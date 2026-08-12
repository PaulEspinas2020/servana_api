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

const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'booking');

const HEADER = (title: string) => `<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-booking-docs.ts, derived from
    src/services/booking/canonicalState.ts   (states, transition whitelist)
    src/services/booking/transitionExecutor.ts (action registry)
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
- **Target validation** — how hard the assignment target is checked.
  \`LEGACY_AUTO\` is deliberately weaker than \`FULL\`; see
  \`docs/TAB04_OPEN_GAPS.md\`.
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

// ─── Emit ─────────────────────────────────────────────────────────────────────

export interface GeneratedFile { relPath: string; content: string }

export function generateAll(): GeneratedFile[] {
  return [
    { relPath: 'docs/booking/BOOKING_STATE_MACHINE.md', content: stateMachineDoc() },
    { relPath: 'docs/booking/BOOKING_ACTOR_PERMISSION_MATRIX.md', content: permissionMatrixDoc() },
    { relPath: 'docs/booking/BOOKING_STATUS_MIGRATION_MATRIX.md', content: migrationMatrixDoc() },
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
