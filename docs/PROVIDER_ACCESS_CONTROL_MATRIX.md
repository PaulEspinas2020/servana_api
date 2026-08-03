# Provider access control matrix

**Command 4 §25 deliverable.** Default is **deny**. A cell is permitted only
where stated, and only through the guard named.

## Roles

| Role | Meaning |
|---|---|
| `applicant` | Account exists, not approved to work |
| `approved` | Approved provider — the normal operating role |
| `suspended` | Approval withdrawn; retains read access to their own record only |
| `rejected` / `disabled` | Terminal; no operational access |
| `admin` | `role IN (0, 1)`, checked by a database read |
| `customer` | The other side of a booking |

**Role is never on the token.** `req.user` is the raw Firebase `DecodedIdToken`;
`verifyRoles` performs a separate `SELECT "role" FROM user_credentials`. No
Firebase custom claims are set anywhere.

## Guards in force

| Guard | Enforces |
|---|---|
| `verifyAuth` | A valid Firebase token; populates `req.user` |
| `verifyRoles([...])` | Role, via a DB read |
| `verifyOwnership` | `req.user.uid === req.params.uid` — fails closed |
| `assertBookingAccess` | Caller is the booking's customer, its active provider, or admin |
| `resolveAccessForConversation` | Participation, derived from the booking |
| SQL scoping | `WHERE worker_uid = $1` inside the query |

`requireActiveProvider` **is now implemented** (`middleware/requireActiveProvider.ts`)
and applied to the nine operational routes — booking lifecycle, location,
go-online, payout. It fails closed on an unknown status, a missing row, or a
database error.

It is deliberately NOT applied to a provider reading their own profile,
documents or support tickets: a suspended provider needs to see why and upload
what fixes it, and locking them out would make suspension unrecoverable.

`requireBranchMembership` and `requireServiceEligibility` remain unimplemented —
branch membership was never modelled, and eligibility is computed inside the
job-matching query rather than as a guard.

## Matrix

**Y** = permitted · **—** = denied · **own** = only their own record

| Resource | applicant | approved | suspended | admin | Guard |
|---|---|---|---|---|---|
| **Own profile** — read | own | own | own | Y | token uid |
| **Own profile** — update | own | own | own | Y | token uid |
| **Another provider's profile** | — | — | — | Y | audience projection |
| **Job cards** — list | — | own | — | Y | `GET /worker/job-cards`, token-scoped |
| **Booking** — accept / decline | — | own | — | — | SQL `worker_uid = $1 AND status = 'ASSIGNED'` |
| **Booking** — en route / arrived | — | own | — | — | SQL, guarded transition |
| **Booking** — start / complete | — | own | — | — | SQL, guarded transition |
| **Booking** — reassigned away | — | — | — | Y | row no longer matches |
| **Provider location** — write | — | own | own | — | `POST /worker/location`, token uid |
| **Provider location** — read | — | own | — | Y | `GET /booking/:id/provider-location` + `assertBookingAccess` |
| **Conversation** — read | — | participant | participant | Y | `resolveAccessForConversation` |
| **Conversation** — send | — | participant | — | Y | participation |
| **Message** — edit / delete | — | author | — | Y | authorship |
| **Conversation** — close | — | participant | — | Y | participation; customer denied |
| **Notifications** — read / mark | — | own | own | Y | token uid |
| **Earnings** — summary / list / detail | — | own | own | Y | SQL `worker_uid = $1` |
| **Withdrawal** — request | — | own | **—** | Y | payout ownership |
| **Bank account** — read / write | — | own | own | Y | `verifyOwnership` |
| **Documents** — upload / delete | own | own | own | Y | token uid |
| **Service application** — submit | own | own | — | Y | token uid |
| **Availability / time-off** | — | own | own | Y | `/worker/*`, token-scoped |
| **Service area** | — | own | own | Y | token-scoped |
| **Provider directory** | — | — | — | Y | `adminOnly` |
| **Available-job pool** | — | eligible | — | Y | backend eligibility |
| **Support ticket** | own | own | own | Y | participation |

### Notes on specific cells

- **Suspended keeps read access to their own record.** They need to see why, and
  to fix documents. They lose every operational action, and withdrawal, because
  a suspension often exists precisely to hold funds.
- **Reassignment revokes by construction.** Every provider query carries
  `worker_uid = $1`; once the assignment row moves, the booking stops matching.
  Nothing has to be actively revoked.
- **Provider location is booking-scoped, not provider-scoped.** The question is
  *"where is the provider on my booking"*, and it cannot be phrased about an
  arbitrary provider. That re-framing is what allowed the unauthenticated
  `/workers/location/:uid` to be deleted.

## Known gaps

| Gap | Effect | Status |
|---|---|---|
| ~~No provider-status guard~~ | ~~Suspension was client-side only~~ | **CLOSED** — `requireActiveProvider` on 9 operational routes |
| No `availableActions` | Clients infer permission from status labels | Open; UX defect, not a hole |
| Branch membership unmodelled | Branch rows exist; no membership model was traced | Open |
| No idempotency keys | Replays return failure rather than the original success | Open |

Branch membership is now the most consequential remaining gap: branch ids exist
on bookings and in the catalog, but no provider-to-branch membership model was
traced, so `requireBranchMembership` cannot be written against anything.
