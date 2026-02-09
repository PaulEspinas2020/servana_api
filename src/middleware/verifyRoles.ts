import { db } from "../config";
import dbQuery from "../db/dbQuery";
const dbSchema = db.schema;
import { errorMessage, status } from "../helpers/status";

const verifyRoles = (allowedRoles: number[]) => async (req: any, res: any, next: any) => {
    try {
        const searchQuery = `SELECT email, "role"
      FROM ${dbSchema}.user_credentials where email = '${req["user"].email}';`;

        const { rows } = await dbQuery.query(searchQuery, []);

        if (allowedRoles.includes(rows[0].role)) {
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
