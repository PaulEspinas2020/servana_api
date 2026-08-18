#!/usr/bin/env bash
#
# Prove a deploy of this repository actually fixed what it claims to fix.
#
# Three defects are committed here and NOT yet in production. Each is a
# published, machine-readable contract that other platforms follow, so "it
# looks fine" is not a verification:
#
#   TAB 03  GET /api/catalog publishes a successor-version link pointing at
#           /api/v1/bookings/:bookingId. The catalog is not superseded by a
#           booking read.
#   TAB 04  Every v1 401 answers in the LEGACY envelope with no requestId,
#           while every v1 404/400 answers in the canonical one.
#   TAB 18  The origin serves no HSTS, nosniff, frame-deny or referrer policy.
#
# Usage:
#   scripts/verify-deploy.sh before        # run BEFORE deploying
#   scripts/verify-deploy.sh after         # run AFTER, prints a verdict
#   ORIGIN=https://staging... scripts/verify-deploy.sh before
#
# Read-only. Every request is a GET or an unauthenticated probe; nothing here
# can create a booking, a message or a ticket.
set -uo pipefail

ORIGIN="${ORIGIN:-https://api.servana.com.ph}"
PHASE="${1:-}"
OUT="${OUT_DIR:-/tmp/servana-deploy-verify}"

if [[ "$PHASE" != "before" && "$PHASE" != "after" ]]; then
  echo "usage: $0 {before|after}" >&2; exit 2
fi
mkdir -p "$OUT"
F="$OUT/$PHASE.txt"
: > "$F"

say() { printf '%s\n' "$*" | tee -a "$F"; }

say "origin      $ORIGIN"
say "phase       $PHASE"
say "captured    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say ""

# ── TAB 03 ───────────────────────────────────────────────────────────────────
say "=== TAB 03  successor-version signpost ==="
for p in /api/catalog /api/services /api/bookings /api/quote /api/catalog/summary /api/user/profile; do
  link=$(curl -sS -D - -o /dev/null -m 20 "$ORIGIN$p" 2>/dev/null \
         | tr -d '\r' | grep -i '^link:' | sed 's/^[Ll]ink: *//')
  say "$(printf '%-24s %s' "$p" "${link:-<no link>}")"
done
say ""

# ── TAB 04 ───────────────────────────────────────────────────────────────────
say "=== TAB 04  v1 error envelope ==="
say "401 body: $(curl -sS -m 20 "$ORIGIN/api/v1/me" 2>/dev/null | head -c 200)"
say "404 body: $(curl -sS -m 20 "$ORIGIN/api/v1/definitely-not-real-xyz" 2>/dev/null | head -c 200)"
say ""

# ── TAB 18 ───────────────────────────────────────────────────────────────────
say "=== TAB 18  security headers ==="
hdrs=$(curl -sS -D - -o /dev/null -m 20 "$ORIGIN/api/v1/catalog" 2>/dev/null | tr -d '\r')
for h in strict-transport-security x-content-type-options x-frame-options referrer-policy; do
  v=$(printf '%s\n' "$hdrs" | grep -i "^$h:" | sed "s/^[^:]*: *//")
  say "$(printf '%-30s %s' "$h" "${v:-<absent>}")"
done
say ""

# ── Regression guard: nothing else moved ─────────────────────────────────────
# Headers are additive metadata. A deploy that changes a STATUS is a different
# deploy from the one that was reviewed.
say "=== regression guard  status codes ==="
for p in /api/v1/catalog /api/v1/search /api/catalog /api/services /api/v1/me /api/v1/bookings; do
  say "$(printf '%-26s %s' "$p" "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 "$ORIGIN$p" 2>/dev/null)")"
done

say ""
say "written to $F"

# ── Verdict ──────────────────────────────────────────────────────────────────
if [[ "$PHASE" == "after" ]]; then
  echo
  echo "════════════ VERDICT ════════════"
  fail=0

  cat_link=$(printf '%s\n' "$(grep -m1 '^/api/catalog ' "$F")")
  if grep -q 'bookings/:bookingId' <<<"$cat_link"; then
    echo "FAIL  TAB 03  /api/catalog still points at the booking read"; fail=1
  elif grep -q '/api/v1/catalog' <<<"$cat_link"; then
    echo "PASS  TAB 03  /api/catalog points at the catalog"
  else
    echo "FAIL  TAB 03  unexpected: $cat_link"; fail=1
  fi

  if grep -q '401 body: .*"error"' "$F" && grep -q '401 body: .*requestId' "$F"; then
    echo "PASS  TAB 04  v1 401 carries the canonical envelope and a requestId"
  else
    echo "FAIL  TAB 04  v1 401 is still the legacy shape"; fail=1
  fi

  missing=0
  for h in strict-transport-security x-content-type-options x-frame-options referrer-policy; do
    grep -qE "^$h +<absent>" "$F" && { echo "FAIL  TAB 18  $h absent"; missing=1; }
  done
  [[ $missing -eq 0 ]] && echo "PASS  TAB 18  all four security headers present"
  [[ $missing -eq 1 ]] && fail=1

  if [[ -f "$OUT/before.txt" ]]; then
    echo
    echo "── status-code diff vs before (MUST be empty) ──"
    # Compare ONLY the status lines. The trailing "written to" line names the
    # file it was written to and therefore always differs — including it makes
    # the guard fire on every run, which is a guard that means nothing.
    statuses() { sed -n '/regression guard/,$p' "$1" | grep -E '^/api'; }
    if diff <(statuses "$OUT/before.txt") <(statuses "$F") > /dev/null; then
      echo "none — no status changed. Additive, as required."
    else
      echo "*** STATUS CODES MOVED — this deploy changed behaviour, not just headers ***"
      diff <(statuses "$OUT/before.txt") <(statuses "$F") || true
      fail=1
    fi
  else
    echo
    echo "NOTE  no before.txt — run '$0 before' next time; without it the"
    echo "      additive-only guarantee is asserted rather than measured."
  fi

  echo "═════════════════════════════════"
  exit $fail
fi
