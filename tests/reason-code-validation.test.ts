/**
 * Command 6 §12 — reason codes must be validated, not merely present.
 *
 * Before this, `reason_code` was read off the request body and stored as-is.
 * finalRejectProvider checked that a code was PRESENT, never that it was real —
 * so any string an admin sent was persisted and later rendered to a provider as
 * though it were curated text.
 */

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../src/config', () => ({ db: { schema: 'servana' } }));

import dbQuery from '../src/db/dbQuery';
import {
  assertValidReasonCode,
  ReasonCodeError,
} from '../src/services/adminOnboardingService';

const q = dbQuery.query as jest.Mock;

/** Schema statements pass through; the lookup returns whatever the test wants. */
const mockCode = (row: any | null) => {
  q.mockReset();
  q.mockImplementation((sql: string) => {
    if (/FROM servana\.provider_review_reason_codes/i.test(String(sql))) {
      return Promise.resolve({ rows: row ? [row] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
};

describe('existence', () => {
  it('rejects a code that is not in the table', async () => {
    mockCode(null);
    await expect(
      assertValidReasonCode('totally_made_up', 'rejected', 'message')
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects an inactive code — the query filters is_active itself', async () => {
    // A retired code must stop being usable without being deleted, so history
    // that references it still reads correctly.
    mockCode(null);
    await expect(
      assertValidReasonCode('req_retired', 'rejected', 'message')
    ).rejects.toBeInstanceOf(ReasonCodeError);
  });

  it('accepts a real code', async () => {
    mockCode({ applicable_decisions: ['rejected'], requires_free_text: false });
    await expect(
      assertValidReasonCode('final_eligibility_criteria', 'rejected')
    ).resolves.toBeUndefined();
  });

  it('no code at all is not this function\'s problem', async () => {
    // Whether a code is REQUIRED is the caller's rule; finalRejectProvider
    // enforces it with a 400 before reaching here.
    mockCode(null);
    await expect(assertValidReasonCode(null, 'rejected')).resolves.toBeUndefined();
    await expect(assertValidReasonCode(undefined, 'rejected')).resolves.toBeUndefined();
  });
});

describe('applicable_decisions', () => {
  it('rejects a code used with a decision it does not apply to', async () => {
    // req_escalated_review exists, but it accompanies an escalation, not a
    // rejection. The data model can already catch this mistake.
    mockCode({ applicable_decisions: ['escalated'], requires_free_text: false });
    await expect(
      assertValidReasonCode('req_escalated_review', 'rejected', 'msg')
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('accepts when the decision is listed', async () => {
    mockCode({
      applicable_decisions: ['rejected', 'needs_resubmission'],
      requires_free_text: false,
    });
    await expect(
      assertValidReasonCode('req_expired', 'needs_resubmission')
    ).resolves.toBeUndefined();
  });

  it('tolerates the column arriving as a JSON string rather than an array', async () => {
    // JSONB comes back parsed from pg, but a driver or a migration could hand
    // back text. Failing on that would reject valid codes.
    mockCode({ applicable_decisions: '["rejected"]', requires_free_text: false });
    await expect(
      assertValidReasonCode('final_policy_decision', 'rejected')
    ).resolves.toBeUndefined();
  });

  it('an empty list means the code is unrestricted, not unusable', async () => {
    mockCode({ applicable_decisions: [], requires_free_text: false });
    await expect(
      assertValidReasonCode('some_code', 'anything')
    ).resolves.toBeUndefined();
  });
});

describe('requires_free_text', () => {
  it('rejects when elaboration is required and absent', async () => {
    // req_additional_info says "we need more information" — on its own that
    // tells the provider nothing about WHAT.
    mockCode({ applicable_decisions: ['needs_resubmission'], requires_free_text: true });
    await expect(
      assertValidReasonCode('req_additional_info', 'needs_resubmission')
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects whitespace as elaboration', async () => {
    mockCode({ applicable_decisions: ['needs_resubmission'], requires_free_text: true });
    await expect(
      assertValidReasonCode('req_additional_info', 'needs_resubmission', '   ')
    ).rejects.toBeInstanceOf(ReasonCodeError);
  });

  it('accepts when elaboration is supplied', async () => {
    mockCode({ applicable_decisions: ['needs_resubmission'], requires_free_text: true });
    await expect(
      assertValidReasonCode(
        'req_additional_info',
        'needs_resubmission',
        'Please send the second page of your certificate.'
      )
    ).resolves.toBeUndefined();
  });
});
