# TAB 11 — Composition Layer: Homepage + Composition Endpoint

## Verdict

```
HOMEPAGE API VERDICT: CERTIFIED_WITH_NONBLOCKING_GAPS
```

Every release gate is met in code, with tests that were actually executed. The
gaps below are product-sequencing, not defects: two declared sections have no
data source in this database yet, and no client has migrated because the
platform-app repositories are out of scope until the backend Master Command
completes.

```
NO DUPLICATED SERVICE/BOOKING TRUTH    PROVEN      ✔  catalog price republished byte-identical
ALL REFERENCES ARE CANONICAL IDS       ASSERTED    ✔  services.id + bookings.id; no family, no option id
LEGACY OPTION ID STILL RESOLVES        PROVEN      ✔  COALESCE fallback ranks the right service
PERSONALIZED DATA IS ACCOUNT-ISOLATED  PROVEN      ✔  two customers driven; no id crosses
PAYLOAD IS BOUNDED                     MEASURED    ✔  items, bytes and query count, over an oversized fixture
WEB/MOBILE RECEIVE EQUIVALENT CONTENT  EQUALITY    ✔  one composition; shared sections byte-identical
PARTIAL FAILURE ISOLATED               PROVEN      ✔  a failing section leaves the page renderable
CACHE SEPARATION public/personal       DERIVED     ✔  from sections present, not from the route
BOOKING STATE IS THE READ MODEL        YES         ✔  deriveCanonicalState + toCustomerProjection
NOTIFICATION COUNT IS THE ONE INBOX    YES         ✔  TAB 09 countUnread, not a second count
DOCS ARE EXECUTED, NOT WRITTEN         YES         ✔  caching + budget tables are run output
BANNERS SECTION                        EMPTY       ⚠  no promotion source exists; inventing one was forbidden
FEATURED CURATION                      DERIVED     ⚠  reuses catalog display_order; no featured flag exists
CLIENTS MIGRATED                       0 of 5      ⚠  out of scope until the Master Command completes
/home/refresh                          NOT BUILT   ⚠  deliberate; nothing to refresh
PRODUCTION SMOKE                       NOT RUN     ✖  forbidden by the standing rules
```

Branch `main`, HEAD `36ca152`. **All work is uncommitted and local.** Nothing was
pushed, deployed, or run against production.

---

## 1. The sweep

The customer app assembles home on the device from three or four separate calls
on launch — catalog, notifications, bookings — each a round trip on a Philippine
mobile network. There is no homepage endpoint, so there is nothing to alias:
this is a new capability, and TAB 01 recorded it as a `planned` placeholder for
exactly that reason.

What the sweep found about the sources:

| Section the command names | Source found |
| --- | --- |
| categories | `catalogPublicService.listCategories` — exists |
| featuredServices | **No featured flag anywhere.** Catalog has `display_order`. |
| popularServices | **No popularity table.** Derivable from completed bookings. |
| recentServices | Derivable from the customer's own bookings |
| activeBooking | `deriveCanonicalState` + `toCustomerProjection` — exists |
| banners/promotions | **Nothing. No promotions table exists.** |
| notificationSummary | `notificationInbox.countUnread` — TAB 09 |

Two of the seven have no source, and the command is explicit that the homepage
must not own promotion truth. So neither was invented:

- **`banners`** is declared and serves `NOT_CONFIGURED`. Declaring it empty
  rather than omitting it means a client builds the surface once and it fills in
  the day a promotion source is built.
- **`featuredServices`** reuses the catalog's OWN curation signal,
  `display_order`, which admins already set. A second featured flag beside it
  would be a second thing to keep in step.

### What could have gone wrong and did not

The failure this tab exists to prevent is specific: a home endpoint grows a
`HomeServiceCard` with its own price, then a `HomeBookingStatus` enum with four
values because the real one has eleven, and within two releases the homepage is a
third source of truth. `SECTION_TYPES` therefore declares, per section, WHICH
service owns the data — and `home-composition.test.ts` asserts the catalog's
distinctive price (`1234.56`) arrives byte-identical, which a homepage that
recomputed or reformatted could not produce.

---

## 2. Endpoints

### Added — canonical, 2 entries

| Method | Path | Domain service |
| --- | --- | --- |
| GET | `/api/v1/home` | `homeService.composeHome` |
| GET | `/api/v1/home/sections` | `homeService.describeSections` |

`home.feed` was a `planned` placeholder from TAB 01; it is now implemented.
`home.sections` is new.

### NOT built, deliberately

`GET /api/v1/home/refresh`, which the command names as "only if current
architecture requires". It does not. The composition holds no server-side cached
copy, so every request is already current — an endpoint whose only behaviour is
to return what the previous one returned is a route that exists to be called by
mistake. The per-section TTLs and the `?sections=` selector cover the case a
client actually has: re-fetching part of the page.

### Aliased / retired

None, and none possible. There is no legacy homepage endpoint.

### Related routes, deliberately KEPT

`GET /api/catalog` and `GET /api/user/notifications/unread-count` are recorded on
the contract entry as `KEEP` rather than `ALIAS_TEMPORARILY`. Home REFERENCES
them — the categories section delegates to the same service, the badge comes from
the same inbox — and a client that needs only the badge should not fetch a whole
page to get it.

---

## 3. The architecture

### One declaration

`src/services/home/homePolicy.ts` holds no database handle. It declares the seven
sections with their audience, owner, canonical reference id, TTL and ceiling; the
cache decision; the payload budget; the partial-failure vocabulary; and the
caller matrix — plus two pure functions, `cacheControlFor` and `failsRequest`.

### Caching is decided by the RESPONSE, not the route

`cacheControlFor` reads the sections actually present. Any personal section makes
the whole response `private, no-store`, whatever the individual TTLs say. A
shared cache holding one customer's active booking and serving it to the next
request is the leak §115 forbids, and it is one the server cannot observe once a
proxy is in front of it. `Vary: Authorization` is set alongside.

The shortest TTL wins among public sections, because a response is only as fresh
as its stalest part — taking the maximum would serve a 15-minute popularity
ranking under a 5-minute promise.

So `?sections=categories,featuredServices` is genuinely cacheable and the default
set is not, and neither is a property of the URL.

### Partial failure is the normal case

`Promise.allSettled`, one envelope per section. A failed section arrives as
`unavailable` with a reason CODE and an empty `items` array — never absent, so a
client renders a gap rather than crashing on a missing key — and the exception
goes to the log rather than to the caller.

`EMPTY` and `UNAVAILABLE` are deliberately different codes. An empty recents list
is a new customer; an unavailable one is a backend that failed. Collapsing them
shows "no recent services" to somebody who has ten.

### The legacy option id still resolves

Popularity and recents both resolve each booking through
`bookingCanonicalServiceSql` — the same COALESCE the eligibility pipeline uses —
so a booking created before Catalog V2 ranks the right `services.id` rather than
silently dropping out. The test fake models that fallback branch faithfully,
because it is the branch that would otherwise fail invisibly.

### The registry is append-only in practice

An unknown section name is IGNORED rather than refused. A client shipped against
a newer registry asking for a section this build lacks gets the rest of its page,
not a 400 — refusing would make adding a section a breaking change for every
older client. If EVERY requested name is unknown the full set is served, because
composing an empty page would look like an outage.

---

## 4. Tests actually executed

Full local run: **236 suites / 5,176 tests, all passing**, plus both typechecks,
the protected-contract guard and all seven doc-drift checks. `npm run build`
clean. Nothing below is claimed unexecuted.

### Suites added — 3, 54 tests

| Suite | Tests | What it proves |
| --- | --- | --- |
| `home-composition.test.ts` | 27 | Canonical ids on every card; no family or option id anywhere in the payload; the legacy-option-id fallback resolves; the catalog price is republished unchanged; two customers' recents, active bookings and unread counts never cross; an anonymous caller gets a page without personal sections; a failing section leaves the rest renderable; EMPTY vs UNAVAILABLE; banners are `NOT_CONFIGURED`; section selection, dedup and unknown-name handling; the cache decision. |
| `home-parity-performance.test.ts` | 11 | Web and Mobile shared sections byte-identical; asking for fewer sections changes nothing about the ones returned; no client-specific builder exists; every ceiling bites on a 40-service / 30-category fixture; total items, serialized bytes and query count inside budget. |
| `home-docs-generated.test.ts` | 16 | The committed document is the generated one, and the caching table matches the real function row by row. |

`tests/support/homeDbFake.ts` routes the real SQL and models the
`catalog_service_id → legacy_service_option_id` COALESCE faithfully. Mocking the
section builders would have proved the composition calls them; routing the SQL
proves the queries are account-scoped and the ids are canonical, which is what
the gates say.

The catalog is MOCKED in the composition suite, and that is the test rather than
a shortcut: giving it a distinctive price and asserting the card carries exactly
that is what proves the homepage did not recompute one.

### Suites updated — 2

`v1-router` (2 new entries plus a home-service mock) and `suite-inventory`
(233 → 236). No existing suite needed a behavioural change: nothing was
modified outside the new module, the contract and the registry.

---

## 5. Cross-platform caller matrix

Rendered in full, with a per-capability rationale, in `HOME_V1_CONTRACT.md` §7 —
generated from `HOME_CAPABILITIES`, so it cannot drift from the contract.

Summary: **two capabilities, zero role splits.** Customer Web and Customer Mobile
receive the identical section set and the identical DTOs from one composition, so
"equivalent shared content" is a property of there being one endpoint rather than
two implementations kept in step. That is why the parity suite can compare two
REQUESTS rather than two code paths.

Providers are `—` throughout. Provider Web and Provider Mobile have a dashboard
with genuinely different content and their own endpoint; folding both into one
surface would give the response a role branch and two meanings.

No cell reads `legacy`, and the document explains why: home is new, so there is
no legacy homepage endpoint to alias.

---

## 6. Gaps

### P0 — none

### P1 — none

### P2 — two sections without a source

1. **`banners` serves `NOT_CONFIGURED`.** No promotions table exists, and the
   command forbids the homepage owning promotion truth — so inventing one would
   have been the violation rather than the fix. The section is declared so a
   client builds the surface once. Building a promotion source is a product
   decision and a domain of its own.

2. **`featuredServices` is `display_order`, not curation.** Reusing the catalog's
   existing signal is the honest available answer, and it means "featured" is
   whatever an admin ordered first rather than something anybody chose to
   feature. A real featured flag belongs on the catalog, not here.

### P3 — sequencing and deliberate remainders

1. **No client migrated.** Platform-app repositories are out of scope. The three
   or four serial launch calls are unchanged and still work.

2. **No migration file.** This tab adds no table and no column — a composition
   endpoint that needed schema would be one that owned data. The only new
   persistence-adjacent behaviour is reading, and everything it reads already
   exists.

3. **Popularity is a full-table aggregate with no cache beyond its TTL.** It is
   the section most likely to be slow and is the reason the partial-failure path
   exists. A materialised ranking is the obvious next step if the response-time
   budget is ever missed; it was not built because a nightly job is infrastructure
   this tab does not need to justify itself.

4. **`hasEscalation` is passed as `false`** to `deriveCanonicalState` in the
   active-booking builder. The homepage does not read `booking_escalations`, so a
   booking in dispute shows its underlying state rather than `ESCALATED`. The
   booking detail screen shows the dispute; a home card that quietly misreported
   it would be worse, so this is recorded rather than hidden — joining the
   escalation table is a one-line change if the card should show it.

5. **No response-time assertion.** The budget test bounds items, bytes and query
   count — things that are deterministic. Wall-clock time against a fake database
   would measure the fake.

---

## 7. The next safe deprecation step

**Nothing to deprecate. The next step is a client adopting it.**

This tab retires nothing and aliases nothing, because there was no homepage
endpoint to replace. The three or four serial calls the customer app makes on
launch are canonical reads in their own right and are explicitly `KEEP`.

So the next safe step is **Customer Web calling `GET /api/v1/home`** and dropping
its serial launch fan-out. Web first for the usual reason — no installed base to
outlive a release — and because the parity suite already proves it will receive
the same shared sections Mobile later gets.

Only after both customer clients have adopted it does any retirement question
arise, and even then it is narrow: the standalone catalog and unread-count routes
stay, because a client that needs only the badge should not fetch a page. What
could eventually retire is the client-side composition itself, which lives in the
app repositories and is out of scope here.

If a promotions source is built later, `banners` fills in with no client release
and no contract change — which is the reason it was declared empty rather than
omitted.
