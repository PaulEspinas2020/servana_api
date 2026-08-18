# TAB 05 — the API's security baseline

> **Closes F-06 and F-07 (both P1).** Implemented 2026-08-18 against `servana_api` at `37d9a7f`.

---

## 1. Measured before, measured after

| Control | Before | After |
| --- | --- | --- |
| `helmet` or equivalent | **absent** — not a dependency | `helmet@8.3.0`, every option set explicitly |
| HSTS | absent | `max-age=31536000; includeSubDomains` (no `preload` — see D2) |
| `X-Content-Type-Options` | absent | `nosniff` |
| `Referrer-Policy` | absent | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | absent | `DENY` |
| `Cross-Origin-Resource-Policy` | absent | **`cross-origin`, deliberately** — see D1 |
| CSP on the one HTML page | absent | hash-based, computed from the page itself |
| Rate limiting — 251 admin routes | **absent** | three tiers, keyed on the admin uid |
| `x-powered-by`, `trust proxy`, CORS whitelist, request correlation | present | unchanged |

## 2. Decisions taken autonomously

**D1 — `crossOriginResourcePolicy: 'cross-origin'`, and this is the §4 break the
book warns about.** `helmet()` with no arguments was run against this Express
version and its headers captured before anything was written. Its default is
`same-origin`, which refuses cross-origin fetches of provider documents and
catalog banners from all five consumers — two of them installed mobile builds
that **cannot be re-released to work around a response header**. The browser
reports such a refusal as a network failure, not as a policy decision, so it
would have read as "the API is down". Measured, not assumed.

**D2 — HSTS without `preload`.** `preload` asks browser vendors to hard-code the
domain into a shipped list; removal takes months to reach everyone who already
has it. That is a decision for whoever owns the domain, made once and knowingly
— not a side effect of a security-headers commit. The header is fully effective
without it after a visitor's first request.

**D3 — every helmet option set explicitly, including the ones matching the
default.** Relying on a default is a bet that the next major will not change it.
A few extra lines turn a future silent behaviour change into a visible diff.

**D4 — CSP off for the API, on for the one page that is HTML.** The received
advice is `contentSecurityPolicy: false` for an API and it is *nearly* right
here. This API serves exactly one HTML document — the Google Play data-deletion
page a reviewer opens in a browser — so a blanket `false` would leave the only
framable, script-capable surface with no policy at all.

**D5 — the page CSP uses computed hashes, not `'unsafe-inline'` and not a pasted
literal.** The page has one inline `<script>` and one inline `<style>`.
`'unsafe-inline'` would permit both and every script an injection introduces. A
pasted `sha256-…` would be correct until somebody edits a line, and then the
page silently stops working *for the one visitor it exists for*. The hashes are
derived from the very string being served, so the policy and the document cannot
disagree. A test asserts that editing the script changes the hash.

**D6 — admin limits keyed on the actor, not the IP.** Every admin reaches this
API through the same nginx hop, so an IP-keyed budget puts the whole operations
team in one bucket: the busiest admin throttles everyone else and the limit
reads as an outage. Keying on the uid gives each admin their own budget and
makes the counter mean *"this account is behaving oddly"*.

**D7 — the limiter sits INSIDE `adminOnly`, after `verifyAuth`.** This is the
subtle half, and it is why the test asserts position and not merely presence. A
limiter mounted app-level on `/api/admin` runs **before** `verifyAuth`, sees no
`req.user`, and silently falls back to the IP — producing a limiter that returns
429s, looks like it works, throttles the team as a group, and catches no
individual. Correct-looking and useless.

**D8 — three tiers, and sensitive is matched by PREFIX.** A single budget must
be loose enough for the busiest read screen, which makes it far too loose for a
payout. `ADMIN_SENSITIVE_PREFIXES` matches by prefix so a *new* payout or
permission route is throttled the day it is added — the question a new route has
to answer is "why is this NOT sensitive".

**D9 — the 429 body names no budget, window or bucket (§21).** "You have made 61
of 60 requests in this 60s window" tells an attacker exactly how hard to push and
how long to wait, and tells a legitimate admin nothing they can act on. It emits
both error layouts via `helpers/rateLimitBody`, so neither an already-shipped
client nor a canonical one throws while retrying.

**D10 — one policy module, two bucket sets.** `ADMIN_BUCKETS` lives in
`src/api/v1/rateLimitPolicy.ts` per §10, but as a *separate export* from
`BUCKETS`: `BUCKETS` renders into `AUTH_V1_CONTRACT.md` §8, a table about
credential endpoints, and an admin-throttle row there would be a true fact in a
misleading place.

## 3. What the coverage test found that reading did not

Wiring by file glob (`admin*.routes.ts`) looked complete and was not. The
derived test — every `/api/admin` route's expanded chain must contain the
limiter — found **three** classes of miss:

1. **`providerCatalog.routes.ts`** — 28 admin routes under
   `/api/admin/provider-catalog/*` composed with inline guards and no
   `adminOnly` array, in a file whose name does not begin with `admin`.
2. **`GET /api/admin/me/permissions`** — `verifyAuth` only by design (every
   admin may read their own grants, so there is no permission to demand). Still
   an authenticated admin endpoint, so still throttled.
3. **`POST /api/admin/admin-users/bootstrap-super-admin`** — `verifyAuth` only,
   and it grants **super admin to its first caller**. Worse, its path is
   `/api/admin/admin-users`, which is *not* `/api/admin/users` — so even once
   covered it landed on the ordinary mutation tier. `/api/admin/admin-users` is
   now a sensitive prefix. **This was found by the test, not by reading**, and
   it is the single most valuable thing in this TAB.

Also `GET /api/admin/provider/reconciliation` (in `provider.routes.ts`) and
`PATCH /api/admin/workers/:uid/archive` (in `technician.routes.ts`) — two of the
orphan routes TAB 09 will classify, both now throttled.

### 3.1 A bug in the checker, recorded rather than quietly fixed

The first version of the chain expander used `\[([^\]]*)\]`, which stops at the
first `]` — and the chain it had to read is
`[verifyAuth, verifyRoles([1]), adminRateLimit]`, whose first `]` is inside
`verifyRoles([1])`. It truncated every chain before the limiter and reported
**500 routes as unprotected**.

Recorded because the failure mode is the one this suite exists to prevent, in
mirror image: a check that is wrong in the *alarming* direction still has to be
fixed at the parser, never by relaxing the expectation. Depth counting is what
makes the answer independent of what a handler expression happens to contain.

## 4. Three existing tests were made robust, not weakened

`admin-provider360`, `admin-guest` and `admin-permissions` asserted the guard
chain by **exact literal text** — `toContain('const adminOnly = [verifyAuth,
verifyRoles([1])]')`. Adding the limiter broke all three while every guard they
protect was still present.

They now assert *containment* of the required guards, parsed bracket-aware. The
`/admin/me/permissions` test now asserts the real property — `verifyAuth`
present, `requirePermission` **absent** — instead of a token sequence. A
text-equality assertion on a middleware array fails on every legitimate
addition, which trains people to edit the test rather than read it.

## 5. Gates

```
npm run verify                    PASS exit 0 — 285 suites, 6054 tests
npm run guard:protected-contracts PASS exit 0 — no published surface moved
npm run authz:legacy              PASS exit 0 — 0 loosenings
tests/admin-security-baseline.test.ts        25 tests
```

Headers asserted over a **real socket**, including on a 500 response — the
headers that say how to treat the bytes matter most when the bytes are
unexpected. The 429 is asserted by actually exhausting the sensitive budget, not
by inspecting configuration.

**Mutation-verified:**

```
MUTATION  remove adminRateLimit from one route file's adminOnly chain
          → 2 failed

MUTATION  move adminRateLimit BEFORE verifyAuth — the silent-collapse defect,
          which still returns 429s and still looks correct
          → 1 failed
```

Both reverted; 25/25 green.

## 6. What could NOT be done here

| Book step | State | Why |
| --- | --- | --- |
| Confirm nginx neither strips nor duplicates the new headers; align `client_max_body_size` with the 10mb Express limit | **NOT DONE** | `PROD-ACCESS`. A 413 from nginx carries no CORS headers and reaches a client as an unexplained network error. Manual task 05.1. |
| Set limits from **measured p99 admin traffic**, ship log-only for a business day, then enforce | **NOT DONE** | `PROD-ACCESS`. Manual task 05.2. |
| Verify provider-document and catalog-banner flows still fetch from all five consumers | **NOT DONE** | `NO-REPO`. The CORP decision is the one change here that *could* break them, which is why it is explicit rather than defaulted. Manual task 05.3. |
| `curl -sI https://api.servana.com.ph/healthz` | **NOT DONE** | `PROD-ACCESS`. |

**The numbers are starting values, chosen from the shape of the work rather than
from measured traffic, and they are labelled as such in the source.**
`ADMIN_RATE_LIMIT_LOG_ONLY=true` counts and logs without refusing anything —
because the rollback for a rate limit is not "revert the commit", it is "watch it
for a business day first". A limit that fires on legitimate operations work gets
removed wholesale rather than tuned, and then there is no limit at all.
