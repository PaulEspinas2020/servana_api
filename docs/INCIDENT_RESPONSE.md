# Incident response

> Written during an incident, from four real ones, on 2026-08-19. Every failure
> mode below has actually happened to this system — none is imagined, and the
> first actions are the ones that would have saved the most time on the day.

## The rule this document exists to break

Three of today's four incidents shared a shape: **the signal existed and nothing
read it**, or **no signal existed at all**. A control that has never been
exercised is a hypothesis, and the moment you discover it is a hypothesis is the
incident.

So: every entry names a **first action**, and the first action is the one that
restores service or eliminates the largest branch — not the one that satisfies
curiosity. The wrong first action costs more than no action.

---

## Severity

| Sev | Meaning | Example from today |
| --- | --- | --- |
| **SEV1** | Customers or providers cannot transact. The API is down or money is moving wrongly | API returned 502 on every path, 13:36–? UTC |
| **SEV2** | A major surface is broken but the platform functions | Catalog and search 500 for over a day while `/healthz` said 200 |
| **SEV3** | Degraded, with a workaround | Token refresh 502 — sessions end at one hour instead of renewing |
| **SEV4** | No user impact, but a control is not working | Deploys failing at typecheck; no release possible |

**A SEV3 nobody can see is still a SEV3.** Token refresh was broken for every
client — admin portal, both mobile apps, provider web — and nobody filed a bug,
because the symptom is "I got logged out", which people blame on themselves.

## On call

No rota exists. **Name one.** Until then the owner is on call for everything,
which is the arrangement that produced a day-long SEV2.

---

## First actions by symptom

### Every path returns 502

**First action: `pm2 list` and `pm2 logs --lines 200` on the host.** nginx
answering 502 in ~0.1s means nginx is healthy and the Node process is not
answering. Restart it; read the log *after* service is restored, not before.

Then, before assuming a release caused it, **check whether one ran**:

```
curl -s "https://api.github.com/repos/PaulEspinas2020/servana_api/actions/runs?per_page=5" \
  | python3 -c "import json,sys; [print(r['head_sha'][:8], r['name'], r['event'], r['conclusion'], r['created_at']) for r in json.load(sys.stdin)['workflow_runs']]"
```

On 2026-08-19 this eliminated the whole "bad deploy" branch in one command: the
last *successful* deploy was 09:33 UTC and the two runs since had **failed**, so
nothing shipped in the window. Rolling back would have wasted the hour.

**Restart it into a working environment or it comes straight back degraded** —
see the next two entries. A restart that restores 200s on `/healthz` while
`/readyz` still says 503 has not fixed anything a customer can feel.

### Catalog, search or any data read returns 500 — but `/healthz` is 200

**First action: `curl -s https://api.servana.com.ph/readyz`.** Liveness is not
readiness. `/readyz` names the failing dependency and the reason, and on
2026-08-19 it had been printing the answer for over a day:

```
phase=degraded ready=false live=true
  required admin-permission-seed: failed
    SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string
```

That string means **`DB_PASSWORD` is unset, empty, or not a string** in the
running process's environment. It is an environment fix, not a code fix, and a
deploy will not repair it — a deploy restarts into the same environment.

Failures are at boot, so **it will not self-heal**.

If `/readyz` is healthy and reads still fail, the next branch is schema drift:
`npm run db:skew` replays the migration chain in PGlite and fails if source
names a relation the chain never builds. Read-only diagnosis on the host is
`npm run db:diagnose`.

### Nobody can stay signed in / everyone is logged out after about an hour

**First action: `curl -s -X POST https://api.servana.com.ph/api/auth/refresh -H 'Content-Type: application/json' -d '{"refreshToken":"x"}'`.**

`502 REFRESH_UNAVAILABLE` means **`API_KEY` is unset**. `refreshIdToken` raises
that exactly one way, and its own comment says why it is not a 401:
*"Misconfiguration, not a client error. Answering 401 here would tell every app
in the field to sign its user out because of a missing env var."*

Every client is affected. The symptom nobody reports is the one to watch for: a
correct client refuses to discard a session on a 502, then presents a token the
server rejects, and the user is simply signed out.

### A spike in 404s on `/api/v1`

**First action: deploy or roll back — do not go looking for a broken route.**

This is the signature of a portal deployed against a backend that has not
shipped, and it has happened here. `contract_mismatch_total` carries namespace
and client labels so you can see **which build is ahead**. The route is not
broken; the two sides are at different commits, and every minute spent reading
route tables is a minute the mismatch persists.

### A payout batch misfires

**First action: stop the scheduler before investigating.** `payouts.trigger_due_run`
is `is_dangerous: true`. `processPendingDisbursements` reports
`{selected, attempted, threw}` — read `threw` first, because a partial batch is
worse than a failed one and the difference is in that number.

Every payout action is audited on success *and* failure. Reconcile from
`finance_ledger_events`, never from a screen.

### A refund is stuck and cannot be retried

`openRefundReview` refuses a second review while one is `requested` or
`approved`, so a refund the processor rejected **blocks every retry for that
booking**. Move it to the `failed` terminal:

```
POST /api/admin/finance/refunds/:refundId/mark-failed   { "failureReason": "..." }
```

Needs `refunds.mark_failed`. `failed` is deliberately distinct from `rejected`:
rejected means a human decided against it, failed means everyone agreed and the
money did not move — only the second is worth retrying.

Note that **an admin cannot approve a refund they themselves requested**. A
second admin is required; the refusal is audited as
`finance_refund_self_approval_refused`. If that is blocking an urgent refund out
of hours, `REFUND_ALLOW_SELF_APPROVAL=true` lifts it and every approval taken
under it is audited with `selfApprovalAllowedByConfig`. Prefer finding a second
admin.

### A deploy shipped past a red gate

**First action: establish which commit is actually serving**, then decide.

`GET /api/v1/health` returns the build provenance `deploy.yml` stamps — commit,
ref, built-at, run. Three answers, three meanings:

* **404** — the running build predates the endpoint. Production is older than
  you think, and that is the answer.
* **200 with `available: false`** — `dist/BUILD_INFO.json` is missing. It means
  the running artefact was built before the stamper existed, or by something
  other than `npm run build`. As of 2026-08-20 production still answers this,
  so **"what commit is serving?" is not answerable from outside yet**. There is
  no Actions run list to fall back on either: CI is gone. Ask the box —
  `ssh root@192.46.224.126 'cd /var/www/servana_api && git rev-parse HEAD'` —
  and note that this tells you what is CHECKED OUT, not what the live process
  loaded, which is exactly the ambiguity the stamp exists to remove.
  The next run of `scripts/deploy-prod.sh` fixes it: it builds, and the build
  stamps.
* **200 with a commit** — believe it, and compare it to `origin/main`.

The middle case is worth naming because it is the one that looks like a working
endpoint. A hand-built deploy is invisible to the mechanism built to identify
deploys, so the question "what is serving?" becomes unanswerable at exactly the
moment somebody is most likely to ask it.

### The portal is blank, or a screen renders nothing

**First action: open the browser console and look for a CSP violation**, not the
network tab. A blocked script fails silently in the network view and loudly in
the console. `netlify.toml` owns the policy. The security headers live in the `/*` block at
the bottom of that file; the `/*.html` block above it now carries only
`Cache-Control`. That split is the fix for a real defect: **Netlify matches
header rules against the REQUESTED path, not the rewritten one**, so a policy
scoped to `.html` never fired for `/` or `/portal/bookings` — only for
`/index.html`, which nobody navigates to. The portal that approves refunds and
releases payouts ran with no CSP at all for a period. If headers go missing
again, check which block they are in before checking anything else.

### A deploy fails and nothing ships

`Typecheck (source and tests)` exiting **134** is SIGABRT — out of memory. That
step peaks at **~650 MB on a 961 MB host that is simultaneously serving
production**. It is redundant with `scripts/hooks/pre-push`, which runs the full
`npm run verify` before any push reaches GitHub. Fix in
[docs/pending-workflow/deploy-typecheck-oom.md](pending-workflow/deploy-typecheck-oom.md).

---

## What to check before declaring an incident over

1. `/healthz` **and** `/readyz` — the second is the one that means "working".
2. One real read: `GET /api/v1/catalog` should be 200, not 500.
3. One real refusal: `GET /api/v1/nope` should be 404 in the v1 error envelope,
   which proves the v1 router is mounted rather than the whole app being a proxy
   error.
4. Token refresh: a bogus token should get **401**, not 502.
5. `GET /api/v1/health` — confirm the commit serving is the one you expect.

A green `/healthz` alone has already been mistaken for recovery once.

## After every incident

Write down **what signal would have caught this, and whether it existed**. Today
produced three different answers to that question, and they need different fixes:

| Incident | Signal | Fix |
| --- | --- | --- |
| Catalog 500s | `/readyz` said it, for a day | Something must *read* it — `deploy:verify` now does |
| Refresh 502 | None. `API_KEY` was in no list | Declare every variable — `tests/env-schema-completeness.test.ts` |
| Full 502 | None. Nothing watched either origin | Uptime monitoring on both origins (V12.7) |

**Resolution, recorded the same day.** Service returned at ~14:0x UTC via a
manual restart on the host with a corrected environment — `/readyz` came back
`phase=ready`, catalog reads returned 200, and a bogus refresh token got a 401
instead of a 502, so `DB_PASSWORD` and `API_KEY` were both set in the same pass.
No deploy ran; the Actions run list still ends at 09:33 UTC.

**The cause of the 502 itself was never established**, and this table says so
rather than inventing one. What is known is that no release was involved, and
that nothing was watching either origin — so the outage was found by a person
looking, which is the part uptime monitoring fixes regardless of the cause.
