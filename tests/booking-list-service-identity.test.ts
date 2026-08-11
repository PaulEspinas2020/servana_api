import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The customer booking LIST must name the thing that was booked.
 *
 * ## The defect
 *
 * `getBookingsByUserId` joined payments, branches, addresses and workers, but
 * never the service. The detail query was given those joins when the booking
 * detail screen was found rendering a bare "Service" label; the list query was
 * not, and every consumer showing a list of bookings has had to invent the
 * name.
 *
 * The customer app's live list mapper (`http_backend.dart:491-502`) digs the
 * name out of `pricingBreakdown.addons[0].level_3` and falls back to the
 * literal `'Beauty & Wellness'` when a booking has no addons. A plumbing
 * booking with no addons is labelled Beauty & Wellness in a shipped app.
 *
 * ## Why this test reads SQL as text
 *
 * The same reasoning as `auth-sql-column-names.test.ts`. The booking tests mock
 * `dbQuery` and hand back fixtures, so they check the code against its own
 * assumption about what the query returned — and a query that never selected
 * the column will happily agree with a fixture that contains it. Reading the
 * SQL is the only way to assert what is actually asked of Postgres.
 *
 * ## Why the cross-platform half matters as much as the addition
 *
 * The hard rule is that a backend change must not alter another platform's
 * integration, and that this is PROVEN rather than reasoned about. Four
 * consumers were read before this change: the customer app parses positionally
 * (`b['id']`, `b['status']`, …) and never enumerates response keys; ServanaWorker
 * declares `getUserBookings` with no call sites; the admin portal and the
 * provider web portal have no consumer of this route at all. No strict parser
 * and no key enumeration exists in any of them, so added keys are inert.
 *
 * The half this test can actually enforce is that nothing was REMOVED or
 * RENAMED, which is the change that would break them.
 */

const SOURCE = readFileSync(join(__dirname, '../src/services/bookingService.ts'), 'utf8');

/** The body of `getBookingsByUserId`, so neighbouring queries cannot satisfy these. */
function listQuerySql(): string {
  const start = SOURCE.indexOf('export const getBookingsByUserId');
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('export const', start + 10);
  return SOURCE.slice(start, end === -1 ? SOURCE.length : end);
}

describe('the customer booking list names the service', () => {
  const sql = listQuerySql();

  test('selects the service identity columns', () => {
    expect(sql).toContain('so.level_2 AS service_name');
    expect(sql).toContain('so.level_3 AS service_option_name');
    expect(sql).toContain('s.name     AS service_category');
    expect(sql).toContain('so.service_id');
  });

  test('selects the total, so a list row need not recompute it', () => {
    expect(sql).toContain('COALESCE(b.final_price, b.quoted_price) AS total_amount');
  });

  test('joins the service tables it selects from', () => {
    // Selecting so.* without the join is a 42P01, and the mocked booking tests
    // would not notice.
    expect(sql).toContain('service_options so');
    expect(sql).toContain('ON so.id = b.service_option_id');
    // The legacy family table was renamed to service_families in Catalog V2;
    // `services` now holds the bookable entity. The join is unchanged — a
    // service_option still belongs to a family — only the name moved.
    expect(sql).toContain('service_families s');
    expect(sql).toContain('ON s.id = so.service_id');
  });

  test('joins the service LEFT, not INNER', () => {
    // An inner join would drop a booking whose service_option row was deleted
    // or is null — deleting bookings from a customer's own history in order to
    // avoid a missing label.
    const serviceJoin = sql.slice(sql.indexOf('service_options so') - 60, sql.indexOf('service_options so'));
    expect(serviceJoin).toContain('LEFT JOIN');

    const servicesJoin = sql.slice(sql.indexOf('.service_families s') - 60, sql.indexOf('.service_families s'));
    expect(servicesJoin).toContain('LEFT JOIN');
  });

  test('uses the same aliases as the detail query', () => {
    // A list row and a detail page describing the same booking under different
    // key names is the drift this removes, not creates.
    const detailStart = SOURCE.indexOf('so.level_2 AS service_name');
    const listStart = sql.indexOf('so.level_2 AS service_name');
    expect(detailStart).toBeGreaterThan(-1);
    expect(listStart).toBeGreaterThan(-1);
    for (const alias of [
      'so.level_2 AS service_name',
      'so.level_3 AS service_option_name',
      'COALESCE(b.final_price, b.quoted_price) AS total_amount',
    ]) {
      // Present twice in the file: once in the detail query, once in the list.
      expect(SOURCE.split(alias).length - 1).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('nothing the other platforms read was removed (cross-platform rule)', () => {
  const sql = listQuerySql();

  test('every column the list returned before is still returned', () => {
    // Read from the query as it stood before this change. Removing or renaming
    // one of these is the only edit here that could break a consumer, so it is
    // the one thing pinned exhaustively.
    for (const column of [
      'b.*',
      'p.status AS payment_status',
      'p.method AS payment_method_used',
      'p.reference_no',
      'p.proof_url',
      'br.name AS branch_name',
      'br.address AS branch_address',
      'br.city AS branch_city',
      "COALESCE(ua.address_one, b.service_address->>'addressLine') AS address",
      "COALESCE(ua.post_town,   b.service_address->>'city')        AS post_town",
      'ua.country AS country',
      'ua.zip_code AS zip_code',
      'bw.status AS worker_status',
      'bw.assigned_at',
      'bw.started_at',
      'bw.completed_at',
    ]) {
      // Named in the failure via the assertion itself: a missing column shows
      // as a diff on the string, which is enough to identify it.
      expect({ column, present: sql.includes(column) }).toEqual({ column, present: true });
    }
  });

  test('the ownership predicate is untouched', () => {
    // The guest-booking clause is a security boundary: it is what stops one
    // customer seeing another's guest bookings via a shared phone number.
    // Nothing about naming a service should go near it.
    expect(sql).toContain('b.user_id = $1');
    expect(sql).toContain('gc.linked_customer_uid = $1');
  });

  test('the ordering is untouched', () => {
    expect(sql).toContain('ORDER BY b.created_at DESC');
  });

  test('the worker lateral join still takes the most recent assignment', () => {
    expect(sql).toContain('ORDER BY bw0.assigned_at DESC NULLS LAST, bw0.id DESC');
    expect(sql).toContain('LIMIT 1');
  });
});
