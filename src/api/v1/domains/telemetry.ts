/**
 * First-party telemetry ingest (TAB 06).
 *
 * ## The decision this implements, and why it is first-party
 *
 * Written up in full, with sources, in `docs/TELEMETRY_DECISION.md`. The short
 * version, because the reason is legal and not aesthetic:
 *
 * The worker app scrubs its payloads to an allowlist that carries no name, no
 * phone number, no location, no token and no document id. It still carries
 * `bookingRef`. Under RA 10173 §3(g), personal information is information from
 * which an identity "can be reasonably and directly ascertained BY THE ENTITY
 * HOLDING THE INFORMATION". Servana holds the bookings table, so a booking
 * reference identifies a provider and a customer to Servana as surely as a name
 * would. The scrubbed payload is therefore still personal information in our
 * hands.
 *
 * That makes a third-party sink a cross-border transfer of personal data: §21
 * accountability, a processor agreement carrying the NPC's 2024 model
 * contractual clauses, and — above 1,000 data subjects processed abroad — a
 * registration with the NPC within 20 days of the first data flow. All of that
 * is discharge-able, and none of it is free, and this platform has zero
 * activated providers and no support process. Buying a foreign-processor
 * obligation before the first provider exists is cost with no offsetting
 * benefit.
 *
 * First-party keeps the data inside the same database and the same jurisdiction
 * it already lives in, and adds no processor to the register.
 *
 * ## Why the server scrubs AGAIN
 *
 * The client's scrubber is good — an allowlist, a forbidden list, scalar values
 * only, and the emitter is the only path to any sink. It is also running on a
 * device we do not control, in a build we cannot recall (until TAB 02 ships),
 * shipped by a client that can be modified. A server that trusts a client's
 * scrubbing has one control, not two.
 *
 * So this module re-derives the allowlist from its own source of truth and
 * drops everything else. The two lists are deliberately maintained separately:
 * if they drift, the server's is authoritative and the difference shows up as a
 * `dropped` count rather than as data nobody meant to store.
 *
 * ## What it deliberately does NOT accept
 *
 * Free text of any kind. There is no `message`, no `stackTrace`, no `note`. A
 * crash reporter that accepts a stack trace accepts whatever the strings in
 * that stack happen to contain — which on this app includes addresses,
 * customer names and signed URLs. If stack traces are wanted later they need
 * their own decision, their own scrubbing and their own retention, not a field
 * added to this one.
 */

import { Request, Response } from 'express';
import { ok, fail, sendCaught } from '../envelope';
import { V1Handlers } from '../types';
import { incr } from '../../../observability/metrics';
import { recordTelemetryEvents } from '../../../services/telemetryService';

/**
 * The events this platform has decided are worth recording.
 *
 * Closed, and matched against the worker app's `TelemetryEvent` enum. An
 * unknown name is dropped rather than stored: an open vocabulary is how an
 * event stream becomes a place to put anything, and this one is
 * unauthenticated-adjacent enough that "anything" is a bad idea.
 */
export const TELEMETRY_EVENTS = Object.freeze([
  'activationStarted',
  'activationCompleted',
  'jobOffered',
  'jobAccepted',
  'jobStarted',
  'jobCompleted',
  'actionFailed',
] as const);

export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[number];

/**
 * Keys a payload may carry, and the type each must be.
 *
 * Typed rather than merely named. The client allows scalars generally; here
 * each key declares what it is, so a string smuggled into `durationMs` — the
 * obvious place to hide a value — is dropped rather than stored.
 */
const ALLOWED: Readonly<Record<string, 'string' | 'number' | 'boolean'>> = Object.freeze({
  flavor: 'string',
  appVersion: 'string',
  buildNumber: 'string',
  bookingRef: 'string',
  failureClass: 'string',
  httpStatus: 'number',
  attempt: 'number',
  durationMs: 'number',
  jobState: 'string',
});

/**
 * Refused even if somebody adds them to ALLOWED by mistake.
 *
 * Mirrors the client's forbidden list. Two lists that must both be edited to
 * let a phone number through is the point — the failure mode being guarded
 * against is a well-meaning edit, not an attacker.
 */
const FORBIDDEN = Object.freeze(new Set([
  'token', 'idtoken', 'refreshtoken', 'authorization', 'password', 'otp', 'otpcode',
  'workercode', 'phone', 'phonenumber', 'documentid', 'signedurl', 'previewurl',
  'latitude', 'longitude', 'uid', 'workeruid', 'customername', 'address', 'email',
]));

/** Bounded so one client cannot fill the table, and so a value cannot carry a blob. */
const MAX_EVENTS_PER_REQUEST = 50;
const MAX_STRING_LENGTH = 120;

export interface ScrubbedEvent {
  event: TelemetryEventName;
  properties: Record<string, string | number | boolean>;
}

export interface ScrubOutcome {
  events: ScrubbedEvent[];
  /** Names of keys refused, for the counter. Never the values. */
  droppedKeys: string[];
  rejectedEvents: number;
}

const isEvent = (v: unknown): v is TelemetryEventName =>
  typeof v === 'string' && (TELEMETRY_EVENTS as readonly string[]).includes(v);

/**
 * Reduce whatever arrived to what this platform decided to store.
 *
 * Never throws and never partially fails a batch: one malformed event in fifty
 * drops that event, not the request. A telemetry endpoint that 400s on a
 * client's bad batch teaches clients to stop sending, and the batches most
 * worth having are the ones from the build that is going wrong.
 */
export const scrub = (body: unknown): ScrubOutcome => {
  const droppedKeys: string[] = [];
  let rejectedEvents = 0;

  const raw = (body as { events?: unknown })?.events;
  if (!Array.isArray(raw)) return { events: [], droppedKeys, rejectedEvents: 0 };

  const events: ScrubbedEvent[] = [];
  for (const candidate of raw.slice(0, MAX_EVENTS_PER_REQUEST)) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      rejectedEvents += 1;
      continue;
    }
    const record = candidate as Record<string, unknown>;
    if (!isEvent(record.event)) { rejectedEvents += 1; continue; }

    const properties: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === 'event') continue;
      const expected = ALLOWED[key];
      if (FORBIDDEN.has(key.toLowerCase()) || expected === undefined) { droppedKeys.push(key); continue; }
      // A nested object is a place for a whole profile to hide, and "the
      // allowlist covered the key" is no comfort if the value was the record.
      if (typeof value !== expected) { droppedKeys.push(key); continue; }
      properties[key] = typeof value === 'string' ? value.slice(0, MAX_STRING_LENGTH) : (value as number | boolean);
    }
    events.push({ event: record.event, properties });
  }

  if (raw.length > MAX_EVENTS_PER_REQUEST) rejectedEvents += raw.length - MAX_EVENTS_PER_REQUEST;
  return { events, droppedKeys, rejectedEvents };
};

export const handlers: V1Handlers = {
  'telemetry.ingest': async (req: Request, res: Response) => {
    try {
      const outcome = scrub(req.body);

      if (outcome.events.length === 0 && outcome.rejectedEvents === 0 && outcome.droppedKeys.length === 0) {
        return fail(res, req, 'VALIDATION_FAILED', 'No recognised events in the request body.');
      }

      for (const e of outcome.events) {
        incr('worker_telemetry_events_total', { event: e.event, flavor: String(e.properties.flavor ?? 'unknown') });
      }
      // The counter that says the two scrubbers have drifted. A rising value is
      // not an attack, it is a client sending a key this server does not store —
      // which means somebody's dashboard is about to be missing a column.
      if (outcome.droppedKeys.length) {
        incr('worker_telemetry_dropped_keys_total', {}, outcome.droppedKeys.length);
      }

      // Never blocks the response. Telemetry that can 500 a client is telemetry
      // that gets switched off in the build that most needed it.
      await recordTelemetryEvents(outcome.events, String((req as { user?: { uid?: string } }).user?.uid ?? ''));

      return ok(res, req, {
        accepted: outcome.events.length,
        dropped: outcome.droppedKeys.length,
        rejected: outcome.rejectedEvents,
      });
    } catch (error) {
      return sendCaught(res, req, 'telemetry.ingest', error as never);
    }
  },
};
