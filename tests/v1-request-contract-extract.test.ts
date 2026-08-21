/**
 * TAB 03 — the published request contract, and the eight defects it must catch.
 *
 * ## What was measured before building
 *
 * `docs/api/CANONICAL_CALL_MANIFEST.json` is the artifact a client team is told
 * to diff its call sites against. It carried method, path, domain, auth,
 * idempotent and the response schema — and for all **55** write operations, no
 * request-body data whatsoever. It did not carry `replayMechanism` either,
 * which the Master Command assumed it did.
 *
 * The provider mobile team measured the consequence rather than predicting it:
 * eight of their writes shipped sending bodies this backend refuses, and all
 * eight passed their own tests, because those tests asserted the PATH. A path
 * assertion proves a call is routable and says nothing about whether it is
 * acceptable.
 *
 * ## Why these eight are asserted individually
 *
 * A test that only checked "every write has a requiredBody array" would pass on
 * an extract full of empty arrays. These pin the eight REAL defects to the data
 * that would have caught each one, so the extract is proven useful rather than
 * merely present. They are regression pins, not a vocabulary — the general
 * property is asserted separately below, and it is the one that grows.
 */

import { canonicalManifest, requestContractOf } from '../src/api/v1/convergence';
import { IMPLEMENTED, V1_PREFIX } from '../src/api/v1/contract';
import { SCHEMAS } from '../src/api/v1/openapi';

const manifest = canonicalManifest();
const byPath = (method: string, path: string) => {
  const found = manifest.find((e) => e.method === method && e.path === `${V1_PREFIX}${path}`);
  if (!found) throw new Error(`no manifest entry for ${method} ${path}`);
  return found;
};

/** A client-side gate of the kind the extract exists to make possible. */
const gate = (entry: any, body: Record<string, unknown>) => {
  const problems: string[] = [];
  if (entry.requiredBody === null) return problems; // declares no body
  for (const field of entry.requiredBody) {
    if (!(field in body)) problems.push(`missing required field: ${field}`);
  }
  if (entry.additionalBodyAllowed === false) {
    for (const field of Object.keys(body)) {
      if (!entry.allowedBody.includes(field)) problems.push(`field not permitted: ${field}`);
    }
  }
  return problems;
};

describe('the extract catches each of the eight writes that shipped broken', () => {
  it('1. verify-mobile sent {phone, code} where idToken is required', () => {
    const entry = byPath('POST', '/auth/verify-mobile');
    expect(entry.requiredBody).toContain('idToken');
    expect(gate(entry, { phone: '+639170000000', code: '123456' })).toEqual([
      'missing required field: idToken',
      'field not permitted: phone',
      'field not permitted: code',
    ]);
  });

  it('2. me/devices sent deviceToken where the field is token — push silently never arrives', () => {
    const entry = byPath('POST', '/me/devices');
    expect(entry.requiredBody).toContain('token');
    expect(entry.allowedBody).not.toContain('deviceToken');
    // The failure mode is not an error a provider sees. It is push
    // notifications never arriving, and push is how a provider learns a job
    // exists — which is why this is the one of the eight that should alarm.
    expect(gate(entry, { deviceToken: 'abc', platform: 'android' })).toEqual([
      'missing required field: token',
      'field not permitted: deviceToken',
    ]);
  });

  it('3. provider/documents omitted two required fields', () => {
    const entry = byPath('POST', '/provider/documents');
    expect(entry.requiredBody).toEqual(
      expect.arrayContaining(['clientRequestId', 'documentTypeId', 'file', 'fileName']),
    );
    const problems = gate(entry, { documentTypeId: 'nbi_clearance', file: 'x' });
    expect(problems).toContain('missing required field: clientRequestId');
    expect(problems).toContain('missing required field: fileName');
  });

  it('3b. …but its wrong FIELD NAMES are only a warning, because it permits extras', () => {
    const entry = byPath('POST', '/provider/documents');
    // Honest limitation, published rather than hidden: this schema does not
    // declare additionalProperties:false, so the server does not refuse an
    // unknown field and a client gate must not claim it does.
    expect(entry.additionalBodyAllowed).toBe(true);
  });

  it('4. time-off omitted reason', () => {
    const entry = byPath('POST', '/provider/time-off');
    expect(entry.requiredBody).toContain('reason');
    expect(gate(entry, { startDate: '2026-09-01', endDate: '2026-09-02' }))
      .toEqual(['missing required field: reason']);
  });

  it('5. provider/profile omitted clientRequestId', () => {
    const entry = byPath('PATCH', '/provider/profile');
    expect(entry.requiredBody).toEqual(['clientRequestId']);
    expect(gate(entry, { biography: 'Hello.' }))
      .toEqual(['missing required field: clientRequestId']);
  });

  it('6. disputes omitted category', () => {
    const entry = byPath('POST', '/bookings/:bookingId/disputes');
    expect(entry.requiredBody).toContain('category');
    expect(gate(entry, { reason: 'Damaged' }))
      .toEqual(['missing required field: category']);
  });

  it('7. additional-work sent a single pair where items is a list', () => {
    const entry = byPath('POST', '/bookings/:bookingId/additional-work');
    expect(entry.requiredBody).toEqual(['items']);
    expect(entry.additionalBodyAllowed).toBe(false);
    // Caught on NAMES alone — the client sent the item's own fields at the top
    // level instead of wrapping them, so no type information is needed.
    expect(gate(entry, { description: 'Extra socket', amount: 500 })).toEqual([
      'missing required field: items',
      'field not permitted: description',
      'field not permitted: amount',
    ]);
  });

  it('8. job-cancel invented two fields against a strict schema', () => {
    const entry = byPath('POST', '/provider/jobs/:bookingId/cancel');
    expect(entry.additionalBodyAllowed).toBe(false);
    expect(gate(entry, { cancellationReason: 'sick', notifyCustomer: true })).toEqual([
      'field not permitted: cancellationReason',
      'field not permitted: notifyCustomer',
    ]);
  });
});

describe('the general property, which grows when the contract does', () => {
  it('every write operation states its body contract, or states that it has none', () => {
    const writes = manifest.filter((e) => e.method !== 'GET');
    expect(writes.length).toBeGreaterThan(0);
    for (const entry of writes) {
      const declared = entry.requestSchema !== null;
      // null and [] mean different things and must never be confused: an empty
      // allow-list would read to a client as "no field is permitted".
      expect(entry.requiredBody === null).toBe(!declared);
      expect(entry.allowedBody === null).toBe(!declared);
      expect(entry.additionalBodyAllowed === null).toBe(!declared);
      if (declared) {
        expect(Array.isArray(entry.requiredBody)).toBe(true);
        expect(Array.isArray(entry.allowedBody)).toBe(true);
        expect(typeof entry.additionalBodyAllowed).toBe('boolean');
      }
    }
  });

  it('every required field is also a permitted one', () => {
    // A schema requiring a field it does not name in `properties` would publish
    // a contract no body can satisfy.
    for (const entry of manifest) {
      if (!entry.requiredBody) continue;
      for (const field of entry.requiredBody) {
        expect(entry.allowedBody).toContain(field);
      }
    }
  });

  it('every non-idempotent write publishes its replay mechanism beside its fields', () => {
    // The distinction between client-request-id (a BODY field) and
    // client-idempotency-key (a HEADER) caused two of the eight defects on its
    // own, and a client cannot tell them apart from the field list alone.
    for (const entry of manifest) {
      if (entry.idempotent) continue;
      expect(Array.isArray(entry.replayMechanism)).toBe(true);
      expect(entry.replayMechanism!.length).toBeGreaterThan(0);
    }
  });

  it('the extract agrees with SCHEMAS, because it is derived from it', () => {
    // One source, two views. A hand-maintained second copy is what this avoids.
    for (const entry of IMPLEMENTED) {
      const derived = requestContractOf(entry);
      const published = manifest.find((m) => m.id === entry.id);
      if (!published) continue;
      expect(published.requiredBody).toEqual(derived.requiredBody);
      expect(published.allowedBody).toEqual(derived.allowedBody);
      expect(published.additionalBodyAllowed).toEqual(derived.additionalBodyAllowed);
    }
  });

  it('arrays are sorted, so regenerating an unchanged contract is not a diff', () => {
    for (const entry of manifest) {
      if (!entry.allowedBody) continue;
      expect(entry.allowedBody).toEqual([...entry.allowedBody].sort());
      expect(entry.requiredBody).toEqual([...entry.requiredBody!].sort());
    }
  });
});

describe('the derivation refuses what it cannot read, rather than answering empty', () => {
  it('throws on a composed schema instead of publishing an empty allow-list', () => {
    const original = (SCHEMAS as any).__ComposedProbe;
    (SCHEMAS as any).__ComposedProbe = { allOf: [{ type: 'object' }] };
    try {
      expect(() =>
        requestContractOf({ id: 'probe', requestSchema: '__ComposedProbe' } as any),
      ).toThrow(/allOf/);
    } finally {
      if (original === undefined) delete (SCHEMAS as any).__ComposedProbe;
      else (SCHEMAS as any).__ComposedProbe = original;
    }
  });

  it('throws when an entry names a schema that does not exist', () => {
    expect(() =>
      requestContractOf({ id: 'probe', requestSchema: 'NoSuchSchema' } as any),
    ).toThrow(/not in SCHEMAS/);
  });
});

describe('a client can tell whether its pinned copy is stale', () => {
  it('the manifest carries the digest of the contract the process serves', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const published = require('../docs/api/CANONICAL_CALL_MANIFEST.json');
    expect(typeof published.contractSha256).toBe('string');
    expect(published.contractSha256).toMatch(/^[0-9a-f]{64}$/);
    // The same value every /api/v1 response carries, so the comparison a client
    // needs is against a live header rather than against a git checkout.
    expect(published.contractDigestHeader).toBe('x-contract-sha256');
  });

  it('states how the body contract is enforced, so a client draws the right conclusion', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const published = require('../docs/api/CANONICAL_CALL_MANIFEST.json');
    // Nothing validates request bodies against these schemas — no Ajv, no Joi,
    // no Zod, and register.ts never reads requestSchema. Saying so in the
    // artifact stops a client concluding, from one call that succeeded with an
    // extra field, that the whole extract is wrong.
    expect(published.bodyEnforcement).toBe('handler');
  });
});
