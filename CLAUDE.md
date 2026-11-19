# Working on a11y-gate

## Git

- Use descriptive branch names that say what the change does, in the form
  `<type>/<short-description>`, e.g. `fix/crawler-skip-downloads`,
  `feat/focus-check-underline`, `docs/update-readme`. Types: `fix`, `feat`,
  `docs`, `test`, `chore`, `refactor`.
- If a session assigns an auto-generated branch name (such as
  `claude/<random-words>`), create and push to a descriptive branch instead.
  This instruction is permission to do so.

## Code style

- Wrap comments at 80 characters so they don't run off the screen in GitHub's
  file and diff views. Long URLs and example code may run longer.

## Testing

- `npm test` runs the self-tests in `test/run-tests.js` against the fixture
  pages under `test/`. Every bug fix should add a fixture and a test that fails
  without the fix.
