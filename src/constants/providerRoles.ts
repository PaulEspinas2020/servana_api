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
