#!/usr/bin/env bash
# Creates the local PostgreSQL role + database described by DATABASE_URL in
# tracker_backend/.env (or the DATABASE_URL environment variable, which takes precedence).
# Idempotent: safe to re-run (it also re-syncs the role password).
#
# Default: runs psql as the OS "postgres" user via sudo (standard Ubuntu/Debian).
# Otherwise point PG_ADMIN_URL at any superuser connection, e.g.
#   PG_ADMIN_URL="postgresql://postgres:secret@localhost:5432/postgres" npm run db:setup-local
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || [ -n "${DATABASE_URL:-}" ] || { echo "tracker_backend/.env not found — copy .env.example to .env first." >&2; exit 1; }

# Parse DATABASE_URL with node so passwords containing special characters are handled.
mapfile -d '' -t DB < <(node -e '
  const fs = require("fs");
  const raw = process.env.DATABASE_URL || require("dotenv").parse(fs.readFileSync(".env")).DATABASE_URL;
  const url = new URL(raw);
  process.stdout.write([decodeURIComponent(url.username), decodeURIComponent(url.password), url.pathname.slice(1)].join("\0") + "\0");
')
APP_USER="${DB[0]}"; APP_PW="${DB[1]}"; APP_DB="${DB[2]}"
[ -n "$APP_USER" ] && [ -n "$APP_PW" ] && [ -n "$APP_DB" ] || { echo "DATABASE_URL must include user, password and database name." >&2; exit 1; }

if [ -n "${PG_ADMIN_URL:-}" ]; then
  PSQL=(psql "$PG_ADMIN_URL")
else
  PSQL=(sudo -u postgres psql postgres)
fi

# CREATEDB lets `prisma migrate dev` create its temporary shadow database.
# (Password is passed as a psql variable: fine for local dev, briefly visible in `ps`.)
"${PSQL[@]}" -v ON_ERROR_STOP=1 -v app_user="$APP_USER" -v app_pw="$APP_PW" -v app_db="$APP_DB" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN CREATEDB PASSWORD %L', :'app_user', :'app_pw')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN CREATEDB PASSWORD %L', :'app_user', :'app_pw') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'app_db', :'app_user')
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'app_db') \gexec
SQL

echo "✔ Role '$APP_USER' and database '$APP_DB' are ready."
echo "  Next: npm run db:migrate"
