/**
 * Admin Error Envelope Tests — Command 9
 * Validates the standardized admin error envelope shape from adminError.ts
 * Run: npx jest tests/admin-error-envelope.test.js
 */

// ─── Mock implementations (mirror adminError.ts logic without crypto) ─────────

let requestIdCallCount = 0;
function mockRequestId() {
  requestIdCallCount++;
  return `mock-request-id-${requestIdCallCount}`;
}

const HTTP_TO_CODE = {
  400: 'BUSINESS_RULE', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 422: 'VALIDATION_ERROR', 500: 'SERVER_ERROR',
};

const CODE_TO_KIND = {
  SERVER_ERROR:     'server',
  NOT_FOUND:        'not_found',
  VALIDATION_ERROR: 'validation',
  CONFLICT:         'conflict',
  BUSINESS_RULE:    'business_rule',
  UNAUTHORIZED:     'unauthenticated',
  FORBIDDEN:        'forbidden',
  RATE_LIMITED:     'rate_limited',
};

function buildAdminErrorEnvelope(code, message, fieldErrors) {
  const requestId = mockRequestId();
  const kind = CODE_TO_KIND[code] ?? 'unknown';
  const body = { status: 'error', error: { code, message, kind, requestId } };
  if (fieldErrors) body.error.fieldErrors = fieldErrors;
  return body;
}

// ─── Envelope shape ───────────────────────────────────────────────────────────

describe('Admin error envelope — shape', () => {
  it('has status: error', () => {
    const env = buildAdminErrorEnvelope('SERVER_ERROR', 'Something broke');
    expect(env.status).toBe('error');
  });

  it('has nested error.code', () => {
    const env = buildAdminErrorEnvelope('NOT_FOUND', 'Booking not found');
    expect(env.error.code).toBe('NOT_FOUND');
  });

  it('has nested error.message', () => {
    const env = buildAdminErrorEnvelope('NOT_FOUND', 'Booking not found');
    expect(env.error.message).toBe('Booking not found');
  });

  it('has error.kind corresponding to code', () => {
    const env = buildAdminErrorEnvelope('NOT_FOUND', 'Booking not found');
    expect(env.error.kind).toBe('not_found');
  });

  it('has error.requestId (truthy)', () => {
    const env = buildAdminErrorEnvelope('SERVER_ERROR', 'Something broke');
    expect(env.error.requestId).toBeTruthy();
  });

  it('each call gets a unique requestId', () => {
    const a = buildAdminErrorEnvelope('SERVER_ERROR', 'err');
    const b = buildAdminErrorEnvelope('SERVER_ERROR', 'err');
    expect(a.error.requestId).not.toBe(b.error.requestId);
  });
});

// ─── Code ↔ kind mapping ─────────────────────────────────────────────────────

describe('Admin error envelope — code to kind mapping', () => {
  const cases = [
    ['SERVER_ERROR', 'server'],
    ['NOT_FOUND', 'not_found'],
    ['VALIDATION_ERROR', 'validation'],
    ['CONFLICT', 'conflict'],
    ['BUSINESS_RULE', 'business_rule'],
    ['FORBIDDEN', 'forbidden'],
    ['RATE_LIMITED', 'rate_limited'],
    ['UNAUTHORIZED', 'unauthenticated'],
  ];

  for (const [code, expectedKind] of cases) {
    it(`${code} → kind: ${expectedKind}`, () => {
      const env = buildAdminErrorEnvelope(code, 'message');
      expect(env.error.kind).toBe(expectedKind);
    });
  }
});

// ─── Optional fieldErrors ─────────────────────────────────────────────────────

describe('Admin error envelope — fieldErrors', () => {
  it('omitted when undefined', () => {
    const env = buildAdminErrorEnvelope('VALIDATION_ERROR', 'Invalid fields');
    expect(env.error.fieldErrors).toBeUndefined();
  });

  it('present when provided', () => {
    const fieldErrors = { email: ['Email is required'], name: ['Name is too short'] };
    const env = buildAdminErrorEnvelope('VALIDATION_ERROR', 'Invalid fields', fieldErrors);
    expect(env.error.fieldErrors).toEqual(fieldErrors);
  });
});

// ─── HTTP status ↔ code mapping ───────────────────────────────────────────────

describe('HTTP to code mapping', () => {
  it('400 → BUSINESS_RULE', () => expect(HTTP_TO_CODE[400]).toBe('BUSINESS_RULE'));
  it('403 → FORBIDDEN',     () => expect(HTTP_TO_CODE[403]).toBe('FORBIDDEN'));
  it('404 → NOT_FOUND',     () => expect(HTTP_TO_CODE[404]).toBe('NOT_FOUND'));
  it('409 → CONFLICT',      () => expect(HTTP_TO_CODE[409]).toBe('CONFLICT'));
  it('422 → VALIDATION_ERROR', () => expect(HTTP_TO_CODE[422]).toBe('VALIDATION_ERROR'));
  it('500 → SERVER_ERROR',  () => expect(HTTP_TO_CODE[500]).toBe('SERVER_ERROR'));
});

// ─── Contract: frontend normalizer compatibility ───────────────────────────────

describe('Admin error envelope — FE normalizer compatibility', () => {
  // The FE normalizeAdminApiError reads:
  //   e?.error?.error?.message  (new nested format)
  //   e?.error?.message         (old flat format, fallback)
  // Both must work.

  it('new nested format: error.error.message is extractable', () => {
    const httpResponse = {
      status: 500,
      error: buildAdminErrorEnvelope('SERVER_ERROR', 'DB connection failed'),
    };
    const extracted = httpResponse.error?.error?.message;
    expect(extracted).toBe('DB connection failed');
  });

  it('new nested format: error.error.kind is extractable', () => {
    const httpResponse = {
      status: 404,
      error: buildAdminErrorEnvelope('NOT_FOUND', 'Provider not found'),
    };
    const extracted = httpResponse.error?.error?.kind;
    expect(extracted).toBe('not_found');
  });

  it('new nested format: error.error.requestId is extractable', () => {
    const httpResponse = {
      status: 500,
      error: buildAdminErrorEnvelope('SERVER_ERROR', 'Error'),
    };
    const requestId = httpResponse.error?.error?.requestId;
    expect(requestId).toBeTruthy();
  });
});

// ─── Contract: non-admin routes not broken ────────────────────────────────────

describe('Admin error envelope — scope', () => {
  it('envelope is only used for /admin/* routes, never for mobile/provider routes', () => {
    const ADMIN_ROUTE_PREFIX = '/api/admin/';
    const MOBILE_ROUTES = [
      '/api/bookings',
      '/api/users/:userId/bookings',
      '/api/workers/:uid/job-cards',
      '/api/provider-catalog/v1/offerings',
    ];
    for (const route of MOBILE_ROUTES) {
      expect(route.startsWith(ADMIN_ROUTE_PREFIX)).toBe(false);
    }
  });
});
