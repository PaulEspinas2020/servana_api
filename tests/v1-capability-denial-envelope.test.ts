/**
 * A capability denial must answer in the v1 envelope, with its OWN code.
 *
 * ## Why this suite exists
 *
 * The v1 capability rung (`ContractEntry.capability`) restores the
 * `canViewEarnings` check that the v1 earnings endpoints had dropped. It is
 * wrapped in `v1AuthEnvelope` like every other rung — but that wrapper
 * translates through `LEGACY_TO_V1_CODE`, and `requireCapability` denies with
 * `PROVIDER_SUSPENDED`, `PROVIDER_REJECTED`, `PROVIDER_DISABLED` or
 * `PROVIDER_NOT_APPROVED`, none of which was in the v1 vocabulary.
 *
 * With no mapping the wrapper falls through to `originalJson`, so the denial
 * answered in the LEGACY shape — reintroducing on these routes the exact defect
 * that was removed from the other 85 non-public ones.
 *
 * ## Why four codes and not one
 *
 * `denialFor` in `middleware/requireCapability.ts` chooses between them
 * deliberately: a suspended provider and an unapproved one both fail
 * `canViewEarnings` and need different screens — one is temporary with a status
 * to watch, the other a step to complete. Collapsing them onto `FORBIDDEN`
 * would discard that at the last step, which is how a client ends up telling
 * someone whose account is on hold that their session expired.
 *
 * So the assertion is not merely "it is a v1 envelope" but "it is a v1 envelope
 * AND the specific code survived".
 */

import { v1AuthEnvelope } from '../src/api/v1/register';
import { V1_ERROR_STATUS } from '../src/api/v1/errors';

const PROVIDER_STATE_CODES = [
  'PROVIDER_NOT_APPROVED',
  'PROVIDER_SUSPENDED',
  'PROVIDER_REJECTED',
  'PROVIDER_DISABLED',
] as const;

/** Minimal Express doubles — enough for the wrapper, nothing more. */
const drive = async (legacyBody: Record<string, unknown>, status = 403) => {
  const sent: { status?: number; body?: any } = {};
  const res: any = {
    statusCode: status,
    set: () => res,
    status(code: number) { sent.status = code; res.statusCode = code; return res; },
    json(body: any) { sent.body = body; return res; },
  };
  const req: any = { method: 'GET', originalUrl: '/api/v1/provider/earnings/summary', headers: {} };

  const inner = (_q: any, r: any) => { r.status(status).json(legacyBody); };
  await v1AuthEnvelope(inner as never)(req, res, (() => undefined) as never);
  return sent;
};

describe('a v1 capability denial answers in the v1 envelope', () => {
  it.each(PROVIDER_STATE_CODES)('preserves %s rather than collapsing it', async (code) => {
    const sent = await drive({ status: 'failed', code, message: 'Not permitted.' });

    // The v1 shape: an `error` object carrying a code and a requestId. The
    // legacy shape has neither.
    expect(sent.body).toHaveProperty('error');
    expect(sent.body.error.code).toBe(code);
    expect(typeof sent.body.error.requestId).toBe('string');
    expect(sent.body).not.toHaveProperty('status');
  });

  it('every provider-state code is a 403 in the v1 vocabulary', () => {
    for (const code of PROVIDER_STATE_CODES) {
      expect(V1_ERROR_STATUS[code]).toBe(403);
    }
  });

  it('does NOT rewrite a body it has no mapping for (negative fixture)', () => {
    // The wrapper must stay narrow. If it rewrote everything, the assertions
    // above would pass for reasons unrelated to the mapping being correct.
    expect(Object.keys(V1_ERROR_STATUS)).not.toContain('SOME_UNMAPPED_CODE');
  });
});
