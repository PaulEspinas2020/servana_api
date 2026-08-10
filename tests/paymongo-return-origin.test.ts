import fs from 'fs';
import path from 'path';

const loadResolver = () => {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../src/services/paymentReturnOrigin');
};

const withNodeEnv = <T>(value: string | undefined, fn: () => T): T => {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
};

const req = (origin?: string) => (origin === undefined ? {} : { headers: { origin } });

describe('PayMongo return origin allowlist', () => {
  describe('the mobile apps are unchanged by construction', () => {
    test('a request with no Origin header resolves to the configured default', () => {
      const { resolvePaymentReturnOrigin } = loadResolver();
      expect(resolvePaymentReturnOrigin(req())).toBeUndefined();
      expect(resolvePaymentReturnOrigin({ headers: {} })).toBeUndefined();
    });

    test('no request at all (the scheduler retry job) resolves to the default', () => {
      const { resolvePaymentReturnOrigin } = loadResolver();
      expect(resolvePaymentReturnOrigin()).toBeUndefined();
      expect(resolvePaymentReturnOrigin(null)).toBeUndefined();
    });
  });

  describe('an allowlisted origin is honoured', () => {
    test('the customer web portal origin resolves to itself', () => {
      const { resolvePaymentReturnOrigin } = loadResolver();
      expect(resolvePaymentReturnOrigin(req('https://client.servana.com.ph')))
        .toBe('https://client.servana.com.ph');
    });

    test('a trailing slash and the default port still match', () => {
      const { resolvePaymentReturnOrigin } = loadResolver();
      expect(resolvePaymentReturnOrigin(req('https://client.servana.com.ph/')))
        .toBe('https://client.servana.com.ph');
      expect(resolvePaymentReturnOrigin(req('https://client.servana.com.ph:443')))
        .toBe('https://client.servana.com.ph');
    });
  });

  describe('a forged Origin cannot redirect a payment', () => {
    // The whole point of the allowlist: the resolver returns OUR entry, never
    // the caller's string. These are the shapes that defeat naive matching.
    test.each([
      'https://evil.example.com',
      'https://client.servana.com.ph.evil.example.com',
      'https://evil.example.com/client.servana.com.ph',
      'https://evil.example.com#client.servana.com.ph',
      'https://evil.example.com?next=https://client.servana.com.ph',
      'https://client.servana.com.ph@evil.example.com',
      'http://client.servana.com.ph',
      'not a url',
      '',
    // The positive control for this block is the 'allowlisted origin is
    // honoured' describe above — without it, a resolver that always returned
    // undefined would pass every case here.
    ])('%s resolves to the default, not to itself', (origin) => {
      const { resolvePaymentReturnOrigin } = loadResolver();
      const resolved = resolvePaymentReturnOrigin(req(origin));
      expect(resolved === undefined || resolved === 'https://client.servana.com.ph').toBe(true);
      expect(String(resolved ?? '')).not.toContain('evil.example.com');
    });

    test('a non-string Origin header is ignored', () => {
      const { resolvePaymentReturnOrigin } = loadResolver();
      expect(resolvePaymentReturnOrigin({ headers: { origin: ['https://client.servana.com.ph'] } }))
        .toBeUndefined();
    });
  });

  describe('the dev origin is not reachable in production', () => {
    test('localhost is allowlisted outside production', () => {
      withNodeEnv('development', () => {
        const { resolvePaymentReturnOrigin } = loadResolver();
        expect(resolvePaymentReturnOrigin(req('http://localhost:4200')))
          .toBe('http://localhost:4200');
      });
    });

    test('localhost is refused in production', () => {
      withNodeEnv('production', () => {
        const { resolvePaymentReturnOrigin, paymentReturnOriginAllowlist } = loadResolver();
        expect(resolvePaymentReturnOrigin(req('http://localhost:4200'))).toBeUndefined();
        expect(paymentReturnOriginAllowlist()).toEqual(['https://client.servana.com.ph']);
      });
    });
  });

  describe('every allowlisted origin actually serves the return routes', () => {
    test('the allowlist holds only origins with /payment-success and /payment-cancel pages', () => {
      withNodeEnv('production', () => {
        const { paymentReturnOriginAllowlist } = loadResolver();
        // Admin can start a checkout for support-assisted recovery but hosts no
        // return pages — its absence here is deliberate, not an oversight.
        expect(paymentReturnOriginAllowlist()).not.toContain('https://admin.servana.com.ph');
        expect(paymentReturnOriginAllowlist()).not.toContain('https://provider.servana.com.ph');
      });
    });
  });
});

describe('the checkout call sites thread the resolved origin', () => {
  const read = (...parts: string[]) =>
    fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8');

  const service = read('services', 'paymentService.ts');
  const paymentCtrl = read('controllers', 'paymentController.ts');
  const additionalCtrl = read('controllers', 'additional.controller.ts');

  test('both HTTP entry points resolve the origin from the request', () => {
    expect(paymentCtrl).toContain('resolvePaymentReturnOrigin(req)');
    expect(additionalCtrl).toContain('resolvePaymentReturnOrigin(req)');
  });

  test('all four return URLs accept the per-request origin', () => {
    // Four call sites: success + cancel, for bookings and for additional work.
    const threaded = service.match(/options\?\.returnOrigin/g) ?? [];
    expect(threaded).toHaveLength(4);
  });

  test('the configured default is still the fallback, so no caller is forced to pass one', () => {
    expect(service).toContain('returnOrigin || process.env.PAYMONGO_RETURN_URL || process.env.APP_URL');
  });

  test('the scheduler still calls createCheckoutSession without an origin', () => {
    const scheduler = fs.readFileSync(path.join(__dirname, '..', 'src', 'scheduler.ts'), 'utf8');
    expect(scheduler).toContain('createCheckoutSession(row.booking_id)');
  });
});
