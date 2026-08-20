/**
 * Every rate and percentage declares its unit and its range.
 *
 * TAB 05 of the Admin API Master Command asks a single question —
 * *"Nothing on either side says whether 0.15 means 15% or 0.15%"* — and asks for
 * two things: document the unit, and give the field a range.
 *
 * ## The answer, and what settles it
 *
 * `services/revenueSplit.ts` declares `SERVANA_COMMISSION_RATE = 0.2` and
 * `PROVIDER_SHARE_RATE = 0.8`. **The two sum to exactly 1.** That is not a
 * convention anybody has to agree to; it is arithmetic, and it settles the unit
 * beyond argument. `commissionRate` is a FRACTION. The portal's current reading
 * is correct and needs no change.
 *
 * ## Why the answer alone is not enough
 *
 * The same API carries `providerSharePercent`, a WHOLE-NUMBER PERCENT, on
 * `ProviderEarningsTransactions`. One split, two representations, 100x apart,
 * and neither NAME said which was which.
 *
 * That has already gone wrong. `providerController` records it in a comment:
 *
 *     Provider Web held its own `PROVIDER_SHARE_PERCENT = 0.80` here, a second
 *     hardcode of a number only the backend actually decides
 *
 * A constant named PERCENT holding a FRACTION, against a backend constant of
 * the same name holding 80. The book warns the portal's reading could be "wrong
 * by a factor of 100"; a client already was.
 *
 * ## The value that makes the magnitude heuristic unusable
 *
 * The book calls `rate <= 1 ? rate * 100 : rate` "ambiguous at exactly 1". That
 * is not a theoretical edge here. `financePolicy.splitFor` returns
 *
 *     commissionRate: earnsJobShare ? SERVANA_COMMISSION_RATE : 1
 *
 * so **1 is a live value** — every INTERNAL_FIXER booking carries it, because
 * Servana retains the whole gross when the provider earns no job share. Read as
 * a fraction it is 100%, which is exactly what an internal fixer means.
 */

import { buildOpenApiDocument } from '../src/api/v1/openapi';
import {
  SERVANA_COMMISSION_RATE,
  PROVIDER_SHARE_RATE,
  PROVIDER_SHARE_PERCENT,
} from '../src/services/revenueSplit';
import { splitFor } from '../src/services/finance/financePolicy';

describe('the split constants settle the unit by arithmetic', () => {
  it('sums the two shares to exactly one', () => {
    // The whole answer to TAB 05 in one line. Two numbers that sum to 1 are
    // fractions; two that sum to 100 are percentages. These sum to 1.
    expect(SERVANA_COMMISSION_RATE + PROVIDER_SHARE_RATE).toBeCloseTo(1, 10);
    expect(SERVANA_COMMISSION_RATE).toBeLessThanOrEqual(1);
    expect(PROVIDER_SHARE_RATE).toBeLessThanOrEqual(1);
  });

  it('keeps the percent representation in step with the fraction', () => {
    // The two representations are allowed to coexist. They are not allowed to
    // disagree — that is the drift a client already shipped.
    expect(PROVIDER_SHARE_PERCENT).toBe(Math.round(PROVIDER_SHARE_RATE * 100));
    expect(PROVIDER_SHARE_PERCENT).toBeGreaterThan(1);
  });
});

describe('commissionRate takes exactly the values the contract says', () => {
  it('is the commission fraction for a provider who earns a job share', () => {
    expect(splitFor('EXTERNAL_PROVIDER', 1000).commissionRate).toBe(SERVANA_COMMISSION_RATE);
  });

  it('is exactly 1 for an INTERNAL_FIXER — the value the heuristic cannot read', () => {
    /**
     * This is the finding. The book calls `rate <= 1 ? rate * 100 : rate`
     * ambiguous at exactly 1 and treats it as an edge case. It is a live value:
     * an internal fixer earns no job share, so Servana retains the whole gross
     * and the rate is 1.
     *
     * Under a fraction reading, 1 is 100% — correct. Under a magnitude
     * heuristic it is unanswerable. The unit has to be declared, not inferred.
     */
    const split = splitFor('INTERNAL_FIXER', 1000);
    expect(split.commissionRate).toBe(1);
    expect(split.providerPayable).toBe(0);
    expect(split.servanaRevenue).toBe(1000);
  });

  it('never exceeds the range the contract declares', () => {
    for (const model of ['EXTERNAL_PROVIDER', 'INTERNAL_FIXER'] as const) {
      const { commissionRate } = splitFor(model, 1234.56);
      expect(commissionRate).toBeGreaterThanOrEqual(0);
      expect(commissionRate).toBeLessThanOrEqual(1);
    }
  });

  it('splits so the two sides always add back to the gross', () => {
    // A split that disagrees with itself is a provider shown one number and
    // paid another — the defect revenueSplit was written to end.
    for (const model of ['EXTERNAL_PROVIDER', 'INTERNAL_FIXER'] as const) {
      for (const gross of [1000, 1234.56, 0.07, 99999.99]) {
        const s = splitFor(model, gross);
        expect(s.providerPayable + s.servanaRevenue).toBeCloseTo(s.gross, 2);
      }
    }
  });
});

describe('the contract declares a unit and a range for every rate', () => {
  const doc = buildOpenApiDocument() as any;
  const schemas = doc.components.schemas;

  /** Fields whose NAME says rate, percent, ratio or share. */
  const RATE_NAME = /(?:rate|percent|ratio|share)$/i;

  interface Field { path: string; field: any }

  const rateFields = (node: unknown, path: string, out: Field[]): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((c, i) => rateFields(c, `${path}[${i}]`, out));
      return;
    }
    const o = node as Record<string, any>;
    if (o.properties) {
      for (const [name, field] of Object.entries<any>(o.properties)) {
        if (!field || typeof field !== 'object') continue;
        const types = Array.isArray(field.type) ? field.type : [field.type];
        if (!RATE_NAME.test(name)) continue;
        if (!types.includes('number') && !types.includes('integer')) continue;
        out.push({ path: `${path}.${name}`, field });
      }
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'enum' || k === 'description') continue;
      rateFields(v, `${path}.${k}`, out);
    }
  };

  const found: Field[] = [];
  rateFields(schemas, 'schemas', found);

  it('finds the rate fields rather than assuming there are none', () => {
    // A detector matching nothing proves nothing.
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        'schemas.BookingPayment.properties.servana.commissionRate',
        'schemas.ProviderEarningsTransactions.items.providerSharePercent',
        'schemas.ProfileCompletion.percent',
      ]),
    );
  });

  it('gives every rate field an explicit minimum and maximum', () => {
    // TAB 05's second ask. A range turns the portal's out-of-range marker from
    // a guess into a contract violation.
    const unbounded = found
      .filter((f) => f.field.minimum === undefined || f.field.maximum === undefined)
      .map((f) => f.path);
    expect(unbounded).toEqual([]);
  });

  it('makes every rate field say FRACTION or PERCENT in words', () => {
    // The name does not say it and cannot be trusted to: PROVIDER_SHARE_PERCENT
    // held 0.80 in a client. The description has to.
    const silent = found
      .filter((f) => !/FRACTION|PERCENT/i.test(f.field.description ?? ''))
      .map((f) => f.path);
    expect(silent).toEqual([]);
  });

  it('declares commissionRate as a fraction bounded by one', () => {
    const rate = schemas.BookingPayment.properties.servana.properties.commissionRate;
    expect(rate.minimum).toBe(0);
    expect(rate.maximum).toBe(1);
    expect(rate.description).toMatch(/FRACTION/i);
    // And that the live value of 1 is named, so nobody rediscovers it.
    expect(rate.description).toMatch(/INTERNAL_FIXER/);
  });

  it('declares providerSharePercent as a percent bounded by a hundred', () => {
    // Looked up through the detector rather than by a literal path: the schema
    // nests through `items`, and a hand-written path is exactly the kind of
    // thing that rots silently when a shape moves.
    const pct = found.find((f) => f.path.endsWith('.providerSharePercent'))!.field;
    expect(pct.minimum).toBe(0);
    expect(pct.maximum).toBe(100);
    expect(pct.description).toMatch(/PERCENT/i);
    // The two representations are named against each other, so a reader of one
    // is told the other exists and differs.
    expect(pct.description).toMatch(/commissionRate/);
  });
});
