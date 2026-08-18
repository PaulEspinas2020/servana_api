/**
 * Secret scan (TAB 12).
 *
 * ## Why this exists, and why it is repo-local
 *
 * TAB 12 asks for secret and dependency scans in CI. None of the three
 * workflows ran one. This repository has already lost that bet once: two
 * Firebase Admin private keys reached git history, were rotated, and the IAM
 * deletion was never confirmed. A live service-account key bypasses every
 * Firebase Security Rule, so the cost of missing one is total.
 *
 * Repo-local rather than a third-party Action, for two reasons. It runs in
 * `npm run verify` on a developer machine before a push, not only in CI — the
 * point is to catch a key BEFORE it is committed, and a GitHub Action cannot do
 * that. And pinning someone else's Action into a workflow that deploys to
 * production adds a supply chain to the thing guarding the supply chain.
 *
 * ## What it scans
 *
 * Files git TRACKS, not the working tree. An untracked `.env` is correctly
 * ignored — it is not going anywhere. What matters is what a push would carry.
 *
 * ## What it deliberately does NOT do
 *
 * It does not scan git HISTORY. Two keys are already in this repository's
 * history; a scanner that failed on them would fail every run forever and be
 * disabled within a day. History needs a rewrite or an accepted risk, and it is
 * recorded as such. This guards what goes in NEXT.
 *
 * It does not detect high-entropy strings. Entropy heuristics on a codebase
 * this size produce false positives on hashes, base64 fixtures and test
 * ids — and a detector people routinely override is worse than none.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface SecretRule {
  name: string;
  /** Why this shape is dangerous, in the failure message. */
  why: string;
  pattern: RegExp;
}

/**
 * Shapes that are credentials wherever they appear.
 *
 * Each is anchored on something structural — a key header, a provider prefix —
 * rather than on a variable NAME. `apiKey = process.env.X` is not a secret;
 * `apiKey = "sk_live_..."` is.
 */
export const SECRET_RULES: readonly SecretRule[] = Object.freeze([
  {
    name: 'private-key-block',
    why: 'a PEM private key. A Firebase service-account key bypasses every Security Rule.',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    name: 'firebase-service-account',
    why: 'a Firebase service-account JSON — it carries private_key and client_email together.',
    pattern: /"type"\s*:\s*"service_account"/,
  },
  {
    name: 'paymongo-live-key',
    why: 'a LIVE PayMongo key. It can move real money.',
    pattern: /\bsk_live_[A-Za-z0-9]{16,}/,
  },
  {
    name: 'paymongo-test-key',
    why: 'a PayMongo test key. Not money, but it is still a credential in a public artefact.',
    pattern: /\bsk_test_[A-Za-z0-9]{16,}/,
  },
  {
    name: 'google-api-key',
    why: 'a Google API key (AIza...). Billable, and often unrestricted.',
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/,
  },
  {
    name: 'aws-access-key-id',
    why: 'an AWS access key id.',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    name: 'slack-token',
    why: 'a Slack token.',
    pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}/,
  },
  {
    name: 'postgres-url-with-password',
    why: 'a PostgreSQL URL with an inline password for a REMOTE host.',
    /**
     * Deliberately excludes localhost and 127.0.0.1.
     *
     * `postgres://admin:ci-not-a-secret@localhost/...` in a CI workflow is a
     * throwaway service container that lives for one job — flagging it teaches
     * people to ignore this scanner, which is the only way it can actually
     * fail. A credential for a host someone else can reach is the real risk.
     *
     * The exclusions are followed by [:/] deliberately. An earlier `db\b` also
     * excluded `db.example.com` — a real production host — because \b matches
     * between the b and the dot. A bare docker service name is `@db:5432`; a
     * subdomain is `@db.something`, and only the first is safe to skip.
     */
    pattern:
      /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s:@/]{6,}@(?!localhost[:/]|localhost$|127\.0\.0\.1|::1|db[:/]|postgres[:/])[^\s/]+/,
  },
]);

/**
 * Paths exempt from scanning, each with the reason.
 *
 * An allowlist by PATH, never by finding: "ignore this match" invites ignoring
 * the next one too.
 */
export const SCAN_EXEMPT: ReadonlyArray<{ prefix: string; why: string }> = Object.freeze([
  {
    prefix: 'scripts/scan-secrets.ts',
    why: 'this file — it necessarily contains the patterns it looks for',
  },
  {
    prefix: 'tests/secret-scan.test.ts',
    why: 'its fixtures are deliberately secret-shaped, which is how the scanner is proven to work',
  },
]);

/**
 * Tokens that mark a line as a TEMPLATE rather than a credential.
 *
 * `servana-serviceAccountKey.json.example` carries a real private-key HEADER
 * around the text `REPLACE_WITH_YOUR_KEY`. Structurally it is a service-account
 * key; in substance it is instructions. Failing on it would mean either
 * deleting a useful template or teaching everyone to pass `--force`.
 *
 * Matched on CONTENT, not on filename. A `.example` suffix is a claim; a
 * `REPLACE_ME` in the value is evidence. Someone who pastes a real key into a
 * file called `.example` is still caught.
 */
const PLACEHOLDER = new RegExp(
  [
    'REPLACE_?ME',
    'REPLACE_?WITH',
    'YOUR[_-]?(KEY|SECRET|TOKEN|PROJECT|PASSWORD)',
    'CHANGE_?ME',
    'EXAMPLE_?KEY',
    'NOT[_-]A[_-]SECRET',
    'xxxxx',
    '<[A-Za-z_ -]+>',
    '\\$\\{[A-Za-z_]+\\}',
  ].join('|'),
  'i',
);

export const looksLikePlaceholder = (line: string): boolean => PLACEHOLDER.test(line);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.ico', '.woff', '.woff2', '.ttf', '.zip',
]);

export const trackedFiles = (cwd: string): string[] =>
  execSync('git ls-files', { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);

export const isExempt = (file: string): boolean =>
  SCAN_EXEMPT.some((e) => file === e.prefix || file.startsWith(e.prefix + '/'));

export interface Finding {
  file: string;
  line: number;
  rule: string;
  why: string;
}

/** Scan one file's text. Exported so a test can drive it without the filesystem. */
export const scanText = (file: string, text: string): Finding[] => {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  for (const rule of SECRET_RULES) {
    for (let i = 0; i < lines.length; i++) {
      if (!rule.pattern.test(lines[i])) continue;

      /**
       * A private-key HEADER and its placeholder body are usually the same
       * line in JSON (`"-----BEGIN...\nREPLACE_ME\n-----END..."`) but separate
       * lines in a PEM file. Both are checked, so a template is recognised
       * either way — and a two-line window is narrow enough that a real key
       * sitting beside an unrelated `<placeholder>` is still reported.
       */
      const neighbourhood = lines.slice(Math.max(0, i - 1), i + 3).join('\n');
      if (looksLikePlaceholder(neighbourhood)) continue;

      findings.push({ file, line: i + 1, rule: rule.name, why: rule.why });
    }
  }
  return findings;
};

export const scanRepository = (cwd: string): Finding[] => {
  const findings: Finding[] = [];
  for (const file of trackedFiles(cwd)) {
    if (isExempt(file)) continue;
    if (BINARY_EXT.has(path.extname(file).toLowerCase())) continue;
    const full = path.join(cwd, file);
    let text: string;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue; // deleted-but-tracked, or unreadable
    }
    findings.push(...scanText(file, text));
  }
  return findings;
};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const findings = scanRepository(root);

  console.log('Secret scan (TAB 12)');
  console.log(`  rules            ${SECRET_RULES.length}`);
  console.log(`  files scanned    ${trackedFiles(root).filter((f) => !isExempt(f)).length}`);
  console.log(`  findings         ${findings.length}`);

  if (findings.length) {
    console.log('');
    for (const f of findings) {
      console.log(`  ${f.file}:${f.line}  [${f.rule}]`);
      console.log(`      ${f.why}`);
    }
    console.log('');
    console.log('  A secret in a tracked file is a secret in every clone and every');
    console.log('  build artefact. Remove it, rotate the credential, and only then');
    console.log('  worry about the history.');
    process.exit(1);
  }

  console.log('');
  console.log('  No secret-shaped content in tracked files.');
  console.log('  NOTE: git HISTORY is not scanned — two Firebase keys are already in it.');
}
