/**
 * Two dead ends in the customer journey.
 *
 * RESEND OTP CALLED A ROUTE THAT DID NOT EXIST. The booking OTP screen's Resend
 * button has always posted to /api/:bookingId/resend-otp
 * (servana_api_client.dart:597), and the client even carried a comment saying
 * the route "must exist on the backend". It never did. A customer whose
 * verification email did not arrive had no recovery at all: the booking sat in
 * PENDING_OTP, the only way forward was a code they had not received, and the
 * code has no expiry that would eventually force a new one.
 *
 * LIVE TRACKING NEVER PLOTTED THE PROVIDER. The endpoint returns the GPS
 * document nested under `location`; the client's parser only unwraps it from the
 * root or from `data` (geo_position_snapshot.fromApiMap). So fromApiMap returned
 * null on every response and the customer watched an empty map for the whole
 * journey — with no error, because null reads as "no position reported yet",
 * which is a legitimate state.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const routes = read('routes', 'booking.routes.ts');
const controller = read('controllers', 'bookingController.ts');
const service = read('services', 'bookingService.ts');

const resendService = service.slice(
  service.indexOf('export const resendBookingOtp'),
  service.indexOf('export const confirmOtp'),
);
const resendController = controller.slice(
  controller.indexOf('export const resendOtp'),
  controller.indexOf('export const getBooking'),
);

describe('resend OTP exists and is safe', () => {
  it('the route the client has always called is registered', () => {
    expect(routes).toMatch(/router\.post\("\/:bookingId\/resend-otp"/);
  });

  it('it requires authentication', () => {
    const line = routes.match(/router\.post\("\/:bookingId\/resend-otp"[^\n]*/)?.[0] ?? '';
    expect(line).toContain('verifyAuth');
  });

  it('it authorizes the booking, not just the caller', () => {
    // Possession of a booking id is not entitlement (§11). Without this,
    // anyone could rotate the OTP on any booking and lock the real customer
    // out of confirming it — a denial of service with no error message.
    expect(resendController).toContain('assertBookingAccess');
  });

  it('a NEW code is issued rather than the old one re-sent', () => {
    // Re-sending would leave every superseded email valid forever, turning a
    // delivery problem into a security one.
    expect(resendService).toContain('generateOTP()');
    expect(resendService).toMatch(/UPDATE \$\{dbSchema\}\.bookings SET otp_code = \$1/);
  });

  it('only a booking still awaiting verification can be re-issued', () => {
    // Re-issuing against a confirmed, cancelled or completed booking would move
    // it backwards, and an OTP for a finished job only helps someone who should
    // not have one.
    expect(resendService).toContain("status === 'PENDING_OTP'");
    // Compatibility is limited to rows the old payment webhook corrupted:
    // PAID with no worker. A paid booking already assigned must not move back.
    expect(resendService).toContain("status === 'PAID' && !booking.worker_uid");
    expect(resendService).toContain('409');
  });

  it('the code is never returned in the response', () => {
    // It travels by email only. Returning it would make the route a way to READ
    // the OTP rather than to re-send it.
    expect(resendService).not.toMatch(/return\s*\{[^}]*otp[^}]*\}/i);
    expect(resendService).toMatch(/return \{ bookingId, resent: true \}/);
  });

  it('a mail failure does not leave the customer holding a dead code', () => {
    // The code is rotated before the send. If the send throws and we surfaced
    // that as failure, the customer would keep using a code that no longer
    // works — worse than a missing email.
    const rotateIdx = resendService.indexOf('SET otp_code');
    const tryIdx = resendService.indexOf('try {');
    expect(rotateIdx).toBeLessThan(tryIdx);
    expect(resendService).toMatch(/\}\s*catch\s*\{/);
  });

  it('a missing booking id is rejected before any lookup', () => {
    expect(resendController).toContain('Invalid booking id');
  });
});

describe('live tracking reaches a client that can parse it', () => {
  const locationController = read('controllers', 'providerLocationAccessController.ts');

  it('the document is also sent under `data`', () => {
    // The shipped app only unwraps from the root or from `data`. This alias
    // fixes tracking for already-installed builds, with no release.
    expect(locationController).toMatch(
      /assigned: true, location, data: location/,
    );
  });

  it('the documented `location` field is unchanged', () => {
    // Additive (§4): the alias must not replace the field other consumers read.
    expect(locationController).toContain('location, data: location');
  });

  it('the not-assigned and no-position states stay distinguishable', () => {
    // These are different truths — "nobody is coming yet" versus "your provider
    // has not reported a position" — and collapsing them makes the UI lie.
    expect(locationController).toContain('assigned: false, location: null');
    expect(locationController).toContain('assigned: true, location: null');
  });
});
