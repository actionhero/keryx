#!/bin/bash
#
# Bootstrap script for Keryx in Claude Code cloud environment
# This script is run automatically via SessionStart hook when a session begins
#

set -e

# -----------------------------------------------------------------------------
# Only run in Claude Code cloud environment
# -----------------------------------------------------------------------------
if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
    exit 0
fi

echo "=== Keryx bootstrap script ==="
echo "Running in Claude Code cloud environment"
echo ""

# -----------------------------------------------------------------------------
# 0. Fix PostgreSQL authentication for cloud environment
# -----------------------------------------------------------------------------
echo "[0/6] Configuring PostgreSQL authentication..."

PG_HBA=$(find /etc/postgresql -name pg_hba.conf 2>/dev/null | head -1)
if [ -n "$PG_HBA" ]; then
    sed -i 's/^\(local.*all.*postgres.*\)peer$/\1trust/' "$PG_HBA"
    sed -i 's/^\(local.*all.*all.*\)peer$/\1trust/' "$PG_HBA"
    sed -i 's/^\(host.*all.*all.*127\.0\.0\.1\/32.*\)scram-sha-256$/\1trust/' "$PG_HBA"
    sed -i 's/^\(host.*all.*all.*::1\/128.*\)scram-sha-256$/\1trust/' "$PG_HBA"
    echo "  pg_hba.conf updated to trust auth"
else
    echo "  WARNING: pg_hba.conf not found, skipping auth configuration"
fi

# -----------------------------------------------------------------------------
# 1. Start PostgreSQL
# -----------------------------------------------------------------------------
echo "[1/6] Starting PostgreSQL..."

# Check if PostgreSQL is already running
if pg_isready -q 2>/dev/null; then
    echo "  PostgreSQL is already running"
else
    # Start PostgreSQL service (varies by environment)
    if command -v pg_ctlcluster &>/dev/null; then
        # Debian/Ubuntu style
        pg_ctlcluster 16 main start 2>/dev/null || pg_ctlcluster 15 main start 2>/dev/null || true
    elif command -v pg_ctl &>/dev/null; then
        # Direct pg_ctl
        pg_ctl start -D /var/lib/postgresql/data 2>/dev/null || true
    fi

    # Wait for PostgreSQL to be ready (up to 30 seconds)
    for i in {1..30}; do
        if pg_isready -q 2>/dev/null; then
            echo "  PostgreSQL started successfully"
            break
        fi
        sleep 1
    done
fi

# Verify PostgreSQL is running
if ! pg_isready -q 2>/dev/null; then
    echo "  WARNING: PostgreSQL may not be running. Tests may fail."
fi

# Reload config so pg_hba.conf changes take effect
pg_ctlcluster 16 main reload 2>/dev/null || true

# Set postgres user password to match DATABASE_URL expectations
psql -U postgres -c "ALTER USER postgres WITH PASSWORD 'postgres';" 2>/dev/null || true
echo "  PostgreSQL password configured"

# -----------------------------------------------------------------------------
# 2. Start Redis
# -----------------------------------------------------------------------------
echo "[2/6] Starting Redis..."

# Check if Redis is already running
if redis-cli ping 2>/dev/null | grep -q PONG; then
    echo "  Redis is already running"
else
    # Start Redis in background
    if command -v redis-server &>/dev/null; then
        redis-server --daemonize yes 2>/dev/null || true
    fi

    # Wait for Redis to be ready (up to 10 seconds)
    for i in {1..10}; do
        if redis-cli ping 2>/dev/null | grep -q PONG; then
            echo "  Redis started successfully"
            break
        fi
        sleep 1
    done
fi

# Verify Redis is running
if ! redis-cli ping 2>/dev/null | grep -q PONG; then
    echo "  WARNING: Redis may not be running. Tests may fail."
fi

# -----------------------------------------------------------------------------
# 3. Create databases
# -----------------------------------------------------------------------------
echo "[3/6] Creating databases..."

# Determine PostgreSQL user - try postgres first, then current user
if psql -U postgres -lqt &>/dev/null; then
    PG_USER="postgres"
elif psql -lqt &>/dev/null; then
    PG_USER="$(whoami)"
else
    echo "  WARNING: Cannot determine PostgreSQL user. Trying 'postgres'..."
    PG_USER="postgres"
fi
echo "  Using PostgreSQL user: $PG_USER"

# Create main database
if psql -U "$PG_USER" -lqt 2>/dev/null | cut -d \| -f 1 | grep -qw keryx; then
    echo "  Database 'keryx' already exists"
else
    createdb -U "$PG_USER" keryx 2>/dev/null && echo "  Created database 'keryx'" || echo "  Could not create database 'keryx' (may already exist)"
fi

# Create test databases — one per workspace, matching CI where each job gets its own Postgres
if psql -U "$PG_USER" -lqt 2>/dev/null | cut -d \| -f 1 | grep -qw keryx-test; then
    echo "  Database 'keryx-test' already exists"
else
    createdb -U "$PG_USER" keryx-test 2>/dev/null && echo "  Created database 'keryx-test'" || echo "  Could not create database 'keryx-test' (may already exist)"
fi

if psql -U "$PG_USER" -lqt 2>/dev/null | cut -d \| -f 1 | grep -qw keryx-package-test; then
    echo "  Database 'keryx-package-test' already exists"
else
    createdb -U "$PG_USER" keryx-package-test 2>/dev/null && echo "  Created database 'keryx-package-test'" || echo "  Could not create database 'keryx-package-test' (may already exist)"
fi

# -----------------------------------------------------------------------------
# 4. Install dependencies
# -----------------------------------------------------------------------------
echo "[4/6] Installing dependencies..."

cd "$CLAUDE_PROJECT_DIR"

if [ -f "bun.lockb" ] || [ -f "package.json" ]; then
    bun install --frozen-lockfile 2>/dev/null || bun install
    echo "  Dependencies installed"
else
    echo "  No package.json found, skipping dependency installation"
fi

# -----------------------------------------------------------------------------
# 5. Set up environment files
# -----------------------------------------------------------------------------
echo "[5/6] Setting up environment files..."

# Cloud-appropriate connection strings
CLOUD_DB_URL="postgres://postgres:postgres@localhost:5432/keryx"
CLOUD_DB_URL_TEST="postgres://postgres:postgres@localhost:5432/keryx-test"
CLOUD_PKG_DB_URL_TEST="postgres://postgres:postgres@localhost:5432/keryx-package-test"
CLOUD_REDIS_URL="redis://localhost:6379/0"
CLOUD_REDIS_URL_TEST="redis://localhost:6379/1"

# Helper: copy .env.example to .env and override specific keys via sed
setup_env() {
    local dir="$1"
    shift
    # remaining args are key=value pairs to override

    local example="$CLAUDE_PROJECT_DIR/$dir/.env.example"
    local target="$CLAUDE_PROJECT_DIR/$dir/.env"

    if [ ! -f "$example" ]; then
        echo "  WARNING: $dir/.env.example not found, skipping"
        return
    fi

    if [ ! -f "$target" ]; then
        cp "$example" "$target"
        echo "  Created $dir/.env from .env.example"
    else
        echo "  $dir/.env already exists, re-applying overrides"
    fi

    # Apply overrides via sed (pipe delimiter avoids conflict with URLs)
    while [ $# -gt 0 ]; do
        local key="${1%%=*}"
        local val="${1#*=}"
        if grep -qE "^#?\s*${key}=" "$target"; then
            sed -i "s|^#\?\s*${key}=.*|${key}=${val}|" "$target"
        else
            echo "${key}=${val}" >> "$target"
        fi
        shift
    done
}

# packages/keryx/.env — uses separate test DB to avoid migration conflicts with example/backend
setup_env "packages/keryx" \
    "DATABASE_URL=\"$CLOUD_DB_URL\"" \
    "DATABASE_URL_TEST=\"$CLOUD_PKG_DB_URL_TEST\"" \
    "REDIS_URL=\"$CLOUD_REDIS_URL\"" \
    "REDIS_URL_TEST=\"$CLOUD_REDIS_URL_TEST\""

# example/backend/.env
setup_env "example/backend" \
    "DATABASE_URL=\"$CLOUD_DB_URL\"" \
    "DATABASE_URL_TEST=\"$CLOUD_DB_URL_TEST\"" \
    "REDIS_URL=\"$CLOUD_REDIS_URL\"" \
    "REDIS_URL_TEST=\"$CLOUD_REDIS_URL_TEST\""

# example/frontend/.env
setup_env "example/frontend" \
    "VITE_API_URL=http://localhost:8080"

# -----------------------------------------------------------------------------
# 6. Export environment variables for the session
# -----------------------------------------------------------------------------
echo "[6/6] Configuring session environment..."

if [ -n "$CLAUDE_ENV_FILE" ]; then
    # DATABASE_URL* intentionally omitted — each workspace .env provides its own
    # value so packages/keryx and example/backend use isolated test databases
    # (matching CI where each job gets its own Postgres instance).
    cat >> "$CLAUDE_ENV_FILE" << 'ENVEOF'
export REDIS_URL="redis://localhost:6379/0"
export REDIS_URL_TEST="redis://localhost:6379/1"
ENVEOF
    echo "  Session environment variables configured"
    echo "  REDIS_URL=redis://localhost:6379/0"
    echo "  REDIS_URL_TEST=redis://localhost:6379/1"
    echo "  (DATABASE_URL* provided per-workspace via .env files)"
else
    echo "  CLAUDE_ENV_FILE not set (running outside Claude Code?)"
fi

# -----------------------------------------------------------------------------
# Done!
# -----------------------------------------------------------------------------
echo ""
echo "=== Bootstrap complete! ==="
echo ""
echo "Services:"
echo "  - PostgreSQL: $(pg_isready -q 2>/dev/null && echo 'running' || echo 'not running')"
echo "  - Redis: $(redis-cli ping 2>/dev/null | grep -q PONG && echo 'running' || echo 'not running')"
echo ""
echo "You can now run:"
echo "  bun test-backend   # Run backend tests"
echo "  bun test-frontend  # Run frontend tests"
echo "  bun dev            # Start development servers"
echo ""

exit 0
