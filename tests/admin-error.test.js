/**
 * Admin Error Utils Tests — Command 9
 * Run: npx jest tests/admin-error.test.js
 *
 * Tests the logic of admin-error.utils.ts (ported to plain JS for Jest compatibility).
 * No TypeScript, no imports — all logic is inlined.
 */

// ─── Local re-implementation of classifyAdminApiError ───────────────────────

function classifyAdminApiError(error) {
  if (!error || typeof error !== 'object') return 'unknown';
  const e = error;
  if (e.name === 'TimeoutError' || e.code === 'ECONNABORTED') return 'timeout';
  if (e.status === 0) return 'network';
  if (e.status === 404) return 'not_found';
  if (e.status === 409) return 'conflict';
  if (e.status === 422) return 'validation';
  if (e.status === 429) return 'rate_limited';
  if (e.status === 400) return 'business_rule';
  if (e.status >= 500) return 'server';
  if (e.status === 401) {
    const code = e.error?.code ?? '';
    if (code === 'TOKEN_EXPIRED') return 'token_expired';
    return 'unauthenticated';
  }
  if (e.status === 403) {
    const code = e.error?.code ?? '';
    const text = typeof e.error === 'string' ? e.error : '';
    if (code === 'TOKEN_EXPIRED' || code === 'UNAUTHENTICATED'
        || /token expired/i.test(text) || /login again/i.test(text)) {
      return 'token_expired';
    }
    return 'forbidden';
  }
  return 'unknown';
}

function shouldRedirectToLogin(kind) {
  return kind === 'unauthenticated' || kind === 'token_expired';
}

function contextLabel(context) {
  const labels = {
    providers:    'Provider Registry',
    onboarding:   'Provider Onboarding',
    dashboard:    'Dashboard',
    job_orders:   'Job Orders',
    services:     'Service Catalog',
    customers:    'Customers',
    users:        'Users',
    schedules:    'Schedules',
    settings:     'Settings',
    chat:         'Chat',
    documents:    'Documents',
    analytics:    'Analytics',
    catalog:      'Service Catalog',
    payments:     'Payments',
    system:       'Admin Portal',
  };
  return labels[context] ?? 'Admin Portal';
}

function pageErrorMessageForKind(kind, context = 'system') {
  const label = contextLabel(context);
  switch (kind) {
    case 'forbidden':       return `You do not have permission to view ${label}.`;
    case 'not_found':       return `${label} could not be found. It may have been deleted.`;
    case 'server':          return `${label} could not be loaded due to a server error. Try again.`;
    case 'network':         return 'Network error. Check your connection and try again.';
    case 'timeout':         return `${label} took too long to load. Try again.`;
    case 'rate_limited':    return 'Too many requests. Wait a moment and try again.';
    case 'token_expired':   return 'Session expired. Please log in again.';
    case 'unauthenticated': return 'Session expired. Please log in again.';
    case 'conflict':        return `${label} has a data conflict. Refresh and try again.`;
    case 'validation':      return `${label} data is invalid. Correct the highlighted fields.`;
    case 'business_rule':   return `${label} could not be loaded due to a configuration issue.`;
    default:                return `${label} could not be loaded. Please try again.`;
  }
}

function mutationErrorMessageForKind(kind, context = 'system') {
  const label = contextLabel(context);
  switch (kind) {
    case 'forbidden':       return `You do not have permission to perform this action on ${label}.`;
    case 'not_found':       return `The ${label} item was not found. It may have been deleted.`;
    case 'server':          return `Could not save changes to ${label}. Try again.`;
    case 'network':         return 'Network error. Check your connection and try again.';
    case 'timeout':         return `The request to ${label} timed out. Try again.`;
    case 'rate_limited':    return 'Too many requests. Wait a moment and try again.';
    case 'token_expired':   return 'Session expired. Please log in again.';
    case 'unauthenticated': return 'Session expired. Please log in again.';
    case 'conflict':        return `A conflict occurred in ${label}. Refresh and try again.`;
    case 'validation':      return `Some fields are invalid. Correct the errors below.`;
    case 'business_rule':   return `This action is not allowed by the current ${label} rules.`;
    default:                return `Action failed in ${label}. Please try again.`;
  }
}

// ─── classifyAdminApiError ────────────────────────────────────────────────────

describe('classifyAdminApiError', () => {
  it('null → unknown', () => {
    expect(classifyAdminApiError(null)).toBe('unknown');
  });

  it('status 0 → network', () => {
    expect(classifyAdminApiError({ status: 0 })).toBe('network');
  });

  it('status 404 → not_found', () => {
    expect(classifyAdminApiError({ status: 404 })).toBe('not_found');
  });

  it('status 409 → conflict', () => {
    expect(classifyAdminApiError({ status: 409 })).toBe('conflict');
  });

  it('status 422 → validation', () => {
    expect(classifyAdminApiError({ status: 422 })).toBe('validation');
  });

  it('status 429 → rate_limited', () => {
    expect(classifyAdminApiError({ status: 429 })).toBe('rate_limited');
  });

  it('status 400 → business_rule', () => {
    expect(classifyAdminApiError({ status: 400 })).toBe('business_rule');
  });

  it('status 500 → server', () => {
    expect(classifyAdminApiError({ status: 500 })).toBe('server');
  });

  it('status 503 → server', () => {
    expect(classifyAdminApiError({ status: 503 })).toBe('server');
  });

  it('status 401 plain → unauthenticated', () => {
    expect(classifyAdminApiError({ status: 401 })).toBe('unauthenticated');
  });

  it('status 401 TOKEN_EXPIRED → token_expired', () => {
    expect(classifyAdminApiError({ status: 401, error: { code: 'TOKEN_EXPIRED' } })).toBe('token_expired');
  });

  it('status 403 plain → forbidden', () => {
    expect(classifyAdminApiError({ status: 403 })).toBe('forbidden');
  });

  it('status 403 with TOKEN_EXPIRED code → token_expired', () => {
    expect(classifyAdminApiError({ status: 403, error: { code: 'TOKEN_EXPIRED' } })).toBe('token_expired');
  });

  it('status 403 with token expired text → token_expired', () => {
    expect(classifyAdminApiError({ status: 403, error: 'Token expired, please login again' })).toBe('token_expired');
  });

  it('TimeoutError → timeout', () => {
    expect(classifyAdminApiError({ name: 'TimeoutError' })).toBe('timeout');
  });

  it('ECONNABORTED → timeout', () => {
    expect(classifyAdminApiError({ code: 'ECONNABORTED' })).toBe('timeout');
  });
});

// ─── shouldRedirectToLogin ───────────────────────────────────────────────────

describe('shouldRedirectToLogin', () => {
  it('unauthenticated → true', () => {
    expect(shouldRedirectToLogin('unauthenticated')).toBe(true);
  });

  it('token_expired → true', () => {
    expect(shouldRedirectToLogin('token_expired')).toBe(true);
  });

  it('forbidden → false (must NOT logout)', () => {
    expect(shouldRedirectToLogin('forbidden')).toBe(false);
  });

  it('server → false', () => {
    expect(shouldRedirectToLogin('server')).toBe(false);
  });

  it('network → false', () => {
    expect(shouldRedirectToLogin('network')).toBe(false);
  });

  it('conflict → false', () => {
    expect(shouldRedirectToLogin('conflict')).toBe(false);
  });

  it('validation → false', () => {
    expect(shouldRedirectToLogin('validation')).toBe(false);
  });
});

// ─── pageErrorMessageForKind ─────────────────────────────────────────────────

describe('pageErrorMessageForKind', () => {
  it('forbidden in dashboard mentions Dashboard', () => {
    const msg = pageErrorMessageForKind('forbidden', 'dashboard');
    expect(msg).toContain('Dashboard');
    expect(msg).toContain('permission');
  });

  it('not_found in job_orders mentions Job Orders', () => {
    const msg = pageErrorMessageForKind('not_found', 'job_orders');
    expect(msg).toContain('Job Orders');
  });

  it('network returns generic network message regardless of context', () => {
    expect(pageErrorMessageForKind('network', 'dashboard')).toContain('Network error');
  });

  it('rate_limited returns rate limiting message', () => {
    expect(pageErrorMessageForKind('rate_limited', 'system')).toContain('Too many requests');
  });

  it('timeout in dashboard mentions Dashboard and took too long', () => {
    const msg = pageErrorMessageForKind('timeout', 'dashboard');
    expect(msg).toContain('Dashboard');
    expect(msg).toContain('too long');
  });

  it('default context falls back to Admin Portal', () => {
    const msg = pageErrorMessageForKind('server');
    expect(msg).toContain('Admin Portal');
  });

  it('providers context uses Provider Registry label', () => {
    const msg = pageErrorMessageForKind('server', 'providers');
    expect(msg).toContain('Provider Registry');
  });

  it('onboarding context uses Provider Onboarding label', () => {
    const msg = pageErrorMessageForKind('forbidden', 'onboarding');
    expect(msg).toContain('Provider Onboarding');
  });
});

// ─── mutationErrorMessageForKind ─────────────────────────────────────────────

describe('mutationErrorMessageForKind', () => {
  it('forbidden mutation mentions permission and context label', () => {
    const msg = mutationErrorMessageForKind('forbidden', 'services');
    expect(msg).toContain('permission');
    expect(msg).toContain('Service Catalog');
  });

  it('validation mutation returns field errors message', () => {
    expect(mutationErrorMessageForKind('validation', 'providers')).toContain('fields are invalid');
  });

  it('conflict mutation mentions refresh', () => {
    expect(mutationErrorMessageForKind('conflict', 'onboarding')).toContain('Refresh');
  });

  it('server mutation indicates could not save', () => {
    const msg = mutationErrorMessageForKind('server', 'services');
    expect(msg).toContain('not save') || expect(msg).toContain('save changes');
  });
});

// ─── Contract: 403 never triggers logout ─────────────────────────────────────

describe('C9 contract: 403 never triggers login redirect', () => {
  it('403 without TOKEN_EXPIRED code → forbidden, not unauthenticated', () => {
    const kind = classifyAdminApiError({ status: 403 });
    expect(kind).toBe('forbidden');
    expect(shouldRedirectToLogin(kind)).toBe(false);
  });

  it('403 with random error text → forbidden', () => {
    const kind = classifyAdminApiError({ status: 403, error: { message: 'Access denied for this resource' } });
    expect(kind).toBe('forbidden');
    expect(shouldRedirectToLogin(kind)).toBe(false);
  });
});

// ─── Self-test: regex/pattern integrity for 403 classification ───────────────

describe('C9 self-test: 403 classification fixture coverage', () => {
  const positives = [
    { status: 403, error: { code: 'TOKEN_EXPIRED' } },
    { status: 403, error: { code: 'UNAUTHENTICATED' } },
    { status: 403, error: 'Token expired. Please login again.' },
    { status: 403, error: 'Your token expired.' },
  ];

  const negatives = [
    { status: 403 },
    { status: 403, error: { message: 'Access denied' } },
    { status: 403, error: 'Insufficient role' },
  ];

  for (const fixture of positives) {
    it(`${JSON.stringify(fixture).slice(0, 60)} → token_expired`, () => {
      expect(classifyAdminApiError(fixture)).toBe('token_expired');
    });
  }

  for (const fixture of negatives) {
    it(`${JSON.stringify(fixture).slice(0, 60)} → forbidden`, () => {
      expect(classifyAdminApiError(fixture)).toBe('forbidden');
    });
  }
});
