import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The booking detail response must carry the fields the customer app renders,
 * and the booking OTP must not travel in a URL.
 *
 * Found by a booking-scoped SWEEP/LEAK pass against 1.0.0+36.
 *
 * ── Money ──────────────────────────────────────────────────────────────────
 * The app renders the Payment section from `totalAmount`. That is not a column
 * on `bookings` and never has been — the table stores `quoted_price` and
 * `final_price`. So the key was simply absent from every response, the client's
 * `?? 0` default took over, and every booking detail screen displayed ₱0.00
 * regardless of what the customer was actually charged.
 *
 * Nothing failed. No error was logged. A booking worth ₱3,500 rendered as free.
 *
 * ── ETA ────────────────────────────────────────────────────────────────────
 * `booking_workers` was joined for its status and timestamps but not for
 * `eta_minutes`, which the app reads to show how far away the technician is.
 *
 * ── The OTP ────────────────────────────────────────────────────────────────
 * `confirmOtp` read the code from `req.query.otp` only. Query strings are
 * written to the nginx access log on every request, so each verification
 * deposited a live credential into a plaintext log that is rotated, backed up
 * and readable by anyone with host access. The route was already POST; the body
 * was available and unused.
 */

const SRC = join(__dirname, '..', 'src');

/** Strips comments so an explanation of the old behaviour cannot satisfy a test. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const bookingService = () =>
  readFileSync(join(SRC, 'services', 'bookingService.ts'), 'utf8');

const getBookingByIdQuery = (): string => {
  const src = stripComments(bookingService());
  const start = src.indexOf('export const getBookingById');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('export const getAllBookings');
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
};

describe('booking detail payload', () => {
  it('returns an amount the app can render', () => {
    const q = getBookingByIdQuery();
    expect(q).toContain('AS total_amount');
    // Must fall back: an unpaid booking has final_price set at creation, but
    // COALESCE keeps it correct if that ever changes.
    expect(q).toMatch(/COALESCE\(\s*b\.final_price\s*,\s*b\.quoted_price\s*\)/);
  });

  it('returns the technician ETA', () => {
    expect(getBookingByIdQuery()).toContain('bw.eta_minutes');
  });

  it('still joins the service, so the booking has a name', () => {
    // Guards the earlier fix in the same query — this endpoint returned no name
    // for the thing being booked, and the app rendered a bare "Service" label.
    const q = getBookingByIdQuery();
    expect(q).toContain('AS service_name');
    expect(q).toContain('service_options so');
  });

  it('does not rename the fields other platforms already read', () => {
    // total_amount is an ALIAS. quoted_price and final_price must survive for
    // the admin portal and the provider app, which read them by those names.
    const q = getBookingByIdQuery();
    expect(q).toContain('b.*');
    expect(q).not.toMatch(/final_price\s+AS\s+(?!.*total_amount)/);
  });
});

describe('the booking OTP does not travel in a URL', () => {
  const confirmOtp = (): string => {
    const src = stripComments(
      readFileSync(join(SRC, 'controllers', 'bookingController.ts'), 'utf8'),
    );
    const start = src.indexOf('export const confirmOtp');
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, start + 1200);
  };

  it('reads the body', () => {
    expect(confirmOtp()).toContain('req.body?.otp');
  });

  it('prefers the body over the query', () => {
    // Order matters. Query-first would keep logging the credential for every
    // client that still sends it that way.
    const body = confirmOtp();
    expect(body.indexOf('req.body?.otp')).toBeLessThan(
      body.indexOf('req.query?.otp'),
    );
  });

  it('still accepts the query, so shipped builds keep working', () => {
    // 1.0.0+36 is in customers' hands and sends the query form. Removing it
    // would break booking verification for everyone who has not updated.
    expect(confirmOtp()).toContain('req.query?.otp');
  });

  it('the route is POST, so a body was always available', () => {
    const routes = readFileSync(join(SRC, 'routes', 'booking.routes.ts'), 'utf8');
    expect(routes).toMatch(/router\.post\(\s*["']\/:id\/confirm-otp["']/);
  });
});
