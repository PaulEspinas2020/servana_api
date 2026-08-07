import { NextFunction, Request, Response } from 'express';
import { db } from '../config';
import dbQuery from '../db/dbQuery';
import { adminError } from '../helpers/adminError';

/** Prevent provider-scoped endpoints from reading or mutating client/admin accounts by UID. */
export default async function requireProviderTarget(req: Request, res: Response, next: NextFunction) {
  try {
    const uid = String(req.params.uid ?? '').trim();
    if (!uid) return adminError(res, 400, 'BUSINESS_RULE', 'Provider uid is required');
    const result = await dbQuery.query(
      `SELECT 1 FROM ${db.schema}.user_credentials WHERE uid = $1 AND role::int IN (2,4) LIMIT 1`,
      [uid],
    );
    if (!result.rowCount) return adminError(res, 404, 'NOT_FOUND', 'Provider not found');
    next();
  } catch (error) {
    return adminError(res, 500, 'SERVER_ERROR', 'Provider target validation failed');
  }
}
