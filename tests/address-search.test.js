/**
 * Address Search Service Tests — Google Places status code handling
 * Run: npx jest tests/address-search.test.js
 *
 * Verifies status-code routing logic, suggestion mapping, and the mobile-safe
 * loc_{lat}_{lon} location ID format. Logic is re-implemented in plain JS
 * (same approach as admin-error.test.js) because ts-jest is not configured.
 */

// ── Re-implemented logic (mirrors addressSearchService.ts) ────────────────────

function buildServanaLocationId(lat, lon) {
  return 'loc_' + lat.toFixed(6) + '_' + lon.toFixed(6);
}

function extractAddressComponent(components, types, useShortName) {
  for (var i = 0; i < components.length; i++) {
    var c = components[i];
    for (var j = 0; j < types.length; j++) {
      if (c.types && c.types.indexOf(types[j]) !== -1) {
        return (useShortName ? c.short_name : c.long_name) || '';
      }
    }
  }
  return '';
}

function handleSuggestionsResponse(respData) {
  var status = (respData && respData.status) ? respData.status : 'UNKNOWN_ERROR';
  if (status === 'ZERO_RESULTS') { return []; }
  if (status !== 'OK') {
    var errMsg = (respData && respData.error_message) ? respData.error_message : '';
    throw new Error('Google Places autocomplete error: ' + status + (errMsg ? ' — ' + errMsg : ''));
  }
  var predictions = (respData && respData.predictions) ? respData.predictions : [];
  return predictions.slice(0, 5).map(function (p) {
    var structured = p.structured_formatting || {};
    return {
      id: p.place_id || '',
      primaryText: structured.main_text || p.description || '',
      secondaryText: structured.secondary_text || '',
      fullText: p.description || '',
      types: p.types || [],
      provider: 'google',
    };
  });
}

function handleDetailsResponse(respData) {
  var status = (respData && respData.status) ? respData.status : 'UNKNOWN_ERROR';
  if (status === 'ZERO_RESULTS' || status === 'NOT_FOUND') { return null; }
  if (status !== 'OK') {
    var errMsg = (respData && respData.error_message) ? respData.error_message : '';
    throw new Error('Google Places details error: ' + status + (errMsg ? ' — ' + errMsg : ''));
  }
  return (respData && respData.result) ? respData.result : null;
}

// ── getSuggestions — status code handling ─────────────────────────────────────

describe('getSuggestions — status code handling', () => {
  it('ZERO_RESULTS → returns empty array (not a 502)', () => {
    var result = handleSuggestionsResponse({ status: 'ZERO_RESULTS', predictions: [] });
    expect(result).toEqual([]);
  });

  it('OK with predictions → maps to AddressSuggestion array', () => {
    var result = handleSuggestionsResponse({
      status: 'OK',
      predictions: [
        {
          place_id: 'gp-001',
          description: 'Makati City, Metro Manila',
          structured_formatting: { main_text: 'Makati City', secondary_text: 'Metro Manila' },
          types: ['locality'],
        },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('gp-001');
    expect(result[0].primaryText).toBe('Makati City');
    expect(result[0].secondaryText).toBe('Metro Manila');
    expect(result[0].provider).toBe('google');
  });

  it('OK with more than 5 predictions → capped at 5', () => {
    var predictions = [1, 2, 3, 4, 5, 6, 7, 8].map(function (n) {
      return { place_id: 'p' + n, description: 'Place ' + n, structured_formatting: {}, types: [] };
    });
    var result = handleSuggestionsResponse({ status: 'OK', predictions: predictions });
    expect(result).toHaveLength(5);
  });

  it('INVALID_REQUEST → throws (not empty array)', () => {
    expect(function () {
      handleSuggestionsResponse({ status: 'INVALID_REQUEST' });
    }).toThrow('INVALID_REQUEST');
  });

  it('REQUEST_DENIED → throws with status in message', () => {
    expect(function () {
      handleSuggestionsResponse({ status: 'REQUEST_DENIED', error_message: 'API key invalid' });
    }).toThrow('REQUEST_DENIED');
  });

  it('OVER_QUERY_LIMIT → throws', () => {
    expect(function () {
      handleSuggestionsResponse({ status: 'OVER_QUERY_LIMIT' });
    }).toThrow('OVER_QUERY_LIMIT');
  });

  it('UNKNOWN_ERROR → throws', () => {
    expect(function () {
      handleSuggestionsResponse({ status: 'UNKNOWN_ERROR' });
    }).toThrow('UNKNOWN_ERROR');
  });

  it('missing status field treated as UNKNOWN_ERROR → throws', () => {
    expect(function () {
      handleSuggestionsResponse({ predictions: [] });
    }).toThrow();
  });
});

// ── resolveAddress — status code handling ─────────────────────────────────────

describe('resolveAddress — status code handling', () => {
  it('OK → returns result object', () => {
    var result = handleDetailsResponse({ status: 'OK', result: { name: 'SM Megamall' } });
    expect(result).not.toBeNull();
    expect(result.name).toBe('SM Megamall');
  });

  it('ZERO_RESULTS → returns null (place not found, not a 502)', () => {
    expect(handleDetailsResponse({ status: 'ZERO_RESULTS' })).toBeNull();
  });

  it('NOT_FOUND → returns null', () => {
    expect(handleDetailsResponse({ status: 'NOT_FOUND' })).toBeNull();
  });

  it('REQUEST_DENIED → throws (API key or billing issue)', () => {
    expect(function () {
      handleDetailsResponse({ status: 'REQUEST_DENIED', error_message: 'API key invalid' });
    }).toThrow('REQUEST_DENIED');
  });
});

// ── buildServanaLocationId ────────────────────────────────────────────────────

describe('buildServanaLocationId — mobile format contract', () => {
  it('produces loc_{lat}_{lon} with 6 decimal places', () => {
    expect(buildServanaLocationId(14.5547, 121.0244)).toBe('loc_14.554700_121.024400');
  });

  it('matches proto fixture format loc_14.557100_121.016900', () => {
    expect(buildServanaLocationId(14.557100, 121.016900)).toBe('loc_14.557100_121.016900');
  });

  it('always starts with loc_ prefix (mobile contract)', () => {
    var id = buildServanaLocationId(14.0, 121.0);
    expect(id.startsWith('loc_')).toBe(true);
    expect(id).toBe('loc_14.000000_121.000000');
  });
});

// ── extractAddressComponent ───────────────────────────────────────────────────

describe('extractAddressComponent — PH address parsing', () => {
  var components = [
    { types: ['street_number'], long_name: '123', short_name: '123' },
    { types: ['route'], long_name: 'Ayala Avenue', short_name: 'Ayala Ave' },
    { types: ['locality'], long_name: 'Makati City', short_name: 'Makati City' },
    { types: ['postal_code'], long_name: '1226', short_name: '1226' },
    { types: ['country'], long_name: 'Philippines', short_name: 'PH' },
  ];

  it('extracts locality for postTown (Makati City)', () => {
    expect(extractAddressComponent(components, ['locality', 'administrative_area_level_3'])).toBe('Makati City');
  });

  it('returns empty string for missing type', () => {
    expect(extractAddressComponent(components, ['subpremise'])).toBe('');
  });

  it('falls through to second type when first type missing (admin_area_level_3 fallback)', () => {
    var fallback = [{ types: ['administrative_area_level_3'], long_name: 'Pateros', short_name: 'Pateros' }];
    expect(extractAddressComponent(fallback, ['locality', 'administrative_area_level_3'])).toBe('Pateros');
  });

  it('useShortName=true returns short_name (country ISO code)', () => {
    // STITCH fix: country must return "PH" not "Philippines" for mobile parity
    expect(extractAddressComponent(components, ['country'], true)).toBe('PH');
  });

  it('useShortName=false (default) returns long_name', () => {
    expect(extractAddressComponent(components, ['locality'])).toBe('Makati City');
  });

  it('useShortName=true on route returns short abbreviation', () => {
    expect(extractAddressComponent(components, ['route'], true)).toBe('Ayala Ave');
  });
});
