#!/usr/bin/env bash
#
# Restore the previously-running build, and say how long it took.
#
# ## Why this is a script and not a workflow step
#
# The rollback exists today only as inline YAML inside
# `docs/pending-workflow/deploy.yml`, a file that CANNOT be landed: the PAT
# lacks the `workflow` scope. So the automated rollback is blocked on a
# credential, and has been for as long as the parked file has existed.
#
# `scripts/` has no such restriction. Moving the logic here changes what is
# true about this platform right now: instead of "there is no rollback",
# there is one an operator can run by hand during an incident, and one that can
# be REHEARSED — which the inline version never could be, because rehearsing it
# meant deploying a deliberately broken build to production.
#
# When the workflow does land, its rollback step should call this script rather
# than restate it. One definition, rehearsed, in a file that can be tested.
#
# ## What it restores, and what it cannot
#
# The BUILD only. See `docs/ROLLBACK.md` — applied migrations stay applied, and
# `.env` is untouched, which matters more than it sounds: when production
# returned 500 on every database-backed read for six days, the leading
# hypothesis was configuration. A rollback would not have helped, and every
# code-level recovery would have failed while looking reasonable.
#
# ## Everything external is injectable, so this can be rehearsed
#
# PM2, the releases directory, the app directory and the port all come from the
# environment. That is not test scaffolding for its own sake: a recovery
# procedure nobody has executed is a hypothesis, and the only way to execute
# this one without a production incident is to let a rehearsal substitute its
# own process manager.
#
# Usage:
#   scripts/rollback.sh                 # restore and restart
#   scripts/rollback.sh --dry-run       # say what it would do, touch nothing
#
# Env:
#   RELEASES   default /home/github-runner/releases
#   APP_DIR    default the repository root
#   PM2        default `sudo /usr/bin/pm2`
#   PM2_NAME   default servana-prod
#   PORT       default from .env, else 3000
#   DEADLINE   seconds to wait for health, default 60
set -uo pipefail

RELEASES="${RELEASES:-/home/github-runner/releases}"
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PM2="${PM2:-sudo /usr/bin/pm2}"
PM2_NAME="${PM2_NAME:-servana-prod}"
DEADLINE="${DEADLINE:-60}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

PREVIOUS="$RELEASES/previous"

if [ -z "${PORT:-}" ]; then
  PORT="$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r' || true)"
fi
PORT="${PORT:-3000}"

echo "rollback"
echo "  releases   $RELEASES"
echo "  app dir    $APP_DIR"
echo "  pm2        $PM2 ($PM2_NAME)"
echo "  port       $PORT"

# A rollback with nothing to roll back to is a script, not a recovery. Checked
# FIRST and loudly: discovering this mid-incident, after stopping the running
# process, would turn a bad deploy into an outage.
if [ ! -d "$PREVIOUS" ]; then
  echo ""
  echo "  NO PREVIOUS BUILD AT $PREVIOUS"
  echo ""
  echo "  There is nothing to restore. Do not stop the running process — it is"
  echo "  serving, badly or otherwise, and stopping it makes this worse."
  echo "  The deploy pipeline must snapshot dist/ BEFORE npm run build overwrites it."
  exit 2
fi

RESTORING="$(node -e 'try{process.stdout.write(require(process.argv[1]).commit||"unknown")}catch(e){process.stdout.write("unstamped")}' "$PREVIOUS/BUILD_INFO.json" 2>/dev/null || echo unstamped)"
CURRENT="$(node -e 'try{process.stdout.write(require(process.argv[1]).commit||"unknown")}catch(e){process.stdout.write("unstamped")}' "$APP_DIR/dist/BUILD_INFO.json" 2>/dev/null || echo unstamped)"
echo "  currently  $CURRENT"
echo "  restoring  $RESTORING"

if [ "$DRY_RUN" = "1" ]; then
  echo ""
  echo "  --dry-run: nothing was changed."
  exit 0
fi

if [ "$RESTORING" = "$CURRENT" ]; then
  # Not fatal — an operator may be recovering from something other than a bad
  # build — but it is almost always a snapshot that was never refreshed, and
  # rolling "back" onto the same commit would look like a recovery and be none.
  echo "  ::warning:: the snapshot is the SAME commit that is running. This rollback changes no code."
fi

START=$(date +%s)

rm -rf "$APP_DIR/dist"
cp -a "$PREVIOUS" "$APP_DIR/dist"

$PM2 stop "$PM2_NAME" 2>/dev/null || true
$PM2 delete "$PM2_NAME" 2>/dev/null || true
$PM2 start "$APP_DIR/dist/app.js" --name "$PM2_NAME"
$PM2 save --force 2>/dev/null || true

code=000
for _ in $(seq 1 $(( DEADLINE / 3 + 1 ))); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  sleep 3
done

END=$(date +%s)
ELAPSED=$((END - START))

if [ "$code" != "200" ]; then
  echo ""
  echo "  ROLLBACK DID NOT RECOVER after ${ELAPSED}s — /healthz returned ${code}"
  echo "  Manual intervention required. The previous build was restored to disk;"
  echo "  the process did not come back. Check pm2 logs $PM2_NAME."
  exit 1
fi

# Ask the RUNNING PROCESS what it is, not the file on disk. Those differ exactly
# when the restart did not take, which is the failure this whole path exists for.
SERVING="$(curl -s --max-time 5 "http://127.0.0.1:${PORT}/api/v1/health" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).data.commit))}catch(e){process.stdout.write("unreadable")}})' 2>/dev/null || echo unreadable)"

echo ""
echo "  RECOVERED in ${ELAPSED}s"
echo "  serving    $SERVING"
if [ "$SERVING" != "$RESTORING" ] && [ "$RESTORING" != "unstamped" ]; then
  echo "  ::warning:: expected to be serving $RESTORING. The restart may not have taken."
fi
echo ""
echo "  ROLLBACK_DURATION_SECONDS=${ELAPSED}"
echo "  Production is serving the PREVIOUS build. This is a recovered incident,"
echo "  not a successful deploy. Applied migrations stay applied; .env is unchanged."
exit 0
