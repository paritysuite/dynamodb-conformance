#!/usr/bin/env bash
#
# Stand up a local ExtendDB and emit the env the conformance suite needs.
#
# ExtendDB publishes no production binary outside its container images (its
# npm binaries are dev-mode builds), so this builds it from source, initialises its
# storage, mints a dynamodb:* IAM access key, and starts the server. It is used
# by every ExtendDB CI job and is runnable locally.
#
# The storage backend is compiled in rather than chosen at runtime, and exactly
# one is installed per binary, so EXTENDDB_BACKEND drives the cargo features as
# well as the init flags. `dev-mode` is deliberately never enabled: it serves
# plain HTTP with open authorisation, which is a different security posture from
# the PostgreSQL build and so not the same thing to measure.
#
# Required:
#   EXTENDDB_DIR              path to an ExtendDB checkout (built or buildable)
#
# Optional (defaults shown):
#   EXTENDDB_BACKEND=postgres storage backend: postgres, sqlite or mongodb
#   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres
#                             postgres backend only
#   MONGODB_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0
#                             mongodb backend only; a replica set, since the
#                             backend uses multi-document transactions
#   EXTENDDB_PORT=8000
#   EXTENDDB_ADMIN_PASSWORD   admin password (generated if unset; init reads it)
#   ACCOUNT_ID=123456789012   12-digit account the conformance user lives in
#   IAM_USER=conformance
#   BUILD=1                   set 0 to skip the cargo build. The run then
#                             refuses a binary that is missing, or stamped for
#                             a different backend, rather than measuring it.
#
# On success it emits the suite env (DYNAMODB_ENDPOINT, NODE_EXTRA_CA_CERTS,
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION). In CI ($GITHUB_ENV set)
# it appends them there and masks the secret; otherwise it prints `export`
# lines suitable for `eval "$(EXTENDDB_DIR=... ./scripts/run-extenddb.sh)"`.
set -euo pipefail

: "${EXTENDDB_DIR:?set EXTENDDB_DIR to an ExtendDB checkout}"
BACKEND=${EXTENDDB_BACKEND:-postgres}
case "$BACKEND" in
  postgres | sqlite | mongodb) ;;
  *)
    echo "ERROR: EXTENDDB_BACKEND must be postgres, sqlite or mongodb (got '$BACKEND')" >&2
    exit 1
    ;;
esac
PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-5432}
PGUSER=${PGUSER:-postgres}
PGPASSWORD=${PGPASSWORD:-postgres}
MONGODB_URI=${MONGODB_URI:-mongodb://127.0.0.1:27017/?replicaSet=rs0}
EXTENDDB_PORT=${EXTENDDB_PORT:-8000}
ACCOUNT_ID=${ACCOUNT_ID:-123456789012}
IAM_USER=${IAM_USER:-conformance}

# Force the port the harness expects rather than inheriting ExtendDB's default,
# which is not ours to pin: 0.1.2 moved it from 8000 to 18443, which left this
# script health-checking a port ExtendDB no longer bound. ExtendDB layers env
# over the config file (config::Environment with the EXTENDDB__ prefix and __
# separator, added after the file source), and every subcommand loads config the
# same way, so exporting this makes serve bind EXTENDDB_PORT and the health
# check, endpoint and manage calls below all agree on it.
export EXTENDDB__SERVER__PORT="$EXTENDDB_PORT"

command -v jq >/dev/null || { echo "ERROR: jq is required" >&2; exit 1; }

# 40 hex chars from 20 random bytes. Avoids `tr </dev/urandom | head`, which
# SIGPIPEs tr (exit 141) under `set -o pipefail` once head closes the pipe.
rand() { LC_ALL=C od -An -tx1 -N20 /dev/urandom | tr -dc 'a-f0-9'; }
EXTENDDB_ADMIN_PASSWORD=${EXTENDDB_ADMIN_PASSWORD:-$(rand)}
export EXTENDDB_ADMIN_PASSWORD

# All build/init/serve/manage commands run from the ExtendDB checkout, where
# init writes extenddb.toml and ~/.extenddb/ (cert + run state) live.
cd "$EXTENDDB_DIR"
BIN=target/release/extenddb
CERT="${HOME}/.extenddb/tls/cert.pem"

# Which backend the binary on disk was built with. The backend is compiled in,
# so a cached target/ from the other job's build looks identical from the
# outside: without this the `-x "$BIN"` check below would skip the rebuild and
# silently measure PostgreSQL while reporting SQLite. Cargo can't be asked
# (the feature set is not recorded in the artefact), so the build records it.
STAMP=target/release/.conformance-backend
built=$([ -f "$STAMP" ] && cat "$STAMP" || echo '')

if [ "${BUILD:-1}" = "1" ] && { [ ! -x "$BIN" ] || [ "$built" != "$BACKEND" ]; }; then
  echo "==> building ExtendDB (release, $BACKEND backend)" >&2
  case "$BACKEND" in
    # Left exactly as it was: the default feature set is postgres, and building
    # the workspace is what this job has always done.
    postgres) cargo build --release ;;
    # No default features, so postgres is not compiled in alongside it. One
    # backend per binary is ExtendDB's own rule, enforced in its init.
    sqlite) cargo build --release -p extenddb --no-default-features --features sqlite ;;
    mongodb) cargo build --release -p extenddb --no-default-features --features mongodb ;;
  esac
  printf '%s\n' "$BACKEND" >"$STAMP"
elif [ "$built" != "$BACKEND" ]; then
  # Fails closed, including when there is no stamp at all. An unstamped binary
  # is the state this guard exists for - a hand-built or pre-stamp one - and
  # treating "unknown" as "agrees" made the check pass in exactly the case it
  # was added to catch.
  if [ -z "$built" ]; then
    echo "ERROR: cannot confirm which backend $BIN was built with (no stamp)." >&2
  else
    echo "ERROR: $BIN was built with the '$built' backend, not '$BACKEND'." >&2
  fi
  echo "       Rebuild it: unset BUILD (or set BUILD=1) and run again." >&2
  exit 1
fi

echo "==> extenddb init ($BACKEND)" >&2
# init and serve print banners to stdout; route to stderr so this script's only
# stdout is the `export` block below (so `eval "$(run-extenddb.sh)"` works).
#
# The compiled-in backend is authoritative; --backend is validated against it
# rather than selecting anything. Passing it is what ExtendDB's getting-started
# documents, and it turns a binary built with the wrong features into a clear
# error here rather than a silent run against the wrong storage.
#
# SQLite is given no path, so the database lands at the compiled-in default,
# $EXTENDDB_DIR/extenddb.sqlite. init records that
# relative path in the generated config and serve resolves it against the same
# working directory, so the two agree.
case "$BACKEND" in
  postgres)
    "$BIN" init --backend postgres --pg-host "$PGHOST" --pg-port "$PGPORT" --pg-user "$PGUSER" --pg-pass "$PGPASSWORD" >&2
    ;;
  sqlite)
    "$BIN" init --backend sqlite >&2
    ;;
  # MongoDB takes no connection flag either: init reads the connection string
  # from the config file it is given, and falls back to localhost without a
  # replica set when there is none. So a minimal config naming the server is
  # written first and init regenerates the full one over it (--overwrite),
  # carrying the connection string across. This is the shape ExtendDB's own
  # MongoDB compose stack uses.
  mongodb)
    printf '[storage]\nbackend = "mongodb"\n\n[storage.mongodb]\nconnection_string = "%s"\n' \
      "$MONGODB_URI" >extenddb.toml
    "$BIN" init --backend mongodb --config extenddb.toml --overwrite >&2
    ;;
esac

# Pure-timing knob: make table create/delete transitions instant. This has no
# effect on the conformance signal (the suite polls for ACTIVE either way); it
# only keeps the run fast. Throttling and GSI propagation are left at ExtendDB's
# defaults so the measured behaviour stays faithful. Best-effort.
"$BIN" settings --config extenddb.toml set control_plane_delay_seconds 0 >&2 || true

echo "==> extenddb serve" >&2
"$BIN" serve --config extenddb.toml >&2

# Wait for the server to answer over TLS before driving the management API.
ready=0
for _ in $(seq 1 30); do
  if curl -fsS --cacert "$CERT" "https://127.0.0.1:${EXTENDDB_PORT}/health" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "ERROR: ExtendDB did not become healthy on :${EXTENDDB_PORT}" >&2
  "$BIN" status --config extenddb.toml >&2 || true
  exit 1
fi

mng() { "$BIN" manage --user admin --password "$EXTENDDB_ADMIN_PASSWORD" --config extenddb.toml "$@"; }

echo "==> create account, user, dynamodb:* policy" >&2
mng create-account --account-id "$ACCOUNT_ID" --account-name conformance >&2
mng create-user --account-id "$ACCOUNT_ID" --user-name "$IAM_USER" --user-password "$(rand)" >&2
mng put-user-policy --account-id "$ACCOUNT_ID" --user-name "$IAM_USER" \
  --policy-name allowddb \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"dynamodb:*","Resource":"*"}]}' >&2

echo "==> mint access key" >&2
key_json=$(mng create-access-key --account-id "$ACCOUNT_ID" --user-name "$IAM_USER")
akid=$(printf '%s' "$key_json" | jq -r '.access_key_id // empty')
secret=$(printf '%s' "$key_json" | jq -r '.secret_access_key // empty')
if [ -z "$akid" ] || [ -z "$secret" ]; then
  echo "ERROR: could not parse access key from create-access-key output" >&2
  printf '%s' "$key_json" | jq 'del(.secret_access_key)' >&2 || true
  exit 1
fi

emit() { # name value
  if [ -n "${GITHUB_ENV:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >>"$GITHUB_ENV"
  else
    printf "export %s='%s'\n" "$1" "$2"
  fi
}
[ -n "${GITHUB_ENV:-}" ] && echo "::add-mask::$secret"
emit DYNAMODB_ENDPOINT "https://127.0.0.1:${EXTENDDB_PORT}"
emit NODE_EXTRA_CA_CERTS "$CERT"
emit AWS_ACCESS_KEY_ID "$akid"
emit AWS_SECRET_ACCESS_KEY "$secret"
emit AWS_REGION "us-east-1"

echo "==> ExtendDB ready at https://127.0.0.1:${EXTENDDB_PORT} (access key ${akid})" >&2
