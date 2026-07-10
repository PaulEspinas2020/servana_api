/**
 * SWEEP Request Parity Middleware — Servana Cross-Platform Field Equivalence
 *
 * Completes the bidirectional SWEEP coverage:
 *   parityMiddleware    → enriches OUTGOING responses (response → client)
 *   requestParityMiddleware → enriches INCOMING request bodies (client → controller)
 *
 * When any platform sends a request body using any known field name alias
 * for a concept, this middleware adds the other known aliases so the
 * controller can read whichever name it expects without needing to know
 * which alias the sending platform used.
 *
 * Example: Customer mobile sends { schedule: "..." }
 *          Controller reads req.body.scheduleAt → finds it (now also present)
 *
 * Uses applyContextSafeParity() — skips the contextual id→uid group to avoid
 * numeric PK fields (booking_id etc.) being aliased to uid/workerUid in bodies.
 * Recurses into nested objects and arrays.
 *
 * Only processes JSON bodies (express.json must run before this middleware).
 * Skips multipart/form-data (those bodies are handled by formidable).
 */

import { Request, Response, NextFunction } from 'express';
import { applyContextSafeParity } from '../utils/fieldParity';

function enrichBody(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(enrichBody);
  if (typeof value === 'object') {
    return applyContextSafeParity(value as Record<string, unknown>);
  }
  return value;
}

export function requestParityMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  // Skip if no body or body is a raw Buffer (Paymongo webhook raw body)
  if (!req.body || Buffer.isBuffer(req.body)) {
    next();
    return;
  }

  // Skip multipart/form-data — body is handled by formidable; req.body is empty
  const contentType = req.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    next();
    return;
  }

  if (typeof req.body === 'object') {
    req.body = enrichBody(req.body);
  }

  next();
}
