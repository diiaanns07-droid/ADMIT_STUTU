#!/usr/bin/env bash
# Export R07 commits (owned paths only) from the CODE_BASE_SHA worktree into ADMIT_STUTU results.
set -euo pipefail
BASE=56538a3a7504d4589c38ab4d3c5107f12aa7f8a6
WT=/home/user/gov_r07
OUT=/home/user/ADMIT_STUTU/research/round-12-results/R07
OWNED=(engine/civic_scenarios web/civic/scenarios tests/civic/R07 tests/civic/test_citywide_osm.py data/civic/astana/osm-walking web/civic/map/streets.json)
cd "$WT"
# refuse if any commit touches a path outside the owned list
outside=$(git diff --name-only "$BASE"..HEAD | grep -v -E '^(engine/civic_scenarios/|web/civic/scenarios/|tests/civic/R07/|tests/civic/test_citywide_osm.py$|data/civic/astana/osm-walking/|web/civic/map/streets.json$)' || true)
if [ -n "$outside" ]; then echo "OUTSIDE OWNED PATHS: $outside" >&2; exit 1; fi
git format-patch --stdout "$BASE"..HEAD -- "${OWNED[@]}" > "$OUT/r07-round12.patch"
git diff --stat "$BASE"..HEAD > "$OUT/r07-round12.diffstat.txt"
echo "head=$(git rev-parse HEAD)" > "$OUT/r07-round12.patch.info"
echo "base=$BASE" >> "$OUT/r07-round12.patch.info"
echo "patch_sha256=$(sha256sum "$OUT/r07-round12.patch" | cut -d' ' -f1)" >> "$OUT/r07-round12.patch.info"
git log --oneline "$BASE"..HEAD >> "$OUT/r07-round12.patch.info"
# verify: patch applies cleanly on a fresh detached checkout of BASE
TMP=$(mktemp -d)
git worktree add -q --detach "$TMP/wt" "$BASE"
( cd "$TMP/wt" && git -c user.name=v -c user.email=v@v am -q "$OUT/r07-round12.patch" && git diff --quiet HEAD "$(git -C "$WT" rev-parse HEAD)" -- "${OWNED[@]}" && echo "PATCH_VERIFY: applies on $BASE and reproduces worktree HEAD for owned paths" )
git worktree remove --force "$TMP/wt"; rm -rf "$TMP"
cat "$OUT/r07-round12.patch.info"
