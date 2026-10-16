#!/usr/bin/env node
/**
 * a11y-check.js
 * -----------------------------------------------------------------------
 * Drop-in accessibility gate for any project. Runs axe-core against a
 * headless Chromium instance for every target page you configure — either
 * live URLs (a dev/build server), a same-origin crawl starting from one or
 * more seed URLs, or static HTML files on disk — and fails the process
 * (non-zero exit code) when it finds violations at or above your
 * configured severity threshold. Everything below that threshold is
 * printed as a warning but does not block.
 *
 * It also runs checks axe has no equivalent for: focus-visibility and
 * keyboard-trap detection, reachability of custom interactive widgets,
 * reflow at 320px (WCAG 1.4.10), and re-auditing the page after opening
 * every modal/dropdown/accordion it can find.
 *
 * Usage:
 *   node scripts/a11y-check.js [options]
 *
 * Options:
 *   --config <path>       Path to config file (default: a11y.config.js or
 *                          a11y.config.json in the current directory)
 *   --url <url>            Add a URL to check (repeatable)
 *   --dir <path>           Add a directory of static HTML to check (repeatable)
 *   --crawl <url>          Add a seed URL to crawl same-origin links from (repeatable)
 *   --max-pages <n>        Cap on total pages a crawl will visit (default: 200)
 *   --fail-on <level>      critical | serious | moderate | minor (default: critical)
 *   --reduced-motion       Audit with prefers-reduced-motion: reduce and force-settle
 *                          CSS animations/transitions (this is on by default; use
 *                          --no-reduced-motion to turn it off)
 *   --no-reduced-motion    Disable motion settling and audit pages as-is
 *   --no-focus-check       Skip the focus-visibility (keyboard) check
 *   --no-mobile            Skip the default mobile viewport pass
 *   --no-desktop           Skip the default desktop viewport pass
 *   --no-keyboard-check    Skip the keyboard-trap / unreachable-custom-widget check
 *   --no-reflow            Skip the 320px reflow check (WCAG 1.4.10)
 *   --no-interactive-states  Skip re-auditing pages after opening menus/modals/etc
 *   --max-triggers <n>     Cap on interactive elements opened per page (default: 5)
 *   --json-report <path>   Write a full JSON report to this path
 *   --no-incomplete        Don't list the findings axe-core couldn't decide on ("needs review")
 *   --repeat <n>           Run the whole audit n times and report any finding that doesn't show up every
 *                          time — a quick way to tell a real problem from a flaky measurement
 *   --no-progress          Disable the progress bar/milestone output
 *   --no-color             Disable colored output
 *   --help                 Show this help text
 *
 * Every page is audited at both a desktop and a mobile viewport by default
 * (see DEFAULT_VIEWPORTS below) — each violation in the report is tagged
 * with which one it showed up under. The mobile pass also turns on axe's
 * target-size rule (touch target size, WCAG 2.5.8), which is off by
 * default in axe-core.
 *
 * Requires (add to the consuming project's devDependencies):
 *   npm install --save-dev puppeteer axe-core
 *
 * See README.md for config file format, wiring into prebuild/postbuild/CI,
 * and troubleshooting notes.
 * -----------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = ['critical', 'serious', 'moderate', 'minor'];
const DEFAULT_FAIL_ON = 'critical';
const DEFAULT_STATIC_DIRS = ['dist', 'build', 'out', 'public']; // common build output dirs
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_CRAWL_PAGES = 200;
const DEFAULT_MAX_CRAWL_DEPTH = 25;
const DEFAULT_MOTION_SETTLE_MS = 300;
const DEFAULT_MAX_FOCUS_STOPS = 400;
// An element that looks unchanged on focus is re-checked this many times (after a short pause) before it's
// reported. A real missing indicator is unchanged every time; a one-off is a style recalculation or an in-flight
// animation caught mid-frame, which settles on the next look.
const FOCUS_RECHECKS = 3;
const FOCUS_RECHECK_DELAY_MS = 80;
const DEFAULT_REFLOW_WIDTH = 320; // 1280px design ÷ 400% zoom, per WCAG 1.4.10's own worked example
const DEFAULT_REFLOW_HEIGHT = 900;
const DEFAULT_MAX_INTERACTIVE_TRIGGERS = 5;
const DEFAULT_INTERACTION_SETTLE_MS = 250;

// Disclosure widgets (modals, dropdowns, mobile nav, accordions) — content
// only these reveal is invisible to a load-time-only audit. ARIA/semantic
// signals only, never text/class guessing, to keep false positives low.
const INTERACTIVE_TRIGGER_SELECTOR =
  '[aria-expanded="false"], [aria-haspopup]:not([aria-haspopup="false"]), summary, [data-toggle]';

// Every page is checked at both of these by default — most real
// accessibility bugs (overlapping text, hidden controls, tiny tap targets)
// only show up at one size or the other, not both.
const DEFAULT_VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  {
    name: 'mobile',
    width: 375,
    height: 667,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    // target-size (touch target size, WCAG 2.5.8) is off by default in
    // axe-core; it matters most for a touch viewport, so it's only turned
    // on for the mobile pass rather than project-wide.
    extraRules: ['target-size'],
  },
];

// CSS animations/transitions caught mid-run read as low contrast or missing
// content. This forces every page to render in its fully settled state,
// independent of whether the site itself listens for prefers-reduced-motion.
const MOTION_SETTLE_CSS = `
  *, *::before, *::after {
    animation-delay: -1ms !important;
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-delay: 0s !important;
    transition-duration: 0s !important;
    scroll-behavior: auto !important;
  }
`;

// CSS animations/transitions are covered by MOTION_SETTLE_CSS above, but a
// growing share of sites (anything using Motion/Framer Motion, GSAP's WAAPI
// backend, or a hand-rolled Web Animations API call) animate outside CSS
// entirely, so the stylesheet override never touches them. The Web
// Animations API exposes every running animation via document.getAnimations,
// CSS-driven or not, so jumping each one to its end state settles both kinds
// the same way. Finishing an animation can itself trigger a chained one (a
// staggered list revealing its next item, for example), so this sweeps a
// few times until nothing new shows up.
async function settleWebAnimations(page) {
  await page.evaluate(() => {
    function finishAll() {
      const anims = document.getAnimations({ subtree: true });
      for (const anim of anims) {
        try {
          anim.finish();
        } catch {
          try {
            anim.cancel();
          } catch {
            // nothing more we can do with this one — leave it running
          }
        }
      }
      return anims.length;
    }
    // A handful of passes is enough to drain any chained/staggered
    // animations without risking an infinite loop on a page that
    // continuously re-triggers its own animations.
    for (let i = 0; i < 5; i++) {
      if (finishAll() === 0) break;
    }
  });
}

const COLOR_ENABLED = process.stdout.isTTY && !process.argv.includes('--no-color') && !process.env.NO_COLOR;

function color(code, str) {
  if (!COLOR_ENABLED) return str;
  return `\x1b[${code}m${str}\x1b[0m`;
}
const c = {
  bold: (s) => color('1', s),
  dim: (s) => color('2', s),
  red: (s) => color('31', s),
  yellow: (s) => color('33', s),
  cyan: (s) => color('36', s),
  green: (s) => color('32', s),
  magenta: (s) => color('35', s),
};

const IMPACT_LABEL = {
  critical: c.red('CRITICAL'),
  serious: c.magenta('SERIOUS '),
  moderate: c.yellow('MODERATE'),
  minor: c.dim('MINOR   '),
  unknown: c.dim('UNKNOWN '),
};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { urls: [], dirs: [], crawlFrom: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--url') args.urls.push(argv[++i]);
    else if (a === '--dir') args.dirs.push(argv[++i]);
    else if (a === '--crawl') args.crawlFrom.push(argv[++i]);
    else if (a === '--max-pages') args.maxPages = Number(argv[++i]);
    else if (a === '--fail-on') args.failOn = argv[++i];
    else if (a === '--json-report') args.jsonReport = argv[++i];
    else if (a === '--reduced-motion') args.reducedMotion = true;
    else if (a === '--no-reduced-motion') args.reducedMotion = false;
    else if (a === '--no-focus-check') args.checkFocusVisibility = false;
    else if (a === '--no-mobile') args.skipMobile = true;
    else if (a === '--no-desktop') args.skipDesktop = true;
    else if (a === '--no-keyboard-check') args.checkKeyboardOperability = false;
    else if (a === '--no-reflow') args.checkReflow = false;
    else if (a === '--no-interactive-states') args.checkInteractiveStates = false;
    else if (a === '--max-triggers') args.maxTriggers = Number(argv[++i]);
    else if (a === '--no-progress') args.showProgress = false;
    else if (a === '--no-incomplete') args.reportIncomplete = false;
    else if (a === '--repeat') args.repeat = Number(argv[++i]);
    else if (a === '--no-color') {
      /* handled above */
    } else if (a.startsWith('-')) {
      console.warn(c.yellow(`Unknown option: ${a}`));
    }
  }
  return args;
}

function printHelp() {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function findDefaultConfigPath(cwd) {
  const candidates = ['a11y.config.js', 'a11y.config.cjs', 'a11y.config.json'];
  for (const name of candidates) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadConfig(args, cwd) {
  const configPath = args.config ? path.resolve(cwd, args.config) : findDefaultConfigPath(cwd);
  let fileConfig = {};
  let hadConfigFile = false;

  if (configPath && fs.existsSync(configPath)) {
    hadConfigFile = true;
    if (configPath.endsWith('.json')) {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } else {
      // .js / .cjs — plain require, must `module.exports = {...}`
      delete require.cache[require.resolve(configPath)];
      fileConfig = require(configPath);
    }
  }

  const config = Object.assign(
    {
      urls: [],
      staticDirs: [],
      staticExtensions: ['.html', '.htm'],
      ignoreRules: [],
      tags: null, // e.g. ['wcag2a', 'wcag2aa', 'wcag21aa'] — null = axe defaults
      failOn: DEFAULT_FAIL_ON,
      concurrency: DEFAULT_CONCURRENCY,
      timeout: DEFAULT_TIMEOUT_MS,
      server: null, // { command, url, readyTimeout }
      jsonReport: null,
      excludePaths: [], // substrings to skip when walking staticDirs
      // On by default so an animated entrance can't hide or fake a violation.
      reducedMotion: true,
      motionSettleDelay: DEFAULT_MOTION_SETTLE_MS,
      // Crawl: discover pages by following same-origin links from one or
      // more seed URLs, instead of (or alongside) an explicit `urls` list.
      crawl: {
        from: [], // seed URLs, e.g. ['http://localhost:3000/']
        maxPages: DEFAULT_MAX_CRAWL_PAGES,
        maxDepth: DEFAULT_MAX_CRAWL_DEPTH,
        includeExternal: false,
      },
      // Keyboard focus-visibility check (tabs through every reachable
      // element and flags any with no visible focus state). This is on by
      // default because axe-core has no equivalent rule.
      // axe-core sorts what it can't decide (often text contrast over images or video) into an "incomplete"
      // list. Those aren't failures, but they're where real problems hide, so they're listed for a human to check.
      reportIncomplete: true,
      checkFocusVisibility: true,
      focusVisibility: {
        maxStops: DEFAULT_MAX_FOCUS_STOPS,
        impact: 'serious',
      },
      // Flags keyboard traps and elements that look interactive but have no
      // tabindex, so a keyboard user can't reach them. axe has no rule for
      // either — it only checks names/roles, never actual reachability.
      checkKeyboardOperability: true,
      keyboardOperability: { impact: 'serious' },
      // Re-audits at a 320px viewport and flags pages needing horizontal
      // scroll to read (WCAG 1.4.10).
      checkReflow: true,
      reflow: {
        width: DEFAULT_REFLOW_WIDTH,
        height: DEFAULT_REFLOW_HEIGHT,
        impact: 'serious',
      },
      // Opens every disclosure widget found (aria-expanded/aria-haspopup/
      // details/data-toggle) and re-audits what it reveals. Never submits
      // forms — see README for why.
      checkInteractiveStates: true,
      interactiveStates: {
        maxTriggers: DEFAULT_MAX_INTERACTIVE_TRIGGERS,
        settleDelay: DEFAULT_INTERACTION_SETTLE_MS,
      },
      // A run with several pages, or a page with several disclosure
      // widgets, can go a long time with no output otherwise.
      showProgress: true,
    },
    fileConfig
  );

  // Merge nested objects shallowly so a partial override in the config file
  // (e.g. `crawl: { from: [...] }`) doesn't drop the other defaults.
  config.crawl = Object.assign(
    { from: [], maxPages: DEFAULT_MAX_CRAWL_PAGES, maxDepth: DEFAULT_MAX_CRAWL_DEPTH, includeExternal: false },
    fileConfig.crawl || {}
  );
  config.focusVisibility = Object.assign(
    { maxStops: DEFAULT_MAX_FOCUS_STOPS, impact: 'serious' },
    fileConfig.focusVisibility || {}
  );
  config.keyboardOperability = Object.assign({ impact: 'serious' }, fileConfig.keyboardOperability || {});
  config.reflow = Object.assign(
    { width: DEFAULT_REFLOW_WIDTH, height: DEFAULT_REFLOW_HEIGHT, impact: 'serious' },
    fileConfig.reflow || {}
  );
  config.interactiveStates = Object.assign(
    { maxTriggers: DEFAULT_MAX_INTERACTIVE_TRIGGERS, settleDelay: DEFAULT_INTERACTION_SETTLE_MS },
    fileConfig.interactiveStates || {}
  );

  // Viewports: `viewports` (plural, a list) wins if set. Otherwise, the old
  // singular `viewport` key still works exactly as before — a single
  // custom viewport, no automatic mobile pass added alongside it. With
  // neither set, default to auditing both a desktop and a mobile viewport.
  if (Array.isArray(fileConfig.viewports) && fileConfig.viewports.length) {
    config.viewports = fileConfig.viewports.map((vp, i) => Object.assign({ name: vp.name || `viewport-${i + 1}` }, vp));
  } else if (fileConfig.viewport) {
    config.viewports = [Object.assign({ name: 'default' }, fileConfig.viewport)];
  } else {
    config.viewports = DEFAULT_VIEWPORTS;
  }

  // CLI overrides
  if (args.urls.length) config.urls = config.urls.concat(args.urls);
  if (args.dirs.length) config.staticDirs = config.staticDirs.concat(args.dirs);
  if (args.crawlFrom.length) config.crawl.from = config.crawl.from.concat(args.crawlFrom);
  if (args.maxPages) config.crawl.maxPages = args.maxPages;
  if (args.failOn) config.failOn = args.failOn;
  if (args.jsonReport) config.jsonReport = args.jsonReport;
  if (args.reducedMotion !== undefined) config.reducedMotion = args.reducedMotion;
  if (args.checkFocusVisibility !== undefined) config.checkFocusVisibility = args.checkFocusVisibility;
  if (args.checkKeyboardOperability !== undefined) config.checkKeyboardOperability = args.checkKeyboardOperability;
  if (args.checkReflow !== undefined) config.checkReflow = args.checkReflow;
  if (args.checkInteractiveStates !== undefined) config.checkInteractiveStates = args.checkInteractiveStates;
  if (args.showProgress !== undefined) config.showProgress = args.showProgress;
  if (args.reportIncomplete !== undefined) config.reportIncomplete = args.reportIncomplete;
  if (args.maxTriggers) config.interactiveStates.maxTriggers = args.maxTriggers;
  if (args.skipMobile) config.viewports = config.viewports.filter((vp) => vp.name !== 'mobile');
  if (args.skipDesktop) config.viewports = config.viewports.filter((vp) => vp.name !== 'desktop');

  if (config.viewports.length === 0) {
    console.warn(c.yellow('All viewports were filtered out (--no-mobile/--no-desktop) — falling back to the desktop viewport.'));
    config.viewports = [DEFAULT_VIEWPORTS[0]];
  }

  // Auto-detect static output dirs only if nothing was configured or passed at all
  const nothingConfigured =
    !hadConfigFile && config.urls.length === 0 && config.staticDirs.length === 0 && config.crawl.from.length === 0;
  if (nothingConfigured) {
    for (const dir of DEFAULT_STATIC_DIRS) {
      if (fs.existsSync(path.join(cwd, dir))) config.staticDirs.push(dir);
    }
  }

  if (!SEVERITY_ORDER.includes(config.failOn)) {
    console.warn(
      c.yellow(`Unknown failOn value "${config.failOn}", falling back to "${DEFAULT_FAIL_ON}".`)
    );
    config.failOn = DEFAULT_FAIL_ON;
  }

  return { config, hadConfigFile, configPath };
}

// ---------------------------------------------------------------------------
// Target discovery — static files
// ---------------------------------------------------------------------------

function walkHtmlFiles(dir, extensions, excludePaths) {
  const results = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (excludePaths.some((ex) => full.includes(ex))) continue;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        stack.push(full);
      } else if (extensions.includes(path.extname(entry.name).toLowerCase())) {
        results.push(full);
      }
    }
  }
  return results;
}

function collectStaticAndUrlTargets(config, cwd) {
  const targets = [];
  const seen = new Set();

  for (const url of config.urls) {
    const key = 'url:' + url;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ type: 'url', target: url, label: url });
  }

  for (const dir of config.staticDirs) {
    const isAbsoluteDir = path.isAbsolute(dir);
    const abs = isAbsoluteDir ? dir : path.join(cwd, dir);
    const files = walkHtmlFiles(abs, config.staticExtensions, config.excludePaths);
    for (const f of files) {
      const label = isAbsoluteDir ? f : path.relative(cwd, f);
      const targetUrl = 'file://' + f;
      const key = 'file:' + targetUrl;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ type: 'file', target: targetUrl, label });
    }
  }

  return { targets, seen };
}

// ---------------------------------------------------------------------------
// Target discovery — same-origin crawl
// ---------------------------------------------------------------------------

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

async function crawlSite(browser, config) {
  const seeds = (config.crawl.from || []).map(normalizeUrl).filter(Boolean);
  if (seeds.length === 0) return [];

  const allowedOrigins = new Set(seeds.map((s) => new URL(s).origin));
  const maxPages = config.crawl.maxPages || DEFAULT_MAX_CRAWL_PAGES;
  const maxDepth = config.crawl.maxDepth == null ? DEFAULT_MAX_CRAWL_DEPTH : config.crawl.maxDepth;

  const visited = new Set();
  const queue = seeds.map((url) => ({ url, depth: 0 }));
  const discovered = [];

  // The crawl's own final page count isn't known until it's done, so this
  // can't be a completed/total bar like the audit and reflow passes — it's
  // liveness only: how many pages found so far, and how many are still
  // queued to check. Same TTY-vs-log-file split as makeProgressReporter.
  const isTTY = Boolean(process.stdout.isTTY);
  let lastCrawlLogAt = 0;

  while (queue.length && discovered.length < maxPages) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    discovered.push(url);

    if (config.showProgress) {
      if (isTTY) {
        const line = `  Crawling... ${discovered.length} page(s) found, ${queue.length} queued`;
        process.stdout.write('\r' + c.cyan(line.padEnd(60)));
      } else if (discovered.length - lastCrawlLogAt >= 10) {
        lastCrawlLogAt = discovered.length;
        console.log(c.cyan(`  Crawling... ${discovered.length} page(s) found so far, ${queue.length} queued`));
      }
    }

    if (depth >= maxDepth) continue;

    const page = await browser.newPage();
    try {
      // Link discovery only needs the DOM, not a fully idle network — using
      // the same networkidle0 wait as the real audit here just adds
      // per-page latency (and risk) for no benefit while crawling.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.timeout });
      const hrefs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]')).map((a) => a.href)
      );
      for (const href of hrefs) {
        const norm = normalizeUrl(href);
        if (!norm || visited.has(norm)) continue;
        const isAllowed = config.crawl.includeExternal || allowedOrigins.has(new URL(norm).origin);
        if (!isAllowed) continue;
        if (!queue.some((q) => q.url === norm)) {
          queue.push({ url: norm, depth: depth + 1 });
        }
      }
    } catch (err) {
      // A page that fails to load during discovery still gets audited (and
      // reported as an error) in the normal audit pass below — no need to
      // do anything special here beyond not following its links.
      console.warn(c.yellow(`  (crawl) could not load ${url}: ${err.message}`));
    } finally {
      await page.close();
    }
  }

  if (config.showProgress && isTTY && discovered.length > 0) process.stdout.write('\n');

  if (discovered.length >= maxPages && queue.length) {
    console.warn(
      c.yellow(
        `  (crawl) hit the ${maxPages}-page limit with more links still queued — raise crawl.maxPages if this site has more pages than that.`
      )
    );
  }

  return discovered;
}

// ---------------------------------------------------------------------------
// Optional local server bootstrap
// ---------------------------------------------------------------------------

// Stops the server this run started if the run is interrupted (Ctrl-C, a CI cancel) or exits any other way. Without
// this, the server — started in its own process group — outlives the run and holds its port, so the next run
// fails with "already in use".
function installServerCleanup(getServer) {
  const onSignal = (signal, code) => () => {
    console.error(c.yellow(`\na11y-check: received ${signal} — stopping the server and exiting.`));
    Promise.resolve(stopServer(getServer())).finally(() => process.exit(code));
  };
  process.once('SIGINT', onSignal('SIGINT', 130));
  process.once('SIGTERM', onSignal('SIGTERM', 143));
  // Last resort for any other way out (an unexpected error, process.exit): kill the server's process group.
  process.on('exit', () => {
    const child = getServer();
    if (!child || child.exit || process.platform === 'win32') return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  });
}

// Resolves true when something is already accepting connections on the
// port in `url` (only checked for loopback URLs — a remote host's port isn't
// ours to probe). Used before spawning the server: if the port is taken, the
// new server would crash with EADDRINUSE while a stale one (often left over
// from an interrupted run) answers — or hangs — in its place.
function isPortInUse(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return Promise.resolve(false);
  const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// `server` is the handle from startServer. Resolves { ready: true } once the
// URL answers, or { ready: false, exited?: {...} } on timeout or if the server
// process dies first (so a crash is reported straight away, with its stderr,
// instead of after the full timeout).
async function waitForServer(url, timeoutMs, server) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (server && server.exit) return { ready: false, exited: server.exit };
    try {
      // Per-request timeout: a server that accepts the connection but never
      // replies would otherwise hang this loop forever and make the
      // readyTimeout meaningless.
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2000) });
      if (res.ok || (res.status >= 200 && res.status < 500)) return { ready: true };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ready: false, exited: server && server.exit };
}

// Returns the child with two extras: `stderr` (the last few KB the server
// wrote there) and `exit` ({ code, signal } once it has died, else null).
function startServer(serverConfig, cwd) {
  const child = spawn(serverConfig.command, {
    cwd,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.serverStderr = '';
  child.exit = null;
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      child.serverStderr = (child.serverStderr + chunk).slice(-4000);
    });
  }
  child.on('exit', (code, signal) => {
    child.exit = { code, signal };
  });
  child.on('error', (err) => {
    child.exit = { code: null, signal: null, error: err.message };
  });
  return child;
}

function stopServer(child) {
  if (!child || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      if (process.platform !== 'win32') {
        process.kill(-child.pid, 'SIGTERM'); // kill whole process group
        resolve();
      } else {
        // child.kill() here only terminates the cmd.exe wrapper that `shell:
        // true` spawns — the actual server process it launched (e.g. `node
        // some-script.js`) is cmd.exe's own child, not ours, and survives.
        // It keeps the port open and holds a lock on its cwd, so anything
        // that expects the server to actually be gone (a rerun on the same
        // port, cleanup of a temp directory used as its cwd) can fail right
        // after this returns. taskkill's /T walks the whole process tree.
        //
        // taskkill is itself just spawned, not awaited — without waiting for
        // it to exit, a caller that immediately deletes the server's cwd
        // (as the self-tests do for their temp fixture directories) can run
        // before taskkill has even started killing the tree, not just
        // before the OS has released the file handles. That race, not a
        // merely-slow release, was the actual cause of the intermittent
        // Windows CI EBUSY/ENOTEMPTY failures the rmSync retries alone
        // couldn't fully cover.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
        });
        killer.on('exit', () => resolve());
        killer.on('error', () => resolve());
      }
    } catch {
      // already dead — fine
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Focus-visibility check (real keyboard traversal — axe has no equivalent)
// ---------------------------------------------------------------------------

// Measures whether focusing `key`'s element changes how it looks: the element itself, plus up to three ancestors,
// because plenty of designs draw the focus ring on a wrapper (a card with `:has(:focus-visible)`, a field group with
// `:focus-within`) while the focused control itself stays plain. Both readings are taken two animation frames after the
// state change so pending style updates have landed, rather than the instant focus moves. The element ends up focused
// again, as it was. Returns { gone: true } if the element left the page, otherwise { changedLevel } where -1 means
// nothing changed, 0 the element itself, and 1+ an ancestor.
const FOCUS_ANCESTOR_LEVELS = 4; // the element + 3 ancestors

async function measureFocusChange(page, key) {
  return page.evaluate(
    async (elementKey, levelCount) => {
      const el = document.querySelector(`[data-a11y-gate-key="${elementKey}"]`);
      if (!el) return { gone: true };
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const snapshot = (target) => {
        const cs = getComputedStyle(target);
        return [
          cs.outlineStyle,
          cs.outlineWidth,
          cs.outlineColor,
          cs.boxShadow,
          cs.borderTopColor,
          cs.borderTopWidth,
          cs.backgroundColor,
        ].join('|');
      };
      const readLevels = () => {
        const out = [];
        let node = el;
        for (let i = 0; i < levelCount && node && node !== document.documentElement; i++) {
          out.push(snapshot(node));
          node = node.parentElement;
        }
        return out;
      };

      if (document.activeElement !== el) el.focus({ preventScroll: true });
      await frame();
      const focused = readLevels();
      el.blur();
      await frame();
      const resting = readLevels();
      el.focus({ preventScroll: true });

      return { changedLevel: focused.findIndex((value, i) => value !== resting[i]) };
    },
    key,
    FOCUS_ANCESTOR_LEVELS
  );
}

async function auditFocusVisibility(page, focusConfig) {
  const maxStops = (focusConfig && focusConfig.maxStops) || DEFAULT_MAX_FOCUS_STOPS;

  await page.evaluate(() => {
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
  });

  const flagged = [];
  const trapped = [];
  const rechecked = [];
  let previousKey = null;
  let firstKey = null;
  let stuckRepeats = 0;

  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press('Tab');

    let info;
    try {
      info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) {
          return { done: true };
        }

        let key = el.getAttribute('data-a11y-gate-key');
        if (!key) {
          key = 'k' + Math.random().toString(36).slice(2);
          el.setAttribute('data-a11y-gate-key', key);
        }

        const matchedFocusVisible = el.matches(':focus-visible');

        const tag = el.tagName.toLowerCase();
        const idAttr = el.id ? '#' + el.id : '';
        const text = (el.textContent || el.value || el.getAttribute('aria-label') || '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 40);

        return {
          done: false,
          key,
          descriptor: `${tag}${idAttr}${text ? ` "${text}"` : ''}`,
          matchedFocusVisible,
        };
      });
    } catch {
      break; // page navigated away or errored mid-check — stop rather than throw
    }

    if (!info || info.done) break;
    if (firstKey === null) firstKey = info.key;

    // Stuck on the same element twice in a row = a real trap (WCAG 2.1.2),
    // not just the end of the tab order.
    if (info.key === previousKey) {
      stuckRepeats++;
      if (stuckRepeats >= 2) {
        trapped.push(info.descriptor);
        break;
      }
    } else {
      stuckRepeats = 0;
    }
    previousKey = info.key;

    // Cycled back to the first stop — the tab order wrapped normally.
    if (i > 0 && info.key === firstKey) break;

    // First look, then up to FOCUS_RECHECKS more if it came back unchanged.
    let changed = false;
    let firstLookChanged = false;
    let looks = 0;
    for (let attempt = 0; attempt <= FOCUS_RECHECKS && !changed; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, FOCUS_RECHECK_DELAY_MS));
      try {
        const measured = await measureFocusChange(page, info.key);
        looks++;
        changed = Boolean(measured.gone) || measured.changedLevel !== -1;
        if (attempt === 0) firstLookChanged = changed;
      } catch {
        changed = true; // page navigated away mid-check — nothing trustworthy to flag
      }
    }
    if (!changed) {
      flagged.push(`${info.descriptor} [looked unchanged on all ${looks} checks; matched :focus-visible: ${info.matchedFocusVisible}]`);
    } else if (!firstLookChanged) {
      // Passed only on a recheck: not a failure, but never silent — a real flicker is worth knowing about.
      rechecked.push(`${info.descriptor} [passed on recheck ${looks - 1}; matched :focus-visible at first look: ${info.matchedFocusVisible}]`);
    }
  }

  await page
    .evaluate(() => {
      document.querySelectorAll('[data-a11y-gate-key]').forEach((el) => el.removeAttribute('data-a11y-gate-key'));
    })
    .catch(() => {});

  return { flagged, trapped, rechecked };
}

// ---------------------------------------------------------------------------
// Keyboard operability — elements that look interactive but aren't focusable
// ---------------------------------------------------------------------------

async function auditKeyboardOperability(page) {
  return page.evaluate(() => {
    const NATIVE_FOCUSABLE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'audio', 'video', 'iframe']);
    const INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option']);
    const flagged = [];

    for (const el of document.querySelectorAll('body *')) {
      const tag = el.tagName.toLowerCase();
      if (NATIVE_FOCUSABLE.has(tag)) continue; // native elements are already keyboard-operable

      const role = el.getAttribute('role');
      const looksInteractive = el.hasAttribute('onclick') || (role && INTERACTIVE_ROLES.has(role));
      if (!looksInteractive) continue;

      const tabindex = el.getAttribute('tabindex');
      const isFocusable = tabindex !== null && Number(tabindex) >= 0;
      if (isFocusable) continue; // already reachable — fine

      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue; // not actually on screen

      const idAttr = el.id ? '#' + el.id : '';
      const text = (el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      flagged.push(`${tag}${idAttr}${role ? `[role=${role}]` : '[onclick]'}${text ? ` "${text}"` : ''}`);
      if (flagged.length >= 50) break;
    }

    return flagged;
  });
}

// ---------------------------------------------------------------------------
// Reflow (WCAG 1.4.10) — horizontal scroll check at a 320px viewport
// ---------------------------------------------------------------------------

async function auditReflow(browser, target, config) {
  const page = await browser.newPage();
  const width = config.reflow.width || DEFAULT_REFLOW_WIDTH;
  const height = config.reflow.height || DEFAULT_REFLOW_HEIGHT;
  await page.setViewport({ width, height });
  const outcome = { violations: [], error: null };

  try {
    if (config.reducedMotion) {
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    }
    await page.goto(target.target, { waitUntil: 'networkidle0', timeout: config.timeout });

    if (config.reducedMotion) {
      await page.addStyleTag({ content: MOTION_SETTLE_CSS });
      await settleWebAnimations(page);
      if (config.motionSettleDelay > 0) {
        await new Promise((r) => setTimeout(r, config.motionSettleDelay));
      }
    }

    const overflow = await page.evaluate((vw) => {
      const tolerance = 1;
      const scrollWidth = document.documentElement.scrollWidth;
      if (scrollWidth <= vw + tolerance) return null;

      const offenders = [];
      for (const el of document.querySelectorAll('body *')) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.right > vw + tolerance) {
          const tag = el.tagName.toLowerCase();
          const idAttr = el.id ? '#' + el.id : '';
          const cls =
            el.className && typeof el.className === 'string'
              ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
              : '';
          offenders.push(`${tag}${idAttr}${cls}`);
        }
      }
      return { scrollWidth, offenders: offenders.slice(0, 5), offenderCount: offenders.length };
    }, width);

    if (overflow) {
      outcome.violations.push({
        id: 'reflow-320',
        impact: config.reflow.impact || 'serious',
        viewport: `reflow-${width}`,
        description: `Content must not require horizontal scrolling at a ${width}px viewport width (WCAG 1.4.10, Reflow).`,
        help: `Page is ${overflow.scrollWidth}px wide at a ${width}px viewport — ${overflow.offenderCount} element(s) overflow horizontally`,
        helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/reflow.html',
        nodes: overflow.offenders,
        nodeCount: overflow.offenderCount,
      });
    }
  } catch (err) {
    outcome.error = err.message;
  } finally {
    await page.close();
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Interactive-state auditing — re-runs axe after opening each disclosure
// widget found on the page
// ---------------------------------------------------------------------------

async function discoverInteractiveTriggers(page, max) {
  return page.evaluate(
    (selector, max) => {
      const nodes = Array.from(document.querySelectorAll(selector));
      const out = [];
      nodes.forEach((el, i) => {
        if (out.length >= max) return;
        // Real links (not "#", not empty, not javascript:) are navigation,
        // not a disclosure widget — clicking one would leave the page.
        if (el.tagName.toLowerCase() === 'a') {
          const href = el.getAttribute('href') || '';
          if (href && href !== '#' && !href.startsWith('javascript:')) return;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return; // not actually reachable/visible
        const tag = el.tagName.toLowerCase();
        const idAttr = el.id ? '#' + el.id : '';
        const text = (el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 30);
        out.push({ nthMatch: i, descriptor: `${tag}${idAttr}${text ? ` "${text}"` : ''}` });
      });
      return out;
    },
    INTERACTIVE_TRIGGER_SELECTOR,
    max
  );
}

async function auditInteractionState(browser, target, viewport, config, axeSource, trigger) {
  const page = await browser.newPage();
  const { name, extraRules, ...puppeteerViewport } = viewport;
  await page.setViewport(puppeteerViewport);
  const outcome = { violations: [], error: null };

  try {
    if (config.reducedMotion) {
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    }
    await page.goto(target.target, { waitUntil: 'networkidle0', timeout: config.timeout });
    if (config.reducedMotion) {
      await page.addStyleTag({ content: MOTION_SETTLE_CSS });
      await settleWebAnimations(page);
      if (config.motionSettleDelay > 0) {
        await new Promise((r) => setTimeout(r, config.motionSettleDelay));
      }
    }

    const clicked = await page.evaluate(
      (selector, nth) => {
        const el = document.querySelectorAll(selector)[nth];
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      },
      INTERACTIVE_TRIGGER_SELECTOR,
      trigger.nthMatch
    );
    if (!clicked) return outcome;

    // settleWebAnimations() above only caught animations already running at
    // load time. Opening this trigger can start its own — a menu's items
    // fading/sliding in, an accordion panel expanding — so it needs the same
    // treatment, not just the fixed delay below (which was doing double
    // duty as an animation wait even though it's really meant for the
    // DOM/layout to settle after the click).
    if (config.reducedMotion) {
      await settleWebAnimations(page);
    }

    const settle = config.interactiveStates.settleDelay || DEFAULT_INTERACTION_SETTLE_MS;
    await new Promise((r) => setTimeout(r, settle));

    await page.evaluate(axeSource);
    const ruleOverrides = {};
    for (const ruleId of config.ignoreRules) ruleOverrides[ruleId] = { enabled: false };
    for (const ruleId of extraRules || []) ruleOverrides[ruleId] = { enabled: true };
    const axeOptions = { rules: ruleOverrides };
    if (config.tags) axeOptions.runOnly = { type: 'tag', values: config.tags };

    const axeResults = await page.evaluate((opts) => window.axe.run(document, opts), axeOptions);
    const stateLabel = `${name} · after opening ${trigger.descriptor}`;
    outcome.violations = axeResults.violations.map((v) => ({
      id: v.id,
      impact: v.impact || 'unknown',
      viewport: stateLabel,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5),
      nodeCount: v.nodes.length,
    }));
  } catch (err) {
    // A misidentified trigger that navigates lands here — not a hard
    // failure, the rest of the page's audit is still valid.
    outcome.error = null;
  } finally {
    await page.close();
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Running axe (+ focus check) against one target at one viewport
// ---------------------------------------------------------------------------

async function auditTargetAtViewport(browser, target, viewport, config, axeSource) {
  const page = await browser.newPage();
  const { name, extraRules, ...puppeteerViewport } = viewport;
  await page.setViewport(puppeteerViewport);
  const outcome = { violations: [], error: null };

  try {
    if (config.reducedMotion) {
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    }
    await page.goto(target.target, { waitUntil: 'networkidle0', timeout: config.timeout });

    if (config.reducedMotion) {
      // Belt-and-suspenders for sites that ignore prefers-reduced-motion.
      await page.addStyleTag({ content: MOTION_SETTLE_CSS });
      await settleWebAnimations(page);
      if (config.motionSettleDelay > 0) {
        await new Promise((r) => setTimeout(r, config.motionSettleDelay));
      }
    }

    await page.evaluate(axeSource);

    const ruleOverrides = {};
    for (const ruleId of config.ignoreRules) ruleOverrides[ruleId] = { enabled: false };
    // Viewport-specific rules (e.g. target-size on mobile) force-enable
    // regardless of tags/ignoreRules.
    for (const ruleId of extraRules || []) ruleOverrides[ruleId] = { enabled: true };

    const axeOptions = { rules: ruleOverrides };
    if (config.tags) axeOptions.runOnly = { type: 'tag', values: config.tags };

    const axeResults = await page.evaluate((opts) => window.axe.run(document, opts), axeOptions);
    outcome.violations = axeResults.violations.map((v) => ({
      id: v.id,
      impact: v.impact || 'unknown',
      viewport: name,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5),
      nodeCount: v.nodes.length,
    }));

    if (config.reportIncomplete) {
      outcome.review = (axeResults.incomplete || []).map((v) => ({
        id: v.id,
        viewport: name,
        help: v.help,
        helpUrl: v.helpUrl,
        nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 3),
        nodeCount: v.nodes.length,
      }));
    }

    if (config.checkFocusVisibility) {
      const { flagged, trapped, rechecked } = await auditFocusVisibility(page, config.focusVisibility);
      outcome.focusRechecks = rechecked.map((descriptor) => ({ viewport: name, descriptor }));
      if (flagged.length) {
        outcome.violations.push({
          id: 'focus-visible-indicator',
          impact: config.focusVisibility.impact || 'serious',
          viewport: name,
          description:
            'Interactive elements must have a visible indicator when they receive keyboard focus (WCAG 2.4.7).',
          help: `${flagged.length} keyboard-reachable element(s) look identical whether focused or not`,
          helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/focus-visible.html',
          nodes: flagged.slice(0, 5),
          nodeCount: flagged.length,
        });
      }
      if (trapped.length) {
        outcome.violations.push({
          id: 'keyboard-trap',
          impact: 'critical',
          viewport: name,
          description: 'Keyboard focus must never become trapped on an element (WCAG 2.1.2).',
          help: `Tab stopped moving focus past ${trapped.length} element(s) — a keyboard-only user cannot leave`,
          helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/no-keyboard-trap.html',
          nodes: trapped.slice(0, 5),
          nodeCount: trapped.length,
        });
      }
    }

    if (config.checkKeyboardOperability) {
      const unreachable = await auditKeyboardOperability(page);
      if (unreachable.length) {
        outcome.violations.push({
          id: 'keyboard-operable-custom-widget',
          impact: config.keyboardOperability.impact || 'serious',
          viewport: name,
          description:
            'Elements that act as controls (an onclick handler, or an interactive ARIA role) must be reachable by keyboard (WCAG 2.1.1).',
          help: `${unreachable.length} element(s) look interactive but have no tabindex, so a keyboard-only user can never reach them`,
          helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/keyboard.html',
          nodes: unreachable.slice(0, 5),
          nodeCount: unreachable.length,
        });
      }
    }

    if (config.checkInteractiveStates) {
      const triggers = await discoverInteractiveTriggers(page, config.interactiveStates.maxTriggers);
      for (const trigger of triggers) {
        const stateOutcome = await auditInteractionState(browser, target, viewport, config, axeSource, trigger);
        outcome.violations.push(...stateOutcome.violations);
      }
    }
  } catch (err) {
    outcome.error = err.message;
  } finally {
    await page.close();
  }

  return outcome;
}

async function runWithConcurrency(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
      if (onProgress) onProgress();
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, runOne);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Progress reporting — a page with several accordions/menus, or a crawl of
// dozens of pages, can run for a long time with axe/puppeteer producing no
// output of their own. Without something here, that silence is easy to
// mistake for a hang. In a real terminal this redraws a single line so it
// doesn't flood the scrollback; piped to a file or a CI log (no TTY) it
// instead prints occasional milestone lines, since redrawing with \r just
// leaves control characters in a log file.
// ---------------------------------------------------------------------------

function renderProgressBar(completed, total, width) {
  const ratio = total === 0 ? 1 : Math.min(1, completed / total);
  const filled = Math.round(ratio * width);
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
  return `[${bar}] ${completed}/${total} (${Math.round(ratio * 100)}%)`;
}

function makeProgressReporter(total, label, config) {
  if (!config.showProgress || total === 0) return () => {};
  const isTTY = Boolean(process.stdout.isTTY);
  let completed = 0;
  let lastMilestone = -1;

  return function tick() {
    completed++;
    if (isTTY) {
      const line = `  ${label} ${renderProgressBar(completed, total, 24)}`;
      // Padding covers a shorter line overwriting a longer one from the
      // same phase (label/total are fixed per phase, but the bar's digit
      // width can still grow, e.g. 9/10 -> 10/10).
      process.stdout.write('\r' + c.cyan(line.padEnd(60)));
      if (completed === total) process.stdout.write('\n');
    } else {
      const percent = Math.floor((completed / total) * 100);
      const milestone = Math.floor(percent / 20) * 20; // roughly every 20%
      if (milestone > lastMilestone || completed === total) {
        lastMilestone = milestone;
        console.log(c.cyan(`  ${label}: ${completed}/${total} (${percent}%)`));
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function severityIndex(impact) {
  const idx = SEVERITY_ORDER.indexOf(impact);
  return idx === -1 ? SEVERITY_ORDER.length : idx; // unknown = least severe
}

function printReport(results, config) {
  const failOnIndex = SEVERITY_ORDER.indexOf(config.failOn);
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0, unknown: 0 };
  let blockingCount = 0;
  let erroredTargets = 0;

  for (const result of results) {
    if (result.error) {
      erroredTargets++;
      console.log(`\n${c.bold(result.label)}`);
      console.log(`  ${c.red('ERROR')}  could not audit this target: ${result.error}`);
      continue;
    }

    if (result.violations.length === 0) continue;

    console.log(`\n${c.bold(result.label)}`);
    for (const v of result.violations) {
      counts[v.impact] = (counts[v.impact] || 0) + 1;
      const blocking = severityIndex(v.impact) <= failOnIndex;
      if (blocking) blockingCount++;

      const label = IMPACT_LABEL[v.impact] || IMPACT_LABEL.unknown;
      const marker = blocking ? c.red('[BLOCKING]') : c.dim('[warning] ');
      const viewportTag = v.viewport ? c.dim(`(${v.viewport}) `) : '';
      console.log(`  ${marker} ${label}  ${viewportTag}${c.bold(v.id)} — ${v.help}`);
      console.log(`            ${c.dim(v.helpUrl)}`);
      console.log(
        `            ${v.nodeCount} element(s), e.g. ${v.nodes.slice(0, 2).join('  |  ')}`
      );
    }
  }

  const cleanTargets = results.filter((r) => !r.error && r.violations.length === 0);
  if (cleanTargets.length) {
    console.log(
      `\n${c.green('✓')} ${cleanTargets.length} target(s) had no detected issues: ${cleanTargets
        .map((r) => r.label)
        .join(', ')}`
    );
  }

  // Findings axe couldn't decide on — informational, never part of the pass/fail result.
  const reviewByRule = new Map();
  for (const r of results) {
    for (const item of r.review || []) {
      if (!reviewByRule.has(item.id)) reviewByRule.set(item.id, { help: item.help, pages: new Map() });
      const pages = reviewByRule.get(item.id).pages;
      const entry = pages.get(r.label) || { viewports: new Set(), nodeCount: 0, example: item.nodes[0] };
      entry.viewports.add(item.viewport);
      entry.nodeCount = Math.max(entry.nodeCount, item.nodeCount);
      pages.set(r.label, entry);
    }
  }
  if (reviewByRule.size) {
    console.log(
      `\n${c.yellow('?')} Needs manual review: axe-core couldn't decide on these, so they aren't counted as failures. ` +
        'Check them by eye (use --json-report for the full list, --no-incomplete to hide):'
    );
    for (const [id, { help, pages }] of reviewByRule) {
      console.log(c.yellow(`    ${id}`) + c.dim(` — ${help}`));
      let shown = 0;
      for (const [label, entry] of pages) {
        if (shown++ >= 4) {
          console.log(c.dim(`        …and ${pages.size - 4} more page(s)`));
          break;
        }
        console.log(
          c.dim(`        ${label} (${[...entry.viewports].join(', ')}): ${entry.nodeCount} element(s), e.g. ${entry.example}`)
        );
      }
    }
  }

  const rechecks = results.flatMap((r) => (r.focusRechecks || []).map((x) => ({ label: r.label, ...x })));
  if (rechecks.length) {
    console.log(
      `\n${c.yellow('!')} ${rechecks.length} focus indicator(s) looked unchanged on first look and passed on a recheck. ` +
        'Not a failure, but if the same element keeps appearing, check its focus styling by hand:'
    );
    for (const r of rechecks) console.log(c.yellow(`    ${r.label} (${r.viewport}): ${r.descriptor}`));
  }

  console.log('\n' + c.bold('Summary'));
  console.log(
    `  critical: ${counts.critical}   serious: ${counts.serious}   moderate: ${counts.moderate}   minor: ${counts.minor}   unknown: ${counts.unknown}`
  );
  console.log(`  fail-on threshold: ${c.bold(config.failOn)} (and anything more severe)`);

  return { blockingCount, erroredTargets, counts };
}

// ---------------------------------------------------------------------------
// --repeat: run the whole audit several times and report what isn't stable
// ---------------------------------------------------------------------------

// Drops `--flag value` pairs from an argv list.
function withoutValueFlags(argv, flags) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (flags.includes(argv[i])) {
      i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

// A finding's identity across runs: page, viewport, rule and elements, minus the run-specific bracketed detail.
function findingKey(result, v) {
  const nodes = (v.nodes || []).map((n) => n.replace(/\s*\[[^\]]*\]\s*$/, '')).join(',');
  return `${result.label} | ${v.viewport || ''} | ${v.id} | ${nodes}`;
}

async function runRepeated(args, rawArgv) {
  const runs = Math.min(Math.max(Math.floor(args.repeat), 2), 50);
  const childArgs = withoutValueFlags(rawArgv, ['--repeat', '--json-report']).concat(['--no-progress', '--no-color']);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-gate-repeat-'));
  const outcomes = [];

  console.log(c.cyan(`Running the audit ${runs} times to check that its results are stable...`));
  for (let i = 1; i <= runs; i++) {
    const reportPath = path.join(tmpDir, `run-${i}.json`);
    const exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, [__filename, ...childArgs, '--json-report', reportPath], {
        cwd: process.cwd(),
        env: Object.assign({}, process.env, { A11Y_GATE_REPEAT_CHILD: '1' }),
        stdio: 'ignore',
      });
      child.on('exit', (code) => resolve(code === null ? 1 : code));
      child.on('error', () => resolve(1));
    });

    let report = null;
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch {
      // the run died before writing a report
    }
    const failOnIndex = report ? SEVERITY_ORDER.indexOf(report.config.failOn) : -1;
    const blocking = new Set();
    const rechecks = new Set();
    for (const result of (report && report.results) || []) {
      if (result.error) blocking.add(`${result.label} | could not audit | ${result.error}`);
      for (const v of result.violations || []) {
        if (severityIndex(v.impact) <= failOnIndex) blocking.add(findingKey(result, v));
      }
      for (const r of result.focusRechecks || []) {
        rechecks.add(`${result.label} | ${r.viewport} | ${r.descriptor.replace(/\s*\[[^\]]*\]\s*$/, '')}`);
      }
    }
    outcomes.push({ run: i, exitCode, report: Boolean(report), blocking, rechecks });
    const label = exitCode === 0 ? c.green('PASS') : c.red(`FAIL (${blocking.size || 'run error'})`);
    console.log(`  run ${i}/${runs}: ${label}${rechecks.size ? c.yellow(`  — ${rechecks.size} focus recheck(s)`) : ''}`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const counts = new Map();
  for (const o of outcomes) for (const key of o.blocking) counts.set(key, (counts.get(key) || 0) + 1);
  const consistent = [...counts].filter(([, n]) => n === runs).map(([key]) => key);
  const flaky = [...counts].filter(([, n]) => n < runs).map(([key, n]) => ({ key, runs: n }));
  const recheckCounts = new Map();
  for (const o of outcomes) for (const key of o.rechecks) recheckCounts.set(key, (recheckCounts.get(key) || 0) + 1);
  const failedRuns = outcomes.filter((o) => o.exitCode !== 0).length;

  console.log('\n' + c.bold('Repeat summary'));
  console.log(`  ${runs - failedRuns} of ${runs} runs passed`);
  if (consistent.length) {
    console.log(c.red(`  Appeared in every run (a real, stable finding): ${consistent.length}`));
    for (const key of consistent) console.log(c.red(`    ${key}`));
  }
  if (flaky.length) {
    console.log(c.yellow(`  Appeared in some runs only (an unstable measurement, not a stable result): ${flaky.length}`));
    for (const f of flaky) console.log(c.yellow(`    ${f.key}  — ${f.runs} of ${runs} runs`));
  }
  if (recheckCounts.size) {
    console.log(c.yellow('  Needed a focus recheck (passed, but not on the first look):'));
    for (const [key, n] of recheckCounts) console.log(c.yellow(`    ${key}  — ${n} of ${runs} runs`));
  }
  if (!consistent.length && !flaky.length && failedRuns === 0) console.log(c.green('  ✓ Every run passed with identical results.'));

  if (args.jsonReport) {
    try {
      fs.writeFileSync(
        path.resolve(process.cwd(), args.jsonReport),
        JSON.stringify({ runs, failedRuns, consistent, flaky, rechecks: [...recheckCounts] }, null, 2)
      );
    } catch (err) {
      console.warn(c.yellow(`Could not write JSON report: ${err.message}`));
    }
  }
  process.exit(failedRuns > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cwd = process.cwd();
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.repeat > 1 && !process.env.A11Y_GATE_REPEAT_CHILD) {
    await runRepeated(args, process.argv.slice(2));
    return;
  }

  let config, hadConfigFile;
  try {
    ({ config, hadConfigFile } = loadConfig(args, cwd));
  } catch (err) {
    console.error(c.red(`a11y-check: could not load config: ${err.message}`));
    process.exit(1);
  }

  const nothingToDo =
    !hadConfigFile &&
    config.urls.length === 0 &&
    config.staticDirs.length === 0 &&
    config.crawl.from.length === 0;

  if (nothingToDo) {
    console.log(
      c.yellow(
        [
          'a11y-check: no a11y.config.js found and no common build output directory',
          `(${DEFAULT_STATIC_DIRS.join(', ')}) exists yet — nothing to audit.`,
          '',
          'Create a11y.config.js in your project root to configure targets, e.g.:',
          '',
          '  module.exports = {',
          "    urls: ['http://localhost:3000/'],",
          "    failOn: 'critical',",
          '  };',
          '',
          'See README.md for the full config reference. Skipping check (exit 0)',
          'so this does not block an unconfigured project.',
        ].join('\n')
      )
    );
    process.exit(0);
  }

  let serverProcess = null;
  if (config.server && config.server.command) {
    if (await isPortInUse(config.server.url)) {
      console.error(
        c.red(
          `a11y-check: ${config.server.url} is already in use, so the server this run would start can't bind there. ` +
            'This is usually a server left over from an earlier run. Stop whatever is listening ' +
            '(macOS/Linux: `lsof -nP -iTCP:<port>`), or change the port in your config.'
        )
      );
      process.exit(1);
    }
    console.log(c.cyan(`Starting server: ${config.server.command}`));
    serverProcess = startServer(config.server, cwd);
    installServerCleanup(() => serverProcess);
    const { ready, exited } = await waitForServer(
      config.server.url,
      config.server.readyTimeout || DEFAULT_TIMEOUT_MS,
      serverProcess
    );
    if (!ready) {
      if (exited) {
        const how = exited.error
          ? `failed to start: ${exited.error}`
          : `exited early (${exited.signal ? 'signal ' + exited.signal : 'code ' + exited.code})`;
        console.error(c.red(`Server ${how} before it became ready at ${config.server.url}.`));
        const tail = (serverProcess.serverStderr || '').trim();
        if (tail) console.error(tail);
      } else {
        console.error(
          c.red(
            `Server did not become ready at ${config.server.url} within ${
              config.server.readyTimeout || DEFAULT_TIMEOUT_MS
            }ms.`
          )
        );
      }
      await stopServer(serverProcess);
      process.exit(1);
    }
    console.log(c.green(`Server ready at ${config.server.url}`));
  }

  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    console.error(
      c.red(
        'a11y-check: the "puppeteer" package is not installed. Run:\n' +
          '  npm install --save-dev puppeteer axe-core'
      )
    );
    await stopServer(serverProcess);
    process.exit(1);
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // Chrome's own background pings can stretch networkidle0 waits —
        // none of this is needed for a headless audit.
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--disable-sync',
        '--disable-default-apps',
        '--no-first-run',
        '--metrics-recording-only',
      ],
    });
  } catch (err) {
    console.error(c.red(`a11y-check: could not launch Chromium: ${err.message}`));
    await stopServer(serverProcess);
    process.exit(1);
  }

  let targets;
  try {
    const { targets: baseTargets, seen } = collectStaticAndUrlTargets(config, cwd);
    targets = baseTargets;

    if (config.crawl.from.length) {
      console.log(c.cyan(`Crawling from ${config.crawl.from.join(', ')}...`));
      const crawled = await crawlSite(browser, config);
      for (const url of crawled) {
        const key = 'url:' + url;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ type: 'url', target: url, label: url });
      }
      console.log(c.cyan(`Crawl discovered ${crawled.length} page(s).`));
    }
  } catch (err) {
    await browser.close();
    await stopServer(serverProcess);
    console.error(c.red(`a11y-check: crawl failed: ${err.message}`));
    process.exit(1);
  }

  if (targets.length === 0) {
    await browser.close();
    await stopServer(serverProcess);
    console.error(
      c.red(
        'a11y-check: config was found but resolved to zero pages to audit. ' +
          'Check your `urls` / `staticDirs` / `crawl.from` settings in the config file.'
      )
    );
    process.exit(1);
  }

  const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

  const viewportNames = config.viewports.map((vp) => vp.name).join(', ');
  const extras = [];
  if (config.checkReflow) extras.push(`reflow @ ${config.reflow.width}px`);
  if (config.checkInteractiveStates) extras.push('interactive states');
  const extrasNote = extras.length ? `, plus ${extras.join(' and ')}` : '';
  console.log(
    c.cyan(
      `Auditing ${targets.length} page(s) with axe-core at ${config.viewports.length} viewport(s) (${viewportNames})${extrasNote}...`
    )
  );

  // Each (target, viewport) pair is its own job, so viewports for different
  // pages can run in parallel.
  const jobs = [];
  for (const target of targets) {
    for (const viewport of config.viewports) {
      jobs.push({ target, viewport });
    }
  }

  let results;
  try {
    const jobOutcomes = await runWithConcurrency(
      jobs,
      config.concurrency,
      (job) => auditTargetAtViewport(browser, job.target, job.viewport, config, axeSource),
      makeProgressReporter(jobs.length, 'Auditing', config)
    );

    const byLabel = new Map();
    for (const target of targets) {
      byLabel.set(target.label, { label: target.label, target: target.target, error: null, violations: [], errors: [], focusRechecks: [], review: [] });
    }
    jobOutcomes.forEach((outcome, i) => {
      const { target, viewport } = jobs[i];
      const bucket = byLabel.get(target.label);
      bucket.violations.push(...outcome.violations);
      if (outcome.focusRechecks) bucket.focusRechecks.push(...outcome.focusRechecks);
      if (outcome.review) bucket.review.push(...outcome.review);
      if (outcome.error) bucket.errors.push(`[${viewport.name}] ${outcome.error}`);
    });

    if (config.checkReflow) {
      const reflowOutcomes = await runWithConcurrency(
        targets,
        config.concurrency,
        (target) => auditReflow(browser, target, config),
        makeProgressReporter(targets.length, 'Checking reflow', config)
      );
      reflowOutcomes.forEach((outcome, i) => {
        const bucket = byLabel.get(targets[i].label);
        bucket.violations.push(...outcome.violations);
        if (outcome.error) bucket.errors.push(`[reflow-${config.reflow.width}] ${outcome.error}`);
      });
    }

    results = Array.from(byLabel.values()).map((r) => ({
      label: r.label,
      target: r.target,
      error: r.errors.length ? r.errors.join('; ') : null,
      violations: r.violations,
      focusRechecks: r.focusRechecks,
      review: r.review,
    }));
  } finally {
    await browser.close();
    await stopServer(serverProcess);
  }

  const { blockingCount, erroredTargets } = printReport(results, config);

  if (config.jsonReport) {
    const reportPath = path.resolve(cwd, config.jsonReport);
    try {
      fs.writeFileSync(reportPath, JSON.stringify({ config, results }, null, 2));
      console.log(`\nFull JSON report written to ${reportPath}`);
    } catch (err) {
      // A report-writing failure is a side effect, not the actual audit
      // result — warn and keep going rather than letting it override the
      // real pass/fail exit code below.
      console.warn(c.yellow(`\nCould not write JSON report to ${reportPath}: ${err.message}`));
    }
  }

  if (blockingCount > 0) {
    console.error(
      c.red(
        `\n✗ Build blocked: ${blockingCount} issue(s) at or above the "${config.failOn}" threshold.`
      )
    );
    process.exit(1);
  }

  if (erroredTargets > 0) {
    console.error(
      c.red(
        `\n✗ Build blocked: ${erroredTargets} target(s) could not be audited (see errors above).`
      )
    );
    process.exit(1);
  }

  console.log(c.green('\n✓ No blocking accessibility issues found.'));
  process.exit(0);
}

main().catch((err) => {
  console.error(c.red('a11y-check: unexpected error'));
  console.error(err);
  process.exit(1);
});
