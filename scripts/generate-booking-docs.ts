/**
 * Writes every generated TAB 04 booking document.
 *
 *   docs/booking/BOOKING_STATE_MACHINE.md
 *   docs/booking/BOOKING_ACTOR_PERMISSION_MATRIX.md
 *   docs/booking/BOOKING_STATUS_MIGRATION_MATRIX.md
 *
 * Run: npm run booking:docs        (rewrite)
 *      npm run booking:docs:check  (fail if the committed files are stale)
 *
 * ## Why these are GENERATED and not written
 *
 * A hand-written state machine document is correct on the day it is written and
 * quietly wrong forever after. The whole point of TAB 04 was to make one
 * declaration the single source of truth for lifecycle writes; a prose copy of
 * that declaration which can drift out of step reintroduces exactly the
 * ambiguity the executor removed, with the added hazard of looking
 * authoritative.
 *
 * So every table here is derived by EXECUTING the real declarations —
 * `TRANSITIONS`, `BOOKING_ACTIONS`, `deriveCanonicalState` — never by reading
 * their source or restating them. `tests/booking-docs-generated.test.ts` runs
 * the check, so a machine edit that is not followed by a regenerate fails the
 * gate rather than leaving the documentation describing a lifecycle the backend
 * no longer implements.
 *
 * The status migration matrix in particular is produced by running
 * `deriveCanonicalState` over the full cross-product of legacy statuses. That
 * makes it evidence rather than description: if the mapping changes, the table
 * changes with it, and if a legacy status stops being handled the row showing
 * its fallback moves on its own.
 */

import fs from 'fs';
import path from 'path';

import {
  BOOKING_STATES,
  TERMINAL_STATES,
  STATE_GROUPS,
  TRANSITIONS,
  deriveCanonicalState,
  type BookingState,
  type Actor,
} from '../src/services/booking/canonicalState';
import { BOOKING_ACTIONS } from '../src/services/booking/transitionExecutor';
import {
  ELIGIBILITY_PIPELINE,
  COMMIT_CRITICAL_STAGES,
  PROVIDER_CAPABILITY_SQL,
  CANONICAL_CAPABILITY_TABLE,
  LEGACY_CAPABILITY_TABLES,
  DEFAULT_SERVICE_DURATION_MINS,
  NON_OCCUPYING_STATUSES,
  LEGACY_AUTO_GAP,
} from '../src/services/booking/eligibilityPipeline';
import { CANONICAL_ADOPTION_CRITERIA } from '../src/services/booking/capabilitySource';
import {
  ZERO_CANDIDATE_REASONS,
  BLOCKER_PRECEDENCE,
} from '../src/services/booking/candidateDiagnostics';
import { V1_CONTRACT, V1_PREFIX, type ContractEntry } from '../src/api/v1/contract';
import {
  EXPERIENCE_CAPABILITIES,
  BOOKING_OTP_PURPOSES,
  BOOKING_OTP_PURPOSE_NAMES,
  TRACKING_LOCATION_STATES,
  TRACKING_MAX_HOURS_SINCE_MOVEMENT,
  RESCHEDULE_REQUIRES_PROVIDER_ACCEPTANCE,
  CUSTOMER_RESCHEDULE_NOTICE_HOURS,
  RESCHEDULE_MAX_LEAD_DAYS,
  RESCHEDULABLE_STATES,
  RESCHEDULE_REASONS,
  CANCELLATION_MATRIX,
  DISPUTE_CATEGORIES,
  DISPUTABLE_STATES,
  BOOKING_EXPERIENCE_EVENTS,
  UNEMITTED_EVENTS,
} from '../src/services/booking/experiencePolicy';

const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'booking');

const HEADER = (title: string, extraSources: string[] = []) => `<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-booking-docs.ts, derived from
    src/services/booking/canonicalState.ts   (states, transition whitelist)
    src/services/booking/transitionExecutor.ts (action registry)${
  extraSources.length ? `\n${extraSources.map((s) => `    ${s}`).join('\n')}` : ''}
  Regenerate: npm run booking:docs
-->

# ${title}
`;

const ACTORS: Actor[] = ['customer', 'assigned_provider', 'admin', 'system'];

const ACTOR_LABEL: Record<Actor, string> = {
  customer: 'Customer',
  assigned_provider: 'Assigned provider',
  admin: 'Admin',
  system: 'System',
};

// ─── 1. The state machine ─────────────────────────────────────────────────────

function stateMachineDoc(): string {
  const groupOfState = new Map<string, string>();
  for (const [group, members] of Object.entries(STATE_GROUPS)) {
    for (const m of members as readonly string[]) groupOfState.set(m, group);
  }

  const stateRows = BOOKING_STATES.map((s) => {
    const terminal = (TERMINAL_STATES as readonly string[]).includes(s) ? 'yes' : '—';
    const out = TRANSITIONS.filter((t) => t.from === s && t.to !== s).length;
    const into = TRANSITIONS.filter((t) => t.to === s && t.from !== s).length;
    return `| \`${s}\` | ${groupOfState.get(s) ?? '—'} | ${terminal} | ${into} | ${out} |`;
  }).join('\n');

  const transitionRows = TRANSITIONS.map((t) => {
    const requires = (t.requires ?? []).length
      ? (t.requires as readonly string[]).map((r) => `\`${r}\``).join(', ')
      : '—';
    const actors = t.actors.map((a) => ACTOR_LABEL[a]).join(', ');
    return `| \`${t.from}\` | \`${t.to}\` | \`${t.action}\` | ${actors} | ${requires} |`;
  }).join('\n');

  const actionRows = Object.entries(BOOKING_ACTIONS).map(([name, spec]) => {
    const s = spec as Record<string, unknown>;
    const from = Array.isArray(s.from)
      ? (s.from as string[]).map((f) => `\`${f}\``).join(' ')
      : '_any legal source_';
    const cell = (v: unknown) => (v === undefined ? '—' : `\`${typeof v === 'object' ? JSON.stringify(v) : v}\``);
    return `| \`${name}\` | \`${s.to}\` | ${ACTOR_LABEL[s.actor as Actor]} | ${from} | `
      + `${cell(s.guard)} | ${cell(s.requires)} | ${cell(s.advisoryLock)} | `
      + `${cell(s.targetValidation)} | ${cell(s.sameTarget)} | ${s.eventOnly ? '`yes`' : '—'} |`;
  }).join('\n');

  const noteRows = TRANSITIONS
    .filter((t) => t.note)
    .map((t) => `**\`${t.from}\` → \`${t.to}\` (\`${t.action}\`)**\n\n> ${t.note}\n`)
    .join('\n');

  return `${HEADER('Booking canonical state machine')}
${BOOKING_STATES.length} states, ${TRANSITIONS.length} whitelisted transitions,
${Object.keys(BOOKING_ACTIONS).length} actions. Every lifecycle write in the
backend goes through \`transitionBooking\`; there are no others.

## States

A booking is in exactly one canonical state, and that state is **derived from
the locked database rows inside the transaction**, never read from a request.

| State | Group | Terminal | Ways in | Ways out |
|---|---|---|---|---|
${stateRows}

\`DISPUTED\` outranks everything, including a terminal state: a dispute is
raised precisely because a booking finished wrongly, and it is the live thing
needing attention. It does not undo \`COMPLETED\` — the timeline keeps it.

## Transition whitelist

Keyed on \`(from, to, actor)\`. A transition absent from this table cannot
happen, whatever a caller asks for.

| From | To | Action | Actors | Requires |
|---|---|---|---|---|
${transitionRows}

## Action registry

Callers name an ACTION, never a destination state. A caller that names a
destination can pick any state the machine happens to allow from where the
booking is, and so bypass the business rule that was supposed to get it there.
Naming the action makes the machine decide what it means — including which
guards apply and who may perform it.

| Action | To | Actor | From | Guard | Credential | Advisory lock | Target validation | Same target | Event only |
|---|---|---|---|---|---|---|---|---|---|
${actionRows}

Column meanings:

- **From** — a source restriction narrower than the whitelist. Two actions can
  share a \`(to, actor)\` pair, so without this a decline could be executed as a
  cancellation.
- **Guard** — a named policy consulted inside the transaction. Guards are
  read-only.
- **Credential** — a secret the caller must present, checked in the same
  statement that performs the write.
- **Advisory lock** — \`pg_advisory_xact_lock\`, taken AFTER the booking row
  lock. One order for every producer, so the deadlock cannot form.
- **Target validation** — how hard the assignment target is checked. One
  profile, \`FULL\`: every producer of an assignment, including
  auto-assignment, passes the same hard constraints under the same two locks.
- **Same target** — what happens when the requested target is already the
  current one.
- **Event only** — an administrative event recorded without a state change.

## Notes carried by the machine itself

${noteRows}
## Ordering inside the executor

\`\`\`
 1. idempotency lookup          a retry must not re-run the work
 2. BEGIN
 3. SELECT ... FOR UPDATE       booking row, then assignment rows
 4. derive canonical state      from the locked rows, never the request
 5. expectedState check         optimistic concurrency, inside the lock
 6. authorize actor             from the loaded assignment, never the body
 7. same-target no-op / event-only
 8. from-restriction, then the whitelist
 9. advisory lock               provider-scoped, AFTER the booking row
10. credential, then guard
11. write booking + assignment
12. legacy projections          tracking, timeline event, status
13. append canonical transition SAME transaction
14. record idempotency          SAME transaction
15. COMMIT
16. return; notifications are emitted by the caller AFTER commit
\`\`\`

Steps 3–14 are one transaction. The timeline is inside it deliberately: an
\`UPDATE status; COMMIT; INSERT timeline\` sequence lets operational state
change with no historical evidence, and that gap is exactly where a crash
leaves a booking that moved for no recorded reason.

Notifications are downstream and outside the transaction. Hard rule §45: a
notification failure must not roll back a committed transition.
`;
}

// ─── 2. Actor permission matrix ───────────────────────────────────────────────

function permissionMatrixDoc(): string {
  const actions = Object.keys(BOOKING_ACTIONS);

  const rows = actions.map((name) => {
    const spec = BOOKING_ACTIONS[name as keyof typeof BOOKING_ACTIONS] as Record<string, unknown>;
    const cells = ACTORS.map((a) => (spec.actor === a ? '✅' : '·')).join(' | ');
    return `| \`${name}\` | ${cells} |`;
  }).join('\n');

  const stateRows = BOOKING_STATES.map((state) => {
    const cells = ACTORS.map((actor) => {
      const permitted = TRANSITIONS
        .filter((t) => t.from === state && t.actors.includes(actor))
        .map((t) => t.action);
      const unique = [...new Set(permitted)];
      return unique.length ? unique.map((a) => `\`${a}\``).join(' ') : '·';
    }).join(' | ');
    return `| \`${state}\` | ${cells} |`;
  }).join('\n');

  return `${HEADER('Booking actor / transition permission matrix')}
Who may do what, derived from the same declarations the executor enforces.

An actor is resolved from the authenticated token and, for a provider, from the
**loaded assignment row** — never from an id in a request body. Hard rule §11:
ids are identifiers, not authorization.

## Action ownership

Each action has exactly one actor. \`assigned_provider\` means the provider
currently holding the booking, proven from the locked row.

| Action | ${ACTORS.map((a) => ACTOR_LABEL[a]).join(' | ')} |
|---|${ACTORS.map(() => '---').join('|')}|
${rows}

## What each actor may do from each state

Taken from the transition whitelist, so it includes machine-level transitions
that no action currently exposes.

| State | ${ACTORS.map((a) => ACTOR_LABEL[a]).join(' | ')} |
|---|${ACTORS.map(() => '---').join('|')}|
${stateRows}

## The two authorization failures that are not the same

- \`NOT_AUTHORIZED\` — this actor may never do this, for this booking.
- \`INVALID_TRANSITION\` — this actor may do it, but not from here.

They are kept distinct because collapsing them makes a permission bug and a
sequencing bug indistinguishable in production logs, and only one of the two is
a security matter.
`;
}

// ─── 3. Legacy status migration matrix ────────────────────────────────────────

/**
 * Every legacy value the derivation actually handles, plus one that it does not.
 *
 * The unrecognised value earns its place: the fallback is a deliberate design
 * decision (intake, not an error, so an admin sees the booking rather than it
 * being hidden), and a matrix that omitted it would leave that decision
 * undocumented and free to change unnoticed.
 */
const LEGACY_BOOKING_STATUSES = [
  'PENDING_OTP', 'CONFIRMED', 'PAID', 'WORKER_ASSIGNED', 'COMPLETED',
  'CANCELLED', 'CANCELED', 'REFUNDED', 'FAILED', 'EXPIRED',
  'SOME_UNRECOGNISED_STATUS',
];

const LEGACY_WORKER_STATUSES = [
  null, 'ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS',
  'COMPLETED', 'DECLINED', 'REASSIGNED', 'CANCELLED',
];

function migrationMatrixDoc(): string {
  const header = `| \`bookings.status\` \\ \`booking_workers.status\` | ${LEGACY_WORKER_STATUSES.map((w) => (w === null ? '_none_' : `\`${w}\``)).join(' | ')} |`;
  const sep = `|---|${LEGACY_WORKER_STATUSES.map(() => '---').join('|')}|`;

  const body = LEGACY_BOOKING_STATUSES.map((bs) => {
    const cells = LEGACY_WORKER_STATUSES.map((ws) => {
      const state = deriveCanonicalState({
        bookingStatus: bs,
        workerStatus: ws,
        workerUid: ws === null ? null : 'provider-1',
        hasEscalation: false,
      });
      return `\`${state}\``;
    }).join(' | ');
    return `| \`${bs}\` | ${cells} |`;
  }).join('\n');

  // The worker_uid distinction, which the grid above cannot show.
  const uidRows = ['WORKER_ASSIGNED', 'CONFIRMED', 'PAID'].map((bs) => {
    const withUid = deriveCanonicalState({
      bookingStatus: bs, workerStatus: null, workerUid: 'provider-1', hasEscalation: false,
    });
    const withNull = deriveCanonicalState({
      bookingStatus: bs, workerStatus: null, workerUid: null, hasEscalation: false,
    });
    const withUndef = deriveCanonicalState({
      bookingStatus: bs, workerStatus: null, hasEscalation: false,
    });
    return `| \`${bs}\` | \`${withUid}\` | \`${withNull}\` | \`${withUndef}\` |`;
  }).join('\n');

  const escalated = deriveCanonicalState({
    bookingStatus: 'COMPLETED', workerStatus: 'COMPLETED', workerUid: 'p', hasEscalation: true,
  });

  return `${HEADER('Booking legacy status → canonical state migration matrix')}
Produced by RUNNING \`deriveCanonicalState\` over the cross-product of legacy
values, not by describing it. If the mapping changes, this table changes with
it.

## The grid

Rows are \`bookings.status\`; columns are the latest \`booking_workers.status\`.
\`worker_uid\` is populated wherever an assignment row exists.

${header}
${sep}
${body}

## Why an ended assignment reads as \`AWAITING_ASSIGNMENT\`

\`DECLINED\`, \`REASSIGNED\` and \`CANCELLED\` all mean the assignment row is
closed. \`bookings.status\` is **not** rewritten when a provider declines —
the legacy path cleared \`worker_uid\` and closed the row, leaving the booking
at \`WORKER_ASSIGNED\`. Reading only \`bookings.status\` therefore reported
\`ASSIGNED\` for a booking with no provider on it, and allowed the provider who
had just declined to accept the same job again.

## Where \`worker_uid\` decides the answer

With no assignment row at all, three legacy statuses are ambiguous, and the
distinction between "looked and found nobody" (\`null\`) and "did not look"
(\`undefined\`) is load-bearing.

| \`bookings.status\` | \`worker_uid\` set | \`worker_uid\` \`null\` | \`worker_uid\` \`undefined\` |
|---|---|---|---|
${uidRows}

A two-column caller cannot know which case it is in, so it keeps the old
answer. Admin passes the column explicitly and gets the accurate one. Guessing
for the two-argument caller would change a wire value on the strength of a
field it never supplied.

## Escalation outranks everything

\`COMPLETED\` + \`COMPLETED\` + an open escalation derives \`${escalated}\`.

## \`PAID\` and \`CONFIRMED\` collapse

Both map to \`AWAITING_ASSIGNMENT\`, which loses the distinction between "paid
but not yet OTP-confirmed" and "confirmed, awaiting a provider". This is
guard-compensated for TAB 04 rather than modelled, and carries an explicit
promotion trigger in \`docs/TAB04_OPEN_GAPS.md\`.
`;
}

// ─── 4. Job + matching contract ───────────────────────────────────────────────

/**
 * TAB 05's contract document.
 *
 * Generated for the same reason as the three above, plus one specific to this
 * subject: the whole point of the tab is that a Job is a PROJECTION of a
 * Booking and matching has ONE set of predicates. A hand-written copy of the
 * eligibility stages, the capability SQL or the caller matrix would be a second
 * declaration of exactly the things that must not have two — the failure the
 * capability audit found three times over.
 *
 * So every table here is produced by reading the live declarations:
 * `ELIGIBILITY_PIPELINE`, the shared predicates, `ZERO_CANDIDATE_REASONS`,
 * `BOOKING_ACTIONS` and `V1_CONTRACT`.
 */
function jobMatchingContractDoc(): string {
  const jobEntries = V1_CONTRACT.filter(
    (e) => e.domain === 'provider-jobs' || /^admin\.bookings\.(assign|reassign|assignmentCandidates)/.test(e.id),
  );

  const CLIENTS: Array<[keyof ContractEntry['callers'], string]> = [
    ['customerMobile', 'Customer Mobile'],
    ['customerWeb', 'Customer Web'],
    ['providerMobile', 'Provider Mobile'],
    ['providerWeb', 'Provider Web'],
    ['admin', 'Admin'],
  ];

  const endpointRows = jobEntries.map((e) => {
    const callers = CLIENTS.map(([key]) => {
      const v = e.callers[key];
      return v === 'n/a' ? '·' : `\`${v}\``;
    }).join(' | ');
    return `| \`${e.method.toUpperCase()} ${V1_PREFIX}${e.path}\` | ${e.status} | ${callers} |`;
  }).join('\n');

  const serviceRows = jobEntries
    .map((e) => `| \`${e.method.toUpperCase()} ${e.path}\` | \`${e.domainService}\` |`)
    .join('\n');

  const legacyRows = jobEntries.flatMap((e) => e.legacy.map((l) =>
    `| \`${l.method.toUpperCase()} ${l.path}\` | \`${e.method.toUpperCase()} ${V1_PREFIX}${e.path}\` | ${l.disposition} | ${l.note} |`,
  )).join('\n');

  const stageRows = ELIGIBILITY_PIPELINE.map((s) =>
    `| ${s.step} | \`${s.name}\` | ${s.owner} | ${s.stageClass === 'COMMIT_CRITICAL' ? '**yes**' : 'no'} | ${s.why} |`,
  ).join('\n');

  const assignmentActions = Object.entries(BOOKING_ACTIONS)
    .filter(([name]) => /ASSIGN|PROVIDER_/.test(name));

  const actionRows = assignmentActions.map(([name, spec]) => {
    const s = spec as Record<string, unknown>;
    const from = Array.isArray(s.from) ? (s.from as string[]).map((f) => `\`${f}\``).join(' ') : '_any legal source_';
    return `| \`${name}\` | \`${s.to}\` | ${ACTOR_LABEL[s.actor as Actor]} | ${from} | `
      + `${s.advisoryLock ? `\`${s.advisoryLock}\`` : '—'} | ${s.targetValidation ? `\`${s.targetValidation}\`` : '—'} | `
      + `${s.requiresReason ? '**yes**' : '—'} |`;
  }).join('\n');

  const reasonRequired = assignmentActions
    .filter(([, spec]) => (spec as Record<string, unknown>).requiresReason)
    .map(([name]) => `\`${name}\``);

  const zeroRows = ZERO_CANDIDATE_REASONS.map((r) =>
    `| \`${r.code}\` | ${r.operatorMessage} | ${r.actionable} |`,
  ).join('\n');

  const precedence = BLOCKER_PRECEDENCE.map((c) => `\`${c}\``).join(' → ');

  return `${HEADER('Job + matching contract (v1)', [
    'src/services/booking/eligibilityPipeline.ts (stages, capability and conflict predicates)',
    'src/services/booking/capabilitySource.ts   (canonical adoption criteria)',
    'src/services/booking/candidateDiagnostics.ts (zero-candidate reasons, blocker precedence)',
    'src/api/v1/contract.ts                     (endpoints, callers, legacy dispositions)',
  ])}
A provider Job is a **projection of a Booking**, not a second record with a
lifecycle of its own. Matching qualifies providers with **one** set of
predicates, and the executor commits with the same ones.

## 1. Endpoints and their callers

Every capability below is one backend domain service. Where a role-specific
endpoint remains, §3 states why the authorization differs — never the truth.

| Endpoint | Status | ${CLIENTS.map(([, label]) => label).join(' | ')} |
|---|---|${CLIENTS.map(() => '---').join('|')}|
${endpointRows}

\`legacy\` means the client is still on the pre-v1 path listed in §5 and the
alias is live. Shared surfaces move additively until every client has migrated.

## 2. One domain service per capability

| Endpoint | Domain service |
|---|---|
${serviceRows}

## 3. Why provider and admin assignment stay separate endpoints

They are separated by **authorization**, not by business truth: every one of
them commits through \`transitionBooking\`, against the same state machine,
with the same guards.

- A provider action derives identity from the **token** and the **locked
  assignment row**. It cannot name another provider, so there is no payload in
  which \`providerUid\` would mean anything.
- An admin action's entire purpose is to name another actor as the provider,
  which requires a permission a provider does not hold
  (\`bookings.assign_provider\`, \`bookings.reassign_provider\`).

Collapsing them into one endpoint would mean accepting a provider identity in a
body on a route providers can call — the exact shape this system forbids.

## 4. The state machine is shared, so a Job cannot diverge from its Booking

${assignmentActions.length} assignment and provider actions, all on the one executor:

| Action | To | Actor | From | Advisory lock | Target validation | Reason required |
|---|---|---|---|---|---|---|
${actionRows}

### The override audit model

${reasonRequired.length ? reasonRequired.join(', ') : 'No action'} refuses to run without a non-empty \`metadata.reason\`, checked **before any write**. Together
with the actor and the outgoing and incoming provider uids — all written inside
the same transaction as the assignment itself — that is the record which makes a
manual override reviewable months later.

Declared on the action rather than checked by a caller, so an internal script, a
future controller or a job cannot move a booking between providers and leave a
timeline entry with an empty description.

## 5. Legacy routes still serving these capabilities

| Legacy | Successor | Disposition | Why it still exists |
|---|---|---|---|
${legacyRows}

## 6. Matching hard constraints

The pipeline, in order. **Commit-critical** stages are the ones that can change
between selecting a provider and writing the row, so the executor repeats
exactly those inside the transaction — and only those. Re-running ranking under
a row lock would hold the lock for a scoring pass; a stale ranking is a
suboptimal assignment, a stale conflict check is a double-booked provider.

| # | Stage | Owner | Commit-critical | Why |
|---|---|---|---|---|
${stageRows}

Repeated under lock by the executor: ${COMMIT_CRITICAL_STAGES.map((s) => `\`${s}\``).join(', ')}.

### Capability

Qualification for a service, run identically by candidate generation, Admin
assignment and the executor:

\`\`\`sql
${PROVIDER_CAPABILITY_SQL('<schema>').trim()}
\`\`\`

**\`${CANONICAL_CAPABILITY_TABLE}\` is the authoritative source**, keyed on the
canonical \`services.id\` (\`$2\`). It is asked first and every decision records
which source answered.

The legacy family grants — ${LEGACY_CAPABILITY_TABLES.map((t) => `\`${t}\``).join(' and ')} —
remain as an **instrumented fallback**, keyed on the legacy
\`service_families.id\` (\`$3\`). They are two different id spaces: one family
implies every bookable service under it, up to 54, so the predicate takes both
rather than converting one to the other.

Removing the fallback today would be a NARROWING, and a narrowing of capability
is the silent supply collapse this tab exists to prevent: a provider whose
canonical row was never projected would simply stop being assignable. Because
canonical rows are a fan-out OF the legacy grants, canonical is a subset of
legacy and the union preserves today's assignability exactly.

A provider qualified only by the fallback is offered with a
\`CAPABILITY_LEGACY_FALLBACK\` warning rather than hidden, and one qualified
only by an inactive legacy grant with \`SERVICE_GRANT_INACTIVE\`. The executor
would commit both, and a preview narrower than its committer hides assignable
providers instead of failing safe.

\`employee_services.status\` is still not filtered: that column is created by
lazy DDL, so filtering on it would make qualification depend on which code path
ran first. The canonical table has a real \`status\` column with a CHECK
constraint and IS filtered — one of the reasons to move.

#### Retiring the fallback

Measured, not promised. \`npm run capability:parity\` reports the grants the
fallback is still carrying; the criteria are:

${Object.entries(CANONICAL_ADOPTION_CRITERIA).map(([k, v]) => `- \`${k}\`: \`${JSON.stringify(v)}\``).join('\n')}

### Conflict

**Half-open overlap against each job's real span.** Two jobs conflict when

\`\`\`
existing.start < candidate.end  AND  existing.end > candidate.start
\`\`\`

where \`end = schedule + duration\`. Half-open on both sides, so a job ending at
12:00 does not collide with one starting at 12:00 — back-to-back work is the
normal shape of a day, and the time-off collision rule already used this form.

Duration comes from \`service_options.duration_mins\`. NULL, zero and negative
all fall back to **${DEFAULT_SERVICE_DURATION_MINS} minutes**, which is the
column's own default and the convention every existing query already used. Zero
is the dangerous case: a zero-length span overlaps nothing, so one bad row would
make a provider infinitely bookable at that instant.

Statuses that do **not** occupy a provider:
${NON_OCCUPYING_STATUSES.map((s) => `\`${s}\``).join(', ')}. Both cancellation
spellings are listed because both exist in production data.

The comparison is between \`timestamptz\` values, so it is timezone-independent
by construction — unlike the fixed window it replaced, which did its arithmetic
on JS \`Date\` objects in the server's zone.

This REPLACED a fixed ±2 hours around the scheduled time, which ignored job
length and was wrong in both directions: it blocked a provider for four hours
around a 30-minute job, and let a second job be assigned three hours into a
four-hour one. Both spans are now resolved in SQL from the booking rows, so a
preview and its committer cannot disagree about how long a job lasts.

### The auto-assignment gap: **${LEGACY_AUTO_GAP.status}**

\`AUTO_ASSIGN\` used to validate its target more weakly than \`ADMIN_ASSIGN\` —
skipping ${LEGACY_AUTO_GAP.previouslySkipped.map((s) => `\`${s}\``).join(', ')} —
so the matching engine could commit a provider an admin would be refused.

${LEGACY_AUTO_GAP.closedBy}

Still outstanding: ${LEGACY_AUTO_GAP.missingStages.length
  ? LEGACY_AUTO_GAP.missingStages.map((s) => `\`${s}\``).join(', ')
  : '**nothing** — every producer of an assignment now passes the same hard constraints under the same two locks.'}

## 7. Candidate diagnostics

"No providers available" is emitted identically when nobody holds the service,
when everybody who does is deactivated, and when the pool was capped before
anyone was evaluated. The pool therefore carries a diagnosis.

| Reason | What it means | What to do |
|---|---|---|
${zeroRows}

A blocked provider is attributed to **one** cause, the earliest of:

${precedence}

running from "this account cannot work at all" to "this account cannot work on
THIS job", so the dominant cause reported is the most general true one.

Two counts make the diagnosis possible:

- **capable** — providers holding the canonical grant for the service,
  unfiltered by account state. The denominator: zero eligible out of zero
  capable is a catalog fact, zero out of fourteen is an incident. A failed
  count reports \`null\`, never \`0\`.
- **population / evaluated / cap** — a bound on the pool is necessary, but a
  bound applied to a name-ordered list is an undeclared filter. It is published,
  so "none available" can never silently mean "sorted after the cap".

\`supplyCollapse.suspected\` is raised only when capable providers exist and
none are assignable. Truncation is reported separately: folding it in would
make one flag mean two things.
`;
}

// ─── 5. Booking experiences (TAB 06) ──────────────────────────────────────────

/**
 * The TAB 06 deliverable, derived by EXECUTING `experiencePolicy` and the
 * contract rather than by restating them.
 *
 * Every number in this document — the OTP expiry, the cooldown, the attempt
 * budget, the tracking window, the notice period, the state lists — is read from
 * the declaration the services enforce. So the document cannot describe a policy
 * the backend does not implement, which is the failure mode a hand-written
 * contract has on the day after it is written.
 */
function bookingExperiencesDoc(): string {
  const CLIENTS: Array<[keyof ContractEntry['callers'], string]> = [
    ['customerMobile', 'Customer Mobile'],
    ['customerWeb', 'Customer Web'],
    ['providerMobile', 'Provider Mobile'],
    ['providerWeb', 'Provider Web'],
    ['admin', 'Admin'],
  ];

  const capabilityEntries = (capability: { contractIds: readonly string[] }): ContractEntry[] =>
    capability.contractIds
      .map((id) => V1_CONTRACT.find((e) => e.id === id))
      .filter((e): e is ContractEntry => !!e);

  /** §1 — the caller matrix the command asks for, one block per capability. */
  const callerMatrix = EXPERIENCE_CAPABILITIES.map((capability) => {
    const entries = capabilityEntries(capability);
    const rows = entries.map((e) => {
      const callers = CLIENTS.map(([key]) => {
        const v = e.callers[key];
        return v === 'n/a' ? '·' : `\`${v}\``;
      }).join(' | ');
      return `| \`${e.method.toUpperCase()} ${V1_PREFIX}${e.path}\` | ${e.status} | ${callers} |`;
    }).join('\n');

    return [
      `### ${capability.title}`,
      '',
      `**One domain module:** \`${capability.domainModule}\``,
      '',
      `| Endpoint | Status | ${CLIENTS.map(([, l]) => l).join(' | ')} |`,
      `|---|---|${CLIENTS.map(() => '---').join('|')}|`,
      rows || '| _no canonical endpoint_ | — | | | | | |',
      '',
      `**Role split:** ${capability.roleSplitRationale}`,
      '',
    ].join('\n');
  }).join('\n');

  const serviceRows = EXPERIENCE_CAPABILITIES.flatMap((capability) =>
    capabilityEntries(capability).map(
      (e) => `| ${capability.title} | \`${e.method.toUpperCase()} ${e.path}\` | \`${e.domainService}\` |`,
    ),
  ).join('\n');

  const legacyRows = EXPERIENCE_CAPABILITIES.flatMap((capability) =>
    capabilityEntries(capability).flatMap((e) =>
      e.legacy.map(
        (l) =>
          `| \`${l.method.toUpperCase()} ${l.path}\` | \`${e.method.toUpperCase()} ${V1_PREFIX}${e.path}\` | ${l.disposition} | ${l.note} |`,
      ),
    ),
  ).join('\n');

  const otpRows = BOOKING_OTP_PURPOSE_NAMES.map((name) => {
    const p = BOOKING_OTP_PURPOSES[name];
    return `| \`${name}\` | \`bookings.${p.credentialColumn}\` | ${p.issuer} | ${p.recipient} | ${p.delivery} | `
      + `${p.expiryMinutes} min | ${p.resendCooldownSeconds}s | ${p.maxVerifyAttempts} | ${p.maxIssues} | `
      + `${p.requestableBy.join(', ')} | ${p.verifiableBy.join(', ')} | \`${p.action}\` |`;
  }).join('\n');

  const otpStateRows = BOOKING_OTP_PURPOSE_NAMES.map(
    (name) => `| \`${name}\` | ${BOOKING_OTP_PURPOSES[name].validStates.map((s) => `\`${s}\``).join(' ')} | ${BOOKING_OTP_PURPOSES[name].why} |`,
  ).join('\n');

  const cancellationRows = CANCELLATION_MATRIX.map((rule) =>
    `| ${ACTOR_LABEL[rule.actor as Actor]} | \`${rule.action}\` | ${rule.from.map((f) => `\`${f}\``).join(' ')} | `
    + `${rule.guard ? `\`${rule.guard}\`` : '—'} | ${rule.reasonRequired ? '**yes**' : 'no'} | `
    + `${rule.reasonCodes.length ? rule.reasonCodes.map((r) => `\`${r}\``).join(' ') : '_free text_'} | `
    + `${rule.notifies.join(', ')} |`,
  ).join('\n');

  const consequenceRows = CANCELLATION_MATRIX.map(
    (rule) => `- **${ACTOR_LABEL[rule.actor as Actor]}** — ${rule.financialConsequence}`,
  ).join('\n');

  const eventRows = BOOKING_EXPERIENCE_EVENTS.map((e) =>
    `| \`${e.name}\` | ${e.capability} | \`${e.timelineType}\` | `
    + `${e.notifies.length ? e.notifies.join(', ') : '—'} | `
    + `${UNEMITTED_EVENTS.includes(e.name) ? '**declared, not emitted**' : 'emitted'} | ${e.why} |`,
  ).join('\n');

  const trackingReasons: Array<[string, string]> = [
    ['NO_ASSIGNMENT', 'The booking has no provider on it yet.'],
    ['STATE_NOT_TRACKABLE', 'The provider has not set off; there is nothing to watch.'],
    ['WINDOW_EXPIRED', 'The window closed on a job that never reached a terminal state.'],
    ['NO_POSITION_REPORTED', 'Assigned and moving, but no position has been reported.'],
  ];

  return `${HEADER('Booking experiences contract (v1)', [
    'src/services/booking/experiencePolicy.ts (OTP purposes, tracking, reschedule, disputes, events)',
    'src/api/v1/contract.ts                     (endpoints, callers, legacy dispositions)',
  ])}
Tracking, codes, cancellation, reschedule, additional work and disputes are
**projections of a Booking**. Every one is booking-scoped, every one is
state-validated, and none of them carries a lifecycle of its own (§60).

## 1. Endpoints and their callers

\`legacy\` means the client is still on the pre-v1 path listed in §7 and the
alias is live. Shared surfaces move additively until every client has migrated.

${callerMatrix}
## 2. One domain service per capability

This is the table that makes "one canonical domain service behind all clients"
checkable rather than aspirational. Two endpoints naming different services for
the same business operation would be two business truths wearing one name.

| Capability | Endpoint | Domain service |
|---|---|---|
${serviceRows}

## 3. Cancellation, centralized

Three actors, three actions, three guards — **one state machine**. Each row is
enforced by \`transitionBooking\`, so no client can cancel from a state another
client could not.

| Actor | Action | May cancel from | Guard | Reason required | Reason codes | Notifies |
|---|---|---|---|---|---|---|
${cancellationRows}

### Financial consequences

${consequenceRows}

Nothing computes a penalty. C18 §26 says outright "do not invent penalties", and
a fee nobody specified would be worse than none.

### Why the endpoints stay role-specific

A customer cancel, a provider cancel and an admin cancel differ in *authority*,
not in truth: the provider action carries a notice window the customer's does
not, the admin action carries neither and takes a \`refundAction\`, and each has
its own notification fan-out. Collapsing them would mean one endpoint branching
on the caller's role to pick a guard — which is the same three rules with the
branch moved somewhere less visible.

## 4. Booking codes (OTP)

A code is minted **for a booking and for a purpose**. Verification compares it
against the column that purpose names and refuses an actor the purpose does not
list, so a confirmation code presented as a service-start code is checked against
\`worker_code\` and fails. There is no "elsewhere" for a code to be reused in.

| Purpose | Column | Issuer | Recipient | Delivery | Expiry | Cooldown | Attempts | Max issues | May request | May verify | Action |
|---|---|---|---|---|---|---|---|---|---|---|---|
${otpRows}

| Purpose | Valid states | Why this lifetime |
|---|---|---|
${otpStateRows}

### The inversion that matters

\`SERVICE_START\`'s recipient is the **customer** and its verifier is the
**provider**. That is the entire security property: the customer reads the code
out on the doorstep and the provider types it in. So the provider may not
*request* it — a provider who could rotate this code could mint the proof they
are supposed to be given.

### What bounds a replay

- **Expiry and cooldown** are derived from \`booking_otp_events\`, not from a
  column on \`bookings\`. The newest \`ISSUED\` row dates the current code; the
  \`FAILED\` rows after it are the attempt count.
- **Only a wrong code spends an attempt.** A mistimed call is refused before the
  executor runs, so nobody can burn a customer's budget by calling at the wrong
  moment.
- **A rotation restores the budget**, because it is a new credential. Otherwise a
  resend would hand back a code that was already dead on arrival.
- **The comparison is still inside the write.** This policy layer decides whether
  an attempt is *allowed*; \`transitionBooking\` decides whether the code
  *matches*, in the same statement as the mutation.

### Enforced in the domain service, not the endpoint

\`bookingService.confirmOtp\` and \`resendBookingOtp\` **delegate** to the same
service. A limit only the canonical path applied would leave
\`POST /api/:id/confirm-otp\` — the path the shipped customer app calls — as an
unlimited guessing oracle, and the release gate would be met on paper.

## 5. Tracking authorization

Provider position is disclosed only when **all three** hold:

1. the booking has an assignment;
2. its canonical state is one of ${TRACKING_LOCATION_STATES.map((s) => `\`${s}\``).join(', ')};
3. the last transition into one of those states was within
   **${TRACKING_MAX_HOURS_SINCE_MOVEMENT} hours**.

The window is measured from the provider's last *movement*, not from the
schedule: a job that started three hours late is still live, and a job that is
never completed must eventually go dark. An unknown movement time **fails
closed**.

| Withheld reason | Meaning |
|---|---|
${trackingReasons.map(([code, why]) => `| \`${code}\` | ${why} |`).join('\n')}

A withheld position answers **200 with a reason, never 403**. The caller is
entitled to the booking; they are simply not entitled to a live location for it
yet, and those are different screens.

## 6. Reschedule

| Rule | Value |
|---|---|
| Provider acceptance required | ${RESCHEDULE_REQUIRES_PROVIDER_ACCEPTANCE ? 'yes' : '**no** — see below'} |
| Customer notice | ${CUSTOMER_RESCHEDULE_NOTICE_HOURS} hours before the CURRENT start |
| Admin notice | none — an admin override is the escalation path |
| Maximum lead | ${RESCHEDULE_MAX_LEAD_DAYS} days |
| Reschedulable from | ${RESCHEDULABLE_STATES.map((s) => `\`${s}\``).join(' ')} |
| Reason codes | ${RESCHEDULE_REASONS.map((r) => `\`${r}\``).join(' ')} |

### Why there is no acceptance step

§62 asks for proposal/acceptance **"if both parties must agree"**. They do not:
the operator's recorded policy (C18 §14/§24) is that *"the provider is NOT a
party to rescheduling — only the customer and admin may move a booking, and the
provider only responds to the outcome."* That is preserved, and the provider is
refused with \`BOOKING_ACCESS_DENIED\` and notified of the result.

What is **not** preserved is the silent overwrite. Every attempt writes a
\`booking_reschedule_requests\` row — accepted *or* refused — so a schedule
change always has a proposer, a before, an after and a reason. Flipping
\`RESCHEDULE_REQUIRES_PROVIDER_ACCEPTANCE\` turns that same record into an
acceptance workflow with no schema change.

### Two ways a move is prevented from being silent

- **Optimistic concurrency.** The write carries
  \`schedule IS NOT DISTINCT FROM <expected>\`, so two simultaneous reschedules
  produce one winner and one \`BOOKING_SCHEDULE_CHANGED\` — not a last-write-wins.
  \`IS NOT DISTINCT FROM\` rather than \`=\` because a NULL schedule is real and
  \`NULL = NULL\` is NULL.
- **Assignment consistency.** A move that would collide with the assigned
  provider's calendar is **refused**, using the same half-open overlap predicate
  the matching engine and the executor use. Releasing the assignment instead
  would need a new lifecycle transition, and inventing one here would put a
  second writer beside the executor for the operation TAB 04 centralised.

## 7. Legacy routes still serving these capabilities

| Legacy | Successor | Disposition | Why it still exists |
|---|---|---|---|
${legacyRows}

Every one of these is counted by \`api/v1/legacyTelemetry\`, whose watch list is
derived from the same table. A route can only be documented as superseded if it
is also being measured.

## 8. Additional work is a child request, not a mutation

It already was: \`booking_additional_requests\` + \`booking_additional_items\`,
with its own status machine —
\`PENDING_ADMIN_APPROVAL → WAITING_FOR_PAYMENT → WAITING_WORKER_APPROVAL →
ACCEPTED → IN_PROGRESS\`, plus \`REJECTED\` and \`CANCELLED\`. Scope and price are
approved before work proceeds, and a rejection refunds.

TAB 06 gives it a booking-scoped canonical path and puts it on the booking
timeline. It does **not** re-model it, and approval and payment stay on the
legacy \`/api/additional/*\` family that Provider Web calls today — both families
call the same \`additionalService\` instance.

## 9. Dispute model

One record for all three actors, on \`booking_escalations\` — the table the admin
portal already derives \`hasDispute\` from, \`deriveCanonicalState\` already reads
to return \`DISPUTED\`, and the payout hold already respects. A second table would
have given admin, provider and customer different answers to "is this booking
disputed?".

| Field | Purpose |
|---|---|
| \`category\` | The standardized vocabulary, distinct from the legacy free-form \`reason_code\`. |
| \`opened_by_role\` | Which seat raised it. \`actor_uid\` alone cannot say. |
| \`state_snapshot\` | Service and financial state **at opening** (§66) — canonical state, raw statuses, schedule, payment status and method. No amounts, no references, no payer. |

**Categories:** ${DISPUTE_CATEGORIES.map((c) => `\`${c}\``).join(' ')}

**Openable from:** ${DISPUTABLE_STATES.map((s) => `\`${s}\``).join(' ')}. A booking
nobody has committed to has nothing to dispute — declining is the mechanism
before acceptance.

**Duplicate prevention has two layers.** The policy check refuses a second open
dispute with a renderable reason; a partial unique index refuses it in the
database. The first is the good error message, the second is the one that holds
when two people press the button in the same second.

**Never projected to any caller:** \`reason\`, \`assigned_team\`, \`actor_uid\` —
free text one party typed about another, internal routing, and a person. Only
\`openedByYou\` varies by caller.

## 10. Canonical domain events

A closed catalog. An event not declared here cannot be emitted — the emitter's
parameter type is the union of these names — so a new side effect must be named
in a diff rather than appearing as a string literal at a call site.

| Event | Capability | Timeline type | Notifies | Status | Why |
|---|---|---|---|---|---|
${eventRows}

\`booking_rescheduled\` and \`dispute_opened\` are values the admin portal already
renders. They are **reused, not renamed**: a new spelling for an existing event
is a silent break of every timeline reader.

Emission is downstream of a committed change and never fails it (§45), except
where a caller passes its own transaction and has asked for the two to be atomic.
Credentials are redacted from every event detail before it reaches a timeline row.
`;
}

// ─── Emit ─────────────────────────────────────────────────────────────────────

export interface GeneratedFile { relPath: string; content: string }

export function generateAll(): GeneratedFile[] {
  return [
    { relPath: 'docs/booking/BOOKING_STATE_MACHINE.md', content: stateMachineDoc() },
    { relPath: 'docs/booking/BOOKING_ACTOR_PERMISSION_MATRIX.md', content: permissionMatrixDoc() },
    { relPath: 'docs/booking/BOOKING_STATUS_MIGRATION_MATRIX.md', content: migrationMatrixDoc() },
    { relPath: 'docs/booking/JOB_MATCHING_V1_CONTRACT.md', content: jobMatchingContractDoc() },
    { relPath: 'docs/booking/BOOKING_EXPERIENCES_V1_CONTRACT.md', content: bookingExperiencesDoc() },
  ];
}

/** Compares generated content with what is on disk. Newline-normalised for Windows checkouts. */
export function staleFiles(): string[] {
  const repoRoot = path.resolve(__dirname, '..');
  const stale: string[] = [];
  for (const file of generateAll()) {
    const abs = path.join(repoRoot, file.relPath);
    if (!fs.existsSync(abs)) { stale.push(file.relPath); continue; }
    const onDisk = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    if (onDisk !== file.content.replace(/\r\n/g, '\n')) stale.push(file.relPath);
  }
  return stale;
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const stale = staleFiles();
    if (stale.length) {
      console.error(`Booking docs are stale — run "npm run booking:docs":\n  ${stale.join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.log('Booking docs are up to date.');
    }
  } else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const file of generateAll()) {
      const abs = path.resolve(__dirname, '..', file.relPath);
      fs.writeFileSync(abs, file.content, 'utf8');
      console.log(`wrote ${file.relPath}`);
    }
  }
}
