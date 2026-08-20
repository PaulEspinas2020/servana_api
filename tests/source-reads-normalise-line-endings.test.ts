import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * A test that reads source and slices a fixed byte window must normalise line
 * endings first.
 *
 * Thirteen suites in this repo introspect source with
 * `src.substring(start, start + N)` and assert a substring is inside. On a
 * Windows checkout every line is one byte longer, so the same N covers fewer
 * lines and the thing being asserted falls outside the window.
 *
 * `admin-permissions.test.js` failed exactly this way: it sliced 500 characters
 * from `resolvePermissionDependencies` and asserted "requires" was present. The
 * word appears 245 times in that file. The function was fine; the window was
 * short.
 *
 * The cost is worse than a red suite. A developer on Windows sees failures that
 * CI does not, learns those suites are unreliable, and stops reading them — so
 * the day one of them catches something real, it gets waved through as "the
 * Windows thing again". One suite had already been fixed in isolation
 * (admin-audit.test.js normalised, alone), which is what fixing an instance
 * instead of a class looks like.
 *
 * This guard is deliberately narrow: it only requires normalisation where a
 * fixed window is actually used. A test that reads a file and checks
 * `toContain` over the whole thing is unaffected by line endings and is left
 * alone.
 */

const TESTS = join(__dirname);

/** `readFileSync(..., 'utf8')` not immediately followed by a `.replace(...)`. */
const UNNORMALISED_READ =
  /readFileSync\((?:[^()]|\([^()]*\))*?,\s*'utf-?8'\s*\)(?!\s*\.replace)/g;

/** `substring(x + 400)` / `slice(x, x + 600)` — a window measured in bytes. */
const FIXED_WINDOW = /(?:substring|slice)\(\s*\w+\s*(?:,\s*\w+\s*)?\+\s*\d{2,}/g;

describe('source-introspection tests survive CRLF', () => {
  const files = readdirSync(TESTS).filter(
    (f) => f.endsWith('.test.ts') || f.endsWith('.test.js'),
  );

  it('finds the suites this rule applies to', () => {
    // If this drops to zero the guard has stopped guarding anything — most
    // likely because the read pattern changed, not because the risk went away.
    const introspecting = files.filter((f) => {
      const src = readFileSync(join(TESTS, f), 'utf8');
      return src.includes('readFileSync') && FIXED_WINDOW.test(src);
    });
    FIXED_WINDOW.lastIndex = 0;
    expect(introspecting.length).toBeGreaterThan(5);
  });

  it('every fixed-window suite normalises line endings when it reads source', () => {
    const offenders: string[] = [];

    for (const f of files) {
      if (f === 'source-reads-normalise-line-endings.test.ts') continue;
      const src = readFileSync(join(TESTS, f), 'utf8');

      FIXED_WINDOW.lastIndex = 0;
      if (!FIXED_WINDOW.test(src)) continue;

      UNNORMALISED_READ.lastIndex = 0;
      const bad = src.match(UNNORMALISED_READ);
      if (bad) {
        offenders.push(`${f} — ${bad.length} unnormalised read(s)`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the detector actually catches the broken shape', () => {
    // Without this the test above passes whenever the regex silently stops
    // matching, which is the failure mode it exists to prevent.
    const broken = `
      const src = readFileSync(p, 'utf8');
      const seg = src.substring(start + 500);
    `;
    UNNORMALISED_READ.lastIndex = 0;
    FIXED_WINDOW.lastIndex = 0;
    expect(broken.match(UNNORMALISED_READ)).not.toBeNull();
    expect(FIXED_WINDOW.test(broken)).toBe(true);
  });

  it('the detector accepts the fixed shape', () => {
    const ok = `
      const src = readFileSync(p, 'utf8').replace(/\\r\\n/g, '\\n');
      const seg = src.substring(start + 500);
    `;
    UNNORMALISED_READ.lastIndex = 0;
    expect(ok.match(UNNORMALISED_READ)).toBeNull();
  });

  it('the detector leaves whole-file reads alone', () => {
    // No fixed window, so line endings cannot shift the assertion.
    const fine = `
      const src = readFileSync(p, 'utf8');
      expect(src).toContain('something');
    `;
    FIXED_WINDOW.lastIndex = 0;
    expect(FIXED_WINDOW.test(fine)).toBe(false);
  });
});

/**
 * No source file carries a literal control byte.
 *
 * ## Why this exists
 *
 * A regex written as `/import\b/` is a word boundary. The same regex generated
 * by a tool that mishandles the escape becomes `/import\x08/` — a LITERAL
 * BACKSPACE — and no source file contains one, so the pattern never matches.
 *
 * That is not a loud failure. It is a silent one, and it produced a guard in
 * this repository that had never run:
 *
 *     tests/admin-invite-state.test.ts
 *       read('services/adminInviteState.ts').match(/^\s*import\x08.*$/gm) ?? []
 *
 * `.match()` returned null, `?? []` made it an empty array, `.join(' ')` gave
 * an empty string, and both `expect(...).not.toContain(...)` assertions passed
 * against it. The import-cycle guard it was protecting had never checked
 * anything, and its own comment warned about a neighbouring mistake — "that
 * mistake has been made three times in this codebase already".
 *
 * ## Why a byte check rather than a smarter one
 *
 * Because this class is invisible at every other layer. It compiles, it lints,
 * it reads correctly in a diff — the backspace renders as nothing — and the
 * test goes green. The only thing that distinguishes it from working code is
 * the byte, so the byte is what is checked.
 *
 * Tab and the two line-ending bytes are permitted; everything else in the C0
 * range is not. A genuine need for one is a `\xNN` escape, which is text.
 */
describe('no source file carries a literal control byte', () => {
  const ROOTS = ['src', 'tests', 'scripts'];
  const REPO = join(__dirname, '..');

  /** C0 controls except tab (09), line feed (0A) and carriage return (0D). */
  // eslint-disable-next-line no-control-regex
  const FORBIDDEN = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

  const files = (dir: string, acc: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        files(full, acc);
      } else if (/\.(ts|js|mjs)$/.test(entry.name)) acc.push(full);
    }
    return acc;
  };

  const all = ROOTS.flatMap((r) => files(join(REPO, r)));

  it('scans a real number of files, so the sweep is not vacuous', () => {
    // The mistake this whole describe is about is a search that matches
    // nothing and reports success. It would be a poor joke to make it here.
    expect(all.length).toBeGreaterThan(300);
  });

  it('finds no backspace, form feed or other C0 control', () => {
    const offenders: string[] = [];
    for (const file of all) {
      const src = readFileSync(file, 'utf8');
      if (!FORBIDDEN.test(src)) continue;
      src.split('\n').forEach((line, i) => {
        const m = FORBIDDEN.exec(line);
        if (!m) return;
        offenders.push(
          `${file.slice(REPO.length + 1).replace(/\\/g, '/')}:${i + 1}` +
            `  U+${m[0].charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`,
        );
      });
    }
    // Named with the codepoint, because the character itself is invisible and
    // a bare filename would send somebody hunting for something they cannot see.
    expect(offenders).toEqual([]);
  });

  it('would catch one if it were there', () => {
    // The detector, against a known offender. Without this the assertion above
    // passes just as well when the regex has stopped matching.
    expect(FORBIDDEN.test(`import${String.fromCharCode(8)}`)).toBe(true);
    expect(FORBIDDEN.test('import\\b')).toBe(false);
    expect(FORBIDDEN.test('a\tb')).toBe(false);
    expect(FORBIDDEN.test('a\r\nb')).toBe(false);
  });
});
