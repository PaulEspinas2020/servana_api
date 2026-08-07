import { db } from "../config";
import dbQuery from "../db/dbQuery";
const dbSchema = db.schema;

/**
 * Servana Transportation Fee Matrix
 * Based on distance between worker and customer location.
 *
 *  0–5 km   → FREE
 *  6–10 km  → ₱110
 *  11–15 km → ₱160
 *  16–20 km → ₱250
 *  21–25 km → ₱400
 *  >25 km   → ₱500
 */
export const computeTranspoFee = (distanceKm: number): number => {
  if (distanceKm <= 5)  return 0;
  if (distanceKm <= 10) return 110;
  if (distanceKm <= 15) return 160;
  if (distanceKm <= 20) return 250;
  if (distanceKm <= 25) return 400;
  return 500;
};

export const computeQuote = async (req: QuoteRequest) => {
  const baseRes = await dbQuery.query(
    `SELECT id, base_price FROM ${dbSchema}.service_options
     WHERE id=$1 AND option_type='MAIN' AND is_active=true`,
    [req.optionId]
  );
  if (!baseRes.rowCount) throw new Error("Invalid service option.");

  const base = Number(baseRes.rows[0].base_price || 0);

  const getModifier = async (type: string, key?: string) => {
    if (!key) return 0;
    const r = await dbQuery.query(
      `SELECT amount FROM ${dbSchema}.pricing_modifiers
       WHERE service_option_id=$1 AND modifier_type=$2 AND key=$3`,
      [req.optionId, type, key]
    );
    return r.rowCount ? Number(r.rows[0].amount) : 0;
  };

  const hp = await getModifier("HP", req.hpKey);
  const height = await getModifier("HEIGHT", req.heightKey);
  const distance = await getModifier("DISTANCE", req.distanceKey);

  let addonsTotal = 0;
  let addons: { id: number; level_3: string; base_price: number }[] = [];

  if (req.addonOptionIds?.length) {
    const addonsRes = await dbQuery.query(
      `SELECT id, level_3, base_price
       FROM ${dbSchema}.service_options
       WHERE id = ANY($1)
         AND option_type='ADD_ON'
         AND parent_option_id=$2
         AND is_active=true`,
      [req.addonOptionIds, req.optionId]
    );
    addons = addonsRes.rows;
    addonsTotal = addons.reduce((s, a) => s + Number(a.base_price || 0), 0);
  }

  // `parts` used to be reduced into a total by multiplying each entry's
  // quantity by a per-unit price taken from the REQUEST BODY.
  //
  // (The expression is described rather than quoted: a regression test greps
  // this file for it, and reproducing it here would defeat that —
  // tests/quote-price-integrity.test.ts.) Every other input to this total is
  // server-sourced — `base` from a service_options lookup, the three modifiers
  // from pricing_modifiers scoped to the option, add-ons re-priced from the DB
  // by id — and `parts` alone was taken on trust. The result flowed into
  // quoted_price, final_price and the payments row (bookingService.ts:80-104),
  // so a caller could name their own total, including a negative one.
  //
  // No shipped client sends a populated array: ServanaClient's aircon store
  // sends `'parts': <dynamic>[]` (aircon_booking_store.dart:361) and the
  // beauty/wellness store omits the key. So dropping the priced form breaks
  // nothing today and closes the hole.
  //
  // Deliberately NOT replaced with a server-side parts lookup: there is no
  // parts table in this schema, so inventing one here would be speculative.
  // When parts become a real feature they must arrive as {part_id, qty} and be
  // priced from the database, exactly as add-ons already are above.
  const partsTotal = 0;
  const parts: never[] = [];

  const final = base + hp + height + distance + addonsTotal + partsTotal;

  return {
    base,
    modifiers: { hp, height, distance },
    addons,
    addonsTotal,
    parts,
    partsTotal,
    final,
  };
};
