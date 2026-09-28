#!/usr/bin/env node
/**
 * Self-test for a11y-check.js. Runs the CLI against fixture pages and a
 * couple of throwaway local servers, and asserts it exits with the correct
 * code and reports the right things. Not a substitute for a full test
 * framework — this exists so the CI workflow has something real to run and
 * this repo proves its own claims.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'scripts', 'a11y-check.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const FOCUS_FIXTURES = path.join(__dirname, 'focus');
const CRAWL_FIXTURES = path.join(__dirname, 'crawl-fixtures');
const VIEWPORT_FIXTURES = path.join(__dirname, 'viewport');
const KEYBOARD_FIXTURES = path.join(__dirname, 'keyboard');
const REFLOW_FIXTURES = path.join(__dirname, 'reflow');
const INTERACTIVE_FIXTURES = path.join(__dirname, 'interactive');

let failures = 0;

// Async on purpose: several tests below run a throwaway HTTP server in this
// same process while the CLI (as a child process) makes requests to it. A
// synchronous spawn would freeze this process's event loop for the child's
// entire lifetime, so that in-process server could never actually respond —
// the request would hang until the CLI's own timeout, not ours.
function run(args, cwd, envOverrides) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: cwd || process.cwd(),
      env: envOverrides ? Object.assign({}, process.env, envOverrides) : process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function check(name, condition, details) {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}`);
    if (details) console.log(`    ${details}`);
    failures++;
  }
}

function tmpDirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-gate-'));
  for (const [name, src] of Object.entries(files)) {
    fs.copyFileSync(src, path.join(dir, name));
  }
  return dir;
}

function writeConfig(dir, configObjSource) {
  const p = path.join(dir, 'a11y.config.js');
  fs.writeFileSync(p, `module.exports = ${configObjSource};\n`);
  return p;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function serveStatic(rootDir, port) {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(rootDir, urlPath);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function main() {
  console.log('Running a11y-gate self-tests...\n');

  // 1. Fixtures dir has a critical violation (missing alt, unlabeled button) -> must block
  {
    const result = await run(['--dir', FIXTURES, '--fail-on', 'critical']);
    check(
      'blocks the build when a critical violation is present',
      result.status === 1,
      `expected exit 1, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    check(
      'reports the known critical rule (image-alt)',
      result.stdout.includes('image-alt'),
      result.stdout
    );
  }

  // 2. Only the clean fixture -> must pass
  {
    const tmpDir = tmpDirWith({ 'good.html': path.join(FIXTURES, 'good.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'critical']);
    check(
      'passes a clean page with no critical violations',
      result.status === 0,
      `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 3. No config file, no build output dir present -> should skip, not fail
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-gate-empty-'));
    const result = await run([], tmpDir);
    check(
      'does not block an unconfigured project',
      result.status === 0,
      `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 4. Motion settling is ON by default — a page fading in must be audited
  //    in its settled state with no flags needed.
  {
    const motionDir = path.join(__dirname, 'motion');
    const result = await run(['--dir', motionDir, '--fail-on', 'serious']);
    check(
      'audits the settled page by default (motion settling is on)',
      result.status === 0,
      `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
  }

  // 5. --no-reduced-motion opts back out, so mid-animation contrast is
  //    still catchable for anyone who deliberately wants raw behavior.
  {
    const motionDir = path.join(__dirname, 'motion');
    const result = await run(['--dir', motionDir, '--fail-on', 'serious', '--no-reduced-motion']);
    check(
      '--no-reduced-motion disables settling and catches mid-animation contrast',
      result.status === 1 && result.stdout.includes('color-contrast'),
      `expected exit 1 with color-contrast, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
  }

  // 6. The old explicit --reduced-motion flag still works (back-compat).
  {
    const motionDir = path.join(__dirname, 'motion');
    const result = await run(['--dir', motionDir, '--fail-on', 'serious', '--reduced-motion']);
    check(
      '--reduced-motion explicit flag still settles the page',
      result.status === 0,
      `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
  }

  // 6b. Motion settling must also catch animations run through the Web
  //     Animations API directly (Element.animate()) — how libraries like
  //     Motion/Framer Motion animate — not just CSS animations/transitions.
  //     Regression test for the false-contrast-failure bug where only CSS
  //     animations were force-settled.
  {
    const tmpDir = tmpDirWith({ 'waapi.html': path.join(__dirname, 'motion', 'waapi-animated.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'serious']);
    check(
      'settles a Web Animations API (non-CSS) fade-in by default',
      result.status === 0,
      `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 7. Focus-visibility: a link/button with its outline removed and no
  //    replacement must be flagged even though axe-core has no rule for it.
  {
    const tmpDir = tmpDirWith({ 'bad-focus.html': path.join(FOCUS_FIXTURES, 'bad-focus.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'serious']);
    check(
      'flags an interactive element with no visible focus indicator',
      result.status === 1 && result.stdout.includes('focus-visible-indicator'),
      `expected exit 1 with focus-visible-indicator, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 8. Focus-visibility: a page that keeps the browser's default outline
  //    must NOT be flagged (no false positives on ordinary pages).
  {
    const tmpDir = tmpDirWith({ 'good-focus.html': path.join(FOCUS_FIXTURES, 'good-focus.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'serious']);
    check(
      'does not flag a page that keeps a visible default focus outline',
      result.status === 0,
      `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 9. --no-focus-check turns the whole check off.
  {
    const tmpDir = tmpDirWith({ 'bad-focus.html': path.join(FOCUS_FIXTURES, 'bad-focus.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'serious', '--no-focus-check']);
    check(
      '--no-focus-check skips the focus-visibility check',
      result.status === 0,
      `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 9b. Every page is audited at both a desktop and a mobile viewport by
  //     default, and each reported violation says which one it came from.
  {
    const tmpDir = tmpDirWith({ 'good.html': path.join(FIXTURES, 'good.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'critical']);
    check(
      'audits at both desktop and mobile viewports by default',
      result.stdout.includes('2 viewport(s) (desktop, mobile)'),
      result.stdout
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 9c. The mobile pass turns on axe's target-size rule (off by default),
  //     since it matters most for a touch viewport — two adjacent tiny
  //     buttons are too small and too close together to pass it.
  {
    const tmpDir = tmpDirWith({ 'tiny-target.html': path.join(VIEWPORT_FIXTURES, 'tiny-target.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'serious']);
    check(
      'flags a touch target that is too small and too close to its neighbor (mobile only)',
      result.status === 1 && result.stdout.includes('target-size') && result.stdout.includes('(mobile)'),
      `expected exit 1 with a (mobile) target-size violation, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 9d. --no-mobile skips the mobile pass entirely, so target-size (which
  //     is only turned on for that pass) never runs at all.
  {
    const tmpDir = tmpDirWith({ 'tiny-target.html': path.join(VIEWPORT_FIXTURES, 'tiny-target.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'serious', '--no-mobile']);
    check(
      '--no-mobile skips the mobile viewport (and its target-size check)',
      result.status === 0 && result.stdout.includes('1 viewport(s) (desktop)'),
      `expected exit 0 auditing only desktop, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 9e. --no-desktop mirrors --no-mobile for the other default viewport.
  {
    const tmpDir = tmpDirWith({ 'good.html': path.join(FIXTURES, 'good.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'critical', '--no-desktop']);
    check(
      '--no-desktop skips the desktop viewport',
      result.status === 0 && result.stdout.includes('1 viewport(s) (mobile)'),
      `expected exit 0 auditing only mobile, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 10. Crawl: discovers pages that are never listed anywhere in config —
  //     page-b.html is two hops from the seed URL and only reachable by
  //     actually following links.
  {
    const port = await getFreePort();
    const server = await serveStatic(CRAWL_FIXTURES, port);
    try {
      const result = await run(['--crawl', `http://127.0.0.1:${port}/index.html`, '--fail-on', 'critical']);
      check(
        'crawl discovers and audits a page two hops deep, never listed in config',
        result.status === 1 && result.stdout.includes('image-alt') && result.stdout.includes('page-b.html'),
        `expected exit 1 with image-alt on page-b.html, got ${result.status}\n${result.stdout}\n${result.stderr}`
      );
      check(
        'crawl reports discovering all 3 pages',
        result.stdout.includes('Crawl discovered 3 page'),
        result.stdout
      );
    } finally {
      await closeServer(server);
    }
  }

  // 11. ignoreRules suppresses specific rule IDs project-wide.
  {
    const tmpDir = tmpDirWith({ 'bad.html': path.join(FIXTURES, 'bad.html') });
    writeConfig(tmpDir, `{ staticDirs: ['.'], ignoreRules: ['image-alt', 'button-name'], failOn: 'critical' }`);
    const result = await run([], tmpDir);
    check(
      'ignoreRules suppresses the rules it names',
      result.status === 0 && !result.stdout.includes('image-alt') && !result.stdout.includes('button-name'),
      `expected exit 0 with no image-alt/button-name, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 12. tags restricts which rules run at all (not just which ones block).
  {
    const tmpDir = tmpDirWith({ 'bad.html': path.join(FIXTURES, 'bad.html') });
    writeConfig(tmpDir, `{ staticDirs: ['.'], tags: ['wcag2a'], failOn: 'critical' }`);
    const result = await run([], tmpDir);
    check(
      'tags restricts the rule set (color-contrast is wcag2aa, so it never runs)',
      result.status === 1 && !result.stdout.includes('color-contrast'),
      `expected exit 1 with no color-contrast, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 13. --json-report writes a full, parseable report.
  {
    const tmpDir = tmpDirWith({ 'good.html': path.join(FIXTURES, 'good.html') });
    const reportPath = path.join(tmpDir, 'report.json');
    const result = await run(['--dir', tmpDir, '--fail-on', 'critical', '--json-report', reportPath]);
    let parsed = null;
    let parseError = null;
    try {
      parsed = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (err) {
      parseError = err.message;
    }
    check(
      '--json-report writes a parseable report with the expected shape',
      result.status === 0 &&
        !parseError &&
        Array.isArray(parsed && parsed.results) &&
        parsed.results.length === 1 &&
        parsed.results[0].violations.length === 0,
      `parseError=${parseError}, status=${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 14. The optional `server` config starts a real process, waits for it,
  //     audits it, and tears it down afterward.
  {
    const port = await getFreePort();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-gate-server-'));
    const serverScript = path.join(FIXTURES, 'mini-server.js');
    writeConfig(
      tmpDir,
      `{
        urls: ['http://127.0.0.1:${port}/'],
        server: {
          command: ${JSON.stringify(`node ${serverScript} ${port}`)},
          url: 'http://127.0.0.1:${port}/',
          readyTimeout: 10000,
        },
        failOn: 'critical',
      }`
    );
    const result = await run([], tmpDir);
    check(
      'the server config auto-starts, waits for, and audits a dev server',
      result.status === 0 && result.stdout.includes('Server ready'),
      `expected exit 0 with "Server ready", got ${result.status}\n${result.stdout}\n${result.stderr}`
    );

    // The CLI should have killed the server process on exit; give it a
    // moment, then confirm the port is no longer accepting connections.
    await new Promise((r) => setTimeout(r, 500));
    const stillUp = await new Promise((resolve) => {
      const sock = net.createConnection({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => resolve(false));
    });
    check('the server process is stopped after the audit finishes', !stillUp);

    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 15. Keyboard trap: a widget that swallows Tab must be flagged even
  //     though no axe rule (or the plain focus-visibility check) covers it.
  {
    const tmpDir = tmpDirWith({ 'trap.html': path.join(KEYBOARD_FIXTURES, 'trap.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'critical']);
    check(
      'flags a real keyboard trap',
      result.status === 1 && result.stdout.includes('keyboard-trap'),
      `expected exit 1 with keyboard-trap, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 16. Keyboard operability: a custom "button" with tabindex="-1" looks and
  //     acts clickable but sits outside the tab order entirely.
  {
    const tmpDir = tmpDirWith({ 'unreachable.html': path.join(KEYBOARD_FIXTURES, 'unreachable-widget.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'serious']);
    check(
      'flags a custom widget that a keyboard user can never reach',
      result.status === 1 && result.stdout.includes('keyboard-operable-custom-widget'),
      `expected exit 1 with keyboard-operable-custom-widget, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 17. The same pattern with tabindex="0" must NOT be flagged — no false
  //     positives on a correctly-implemented custom widget.
  {
    const tmpDir = tmpDirWith({ 'reachable.html': path.join(KEYBOARD_FIXTURES, 'reachable-widget.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'serious']);
    check(
      'does not flag a custom widget that is properly reachable by keyboard',
      result.status === 0,
      `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 18. --no-keyboard-check turns both of the above off.
  {
    const tmpDir = tmpDirWith({ 'unreachable.html': path.join(KEYBOARD_FIXTURES, 'unreachable-widget.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'serious', '--no-keyboard-check']);
    check(
      '--no-keyboard-check skips the keyboard-operability check',
      result.status === 0,
      `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 19. Reflow (WCAG 1.4.10): a fixed 900px-wide block forces horizontal
  //     scrolling at the 320px reflow viewport.
  {
    const tmpDir = tmpDirWith({ 'overflow.html': path.join(REFLOW_FIXTURES, 'overflow.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'serious']);
    check(
      'flags a page that needs horizontal scrolling at 320px',
      result.status === 1 && result.stdout.includes('reflow-320'),
      `expected exit 1 with reflow-320, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 20. A fluid layout must NOT be flagged at 320px.
  {
    const tmpDir = tmpDirWith({ 'responsive.html': path.join(REFLOW_FIXTURES, 'responsive.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'serious']);
    check(
      'does not flag a fluid layout at 320px',
      result.status === 0,
      `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 21. --no-reflow turns the 320px pass off entirely.
  {
    const tmpDir = tmpDirWith({ 'overflow.html': path.join(REFLOW_FIXTURES, 'overflow.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'serious', '--no-reflow']);
    check(
      '--no-reflow skips the reflow check',
      result.status === 0,
      `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 22. A violation only present once a dropdown is opened must still be caught.
  {
    const tmpDir = tmpDirWith({ 'dropdown.html': path.join(INTERACTIVE_FIXTURES, 'dropdown.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'critical']);
    check(
      'catches a violation hidden behind a dropdown by opening it',
      result.status === 1 && result.stdout.includes('image-alt') && result.stdout.includes('after opening'),
      `expected exit 1 with image-alt after opening the dropdown, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 23. --no-interactive-states turns that pass off, so the same page passes.
  {
    const tmpDir = tmpDirWith({ 'dropdown.html': path.join(INTERACTIVE_FIXTURES, 'dropdown.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'critical', '--no-interactive-states']);
    check(
      '--no-interactive-states misses the same violation',
      result.status === 0,
      `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 23b. Regression test: opening a trigger can start its own animations
  //      (a menu's items fading in), not just reveal already-settled
  //      content — those need settling too, not just the fixed post-click
  //      delay, or a check can sample them mid-fade as low contrast.
  {
    const tmpDir = tmpDirWith({ 'menu-fade.html': path.join(INTERACTIVE_FIXTURES, 'menu-fade.html') });
    const result = await run(['--dir', tmpDir, '--fail-on', 'serious']);
    check(
      'settles animations a click itself starts, not just ones already running at load',
      result.status === 0,
      `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 24. Regression test for the executable-bit bug that shipped once
  //     already: npm's POSIX bin shim invokes this file directly (not via
  //     `node`), so it must stay executable and its shebang must work.
  if (process.platform !== 'win32') {
    const mode = fs.statSync(CLI).mode;
    check('the CLI file is directly executable (npm bin shim relies on this)', (mode & 0o111) !== 0, `mode: ${mode.toString(8)}`);

    const result = await new Promise((resolve) => {
      const child = spawn(CLI, ['--help']); // spawned directly, not via node
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.on('error', () => resolve({ status: null, stdout: '' }));
      child.on('close', (status) => resolve({ status, stdout }));
    });
    check(
      'the CLI runs directly via its shebang, the way npx invokes it',
      result.status === 0 && result.stdout.includes('Usage:'),
      `expected exit 0 with usage text, got ${JSON.stringify(result)}`
    );
  } else {
    console.log('  (skipped on Windows — direct shebang execution does not apply)');
  }

  // 25. A config file that fails to parse must fail clearly, not crash raw.
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-gate-badconfig-'));
    fs.writeFileSync(path.join(tmpDir, 'a11y.config.json'), '{ this is not valid json');
    const result = await run([], tmpDir);
    check(
      'a malformed config file fails clearly instead of crashing raw',
      result.status === 1 && result.stderr.includes('a11y-check: could not load config'),
      `expected exit 1 with a clear config error, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 26. If Chromium fails to launch, a server this run started must still
  //     be killed rather than leaked as an orphaned process.
  {
    const port = await getFreePort();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-gate-launchfail-'));
    const serverScript = path.join(FIXTURES, 'mini-server.js');
    writeConfig(
      tmpDir,
      `{
        urls: ['http://127.0.0.1:${port}/'],
        server: {
          command: ${JSON.stringify(`node ${serverScript} ${port}`)},
          url: 'http://127.0.0.1:${port}/',
          readyTimeout: 10000,
        },
        failOn: 'critical',
      }`
    );
    const result = await run([], tmpDir, { PUPPETEER_EXECUTABLE_PATH: '/nonexistent/chrome' });
    check(
      'a Chromium launch failure fails clearly rather than crashing raw',
      result.status === 1 && result.stderr.includes('a11y-check: could not launch Chromium'),
      `expected exit 1 with a clear launch error, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );

    await new Promise((r) => setTimeout(r, 500));
    const stillUp = await new Promise((resolve) => {
      const sock = net.createConnection({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => resolve(false));
    });
    check('the server it started is still killed even when the launch fails', !stillUp);
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 27. A page that fails to load during the real audit (not just crawl
  //     discovery) is reported as an error and blocks the build.
  {
    const result = await run(['--url', 'http://127.0.0.1:1/', '--fail-on', 'critical']);
    check(
      'a target that fails to load is reported as an error and blocks the build',
      result.status === 1 && result.stdout.includes('ERROR') && result.stdout.includes('could not audit'),
      `expected exit 1 with an ERROR line, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
  }

  // 28. An unwritable --json-report path should warn, not crash or mask the
  //     real pass/fail result underneath it.
  {
    const tmpDir = tmpDirWith({ 'good.html': path.join(FIXTURES, 'good.html') });
    const badReportPath = path.join(tmpDir, 'nonexistent-subdir', 'report.json');
    const result = await run(['--dir', tmpDir, '--fail-on', 'critical', '--json-report', badReportPath]);
    check(
      'an unwritable JSON report path warns but does not crash or mask the real result',
      result.status === 0 && result.stderr.includes('Could not write JSON report'),
      `expected exit 0 with a JSON-report warning, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    // maxRetries/retryDelay: on Windows, a just-killed process (or antivirus
    // scanning a just-written temp file) can hold the directory a beat
    // longer than the kill call itself takes to return — a bare rmSync can
    // hit EBUSY/ENOTEMPTY in that window. Retrying briefly is the documented
    // way around it and is a no-op everywhere else.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures} self-test(s) failed.`);
    process.exit(1);
  }
  console.log('All self-tests passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Self-test runner crashed:', err);
  process.exit(1);
});
