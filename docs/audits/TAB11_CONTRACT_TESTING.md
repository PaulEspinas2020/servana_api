# TAB 11 — making portal↔backend agreement a build failure

> **Closes the backend half of F-13.** Implemented 2026-08-18 against
> `servana_api` at `34f968d`.

---

## 1. The gap, and which half of it lives here

The book is blunt about why this TAB matters most for an integration launch:

> *A test harness can make every route green while production wires none of
> them. The portal's 1373 specs pass against mocks; the backend's tests pass
> against its own fixtures. The integration between them is verified by nobody.*

`scripts/smoke-contracts.mjs` lives in the **portal** and has never run — it
needs `ADMIN_API_BASE_URL` and a scoped CI identity. That half cannot be done
here: the repository is not on this machine and the credential is one this
environment must not hold.

The half that **does** live here is the mechanism the book names for closing the
loop — *generate the portal's expected shapes from the backend's OpenAPI
document, which is itself generated from the contract array* — so that drift
fails at build time in whichever repo drifted.

## 2. What was already covered, and deliberately not rebuilt

Measured before writing anything, because the cheapest way to fail this TAB is
to add a fourth test for something already asserted three times:

| Book requirement | Already covered by |
| --- | --- |
| The canonical `{ status, data, meta }` envelope | `tests/legacy-response-envelope.contract.test.ts` |
| The v1 envelope | `tests/v1-router.test.ts`, `tests/v1-contract.test.ts` |
| Errors leak no SQL, constraint name or stack trace (§21) | `tests/terminal-error-handler.test.ts` |
| Timestamps serialise as strings, never `Date` | `tests/timestamp-is-never-a-date.test.ts` |
| Negative cases 401 / 403 / 404 | `tests/v1-router.test.ts`, `tests/route-health-and-authz.test.ts` |

Five of the book's seven execution points were already satisfied. Adding to them
would have been duplicate reality in test form (§9).

## 3. The gap that was real: the document is generated, but nothing keeps it *generatable*

`docs/api/openapi.v1.json` is regenerated from the contract on every `verify`,
and a drift check asserts it matches. **Nothing asserted it was fit to generate
a client from.**

That distinction is the whole finding. A dangling `$ref`, a 2xx with no schema,
or a duplicated `operationId` breaks **nothing in this repository** — every suite
stays green, the drift check passes because the generated file faithfully
reflects the broken contract — and it breaks the **portal's** code generation, in
another repository, at a time nobody connects to the commit that caused it.

That is the worst shape a defect can have: **silent at the origin, loud
somewhere else, and expensive to trace back.** It is also exactly the failure
mode this TAB exists to prevent, arriving from the opposite direction.

### 3.1 Measured state

```
paths                         90
schemas defined              137
distinct $refs               133
DANGLING $refs                 0
2xx without a response schema  0
```

The document is generatable **today**. `tests/openapi-is-dto-generatable.test.ts`
(11 assertions) is what keeps it so:

- every `$ref` resolves — walked recursively, with a positive control proving
  the walker finds a *nested* ref, because a resolver that only looked one level
  deep would report zero dangling refs on a document full of them;
- every 2xx declares a JSON schema;
- every request body declares one;
- every `operationId` is present and **unique** — duplicates silently collapse
  two DTOs into one in a generator;
- the operation set equals the contract entry set exactly — not "at least",
  because an operation with no entry is a shape the portal would generate a
  client for and then receive a 404 from;
- paths use OpenAPI brace params, never Express colons — a `:bookingId` that
  survives into the document generates a client method with a literal colon in
  the URL, which 404s at runtime rather than failing to build;
- every operation documents at least one failure response, so a generated client
  has a **type** for the unhappy path instead of parsing an untyped body.

**Mutation-verified:** renaming the `Error` schema so live references dangle
fails the gate. Restored; 11/11 green.

## 4. Gates

```
npm run verify   PASS exit 0 — 293 suites, 6198 tests
tests/openapi-is-dto-generatable.test.ts   11 tests
```

It runs inside `verify`, which the release gate runs, which TAB 03 made a
prerequisite of the deploy job. So the backend half is already wired into the
deploy dependency the book asks for.

## 5. What could NOT be done here

| Book step | State | Why |
| --- | --- | --- |
| Provision `ADMIN_API_BASE_URL` and a scoped, rotatable CI admin identity — a real Firebase identity with a known permission set, **not** a super admin, so permission failures are observable rather than bypassed | **NOT DONE** | `NO-CRED`. Manual task 11.1. |
| Run `smoke:contracts` against a non-production environment on every push, and against production read-only on a schedule | **NOT DONE** | `NO-REPO`, `NO-CRED`. Manual task 11.2. |
| Demonstrate a deliberate backend response-shape change failing the **portal** build | **NOT DONE** | `NO-REPO`. Manual task 11.3 — and this is the demonstration that actually proves the loop is closed. |
| Wire the gate into the portal's `verify:release` | **NOT DONE** | `NO-REPO`. Manual task 11.4. |

**The honest headline:** the backend can no longer publish a document the portal
cannot generate from. Whether the portal *does* generate from it, and whether a
shape change is caught there, remains unverified — and that is the half the book
calls the seam a launch fails on.
