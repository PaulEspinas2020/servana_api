#!/usr/bin/env bash
#
# Keep the build that just PROVED itself, so the next deploy has somewhere to
# fall back to.
#
# ## The defect this exists to fix
#
# `docs/pending-workflow/deploy.yml` snapshotted the RUNNING build at the start
# of a deploy, after checkout and before `npm run build` overwrote `dist/`. That
# cannot work, and would have failed silently every single run:
#
#   - `dist` is gitignored (.gitignore:109)
#   - `actions/checkout@v4` defaults to `clean: true`, which runs `git clean
#     -ffdx` — and `-x` removes ignored files. Verified: `git clean -ffdxn --
#     dist` prints "Would remove dist/".
#   - the snapshot step ran at line 169; checkout at line 70.
#
# So by the time the snapshot ran there was no `dist/` to copy. It would have
# taken its `::warning::no dist/ to snapshot` branch on every deploy, and the
# rollback below it would have hit "there is NO previous build to restore" every
# time it was ever needed.
#
# That is what "a rollback that has never been executed is a hypothesis" buys
# you in practice: not a risky recovery, an absent one that reads as present.
#
# ## The ordering that does work
#
# Snapshot the build that has just PASSED its post-deploy probe, at the END of a
# successful deploy. It becomes `previous` for the NEXT one. That is robust to
# the workspace being cleaned, and it has a property the original ordering did
# not: what is retained is a build known to have served traffic, rather than
# whatever happened to be on disk.
#
# The cost is stated plainly: the first deploy after this lands has no snapshot
# and therefore no rollback. There is no way around that — a known-good build
# has to be proven once before it can be kept.
#
# Usage:  scripts/snapshot-build.sh
# Env:    RELEASES  default /home/github-runner/releases
#         APP_DIR   default the repository root
#         KEEP      how many timestamped copies to retain besides `previous`, default 3
set -uo pipefail

RELEASES="${RELEASES:-/home/github-runner/releases}"
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
KEEP="${KEEP:-3}"
DIST="$APP_DIR/dist"

if [ ! -d "$DIST" ]; then
  echo "::error::no $DIST to snapshot. Nothing was retained, so the next deploy has no rollback."
  exit 1
fi

# A build that cannot name itself is not worth keeping as the thing you would
# restore to: mid-incident you would have no way to tell what you rolled back onto.
COMMIT="$(node -e 'try{process.stdout.write(require(process.argv[1]).commit||"")}catch(e){process.stdout.write("")}' "$DIST/BUILD_INFO.json" 2>/dev/null || true)"
if [ -z "$COMMIT" ]; then
  echo "::error::$DIST/BUILD_INFO.json names no commit. Refusing to retain an unidentifiable build."
  exit 1
fi

mkdir -p "$RELEASES" 2>/dev/null || sudo mkdir -p "$RELEASES"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Written aside then moved, so an interrupted copy cannot leave `previous` as a
# half-written directory that a later rollback would restore with confidence.
TMP="$RELEASES/.incoming-$STAMP"
rm -rf "$TMP"
cp -a "$DIST" "$TMP"
rm -rf "$RELEASES/previous"
mv "$TMP" "$RELEASES/previous"
cp -a "$RELEASES/previous" "$RELEASES/$STAMP-$COMMIT"

echo "retained $COMMIT as $RELEASES/previous (and $STAMP-$COMMIT)"

# Oldest first, keep the newest $KEEP. `previous` is never a candidate.
#
# Counted and then `head -n "$drop"`, NOT `head -n -"$KEEP"`. The negative form
# is a GNU extension: BSD/macOS `head` rejects it with "illegal line count", the
# pipeline prints an error nobody reads, and pruning silently does nothing while
# the retention directory grows without bound.
#
# Found by rehearsing this script rather than by reviewing it — the deploy host
# is Linux and would have worked, so this would have shipped and only ever bitten
# whoever tried to rehearse it on a laptop. That is the same shape as the two
# cross-platform gate defects this repository has already fixed.
kept="$(ls -1d "$RELEASES"/2*-* 2>/dev/null | sort || true)"
if [ -n "$kept" ]; then
  total="$(printf '%s\n' "$kept" | wc -l | tr -d ' ')"
  drop=$(( total - KEEP ))
  if [ "$drop" -gt 0 ]; then
    printf '%s\n' "$kept" | head -n "$drop" | while read -r old; do
      rm -rf "$old" && echo "  pruned $(basename "$old")"
    done
  fi
fi
exit 0
