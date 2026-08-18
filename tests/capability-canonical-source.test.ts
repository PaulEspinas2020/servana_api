/**
 * `catalog_provider_services` is the capability source. The legacy family
 * grants are a fallback with a counter on it.
 *
 * ## The gate this closes
 *
 * The Master Command names
 * `catalog_provider_services.service_id -> services.id` as canonical provider
 * capability truth. It was not adopted, for a reason that was real: the table
 * had been backfilled once during the Catalog V2 cutover and then nothing ever
 * wrote it again, so reading it alone would have quietly unassigned every
 * provider granted since.
 *
 * Adoption therefore has four parts, and this suite holds all four:
 *
 *   1. the canonical table is asked FIRST, on the right id space;
 *   2. the legacy grant still answers when the canonical row is missing, and
 *      that fallback is COUNTED rather than silent;
 *   3. every capability-change writer projects canonically, so the gap stops
 *      growing;
 *   4. the backfill and the parity guard refuse to certify a state where
 *      removing the fallback would drop supply.
 */

import fs from 'fs';
import path from 'path';

import {
  classifyCapabilityRows,
  recordCapabilityDecision,
  capabilityAdoptionReport,
  resetCapabilityAdoptionCounters,
  CANONICAL_ADOPTION_CRITERIA,
  LEGACY_GRANT_NAMES,
} from '../src/services/booking/capabilitySource';
import {
  projectFamilyGrant,
  setFamilyGrantStatus,
  projectFamilyGrantSafely,
  setFamilyGrantStatusSafely,
  CAPABILITY_PARITY_SQL,
  readParityRow,
  supplyCollapseVerdict,
} from '../src/services/booking/capabilityProjection';

const ROOT = path.join(__dirname, '..');

const readFile = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const codeOf = (rel: string): string => readFile(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// ─── 1. Classification ────────────────────────────────────────────────────────

describe('a capability answer says WHICH source it came from', () => {
  beforeEach(resetCapabilityAdoptionCounters);

  it('reports canonical when the canonical table answered', () => {
    const d = classifyCapabilityRows([{ source: 'CANONICAL' }]);
    expect(d).toMatchObject({ qualified: true, canonical: true, legacyOnly: false });
    expect(d.sources).toEqual(['CANONICAL']);
  });

  it('reports legacyOnly when ONLY a family grant answered', () => {
    // The adoption gap, one decision at a time: every one of these is a
    // canonical row that should exist and does not.
    const d = classifyCapabilityRows([{ source: 'LEGACY_EMPLOYEE_SERVICE' }]);
    expect(d).toMatchObject({ qualified: true, canonical: false, legacyOnly: true });
  });

  it('is not legacyOnly when both answered', () => {
    const d = classifyCapabilityRows([
      { source: 'LEGACY_EMPLOYEE_SERVICE' }, { source: 'CANONICAL' },
    ]);
    expect(d).toMatchObject({ canonical: true, legacyOnly: false });
    // Declaration order, not row order: the report reads the same either way.
    expect(d.sources).toEqual(['CANONICAL', 'LEGACY_EMPLOYEE_SERVICE']);
  });

  it('is unqualified only when nothing answered', () => {
    expect(classifyCapabilityRows([])).toMatchObject({
      qualified: false, canonical: false, legacyOnly: false,
    });
  });

  it('still qualifies on a source it has never been taught', () => {
    /**
     * A row came back: the predicate found a grant this classifier does not
     * know about. Calling that unqualified would make adding a fourth source
     * silently NARROW the assignable pool — the failure mode of the whole tab.
     */
    const d = classifyCapabilityRows([{ source: 'SOME_FUTURE_SOURCE' }]);
    expect(d.qualified).toBe(true);
    expect(d.canonical).toBe(false);
    expect(d.sources).toEqual([]);
  });

  it('ignores a row with no source rather than crashing on it', () => {
    expect(classifyCapabilityRows([{}, { source: '' }]).qualified).toBe(true);
  });
});

// ─── 2. The adoption counter ──────────────────────────────────────────────────

describe('the fallback is counted, so it can be retired on evidence', () => {
  beforeEach(resetCapabilityAdoptionCounters);

  it('separates canonical answers from fallback answers', () => {
    recordCapabilityDecision(classifyCapabilityRows([{ source: 'CANONICAL' }]));
    recordCapabilityDecision(classifyCapabilityRows([{ source: 'LEGACY_EMPLOYEE_SERVICE' }]),
      { canonicalServiceId: 55, legacyFamilyId: 7 });
    recordCapabilityDecision(classifyCapabilityRows([]));

    expect(capabilityAdoptionReport()).toMatchObject({
      qualified: 2, canonical: 1, legacyOnly: 1, unqualified: 1,
    });
  });

  it('records the SERVICE that fell back, never the provider', () => {
    /**
     * §58 applies to telemetry exactly as it applies to a response. A log
     * naming which provider is missing a canonical row is a log that has to be
     * protected like the data it describes — and the service id is enough to
     * find the gap and fix it with the reconciler.
     */
    recordCapabilityDecision(
      classifyCapabilityRows([{ source: 'LEGACY_APPROVED_APPLICATION' }]),
      { canonicalServiceId: 55, legacyFamilyId: 7 },
    );
    const report = capabilityAdoptionReport();
    expect(report.legacyOnlyServices).toEqual(['service:55/family:7']);
    expect(JSON.stringify(report)).not.toMatch(/uid|provider-/i);
  });

  it('caps the distinct-service list rather than growing without bound', () => {
    for (let i = 0; i < 200; i += 1) {
      recordCapabilityDecision(
        classifyCapabilityRows([{ source: 'LEGACY_EMPLOYEE_SERVICE' }]),
        { canonicalServiceId: i, legacyFamilyId: 1 },
      );
    }
    const report = capabilityAdoptionReport();
    expect(report.legacyOnly).toBe(200);          // the count is exact
    expect(report.legacyOnlyServices).toHaveLength(50);  // the list is bounded
  });

  it('never throws, whatever it is handed', () => {
    // This sits inside the assignment commit path. A telemetry bug there would
    // be an outage rather than a missing log line.
    expect(() => recordCapabilityDecision(
      undefined as never, undefined as never,
    )).not.toThrow();
  });

  it('states retirement criteria that are measurements, not promises', () => {
    expect(CANONICAL_ADOPTION_CRITERIA.zeroFallbackDays).toBeGreaterThan(0);
    expect(CANONICAL_ADOPTION_CRITERIA.requireParityClean).toBe(true);
    expect(CANONICAL_ADOPTION_CRITERIA.requireAllWritersProject).toBe(true);
    expect(LEGACY_GRANT_NAMES).toEqual(
      ['LEGACY_EMPLOYEE_SERVICE', 'LEGACY_APPROVED_APPLICATION'],
    );
  });
});

// ─── 3. The projection writer ─────────────────────────────────────────────────

describe('projecting a family grant to the canonical grain', () => {
  const capture = () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const exec = async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rowCount: 3 };
    };
    return { calls, exec };
  };

  it('fans a FAMILY grant out to every bookable service under it', () => {
    const { calls, exec } = capture();
    return projectFamilyGrant(exec, 'servana', {
      providerUid: 'p1', familyId: 7, origin: 'application_approved',
    }).then((written) => {
      expect(written).toBe(3);
      const { sql, params } = calls[0];
      // INSERT ... SELECT from services, not a single-row insert: one family
      // approval already implies every service under it.
      expect(sql).toContain('INSERT INTO servana.catalog_provider_services');
      expect(sql).toContain('FROM servana.services s');
      expect(sql).toContain('s.legacy_service_family_id = $2');
      expect(params).toEqual(['p1', 7, 'active', 'application_approved']);
    });
  });

  it('REVIVES an archived row instead of skipping it', () => {
    /**
     * `ON CONFLICT DO NOTHING` would leave a previously revoked provider
     * archived after a re-approval — assignable in the legacy table, refused
     * canonically, silently. DO UPDATE is the difference between idempotent
     * and inert.
     */
    const { calls, exec } = capture();
    return projectFamilyGrant(exec, 'servana', {
      providerUid: 'p1', familyId: 7, origin: 'admin_grant',
    }).then(() => {
      expect(calls[0].sql).toContain('ON CONFLICT (provider_uid, service_id) DO UPDATE');
      expect(calls[0].sql).toContain('status     = EXCLUDED.status');
      expect(calls[0].sql).not.toContain('DO NOTHING');
    });
  });

  it('stamps the provenance so the projection can be reversed by family', () => {
    const { calls, exec } = capture();
    return projectFamilyGrant(exec, 'servana', {
      providerUid: 'p1', familyId: 7, origin: 'migrated_from_family',
    }).then(() => {
      expect(calls[0].sql).toContain('legacy_service_family_id');
    });
  });

  it('archives on revoke rather than deleting', () => {
    /**
     * A deleted row cannot answer "was this provider ever approved for that
     * service, and when did it stop" — the question a payout dispute asks.
     */
    const { calls, exec } = capture();
    return setFamilyGrantStatus(exec, 'servana', {
      providerUid: 'p1', familyId: 7, status: 'archived',
    }).then(() => {
      expect(calls[0].sql).toContain('UPDATE servana.catalog_provider_services');
      expect(calls[0].sql).not.toContain('DELETE');
      expect(calls[0].sql).toContain('legacy_service_family_id = $2');
      expect(calls[0].params).toEqual(['p1', 7, 'archived']);
    });
  });

  it('scopes a status change to the family it came from', () => {
    // A service the provider also holds through another family, or through a
    // direct admin grant, must not be swept up by a revoke.
    const { calls, exec } = capture();
    return setFamilyGrantStatus(exec, 'servana', {
      providerUid: 'p1', familyId: 7, status: 'paused',
    }).then(() => {
      expect(calls[0].sql).toContain('WHERE provider_uid = $1');
      expect(calls[0].sql).toContain('AND legacy_service_family_id = $2');
    });
  });

  it('the SAFE wrappers swallow a failure and say so', async () => {
    /**
     * On a path with no transaction, failing a provider's approval because a
     * projection statement errored would be worse than the drift it prevents:
     * the matcher still falls back to the legacy grant, so the provider stays
     * assignable, and the reconciler closes the gap.
     */
    const boom = async () => { throw new Error('projection exploded'); };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(projectFamilyGrantSafely(boom, 'servana', {
        providerUid: 'p1', familyId: 7, origin: 'admin_grant',
      })).resolves.toBeNull();
      await expect(setFamilyGrantStatusSafely(boom, 'servana', {
        providerUid: 'p1', familyId: 7, status: 'archived',
      })).resolves.toBeNull();
      expect(spy).toHaveBeenCalledTimes(2);
      // Logged with the family, never the uid.
      expect(String(spy.mock.calls[0][0])).toContain('family 7');
      expect(String(spy.mock.calls[0][0])).not.toContain('p1');
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── 4. Every writer projects ─────────────────────────────────────────────────

describe('every capability-change path keeps the canonical table current', () => {
  /**
   * The gap this closes is not hypothetical: the table was backfilled once in
   * the Catalog V2 cutover and then nothing wrote it for the rest of its life,
   * so every grant made afterwards existed only in the legacy tables.
   *
   * Each entry is a writer and the projection it must make. A new writer added
   * without one fails here rather than in production, months later, as a
   * provider who cannot be found.
   */
  const WRITERS: Array<{ file: string; fn: string; projects: string }> = [
    { file: 'services/serviceApplicationService.ts', fn: 'decideApplication (approve)', projects: 'projectFamilyGrant' },
    { file: 'services/serviceApplicationService.ts', fn: 'approveApplication', projects: 'projectFamilyGrantSafely' },
    { file: 'services/technicianService.ts', fn: 'assignServicesToEmployee', projects: 'projectFamilyGrantSafely' },
    { file: 'services/technicianService.ts', fn: 'removeServiceFromEmployee', projects: 'setFamilyGrantStatusSafely' },
    { file: 'services/technicianService.ts', fn: 'pauseService / reactivateService', projects: 'setFamilyGrantStatusSafely' },
  ];

  it.each([...new Set(WRITERS.map((w) => w.file))])(
    '%s imports the shared projection rather than writing the table itself',
    (file) => {
      const code = codeOf(`src/${file}`);
      // Either quote style — technicianService uses double quotes throughout.
      expect(code).toMatch(/from ['"]\.\/booking\/capabilityProjection['"]/);
      // No hand-written INSERT into the canonical table anywhere else: five
      // hand-rolled projections would be five status vocabularies.
      expect(code).not.toMatch(/INSERT INTO \$\{dbSchema\}\.catalog_provider_services/);
    },
  );

  it.each(WRITERS)('$fn projects via $projects', ({ file, projects }) => {
    expect(codeOf(`src/${file}`)).toContain(projects);
  });

  it('the approval path that OWNS a transaction projects inside it', () => {
    /**
     * `decideApplication` already holds a client. Projecting through it means
     * the two capability records cannot disagree: either the provider is
     * approved in both tables or in neither.
     */
    const code = codeOf('src/services/serviceApplicationService.ts');
    const approveBlock = code.slice(
      code.indexOf('INSERT INTO ${dbSchema}.employee_services'),
      code.indexOf("SET status = 'approved'"),
    );
    expect(approveBlock).toContain('projectFamilyGrant(');
    expect(approveBlock).toContain('client.query');
  });

  it('the writer count is pinned, so a new one has to be acknowledged', () => {
    // Raising this number is the expected case. It appearing in a diff is the
    // point — a capability writer added silently is how the gap opened.
    expect(WRITERS).toHaveLength(5);
  });
});

// ─── 5. Parity and the supply-collapse guard ──────────────────────────────────

describe('parity between the canonical table and the legacy grants', () => {
  it('counts grants BOTH ways, because only one direction is dangerous', () => {
    const sql = CAPABILITY_PARITY_SQL('servana');
    // legacy_only is the adoption gap: providers the fallback is carrying.
    expect(sql).toContain('AS legacy_only');
    // canonical_only is not a defect — an admin grant legitimately has no
    // legacy row — but an unexplained jump in it means a writer went rogue.
    expect(sql).toContain('AS canonical_only');
    expect(sql).toContain('AS legacy_providers');
    expect(sql).toContain('AS canonical_providers');
    expect(sql).toContain('servana.services');
  });

  it('only counts ACTIVE canonical rows as covering a legacy grant', () => {
    // An archived canonical row is a revocation, not coverage.
    expect(CAPABILITY_PARITY_SQL('servana')).toMatch(/canonical AS \([\s\S]*?status = 'active'/);
  });

  it('reads a row without inventing numbers for missing columns', () => {
    expect(readParityRow({})).toEqual({
      legacyGrants: 0, canonicalGrants: 0, legacyOnly: 0,
      canonicalOnly: 0, legacyProviders: 0, canonicalProviders: 0,
    });
  });

  it('refuses to call the fallback retirable while it carries anything', () => {
    const verdict = supplyCollapseVerdict({
      legacyGrants: 100, canonicalGrants: 90, legacyOnly: 10,
      canonicalOnly: 0, legacyProviders: 12, canonicalProviders: 11,
    });
    expect(verdict.safeToRetireFallback).toBe(false);
    expect(verdict.providerShortfall).toBe(1);
    expect(verdict.detail).toContain('10 grant(s)');
    expect(verdict.detail).toContain('1 provider(s)');
  });

  it('clears only when NO grant and NO provider would be lost', () => {
    expect(supplyCollapseVerdict({
      legacyGrants: 100, canonicalGrants: 100, legacyOnly: 0,
      canonicalOnly: 4, legacyProviders: 12, canonicalProviders: 12,
    })).toMatchObject({ safeToRetireFallback: true, providerShortfall: 0 });
  });

  it('does not read extra canonical rows as a shortfall', () => {
    // More canonical providers than legacy ones is an admin grant, not a loss.
    expect(supplyCollapseVerdict({
      legacyGrants: 10, canonicalGrants: 20, legacyOnly: 0,
      canonicalOnly: 10, legacyProviders: 3, canonicalProviders: 5,
    }).providerShortfall).toBe(0);
  });
});

// ─── 6. The migration ─────────────────────────────────────────────────────────

describe('migration 029 backfills without ever narrowing', () => {
  const sql = readFile('scripts/migrations/029-capability-canonical-source.sql');

  it('is registered in the numbered sequence the runner reads', () => {
    const dir = fs.readdirSync(path.join(ROOT, 'scripts', 'migrations'));
    expect(dir).toContain('029-capability-canonical-source.sql');
  });

  it('owns no transaction — the runner does', () => {
    // A migration with its own BEGIN cannot be dry-run and rolled back.
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/mi);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/mi);
  });

  it('covers BOTH legacy sources, which migration 021 did not', () => {
    // 021 backfilled from employee_services only, so an approval that was never
    // mirrored into that table has no canonical row at all.
    expect(sql).toContain('FROM servana.employee_services es');
    expect(sql).toContain('FROM servana.worker_service_applications wsa');
    expect(sql).toContain("wsa.status = 'approved'");
  });

  it('joins through legacy_service_family_id, never by assuming ids line up', () => {
    expect(sql).toContain('JOIN servana.services s ON s.legacy_service_family_id');
  });

  it('deletes nothing and touches no legacy table', () => {
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/UPDATE servana\.employee_services/i);
    expect(sql).not.toMatch(/UPDATE servana\.worker_service_applications/i);
    expect(sql).not.toMatch(/UPDATE servana\.bookings/i);
  });

  it('RAISES rather than committing an incomplete backfill', () => {
    /**
     * The supply-collapse guard. A backfill that silently under-covers is
     * exactly the failure this tab exists to prevent, and aborting the
     * transaction leaves the fallback carrying the load exactly as before —
     * the safe direction to fail in.
     */
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain('legacy_only_grants > 0');
    expect(sql).toContain('canonical_providers < legacy_providers');
  });

  it('creates the composite index the hot lookup uses', () => {
    expect(sql).toContain('catalog_provider_services_lookup_idx');
    expect(sql).toContain('(provider_uid, service_id, status)');
  });

  it('records what the table now IS, for the next reader', () => {
    expect(sql).toContain('COMMENT ON TABLE servana.catalog_provider_services');
    expect(sql).toMatch(/AUTHORITATIVE/);
  });
});

describe('the parity script is safe to run and refuses a remote apply', () => {
  const script = readFile('scripts/capability-parity-report.ts');
  const pkg = JSON.parse(readFile('package.json'));

  it('is registered under names that say what they do', () => {
    expect(pkg.scripts['capability:parity']).toContain('capability-parity-report.ts');
    expect(pkg.scripts['capability:reconcile']).toContain('--apply');
  });

  it('measures by default and writes only with --apply', () => {
    expect(script).toContain("const apply = process.argv.includes('--apply')");
    expect(script).toContain('if (!apply)');
  });

  it('writes ONLY the canonical table', () => {
    // It cannot widen capability: every row corresponds to a permission the
    // provider already holds at the family grain.
    expect(script).toContain('INSERT INTO ${schema}.catalog_provider_services');
    expect(script).not.toMatch(/DELETE|UPDATE servana|DROP/i);
  });

  it('refuses a remote database without an explicit acknowledgement', () => {
    // Same guard, and the same reasoning, as run-migrations.ts.
    expect(script).toContain('CAPABILITY_REMOTE_ACK');
    expect(script).toContain('Remote reconcile refused');
  });

  it('exits non-zero while the gap is open, so CI can gate on it', () => {
    expect(script).toContain('process.exitCode = 1');
  });
});
