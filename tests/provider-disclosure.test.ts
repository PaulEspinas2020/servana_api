/**
 * PII staging, decided once.
 *
 * Two places used to decide independently how much of a customer a provider
 * may see, one of them carrying a comment saying it matched the other. They did
 * match when measured — but by inspection, and only until somebody edited one.
 * A comment claiming kinship is not a mechanism.
 *
 * The consequence of drift is not cosmetic. `getProviderBookingDetail` exists
 * in its current form precisely because it once spread the raw row, so an
 * ASSIGNED provider who had accepted nothing could read the street address and
 * zip code by calling it directly.
 */

import fs from 'fs';
import path from 'path';

import {
  disclosureLevelFor,
  hasFullDisclosure,
  OPERATIONAL_WORKER_STATUSES,
  RELINQUISHED_WORKER_STATUSES,
} from '../src/controllers/providerDisclosure';
import { formatJobCard } from '../src/controllers/jobCardView';

const SRC = path.join(__dirname, '..', 'src');

const codeOf = (relative: string): string => fs
  .readFileSync(path.join(SRC, relative), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');

const row = (worker_status: string) => ({
  booking_id: 5,
  worker_uid: 'provider-1',
  status: 'WORKER_ASSIGNED',
  worker_status,
  has_escalation: false,
  customer_id: 'cust-1',
  first_name: 'Maria',
  last_name: 'Santos',
  phone_number: '+639171234567',
  address_one: '45 Ayala Avenue',
  address_two: 'Unit 5',
  post_town: 'Makati',
  zip_code: '1226',
  country: 'PH',
  delivery_instructions: 'Side entrance',
  location_id: 'loc_14.55_121.02',
});

// ─── The decision ─────────────────────────────────────────────────────────────

describe('the staging levels', () => {
  it('grants FULL only where the provider is working the job', () => {
    for (const s of ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED']) {
      expect(`${s}:${disclosureLevelFor(s)}`).toBe(`${s}:full`);
    }
  });

  it('grants AREA before acceptance', () => {
    // Enough to decide whether to take the job; not the customer's street.
    expect(disclosureLevelFor('ASSIGNED')).toBe('area');
  });

  it('grants NOTHING once the provider has relinquished the job', () => {
    for (const s of ['DECLINED', 'CANCELLED', 'CANCELED', 'REASSIGNED']) {
      expect(`${s}:${disclosureLevelFor(s)}`).toBe(`${s}:none`);
    }
  });

  it('EN_ROUTE and ARRIVED keep full disclosure', () => {
    // They sit BETWEEN accepted and in-progress. A provider who tapped "on my
    // way" is travelling to the address; withholding it there would break the
    // journey the disclosure exists to enable.
    expect(hasFullDisclosure('EN_ROUTE')).toBe(true);
    expect(hasFullDisclosure('ARRIVED')).toBe(true);
  });

  it('is case-insensitive and null-safe', () => {
    expect(disclosureLevelFor('accepted')).toBe('full');
    expect(disclosureLevelFor(null)).toBe('area');
    expect(disclosureLevelFor(undefined)).toBe('area');
  });
});

// ─── Negative fixtures: the failure direction ─────────────────────────────────

describe('NEGATIVE: unknown and hostile input fails towards LESS exposure', () => {
  it('an unrecognised status does not earn full disclosure', () => {
    /**
     * The direction that matters. A status this platform has never seen is not
     * evidence of an accepted job, so it must not unlock the street address —
     * and a future status added server-side must not grant access by default.
     */
    for (const s of ['SOMETHING_NEW', 'PENDING_REVIEW', '', '   ', 'ACCEPTED_MAYBE']) {
      expect(hasFullDisclosure(s)).toBe(false);
    }
  });

  it('a relinquished status is never upgraded by casing or padding', () => {
    expect(disclosureLevelFor('declined')).toBe('none');
    expect(disclosureLevelFor('Cancelled')).toBe('none');
  });

  it('the two sets do not overlap', () => {
    // An overlap would make the answer depend on check order.
    for (const s of OPERATIONAL_WORKER_STATUSES) {
      expect(RELINQUISHED_WORKER_STATUSES.has(s)).toBe(false);
    }
  });
});

describe('NEGATIVE: the job card withholds what the level forbids', () => {
  it('an ASSIGNED provider gets the area and nothing identifying', () => {
    const card = formatJobCard(row('ASSIGNED'));
    expect(card.address.addressOne).toBeNull();
    expect(card.address.zipCode).toBeNull();
    expect(card.address.instructions).toBeNull();
    expect(card.address.lat).toBeNull();
    expect(card.address.lng).toBeNull();
    expect(card.customer.phone).toBeNull();
    // Masked, not full.
    expect(card.customer.name).toBe('Maria S.');
    // The AREA survives — it is what a travel decision needs.
    expect(card.address.city).toBe('Makati');
  });

  it('a DECLINED provider gets nothing, not even the area', () => {
    const card = formatJobCard(row('DECLINED'));
    expect(card.customer.uid).toBeNull();
    expect(card.customer.name).toBe('');
    expect(card.customer.phone).toBeNull();
    expect(card.address.city).toBeNull();
    expect(card.address.country).toBeNull();
  });

  it('an ACCEPTED provider gets the street, the phone and coordinates', () => {
    const card = formatJobCard(row('ACCEPTED'));
    expect(card.address.addressOne).toBe('45 Ayala Avenue');
    expect(card.address.instructions).toBe('Side entrance');
    expect(card.customer.phone).toBe('+639171234567');
    expect(card.customer.name).toBe('Maria Santos');
  });

  it('keys are emptied, never removed', () => {
    // Removing a key changes a consumer's shape; emptying it does not.
    const assigned = Object.keys(formatJobCard(row('ASSIGNED')).address).sort();
    const accepted = Object.keys(formatJobCard(row('ACCEPTED')).address).sort();
    expect(assigned).toEqual(accepted);
  });
});

// ─── The guard against a third copy ───────────────────────────────────────────

describe('no file may stage provider PII on its own', () => {
  /**
   * Files permitted to name the operational statuses, each with the reason it
   * is not a second decision. Adding one fails and forces a classification.
   */
  const PERMITTED: Record<string, string> = {
    'controllers/providerDisclosure.ts': 'THE decision. The one place allowed to make it.',
    'services/booking/canonicalState.ts': 'The state machine; names every state to model it.',
    'services/booking/providerActions.ts': 'Projects the machine into UI codes, keyed BY state.',
    'services/booking/projections.ts': 'Labels every state.',
    'services/booking/eligibilityPipeline.ts': 'Assignment eligibility; not customer disclosure.',
    'services/booking/adminOpsStatusSql.ts': 'Admin state derivation; not customer disclosure.',
    'services/booking/transitionExecutor.ts': 'Writes the lifecycle; discloses nothing.',
    'services/booking/experiencePolicy.ts':
      'Names states to gate booking-adjacent ACTIONS, not to disclose a person. The ' +
      'one disclosure decision it does hold — whether a provider position may be ' +
      'shown — is a withhold-by-default rule keyed on state and elapsed time, and it ' +
      'returns a verdict rather than any provider field.',
    'chat/chat.repository.ts': 'Chat membership from the assignment; discloses no address.',
    'services/providerCalendarService.ts':
      'Emits the CITY unconditionally and never more, so it sits at the area floor '
      + 'by construction and has nothing to stage. Excludes declined and cancelled '
      + 'work entirely, so the relinquished case cannot arise.',
    'services/bookingAccessService.ts': 'Access control; which statuses count as active.',
    'controllers/bookingDisputeView.ts':
      'Orders the lifecycle stages for a dispute summary. Presentation over '
      + 'stages, no customer data staged.',
    'controllers/bookingTimeline.ts':
      'Builds timeline events from per-stage timestamps. Emits WHEN things '
      + 'happened, never the customer address or phone.',
    'services/booking/bookingPolicies.ts':
      'Which stages a provider may self-cancel from. A cancellation policy, not '
      + 'a disclosure decision.',
    'services/bookingResponseConflict.ts':
      'Detects an accept or decline arriving after the assignment moved on. '
      + 'Compares statuses; returns no customer fields.',
    'services/bookingStatusProjection.ts':
      'A thin adapter over deriveCanonicalState. Projects state, discloses '
      + 'nothing.',
    'services/technicianService.ts': 'Produces the rows; the formatter stages them.',
    'services/adminBookingService.ts': 'Admin surface; admins are not staged.',
    'controllers/providerController.ts':
      'getProviderBookingDetail consumes hasFullDisclosure. Asserted below to hold '
      + 'no list of its own.',
  };

  it('every file naming the operational set is a reviewed consumer', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const rel = path.relative(SRC, full).split(path.sep).join('/');
        const code = codeOf(rel);
        // The shape of a staging decision: the operational statuses listed
        // together as literals.
        const listsOperational = /['"]EN_ROUTE['"]/.test(code)
          && /['"]ARRIVED['"]/.test(code)
          && /['"]IN_PROGRESS['"]/.test(code);
        if (!listsOperational) continue;
        if (!(rel in PERMITTED)) offenders.push(rel);
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it('the detector would catch a new copy', () => {
    const fixture = `const ops = ["ACCEPTED","EN_ROUTE","ARRIVED","IN_PROGRESS"];`;
    expect(/['"]EN_ROUTE['"]/.test(fixture) && /['"]ARRIVED['"]/.test(fixture)
      && /['"]IN_PROGRESS['"]/.test(fixture)).toBe(true);
    expect(/['"]EN_ROUTE['"]/.test('const x = 1;')).toBe(false);
  });

  it('the booking-detail route holds NO list of its own', () => {
    // The specific duplication this slice removed.
    const code = codeOf('controllers/providerController.ts');
    expect(code).toContain('hasFullDisclosure(workerStatus)');
    expect(code).not.toContain('["ACCEPTED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED"].includes');
  });

  it('the job card holds no list of its own either', () => {
    const code = codeOf('controllers/jobCardView.ts');
    expect(code).toContain('disclosureLevelFor(workerStatus)');
    expect(code).not.toContain('const OPERATIONAL_WORKER_STATUSES = new Set');
  });

  it('the calendar still emits only the city', () => {
    /**
     * Not a third copy, and this keeps it that way: a calendar that started
     * emitting a street address would be a new disclosure decision made in a
     * place that has never had one.
     */
    const code = codeOf('services/providerCalendarService.ts');
    expect(code).toContain('locationLabel');
    expect(code).not.toContain('address_one');
    expect(code).not.toContain('phone_number');
    expect(code).not.toContain('delivery_instructions');
  });
});

// ─── Wire compatibility ───────────────────────────────────────────────────────

describe('consolidation did not change the wire', () => {
  it('the booking detail still answers in snake_case, spread from the row', () => {
    /**
     * The two surfaces have irreconcilable shapes — the job card is camelCase
     * and nested, this route is snake_case and flat — so they share the
     * DECISION, not the formatter. Routing this through formatJobCard would
     * have broken every consumer of it.
     */
    const code = codeOf('controllers/providerController.ts');
    expect(code).toContain('address: operational ? row.address : null');
    expect(code).toContain('zip_code: operational ? row.zip_code : null');
    expect(code).toContain('clientPaymentStatus');
  });

  it('the booking detail is still scoped to an ACTIVE assignment', () => {
    // Its authorization is a join, not a filter applied afterwards — which is
    // why it needs no relinquished branch: a declined provider gets 404 and
    // never reaches the staging at all.
    const code = codeOf('controllers/providerController.ts');
    expect(code).toContain('bw.worker_uid = $2');
    expect(code).toContain("bw.status IN ('ASSIGNED','ACCEPTED','EN_ROUTE','ARRIVED','IN_PROGRESS','COMPLETED')");
  });
});

// ─── Reassignment, and the scoping every provider surface depends on ─────────

describe('a reassigned provider loses disclosure by the same decision', () => {
  /**
   * `ADMIN_REASSIGN` closes the outgoing assignment as `DECLINED` — the word is
   * deliberate (auto-assignment excludes providers whose row says DECLINED, so
   * the more accurate `REASSIGNED` would make an admin's removal reversible by
   * the matcher on the next pass).
   *
   * The consequence for PII is what matters here: the outgoing provider's
   * status is now in the relinquished set, so the SAME staging decision that
   * gave them the street address takes it back. No second rule, no cleanup job.
   */
  it('DECLINED and REASSIGNED both fall to nothing', () => {
    for (const status of ['DECLINED', 'REASSIGNED']) {
      expect(disclosureLevelFor(status)).toBe('none');
      expect(hasFullDisclosure(status)).toBe(false);
    }
  });

  it('the outgoing provider stops seeing the customer entirely', () => {
    // Not merely the street: the name and the city go too. They are no longer
    // on the job, so there is nothing they need.
    const card = formatJobCard(row('DECLINED'));
    expect(card.customer.uid).toBeNull();
    expect(card.customer.name).toBe('');
    expect(card.customer.phone).toBeNull();
    expect(card.address.addressOne).toBeNull();
    expect(card.address.city).toBeNull();
  });

  it('the INCOMING provider gets the area, not the street, until they accept', () => {
    // Reassignment hands over at ASSIGNED, so the new provider starts at the
    // same floor everybody else does — an admin action does not pre-authorise
    // them to the customer's door.
    const card = formatJobCard(row('ASSIGNED'));
    expect(card.address.city).toBe('Makati');
    expect(card.address.addressOne).toBeNull();
    expect(card.customer.phone).toBeNull();
  });
});

describe('every provider surface is scoped to the provider, in SQL', () => {
  /**
   * Disclosure staging answers "how much of this customer", and is only half
   * the question. The other half is "whose jobs am I even reading" — and an
   * account switch on a shared device is exactly when that half fails, because
   * the token changes while the screen does not.
   *
   * All three surfaces answer it the same way: the provider uid is a bound
   * parameter in the WHERE clause, so there is no per-account cache to clear
   * and no request shape that can widen the scope.
   */
  const SURFACES: Array<[string, string, RegExp]> = [
    ['job list / job card', 'services/technicianService.ts', /WHERE b\.worker_uid = \$1/],
    ['booking detail', 'controllers/providerController.ts', /bw\.worker_uid = \$2/],
    ['calendar', 'services/providerCalendarService.ts', /WHERE bw\.worker_uid = \$1/],
  ];

  it.each(SURFACES)('%s scopes on the provider uid', (_label, file, predicate) => {
    expect(codeOf(file)).toMatch(predicate);
  });

  it('the calendar reads the ASSIGNMENT row, not the booking pointer', () => {
    /**
     * `bookings.worker_uid` is the CURRENT provider. After a reassignment it
     * moves, so a calendar keyed on it would silently hand the incoming
     * provider the outgoing one's history — and erase the outgoing provider's
     * own past work from their calendar.
     */
    const code = codeOf('services/providerCalendarService.ts');
    expect(code).toContain('FROM ${s}.booking_workers bw');
    expect(code).toContain('JOIN ${s}.bookings b ON b.id = bw.booking_id');
  });

  it('the calendar excludes relinquished work, so it never needs a "none" level', () => {
    // The reason it is not a third staging copy: a declined or cancelled job is
    // not an appointment, so the case that would require withholding cannot
    // arise. Asserted from the status lists rather than trusted.
    const code = codeOf('services/providerCalendarService.ts');
    // Asserted on the two status lists the booking query filters by, not on the
    // whole file: `CANCELLED` also appears in the time-off query, where it means
    // a cancelled time-off request and has nothing to do with an assignment.
    const lists = code
      .split(String.fromCharCode(10))
      .filter((l: string) => /^const (CONFIRMED|AWAITING)_WORKER_STATUSES/.test(l))
      .join(' ');
    expect(lists).toContain('ACCEPTED');
    expect(lists).toContain('ASSIGNED');
    for (const relinquished of [...RELINQUISHED_WORKER_STATUSES]) {
      expect(lists).not.toContain(relinquished);
    }
    expect(code).toContain('CONFIRMED_WORKER_STATUSES');
    expect(code).toContain('AWAITING_WORKER_STATUSES');
  });

  it('no provider surface accepts a uid from the request', () => {
    // §11: ids are identifiers, not authorization. A surface that read the
    // subject from a query string would make the scoping above decorative.
    for (const [, file] of SURFACES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/req\.query\.(workerUid|providerUid|uid)/);
      expect(code).not.toMatch(/req\.body\.(workerUid|providerUid)\b/);
    }
  });
});
