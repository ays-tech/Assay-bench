# Assay — product spec

> **Verify the gateway. Then pick the model.**
> Assay audits an inference gateway with your own key (billing, model identity, token counts,
> API behaviour), then benchmarks cheaper models on your own prompts and recommends a switch
> only when the evidence supports it.

Status: v0.2 · Built for the Orbio agent hackathon · Zero runtime dependencies (Node ≥ 20.12) · 153 tests

---

## 1. Problem

Orbio sells inference credit below list price. That only works if buyers can trust four
things that are currently **claims, not evidence**:

| Orbio says | Buyer's real question |
| --- | --- |
| "1 CREDIT = $1 of usage, metered at each model's rate" | Am I ever billed above the catalog price? |
| "Nothing is swapped or downgraded" | Is the model I asked for the model that answered? |
| "Works exactly as OpenRouter does" | Do streaming, tool calls and errors behave like the OpenAI API? |
| "< 50 ms added latency" | Says who, measured how? |

Every one of these can be **checked from the outside with a normal API key.** Nobody is
doing that continuously. Assay does, and it makes the result legible to a developer in
ten seconds.

The second question every prospective buyer asks is *"what would I actually save?"*
Headline discounts ignore the 5 % platform fee and the depth of the liquidity book.
Assay answers it honestly, for the buyer's real models and volumes.

## 2. Users and jobs

- **Prospective buyer** — "Should I move my OpenRouter traffic here?" → run the
  estimator against my repo, read the scorecard.
- **Existing buyer / agent operator** — "Is my gateway still behaving?" → run
  `assay watch`, get alerted when fineness drops.
- **Orbio team / sellers** — "Where is trust weakest?" → a public, reproducible
  scorecard with methodology, not a marketing claim.

## 3. Principles

1. **Evidence over claims.** Every verdict carries the raw numbers that produced it.
2. **Honest limits.** Each check states what it cannot prove. A check that can't run is
   `skip`, never a silent pass.
3. **No false alarms from our own noise.** A failure must be *confirmed* by a second,
   larger sample before it is called a failure. Unconfirmed anomalies are `warn`.
4. **Cheap by construction.** Hard spend cap (default $0.25), small prompts, cheapest
   viable models, reservation before every paid call.
5. **Key stays server-side.** Never written to reports, logs or the browser.
6. **Zero dependencies.** Built-ins only (`fetch`, `node:test`, `node:http`, BigInt).
   Nothing to audit but our own code.

## 4. The agent loop

```
observe ──► plan ──► probe ──► analyze ──► confirm ──► conclude
 /key        pick     paid     pure         re-run       score, summary,
 /models     models,  calls,   functions    anomalies    optional LLM
 (+ bad key) budget,  each     over the     with a       narrative whose
             sample   reserved evidence     bigger       numbers are
             sizes                          sample       machine-verified
```

- **Observe** — read balance, catalog, rate limits; confirm a bad key is rejected.
- **Plan** — choose models across ≥ 2 vendors (cheapest viable), size samples so the
  cost is *resolvable* against the balance's decimal precision.
- **Probe** — paid calls. Each is reserved against the budget first.
- **Analyze** — pure functions over collected records (unit-tested with fixtures).
- **Confirm** — any escalatable `warn` triggers one larger re-run before a verdict.
- **Conclude** — score, deterministic summary, optional narrative (`--narrate`) that is
  discarded if it contains any number not present in the evidence.

`assay watch` repeats the loop on a schedule and alerts on regression.

## 5. Checks

Weights sum to 100. Statuses: `pass`, `warn`, `fail`, `skip` (could not run), `info`
(measured but no claim to verify). `skip` and `info` do not affect the score.

| id | w | Claim tested | Method | Pass / Warn / Fail | Cannot prove |
| --- | -: | --- | --- | --- | --- |
| `billing` | 30 | Billed ≤ catalog price | Balance before → paid canary calls → poll until charge settles. Compare Δ balance with Σ(tokens × catalog price), in exact BigInt decimals. Tolerance = 2 % + rounding slack of one unit of the balance's precision per call. Also checks funds conservation (Δavailable = −Δused) and the per-call header chain. | Pass: ≤ tolerance. Warn: over once, or no charge seen. Fail: over on **two** independent batches. Skip: cost below the balance's resolution. | Charges for calls made by *other* clients on the same key (use a dedicated key). |
| `tokens` | 15 | Reported token counts are honest | Invariants on every call: completion ≤ max_tokens, total = prompt + completion, prompt tokens within plausible bounds for a known ASCII prompt, stable across repeats, no cross-model outlier. | Pass: all hold. Warn: unstable or outlier. Fail: invariant broken. | Small (< 2×) consistent inflation without a baseline key. |
| `identity` | 20 | Requested model answered | Returned `model` matches the requested id and vendor family; response ids unique; tokenizer fingerprint (Unicode/code stress prompt) is stable per model and distinguishes vendors. With a baseline key: fingerprint equals direct-to-provider. | Pass / Warn: indistinct or unstable fingerprint / Fail: mislabelled, or baseline mismatch. | Which weights actually ran. Detects gross substitution and mislabelling only. |
| `compat` | 15 | OpenAI-compatible behaviour | Streaming SSE (deltas, `[DONE]`, final usage chunk), forced tool call with valid JSON arguments, error envelope for an unknown model. | Pass: all. Warn: partial. Fail: streaming or tools broken. | Vision, audio, files, every provider quirk. |
| `latency` | 10 | < 50 ms added | With baseline key: interleaved A/B on the same model, difference of medians with bootstrap 95 % CI. Without: report `/key` round-trip (no upstream involved) and per-model p50/p95 as `info`. | Pass: CI upper bound < 50 ms. Warn: point estimate < 50 but CI crosses. Fail: CI lower bound > 50. | Overhead without a baseline key. Network path of the tester. |
| `auth` | 5 | Credentials enforced; documented endpoints exist | `/key` shape, `/auth/key` OpenRouter shape agrees, bad key → 401/403. | Fail if a bad key is accepted. | — |
| `catalog` | 5 | Catalog is sane | Parses, unique ids, non-negative finite prices, unit detection. | Warn on anomalies. | Price accuracy vs. provider list (billing check covers what you are charged). |

Not tested, on purpose: prompt storage (unobservable from outside), model quality.

### Score: fineness

Borrowed from hallmarking: purity in parts per thousand.

`fineness = round(1000 × Σ(weight × s) / Σ(weight))` over checks that ran, with
`s = 1 / 0.5 / 0` for pass / warn / fail. A `fail` in `billing`, `tokens`, `identity` or
`auth` caps fineness at 600 — integrity failures are not averaged away.
**Coverage** (share of total weight that ran) is always shown next to the number, and the
top grade is withheld below 80 % coverage: a clean result on little evidence is not "Verified".

| Fineness | Reading |
| --- | --- |
| ≥ 950 and coverage ≥ 80 % | Verified |
| ≥ 950, lower coverage | Partially verified |
| 800–949 | Mostly verified |
| 500–799 | Concerns |
| < 500 | Failed |

### Calibration: accuse conservatively

Failures are reserved for clear violations, because a false accusation costs more than a
missed one. Provider quirks produce `warn`, never `fail`:

- completion tokens a few over `max_tokens`, or `total_tokens` off by a few percent → `warn`
- an unfamiliar model name → `unknown`; `mismatch` requires a recognisably *different vendor's* model
- `claude-haiku-4.5` ≡ `claude-haiku-4-5-20251001` (dots/dashes and date snapshots normalised)
- a billing anomaly must reproduce on a second, larger batch before it is a `fail`

## 6. Savings estimator

Billing is metered at catalog rate (1 CREDIT = $1 of usage); the discount is earned when
**buying** credit. So:

```
cash cost   = usage at catalog price × (1 − discount) × (1 + platformFee)
net saving  = 1 − (1 − discount) × (1 + platformFee)        # 22.5 % headline → 18.6 % net
```

- Platform fee: 5 % of the discounted price (Orbio FAQ).
- Discount: fixed % (default 22.5 %, Orbio's own headline example) **or** blended from
  the liquidity book for the purchase size (tiers shipped as a dated snapshot).
- Volume: user-entered tokens per model, or **scanned from a repository**.
- Repo scan finds: model ids, provider base URLs, env var names; prints the
  two-line migration. It never prints file contents beyond the matched token and never
  reads values from `.env` files.
- Output states its assumptions. It is an estimate, not a quote.

## 6b. Bench: pick the model

**Problem.** After you trust a gateway, the next-biggest lever on cost is the model itself. Teams pick
one and never revisit it, because comparing models on *their* workload is tedious and leaderboards do
not describe it. Shadowbench automates the comparison.

**Why it lives inside Assay.** A benchmark run through a gateway that swaps models or misbills measures
nothing. So every benchmark (a) embeds the latest audit score for that gateway and (b) reconciles its
own billing across the whole run. The pitch and the architecture are the same sentence: verify, then choose.

**Flow.** Capture (JSONL prompts with checks) → shadow-run (current model + candidates, one key,
rate-limited, item-major order so a spend-cap stop leaves fair data) → score → report.

**Scoring.**
- *Deterministic* checks where an answer is checkable: `json`, `schema` (a JSON-Schema subset), `fields`
  (case-insensitive subset match), `equals`, `contains`, `notContains`, `regex`, `maxChars`. JSON is
  extracted from prose and code fences, so formatting habits are not scored as errors.
- *Judged* checks for fuzzy answers: the judge compares candidate vs. the current model's answer **twice
  with positions swapped**, so a judge that favours position A cancels out; how often it flipped is
  reported. The judge is chosen per candidate from a vendor that is neither the current model's nor the
  candidate's (an explicit `--judge` is honoured and flagged if it conflicts). The current model is the
  reference on judged prompts.
- A prompt is **correct** when all its hard checks pass and (if judged) the candidate at least ties.

**Statistics.** Both models answer the *same* prompts, so uncertainty comes from a **paired bootstrap**
(resample prompts, not answers; seeded, deterministic) giving (candidate − current) accuracy and the
ratio, each with a 95% interval; Wilson intervals for single accuracies.

**Decision rule** (`web/recommend.js`, shared by CLI and browser):
- *equivalent* iff the interval's **lower** bound ≥ −margin (default 5 points): never the point estimate;
- *worse* iff the upper bound < −margin; *inconclusive* otherwise, with an estimate of the prompts that
  would settle it; *insufficient* under 20 prompts; *unreliable* if over 30% of calls failed;
- recommend the equivalent model with the lowest **cost per correct answer**, if it saves ≥ 10%.
The dashboard re-runs this rule when the reader changes the margin, so the answer is visibly a function
of the quality loss they accept.

**Cost per correct answer** = cost per 1k calls ÷ accuracy. It is the metric that prevents a cheap model
that is wrong a third of the time from looking like a bargain.

**Interfaces.** `assay bench --current <model> (--sample | --data file.jsonl) [--candidates auto|a,b]
[--judge m] [--margin 5] [--limit N] [--max-spend 1.00] [--dry-run]`; dashboard Bench page (run form,
live progress, margin control, table, interval and cost charts, savings at your volume with a hand-off to
the estimator, failure excerpts); `POST /api/bench/run`, `GET /api/bench/status`.

**Report schema** `assay.bench/1`: `models[]` (cost, accuracy + interval, paired difference + interval and
spread, cost per correct, latency, tokens, verdict, judge stats, failure excerpts), `trust.audit`,
`trust.billing`, `recommendation`, `spend`, `skipped`, `notes`.

**Privacy.** Bench sends *your* prompts to the gateway you chose, with your key. Reports keep short answer
excerpts for failures; `--no-samples` drops them and `export --public` strips them.

## 6c. Lessons from live and adversarial testing

Real bugs, found by running the tool, each now pinned by a regression test:

1. **Overclaiming.** On the live gateway two of three audit models could not answer (one was a
   `:batch` variant id), yet the report said "3 vendors" and scored 1000. Now every model must pass a
   preflight call, failures are reported and replaced, `:variant` ids are excluded, and only vendors that
   actually responded are counted. *A tool that audits honesty must not overclaim.*
2. **Late charges look like overcharging.** A charge lands *after* the call it pays for, so a preflight's
   charge could land inside the next billing window. The audit and Bench now wait for pending charges to
   land before measuring.
3. **Silent under-measurement.** The first fix for (2) returned too early on a slow gateway, and the
   settle logic accepted *any* balance change as "the charge landed": billing passed while measuring
   2.5% of the real charge. Fixed at the root, and a result billed under half of expected can no longer
   pass silently.
4. **Precision.** The live `/key` exposes exact `*_micro_usd` integers beside rounded decimals; Assay
   prefers them (one more decimal of resolution).
5. **Security edge.** `Origin: null` produced a 500 instead of a 403 on state-changing routes; oversize
   bodies dropped the socket before the error could be sent.
6. **Estimator honesty.** The pre-run cost estimate ran 1.7× high and would have refused runs that fit the
   cap; recalibrated, with the hard spend cap as the real limit.

## 7. Interfaces

### CLI

```
assay run       [--models a,b] [--max-spend 0.25] [--narrate] [--narrate-model id] [--fail-under N] [--json]
assay watch     --every 30m [--alert-below 900] [--webhook URL]
assay serve     [--port 4477] [--open]
assay export    [--out scorecard.html] [--public]
assay estimate  [path] [--input-mtok N --output-mtok N] [--discount 22.5] [--fee 5] [--book]
assay probe     # dump redacted raw API shapes (integration debugging)
assay demo      [--fault overcharge|swap|inflate|lag|coarse|clean]
```

Exit codes: 0 ok · 1 below `--fail-under` · 2 usage/config error · 3 runtime failure.

### Dashboard (`assay serve`, also exportable as one self-contained HTML file)

Five routed views (hash routes, one page, no build step), one nav, one card language:

1. **Overview** (`#/`): what this is and *why it exists* (three cards), the hero result card, and the two
   questions in order. It shows real numbers when the reader has run an audit or benchmark, and clearly
   labelled examples when not.
2. **Audit** (`#/audit`): verdict, run facts and the fineness stamp; the ledger (one row per check:
   status glyph *and* word, what it found, the measured value; expand for method and evidence); charts.
3. **Bench** (`#/bench`): trust strip (audit score + this run's billing), verdict, margin control,
   the results table (cost / 1k calls, quality vs. current, cost per correct answer, verdict), evidence
   charts, savings at your volume, failure excerpts, and the run card.
4. **Estimator** (`#/estimator`): "What would your workload cost?" Bench hands its measured token counts here.
5. **Method** (`#/method`): what Assay proves and cannot.

Design system (deliberately close to Orbio's own look, so it feels native to the ecosystem):

- Warm marble paper with a faint lime glow; near-black type; **one** accent, lime, used for the primary
  action, the active tab, the recommended row and the stamp. Green/amber/red are reserved for meaning.
- Type: **DM Sans** for text and headings, **JetBrains Mono** for every number. Complete fallback stacks,
  so the page is fully usable offline.
- Big soft cards; the action lives in a hero card (Buy credits becomes Run a benchmark).
- Status is never colour alone: glyph shape + word. Focus is visible, reduced motion is respected, the
  table scrolls in a focusable region on small screens, and the nav stays reachable on phones.
- All dynamic text is set through DOM text nodes, never `innerHTML`; strict CSP, no inline styles or scripts.
- The static scorecard bundles the same modules into one classic script and works from disk, including the
  live margin control.

## 8. Architecture

```
bin/assay.js               entry
src/cli.js                 commands (node:util parseArgs)
src/config.js              flags + env → validated config
src/client.js              gateway client: timeouts, redaction, header capture, SSE
src/agent.js               the loop: observe → plan → probe → analyze → confirm → conclude
src/probe.js               paid-call collector; budget reservation; record shape
src/checks/*.js            one module per check: run(ctx) + pure evaluate*(…)
src/decimal.js             BigInt fixed-point decimals (exact money)
src/stats.js               median, percentile, seeded bootstrap CI
src/score.js               fineness, coverage, caps
src/summary.js, narrate.js deterministic headline; verified LLM narrative
src/store.js               .assay/ reports, latest, history
src/server.js, export.js   local dashboard API; single-file export
src/estimate/scan.js       repo scanner
src/mock/gateway.js        fault-injecting fake Orbio (demo + tests)
web/                       index.html, app.css, app.js, pricing.js (shared with Node)
test/                      unit tests + end-to-end against the mock
```

### Report schema (`assay.report/1`)

```jsonc
{
  "schema": "assay.report/1",
  "id": "2026-09-21T09-14-03Z",
  "startedAt": "…", "finishedAt": "…", "durationMs": 0,
  "tool": { "name": "assay", "version": "0.1.0" },
  "gateway": { "host": "api.orbio.so", "priceUnit": "per_token", "catalogSize": 446 },
  "models": ["…"],
  "spend": { "calls": 27, "expectedUsd": "0.014200", "actualUsd": "0.015100", "capUsd": "0.250000" },
  "keyFingerprint": "9f2a41c0",
  "score": { "fineness": 972, "grade": "Verified", "coverage": 0.9, "capped": false },
  "headline": "…",
  "checks": [{ "id": "billing", "title": "…", "status": "pass", "weight": 30,
               "summary": "…", "measured": {}, "details": {}, "method": "…", "limits": "…" }],
  "records": [{ "tag": "billing", "model": "…", "promptTokens": 0, "completionTokens": 0,
                "latencyMs": 0, "expectedUsd": "…", "billedUsd": "…" }],
  "narrative": { "model": "…", "text": "…" }
}
```

## 9. Security and privacy

- Key read from `ORBIO_API_KEY` (env or `.env`) only — there is deliberately **no `--key` flag**, so it never lands in shell history; all logged text and stored errors pass through `redact()`.
- Reports contain a key *fingerprint* (sha-256 prefix), never the key. `export --public` drops it.
- Dashboard binds to `127.0.0.1`, rejects foreign `Host`/`Origin` (DNS-rebinding guard),
  strict CSP, no key ever reaches the browser (catalog is proxied).
- Canary prompts are fixed public text. No user data is sent to the gateway.
- Chat calls are never auto-retried (a retry would double-charge and corrupt reconciliation).

## 10. Testing strategy

- **Unit**: decimal math, stats, SSE parser, model-id matching, each `evaluate*` function.
- **Fault injection**: the mock gateway can overcharge, swap models, inflate token counts,
  lag settlement, coarsen balance precision, drop stream usage. Every fault must be caught
  by the intended check, and a clean run must score ≥ 950.
- **End-to-end**: CLI → mock → report → export, asserting on the produced JSON/HTML.
- Live-key validation is manual (`assay probe`, then `assay run`).

## 11. Assumptions to verify against the live API

Orbio's API is documented as OpenRouter-compatible; these details are inferred and are
what `assay probe` exists to confirm:

1. Base URL is `https://api.orbio.so/api/v1` (agent paper uses `https://www.orbio.so/api/v1`; override with `ORBIO_BASE_URL`).
2. `/models` returns OpenRouter-shaped entries with `pricing.prompt` / `pricing.completion` (USD per token, strings). Unit is auto-detected (per-token vs per-million).
3. `/key` returns `balance.available` / `balance.used` as decimal strings.
4. Responses carry `X-Orbio-Balance` (balance the request *started* from).
5. Catalog prices equal what per-request billing uses (i.e. list price; discount is applied at credit purchase).

## 12. Build plan

- [x] 1. Project scaffold, config, redaction, decimal + stats libraries
- [x] 2. Gateway client, SSE parser, catalog normalisation, budget
- [x] 3. Collector + checks (`auth`, `catalog`, `billing`, `tokens`, `identity`, `compat`, `latency`)
- [x] 4. Agent loop, scoring, summary, narrative guard, store
- [x] 5. Mock gateway with fault injection
- [x] 6. Unit + fault-injection + end-to-end tests green
- [x] 7. Estimator: shared pricing model, repo scanner, CLI
- [x] 8. CLI (`run`, `watch`, `serve`, `export`, `estimate`, `probe`, `demo`)
- [x] 9. Dashboard (hallmark, ledger, evidence, estimator, method) + server + export
- [x] 10. README, `.env.example`, package zip, live-key checklist

## 13. Out of scope for v0.2

Multi-tenant hosting, persistent public leaderboard, on-chain interactions (buying or
activating CREDIT), vision/audio checks, verifying prompt non-retention, automatic prompt capture from a
live app (Bench takes a JSONL file; a logging wrapper is the natural next step), judging multi-turn agent
trajectories, and validating LLM-judge agreement against human labels.
