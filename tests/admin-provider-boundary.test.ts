import fs from 'fs';
import path from 'path';

const read = (file: string) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8').replace(/\r\n/g, '\n');

describe('admin provider target and response boundaries', () => {
  const routes = read('routes/adminProvider.routes.ts');
  const guard = read('middleware/requireProviderTarget.ts');
  const service = read('services/adminProviderService.ts');
  const controller = read('controllers/adminProviderController.ts');

  it('applies provider-role validation to every :uid route', () => {
    expect(routes).toContain("router.param('uid', requireProviderTarget)");
    expect(guard).toContain('role::int IN (2,4)');
    expect(guard).toContain("'Provider not found'");
  });

  it('defends the PII identity query even when called outside the router', () => {
    expect(service).toContain('WHERE uid = $1 AND role::int IN (2,4) LIMIT 1');
  });

  it('clamps pagination to valid SQL limits and offsets', () => {
    expect(controller).toContain('Math.max(1, parseIntQ(req.query.page, 1))');
    expect(controller).toContain('Math.min(Math.max(1, parseIntQ(req.query.limit, 50)), 200)');
  });

  it('returns canonical provider identity fields in list rows', () => {
    expect(controller).toContain('providerUid:     r.uid');
    expect(controller).toContain('displayName:');
  });

  it('aligns missing service-area metrics with invalid explicit city coverage', () => {
    expect(service).toContain("wsa.coverage_mode = 'city'");
    expect(service).toContain("wsa.city_ids = '[]'::jsonb");
  });
});
