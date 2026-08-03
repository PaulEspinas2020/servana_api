# Servana provider action matrix

**Command 3 §8 deliverable.** Defines the server-authorized action model, and
records honestly which parts exist today and which do not.

## Status today

**`availableActions` is not implemented.** No provider-facing endpoint returns
it. Both clients currently infer what a provider may do from status labels, which
is exactly what §8 forbids — and it is why the two clients disagree about, for
example, whether a job can be started.

What *does* exist is the enforcement underneath: the provider lifecycle is
guarded in SQL, so an unauthorized action fails safely even though the client had
to guess it was available. Client-side inference is therefore a **UX defect**
(buttons that do nothing, or missing buttons) rather than a security hole.

That distinction sets the priority: this is worth building, and it is not urgent
in the way an unguarded mutation would be.

## The contract

Every booking-detail response carries the actions the caller may take **on that
booking, right now**:

```json
{
  "availableActions": [
    {
      "action": "START_WORK",
      "enabled": false,
      "disabledReason": "AWAITING_ACCEPTANCE",
      "requiresConfirmation": false,
      "requiresReason": false,
      "requiresEvidence": false,
      "idempotent": true
    }
  ]
}
```

- **The backend decides eligibility.** The client renders what it is given.
- **Disabled is not hidden.** An action the provider could take later appears
  disabled with a reason code, so the UI can explain rather than mystify. An
  action they can never take is omitted entirely.
- **`disabledReason` is a code, not prose** — clients localise it.
- **Every mutation is revalidated at execution.** The list is a hint about the
  present, and the present can change between render and tap.

## Actions

Grouped by the transition they drive. **Supported** means the backend route
exists today.

| Action | Route | Supported | Guarded by |
|---|---|---|---|
| `ACCEPT_BOOKING` | `PUT /api/worker/bookings/:id/accept` | yes | `status = 'ASSIGNED'` |
| `DECLINE_BOOKING` | `PUT /api/worker/bookings/:id/decline` | yes | `status = 'ASSIGNED'` |
| `START_WORK` | `PUT /api/worker/bookings/:id/start` | yes | `status = 'ACCEPTED'` |
| `COMPLETE_WORK` | `PUT /api/worker/bookings/:id/complete` | yes | `status = 'IN_PROGRESS'` |
| `VERIFY_CODE` | `?workerCode=` on start | yes | arrival code, passed to `startJob` |
| `MESSAGE_CUSTOMER` | `POST /api/chat/conversations/:id/messages` | yes | conversation participation |
| `RESPOND_ADDITIONAL_WORK` | `POST /api/additional/:id/worker-decision` | yes | — |
| `REQUEST_ADDITIONAL_WORK` | `POST /api/worker/additional-work/*` | yes | — |
| `REPORT_INCIDENT` | `POST /api/provider/safety/incidents` | yes | — |
| `SAFETY_CHECK_IN` | `POST /api/provider/safety/check-in` | yes | — |
| `CONTACT_SUPPORT` | `POST /api/provider/support/tickets` | yes | — |
| `MARK_EN_ROUTE` | `PUT /api/worker/bookings/:id/en-route` | yes | `status = 'ACCEPTED'` |
| `MARK_ARRIVED` | `PUT /api/worker/bookings/:id/arrived` | yes | `status = 'EN_ROUTE'` |
| **`PAUSE_WORK` / `RESUME_WORK`** | — | **NO ROUTE** | no `PAUSED` status exists |
| **`COLLECT_CASH`** | payment routes exist | partial | not modelled as a provider action |
| **`REQUEST_RESCHEDULE`** | — | **NO ROUTE** | no reschedule status exists |
| **`OPEN_DISPUTE`** | — | **NO ROUTE** | no dispute status exists |
| **`REPORT_NO_SHOW`** | — | **NO ROUTE** | — |

Seven of the actions the command enumerates have **no backend at all**. Building
UI for them would produce buttons that cannot work. `MARK_EN_ROUTE` and
`MARK_ARRIVED` are the most consequential: arrival tracking is table stakes for a
field-worker product, and today the platform cannot express it.

## Disabled reason codes

| Code | Meaning |
|---|---|
| `AWAITING_ACCEPTANCE` | Accept the job first |
| `NOT_STARTED` | Start work first |
| `ALREADY_COMPLETED` | Terminal |
| `BOOKING_CANCELLED` | Terminal |
| `NOT_ASSIGNED_TO_YOU` | Reassigned while the screen was open |
| `PROVIDER_NOT_APPROVED` | Account not approved to work |
| `PROVIDER_SUSPENDED` | Approval withdrawn |
| `VERIFICATION_REQUIRED` | Arrival code needed first |
| `PAYMENT_REQUIRED` | Customer has not paid |
| `TOO_EARLY` | Outside the arrival window |

## Idempotency

Marked `idempotent: true` where a repeat is safe. The lifecycle guards already
provide this for the four core transitions: a second `accept` matches no row
because the status is no longer `ASSIGNED`, so it changes nothing.

That is idempotent in effect, but it currently returns a **failure** on the
replay. A retry after a timeout — the exact case that matters — therefore looks
like an error to the client even though the first call succeeded. The correct
behaviour is to return the same success for the same accepted request; that
requires an idempotency key and is not implemented.

## Client rules

1. **Render the list. Do not compute it.** No client-side status-to-button map.
2. **An empty list is valid** and means no actions right now.
3. **An unknown action code is ignored silently** — this is how the backend ships
   a new action to already-installed apps.
4. **Never show success before the mutation is confirmed.** No optimistic
   transition on money, completion or verification.
5. **Haptics fire on the confirmed result, never on the tap** — a success
   vibration for a failed completion is worse than none.
