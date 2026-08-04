/**
 * The conflict-detection logic, proven against synthetic rows.
 *
 * The audit script itself cannot run here — the local .env has no database
 * credentials — so this exercises the classification it performs, using the
 * SAME normalizers, before anyone points it at production data.
 *
 * The distinction it has to get right is conflict vs gap:
 *   conflict — two accounts share a normalized identifier. The unique index
 *              will FAIL. Someone must decide who owns that person's history.
 *   gap      — a value that does not parse, so it has no normalized form. It
 *              cannot collide with anything. Not a conflict, and reporting it
 *              as one sends someone chasing a problem that does not exist.
 */

import { normalizeEmail, toE164PhMobile } from '../src/helpers/phoneIdentifier';

type Row = { uid: string; email: string | null; phone_number: string | null };

/** Mirrors the grouping the audit script performs. */
function classify(rows: Row[]) {
  const byEmail = new Map<string, string[]>();
  const byPhone = new Map<string, string[]>();
  const gaps = { email: 0, phone: 0 };

  for (const r of rows) {
    const e = normalizeEmail(r.email);
    if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), r.uid]);
    else if (r.email) gaps.email++;

    const p = toE164PhMobile(r.phone_number);
    if (p) byPhone.set(p, [...(byPhone.get(p) ?? []), r.uid]);
    else if (r.phone_number) gaps.phone++;
  }

  const conflicts = [
    ...[...byEmail].filter(([, u]) => u.length > 1).map(([v, u]) => ({ kind: 'email', v, uids: u })),
    ...[...byPhone].filter(([, u]) => u.length > 1).map(([v, u]) => ({ kind: 'mobile', v, uids: u })),
  ];
  return { conflicts, gaps };
}

describe('conflicts the unique index would reject', () => {
  test('same email, different casing', () => {
    const { conflicts } = classify([
      { uid: 'a', email: 'Juan@Gmail.com', phone_number: null },
      { uid: 'b', email: 'juan@gmail.com', phone_number: null },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].uids.sort()).toEqual(['a', 'b']);
  });

  test('same mobile, different formats', () => {
    // The case a raw-column comparison would completely miss.
    const { conflicts } = classify([
      { uid: 'a', email: null, phone_number: '09171234567' },
      { uid: 'b', email: null, phone_number: '+63 917 123 4567' },
      { uid: 'c', email: null, phone_number: '9171234567' },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].uids).toHaveLength(3);
  });

  test('one account can conflict on both identifiers at once', () => {
    const { conflicts } = classify([
      { uid: 'a', email: 'j@x.com', phone_number: '09171234567' },
      { uid: 'b', email: 'J@X.com', phone_number: '0917 123 4567' },
    ]);
    expect(conflicts).toHaveLength(2);
  });
});

describe('gaps are NOT conflicts', () => {
  test('unparseable values are counted separately', () => {
    const { conflicts, gaps } = classify([
      { uid: 'a', email: 'not-an-email', phone_number: 'n/a' },
      { uid: 'b', email: 'also-broken', phone_number: '12345' },
    ]);
    // Two broken emails do NOT collide — neither has a normalized form, so the
    // unique index is indifferent to them. Reporting these as conflicts would
    // send someone chasing a problem that does not exist.
    expect(conflicts).toHaveLength(0);
    expect(gaps).toEqual({ email: 2, phone: 2 });
  });

  test('a null identifier is neither', () => {
    const { conflicts, gaps } = classify([
      { uid: 'a', email: null, phone_number: null },
      { uid: 'b', email: null, phone_number: null },
    ]);
    expect(conflicts).toHaveLength(0);
    expect(gaps).toEqual({ email: 0, phone: 0 });
  });
});

describe('clean data', () => {
  test('distinct identifiers produce nothing', () => {
    const { conflicts, gaps } = classify([
      { uid: 'a', email: 'a@x.com', phone_number: '09171234567' },
      { uid: 'b', email: 'b@x.com', phone_number: '09181234567' },
    ]);
    expect(conflicts).toHaveLength(0);
    expect(gaps.email + gaps.phone).toBe(0);
  });

  test('periods and +tags stay distinct', () => {
    // Gmail treats these as one address. Servana does not, and collapsing them
    // would merge genuinely different accounts at every other provider.
    const { conflicts } = classify([
      { uid: 'a', email: 'juan.cruz@outlook.com', phone_number: null },
      { uid: 'b', email: 'juancruz@outlook.com', phone_number: null },
      { uid: 'c', email: 'juan+servana@outlook.com', phone_number: null },
    ]);
    expect(conflicts).toHaveLength(0);
  });
});
