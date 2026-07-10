import { db } from "../config";
import dbQuery from "../db/dbQuery";
const dbSchema = db.schema;

// Looks up role by UID. Uses Number() coercion so DB string "1" matches numeric allowedRole 1.
const verifyRoles = (allowedRoles: number[]) => async (req: any, res: any, next: any) => {
  try {
    const { rows } = await dbQuery.query(
      `SELECT "role" FROM ${dbSchema}.user_credentials WHERE uid = $1`,
      [req.user.uid]
    );

    const dbRole = rows.length > 0 ? Number(rows[0].role) : NaN;

    if (!isNaN(dbRole) && allowedRoles.includes(dbRole)) {
      next();
    } else {
      res.status(403).json({
        status: "failed",
        code: "FORBIDDEN_ROLE",
        message: "You do not have permission to access this API",
      });
    }
  } catch {
    res.status(403).json({
      status: "failed",
      code: "FORBIDDEN_ROLE",
      message: "You do not have permission to access this API",
    });
  }
};

export default verifyRoles;
