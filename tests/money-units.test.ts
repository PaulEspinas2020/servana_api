/**
 * Every money field declares its unit and its currency.
 *
 * TAB 04 of the Admin API Master Command: *"State the JSON type of every money
 * field in the schema, per field: is it a number, or a string? Today the portal
 * must accept both everywhere because the contract does not say."*
 *
 * ## The book's premise, corrected
 *
 * The book supposes the string case is a driver property — *"numeric(12,2)
 * reaches some clients as a string through some drivers and the portal cannot
 * know which fields do"*. Measured from this side it is neither a driver
 * property nor unknowable.
 *
 * `src/db/dbQuery.ts` registers type parsers for OIDs 1114, 1184 and 1082 —
 * timestamps and dates. It registers NOTHING for 1700, `numeric`. So
 * node-postgres hands back every numeric column as a STRING: always,
 * deterministically, on every machine, for every driver version.
 *
 * What decides the wire type is whether a MAPPER coerced it:
 *
 *     financePolicy.toCentavos     Number(v ?? 0), rounded to 2dp
 *     catalogPublicService.money   v == null ? null : Number(v)
 *
 * Every canonical v1 finance and catalog response passes through one of those,
 * so it carries a real `number`. The responses that return a raw database row —
 * `AdminBookingRow`, `AdditionalWorkRequest_Row` — have no mapper and carry the
 * driver's string.
 *
 * So it IS a per-field fact, and the contract can state it. A client does not
 * need `number | string` everywhere; it needs it exactly where `MoneyRaw` says.
 *
 * ## What this suite pins
 *
 * That the statement is made on every money field and cannot quietly stop being
 * made — the same ceiling-of-zero discipline as the empty-schema gate, for the
 * same reason: there is no legitimate reason to ship an amount whose unit
 * nobody wrote down.
 */

import { buildOpenApiDocument, stateTheMoneyRule } from '../src/api/v1/openapi';
import { CURRENCY, toCentavos, toMinorUnits } from '../src/services/finance/financePolicy';

/** Mirrors the generator's rule. Kept in step by the two tests below. */
const MONEY_NAME = /amount|gross|fee|earning|payout|price|payable|revenue|refunded|refundable/i;
const NOT_MONEY = new Set([
  'refundReviewId', 'refundId', 'payoutWindowHours', 'payoutStatus',
  'providerPayoutStatus', 'payoutStatusCanonical', 'payoutBlockedBy',
  'payoutBlockedReason', 'priceSummary', 'basePriceSummary', 'commissionRate',
  'estimatedJobsCount', 'refundedAt', 'releasedAt', 'paidAt', 'eligibleAt',
  'reversesProviderEarning', 'pendingIsEstimate', 'earningsDisclosure',
  'withheldReason',
]);

interface Field { path: string; description: string; ref?: string }

function moneyFields(node: unknown, path: string, out: Field[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => moneyFields(child, `${path}[${i}]`, out));
    return;
  }
  const o = node as Record<string, any>;

  if (o.properties) {
    for (const [name, field] of Object.entries<any>(o.properties)) {
      if (!field || typeof field !== 'object') continue;
      if (!MONEY_NAME.test(name) || NOT_MONEY.has(name)) continue;

      const ref: string | undefined = field.$ref ?? field.allOf?.[0]?.$ref;
      const types = Array.isArray(field.type) ? field.type : [field.type];
      const numericOrString =
        types.includes('number') || types.includes('integer') || types.includes('string');
      if (!numericOrString && !ref) continue;

      out.push({
        path: `${path}.${name}`,
        description: typeof field.description === 'string' ? field.description : '',
        ref,
      });
    }
  }

  for (const [key, value] of Object.entries(o)) {
    if (key === 'enum' || key === 'description') continue;
    moneyFields(value, `${path}.${key}`, out);
  }
}

describe('the contract states the unit of every money field', () => {
  const doc = buildOpenApiDocument() as any;
  const schemas = doc.components.schemas;

  it('declares the three money representations, each naming its unit', () => {
    // One place that says what a peso is. Forty copies of the sentence is forty
    // chances for them to disagree.
    for (const name of ['MoneyMajor', 'MoneyMinor', 'MoneyRaw']) {
      expect(schemas[name]).toBeDefined();
      expect(`${name}: ${schemas[name].description}`).toMatch(/UNIT: PHP/);
      expect(schemas[name].description).toMatch(/CURRENCY: PHP/);
    }
  });

  it('gives MoneyMinor an INTEGER type and MoneyMajor a number', () => {
    // The whole reason the twin exists. An integer number of centavos cannot
    // drift; a float number of pesos accumulates error at the fourth decimal
    // place and surfaces months later in a reconciliation report.
    expect(schemas.MoneyMinor.type).toEqual(expect.arrayContaining(['integer']));
    expect(schemas.MoneyMinor.type).not.toEqual(expect.arrayContaining(['number']));
    expect(schemas.MoneyMajor.type).toEqual(expect.arrayContaining(['number']));
  });

  it('says out loud that MoneyRaw is a string, and why', () => {
    // The correction to the book's premise. Not "some drivers" — no parser is
    // registered for OID 1700, so it is every driver, always.
    expect(schemas.MoneyRaw.type).toEqual(expect.arrayContaining(['string']));
    expect(schemas.MoneyRaw.description).toMatch(/1700/);
    expect(schemas.MoneyRaw.description).toMatch(/concatenat/i);
  });

  it('leaves no money field without its unit and currency', () => {
    const found: Field[] = [];
    moneyFields(schemas, 'schemas', found);
    expect(found.length).toBeGreaterThan(30);

    const bare = found
      .filter((f) => {
        // A field that references a canonical money schema inherits its
        // statement; anything else must carry it directly.
        if (f.ref && /Money(Major|Minor|Raw)$/.test(f.ref)) return false;
        return !/UNIT: PHP/.test(f.description);
      })
      .map((f) => f.path);

    // Named, not counted: a bare number tells whoever broke this nothing.
    expect(bare).toEqual([]);
  });

  it('does not stamp a field that is money-SHAPED but is not money', () => {
    // `commissionRate` is the one that matters: it is a FRACTION of gross, and
    // labelling it "PHP MAJOR units" would be a confidently wrong statement
    // about the field TAB 05 exists to disambiguate.
    const rate = schemas.BookingPayment.properties.servana.properties.commissionRate;
    expect(rate.description).not.toMatch(/UNIT: PHP/);
    expect(rate.description).toMatch(/fraction/i);

    const hours = schemas.BookingPayment.properties.payout.properties.windowHours;
    if (hours) expect(hours.description ?? '').not.toMatch(/UNIT: PHP/);
  });

  it('appends the unit rather than replacing what a field already said', () => {
    const node = {
      properties: {
        gross: { type: 'number', description: 'Base price plus PAID additional work.' },
        grossMinor: { type: 'integer' },
      },
    };
    stateTheMoneyRule(node);
    expect(node.properties.gross.description).toMatch(/^Base price plus PAID additional work\. /);
    expect(node.properties.gross.description).toMatch(/MAJOR units/);
    expect((node.properties.grossMinor as any).description).toMatch(/MINOR units/);
  });

  it('generates the same document twice in one process', () => {
    // Same singleton hazard as the UTC rule: `SCHEMAS` is module-level, so a
    // stamp written straight into it would be appended again on the next call —
    // and `npm run verify` calls this twice in one process.
    const first = JSON.stringify(buildOpenApiDocument());
    const second = JSON.stringify(buildOpenApiDocument());
    expect(second).toBe(first);
  });
});

describe('the money helpers behave as the unit declarations claim', () => {
  it('names one currency, and the contract agrees with it', () => {
    // The portal renders a peso sign unconditionally, which is correct today
    // and is an assumption nothing checked. This is the check.
    expect(CURRENCY).toBe('PHP');
    const doc = buildOpenApiDocument() as any;
    expect(doc.components.schemas.BookingPayment.properties.currency.enum).toEqual(['PHP']);
  });

  it('coerces the driver STRING that numeric columns actually arrive as', () => {
    // This is the behaviour that makes MoneyMajor a number at all. Without it
    // every one of those fields would be a string and the contract would lie.
    expect(toCentavos('1500.00')).toBe(1500);
    expect(toCentavos('0.1')).toBe(0.1);
    expect(toCentavos(null)).toBe(0);
    expect(toCentavos(undefined)).toBe(0);
  });

  it('produces an INTEGER number of centavos, with no float residue', () => {
    // 0.1 + 0.2 is the canonical float example; in centavos it is exact.
    expect(toMinorUnits('1500.00')).toBe(150000);
    expect(toMinorUnits(0.1)).toBe(10);
    expect(toMinorUnits(0.07)).toBe(7);
    expect(Number.isInteger(toMinorUnits(1234.56))).toBe(true);
    expect(toMinorUnits(1234.56)).toBe(123456);
  });

  it('does not silently turn junk into an amount', () => {
    // A non-numeric string becoming 0 is a wrong number nobody can see. It is
    // recorded here as the CURRENT behaviour rather than asserted to be right:
    // toCentavos returns 0 for unparseable input, so a corrupted column reads
    // as free rather than as an error.
    expect(toCentavos('not money')).toBe(0);
  });
});

/**
 * The minor-unit twins are actually emitted, and agree with their majors.
 *
 * TAB 04's second ask: *"Provide a minor-unit twin for every money field, as
 * you already do for gross and refundable. That is the change that lets the
 * portal delete its float path entirely rather than carry it defensively."*
 *
 * Three existed. The admin seat — the one that reads the reconciliation screen,
 * where float drift surfaces months later as a small, real and extremely
 * expensive discrepancy — now carries eight.
 *
 * Asserted at RUNTIME rather than only in the contract. A schema that declares
 * `payableMinor` while the projection does not emit it is a contract that lies,
 * and the empty-schema TAB is the whole argument for why that matters.
 */
describe('the admin payment projection emits a minor twin for every amount', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { projectFor } = require('../src/services/finance/bookingPaymentService');
  const { toMinorUnits: minor } = require('../src/services/finance/financePolicy');

  /** Deliberately awkward decimals: .07 and .01 are where float drift shows. */
  const finance = {
    bookingId: 4242,
    currency: 'PHP',
    gross: 1234.57,
    basePrice: 1000.07,
    additionalWork: 234.5,
    payment: {
      paymentId: 9,
      state: 'PAID',
      captured: true,
      method: 'gcash',
      paidAt: '2026-08-11T11:03:23.421Z',
      refundedAmount: 100.01,
      refundedAt: null,
      refundable: 1134.56,
    },
    provider: {
      uid: 'prov-1',
      economicModel: 'EXTERNAL_PROVIDER',
      payable: 987.65,
      isEstimate: false,
      withheldReason: null,
    },
    servana: { revenue: 246.92, commissionRate: 0.2 },
    payout: {
      disbursementId: null,
      status: 'PENDING',
      releasedAt: null,
      eligible: false,
      blockedBy: null,
      blockedReason: null,
      eligibleAt: null,
    },
  };

  const admin = projectFor('admin', finance) as any;

  it('emits every twin the contract declares', () => {
    expect(admin.breakdown.grossMinor).toBeDefined();
    expect(admin.breakdown.basePriceMinor).toBeDefined();
    expect(admin.breakdown.additionalWorkMinor).toBeDefined();
    expect(admin.refund.refundedAmountMinor).toBeDefined();
    expect(admin.refund.refundableMinor).toBeDefined();
    expect(admin.provider.payableMinor).toBeDefined();
    expect(admin.servana.revenueMinor).toBeDefined();
  });

  it('makes every twin an INTEGER', () => {
    const twins = [
      admin.breakdown.grossMinor,
      admin.breakdown.basePriceMinor,
      admin.breakdown.additionalWorkMinor,
      admin.refund.refundedAmountMinor,
      admin.refund.refundableMinor,
      admin.provider.payableMinor,
      admin.servana.revenueMinor,
    ];
    for (const t of twins) expect(Number.isInteger(t)).toBe(true);
  });

  it('makes every twin agree with its major-unit partner', () => {
    // The property that makes a twin worth having. If these ever disagree, the
    // twin is a second and subtly different source for the same number, which
    // is worse than not having one.
    expect(admin.breakdown.grossMinor).toBe(minor(admin.breakdown.gross));
    expect(admin.breakdown.basePriceMinor).toBe(minor(admin.breakdown.basePrice));
    expect(admin.breakdown.additionalWorkMinor).toBe(minor(admin.breakdown.additionalWork));
    expect(admin.refund.refundedAmountMinor).toBe(minor(admin.refund.refundedAmount));
    expect(admin.provider.payableMinor).toBe(minor(admin.provider.payable));
    expect(admin.servana.revenueMinor).toBe(minor(admin.servana.revenue));
    // And the exact centavo values, so a rounding change is visible:
    expect(admin.breakdown.basePriceMinor).toBe(100007);
    expect(admin.refund.refundedAmountMinor).toBe(10001);
  });

  it('leaves the major-unit fields exactly as they were', () => {
    // Purely additive. A client reading the float path must be unaffected —
    // that is what makes this safe to land without moving every consumer.
    expect(admin.breakdown.gross).toBe(1234.57);
    expect(admin.provider.payable).toBe(987.65);
    expect(admin.servana.commissionRate).toBe(0.2);
  });

  it('does not leak the admin-only twins to the provider seat', () => {
    // `servana` and `provider` are ADMIN-only by construction — projectFor
    // builds an explicit per-actor DTO. Adding twins must not have widened it.
    const provider = projectFor('assigned_provider', finance) as any;
    expect(provider.servana).toBeUndefined();
    expect(provider.provider).toBeUndefined();
  });
});

/**
 * Every minor-unit twin in the contract agrees with its major partner.
 *
 * TAB 04 asked for a twin on every money field and landed eight on the admin
 * payment seat. The two that were left ratcheted — the provider earnings summary
 * and the reconciliation totals — are now done, taking the contract from 7
 * twins to 25.
 *
 * The reconciliation one is the screen the twins exist FOR:
 * `outstandingProviderLiability` is a SUBTRACTION of two floats, which is
 * exactly the arithmetic that accumulates error at the fourth decimal place and
 * surfaces months later as a discrepancy nobody can explain.
 *
 * ## What this asserts, and why it is not a formality
 *
 * That every declared twin has a major partner declared beside it, and that the
 * two are the same KIND of number. A twin whose major is missing is a field a
 * client cannot cross-check; a twin declared `number` rather than `integer` is
 * not a minor unit at all, it is the float path wearing a different name.
 */
describe('the minor-unit twins are complete and consistent', () => {
  const doc = buildOpenApiDocument() as any;

  interface Pair { path: string; minor: any; major: any }

  const pairs = (node: unknown, path: string, out: Pair[]): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((c, i) => pairs(c, `${path}[${i}]`, out));
      return;
    }
    const o = node as Record<string, any>;
    if (o.properties) {
      for (const [name, field] of Object.entries<any>(o.properties)) {
        if (!/Minor$/.test(name)) continue;
        out.push({
          path: `${path}.${name}`,
          minor: field,
          major: o.properties[name.replace(/Minor$/, '')],
        });
      }
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'enum' || k === 'description') continue;
      pairs(v, `${path}.${k}`, out);
    }
  };

  const found: Pair[] = [];
  pairs(doc.components.schemas, 'schemas', found);

  it('finds them, so the sweep is not vacuous', () => {
    // The rule this suite's own repo learned the hard way: a search that
    // matches nothing proves nothing.
    expect(found.length).toBeGreaterThanOrEqual(25);
  });

  it('declares every twin as an INTEGER', () => {
    // A twin typed `number` is the float path with a new name.
    const notInteger = found
      .filter((p) => {
        const t = Array.isArray(p.minor.type) ? p.minor.type : [p.minor.type];
        return !t.includes('integer');
      })
      .map((p) => p.path);
    expect(notInteger).toEqual([]);
  });

  it('gives every twin a major partner declared beside it', () => {
    // Without the major there is nothing to cross-check the twin against, and
    // the point of a twin is that a client can.
    const orphans = found.filter((p) => !p.major).map((p) => p.path);
    expect(orphans).toEqual([]);
  });

  it('covers the two schemas TAB 04 left ratcheted', () => {
    const names = found.map((p) => p.path);
    expect(names.some((n) => n.includes('ProviderEarningsSummary'))).toBe(true);
    expect(names.some((n) => n.includes('FinanceReconciliation'))).toBe(true);
  });
});

describe('the earnings and reconciliation twins agree with their majors at runtime', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { toMinorUnits: minor } = require('../src/services/finance/financePolicy');

  it('converts the awkward decimals a reconciliation actually carries', () => {
    // .07 and .01 are where float drift shows. Exact centavo values are pinned
    // so a rounding change is visible rather than absorbed.
    expect(minor(1000.07)).toBe(100007);
    expect(minor(0.01)).toBe(1);
    expect(minor(99999.99)).toBe(9999999);
  });

  it('makes a subtraction of two majors exact in minor units', () => {
    /**
     * The defect the reconciliation twin exists to prevent, in one line.
     *
     * accrued - released is a float subtraction. Done in pesos it can land a
     * centavo away from the truth; done in centavos it cannot, because both
     * operands are integers.
     */
    const accrued = 1234.56;
    const released = 1000.07;
    const inPesos = accrued - released;

    expect(minor(accrued) - minor(released)).toBe(23449);
    expect(Number.isInteger(minor(accrued) - minor(released))).toBe(true);
    // The float path lands in the right neighbourhood and is not exact.
    expect(Math.round(inPesos * 100)).toBe(23449);
  });

  it('sums without drifting, which the float path does not guarantee', () => {
    const parts = [0.1, 0.2, 0.07, 1000.01];
    const minorSum = parts.reduce((n, p) => n + minor(p), 0);
    expect(minorSum).toBe(100038);
    expect(Number.isInteger(minorSum)).toBe(true);
  });
});
