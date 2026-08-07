/**
 * The price a customer is charged must come from the database, never the request.
 *
 * computeQuote summed `parts[].unit_price` straight from the caller:
 *
 *     const partsTotal = parts.reduce((s, p) => s + p.qty * p.unit_price, 0)
 *
 * Every other input was server-sourced — `base` from a service_options lookup,
 * the HP/HEIGHT/DISTANCE modifiers from pricing_modifiers scoped to the option,
 * add-ons re-priced from the DB by id. `parts` alone was taken on trust, and the
 * total flowed into quoted_price, final_price and the payments row
 * (bookingService.ts:80-104). A caller could name their own price, including a
 * negative one, and POST /api/quote answers 200 without a token.
 *
 * The `QuoteRequest` type is part of what made it look deliberate: it declared
 * `unit_price` as an input, so the code read as intended rather than as an
 * oversight. The type is gone with the behaviour.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));
jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import dbQuery from '../src/db/dbQuery';
import { computeQuote } from '../src/services/pricingService';

const q = dbQuery.query as jest.Mock;
const SRC = path.join(__dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** base lookup, then HP / HEIGHT / DISTANCE, then add-ons. */
function stubPricing(opts: { base?: number } = {}) {
  q.mockReset();
  q.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1, base_price: opts.base ?? 1000 }] });
  q.mockResolvedValue({ rowCount: 0, rows: [] });
}

describe('a caller cannot inject a price', () => {
  it('a fabricated part does not change the total', async () => {
    stubPricing({ base: 1000 });
    const quote = await computeQuote({
      optionId: 1,
      // Shape of the old exploit, passed deliberately.
      parts: [{ part_name: 'compressor', qty: 1, unit_price: 50000 }],
    } as any);
    expect(quote.final).toBe(1000);
    expect(quote.partsTotal).toBe(0);
  });

  it('a NEGATIVE part cannot discount the booking', async () => {
    // The direction that actually costs money: a caller pricing a job at zero,
    // or below, and the backend writing that to the payments row.
    stubPricing({ base: 1000 });
    const quote = await computeQuote({
      optionId: 1,
      parts: [{ part_name: 'discount', qty: 1, unit_price: -999999 }],
    } as any);
    expect(quote.final).toBe(1000);
    expect(quote.final).toBeGreaterThan(0);
  });

  it('a huge qty cannot overflow the total', async () => {
    stubPricing({ base: 1000 });
    const quote = await computeQuote({
      optionId: 1,
      parts: [{ part_name: 'x', qty: Number.MAX_SAFE_INTEGER, unit_price: 1 }],
    } as any);
    expect(quote.final).toBe(1000);
    expect(Number.isFinite(quote.final)).toBe(true);
  });

  it('parts is reported as empty rather than echoed back', async () => {
    // Echoing the caller's array would let a client render a total the server
    // never agreed to, which is the same class of bug one layer up.
    stubPricing({ base: 1000 });
    const quote = await computeQuote({
      optionId: 1,
      parts: [{ part_name: 'ghost', qty: 2, unit_price: 500 }],
    } as any);
    expect(quote.parts).toEqual([]);
  });
});

describe('server-sourced prices still work', () => {
  it('base price comes from the option lookup', async () => {
    stubPricing({ base: 3190 });
    await expect(computeQuote({ optionId: 1 } as any)).resolves.toMatchObject({
      base: 3190,
      final: 3190,
    });
    expect(q.mock.calls[0][0]).toMatch(
      /option_type='MAIN'\s+AND is_active=true/,
    );
  });

  it('modifiers are added when pricing_modifiers has a row', async () => {
    q.mockReset();
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1, base_price: 1000 }] });
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ amount: 250 }] }); // HP
    q.mockResolvedValue({ rowCount: 0, rows: [] });
    const quote = await computeQuote({ optionId: 1, hpKey: '1.5hp' } as any);
    expect(quote.modifiers.hp).toBe(250);
    expect(quote.final).toBe(1250);
  });

  it('add-ons are re-priced from the database, not from the request', async () => {
    q.mockReset();
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1, base_price: 1000 }] });
    // getModifier returns 0 without querying when its key is absent
    // (pricingService.ts:35), so with no hp/height/distance keys the add-on
    // lookup is the SECOND query, not the fifth.
    q.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 9, level_3: 'Hot Stone', base_price: 150 }],
    });
    const quote = await computeQuote({ optionId: 1, addonOptionIds: [9] } as any);
    expect(quote.addonsTotal).toBe(150);
    expect(quote.final).toBe(1150);
    expect(q.mock.calls[1][0]).toMatch(
      /option_type='ADD_ON'[\s\S]*parent_option_id=\$2[\s\S]*is_active=true/,
    );
    expect(q.mock.calls[1][1]).toEqual([[9], 1]);
  });

  it('an unknown option is rejected rather than priced at zero', async () => {
    q.mockReset();
    q.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(computeQuote({ optionId: 999999 } as any)).rejects.toThrow(
      'Invalid service option.',
    );
  });
});

describe('the shape of the fix', () => {
  const svc = read('services', 'pricingService.ts');
  const bookingSvc = read('services', 'bookingService.ts');

  it('no request-supplied price is multiplied into the total', () => {
    expect(svc).not.toMatch(/p\.qty\s*\*\s*p\.unit_price/);
    expect(svc).not.toMatch(/reduce\([^)]*unit_price/);
  });

  it('unit_price is gone from the QuoteRequest type', () => {
    // The type is what made the old code read as intentional.
    const types = fs.readFileSync(path.join(SRC, 'types', 'type.d.ts'), 'utf8');
    const iface = types.slice(
      types.indexOf('interface QuoteRequest'),
      types.indexOf('interface QuoteRequest') + 700,
    );
    expect(iface).not.toMatch(/unit_price\s*:/);
  });

  it('booking creation only resolves an active MAIN service option', () => {
    expect(bookingSvc).toMatch(
      /WHERE so\.id = \$1[\s\S]*so\.option_type = 'MAIN'[\s\S]*so\.is_active = true/,
    );
  });
});

describe('quoting stays public, but bounded', () => {
  const routes = read('routes', 'pricing.routes.ts');

  it('is NOT behind verifyAuth', () => {
    // Deliberate. The customer app's booking configuration screens are absent
    // from the router's protected list, so a signed-out customer can price a
    // job before creating an account. Adding auth here would break browsing —
    // and with prices now resolved server-side, a quote exposes nothing the
    // public catalog does not.
    expect(routes).not.toContain('verifyAuth');
  });

  it('is rate limited, because it is public and hits the database', () => {
    expect(routes).toMatch(/rateLimit\(/);
    expect(routes).toMatch(/router\.post\("\/quote",\s*quoteLimiter/);
  });
});
