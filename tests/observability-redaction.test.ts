/**
 * "No secrets in logs" (§141), as an adversarial suite.
 *
 * ## Why this is written by attacking the redactor
 *
 * A redaction test that feeds in `{ password: 'x' }` and checks it was removed
 * proves the one case the author already thought of. The failure that actually
 * happens is the field nobody classified: somebody adds `taxIdNumber` to a
 * payload, nothing rejects it, and six months of it sits in the log aggregator
 * before anyone looks.
 *
 * So the redactor is deny-by-default — it keeps what is named and drops
 * everything else — and this suite throws realistic, messy payloads at it and
 * asserts on what SURVIVED rather than on what was removed.
 */

jest.mock('../src/config', () => ({ db: { schema: 'servana' }, tempId: undefined }));

import {
  ACTOR_ROLES,
  CORRELATION,
  CORRELATION_ID_PATTERN,
  FORBIDDEN_KEY_FRAGMENTS,
  LOG_FIELDS,
  LOG_FIELD_NAMES,
  REDACTION_PLACEHOLDER,
  SAFE_ENTITY_KEYS,
  redact,
  routeTemplate,
  sanitizeCorrelationId,
  statusClass,
} from '../src/observability/observabilityPolicy';

// ─── Deny by default ──────────────────────────────────────────────────────────

describe('the redactor keeps only what is named', () => {
  it('drops a field nobody has classified', () => {
    /**
     * THE test. An allow-list is the only design where a NEW sensitive field is
     * safe by default; under a deny-list it is logged until somebody notices.
     *
     * Neither of these is on any list. Under a deny-list both would be logged
     * in full; here they simply do not appear.
     */
    expect(redact({ somethingInventedTomorrow: 'value' })).toEqual({});
    expect(redact({ internalRiskScore: 0.93 })).toEqual({});
  });

  it('marks a field the fragment list recognises, even if nobody classified it', () => {
    // `taxIdNumber` is on no allow-list and on no explicit deny-list, but `tax`
    // is a forbidden fragment — so it is flagged rather than merely dropped.
    // Both mechanisms give a safe answer; this one gives the more informative.
    expect(redact({ taxIdNumber: '123-456-789' })).toEqual({ taxIdNumber: REDACTION_PLACEHOLDER });
  });

  it('keeps the safe entity ids', () => {
    expect(redact({ bookingId: 84213, conversationId: 'conv-9' }))
      .toEqual({ bookingId: 84213, conversationId: 'conv-9' });
  });

  it('marks a forbidden key rather than silently dropping it', () => {
    // Dropping would be safe but invisible. A placeholder tells whoever reads
    // the line that something was there and was withheld.
    expect(redact({ password: 'hunter2' })).toEqual({ password: REDACTION_PLACEHOLDER });
  });

  it('survives a realistic booking-create payload with nothing sensitive escaping', () => {
    const payload = {
      bookingId: 84213,
      serviceId: 180,
      customerEmail: 'dana@example.com',
      customerPhone: '+639170000000',
      addressOne: '14 Mabini Street, Taytay',
      latitude: 14.5764,
      longitude: 121.1325,
      otp: '482913',
      accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc',
      fcmToken: 'dGhpcy1pcy1hLXRva2Vu',
      notes: 'Gate code is 4471, ask for Dana',
    };
    const out = redact(payload);
    const serialized = JSON.stringify(out);

    expect(out.bookingId).toBe(84213);
    expect(out.serviceId).toBe(180);

    for (const secret of [
      'dana@example.com', '+639170000000', 'Mabini', '482913',
      'eyJhbGci', 'dGhpcy1pcy1hLXRva2Vu', '4471', 'Dana',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('14.5764');
    expect(serialized).not.toContain('121.1325');
  });

  it('catches a secret under any of the casings it actually arrives in', () => {
    // The same token reaches different layers as token / accessToken /
    // access_token / Authorization.
    for (const key of ['token', 'accessToken', 'access_token', 'Authorization', 'AUTH_TOKEN']) {
      expect(redact({ [key]: 'v' })[key]).toBe(REDACTION_PLACEHOLDER);
    }
  });

  it('never lets a safe key smuggle an unbounded value', () => {
    // A 4 KB "conversationId" is somebody putting a payload where an id goes.
    const out = redact({ conversationId: 'x'.repeat(5000) });
    expect(out.conversationId).toBeUndefined();
  });

  it('ignores arrays, primitives and null rather than guessing', () => {
    expect(redact(null)).toEqual({});
    expect(redact('a string')).toEqual({});
    expect(redact([{ bookingId: 1 }])).toEqual({});
  });

  it('drops a nested object rather than walking into it', () => {
    // Recursion is how a redactor ends up logging a whole user record because
    // one leaf was on the allow-list.
    expect(redact({ bookingId: 1, customer: { bookingId: 2, email: 'x@y.z' } }))
      .toEqual({ bookingId: 1 });
  });

  it('the two mechanisms do not contradict each other', () => {
    /**
     * A key that is BOTH on the safe list and matches a forbidden fragment
     * would be a leak that survives review, because each mechanism would assume
     * the other handled it.
     */
    for (const safe of SAFE_ENTITY_KEYS) {
      const lower = safe.toLowerCase();
      const clash = FORBIDDEN_KEY_FRAGMENTS.filter((f) => lower.includes(f));
      expect({ safe, clash }).toEqual({ safe, clash: [] });
    }
  });

  it('forbids every category §141 names', () => {
    for (const fragment of ['token', 'otp', 'password', 'email', 'phone', 'address']) {
      expect(FORBIDDEN_KEY_FRAGMENTS).toContain(fragment);
    }
  });
});

// ─── Route templates ──────────────────────────────────────────────────────────

describe('route templates carry no identifiers', () => {
  it('collapses a numeric id', () => {
    expect(routeTemplate('/api/v1/bookings/84213/timeline')).toBe('/api/v1/bookings/:id/timeline');
  });

  it('collapses a Firebase-shaped uid', () => {
    expect(routeTemplate('/api/v1/providers/FbX9k2Lm4nQ8rT1vW3yZ5aB7cD9e/profile'))
      .toBe('/api/v1/providers/:id/profile');
  });

  it('collapses a UUID', () => {
    expect(routeTemplate('/api/v1/events/7f3c1a92-0d4e-4f6b-9c2a-1b8e5d0a3f77'))
      .toBe('/api/v1/events/:id');
  });

  it('keeps real path words, which are what makes the label readable', () => {
    expect(routeTemplate('/api/v1/catalog/categories')).toBe('/api/v1/catalog/categories');
    expect(routeTemplate('/api/v1/notifications/unread-count'))
      .toBe('/api/v1/notifications/unread-count');
  });

  it('drops the query string entirely', () => {
    // A query string carries search terms, which are user content.
    expect(routeTemplate('/api/v1/search?q=somebody%27s+address'))
      .toBe('/api/v1/search');
  });

  it('never emits a template containing a digit run that could be an id', () => {
    const templated = routeTemplate('/api/v1/bookings/84213/support-cases/9912');
    expect(templated).toBe('/api/v1/bookings/:id/support-cases/:id');
    expect(templated).not.toMatch(/\d{3,}/);
  });
});

// ─── Correlation ──────────────────────────────────────────────────────────────

describe('an inbound correlation id is accepted but never trusted', () => {
  it('accepts a sane id', () => {
    expect(sanitizeCorrelationId('7f3c1a92-0d4e-4f6b-9c2a-1b8e5d0a3f77'))
      .toBe('7f3c1a92-0d4e-4f6b-9c2a-1b8e5d0a3f77');
  });

  it('refuses one carrying a newline, which would forge a log line', () => {
    // The classic: a caller-controlled value that reaches a line-delimited log
    // can inject an entire fake entry.
    expect(sanitizeCorrelationId('abcdefgh\n{"level":"info","msg":"all clear"}')).toBeNull();
  });

  it('refuses embedded control characters, quotes and spaces', () => {
    for (const bad of ['abcdefgh"', "abcdefgh'", 'abcd efgh', 'abc\tdefgh', 'abcdefgh<b>']) {
      expect(sanitizeCorrelationId(bad)).toBeNull();
    }
  });

  it('whatever it returns is always pattern-clean', () => {
    /**
     * The property that matters, rather than a list of cases. Surrounding
     * whitespace is trimmed and the RESULT is validated, so 'abcdefgh\r'
     * yields the safe 'abcdefgh' rather than being refused - but nothing that
     * reaches a log line can ever carry a delimiter.
     */
    const attempts: unknown[] = [
      'abcdefgh ', 'abcdefgh\r', '  7f3c1a92-0d4e  ', 'abcd efgh',
      'abcdefgh\n{"level":"info"}', 'a'.repeat(5000), '', 'short', undefined, null, 42, {},
    ];
    for (const attempt of attempts) {
      const result = sanitizeCorrelationId(attempt);
      if (result !== null) {
        expect(result).toMatch(CORRELATION_ID_PATTERN);
        expect(result).not.toMatch(/[\r\n\s"']/);
      }
    }
  });

  it('refuses an unbounded value', () => {
    expect(sanitizeCorrelationId('a'.repeat(5000))).toBeNull();
    expect(sanitizeCorrelationId('short')).toBeNull();
  });

  it('refuses a missing header rather than inventing one', () => {
    expect(sanitizeCorrelationId(undefined)).toBeNull();
    expect(sanitizeCorrelationId('')).toBeNull();
  });

  it('the pattern is bounded at both ends', () => {
    expect(CORRELATION_ID_PATTERN.source).toContain('{8,128}');
  });

  it('names the headers it reads and the one it returns', () => {
    expect(CORRELATION.header).toBe('X-Request-Id');
    expect(CORRELATION.inboundHeaders).toContain('x-request-id');
    expect(CORRELATION.propagatedTo.length).toBeGreaterThan(2);
  });
});

// ─── The schema ───────────────────────────────────────────────────────────────

describe('the log schema is a schema', () => {
  it('every always-present field is what makes a line greppable', () => {
    const always = LOG_FIELDS.filter((f) => f.presence === 'always').map((f) => f.field);
    for (const field of ['requestId', 'route', 'status', 'durationMs', 'client', 'namespace']) {
      expect(always).toContain(field);
    }
  });

  it('carries a role and never a uid', () => {
    /**
     * "A provider failed to accept a job" is an operational fact. "Provider
     * FbX9… failed to accept job 84213" is a record of a named person's working
     * day, and a log that accumulates those has to be protected like the
     * database it describes.
     */
    expect(LOG_FIELD_NAMES).toContain('actorRole');
    expect(LOG_FIELD_NAMES).not.toContain('uid');
    expect(LOG_FIELD_NAMES).not.toContain('userId');
    expect(LOG_FIELD_NAMES).not.toContain('actorId');
    expect([...ACTOR_ROLES].sort()).toEqual(['admin', 'anonymous', 'customer', 'provider']);
  });

  it('every declared field has a description worth reading', () => {
    for (const field of LOG_FIELDS) {
      expect(field.description.length).toBeGreaterThan(10);
    }
  });

  it('buckets status into classes rather than logging a cardinal status label', () => {
    expect(statusClass(200)).toBe('2xx');
    expect(statusClass(404)).toBe('4xx');
    expect(statusClass(503)).toBe('5xx');
  });
});
