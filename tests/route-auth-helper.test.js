/**
 * The bare-route detector, tested on fixtures before anything trusts it.
 *
 * Two earlier versions of this logic were wrong in opposite directions, and one
 * of them caused six authenticated admin routes to be deleted before the suite
 * caught it. A detector that decides what is safe to remove has to be checked
 * against cases where it must say yes AND cases where it must say no.
 */

const { bareRoutes, aliasMap } = require('./helpers/routeAuth');

describe('bareRoutes', () => {
  const PRELUDE = `
const adminOnly = [verifyAuth, verifyRoles([0, 1])];
const publicOnly = [rateLimit];
`;

  it('flags a route with no middleware at all', () => {
    const src = PRELUDE + `router.get("/a", ctrl.handler);`;
    expect(bareRoutes(src)).toHaveLength(1);
  });

  it('accepts a literal verifyAuth', () => {
    const src = PRELUDE + `router.get("/b", verifyAuth, ctrl.handler);`;
    expect(bareRoutes(src)).toEqual([]);
  });

  it('accepts a spread alias that contains verifyAuth', () => {
    // The miss that deleted six secured admin routes.
    const src = PRELUDE + `router.get("/c", ...adminOnly, ctrl.handler);`;
    expect(bareRoutes(src)).toEqual([]);
  });

  it('still flags a spread alias that does NOT contain verifyAuth', () => {
    // The inverse must hold, or the alias resolution becomes a way to smuggle
    // an unauthenticated route past the check.
    const src = PRELUDE + `router.get("/d", ...publicOnly, ctrl.handler);`;
    expect(bareRoutes(src)).toHaveLength(1);
  });

  it('reads a declaration split across lines', () => {
    // The second miss: `router.get(` alone on a line, middleware below.
    const src =
      PRELUDE +
      `router.get(\n  "/e",\n  verifyAuth,\n  verifyOwnership,\n  ctrl.handler,\n);`;
    expect(bareRoutes(src)).toEqual([]);
  });

  it('flags a multi-line declaration that is genuinely bare', () => {
    const src = PRELUDE + `router.post(\n  "/f",\n  ctrl.handler,\n);`;
    expect(bareRoutes(src)).toHaveLength(1);
  });

  it('is not confused by parentheses inside the declaration', () => {
    const src = PRELUDE + `router.get("/g", verifyRoles([0, 1]), ctrl.h);`;
    // verifyRoles alone is a ROLE check, not authentication — still bare.
    expect(bareRoutes(src)).toHaveLength(1);
  });

  it('resolves aliases correctly', () => {
    expect(aliasMap(PRELUDE)).toEqual({ adminOnly: true, publicOnly: false });
  });
});
