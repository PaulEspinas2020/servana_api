/**
 * Address Search Service Tests — dual-type merge logic + status code handling
 * Run: npx jest tests/address-search.test.js
 *
 * Mirrors addressSearchService.ts logic in plain JS (same approach as other
 * test files) because ts-jest is not configured.
 *
 * Changes from previous version:
 *   - Dual-type merge logic: geocode + establishment parallel, deduplicate
 *   - Cap raised from 5 to 6 (MERGED_MAX_RESULTS)
 *   - fetchAutocompletePage returns {predictions, ok} — partial failures handled
 *   - Both-fail case throws (triggers 502 retry UI)
 */

// ── Re-implemented logic (mirrors addressSearchService.ts) ────────────────────

const GOOGLE_MAX_PREDICTIONS = 5;
const MERGED_MAX_RESULTS = 6;

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

// fetchAutocompletePage: returns {predictions, ok} — never throws
function handleAutocompleteResponse(respData) {
  var status = (respData && respData.status) ? respData.status : 'UNKNOWN_ERROR';
  if (status === 'ZERO_RESULTS') {
    return { predictions: [], ok: true };
  }
  if (status === 'OK') {
    var preds = (respData && respData.predictions) ? respData.predictions : [];
    return { predictions: preds.slice(0, GOOGLE_MAX_PREDICTIONS), ok: true };
  }
  // Non-OK status: partial failure — return ok:false, caller decides
  return { predictions: [], ok: false };
}

// Merge geocode + establishment results, deduplicate by place_id
function mergePredictions(geocodePreds, establishPreds) {
  var seenPlaceIds = {};
  var merged = [];
  var i, p, id;

  for (i = 0; i < geocodePreds.length; i++) {
    p = geocodePreds[i];
    id = p.place_id || '';
    if (id && !seenPlaceIds[id]) {
      seenPlaceIds[id] = true;
      merged.push(p);
    }
  }

  for (i = 0; i < establishPreds.length; i++) {
    p = establishPreds[i];
    id = p.place_id || '';
    if (id && !seenPlaceIds[id]) {
      seenPlaceIds[id] = true;
      merged.push(p);
    }
  }

  return merged.slice(0, MERGED_MAX_RESULTS);
}

function predictionToSuggestion(p) {
  var structured = p.structured_formatting || {};
  return {
    id: p.place_id || '',
    primaryText: structured.main_text || p.description || '',
    secondaryText: structured.secondary_text || '',
    fullText: p.description || '',
    types: p.types || [],
    provider: 'google',
  };
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

// ── fetchAutocompletePage — status code handling ──────────────────────────────

describe('fetchAutocompletePage (handleAutocompleteResponse) — status code handling', () => {
  it('ZERO_RESULTS → empty predictions, ok=true (not an error)', () => {
    var result = handleAutocompleteResponse({ status: 'ZERO_RESULTS', predictions: [] });
    expect(result.ok).toBe(true);
    expect(result.predictions).toEqual([]);
  });

  it('OK with predictions → mapped predictions, ok=true', () => {
    var result = handleAutocompleteResponse({
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
    expect(result.ok).toBe(true);
    expect(result.predictions).toHaveLength(1);
    expect(result.predictions[0].place_id).toBe('gp-001');
  });

  it('OK with more than 5 predictions → capped at 5 (per-page cap)', () => {
    var predictions = [1, 2, 3, 4, 5, 6, 7, 8].map(function (n) {
      return { place_id: 'p' + n, description: 'Place ' + n, structured_formatting: {}, types: [] };
    });
    var result = handleAutocompleteResponse({ status: 'OK', predictions: predictions });
    expect(result.ok).toBe(true);
    expect(result.predictions).toHaveLength(5);
  });

  it('INVALID_REQUEST → ok=false, empty predictions (partial failure — not thrown)', () => {
    var result = handleAutocompleteResponse({ status: 'INVALID_REQUEST' });
    expect(result.ok).toBe(false);
    expect(result.predictions).toEqual([]);
  });

  it('REQUEST_DENIED → ok=false (API key issue, non-throw so other call can succeed)', () => {
    var result = handleAutocompleteResponse({ status: 'REQUEST_DENIED', error_message: 'API key invalid' });
    expect(result.ok).toBe(false);
    expect(result.predictions).toEqual([]);
  });

  it('OVER_QUERY_LIMIT → ok=false', () => {
    var result = handleAutocompleteResponse({ status: 'OVER_QUERY_LIMIT' });
    expect(result.ok).toBe(false);
  });

  it('UNKNOWN_ERROR → ok=false', () => {
    var result = handleAutocompleteResponse({ status: 'UNKNOWN_ERROR' });
    expect(result.ok).toBe(false);
  });
});

// ── mergePredictions — dual-type merge logic ──────────────────────────────────

describe('mergePredictions — geocode + establishment merge', () => {
  var STREET = { place_id: 'street-001', description: '12 Mabini Street, Makati', structured_formatting: { main_text: '12 Mabini Street', secondary_text: 'Makati City' }, types: ['route'] };
  var BUILDING = { place_id: 'bldg-001', description: 'Avida Towers, Makati', structured_formatting: { main_text: 'Avida Towers', secondary_text: 'Makati City' }, types: ['premise'] };
  var CONDO = { place_id: 'condo-001', description: 'SMDC Light Residences, Mandaluyong', structured_formatting: { main_text: 'SMDC Light Residences', secondary_text: 'Mandaluyong City' }, types: ['establishment'] };

  it('geocode results come first in merged output', () => {
    var merged = mergePredictions([STREET], [CONDO]);
    expect(merged[0].place_id).toBe('street-001');
    expect(merged[1].place_id).toBe('condo-001');
  });

  it('deduplicates by place_id — same place in both calls appears once', () => {
    var merged = mergePredictions([BUILDING], [BUILDING]);
    expect(merged).toHaveLength(1);
    expect(merged[0].place_id).toBe('bldg-001');
  });

  it('establishment-only results are appended after geocode results', () => {
    var merged = mergePredictions([STREET], [CONDO]);
    expect(merged).toHaveLength(2);
    expect(merged[0].place_id).toBe('street-001');
    expect(merged[1].place_id).toBe('condo-001');
  });

  it('empty geocode, establishment results → establishment shown', () => {
    var merged = mergePredictions([], [CONDO]);
    expect(merged).toHaveLength(1);
    expect(merged[0].place_id).toBe('condo-001');
  });

  it('empty establishment, geocode results → geocode shown', () => {
    var merged = mergePredictions([STREET], []);
    expect(merged).toHaveLength(1);
    expect(merged[0].place_id).toBe('street-001');
  });

  it('merged result capped at MERGED_MAX_RESULTS (6)', () => {
    var geocodePreds = [1, 2, 3, 4, 5].map(function (n) {
      return { place_id: 'g' + n, description: 'G' + n, structured_formatting: {}, types: [] };
    });
    var establishPreds = [6, 7, 8, 9, 10].map(function (n) {
      return { place_id: 'e' + n, description: 'E' + n, structured_formatting: {}, types: [] };
    });
    var merged = mergePredictions(geocodePreds, establishPreds);
    expect(merged).toHaveLength(6);
  });

  it('both empty → empty merged result (not an error at this layer)', () => {
    var merged = mergePredictions([], []);
    expect(merged).toEqual([]);
  });
});

// ── predictionToSuggestion — mapping ─────────────────────────────────────────

describe('predictionToSuggestion — prediction → AddressSuggestion', () => {
  it('maps structured_formatting primary/secondary text', () => {
    var p = {
      place_id: 'gp-001',
      description: 'Makati City, Metro Manila',
      structured_formatting: { main_text: 'Makati City', secondary_text: 'Metro Manila' },
      types: ['locality'],
    };
    var s = predictionToSuggestion(p);
    expect(s.id).toBe('gp-001');
    expect(s.primaryText).toBe('Makati City');
    expect(s.secondaryText).toBe('Metro Manila');
    expect(s.fullText).toBe('Makati City, Metro Manila');
    expect(s.provider).toBe('google');
  });

  it('falls back to description when structured_formatting is missing', () => {
    var p = { place_id: 'gp-002', description: 'BGC Tower, Taguig', structured_formatting: {}, types: [] };
    var s = predictionToSuggestion(p);
    expect(s.primaryText).toBe('BGC Tower, Taguig');
    expect(s.secondaryText).toBe('');
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

  it('UNKNOWN_ERROR → throws', () => {
    expect(function () {
      handleDetailsResponse({ status: 'UNKNOWN_ERROR' });
    }).toThrow('UNKNOWN_ERROR');
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
    expect(extractAddressComponent(components, ['country'], true)).toBe('PH');
  });

  it('useShortName=false (default) returns long_name', () => {
    expect(extractAddressComponent(components, ['locality'])).toBe('Makati City');
  });

  it('useShortName=true on route returns short abbreviation', () => {
    expect(extractAddressComponent(components, ['route'], true)).toBe('Ayala Ave');
  });
});
