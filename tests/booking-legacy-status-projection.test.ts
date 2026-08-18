/**
 * `bookings.status` carrying EN_ROUTE / ARRIVED is a COMPATIBILITY PROJECTION,
 * not canonical state — and these tests are what keeps that distinction true
 * rather than merely written down.
 *
 * ## Why it exists at all
 *
 * A consumer sweep on 2026-08-12 found exactly one dependant. The backend has
 * none: all 29 `bookings.status` filters use COMPLETED, CANCELLED, PENDING_OTP,
 * CONFIRMED, PAID, WORKER_ASSIGNED, IN_PROGRESS, REFUNDED, FAILED or EXPIRED,
 * and every arrival-aware predicate is on `booking_workers.status`. Neither
 * Admin, Provider Web, ServanaWorker nor the customer web portal read it.
 *
 * ServanaClient reads it in the two places that matter — the bookings LIST
 * (`customer_booking.dart:166`) and the assignment POLLER
 * (`assignment_polling_service.dart:100`). Removing the projection would not
 * error there; the booking would simply never appear to progress.
 *
 * ## The rule
 *
 * The projected value is derived from a transition the canonical machine has
 * ALREADY approved. It is never an input to whether a transition is legal. The
 * moment it becomes one, it is a second state machine and the whole exercise
 * has been undone.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..', 'src');
const codeOf = (rel: string): string =>
  fs
    .readFileSync(path.join(SRC, rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

const executor = codeOf('services/booking/transitionExecutor.ts');

describe('the projection is derived, never deciding', () => {
  it('is written only from the approved-transition path', () => {
    // Its single call site is inside `applyState`, which runs after
    // `canTransition` has already allowed the move under the row lock.
    const calls = executor.split('\n').filter((l) => l.includes('writeLegacyStatusProjection('));
    // One definition, one call.
    expect(calls).toHaveLength(2);
    const callSite = calls.find((l) => !l.includes('async function'))!;
    expect(callSite).toContain('await writeLegacyStatusProjection(client, loaded.id, providerUid, to)');
  });

  it('takes the state it writes as an argument — it does not compute one', () => {
    const start = executor.indexOf('async function writeLegacyStatusProjection');
    const body = executor.slice(start, executor.indexOf('\n}', start));
    // No status derivation, no branching on the current row.
    expect(body).not.toContain('deriveCanonicalState');
    expect(body).not.toContain('canTransition');
    expect(body).not.toMatch(/if\s*\(\s*\w+Status/);
  });

  it('accepts only the two states the projection covers', () => {
    // Slice FORWARD from the declaration: `): Promise<void>` also appears on
    // ensureTransitionSchema earlier in the file, and an unanchored indexOf
    // produced an empty slice that passed nothing.
    const start = executor.indexOf('async function writeLegacyStatusProjection');
    const signature = executor.slice(start, executor.indexOf('): Promise<void>', start));
    expect(signature).toContain("Extract<BookingState, 'EN_ROUTE' | 'ARRIVED'>");
  });

  it('is scoped to the provider who owns the booking', () => {
    // Same scoping `advanceArrivalStage` used, so a concurrent admin action on
    // a reassigned booking cannot be clobbered.
    expect(executor).toContain('WHERE id = $1 AND worker_uid = $3');
  });

  it('runs inside the transaction, not after the commit', () => {
    const call = executor.indexOf('writeLegacyStatusProjection(client');
    const commit = executor.indexOf("client.query('COMMIT')");
    expect(call).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(call);
  });
});

describe('the retirement condition is recorded, not remembered', () => {
  const raw = fs.readFileSync(
    path.join(SRC, 'services/booking/transitionExecutor.ts'),
    'utf8',
  );

  it('names the blocker and the consumers by file', () => {
    expect(raw).toContain('LEGACY_STATUS_PROJECTION_RETIREMENT_BLOCKER');
    expect(raw).toContain('customer_booking.dart');
    expect(raw).toContain('assignment_polling_service.dart');
  });

  it('requires ADOPTION, not merely a code change', () => {
    // Two Dart lines is the change. It is not the condition — an unupdated app
    // keeps reading the old field for as long as it stays installed.
    expect(raw).toMatch(/adopted/i);
    expect(raw).toMatch(/telemetry/i);
  });

  it('states that the projection is not canonical', () => {
    expect(raw).toContain('This is NOT canonical state');
  });
});

/**
 * ─── Migration debt, gated ───────────────────────────────────────────────────
 *
 * Phase A's `/api/v1/provider/jobs/:id/{en-route,arrived}` endpoints go through
 * the executor, so they now produce the projection too — closing the
 * inconsistency where the canonical path and the legacy path disagreed about
 * `bookings.status`.
 *
 * These assertions are the gate. They were FAILING when Phase A landed and the
 * executor did not cascade; they pass now. Keeping them named makes the
 * discrepancy migration debt with a check rather than tribal knowledge.
 */
describe('V1 / legacy parity for the arrival states', () => {
  it('V1_EN_ROUTE_BOOKING_STATUS_PARITY', () => {
    // The v1 endpoint and technicianService.advanceArrivalStage must both leave
    // bookings.status = 'EN_ROUTE'.
    const legacy = codeOf('services/technicianService.ts');
    expect(legacy).toContain('UPDATE ${dbSchema}.bookings');
    expect(executor).toContain('writeLegacyStatusProjection');
  });

  it('V1_ARRIVED_BOOKING_STATUS_PARITY', () => {
    // Both arrival states route through the same projection helper, so parity
    // cannot hold for one and not the other.
    const applyState = executor.slice(executor.indexOf('async function applyState'));
    const arrivalBranch = applyState.slice(
      applyState.indexOf("case 'EN_ROUTE':"),
      applyState.indexOf("case 'IN_PROGRESS':"),
    );
    expect(arrivalBranch).toContain("case 'ARRIVED':");
    expect(arrivalBranch).toContain('writeLegacyStatusProjection');
  });

  it('ACCEPTED does NOT get the projection — legacy never cascaded it', () => {
    // `advanceArrivalStage` is called only for EN_ROUTE and ARRIVED. Projecting
    // ACCEPTED would be a new behaviour, not a preserved one.
    const applyState = executor.slice(executor.indexOf('async function applyState'));
    const acceptedBranch = applyState.slice(
      applyState.indexOf("case 'ACCEPTED':"),
      applyState.indexOf("case 'EN_ROUTE':"),
    );
    expect(acceptedBranch).not.toContain('writeLegacyStatusProjection');
  });
});

describe('schema repair is not the executor\'s job', () => {
  it('the executor never runs arrival-column DDL', () => {
    // `ensureArrivalColumns()` is lazy DDL for accepted_at / en_route_at /
    // arrived_at. A booking transition must not be able to alter schema, so it
    // stays at the technicianService boundary and is queued as a real
    // migration. Preserved for compatibility, not blessed as domain behaviour.
    expect(executor).not.toContain('ensureArrivalColumns');
    expect(executor).not.toMatch(/ALTER TABLE \$\{s\}\.booking_workers/);
  });

  it('the lazy DDL still exists where it did, so nothing was silently dropped', () => {
    const legacy = codeOf('services/technicianService.ts');
    expect(legacy).toContain('ensureArrivalColumns');
  });
});
