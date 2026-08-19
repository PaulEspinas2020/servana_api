/**
 * Philippine mobile numbers as an ACCOUNT IDENTIFIER (Command 5 §5).
 *
 * There was already a `normalizePhilippinePhone` in adminCreateBookingService,
 * used for guest contact numbers. It cannot fail: its last line is
 * `return raw.startsWith('+') ? raw : '+' + cleaned`, so "not a number" becomes
 * "+notanumber". That is defensible for a guest's contact field, where storing
 * whatever the admin typed beats rejecting a booking — but it is exactly wrong
 * for an identifier.
 *
 * §5 says an invalid number must not be silently turned into a valid-looking
 * one, and the reason is concrete: a normalizer that always succeeds produces a
 * DISTINCT output for every malformed spelling, so a uniqueness index over it
 * cannot catch duplicates. Two typos of the same number become two accounts,
 * which is the failure §15 exists to prevent.
 *
 * So: strict here, returning null on anything that is not a real PH mobile
 * number, and the lenient helper now delegates to this and applies its fallback
 * explicitly rather than by accident.
 *
 * Deliberately not a library. libphonenumber is the right answer for
 * international numbers and should be adopted when an international selector
 * lands; for PH mobiles the rules are small, fixed and testable, and adding a
 * dependency to the auth path is not free.
 */

/** PH mobile prefixes are 9XX — the subscriber number is always 10 digits. */
const PH_MOBILE = /^9\d{9}$/;

/**
 * Normalise a Philippine mobile number to E.164, or return null.
 *
 * Accepts the forms a person actually types:
 *   0917 123 4567 · 0917-123-4567 · 9171234567 · +63 917 123 4567 ·
 *   63 917 123 4567 · (0917) 123-4567
 *
 * All become `+639171234567`.
 */
export function toE164PhMobile(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  // Strip only formatting a human would type. Anything else left behind is a
  // character that has no business in a phone number, and the digit check below
  // will reject it rather than quietly dropping it.
  const cleaned = raw.replace(/[\s\-().]/g, "").replace(/^\+/, "");

  if (!/^\d+$/.test(cleaned)) return null;

  let subscriber: string | null = null;

  if (cleaned.length === 12 && cleaned.startsWith("63")) {
    subscriber = cleaned.slice(2); // +63 9XXXXXXXXX
  } else if (cleaned.length === 11 && cleaned.startsWith("0")) {
    subscriber = cleaned.slice(1); // 09XXXXXXXXX
  } else if (cleaned.length === 10) {
    subscriber = cleaned; // 9XXXXXXXXX
  }

  if (!subscriber || !PH_MOBILE.test(subscriber)) return null;
  return `+63${subscriber}`;
}

/** True when [raw] is a usable PH mobile identifier. */
export const isValidPhMobile = (raw: unknown): boolean =>
  toE164PhMobile(raw) !== null;

/**
 * Display form for a stored E.164 number: `+639171234567` → `0917 123 4567`.
 *
 * Local format because that is how a Filipino provider reads their own number
 * back and recognises it.
 */
export function formatPhMobileForDisplay(e164: string | null | undefined): string {
  const n = toE164PhMobile(e164);
  if (!n) return e164 ?? "";
  const d = n.slice(3); // 9XXXXXXXXX
  return `0${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

/**
 * Masked form for recovery and security screens (§5).
 *
 * `+639171234567` → `0917 •••• 567`. Enough for the owner to recognise, not
 * enough for someone reading over their shoulder to write down.
 */
export function maskPhMobile(e164: string | null | undefined): string {
  const n = toE164PhMobile(e164);
  if (!n) return "";
  const d = n.slice(3);
  return `0${d.slice(0, 3)} •••• ${d.slice(7)}`;
}

// ── Email ────────────────────────────────────────────────────────────────────

/**
 * Normalise an email for UNIQUENESS and lookup (§4).
 *
 * Trims, lower-cases the domain, and lower-cases the local part.
 *
 * Lower-casing the local part is a deliberate policy choice, not an oversight:
 * RFC 5321 permits case-sensitive local parts, but no mail provider Servana's
 * users will plausibly hold treats them that way, and the alternative is that
 * `Juan@gmail.com` and `juan@gmail.com` become two provider accounts. That
 * failure is far more likely, and far more damaging, than the theoretical
 * address that needs its case preserved.
 *
 * Deliberately does NOT strip periods or `+tags`. Those are Gmail-specific, and
 * applying them platform-wide would collapse genuinely distinct addresses at
 * every other provider (§4: no provider-specific assumptions).
 *
 * The display form is stored separately; this is only for comparison.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 254) return null;

  // Reject anything with whitespace or control characters inside — those are
  // paste accidents and homograph attempts, not addresses.
  if (/[\s\x00-\x1f\x7f-\u009f\u200b-\u200f\ufeff]/.test(trimmed)) return null;

  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  if (local.length > 64) return null;
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return null;
  if (domain.includes("..")) return null;

  return `${local.toLowerCase()}@${domain.toLowerCase()}`;
}

export const isValidEmail = (raw: unknown): boolean => normalizeEmail(raw) !== null;

// ── Identifier type detection (§7) ───────────────────────────────────────────

export type IdentifierType = "email" | "mobile" | "unknown";

/**
 * What did the provider type into the one sign-in field?
 *
 * An `@` means they meant an email, even a malformed one — telling someone who
 * typed `juan@gmial` that their MOBILE NUMBER is invalid is worse than useless.
 */
export function detectIdentifierType(raw: unknown): IdentifierType {
  if (typeof raw !== "string" || !raw.trim()) return "unknown";
  const t = raw.trim();
  if (t.includes("@")) return "email";
  if (isValidPhMobile(t)) return "mobile";
  return "unknown";
}
