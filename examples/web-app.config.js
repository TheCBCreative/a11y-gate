/**
 * Example: a client-rendered web app (React/Vue/Svelte/etc). a11y-gate
 * starts the dev server itself, waits for it to respond, audits the
 * listed routes, then shuts the server back down.
 *
 * Wire this up as `prebuild`, since it only needs a running server, not
 * build output:
 *
 *   "scripts": {
 *     "prebuild": "a11y-gate",
 *     "build": "your-build-command"
 *   }
 */

module.exports = {
  urls: [
    'http://localhost:3000/',
    'http://localhost:3000/login',
    'http://localhost:3000/dashboard',
  ],
  server: {
    command: 'npm run dev',
    url: 'http://localhost:3000/',
    readyTimeout: 30000,
  },
  failOn: 'critical',
};
