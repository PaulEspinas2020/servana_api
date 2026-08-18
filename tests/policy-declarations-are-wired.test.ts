/**
 * Declared policy must be wired to something, or acknowledged as inert.
 *
 * ## The failure class
 *
 * This repository declares its rules as exported constants — capability lists,
 * field sets, seat vocabularies — and generates documents from them. That is a
 * good pattern, and it has one failure mode: a constant that reads as
 * architecture, is quoted in a certification, and is wired to nothing. It cannot
 * be wrong, because nothing consults it.
 *
 * TABs 13 and 14 each carried a version of this, and both were real: five
 * capabilities named a domain module no endpoint reached, and a security matrix
 * documented itself as asserted against the router when it was not.
 *
 * ## What this asserts
 *
 * Every exported const in the policy modules either has a CONSUMER — src, tests
 * or scripts, outside its own declaration — or appears in `INERT` below with a
 * reason. Adding an unused one fails the build until somebody decides which it
 * is.
 *
 * `INERT` is not an allow-list to grow. It is a debt register with eight entries
 * and a note beside each saying what wiring it would mean.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');

const POLICY_MODULES = [
  'src/services/booking/experiencePolicy.ts',
  'src/services/messaging/messagingPolicy.ts',
  'src/services/account/accountPolicy.ts',
  'src/services/home/homePolicy.ts',
  'src/services/reviews/reviewPolicy.ts',
  'src/services/finance/financePolicy.ts',
];

/**
 * Declared, consumed by nothing, deliberately kept — with what it would take to
 * make each one load-bearing.
 */
const INERT: Record<string, string> = {
  MESSAGING_CAPABILITY_KEYS:
    'Capability keys for the messaging registry. Wiring means asserting the ' +
    'federated registry in convergence.ts covers exactly these.',
  ACCOUNT_CAPABILITY_KEYS:
    'Capability keys for the account registry; same wiring as the messaging one.',
  HOME_CAPABILITY_KEYS:
    'Capability keys for the home registry; same wiring as the messaging one.',
  REVIEW_CAPABILITY_KEYS:
    'Capability keys for the review registry; same wiring as the messaging one.',
  PROVIDER_FIELD_IDS:
    'The provider-profile field vocabulary. Wiring means asserting the provider ' +
    'profile DTO exposes exactly these ids.',
  SETTINGS_GROUPS:
    'How settings are grouped for display. Wiring means asserting every declared ' +
    'setting belongs to exactly one group.',
  RATING_SUMMARY_FIELDS:
    'The fields a rating summary carries. Wiring means asserting the summary DTO ' +
    'matches — the highest-value of these eight, because a summary that silently ' +
    'drops a field is a visible product regression.',
  failsRequest:
    'A home-composition predicate for partial failure. Wiring means using it in ' +
    'the composition path instead of the inline check that replaced it.',
};

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && full.endsWith('.ts') ? [full] : [];
  });

const CORPUS = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'tests')),
  ...walk(path.join(ROOT, 'scripts')),
].map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));

describe('policy declarations are wired to something', () => {
  const exportsOf = (mod: string): string[] => {
    const text = fs.readFileSync(path.join(ROOT, mod), 'utf8');
    return [...text.matchAll(/^export (?:const|function|async function) ([A-Za-z_]\w*)/gm)]
      .map((m) => m[1]);
  };

  it('finds policy exports at all (positive fixture)', () => {
    // A broken regex would find none and pass everything below forever.
    const total = POLICY_MODULES.reduce((n, m) => n + exportsOf(m).length, 0);
    expect(total).toBeGreaterThan(100);
  });

  it('every export has a consumer, or is a named INERT entry', () => {
    const unaccounted: string[] = [];

    for (const mod of POLICY_MODULES) {
      const own = path.join(ROOT, mod);
      for (const name of exportsOf(mod)) {
        if (name in INERT) continue;
        const consumed = CORPUS.some(
          ({ file, text }) => file !== own && new RegExp(String.raw`\b${name}\b`).test(text),
        );
        // A policy module may also legitimately use its own export internally —
        // `isDisputeCategory` is called by `evaluateDisputeOpening` beside it.
        const usedInModule =
          (fs.readFileSync(own, 'utf8').match(new RegExp(String.raw`\b${name}\b`, 'g')) ?? []).length > 1;
        if (!consumed && !usedInModule) unaccounted.push(`${mod}::${name}`);
      }
    }

    expect(unaccounted).toEqual([]);
  });

  it('every INERT entry says what wiring it would mean', () => {
    // A register of names with no reasons is the same problem in a shape that
    // passes the check above.
    for (const [name, why] of Object.entries(INERT)) {
      expect(name).toMatch(/^[A-Za-z_]\w*$/);
      expect(why.length).toBeGreaterThan(50);
    }
  });

  it('INERT does not list something that IS consumed', () => {
    /**
     * The register must shrink as things get wired, not linger. If a name here
     * gains a consumer, this fails and the entry comes out — otherwise the debt
     * register slowly becomes fiction.
     */
    const stillInert = Object.keys(INERT).filter((name) => {
      const declaring = POLICY_MODULES.map((m) => path.join(ROOT, m)).find((f) =>
        new RegExp(String.raw`^export (?:const|function) ${name}\b`, 'm').test(fs.readFileSync(f, 'utf8')),
      );
      const consumed = CORPUS.some(
        ({ file, text }) =>
          file !== declaring && file !== __filename && new RegExp(String.raw`\b${name}\b`).test(text),
      );
      return consumed;
    });
    expect(stillInert).toEqual([]);
  });
});
