#!/usr/bin/env bash
#
# Did the process that just restarted actually come back able to serve?
#
# ## The gap this closes
#
# `deploy.yml` ends at `pm2 start`. Nothing afterwards asks whether the process
# came back healthy, so a deploy that leaves production unable to reach its
# database reports success and keeps serving 500s until somebody notices by
# hand. That is not hypothetical: on 2026-08-19 every catalog read returned 500
# for over a day while `/healthz` returned 200 throughout, because liveness is
# not readiness — the process was up, it simply could not authenticate to
# Postgres:
#
#     SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string
#
# `/readyz` had been reporting that exact string, with the failing dependency
# named, the whole time. Nothing read it.
#
# ## Local only, deliberately
#
# Probes `127.0.0.1`, never the public origin. The deploy runs on a self-hosted
# runner ON the production host, so localhost is the process this deploy just
# started — the public origin may be served by a proxy, a cache or another
# instance, and a green probe there would prove the wrong thing.
#
# ## Read-only
#
# Two GETs. It cannot create a booking, a message or a ticket.
#
# Usage:  scripts/post-deploy-readiness.sh [port] [timeout_seconds]
set -uo pipefail

PORT="${1:-${PORT:-3000}}"
DEADLINE="${2:-90}"
BASE="http://127.0.0.1:${PORT}"

# ─────────────────────────────────────────────────────────────────────────────
# Does the process that just restarted serve the commit this deploy built?
#
# Readiness proves it can serve. It does not prove it is serving THIS build, and
# those come apart in a way that has already happened here: a deploy whose
# migration step fails stops short of the PM2 restart, so the workflow's earlier
# steps go green, the old process keeps answering, and from the outside a deploy
# that silently did not restart is indistinguishable from one that did.
#
# `dist/BUILD_INFO.json` is stamped by `npm run build`, and `/api/v1/health`
# serves it. Comparing the two answers "is the running process the artefact we
# just made?" — which is the question a deploy log cannot otherwise be asked.
#
# EXPECTED_COMMIT is the commit the deploy checked out (GITHUB_SHA). When it is
# unset — a hand-run on the host — the probe still asserts that provenance is
# AVAILABLE, because `available:false` means the running build cannot name
# itself at all, and that is worth failing on whether or not we know what it
# should have been.
check_provenance() {
  local expected="${EXPECTED_COMMIT:-${GITHUB_SHA:-}}"
  local body
  body="$(curl -sS -m 5 "${BASE}/api/v1/health" 2>/dev/null)"

  local available commit
  available="$(printf '%s' "$body" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("data",{}).get("available"))
except Exception: print("unreadable")' 2>/dev/null)"
  commit="$(printf '%s' "$body" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("data",{}).get("commit"))
except Exception: print("")' 2>/dev/null)"

  if [ "$available" != "True" ]; then
    echo ""
    echo "  DEPLOY FAILED PROVENANCE — /api/v1/health reports available=${available}"
    echo ""
    echo "  The running build cannot say which commit it is. dist/BUILD_INFO.json"
    echo "  is absent from the artefact this process is serving, which means either"
    echo "  the build step did not stamp it or PM2 did not restart onto the new"
    echo "  dist. Both look exactly like a successful deploy from outside."
    return 1
  fi

  if [ -n "$expected" ] && [ "$commit" != "$expected" ]; then
    echo ""
    echo "  DEPLOY FAILED PROVENANCE — serving the wrong commit"
    echo "    built:   ${expected}"
    echo "    serving: ${commit}"
    echo ""
    echo "  The restart did not take. The previous build is still answering, and"
    echo "  every step of this deploy before now reported success."
    return 1
  fi

  echo "  provenance ok — serving ${commit}"
  return 0
}

# Provenance alone, without waiting out readiness.
#
# Two callers want this. An operator asking "what is actually serving right now?"
# should not have to satisfy a readiness deadline to find out — and during an
# incident readiness is exactly what is failing, which is when the question is
# asked most. And a test can exercise the provenance assertion without standing
# up a database.
if [ "${PROVENANCE_ONLY:-}" = "1" ]; then
  check_provenance
  exit $?
fi

echo "post-deploy readiness: ${BASE}, up to ${DEADLINE}s"

started=$(date +%s)
attempt=0
last_body=""

while :; do
  attempt=$((attempt + 1))
  # `|| echo 000` would APPEND to curl's own "000" on failure and print
  # "000000", which reads like a status code and is not one.
  code=$(curl -sS -o /tmp/readyz.$$ -w '%{http_code}' -m 5 "${BASE}/readyz" 2>/dev/null)
  code="${code:-000}"
  last_body="$(cat /tmp/readyz.$$ 2>/dev/null)"

  if [ "$code" = "200" ]; then
    echo "  ready after ${attempt} attempt(s)"
    rm -f /tmp/readyz.$$
    check_provenance
    exit $?
  fi

  now=$(date +%s)
  if [ $((now - started)) -ge "$DEADLINE" ]; then
    break
  fi
  # A restarting process legitimately answers 000 or 503 for a few seconds.
  sleep 3
done

rm -f /tmp/readyz.$$
echo ""
echo "  DEPLOY FAILED READINESS after ${DEADLINE}s — /readyz returned ${code}"
echo ""

# The snapshot names the dependency and the error. Print it: a failure that does
# not say what failed sends somebody to the logs for something already in hand.
if [ -n "$last_body" ]; then
  echo "$last_body" | python3 -c '
import json, sys
# No backslashes inside f-string expressions: Python 3.9 rejects them, and the
# host runtime is not ours to assume. Plain concatenation works everywhere.
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print("  phase=" + str(d.get("phase")) + "  ready=" + str(d.get("ready")) + "  live=" + str(d.get("live")))
for dep in d.get("dependencies", []):
    if dep.get("state") != "ready":
        print("    " + str(dep.get("kind", "?")).ljust(9) + " " + str(dep.get("name")) + ": " + str(dep.get("state")))
        err = dep.get("error")
        if err:
            print("              " + str(err))
' 2>/dev/null || echo "$last_body" | head -c 600
fi

echo ""
echo "  The process may be LIVE and still unable to serve. /healthz only proves"
echo "  it is running. Do not treat this deploy as successful."
exit 1
