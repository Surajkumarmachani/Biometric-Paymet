#!/usr/bin/env bash
# Local Postgres for the test suite.
#
# The correctness gates run against real Postgres, not a mock — the invariants
# under test (atomic challenge consumption, paid-is-never-demoted, exactly-once
# fulfilment, RLS denial) are properties of Postgres semantics, so testing them
# against a fake would test the fake.
#
# If you already have Postgres or a local Supabase running, skip this and set
#   export TEST_PG_ADMIN_URL=postgresql://user@host:port/postgres
set -euo pipefail

PGDATA="${PGDATA:-/tmp/regal-pgdata}"
PGPORT="${PGPORT:-5433}"
PGACCOUNT="${PGACCOUNT:-postgres}"

# Locate the Postgres binaries. Order: explicit $PGBIN, then whatever is on PATH
# (Homebrew's `brew install postgresql@17` puts them there), then common install
# dirs on macOS (Homebrew) and Linux (apt). This is what makes the script work
# on a dev Mac and in CI without editing it.
find_pgbin() {
  if [ -n "${PGBIN:-}" ] && [ -x "$PGBIN/pg_ctl" ]; then
    echo "$PGBIN"; return 0
  fi
  if command -v pg_ctl >/dev/null 2>&1; then
    dirname "$(command -v pg_ctl)"; return 0
  fi
  local d
  for d in \
    /opt/homebrew/opt/postgresql@*/bin \
    /usr/local/opt/postgresql@*/bin \
    /opt/homebrew/bin \
    /usr/local/bin \
    /usr/lib/postgresql/*/bin; do
    if [ -x "$d/pg_ctl" ]; then echo "$d"; return 0; fi
  done
  return 1
}

if ! PGBIN="$(find_pgbin)"; then
  echo "Could not find Postgres binaries (pg_ctl)." >&2
  echo "  macOS:  brew install postgresql@17" >&2
  echo "  Debian: apt-get install postgresql" >&2
  echo "  or set PGBIN=/path/to/postgres/bin" >&2
  exit 1
fi

# initdb/pg_ctl refuse to run as root; drop to an unprivileged account when we
# are root (Linux CI). On a normal dev machine (non-root) we run them directly.
run_pg() {
  # run_pg <binary> <args...>
  if [ "$(id -u)" = "0" ]; then
    chown -R "$PGACCOUNT" "$PGDATA" 2>/dev/null || true
    su "$PGACCOUNT" -c "$*"
  else
    eval "$*"
  fi
}

case "${1:-start}" in
  start)
    # Idempotent: if a server is already accepting connections on the port,
    # there's nothing to do — so `npm run db:pg:start && npm test` works whether
    # or not the cluster was already up.
    if "$PGBIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1; then
      echo "postgres already up on 127.0.0.1:$PGPORT"
      echo "export TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:$PGPORT/postgres"
      exit 0
    fi

    # A stale postmaster.pid from a crash blocks a fresh start; clear it if no
    # server is actually listening (checked above).
    rm -f "$PGDATA/postmaster.pid" 2>/dev/null || true

    # PG_VERSION is the definitive marker of a valid cluster. If it is missing
    # (fresh dir, or a corrupt/partial leftover from an aborted init), start
    # clean — this is throwaway test data under /tmp.
    if [ ! -s "$PGDATA/PG_VERSION" ]; then
      [ -n "$PGDATA" ] && rm -rf "$PGDATA"
      mkdir -p "$PGDATA"
      run_pg "'$PGBIN/initdb' -D '$PGDATA' -U postgres --auth=trust"
    fi
    # -k /tmp gives a writable unix-socket dir on every platform; tests connect
    # over TCP (127.0.0.1) but the socket dir must still be writable.
    OPTS="-p $PGPORT -c listen_addresses=127.0.0.1 -k /tmp"
    run_pg "'$PGBIN/pg_ctl' -D '$PGDATA' -o '$OPTS' -l /tmp/regal-pg.log -w start"
    echo "postgres up on 127.0.0.1:$PGPORT  (using $PGBIN)"
    echo "export TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:$PGPORT/postgres"
    ;;
  stop)
    run_pg "'$PGBIN/pg_ctl' -D '$PGDATA' stop" || true
    ;;
  *)
    echo "usage: $0 {start|stop}" >&2
    exit 1
    ;;
esac
