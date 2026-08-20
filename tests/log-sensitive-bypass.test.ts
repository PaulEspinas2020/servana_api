/**
 * Nothing sensitive reaches a log through the 209 calls that skip the redactor.
 *
 * ## What this adds to `observability-redaction`
 *
 * That suite proves `redact()` is correct. It cannot prove `redact()` is
 * *reached*: it guards the structured request log, and `redact(` appears at
 * exactly ONE call site in `src/`. Measured 2026-08-19 there are **209**
 * `console.*` calls in `src/`, every one of which writes to the same stdout
 * without passing through the allow-list.
 *
 * Reading all 12 of those that mention sensitive vocabulary found **no leak** —
 * they log an identifierType, a uid, an error message, or the fact that an OTP
 * was sent, never the value. This test is what keeps that true, because the
 * next one is a one-line edit away and no gate was watching.
 *
 * ## Why it matches identifiers and not prose
 *
 * String literals are stripped before matching, so `"[scheduler] Sending
 * PENDING_OTP reminders"` is not a finding — it names a job, it does not carry a
 * code. What survives stripping is code: `${otp}`, `{ token }`, `phone`. That
 * distinction is the whole detector, and it is why the interpolations INSIDE a
 * template literal are deliberately kept while the surrounding text is dropped.
 *
 * A `*Type`, `*Kind`, `*Error`, `*Count`, `*Id` or `has*` suffix is not the
 * value: `identifierType: type` says which KIND of identifier was used and is
 * exactly the shape a careful author reaches for instead of the identifier.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..', 'src');

/**
 * Matched on camelCase SEGMENTS, not on whole words.
 *
 * The first version of this used /\b(otp|token|…)\b/ and a planted
 * `console.log(`code ${__probeOtp}`)` sailed straight past it: there is no word
 * boundary inside `__probeOtp`. Almost every real name for a sensitive value is
 * a compound — `accessToken`, `otpCode`, `phoneNumber`, `resetToken` — so the
 * bare-word version would have caught approximately nothing while reporting a
 * confident zero.
 */
const SENSITIVE_SEGMENTS = new Set(['otp', 'token', 'password', 'passwd', 'secret', 'phone', 'apikey', 'credential']);

/** Two-segment classes: a "signed url" is sensitive, a "url" on its own is not. */
const SENSITIVE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['signed', 'url'],
  ['preview', 'url'],
  ['document', 'id'],
  ['document', 'identifier'],
];

/**
 * Names carrying a fact ABOUT the value rather than the value. `tokenType` says
 * which kind of token; `hasToken` says whether there was one. Note `Id` is NOT
 * here — `documentId` is one of the four named classes, and exempting every
 * `*Id` would exempt it.
 */
const SAFE_SUFFIX = /(Type|Kind|Error|Count|Length|Purpose|Status|At|Sent|Expiry|ExpiresAt|Present|Missing)$/;
const SAFE_PREFIX = /^(has|is|should|can|any|no)[A-Z]/;

/** `accessToken` -> ['access','token']; `email_otp` -> ['email','otp']. */
export const segmentsOf = (identifier: string): string[] =>
  identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+|\s+/)
    .filter(Boolean)
    .map((x) => x.toLowerCase());

export const isSensitiveName = (identifier: string): boolean => {
  if (SAFE_SUFFIX.test(identifier) || SAFE_PREFIX.test(identifier)) return false;
  const seg = segmentsOf(identifier);
  if (seg.some((x) => SENSITIVE_SEGMENTS.has(x))) return true;
  return SENSITIVE_PAIRS.some(([a, b]) =>
    seg.some((x, i) => x === a && seg[i + 1] === b),
  );
};

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && full.endsWith('.ts') ? [full] : [];
  });

/** Balanced-paren slice of one call, starting at the '(' index. */
const callAt = (src: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
};

/**
 * Drop string content, KEEP `${...}` interpolations — those are code, and code
 * is what can carry a value into a log line.
 */
export const stripStrings = (code: string): string => {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === "'" || c === '"') {
      const quote = c;
      i += 1;
      while (i < code.length && code[i] !== quote) i += code[i] === '\\' ? 2 : 1;
      i += 1;
      out += '""';
      continue;
    }
    if (c === '`') {
      i += 1;
      while (i < code.length && code[i] !== '`') {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '$' && code[i + 1] === '{') {
          let depth = 0;
          const start = i + 2;
          i += 1;
          while (i < code.length) {
            if (code[i] === '{') depth += 1;
            else if (code[i] === '}') { depth -= 1; if (depth === 0) break; }
            i += 1;
          }
          out += ` ${code.slice(start, i)} `;
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
};

export interface Bypass { file: string; line: number; identifier: string; text: string }

export const sensitiveConsoleCalls = (root = SRC): Bypass[] => {
  const found: Bypass[] = [];
  for (const abs of walk(root)) {
    const src = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    const re = /console\s*\.\s*(?:log|info|warn|error|debug)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const open = src.indexOf('(', m.index);
      const code = stripStrings(callAt(src, open));
      // Identifiers only: a bare word, or the VALUE half of `key: value`.
      for (const idMatch of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
        const id = idMatch[0];
        if (!isSensitiveName(id)) continue;
        found.push({
          file: path.relative(path.resolve(__dirname, '..'), abs),
          line: src.slice(0, m.index).split('\n').length,
          identifier: id,
          text: src.slice(m.index, src.indexOf('\n', m.index)).trim().slice(0, 100),
        });
      }
    }
  }
  return found;
};

describe('no console call carries a sensitive value past the redactor', () => {
  it('finds console calls at all (positive fixture)', () => {
    // A broken matcher would report zero findings and pass forever.
    let total = 0;
    for (const abs of walk(SRC)) {
      total += (fs.readFileSync(abs, 'utf8').match(/console\s*\.\s*(?:log|info|warn|error|debug)\s*\(/g) ?? []).length;
    }
    expect(total).toBeGreaterThan(150);
  });

  it('keeps interpolated code while dropping prose', () => {
    // The detector's own contract, both halves.
    expect(stripStrings('console.log("Sending PENDING_OTP reminders")')).not.toMatch(/OTP/i);
    expect(stripStrings('console.log(`code ${otp} sent`)')).toMatch(/otp/);
  });

  it('matches compound names, which is how sensitive values are actually named', () => {
    // The bare-word version of this detector caught none of these.
    for (const name of ['accessToken', 'otpCode', '__probeOtp', 'phoneNumber', 'resetToken', 'documentId', 'signedUrl']) {
      expect({ name, sensitive: isSensitiveName(name) }).toEqual({ name, sensitive: true });
    }
    // And must not fire on the shapes a careful author uses instead.
    for (const name of ['identifierType', 'tokenType', 'hasToken', 'bookingId', 'otpSentAt', 'url', 'documentCount']) {
      expect({ name, sensitive: isSensitiveName(name) }).toEqual({ name, sensitive: false });
    }
  });

  it('no sensitive identifier is passed to console.*', () => {
    const found = sensitiveConsoleCalls();
    expect(found.map((f) => `${f.file}:${f.line} [${f.identifier}] ${f.text}`)).toEqual([]);
  });
});
