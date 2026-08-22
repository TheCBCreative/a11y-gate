/**
 * Example: a static site / SSG build (e.g. Eleventy, Astro's static output,
 * Jekyll, Hugo). No server needed — a11y-gate walks the built HTML directly.
 *
 * Wire this up as `postbuild` in package.json, since `dist/` has to exist
 * before there's anything to scan:
 *
 *   "scripts": {
 *     "build": "your-build-command",
 *     "postbuild": "a11y-gate"
 *   }
 */

module.exports = {
  staticDirs: ['dist'],
  ignoreRules: [],
  failOn: 'critical',
};
