/**
 * Location Controller Tests — SUGGESTED ADDRESS audit
 * Tests the controller shim between HTTP and addressSearchService.
 *
 * Re-implements the controller logic in plain JS (same pattern as other test files)
 * because ts-jest is not configured.
 *
 * Changes from previous version:
 *   MIN_QUERY_LENGTH lowered from 3 to 2 to support numeric-prefix queries ("12").
 */

// ── Minimal controller logic re-implemented ───────────────────────────────────
// (mirrors locationController.ts exactly)

const MIN_QUERY_LENGTH = 2;

async function getAddressSuggestions(req, mockService) {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const sessionToken =
    typeof req.query.sessionToken === 'string' ? req.query.sessionToken.trim() : '';

  if (!q || q.length < MIN_QUERY_LENGTH) {
    return { status: 200, body: { data: { suggestions: [] } } };
  }
  if (!sessionToken) {
    return { status: 400, body: { status: 'failed', message: 'sessionToken is required' } };
  }

  try {
    const suggestions = await mockService.getSuggestions(q, sessionToken);
    return { status: 200, body: { data: { suggestions } } };
  } catch (err) {
    return { status: 502, body: { status: 'failed', message: 'Address search is temporarily unavailable' } };
  }
}

async function getAddressDetails(req, mockService) {
  const placeId = typeof req.params.placeId === 'string' ? req.params.placeId.trim() : '';
  const sessionToken =
    typeof req.query.sessionToken === 'string' ? req.query.sessionToken.trim() : '';

  if (!placeId) {
    return { status: 400, body: { status: 'failed', message: 'placeId is required' } };
  }
  if (!sessionToken) {
    return { status: 400, body: { status: 'failed', message: 'sessionToken is required' } };
  }

  try {
    const result = await mockService.resolveAddress(placeId, sessionToken);
    if (!result) {
      return { status: 404, body: { status: 'failed', message: 'Address not found' } };
    }
    return { status: 200, body: { data: { result } } };
  } catch (err) {
    return { status: 502, body: { status: 'failed', message: 'Address resolution is temporarily unavailable' } };
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_SUGGESTION = {
  id: 'ChIJ_makati',
  primaryText: 'Makati City',
  secondaryText: 'Metro Manila',
  fullText: 'Makati City, Metro Manila, Philippines',
  types: ['locality'],
  provider: 'google',
};

const MOCK_RESOLVED = {
  externalPlaceId: 'ChIJ_makati',
  displayName: 'Makati City',
  formattedAddress: 'Makati City, Metro Manila, Philippines',
  addressOne: 'Makati City',
  postTown: 'Makati City',
  province: 'Metro Manila',
  zipCode: '1200',
  country: 'PH',
  latitude: 14.5547,
  longitude: 121.0244,
  servanaLocationId: 'loc_14.554700_121.024400',
};

// ── getAddressSuggestions — input validation ──────────────────────────────────

describe('getAddressSuggestions — input validation', () => {
  it('single char query → 200 empty suggestions (too short for min=2)', async () => {
    const service = { getSuggestions: jest.fn() };
    const res = await getAddressSuggestions({ query: { q: 'M', sessionToken: 'tok-1' } }, service);
    expect(res.status).toBe(200);
    expect(res.body.data.suggestions).toEqual([]);
    expect(service.getSuggestions).not.toHaveBeenCalled();
  });

  it('2-char query → triggers service call (numeric prefix supported)', async () => {
    const service = { getSuggestions: jest.fn().mockResolvedValue([MOCK_SUGGESTION]) };
    const res = await getAddressSuggestions({ query: { q: '12', sessionToken: 'tok-num' } }, service);
    expect(res.status).toBe(200);
    expect(service.getSuggestions).toHaveBeenCalledWith('12', 'tok-num');
  });

  it('2-char alphabetical query → triggers service call', async () => {
    const service = { getSuggestions: jest.fn().mockResolvedValue([]) };
    const res = await getAddressSuggestions({ query: { q: 'Ma', sessionToken: 'tok-ma' } }, service);
    expect(res.status).toBe(200);
    expect(service.getSuggestions).toHaveBeenCalledWith('Ma', 'tok-ma');
  });

  it('empty query → 200 empty suggestions', async () => {
    const service = { getSuggestions: jest.fn() };
    const res = await getAddressSuggestions({ query: { q: '', sessionToken: 'tok-2' } }, service);
    expect(res.status).toBe(200);
    expect(res.body.data.suggestions).toEqual([]);
  });

  it('missing sessionToken → 400', async () => {
    const service = { getSuggestions: jest.fn() };
    const res = await getAddressSuggestions({ query: { q: 'Makati' } }, service);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sessionToken/);
    expect(service.getSuggestions).not.toHaveBeenCalled();
  });

  it('blank sessionToken → 400', async () => {
    const service = { getSuggestions: jest.fn() };
    const res = await getAddressSuggestions({ query: { q: 'Makati', sessionToken: '   ' } }, service);
    expect(res.status).toBe(400);
  });
});

describe('getAddressSuggestions — happy path', () => {
  it('valid query + sessionToken → 200 with suggestions from service', async () => {
    const service = { getSuggestions: jest.fn().mockResolvedValue([MOCK_SUGGESTION]) };
    const res = await getAddressSuggestions({ query: { q: 'Makati', sessionToken: 'tok-ok' } }, service);
    expect(res.status).toBe(200);
    expect(res.body.data.suggestions).toHaveLength(1);
    expect(res.body.data.suggestions[0].id).toBe('ChIJ_makati');
    expect(service.getSuggestions).toHaveBeenCalledWith('Makati', 'tok-ok');
  });

  it('numeric prefix query "12 Mabini" → 200 with service results', async () => {
    const numericSuggestion = {
      id: 'ChIJ_mabini',
      primaryText: '12 Mabini Street',
      secondaryText: 'Barangay San Antonio, Makati City',
      fullText: '12 Mabini Street, San Antonio, Makati City, Metro Manila',
      types: ['street_address'],
      provider: 'google',
    };
    const service = { getSuggestions: jest.fn().mockResolvedValue([numericSuggestion]) };
    const res = await getAddressSuggestions({ query: { q: '12 Mabini', sessionToken: 'tok-num2' } }, service);
    expect(res.status).toBe(200);
    expect(res.body.data.suggestions[0].primaryText).toBe('12 Mabini Street');
  });

  it('service returns empty array → 200 with empty suggestions', async () => {
    const service = { getSuggestions: jest.fn().mockResolvedValue([]) };
    const res = await getAddressSuggestions({ query: { q: 'xyz99', sessionToken: 'tok-empty' } }, service);
    expect(res.status).toBe(200);
    expect(res.body.data.suggestions).toEqual([]);
  });
});

describe('getAddressSuggestions — service failure', () => {
  it('service throws → 502 (not 500, not leaking the original error)', async () => {
    const service = { getSuggestions: jest.fn().mockRejectedValue(new Error('REQUEST_DENIED')) };
    const res = await getAddressSuggestions({ query: { q: 'Makati', sessionToken: 'tok-fail' } }, service);
    expect(res.status).toBe(502);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).not.toMatch(/REQUEST_DENIED/); // do not leak Google error to browser
    expect(res.body.message).toMatch(/temporarily unavailable/);
  });

  it('service throws OVER_QUERY_LIMIT → 502 (safe generic message)', async () => {
    const service = { getSuggestions: jest.fn().mockRejectedValue(new Error('OVER_QUERY_LIMIT')) };
    const res = await getAddressSuggestions({ query: { q: 'BGC', sessionToken: 'tok-quota' } }, service);
    expect(res.status).toBe(502);
  });
});

// ── getAddressDetails ─────────────────────────────────────────────────────────

describe('getAddressDetails — input validation', () => {
  it('empty placeId → 400', async () => {
    const service = { resolveAddress: jest.fn() };
    const res = await getAddressDetails({ params: { placeId: '' }, query: { sessionToken: 'tok-1' } }, service);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/placeId/);
  });

  it('missing sessionToken → 400', async () => {
    const service = { resolveAddress: jest.fn() };
    const res = await getAddressDetails({ params: { placeId: 'ChIJ_test' }, query: {} }, service);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sessionToken/);
  });
});

describe('getAddressDetails — happy path', () => {
  it('valid placeId + sessionToken → 200 with resolved address', async () => {
    const service = { resolveAddress: jest.fn().mockResolvedValue(MOCK_RESOLVED) };
    const res = await getAddressDetails(
      { params: { placeId: 'ChIJ_makati' }, query: { sessionToken: 'tok-ok' } },
      service,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.result.externalPlaceId).toBe('ChIJ_makati');
    expect(res.body.data.result.servanaLocationId).toBe('loc_14.554700_121.024400');
    expect(service.resolveAddress).toHaveBeenCalledWith('ChIJ_makati', 'tok-ok');
  });

  it('resolved address country is PH', async () => {
    const service = { resolveAddress: jest.fn().mockResolvedValue(MOCK_RESOLVED) };
    const res = await getAddressDetails(
      { params: { placeId: 'ChIJ_makati' }, query: { sessionToken: 'tok-country' } },
      service,
    );
    expect(res.body.data.result.country).toBe('PH');
  });
});

describe('getAddressDetails — not found', () => {
  it('service returns null → 404', async () => {
    const service = { resolveAddress: jest.fn().mockResolvedValue(null) };
    const res = await getAddressDetails(
      { params: { placeId: 'ChIJ_gone' }, query: { sessionToken: 'tok-notfound' } },
      service,
    );
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
  });
});

describe('getAddressDetails — service failure', () => {
  it('service throws → 502 with safe generic message (no Google error leaked)', async () => {
    const service = { resolveAddress: jest.fn().mockRejectedValue(new Error('REQUEST_DENIED')) };
    const res = await getAddressDetails(
      { params: { placeId: 'ChIJ_fail' }, query: { sessionToken: 'tok-502' } },
      service,
    );
    expect(res.status).toBe(502);
    expect(res.body.message).not.toMatch(/REQUEST_DENIED/);
    expect(res.body.message).toMatch(/temporarily unavailable/);
  });
});

// ── servanaLocationId mobile format contract ──────────────────────────────────

describe('servanaLocationId format contract', () => {
  it('resolved address has loc_{lat.6dp}_{lon.6dp} format (mobile parity)', async () => {
    const service = { resolveAddress: jest.fn().mockResolvedValue(MOCK_RESOLVED) };
    const res = await getAddressDetails(
      { params: { placeId: 'ChIJ_makati' }, query: { sessionToken: 'tok-loc' } },
      service,
    );
    const id = res.body.data.result.servanaLocationId;
    expect(id).toMatch(/^loc_\d+\.\d{6}_\d+\.\d{6}$/);
    const { latitude, longitude } = res.body.data.result;
    expect(id).toBe('loc_' + latitude.toFixed(6) + '_' + longitude.toFixed(6));
  });
});
