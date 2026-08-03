/**
 * Find route declarations that reach a handler without a credential.
 *
 * Three separate attempts at this check got it wrong, and each failure is a
 * property this helper has to have:
 *
 *   1. Searching each line for the literal string "verifyAuth" missed
 *      `...adminOnly`, a spread of [verifyAuth, verifyRoles([0,1])]. Six
 *      secured admin routes were reported bare — and deleted — before the
 *      tests caught it. So: resolve middleware aliases.
 *
 *   2. Matching a single line missed declarations split across several lines,
 *      where `router.get(` sits alone and the middleware follows below. So:
 *      parse the whole declaration, not the first line of it.
 *
 *   3. Both earlier versions were written inline in two test files and drifted
 *      apart. So: one implementation, imported.
 *
 * `bareRoutes(src)` returns the full text of every declaration with no
 * authentication. An empty array is the invariant worth asserting.
 */

const AUTH_TOKENS = ['verifyAuth', 'verifyFirebase', 'requireAuth'];

/** `const adminOnly = [verifyAuth, verifyRoles([0,1])]` -> { adminOnly: true } */
function aliasMap(src) {
  const out = {};
  const rx = /const\s+(\w+)\s*=\s*\[([^\]]*)\]/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    out[m[1]] = AUTH_TOKENS.some((t) => m[2].includes(t));
  }
  return out;
}

/** Every `router.<method>( ... );` declaration, newlines and all. */
function declarations(src) {
  const out = [];
  const rx = /router\.(get|post|put|patch|delete)\(/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    // Walk to the matching close paren so multi-line declarations arrive whole.
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

function isAuthenticated(decl, aliases) {
  if (AUTH_TOKENS.some((t) => decl.includes(t))) return true;
  return Object.keys(aliases).some(
    (name) => aliases[name] && new RegExp(`\\.\\.\\.\\s*${name}\\b`).test(decl)
  );
}

function bareRoutes(src) {
  const aliases = aliasMap(src);
  return declarations(src).filter((d) => !isAuthenticated(d, aliases));
}

module.exports = { bareRoutes, declarations, aliasMap, isAuthenticated };
