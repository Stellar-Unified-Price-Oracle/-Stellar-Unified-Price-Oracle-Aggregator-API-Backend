#!/usr/bin/env sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

npm run generate:api-client
npm run generate:sdks

if ! git diff --quiet -- api/openapi.json sdk/src/generated sdk/generated; then
  echo "ERROR: Generated SDK artifacts are out of date."
  echo "Run 'npm run generate:api-client' and 'npm run generate:sdks' and commit the changes."
  git diff --stat -- api/openapi.json sdk/src/generated sdk/generated
  exit 1
fi

echo "Generated SDK artifacts are up to date."

# ---------------------------------------------------------------------------
# Reproducible release build verification (issue #752)
#
# Rebuilds release artifacts from a given git tag in a clean checkout, hashes
# them, and compares the hashes against the published artifacts for that tag.
# Exits non-zero on any mismatch so it can be wired into CI or run locally.
#
# Usage:
#   scripts/check-generated.sh --verify-release <tag> [--published-dir <dir>]
#
#   <tag>            Git tag to rebuild (e.g. v1.4.0).
#   --published-dir  Directory containing the published artifacts to compare
#                    against. Defaults to $REPRO_PUBLISHED_DIR, or
#                    ./dist/published/<tag> if set/downloaded.
#
# Environment:
#   REPRO_PUBLISHED_DIR  Default published-artifacts directory.
#   REPRO_WORK_DIR       Scratch directory for the clean rebuild
#                        (default: a fresh mktemp dir).
#   REPRO_ARTIFACT_GLOB  Glob (relative to repo root) selecting artifacts to
#                        hash. Default: "dist/*".
#
# Exit codes:
#   0  Rebuild succeeded and all artifact hashes match the published set.
#   1  Hash mismatch, missing artifact, or extra artifact.
#   2  Usage / environment error (bad tag, missing published dir, etc.).
#
# Mismatch investigation guidance (see docs/reproducible-builds.md):
#   1. Confirm the tag resolves to the expected commit:
#        git rev-parse <tag>^{commit}
#   2. Diff the rebuild's build inputs against the published build:
#        - lockfile (package-lock.json) and toolchain versions
#          (node --version, npm --version)
#        - SOURCE_DATE_EPOCH and any embedded build timestamps
#        - absolute paths, hostnames, or usernames embedded in artifacts
#   3. Re-run with REPRO_WORK_DIR set to a stable path to rule out path
#      leakage, and with a fixed SOURCE_DATE_EPOCH to rule out timestamps.
#   4. If only metadata differs, check for non-deterministic ordering
#      (file globbing, map iteration) in the build pipeline.
#   5. If the published artifact cannot be reproduced from the tagged
#      source, treat it as a supply-chain incident: open a security issue,
#      quarantine the artifact, and do not promote it to stable.
# ---------------------------------------------------------------------------

verify_release() {
  tag=""
  published_dir="${REPRO_PUBLISHED_DIR:-}"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --published-dir)
        [ "$#" -ge 2 ] || { echo "ERROR: --published-dir requires a value" >&2; exit 2; }
        published_dir="$2"
        shift 2
        ;;
      --published-dir=*)
        published_dir="${1#*=}"
        shift
        ;;
      -*)
        echo "ERROR: unknown option for --verify-release: $1" >&2
        exit 2
        ;;
      *)
        if [ -n "$tag" ]; then
          echo "ERROR: --verify-release accepts a single tag" >&2
          exit 2
        fi
        tag="$1"
        shift
        ;;
    esac
  done

  if [ -z "$tag" ]; then
    echo "ERROR: --verify-release requires a tag" >&2
    exit 2
  fi

  if ! git rev-parse --verify --quiet "${tag}^{commit}" >/dev/null; then
    echo "ERROR: tag '$tag' does not resolve to a commit" >&2
    exit 2
  fi

  if [ -z "$published_dir" ]; then
    published_dir="$ROOT/dist/published/$tag"
  fi

  if [ ! -d "$published_dir" ]; then
    echo "ERROR: published artifacts directory not found: $published_dir" >&2
    echo "Download the published artifacts for '$tag' or pass --published-dir." >&2
    exit 2
  fi

  artifact_glob="${REPRO_ARTIFACT_GLOB:-dist/*}"

  work_dir="${REPRO_WORK_DIR:-}"
  cleanup_work=""
  if [ -z "$work_dir" ]; then
    work_dir=$(mktemp -d)
    cleanup_work="$work_dir"
  else
    mkdir -p "$work_dir"
  fi

  cleanup() {
    if [ -n "$cleanup_work" ] && [ -d "$cleanup_work" ]; then
      rm -rf "$cleanup_work"
    fi
  }
  trap cleanup EXIT INT TERM

  checkout_dir="$work_dir/src"
  rebuild_dir="$work_dir/rebuild"

  echo "==> Verifying reproducible build for tag: $tag"
  echo "    commit:        $(git rev-parse "${tag}^{commit}")"
  echo "    work dir:      $work_dir"
  echo "    published dir: $published_dir"

  rm -rf "$checkout_dir" "$rebuild_dir"
  mkdir -p "$checkout_dir" "$rebuild_dir"

  # Clean checkout of the tagged source (no working-tree changes, no untracked).
  git archive --format=tar "$tag" | tar -x -C "$checkout_dir"

  # Deterministic build environment.
  export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct "${tag}^{commit}")}"
  export TZ=UTC
  export LC_ALL=C

  echo "==> Building from clean checkout (SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH)"
  (
    cd "$checkout_dir"
    if [ -f package-lock.json ]; then
      npm ci --no-audit --no-fund
    else
      npm install --no-audit --no-fund
    fi
    npm run build
  )

  # Collect rebuilt artifacts into a flat directory for hashing.
  echo "==> Collecting rebuilt artifacts matching: $artifact_glob"
  (
    cd "$checkout_dir"
    # shellcheck disable=SC2086
    for f in $artifact_glob; do
      [ -f "$f" ] || continue
      dest="$rebuild_dir/$(basename "$f")"
      cp "$f" "$dest"
    done
  )

  if [ -z "$(ls -A "$rebuild_dir" 2>/dev/null)" ]; then
    echo "ERROR: rebuild produced no artifacts matching '$artifact_glob'" >&2
    exit 2
  fi

  hash_dir() {
    dir="$1"
    (
      cd "$dir"
      # Sort for stable ordering; hash filenames and contents.
      find . -maxdepth 1 -type f -print | LC_ALL=C sort | while IFS= read -r f; do
        name=$(basename "$f")
        sum=$(sha256sum "$f" | cut -d' ' -f1)
        printf '%s  %s\n' "$sum" "$name"
      done
    )
  }

  rebuilt_hashes="$work_dir/rebuilt.sha256"
  published_hashes="$work_dir/published.sha256"

  hash_dir "$rebuild_dir" > "$rebuilt_hashes"
  hash_dir "$published_dir" > "$published_hashes"

  echo "==> Comparing artifact hashes"
  if diff -u "$published_hashes" "$rebuilt_hashes" > "$work_dir/hash-diff.txt"; then
    echo "OK: rebuilt artifacts match published artifacts for $tag"
    cat "$rebuilt_hashes"
    exit 0
  fi

  echo "ERROR: rebuilt artifacts do NOT match published artifacts for $tag" >&2
  echo "--- published (expected) vs rebuilt (actual) ---" >&2
  cat "$work_dir/hash-diff.txt" >&2
  echo "" >&2
  echo "Investigation guidance:" >&2
  echo "  1. Confirm tag commit: git rev-parse ${tag}^{commit}" >&2
  echo "  2. Check lockfile and toolchain versions (node/npm) match the release." >&2
  echo "  3. Re-run with a fixed SOURCE_DATE_EPOCH and REPRO_WORK_DIR to rule out" >&2
  echo "     timestamp and path leakage." >&2
  echo "  4. Look for non-deterministic ordering in the build pipeline." >&2
  echo "  5. If the published artifact cannot be reproduced from tagged source," >&2
  echo "     treat it as a supply-chain incident and quarantine the artifact." >&2
  echo "  See docs/reproducible-builds.md for the full procedure." >&2
  exit 1
}

# Dispatch: if the first argument is --verify-release, run verification;
# otherwise preserve the original generated-artifact check behavior.
if [ "${1:-}" = "--verify-release" ]; then
  shift
  verify_release "$@"
fi