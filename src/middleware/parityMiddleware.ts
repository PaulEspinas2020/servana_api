/**
 * SWEEP Parity Middleware — Servana Cross-Platform Field Equivalence
 *
 * Automatically enriches every JSON response so that the same data can be
 * read under any known field name alias, regardless of which platform calls it.
 *
 * Applies applyContextSafeParity() — which covers all alias groups EXCEPT
 * the contextual id→uid group (that only applies to user credential objects
 * where we know `id` = Firebase UID, not a numeric booking/service PK).
 * User formatters (formatUserCredentials, formatUserProfile) apply the full
 * applyParity() including id→uid since they know the entity type.
 *
 * Aliases automatically added to every response (if field is present):
 *   firstName      → first_name
 *   lastName       → last_name
 *   phoneNumber    → phone, phone_number
 *   scheduleAt     → schedule, scheduledAt (and vice versa)
 *   workerUid      → worker_uid, providerUid, provider_uid
 *   workerStatus   → worker_status, assignmentStatus
 *   bookingId      → booking_id
 *   photoUrl       → photo_url, photoURL, avatarUrl
 *   isArchived     → is_archive, is_archived
 *   isEmailVerified → is_email_verified, emailVerified
 *   createdDate    → created_date, createdAt
 *   updatedAt      → updated_at
 *   serviceName    → service_name, level2, level_2, name
 *   serviceType    → service_type, level3, level_3, type
 *   serviceId      → service_id
 *   addressOne     → address_one, addressLine, address
 *   postTown       → post_town, city
 *   zipCode        → zip_code
 *   requirementType → requirement_type
 *   ... and all reverses
 *
 * Applied after all other middleware, before the response reaches the client.
 */

import { Request, Response, NextFunction } from 'express';
import { applyContextSafeParity } from '../utils/fieldParity';

function enrichValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(enrichValue);
  if (typeof value === 'object') {
    return applyContextSafeParity(value as Record<string, unknown>);
  }
  return value;
}

export function parityMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const originalJson = res.json.bind(res);

  res.json = function (body: unknown): Response {
    if (body !== null && body !== undefined && typeof body === 'object') {
      body = enrichValue(body);
    }
    return originalJson(body);
  };

  next();
}
