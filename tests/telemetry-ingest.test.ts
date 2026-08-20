/**
 * The telemetry sink refuses what the client was never supposed to send (TAB 06).
 *
 * ## Why the server scrubs a payload the client already scrubbed
 *
 * The worker app's scrubber is good: an allowlist, a forbidden list, scalar
 * values only, and its emitter is the only path to any sink. It also runs on a
 * device we do not control, in a build we cannot recall, shipped by a client
 * that can be modified. **A server that trusts a client's scrubbing has one
 * control, not two**, and the TAB refuses exactly that.
 *
 * So the assertions below are written against THIS server's behaviour with no
 * reference to what the client would have done. Several of them send payloads
 * the client could not produce, which is the point: the question is not "does
 * the client behave" but "what happens when something else does not".
 */

import { scrub, TELEMETRY_EVENTS } from '../src/api/v1/domains/telemetry';
import { V1_CONTRACT } from '../src/api/v1/contract';
import { METRICS, ALERTS } from '../src/observability/observabilityPolicy';

const batch = (...events: unknown[]) => ({ events });

describe('the closed event vocabulary', () => {
  it('matches the seven events the worker app emits', () => {
    // Named individually rather than counted: a count passes when one is swapped
    // for another, and these are the questions the product is judged on.
    expect([...TELEMETRY_EVENTS].sort()).toEqual([
      'actionFailed', 'activationCompleted', 'activationStarted',
      'jobAccepted', 'jobCompleted', 'jobOffered', 'jobStarted',
    ]);
  });

  it('drops an event it does not recognise, rather than storing it', () => {
    const out = scrub(batch({ event: 'providerLocationPinged' }));
    expect(out.events).toEqual([]);
    expect(out.rejectedEvents).toBe(1);
  });

  it('drops one bad event without losing the rest of the batch', () => {
    /**
     * A telemetry endpoint that 400s on a client's bad batch teaches clients to
     * stop sending, and the batches most worth having come from the build that
     * is going wrong.
     */
    const out = scrub(batch(
      { event: 'jobAccepted' },
      { event: 'notAnEvent' },
      { event: 'jobCompleted' },
    ));
    expect(out.events.map((e) => e.event)).toEqual(['jobAccepted', 'jobCompleted']);
    expect(out.rejectedEvents).toBe(1);
  });
});

describe('nothing sensitive survives, whatever is sent', () => {
  /**
   * The gate: "No location, document id, phone number or token is present in
   * what arrives, verified against a real payload."
   *
   * This is a REAL payload in the sense that matters — every forbidden key here
   * is one the worker app genuinely holds. It carries live location, identity
   * documents, signed preview URLs and a bearer token; those are not invented
   * field names, they are what would leak.
   */
  const hostile = {
    event: 'jobCompleted',
    // Allowed, and must survive.
    bookingRef: 'BKG-7731',
    durationMs: 4210,
    jobState: 'completed',
    appVersion: '1.4.2',
    // Every one of these must not.
    latitude: 14.5995,
    longitude: 120.9842,
    uid: 'firebase-uid-abc123',
    workerUid: 'firebase-uid-abc123',
    phoneNumber: '+639171234567',
    documentId: 'doc_98f3',
    signedUrl: 'https://storage.googleapis.com/servana/doc_98f3?X-Goog-Signature=deadbeef',
    previewUrl: 'https://storage.googleapis.com/servana/preview?sig=abc',
    idToken: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjE',
    authorization: 'Bearer eyJhbGciOiJSUzI1NiI',
    otpCode: '445512',
    workerCode: '8812',
    customerName: 'Maria Santos',
    address: '14 Mabini St, Barangay Poblacion, Makati',
    email: 'maria@example.com',
    password: 'hunter2',
  };

  it('keeps the allowed keys', () => {
    const out = scrub(batch(hostile));
    expect(out.events).toHaveLength(1);
    expect(out.events[0].properties).toEqual({
      bookingRef: 'BKG-7731',
      durationMs: 4210,
      jobState: 'completed',
      appVersion: '1.4.2',
    });
  });

  it('lets no forbidden VALUE through anywhere in the stored row', () => {
    // Asserted on the serialized row rather than key by key: a key-by-key check
    // passes if a value is moved into a different key.
    const out = scrub(batch(hostile));
    const stored = JSON.stringify(out.events);
    for (const leak of [
      '14.5995', '120.9842', 'firebase-uid-abc123', '+639171234567', 'doc_98f3',
      'X-Goog-Signature', 'eyJhbGciOiJSUzI1NiI', '445512', '8812',
      'Maria Santos', 'Mabini St', 'maria@example.com', 'hunter2',
    ]) {
      expect(stored).not.toContain(leak);
    }
  });

  it('counts what it dropped, so drift between the two scrubbers is visible', () => {
    const out = scrub(batch(hostile));
    expect(out.droppedKeys.length).toBeGreaterThan(10);
    // Names only. A dropped-key report that echoed values would put the phone
    // number in the log instead of the database.
    expect(JSON.stringify(out.droppedKeys)).not.toContain('+639171234567');
  });

  it('refuses a forbidden key even in different casing', () => {
    const out = scrub(batch({ event: 'jobStarted', LATITUDE: 1, PhoneNumber: '+63', Uid: 'x' }));
    expect(out.events[0].properties).toEqual({});
  });
});

describe('values are typed, not merely named', () => {
  it('drops a string smuggled into a numeric field', () => {
    // The obvious hiding place: an allowed key whose value is not what it claims.
    const out = scrub(batch({ event: 'actionFailed', durationMs: '+639171234567' }));
    expect(out.events[0].properties).toEqual({});
    expect(out.droppedKeys).toContain('durationMs');
  });

  it('drops a nested object, where a whole profile could hide', () => {
    const out = scrub(batch({
      event: 'actionFailed',
      failureClass: { name: 'Maria Santos', phone: '+639171234567' },
    }));
    expect(out.events[0].properties).toEqual({});
  });

  it('drops an array for the same reason', () => {
    const out = scrub(batch({ event: 'actionFailed', failureClass: ['a', 'b'] }));
    expect(out.events[0].properties).toEqual({});
  });

  it('truncates a long string rather than storing a blob', () => {
    const out = scrub(batch({ event: 'actionFailed', failureClass: 'x'.repeat(5000) }));
    expect((out.events[0].properties.failureClass as string).length).toBe(120);
  });

  it('caps the batch, so one client cannot fill the table', () => {
    const many = Array.from({ length: 200 }, () => ({ event: 'jobOffered' }));
    const out = scrub(batch(...many));
    expect(out.events.length).toBe(50);
    expect(out.rejectedEvents).toBe(150);
  });
});

describe('malformed input is survived, not thrown on', () => {
  it.each([
    ['null', null],
    ['a string', 'events'],
    ['no events key', { other: 1 }],
    ['events not an array', { events: 'jobOffered' }],
    ['an array of nulls', { events: [null, null] }],
    ['an array of arrays', { events: [[], []] }],
  ])('survives %s', (_label, body) => {
    expect(() => scrub(body)).not.toThrow();
    expect(scrub(body).events).toEqual([]);
  });
});

describe('there is no free-text field, and that is a decision', () => {
  it('accepts no message, stackTrace or note', () => {
    /**
     * A crash reporter that accepts a stack trace accepts whatever the strings
     * in that stack happen to contain — which on this app includes addresses,
     * customer names and signed URLs. Wanting stack traces later is a separate
     * decision with its own scrubbing and its own retention, not a field added
     * to this one.
     */
    const out = scrub(batch({
      event: 'actionFailed',
      message: 'failed for Maria Santos at 14 Mabini St',
      stackTrace: 'at BookingApi.complete (token=eyJhbGciOi)',
      note: 'customer phone +639171234567',
    }));
    expect(out.events[0].properties).toEqual({});
    expect(JSON.stringify(out.events)).not.toContain('Mabini');
  });
});

describe('the endpoint is declared, and its refusals are on the record', () => {
  const entry = V1_CONTRACT.find((e) => e.id === 'telemetry.ingest');

  it('exists, is mounted, and requires a credential', () => {
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('implemented');
    // Unlike the recall lever, this one is authenticated: the events are
    // attributed to a provider, and the attribution comes from the token.
    expect(entry?.auth).toBe('authenticated');
  });

  it('names what stops a replay instead of leaving the sentence unfinished', () => {
    expect(entry?.idempotent).toBe(false);
    expect(entry?.replayMechanism).toEqual(['none-accepted']);
    expect(entry?.replayGuard).toContain('double-count');
  });
});

describe('the signal has somewhere to go and somebody to wake', () => {
  it('emits counters a collector can read', () => {
    const names = METRICS.map((m) => m.name);
    expect(names).toContain('worker_telemetry_events_total');
    expect(names).toContain('worker_telemetry_dropped_keys_total');
    expect(names).toContain('worker_telemetry_write_failures_total');
  });

  it('defines one alert with a threshold and a first action', () => {
    /**
     * The refusal: "Do not ship an ingest endpoint with no alert on it and call
     * the app observable." The worker app's failures are silent by nature — a
     * job offer that never arrives produces no error anywhere.
     */
    const alert = ALERTS.find((a) => a.name === 'worker-activation-stall');
    expect(alert).toBeDefined();
    expect(alert?.metric).toBe('worker_telemetry_events_total');
    expect(alert?.condition).toContain('activationCompleted');
    expect(alert?.firstAction.length).toBeGreaterThan(60);
  });
});
