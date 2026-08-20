# TAB 11 — Production observability

**Owner:** ServanaWorkerWeb + servana_api-main
**Status: PARTIAL — mandate 3 done; 1, 5, 6, 7 need a vendor account and a deploy; 2 and 4 are specified here.**
**Measured:** 2026-08-18.

---

## The premise, verified rather than assumed

| Checked | Result |
|---|---|
| Sentry, Datadog, LogRocket, Bugsnag, Rollbar, AppSignal, New Relic in `package.json` | **zero, all seven** |
| Same names in `src/` | two apparent hits, both **grep artefacts** — `ServiceStatusEntry` contains "sEntry", `scrollbar` contains "rollbar" |
| `console.*` in non-spec source | **3** — none carrying a password, OTP, token, address or provider record |
| `X-Request-Id` minting | present, `RequestContextInterceptor` |
| `error.requestId` parsed from the v1 envelope | present, `backend-error-shapes.ts` |

So the command is right: no client error reporting of any kind, and the
foundations for correlating one already exist and are unused for this purpose.

The grep artefacts are worth recording. A name-matched search said "Sentry is
present" and it was not — the standing rule about verifying an absence cuts both
ways.

---

## Mandate 3 — the scrubber · **DONE**

`src/app/core/observability/servana-event-scrubber.ts`, nine tests.

**Written before the monitor, not after it.** The portal's logging hygiene is
currently an asset, and the command is blunt: *"a monitor is the easiest way to
lose it."* An error reporter captures whatever is attached to an error, and
errors are attached to the payload that caused them. Building the boundary
afterwards means building it after the first payload has already left.

**An allowlist, because a blocklist fails silently.** A blocklist answers "is
this key one I thought of" — a field added next quarter ships to a vendor because
nobody remembered to forbid it. An allowlist answers "is this key one I decided
was safe", and its failure mode is a missing field on a dashboard.

Only correlation and classification survive: `requestId`, `traceId`, `code`,
`status`, `authRelated`, `surfaceUnavailable`, `route` (a **template**, never a
resolved url — `/provider/jobs/:id` is a screen, `/provider/jobs/8815` is a
booking), `httpStatus`, `durationMs`, build identifiers.

Nested objects are dropped **whole** rather than walked, because walking one
means deciding for every future shape which of its leaves are safe — the implicit
decision an allowlist exists to prevent.

Secret-shaped values are redacted even inside allowlisted fields: bearer tokens,
JWTs, Google API keys. That covers the case a key check cannot — a token
interpolated into a message.

### Watched to fail, and the shape of the failure matters

Downgrading the allowlist to a blocklist failed **exactly one** test — *"drops an
unrecognised key rather than passing it through"* — because
`TELEMETRY_FORBIDDEN_KEYS` still caught every named category. That is the correct
discrimination: the allowlist's unique value **is** the unknown-field case, and
one test isolates it while the other eight prove the two mechanisms are
independent.

### Stated plainly

**It has no caller yet.** Wiring a monitor needs a vendor account, and adding any
dependency is blocked by **M-21** — the lockfile is npm 6 format and every
install rewrites 30,000+ lines. The scrubber is the half that needs neither, and
the half the guardrail says must exist first.

---

## Mandate 4 — the four signals, specified

Generic error volume would not have caught the outage this programme began with.
These four would. Written here as specifications for whoever wires the monitor,
rather than as unused code — a dormant definition is the thing TAB 18 calls
"untested code presented as a capability".

| # | Signal | Threshold | Why this one |
|---|---|---|---|
| **a** | Any **404, or a 401 carrying no v1 error code**, against an `/api/v1` path | any occurrence, alert immediately | **The exact shape of the 2026-08-18 outage.** The classification already exists: `ApiErrorInterceptor` now emits `surfaceUnavailable: true` for precisely this case (TAB 03), so the signal is a field read, not a heuristic |
| **b** | `session-expired` redirects **per signed-in session** | > 1 per session, or any spike above baseline | Spikes when TAB 03's misclassification fires. Per session, not absolute — absolute volume rises with sign-ins and hides the ratio |
| **c** | Job-action failure rate, **by action** | > 2% per action over 15 min | By action: accept and complete fail for different reasons, and an aggregate hides one behind the other |
| **d** | Failures of the **earnings and payout** reads | > 1% over 15 min | Money surfaces. A provider who cannot see what they earned assumes they were not paid |

Signal (a) is the one that closes the loop on this programme's origin: a live
client calling routes a live server does not serve, visible within minutes of the
first sign-in attempt instead of after six days.

---

## Mandate status

| # | Mandate | State |
|---|---|---|
| 1 | Client error monitor with source-map upload | **BLOCKED** — vendor account (**M-28**) and M-21 |
| 2 | Propagate `X-Request-Id` and `traceId` into every captured event | **READY** — both are carried on `ServanaApiError` and both are allowlisted by the scrubber; nothing to send them to yet |
| 3 | Scrub before send, by allowlist | **DONE**, mutation-proven |
| 4 | Four Servana-specific signals | **SPECIFIED** above; alerting needs the monitor |
| 5 | Real-user monitoring for Core Web Vitals | **BLOCKED** — vendor (M-28) |
| 6 | Page a human on deploy failure, both repositories | **BLOCKED** — webhook and a named recipient (**M-03**, already open since TAB 01) |
| 7 | Synthetic canary every fifteen minutes | **BLOCKED** — needs the dedicated provider account (**M-08**) and a scheduler |

### Guardrails honoured

- Source maps are **not** shipped to browsers; the existing release-gate
  assertion is untouched.
- No request or response bodies are logged wholesale — the scrubber makes that
  structurally impossible rather than conventionally discouraged.
- The canary account requirement is recorded rather than improvised.
