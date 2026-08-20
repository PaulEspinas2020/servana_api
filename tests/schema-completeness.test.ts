/**
 * No schema in the canonical contract is declared without a shape.
 *
 * TAB 02 of the Admin API Master Command: *"nothing can bind to an empty
 * object, so a change inside any of these is invisible to every client-side
 * gate that exists"*. `openapi-typescript` renders a schema with no
 * `properties` as `Record<string, never>`, so a client generated from one
 * cannot say what the response contains — and therefore cannot fail when it
 * changes.
 *
 * The book counted 21 such positions from the portal's generated types and
 * named nine top-level schemas. Measured here against this repository's own
 * contract the count was **17**, across eight top-level schemas: two of the
 * book's nine had already closed before this session, and none of them were
 * closed by it.
 *
 * All 17 are now closed. This suite is what stops the eighteenth.
 *
 * ## Why a ceiling of zero rather than a ratchet
 *
 * Every other counter in this programme ratchets, because the work is
 * open-ended. This one does not: there is no legitimate reason to add a schema
 * with no properties to a contract five clients generate from. If a shape is
 * genuinely unknown, `additionalProperties: true` with a description says so
 * honestly and still binds; `{ type: 'object' }` says nothing at all.
 */

import { buildOpenApiDocument } from '../src/api/v1/openapi';

/** Every position in the document that renders as `Record<string, never>`. */
function emptyObjectPositions(node: unknown, path: string, out: string[]): void {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    node.forEach((child, i) => emptyObjectPositions(child, `${path}[${i}]`, out));
    return;
  }

  const o = node as Record<string, unknown>;
  const composes = o.properties || o.allOf || o.oneOf || o.anyOf || o.$ref;
  if (o.type === 'object' && !composes && o.additionalProperties === undefined) {
    out.push(path);
  }

  for (const [key, value] of Object.entries(o)) {
    // `description` is prose and `enum` is values; neither can hold a schema.
    if (key === 'description' || key === 'enum') continue;
    emptyObjectPositions(value, `${path}.${key}`, out);
  }
}

describe('the canonical contract declares a shape for everything', () => {
  const doc = buildOpenApiDocument() as {
    components: { schemas: Record<string, unknown> };
  };
  const schemas = doc.components.schemas;

  it('has no schema position that generates as an empty object', () => {
    const found: string[] = [];
    for (const [name, schema] of Object.entries(schemas)) {
      emptyObjectPositions(schema, name, found);
    }
    // Named, not counted: a bare number tells whoever broke this nothing about
    // which schema to open.
    expect(found).toEqual([]);
  });

  it('gives the five admin assignment-path schemas real properties', () => {
    // The book's priority: "closing them turns five admin assignment endpoints
    // from invisible into type-checked in every client".
    for (const name of [
      'AdminBookingList',
      'AssignmentCandidatePool',
      'AdminAssignRequest',
      'AdminReassignRequest',
      'AdminBookingActionResult',
    ]) {
      const schema = schemas[name] as Record<string, unknown>;
      expect(schema).toBeDefined();
      const shaped =
        Boolean(schema.properties) ||
        Boolean(schema.oneOf) ||
        Boolean(schema.allOf) ||
        schema.type === 'array';
      expect(`${name}: ${shaped}`).toBe(`${name}: true`);
    }
  });

  it('describes assign and reassign as the DIFFERENT objects they are', () => {
    /**
     * One name, `AdminBookingActionResult`, was the declared response of both
     * endpoints. Reading the two services shows they never agreed:
     *
     *   adminAssignProvider   → { bookingId, providerUid, providerName, status }
     *   adminReassignProvider → { bookingId, fromProviderUid, toProviderUid, providerName }
     *
     * The reassign result carries no `status` at all, and names both ends of
     * the move rather than one provider. No single object schema could have
     * described both, which is why the shared name stayed empty for so long —
     * an empty schema is what a disagreement looks like when nobody has to
     * resolve it.
     */
    const assign = schemas.AdminAssignResult as any;
    const reassign = schemas.AdminReassignResult as any;

    expect(Object.keys(assign.properties)).toEqual(
      expect.arrayContaining(['bookingId', 'providerUid', 'status']),
    );
    expect(Object.keys(reassign.properties)).toEqual(
      expect.arrayContaining(['bookingId', 'fromProviderUid', 'toProviderUid']),
    );
    // The asymmetry itself, asserted — this is the fact a client must know.
    expect(reassign.properties.status).toBeUndefined();
    expect(assign.properties.toProviderUid).toBeUndefined();
  });

  it('names the reassign field the handler actually reads', () => {
    // The previous description said "providerUid and a REQUIRED reason". The
    // handler reads `toProviderUid`, so a client built from that sentence sent
    // a body the handler rejects as missing.
    const req = schemas.AdminReassignRequest as any;
    expect(req.required).toEqual(expect.arrayContaining(['toProviderUid', 'reason']));
    expect(req.properties.providerUid).toBeUndefined();
  });

  it('declares commissionRate as a fraction with a range', () => {
    // TAB 05. SERVANA_COMMISSION_RATE is 0.2 and PROVIDER_SHARE_RATE is 0.8;
    // the two sum to exactly 1, which settles the unit beyond argument.
    const rate = (schemas.BookingPayment as any).properties.servana.properties
      .commissionRate;
    expect(rate.minimum).toBe(0);
    expect(rate.maximum).toBe(1);
    expect(rate.description).toMatch(/fraction/i);
  });

  it('declares the booking timeline as the object the handler returns', () => {
    // It was declared `type: 'array'`. getCustomerBookingTimeline returns an
    // OBJECT — { bookingId, events, currentStep } — so a generated client
    // iterated `timeline` and found nothing, with no error anywhere.
    const timeline = (schemas.BookingTimeline as any).properties.timeline;
    expect(timeline.type).toBe('object');
    expect(Object.keys(timeline.properties)).toEqual(
      expect.arrayContaining(['bookingId', 'events', 'currentStep']),
    );
    expect(timeline.properties.events.type).toBe('array');
  });

  it('does not declare a booking credential as part of the Booking shape', () => {
    // The Booking schema is an open shape, so it cannot forbid a field. What it
    // CAN do is refuse to advertise one: a contract that named `workerCode` as
    // part of every booking response would be documenting the leak as a feature.
    const booking = JSON.stringify((schemas.Booking as any).properties);
    expect(booking).not.toContain('workerCode');
    expect(booking).not.toContain('otpCode');
  });
});
