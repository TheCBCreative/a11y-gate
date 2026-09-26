# a11y-gate

[![npm](https://img.shields.io/npm/v/a11y-gate.svg)](https://www.npmjs.com/package/a11y-gate)
[![CI](https://github.com/TheCBCreative/a11y-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/TheCBCreative/a11y-gate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A drop-in accessibility gate for any project's build pipeline. It runs [axe-core](https://github.com/dequelabs/axe-core)
against real rendered pages — either a live server or static HTML output — and fails the build
(non-zero exit code) when it finds **critical** issues. Everything less severe (serious/moderate/minor)
is printed as a warning but does not block, so teams can adopt it without a wall of pre-existing issues
stopping every build on day one.

## Why

Most accessibility tooling is either a linter that only catches what's visible in source (missing `alt`,
invalid `aria-*`) or a full audit dashboard that's too heavy to run on every build. a11y-gate sits in
between: it checks the actual rendered DOM with the same engine Lighthouse and Chrome DevTools use, is
cheap enough to run on every `npm run build`, and only blocks on the violations that genuinely block
users — everything else stays visible without stopping anyone's work.

## Install

```bash
npm install --save-dev a11y-gate
```

This pulls in `puppeteer` and `axe-core` as part of the install — no separate setup step.

## Configure

Copy the example config to your project root and edit it for that project:

```bash
cp node_modules/a11y-gate/a11y.config.example.js a11y.config.js
```

Every project falls into one (or both) of two shapes — see [`examples/`](examples) for complete, ready
to copy configs of each:

**Web app** ([`examples/web-app.config.js`](examples/web-app.config.js)) — pages that need JavaScript to
render. Point at a running server, and optionally let a11y-gate start/stop it for you:

```js
module.exports = {
  urls: ['http://localhost:3000/'],
  server: {
    command: 'npm run dev',
    url: 'http://localhost:3000/',
    readyTimeout: 30000,
  },
  failOn: 'critical',
};
```

**Static site** ([`examples/static-site.config.js`](examples/static-site.config.js)) — plain HTML build
output (static-site generators, prerendered builds):

```js
module.exports = {
  staticDirs: ['dist'],
  failOn: 'critical',
};
```

You can set both `urls` and `staticDirs` in one config if a project has both kinds of pages. With no
config file at all, a11y-gate auto-detects a common build folder (`dist`, `build`, `out`, `public`) if
one exists, and otherwise skips itself (exit 0) with a message telling you to configure it — dropping
this into a project never breaks an unconfigured build.

Full option reference (ignoreRules, tags, concurrency, timeout, viewport, jsonReport, etc.) is documented
inline in [`a11y.config.example.js`](a11y.config.example.js).

## Wire it into your build

Once installed, `a11y-gate` is available as a binary via npm scripts.

**A note on prebuild vs. postbuild**, because it matters which one fits your project:

- Checking a **running server** (`urls` + a dev/preview server) → `prebuild`, since it doesn't depend on
  build output existing yet.
- Checking **static build output** (`staticDirs` pointing at `dist/`) → `postbuild`, since the build has
  to run *first* to produce that HTML. `prebuild`/`postbuild` are npm lifecycle hooks — npm runs them
  automatically around `npm run build`, no extra wiring needed.

```json
{
  "scripts": {
    "prebuild": "a11y-gate",
    "build": "vite build",
    "postbuild": "a11y-gate"
  }
}
```

Only add the hook that matches how that project is configured — most projects use one or the other, not
both.

### CI (GitHub Actions example)

```yaml
- name: Install dependencies
  run: npm ci

- name: Build
  run: npm run build   # runs prebuild/postbuild automatically, fails the job on critical a11y issues
```

Or as an explicit step:

```yaml
- name: Accessibility check
  run: npx a11y-gate
```

**Docker/CI sandboxing:** a11y-gate already launches Chromium with `--no-sandbox --disable-setuid-sandbox`,
which containers normally require, so no extra flags should be needed there.

## What blocks vs. what warns

By default, only `critical` axe-core violations (impact === "critical") fail the build — things like a
form input with no accessible name, or a button with no discernible text. `serious`, `moderate`, and
`minor` findings are still printed in full, but as warnings only.

Tighten this per project by setting `failOn` in that project's `a11y.config.js`:

```js
failOn: 'serious', // blocks on critical AND serious
```

Valid values, strictest to loosest: `critical` → `serious` → `moderate` → `minor`.

## CLI flags

Override config without editing the file:

```
a11y-gate \
  --url http://localhost:3000/ \
  --dir dist \
  --fail-on serious \
  --json-report a11y-report.json \
  --config custom-a11y.config.js \
  --no-color
```

## Troubleshooting

- **"Could not find Chrome"** — `puppeteer` wasn't able to download its bundled Chromium (common on
  locked-down networks/CI images). Either allow the download, or install Chromium separately and set the
  `PUPPETEER_EXECUTABLE_PATH` environment variable to its path before running.
- **Server never becomes ready** — increase `server.readyTimeout`, or confirm `server.url` matches what
  the server actually listens on (host/port/path).
- **False positives on a specific rule** — add the axe-core rule ID to `ignoreRules` in that project's
  config rather than disabling the whole check. Rule IDs are printed in the report; see the
  [axe-core rule list](https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md).
- **A single flaky/slow page times out** — raise `timeout` (ms) in the config; it applies per-page.

## Development

```bash
git clone https://github.com/TheCBCreative/a11y-gate.git
cd a11y-gate
npm install
npm test        # runs the self-test suite against test/fixtures
```

`test/run-tests.js` runs the CLI against known-good and known-bad fixture pages and asserts the exit
codes are correct — this is what the CI badge above is actually running.

## License

[MIT](LICENSE)
