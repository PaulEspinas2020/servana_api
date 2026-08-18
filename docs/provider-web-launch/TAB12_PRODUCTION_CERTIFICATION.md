# TAB 12 — Live end-to-end certification with a real provider account

**Owner:** ServanaWorkerWeb · **Measured:** 2026-08-18.

---

## Verdict

# NOT_CERTIFIED

Not "certified with gaps" and not "pending". This TAB's entire premise is a real
provider account signing in against production, and that account does not exist.
A certification recorded without it would be the exact failure this programme was
convened to correct — the command's own note that *"the prior certification of
this portal was recorded while two TABs were still partial and one had never run,
and it was pushed to production on that basis."*

**Blocked on M-08** (a dedicated production provider account) and, for the
harness itself, **M-21** (adding Playwright is a dependency change, and every
dependency change currently rewrites 30,000+ lines of lockfile).

---

## What was attempted anyway, and what it found

Two mandates here need neither an account nor a new dependency: verifying the
deployed artefact against its build commit, and asserting network reality rather
than rendered pixels. Both were attempted. Both produced findings.

### 1. The deployed bundle is genuinely unchanged

| | |
|---|---|
| Served `main.e26e7eec019dc8c4.js` | sha256 `80577a5f1978360a404f9c06985a8639e73676ba573b37acbfd10f8714115364` |
| Master Command recorded | `80577a5f1978360a…` |
| Verdict | **matches exactly** |

Production is serving what the sweep measured, and none of the 13 local portal
commits have reached it. That is the expected state — nothing has been pushed —
and it is now evidence rather than assumption.

### 2. A `200` on a bundle URL proves nothing here

```
GET /definitely-missing-xyz.js  ->  200,  <!doctype html>
```

The SPA redirect (`/* -> /index.html`) answers **200 with index.html for any
missing path**. So an artefact check that tests for a 200 passes for a bundle
that does not exist. Three of my own probes returned 200 and were index.html
before I checked the bytes.

Any post-deploy artefact assertion must compare **content**, not status. This is
recorded because the obvious check is the wrong one.

### 3. The build is not reproducible — and that blocks TAB 20 mandate 4

TAB 20 requires: *"compare the served bundle hashes against a local build of the
tagged commit, chunk by chunk. A bundle grep is not a deploy check."*

Attempted, in a clean worktree at `e57259d` — the exact commit production is
serving:

| | |
|---|---|
| Production serves | `main.e26e7eec019dc8c4.js` |
| Local build of the same commit produced | `main.306c9c0f728753f3.js` |

Different filename, therefore different content, from the same source. Every
entry bundle and all five sampled lazy chunks differ.

The cause is not a bad deploy. It is that the build is **not reproducible across
toolchains**: Netlify builds on **Node 20 with `--legacy-peer-deps`**, this
machine built on **Node 24 with npm 11**, and `package-lock.json` is
`lockfileVersion: 1` (npm 6 format) so it does not constrain resolution. Three
environments, three dependency trees, three bundles.

**So TAB 20's artefact verification cannot pass today for any commit**, and the
reason is the same root cause as TAB 09's blocked supply-chain work: **M-21**.
That is a certification blocker nobody had connected to the lockfile before.

---

## The certification specification, ready for the moment M-08 lands

Written now so that the work is mechanical rather than exploratory later. Each
domain asserts **network reality** — the exact path called, the status returned,
and the presence of the fields the screen depends on — because *a screen can
render plausibly from a fallback while the canonical call is failing*.

| # | Domain | The assertion that matters |
|---|---|---|
| 1 | Sign-in and session | `POST /api/v1/auth/login` with `audience: 'provider'`; a customer credential is **refused** |
| 2 | Onboarding and account state | `availableActions` comes from the server, never a local status map |
| 3 | Dashboard | renders from canonical reads, not a cached shell |
| 4 | Jobs list | `GET /api/v1/provider/jobs` in the network panel, not inferred |
| 5 | Job detail | `GET /api/v1/provider/jobs/:id` |
| 6 | All seven job actions | one server-side transition per submission, under a held `Idempotency-Key` |
| 7 | Live tracking and OTP | `POST /api/v1/bookings/:id/otp/verify` |
| 8 | Additional work | `GET`/`POST /api/v1/bookings/:id/additional-work` |
| 9 | Reschedule and cancellation | canonical paths; cancellation eligibility is still legacy |
| 10 | Messaging with attachment | `/api/v1/conversations/...`; attachment upload is still legacy (`/chat/attachments/upload`) |
| 11 | Notifications and preferences | inbox fully v1 including dismissal |
| 12 | **Earnings and payouts** | see the money-surface rules below |
| 13 | Profile and documents | upload, preview, delete on v1; the **uploaded-files list is legitimately legacy** (M-19) |
| 14 | Availability and time off | still legacy; blocked on the grain decision (M-15) |
| 15 | Services and applications | still legacy |
| 16 | Reputation, support and safety | still legacy |

### The money surfaces, certified explicitly

An `INTERNAL_FIXER` is a salaried provider who legitimately earns no share.
Certification must confirm:

- the **withheld reason** and the economic model render;
- **no peso amount is ever fabricated**;
- a **confirmed zero is suppressed**, not printed as a settled figure;
- **failed-payout money is named in the banner**, not silently folded into the
  headline.

### The verdict format TAB 20 consumes

`CERTIFIED` · `CERTIFIED_WITH_NONBLOCKING_GAPS` · `NOT_CERTIFIED`, with the design
lines stated explicitly as pass or fail: `CURRENT_STYLE_PRESERVED`,
`BRAND_CONSISTENCY`, `BOOKINGS_EMPHASIS`, `EARNINGS_EMPHASIS`,
`NEW_ASSETS_MATCH_BRAND`.

---

## Why no harness was built

Mandate 2 asks for an executable suite — Playwright or equivalent. There is no
e2e framework in this repository (`0` e2e dependencies, no `e2e/` directory), so
adding one is a dependency change, and **M-21** makes every dependency change an
unreviewable 30,000-line lockfile rewrite.

Building a harness that cannot sign in, cannot run against a reproducible build,
and would arrive with an unreviewable lockfile diff would produce a green suite
that certifies nothing — which is precisely what this TAB exists to stop. The
specification above is the part that survives the wait.

---

## Guardrails honoured

- Nothing was certified against a staging backend and called production.
- No real customer's booking was used as a fixture — no fixtures were created at
  all.
- **A green suite is not a certification**, and an absent suite is not one either.
  The verdict is NOT_CERTIFIED and says why.
