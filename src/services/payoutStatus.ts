/**
 * One source of truth for what a disbursement's status means.
 *
 * Command 20 §1 (F-03), carried from C17-02. Three functions in
 * `providerController` read the SAME `disbursements.status` column and answered
 * three different words:
 *
 *   normalizePayoutStatus  →  disbursed / failed_or_on_hold / pending / processing
 *   _mapPayoutStatus       →  paid      / failed            / pending
 *   getLedger (F-01)       →  settled   / failed            / pending
 *
 * The third dialect is mine — the F-01 fix had to stop the ledger hardcoding
 * `settled`, and introduced `settled` as a value in doing so. Correct fix,
 * wider problem.
 *
 * ── Why the dialects still exist ─────────────────────────────────────────────
 * They are kept, byte-for-byte, because five surfaces consume them and renaming
 * a value silently changes what a provider is told about their own money.
 * Servana.com.ph's payout mapper branches on the literal strings `disbursed`,
 * `failed_or_on_hold`, `on_hold` and `disputed`; ServanaWorker's dashboard
 * store branches on `disbursed` and `failed_or_on_hold`. What changes here is
 * that all three dialects are now DERIVED from one canonical value instead of
 * being hand-written three times, so they can no longer drift apart — and every
 * endpoint additionally reports the canonical value, which consumers can move
 * to at their own pace.
 *
 * ── The distinction the dialects lose ────────────────────────────────────────
 * §1: "Pending, available, held, processing, paid, reversed, and disputed
 * values must remain distinct." Two of the three dialects collapse PROCESSING
 * into `pending`, so a payout actively being released is indistinguishable from
 * one that has not started. `payoutStatusCanonical` keeps them apart.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────
 * §1 also names `available`, `held`, `reversed` and `disputed`.
 * `disbursements.status` is only ever PENDING, PROCESSING, RELEASED or FAILED,
 * so this module cannot distinguish states the data does not record. Inventing
 * them would produce a vocabulary that looks richer than the truth behind it.
 * Holds and disputes live in `booking_escalations`, and belong to whatever
 * reads that.
 */

/** Every state a disbursement can actually be in, plus a term for "not one of these". */
export type PayoutStatus = "pending" | "processing" | "paid" | "failed" | "unknown";

/** The whole vocabulary of `disbursements.status`, per disbursement.service.ts. */
const CANONICAL: Readonly<Record<string, PayoutStatus>> = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  RELEASED: "paid",
  FAILED: "failed",
});

/**
 * A missing status means no disbursement row exists yet — the booking is
 * completed but nothing has been calculated. That is genuinely pending, and all
 * three dialects have always treated it so.
 */
export const canonicalPayoutStatus = (raw: unknown): PayoutStatus => {
  if (raw === null || raw === undefined) return "pending";
  const s = String(raw).trim();
  if (s === "") return "pending";
  return CANONICAL[s.toUpperCase()] ?? "unknown";
};

/**
 * `/provider/earnings` and job cards. Emits `disbursed` / `failed_or_on_hold`,
 * and passes anything unrecognised through in lowercase.
 *
 * The passthrough is preserved rather than corrected: it is the only reason
 * `processing` reaches a consumer at all today, and collapsing it to `pending`
 * to tidy the function would delete the one place §1's distinction survives.
 */
export const earningsPayoutDialect = (raw: string | null | undefined): string => {
  if (!raw) return "pending";
  const c = canonicalPayoutStatus(raw);
  if (c === "paid") return "disbursed";
  if (c === "failed") return "failed_or_on_hold";
  if (c === "unknown") return String(raw).toLowerCase();
  return c;
};

/** `/provider/payouts`. Emits `paid` / `failed` / `pending`. */
export const payoutsPayoutDialect = (raw: string | null | undefined): string => {
  const c = canonicalPayoutStatus(raw);
  if (c === "paid") return "paid";
  if (c === "failed") return "failed";
  return "pending";
};

/** `/provider/ledger`. Emits `settled` / `failed` / `pending`. */
export const ledgerPayoutDialect = (raw: string | null | undefined): string => {
  const c = canonicalPayoutStatus(raw);
  if (c === "paid") return "settled";
  if (c === "failed") return "failed";
  return "pending";
};
