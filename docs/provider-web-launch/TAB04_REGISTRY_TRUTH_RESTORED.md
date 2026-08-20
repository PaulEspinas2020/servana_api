# TAB 04 — Restore the contract registry as a source of truth

**Owner:** servana_api-main · **Measured:** 2026-08-18, against both repositories.

---

## Verdict

**CERTIFIED_WITH_NONBLOCKING_GAPS.** The Provider Web rows are correct and now
derived rather than asserted. The other four clients publish no manifest yet and
are deliberately untouched.

---

## What was wrong

Across all 109 entries of `src/api/v1/contract.ts`, `providerWeb: 'migrated'`
appeared **zero times** — 52 `legacy`, 18 `planned`, 39 `n/a` — while 36 entries
name a canonical `/api/v1` path the portal calls unconditionally.

The consequence is structural. Alias retirement requires every client the matrix
lists to read `migrated`, so with none recorded, **none of the 89
`ALIAS_TEMPORARILY` routes could ever be retired**. And because
`PER_CLIENT_MIGRATION_PLAN.md` is generated from the field, it instructed the
Provider Web team to redo capabilities they had already shipped.

## Why the fix is not a mass edit

A hand-maintained flag in this repository, describing code in five others,
cannot help but rot. Correcting 36 rows by hand would buy one correct afternoon.

So the client that changes the call changes the record:

1. The portal generates `servana-worker-web.canonical-calls.json` from its own
   source — **36 canonical endpoints across 42 call sites**, each with the
   `file:line` of every site.
2. It is vendored here under `src/api/v1/client-manifests/`.
3. `scripts/reconcile-client-manifests.ts` derives `callers.providerWeb` from it.
4. `clients:reconcile:check` runs inside `npm run verify`, so drift is a red
   build rather than a discovery six months later.

Nothing is hand-listed. Remove a call in the portal and the next run turns the
row back to `legacy`.

### A source scan is sound here, and that is a property, not luck

The portal has exactly one egress path — no `fetch()`, no `HttpClient` outside
`ServanaApiClientService`, and no UI file able to construct a URL. Without those
properties this would be a grep pretending to be an inventory.

---

## The count is 36, not 29

The command estimated 29. That is not a disagreement about facts: 29 was a hand
list and 36 is derived. The extra seven are

- **five job-state transitions** that share one `transition(jobId, action)` call
  site (`provider-jobs-api.service.ts:239, 273, 294, 305, 381`). The literal in
  source is `/v1/provider/jobs/${jobId}/${action}`, which normalises to
  `:param/:param` and matches no contract entry. Left unexpanded, five migrated
  capabilities read as zero — the same class of error this TAB corrects — so the
  expansion is declared in the generator with the call sites that justify it.
- **two booking reads** recorded as `planned` while the portal already calls
  them (`bookings.otp.status`, `bookings.reschedule.history`).

---

## Result

| `callers.providerWeb` | Before | After |
|---|---|---|
| `migrated` | **0** | **36** |
| `legacy` | 52 | 22 |
| `planned` | 18 | 12 |
| `n/a` | 39 | 39 |

Regenerated (never hand-edited — the guardrail names that as the failure mode
this TAB exists to remove):

| Provider Web, in `PER_CLIENT_MIGRATION_PLAN.md` | Before | After |
|---|---|---|
| Already on canonical | **0** | **22** |
| Still on a legacy route | 25 | 3 |
| Partially migrated | 1 | 6 |
| No equivalent called today | 13 | 8 |

---

## The test reads a manifest, not a list

`tests/client-manifest-parity.test.ts`. The acceptance criterion is explicit that
the check must read the client's own manifest "rather than a hand-written list" —
a list here would be the same defect in a new file.

It also asserts two things a parity check usually leaves implicit:

- **the vacuous-pass case out loud** — if no manifest is present the suite proves
  nothing, so its absence fails rather than passes;
- **that clients without a manifest are left untouched** — Customer Web, Provider
  Mobile, Customer Mobile and Admin Web publish none, and deriving their state
  from anything available here would be a guess dressed as a derivation, which is
  how the `providerWeb` rows came to be wrong in the first place.

---

## Mandate status

| # | Mandate | State |
|---|---|---|
| 1 | Correct `callers.providerWeb`, each backed by a file:line citation | **DONE** — 36 entries, citations in the manifest |
| 2 | Re-derive for the other four clients | **NOT DONE** — those repositories are not on this machine. Recorded as manual task, not fabricated. |
| 3 | Replace the hand-maintained flag with a client-declared manifest | **DONE** — generator, manifest, reconciler, gate |
| 4 | Telemetry cross-check until the manifest pipeline exists | **NOT NEEDED for providerWeb** — the pipeline exists now. Still wanted for the four clients without one; folded into mandate 2. |
| 5 | Regenerate the three derived documents | **DONE** — all ten generator sets regenerated |
| 6 | Start the retirement clock | **DELIBERATELY NOT DONE** — the guardrail forbids retiring any alias in this TAB. |

### Guardrails honoured

- **No alias retired.** Correcting the record is separate from acting on it; the
  14-day web and 90-day mobile silence windows start after the record is right.
- **No generated markdown hand-edited.** Every document above came from its
  generator.
- **Each claim verified against the client repository** — the manifest carries
  the `file:line` for all 42 call sites.

---

## An honest note about how this landed

`88dfacf` carries an accurate message and inaccurate content. Another session was
rewriting `contract.ts` in this same working tree while that commit was staged,
so it captured the file with zero migrated rows — the very state its message says
it fixes. `0d1d80e` lands the real change and says so.

It is recorded rather than amended away. Two sessions in one working tree will do
this, and a commit whose message and diff disagree is exactly the confidently
wrong artefact this TAB exists to remove; hiding it would be the same error one
level up.

---

## Eight tests asserted the defect, and had to be retired

The correction turned nine suites red. None was a regression: each asserted, as a
constant, that **no client is ever migrated**.

| Test | What it asserted |
|---|---|
| `finance-docs-generated`, `messaging-docs-generated`, `account-docs-generated`, `notification-docs-generated`, `home-docs-generated` | `expect(row).not.toContain('migrated')` on every caller-matrix row |
| `booking-experiences-contract` | `expect(Object.values(entry.callers)).not.toContain('migrated')` |
| `convergence-docs-generated` | `expect(summary.migratedCallerCells).toBe(0)` plus the literal sentence "No client has migrated" |
| `cross-platform-convergence` | `expect(convergenceSummary().migratedCallerCells).toBe(0)` |
| `finance-contract` | `expect(state).not.toBe('migrated')` across every finance caller |

Their docblocks all give the same reason, and it was a good one: *"Client
repositories are out of scope until the backend command completes"* — so nothing
could be verified from here, and the strongest available guard was to forbid the
claim entirely.

**TAB 04 ended that premise, not that intent.** The rule was never "no client is
migrated"; it was "do not claim a migration nobody verified". Every one now
asserts the same thing against evidence: a `migrated` cell is legitimate exactly
when that client publishes a manifest. A client without one still cannot be
marked migrated, whatever it may already have shipped.

Left as-is, these would have pinned a known-wrong registry in place — the same
failure this TAB exists to remove, one level up.

### The generator contradicted itself in print

`scripts/generate-convergence-docs.ts:146` interpolated the measured count and
then hardcoded the sentence beneath it, so the regenerated document read:

> **22 cells on canonical.** No client has migrated.

The prose is now conditional on the number, in both directions, and
`convergence-docs-generated` asserts they agree rather than asserting either one.

### One assertion I got wrong first

My replacement for `cross-platform-convergence` compared
`migratedCallerCells` to the count of migrated contract entries: 22 against 36.
They are different units — the summary counts capability × client **cells**, and a
capability whose endpoints are only partly migrated rolls up to `mixed`. The gap
*is* the six partially-migrated capabilities.

Re-deriving that rollup in the test would create a second definition of "migrated
capability" and the two would disagree eventually, so it asserts the invariant
instead: cells may never exceed entries, and may not be non-zero when entries are
zero.

---

## Outstanding

- **Manifests for Customer Web, Provider Mobile, Customer Mobile, Admin Web.**
  Each needs the same generator in its own repository. Until then their rows stay
  as they are and the aliases they block stay unretirable — which is now visible
  rather than hidden behind a uniformly-wrong `providerWeb` column.
