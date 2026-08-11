# Servana search — the contract

`GET /api/v1/search` · `GET /api/v1/catalog/search`

Two paths, **one implementation**. The command named both as the target; serving
them from two functions would be two search behaviours wearing one name, which
is the thing this programme exists to remove. A test asserts the shared handler.

---

## 1. What existed before

Nothing, on the server.

ServanaClient searches **client-side** over the `/api/services/full` payload.
That is not a stylistic choice with a cost — it is a defect generator. When
`getFullServiceCatalog` shipped every option group nameless (`level2` was
`undefined`, and `JSON.stringify` drops undefined keys entirely), the client's
`search_repository.dart` discarded every group with an empty `level2`, the cache
was permanently empty, and **every query rendered "No services match your
search."** A total data-layer failure presented as a legitimate empty result.

Search that lives on the client can only ever find what the client already
downloaded, in the shape the client happened to parse.

## 2. Request

```
GET /api/v1/search?q=facial&types=service,subcategory&limit=20
```

| Parameter | Required | Meaning |
|---|---|---|
| `q` | yes | Search term. Under **2 characters** returns an empty result, not an error — one character matches most of the catalog. |
| `types` | no | Comma-separated: `category`, `subcategory`, `service`. Default: all three. |
| `limit` | no | 1–50, default 20. Clamped, never trusted. |

An **unrecognised** `types` value is a `VALIDATION_FAILED`, not a silent
narrowing. Answering with services for `types=provider` would tell a client that
providers are searchable.

## 3. Response

```jsonc
{
  "data": {
    "query": "aircon",
    "expandedTerms": ["aircon", "air conditioning", "air-con", "airconditioning", "ac"],
    "total": 4,
    "counts": { "category": 1, "subcategory": 1, "service": 2 },
    "hits": [
      {
        "ref": "service:20",
        "type": "service",
        "id": 20,
        "name": "Air Conditioning Cleaning",
        "slug": "aircon-cleaning",
        "context": "Home Services › Appliance Care",
        "bookable": true,
        "status": "active",
        "basePrice": 900,
        "categoryId": 5,
        "subcategoryId": 9,
        "score": 3,
        "matchedTerm": "air conditioning"
      }
    ]
  }
}
```

**Every hit carries a `ref`.** A result set mixing three entity types cannot be
keyed on `id` alone — `3` could be a Category, a Subcategory or a Service. The
client must not have to infer the type from which array a row arrived in,
because in a ranked list there is only one array.

`total` is the true match count; `hits` is the page. `counts` breaks the total
down by type and is independent of `limit`, so a client can render "4 services,
1 category" without another request.

`expandedTerms` and `matchedTerm` exist so a surprising hit is **explainable**.
Somebody asking "why did searching aircon return that?" can see the alias that
did it, rather than filing a bug against ranking.

## 4. Ranking

A deterministic ladder, highest first:

| Score | Rule |
|---|---|
| 4 | exact name match |
| 3 | name starts with the term |
| 2 | a word inside the name starts with the term |
| 1 | the term appears anywhere in name, description, or parent names |

Ties break on **entity type** (Service → Subcategory → Category), then
`displayOrder`, then name. Deterministic all the way down: two identical queries
never return two different orders.

Service outranks its container at equal score because somebody typing "facial"
wants to book a facial, not to browse the category that contains facials.

### Why not Postgres full-text search

`to_tsvector` brings stemming, dictionaries and a per-language configuration
that has to be chosen and maintained. The catalog is 3 categories, 12
subcategories and 95 services of Philippine consumer-service names. A ladder
over 110 rows is faster to run, far easier to explain to somebody staring at a
wrong result, and does not change behaviour when a Postgres upgrade changes a
dictionary.

That trade flips if the catalog reaches thousands of rows. It is written down
here so the decision gets revisited on evidence rather than inherited.

## 5. Aliases — widening what a term MATCHES, never what EXISTS

"aircon" must find "Air Conditioning Cleaning". "masahe" must find "Swedish
Massage".

The wrong fix is a Service row per synonym. §30 forbids it, and it would make
one real-world service bookable under two canonical ids — the exact ambiguity
Catalog V2 exists to remove.

Aliases live in
[`catalogSearchService.SEARCH_ALIASES`](../../src/services/catalogSearchService.ts)
as a **query-expansion table**. Matching any member of a group pulls in the
whole group, which makes the relation symmetric: "masahe" finds "massage" and
"massage" finds "masahe".

**A search for "aircon" and a search for "air conditioning" return the same
Services with the same ids.** That is asserted directly, because a test that
only checked "aircon returns results" would pass on the wrong implementation.

### Whole-word matching, and why

Alias matching is **whole-word**, not substring.

The first implementation used `includes` in both directions. The alias `ac` — a
perfectly reasonable way to write "aircon" — is a substring of "f**ac**ial**, so
searching "facial" expanded into the entire air-conditioning group and returned
"Air Conditioning Cleaning" above half the facial results. A test caught it.

The vocabulary was not the problem; the matching rule was. Whole-word keeps
"ac cleaning" working and stops "facial" reaching it.

### Why the table is in code

It is product copy about how Filipinos say things, it changes when somebody
notices a miss, and it belongs in review beside the code that uses it. A
`catalog_search_aliases` table would move it out of review and into an admin
screen nobody would open.

## 6. Visibility

Only `active` rows, at **all three levels**. A Service whose Subcategory is
deactivated is not findable, because it is not bookable — returning it would
produce a search result that dead-ends.

This matches browse exactly. Search and browse disagreeing about what exists is
its own class of bug.

## 7. What search will never return

- A provider, a booking, a customer or an address. It is a **catalog** search.
- A `service_families` row. The legacy coarse family is provenance, not a
  bookable thing, and the search service never queries that table.
- A `level2` or `level3` field.
- A duplicate `ref`. An alias expansion that added a hit per matched term
  instead of scoring once would return the same Service several times; a test
  asserts refs are unique across a result set.

## 8. Limits, stated plainly

- **No pagination.** `limit` caps the page and `total` reports the truth, but
  there is no offset. At 110 rows nobody needs page two; add it when the catalog
  grows, not before.
- **No typo tolerance.** "facal" finds nothing. Fuzzy matching needs a distance
  threshold tuned against real queries, and there are no real queries yet
  because there has never been a server-side search to log.
- **No ranking by popularity.** Nothing records what people search for or book
  from a search. That is the first thing to add once this endpoint is serving.
- **No per-query telemetry yet.** Volume is counted through the standard v1
  route observability; the search **terms** are not logged. Logging them is a
  privacy decision, not an oversight, and it should be made deliberately.
