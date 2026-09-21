# Contributing to Assay

Thanks for helping. Assay is small on purpose, and its whole value is that people can
trust it, so the bar for changes is *evidence and clarity*, not volume.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security
problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Ground rules

These come from the project's design and are non-negotiable:

1. **Zero runtime dependencies.** Node built-ins only (Node ≥ 20.12). A pull request that
   adds a dependency, a bundler, or a build step will be declined. If you think something
   truly needs one, open an issue first.
2. **Honest verdicts.** Every check states what it cannot prove. A failure must reproduce on
   a larger sample before it counts. Do not add a check that reports a guess as a fact.
3. **Money is exact.** Use the BigInt fixed-point helpers in `src/decimal.js`, never
   floating point, for anything that is a price, balance, or cost.
4. **The key never leaks.** It comes from the environment only, is never a CLI flag, and
   goes through `redact()` before any log, report, or stored error.
5. **Chat calls are never auto-retried.** A retry would double-charge and corrupt the
   billing reconciliation.
6. **No network in tests.** Tests run against the mock gateway (`src/mock/gateway.js`).

Paths below are relative to the `assay/` package directory.

## Getting set up

```bash
git clone https://github.com/ays-tech/Assay-bench.git
cd Assay-bench/assay     # the package lives in assay/
node --version          # >= 20.12
npm test                # no install step, no key, no network
node bin/assay.js demo --fault overcharge --serve    # try it offline
```

There is nothing to `npm install`. You only need a real key (`cp .env.example .env`) to
test against the live gateway, which no contribution requires.

## Making a change

1. **Open an issue first** for anything bigger than a small fix, so we can agree on the
   approach before you spend time on it.
2. Branch from `main`: `git checkout -b fix/short-description`.
3. Keep the change focused: one concern per pull request.
4. Add or update tests (see below).
5. Run `npm run check`. It must pass.
6. Update the READMEs and `CHANGELOG.md` if behaviour, flags, or output change.
7. Open a pull request and fill in the template.

### Adding or changing a check

Each check lives in `src/checks/` as one module with a `run` function (talks to the
gateway) and one or more pure `evaluate*` functions (decides the verdict from data).
Keep the decision logic pure so it can be tested without I/O. Then:

- add a fault to `src/mock/gateway.js` that the check should catch, and a test proving it
  is caught;
- confirm a clean gateway still scores 1000;
- state in the check's output what it cannot prove.

### Changing Bench

The decision rule is shared by the CLI and the browser (`web/recommend.js`), and the
savings model too (`web/pricing.js`). Change them once and both stay in agreement. Bench
must not recommend a switch on a point estimate.

## Tests

```bash
npm test                          # everything, roughly a minute
node --test test/stats.test.js    # one file
```

Tests use `node:test`. Put new tests in `test/<area>.test.js`; the runner picks up every
`*.test.js`. Shared helpers are in `test/helpers.js`.

## Code style

- Modern ESM (`import`/`export`), no TypeScript, no transpilation.
- Match the surrounding code: naming, comment density, and idiom.
- Comments explain *why*, not *what*.
- Dashboard text is set through DOM text nodes, never `innerHTML`, and the CSP forbids
  inline script. Keep it that way.
- Prefer small, pure functions.

## Commit messages and pull requests

- Write the subject in the imperative, under about 72 characters
  ("Reject oversized bench bodies", not "fixed stuff").
- Explain the *why* in the body when it is not obvious.
- Link the issue (`Fixes #123`).
- Pull requests are squash-merged, so the PR title becomes the commit subject.

## Reporting bugs and requesting features

Use the issue templates. For a bug, the most useful thing you can attach is a reproduction
with `assay demo` or the mock gateway (no key needed). **Redact every key and token** before
pasting logs or reports.

## Licence

By contributing you agree that your contribution is licensed under the project's
[MIT License](LICENSE).
