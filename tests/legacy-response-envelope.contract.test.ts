/**
 * Contract test for the legacy response envelope.
 *
 * `{ status: 'success', data }` / `{ status: 'error', error }` is read directly
 * by both live Flutter apps:
 *   ServanaWorker  servana_api.dart:107   data['message'] ?? data['error']
 *   ServanaClient  http_backend.dart:100  body['error'] as String?
 *
 * The second one is a cast, so `error` must stay a STRING. Neither app can be
 * released to accommodate a change here, which is the whole point of pinning it.
 *
 * This file exists because the repo also has utils/apiResponse.ts, a newer
 * `{ success, message, data }` envelope. The two look interchangeable and are
 * not; a future tidy-up that swaps one for the other would break both apps
 * silently, and nothing else in the suite would have noticed.
 */

import {
  buildSuccess,
  buildError,
  logFailure,
  GENERIC_FAILURE_MESSAGE,
  status,
} from '../src/helpers/status';

describe('legacy response envelope — protected contract', () => {

  describe('success', () => {
    it('uses status:"success" and puts the payload under data', () => {
      const env = buildSuccess({ id: 1 });
      expect(env.status).toBe('success');
      expect(env.data).toEqual({ id: 1 });
    });

    it('omits data entirely when there is none, rather than sending null', () => {
      expect(Object.keys(buildSuccess())).toEqual(['status']);
    });

    it('returns a NEW object every call', () => {
      const a = buildSuccess({ v: 1 });
      const b = buildSuccess({ v: 2 });
      expect(a).not.toBe(b);
      expect(a.data).toEqual({ v: 1 });
    });

    // The defect this replaced: a shared object kept the previous request's
    // payload, so any path that sent without assigning leaked it to the next
    // caller.
    it('does not retain a previous payload', () => {
      buildSuccess({ secret: 'first-caller' });
      expect(JSON.stringify(buildSuccess())).not.toContain('first-caller');
    });
  });

  describe('error', () => {
    it('uses status:"error" and a string under error', () => {
      const env = buildError('Something specific.');
      expect(env.status).toBe('error');
      expect(typeof env.error).toBe('string');
      expect(env.error).toBe('Something specific.');
    });

    // ServanaClient does `body['error'] as String?`. A non-string throws there.
    it('never emits a non-string error, even with no message supplied', () => {
      expect(typeof buildError().error).toBe('string');
      expect(buildError().error).toBe(GENERIC_FAILURE_MESSAGE);
      expect(typeof buildError('').error).toBe('string');
    });

    it('returns a NEW object every call and retains nothing', () => {
      buildError('first-caller-detail');
      expect(JSON.stringify(buildError())).not.toContain('first-caller-detail');
    });

    it('carries requestId only when one is supplied', () => {
      expect(Object.keys(buildError('x'))).toEqual(['status', 'error']);
      expect(buildError('x', 'req_1').requestId).toBe('req_1');
    });
  });

  describe('no exception detail reaches the client', () => {
    const dbError = new Error(
      'duplicate key value violates unique constraint "user_address_pkey"',
    );

    it('keeps the exception out of the envelope', () => {
      const requestId = logFailure('test.context', dbError);
      const body = JSON.stringify(buildError(undefined, requestId));
      expect(body).not.toContain('user_address_pkey');
      expect(body).not.toContain('duplicate key');
      expect(body).not.toContain('constraint');
    });

    it('gives the caller a correlation id instead', () => {
      const requestId = logFailure('test.context', dbError);
      expect(requestId).toMatch(/^req_/);
      expect(buildError(undefined, requestId).requestId).toBe(requestId);
    });

    it('issues a distinct id per failure', () => {
      expect(logFailure('a', dbError)).not.toBe(logFailure('b', dbError));
    });
  });

  it('keeps the HTTP status map intact', () => {
    expect(status.success).toBe(200);
    expect(status.error).toBe(500);
    expect(status.unauthorized).toBe(401);
    expect(status.conflict).toBe(409);
    expect(status.bad).toBe(400);
  });

  // Guard against the confusion that motivated this file.
  it('is NOT the utils/apiResponse envelope', () => {
    const legacy = buildSuccess({ a: 1 }) as unknown as Record<string, unknown>;
    expect(legacy['success']).toBeUndefined();
    expect(legacy['message']).toBeUndefined();
  });
});
