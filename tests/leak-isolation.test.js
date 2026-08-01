/**
 * LEAK — Cross-tenant data isolation: static source verification tests.
 *
 * These tests inspect source files to prove that the isolation fixes are in
 * place without needing a running server or Firebase tokens.  Each test
 * corresponds to a finding from the LEAK audit and verifies the exact guard
 * that was added.
 *
 * HTTP integration tests (customer-A-cannot-read-customer-B flow) require
 * a live server + test Firebase tokens and are tracked as TODO below.
 */

const fs = require("fs");
const path = require("path");

const SRC = (...parts) => path.join(__dirname, "..", "src", ...parts);

// ---------------------------------------------------------------------------
// Finding 6/7: User profile IDOR — getUserProfile forced to JWT uid
// ---------------------------------------------------------------------------

describe("LEAK-FIX: getUserProfile always uses req.user.uid", () => {
  it("user.controller.ts no longer reads req.query.id for profile lookup", () => {
    const src = fs.readFileSync(SRC("controllers", "user.controller.ts"), "utf8");
    // Old pattern: const id = req.query.id
    // New pattern: const id = req.user.uid
    const getProfileBlock = src.match(/getUserProfile[\s\S]{0,400}/)?.[0] ?? "";
    expect(getProfileBlock).toContain("req.user.uid");
    expect(getProfileBlock).not.toContain("req.query.id");
  });
});

// ---------------------------------------------------------------------------
// Finding 18: Address IDOR — getAddressByAddressId ownership check
// ---------------------------------------------------------------------------

describe("LEAK-FIX: getAddressByAddressId verifies ownership", () => {
  it("user.controller.ts compares address.userId against req.user.uid", () => {
    const src = fs.readFileSync(SRC("controllers", "user.controller.ts"), "utf8");
    expect(src).toContain("dbResponse.userId !== uid");
  });
});

// ---------------------------------------------------------------------------
// Finding (makeAddressPrimary/deleteAddress): DB-level ownership scoping
// ---------------------------------------------------------------------------

describe("LEAK-FIX: address mutations scope to authenticated owner at DB level", () => {
  it("makeAddressPrimary WHERE clause includes uid = $2", () => {
    const src = fs.readFileSync(SRC("services", "address.service.ts"), "utf8");
    expect(src).toContain("WHERE address_id = $1 AND uid = $2");
  });

  it("deleteAddress WHERE clause includes uid = $2", () => {
    const src = fs.readFileSync(SRC("services", "address.service.ts"), "utf8");
    // Two occurrences expected: makeAddressPrimary + deleteAddress
    const count = (src.match(/AND uid = \$2/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  // updateUserAddress was missed when its two siblings were scoped. Any
  // authenticated caller could rewrite another customer's address — including
  // location_id, which drives coverage checks and worker-distance pricing at
  // booking time, making it a booking-corruption vector and not only a privacy
  // one. Found by the 2026-08-01 six-pass audit.
  it("updateUserAddress WHERE clause is scoped to the owning uid", () => {
    const src = fs.readFileSync(SRC("services", "address.service.ts"), "utf8");
    expect(src).toContain("WHERE address_id = $11 AND uid = $12 returning *");
  });

  // Catch-all so the next mutation added to this file cannot repeat the miss.
  // The uid predicate is written both ways here — `AND uid = $2` when address_id
  // leads, `WHERE uid = $2 and ...` when it does not — so match either rather
  // than pinning one spelling.
  it("no user_address mutation is left unscoped by uid", () => {
    const src = fs.readFileSync(SRC("services", "address.service.ts"), "utf8");
    const mutations = src.match(/(UPDATE|DELETE FROM)[\s\S]{0,400}?returning \*/g) || [];
    expect(mutations.length).toBeGreaterThan(0);

    const unscoped = mutations
      .filter((m) => /user_address/.test(m))
      .filter((m) => !/\b(AND|WHERE)\s+uid\s*=\s*\$\d+/i.test(m));

    expect(unscoped).toEqual([]);
  });

  it("user.controller.ts passes uid to makeAddressPrimary", () => {
    const src = fs.readFileSync(SRC("controllers", "user.controller.ts"), "utf8");
    expect(src).toContain("makeAddressPrimary(addressId, uid)");
  });

  it("user.controller.ts passes uid to deleteAddress", () => {
    const src = fs.readFileSync(SRC("controllers", "user.controller.ts"), "utf8");
    expect(src).toContain("deleteAddress(addressId, uid)");
  });
});

// ---------------------------------------------------------------------------
// Finding 12: archiveUser — admin-only guard
// ---------------------------------------------------------------------------

describe("LEAK-FIX: archiveUser route requires admin role", () => {
  it("user.route.ts applies verifyRoles([1]) to the archive route", () => {
    const src = fs.readFileSync(SRC("routes", "user.route.ts"), "utf8");
    // verifyRoles([1]) must appear on the same conceptual line as archiveUser
    expect(src).toMatch(/verifyRoles\(\[1\]\).*archiveUser|archiveUser.*verifyRoles\(\[1\]\)/s);
    // Simpler: both must appear in the file (order checked by logic above)
    expect(src).toContain("verifyRoles([1])");
    expect(src).toContain("archiveUser");
  });
});

// ---------------------------------------------------------------------------
// Finding 7: listUserBookings soft ownership gate
// ---------------------------------------------------------------------------

describe("LEAK-FIX: listUserBookings enforces ownership when JWT present", () => {
  // REVERSED a second time. This asserted the "present-and-differs" shape
  // (`actor?.uid && actor.uid !== userId`), which skips ownership entirely when
  // the actor is absent. Now absent-or-differs, so a missing actor is denied.
  it("bookingController.ts denies an absent OR mismatched actor", () => {
    const src = fs.readFileSync(SRC("controllers", "bookingController.ts"), "utf8");
    expect(src).toContain("!actor?.uid || actor.uid !== userId");
    expect(src).not.toContain("if (actor?.uid && actor.uid !== userId)");
  });

  it("booking.routes.ts applies verifyAuthOptional to /users/:userId/bookings", () => {
    const src = fs.readFileSync(SRC("routes", "booking.routes.ts"), "utf8");
    expect(src).toContain("verifyAuthOptional");
    expect(src).toContain("/users/:userId/bookings");
  });
});

// ---------------------------------------------------------------------------
// verifyAuthOptional middleware correctness
// ---------------------------------------------------------------------------

describe("LEAK-FIX: verifyAuthOptional passes through when no token is present", () => {
  it("middleware exists at the expected path", () => {
    expect(fs.existsSync(SRC("middleware", "verifyAuthOptional.ts"))).toBe(true);
  });

  it("calls next() unconditionally when no auth header is present", () => {
    const src = fs.readFileSync(SRC("middleware", "verifyAuthOptional.ts"), "utf8");
    // Must call next() for missing token
    expect(src).toContain("return next()");
    // Must NOT send a 401 for missing token (that is verifyAuth's job)
    expect(src).not.toMatch(/status\(401\)/);
  });
});

// ---------------------------------------------------------------------------
// Finding 13: Socket.IO CORS — origin: "*" removed
// ---------------------------------------------------------------------------

describe("LEAK-FIX: Socket.IO CORS is restricted to the allowed-origin list", () => {
  it('chat.gateway.ts does not contain cors: { origin: "*" }', () => {
    const src = fs.readFileSync(SRC("chat", "chat.gateway.ts"), "utf8");
    expect(src).not.toContain('origin: "*"');
  });

  it("chat.gateway.ts uses ALLOWED_ORIGINS list matching the HTTP whitelist", () => {
    const src = fs.readFileSync(SRC("chat", "chat.gateway.ts"), "utf8");
    expect(src).toContain("ALLOWED_ORIGINS");
    expect(src).toContain("servana.com.ph");
    expect(src).toContain("localhost:4200");
  });
});

// ---------------------------------------------------------------------------
// Finding 14: PayMongo webhook — "li" (live) signature key support
// ---------------------------------------------------------------------------

describe("LEAK-FIX: paymentService accepts live PayMongo signature key", () => {
  it('verifySignature reads key === "li" for live environment', () => {
    const src = fs.readFileSync(SRC("services", "paymentService.ts"), "utf8");
    expect(src).toContain('key === "li"');
  });

  it("te is a fallback-only key, not the primary", () => {
    const src = fs.readFileSync(SRC("services", "paymentService.ts"), "utf8");
    // The live key (li) should appear before the test key (te) fallback
    const liPos = src.indexOf('"li"');
    const tePos = src.indexOf('"te"');
    expect(liPos).toBeGreaterThan(-1);
    expect(tePos).toBeGreaterThan(-1);
    expect(liPos).toBeLessThan(tePos);
  });
});

// ---------------------------------------------------------------------------
// Finding 15: PayMongo webhook — double-response eliminated
// ---------------------------------------------------------------------------

describe("LEAK-FIX: paymentController.ts webhook has a single response path", () => {
  it("processWebhook call is not followed by an unconditional res.send in a try block", () => {
    const src = fs.readFileSync(SRC("controllers", "paymentController.ts"), "utf8");
    // The fixed version sends 200 only once, inside the try block, after the await.
    // It must NOT still have the old pattern of calling res.status inside processWebhook
    // AND also calling res.status(200) in the controller on every code path.
    expect(src).toContain("res.status(200).json({ received: true })");
    // processWebhook no longer calls res directly — it throws instead
    expect(src).not.toContain('res.status(400).send("Invalid signature")');
  });

  it("paymentService.ts throws instead of calling res.send on signature failure", () => {
    const src = fs.readFileSync(SRC("services", "paymentService.ts"), "utf8");
    expect(src).not.toContain('res.status(400).send("Invalid signature")');
    expect(src).toContain('throw new Error("Invalid signature")');
  });
});

// ---------------------------------------------------------------------------
// TODO: HTTP integration tests (require live server + Firebase tokens)
//
//  To enable, install supertest and set:
//    TEST_FIREBASE_TOKEN_A, TEST_FIREBASE_TOKEN_B, TEST_UID_A, TEST_UID_B,
//    TEST_ADMIN_TOKEN, TEST_API_BASE_URL
//
//  Negative cases to cover:
//   - Customer A GET /users/:uid_b/bookings → 403
//   - Customer A GET /user/uid_b/addresses → 403
//   - Customer A GET /user/profile?id=uid_b → own profile returned
//   - Non-admin PUT /user/archive → 403
//   - Authenticated provider PUT /workers/:uid_b/availability → 403
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ALIGN/REPEAT: /user/alluseraddresses role scoping — service layer, not route guard
// ---------------------------------------------------------------------------

describe("ALIGN: /user/alluseraddresses scopes by role in service layer, not route guard", () => {
  const routeSrc = fs.readFileSync(SRC("routes", "user.route.ts"), "utf8");
  const svcSrc   = fs.readFileSync(SRC("services", "address.service.ts"), "utf8");

  it("route does NOT apply verifyRoles([1]) to /user/alluseraddresses", () => {
    // verifyRoles([1]) was removed from alluseraddresses because ServanaClient (role 3)
    // calls this endpoint to list its own addresses. The service layer already scopes:
    // admin → all customer addresses; role 2/3 → only their own.
    const allAddrLine = routeSrc.match(/\/user\/alluseraddresses[^\n]*/)?.[0] ?? "";
    expect(allAddrLine).not.toContain("verifyRoles([1])");
  });

  it("route still requires verifyAuth on /user/alluseraddresses", () => {
    const allAddrLine = routeSrc.match(/\/user\/alluseraddresses[^\n]*/)?.[0] ?? "";
    expect(allAddrLine).toContain("verifyAuth");
  });

  it("address.service.ts getAllAddressesOfUser scopes by role in service layer", () => {
    // Wider window — the function body spans ~30 lines
    const fn = svcSrc.match(/getAllAddressesOfUser[\s\S]{0,1200}/)?.[0] ?? "";
    expect(fn).toContain("role === '1'");
    expect(fn).toContain("role === '3'");
    expect(fn).toContain("params = [userId]");
  });

  // REVERSED 2026-08-01. This previously asserted verifyAuthOptional "for mobile
  // parity" — it pinned the vulnerability as intended behaviour. The controller
  // guard reads `if (req.user && req.user.uid !== userId) 403`, so with no
  // Authorization header req.user is undefined, the condition short-circuits,
  // and any anonymous caller could read any customer's saved home addresses.
  // Sending no credentials beat sending the wrong ones.
  //
  // The parity premise did not hold: the only caller is the provider web
  // portal, which attaches a Bearer token to every request.
  it("/user/:userId/addresses requires hard authentication", () => {
    const uidAddrLine = routeSrc.match(/\/user\/:userId\/addresses[^\n]*/)?.[0] ?? "";
    expect(uidAddrLine).toContain("verifyAuth");
    expect(uidAddrLine).not.toContain("verifyAuthOptional");
  });

  // REVERSED. Asserting `req.user && req.user.uid !== userId` pinned a guard
  // that does nothing when req.user is undefined — the exact condition this
  // file's own comment, twenty lines up, describes as the vulnerability.
  it("getAddressesByUserId denies an absent OR mismatched caller", () => {
    const ctrlSrc = fs.readFileSync(SRC("controllers", "user.controller.ts"), "utf8");
    const fn = ctrlSrc.match(/getAddressesByUserId[\s\S]{0,900}/)?.[0] ?? "";
    expect(fn).toContain("!req.user?.uid || req.user.uid !== userId");
    expect(fn).not.toContain("if (req.user && req.user.uid !== userId)");
    expect(fn).toContain("403");
  });
});
