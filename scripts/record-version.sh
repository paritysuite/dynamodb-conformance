#!/usr/bin/env bash
#
# Record the tested target's version into results/<target>.version, so the
# results table can show which build each run was against. Best-effort: writes
# "-" when nothing is resolvable. Called by each conformance CI job.
#
#   scripts/record-version.sh <target>
#
# Per-target inputs:
#   EXTENDDB_REF       extenddb, extenddb-sqlite - the release tag/ref built
#   DYNOXIDE_WASM_REF  dynoxide-wasm - the dynoxide release the bundle came from
#   TARGET_IMAGE       container targets - the image ref, used to resolve a digest
#
# Sources, by target:
#   dynamodb              live AWS service (no version)
#   dynoxide / dynalite   npm published version (`npm view`)
#   dynoxide-wasm         the triggering dynoxide release, else the version the
#                         wasm engine publishes for itself on npm
#   localstack            its /_localstack/info version endpoint
#   aws-emulator          the installed binary's own `aws-emulator -v`
#   alternator            `scylla --version` in the running container, else
#                         the image digest
#   extenddb              the built release tag; the SQLite row reports the
#   extenddb-sqlite       same tag, being the same release built with a
#                         different storage feature rather than its own build
#   container `:latest`   the resolved image digest (pins what latest was)
set -uo pipefail

target="${1:?usage: record-version.sh <target>}"
mkdir -p results

ver=""
case "$target" in
  dynamodb)   ver="live (AWS)" ;;
  extenddb | extenddb-sqlite) ver="${EXTENDDB_REF:-}" ;;
  dynoxide)   ver=$(npm view dynoxide version 2>/dev/null) ;;
  dynoxide-wasm)
    # The ref is a release tag (v1.0.0) while the board renders the version bare
    # (1.0.0), so the prefix goes rather than having two adjacent rows render
    # the same release two ways.
    ver="${DYNOXIDE_WASM_REF:-}"
    ver="${ver#v}"
    # The wasm engine publishes a package of its own, so ask that one. It used
    # to borrow the native binary's version, on the reasoning that the bundle
    # shipped inside the dynoxide release; it no longer does. The two track each
    # other today, and the moment they stop this row would carry a version it
    # never ran.
    [ -z "$ver" ] && ver=$(npm view @dynoxide/wasm-engine version 2>/dev/null)
    ;;
  dynalite)   ver=$(npm view dynalite version 2>/dev/null) ;;
  localstack)
    ver=$(curl -fsS http://localhost:4566/_localstack/info 2>/dev/null | jq -r '.version // empty')
    ver=${ver%%:*} # drop any :git-hash suffix
    ;;
  aws-emulator)
    # The first version-shaped token on the first line of `aws-emulator -v`,
    # asked of the installed binary rather than of the package index, which
    # moves several times a day.
    ver=$(aws-emulator -v 2>/dev/null |
      awk 'NR == 1 { if (match($0, /[0-9]+(\.[0-9]+)+/)) print substr($0, RSTART, RLENGTH); exit }')
    ;;
  alternator)
    # The ScyllaDB release, asked of the container named `alternator` that the
    # CI job and the README start. Of <version>-<build>.<date>.<commit>, only
    # the version is kept.
    ver=$(docker exec alternator scylla --version 2>/dev/null | head -n 1)
    ver=${ver%%-*}
    ;;
esac

# Container targets (and a fallback for any image-backed target): the resolved
# image digest pins what `:latest` actually was at run time.
if [ -z "$ver" ] && [ -n "${TARGET_IMAGE:-}" ]; then
  digest=$(docker inspect --format '{{ if .RepoDigests }}{{ index .RepoDigests 0 }}{{ end }}' "$TARGET_IMAGE" 2>/dev/null)
  if [ -n "$digest" ]; then
    ver="${digest##*sha256:}"
    ver="${ver:0:12}"
  fi
fi

[ -z "$ver" ] && ver="-"
printf '%s\n' "$ver" >"results/${target}.version"
echo "recorded ${target} version: ${ver}"

# Region the target was exercised in. Meaningful chiefly for the ground-truth
# dynamodb run (emulator targets sign for a placeholder region). Written to a
# separate sibling file so summarise.mjs stays byte-stable, and so the results
# table and paritysuite.org can render "observed in <region>" from data rather
# than hand-authoring it.
region="${AWS_REGION:-}"
[ -z "$region" ] && region="-"
printf '%s\n' "$region" >"results/${target}.region"
echo "recorded ${target} region: ${region}"
