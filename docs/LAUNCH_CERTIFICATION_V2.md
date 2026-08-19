# Launch certification — Servana Production Launch Master Command V2

**Verdict: NOT_CERTIFIED.**

Measured 2026-08-19. Every figure below was produced by a command run on the
day, not read from a previous report.

---

## Why NOT_CERTIFIED, in one paragraph

The trees are green and the platform is not. Both repositories pass every gate
they own — 6,497 backend tests, 1,592 portal tests, a fresh database reaching
current schema, zero v1 successors weaker than the routes they supersede — and
**most of this programme is not in production.** The book anticipated exactly
this and said so: *certify the system, not the document.* The previous book's
verdict was NOT_CERTIFIED for the same reason, and repeating a green-tree
certification would repeat the error rather than correct it.

Two things also broke on the day and are unresolved: **no deploy can complete**,
and **the portal has not deployed at all**.

## What is actually running in production

Established by probe, not by assumption:

| Probe | Result | Means |
| --- | --- | --- |
| `GET /api/v1/health` | 200 | the running build includes `9c6b141` |
| `POST /api/v1/admin/refunds/1/mark-failed` | **404** | it does **not** include `2d34699` |
| `GET /api/v1/health` → `available: false` | — | **nothing stamps provenance at all** — see the correction below |
| Actions run list | last success `82abbd0d`, 09:33 UTC | the running build is newer than any deploy that ran |

So production sits **between `9c6b141` and `2d34699`** and cannot identify
itself.

**Correction to an earlier reading in this document.** `available: false` was
first taken as proof the build was assembled by hand, on the grounds that
`deploy.yml` writes the stamp. It does not. The stamping step exists only in the
PARKED copy at `docs/pending-workflow/deploy.yml`; the live workflow has no
BUILD_INFO step, so the endpoint would answer `available: false` after a
perfectly ordinary deploy too. The reading proved nothing.

The conclusion survives on independent evidence: the Actions run list shows no
successful deploy since 09:33 UTC, and the running build serves
`/api/v1/health`, which `82abbd0d` predates. So the build *is* newer than any
deploy that ran — established by the run list, not by the stamp.

A note on method: `POST /api/admin/<anything>` returns **401**, including for
routes that do not exist, because auth precedes routing in that namespace. Any
inference from a 401 there is unsound. The `/api/v1` router answers 404 for
unknown endpoints — verified with a deliberate nonsense path — so only the v1
probes above carry weight.

---

## The launch gate, row by row

| TAB | Condition | Verdict | Evidence |
| --- | --- | --- | --- |
| 00 | One tree; gates green from a clean clone | **PARTIAL** | Portal clean-clone `npm ci` + `verify:release` green, no flags. But `angular-20-upgrade` is a live divergent branch by owner decision |
| 01 | No unpermissioned or unaudited path to money **in production** | **NOT MET** | Needs a 403 from production for an under-permissioned admin. No such credential here, and `2d34699` — which adds the segregation control — is not deployed |
| 02 | API security headers live; admin rate limits after a log-only soak | **PARTIAL** | Headers live and verified: HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, CORP. The rate-limit soak and p99-derived limits are not done |
| 03 | A failing gate produces a **skipped** deploy | **MET** | Run pair on the day: `82abbd0d` success 09:33; `72a3ac2` failure 10:56 with Build, migrations and PM2 restart all `skipped`. Demonstrated, if unintentionally |
| 04 | Every permission has a negative test | **MET (local)** | `tests/authz-negative.test.ts` — 152 assertions against the real `requirePermission`. Grant provisioning in production is unverified |
| 05 | CSP observed in a browser with no console violation | **NOT MET** | CSP and `X-Frame-Options` confirmed live by `curl`. Nobody has opened a browser — the console half is the half that finds violations |
| 06 | A backend shape change fails the portal build | **MET** | Demonstrated red: enum widened → `ng build` exit 1 at `contract-bindings.ts:62`; baseline exit 0. Four shape mutations, all caught |
| 07 | Money and authorization API services specced | **MET** | 10 services, 210 tests. One-character URL change (`/payouts` → `/payout`) fails a spec — demonstrated |
| 08 | v1 admin domain, permissions enforced at registration | **PARTIAL** | `authz:legacy`: **0** v1 successors less restrictive, **0** dropped capabilities. Wave 1 complete; wave 3 has one entry; waves 2–3 outstanding |
| 09 | Migrated endpoints verified live; allowlist governs | **NOT MET** | The allowlist governs and is **empty** — nothing is migrated, so nothing is verified live. No telemetry sink exists to measure a traffic shift |
| 10 | Zero high advisories; supported Angular major | **NOT MET on `main`** | `main` is Angular 18 with 9 high advisories. The fix is complete on `angular-20-upgrade` — zero advisories, clean-clone `npm ci` with no flags — and held back by owner decision pending a soak |
| 11 | WCAG 2.2 AA; four workflows keyboard-only | **NOT MET** | Keyboard baseline 29 → 3, and 12 of the original 29 were reclassified as things that must *not* be focusable. No axe run, no keyboard or screen-reader pass, no contrast check |
| 12 | Trace correlation proven; SLOs and alerts live | **NOT MET** | Log sampling done and mutation-verified. No sink, no SLO, no alert, no dashboard; the request id is captured by the portal and shown to nobody |
| 13 | Backup restored; rollback rehearsed; keys confirmed deleted | **NOT MET** | Incident runbook and cross-platform impact register written. No restore, no rollback rehearsal, no IAM confirmation |

**MET: 4. PARTIAL: 4. NOT MET: 6.**

---

## Certification commands, as run

```
backend   npm run verify                exit 0   6,497 tests
          npm run db:verify:embedded    exit 0   fresh DB reaches current schema
          npm run schema:authority      exit 0
          npm run authz:legacy          exit 0   0 weaker successors

portal    npm run verify:release        exit 0   1,592 tests, 0 lint errors
          npm run smoke:contracts       exit 0   SKIPPED — ADMIN_API_BASE_URL unset

production
          admin portal CSP + X-Frame-Options     present
          GET /api/v1/catalog                    200
          GET /api/v1/bookings                   401
          GET /zzz-nope                          404
```

`smoke:contracts` exiting 0 while skipping is worth stating plainly: it is not
evidence of a passing contract check, it is evidence that no contract check ran.

---

## Gaps — every one named, owned and dated

A gap without an owner is an incident with a delay. **Owner is the repository
owner for all rows below**, because no rota exists — which is itself G-14.

### Blocking

| # | Gap | Opened | Closes when |
| --- | --- | --- | --- |
| G-01 | **No deploy can complete.** `Typecheck (source and tests)` exits 134 (SIGABRT): ~650 MB peak on a 961 MB host that is serving production. Today's recovery went around it by hand | 2026-08-19 | A push to `main` produces a successful deploy run |
| G-02 | **The portal has not deployed at all.** Live `runtime.<hash>.js` still differs from a local build. TABs 06–09 and 11 are on GitHub, not in production. `[skip ci]` is honoured by Netlify and explains part of it, but two commits pushed deliberately without it also failed to deploy | 2026-08-19 | A push to `main` changes the live `runtime.<hash>.js` |
| G-03 | **Production cannot identify itself, and cannot be made to.** `/api/v1/health` answers `available: false` because the live `deploy.yml` has **no stamping step** — it exists only in the parked copy the PAT cannot push. The endpoint is built, contracted, documented and fed by nothing | 2026-08-19 | The stamping step lands with the other held-back workflow edits, and the endpoint returns a commit |
| G-04 | No production evidence for TAB 01 — a 403 for an under-permissioned admin has never been observed | 2026-08-19 | Probe recorded against production |
| G-05 | `payouts.trigger_due_run` is granted to nobody; the due-payout run is unreachable | earlier | At least one non-super-admin holds it |
| G-06 | `refunds.mark_failed` is granted to nobody; the refund `failed` terminal is unreachable | 2026-08-19 | At least one non-super-admin holds it |

### Non-blocking but dated

| # | Gap | Closes when |
| --- | --- | --- |
| G-07 | Angular 20 held on a branch pending soak (9 high advisories remain on `main`) | Branch merged and soaked; **before 2026-10-31**, when Angular 20 itself leaves LTS |
| G-08 | No axe run, keyboard pass, screen-reader pass or contrast check | Documented pass per workflow |
| G-09 | No log sink, SLO, alert or dashboard | Lines queryable; four alerts with owners |
| G-10 | Request id captured by the portal and displayed nowhere | An operator can read and copy it from a failed action |
| G-11 | No backup restore, no rollback rehearsal, no IAM key confirmation | Each done and dated |
| G-12 | Provider Mobile and Customer Web unread; impact register empty for two of four consumers | Both repositories read |
| G-13 | Two env files on the production host; neither documented as authoritative | Inventory written |
| G-14 | **No on-call rota.** The owner is on call for everything | A rota exists |
| G-15 | Behaviour change unannounced: an admin who opens a refund review can no longer approve it | Finance operators told |

---

## The three things to do first

1. **Fix the deploy** (G-01). Nothing else can reach production until a deploy
   completes, and today proved the alternative is a hand-built restart that
   production cannot then identify.
2. **Fix the portal deploy** (G-02). Four TABs of portal work are finished and
   invisible.
3. **Grant `refunds.mark_failed` and `payouts.trigger_due_run`** (G-05, G-06).
   Both are capabilities that exist, are tested, and are reachable by nobody —
   the cheapest gaps on this page and the ones most likely to be discovered
   during an incident.

## What a re-certification needs

Not more code. Rows 01, 05, 09, 11, 12 and 13 all need **production, a browser,
or a credential** — none of which is reachable from the build machine. The
engineering for the rows that could be done locally is done and gated; what
remains is deployment and observation.
