/**
 * The canonical address book.
 *
 * ## What was wrong
 *
 * Five legacy routes with five shapes: `GET /user/alluseraddresses`,
 * `GET /user/getaddressbyid?id=`, `POST /user/adduseraddress` (which doubles as
 * an update when the body happens to carry an `addressId`),
 * `PUT /user/makeaddressprimary?addressId=` and
 * `DELETE /user/deleteaddress?addressId=`. Ids in query strings, a create verb
 * that updates, and a separate verb for a boolean.
 *
 * Two things were actually broken underneath that:
 *
 *   1. **Ownership was checked in a CONTROLLER, not in SQL.**
 *      `getAddressByAddressId(addressId)` selects by id alone and the handler
 *      compares `dbResponse.userId !== uid` afterwards. That is correct today and
 *      is one careless caller away from not being — the row is already in memory
 *      by the time anybody asks whose it is. Every statement here carries
 *      `AND uid = $n`.
 *
 *   2. **Setting a default was TWO statements with no transaction.**
 *      `makeAddressPrimary` set the new one, then `makeOtherAddressNotPrimary`
 *      cleared the rest. A failure between them leaves an account with two
 *      primaries, and every reader picks whichever the planner returned first —
 *      including checkout, which is how a booking gets addressed to a house
 *      somebody moved out of.
 *
 * ## What this does NOT change
 *
 * The legacy routes stay mounted and keep their exact shapes. The MongoDB
 * geocode sync stays where it is, in `address.service`, and this delegates the
 * write so there is one place that knows about it — a second writer that forgot
 * the coordinate sync would produce addresses that pass validation and fail
 * coverage checks.
 */

import type { PoolClient } from 'pg';
import dbQuery, { pool } from '../../db/dbQuery';
import { db } from '../../config';
import * as legacyAddressService from '../address.service';
import {
  ADDRESS_LIMITS,
  validateAddress,
  type AddressRefusal,
} from './accountPolicy';

const s = db.schema;

export class AddressError extends Error {
  constructor(
    readonly code: AddressRefusal,
    message: string,
    readonly status: number = 422,
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = 'AddressError';
  }
}

// ─── The DTO ──────────────────────────────────────────────────────────────────

export interface AddressDto {
  addressId: string;
  label: string | null;
  addressOne: string | null;
  addressTwo: string | null;
  postTown: string | null;
  zipCode: string | null;
  country: string | null;
  locationId: string | null;
  isDefault: boolean;
  createdAt: string | null;
  /** Present only when the geocode is known. Drives coverage and distance pricing. */
  coordinates: { lat: number; lon: number } | null;
}

const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
};

/**
 * NAMED fields only.
 *
 * `user_address` carries `created_by`/`updated_by` audit columns and the raw
 * `uid`. Copying the row and deleting what we do not want would publish every
 * column somebody later adds; naming them publishes only what is named.
 */
const toDto = (row: any, coords?: { lat: number; lon: number } | null): AddressDto => ({
  addressId: String(row.address_id),
  label: row.label ?? null,
  addressOne: row.address_one ?? null,
  addressTwo: row.address_two ?? null,
  postTown: row.post_town ?? null,
  zipCode: row.zip_code ?? null,
  country: row.country ?? null,
  locationId: row.location_id ?? null,
  isDefault: row.is_primary === true,
  createdAt: iso(row.created_at),
  coordinates: coords ?? null,
});

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Every address the account owns, default first.
 *
 * Owner-scoped in the WHERE clause. There is no parameter that names another
 * account, which is what makes the leakage test a statement about the code
 * rather than about today's set of routes.
 */
export const listAddresses = async (uid: string): Promise<AddressDto[]> => {
  const { rows } = await dbQuery.query(
    `SELECT address_id, label, address_one, address_two, post_town, zip_code,
            country, location_id, is_primary, created_at
       FROM ${s}.user_address
      WHERE uid = $1
      ORDER BY is_primary DESC, created_at ASC`,
    [uid],
  );
  return rows.map((row: any) => toDto(row));
};

export const getAddress = async (uid: string, addressId: string): Promise<AddressDto> => {
  const { rows } = await dbQuery.query(
    `SELECT address_id, label, address_one, address_two, post_town, zip_code,
            country, location_id, is_primary, created_at
       FROM ${s}.user_address
      WHERE uid = $1 AND address_id = $2
      LIMIT 1`,
    [uid, addressId],
  );
  if (!rows.length) {
    // ONE refusal for "no such address" and "not yours". Address ids are short
    // generated strings; an endpoint that distinguished the two would let a
    // caller confirm which ids exist, and these are people's homes.
    throw new AddressError('ADDRESS_NOT_FOUND', 'No address with that id.', 404);
  }
  return toDto(rows[0]);
};

export const countAddresses = async (uid: string): Promise<number> => {
  const { rows } = await dbQuery.query(
    `SELECT COUNT(*)::int AS count FROM ${s}.user_address WHERE uid = $1`,
    [uid],
  );
  return Number(rows[0]?.count ?? 0);
};

// ─── Writes ───────────────────────────────────────────────────────────────────

const assertValid = (
  input: Record<string, unknown>,
  opts: { existingCount?: number; isCreate?: boolean },
): void => {
  const verdict = validateAddress(input, opts);
  if (!verdict.ok) {
    throw new AddressError(
      verdict.refusal ?? 'ADDRESS_FIELD_REQUIRED',
      verdict.message ?? 'The address is not valid.',
      verdict.refusal === 'ADDRESS_LIMIT_REACHED' ? 409 : 422,
      verdict.field,
    );
  }
};

/**
 * Create an address.
 *
 * The FIRST address an account creates becomes the default automatically —
 * `DEFAULT_ADDRESS_RULE.onFirstAddress`. An account with addresses and no
 * default is a checkout screen with nothing selected, and the customer cannot
 * tell why.
 */
export const createAddress = async (
  uid: string,
  input: Record<string, unknown>,
): Promise<AddressDto> => {
  const existingCount = await countAddresses(uid);
  assertValid(input, { existingCount, isCreate: true });

  const shouldBeDefault = existingCount === 0 || input.isDefault === true;

  // Delegated so the MongoDB geocode sync has ONE caller. A second writer that
  // forgot it would produce addresses that validate and then fail coverage.
  const created = await legacyAddressService.addUserAddress(
    {
      addressOne: input.addressOne,
      addressTwo: input.addressTwo,
      postTown: input.postTown,
      zipCode: input.zipCode,
      country: input.country,
      label: input.label,
      locationId: input.locationId,
      lat: input.lat,
      lon: input.lon,
      isPrimary: false,
    } as never,
    uid,
  );

  const addressId = String((created as any)?.addressId ?? (created as any)?.address_id ?? '');
  if (shouldBeDefault && addressId) await setDefaultAddress(uid, addressId);
  return getAddress(uid, addressId);
};

export const updateAddress = async (
  uid: string,
  addressId: string,
  input: Record<string, unknown>,
): Promise<AddressDto> => {
  // Proves ownership before anything is written, and gives the 404 that a
  // foreign id deserves.
  await getAddress(uid, addressId);
  assertValid(input, { isCreate: false });

  await legacyAddressService.updateUserAddress(
    {
      addressOne: input.addressOne,
      addressTwo: input.addressTwo,
      postTown: input.postTown,
      zipCode: input.zipCode,
      country: input.country,
      label: input.label,
      locationId: input.locationId,
      lat: input.lat,
      lon: input.lon,
    } as never,
    uid,
    addressId,
  );

  if (input.isDefault === true) await setDefaultAddress(uid, addressId);
  return getAddress(uid, addressId);
};

/**
 * Promote one address to default, atomically.
 *
 * ONE transaction: demote everything, promote this one. The legacy path did the
 * reverse in two statements with no transaction, so a failure between them left
 * two primaries — and demote-then-promote is the right order even inside a
 * transaction, because it never transiently satisfies "exactly one" by having
 * zero rather than two.
 */
export const setDefaultAddress = async (
  uid: string,
  addressId: string,
): Promise<AddressDto> => {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    const owned = await client.query(
      `SELECT address_id FROM ${s}.user_address
        WHERE uid = $1 AND address_id = $2
        FOR UPDATE`,
      [uid, addressId],
    );
    if (!owned.rows.length) {
      throw new AddressError('ADDRESS_NOT_FOUND', 'No address with that id.', 404);
    }

    await client.query(
      `UPDATE ${s}.user_address SET is_primary = FALSE
        WHERE uid = $1 AND is_primary = TRUE AND address_id <> $2`,
      [uid, addressId],
    );
    await client.query(
      `UPDATE ${s}.user_address SET is_primary = TRUE
        WHERE uid = $1 AND address_id = $2`,
      [uid, addressId],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return getAddress(uid, addressId);
};

/**
 * Delete an address, promoting a successor when the default goes.
 *
 * `DEFAULT_ADDRESS_RULE.onDelete`. Leaving an account with addresses and no
 * default is the same broken checkout as never setting one, and it is the state
 * the legacy delete left behind every time somebody removed their primary.
 */
export const deleteAddress = async (
  uid: string,
  addressId: string,
): Promise<{ deleted: true; promotedAddressId: string | null }> => {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    const target = await client.query(
      `SELECT address_id, is_primary FROM ${s}.user_address
        WHERE uid = $1 AND address_id = $2
        FOR UPDATE`,
      [uid, addressId],
    );
    if (!target.rows.length) {
      throw new AddressError('ADDRESS_NOT_FOUND', 'No address with that id.', 404);
    }
    const wasDefault = target.rows[0].is_primary === true;

    await client.query(
      `DELETE FROM ${s}.user_address WHERE uid = $1 AND address_id = $2`,
      [uid, addressId],
    );

    let promotedAddressId: string | null = null;
    if (wasDefault) {
      const successor = await client.query(
        `SELECT address_id FROM ${s}.user_address
          WHERE uid = $1
          ORDER BY created_at ASC
          LIMIT 1`,
        [uid],
      );
      if (successor.rows.length) {
        promotedAddressId = String(successor.rows[0].address_id);
        await client.query(
          `UPDATE ${s}.user_address SET is_primary = TRUE
            WHERE uid = $1 AND address_id = $2`,
          [uid, promotedAddressId],
        );
      }
    }

    await client.query('COMMIT');
    return { deleted: true, promotedAddressId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

/**
 * How many defaults this account actually has.
 *
 * Diagnostic, and the thing the reconciliation test asserts is exactly one.
 * `ADDRESS_LIMITS.exactlyOneDefault` is only a claim if something counts.
 */
export const countDefaults = async (uid: string): Promise<number> => {
  const { rows } = await dbQuery.query(
    `SELECT COUNT(*)::int AS count FROM ${s}.user_address
      WHERE uid = $1 AND is_primary = TRUE`,
    [uid],
  );
  return Number(rows[0]?.count ?? 0);
};
