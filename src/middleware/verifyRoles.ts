import { db } from "../config";
import dbQuery from "../db/dbQuery";
const dbSchema = db.schema;
import { errorMessage, status } from "../helpers/status";

// Looks up role by UID (always present on decoded Firebase tokens — works for both
// email-auth and phone-auth providers; the old email-based lookup failed for phone-only users).
const verifyRoles = (allowedRoles: number[]) => async (req: any, res: any, next: any) => {
    try {
        const { rows } = await dbQuery.query(
            `SELECT "role" FROM ${dbSchema}.user_credentials WHERE uid = $1`,
            [req.user.uid]
        );

        if (rows.length > 0 && allowedRoles.includes(rows[0].role)) {
            next();
        } else {
            throw Error();
        }
    } catch (error) {
        errorMessage.error = "Authentication Failed: User not allowed to access this API";
        res.status(status.unauthorized).send(errorMessage);
    }
};

export default verifyRoles;
