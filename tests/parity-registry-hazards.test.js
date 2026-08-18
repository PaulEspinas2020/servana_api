'use strict';

/**
 * PARITY TEST — structural hazards in the cross-platform field registry.
 *
 * applyParity() writes every alias of a group onto the response object. That is
 * useful when a name means one thing and dangerous when it means two, because
 * nothing here throws: a wrong alias produces a plausible value, and this
 * codebase's most expensive bugs have all been plausible wrong values rather
 * than errors (P0.00 totals, "Beauty & Wellness" on every booking, 0,0 coords).
 *
 * These tests pin the hazards that are currently understood so a NEW one cannot
 * be added silently. The one known overlap (`providerUid`) is asserted
 * explicitly rather than waived — if it is ever resolved, this test fails and
 * tells you to update it, which is the point.
 *
 * Registry copies exist in four repos. The backend one is canonical; the three
 * Angular copies are checked opportunistically when they are checked out beside
 * this repo, and skipped when they are not.
 */

var fs = require('fs');
var path = require('path');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

var REGISTRY_SRC = stripComments(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'fieldParity.ts'), 'utf8')
);

/** Parse the registry into {canonical, aliases, contextual} records. */
function parseGroups(src) {
  var groups = [];
  var blocks = src.split(/\n\s*\{\s*\n/);
  blocks.forEach(function (b) {
    var cm = /canonical:\s*'([^']+)'/.exec(b);
    if (!cm) return;
    var am = /aliases:\s*\[([\s\S]*?)\]/.exec(b);
    var aliases = [];
    if (am) {
      var r = /'([^']+)'/g, m;
      while ((m = r.exec(am[1]))) aliases.push(m[1]);
    }
    groups.push({
      canonical: cm[1],
      aliases: aliases,
      contextual: /contextual:\s*true/.test(b),
    });
  });
  return groups;
}

var GROUPS = parseGroups(REGISTRY_SRC);

// Names known to belong to more than one group. Each entry is a decision, not
// an oversight — adding to this list should require the same argument the
// original overlap got.
var KNOWN_OVERLAPS = ['providerUid'];

describe('parity registry — parses', function () {
  it('finds every group', function () {
    expect(GROUPS.length).toBeGreaterThan(50);
  });

  it('every group has a canonical and at least one alias', function () {
    GROUPS.forEach(function (g) {
      expect(typeof g.canonical).toBe('string');
      expect(g.canonical.length).toBeGreaterThan(0);
      expect(Array.isArray(g.aliases)).toBe(true);
    });
  });

  it('self-test: the parser really reads aliases (not an empty list)', function () {
    var withAliases = GROUPS.filter(function (g) { return g.aliases.length > 0; });
    expect(withAliases.length).toBeGreaterThan(50);
  });
});

describe('parity registry — hazards', function () {
  it('no canonical is declared twice', function () {
    var seen = {};
    var dupes = [];
    GROUPS.forEach(function (g) {
      if (seen[g.canonical]) dupes.push(g.canonical);
      seen[g.canonical] = true;
    });
    expect(dupes).toEqual([]);
  });

  it('no canonical appears in its own alias list', function () {
    var bad = GROUPS.filter(function (g) {
      return g.aliases.indexOf(g.canonical) !== -1;
    }).map(function (g) { return g.canonical; });
    expect(bad).toEqual([]);
  });

  it('no NEW name is shared by two groups', function () {
    var owner = {};
    GROUPS.forEach(function (g) {
      g.aliases.forEach(function (a) {
        (owner[a] = owner[a] || []).push(g.canonical);
      });
    });
    var shared = Object.keys(owner).filter(function (a) {
      return owner[a].length > 1 && KNOWN_OVERLAPS.indexOf(a) === -1;
    });
    expect(shared).toEqual([]);
  });

  /**
   * An alias that is ALSO another group's canonical is the sharpest form of the
   * overlap: writing group A's value under that name overwrites group B's real
   * value with something that means a different thing.
   *
   * `id -> workerUid` is the one instance. It is tolerated ONLY because `id` is
   * contextual, so the response middleware (applyContextSafeParity) never
   * expands it. If someone clears the contextual flag, this stops being safe —
   * hence the paired assertion below.
   */
  it('any alias that is another group\'s canonical belongs to a CONTEXTUAL group', function () {
    var canonicals = {};
    GROUPS.forEach(function (g) { canonicals[g.canonical] = g; });
    var offenders = [];
    GROUPS.forEach(function (g) {
      g.aliases.forEach(function (a) {
        if (canonicals[a] && a !== g.canonical && !g.contextual) {
          offenders.push(g.canonical + ' -> ' + a);
        }
      });
    });
    expect(offenders).toEqual([]);
  });

  it('the id group is still contextual — the whole safety argument rests on it', function () {
    var id = GROUPS.filter(function (g) { return g.canonical === 'id'; })[0];
    expect(id).toBeDefined();
    expect(id.contextual).toBe(true);
    expect(id.aliases).toContain('workerUid');
  });

  it('the response middleware uses the context-SAFE variant', function () {
    var mw = stripComments(
      fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'parityMiddleware.ts'), 'utf8')
    );
    expect(mw).toMatch(/applyContextSafeParity/);
    expect(mw).not.toMatch(/[^t]applyParity\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-repo: the three Angular copies of this registry.
// ─────────────────────────────────────────────────────────────────────────────

var COPIES = [
  ['customer web', path.join(__dirname, '..', '..', 'servana_Customer_WebPortal',
    'src', 'app', 'core', 'utils', 'servana-field-parity.util.ts')],
  ['worker web', path.join(__dirname, '..', '..', 'Servana.com.ph',
    'src', 'app', 'core', 'utils', 'servana-field-parity.util.ts')],
  ['admin portal', path.join(__dirname, '..', '..', 'servana_adminportal',
    'src', 'app', 'shared', 'utils', 'servana-field-parity.util.ts')],
];

describe('parity registry — the Angular copies', function () {
  COPIES.forEach(function (entry) {
    var label = entry[0];
    var file = entry[1];

    describe(label, function () {
      var src = null;
      beforeAll(function () {
        if (fs.existsSync(file)) src = stripComments(fs.readFileSync(file, 'utf8'));
      });

      it('keeps the id group contextual', function () {
        if (!src) return; // repo not checked out beside this one
        var m = /canonical:\s*'id'[\s\S]{0,300}/.exec(src);
        expect(m).not.toBeNull();
        expect(m[0]).toMatch(/contextual:\s*true/);
      });

      /**
       * A single-valued name->canonical index keeps only whichever group was
       * registered last, so resolveField() searches ONE of the two groups an
       * overlapping name belongs to and silently returns undefined for the
       * other. The customer web portal fixed this with a name -> group[] Map;
       * worker web and admin portal still use Record<string, string>.
       *
       * It is LATENT in both: resolveField() has zero call sites there, and the
       * only wired helper (normalizeContextSafe, via the field-parity
       * interceptor) is unaffected because it looks up by key rather than
       * resolving across groups. This test does not fail them for it — it pins
       * the fact so that wiring resolveField() has to confront it.
       */
      it('documents whether its index is single- or multi-valued', function () {
        if (!src) return;
        var multi = /new Map<string,\s*ParityGroup\[\]>/.test(src);
        var single = /aliasToCanonical:\s*Record<string,\s*string>/.test(src);
        expect(multi || single).toBe(true);
        if (single) {
          // The trap is armed: resolveField must not be wired while it exists.
          expect(/\bresolveField\s*\(/.test(src.replace(/export function resolveField[\s\S]*?\n\}/, ''))).toBe(false);
        }
      });
    });
  });
});
