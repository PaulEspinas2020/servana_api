/**
 * TAB 12 — typed environment validation.
 *
 * The risk this suite guards is not "does it validate" but "does it refuse the
 * wrong things". A fail-fast that names a variable production does not set would
 * turn the next boot into a crash, so the required list is asserted explicitly
 * and the degraded list is asserted to be non-fatal.
 */

import {
  inspectEnv,
  validateEnv,
  describeFailure,
  REQUIRED_ENV,
  DEGRADED_ENV,
  ENV_SCHEMA,
} from '../src/env/envSchema';

const ORIGINAL = { ...process.env };

const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    process.env = { ...saved };
  }
};

/** Every required variable set to a placeholder, so a case can unset just one. */
const allRequiredSet = (): Record<string, string> =>
  Object.fromEntries(REQUIRED_ENV.map((s) => [s.name, 'set-for-test']));

afterAll(() => {
  process.env = { ...ORIGINAL };
});

describe('production refuses an unusable environment', () => {
  it('throws when a required variable is missing', () => {
    expect(() =>
      withEnv({ ...allRequiredSet(), DB_HOST: undefined }, () => validateEnv(true)),
    ).toThrow(/DB_HOST/);
  });

  it('lists EVERY problem at once, not one per restart', () => {
    // Reporting one variable per boot turns a five-variable misconfiguration
    // into five deploys.
    let message = '';
    try {
      withEnv(
        { ...allRequiredSet(), DB_HOST: undefined, DB_USER: undefined, SECRET: undefined },
        () => validateEnv(true),
      );
    } catch (err: any) {
      message = err.message;
    }
    expect(message).toMatch(/DB_HOST/);
    expect(message).toMatch(/DB_USER/);
    expect(message).toMatch(/SECRET/);
  });

  it('explains what each missing variable is for', () => {
    let message = '';
    try {
      withEnv({ ...allRequiredSet(), SCHEMA: undefined }, () => validateEnv(true));
    } catch (err: any) {
      message = err.message;
    }
    // A boot failure that only names a variable makes the reader go looking.
    expect(message).toMatch(/SCHEMA — .*schema/i);
  });

  it('treats an empty or whitespace value as unset', () => {
    // `DB_HOST=` in a .env file is not a configured host.
    expect(() =>
      withEnv({ ...allRequiredSet(), DB_HOST: '   ' }, () => validateEnv(true)),
    ).toThrow(/DB_HOST/);
  });

  it('passes when everything required is present', () => {
    expect(() => withEnv(allRequiredSet(), () => validateEnv(true))).not.toThrow();
  });
});

describe('the insecure-fallback rule', () => {
  it('refuses TEMP_ID in production even when everything else is set', () => {
    // It bypasses authentication outright, so it is unsafe regardless of the
    // rest of the configuration.
    expect(() =>
      withEnv({ ...allRequiredSet(), TEMP_ID: 'anything' }, () => validateEnv(true)),
    ).toThrow(/TEMP_ID/);
  });

  it('allows TEMP_ID outside production', () => {
    expect(() =>
      withEnv({ ...allRequiredSet(), TEMP_ID: 'anything' }, () => validateEnv(false)),
    ).not.toThrow();
  });
});

describe('degraded configuration is reported, never fatal', () => {
  it('does not throw in production when only degraded variables are unset', () => {
    /**
     * This is the half that protects the boot. PayMongo, SendGrid and Mongo keys
     * are real, but an unset one must degrade a capability rather than refuse
     * traffic — and none of them belongs on the required list.
     */
    const unsetAllDegraded = Object.fromEntries(DEGRADED_ENV.map((s) => [s.name, undefined]));
    expect(() =>
      withEnv({ ...allRequiredSet(), ...unsetAllDegraded }, () => validateEnv(true)),
    ).not.toThrow();
  });

  it('names the unset capabilities instead of hiding them', () => {
    const info = jest.fn();
    withEnv({ ...allRequiredSet(), MAILER_KEY: undefined }, () =>
      validateEnv(true, { warn: jest.fn(), info } as any),
    );
    expect(info).toHaveBeenCalled();
    expect(String(info.mock.calls[0][0])).toMatch(/MAILER_KEY/);
  });

  it('warns rather than throwing outside production when a required one is unset', () => {
    const warn = jest.fn();
    withEnv({ ...allRequiredSet(), DB_HOST: undefined }, () =>
      validateEnv(false, { warn, info: jest.fn() } as any),
    );
    expect(String(warn.mock.calls[0][0])).toMatch(/DB_HOST/);
    expect(String(warn.mock.calls[0][0])).toMatch(/fatal in production/);
  });
});

describe('no value ever leaves this module', () => {
  it('reports names only — a masked secret in a log is still a secret in a log', () => {
    const secretValue = 'super-secret-value-do-not-log';
    let message = '';
    try {
      withEnv({ ...allRequiredSet(), SECRET: secretValue, DB_HOST: undefined }, () =>
        validateEnv(true),
      );
    } catch (err: any) {
      message = err.message;
    }
    expect(message).not.toContain(secretValue);
  });

  it('the report carries names, not values', () => {
    const report = withEnv({ ...allRequiredSet(), MAILER_KEY: 'sg.live.key' }, () =>
      inspectEnv(true),
    );
    expect(JSON.stringify(report)).not.toContain('sg.live.key');
  });
});

describe('the schema itself', () => {
  it('keeps the required list to what production demonstrably already sets', () => {
    /**
     * Pinned deliberately. Production serves traffic today, so these are present
     * by demonstration. Adding a name here is a claim about production's real
     * environment, and getting it wrong means the next deploy refuses to boot —
     * so this test is the place that claim has to be made explicitly.
     */
    expect(REQUIRED_ENV.map((s) => s.name).sort()).toEqual([
      'DB_DATABASE',
      'DB_HOST',
      'DB_PASSWORD',
      'DB_PORT',
      'DB_USER',
      'SCHEMA',
      'SECRET',
    ]);
  });

  it('declares no variable twice', () => {
    const names = ENV_SCHEMA.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every variable a purpose a reader can act on', () => {
    for (const spec of ENV_SCHEMA) {
      expect(spec.purpose.length).toBeGreaterThan(10);
    }
  });

  it('describeFailure stays silent when there is nothing wrong', () => {
    const clean = withEnv(allRequiredSet(), () => inspectEnv(true));
    expect(clean.missingRequired).toEqual([]);
    expect(clean.insecure).toEqual([]);
    expect(describeFailure(clean)).not.toMatch(/MISSING|INSECURE/);
  });
});
