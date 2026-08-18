/**
 * Who counts as a provider.
 *
 * Both 2 and 4 are provider roles. A check written as `role = 2` is wrong, and
 * has been written that way more than once — which is the reason this lives in
 * one file that everything imports rather than as a literal at each call site.
 *
 * Stored as strings because `user_credentials.role` is read back as text by the
 * pg driver in some paths and as a number in others; comparing the string form
 * avoids a silent `"2" !== 2` miss.
 */
export const PROVIDER_ROLES: ReadonlySet<string> = new Set(["2", "4"]);

/**
 * Whether a role value from the database is a provider role.
 *
 * Null, undefined, empty and unrecognised all answer false. Note the contrast
 * with `account_status`, where ABSENCE is deliberately permitted: that column
 * was added after accounts already existed, so a null there means "nothing was
 * ever written" and blocking on it caused a production outage. `role` is NOT
 * NULL and has always been populated — every one of the 109 production accounts
 * carries one — so an absent role is a genuinely unknown actor, not a legacy
 * one, and denies.
 */
export const isProviderRole = (role: unknown): boolean => {
  if (role === null || role === undefined) return false;
  const s = String(role).trim();
  return s !== "" && PROVIDER_ROLES.has(s);
};

/**
 * The provider roles as a SQL list, derived from the set above.
 *
 * Exists so raw SQL never retypes `2, 4`. `adminBookingService` had
 * `role::int = 2` in two places and `role::int IN (2, 4)` in a third — the
 * same file disagreeing with itself, which meant an admin could not assign a
 * role-4 provider and was told "Provider not found".
 *
 * Safe to interpolate: the values come from this module's own constant, never
 * from a request. Asserted numeric below so it cannot become an injection
 * point if PROVIDER_ROLES ever gains a non-numeric member.
 */
export const providerRoleSqlList = (): string => {
  const values = [...PROVIDER_ROLES].map((role) => {
    const n = Number(role);
    if (!Number.isInteger(n)) {
      throw new Error(`Non-numeric provider role cannot be inlined into SQL: ${role}`);
    }
    return String(n);
  });
  return values.join(', ');
};

/** `role::int IN (2, 4)` for a given column, built from the canonical set. */
export const providerRoleSqlPredicate = (column: string): string =>
  `${column}::int IN (${providerRoleSqlList()})`;
