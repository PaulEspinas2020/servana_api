# The v1 job-card projection — measured, and what a migrating client must derive

**TAB 02 of the Servana Backend Master Command (worker/provider mobile).**
Measured at `4a647fd` / `10ace32`, 2026-08-21. Backend only. Nothing pushed or
deployed.

---

## Verdict: the mandate was already satisfied at this HEAD

The Master Command records TAB 02 as a **P0**:

> "GET /api/worker/job-cards and /api/worker/job-cards/`$bookingId` have no
> canonical successor." … "A client can accept, travel, arrive, start and
> complete a job entirely on v1 — and cannot read the job it is acting on
> without a legacy call."

**That is not true of this backend.** Measured, with citations:

| Claim | Measured |
|---|---|
| No canonical successor for the list | `provider.jobs.list` → `GET /api/v1/provider/jobs`, `contract.ts:701` |
| No canonical successor for the single card | `provider.jobs.get` → `GET /api/v1/provider/jobs/:bookingId`, `contract.ts:740` |
| The projection is legacy-only | Both v1 handlers call **`controllers/jobCardView.formatJobCard`** — the *same function* both legacy controllers call (`providerJobs.ts:46`, `:69`; `providerController.ts:2734`, `:2752`) |
| The projection does not carry `canonicalState` | `formatJobCard` emits `canonicalState`, `stateLabel`, `nextAction`, `terminal` (`jobCardView.ts:107-129`) |
| The projection does not carry `availableActions` | Emitted, and **generated from the transition whitelist** rather than switched on a raw status (`jobCardView.ts:131-160`) |
| The legacy paths have no declared successor | Both declared `ALIAS_TEMPORARILY` in the contract, and the **generated** migration matrix names the successors (`LEGACY_ENDPOINT_MIGRATION_MATRIX.md:105-106`) |
| The mobile client cannot migrate | The provider mobile client's **own published manifest** cites the Dart file and line where it already calls both: `lib/features/jobs/provider_jobs_api.dart:64` and `:67` |

### Why the book says otherwise

TAB 02 was written from the mobile client's **frozen legacy inventory** — the
set of legacy paths still *present* in its code. That is a different question
from "has no canonical successor". A path stays in a legacy inventory while an
un-deleted legacy code path still references it, even when the client is also
calling the canonical route. The client's own **canonical call manifest**, which
lives in this repository and is derived from file:line citations rather than
maintained by hand, records both v1 job routes as called.

The two documents disagree, and the manifest is the one with citations.

**So the remaining work on these two paths is client-side deletion, not backend
publication** — and that is out of scope here.

## What TAB 02 delivered instead

The projection existed. What did **not** exist was an *executed* proof that the
surfaces cannot drift apart.

`tests/provider-job-response-contract.test.ts` proves the sharing by reading the
three controllers' **source** and asserting the text returns `formatJobCard(...)`
unmodified. Its own docblock draws exactly the right distinction — *"they all
import it" and "they all return what it produced" are different claims* — and
then establishes the second by reading imports. Source text is not behaviour: a
wrapper around the call, a field deleted from the envelope on the way out, or a
response post-processed by middleware would all leave the asserted substring
exactly where it is.

`tests/provider-job-card-executed-parity.test.ts` (new) **runs** them. One seeded
row, both handlers invoked against a response double, the two emitted payloads
compared byte for byte. It also asserts, against what the handler *actually
sent* rather than against the schema that describes it:

- `canonicalState` and `availableActions` are present and non-empty — the TAB 02
  acceptance criterion;
- the deprecated `status` / `workerStatus` pair is **still** carried, so the
  addition stayed additive and shipped apps keep working;
- the provider uid is taken from the **token**, and a path parameter naming
  another provider never reaches the query — the BOLA shape v1 exists to remove;
- a non-numeric `bookingId` is refused **before** the query runs.

Mutation-verified: stripping `availableActions` from the v1 response makes it
fail.

---

## What a client must derive itself

The card is identical. Two things around it are not, and a migrating client has
to handle both.

### 1. The envelope

| | Legacy | v1 |
|---|---|---|
| List | a bare JSON array | `{ "data": { "jobs": [...] }, "meta": { "page": {...} } }` |
| Single | the card object | `{ "data": { ...card } }` |

### 2. Pagination — the one behavioural difference, and the one with teeth

`getJobCardsByWorker` has **no `LIMIT`**: the legacy route returns every readable
card. The v1 list windows them — `readPage(req, { defaultLimit: 50, maxLimit: 100 })`.

So a provider with more than fifty readable job cards, calling
`GET /api/v1/provider/jobs` **without** `limit`/`offset`, receives fifty.

That matters more than a page usually does, because the query is
`ORDER BY b.schedule ASC`. The rows dropped are the **furthest-future** ones — a
provider would lose sight of upcoming work rather than of old history, which is
the opposite of the usual truncation failure and much harder to notice.

The information needed to detect this **is** published: `meta.page.total` is on
every response, and `limit`/`offset` are declared as query parameters in
`openapi.v1.json`. A client that reads `total` cannot be fooled. A client that
assumes the array is complete — as it was on legacy — silently can be.

**This is the single thing a client team migrating off `/api/worker/job-cards`
must be told.** It is recorded here and asserted by test.

### 3. The single-card route is still needed

TAB 02 asked whether `/v1/provider/jobs/{bookingId}` remains necessary once the
list carries the projection. **Yes**, and precisely because of the windowing
above: from the list alone, "not on the page I fetched" and "not mine" are
indistinguishable. The single-card route answers that question directly, scopes
by uid inside the SQL, and returns a 404 that deliberately does not distinguish
"not yours" from "not there". Asserted by test.

---

## Not changed

No production code was modified for TAB 02. The projection, the canonical
fields, the legacy mappings and the generated matrix were already correct; adding
code to a correct implementation to make a book's checklist feel satisfied would
be the opposite of what the standing rules ask for.

Every other TAB should be re-measured the same way before implementation. TAB 01
found its premise accurate; TAB 02 did not.
