import { db } from "../config";
import dbQuery from "../db/dbQuery";
import { decisionFor, recordAuthzDecision, routeIdOf } from "../observability/authzAudit";
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
      // Which rule refused, so a 403 is diagnosable without log archaeology.
      recordAuthzDecision(
        decisionFor(req, {
          outcome: "deny",
          rule: "role",
          routeId: routeIdOf(req),
          reason: "FORBIDDEN_ROLE",
        }),
      );
      res.status(403).json({
        status: "failed",
        code: "FORBIDDEN_ROLE",
        message: "You do not have permission to access this API",
      });
    }
  } catch {
    // A lookup failure is not a verdict about the role, and is recorded as an
    // authentication-layer refusal so it cannot be read as one.
    recordAuthzDecision(
      decisionFor(req, {
        outcome: "deny",
        rule: "authentication",
        routeId: routeIdOf(req),
        reason: "ROLE_LOOKUP_FAILED",
      }),
    );
    res.status(403).json({
      status: "failed",
      code: "FORBIDDEN_ROLE",
      message: "You do not have permission to access this API",
    });
  }
};

export default verifyRoles;
