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
    exit 0
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
