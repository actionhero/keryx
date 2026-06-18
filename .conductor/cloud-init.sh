#!/usr/bin/env bash
#
# Conductor Cloud snapshot initialization script.
#
# Runs ONCE when Conductor builds the cloud snapshot (Vercel Sandbox / Amazon
# Linux 2023); its output is baked into the snapshot, so every workspace forked
# from it gets bun, PostgreSQL, and Redis pre-installed for free.
#
# This is the slow, repeatable, system-level work. Per-workspace runtime work
# (starting the services, creating databases, writing .env files) lives in
# .conductor/setup.ts, which runs on every workspace creation.
#
# To wire it up: in the Conductor app, go to Settings -> Cloud -> Snapshots and
# set the initialization script to run this file (then "Build snapshot now"):
#
#     bash .conductor/cloud-init.sh
#     bun install --frozen-lockfile --prefer-offline || bun install
#
set -euo pipefail

echo "=== Conductor Cloud init: installing bun, PostgreSQL, Redis ==="

# -----------------------------------------------------------------------------
# bun
# -----------------------------------------------------------------------------
# Install to $HOME/.bun, then symlink into ~/.local/bin (already on PATH and
# user-owned). We do NOT touch $PATH directly — Conductor reserves it.
if ! command -v bun >/dev/null 2>&1; then
  echo "[bun] installing..."
  export BUN_INSTALL="$HOME/.bun"
  curl -fsSL https://bun.sh/install | bash
  mkdir -p "$HOME/.local/bin"
  ln -sf "$BUN_INSTALL/bin/bun" "$HOME/.local/bin/bun"
  ln -sf "$BUN_INSTALL/bin/bunx" "$HOME/.local/bin/bunx"
else
  echo "[bun] already installed ($(command -v bun))"
fi

# -----------------------------------------------------------------------------
# PostgreSQL + Redis (Amazon Linux 2023 packages)
# -----------------------------------------------------------------------------
# postgresql16 client binaries land on /usr/bin (psql, createdb, pg_isready);
# postgresql16-server adds initdb/pg_ctl/postgres. redis6 installs its binaries
# as redis6-server / redis6-cli, so we symlink the conventional names too.
echo "[dnf] installing postgresql16, postgresql16-server, redis6..."
sudo dnf install -y postgresql16 postgresql16-server redis6

mkdir -p "$HOME/.local/bin"
ln -sf /usr/bin/redis6-server "$HOME/.local/bin/redis-server"
ln -sf /usr/bin/redis6-cli "$HOME/.local/bin/redis-cli"

# -----------------------------------------------------------------------------
# Initialize the PostgreSQL data directory
# -----------------------------------------------------------------------------
# A user-owned data dir + trust auth sidesteps the postgres-system-user / peer
# auth dance. The "postgres" role is created here so DATABASE_URLs of the form
# postgres://postgres@localhost work. This dir is baked into the snapshot, so
# initdb runs at most once.
PGDATA="$HOME/pgdata"
if [ ! -d "$PGDATA/base" ]; then
  echo "[postgres] initializing data dir at $PGDATA..."
  /usr/bin/initdb -D "$PGDATA" -U postgres --auth=trust
else
  echo "[postgres] data dir already initialized at $PGDATA"
fi

echo "=== Conductor Cloud init complete ==="
