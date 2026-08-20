# TAB 08 — Serve the contract, so a stale pin is detectable (P2)

## Verdict

```
THE RUNNING PROCESS CAN NOW BE ASKED WHAT IT IMPLEMENTS        CERTIFIED

Paths serving the contract           0  ->  1   (GET /api/v1/openapi.json)
Responses carrying a digest          0  ->  ALL /api/v1 responses
Digest recipe a client can reproduce none -> stated and asserted
Removing the header                        FAILS the gate  ✔ 114 tests red
```

## What was there before

**Nothing.** Measured, not assumed: no `/openapi` route, no digest header, no
version endpoint. A client's only comparison was against a git checkout —
a statement about a repository, not about a server.

The book states the consequence exactly:

> the portal currently proves its pin matches your **checkout** and can prove
> nothing about the process serving requests.

## What now exists

### 1. `GET /api/v1/openapi.json` — the document, derived not read

It does **not** serve the committed `docs/api/openapi.v1.json`. That file
answers *"what does the repository say?"* — the same question a checkout already
answers, from a different angle.

It serves `buildOpenApiDocument()`, derived from the same `V1_CONTRACT` and
`SCHEMAS` that `register.ts` mounts the routers from. **There is no second copy
that can go stale**, which is the book's third ask — *"so 'the contract the
running process implements' is a thing that can be fetched rather than inferred
from a checkout."*

A test asserts every implemented contract entry appears in the served document,
so the two cannot drift into being separate things to keep in sync.

### 2. `x-contract-sha256` on every `/api/v1` response

The book says the header alone is enough — *"a client can detect staleness with
one cheap request and no parsing"* — so it is set by router-level middleware
**before any handler**, and therefore rides on error responses too. The moment a
client most wants to know whether it is talking to the contract it was built
against is when a call has just failed in a shape it did not expect.

Putting it only on `/openapi.json` would mean fetching 330 kB to learn whether
you needed to.

Asserted on **all 95 endpoints**, by adding one line to the router suite's
per-entry loop rather than writing a separate test that could cover fewer.

### 3. A digest recipe a client can actually reproduce

```
sha256( JSON.stringify(document) )      // no indentation
```

Stated rather than left to be guessed, and asserted three ways: that it matches
the recipe, that it **changes** when the document changes, and that a
parse/stringify round trip is byte-stable — because the client's pinned file is
pretty-printed and will be re-serialised before hashing. If key order did not
survive that, the recipe would be unusable and the gate would be a lie.

It is deliberately **not** the hash of the response body: the v1 envelope carries
a per-request id, so a body hash would differ on every call.

## A design decision reversed mid-implementation

The first version served a **bare** document, on the reasoning that a generator
pointed at the URL should receive a document rather than something to unwrap.

`tests/v1-router` refused it: every implemented entry must answer `{ data }` and
carry no second success signal, across all ninety-five. **The invariant is worth
more than the convenience.** An exception to "every response has this shape" is
how a shape stops being relied upon, and unwrapping `.data` is one line — while
the staleness question, which is what this TAB is actually about, is answered by
the header and never needs this endpoint at all.

The endpoint now answers in the envelope. The reversal is recorded here and in
the source rather than presented as the original plan.

## Authenticated, not public — and why that differs from `health.build`

`health.build` is public, and its own docblock argues why:

> A provenance check that needs a credential can only be run by someone who
> already has one, which is the situation it exists to fix.

**That argument does not transfer.** Build provenance is four fields; a full API
surface is a map of what to attack, and every client that wants it already holds
a token. `auth: 'authenticated'`, asserted, with `health.build` asserted public
in the same test so the distinction is deliberate rather than incidental.

## Two existing gates caught this work, and both were right

Adding one endpoint tripped two invariants nobody had to remember:

```
§137  convergence: "contract entry health.contract is claimed by no capability"
      → a new endpoint must be assigned to a capability, or the client parity
        matrix silently stops describing the whole surface.

      convergence: "declared api/v1/contractDigest, actual api/v1/domains/health"
      → a capability may not name a module none of its endpoints reach.
```

Both were satisfied properly — a `contractDiscovery` capability with a stated
role-split rationale, and a `domainModule` naming the module the endpoint
actually reaches — rather than by relaxing either check. This is what the repo's
own gates buy: a new route cannot be half-added.

## Negative control

```
Remove the digest middleware from register.ts
  → 114 tests fail across the router and digest suites
Restore → 324 suites, 6731 tests, exit 0
```

## What is still NOT closed

**The document is served, but nothing serves it from production yet.** This is a
local change; the endpoint exists in code and is proven by the suite against the
real Express router. Whether production is running a build that contains it is a
deploy question, and deploying is outside this programme's boundary.

Until then the portal's `smoke:contracts` should keep printing its NOT VERIFIED
block. The gap is now closeable rather than closed, and the closing step is one
deploy plus one client change: read the header, compare, and stop diffing 530 kB
of JSON by hand.

## Deliverables

| File | What it is |
| --- | --- |
| `src/api/v1/contractDigest.ts` | Derives, serialises and hashes the document once per process; test seam to reset the memo |
| `src/api/v1/domains/health.ts` | `health.contract` handler, ETag on the digest |
| `src/api/v1/contract.ts` | `GET /openapi.json`, `auth: authenticated` |
| `src/api/v1/register.ts` | Router-level middleware setting the header before any route |
| `src/api/v1/convergence.ts` | `contractDiscovery` capability (§137) |
| `tests/contract-digest.test.ts` | 10 assertions on the digest and the served document |
| `tests/v1-router.test.ts` | Header asserted on every implemented entry |

## Acceptance, against the book's own criteria

| Book's criterion | Status |
| --- | --- |
| Publish the OpenAPI document at a stable, fetchable URL | ✅ `GET /api/v1/openapi.json`, derived from the running contract |
| Return a sha256 of the document in a response header | ✅ on **every** `/api/v1` response, not just that one |
| Version the document alongside the deploy | ✅ inherently — it is derived from the mounted contract, so it cannot lag the code |
| `smoke:contracts` stops printing NOT VERIFIED | ⚠️ needs a deploy; out of this programme's boundary |

## Gate

```
npm run verify → Test Suites: 324 passed, 324 total
                 Tests:       6731 passed, 6731 total
                 EXIT=0
```

---
Servana Backend — Admin API Master Command · TAB 08
