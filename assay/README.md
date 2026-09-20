# Assay

**Verify the gateway. Then pick the model.**

Assay is two tools in one dashboard, for people buying inference through the [Orbio](https://orbio.so) gateway.

1. **Audit**: with your own key, it checks that billing, model identity, token counts and API
   behaviour match what the gateway promises, and scores the result as a hallmark-style **fineness**
   out of 1000.
2. **Bench**: it replays *your own prompts* against cheaper models through the same key, grades every
   answer, and tells you whether a switch is safe, in cost per **correct** answer. A benchmark on a
   gateway you have not verified is meaningless, which is why the two live together.

- **Zero dependencies.** Node ≥ 20.12, built-ins only. Nothing to audit but this code.
- **Cheap by construction.** Hard spend caps (audit $0.25, bench $1.00 by default).
- **Honest.** Every verdict carries its raw numbers, every check states what it *cannot* prove, a
  failure must reproduce on a larger sample before it counts, and Bench will not recommend a switch
  on a point estimate.

```
$ assay demo --fault overcharge          # no key, no network, no cost

   ┌──────────────────────┐
   │         600          │   Concerns  (capped: an integrity check failed)
   │  parts per thousand  │   Orbio billed above the catalog price.
   └──────────────────────┘   coverage 90% of check weight

  ✔ verified  auth      Balance $5.000000 readable; invalid key rejected (401).
  ✔ verified  catalog   7 models, prices in USD per token. Auditing 3 models across 3 vendors.
  ✖ FAILED    billing   Billed above catalog price in 2 independent batches (1.500× catalog, 1.500× catalog).
  ✔ verified  identity  30 responses named the requested model across 3 vendors; fingerprints stable and distinct.
  ✔ verified  tokens    All 30 calls passed every usage invariant.
  ✔ verified  compat    Streaming, forced tool call and error envelope all behave like the OpenAI API.
  ·  measured  latency  Gateway round-trip p50 1 ms on /key with no model involved. Set ASSAY_BASELINE_KEY …
```

## Quick start

```bash
git clone <this repo> && cd assay
node bin/assay.js demo --fault overcharge --serve   # see a failing audit and the dashboard, offline
node bin/assay.js demo --bench --serve              # the whole story: verify the gateway, then benchmark on it
```

Against the real gateway:

```bash
cp .env.example .env            # put your Orbio key in ORBIO_API_KEY
node bin/assay.js probe         # 1. confirm Assay reads your gateway's API shapes
node bin/assay.js run           # 2. audit it
node bin/assay.js serve         # 3. dashboard at http://localhost:4477
node bin/assay.js export        # 4. one self-contained scorecard.html to share
```

Then benchmark (see [Bench](#bench-pick-the-model)):

```bash
node bin/assay.js bench --sample --current <a model you use today> --dry-run   # plan + cost, spends only cents
node bin/assay.js bench --sample --current <a model you use today>
```

Optionally `npm link` to get an `assay` command.

## What it checks

| Check | w | Claim | How |
| --- | -: | --- | --- |
| `billing` | 30 | Billed ≤ catalog price | Balance before → canary calls → wait for the charge to settle → compare the drop with Σ(tokens × price), in exact BigInt decimals, with rounding slack of one balance unit per call. Funds conservation and the `X-Orbio-Balance` header chain are cross-checked. |
| `identity` | 20 | The requested model answered | Returned model name vs requested (vendor-aware), unique response ids, and a Unicode/code **tokenizer fingerprint**: stable per model, distinct across vendors, and equal to the direct provider when a baseline key is set. |
| `tokens` | 15 | Usage counts are honest | Invariants on every response: completion ≤ `max_tokens`, total = prompt + completion, prompt tokens plausible for a known ASCII prompt, stable across repeats, no cross-vendor outlier. |
| `compat` | 15 | Behaves like the OpenAI API | SSE streaming (deltas, `[DONE]`, usage chunk), forced tool call with valid JSON args, error envelope for an unknown model. |
| `latency` | 10 | < 50 ms added | With `ASSAY_BASELINE_KEY`: interleaved A/B vs direct OpenRouter, bootstrap 95 % CI on the difference of medians. Without: reports the gateway round-trip only and says it cannot isolate overhead. |
| `auth` | 5 | Credentials enforced | `/key` and OpenRouter-shaped `/auth/key` agree; an invalid key must get 401/403. |
| `catalog` | 5 | Catalog is sane | Unique ids, finite non-negative prices, price-unit auto-detection, audit-model selection. |

**Fineness** = `1000 × Σ(weight × points) / Σ(weight)` over checks that ran (pass 1, warn ½, fail 0).
A failure in `billing`, `tokens`, `identity` or `auth` caps the score at 600. **Coverage** is always
shown, and the top grade is withheld below 80 % coverage.

### The agent loop

`observe → plan → probe → analyze → confirm → conclude`. It reads balance and catalog, picks the
cheapest viable model from several vendors, sizes samples so the cost is *resolvable* at the
balance's precision, spends through a budget guard, and re-runs anything suspicious with a larger
sample before calling it a failure. `assay watch --every 30m --alert-below 900 --webhook <url>`
repeats it and alerts on regression. `--narrate` has a cheap model, through the gateway under
audit, write a plain-English summary; it is **discarded if it contains any number not present
in the evidence**.

## Bench: pick the model

Most teams choose one model and never revisit it. Bench automates the comparison:

1. **Capture.** A JSONL file of your real prompts, each with a check that defines a correct answer.
2. **Shadow-run.** The same prompts go to your current model and several cheaper ones through one key.
   Your live app is never touched. Calls are rate-limited and concurrency-bounded.
3. **Score.** Deterministic checks (valid JSON, schema, exact fields, contains, regex, length) where an
   answer is checkable. For fuzzy answers a **judge model** compares each candidate with your current
   model twice, **with the order swapped**, and is never from the same vendor as either.
4. **Report.** Cost per 1k calls, quality against your current model with a 95% range, and **cost per
   correct answer**, the metric that stops a cheap-but-wrong model from looking like a bargain.

```
  gemini-3.8-flash looks promising, but 36 prompts cannot prove it.
  It is 95% cheaper and not visibly worse, yet the uncertainty still allows a real quality loss.

  model                 cost / 1k calls   quality vs current   cost / 1k correct     verdict
  ● gpt-6-astra                   $2.47                 100%               $2.70     current
  ► gemini-3.8-flash            $0.1171                97% ±5             $0.1317   inconclusive
```

**The decision rule is deliberately conservative.** A cheaper model is "equivalent" only when the
*lower* end of a 95% paired-bootstrap interval on (candidate − current) accuracy stays inside your
margin (default 5 points). Otherwise Bench says how many more prompts would settle it. The dashboard
lets you change the margin and re-decides live from the stored statistics: the answer is visibly a
function of how much quality loss *you* accept.

Dataset format (`examples/support-tickets.jsonl` is a 36-prompt sample):

```jsonl
{"id":"t1","system":"Reply with JSON only.","prompt":"Ticket: I was charged twice.","expect":{"fields":{"category":"billing"}}}
{"id":"r1","prompt":"Write a two-sentence reply to this angry customer…","expect":{"maxChars":600},"judge":{"rubric":"Polite, specific, promises a concrete next step"}}
```

Checks: `json`, `schema`, `fields`, `equals`, `contains`, `notContains`, `regex`, `maxChars`. A malformed
file reports every problem with line numbers before a cent is spent. On judged prompts your current
model is the reference: a candidate must be at least as good as it.

Also worth knowing:

- **Every benchmark is also a billing audit.** It reconciles the whole run against your balance
  (hundreds of calls) and reports the ratio to catalog price, and embeds the latest Assay audit score.
- Models that cannot answer a preflight call are skipped and listed, never silently benchmarked.
- Only prompts every model completed are compared, so a spend-cap stop leaves a fair, smaller result.
- `--no-samples` keeps answer excerpts out of the saved report; `assay export --public` strips them.
- A benchmark is only as representative as your prompts. Include your hard cases.

## The savings estimator

Billing is metered at catalog rate; the discount is earned when you **buy** credit, and Orbio adds a
5 % fee on the discounted price. So the headline is not what you keep:

```
cash cost = usage × (1 − discount) × (1 + fee)      # 22.5 % headline → 18.6 % kept
```

```bash
assay estimate ./my-repo --input-mtok 40 --output-mtok 8 --discount 22.5
assay estimate ./my-repo --input-mtok 40 --output-mtok 8 --book     # blend from the liquidity book
```

It scans the repo for provider base URLs, model ids and env var names (**names only, never values;
no source lines are stored**), matches them to the live catalog, shows the two-line migration
(without touching files), and prices your volume. The dashboard has the same model as an interactive
calculator, including the point where a small discount stops covering the fee (4.8 %) and how a
bigger purchase earns a smaller blended discount. The liquidity-book tiers are a **dated snapshot**;
the estimate is an estimate, not a quote.

## Live-key checklist

1. Use a **dedicated key**: the billing check reads the balance, so other clients spending on the
   same key during the audit look like overcharging.
2. `assay probe` first. It prints redacted raw shapes for `/key`, `/models`, a chat call, a stream,
   and the balance afterwards. If a check misreads your gateway, this is what to look at.
3. `assay run`. If billing says *skip: balance precision too coarse*, the balance has too few
   decimals to resolve a sub-cent call; that is reported honestly rather than passed.
4. Set `ASSAY_BASELINE_KEY` (a direct OpenRouter key) to turn the latency line from *measured* into a
   real verdict, and to compare tokenizer fingerprints against the provider directly.
5. `assay export --public` for a shareable file with the key fingerprint stripped.
6. `assay bench --sample --current <model> --dry-run` before a real bench run: it prints the plan, the
   judge models and an estimated cost. Bench has been tested against the mock gateway; run it on the
   live one with a small `--limit` first and check the billing line says *reconciled*.

Assumptions Assay makes about the live API (all documented in `PRODUCT.md`, section 11): base URL
`https://api.orbio.so/api/v1` (override with `ORBIO_BASE_URL`; the agent paper also shows
`https://www.orbio.so/api/v1`), OpenRouter-shaped `/models`, decimal-string balances on `/key`, and an
`X-Orbio-Balance` response header.

## Commands

```
assay run       [--models a,b] [--max-spend 0.25] [--narrate] [--fail-under N] [--json]
assay watch     [--every 30m] [--alert-below 900] [--webhook URL]
assay serve     [--port 4477]
assay export    [--out scorecard.html] [--public]
assay bench     --current <model> [--sample | --data file.jsonl] [--candidates auto|a,b] [--judge model]
                [--margin 5] [--limit N] [--max-spend 1.00] [--dry-run] [--no-samples] [--json]
assay estimate  [path] [--input-mtok N] [--output-mtok N] [--discount 22.5] [--fee 5] [--book] [--json]
assay probe
assay demo      [--bench] [--fault overcharge|swap|inflate|lag|coarse|nostreamusage|notools|noauthcheck|clean] [--serve]
```

Exit codes: `0` ok · `1` below `--fail-under` (use it as a CI gate) · `2` usage/config · `3` runtime.
The API key is **never** accepted as a flag, so it stays out of shell history.

## Security

- Key comes from the environment only, passes through `redact()` before any log or stored error, and
  reports contain a sha-256 *fingerprint*, never the key.
- The dashboard binds to `127.0.0.1`, rejects foreign `Host` and `Origin` headers (DNS-rebinding and
  cross-site spend), sends a strict CSP (no inline script, no third-party script), and proxies the
  catalog so the key never reaches the browser. All dynamic text is set through DOM text nodes.
- Chat calls are never auto-retried: a retry would double-charge and corrupt the reconciliation.
- Audit canary prompts are fixed public text. Bench sends *your* prompts, to the gateway you chose, with
  your key; nothing else leaves your machine.
- `POST /api/bench/run` sits behind the same loopback-Host and same-origin guards as the audit, requires
  `application/json`, caps the body at 4 KB, validates every field, and can only name datasets the
  server itself lists (no client-supplied file paths).

## Testing

```bash
npm test        # 153 tests, ~50 s, no network, no key
```

Besides unit tests for exact decimals, statistics, SSE parsing and each check's pure evaluator, a
**fault-injecting mock gateway** (`src/mock/gateway.js`) proves each check catches what it claims to:
overcharging, model substitution, self-consistent token inflation, lagging settlement, coarse balance
precision, an open-auth gateway, missing stream usage, ignored `tool_choice`, and a heavy gateway hop.
A clean gateway must score 1000. The mock is also what `assay demo` runs. Bench is tested the same way:
the mock can simulate models of different skill, broken models, a talkative model that trips the spend
cap, and a slow-settling gateway, and the statistics, decision rule, judge order-swapping and
server security are covered directly.

## Layout

```
bin/assay.js            entry            src/agent.js       the loop
src/cli.js              commands         src/checks/*.js    one module per check (run + pure evaluate*)
src/client.js           gateway client   src/decimal.js     BigInt fixed-point money
src/server.js           dashboard API    src/export.js      single-file scorecard
src/estimate/           repo scanner     web/pricing.js     savings model shared by CLI and browser
src/bench/              Bench engine     web/recommend.js   decision rule shared by CLI and browser
src/mock/gateway.js     fault injection  web/                dashboard: overview, audit, bench, estimator
examples/               sample prompts   src/mock/bench-responder.js  simulated model skill
```

## Limits

Assay cannot see whether prompts are stored, cannot prove which weights ran (it detects mislabelling
and gross substitution), and cannot isolate gateway latency without a baseline key. Bench can only tell you how models
behave on the prompts you gave it, and an LLM judge has its own biases (Bench reports how often the
judge changed its pick when the order flipped). The dashboard's Method page says the same, on purpose.

MIT licensed.
