import dbQuery from '../db/dbQuery';
import { db as dbSchema } from '../config';
import { auditFire } from './adminAuditService';

export interface AdminUserListParams {
  search?: string;
  page?: number;
  limit?: number;
}

export async function listUsers(params: AdminUserListParams) {
  const page = Math.max(1, Number(params.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 25));
  const offset = (page - 1) * limit;
  const values: unknown[] = [];
  let where = '';

  if (params.search?.trim()) {
    values.push(`%${params.search.trim()}%`);
    where = `WHERE (uc.email ILIKE $1 OR uc.phone_number ILIKE $1 OR CONCAT_WS(' ', uc.first_name, uc.last_name) ILIKE $1)`;
  }

  const count = await dbQuery.query(
    `SELECT COUNT(*)::int AS total FROM ${dbSchema}.user_credentials uc ${where}`,
    values,
  );
  values.push(limit, offset);
  const rows = await dbQuery.query(
    `SELECT uc.uid, uc.email, uc.phone_number, uc.first_name, uc.last_name,
            uc.role, uc.account_status, COALESCE(uc.is_archive, false) AS is_archive,
            uc.is_email_verified, uc.created_date
       FROM ${dbSchema}.user_credentials uc
       ${where}
      ORDER BY uc.created_date DESC NULLS LAST
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );

  return {
    data: rows.rows.map((row: any) => ({
      uid: row.uid,
      email: row.email ?? null,
      phoneNumber: row.phone_number ?? null,
      firstName: row.first_name ?? '',
      lastName: row.last_name ?? '',
      fullName: [row.first_name, row.last_name].filter(Boolean).join(' '),
      role: Number(row.role),
      accountStatus: row.account_status ?? null,
      isArchive: Boolean(row.is_archive),
      isEmailVerified: Boolean(row.is_email_verified),
      createdAt: row.created_date ?? null,
    })),
    total: Number(count.rows[0]?.total ?? 0),
    page,
    limit,
  };
}

export async function setUserArchive(
  uid: string,
  isArchive: boolean,
  actorUid: string,
  reason: string,
) {
  if (!reason.trim()) {
    throw Object.assign(new Error('reason is required'), { statusCode: 400 });
  }
  if (uid === actorUid) {
    throw Object.assign(new Error('Administrators cannot archive their own account here'), { statusCode: 409 });
  }

  const before = await dbQuery.query(
    `SELECT uid, role, is_archive, account_status FROM ${dbSchema}.user_credentials WHERE uid = $1`,
    [uid],
  );
  if (!before.rowCount) throw Object.assign(new Error('User not found'), { statusCode: 404 });
  if (Number(before.rows[0].role) === 1) {
    throw Object.assign(new Error('Admin accounts must be managed through Admin Users'), { statusCode: 409 });
  }

  const updated = await dbQuery.query(
    `UPDATE ${dbSchema}.user_credentials SET is_archive = $1 WHERE uid = $2
     RETURNING uid, role, account_status, is_archive`,
    [isArchive, uid],
  );
  const row = updated.rows[0];
  auditFire({
    action: isArchive ? 'user_archived' : 'user_restored',
    actionCategory: 'user', outcome: 'success', actorUid,
    entityType: 'user', entityId: uid,
    before: { isArchive: Boolean(before.rows[0].is_archive) },
    after: { isArchive: Boolean(row.is_archive) }, reason: reason.trim(),
    source: 'admin_portal',
  });
  return { uid: row.uid, role: Number(row.role), accountStatus: row.account_status, isArchive: Boolean(row.is_archive) };
}
