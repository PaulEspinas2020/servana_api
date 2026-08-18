# LEGACY_AUTO candidate delta — operator runbook

**The harness has never been run. It requires production read access, which I
do not have and did not request.**

---

## 1. What it answers

`AUTO_ASSIGN` validates its target with `LEGACY_AUTO` — the schedule conflict
and nothing else. `ADMIN_ASSIGN` uses `FULL`:

| Check | `LEGACY_AUTO` | `FULL` |
|---|---|---|
| Schedule conflict (±2h) | ✅ | ✅ |
| Canonical provider role (2 or 4) | ❌ | ✅ |
| Not archived | ❌ | ✅ |
| Service capability | ❌ | ✅ |

Closing that gap upward changes **which bookings get auto-assigned at all**. The
question this answers before the change lands:

> Of the auto-assignments that have succeeded, how many would the stricter rule
> have refused — and for which reason?

---

## 2. The command

```bash
PG_MEASURE_HOST=<host> \
PG_MEASURE_PORT=5432 \
PG_MEASURE_DATABASE=<database> \
PG_MEASURE_USER=<read-only user> \
PG_MEASURE_PASSWORD=<password> \
PG_MEASURE_SCHEMA=servana \
ALLOW_PRODUCTION_MEASUREMENT=true \
npx ts-node scripts/measure-legacy-auto-delta.ts
```

Use a **read-only database role** if one exists. The script does not depend on
it — it enforces read-only three separate ways — but defence in depth is free
here.

Without `ALLOW_PRODUCTION_MEASUREMENT=true`, or with any variable missing, it
prints a refusal and exits 1 without connecting.

---

## 3. Expected output

A single JSON document on stdout:

```json
{
  "measuredAt": "2026-08-12T09:00:00.000Z",
  "totals": { "autoAssignments": 42, "wouldBeRefused": 5, "refusedPercent": 11.9 },
  "byFailure": { "ROLE_NOT_PROVIDER": 0, "ARCHIVED": 1, "NO_CAPABILITY": 4 },
  "providers": [
    { "provider": "p_9f2a1c4b7e01", "refused": 3, "reasons": ["NO_CAPABILITY"] },
    { "provider": "p_1b8d3e5a2f90", "refused": 2, "reasons": ["ARCHIVED", "NO_CAPABILITY"] }
  ]
}
```

Those numbers are **illustrative**. The shape is pinned by
`tests/legacy-auto-delta-harness.test.ts`, which fails if the real report drifts
from the documented example.

`byFailure` counts reasons, not assignments, so it can exceed `wouldBeRefused` —
one assignment can fail several checks, and knowing a provider is *both*
archived *and* unqualified is more useful than knowing only the first reason.

---

## 4. Safety properties, all test-proven without a database

| Property | How |
|---|---|
| Cannot write | session `default_transaction_read_only=on`, `BEGIN READ ONLY`, and a statement denylist checked **before** the query is sent |
| Catches a data-modifying CTE | an allow-list alone would pass `WITH x AS (DELETE …) SELECT …`; the denylist scans the whole statement |
| No credential guessing | dedicated `PG_MEASURE_*` with **no** `DB_*` fallback, plus an explicit opt-in |
| No PII | provider ids hashed to `p_<12 hex>`; the query selects no name, email, phone or address |
| Deterministic | pure classification, stable sort, identical output for reordered input |
| Changes nothing | not imported anywhere in `src/`; a test asserts `AUTO_ASSIGN` still declares `LEGACY_AUTO` |

The read-only check runs **before** `client.query`, asserted by comparing source
positions — a check after the statement is sent prevents nothing.

---

## 5. Reading the result

| Outcome | Reading |
|---|---|
| `wouldBeRefused = 0` | The correction is free. Adopt `FULL` for `AUTO_ASSIGN`. |
| Small, all `NO_CAPABILITY` | Those auto-assignments were sending unqualified providers to jobs. The refusals are the fix, not the cost. |
| Large, or mostly `ROLE_NOT_PROVIDER` | Stop. A large role-based delta more likely means the role data is wrong than that dispatch is broken, and tightening would suppress assignment platform-wide. |
| Any `ARCHIVED` | Archived providers are being auto-assigned live work today. Worth acting on regardless of the rest. |

---

## 6. Caveats

- It measures **history**, not the current candidate pool. A provider who lost a
  qualification last week appears in every past assignment they took.
- It reads `booking_transitions`, so it only sees auto-assignments made **since
  the canonical executor shipped**. Older dispatcher assignments predate that
  evidence and are invisible to it. On a database where the executor has not yet
  deployed, `autoAssignments` will be **0** — which is a true answer to "what
  has the executor recorded", not evidence that auto-assignment is unused.
- Capability uses the same two-grant predicate the executor uses today
  (`employee_services` ∪ approved applications). If the backing table later
  moves to `catalog_provider_services`, this measurement must be re-run — the
  two questions are not interchangeable.

---

## 7. Status

```
HARNESS          written, 27 safety tests green
RUN              never — needs production read access
BLOCKS           closing LEGACY_AUTO upward (TAB 05 sequence item 2)
CHANGES MADE     none; AUTO_ASSIGN still declares LEGACY_AUTO
```
