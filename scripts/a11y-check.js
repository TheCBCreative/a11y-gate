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

  while (queue.length && discovered.length < maxPages) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    discovered.push(url);

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

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok || (res.status >= 200 && res.status < 500)) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function startServer(serverConfig, cwd) {
  const child = spawn(serverConfig.command, {
    cwd,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  return child;
}

function stopServer(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, 'SIGTERM'); // kill whole process group
    } else {
      child.kill();
    }
  } catch {
    // already dead — fine
  }
}

// ---------------------------------------------------------------------------
// Focus-visibility check (real keyboard traversal — axe has no equivalent)
// ---------------------------------------------------------------------------

async function auditFocusVisibility(page, focusConfig) {
  const maxStops = (focusConfig && focusConfig.maxStops) || DEFAULT_MAX_FOCUS_STOPS;

  await page.evaluate(() => {
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
  });

  const flagged = [];
  const trapped = [];
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

        function snapshot(target) {
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
        }

        const focusedSnapshot = snapshot(el);
        el.blur();
        const restingSnapshot = snapshot(el);
        el.focus({ preventScroll: true });

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
          changed: focusedSnapshot !== restingSnapshot,
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

    if (!info.changed) flagged.push(info.descriptor);
  }

  await page
    .evaluate(() => {
      document.querySelectorAll('[data-a11y-gate-key]').forEach((el) => el.removeAttribute('data-a11y-gate-key'));
    })
    .catch(() => {});

  return { flagged, trapped };
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

    if (config.checkFocusVisibility) {
      const { flagged, trapped } = await auditFocusVisibility(page, config.focusVisibility);
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

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, runOne);
  await Promise.all(workers);
  return results;
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

  console.log('\n' + c.bold('Summary'));
  console.log(
    `  critical: ${counts.critical}   serious: ${counts.serious}   moderate: ${counts.moderate}   minor: ${counts.minor}   unknown: ${counts.unknown}`
  );
  console.log(`  fail-on threshold: ${c.bold(config.failOn)} (and anything more severe)`);

  return { blockingCount, erroredTargets, counts };
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

  const { config, hadConfigFile } = loadConfig(args, cwd);

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
    console.log(c.cyan(`Starting server: ${config.server.command}`));
    serverProcess = startServer(config.server, cwd);
    const ready = await waitForServer(
      config.server.url,
      config.server.readyTimeout || DEFAULT_TIMEOUT_MS
    );
    if (!ready) {
      console.error(
        c.red(
          `Server did not become ready at ${config.server.url} within ${
            config.server.readyTimeout || DEFAULT_TIMEOUT_MS
          }ms.`
        )
      );
      stopServer(serverProcess);
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
    stopServer(serverProcess);
    process.exit(1);
  }

  const browser = await puppeteer.launch({
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
    stopServer(serverProcess);
    console.error(c.red(`a11y-check: crawl failed: ${err.message}`));
    process.exit(1);
  }

  if (targets.length === 0) {
    await browser.close();
    stopServer(serverProcess);
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
    const jobOutcomes = await runWithConcurrency(jobs, config.concurrency, (job) =>
      auditTargetAtViewport(browser, job.target, job.viewport, config, axeSource)
    );

    const byLabel = new Map();
    for (const target of targets) {
      byLabel.set(target.label, { label: target.label, target: target.target, error: null, violations: [], errors: [] });
    }
    jobOutcomes.forEach((outcome, i) => {
      const { target, viewport } = jobs[i];
      const bucket = byLabel.get(target.label);
      bucket.violations.push(...outcome.violations);
      if (outcome.error) bucket.errors.push(`[${viewport.name}] ${outcome.error}`);
    });

    if (config.checkReflow) {
      const reflowOutcomes = await runWithConcurrency(targets, config.concurrency, (target) =>
        auditReflow(browser, target, config)
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
    }));
  } finally {
    await browser.close();
    stopServer(serverProcess);
  }

  const { blockingCount, erroredTargets } = printReport(results, config);

  if (config.jsonReport) {
    const reportPath = path.resolve(cwd, config.jsonReport);
    fs.writeFileSync(reportPath, JSON.stringify({ config, results }, null, 2));
    console.log(`\nFull JSON report written to ${reportPath}`);
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
