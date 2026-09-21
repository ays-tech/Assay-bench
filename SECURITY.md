# Security Policy

Assay handles a real API key and spends real money on your behalf, so we treat
security reports seriously.

## Supported versions

Assay is pre-1.0. Only the latest release on `main` receives security fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub:
[Report a vulnerability](https://github.com/ays-tech/Assay-bench/security/advisories/new).

Include, as far as you can:

- what the issue is and the impact (for example: key disclosure, spend beyond a
  cap, a request that a web page could make to the local dashboard)
- the version or commit, your Node version and OS
- the smallest set of steps that reproduces it (`assay demo` and the mock gateway
  need no key and are the preferred way to reproduce)
- a suggested fix, if you have one

**Never include a real API key** in a report. Rotate any key you think may have
been exposed.

## What to expect

This is a volunteer-maintained project, so these are targets, not guarantees:

- acknowledgement within 7 days
- an initial assessment and severity within 14 days
- a fix or mitigation for confirmed issues as quickly as their severity warrants,
  with a coordinated disclosure date agreed with you
- credit in the release notes and advisory, unless you prefer to stay anonymous

## In scope

Anything in this repository that could harm a person running Assay. In
particular:

- **Credential handling**: the API key appearing in logs, reports, exports,
  stored errors, the dashboard, or shell history (it must only come from the
  environment and pass through `redact()`)
- **Dashboard server**: bypasses of the loopback bind, `Host` / `Origin` checks
  (DNS rebinding, cross-site requests), the CSP, or the body-size and content-type
  limits
- **Bench endpoints**: reading files outside the listed datasets, path traversal,
  or injecting fields the server should validate
- **Spend controls**: ways to exceed the hard spend caps, or to trigger an
  automatic retry of a billed chat call
- **Output injection**: dynamic text in the dashboard or exported `scorecard.html`
  rendered as markup or script
- **Supply chain**: anything that would add a dependency or fetch code at
  runtime. Assay is intentionally dependency-free.

## Out of scope

- Vulnerabilities in the Orbio gateway or in any model provider. Report those to
  the vendor. (Assay *detecting* gateway misbehaviour is the product working,
  not a vulnerability in Assay.)
- Attacks that require an attacker to already control your machine, your shell
  environment, or your `.env` file
- Running the dashboard on a non-loopback address or behind a proxy you
  configured to strip the protections described in the README
- Findings from automated scanners with no demonstrated impact
- Denial of service against the local dashboard by the local user

## Safe harbour

If you make a good-faith effort to follow this policy (test only against your
own machine and your own keys, avoid privacy violations and service
disruption, and give us reasonable time to respond before disclosing), we will
not pursue or support any legal action against you for your research.

## Hardening tips for users

- Keep your key in `.env` or the environment. It is gitignored, so do not force-add it.
- Use a dedicated, low-balance key for audits and benchmarks.
- Leave the dashboard on `127.0.0.1`.
- Review any `scorecard.html` before sharing it. It contains your results and
  model names, though never the key.
