import { db } from "../config";
import dbQuery from "../db/dbQuery";
const dbSchema = db.schema;

const createLogEntry = async (activity: string, log_by: string, reference_id: string, module_reference: string) => {
    const queryText = `
        INSERT INTO ${dbSchema}.logs (activity, log_by, reference_id, module_reference)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `;
    const values = [activity, log_by, reference_id, module_reference];
    try {
        const { rows } = await dbQuery.query(queryText, values);
        if (!rows && rows.length === 0) {
            return null;
        }
        return rows[0];
    } catch (error) {
        throw error;
    }
};

export {
    createLogEntry
}
