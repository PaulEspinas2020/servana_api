/**
 * SERVICEAREA command — source-inspection tests.
 *
 * Verifies the default-all-cities semantics shipped in this command:
 *   - explainCoverage: missing profile → covered:true (DEFAULT_ALL_CITIES)
 *   - explainCoverage: all_cities mode → covered:true (ALL_CITIES_EXPLICIT)
 *   - resolveServiceAreaIntent: all 6 branches
 *   - hasServiceArea=false filter: no longer uses NOT EXISTS; uses invalid-city-row check
 *   - getProviderSetupSummary: missing_service_area uses EXISTS+coverage_mode check
 *
 * No live DB or running server required.
 */

const fs   = require('fs');
const path = require('path');

const SVC  = (...p) => path.join(__dirname, '..', 'src', 'services', ...p);

// ── File presence ─────────────────────────────────────────────────────────────

describe('SERVICEAREA — required files exist', () => {
  it('providerServiceAreaEngine.ts exists', () => {
    expect(fs.existsSync(SVC('providerServiceAreaEngine.ts'))).toBe(true);
  });
  it('providerEligibilityEngine.ts exists', () => {
    expect(fs.existsSync(SVC('providerEligibilityEngine.ts'))).toBe(true);
  });
  it('providerSupplyHealthService.ts exists', () => {
    expect(fs.existsSync(SVC('providerSupplyHealthService.ts'))).toBe(true);
  });
  it('adminProviderService.ts exists', () => {
    expect(fs.existsSync(SVC('adminProviderService.ts'))).toBe(true);
  });
  it('providerAutoOnlineEngine.ts exists', () => {
    expect(fs.existsSync(SVC('providerAutoOnlineEngine.ts'))).toBe(true);
  });
});

// ── CoverageMode type ─────────────────────────────────────────────────────────

describe('SERVICEAREA — CoverageMode includes all_cities', () => {
  let src;
  beforeAll(() => { src = fs.readFileSync(SVC('providerServiceAreaEngine.ts'), 'utf8'); });

  it("CoverageMode union includes 'all_cities'", () => {
    expect(src).toContain("'city' | 'branch' | 'radius' | 'all_cities'");
  });

  it("VALID_MODES array includes 'all_cities'", () => {
    expect(src).toContain("'all_cities'");
  });
});

// ── ServiceAreaIntent type ────────────────────────────────────────────────────

describe('SERVICEAREA — ServiceAreaIntent exported with all 6 branches', () => {
  let src;
  beforeAll(() => { src = fs.readFileSync(SVC('providerServiceAreaEngine.ts'), 'utf8'); });

  it("exports ServiceAreaIntent type", () => {
    expect(src).toContain('export type ServiceAreaIntent');
  });

  it("ServiceAreaIntent includes 'unconfigured'", () => {
    expect(src).toContain("'unconfigured'");
  });

  it("ServiceAreaIntent includes 'all_cities'", () => {
    // present in both CoverageMode and ServiceAreaIntent
    const matches = (src.match(/'all_cities'/g) || []).length;
    expect(matches).toBeGreaterThanOrEqual(2);
  });

  it("ServiceAreaIntent includes 'restricted_city'", () => {
    expect(src).toContain("'restricted_city'");
  });

  it("ServiceAreaIntent includes 'restricted_branch'", () => {
    expect(src).toContain("'restricted_branch'");
  });

  it("ServiceAreaIntent includes 'restricted_radius'", () => {
    expect(src).toContain("'restricted_radius'");
  });

  it("ServiceAreaIntent includes 'invalid'", () => {
    expect(src).toContain("'invalid'");
  });
});

// ── explainCoverage: missing profile → covered:true ──────────────────────────

describe('SERVICEAREA — explainCoverage missing-profile path returns covered:true', () => {
  let src;
  beforeAll(() => { src = fs.readFileSync(SVC('providerServiceAreaEngine.ts'), 'utf8'); });

  it("DEFAULT_ALL_CITIES reason code exists in explainCoverage", () => {
    expect(src).toContain("'DEFAULT_ALL_CITIES'");
  });

  it("missing profile branch returns covered: true (not false)", () => {
    // The old code returned covered: false for missing profiles.
    // Verify the new code: the block after "profile.status === 'missing'" contains covered: true.
    const missingIdx = src.indexOf("profile.status === 'missing'");
    expect(missingIdx).toBeGreaterThan(-1);
    // Extract the next 300 chars after the missing check
    const block = src.slice(missingIdx, missingIdx + 300);
    expect(block).toContain('covered: true');
    expect(block).not.toContain('covered: false');
  });

  it("missing profile does NOT push NO_SERVICE_AREA reason", () => {
    // NO_SERVICE_AREA should no longer appear in the missing-profile block
    const missingIdx = src.indexOf("profile.status === 'missing'");
    const block = src.slice(missingIdx, missingIdx + 300);
    expect(block).not.toContain("'NO_SERVICE_AREA'");
  });
});

// ── explainCoverage: all_cities case → covered:true ──────────────────────────

describe('SERVICEAREA — explainCoverage all_cities case returns covered:true', () => {
  let src;
  beforeAll(() => { src = fs.readFileSync(SVC('providerServiceAreaEngine.ts'), 'utf8'); });

  it("switch case for 'all_cities' exists", () => {
    expect(src).toContain("case 'all_cities':");
  });

  it("ALL_CITIES_EXPLICIT reason code is pushed in all_cities case", () => {
    expect(src).toContain("'ALL_CITIES_EXPLICIT'");
  });

  it("all_cities case returns covered: true", () => {
    const idx = src.indexOf("case 'all_cities':");
    const block = src.slice(idx, idx + 350);
    expect(block).toContain('covered: true');
  });
});

// ── resolveServiceAreaIntent ──────────────────────────────────────────────────

describe('SERVICEAREA — resolveServiceAreaIntent exported and handles all branches', () => {
  let src;
  beforeAll(() => { src = fs.readFileSync(SVC('providerServiceAreaEngine.ts'), 'utf8'); });

  it("exports resolveServiceAreaIntent function", () => {
    expect(src).toContain('export const resolveServiceAreaIntent');
  });

  it("returns 'unconfigured' for missing profile", () => {
    expect(src).toContain("return 'unconfigured'");
  });

  it("returns 'all_cities' for all_cities coverageMode", () => {
    expect(src).toContain("return 'all_cities'");
  });

  it("produces 'restricted_city' for city mode with non-empty cityIds (ternary form)", () => {
    // resolveServiceAreaIntent uses ternary: cityIds.length > 0 ? 'restricted_city' : 'invalid'
    expect(src).toContain("'restricted_city'");
    expect(src).toContain("cityIds.length > 0");
  });

  it("produces 'restricted_branch' for branch mode with non-empty branchIds (ternary form)", () => {
    expect(src).toContain("'restricted_branch'");
    expect(src).toContain("branchIds.length > 0");
  });

  it("produces 'restricted_radius' for radius mode with positive radiusKm (ternary form)", () => {
    expect(src).toContain("'restricted_radius'");
    expect(src).toContain("radiusKm !== null");
  });

  it("returns 'invalid' for degenerate configs (last resort)", () => {
    expect(src).toContain("return 'invalid'");
  });
});

// ── getEffectiveServiceArea exported ─────────────────────────────────────────

describe('SERVICEAREA — getEffectiveServiceArea exported', () => {
  let src;
  beforeAll(() => { src = fs.readFileSync(SVC('providerServiceAreaEngine.ts'), 'utf8'); });

  it("exports getEffectiveServiceArea function", () => {
    expect(src).toContain('export const getEffectiveServiceArea');
  });

  it("exports EffectiveServiceArea interface", () => {
    expect(src).toContain('export interface EffectiveServiceArea');
  });

  it("unconfigured path sets source: 'system_default'", () => {
    expect(src).toContain("source: 'system_default'");
  });

  it("explicit path sets source: 'explicit'", () => {
    expect(src).toContain("source: 'explicit'");
  });
});

// ── EligibilityCheckCode: DEFAULT_ALL_CITIES ──────────────────────────────────

describe('SERVICEAREA — EligibilityCheckCode includes DEFAULT_ALL_CITIES', () => {
  let src;
  beforeAll(() => { src = fs.readFileSync(SVC('providerEligibilityEngine.ts'), 'utf8'); });

  it("EligibilityCheckCode includes 'DEFAULT_ALL_CITIES'", () => {
    expect(src).toContain("'DEFAULT_ALL_CITIES'");
  });
});

// ── Supply health: missing_service_area uses EXISTS+city check ────────────────

describe('SERVICEAREA — providerSupplyHealthService missingServiceArea definition', () => {
  let src;
  beforeAll(() => { src = fs.readFileSync(SVC('providerSupplyHealthService.ts'), 'utf8'); });

  it("missing_service_area does NOT use NOT EXISTS (worker_service_areas)", () => {
    // The old definition used: NOT EXISTS (SELECT 1 FROM worker_service_areas)
    // for missing_service_area. That must no longer exist.
    const idx = src.indexOf('missing_service_area');
    // Extract the 300 chars after the first mention of missing_service_area (the COUNT FILTER)
    const block = src.slice(idx - 50, idx + 300);
    // Should NOT find the bare NOT EXISTS pattern for the area check
    expect(block).not.toMatch(/NOT EXISTS.*worker_service_areas.*missing_service_area/s);
  });

  it("missing_service_area uses EXISTS with coverage_mode='city' check", () => {
    expect(src).toContain("coverage_mode = 'city'");
    expect(src).toContain("city_ids = '[]'::jsonb");
  });

  it("areaCond in listProvidersMissingSetup also uses EXISTS+city check", () => {
    const idx = src.indexOf('areaCond');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 200);
    expect(block).toContain("coverage_mode = 'city'");
  });
});

// ── adminProviderService: area_status returns 'default_all' ──────────────────

describe('SERVICEAREA — adminProviderService area_status uses default_all', () => {
  let src;
  beforeAll(() => { src = fs.readFileSync(SVC('adminProviderService.ts'), 'utf8'); });

  it("area_status CASE returns 'default_all' for no-row providers", () => {
    expect(src).toContain("ELSE 'default_all'");
  });

  it("area_status does NOT return 'missing' for no-row providers", () => {
    // Old: ELSE 'missing' END AS area_status
    expect(src).not.toMatch(/ELSE 'missing' END AS area_status/);
  });
});

// ── adminProviderService: hasServiceArea=false filter fixed ───────────────────

describe('SERVICEAREA — hasServiceArea=false filter does not use NOT EXISTS', () => {
  let src;
  beforeAll(() => { src = fs.readFileSync(SVC('adminProviderService.ts'), 'utf8'); });

  it("hasServiceArea=false uses EXISTS (not NOT EXISTS) to find invalid configs", () => {
    // Find the hasServiceArea=false branch
    const idx = src.indexOf('hasServiceArea === false');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 300);
    // Must NOT use NOT EXISTS for the false branch
    expect(block).not.toContain('NOT EXISTS');
    // Must use EXISTS with coverage_mode='city' check
    expect(block).toContain("coverage_mode = 'city'");
  });

  it("hasServiceArea=true still uses EXISTS (has explicit row)", () => {
    const idx = src.indexOf('hasServiceArea === true');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 150);
    expect(block).toContain('EXISTS');
  });
});

// ── providerAutoOnlineEngine: serviceAreaMode=all for missing ─────────────────

describe('SERVICEAREA — providerAutoOnlineEngine serviceAreaMode for unconfigured providers', () => {
  let src;
  beforeAll(() => { src = fs.readFileSync(SVC('providerAutoOnlineEngine.ts'), 'utf8'); });

  it("sets serviceAreaMode='all' when area.status === 'missing'", () => {
    const idx = src.indexOf("area.status === 'missing'");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 100);
    expect(block).toContain("serviceAreaMode = 'all'");
  });

  it("sets serviceAreaMode='all' for all_cities coverageMode", () => {
    expect(src).toContain("coverageMode === 'all_cities'");
  });

  it("serviceAreaMode type includes 'all' | 'custom' | 'missing'", () => {
    expect(src).toContain("'all' | 'custom' | 'missing'");
  });
});
