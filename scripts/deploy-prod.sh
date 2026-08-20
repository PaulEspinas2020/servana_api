#!/usr/bin/env bash
#
# Deploy the current checkout to production. Run ON the production host.
#
# ## Why this is a script and not a workflow
#
# It used to be `.github/workflows/deploy.yml`, triggered by a push to main and
# executed on the self-hosted runner. That workflow is deleted: this platform no
# longer uses GitHub Actions for anything, on any repository, and Actions credit
# is not being topped up. Every step below is that workflow's, moved here
# verbatim along with the reasoning that justified each one — a deploy job is
# usually the only written record of the real deploy sequence, and deleting it
# without rescuing it would have thrown that away.
#
# The one thing the move genuinely changes: **a push no longer deploys.** The
# push lands the code; a human then runs this script on the box. That is a
# deliberate consequence of removing CI, not an oversight, and it is stated here
# so nobody pushes to main expecting production to move on its own.
#
# ## What replaced the checks the runner environment used to provide
#
# `verify-build-info.mjs` decides whether to be STRICT from `CI`,
# `GITHUB_ACTIONS`, `NODE_ENV=production` or an explicit `--strict`. With the
# workflow gone the first two are never set, so this script passes `--strict`
# itself. Without that, a build that cannot name its own commit would have
# started reaching production silently — the exact failure the stamp exists to
# prevent, reintroduced by removing CI rather than by any code change.
#
# `DB_PASSWORD` came from an Actions repo secret. It now comes from `.env`,
# which `migrations:plan`/`migrations:apply` read via `-r dotenv/config`. The
# check below is the replacement for the workflow's "Require DB_PASSWORD
# secret" step and fails just as loudly: the literal fallback that used to sit
# on that line was the production Postgres password in plaintext, committed and
# pushed, and there is deliberately no fallback of any kind now.
#
# `SERVANA_APPLY_DESTRUCTIVE` came from an Actions repo variable. Export it in
# the calling shell for a deploy that intends a destructive migration, with a
# backup taken. Do not export it permanently: that would authorise every future
# destructive migration too, which is the accident the guard exists to prevent.
#
# ## The paths are the CURRENT ones, not the workflow's
#
# The workflow's paths were the pre-move layout and are deliberately NOT copied.
# It ran on a self-hosted runner installed on the production box, with the app
# executing straight out of the runner's scratch directory
# (`/home/github-runner/actions-runner/_work/servana_api/servana_api`), and its
# secrets came from `/home/github-runner/env/`. That layout is exactly what took
# production down on 2026-08-19: step 3 `actions/checkout` deleted the `dist/`
# production was running from, the typecheck then failed, and build and restart
# never ran. The live process survived on code already in memory and then
# returned 502 on everything the moment it restarted.
#
# Production was moved to `/var/www/servana_api` that day. **Never point it back
# at a directory CI could write to** — see docs/DEPLOY_AND_GATE_POLICY.md.
#
# ## Everything external is injectable, so this can be rehearsed
#
#   APP_DIR    default the repository root (on the box: /var/www/servana_api)
#   ENV_SRC    default /etc/servana_api.env
#   KEY_SRC    default /etc/servana-serviceAccountKey.json — skipped if absent
#   RELEASES   default /home/github-runner/releases (matches scripts/rollback.sh)
#   PM2        default `sudo /usr/bin/pm2`
#   PM2_NAME   default servana-prod
#   SKIP_NGINX set to 1 to leave nginx alone
#
# Ordering is load-bearing and is asserted by
# `tests/deploy-is-direct-not-ci.test.ts` and
# `tests/destructive-migration-guard.test.ts`. Read those before reordering.

set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_SRC="${ENV_SRC:-/etc/servana_api.env}"
KEY_SRC="${KEY_SRC:-/etc/servana-serviceAccountKey.json}"
PM2="${PM2:-sudo /usr/bin/pm2}"
PM2_NAME="${PM2_NAME:-servana-prod}"

cd "$APP_DIR"

echo "== deploy =="
echo "  app dir    $APP_DIR"
echo "  pm2        $PM2 ($PM2_NAME)"
echo "  commit     $(git rev-parse --short HEAD 2>/dev/null || echo 'no git checkout')"
echo

# ── Secrets ──────────────────────────────────────────────────────────────────
#
# Copied only when the source exists. The workflow copied unconditionally, which
# was safe when it owned a scratch checkout and is NOT safe now: production runs
# from `/var/www/servana_api`, whose `.env` is the live one. Clobbering it with a
# stale `/etc/servana_api.env` would be a configuration change nobody asked for,
# during a deploy — and configuration was the leading hypothesis for the six-day
# outage. Absent source plus existing `.env` means "keep what is running".
echo "-> secrets"
if [ -f "$ENV_SRC" ]; then
  cp "$ENV_SRC" .env
  chmod 600 .env
elif [ ! -f .env ]; then
  echo "FATAL: neither $ENV_SRC nor $APP_DIR/.env exists." >&2
  exit 1
else
  echo "   $ENV_SRC absent; keeping the .env already in place."
fi

if [ -f "$KEY_SRC" ]; then
  cp "$KEY_SRC" servana-serviceAccountKey.json
  chmod 600 servana-serviceAccountKey.json
elif [ ! -f servana-serviceAccountKey.json ]; then
  # Not fatal. firebaseApp.ts resolves the credential lazily (fca1ed1), so the
  # process boots and only the Firebase-backed paths fail — which is a better
  # failure than refusing to deploy a fix for something unrelated.
  echo "   WARNING: no service-account key at $KEY_SRC and none in place;" >&2
  echo "   Firebase-backed routes will fail until one is installed." >&2
fi

# Document uploads must have an operational scanner. Until a managed scanner is
# configured, explicitly enable the repository's built-in signature/content
# scanner instead of letting every upload fail 503.
if ! grep -q '^PROVIDER_DOCUMENT_SCANNER_URL=.' .env || ! grep -q '^PROVIDER_DOCUMENT_SCANNER_TOKEN=.' .env; then
  grep -q '^ALLOW_BASELINE_DOCUMENT_SCAN=true$' .env || echo 'ALLOW_BASELINE_DOCUMENT_SCAN=true' >> .env
  echo "   warning: managed document scanner is not configured; using the built-in scanner."
fi

# Fails loudly rather than silently authenticating with a burned password.
if ! grep -qE '^DB_PASSWORD=.+' .env; then
  echo "FATAL: DB_PASSWORD is not set in $ENV_SRC." >&2
  echo "There is deliberately no fallback: the previous literal was the" >&2
  echo "production password in plaintext and is now rotated." >&2
  exit 1
fi

# ── Install ──────────────────────────────────────────────────────────────────
# --include=dev explicitly: jest and typescript are devDependencies, and if the
# host environment carries NODE_ENV=production then `npm ci` silently omits
# them — the checks below would then fail on a missing binary and read as a
# broken test suite rather than a missing install.
echo "-> install"
npm ci --prefer-offline --include=dev < /dev/null

# ── Cheap, host-specific checks ──────────────────────────────────────────────
# The FULL suite deliberately does not run here. It runs in the pre-push hook,
# on a machine with memory. `npm run verify` died twice on this host with exit
# 134 — SIGABRT, the V8 heap giving out: the suites run --runInBand so they
# accumulate in ONE process, and this box has 961 MB of RAM. Adding swap did not
# help; swap raises system memory, not the heap ceiling.
#
# More to the point, running it here is the wrong place. A gate exists to stop
# bad code REACHING the host, and by the time this script runs the code is
# already on it. What stays are the checks that are cheap and specific to this
# host: typechecking, generated-document drift, the secret scan, and the
# protected-contract guard — that last one catches a legacy route being removed,
# which is the failure this deploy could actually cause.
echo "-> checks"
npm run typecheck < /dev/null
npm run typecheck:tests < /dev/null
npm run api:docs:check < /dev/null
npm run security:secrets < /dev/null
npm run guard:protected-contracts < /dev/null

# ── Build ────────────────────────────────────────────────────────────────────
echo "-> build"
npm run build < /dev/null
# STRICT explicitly, because no CI environment variable sets it any more.
node scripts/verify-build-info.mjs --strict

# ── Migrations ───────────────────────────────────────────────────────────────
# Position is load-bearing: after the build, before the restart. This used to be
# the fifth step of the workflow — it ran before Node was even installed, so
# schema changes were applied to the production database before the code that
# needs them had been compiled, let alone tested. A failed build left production
# running old code against a migrated schema, and nothing said so.
#
# Applied by the repository's own runner, not by a bash loop. The loop this
# replaced kept its own ledger of `.done` marker FILES; `servana.schema_migrations`
# is the single source of truth and the two had already diverged.
# scripts/run-migrations.ts takes pg_advisory_lock('servana-controlled-migrations')
# so two deploys cannot migrate concurrently, hashes each migration and refuses
# to proceed if an APPLIED one has changed, and wraps each in one transaction
# with its ledger insert inside it.
#
# It also refuses any migration marked SERVANA:DESTRUCTIVE unless
# SERVANA_APPLY_DESTRUCTIVE names it.
echo "-> migrations (plan)"
# Printed before anything is applied, so the log records what was about to
# change even when the apply then fails.
npm run migrations:plan < /dev/null

echo "-> migrations (apply)"
# Passed through from the CALLING shell, never set here. It used to come from an
# Actions repo variable; hardcoding it in this file would authorise every future
# destructive migration instead of the one deploy that intends it. Logged either
# way, so the deploy record says whether a destructive migration was authorised
# and by what name.
if [ -n "${SERVANA_APPLY_DESTRUCTIVE:-}" ]; then
  echo "   DESTRUCTIVE migration authorised by the operator: $SERVANA_APPLY_DESTRUCTIVE"
else
  echo "   no destructive migration authorised (SERVANA_APPLY_DESTRUCTIVE unset)"
fi
SERVANA_APPLY_DESTRUCTIVE="${SERVANA_APPLY_DESTRUCTIVE:-}" npm run migrations:apply < /dev/null

# ── Restart ──────────────────────────────────────────────────────────────────
# Deliberately stop/delete/start rather than `pm2 reload`, which was considered
# on 2026-08-19 and rejected on measurement:
#
#  - `pm2 reload` is only zero-downtime in CLUSTER mode. There is no ecosystem
#    config here and the app is started with plain args, so it runs in fork
#    mode, where reload degrades to a restart and the gap remains.
#  - Moving to cluster mode would run startScheduler() (src/app.ts) in every
#    instance, and src/scheduler.ts has no single-instance guard, so every cron
#    tick would fire twice — far worse than the short 502 this sequence costs.
#  - The delete step is load-bearing: it exists because a previous deploy left
#    an EADDRINUSE crash loop.
echo "-> restart"
APP="$APP_DIR/dist/app.js"
$PM2 stop "$PM2_NAME" 2>/dev/null || true
$PM2 delete "$PM2_NAME" 2>/dev/null || true
$PM2 start "$APP" --name "$PM2_NAME"
$PM2 save --force

if [ "${SKIP_NGINX:-0}" != "1" ]; then
  echo "-> nginx"
  sudo systemctl reload nginx
fi

# ── Prove it serves, and recover if it does not ──────────────────────────────
# The workflow that actually ran had NO post-deploy probe, no rollback and no
# retention. All three existed only in the parked copy under
# `docs/pending-workflow/`, which could not be landed because the PAT lacked the
# `workflow` scope — so for as long as that file existed, this platform's
# rollback was a hypothesis rather than a capability. A script has no such
# restriction, which is the second reason this is a script.
echo "-> post-deploy probe"
if EXPECTED_COMMIT="$(git rev-parse HEAD 2>/dev/null || true)" bash scripts/post-deploy-readiness.sh; then
  PROBE_OK=1
else
  PROBE_OK=0
fi

if [ "$PROBE_OK" -ne 1 ]; then
  echo
  echo "!! the deployed build does not serve — rolling back" >&2
  RELEASES="${RELEASES:-/home/github-runner/releases}" PM2="$PM2" PM2_NAME="$PM2_NAME" \
    bash scripts/rollback.sh || true
  echo
  echo "Rollback restores the BUILD only. Applied migrations stay applied." >&2
  echo "Migrations run before the restart and are additive by policy, so the" >&2
  echo "previous build tolerates the newer schema — that is why that ordering" >&2
  echo "was chosen. A migration that is not backward-tolerable must not ship in" >&2
  echo "the same deploy as the code that needs it; that is a two-deploy change," >&2
  echo "and no script can enforce it. See docs/audits/TAB03_DEPLOY_GATING.md." >&2
  # A rollback is a recovered incident, not a successful deploy. Exiting 0 here
  # would hide that.
  exit 1
fi

# ── Retain, LAST, and only on success ────────────────────────────────────────
# Only after the probe accepted the build. Retaining one the probe rejected
# would make the next rollback restore the very build this deploy just rolled
# back from, and it would look like a recovery.
echo "-> retain this build, so the NEXT deploy can roll back to it"
RELEASES="${RELEASES:-/home/github-runner/releases}" KEEP="${KEEP:-3}" \
  bash scripts/snapshot-build.sh

echo
echo "== deployed $(git rev-parse --short HEAD 2>/dev/null || echo '(unknown commit)') =="
