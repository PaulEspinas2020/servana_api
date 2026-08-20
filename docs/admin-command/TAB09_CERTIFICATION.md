# TAB 09 — Make the request id joinable to a log line (P1)

## Verdict

```
THE ID NOW JOINS TO SOMETHING                    CERTIFIED_WITH_INFRA_GAP

Ask 2  id on every response, not only errors     ALREADY TRUE  — proven
Ask 3  id stamped on the legacy /api/admin tree  ALREADY TRUE  — proven
Ask 1  a lock the id opens                       HALF ALREADY EXISTED, undocumented
       ...and on the admin tree it was BROKEN    FIXED

Admin error ids that matched no log line   ALL of them  ->  none
```

## The defect this TAB found

The book asks for a log sink. Before answering that, the id itself had to be
checked — and on the admin tree it was **worse than "a token with no lock"**.

`helpers/adminError` takes only `res`, has no `req`, and did this:

```ts
const requestId = randomUUID();
res.setHeader('x-request-id', requestId);
```

`correlationMiddleware` runs `app.use`d ahead of every router and had already
stamped the **real** correlation id on that response. The structured request log
emits that id. `auditFire` records that id in `admin_audit_events.request_id`.
This helper overwrote it a moment before the body was sent.

**So every legacy admin error handed the operator a number that appears nowhere
else in the system.** Searching for it finds nothing — not because the log is
missing, but because the id never existed anywhere but on that screen. Across
251 admin operations, and nothing said so.

Fixed by reading the id back off the response, where the middleware already put
it. **No call site changed**, which mattered: there are a great many of them.

## Ask 1 — there was already a lock, and nobody had written it down

> An operator can now read out `req_01J9ZK…`; nobody can currently turn it into
> the server log line that explains the failure. Until then the id is a token
> with no lock.

Measured: `admin_audit_events.request_id` is a real column, `recordAuditEvent`
writes it, `findEvents` filters on it in SQL, and the admin route exposes it:

```
GET /api/admin/audit-logs?request_id=<the id>
```

That answers *what did this action do* — actor, outcome, before/after state,
changed fields, reason — **through the API**, needing a token and a permission
rather than a shell. It covers approvals, rejections, assignments, permission
changes, refund decisions and catalog publishes: the actions an operator is
normally asked about.

The predicate is asserted against the **production statement builder**, with a
mocked driver capturing the real SQL — not against a re-implementation.
`tests/admin-audit.test.js` re-implements pure logic inline "to avoid needing a
TS transform", and a test that reassembles a predicate can be wider or narrower
than the one that runs. Both halves are asserted: that the clause appears when a
request id is given, and that it does **not** when one is not — a filter that
always applies is not a filter.

## Asks 2 and 3 — already true, now proven

**Ask 2, "the id on *every* response, not only errors."** `correlationMiddleware`
does `res.set(CORRELATION.header, …)` unconditionally, on the request path, not
the error path.

**Ask 3, "confirm the id is stamped on the legacy `/api/admin/*` tree."** True
for a structural reason: the middleware is mounted at the app level ahead of
every router, so it cannot know which tree a path belongs to. Asserted against a
legacy admin path specifically — *"it applies everywhere"* is exactly the claim
that turns out to have an exception — and separately by checking the **mount
order** in `app.ts`, because if the middleware ever moved below a router, that
router's responses would lose the header while every direct test still passed.

Inbound adoption is proven too: a well-formed `x-request-id` or
`x-correlation-id` is adopted, and a malformed one is **refused** rather than
echoed. Adopting anything a caller sends makes the id a log-injection vector and
an unbounded cardinality label on every metric.

## A detector of mine was wrong, and the app was right

The mount-order check first matched `app.use(cors(` and failed — on
`app.use(cors(corsOptionsDelegate))`, the **global** cors policy, which mounts no
router at all. The detector was wrong, not the app. It now matches
path-prefixed mounts, and requires more than ten of them so it cannot pass by
finding none.

## Breaking my own fix taught the more important lesson

The correlation lookup called `res.getHeader(...)` directly. Against a response
double that only implemented `setHeader`, it threw — and because this function
runs **while building an error response**, the throw did not degrade the
message. It replaced a clean 403 with an unhandled exception:
`tests/authz-negative` turned **148 assertions from `403` into `0`**.

**A formatter on the failure path must not be able to fail.** Reading a header is
never worth a crash. It is now defensive about the accessor existing, about it
throwing, and about it returning a non-string — each pinned by a test, and none
of them is a test accommodation: they are the states a real `res` can be in.

## What is still open, stated plainly

**A queryable sink for failures that are not audited actions.** A 500 on a read,
a validation refusal, a timeout — these exist only as a `console.info` line on
stdout, captured by PM2 to a file on the host. Greppable with a shell; not
queryable by anyone else, and it rotates.

Closing that is **infrastructure**, not code: a log sink, its retention decision
and its access model. It is outside what a backend change can deliver, and
pretending otherwise would be the "foundation without callers" mistake in a
different costume.

What *has* changed is that the gap is now precisely bounded. An audited action is
traceable through the API by anyone with the permission; an unaudited failure is
traceable only with host access; and a `local-` prefixed id means the request
never reached the server at all and there is nothing to find.

`docs/OPERATOR_REQUEST_ID_LOOKUP.md` is the operator-facing half — which kind of
id it is, which lock to try, and the limitation of each.

## Negative control

```
Restore randomUUID() in adminError
  → 2 tests fail: "reports the correlation id the middleware stamped"
                  "does not mint a fresh id over an existing one"
Restore the fix → 23 passed, 23 total
```

## Deliverables

| File | What changed |
| --- | --- |
| `src/helpers/adminError.ts` | Reuses the correlation id; cannot throw while formatting an error |
| `docs/OPERATOR_REQUEST_ID_LOOKUP.md` | Which lock to try, and what each cannot answer |
| `tests/request-id-joinable.test.ts` | 23 assertions across all three asks, plus the formatter's robustness |

## Acceptance, against the book's own criteria

| Book's criterion | Status |
| --- | --- |
| A log sink where the id can be looked up | ⚠️ audited actions: yes, via `GET /api/admin/audit-logs?request_id=`, and it already existed. Unaudited failures: still host-only — infrastructure work |
| The id on *every* response, not only errors | ✅ already true, now proven |
| Correlation across the admin surface | ✅ already true — **and the admin error envelope was reporting a fabricated id, which is fixed** |
| Do not treat a `local-` id as a missing log entry | ✅ documented as the first question an operator asks |

## Gate

```
npm run verify → Test Suites: 325 passed, 325 total
                 Tests:       6754 passed, 6754 total
                 EXIT=0
```

---
Servana Backend — Admin API Master Command · TAB 09
