/**
 * A fake `pg` for the TAB 10 account domain.
 *
 * ## Why a fake and not mocked services
 *
 * The guarantees this tab rests on are SQL:
 *
 *   - every address statement is owner-scoped in its WHERE clause, so an id
 *     belonging to another account resolves to nothing;
 *   - the default-address promotion is ONE transaction, so an account never has
 *     two primaries;
 *   - deleting the default promotes a successor in the same transaction.
 *
 * A suite that stubbed the repository would prove the services call each other.
 * The "exactly one default" test in particular would pass against a database
 * that had just written two.
 *
 * So this routes the real statements and implements real transactions — unlike
 * `eventDbFake`, because here the transaction IS the subject.
 */

export interface Row { [k: string]: unknown }

let nextAddressSeq = 1;

export const store = {
  users: [] as Row[],
  profiles: [] as Row[],
  addresses: [] as Row[],
  settings: [] as Row[],
  requirements: [] as Row[],
  employeeServices: [] as Row[],
  sql: [] as string[],
  /** Makes the NEXT commit throw, to prove the rollback path. */
  failNextCommit: false,
};

export const reset = (): void => {
  store.users = [];
  store.profiles = [];
  store.addresses = [];
  store.settings = [];
  store.requirements = [];
  store.employeeServices = [];
  store.sql = [];
  store.failNextCommit = false;
  nextAddressSeq = 1;
};

// ─── Seeding ──────────────────────────────────────────────────────────────────

export const seedUser = (uid: string, role: number, o: Partial<Row> = {}): void => {
  store.users.push({
    uid,
    role,
    email: `${uid}@example.test`,
    first_name: 'Test',
    last_name: uid,
    phone_number: null,
    is_email_verified: true,
    is_mobile_verified: false,
    account_status: 'active',
    password_updated_at: null,
    fcm_token: null,
    // A column that must NEVER be projected. Present so the leakage test has
    // something real to fail on rather than asserting against an absence that
    // was never there.
    password_hash: 'do-not-project-me',
    ...o,
  });
  store.profiles.push({
    uid,
    birthdate: null,
    gender: null,
    photo_url: null,
    public_display_name: null,
    public_bio: null,
    public_skills: null,
    public_languages: null,
    public_experience_summary: null,
  });
};

/**
 * Set public provider-profile columns on an already-seeded user.
 *
 * Separate from `seedUser` because `seedUser`'s options object applies to
 * `user_credentials`; the public profile lives in `user_profile` and its column
 * names are the ones a projection bug hides behind.
 */
export const seedProviderProfile = (uid: string, o: Partial<Row> = {}): void => {
  const row = store.profiles.find((x) => x.uid === uid);
  if (row) Object.assign(row, o);
};

export const seedAddress = (uid: string, o: Partial<Row> = {}): Row => {
  const row: Row = {
    address_id: `CAD${String(nextAddressSeq).padStart(3, '0')}`,
    uid,
    label: 'Home',
    address_one: '1 Street',
    address_two: null,
    post_town: 'Taytay',
    zip_code: null,
    country: 'PH',
    location_id: null,
    is_primary: false,
    created_at: new Date(2026, 0, nextAddressSeq).toISOString(),
    created_by: uid,
    updated_by: uid,
    ...o,
  };
  nextAddressSeq += 1;
  store.addresses.push(row);
  return row;
};

export const seedRequirement = (uid: string, type: string, status: string): void => {
  store.requirements.push({
    id: store.requirements.length + 1,
    worker_uid: uid,
    requirement_type: type,
    status,
    created_at: new Date().toISOString(),
    expiry_date: null,
    review_note: null,
  });
};

export const seedService = (uid: string, serviceId: number, status = 'active'): void => {
  // Keyed on `employee_uid` because that is the column `servana.employee_services`
  // actually declares (scripts/baseline/000-baseline.sql). This fake previously
  // stored `worker_uid` — the same name the service wrongly queried — so the fake
  // and the defect agreed with each other and the suite stayed green while every
  // provider got an empty list in production. A fake that mirrors the bug proves
  // the bug.
  store.employeeServices.push({ employee_uid: uid, service_id: serviceId, status, name: `Service ${serviceId}` });
};

export const addressesFor = (uid: string): Row[] =>
  store.addresses.filter((a) => a.uid === uid);

export const defaultsFor = (uid: string): Row[] =>
  store.addresses.filter((a) => a.uid === uid && a.is_primary === true);

// ─── Transaction support ──────────────────────────────────────────────────────

/**
 * A real snapshot/restore transaction.
 *
 * The address service's atomicity is what several tests are actually about, so
 * a fake that treated BEGIN/COMMIT as no-ops would let the "never two defaults"
 * test pass against code that had written two and not rolled back.
 */
let snapshot: Row[] | null = null;

const beginTx = () => {
  snapshot = store.addresses.map((row) => ({ ...row }));
};

const commitTx = () => {
  if (store.failNextCommit) {
    store.failNextCommit = false;
    rollbackTx();
    throw new Error('commit failed');
  }
  snapshot = null;
};

const rollbackTx = () => {
  if (snapshot) store.addresses = snapshot;
  snapshot = null;
};

// ─── The router ───────────────────────────────────────────────────────────────

const done = (rows: Row[]) => ({ rows, rowCount: rows.length });

/**
 * Return only the columns a SELECT list names.
 *
 * The fake stores whole rows, so without this it answers every question with
 * every column — and a query asking for a column that does not exist gets a
 * usable row anyway. Real PostgreSQL raises 42703 instead. Projecting narrows
 * the fake to what was asked, so a wrong column name surfaces as an absent key
 * rather than as a silently correct answer.
 *
 * Anything the parser cannot resolve to a bare `alias.column`, `column`, or
 * `... AS name` falls back to the whole row. Over-supplying is the previous
 * behaviour and is safe; guessing at an expression would drop a column a suite
 * legitimately needs.
 */
const projectSelected = (sql: string, row: Row): Row => {
  const list = /^SELECT\s+([\s\S]*?)\s+FROM\s/i.exec(sql)?.[1];
  if (!list || list.includes('*')) return row;
  const wanted: string[] = [];
  for (const part of list.split(',')) {
    const term = part.trim();
    const aliased = /\bAS\s+(\w+)$/i.exec(term);
    const simple = /^(?:\w+\.)?(\w+)$/.exec(term);
    if (aliased) wanted.push(aliased[1]);
    else if (simple) wanted.push(simple[1]);
    else return row;
  }
  const out: Row = {};
  for (const key of wanted) out[key] = row[key];
  return out;
};

export const run = (sql: string, params: unknown[] = []): { rows: Row[]; rowCount: number } => {
  const flat = sql.replace(/\s+/g, ' ').trim();
  store.sql.push(flat);

  if (/^BEGIN/i.test(flat)) { beginTx(); return done([]); }
  if (/^COMMIT/i.test(flat)) { commitTx(); return done([]); }
  if (/^ROLLBACK/i.test(flat)) { rollbackTx(); return done([]); }
  if (/^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|ALTER TABLE|COMMENT ON)/i.test(flat)) {
    return done([]);
  }
  if (/CREATE TABLE IF NOT EXISTS/i.test(flat)) return done([]);

  // ── identity ──────────────────────────────────────────────────────────────
  if (/^SELECT uid, email, first_name, last_name, role, is_email_verified, phone_number/i.test(flat)) {
    const u = store.users.find((x) => x.uid === params[0]);
    return done(u ? [u] : []);
  }
  if (/^SELECT uc\.account_status, uc\.is_mobile_verified, up\.photo_url/i.test(flat)) {
    const u = store.users.find((x) => x.uid === params[0]);
    if (!u) return done([]);
    const p = store.profiles.find((x) => x.uid === params[0]);
    return done([{
      account_status: u.account_status,
      is_mobile_verified: u.is_mobile_verified,
      photo_url: p?.photo_url ?? null,
    }]);
  }
  if (/^SELECT role::int AS role FROM servana\.user_credentials/i.test(flat)) {
    const u = store.users.find((x) => x.uid === params[0]);
    return done(u ? [{ role: Number(u.role) }] : []);
  }
  if (/^SELECT password_updated_at, is_mobile_verified/i.test(flat)) {
    const u = store.users.find((x) => x.uid === params[0]);
    return done(u ? [{ password_updated_at: u.password_updated_at, is_mobile_verified: u.is_mobile_verified }] : []);
  }

  // ── customer profile ──────────────────────────────────────────────────────
  if (/^SELECT up\.birthdate, up\.gender, up\.photo_url,/i.test(flat)) {
    const u = store.users.find((x) => x.uid === params[0]);
    if (!u) return done([]);
    const p = store.profiles.find((x) => x.uid === params[0]);
    const mine = addressesFor(String(params[0]));
    const primary = mine.filter((a) => a.is_primary === true)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
    return done([{
      birthdate: p?.birthdate ?? null,
      gender: p?.gender ?? null,
      photo_url: p?.photo_url ?? null,
      default_address_id: primary?.address_id ?? null,
      address_count: mine.length,
    }]);
  }
  if (/^SELECT photo_url FROM servana\.user_profile/i.test(flat)) {
    const p = store.profiles.find((x) => x.uid === params[0]);
    return done(p ? [{ photo_url: p.photo_url }] : []);
  }
  if (/^SELECT is_mobile_verified FROM servana\.user_credentials/i.test(flat)) {
    const u = store.users.find((x) => x.uid === params[0]);
    return done(u ? [{ is_mobile_verified: u.is_mobile_verified }] : []);
  }

  // ── provider profile ──────────────────────────────────────────────────────
  if (/^SELECT uc\.uid, uc\.email, uc\.first_name, uc\.last_name, uc\.phone_number, uc\.account_status/i.test(flat)) {
    const u = store.users.find((x) => x.uid === params[0]);
    if (!u) return done([]);
    const p = store.profiles.find((x) => x.uid === params[0]) ?? {};
    // PROJECT what the SELECT list actually names. Returning the whole merged row
    // meant a query could name a column that does not exist and still receive a
    // populated row, because the caller then read the key it wanted from a row
    // the fake had over-supplied. That is how `up.public_biography` — a column no
    // migration has ever created — passed here while raising 42703 on a real
    // server. A fake that answers questions it was not asked cannot catch a
    // question that was asked wrongly.
    return done([projectSelected(flat, { ...u, ...p })]);
  }
  if (/FROM servana\.worker_requirements WHERE worker_uid = \$1 AND COALESCE/i.test(flat)) {
    const accepted = store.requirements.filter(
      (r) => r.worker_uid === params[0]
        && ['approved', 'accepted', 'verified'].includes(String(r.status).toLowerCase()),
    ).length;
    return done([{ accepted }]);
  }
  if (/^SELECT id, requirement_type, status, created_at, expiry_date, review_note/i.test(flat)) {
    return done(store.requirements.filter((r) => r.worker_uid === params[0]));
  }
  // The WHERE column is part of the match, deliberately. Matching on the SELECT
  // list alone accepted `WHERE es.worker_uid = $1`, which PostgreSQL answers with
  // 42703 — so the fake was strictly more permissive than the server it stands in
  // for, and a wider predicate passes while production is broken. Anything that
  // does not match falls through to the unrouted-SQL throw at the end.
  if (/^SELECT es\.service_id, es\.status, sv\.name/i.test(flat)
      && /WHERE es\.employee_uid = \$1/i.test(flat)) {
    return done(store.employeeServices.filter((e) => e.employee_uid === params[0]));
  }

  // ── addresses ─────────────────────────────────────────────────────────────
  if (/^SELECT address_id, label, address_one, address_two, post_town, zip_code, country, location_id, is_primary, created_at FROM servana\.user_address WHERE uid = \$1 ORDER BY/i.test(flat)) {
    return done(
      addressesFor(String(params[0])).sort((a, b) => {
        if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
        return String(a.created_at).localeCompare(String(b.created_at));
      }),
    );
  }
  if (/^SELECT address_id, label, address_one, address_two, post_town, zip_code, country, location_id, is_primary, created_at FROM servana\.user_address WHERE uid = \$1 AND address_id = \$2/i.test(flat)) {
    // OWNER-SCOPED. A foreign id resolves to nothing rather than to a row the
    // caller then has to be trusted not to read.
    const row = store.addresses.find((a) => a.uid === params[0] && a.address_id === params[1]);
    return done(row ? [row] : []);
  }
  if (/^SELECT COUNT\(\*\)::int AS count FROM servana\.user_address WHERE uid = \$1 AND is_primary = TRUE/i.test(flat)) {
    return done([{ count: defaultsFor(String(params[0])).length }]);
  }
  if (/^SELECT COUNT\(\*\)::int AS count FROM servana\.user_address WHERE uid = \$1/i.test(flat)) {
    return done([{ count: addressesFor(String(params[0])).length }]);
  }
  if (/^SELECT address_id FROM servana\.user_address WHERE uid = \$1 AND address_id = \$2 FOR UPDATE/i.test(flat)) {
    const row = store.addresses.find((a) => a.uid === params[0] && a.address_id === params[1]);
    return done(row ? [{ address_id: row.address_id }] : []);
  }
  if (/^SELECT address_id, is_primary FROM servana\.user_address WHERE uid = \$1 AND address_id = \$2 FOR UPDATE/i.test(flat)) {
    const row = store.addresses.find((a) => a.uid === params[0] && a.address_id === params[1]);
    return done(row ? [{ address_id: row.address_id, is_primary: row.is_primary }] : []);
  }
  if (/^SELECT address_id FROM servana\.user_address WHERE uid = \$1 ORDER BY created_at ASC LIMIT 1/i.test(flat)) {
    const oldest = addressesFor(String(params[0]))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
    return done(oldest ? [{ address_id: oldest.address_id }] : []);
  }
  if (/^UPDATE servana\.user_address SET is_primary = FALSE WHERE uid = \$1 AND is_primary = TRUE AND address_id <> \$2/i.test(flat)) {
    let n = 0;
    for (const row of store.addresses) {
      if (row.uid === params[0] && row.is_primary === true && row.address_id !== params[1]) {
        row.is_primary = false;
        n += 1;
      }
    }
    return { rows: [], rowCount: n };
  }
  if (/^UPDATE servana\.user_address SET is_primary = TRUE WHERE uid = \$1 AND address_id = \$2/i.test(flat)) {
    const row = store.addresses.find((a) => a.uid === params[0] && a.address_id === params[1]);
    if (row) row.is_primary = true;
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  if (/^DELETE FROM servana\.user_address WHERE uid = \$1 AND address_id = \$2/i.test(flat)) {
    const before = store.addresses.length;
    store.addresses = store.addresses.filter(
      (a) => !(a.uid === params[0] && a.address_id === params[1]),
    );
    return { rows: [], rowCount: before - store.addresses.length };
  }
  // The LEGACY writer, delegated to so the geocode sync has one caller.
  if (/^INSERT INTO servana\.user_address/i.test(flat)) {
    const row = seedAddress(String(params[1]), {
      address_id: String(params[0]),
      location_id: params[2] ?? null,
      address_one: params[3] ?? null,
      address_two: params[4] ?? null,
      zip_code: params[5] ?? null,
      post_town: params[6] ?? null,
      country: params[7] ?? null,
      label: params[10] ?? null,
      is_primary: params[11] === true,
    });
    return done([row]);
  }
  if (/^UPDATE servana\.user_address SET/i.test(flat) && /address_id = \$/i.test(flat)) {
    // The legacy multi-column update. Ownership is the trailing predicate.
    const addressId = params[params.length - 2];
    const owner = params[params.length - 1];
    const row = store.addresses.find((a) => a.address_id === addressId && a.uid === owner);
    return done(row ? [row] : []);
  }
  if (/^SELECT \* from servana\.user_address WHERE address_id = \$1/i.test(flat)) {
    const row = store.addresses.find((a) => a.address_id === params[0]);
    return done(row ? [row] : []);
  }

  // ── user profile write (the ONE writer) ───────────────────────────────────
  if (/^INSERT INTO servana\.user_profile/i.test(flat)) {
    const [birthdate, gender, photoUrl, uid] = params as any[];
    let row = store.profiles.find((p) => p.uid === uid);
    if (!row) { row = { uid }; store.profiles.push(row); }
    if (birthdate != null) row.birthdate = birthdate;
    if (gender != null) row.gender = gender;
    if (photoUrl != null) row.photo_url = photoUrl;
    return done([row]);
  }
  if (/^UPDATE servana\.user_credentials SET/i.test(flat)) {
    const u = store.users.find((x) => x.uid === params[params.length - 1]);
    return done(u ? [u] : []);
  }
  if (/FROM servana\.user_credentials uc LEFT JOIN servana\.user_profile up/i.test(flat)) {
    const u = store.users.find((x) => x.uid === params[0]);
    if (!u) return done([]);
    const p = store.profiles.find((x) => x.uid === params[0]) ?? {};
    return done([{ ...u, ...p }]);
  }

  // ── settings ──────────────────────────────────────────────────────────────
  if (/^SELECT setting_id, value FROM servana\.account_settings WHERE uid = \$1/i.test(flat)) {
    return done(store.settings.filter((x) => x.uid === params[0]));
  }
  if (/^INSERT INTO servana\.account_settings/i.test(flat)) {
    const [uid, settingId, value] = params as any[];
    const existing = store.settings.find((x) => x.uid === uid && x.setting_id === settingId);
    if (existing) existing.value = value;
    else store.settings.push({ uid, setting_id: settingId, value });
    return done([]);
  }

  // ── notification preferences (TAB 09, pointed at by settings) ─────────────
  if (/servana\.provider_notification_preferences/i.test(flat)) {
    return done([]);
  }
  // Device count, for the security surface.
  if (/^SELECT token FROM servana\.account_device_tokens/i.test(flat)) {
    return done([]);
  }

  throw new Error(`accountDbFake: unrouted SQL — ${flat.slice(0, 220)}`);
};

export const dbQueryFake = {
  query: async (sql: string, params: unknown[] = []) => run(sql, params),
};

/** A `pool` whose client shares the same router, so transactions are real. */
export const poolFake = {
  connect: async () => ({
    query: async (sql: string, params: unknown[] = []) => run(sql, params),
    release: () => undefined,
  }),
};
