/**
 * Account deletion requests (Google Play "Data deletion" policy).
 *
 * Play requires any app that lets people create an account to offer BOTH an
 * in-app route to delete it and a publicly reachable web route, without
 * requiring the person to reinstall or sign in again to find it.
 *
 * ── Why this records a REQUEST rather than deleting the row ──────────────────
 * `user_credentials.uid` is referenced by bookings, logs, user_address,
 * employee_services and worker_requirements. Only some of those cascade, so a
 * DELETE would simply throw a foreign-key violation the moment an account has
 * any history — which is every account worth deleting. More to the point,
 * bookings and payouts are financial records: erasing them on request is not
 * something a login-adjacent endpoint should decide, and retention of
 * transaction records is a legitimate basis under the DPA.
 *
 * So the request is captured, acknowledged, and executed by an operator who can
 * anonymise the identity columns while leaving the financial trail intact. The
 * policy requirement is that the person can ASK and be told what happens; it is
 * not that the row vanishes synchronously.
 *
 * ── On enumeration ───────────────────────────────────────────────────────────
 * The public form takes an email or mobile from an UNAUTHENTICATED caller. It
 * therefore behaves identically whether or not the identifier matches an
 * account: same status, same body, same amount of work. A form that answered
 * "no such account" would be a free membership oracle for anyone holding a list
 * of numbers — the same reasoning as `identifierResolver`, and it has to hold
 * here too or the careful work there is undone by this endpoint.
 */

import dbQuery from "../db/dbQuery";
import { db } from "../config";
import { resolveIdentifier } from "./identifierResolver";

const s = db.schema;

export type DeletionSource = "app" | "web";

export const ensureAccountDeletionTable = async (): Promise<void> => {
  await dbQuery.query(
    `CREATE TABLE IF NOT EXISTS ${s}.account_deletion_requests (
       id              BIGSERIAL PRIMARY KEY,
       uid             VARCHAR(128),
       identifier      VARCHAR(254) NOT NULL,
       identifier_type VARCHAR(10)  NOT NULL,
       source          VARCHAR(10)  NOT NULL,
       status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
       requested_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
       processed_at    TIMESTAMPTZ,
       processed_by    VARCHAR(128),
       note            TEXT
     )`,
    []
  );

  // One open request per identifier. Someone who submits the form three times
  // because nothing visibly happened should not create three tickets for an
  // operator to reconcile — and the partial predicate means a NEW request can
  // still be filed after an earlier one is processed.
  await dbQuery.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_adr_open_identifier
       ON ${s}.account_deletion_requests (identifier)
       WHERE status = 'pending'`,
    []
  );

  await dbQuery.query(
    `CREATE INDEX IF NOT EXISTS idx_adr_pending
       ON ${s}.account_deletion_requests (requested_at)
       WHERE status = 'pending'`,
    []
  );
};

/**
 * Record a deletion request for a typed identifier.
 *
 * Returns nothing the caller can use to distinguish a match from a miss. That
 * is deliberate — see the enumeration note above. `uid` is stored when it
 * resolves, purely so the operator working the queue does not have to redo the
 * lookup by hand.
 */
export async function recordDeletionRequest(
  rawIdentifier: unknown,
  source: DeletionSource
): Promise<void> {
  const resolution = await resolveIdentifier(rawIdentifier);

  // A malformed identifier is not an error the caller gets to see. Storing it
  // would put unvalidated free text in the operator queue for no benefit, so it
  // is dropped here and the caller still receives the standard acknowledgement.
  if (!resolution.normalized || resolution.type === "unknown") return;

  await dbQuery.query(
    `INSERT INTO ${s}.account_deletion_requests
       (uid, identifier, identifier_type, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [resolution.account?.uid ?? null, resolution.normalized, resolution.type, source]
  );
}

/**
 * Record a deletion request for an already-authenticated caller.
 *
 * Separate from the public path because there is nothing to resolve and nothing
 * to hide: the session already proves who this is. It reads the account's own
 * identifiers so the operator queue keys on the same value the web form would
 * have produced, rather than on a uid alone.
 */
export async function recordDeletionRequestForUid(uid: string): Promise<void> {
  const { rows } = await dbQuery.query(
    `SELECT COALESCE(email_normalized, LOWER(BTRIM(email)))    AS email_key,
            COALESCE(phone_normalized, phone_number)           AS phone_key
       FROM ${s}.user_credentials
      WHERE uid = $1
      LIMIT 1`,
    [uid]
  );

  const row = rows[0];
  // Fall back to the uid itself so a request is never silently lost for an
  // account that happens to carry neither a usable email nor a usable phone.
  const identifier: string = row?.email_key || row?.phone_key || uid;
  const identifierType = row?.email_key ? "email" : row?.phone_key ? "mobile" : "uid";

  await dbQuery.query(
    `INSERT INTO ${s}.account_deletion_requests
       (uid, identifier, identifier_type, source)
     VALUES ($1, $2, $3, 'app')
     ON CONFLICT DO NOTHING`,
    [uid, identifier, identifierType]
  );
}
