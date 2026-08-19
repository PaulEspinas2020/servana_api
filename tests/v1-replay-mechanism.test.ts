/**
 * The replay invariant, made checkable (TAB 13).
 *
 * `replayGuard` is prose and must stay prose — a reviewer needs the reasoning.
 * What it cannot do is fail a build. The Master Command records that an attempt
 * to build this gate from the prose flagged **10 of 11 entries wrongly**, and the
 * strings show exactly why: `auth.login` and `bookings.payments.intent` both
 * contain "Idempotency-Key" and NEITHER honours a client-supplied one.
 *
 * `replayMechanism` is the same guarantee in a closed vocabulary. These tests are
 * what stop the two drifting apart on the one axis a machine can settle: whether
 * the handler that serves an entry actually reads the header.
 */

import fs from 'fs';
import path from 'path';
import { V1_CONTRACT, ContractEntry, ReplayMechanism } from '../src/api/v1/contract';
import { IDEMPOTENCY_HEADER } from '../src/api/v1/envelope';

import { handlers as catalogHandlers } from '../src/api/v1/domains/catalog';
import { handlers as identityHandlers } from '../src/api/v1/domains/identity';
import { handlers as bookingHandlers } from '../src/api/v1/domains/bookings';
import { handlers as providerJobHandlers } from '../src/api/v1/domains/providerJobs';
import { handlers as notificationHandlers } from '../src/api/v1/domains/notifications';
import { handlers as reviewHandlers } from '../src/api/v1/domains/reviews';
import { handlers as settingsHandlers } from '../src/api/v1/domains/settings';
import { handlers as authHandlers } from '../src/api/v1/domains/auth';
import { handlers as bookingActionHandlers } from '../src/api/v1/domains/bookingActions';
import { handlers as bookingExperienceHandlers } from '../src/api/v1/domains/bookingExperiences';
import { handlers as financeHandlers } from '../src/api/v1/domains/finance';
import { handlers as conversationHandlers } from '../src/api/v1/domains/conversations';
import { handlers as accountHandlers } from '../src/api/v1/domains/account';
import { handlers as homeHandlers } from '../src/api/v1/domains/home';
import { handlers as adminBookingHandlers } from '../src/api/v1/domains/adminBookings';
import { handlers as adminFinanceHandlers } from '../src/api/v1/domains/adminFinance';

/** Entry id -> the domain module that serves it. */
const MODULES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['catalog', catalogHandlers], ['identity', identityHandlers], ['bookings', bookingHandlers],
  ['providerJobs', providerJobHandlers], ['notifications', notificationHandlers],
  ['reviews', reviewHandlers], ['settings', settingsHandlers], ['auth', authHandlers],
  ['bookingActions', bookingActionHandlers], ['bookingExperiences', bookingExperienceHandlers],
  ['finance', financeHandlers], ['conversations', conversationHandlers],
  ['account', accountHandlers], ['home', homeHandlers],
  ['adminBookings', adminBookingHandlers], ['adminFinance', adminFinanceHandlers],
];

const moduleOf = (id: string): string | null => {
  for (const [name, handlers] of MODULES) if (Object.prototype.hasOwnProperty.call(handlers, id)) return name;
  return null;
};

const DOMAIN_DIR = path.resolve(__dirname, '..', 'src', 'api', 'v1', 'domains');
const sourceOf = (moduleName: string): string =>
  fs.readFileSync(path.join(DOMAIN_DIR, `${moduleName}.ts`), 'utf8');

/** Domain modules whose source reads the caller's Idempotency-Key header. */
const modulesReadingTheHeader = (): string[] =>
  MODULES.map(([n]) => n).filter((n) => /\breadIdempotencyKey\s*\(/.test(sourceOf(n)));

const ALL: ContractEntry[] = V1_CONTRACT as unknown as ContractEntry[];
const nonIdempotent = ALL.filter((e) => e.idempotent !== true);
const declaring = (m: ReplayMechanism): ContractEntry[] =>
  nonIdempotent.filter((e) => (e.replayMechanism ?? []).includes(m));

const VOCABULARY: readonly ReplayMechanism[] = [
  'client-idempotency-key', 'processor-idempotency-key', 'client-request-id', 'unique-constraint',
  'upsert-primary-key', 'state-predicate', 'state-machine', 'advisory-lock', 'row-lock',
  'single-use-token', 'external-authority', 'rate-limit', 'arithmetic-ceiling', 'none-accepted',
];

describe('every non-idempotent entry declares HOW a replay is stopped', () => {
  it('finds non-idempotent entries at all (positive fixture)', () => {
    // A contract that failed to load would make every assertion below vacuous.
    expect(ALL.length).toBeGreaterThan(100);
    expect(nonIdempotent.length).toBeGreaterThan(30);
  });

  it('each one names at least one mechanism', () => {
    const bare = nonIdempotent.filter((e) => !(e.replayMechanism ?? []).length).map((e) => e.id);
    expect(bare).toEqual([]);
  });

  it('an idempotent entry names none — the field would be a claim about nothing', () => {
    const stray = ALL.filter((e) => e.idempotent === true && (e.replayMechanism ?? []).length).map((e) => e.id);
    expect(stray).toEqual([]);
  });

  it('every value is in the closed vocabulary', () => {
    // TypeScript settles this for TS callers; the contract is also read by
    // generators and by .js tests, where the union is not enforced.
    const unknown = nonIdempotent.flatMap((e) =>
      (e.replayMechanism ?? []).filter((m) => !VOCABULARY.includes(m)).map((m) => `${e.id}: ${m}`),
    );
    expect(unknown).toEqual([]);
  });

  it('"none-accepted" is exclusive — it cannot sit beside a mechanism that does guard', () => {
    const contradictory = declaring('none-accepted')
      .filter((e) => (e.replayMechanism ?? []).length > 1)
      .map((e) => `${e.id}: ${(e.replayMechanism ?? []).join(', ')}`);
    expect(contradictory).toEqual([]);
  });
});

describe('a declared client key is a key the handler actually reads', () => {
  it('the set of domain modules reading the header is pinned', () => {
    // Two, and both deliberate: bookingActions is the shared factory for the job
    // actions and cancel; bookingExperiences reads it directly for otp.verify.
    // A third appearing here is a real change, not an accident.
    expect(modulesReadingTheHeader().sort()).toEqual(['bookingActions', 'bookingExperiences']);
  });

  it('every entry declaring client-idempotency-key is served by a module that reads it', () => {
    const readers = new Set(modulesReadingTheHeader());
    const liars = declaring('client-idempotency-key')
      .map((e) => ({ id: e.id, module: moduleOf(e.id) }))
      .filter((x) => !x.module || !readers.has(x.module));
    expect(liars).toEqual([]);
  });

  /**
   * The other direction is PINNED, not derived, and the difference matters.
   *
   * The obvious reverse check — "every entry served by a header-reading module
   * declares the mechanism" — is unsound at module granularity, and saying so is
   * cheaper than discovering it later: `bookingExperiences` serves six entries
   * and reads the header for exactly one of them. Written that way this test
   * failed on `bookings.otp.request`, `bookings.reschedule`,
   * `bookings.additionalWork.create` and `bookings.disputes.open`, none of which
   * is a defect. Resolving per-HANDLER rather than per-module would settle it
   * honestly; a list settles it today without a false positive.
   */
  it('the entries claiming a client key are exactly these nine', () => {
    expect(declaring('client-idempotency-key').map((e) => e.id).sort()).toEqual([
      'bookings.cancel',
      'bookings.otp.verify',
      'provider.jobs.accept',
      'provider.jobs.arrived',
      'provider.jobs.cancel',
      'provider.jobs.complete',
      'provider.jobs.decline',
      'provider.jobs.enroute',
      'provider.jobs.start',
    ]);
  });

  it('a processor key is never confused with a client key', () => {
    // bookings.payments.intent derives a key for PayMongo from the payment row
    // and its attempt counter. It does not read the caller's. Declaring both
    // would restate the exact conflation that made the prose gate unusable.
    const both = declaring('processor-idempotency-key')
      .filter((e) => (e.replayMechanism ?? []).includes('client-idempotency-key'))
      .map((e) => e.id);
    expect(both).toEqual([]);
  });
});

describe('one header name, read in one place', () => {
  it('the constant is the only spelling of it in src/', () => {
    // The Master Command records this invariant as MEASURED and NOT GUARDED.
    // A competing literal is how a client discovers per-endpoint that its key
    // was ignored: the header it sent was read under a different spelling.
    const SRC = path.resolve(__dirname, '..', 'src');
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const full = path.join(dir, d.name);
        return d.isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
      });
    const offenders: string[] = [];
    for (const abs of walk(SRC)) {
      const rel = path.relative(path.resolve(__dirname, '..'), abs);
      const src = fs.readFileSync(abs, 'utf8');
      src.split('\n').forEach((line, i) => {
        const trimmed = line.trim();
        // Prose is not a competing spelling. Several docblocks discuss the header.
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
        // Only an INBOUND read counts. `"Idempotency-Key": …` inside a request
        // sent to PayMongo is the processor's key travelling OUTWARD — a
        // different header on a different request, and correct. Flagging those
        // is how this gate would earn the deletion the TAB 13 refusal warns of:
        // written without this line it reported six offenders, none real.
        if (!/(req|request)\s*\.\s*(get|header)\s*\(|headers\s*\[/.test(line)) return;
        if (!/['"`]idempotency-key['"`]/i.test(line)) return;
        if (rel === 'src/api/v1/envelope.ts') return; // the one definition's own read
        offenders.push(`${rel}:${i + 1}  ${trimmed.slice(0, 80)}`);
      });
    }
    expect(offenders).toEqual([]);
    expect(IDEMPOTENCY_HEADER).toBe('idempotency-key');
  });
});
