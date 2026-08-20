/**
 * Every timestamp this API emits carries an explicit UTC designator.
 *
 * TAB 03 of the Admin API Master Command asks for a serialisation-level
 * guarantee rather than a per-field convention, and for "a test that would
 * fail".
 *
 * The machinery existed and the guarantee did not. `src/db/dbQuery.ts` has
 * always registered `asUtcIso` against OIDs 1114 and 1184, so it LOOKED closed
 * — this suite was originally written to pin behaviour that was assumed
 * correct, and four of its cases failed on the first run.
 *
 * The zone guard was `/[Zz]$|[+-]\d{2}:?\d{2}$/`: four offset digits,
 * minimum. Postgres emits TWO — `2026-08-11 11:03:23.421016+00`. So every
 * `timestamptz` was judged zone-less, had `Z` appended to a string that already
 * carried an offset, produced `…+00Z`, failed `new Date()`, and fell through
 * the NaN guard to be returned UNCHANGED. Postgres' native format reached
 * clients on every `accepted_at`, `arrived_at`, `cancelled_at` and
 * `confirmed_at` in the system — which is verbatim the string the contract
 * tells clients they will never receive.
 *
 * V8 parses that form through its legacy non-ISO path, which is why nothing
 * looked broken; JavaScriptCore does not, so the same booking is an Invalid
 * Date on iOS Safari and fine in Chrome. The naive `timestamp without time
 * zone` branch always worked. Only the type that carries a zone was broken.
 *
 * ## Why this matters more here than in most systems
 *
 * Servana operates in Asia/Manila, UTC+8. A booking at 08:00 Manila is 00:00
 * UTC, so a timestamp read in the wrong zone moves a job across a DAY boundary
 * and "today's jobs" differs between the provider's phone and the server.
 *
 * A naive string is worse than a wrong one, because it is uncorrectable. Given
 * `2026-08-11 11:03:23`, a client cannot tell whether that is Manila or UTC —
 * it has to guess, and every browser guesses "local". The portal reported that
 * Angular's DatePipe cannot read IANA zone names at all: `timezoneToOffset`
 * is `Date.parse('Jan 01, 1970 00:00:00 ' + tz)`, which is NaN for
 * `Asia/Manila` and silently falls back to the browser's own offset.
 *
 * ## The two instants every case is pinned at
 *
 * 00:30 and 23:45 Manila — the two the front-end book names, chosen because
 * Manila and UTC fall on DIFFERENT DATES at both. A test that used midday would
 * pass while agreeing with the runner's clock, which is not the same thing as
 * being right.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { asUtcIso } from '../src/db/dbQuery';

/** Ends in `Z`, or in an explicit ±HH:MM / ±HHMM offset. */
const HAS_DESIGNATOR = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;

describe('asUtcIso — the guarantee itself', () => {
  it('adds a designator to a NAIVE postgres timestamp', () => {
    // `timestamp without time zone` arrives with no offset at all. This is the
    // input the whole function exists for.
    const out = asUtcIso('2026-08-11 11:03:23.421016');
    expect(out).toMatch(HAS_DESIGNATOR);
    expect(out).toBe('2026-08-11T11:03:23.421Z');
  });

  it('normalises an offset-bearing timestamp to Z rather than passing it through', () => {
    // Postgres native `2026-08-11 11:03:23.421016+00` is the exact string the
    // contract's one documented timestamp field warns against emitting.
    const out = asUtcIso('2026-08-11 11:03:23.421016+00');
    expect(out).toBe('2026-08-11T11:03:23.421Z');
  });

  it('converts a non-UTC offset to the same instant in Z', () => {
    // +08:00 is Manila. 19:03 Manila is 11:03 UTC — the same instant, and the
    // client must not have to do that arithmetic.
    expect(asUtcIso('2026-08-11 19:03:23.421016+08')).toBe('2026-08-11T11:03:23.421Z');
  });

  it('holds at 00:30 Manila, where Manila and UTC are on DIFFERENT DATES', () => {
    // 00:30 on the 12th in Manila is 16:30 on the 11th in UTC. A test at midday
    // cannot tell a correct implementation from one that agrees with the
    // runner's clock; this one can.
    const out = asUtcIso('2026-08-12 00:30:00+08')!;
    expect(out).toBe('2026-08-11T16:30:00.000Z');
    expect(out.slice(0, 10)).toBe('2026-08-11');
  });

  it('holds at 23:45 Manila, the other side of the same boundary', () => {
    const out = asUtcIso('2026-08-11 23:45:00+08')!;
    expect(out).toBe('2026-08-11T15:45:00.000Z');
  });

  it('passes null through, because a null timestamp is a fact', () => {
    expect(asUtcIso(null)).toBeNull();
  });

  it('returns an unparseable value UNCHANGED rather than inventing one', () => {
    // Fail visibly. A garbage string that silently became an epoch date would
    // be a wrong answer nobody could see; the raw value at least reads as wrong.
    expect(asUtcIso('not a timestamp')).toBe('not a timestamp');
  });

  it('is independent of the process timezone', () => {
    // The property that makes this a guarantee rather than a coincidence: the
    // same input must produce the same output on a laptop, on the Linode box
    // and under any TZ a runner happens to carry.
    const before = process.env.TZ;
    try {
      for (const tz of ['UTC', 'Asia/Manila', 'America/New_York']) {
        process.env.TZ = tz;
        expect(asUtcIso('2026-08-11 11:03:23.421016+00')).toBe('2026-08-11T11:03:23.421Z');
      }
    } finally {
      process.env.TZ = before;
    }
  });
});

describe('the parsers are actually installed against the right OIDs', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'db', 'dbQuery.ts'), 'utf8');

  it('registers asUtcIso for timestamp AND timestamptz', () => {
    // 1114 = timestamp without time zone, 1184 = timestamp with time zone.
    // Registering only one leaves the other building a JS Date in the process
    // zone, which is the environment-dependent behaviour this replaced.
    expect(source).toMatch(/setTypeParser\(TIMESTAMP_OID,\s*asUtcIso\)/);
    expect(source).toMatch(/setTypeParser\(TIMESTAMPTZ_OID,\s*asUtcIso\)/);
    expect(source).toMatch(/TIMESTAMP_OID\s*=\s*1114/);
    expect(source).toMatch(/TIMESTAMPTZ_OID\s*=\s*1184/);
  });

  it('leaves DATE alone, deliberately', () => {
    // 1082 is `date`. A date has no zone and must NOT become a Date object,
    // which would attach one and can move it a day.
    expect(source).toMatch(/setTypeParser\(DATE_OID,\s*\(v[^)]*\)\s*=>\s*v\)/);
  });

  it('pins the SESSION zone to UTC as well as the parsers', () => {
    // Without this, anything computed IN SQL — NOW(), date_trunc, an interval
    // comparison — follows the server's default instead of the parsers, and the
    // two disagree. It is also what makes a jsonb-rendered timestamptz come
    // back as +00:00 rather than in some server-local offset.
    expect(source).toMatch(/timezone=UTC/);
  });
});

/**
 * The one way a timestamp can still escape the parsers, measured rather than
 * imagined.
 *
 * The type parsers key on the COLUMN'S OID. A value that leaves Postgres as
 * `text` never reaches them. `to_jsonb(row) ->> 'col'` does exactly that, and
 * running it against PGlite shows the difference precisely:
 *
 *     accepted_at                     -> 2026-08-11T03:03:23.421Z   (JS Date, parsed)
 *     to_jsonb(bw) ->> 'accepted_at'  -> "2026-08-11T11:03:23.421016"   (string, NAIVE)
 *
 * The naive form has no designator and is uncorrectable by any client.
 *
 * Eight such extractions exist in this repository today and ALL EIGHT are safe,
 * because every column they name is `timestamp with time zone` — jsonb renders
 * those with an explicit offset, and the session zone is pinned to UTC so it is
 * `+00:00`. That is a property of which columns were chosen, not of the
 * technique. Point the same expression at a `timestamp without time zone`
 * column and it emits a naive string with the gate green.
 *
 * So the test does not ban the technique. It reads the schema baseline for the
 * column's real type and fails only on the combination that is actually unsafe.
 */
describe('no jsonb text extraction reads a zone-less timestamp column', () => {
  const REPO = join(__dirname, '..');

  /** Columns declared `timestamp without time zone`, from the schema baseline. */
  const zonelessColumns = (): Set<string> => {
    const sql = readFileSync(join(REPO, 'scripts', 'baseline', '000-baseline.sql'), 'utf8');
    const out = new Set<string>();
    for (const m of sql.matchAll(/^\s+(\w+)\s+timestamp without time zone/gm)) {
      out.add(m[1]);
    }
    return out;
  };

  const tsFiles = (dir: string, acc: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) tsFiles(full, acc);
      else if (entry.endsWith('.ts')) acc.push(full);
    }
    return acc;
  };

  it('finds the extractions rather than assuming there are none', () => {
    // A detector that matches nothing proves nothing. This asserts the pattern
    // still occurs, so a rewrite that changes the syntax fails here loudly
    // instead of passing silently on zero matches.
    let found = 0;
    for (const file of tsFiles(join(REPO, 'src'))) {
      const src = readFileSync(file, 'utf8');
      found += [...src.matchAll(/->>\s*'(\w+)'/g)].length;
    }
    expect(found).toBeGreaterThan(0);
  });

  it('never extracts a zone-less timestamp column as jsonb text', () => {
    const zoneless = zonelessColumns();
    expect(zoneless.size).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of tsFiles(join(REPO, 'src'))) {
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/->>\s*'(\w+)'/g)) {
          if (zoneless.has(m[1])) {
            offenders.push(
              `${file.slice(REPO.length + 1).replace(/\\/g, '/')}:${i + 1}  ->> '${m[1]}'`,
            );
          }
        }
      });
    }

    // Named, not counted. Whoever trips this needs the line, and the fix is to
    // read the column directly so the OID parser sees it — never to cast it.
    expect(offenders).toEqual([]);
  });
});

/**
 * The rule is stated on every timestamp, and stating it does not corrupt the
 * document.
 *
 * TAB 03's fourth ask: *"State the rule in the schema description of every
 * timestamp field, not one of them."* Before this, exactly one field in 62
 * carried it — a convention written down once, and therefore true only by
 * memory.
 */
describe('every timestamp field states the rule', () => {
  const dateTimeFields = (
    node: unknown,
    path: string,
    out: Array<{ path: string; description: string }>,
  ): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => dateTimeFields(child, `${path}[${i}]`, out));
      return;
    }
    const o = node as Record<string, unknown>;
    if (o.format === 'date-time') {
      out.push({ path, description: typeof o.description === 'string' ? o.description : '' });
    }
    for (const [key, value] of Object.entries(o)) {
      if (key === 'enum') continue;
      dateTimeFields(value, `${path}.${key}`, out);
    }
  };

  it('leaves no timestamp field without the designator rule', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildOpenApiDocument } = require('../src/api/v1/openapi');
    const doc = buildOpenApiDocument();
    const found: Array<{ path: string; description: string }> = [];
    dateTimeFields(doc.components.schemas, 'schemas', found);

    expect(found.length).toBeGreaterThan(50);
    const bare = found.filter((f) => !f.description.includes('UTC designator')).map((f) => f.path);
    // Named rather than counted: whoever trips this needs the field.
    expect(bare).toEqual([]);
  });

  it('generates the SAME document twice in one process', () => {
    /**
     * The hazard the deep clone exists for. `SCHEMAS` is a module-level
     * singleton, so stamping the rule directly into it would make the second
     * call see the sentence the first one wrote — and append it again.
     *
     * Not hypothetical: `npm run verify` runs `api:docs:check` in a process
     * that has already imported the module, and a document that grows a
     * duplicated sentence on every generation would fail the staleness gate
     * with no source change to explain it.
     */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildOpenApiDocument } = require('../src/api/v1/openapi');
    const first = JSON.stringify(buildOpenApiDocument());
    const second = JSON.stringify(buildOpenApiDocument());
    expect(second).toBe(first);
  });

  it('appends the rule rather than replacing what a field already said', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { stateTheUtcRule, UTC_RULE } = require('../src/api/v1/openapi');
    const node = {
      a: { format: 'date-time', description: 'When the provider arrived.' },
      b: { format: 'date-time' },
    };
    stateTheUtcRule(node);
    expect(node.a.description).toBe(`When the provider arrived. ${UTC_RULE}`);
    expect((node.b as any).description).toBe(UTC_RULE);
  });

  it('does not stamp a field that is not a timestamp', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { stateTheUtcRule } = require('../src/api/v1/openapi');
    const node = { d: { type: 'string', format: 'date', description: 'A calendar date.' } };
    stateTheUtcRule(node);
    // `date` has no zone and must not claim one — attaching a designator to it
    // is the mistake the DATE_OID parser exists to avoid.
    expect(node.d.description).toBe('A calendar date.');
  });
});
