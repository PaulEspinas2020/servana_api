<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-home-docs.ts, derived from
    src/services/home/homePolicy.ts    (sections, caching, budget, failure modes)
    src/services/home/homeService.ts   (the composition)
    src/api/v1/contract.ts             (the canonical endpoints)
  Regenerate: npm run home:docs
-->

# Home v1 Contract

> A COMPOSITION endpoint. It aggregates and owns nothing: every card is a
> reference to a canonical id, and the section registry names which service
> owns each part. The caching and budget tables are produced by RUNNING the
> real decision functions, so they are evidence rather than description.

## 1. The section registry

7 declared sections. The wire names are **append-only**: a client
shipped against an older registry must keep working, so a section is never renamed and an
unknown one is ignored rather than refused.

| Section | Audience | Owned by | Reference id | TTL | Max items |
| --- | --- | --- | --- | --- | --- |
| `categories` | public | `services/catalogPublicService.listCategories` | `catalog_categories.id` | 300s | 24 |
| `featuredServices` | public | `services/catalogPublicService.listPublicServices` | `services.id` | 300s | 10 |
| `popularServices` | public | `services/home/homeService.popularServices (derived from completed bookings)` | `services.id` | 900s | 10 |
| `recentServices` | personal | `services/home/homeService.recentServices (this account's own bookings)` | `services.id` | 0s | 6 |
| `activeBooking` | personal | `services/booking/projections.toCustomerProjection` | `bookings.id` | 0s | 3 |
| `banners` | public | `nothing yet — no promotion source exists in this database` | — | 300s | 5 |
| `notificationSummary` | personal | `services/events/notificationInbox.countUnread` | — | 0s | 1 |

The **Owned by** column is the load-bearing one. The homepage is a READ MODEL: it aggregates
and owns nothing, and every row above names the service that actually decides that data. A
homepage with its own opinion about a price or a booking state is a third source of truth that
disagrees on a Tuesday.

**`categories`** — The Catalog V2 top level. Category → subcategory → service.

**`featuredServices`** — Curated by the catalog's OWN display_order, which admins already set. No featured flag is invented: a second curation signal beside display_order would be a second thing to keep in step.

**`popularServices`** — Ranked by completed booking count, resolved through the canonical `bookingCanonicalServiceSql` so the ranking keys on services.id and never on a legacy option id or a service family.

**`recentServices`** — Services this customer has booked before, most recent first. Account-scoped.

**`activeBooking`** — In-flight bookings with the CANONICAL state, projected by the booking read model. The homepage declares no status vocabulary of its own.

**`banners`** — Declared and EMPTY. There is no promotions table, and the command forbids the homepage owning promotion truth — so inventing one here would be the violation, not the fix. The section exists so a client builds the surface once and it fills in the day a promotion source is built.

**`notificationSummary`** — The unread badge, from the ONE inbox TAB 09 built. Not a second count computed here.

### Two sections that own nothing because nothing exists yet

`banners` has no promotions table in this database, and the command forbids the homepage
owning promotion truth — so inventing one here would be the violation, not the fix. It is
declared and serves `NOT_CONFIGURED`, so a client builds the surface once and it fills in the
day a promotion source is built.

`featuredServices` reuses the catalog's OWN curation signal, `display_order`, which admins
already set. A second featured flag beside it would be a second thing to keep in step.

## 2. Canonical references

Every card is a REFERENCE, never a copy.

### Service cards

- id field: `serviceId` from `services.id`
- hierarchy: `categoryId`, `categoryName`, `subcategoryId`, `subcategoryName`
- **never**: `serviceFamilyId`, `service_family_id`, `serviceOptionId`

Catalog V2 is certified with services.id as the canonical specific-service identity. A card keyed on a family or a legacy option id is how the family becomes the bookable identity again.

A booking created before Catalog V2 carries a legacy option id and no
`catalog_service_id`. The composition resolves it through
`bookingCanonicalServiceSql` — the same helper the eligibility pipeline uses — so such a
booking still ranks the right service rather than silently dropping out of the ranking.

### Booking cards

`bookingId` is `bookings.id`, and the state is the CANONICAL state with its customer
projection: the same `deriveCanonicalState` and `toCustomerProjection` every other customer
surface uses.

The homepage declares no status vocabulary of its own. A four-value homepage enum over an
eleven-state machine is a card that says "in progress" for three different situations.

The active-booking list is additionally filtered on the DERIVED answer rather than the raw
status column, because the derivation is the authority and the two can disagree — that
disagreement is the whole reason the derivation exists.

### Deep links

Reused, not redeclared: `BOOKING_DETAIL`, `NOTIFICATIONS` come from
`services/events/domainEvents.DEEP_LINK_TARGETS`, which already declares one target per
destination keyed on a canonical id with a projection per client. A second deep-link
vocabulary for the homepage is precisely the duplication this tab avoids.

## 3. Caching

The header is derived from the SECTIONS PRESENT, not from the route. Produced by running
`cacheControlFor`:

| Requested | Cache-Control |
| --- | --- |
| every public section | `public, max-age=300` |
| `categories` + `popularServices` | `public, max-age=300` |
| `categories` + `activeBooking` | `private, no-store` |
| every personal section | `private, no-store` |

Two rules produce that table.

**Any personal section makes the whole response `private, no-store`**, whatever the individual
TTLs say. A shared cache holding one customer's active booking and serving it to the next
request is the leak §115 forbids, and it is one the server cannot observe once a proxy is in
front of it. `Vary: Authorization` is set alongside as belt and braces.

**The shortest TTL wins.** A response is only as fresh as its stalest part; taking the maximum
would serve a 15-minute popularity ranking under a 5-minute promise.

So `?sections=categories,featuredServices` is genuinely cacheable and the default set is not,
and neither is a property of the URL.

### One request, not a dozen

Sections are composed with Promise.allSettled. One request, and the latency is the slowest section rather than the sum of all of them.

## 4. Partial failure

Every section is `optional` (7 of 7), which is the
correct default: every section on this page is additive to a page that is still usable without
it. One failed section must not blank the homepage.

A failed section arrives as `status: "unavailable"` with an empty `items` array and a reason
CODE. `items` is never absent, so a client renders a gap rather than crashing on a missing
key, and the exception goes to the log rather than to the caller.

| Reason | Meaning |
| --- | --- |
| `EMPTY` | The section built successfully and has nothing in it. |
| `UNAVAILABLE` | The section could not be built. The rest of the page is unaffected. |
| `NOT_CONFIGURED` | No source is configured for this section yet. |
| `REQUIRES_AUTH` | The section is account-scoped and the caller is anonymous. |

`EMPTY` and `UNAVAILABLE` are deliberately different. An empty recents list is a new
customer; an unavailable one is a backend that failed. Collapsing them shows "no recent
services" to somebody who has ten.

`meta.unavailable` names every section that failed, so a client can tell a partial page from a
complete one without inspecting each envelope.

## 5. Payload budget

| Bound | Value |
| --- | --- |
| Total items across every section | 59 |
| Serialized bytes | 64 KiB |
| Queries per request | 12 |

A homepage that grows without a ceiling is one that gets slower every release and nobody notices which change did it.

Every number is asserted against a COMPOSED response in
`tests/home-parity-performance.test.ts`, over a deliberately oversized catalog — 40 services
and 30 categories — so the ceilings are what is being tested rather than the fixture happening
to be small. The byte ceiling is the backstop that catches a section whose ITEMS grew rather
than whose count did.

## 6. Canonical endpoints

| Endpoint | Auth | Domain service |
| --- | --- | --- |
| `GET /api/v1/home` | authenticated | `services/home/homeService.composeHome` |
| `GET /api/v1/home/sections` | authenticated | `services/home/homeService.describeSections` |

`GET /api/v1/home/refresh` was named as optional in the command and is NOT built. There
is nothing to refresh: the composition holds no server-side cached copy, so every request is
already current, and an endpoint whose only behaviour is to return what the previous one
returned is a route that exists to be called by mistake. Per-section TTLs and the
`?sections=` selector cover the case a client actually has — re-fetching part of the page.

### Related routes, deliberately KEPT

Neither is superseded. Home REFERENCES them rather than replacing them, and a client that
needs only one of them should not fetch a whole page to get it.

| Route | Disposition | Related entry | Why |
| --- | --- | --- | --- |
| `GET /api/catalog` | KEEP | `home.feed` | NOT superseded. The customer app calls it directly for the category browse, and it remains the canonical catalog read. Home REFERENCES it - the categories section delegates to the same service - rather than replacing it. |
| `GET /api/user/notifications/unread-count` | KEEP | `home.feed` | NOT superseded. Home carries the unread count as one section so a launch costs one round trip; the standalone endpoint is still what a client polls when only the badge changed. |

## 7. Cross-platform caller matrix

`migrated` — this client calls the canonical v1 route today.
`legacy` — this client calls a legacy route the canonical entry supersedes.
`planned` — this client will migrate; it calls no equivalent today.
`—` — the capability does not apply to this client.

| Capability | Customer Mobile | Customer Web | Provider Mobile | Provider Web | Admin Web |
| --- | --- | --- | --- | --- | --- |
| The composed home surface | planned | planned | — | — | — |
| Which sections exist and what owns each | planned | planned | — | — | planned |

Home is **new**, so no cell reads `legacy`: there is no legacy homepage endpoint to alias.
The customer app assembles the page on the device from three or four separate calls, and those
calls are KEPT — they are canonical reads in their own right, and home references them rather
than replacing them.

Providers are `—` throughout. Provider Web and Provider Mobile have a dashboard with
genuinely different content and their own endpoint; folding both into one surface would give
the response a role branch and two meanings.

### Why each capability is or is not role-split

**The composed home surface** (`services/home/homeService`)

No role split, and no client split — which IS the capability. Customer Web and Customer Mobile receive the identical section set and the identical DTOs from one composition, so "equivalent shared content" is a property of there being one endpoint rather than two implementations kept in step. Providers have a dashboard with genuinely different content and their own endpoint; folding both into one surface would give the response a role branch and two meanings.

**Which sections exist and what owns each** (`services/home/homeService`)

No role split. The registry is metadata about the page, not content: it says which section types exist, what owns each and how long each may be cached. A client uses it to render unknown sections safely; an admin uses it to see what home is made of without reading the source.
