/**
 * a11y.config.js
 * -----------------------------------------------------------------------
 * Copy this file to the root of your project as `a11y.config.js` and
 * adjust it for that project. Only set the fields you need — anything
 * you omit falls back to a sane default (see scripts/a11y-check.js).
 * -----------------------------------------------------------------------
 */

module.exports = {
  // --- Web app mode ------------------------------------------------------
  // Pages to audit on a running server (dev server, preview server, etc).
  // Leave empty [] if this project has no server-rendered pages to check.
  urls: [
    // 'http://localhost:3000/',
    // 'http://localhost:3000/login',
    // 'http://localhost:3000/dashboard',
  ],

  // Optional: have the script start the server itself before auditing,
  // wait for it to respond, then shut it down afterwards. Omit/set to
  // null if you already start the server yourself (e.g. in a separate
  // CI step) before this script runs.
  server: null,
  // server: {
  //   command: 'npm run start',
  //   url: 'http://localhost:3000/',
  //   readyTimeout: 30000, // ms to wait for the server to respond
  // },

  // --- Static HTML mode ---------------------------------------------------
  // Directories to recursively scan for .html files (e.g. a static site
  // build, or output from a static-site generator). Leave empty [] if this
  // project has no static HTML output to check. If you set neither `urls`
  // nor `staticDirs` nor a config file at all, the script auto-detects
  // common build folders (dist/build/out/public) if present.
  staticDirs: [
    // 'dist',
  ],
  staticExtensions: ['.html', '.htm'],
  excludePaths: [
    // substrings to skip while walking staticDirs, e.g. 'vendor', 'legacy'
  ],

  // --- Rules ---------------------------------------------------------------
  // axe-core rule IDs to disable entirely (project-wide false positives).
  // See https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md
  ignoreRules: [
    // 'color-contrast',
  ],

  // Restrict which axe rule set runs, by WCAG tag. Leave null to run
  // axe-core's full default rule set (roughly WCAG 2.1 A/AA + best practices).
  tags: null,
  // tags: ['wcag2a', 'wcag2aa', 'wcag21aa'],

  // --- Severity gate ---------------------------------------------------
  // Violations at this severity or worse BLOCK the build (non-zero exit).
  // Anything less severe is still printed, but only as a warning.
  // One of: 'critical' | 'serious' | 'moderate' | 'minor'
  failOn: 'critical',

  // --- Misc ---------------------------------------------------------------
  concurrency: 4, // how many pages to audit in parallel
  timeout: 30000, // ms, per-page navigation timeout
  viewport: { width: 1280, height: 900 },
  jsonReport: null, // e.g. 'a11y-report.json' to write a full machine-readable report
};
