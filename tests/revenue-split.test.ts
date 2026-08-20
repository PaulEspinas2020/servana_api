/**
 * The revenue split is a single business rule: 80% provider, 20% Servana, on all
 * platform revenue — base booking, transport fee and paid additional work alike.
 *
 * It used to be a bare float duplicated across twelve sites in four files. Two of
 * those were the authoritative payout path and the rest were display, and nothing
 * forced them to agree. A split that disagrees with itself is not a rounding
 * problem: it is a provider shown one number and paid another.
 */

import fs from 'fs';
import path from 'path';
import {
  splitRevenue,
  providerShareOf,
  servanaShareOf,
  PROVIDER_SHARE_RATE,
  SERVANA_COMMISSION_RATE,
  PROVIDER_SHARE_PERCENT,
} from '../src/services/revenueSplit';

describe('the rule', () => {
  test('is 80 / 20', () => {
    expect(PROVIDER_SHARE_RATE).toBe(0.8);
    expect(SERVANA_COMMISSION_RATE).toBe(0.2);
    expect(PROVIDER_SHARE_PERCENT).toBe(80);
  });

  test('the two rates account for the whole amount', () => {
    expect(PROVIDER_SHARE_RATE + SERVANA_COMMISSION_RATE).toBeCloseTo(1, 10);
  });
});

describe('splitRevenue', () => {
  test('splits a plain amount', () => {
    expect(splitRevenue(600)).toEqual({
      totalAmount: 600,
      servanaShare: 120,
      providerShare: 480,
    });
  });

  test('the shares always add back to the total exactly', () => {
    // The provider share is derived by subtraction rather than a second
    // multiplication. Rounding both independently can leave a stray centavo
    // that reconciliation then has to explain.
    for (const gross of [0, 0.01, 1, 3.33, 10.05, 99.99, 600, 1234.56, 87654.21]) {
      const { totalAmount, servanaShare, providerShare } = splitRevenue(gross);
      expect(Math.round((servanaShare + providerShare) * 100) / 100).toBe(totalAmount);
    }
  });

  test('rounds to centavos, not to fractions of one', () => {
    const { servanaShare, providerShare } = splitRevenue(33.33);
    expect(servanaShare).toBe(6.67);
    expect(providerShare).toBe(26.66);
  });

  test('a transport fee is provider revenue like any other', () => {
    // Providers are paid 80% of the transport fee too — Servana retains 20% of
    // it. That is the stated rule; this test exists so the behaviour is a
    // decision on the record rather than an accident of where the fee is added.
    const base = providerShareOf(600);
    const withTransport = providerShareOf(600 + 500);
    expect(withTransport - base).toBe(400); // 80% of 500
  });

  test('handles junk without throwing', () => {
    expect(splitRevenue(NaN as unknown as number).totalAmount).toBe(0);
    expect(providerShareOf(undefined as unknown as number)).toBe(0);
    expect(servanaShareOf(null as unknown as number)).toBe(0);
  });
});

describe('nothing else defines the rate', () => {
  /**
   * The predicate, extracted so the detector can be tested against known input.
   *
   * It used to be inline, which meant the only assertion over it was
   * `expect(offenders).toEqual([])` — and that passes just as well when the
   * pattern has stopped matching as when nothing violates it. A detector cannot
   * distinguish "no violations" from "I am broken" unless something feeds it a
   * violation on purpose.
   */
  const HARDCODED_RATE = (line: string): boolean => {
    const stripped = line.replace(/\/\/.*/, '').replace(/--.*/, '');
    return /\*\s*0\.8\b|\*\s*0\.20\b|0\.80\b|Percent:\s*80\b/.test(stripped);
  };

  test('the detector still recognises a hardcoded rate — positive fixtures', () => {
    // Every shape the pattern is meant to catch, so a refactor that quietly
    // breaks it fails HERE rather than by reporting a clean sweep.
    expect(HARDCODED_RATE('const share = gross * 0.8;')).toBe(true);
    expect(HARDCODED_RATE('const cut = gross * 0.20;')).toBe(true);
    expect(HARDCODED_RATE('const RATE = 0.80;')).toBe(true);
    expect(HARDCODED_RATE('providerSharePercent: 80,')).toBe(true);
  });

  test('and does NOT flag the things it must leave alone — negative fixtures', () => {
    // A detector with only positive fixtures is a detector nobody can trust to
    // stay quiet. These are the shapes that must not trip it.
    expect(HARDCODED_RATE('const share = gross * PROVIDER_SHARE_RATE;')).toBe(false);
    expect(HARDCODED_RATE('// the split is 0.80 of gross')).toBe(false);
    expect(HARDCODED_RATE('const timeoutMs = 800;')).toBe(false);
    expect(HARDCODED_RATE('const ratio = total * 0.85;')).toBe(false);
  });

  test('no live source file hardcodes 0.8 / 0.2 / 80%', () => {
    const SRC = path.join(__dirname, '..', 'src');
    const offenders: string[] = [];
    let scanned = 0;

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name === 'revenueSplit.ts') continue;

        scanned += 1;
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (HARDCODED_RATE(line)) {
            offenders.push(`${path.relative(SRC, p)}:${i + 1}  ${line.trim()}`);
          }
        });
      }
    };
    walk(SRC);

    /**
     * The sweep must have SWEPT something.
     *
     * `expect(offenders).toEqual([])` is an absence assertion over a collection
     * this function built. If the walk visited no files — a moved directory, a
     * changed extension, an exclusion that grew too wide — the collection is
     * empty for the wrong reason and the assertion passes anyway.
     */
    expect(scanned).toBeGreaterThan(100);

    expect(offenders).toEqual([]);
  });
});
