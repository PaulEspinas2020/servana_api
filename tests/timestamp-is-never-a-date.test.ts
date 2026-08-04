import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * No database timestamp is ever a JS Date, so nothing may call a Date method
 * straight on one.
 *
 * `src/db/dbQuery.ts` installs global node-postgres type parsers for OIDs 1114
 * (timestamp), 1184 (timestamptz) and 1082 (date). That is deliberate — without
 * it the driver builds a Date using the Node process's local zone, so the same
 * row serialises differently on a laptop, on the Linode box and in CI, and a
 * booking at 08:00 Manila can cross a day boundary. Every timestamp therefore
 * arrives as a STRING.
 *
 * `bookingService.createBooking` did not get the memo:
 *
 *     booking_date: booking.schedule.toLocaleDateString("en-US", { ... })
 *
 * `String.prototype` has toLocaleUpperCase and toLocaleLowerCase but no
 * toLocaleDateString, so this threw
 *
 *     TypeError: booking.schedule.toLocaleDateString is not a function
 *
 * and the customer saw that exact string on the checkout screen.
 *
 * ── Why it was worse than a broken email ───────────────────────────────────
 * The call sat in the ARGUMENT LIST of send(). Arguments are evaluated before
 * the call, so the throw escaped createBooking rather than the mailer — after
 * the INSERT into bookings and the INSERT into payments had both committed.
 * Every booking attempt wrote its rows, then answered with an error. Customers
 * retried, and each retry orphaned another pending booking.
 *
 * ── Why this is a class, not an instance ───────────────────────────────────
 * Twelve other call sites in this repo already wrap correctly in `new Date(...)`
 * — including one 70 lines further down the SAME file, in resendBookingOtp.
 * Fixing only line 112 would leave the next person free to write it again, so
 * this test reads the source and fails on any Date-only method invoked on
 * something that is not demonstrably a Date.
 */

const SRC = join(__dirname, '..', 'src');

/** Methods that exist on Date.prototype and NOT on String.prototype. */
const DATE_ONLY_METHODS = [
  'toLocaleDateString',
  'toLocaleTimeString',
  'getTime',
  'getFullYear',
  'getMonth',
  'getDate',
  'getHours',
  'getMinutes',
  'toISOString',
];

/**
 * `toLocaleString` is deliberately absent from the list above: Number and String
 * both define it, so `price.toLocaleString()` is legitimate and flagging it
 * would produce noise that trains people to ignore this test.
 */

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Blanks a span while keeping its newlines, so every reported line number still
 * refers to the real file. The first version of this collapsed block comments to
 * a single space and reported offenders 40 lines off target.
 */
const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

/**
 * Replaces every `new Date(...)` — parentheses balanced, so nested calls such as
 * `new Date(new Date(x).getTime() - 1)` collapse correctly — with a single
 * token. Whatever still carries a Date-only method afterwards was never wrapped.
 */
function maskDateConstructions(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const at = src.indexOf('new Date(', i);
    if (at === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, at);
    let depth = 0;
    let j = at + 'new Date'.length;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    out += '__DATE__' + blank(src.slice(at, j)).replace(/ /g, '');
    i = j;
  }
  return out;
}

/** Strips comments and string/template literals so prose can never trip this. */
function stripNonCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank)
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, (m) => '``' + blank(m).slice(2))
    .replace(/'(?:\\[\s\S]|[^\\'])*'/g, (m) => "''" + blank(m).slice(2))
    .replace(/"(?:\\[\s\S]|[^\\"])*"/g, (m) => '""' + blank(m).slice(2));
}

/**
 * Finds Date-only methods invoked on something that was never proven to be a
 * Date. Returns `line — expression` strings.
 *
 * `providerAvailabilityEngine` writes the safe form
 *
 *     r.start_date instanceof Date ? r.start_date.toISOString() : String(...)
 *
 * eight times. A detector that cannot see the guard reports all eight, and
 * "fixing" them would break working code — the failure mode that once deleted
 * six correctly-secured routes. So a receiver is exempt when the same line
 * tests exactly that receiver with `instanceof Date`.
 */
export function findUnguardedDateCalls(src: string): string[] {
  const masked = maskDateConstructions(stripNonCode(src));
  const lines = masked.split('\n');
  const out: string[] = [];

  const re = new RegExp(
    `([A-Za-z_$][\\w$]*(?:\\.[\\w$]+)+)\\.(${DATE_ONLY_METHODS.join('|')})\\s*\\(`,
    'g',
  );

  lines.forEach((line, idx) => {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      const receiver = m[1];
      if (receiver.includes('__DATE__')) continue;
      // Whitespace-tolerant: the guarded lines pad for column alignment
      // (`r.end_date   instanceof Date`), which a literal match misses.
      const guard = new RegExp(
        `${receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+instanceof\\s+Date`,
      );
      if (guard.test(line)) continue;
      out.push(`${idx + 1} — ${receiver}.${m[2]}()`);
    }
  });

  return out;
}

describe('database timestamps are strings, not Dates', () => {
  it('the type parsers that make this true are still installed', () => {
    // If these are ever removed the premise of this whole file changes, and
    // the failure would be silent — timestamps would quietly become Dates and
    // every string-assuming caller would start producing wrong output instead
    // of throwing. Pin them.
    const dbQuery = readFileSync(join(SRC, 'db', 'dbQuery.ts'), 'utf8');
    expect(dbQuery).toContain('setTypeParser(TIMESTAMP_OID');
    expect(dbQuery).toContain('setTypeParser(TIMESTAMPTZ_OID');
    expect(dbQuery).toContain('setTypeParser(DATE_OID');
  });

  // A detector nobody has tested is a detector that reports whatever it happens
  // to report. These fixtures pin both directions before it is trusted against
  // the real tree.
  describe('the detector itself', () => {
    it('catches the shape that actually shipped', () => {
      expect(
        findUnguardedDateCalls('booking_date: booking.schedule.toLocaleDateString("en-US")'),
      ).toEqual(['1 — booking.schedule.toLocaleDateString()']);
    });

    it('accepts a wrapped value', () => {
      expect(
        findUnguardedDateCalls('x: new Date(booking.schedule).toLocaleDateString("en-US")'),
      ).toEqual([]);
    });

    it('accepts a nested wrap', () => {
      expect(
        findUnguardedDateCalls('const w = new Date(new Date(r.schedule).getTime() - 1);'),
      ).toEqual([]);
    });

    it('accepts an instanceof-guarded call', () => {
      expect(
        findUnguardedDateCalls(
          'a: r.start_date instanceof Date ? r.start_date.toISOString() : String(r.start_date)',
        ),
      ).toEqual([]);
    });

    it('accepts a guard padded for column alignment', () => {
      // The real file aligns its object literals, so the guard reads
      // `r.end_date   instanceof Date`. A literal-substring check missed that
      // and reported four working lines as broken.
      expect(
        findUnguardedDateCalls(
          'b: r.end_date   instanceof Date ? r.end_date.toISOString()   : String(r.end_date)',
        ),
      ).toEqual([]);
    });

    it('is not fooled by the same call inside a comment', () => {
      expect(
        findUnguardedDateCalls('// booking.schedule.toLocaleDateString is not a function'),
      ).toEqual([]);
    });

    it('reports the true line number', () => {
      const src = ['/*', ' * multi', ' * line', ' */', 'a.b.getTime()'].join('\n');
      expect(findUnguardedDateCalls(src)).toEqual(['5 — a.b.getTime()']);
    });

    it('leaves toLocaleString alone — Number and String both define it', () => {
      expect(findUnguardedDateCalls('`PHP ${row.amount.toLocaleString()}`')).toEqual([]);
    });
  });

  it('no Date-only method is called on an unwrapped value', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      for (const hit of findUnguardedDateCalls(readFileSync(file, 'utf8'))) {
        offenders.push(`${file.replace(SRC, 'src')}:${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The comment above the fix quotes the broken expression verbatim, because
   * naming the defect is the point of the comment. A raw substring check
   * therefore matches the PROSE and reports a bug that is not there — which is
   * how the first run of this file failed against correct code. Assert against
   * code only.
   */
  const createBookingCode = (): string => {
    const src = stripNonCode(
      readFileSync(join(SRC, 'services', 'bookingService.ts'), 'utf8'),
    );
    const start = src.indexOf('export const createBooking');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('export const resendBookingOtp');
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  it('createBooking guards the schedule it puts in the OTP email', () => {
    const body = createBookingCode();
    expect(body).not.toContain('booking.schedule.toLocaleDateString');
    expect(body).not.toContain('booking.schedule.toLocaleTimeString');
    expect(body).toContain('new Date(booking.schedule).toLocaleDateString');
  });

  it('a failed OTP email cannot fail a booking that was already written', () => {
    // The rows are committed before the mail goes out. Throwing after that point
    // tells the customer the booking did not happen while it sits in the
    // database, which is what produced the duplicate PENDING bookings.
    const body = createBookingCode();

    // stripNonCode blanks template literals, so the SQL text is gone — match the
    // call that carries it instead.
    const insert = body.indexOf('dbQuery.query');
    const mail = body.indexOf('send(email,');
    expect(insert).toBeGreaterThan(-1);
    expect(mail).toBeGreaterThan(insert);

    // The mail call must sit inside a try that swallows.
    expect(body.slice(insert, mail)).toContain('try {');
    expect(body.slice(mail)).toContain('catch');
  });
});
