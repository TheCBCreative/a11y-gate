#!/usr/bin/env node
/**
 * a11y-check.js
 * -----------------------------------------------------------------------
 * Drop-in accessibility gate for any project. Runs axe-core against a
 * headless Chromium instance for every target page you configure — either
 * live URLs (a dev/build server) or static HTML files on disk — and fails
 * the process (non-zero exit code) when it finds violations at or above
 * your configured severity threshold. Everything below that threshold is
 * printed as a warning but does not block.
 *
 * Usage:
 *   node scripts/a11y-check.js [options]
 *
 * Options:
 *   --config <path>      Path to config file (default: a11y.config.js or
 *                         a11y.config.json in the current directory)
 *   --url <url>           Add a URL to check (repeatable)
 *   --dir <path>          Add a directory of static HTML to check (repeatable)
 *   --fail-on <level>     critical | serious | moderate | minor (default: critical)
 *   --reduced-motion      Audit with prefers-reduced-motion: reduce, so pages
 *                         that animate content in are checked in their final state
 *   --json-report <path>  Write a full JSON report to this path
 *   --no-color            Disable colored output
 *   --help                Show this help text
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
  const args = { urls: [], dirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--url') args.urls.push(argv[++i]);
    else if (a === '--dir') args.dirs.push(argv[++i]);
    else if (a === '--fail-on') args.failOn = argv[++i];
    else if (a === '--json-report') args.jsonReport = argv[++i];
    else if (a === '--reduced-motion') args.reducedMotion = true;
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
      viewport: { width: 1280, height: 900 },
      server: null, // { command, url, readyTimeout }
      jsonReport: null,
      excludePaths: [], // substrings to skip when walking staticDirs
      reducedMotion: false, // emulate prefers-reduced-motion: reduce
    },
    fileConfig
  );

  // CLI overrides
  if (args.urls.length) config.urls = config.urls.concat(args.urls);
  if (args.dirs.length) config.staticDirs = config.staticDirs.concat(args.dirs);
  if (args.failOn) config.failOn = args.failOn;
  if (args.jsonReport) config.jsonReport = args.jsonReport;
  if (args.reducedMotion) config.reducedMotion = true;

  // Auto-detect static output dirs only if nothing was configured or passed at all
  const nothingConfigured =
    !hadConfigFile && config.urls.length === 0 && config.staticDirs.length === 0;
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
// Target discovery
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

function collectTargets(config, cwd) {
  const targets = [];

  for (const url of config.urls) {
    targets.push({ type: 'url', target: url, label: url });
  }

  for (const dir of config.staticDirs) {
    const isAbsoluteDir = path.isAbsolute(dir);
    const abs = isAbsoluteDir ? dir : path.join(cwd, dir);
    const files = walkHtmlFiles(abs, config.staticExtensions, config.excludePaths);
    for (const f of files) {
      const label = isAbsoluteDir ? f : path.relative(cwd, f);
      targets.push({ type: 'file', target: 'file://' + f, label });
    }
  }

  return targets;
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
// Running axe against each target
// ---------------------------------------------------------------------------

async function auditTarget(browser, target, config, axeSource) {
  const page = await browser.newPage();
  await page.setViewport(config.viewport);
  const result = { label: target.label, target: target.target, error: null, violations: [] };

  try {
    // Entrance animations caught mid-fade read as low contrast; reduced motion shows the settled page.
    if (config.reducedMotion) {
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    }
    await page.goto(target.target, { waitUntil: 'networkidle0', timeout: config.timeout });
    await page.evaluate(axeSource);

    const ignoreRules = {};
    for (const ruleId of config.ignoreRules) ignoreRules[ruleId] = { enabled: false };

    const axeOptions = { rules: ignoreRules };
    if (config.tags) axeOptions.runOnly = { type: 'tag', values: config.tags };

    const axeResults = await page.evaluate((opts) => window.axe.run(document, opts), axeOptions);
    result.violations = axeResults.violations.map((v) => ({
      id: v.id,
      impact: v.impact || 'unknown',
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5),
      nodeCount: v.nodes.length,
    }));
  } catch (err) {
    result.error = err.message;
  } finally {
    await page.close();
  }

  return result;
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
      console.log(`  ${marker} ${label}  ${c.bold(v.id)} — ${v.help}`);
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

  if (!hadConfigFile && config.urls.length === 0 && config.staticDirs.length === 0) {
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

  const targets = collectTargets(config, cwd);

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

  if (targets.length === 0) {
    console.error(
      c.red(
        'a11y-check: config was found but resolved to zero pages to audit. ' +
          'Check your `urls` / `staticDirs` settings in the config file.'
      )
    );
    stopServer(serverProcess);
    process.exit(1);
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

  const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

  console.log(c.cyan(`Auditing ${targets.length} page(s) with axe-core...`));

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let results;
  try {
    results = await runWithConcurrency(targets, config.concurrency, (target) =>
      auditTarget(browser, target, config, axeSource)
    );
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
