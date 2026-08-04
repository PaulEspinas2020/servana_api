import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Command 6 §1 — operational access has exactly ONE writer.
 *
 * `account_status = 'active'` is what `requireActiveProvider` checks, so
 * whatever writes it decides who may work. It used to have two writers:
 *
 *   1. the admin approve path — an explicit decision, readiness re-checked
 *   2. providerAutoOnlineEngine.applyAutoOnline — a completeness calculation
 *      that excluded suspended/blocked/rejected/deactivated/deleted but NOT
 *      `pending` or `under_review`, so it promoted providers nobody had
 *      reviewed
 *
 * Two writers meant no authority, and the derived one granted access §1
 * forbids granting. Both now route through the ACTIVE transition in
 * providerActivationService, which re-checks requirements immediately before
 * writing and refuses a provider actor outright.
 *
 * This test exists because that is easy to undo by accident. A future service
 * needing "make this provider active" will reach for an UPDATE unless
 * something objects.
 */

const SRC = join(__dirname, '..', 'src');

/** The one file permitted to grant operational access outright. */
const AUTHORISED_GRANTOR = 'services/providerActivationService.ts';

/**
 * A documented exception, not an oversight.
 *
 * `updateProviderAccountStatus` is an admin override — support needs a way to
 * correct an account without walking the whole review flow. It is allowed to
 * write the field, but it must keep the activation dimension in step, or the
 * two sources of truth diverge and the account-state endpoint has to arbitrate
 * between them. The second assertion below enforces that.
 */
const DOCUMENTED_OVERRIDE = 'services/adminProviderService.ts';

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
  );

/** Strip comments so prose explaining the rule does not trip the rule. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('operational access has a single grantor', () => {
  const offenders: string[] = [];

  beforeAll(() => {
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      if (rel === AUTHORISED_GRANTOR || rel === DOCUMENTED_OVERRIDE) continue;

      const code = stripComments(readFileSync(file, 'utf8'));

      // Only WRITES count. `WHERE account_status = 'active'` is a read filter
      // and appears legitimately in dashboards, eligibility queries and supply
      // reports — an earlier version of this test flagged five of those and was
      // simply wrong.
      const literalWrite = /SET\s+account_status\s*=\s*'(active|approved)'/i;

      // A parameterised write to user_credentials can smuggle 'active' through
      // at runtime, so it counts too.
      const parameterisedWrite =
        /UPDATE[^;]*user_credentials[\s\S]{0,200}?SET\s+account_status\s*=\s*\$/i;

      if (literalWrite.test(code) || parameterisedWrite.test(code)) {
        offenders.push(rel);
      }
    }
  });

  it('no service other than providerActivationService writes an active status', () => {
    expect(offenders).toEqual([]);
  });

  it('the documented override keeps the activation dimension in step', () => {
    // Permitted to write the field, but not permitted to let the two sources of
    // truth drift apart.
    const code = readFileSync(join(SRC, DOCUMENTED_OVERRIDE), 'utf8');
    expect(code).toMatch(/transitionActivation\(/);
    expect(code).toMatch(/admin_override:/);
  });

  it('the authorised grantor really does contain the write', () => {
    // A guard that passes because it is looking in the wrong place proves
    // nothing. Pin that the permitted writer still exists.
    const code = stripComments(
      readFileSync(join(SRC, AUTHORISED_GRANTOR), 'utf8')
    );
    expect(code).toMatch(/account_status\s*=\s*'active'/i);
  });

  it('the grantor only writes it under the ACTIVE transition', () => {
    // Comments stripped first: this file's own header explains the rule and
    // quotes the very string being searched for, so an unstripped search finds
    // the prose rather than the code.
    const code = stripComments(readFileSync(join(SRC, AUTHORISED_GRANTOR), 'utf8'));

    const writeIdx = code.search(/account_status\s*=\s*'active'/i);
    const guardIdx = code.search(/if \(to === ["']ACTIVE["']\)/);

    expect(writeIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    // The write must sit after the guard, not on an unconditional path.
    expect(guardIdx).toBeLessThan(writeIdx);
  });
});
