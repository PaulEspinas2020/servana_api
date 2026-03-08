import { db } from "../config";
import dbQuery from "../db/dbQuery";
const dbSchema = db.schema;

export const computeQuote = async (req: QuoteRequest) => {
  // Base price
  const baseRes = await dbQuery.query(
    `SELECT id, base_price FROM ${dbSchema}.service_options WHERE id=$1 AND option_type='MAIN'`,
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

  // Add-ons
  let addonsTotal = 0;
  let addons: { id: number; level_3: string; base_price: number }[] = [];

  if (req.addonOptionIds?.length) {
    const addonsRes = await dbQuery.query(
      `SELECT id, level_3, base_price
       FROM ${dbSchema}.service_options
       WHERE id = ANY($1) AND option_type='ADD_ON'`,
      [req.addonOptionIds]
    );
    addons = addonsRes.rows;
    addonsTotal = addons.reduce((s, a) => s + Number(a.base_price || 0), 0);
  }

  // Parts
  const parts = req.parts || [];
  const partsTotal = parts.reduce((s, p) => s + p.qty * p.unit_price, 0);

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
