# a11y-gate

[![npm](https://img.shields.io/npm/v/a11y-gate.svg)](https://www.npmjs.com/package/a11y-gate)
[![CI](https://github.com/TheCBCreative/a11y-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/TheCBCreative/a11y-gate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A drop-in accessibility gate for any project's build pipeline. It runs [axe-core](https://github.com/dequelabs/axe-core)
against real rendered pages — a live server (optionally crawled page-by-page automatically), or static
HTML output — at both a desktop and a mobile viewport, inside every modal/dropdown/accordion it can find,
and at a 320px reflow viewport. On top of axe it adds keyboard checks axe has no equivalent for (focus
visibility, keyboard traps, unreachable custom widgets), then fails the build (non-zero exit code) when it
finds **critical** issues. Everything less severe (serious/moderate/minor) is printed as a warning but does
not block, so teams can adopt it without a wall of pre-existing issues stopping every build on day one.

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

This pulls in `puppeteer` and `axe-core` as part of the install — no separate setup step. Requires Node 22.12 or later, Puppeteer's minimum.

## Configure

Copy the example config to your project root and edit it for that project:

```bash
cp node_modules/a11y-gate/a11y.config.example.js a11y.config.js
```

Every project falls into one or more of three shapes — see [`examples/`](examples) for complete, ready
to copy configs of each:

**Web app, every page** ([`examples/web-app-crawl.config.js`](examples/web-app-crawl.config.js)) — the
option to reach for when you want "every rendered page in the app" checked, not a hand-maintained list.
a11y-gate follows same-origin links starting from one or more seed URLs and audits everything it finds:

```js
module.exports = {
  crawl: { from: ['http://localhost:3000/'] },
  server: {
    command: 'npm run dev',
    url: 'http://localhost:3000/',
    readyTimeout: 30000,
  },
  failOn: 'critical',
};
```

**Web app, specific pages** ([`examples/web-app.config.js`](examples/web-app.config.js)) — a short, known
list of routes. Point at a running server, and optionally let a11y-gate start/stop it for you:

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
output (static-site generators, prerendered builds). Every `.html` file under the directory is walked and
audited, so this already covers "every page" without a separate crawl step:

```js
module.exports = {
  staticDirs: ['dist'],
  failOn: 'critical',
};
```

You can combine `urls`, `crawl`, and `staticDirs` in one config if a project has more than one kind of
page. With no config file at all, a11y-gate auto-detects a common build folder (`dist`, `build`, `out`,
`public`) if one exists, and otherwise skips itself (exit 0) with a message telling you to configure it —
dropping this into a project never breaks an unconfigured build.

Full option reference (`crawl`, `viewports`, `ignoreRules`, `tags`, `concurrency`, `timeout`,
`reducedMotion`, `motionSettleDelay`, `checkFocusVisibility`, `focusVisibility`, `jsonReport`, etc.) is
documented inline in [`a11y.config.example.js`](a11y.config.example.js).

## What this actually checks

axe-core plus one custom check cover a meaningful chunk of accessibility automatically, but no tool —
this one included — can automatically verify "meets all accessibility." Here's what maps to what:

| You want to know...                       | What covers it                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Color contrast is good                     | axe's `color-contrast` rule (WCAG 1.4.3), run on the page in its fully settled state (see [Motion](#motion) below) |
| Alt text is present where it's needed      | axe's `image-alt`, `input-image-alt`, `area-alt`, `role-img-alt`, `svg-img-alt`, `object-alt` rules                |
| Links/hovers are accessible                | axe's `link-name` (discernible link text) **plus** custom focus-visibility, keyboard-trap, and keyboard-operability checks (below) — hover/focus-persistent content (WCAG 1.4.13) still needs a manual check, see below |
| Screen readers can read it                 | axe's ARIA/semantics rule family — `aria-*`, `label`, `document-title`, `html-has-lang`, `landmark-*`, `heading-order`, `page-has-heading-one`, `region`, `bypass`, `duplicate-id`, and more (roughly 40 of axe's rules, all on by default) — this checks the structure a screen reader relies on (including heading order and landmark regions), not what one actually announces; a real pass with VoiceOver/NVDA/JAWS is still the only way to be fully sure |
| Every rendered page, regardless of motion  | `crawl` (web apps) / `staticDirs` (static builds) for full-site coverage, plus forced motion-settling so a page mid-animation never hides or fakes a result (see below) |
| Works on mobile as well as desktop         | Every page is audited at both a desktop and a mobile viewport by default, and the mobile pass also turns on axe's `target-size` rule (touch target size) — see [Viewports](#viewports) below |
| Content behind menus/modals/accordions     | [Interactive-state auditing](#interactive-states) re-runs the full audit after opening every disclosure widget it can find, since axe otherwise only ever sees the page as it first loads |
| No horizontal scrolling when zoomed        | The [reflow check](#reflow) re-audits every page at a 320px viewport (WCAG 1.4.10) |
| Meets all accessibility                    | No automated tool can promise this — see [What still needs a manual check](#what-still-needs-a-manual-check) below |

By default (`tags: null`) axe-core runs its full rule set — everything except rules it marks
experimental/deprecated — which is broader than WCAG 2.1 A/AA alone (it also includes axe's best-practice
rules, Section 508, and EN 301 549). Narrow this with `tags` if you only want a stricter WCAG subset.

## What still needs a manual check

Deque (axe-core's maintainer) estimates automated tools catch roughly 30–50% of WCAG issues on their own.
Everything on this page pushes a11y-gate well past that baseline, but a passing run is not a certification —
these still need a human, and no amount of additional automation changes that:

- **Alt text quality.** a11y-gate confirms alt text is *present*; whether it's *accurate* and actually
  useful ("photo of a golden retriever" vs. "image1.jpg") is a judgment call no tool can make.
- **Whether a keyboard-reachable control actually works.** [Keyboard operability](#keyboard-operability)
  confirms a custom widget is *reachable* by keyboard — it can't confirm that pressing Enter or Space on it
  does the right thing once focused.
- **Form validation states.** [Interactive-state auditing](#interactive-states) deliberately never submits
  forms, since there's no safe way to trigger validation without risking a real network submission. Whether
  error messages are announced and correctly associated with their field still needs a manual pass.
- **Real screen-reader UX.** The ARIA/semantics checks confirm the structure a screen reader relies on is
  valid — not that the page actually makes sense read aloud in order. Run it with VoiceOver, NVDA, or JAWS
  before calling it done.
- **Color as the only signal (WCAG 1.4.1).** `color-contrast` checks contrast ratios, not whether color is
  the *only* way information is conveyed (e.g. a required field marked only in red).
- **Hover/focus-persistent content (WCAG 1.4.13).** Custom tooltips and similar hover-triggered content that
  must stay visible on hover/focus aren't automatable.
- **Captions and transcripts** for video/audio content.
- **Consistent navigation, helpful error messages, and appropriate reading level** across the site.
- **Time limits and session timeouts** having an accessible accommodation (extend, disable, adjust).

None of this is a gap to "fix" with more code — it's the honest line between what automation can verify and
what needs a person.

### Motion

Entrance animations and JS-driven motion are handled by default, not opt-in — a page is always audited in
its settled state:

1. `prefers-reduced-motion: reduce` is emulated, for sites that already respect it.
2. CSS animations/transitions are force-set to their end state via injected CSS, for sites that don't.
3. A short `motionSettleDelay` (default 300ms) is waited out after load, for motion driven by JS timers or
   `requestAnimationFrame` rather than CSS.

Set `reducedMotion: false` (or pass `--no-reduced-motion`) if you deliberately want to audit a page
mid-animation.

### Focus visibility

axe-core checks that an interactive element has a discernible *name* — it has no rule for whether focus is
*visible* (WCAG 2.4.7). a11y-gate adds this itself: it tabs through every real keyboard stop on the page
(using actual `Tab` key presses, so it only visits what a keyboard user could actually reach) and flags any
link, button, or form field whose computed style is identical whether focused or not. This is on by
default (`checkFocusVisibility: true`); disable it with `--no-focus-check` if it's too noisy for a
particular project (e.g. one using a `:focus-visible` polyfill pattern this heuristic doesn't recognize).

### Keyboard operability

Two more checks axe-core has no rule for, since both are about *reachability* rather than naming/roles,
found during the same Tab traversal used for focus-visibility:

- **Keyboard traps (WCAG 2.1.2):** if Tab stops moving focus at all — the same element stays focused press
  after press — that's a real trap (e.g. a widget that calls `preventDefault()` on every `Tab` keydown), and
  it's reported as `keyboard-trap` at `critical` impact. This is distinct from focus simply wrapping back
  around to the top of the page after the last stop, which is normal and not flagged.
- **Unreachable custom widgets (WCAG 2.1.1):** any element with an `onclick` handler or an interactive ARIA
  role (`button`, `link`, `menuitem`, `tab`, `checkbox`, `radio`, `switch`, `option`) that isn't a native
  focusable tag and has no non-negative `tabindex` — a mouse user can click it, a keyboard user structurally
  cannot. Reported as `keyboard-operable-custom-widget`. This only checks *reachability*; it can't verify
  that a reachable widget actually responds correctly to Enter/Space once focused — that still needs a
  manual pass.

Both are on by default; disable with `--no-keyboard-check` (turns off both together).

### Reflow

Re-audits every page at a 320px-wide viewport — the standard stand-in for a 1280px design viewed at 400%
browser zoom — and flags any page whose content requires horizontal scrolling to read (WCAG 1.4.10,
Reflow), reported as `reflow-320`. Vertical scrolling is always fine; only *horizontal* scroll at this width
is a failure. On by default; disable with `--no-reflow`, or change the width/height/impact via the `reflow`
config option.

### Interactive states

Everything above — axe's rules and all of a11y-gate's own checks — only ever sees a page as it looks the
moment it finishes loading. A lot of real accessibility bugs live somewhere axe never looks: inside a modal,
a dropdown, a mobile nav panel, or an accordion section that doesn't exist in the DOM (or is `hidden`/
`display: none`) until a user opens it.

a11y-gate handles this by finding every disclosure widget on the page — anything using `aria-expanded`,
`aria-haspopup`, `<details>`/`<summary>`, or `data-toggle` — clicking it, waiting briefly for it to settle,
and re-running the *full* axe pass (plus focus-visibility and keyboard-operability) against whatever that
click revealed. Each resulting violation is tagged with which trigger opened it, e.g.
`(desktop · after opening button "More info")`.

A few deliberate limits:

- Real links (an `<a>` with an actual `href`, not `#`) are excluded from the trigger list, since clicking
  one would navigate away rather than open something in place.
- `interactiveStates.maxTriggers` (default 5) caps how many widgets get opened per page, since each one is a
  full extra page load — raise it for a page with many disclosure widgets you want full coverage of, at the
  cost of a slower run.
- **Forms are never auto-submitted.** Safely triggering a form's own validation logic without risking a real
  network submission isn't possible in general — a11y-gate can't know whether a given submit button's
  handler calls `preventDefault()` or genuinely posts to a live endpoint. Testing accessibility of validation
  error states (are they announced, associated with their field, etc.) still needs a manual pass, ideally
  against a component in isolation (Storybook, a test-only route) rather than a live form.

On by default; disable with `--no-interactive-states`, or cap the trigger count with `--max-triggers <n>`.

### Viewports

Every page is audited at both a desktop (1280×900) and a mobile (375×667, touch-emulated) viewport by
default — each violation in the report is tagged `(desktop)` or `(mobile)` so you know which one it showed
up under. This matters because a lot of real issues are viewport-specific: responsive layouts that hide or
overlap content at narrow widths, text that becomes low-contrast against a different background at mobile
sizes, and touch targets that are fine for a mouse cursor but too small or too close together for a
thumb — which is why the mobile pass also turns on axe's `target-size` rule (WCAG 2.5.8), off by default in
axe-core since it's specifically about touch.

Skip either pass with `--no-mobile` / `--no-desktop` (or the equivalent `viewports` config), or replace the
defaults entirely with your own list (e.g. to add a tablet size) — see `a11y.config.example.js`. The old
singular `viewport: { width, height }` option still works exactly as before for a project that only wants
one custom size.

### Crawling

Set `crawl.from` to one or more seed URLs and a11y-gate discovers every same-origin page reachable from
them by following real `<a href>` links, rather than requiring a maintained `urls` list. `crawl.maxPages`
and `crawl.maxDepth` cap how far it goes (defaults: 200 pages, 25 hops); set `crawl.includeExternal: true`
to also follow links off the seed's own origin. A crawled page that fails to load is still reported as an
error, just like any other target.

## Wire it into your build

Once installed, `a11y-gate` is available as a binary via npm scripts.

**A note on prebuild vs. postbuild**, because it matters which one fits your project:

- Checking a **running server** (`urls`/`crawl` + a dev/preview server) → `prebuild`, since it doesn't
  depend on build output existing yet.
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
`minor` findings are still printed in full, but as warnings only. This includes axe's own heading-order and
landmark rules (`heading-order`, `landmark-one-main`, `region`, etc.) — they're already part of the default
run, just reported as `moderate`, so raise `failOn` to `moderate` if a project wants those to block too.

The custom checks default to: `serious` for focus-visibility, keyboard-operability, and reflow
(configurable via `focusVisibility.impact`, `keyboardOperability.impact`, `reflow.impact`); `critical` for a
genuine keyboard trap, since it can leave a keyboard-only user fully stuck.

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
  --crawl http://localhost:3000/ \
  --max-pages 200 \
  --fail-on serious \
  --json-report a11y-report.json \
  --no-reduced-motion \
  --no-focus-check \
  --no-mobile \
  --no-desktop \
  --no-keyboard-check \
  --no-reflow \
  --no-interactive-states \
  --max-triggers 5 \
  --config custom-a11y.config.js \
  --no-color
```

`--reduced-motion` and `--no-reduced-motion` are the on/off switches for motion settling (on by default);
`--no-focus-check` turns off the keyboard focus-visibility check (also on by default); `--no-mobile` /
`--no-desktop` skip one of the two default viewport passes (see [Viewports](#viewports));
`--no-keyboard-check` turns off keyboard-trap and unreachable-widget detection (see
[Keyboard operability](#keyboard-operability)); `--no-reflow` turns off the 320px reflow pass (see
[Reflow](#reflow)); `--no-interactive-states` / `--max-triggers` control the modal/dropdown/accordion
re-audit pass (see [Interactive states](#interactive-states)).

## Troubleshooting

- **"Could not find Chrome"** — `puppeteer` wasn't able to download its bundled Chromium (common on
  locked-down networks/CI images). Either allow the download, or install Chromium separately and set the
  `PUPPETEER_EXECUTABLE_PATH` environment variable to its path before running.
- **Server never becomes ready** — increase `server.readyTimeout`, or confirm `server.url` matches what
  the server actually listens on (host/port/path).
- **False positives on a specific rule** — add the axe-core rule ID to `ignoreRules` in that project's
  config rather than disabling the whole check. Rule IDs are printed in the report; see the
  [axe-core rule list](https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md).
- **Contrast failures that come and go** — this should no longer happen, since motion settling is on by
  default (see [Motion](#motion)). If it still does, raise `motionSettleDelay`, or check whether the
  animation is triggered by something other than page load (e.g. scroll-linked).
- **Focus-visibility false positive** — some `:focus-visible` polyfills or custom keyboard-detection
  patterns can render differently than this heuristic expects. Set `checkFocusVisibility: false` for that
  project, or raise it as an issue with the pattern that tripped it.
- **Crawl missed/over-visited pages** — `crawl` only follows `<a href>` elements reachable in the rendered
  DOM; it won't find pages that are only reachable via a form submission, a client-side redirect with no
  link, or JS-only navigation with no real `<a href>`. Add those specific pages to `urls` alongside `crawl`.
- **Slower since upgrading** — auditing at two viewports instead of one roughly doubles the work per page,
  the reflow pass adds a third full pass, and interactive-state auditing adds one extra page load *per
  disclosure widget found* (up to `interactiveStates.maxTriggers`, default 5) — a page with several
  dropdowns/accordions can end up meaningfully slower to audit than one without. Raise `concurrency`, lower
  `maxTriggers`, or turn off whichever pass a given project doesn't need
  (`--no-mobile`/`--no-desktop`/`--no-reflow`/`--no-interactive-states`).
- **A single flaky/slow page times out** — raise `timeout` (ms) in the config; it applies per-page (and
  per-page during crawling and interactive-state re-audits).
- **A disclosure widget gets opened but nothing looks different in the report** — a11y-gate excludes real
  links (`<a href="...">` other than `#`) from the trigger list on purpose, since clicking one would
  navigate away rather than reveal something in place. If a menu is built from real links styled to look
  like a dropdown, its contents were already visible in the initial DOM and audited normally — there's
  nothing extra to open.

## Development

```bash
git clone https://github.com/TheCBCreative/a11y-gate.git
cd a11y-gate
npm install
npm test        # runs the self-test suite (test/fixtures, test/focus, test/viewport, test/crawl-fixtures,
                # test/keyboard, test/reflow, test/interactive) — takes ~90s, mostly spent on real
                # Chromium page loads
```

`test/run-tests.js` runs the CLI against known-good and known-bad fixture pages (and a couple of
throwaway local servers, for the crawl and server-bootstrap paths) and asserts the exit codes and reported
output are correct — this is what the CI badge above is actually running, on Node 22.x/24.x on Linux and
on Windows (the `server` option's process-teardown code has a separate win32 code path).

## License

[MIT](LICENSE)
