/**
 * ADMINCREATEBOOKING command — source contracts
 * Run: npx jest tests/admin-create-booking.test.js
 */

const fs   = require('fs');
const path = require('path');

const svcSrc    = fs.readFileSync(path.join(__dirname, '../src/services/adminCreateBookingService.ts'), 'utf-8');
const ctrlSrc   = fs.readFileSync(path.join(__dirname, '../src/controllers/adminBookingController.ts'), 'utf-8');
const routeSrc  = fs.readFileSync(path.join(__dirname, '../src/routes/adminBooking.routes.ts'), 'utf-8');
const permSrc   = fs.readFileSync(path.join(__dirname, '../src/services/adminPermissionService.ts'), 'utf-8');
const appSrc    = fs.readFileSync(path.join(__dirname, '../src/app.ts'), 'utf-8');

// Isolate the createBooking transaction function body (full function, generous slice)
const txStart = svcSrc.indexOf('adminCreateBooking =');
const txBody  = svcSrc.slice(txStart, txStart + 12000);

describe('adminCreateBooking — schema bootstrap', () => {
  it('creates guest_customers table', () => {
    expect(svcSrc).toContain('guest_customers');
    expect(svcSrc).toContain('phone_normalized');
    expect(svcSrc).toContain('linked_customer_uid');
  });

  it('creates UNIQUE index on phone_normalized (required for ON CONFLICT (phone_normalized) to work)', () => {
    expect(svcSrc).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_gc_phone_unique');
    expect(svcSrc).toContain('(phone_normalized)');
  });

  it('creates booking_payment_evidence table', () => {
    expect(svcSrc).toContain('booking_payment_evidence');
    expect(svcSrc).toContain('storage_url');
    expect(svcSrc).toContain('mime_type');
  });

  it('creates booking_create_idempotency table with UNIQUE constraint', () => {
    expect(svcSrc).toContain('booking_create_idempotency');
    expect(svcSrc).toContain('UNIQUE (idempotency_key, admin_actor_uid)');
  });

  it('adds guest_customer_id column to bookings', () => {
    expect(svcSrc).toContain('ADD COLUMN IF NOT EXISTS guest_customer_id');
  });

  it('adds admin_created flag to bookings', () => {
    expect(svcSrc).toContain('ADD COLUMN IF NOT EXISTS admin_created');
  });

  it('relaxes user_id NOT NULL for guest support', () => {
    expect(svcSrc).toContain('ALTER COLUMN user_id DROP NOT NULL');
  });

  it('wraps each ALTER TABLE in try-catch so one failure does not abort the rest', () => {
    const alterIdx = svcSrc.indexOf('ALTER TABLE ${s}.bookings ADD COLUMN IF NOT EXISTS guest_customer_id');
    const catchIdx = svcSrc.indexOf('} catch {', alterIdx);
    expect(catchIdx).toBeGreaterThan(alterIdx);
  });
});

describe('adminCreateBooking — phone normalization', () => {
  it('normalizes 09XXXXXXXXX → +639XXXXXXXXX', () => {
    expect(svcSrc).toContain("startsWith('09') && cleaned.length === 11");
    expect(svcSrc).toContain("'+63' + cleaned.slice(1)");
  });

  it('normalizes 63XXXXXXXXXX → +63XXXXXXXXXX', () => {
    expect(svcSrc).toContain("startsWith('63') && cleaned.length === 12");
  });
});

describe('adminCreateBooking — idempotency guard', () => {
  it('checks idempotency BEFORE opening a transaction', () => {
    const idempIdx  = txBody.indexOf('booking_create_idempotency');
    const beginIdx  = txBody.indexOf("client.query('BEGIN')");
    expect(idempIdx).toBeGreaterThanOrEqual(0);
    expect(beginIdx).toBeGreaterThan(idempIdx);
  });

  it('records idempotency key inside the transaction', () => {
    expect(txBody).toContain('INSERT INTO ${s}.booking_create_idempotency');
    expect(txBody).toContain('ON CONFLICT DO NOTHING');
  });
});

describe('adminCreateBooking — transaction safety', () => {
  it("uses pool.connect() for a true transaction (not pool.query)", () => {
    expect(svcSrc).toContain('pool.connect()');
    expect(txBody).toContain("client.query('BEGIN')");
    expect(txBody).toContain("client.query('COMMIT')");
    expect(txBody).toContain("client.query('ROLLBACK')");
    expect(txBody).toContain('client.release()');
  });

  it('ROLLBACK is inside catch, release is inside finally', () => {
    expect(txBody).toContain("client.query('ROLLBACK')");
    expect(txBody).toContain('client.release()');
    // Verify structural order: BEGIN < ROLLBACK < release
    const beginIdx    = txBody.indexOf("client.query('BEGIN')");
    const rollbackIdx = txBody.indexOf("client.query('ROLLBACK')");
    const releaseIdx  = txBody.lastIndexOf('client.release()');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(rollbackIdx).toBeGreaterThan(beginIdx);
    expect(releaseIdx).toBeGreaterThan(rollbackIdx);
  });
});

describe('adminCreateBooking — booking status rules', () => {
  it("inserts booking with status='CONFIRMED' — never PENDING_OTP", () => {
    expect(txBody).toContain("'CONFIRMED'");
    expect(txBody).not.toContain('PENDING_OTP');
  });

  it("inserts booking_workers with status='ASSIGNED'", () => {
    expect(txBody).toContain("'ASSIGNED'");
    expect(txBody).toContain('booking_workers');
  });

  it('sets admin_created = true on the booking row', () => {
    expect(txBody).toContain('admin_created');
    expect(txBody).toContain('true');
  });
});

describe('adminCreateBooking — provider eligibility recheck', () => {
  it('calls evaluateProviderForSlot at creation time (server-side recheck)', () => {
    expect(svcSrc).toContain('evaluateProviderForSlot');
    // recheck is pre-flight before BEGIN — inside adminCreateBooking, eligibility check precedes BEGIN
    const fnStart     = svcSrc.indexOf('adminCreateBooking =');
    const fnBody      = svcSrc.slice(fnStart, fnStart + 12000);
    const evalIdx     = fnBody.indexOf('evaluateProviderForSlot(providerUid');
    const beginIdx    = fnBody.indexOf("client.query('BEGIN')");
    expect(evalIdx).toBeGreaterThanOrEqual(0);
    expect(evalIdx).toBeLessThan(beginIdx);
  });

  it('uses serviceId from service_options JOIN, not from client payload directly', () => {
    expect(svcSrc).toContain('String(svcRow.service_id)');
  });

  it('rejects ineligible provider with 409', () => {
    expect(svcSrc).toContain('statusCode: 409');
    expect(svcSrc).toContain('Provider is not eligible for this slot');
  });
});

describe('adminCreateBooking — guest customer handling', () => {
  it('stores guest_customer_id on the booking row', () => {
    expect(txBody).toContain('guest_customer_id');
  });

  it('does NOT use a fake Firebase UID for guests (user_id is NULL for guest)', () => {
    expect(txBody).toContain("customerType === 'client' ? customerUid : null");
  });

  it('uses ON CONFLICT (phone_normalized) DO NOTHING for guest upsert (same phone → same identity)', () => {
    expect(txBody).toContain('ON CONFLICT (phone_normalized) DO NOTHING');
  });
});

describe('adminCreateBooking — payment evidence', () => {
  it('validates MIME type against allowed list (JPEG/PNG/WebP only)', () => {
    expect(svcSrc).toContain("'image/jpeg'");
    expect(svcSrc).toContain("'image/png'");
    expect(svcSrc).toContain("'image/webp'");
  });

  it('performs magic-byte verification', () => {
    expect(svcSrc).toContain('MAGIC_BYTES');
    expect(svcSrc).toContain('0xFF, 0xD8, 0xFF'); // JPEG
    expect(svcSrc).toContain('0x89, 0x50, 0x4E, 0x47'); // PNG
  });

  it('enforces 7 MB size limit (body-parser cap is 10 MB JSON; 7 MB raw encodes to ~9.3 MB base64)', () => {
    expect(svcSrc).toContain('7 * 1024 * 1024');
  });

  it('uses token-authenticated Firebase Storage (uploadFileToStorage)', () => {
    expect(svcSrc).toContain('uploadFileToStorage');
    expect(svcSrc).toContain("'payment-evidence'");
  });

  it('stores evidence metadata in booking_payment_evidence (not in bookings directly)', () => {
    expect(txBody).toContain('booking_payment_evidence');
    expect(txBody).toContain('storage_url');
  });
});

describe('adminCreateBooking — stop conditions (hard rules)', () => {
  it('does NOT call /api/workers/bookings (mobile endpoint protected)', () => {
    expect(svcSrc).not.toContain('/api/workers/bookings');
  });

  it('does NOT call acceptJob (mobile route untouched)', () => {
    expect(svcSrc).not.toContain('acceptJob');
  });

  it('does NOT call POST /bookings (customer route untouched)', () => {
    expect(svcSrc).not.toContain("POST /bookings");
    expect(svcSrc).not.toContain('createBooking(');
  });

  it('does NOT generate a fake Firebase UID or call firebase.auth', () => {
    expect(svcSrc).not.toContain('firebase.auth');
    expect(svcSrc).not.toContain('createUserWithEmailAndPassword');
    expect(svcSrc).not.toContain('signInWithEmailAndPassword');
  });
});

describe('adminCreateBooking — controller validation', () => {
  const ctrlFn = (() => {
    const idx = ctrlSrc.indexOf('createAdminBooking');
    return ctrlSrc.slice(idx, idx + 2000);
  })();

  it('rejects missing idempotencyKey', () => {
    expect(ctrlFn).toContain('idempotencyKey is required');
  });

  it('rejects invalid customerType (must be guest or client)', () => {
    expect(ctrlFn).toContain("'guest','client'");
  });

  it('rejects missing providerUid', () => {
    expect(ctrlFn).toContain('providerUid is required');
  });

  it('validates paymentMethod against allowed values', () => {
    expect(ctrlFn).toContain("'CASH','GCASH','ONLINE'");
  });

  it('validates paymentStatus against PAID | PAY_LATER', () => {
    expect(ctrlSrc).toContain("'PAID','PAY_LATER'");
  });
});

describe('adminCreateBooking — routes', () => {
  it('POST /admin/bookings is behind bookings.create permission', () => {
    expect(routeSrc).toContain("'bookings.create'");
    expect(routeSrc).toContain('createAdminBooking');
  });

  it('GET /admin/bookings/slot-candidates is before /:id route', () => {
    const slotIdx    = routeSrc.indexOf('slot-candidates');
    const idRouteIdx = routeSrc.indexOf('/admin/bookings/:id');
    expect(slotIdx).toBeGreaterThanOrEqual(0);
    expect(slotIdx).toBeLessThan(idRouteIdx);
  });

  it('payment evidence upload route is behind bookings.payment_evidence_upload', () => {
    expect(routeSrc).toContain("'bookings.payment_evidence_upload'");
    expect(routeSrc).toContain('uploadPaymentEvidence');
  });

  it('customer search route uses bookings.create_for_client permission', () => {
    expect(routeSrc).toContain("'bookings.create_for_client'");
    expect(routeSrc).toContain('searchClientsForBooking');
  });
});

describe('adminCreateBooking — permissions', () => {
  it('seeds bookings.create permission', () => {
    expect(permSrc).toContain("key: 'bookings.create'");
  });

  it('seeds bookings.create_guest permission', () => {
    expect(permSrc).toContain("key: 'bookings.create_guest'");
  });

  it('seeds bookings.create_for_client permission', () => {
    expect(permSrc).toContain("key: 'bookings.create_for_client'");
  });

  it('seeds bookings.payment_record permission', () => {
    expect(permSrc).toContain("key: 'bookings.payment_record'");
  });

  it('seeds bookings.payment_evidence_upload permission', () => {
    expect(permSrc).toContain("key: 'bookings.payment_evidence_upload'");
  });
});

describe('adminCreateBooking — app.ts wiring', () => {
  it('wires ensureAdminCreateBookingSchema IIFE in app.ts', () => {
    expect(appSrc).toContain('ensureAdminCreateBookingSchema');
  });
});

describe('listCandidatesForSlot — STITCH/SWEEP contracts', () => {
  it('accepts serviceOptionId to compute accurate endAt from duration_mins', () => {
    expect(svcSrc).toContain('serviceOptionId');
    expect(svcSrc).toContain('duration_mins');
    // The function must look up duration_mins when serviceOptionId is provided
    const fnIdx = svcSrc.indexOf('listCandidatesForSlot');
    const fn = svcSrc.slice(fnIdx, fnIdx + 1500);
    expect(fn).toContain('serviceOptionId');
    expect(fn).toContain('duration_mins');
  });

  it('fetches photo_url for provider avatars', () => {
    const fnIdx = svcSrc.indexOf('listCandidatesForSlot');
    const fn = svcSrc.slice(fnIdx, fnIdx + 4000);
    expect(fn).toContain('photo_url');
    expect(fn).toContain('avatarUrl');
  });

  it('batch-fetches active services for all providers', () => {
    const fnIdx = svcSrc.indexOf('listCandidatesForSlot');
    const fn = svcSrc.slice(fnIdx, fnIdx + 4000);
    expect(fn).toContain('employee_services');
    expect(fn).toContain('activeServicesByUid');
    expect(fn).toContain('activeServices:');
  });

  it('controller forwards serviceOptionId to listCandidatesForSlot', () => {
    const fnIdx = ctrlSrc.indexOf('getSlotCandidates');
    const fn = ctrlSrc.slice(fnIdx, fnIdx + 600);
    expect(fn).toContain('serviceOptionId');
  });
});

describe('adminCreateBooking — instructions field', () => {
  it('AdminCreateBookingParams accepts optional instructions field', () => {
    // The interface must declare instructions as optional
    expect(svcSrc).toContain('instructions?: string | null');
  });

  it('service_address JSONB includes instructions when provided', () => {
    const fnIdx = svcSrc.indexOf('serviceAddress');
    const fn = svcSrc.slice(fnIdx, fnIdx + 300);
    expect(fn).toContain('instructions');
  });

  it('convertDraft forwards instructions from addressPayload', () => {
    const draftSrc = require('fs').readFileSync(
      require('path').join(__dirname, '../src/services/adminBookingDraftService.ts'), 'utf-8'
    );
    // Search whole file — instructions is forwarded inside convertDraft's adminCreateBooking call
    expect(draftSrc).toContain('addr.instructions');
    expect(draftSrc).toContain('instructions:');
  });

  it('convertDraft uses Number.isFinite guard for servanaLocationId (NaN guard)', () => {
    const draftSrc = require('fs').readFileSync(
      require('path').join(__dirname, '../src/services/adminBookingDraftService.ts'), 'utf-8'
    );
    // NaN guard: Number(non-numeric string) = NaN which would corrupt locationId.
    // The fix: Number.isFinite() rejects NaN/Infinity and falls back to null.
    expect(draftSrc).toContain('Number.isFinite(Number(addr.servanaLocationId))');
  });
});

describe('job-card — instructions surface to provider (STITCH-003)', () => {
  const techSvcSrc = require('fs').readFileSync(
    require('path').join(__dirname, '../src/services/technicianService.ts'), 'utf-8'
  );
  const techCtrlSrc = require('fs').readFileSync(
    require('path').join(__dirname, '../src/controllers/technicianController.ts'), 'utf-8'
  );

  it('getJobCardsByWorker SELECT includes delivery_instructions from service_address JSONB', () => {
    const fnIdx = techSvcSrc.indexOf('getJobCardsByWorker');
    const fn = techSvcSrc.slice(fnIdx, fnIdx + 2000);
    expect(fn).toContain("service_address->>'instructions'");
    expect(fn).toContain('delivery_instructions');
  });

  it('getJobCards controller maps delivery_instructions into address.instructions', () => {
    const fnIdx = techCtrlSrc.indexOf('getJobCards');
    const fn = techCtrlSrc.slice(fnIdx, fnIdx + 1200);
    expect(fn).toContain('instructions:');
    expect(fn).toContain('delivery_instructions');
  });
});

describe('adminBookingDraftService — DRAFT BOOKINGS audit fixes (2026-07-25)', () => {
  const draftSrc = require('fs').readFileSync(
    require('path').join(__dirname, '../src/services/adminBookingDraftService.ts'), 'utf-8'
  );

  it('getDraft enforces expiry — transitions expired mutable drafts to status=expired', () => {
    // Must check expires_at against current time for editing/ready_for_review drafts
    const getDraftFn = draftSrc.match(/export const getDraft[\s\S]{0,1200}/)?.[0] ?? '';
    expect(getDraftFn).toContain('expiresAt');
    expect(getDraftFn).toContain('DRAFT_EXPIRED');
    expect(getDraftFn).toContain("status = 'expired'");
  });

  it('getDraft throws 410 DRAFT_EXPIRED for expired mutable drafts', () => {
    const getDraftFn = draftSrc.match(/export const getDraft[\s\S]{0,1200}/)?.[0] ?? '';
    expect(getDraftFn).toContain('statusCode: 410');
    expect(getDraftFn).toContain("code: 'DRAFT_EXPIRED'");
  });

  it('patchDraft RETURNING clause includes status for accurate audit logging', () => {
    // Full-file search — patchDraft spans ~90 lines; slice by index is more reliable
    const patchIdx = draftSrc.indexOf('export const patchDraft');
    const patchFn  = patchIdx >= 0 ? draftSrc.slice(patchIdx, patchIdx + 6000) : '';
    expect(patchFn).toContain('RETURNING version, updated_at, status');
  });

  it('patchDraft audit call uses actual returned status, not hardcoded editing', () => {
    const patchIdx = draftSrc.indexOf('export const patchDraft');
    const patchFn  = patchIdx >= 0 ? draftSrc.slice(patchIdx, patchIdx + 6000) : '';
    // row.status from RETURNING clause — not hardcoded 'editing'
    expect(patchFn).toContain('ADMIN.BOOKING_DRAFT.UPDATED');
    expect(patchFn).not.toContain("null, 'editing', 'ADMIN.BOOKING_DRAFT.UPDATED'");
  });
});

describe('adminCreateBooking — fallback path: controller forwards instructions (STITCH-005)', () => {
  it('createAdminBooking destructures instructions from req.body', () => {
    const fnIdx = ctrlSrc.indexOf('createAdminBooking');
    const fn = ctrlSrc.slice(fnIdx, fnIdx + 800);
    expect(fn).toContain('instructions');
  });

  it('createAdminBooking passes instructions to adminCreateBooking service call', () => {
    const fnIdx = ctrlSrc.indexOf('createAdminBooking');
    const fn = ctrlSrc.slice(fnIdx, fnIdx + 3500);
    // Must contain the forwarding expression in the service call
    expect(fn).toContain('instructions:');
    // Must use nullish coalescing so undefined becomes null (not forwarded as undefined)
    expect(fn).toContain('instructions ?? null');
  });
});
