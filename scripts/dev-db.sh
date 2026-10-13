#!/usr/bin/env bash
# Starts the local PostgreSQL 16 service and creates the culture atlas role and
# databases (culture_atlas for development, culture_atlas_test as the admin/base
# database for tests). Idempotent. Requires root (or sudo) for `service` and `su`.
set -euo pipefail

DB_USER="${DB_USER:-culture_atlas}"
DB_PASSWORD="${DB_PASSWORD:-culture_atlas}"

run_as_postgres() {
  if [ "$(id -u)" = "0" ]; then su postgres -c "$1"; else sudo -u postgres bash -c "$1"; fi
}

if ! pg_isready -q -h localhost -p 5432 2>/dev/null; then
  echo "Starting PostgreSQL..."
  if [ "$(id -u)" = "0" ]; then service postgresql start; else sudo service postgresql start; fi
  for _ in $(seq 1 30); do pg_isready -q -h localhost -p 5432 && break; sleep 0.5; done
fi

# Role with CREATEDB so the test harness can create an isolated database per run.
run_as_postgres "psql -v ON_ERROR_STOP=1 -tAc \"DO \\\$\\\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN CREATEDB PASSWORD '${DB_PASSWORD}';
  ELSE
    ALTER ROLE ${DB_USER} LOGIN CREATEDB PASSWORD '${DB_PASSWORD}';
  END IF;
END \\\$\\\$;\""

for db in culture_atlas culture_atlas_test; do
  exists=$(run_as_postgres "psql -tAc \"SELECT 1 FROM pg_database WHERE datname = '${db}'\"")
  if [ "${exists}" != "1" ]; then
    echo "Creating database ${db}"
    run_as_postgres "createdb -O ${DB_USER} ${db}"
  fi
done

echo "PostgreSQL ready."
echo "  DATABASE_URL=postgres://${DB_USER}:${DB_PASSWORD}@localhost:5432/culture_atlas"
echo "  TEST_DATABASE_URL=postgres://${DB_USER}:${DB_PASSWORD}@localhost:5432/culture_atlas_test"
echo "Run 'pnpm db:migrate' to apply migrations to DATABASE_URL."
