/**
 * TAB 12 — the secret scan, proven to FIRE and proven not to cry wolf.
 *
 * A detector with only negative fixtures ("the repo is clean") passes just as
 * well when it is broken. Every rule below is driven with a positive case that
 * MUST be caught and a negative case that must NOT be, because the two failure
 * modes have different costs: a miss leaks a credential, a false positive gets
 * the scanner switched off and then leaks a credential.
 *
 * The fixtures here are deliberately secret-SHAPED, which is why this file is on
 * the scanner's own exempt list. None of them is a real credential: the keys are
 * structurally valid and cryptographically meaningless.
 */

import {
  SECRET_RULES,
  SCAN_EXEMPT,
  scanText,
  scanRepository,
  looksLikePlaceholder,
  isExempt,
} from '../scripts/scan-secrets';
import path from 'path';

const rules = (text: string) => scanText('fixture.ts', text).map((f) => f.rule);

describe('every rule catches what it is for', () => {
  const positives: Array<[string, string]> = [
    ['private-key-block', 'const k = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----`;'],
    ['private-key-block', '-----BEGIN RSA PRIVATE KEY-----'],
    ['firebase-service-account', '{ "type": "service_account", "project_id": "servana-59bee" }'],
    ['paymongo-live-key', 'const key = "sk_live_aB3dE5fG7hJ9kL1mN3pQ5rS7";'],
    ['paymongo-test-key', 'const key = "sk_test_aB3dE5fG7hJ9kL1mN3pQ5rS7";'],
    ['google-api-key', 'const k = "AIzaSyC1234567890abcdefghijklmnopqrstuv";'],
    ['aws-access-key-id', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLQ'],
    ['slack-token', 'const t = "xoxb-1234567890-abcdefghij";'],
    ['postgres-url-with-password', 'postgres://admin:hunter2hunter2@db.example.com:5432/servana'],
  ];

  for (const [rule, sample] of positives) {
    it(`catches ${rule}`, () => {
      expect(rules(sample)).toContain(rule);
    });
  }

  it('every declared rule has a positive case here', () => {
    // Otherwise a rule can be added, never exercised, and quietly never match.
    const covered = new Set(positives.map(([r]) => r));
    for (const rule of SECRET_RULES) {
      expect(covered.has(rule.name)).toBe(true);
    }
  });
});

describe('it does not cry wolf', () => {
  const negatives: Array<[string, string]> = [
    ['env reference, not a value', 'const key = process.env.PAYMONGO_SECRET_KEY;'],
    ['a variable named like a secret', 'const apiKey = config.apiKey;'],
    ['a local CI database', 'run: npm run db:verify -- --live=postgres://admin:ci-not-a-secret@localhost:5432/x'],
    ['a 127.0.0.1 database', 'postgresql://admin:localdev@127.0.0.1:5432/servana_staging'],
    ['a service template', '"private_key": "-----BEGIN PRIVATE KEY-----\\nREPLACE_WITH_YOUR_KEY\\n-----END PRIVATE KEY-----"'],
    ['a documented placeholder', 'DATABASE_URL=postgres://user:<YOUR_PASSWORD>@host/db'],
    ['a shell-expanded value', 'postgres://admin:${DB_PASSWORD}@prod.example.com/servana'],
    ['prose about keys', '// The Firebase service account key must never be committed.'],
  ];

  for (const [label, sample] of negatives) {
    it(`ignores ${label}`, () => {
      expect(scanText('fixture.ts', sample)).toHaveLength(0);
    });
  }
});

describe('the placeholder rule is content-based, not filename-based', () => {
  it('recognises the template markers', () => {
    expect(looksLikePlaceholder('REPLACE_ME')).toBe(true);
    expect(looksLikePlaceholder('YOUR_SECRET')).toBe(true);
    expect(looksLikePlaceholder('<your password>')).toBe(true);
    expect(looksLikePlaceholder('${DB_PASSWORD}')).toBe(true);
  });

  it('a REAL key in a file named .example is still caught', () => {
    /**
     * The point of matching on content. A `.example` suffix is a claim about a
     * file; a `REPLACE_ME` inside the value is evidence about the value. Someone
     * who pastes a live key into `serviceAccountKey.json.example` gets caught.
     */
    const real =
      '{ "type": "service_account", "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQ\\n-----END PRIVATE KEY-----" }';
    expect(scanText('servana-serviceAccountKey.json.example', real).length).toBeGreaterThan(0);
  });

  it('the placeholder window is narrow enough to not swallow a neighbour', () => {
    // A real key two lines below an unrelated placeholder must still be found.
    const mixed = [
      'const doc = "<see the docs>";',
      '',
      '',
      '',
      'const k = "sk_live_aB3dE5fG7hJ9kL1mN3pQ5rS7";',
    ].join('\n');
    expect(rules(mixed)).toContain('paymongo-live-key');
  });
});

describe('the exempt list', () => {
  it('covers the scanner and its own fixtures, and nothing else', () => {
    // Every exemption is a hole. Two, both self-referential, is the whole list.
    expect(SCAN_EXEMPT.map((e) => e.prefix).sort()).toEqual([
      'scripts/scan-secrets.ts',
      'tests/secret-scan.test.ts',
    ]);
  });

  it('every exemption states WHY', () => {
    for (const e of SCAN_EXEMPT) {
      expect(e.why.length).toBeGreaterThan(20);
    }
  });

  it('matches whole path segments, not prefixes of other names', () => {
    expect(isExempt('scripts/scan-secrets.ts')).toBe(true);
    expect(isExempt('scripts/scan-secrets-v2.ts')).toBe(false);
  });
});

describe('the repository itself is clean', () => {
  it('no tracked file carries secret-shaped content', () => {
    const findings = scanRepository(path.resolve(__dirname, '..'));
    if (findings.length) {
      // Name them, so a failure is actionable rather than a bare count.
      throw new Error(
        'Secret-shaped content in tracked files:\n' +
          findings.map((f) => `  ${f.file}:${f.line} [${f.rule}]`).join('\n'),
      );
    }
    expect(findings).toHaveLength(0);
  });
});
