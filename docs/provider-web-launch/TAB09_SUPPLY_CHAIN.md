# TAB 09 — Framework currency and supply chain

**Owner:** ServanaWorkerWeb · **Status: PARTIAL — mandates 3 and 4 closed; 2, 5 and 7 blocked on one finding; 1 and 6 are scheduled work.**
**Measured:** 2026-08-18 against the portal at `dd3e34b`.

---

## The advisory table, with disposition per package

`npm audit --omit=dev` — **10 vulnerabilities: 1 critical, 9 high.** Matches the
command's figures exactly.

| Package | Severity | Fix requires | Disposition |
|---|---|---|---|
| `protobufjs` | **critical** | `firebase@12.17.1` (**major**, 9 → 12) | **BLOCKED** — see the lockfile finding |
| `@firebase/firestore` | high | `firebase@12.17.1` (major) | BLOCKED |
| `@firebase/firestore-compat` | high | `firebase@12.17.1` (major) | BLOCKED |
| `@grpc/grpc-js` | high | `firebase@12.17.1` (major) | BLOCKED |
| `@grpc/proto-loader` | high | `firebase@12.17.1` (major) | BLOCKED |
| `firebase` | high | `firebase@12.17.1` (major) | BLOCKED |
| `socket.io-parser` | high | **in-range** | BLOCKED — see below. `socket.io-client` is already at its latest (4.8.3); the vulnerable parser arrives nested, so there is no client upgrade to make |
| `@angular/core` | high | `@angular/core@22.1.2` (major) | Mandate 1 — a scheduled programme, nine majors |
| `@angular/compiler` | high | `@angular/compiler@22.1.2` (major) | Mandate 1 — **and no reachable surface, see mandate 4** |
| `@angular/common` | high | `@angular/common@22.1.2` (major) | Mandate 1 — **precondition removed, see mandate 3** |

---

## The finding that blocks mandates 2, 5 and 7

**`package-lock.json` is `lockfileVersion: 1` — the npm 6 format.** Local npm is
11.17.0. Netlify builds on Node 20 with `NPM_FLAGS = "--legacy-peer-deps"`. CI
and local run Node 24.

So no two environments resolve the same dependency tree, and the committed
lockfile provides almost no reproducibility guarantee. It also explains why
`--legacy-peer-deps` is needed at all.

The practical consequence, measured rather than predicted — three attempts:

| Attempt | Lockfile churn | Result |
|---|---|---|
| `npm audit fix --omit=dev --package-lock-only` | **31,001 lines** | tree re-resolved wholesale |
| `overrides: { socket.io-parser } ` + `npm install --package-lock-only` | **34,084 lines** | vulnerabilities went **10 → 14** |
| (reverted both) | — | baseline restored, 10 vulnerabilities |

Any dependency change in this repository currently rewrites the lockfile from v1
to v3 and re-resolves everything, which is why a one-package bump produced a
thirty-thousand-line diff that nobody can review and that made the count *worse*.

**So the lockfile migration is a prerequisite for mandate 2, not a detail of it.**
The command sequences the dependency-only wins first because they are "decoupled
from the framework upgrade" — which is true of the *packages* and not of the
*tooling*. Migrating v1 → v3 changes resolutions across the tree (proven above),
so it needs the full suite, a production build, and a Netlify build to validate —
and the last of those cannot be done from here.

Forcing it through would mean shipping an unreviewable resolution change to a
build target I cannot test. Recorded as **M-21** instead.

---

## Mandate 3 — the XSRF precondition, removed · **DONE**

`@angular/common` <= 19.2.25 leaks the XSRF token to a third-party origin when a
**protocol-relative** url (`//evil.example`) reaches `HttpClient`. It is the
sharpest of the three unpatchable advisories for this product, because this
client attaches a bearer token to an API that performs money and job-state
operations.

Every request here is built as `${base}${path}`, so a base that can never be
protocol-relative means no protocol-relative url can be constructed.
`assertUsableApiBase()` asserts it at construction and **throws** rather than
correcting — a silent fallback leaves a misconfigured build talking to an origin
nobody chose, which is the situation the advisory describes.

Six tests, including one that runs the guard against the base this build actually
ships with, so editing `environment.prod.ts` to a protocol-relative or
scheme-less value fails the suite.

**Watched to fail.** Disabling the protocol-relative branch failed exactly the
two assertions that guard it — the other four (scheme-less, empty, real bases,
configured base) stayed green, which is the discrimination a single-branch
mutation should show. File restored byte-identical to HEAD.

---

## Mandate 4 — the SVG and i18n XSS audit · **DONE, and the surface does not exist**

The command asks for "an inline-SVG audit with a stated verdict for every
occurrence". The verdict is that there are no occurrences:

| Checked | Count |
|---|---|
| `bypassSecurityTrust*` | **0** |
| `DomSanitizer` | **0** |
| `[innerHTML]` bindings | **0** |
| inline `<svg>` in templates | **0** |
| SVG from a variable or `[src]` binding | **0** |

Sixteen `innerHTML` matches exist in the repository and **every one is a comment
asserting the policy** — "plain text only — never render as innerHTML",
"safeBody is HTML-escaped (never injected via [innerHTML])".

So `@angular/compiler`'s stored-XSS-via-SVG and `@angular/core`'s i18n XSS have
**no reachable surface in this portal**. That is now measured rather than
assumed, which is the difference between an advisory that is accepted and one
that is merely unpatched. TAB 10's Content-Security-Policy remains the second
layer and the framework upgrade remains the actual fix.

---

## Mandate status

| # | Mandate | State |
|---|---|---|
| 1 | Angular upgrade, one major at a time | **NOT STARTED** — nine majors to 22.1.2; a 2-4 week programme, and it must follow the lockfile migration or every step produces an unreviewable diff |
| 2 | Dependency-only wins (Firebase, socket.io) | **BLOCKED on M-21** — attempted three ways, all unreviewable; baseline restored |
| 3 | Mitigate XSRF at the boundary | **DONE**, mutation-proven |
| 4 | Audit inline SVG / sanitiser bypasses | **DONE** — zero occurrences |
| 5 | Remove `--legacy-peer-deps` from the Netlify build | **BLOCKED on M-21** — it exists because the tree is inconsistent |
| 6 | `npm audit` as a blocking release gate with expiring exceptions | **NOT DONE** — it would fail on day one against 10 open advisories, so it needs the exception list agreed and dated first (M-22) |
| 7 | Pin Node and npm to one version across CI, Netlify and local | **BLOCKED on M-21** — this IS the finding, and pinning without regenerating the lockfile changes nothing |

### Guardrails honoured

- The framework upgrade was **not** attempted in the same release as the v1
  migrations.
- `npm audit` was not silenced; the count is reported as measured, including
  when my own attempt made it worse.
- The six-shard totals are unchanged and green: 5,799 (5,793 + 6 new).
