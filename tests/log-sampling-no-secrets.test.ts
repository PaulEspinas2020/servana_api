/**
 * Sample what the logger ACTUALLY writes, not what the redactor would do if
 * asked.
 *
 * ## Why this exists beside two suites that already cover redaction
 *
 * `observability-redaction` drives `redact()` directly, and
 * `log-sensitive-bypass` statically scans `console.*` call sites. Both are
 * useful and neither answers the question the launch criterion asks — "no
 * sensitive data appears in any log, **verified by sampling**".
 *
 * A unit test of a redactor proves the redactor works on what it is handed. It
 * cannot prove the middleware hands it everything: a field read straight off
 * `req` and copied into the line bypasses the redactor entirely, and the unit
 * test stays green while the secret ships. That is a different failure with the
 * same symptom, and only the emitted line can distinguish them.
 *
 * So this builds requests carrying secrets in every place a secret genuinely
 * arrives — Authorization header, cookies, body, query string, path parameters
 * — runs the REAL `buildLogLine`, serialises the result exactly as
 * `requestLogMiddleware` does, and searches the text for the values.
 *
 * ## The positive control is the load-bearing part
 *
 * A sampling test that captures nothing passes. `the sampler can see a secret
 * when one is present` puts a secret into a line deliberately and asserts the
 * search FINDS it, so a green run means "searched and found nothing" rather
 * than "searched nothing".
 */

import type { Request, Response } from 'express';
import { buildLogLine } from '../src/observability/requestLog';

/**
 * Values chosen to be unmistakable in a haystack.
 *
 * Each stands for something that really passes through this API: a Firebase ID
 * token, a password on a reset, a PayMongo key, a GCash reference from a
 * receipt, a card-like number, and an email. Random-looking strings are used so
 * a match cannot be a coincidence of formatting.
 *
 * The PayMongo one is a PLACEHOLDER rather than an `sk_live_…` shape, and that
 * is deliberate. The first version used the realistic prefix and the repository's
 * own secret scanner refused the push — correctly, because it cannot know a
 * fixture from a credential. A test file full of things that look like live keys
 * teaches everyone to wave the scanner through, and it would match a grep for
 * live keys during an incident. The shape is irrelevant here anyway: redaction
 * keys off the FIELD NAME, not the value, so any unique needle proves the same
 * thing.
 */
const SECRETS = {
  bearer: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IlNVUEVSU0VDUkVUVE9LRU4ifQ.PAYLOADSECRET.SIGSECRET',
  password: 'Correct-Horse-Battery-Staple-99',
  paymongoKey: 'PAYMONGO-KEY-PLACEHOLDER-QQ11ZZ',
  receiptRef: 'GCASH-REF-8837412290',
  pan: '4111111111111111',
  email: 'refund.requester@servana.com.ph',
  cookie: 'session=abcSESSIONSECRETxyz; refresh=REFRESHSECRETxyz',
};

const fakeReq = (over: Partial<Request> = {}): Request =>
  ({
    method: 'POST',
    baseUrl: '/api/admin/finance',
    path: '/refunds',
    originalUrl: '/api/admin/finance/refunds',
    params: {},
    query: {},
    body: {},
    headers: {},
    get(this: { headers: Record<string, string> }, name: string) {
      return this.headers[name.toLowerCase()];
    },
    ...over,
  }) as unknown as Request;

const fakeRes = (over: Partial<Response> = {}): Response =>
  ({ statusCode: 200, locals: {}, getHeader: () => undefined, ...over }) as unknown as Response;

/** Exactly how requestLogMiddleware puts the line on stdout. */
const emit = (req: Request, res: Response): string => JSON.stringify(buildLogLine(req, res, 12));

/**
 * Which secrets appear in this text, by name.
 *
 * A pure function returning a list, rather than a helper that throws. The first
 * version threw, and the repository's vacuous-test ratchet correctly flagged
 * nine tests as asserting nothing: a delegated throw is invisible to anything
 * counting assertions, and it is invisible to a reader skimming for what a test
 * checks. Returning the names also makes a failure say WHICH secret escaped
 * instead of only that one did.
 */
const leakedSecrets = (text: string): string[] =>
  Object.entries(SECRETS)
    .filter(([, value]) => text.includes(value))
    .map(([name]) => name)
    .sort();

describe('the sampler can see a secret when one is present', () => {
  it('finds a planted value, so a clean result means searched-and-found-nothing', () => {
    /**
     * The control. Without it, a bug that made `emit` return `''` would turn
     * every assertion below green — the exact way a sampling check rots into
     * decoration.
     */
    const planted = `{"msg":"http_request","note":"${SECRETS.bearer}"}`;
    expect(leakedSecrets(planted)).toEqual(['bearer']);
  });

  it('emits a non-empty line for an ordinary request', () => {
    const line = emit(fakeReq(), fakeRes());
    expect(line.length).toBeGreaterThan(50);
    expect(line).toContain('http_request');
  });
});

describe('no secret reaches the emitted line, whatever route it arrives by', () => {
  it('an Authorization header does not', () => {
    const req = fakeReq({
      headers: { authorization: `Bearer ${SECRETS.bearer}` } as never,
    });
    expect(leakedSecrets(emit(req, fakeRes()))).toEqual([]);
  });

  it('a Cookie header does not', () => {
    const req = fakeReq({ headers: { cookie: SECRETS.cookie } as never });
    expect(leakedSecrets(emit(req, fakeRes()))).toEqual([]);
  });

  it('a password in the body does not', () => {
    const req = fakeReq({
      body: { email: SECRETS.email, newPassword: SECRETS.password, token: SECRETS.bearer } as never,
    });
    expect(leakedSecrets(emit(req, fakeRes()))).toEqual([]);
  });

  it('a processor key and a receipt reference do not', () => {
    // The money path. A GCash reference identifies a real customer payment and a
    // secret key is a credential; neither belongs in an aggregated log.
    const req = fakeReq({
      body: {
        refundReference: SECRETS.receiptRef,
        paymongoSecretKey: SECRETS.paymongoKey,
        proofOfPaymentUrl: `https://cdn.example/${SECRETS.receiptRef}.jpg`,
      } as never,
    });
    expect(leakedSecrets(emit(req, fakeRes()))).toEqual([]);
  });

  it('a card-like number does not', () => {
    const req = fakeReq({ body: { cardNumber: SECRETS.pan, cvv: '123' } as never });
    expect(leakedSecrets(emit(req, fakeRes()))).toEqual([]);
  });

  it('a secret in the QUERY STRING does not', () => {
    /**
     * Query strings are the easiest place for a credential to end up by
     * accident — a developer testing with `?token=…`, a client that builds a
     * URL wrongly — and they are also the place most likely to be copied into
     * an aggregator verbatim with the path.
     */
    const req = fakeReq({
      originalUrl: `/api/admin/finance/refunds?token=${SECRETS.bearer}&email=${SECRETS.email}`,
      query: { token: SECRETS.bearer, email: SECRETS.email } as never,
    });
    expect(leakedSecrets(emit(req, fakeRes()))).toEqual([]);
  });

  it('a secret in a PATH PARAMETER does not', () => {
    // `params` is the one input `buildLogLine` deliberately reads, through
    // `redact()`. This is the assertion that the reading is actually redacted
    // rather than merely intended to be.
    const req = fakeReq({
      params: { refundId: '7', token: SECRETS.bearer, email: SECRETS.email } as never,
    });
    expect(leakedSecrets(emit(req, fakeRes()))).toEqual([]);
  });

  it('an error message carrying a secret does not', () => {
    // A domain error that interpolated a value is a real way secrets escape:
    // the redactor never sees it, because it arrives as prose.
    const res = fakeRes({
      locals: { errorCode: 'VALIDATION_FAILED', errorMessage: `token ${SECRETS.bearer} is invalid` },
    } as never);
    expect(leakedSecrets(emit(fakeReq(), res))).toEqual([]);
  });

  it('every input at once does not', () => {
    // The combination, because a line is assembled from several sources and a
    // per-source test can miss an interaction between them.
    const req = fakeReq({
      headers: { authorization: `Bearer ${SECRETS.bearer}`, cookie: SECRETS.cookie } as never,
      body: { newPassword: SECRETS.password, refundReference: SECRETS.receiptRef } as never,
      query: { email: SECRETS.email } as never,
      params: { token: SECRETS.bearer } as never,
      originalUrl: `/api/admin/finance/refunds?email=${SECRETS.email}`,
    });
    const res = fakeRes({ statusCode: 500, locals: { errorMessage: SECRETS.paymongoKey } } as never);
    expect(leakedSecrets(emit(req, res))).toEqual([]);
  });
});

describe('the line still carries what an operator needs', () => {
  it('keeps the request id, route, status and actor role', () => {
    /**
     * Redaction that removes the useful parts is its own failure. The whole
     * point of these lines is joining a portal error to a server line by
     * request id, so the key must survive whatever else is dropped.
     */
    const req = fakeReq({
      headers: { authorization: `Bearer ${SECRETS.bearer}` } as never,
      params: { refundId: '7' } as never,
    });
    (req as unknown as { id: string }).id = 'req-correlation-key';

    const line = JSON.parse(emit(req, fakeRes({ statusCode: 403 })));
    expect(line.requestId).toBe('req-correlation-key');
    expect(line.status).toBe(403);
    expect(line.method).toBe('POST');
    expect(typeof line.route).toBe('string');
    expect(line.route.length).toBeGreaterThan(0);
    expect(line).toHaveProperty('actorRole');
  });

  it('reports a route TEMPLATE rather than the concrete path', () => {
    // `/refunds/7` in a log is a cardinality problem and a privacy one: it makes
    // every id its own time series and puts identifiers into an aggregator.
    const req = fakeReq({ baseUrl: '/api/admin/finance', path: '/refunds/7' });
    const line = JSON.parse(emit(req, fakeRes()));
    expect(line.route).not.toContain('/7');
  });
});
