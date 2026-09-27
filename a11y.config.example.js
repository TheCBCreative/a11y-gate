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
  // Exact pages to audit on a running server (dev server, preview server,
  // etc). Use this for a short, known list of pages. For "every page this
  // app has", use `crawl` below instead — it's usually less to maintain
  // and won't quietly miss a new route you forgot to add here.
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

  // --- Crawl mode ----------------------------------------------------------
  // Discover pages automatically by following same-origin links, starting
  // from one or more seed URLs, instead of hand-listing every route in
  // `urls`. This is the option to reach for when you want "every rendered
  // page in the app", not just the ones you remembered to list.
  crawl: {
    from: [
      // 'http://localhost:3000/',
    ],
    maxPages: 200, // hard cap so a runaway site (or infinite pagination) can't run forever
    maxDepth: 25, // how many link-hops from a seed URL to follow
    includeExternal: false, // set true to also follow links off the seed's origin
  },

  // --- Static HTML mode ---------------------------------------------------
  // Directories to recursively scan for .html files (e.g. a static site
  // build, or output from a static-site generator). Every matching file is
  // audited — there's no separate "crawl" needed for static output, since
  // walking the directory already finds every page. Leave empty [] if this
  // project has no static HTML output to check. If you set none of `urls`,
  // `staticDirs`, or `crawl.from`, and there's no config file at all, the
  // script auto-detects common build folders (dist/build/out/public) if
  // present.
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

  // --- Motion ---------------------------------------------------------------
  // On by default: forces CSS animations/transitions to their end state,
  // emulates prefers-reduced-motion: reduce, and waits `motionSettleDelay`
  // ms after load before auditing — so a page is always checked in its
  // settled state, whether the motion is CSS-driven or JS-driven, and
  // whether or not the site itself honors prefers-reduced-motion. Turn off
  // only if you deliberately want to audit pages mid-animation.
  reducedMotion: true,
  motionSettleDelay: 300, // ms to wait after load for JS-driven motion to finish

  // --- Focus visibility ------------------------------------------------
  // On by default: tabs through every real keyboard stop on the page and
  // flags any interactive element (links, buttons, form fields, etc.) whose
  // focus state looks identical to its resting state — axe-core has no rule
  // for this (WCAG 2.4.7), since it only checks that an element *has* a
  // name, not that focus is visible.
  checkFocusVisibility: true,
  focusVisibility: {
    maxStops: 400, // safety cap on how many Tab presses to make per page
    impact: 'serious', // how this is reported/gated alongside axe's own severities
  },

  // --- Keyboard operability ---------------------------------------------
  // On by default: found during the same Tab traversal as focus-visibility.
  // Flags a genuine keyboard trap (Tab stops moving focus at all — always
  // 'critical', not configurable, since it can leave someone fully stuck)
  // and any element that looks interactive (an onclick handler, or an
  // interactive ARIA role) but has no tabindex, so a keyboard user can never
  // reach it at all.
  checkKeyboardOperability: true,
  keyboardOperability: {
    impact: 'serious',
  },

  // --- Reflow (WCAG 1.4.10) ---------------------------------------------
  // On by default: re-audits every page at a 320px-wide viewport (the
  // standard stand-in for a 1280px design at 400% browser zoom) and flags
  // any page that needs horizontal scrolling to read — vertical scrolling
  // is always fine, only horizontal is a failure.
  checkReflow: true,
  reflow: {
    width: 320,
    height: 900,
    impact: 'serious',
  },

  // --- Interactive states ------------------------------------------------
  // On by default: axe (and everything above) only ever sees a page as it
  // looks at load — a lot of real bugs live inside a modal, dropdown,
  // mobile nav panel, or accordion section that doesn't exist until it's
  // opened. This finds every disclosure widget on the page (aria-expanded,
  // aria-haspopup, <details>/<summary>, data-toggle), opens each one, and
  // re-runs the full audit against whatever it reveals. Never submits
  // forms — see README's "Interactive states" section for why.
  checkInteractiveStates: true,
  interactiveStates: {
    maxTriggers: 5, // each one is a full extra page load — raise for more coverage, at the cost of speed
    settleDelay: 250, // ms to wait after the click before auditing
  },

  // --- Viewports -----------------------------------------------------------
  // On by default: every page is audited at BOTH a desktop and a mobile
  // viewport (each reported violation says which one it came from), since
  // a lot of real issues — overlapping text, hidden controls, tiny tap
  // targets — only show up at one size or the other. The mobile pass also
  // turns on axe's `target-size` rule (touch target size, WCAG 2.5.8),
  // which is off by default in axe-core. Omit `viewports` entirely to keep
  // this default; set it to run your own list instead (each item needs a
  // `name`, and can set `extraRules` the way the built-in mobile one does):
  // viewports: [
  //   { name: 'desktop', width: 1280, height: 900 },
  //   { name: 'mobile', width: 375, height: 667, isMobile: true, hasTouch: true, deviceScaleFactor: 2, extraRules: ['target-size'] },
  //   { name: 'tablet', width: 768, height: 1024 },
  // ],
  //
  // The old singular `viewport` option (a single object) still works
  // exactly as before, for a project that only wants one custom size and no
  // automatic mobile pass:
  // viewport: { width: 1440, height: 900 },

  // --- Misc ---------------------------------------------------------------
  concurrency: 4, // how many (page, viewport) audits to run in parallel
  timeout: 30000, // ms, per-page navigation timeout
  jsonReport: null, // e.g. 'a11y-report.json' to write a full machine-readable report
};
