/**
 * The two divergences the portal would not guess about, resolved from this side.
 *
 * TAB 07 of the Admin API Master Command reports two type conflicts between the
 * contract and the admin portal's hand-written DTOs, and declines to fix either
 * from the front end:
 *
 * > The portal has deliberately not been changed to `string`, because the
 * > contract is precisely the thing nothing verifies against a running backend.
 * > Guessing which side is wrong would replace a visible divergence with an
 * > invisible one.
 *
 * That restraint was right, and this is the side that can answer.
 *
 * ## A-07a — ProviderTimeOff.id
 *
 * **The contract was wrong.** It declared `string`; the portal declared
 * `number`. Three independent sources in this repository say number:
 *
 *     scripts/baseline/000-baseline.sql   worker_time_off.id  integer NOT NULL
 *     node-postgres                       int4 parses to a JS number
 *     providerAvailabilityEngine.ts       interface ProviderTimeOff { id: number }
 *
 * A client that had trusted the document and compared `id === "5"` would never
 * have matched. The book's own framing — *"If it sends a number, the contract
 * is lying to every other client generating from it"* — is the case that holds.
 *
 * ## A-07b — MessageReport
 *
 * **Neither side is wrong.** They describe different endpoints on different
 * trees, and the shared name is the entire defect.
 *
 *     v1     POST /api/v1/conversations/{id}/messages/{id}/report
 *            chat.service.reportMessage: Promise<{ reportId: string }>
 *            -> the RECEIPT. One field, and that is the correct answer.
 *
 *     admin  GET /api/admin/communications/reports
 *            -> a MODERATION QUEUE ROW: id, messageId, reportedByUid, reason,
 *               messageBody, conversationId, status, resolvedByUid, …
 *
 * The queue row is published as `AdminMessageReport` in the admin document
 * (TAB 01), so the collision cannot persist. Both schemas now name the other.
 *
 * ## What these tests assert
 *
 * Against the IMPLEMENTATION, not only the document. A contract corrected to
 * agree with a service that later changes is the same defect with the sides
 * swapped, which is exactly how this one arose.
 */

import fs from 'fs';
import path from 'path';
import { buildOpenApiDocument } from '../src/api/v1/openapi';

const REPO = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');

const doc = buildOpenApiDocument() as any;
const schemas = doc.components.schemas;

describe('A-07a — ProviderTimeOff.id is a number, and every source agrees', () => {
  it('declares an integer in the contract', () => {
    expect(schemas.ProviderTimeOff.properties.id.type).toBe('integer');
  });

  it('matches the column type in the schema baseline', () => {
    // The database is the outermost authority. If this ever becomes bigint the
    // answer changes again — node-postgres returns int8 as a STRING — so the
    // column type is asserted rather than remembered.
    const sql = read(path.join('scripts', 'baseline', '000-baseline.sql'));
    const table = /CREATE TABLE servana\.worker_time_off \(([\s\S]*?)\n\);/.exec(sql);
    expect(table).not.toBeNull();
    expect(table![1]).toMatch(/^\s*id\s+integer\s+NOT NULL/m);
    // Explicitly NOT bigint: that would parse to a string and flip the answer.
    expect(table![1]).not.toMatch(/^\s*id\s+bigint/m);
  });

  it("matches the service's own TypeScript interface", () => {
    const src = read(path.join('src', 'services', 'providerAvailabilityEngine.ts'));
    const iface = /export interface ProviderTimeOff \{([\s\S]*?)\n\}/.exec(src);
    expect(iface).not.toBeNull();
    expect(iface![1]).toMatch(/\bid:\s*number\b/);
  });

  it('does not stringify the id anywhere in that service', () => {
    // The admin tree really does stringify some ids — NotificationTemplate.id
    // and CommunicationEvent.id are String(row.id). This one is not, and the
    // difference is the whole finding.
    const src = read(path.join('src', 'services', 'providerAvailabilityEngine.ts'));
    expect(src).not.toMatch(/id:\s*String\(/);
  });

  it('types the list against the schema instead of an open object', () => {
    // It was `items: { type: 'object', additionalProperties: true }` — an
    // untyped array that no client could bind to, which is how the id type
    // stayed wrong without anything noticing.
    expect(schemas.ProviderTimeOffList.properties.timeOff.items).toEqual({
      $ref: '#/components/schemas/ProviderTimeOff',
    });
  });

  it('declares the fields the interface has and the document had dropped', () => {
    // status in particular: cancelling does not delete the row, so a client
    // filtering for live time off must read it — and it was not documented.
    const props = Object.keys(schemas.ProviderTimeOff.properties);
    expect(props).toEqual(
      expect.arrayContaining(['status', 'createdBy', 'cancelledAt', 'cancelledBy']),
    );
    expect(schemas.ProviderTimeOff.properties.status.enum).toEqual(['active', 'cancelled']);
  });

  it('declares reason nullable, because the column is', () => {
    expect(schemas.ProviderTimeOff.properties.reason.type).toEqual(
      expect.arrayContaining(['null']),
    );
  });
});

describe('A-07b — MessageReport is a receipt, and says which object it is not', () => {
  it('declares exactly the shape the service returns', () => {
    const src = read(path.join('src', 'chat', 'chat.service.ts'));
    // The service's own signature is the authority.
    expect(src).toMatch(/reportMessage[\s\S]{0,400}?Promise<\{\s*reportId:\s*string\s*\}>/);
    expect(src).toMatch(/return \{ reportId: String\(/);

    expect(Object.keys(schemas.MessageReport.properties)).toEqual(['reportId']);
    expect(schemas.MessageReport.properties.reportId.type).toBe('string');
  });

  it('makes reportId required, because the service cannot return without it', () => {
    // An optional field that is always present teaches every client to
    // null-check for nothing.
    expect(schemas.MessageReport.required).toEqual(['reportId']);
  });

  it('names the other object so the collision cannot persist quietly', () => {
    // The fix for "two objects travelling under one name" is not to merge them
    // — they are genuinely different — it is to make each say what it is not.
    expect(schemas.MessageReport.description).toMatch(/AdminMessageReport/);
    expect(schemas.MessageReport.description).toMatch(/admin\/communications\/reports/);
  });

  it('publishes the moderation queue row under its own name', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ADMIN_SCHEMAS } = require('../src/api/admin/adminResponses');
    expect(ADMIN_SCHEMAS.AdminMessageReport).toBeDefined();
    const props = Object.keys((ADMIN_SCHEMAS.AdminMessageReport as any).properties);
    // The fields the portal's DTO actually holds — none of which is reportId.
    expect(props).toEqual(
      expect.arrayContaining(['id', 'messageId', 'reportedByUid', 'conversationId', 'status']),
    );
    expect(props).not.toContain('reportId');
  });

  it('keeps the two id representations distinguishable', () => {
    // The receipt stringifies; the queue row does not. A client holding both
    // must not assume they compare.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ADMIN_SCHEMAS } = require('../src/api/admin/adminResponses');
    expect(schemas.MessageReport.properties.reportId.type).toBe('string');
    expect((ADMIN_SCHEMAS.AdminMessageReport as any).properties.id.type).toBe('integer');
  });
});

describe('the other schemas TAB 07 listed', () => {
  it('has no under-specified position left in any of them', () => {
    /**
     * The book's third instruction: *"Then look at the other nine …  Several
     * contain one of the 21 under-specified positions, so part of what they
     * describe cannot be expressed in the contract until TAB 02 lands."*
     *
     * TAB 02 landed: 17 positions measured, 17 closed. This asserts the named
     * schemas are shaped, so the reason those DTOs could not be bound is gone.
     */
    const named = [
      'CatalogSubcategory', 'CatalogCategory', 'BookingTracking',
      'BookingRescheduleRequest', 'BookingAdditionalWorkRequest',
      'BookingAdditionalWorkList', 'BookingDispute', 'BookingDisputeList',
    ];
    const unshaped = named.filter((name) => {
      const schema = schemas[name];
      if (!schema) return false; // absent is a different problem, not this one
      return !schema.properties && !schema.allOf && !schema.oneOf && !schema.$ref;
    });
    expect(unshaped).toEqual([]);
  });
});
