jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

import { evaluateServicePolicy } from '../src/services/providerServicePolicyService';

const enforcedOffering = {
  id: 7,
  offering_version: 4,
  enforcement_state: 'enforced',
  allowed_provider_types: ['individual_provider'],
  allowed_branch_ids: ['3'],
  allowed_city_ids: ['makati'],
};

describe('canonical provider service policy', () => {
  it('keeps unconfigured policy additive during deployment', async () => {
    const runner = jest.fn().mockResolvedValueOnce({ rows: [{ id: 7, offering_version: 2, enforcement_state: null }] });
    const result = await evaluateServicePolicy('provider-a', 11, runner);
    expect(result).toMatchObject({ eligible: true, code: 'POLICY_NOT_CONFIGURED', requirementsVersion: 2 });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('blocks a partial multi-offering rollout instead of allowing a draft-policy bypass', async () => {
    const runner = jest.fn().mockResolvedValueOnce({ rows: [enforcedOffering, { id: 8, offering_version: 5, enforcement_state: 'draft' }] });
    const result = await evaluateServicePolicy('provider-a', 11, runner);
    expect(result).toMatchObject({ eligible: false, code: 'SERVICE_POLICY_INCOMPLETE', requirementsVersion: 5 });
  });

  it('requires provider-owned, clean, approved and current qualification evidence', async () => {
    const runner = jest.fn()
      .mockResolvedValueOnce({ rows: [enforcedOffering] })
      .mockResolvedValueOnce({ rows: [{ role: 2, coverage_mode: 'city', city_ids: ['makati'], branch_ids: ['3'] }] })
      .mockResolvedValueOnce({ rows: [{
        offering_id: 7,
        requirement_key: 'trade_license',
        document_type_id: 'professional_license',
        provider_label: 'Professional license',
        provider_description: 'Upload a current professional license.',
        is_required: true,
        document_id: null,
        lifecycle_state: null,
        scan_status: null,
        expires_at: null,
        review_state: null,
      }] });

    const result = await evaluateServicePolicy('provider-a', 11, runner);
    expect(result).toMatchObject({ eligible: false, code: 'QUALIFICATION_REQUIRED' });
    expect(result.requirements).toEqual([expect.objectContaining({ id: 'trade_license', state: 'missing' })]);
    expect(runner.mock.calls[2][1]).toEqual(['provider-a', [7]]);
    expect(runner.mock.calls[2][0]).toContain('wr.worker_uid = $1');
  });

  it('accepts the matching provider only after the linked evidence is verified', async () => {
    const runner = jest.fn()
      .mockResolvedValueOnce({ rows: [enforcedOffering] })
      .mockResolvedValueOnce({ rows: [{ role: 2, coverage_mode: 'city', city_ids: ['makati'], branch_ids: ['3'] }] })
      .mockResolvedValueOnce({ rows: [{
        offering_id: 7,
        requirement_key: 'trade_license',
        document_type_id: 'professional_license',
        provider_label: 'Professional license',
        provider_description: 'Upload a current professional license.',
        is_required: true,
        document_id: 41,
        lifecycle_state: 'under_review',
        scan_status: 'clean',
        expires_at: '2099-01-01T00:00:00.000Z',
        review_state: 'approved',
      }] });

    const result = await evaluateServicePolicy('provider-a', 11, runner);
    expect(result).toMatchObject({ eligible: true, code: 'POLICY_SATISFIED' });
    expect(result.requirements[0].state).toBe('verified');
  });
});
