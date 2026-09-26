#!/usr/bin/env node
/**
 * Minimal self-test for a11y-check.js. Runs the CLI against fixture pages
 * and asserts it exits with the correct code:
 *   - a directory with a known-critical violation must BLOCK (exit 1)
 *   - a clean page must PASS (exit 0)
 *   - a project with no config/targets must skip cleanly (exit 0)
 *
 * Not a substitute for a full test framework — this exists so the CI
 * workflow has something real to run and this repo proves its own claims.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'scripts', 'a11y-check.js');
const FIXTURES = path.join(__dirname, 'fixtures');

let failures = 0;

function run(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
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

console.log('Running a11y-gate self-tests...\n');

// 1. Fixtures dir has a critical violation (missing alt, unlabeled button) -> must block
{
  const result = run(['--dir', FIXTURES, '--fail-on', 'critical']);
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-gate-clean-'));
  fs.copyFileSync(path.join(FIXTURES, 'good.html'), path.join(tmpDir, 'good.html'));
  const result = run(['--dir', tmpDir, '--fail-on', 'critical']);
  check(
    'passes a clean page with no critical violations',
    result.status === 0,
    `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// 3. No config file, no build output dir present -> should skip, not fail
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-gate-empty-'));
  const result = run([], tmpDir);
  check(
    'does not block an unconfigured project',
    result.status === 0,
    `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// 4. Text still fading in reads as low contrast; --reduced-motion audits the settled page
{
  const motionDir = path.join(__dirname, 'motion');
  const animated = run(['--dir', motionDir, '--fail-on', 'serious']);
  check(
    'flags text caught mid-animation',
    animated.status === 1 && animated.stdout.includes('color-contrast'),
    `expected exit 1 with color-contrast, got ${animated.status}\n${animated.stdout}\n${animated.stderr}`
  );
  const settled = run(['--dir', motionDir, '--fail-on', 'serious', '--reduced-motion']);
  check(
    'audits the settled page with --reduced-motion',
    settled.status === 0,
    `expected exit 0, got ${settled.status}\n${settled.stdout}\n${settled.stderr}`
  );
}

console.log('');
if (failures > 0) {
  console.error(`${failures} self-test(s) failed.`);
  process.exit(1);
}
console.log('All self-tests passed.');
process.exit(0);
