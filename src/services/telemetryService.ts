/**
 * Where a scrubbed telemetry event goes so a human can query it (TAB 06).
 *
 * ## Why a table and not a log line
 *
 * The gate asks that an event reach "something a human can query". Log lines
 * are greppable, not queryable: answering "what share of activations completed
 * this week" from `pm2 logs` is an afternoon, and nobody will spend it. A table
 * makes that one statement, in a database an operator already has access to,
 * with no new infrastructure and no new vendor.
 *
 * ## Why it never throws
 *
 * This platform already has a metrics registry nothing scrapes and a portal
 * telemetry allowlist with zero call sites. The failure this guards against is
 * different and worse: telemetry that can 500 a client is telemetry somebody
 * switches off, and the build it gets switched off in is the one that most
 * needed it. So a write failure is counted and swallowed.
 *
 * The events are not business records. Losing one costs a row in a chart. That
 * is precisely why it may be dropped, and precisely why it must never be able
 * to take a request down with it.
 *
 * ## Retention is a decision, not an accident
 *
 * `telemetry_events` carries `occurred_at` and the migration ships a retention
 * note: 90 days. Data minimisation under RA 10173 is not only about which
 * fields are collected but for how long they are kept, and an event stream with
 * no retention policy becomes a permanent behavioural record of identifiable
 * providers by default rather than by decision.
 */

import dbQuery from '../db/dbQuery';
import { db } from '../config';
import { incr } from '../observability/metrics';
import type { ScrubbedEvent } from '../api/v1/domains/telemetry';

const dbSchema = db.schema;

/**
 * `actorUid` is stored, and that is a deliberate choice rather than an oversight.
 *
 * The events answer "did activation finish", "did the job get accepted" — which
 * are per-provider questions. Storing the uid is what makes them answerable, and
 * it is the same identifier already in `user_credentials`, in the same database,
 * under the same access control. It is NOT accepted from the payload: the client
 * is forbidden from sending `uid`, and this comes from the verified token, so a
 * client cannot attribute an event to somebody else.
 */
export const recordTelemetryEvents = async (
  events: readonly ScrubbedEvent[],
  actorUid: string,
): Promise<void> => {
  if (events.length === 0) return;
  try {
    const values: unknown[] = [];
    const rows = events.map((e, i) => {
      const base = i * 3;
      values.push(e.event, actorUid || null, JSON.stringify(e.properties));
      return `($${base + 1}, $${base + 2}, $${base + 3}::jsonb)`;
    });
    await dbQuery.query(
      `INSERT INTO ${dbSchema}.telemetry_events (event, actor_uid, properties) VALUES ${rows.join(', ')}`,
      values,
    );
  } catch {
    // Counted, not thrown. A telemetry write that fails must cost a row in a
    // chart, never a client's request.
    incr('worker_telemetry_write_failures_total', {});
  }
};
