# TAB 12 — P1/P2: Post-Service Trust (Reviews + Service Completion + Quality/Support)

## Verdict

```
REVIEWS + QUALITY VERDICT: CERTIFIED_WITH_NONBLOCKING_GAPS
```

Every release gate is met in code, with tests that were actually executed. The
gaps below are sequencing and naming, not defects: no client has migrated
because the platform-app repositories are out of scope until the backend Master
Command completes, and two canonical paths keep the names TAB 01 shipped rather
than the ones this command's prose used.

```
REVIEW REFERENCES AN ELIGIBLE BOOKING     PROVEN      ✔  pure decision, 9 scenarios executed
NO DUPLICATE ACTIVE REVIEW PER BOOKING    PROVEN      ✔  lock → in-txn check → insert, order asserted
PROVIDER COMES FROM THE ASSIGNMENT        STRUCTURAL  ✔  no provider field exists on the payload
RATING SUMMARY IS BACKEND-DERIVED         PROVEN      ✔  no endpoint accepts a rating; aggregate table
HIDDEN NEVER COUNTS TOWARD THE RATING     PROVEN      ✔  invariant asserted over all 7 states
POLICY AND AGGREGATE AGREE STATE-BY-STATE PROVEN      ✔  countsTowardRating ≡ isAggregateContributor
MODERATION IS AUDITABLE                   EXISTS      ✔  review_moderation_cases, append-only
REVIEW ACCESS FOLLOWS ROLE/PRIVACY RULES  PROVEN      ✔  leak suite over a row carrying every private column
PRIVATE FEEDBACK NEVER REACHES A PROVIDER PROVEN      ✔  author + admin seats only
SUPPORT IS GROUNDED IN A BOOKING          PROVEN      ✔  owner-scoped SQL; unowned ≡ absent
BILLING ROUTED, NOT FORKED                PROVEN      ✔  routedTo: finance; no money module imported
CATALOG V2 SERVICE ID CORRECTED           FIXED       ✔  was a family id; dimensions never matched
DOCS ARE EXECUTED, NOT WRITTEN            YES         ✔  eligibility + visibility tables are run output
CANONICAL PATH NAMES                      DIFFERENT   ⚠  TAB 01 shipped /reviews/providers/:uid
CLIENTS MIGRATED                          0 of 5      ⚠  out of scope until the Master Command completes
REVIEW WRITE PATH AGAINST A REAL DATABASE NOT RUN     ⚠  asserted structurally; see §6
PRODUCTION SMOKE                          NOT RUN     ✖  forbidden by the standing rules
```

Branch `main`, HEAD `36ca152`. **All work is uncommitted and local.** Nothing was
pushed, deployed, or run against production. No live provider, customer, order
or booking record was read or written.

---

## 1. The sweep

Unlike TAB 11, this domain was not missing. `customerReviewService` is 711 lines
and most of it was already right: an advisory transaction lock, a
`client_request_id` replay, the provider resolved from the COMPLETED assignment
rather than the payload, completion and window checks, a duplicate refusal.
`ratingAggregationService`, `review_moderation_cases`, `review_reports`,
provider responses and `service_review_dimensions` all existed from migration 012.

| Deliverable the command names | Found |
| --- | --- |
| Review creation | `customerReviewService.createReview` — exists, sound |
| Review eligibility rules | Only as `if` statements inside one function |
| Provider rating projection | `ratingAggregationService` — exists |
| Moderation workflow | `review_moderation_cases` + admin routes — exists |
| Review events | `ReviewCreated` in the TAB 09 registry — exists |
| Post-service support | **Nothing booking-scoped.** See §4. |

So this tab did four things: DECLARED what was implicit, FIXED a real defect,
BUILT the one missing surface, and TESTED all of it.

---

## 2. The defect this tab found and fixed

`getBookingForReview` resolved a booking's service like this:

```sql
LEFT JOIN servana.service_options so ON so.id = b.service_option_id
...
so.service_id::text AS service_id
```

`catalogPublicService` documents, in its own header, that
`service_options.service_id` is **a foreign key to `service_families`** — legacy
coarse provenance. That id was then used to look up
`service_review_dimensions`, whose `service_id` column is
`BIGINT NOT NULL REFERENCES servana.services(id)` — the Catalog V2 canonical
specific-service identity.

Two different id spaces. Service-specific review dimensions were being looked up
with a family id against a table keyed on a service id, so **they silently never
matched** and every review fell back to the global dimension set. Worse, had the
two id ranges overlapped, it would have matched the *wrong* service's dimensions
— a customer rating "grout finish" on a booking that was an aircon service.

It is also precisely the constraint this command restates: the family must not
become the canonical bookable identity again.

The fix is one line, using the helper the eligibility pipeline already owns:

```ts
(${bookingCanonicalServiceSql(dbSchema, 'b')})::text AS service_id
```

**No schema change and no backfill.** The schema was always right; only the read
was wrong. Reviews do not store a service id of their own, so no stored row
carries a bad one. `tests/review-eligibility.test.ts` asserts the correct helper
is used and that `service_options` no longer appears in the lookup at all.

---

## 3. What was declared

`src/services/reviews/reviewPolicy.ts` — no database handle, every decision
function pure, four consumers: the service enforces it, the support service
routes against it, the generator executes it, the tests assert it.

The eligibility rules had lived only as a sequence of `if` statements, which
meant no document could state them and no test could assert them without driving
six tables. `evaluateEligibility` is now the decision, and the contract's
eligibility table is its output rather than a description of it.

**Precedence is the load-bearing part.** Ownership is checked first and answers
identically to a booking that does not exist. Run with every input wrong at
once, the verdict is `BOOKING_NOT_OWNED` with **no window** — so a caller cannot
learn whether somebody else's booking exists, was completed, or was already
reviewed. A booking id is a small integer.

Completion is checked before the window because "not finished yet" and "too
late" are opposite situations, and a client that shows the wrong one tells a
customer to give up when they should wait. That is why every refusal carries
`terminal: true|false`.

---

## 4. What was built

`booking_support_cases` and `postServiceSupportService`. The gap was real:

- `support_tickets` (customer contact) carries **no booking id**, so a quality
  complaint raised through it arrives with no way to see which visit it is about;
- `provider_support_cases` is a different party asking a different question.

### The BILLING decision

A `BILLING` case is **accepted, stored, and routed to finance** — the response
carries `routedTo: "finance"` and names `POST /api/v1/bookings/:bookingId/refunds`.

Handling it here would mean a second refund path with its own eligibility rules
beside the one `bookingPaymentService` enforces, and a refund granted under
different rules from the ones reconciliation checks is a break nobody can close.
Refusing it outright would be worse in the other direction: the customer has a
real problem and no button. `tests/review-support-case.test.ts` asserts the
service imports no payment, refund, payout or processor module at all — it
cannot fork the refund path, because it cannot reach it.

Damage and safety raise at elevated severity. One has financial exposure; the
other may involve somebody being unsafe in their own home.

---

## 5. The release gates, and how each was proven

**A review always references an eligible booking.** `evaluateEligibility` run
over one eligible baseline with a single field spoiled at a time — nine
scenarios, each printed into the contract. Seven distinguishable refusal codes,
each with a status and a terminal/retryable kind.

**One booking cannot create duplicate active reviews.** Three mechanisms, and
the test asserts their ORDER in source rather than merely their presence:
`BEGIN` → `pg_advisory_xact_lock(review:{customer}:{booking})` → the
existing-review check **on the transaction's own connection** → `INSERT` →
`COMMIT`. A check taken before the lock is a check two concurrent submissions
both pass. `client_request_id` replays the original rather than writing a second,
and the replay returns the ORIGINAL content — so a retry cannot quietly edit.

**Provider rating summary is backend-derived.** No endpoint accepts a rating; the
handler file contains no rating assignment at all. The stronger property is that
`countsTowardRating` (policy) and `isAggregateContributor` (aggregate service)
are asserted equal for every one of the seven moderation states — two files
deciding the same thing separately is how a hidden review keeps moving an
average. And no state is both hidden and counted, which is what stops a
provider's displayed rating disagreeing with the reviews shown beneath it.

`REPORTED` deliberately stays visible and keeps counting: hiding on report would
make the report button a censorship button.

**Moderation and support state is auditable.** `review_moderation_cases` is
append-only and records the before/after state, the visibility effect, the
deciding admin, the timestamp, the provider-facing reason and internal notes.
Support cases carry an immutable `created_at`, a `state` and a `resolved_at`.

**Review data access follows role/privacy rules.** Every projection is fed a row
carrying every private column the tables hold — email, phone, address, private
feedback, moderator notes, a password hash, an FCM token — and the assertion is
on the serialized output. A stranger's read carries the rating, the comment and
the provider response; nothing else. `privateFeedback` reaches the author and
admin only: a customer who writes "he made me uncomfortable" there has not
consented to that reaching him. `bookingId` is withheld from the public because a
booking id plus a provider plus a date locates a person at an address on a day.

---

## 6. Gaps, stated plainly

**The path names differ from the command's prose.** The command names
`/providers/:providerId/reviews` and `/providers/:providerId/rating-summary`. The
canonical routes are `/api/v1/reviews/providers/:providerUid` and
`.../rating`, which SHIPPED in TAB 01 and which the contract, the OpenAPI
document and the migration matrix already carry. They are the same resources
under a path that groups by domain rather than by subject. Renaming them now
would break migrated callers and duplicate a route to gain nothing, so they were
reused. The generated contract states the difference in §8 rather than quietly
adopting the command's wording, because a client team reading it would otherwise
call a path that does not exist.

**The review write path is asserted structurally, not driven against a
database.** `createReview` is ~150 lines of SQL across six tables from migration
012. The support-case path IS driven against a fake that routes the real
statements and enforces the real constraints — the owner-scoped predicate, the
open-case ceiling, the partial unique index throwing `23505`. For the review
write path a fake faithful enough would be a reimplementation of Postgres, so
its guarantees are asserted against the pure decision function plus the source
order of lock/check/insert/commit. This is stated in `tests/support/reviewDbFake.ts`
rather than left implicit.

**No client has migrated.** All five surfaces read `legacy` or `planned`. The
platform client repositories are out of scope until the backend Master Command
completes; the legacy routes remain mounted and aliased, and are retired only on
the observed-zero-traffic criteria.

**Migration 035 has not been applied anywhere.** The only reachable database is
production, which this work is forbidden to touch. The service applies the same
DDL lazily with `IF NOT EXISTS`, so whichever runs first wins — the convention
every tab since 029 has used, and `tests/review-policy-wiring.test.ts` asserts
the two declare the same columns and the same partial unique index.

---

## 7. Verification actually executed

```
npm run typecheck            PASS
npm run typecheck:tests      PASS
guard:protected-contracts    PASS
8 doc-drift checks           PASS  (api, booking, finance, messaging,
                                    notification, account, home, review)
npm run test:ci              PASS  241 suites, 5311 tests
npm run build                PASS  tsc + asset copy
```

TAB 12 suites, all executed:

| Suite | Tests |
| --- | --- |
| `tests/review-eligibility.test.ts` | 36 |
| `tests/review-support-case.test.ts` | 28 |
| `tests/review-leakage.test.ts` | 20 |
| `tests/review-policy-wiring.test.ts` | 21 |
| `tests/review-docs-generated.test.ts` | 22 |
| `tests/v1-router.test.ts` (extended) | 210 |

### An honest note about the full run

The first `npm run verify` of this tab reported 3 failures in 2 suites
(`tests/catalog-banner.test.ts`, `tests/booking-c-confirm-otp.test.ts`). Both
pass in isolation. A second full run scoped differently failed two *different*
suites (`tests/catalog-service.test.ts`, `tests/admin-dedup.test.ts`), and two
subsequent unmodified full runs passed 241/241 and 5311/5311.

That pattern — a different failure set each time, none of them in code this tab
touched, all passing alone — is order- or resource-sensitivity in the single
`--runInBand` process, not a TAB 12 regression. It is recorded here rather than
omitted because a suite that fails intermittently is a real thing to fix, and it
is not this tab's to fix silently. `catalog-banner` builds a 4 MB buffer and
spreads it, which is the most likely stack-pressure candidate.

---

## 8. Files

**New**

```
src/services/reviews/reviewPolicy.ts
src/services/reviews/postServiceSupportService.ts
scripts/generate-review-docs.ts
scripts/migrations/035-post-service-support.sql
docs/reviews/REVIEWS_V1_CONTRACT.md          (generated)
docs/reviews/TAB12_CERTIFICATION.md
tests/support/reviewDbFake.ts
tests/review-eligibility.test.ts
tests/review-support-case.test.ts
tests/review-leakage.test.ts
tests/review-policy-wiring.test.ts
tests/review-docs-generated.test.ts
```

**Modified**

```
src/services/customerReviewService.ts        the Catalog V2 correction
src/api/v1/domains/reviews.ts                4 new handlers beside the 2 from TAB 01
src/api/v1/contract.ts                       4 canonical entries + legacy aliases
src/api/v1/errors.ts                         6 codes
src/api/v1/openapi.ts                        7 schemas
package.json                                 review:docs, review:docs:check, verify
tests/v1-router.test.ts                      4 route cases
tests/suite-inventory.test.ts                236 → 241
docs/api/*                                   regenerated
```

Nothing else was touched. The TAB 01–11 dirty tree was preserved in full.
