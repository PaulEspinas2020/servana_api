/**
 * SW-13 / SW-05 — reading coordinates out of `location_id` without guessing.
 *
 * The column is not clean: production `user_address` row `CAD-26-940687` holds
 * `ChIJ8T1GpMGzljMRq2q5T1u7I0w`, a raw Google place id. These values become a
 * map pin labelled as the customer's address, so a lenient parser puts a
 * provider at the wrong door. Every rejection is null, and null is a state the
 * UI has to render honestly — for some rows it is simply the truth.
 */
import fs from 'fs';
import path from 'path';

import {
  coordinatesForAddress,
  formatServanaLocationId,
  parseServanaLocationId,
} from '../src/helpers/servanaLocationId';

describe('the canonical format, round-tripped', () => {
  it('formats to §42 exactly — six decimal places, always', () => {
    expect(formatServanaLocationId(14.562312, 121.01954)).toBe(
      'loc_14.562312_121.019540',
    );
    expect(formatServanaLocationId(14, 121)).toBe('loc_14.000000_121.000000');
  });

  it('round-trips a real production value', () => {
    // servana.user_address CAD-26-965525, "129 Malugay", Makati.
    const id = 'loc_14.562312_121.019540';
    expect(parseServanaLocationId(id)).toEqual({ lat: 14.562312, lng: 121.01954 });
    expect(formatServanaLocationId(14.562312, 121.01954)).toBe(id);
  });

  it('reads every other real production value', () => {
    const rows: Array<[string, number, number]> = [
      ['loc_14.625197_120.977759', 14.625197, 120.977759],
      ['loc_14.743366_121.143569', 14.743366, 121.143569],
      ['loc_14.580977_121.033760', 14.580977, 121.03376],
      ['loc_14.640149_121.025783', 14.640149, 121.025783],
    ];
    for (const [id, lat, lng] of rows) {
      expect(parseServanaLocationId(id)).toEqual({ lat, lng });
    }
  });
});

describe('SW-13 — the row that is not a location id', () => {
  it('rejects the Google place id sitting in production today', () => {
    expect(parseServanaLocationId('ChIJ8T1GpMGzljMRq2q5T1u7I0w')).toBeNull();
  });

  it('rejects place ids generally, not just that one', () => {
    for (const v of [
      'ChIJN1t_tDeuEmsRUsoyG83frY4',
      'EiQxMjMgTWFpbiBTdCwgTWFrYXRp',
      'place_id:ChIJ8T1GpMGzljMRq2q5T1u7I0w',
    ]) {
      expect(parseServanaLocationId(v)).toBeNull();
    }
  });
});

describe('nothing malformed becomes a pin', () => {
  it('rejects non-strings and empties', () => {
    for (const v of [null, undefined, 42, {}, [], '', '   ', true]) {
      expect(parseServanaLocationId(v)).toBeNull();
    }
  });

  it('rejects the wrong shape', () => {
    for (const v of [
      'loc_14.562312',
      'loc__121.019540',
      'loc_14.562312_121.019540_extra',
      '14.562312_121.019540',
      'LOC_14.562312_121.019540',
      'loc_abc_def',
      'loc_14.562312_121.019540;DROP TABLE',
    ]) {
      expect(parseServanaLocationId(v)).toBeNull();
    }
  });

  it('rejects coordinates outside the possible range', () => {
    expect(parseServanaLocationId('loc_91.000000_121.000000')).toBeNull();
    expect(parseServanaLocationId('loc_14.000000_181.000000')).toBeNull();
    expect(parseServanaLocationId('loc_-91.000000_0.500000')).toBeNull();
  });

  it('rejects null island', () => {
    // 0/0 is what an unset pair looks like after a formatter has been at it,
    // and it is in the Gulf of Guinea.
    expect(parseServanaLocationId('loc_0.000000_0.000000')).toBeNull();
    expect(coordinatesForAddress({ lat: 0, lng: 0 })).toBeNull();
  });

  it('tolerates surrounding whitespace, which a text column collects', () => {
    expect(parseServanaLocationId('  loc_14.562312_121.019540  ')).toEqual({
      lat: 14.562312,
      lng: 121.01954,
    });
  });
});

describe('coordinatesForAddress — the id wins, the JSONB is the fallback', () => {
  it('prefers the canonical id', () => {
    expect(
      coordinatesForAddress({
        locationId: 'loc_14.562312_121.019540',
        lat: '1.0',
        lng: '2.0',
      }),
    ).toEqual({ lat: 14.562312, lng: 121.01954 });
  });

  it('falls back to service_address lat/lon for admin-created bookings', () => {
    // Those rows have no user_address at all, so the id is absent, not wrong.
    expect(
      coordinatesForAddress({ locationId: null, lat: '14.5995', lng: '120.9842' }),
    ).toEqual({ lat: 14.5995, lng: 120.9842 });
  });

  it('falls back when the id is the place-id row', () => {
    // SW-13 in combination: a bad id must not shadow good coordinates.
    expect(
      coordinatesForAddress({
        locationId: 'ChIJ8T1GpMGzljMRq2q5T1u7I0w',
        lat: '14.5547',
        lng: '121.0244',
      }),
    ).toEqual({ lat: 14.5547, lng: 121.0244 });
  });

  it('returns null when neither source has anything usable', () => {
    expect(coordinatesForAddress({})).toBeNull();
    expect(
      coordinatesForAddress({ locationId: 'ChIJ8T1GpMGzljMRq2q5T1u7I0w' }),
    ).toBeNull();
    expect(coordinatesForAddress({ lat: 'north', lng: 'east' })).toBeNull();
  });
});

describe('SW-05 — the job card releases a pin only at full disclosure', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/controllers/jobCardView.ts'),
    'utf8',
  );

  it('computes coordinates behind the fullDisclosure gate', () => {
    expect(src).toMatch(/const coords = fullDisclosure[\s\S]{0,300}?: null;/);
  });

  it('sends null coordinates on every non-operational branch', () => {
    // ASSIGNED and DECLINED both. A precise pin IS the street address, so
    // sending it early hands over what the text deliberately withholds.
    const addressBlock = src.slice(
      src.indexOf('const address = fullDisclosure'),
      src.indexOf('return {'),
    );
    const branches = addressBlock.split('addressOne:');
    // Three branches: full, relinquished, pre-acceptance.
    expect(branches.length).toBe(4);
    expect(branches[2]).toContain('lat: null');
    expect(branches[3]).toContain('lat: null');
  });

  it('keeps the keys present on every branch, so no consumer shape changes', () => {
    const addressBlock = src.slice(
      src.indexOf('const address = fullDisclosure'),
      src.indexOf('return {'),
    );
    expect((addressBlock.match(/lat:/g) ?? []).length).toBe(3);
    expect((addressBlock.match(/lng:/g) ?? []).length).toBe(3);
  });

  it('selects both coordinate sources in the job-cards query', () => {
    const svc = fs.readFileSync(
      path.join(__dirname, '../src/services/technicianService.ts'),
      'utf8',
    );
    const query = svc.slice(svc.indexOf('export const getJobCardsByWorker'));
    expect(query).toContain('ua.location_id');
    expect(query).toContain("b.service_address->>'lat' AS service_address_lat");
    expect(query).toContain("b.service_address->>'lon' AS service_address_lon");
  });
});
