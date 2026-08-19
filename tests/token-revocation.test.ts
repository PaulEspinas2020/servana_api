const getUser = jest.fn();

jest.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ getUser }),
}));
jest.mock("../src/middleware/firebaseApp", () => ({ getFirebaseAdmin: () => ({}) }));

import {
  isRevoked,
  noteRevoked,
  __clearRevocationCache,
  REVOCATION_TTL_MS,
} from "../src/services/tokenRevocation";

/**
 * "Sign out all devices" did nothing for up to an hour.
 *
 * Command 7 §20. `revokeAllProviderSessions`, password reset and every admin
 * security action call `revokeRefreshTokens`, which stops Firebase issuing NEW
 * id tokens and does nothing about the ones already held. `verifyAuth` called
 * `verifyIdToken(idToken)` with no revocation check, so the revoked device kept
 * full access to every protected route until its token expired naturally.
 *
 * Firebase id tokens live one hour. The control a provider reaches for when
 * they believe their account is compromised therefore had no effect on the
 * device they were trying to remove, for up to an hour, while telling them it
 * had worked.
 */

const SECOND = 1000;

/** A decoded token that authenticated `agoMs` ago. */
const token = (agoMs: number, uid = "provider-1") => ({
  uid,
  auth_time: Math.floor((Date.now() - agoMs) / SECOND),
});

describe("isRevoked", () => {
  beforeEach(() => {
    __clearRevocationCache();
    getUser.mockReset();
  });

  it("admits a token from an account that has never been revoked", async () => {
    getUser.mockResolvedValue({});
    expect(await isRevoked(token(5 * 60 * SECOND))).toBe(false);
  });

  it("rejects a token issued BEFORE the revocation", async () => {
    // The whole point. The provider signed in an hour ago and pressed "sign out
    // all devices" a minute ago; this token predates that and must stop working.
    getUser.mockResolvedValue({
      tokensValidAfterTime: new Date(Date.now() - 60 * SECOND).toUTCString(),
    });
    expect(await isRevoked(token(60 * 60 * SECOND))).toBe(true);
  });

  it("admits a token issued AFTER the revocation", async () => {
    // The provider signed back in. A revocation must not lock them out for ever.
    getUser.mockResolvedValue({
      tokensValidAfterTime: new Date(Date.now() - 60 * 60 * SECOND).toUTCString(),
    });
    expect(await isRevoked(token(30 * SECOND))).toBe(false);
  });

  it("rejects a token with no auth_time once a revocation exists", async () => {
    // An unprovable token is not a valid one. It cannot be shown to postdate
    // the revocation, and guessing in its favour is how the check gets bypassed.
    getUser.mockResolvedValue({
      tokensValidAfterTime: new Date(Date.now() - 60 * SECOND).toUTCString(),
    });
    expect(await isRevoked({ uid: "provider-1" })).toBe(true);
  });

  it("admits a token with no auth_time when nothing was ever revoked", async () => {
    // Failing closed here would deny every request for every account that has
    // never been revoked, which is nearly all of them.
    getUser.mockResolvedValue({});
    expect(await isRevoked({ uid: "provider-1" })).toBe(false);
  });

  it("fails CLOSED when the lookup itself fails", async () => {
    // A revocation check that cannot run is not evidence the session is fine.
    // The alternative — admit everything during a Firebase blip — is the hole
    // this exists to close.
    getUser.mockRejectedValue(new Error("firebase unavailable"));
    expect(await isRevoked(token(60 * SECOND))).toBe(true);
  });

  it("treats an unparseable tokensValidAfterTime as no revocation", async () => {
    // Distinct from a failed lookup: Firebase answered, and the answer names no
    // usable revocation instant. Denying every request on a malformed timestamp
    // would take the platform down over a formatting change.
    getUser.mockResolvedValue({ tokensValidAfterTime: "not a date" });
    expect(await isRevoked(token(60 * SECOND))).toBe(false);
  });
});

describe("the cache", () => {
  beforeEach(() => {
    __clearRevocationCache();
    getUser.mockReset();
    getUser.mockResolvedValue({});
  });

  it("does not fetch the user record on every request", async () => {
    // Why this is not just `verifyIdToken(token, true)`: that is a network
    // round trip per protected call, and a security fix that costs latency on
    // every request is one that gets reverted.
    for (let i = 0; i < 25; i++) await isRevoked(token(SECOND));
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("keeps one entry per account, not one per request", async () => {
    await isRevoked(token(SECOND, "a"));
    await isRevoked(token(SECOND, "b"));
    await isRevoked(token(SECOND, "a"));
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it("a revocation by this process takes effect on the next request", async () => {
    // The common case: the provider taps "sign out all devices" and the same
    // process serves their next call. Waiting out the TTL there would be both
    // avoidable and the least excusable place to wait.
    await isRevoked(token(60 * SECOND));
    expect(getUser).toHaveBeenCalledTimes(1);

    getUser.mockResolvedValue({
      tokensValidAfterTime: new Date().toUTCString(),
    });
    noteRevoked("provider-1");

    expect(await isRevoked(token(60 * SECOND))).toBe(true);
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it("bounds how stale an outside revocation can be", async () => {
    // A revocation from the Firebase console or another instance is not
    // announced to this process, so the TTL is the whole guarantee. It is
    // asserted here so that widening it is a deliberate act.
    expect(REVOCATION_TTL_MS).toBeLessThanOrEqual(60_000);
    expect(REVOCATION_TTL_MS).toBeGreaterThan(0);
  });
});

describe("the middleware says which failure it was", () => {
  const source = require("fs").readFileSync(
    require("path").join(__dirname, "..", "src", "middleware", "verifyAuth.ts"),
    "utf8"
  );

  it("emits TOKEN_REVOKED, not a generic 401", async () => {
    // A client that cannot tell "expired" from "revoked" shows the wrong thing:
    // one is routine and silent, the other means somebody signed this device
    // out deliberately and the person should be told.
    expect(source).toContain("TOKEN_REVOKED");
    expect(source).toContain("isRevoked");
  });

  it("checks revocation BEFORE trusting the token", async () => {
    // Ordering is the whole fix: assigning req.user first and checking after
    // would leave a window where a handler could run on a revoked session.
    const revokedAt = source.indexOf("isRevoked");
    const assignedAt = source.indexOf("req.user = decodedIdToken");
    expect(revokedAt).toBeGreaterThan(-1);
    expect(assignedAt).toBeGreaterThan(revokedAt);
  });
});
