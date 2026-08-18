# Capability query audit — TAB 05 Phase 0

**Measurement only. No code changed.**

The question: *when the platform asks "is provider X qualified for service Y?",
how many different answers can it get?*

Answer: **four sources, three live predicates, and they disagree.**

---

## 1. The four sources, by usage

| Table | References in `src/` | Used by |
|---|---:|---|
| `employee_services` | **101** | the executor, eligibility, matching, supply health, onboarding, admin |
| `worker_service_applications` | **74** | the executor, eligibility (as a *reason*, not a grant) |
| `catalog_provider_services` | **11** | `catalogAdminService` (10), `catalogPublicService` (1) — **coverage reporting only** |
| `provider_services` | 1 | a comment. Not a real table reference. |

The command names `catalog_provider_services.service_id → services.id` as the
canonical qualification. **It is not currently used by any matching,
assignment, or eligibility path.** Its eleven references are all catalog
coverage questions of the form "does this service have any provider at all".

---

## 2. The three live predicates, verbatim

### A. The canonical executor — `assertAssignableProvider`

```sql
SELECT 1 FROM employee_services
 WHERE employee_uid = $1 AND service_id = $2
UNION ALL
SELECT 1 FROM worker_service_applications
 WHERE worker_uid = $1 AND service_id = $2 AND status = 'approved'
LIMIT 1
```

Ignores `employee_services.status`. Accepts an approved application as a grant.
**This is the predicate that decides whether an assignment actually commits.**

### B. The eligibility engine — `providerEligibilityEngine`

```sql
SELECT 1 FROM employee_services
 WHERE employee_uid = $1 AND service_id = $2
   AND COALESCE(status, 'active') = 'active'
LIMIT 1
```

Requires `status = 'active'`. Reads `worker_service_applications` **only to
produce a human-readable reason** — a pending or approved application never
grants eligibility here.

### C. Supply health — `providerSupplyHealthService`

```sql
EXISTS (SELECT 1 FROM employee_services es
         WHERE es.employee_uid = uc.uid AND es.service_id = $n)
```

No status filter. No applications. A third answer.

### D. A fourth vocabulary exists

`providerAutoOnlineEngine` types its own capability source as:

```ts
source: 'employee_services' | 'service_applications' | 'catalog_capabilities' | 'mixed' | 'none'
```

So `catalog_capabilities` is already a recognised concept in the auto-online
path, distinct from the three above.

---

## 3. Where they disagree, concretely

| Provider state | Executor (A) | Eligibility (B) | Supply (C) |
|---|---|---|---|
| `employee_services` row, `status='active'` | qualified | eligible | counted |
| `employee_services` row, **`status='inactive'`** | **qualified** | **NOT eligible** | counted |
| **only** an approved `worker_service_applications` row | **qualified** | **NOT eligible** | **not counted** |
| approved application + inactive `employee_services` row | qualified | NOT eligible | counted |

Two of those rows are the failure the command calls *eligibility drift*, and
they fail in the more dangerous direction:

> **Admin's eligibility preview says a provider is NOT eligible, and the
> executor assigns them anyway.**

The preview is advisory; the executor is authoritative. So the platform can
show an operator a refusal reason for an assignment that will, in fact,
succeed — and the reverse is equally reachable: a provider who looks eligible
in supply-health counts and is refused at commit.

`employee_services.status` is added by **lazy DDL** in
`providerAutoOnlineEngine` (`ADD COLUMN IF NOT EXISTS status TEXT NOT NULL
DEFAULT 'active'`), which is the same class of hazard migration 027 exists to
close: a column whose presence depends on which code path ran first.

---

## 4. ⚠ Why `catalog_provider_services` cannot simply be adopted

**Nothing in this repository writes it.** There is no `INSERT INTO
catalog_provider_services` and no `CREATE TABLE` for it anywhere in `src/` or
`scripts/`. Like `bookings`, it is created and populated outside the repo — or
it is a view, or it is empty.

That makes "switch qualification to `catalog_provider_services`" a change whose
blast radius cannot be computed from the code alone. If the table is sparsely
populated relative to `employee_services`, migrating the predicate would
silently **shrink the assignable provider pool** — possibly to zero for some
services — and the symptom would be bookings that stop finding providers rather
than an error anybody sees.

Before adopting it, three facts are needed from production, all read-only:

```sql
-- 1. Does it exist, and is it a table or a view?
SELECT table_type FROM information_schema.tables
 WHERE table_schema='servana' AND table_name='catalog_provider_services';

-- 2. How does its coverage compare to what actually drives assignment today?
SELECT
  (SELECT COUNT(DISTINCT employee_uid) FROM servana.employee_services)        AS es_providers,
  (SELECT COUNT(DISTINCT provider_uid) FROM servana.catalog_provider_services
    WHERE status='active')                                                     AS cps_providers,
  (SELECT COUNT(DISTINCT service_id)   FROM servana.employee_services)         AS es_services,
  (SELECT COUNT(DISTINCT service_id)   FROM servana.catalog_provider_services
    WHERE status='active')                                                     AS cps_services;

-- 3. Who would LOSE qualification under the migration?
SELECT es.employee_uid, es.service_id
  FROM servana.employee_services es
 WHERE NOT EXISTS (
   SELECT 1 FROM servana.catalog_provider_services cps
    WHERE cps.provider_uid = es.employee_uid
      AND cps.service_id   = es.service_id
      AND cps.status = 'active');
```

Query 3 is the one that matters. A non-empty result is the list of providers
who would stop being assignable the moment the predicate changes.

*(Column names in queries 2 and 3 are inferred from usage — only `service_id`
and `status` are confirmed by the code. Adjust the provider-uid column to
whatever the table actually uses.)*

---

## 5. Recommendation

**Unify on ONE predicate now; defer the choice of BACKING TABLE until the
production comparison above is available.**

Concretely, in this order:

1. **Extract a single `isProviderQualified` / `qualifiedProviderSql`** used by
   the executor, the eligibility engine, supply health and matching — generated
   from one declaration, the same shape that closed the state-derivation
   problem in TAB 04. Behaviour preserved: adopt the **executor's** predicate,
   because it is the one that currently decides real assignments, and changing
   what commits is a bigger behaviour change than changing what a preview says.
2. **That immediately closes eligibility drift**, because the preview and the
   commit stop being able to disagree — which is the defect the command asks to
   be tested for.
3. **Then** switch the backing table to `catalog_provider_services` as a
   *separate, declared* behaviour change, once query 3 shows who it would
   displace. With step 1 done, that becomes a one-line change in one file
   instead of a sweep across twenty.

Doing it the other way round — adopting the new table first — changes both the
source *and* the semantics in one step, across paths that already disagree, with
no way to attribute a regression to either.

**This is a material decision and it is flagged, not taken.** Step 1 is
behaviour-preserving and I can proceed with it immediately. Step 3 needs the
production numbers.

---

## 6. Still to measure in Phase 0

- [ ] Can Job Order status diverge from canonical Booking status? (verdict criterion)
- [ ] Does any route authorize assignment from a **client-provided** provider id? (verdict criterion)
- [ ] Cross-provider leak surface: can Provider A read or act on Provider B's job?
- [ ] Legacy provider endpoint inventory and adapter map
- [ ] Availability / service-area / schedule / capacity predicates — same
      divergence question as capability
