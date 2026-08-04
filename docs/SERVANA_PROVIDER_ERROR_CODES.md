# Servana provider API — error contract

**Command 3 §15 deliverable.** Records the eight error shapes in production
today, defines the one that replaces them, and states the migration.

## The problem, measured

There is **no canonical error envelope**. Eight structurally distinct failure
bodies are emitted across roughly **494** 4xx/5xx `.status(...)` sites, and
several controllers emit two of them in the same file.

| # | Shape | Occurrences |
|---|---|---|
| 1 | `{success: false, message}` | 221 |
| 2 | `{status: "failed", message}` | 285 |
| 3 | `{status: 'error', error: {code, message, kind, requestId}}` | 213 (adminError family) |
| 4 | `{error: CODE, message?}` | 13 |
| 5 | `{success: false, error: {code?, message}}` | 6 |
| 6 | `{success: false, code, message}` | ~7 |
| 7 | `{status: "failed", code, message}` | ~7 |
| 8 | `{status: 'error', message}` — flat, from express-rate-limit | 6 |

**No client can write one parser.** A client discriminating on
`success === false` misses 285 `status:"failed"` sites and all 213 admin sites.
One discriminating on `status === 'error'` hits both shape 3 and shape 8.

### The sharpest edge

Shapes 3 and 8 share the discriminator `status: 'error'` and have incompatible
layouts. `adminError()` nests the message inside `error`; express-rate-limit puts
it flat and provides no `error` object at all.

**A client that branches on `status === 'error'` and reads `body.error.code`
throws on every 429.** Rate limiting is exactly when a client is least able to
afford an unhandled exception, because it is already retrying.

There is also **no central error handler** — every controller hand-rolls its
response, which is why eight shapes could coexist without anyone choosing them.

## The canonical envelope

```json
{
  "status": "error",
  "error": {
    "code": "BOOKING_INVALID_TRANSITION",
    "message": "This booking cannot move to that status.",
    "fieldErrors": {},
    "retryable": false,
    "requestId": "req_01HTZ..."
  }
}
```

- `code` is the only thing a client may branch on. Messages are for humans and
  may be reworded at any time without a version bump.
- `message` is safe to display: never a SQL error, constraint name, stack trace,
  storage key, or upstream provider body.
- `fieldErrors` maps a form field to its message. Empty object, never null.
- `retryable` must be accurate. A client that retries a non-retryable error
  hammers a failing system; one that gives up on a retryable error loses work.
- `requestId` correlates the response with the server log.

## Canonical codes

| Code | HTTP | Retryable | Meaning |
|---|---:|---|---|
| `UNAUTHENTICATED` | 401 | no | No credential, or it did not verify |
| `SESSION_EXPIRED` | 401 | no | Token expired; refresh and retry once |
| `ROLE_FORBIDDEN` | 403 | no | Authenticated, wrong role |
| `PROVIDER_NOT_APPROVED` | 403 | no | Account exists but is not approved to work |
| `PROVIDER_SUSPENDED` | 403 | no | Approval withdrawn |
| `OWNERSHIP_DENIED` | 403 | no | Real record, not the caller's |
| `NOT_FOUND` | 404 | no | No such record, or none the caller may see |
| `INVALID_REQUEST` | 400 | no | Malformed — bad id, missing parameter |
| `VALIDATION_FAILED` | 422 | no | Well-formed but rejected; see `fieldErrors` |
| `INVALID_TRANSITION` | 409 | no | Not reachable from the current state |
| `CONFLICT` | 409 | no | Record changed underneath the caller |
| `DUPLICATE_REQUEST` | 409 | no | Idempotency key replayed with a different body |
| `RATE_LIMITED` | 429 | **yes** | Back off and retry |
| `UPSTREAM_UNAVAILABLE` | 503 | **yes** | PayMongo, Firebase, Mongo |
| `MAINTENANCE` | 503 | **yes** | Planned |
| `INTERNAL_ERROR` | 500 | **yes** | Unclassified |

`OWNERSHIP_DENIED` vs `NOT_FOUND` is a deliberate decision, not a detail: booking
ids are sequential integers, so answering "403, that exists but is not yours"
confirms existence to an enumerator. **Prefer `NOT_FOUND` for any record the
caller may not see.** Reserve `OWNERSHIP_DENIED` for cases where the caller
demonstrably knows the record exists — a booking they were unassigned from, say.

## Migration

This cannot be a flag day: ~494 sites, three shipped clients, and two of those
clients are mobile apps that live in the field for months.

1. **Add, do not replace.** Emit the canonical `error` object *alongside* the
   existing keys. `{success: false, message, status: 'error', error: {...}}`
   satisfies old and new parsers at once.
2. **Fix shape 8 first.** The rate-limit body is the only one that actively
   throws in a client. It is six call sites and needs no client change.
3. **Teach clients to prefer `error.code`** and fall back to their current
   discriminator. Ship. Wait for adoption.
4. **Introduce a central error handler**, so new controllers cannot invent a
   ninth shape.
5. **Remove the legacy keys** only once telemetry shows no client reading them.

Until step 5, a client must treat a missing `error.code` as `INTERNAL_ERROR`
rather than as a parse failure.

## Client mapping

`ServanaWorker` has an `ApiFailure` taxonomy of 12 kinds and switches on `kind`,
not on the HTTP status — the right shape. Once `error.code` is universal, that
taxonomy should map from the code rather than inferring from status plus message
text. **Message-text matching must not be introduced anywhere**; it breaks on
the first copy edit and does so silently.
