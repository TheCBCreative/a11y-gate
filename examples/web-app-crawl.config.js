/**
 * Example: a client- or server-rendered web app where you want every
 * reachable page audited, not just a hand-maintained list of routes.
 * a11y-gate starts the dev server itself, crawls same-origin links starting
 * from the seed URL, audits every page it finds, then shuts the server
 * back down.
 *
 * This is the option to reach for over `urls` when the app has more pages
 * than you want to keep in sync by hand, or when you specifically want to
 * catch a new page that nobody remembered to add to a config file.
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
  crawl: {
    from: ['http://localhost:3000/'],
    maxPages: 200,
    maxDepth: 25,
  },
  server: {
    command: 'npm run dev',
    url: 'http://localhost:3000/',
    readyTimeout: 30000,
  },
  failOn: 'critical',
};
