#!/usr/bin/env bash
# Nightly on-prem backup for culture atlas (docs/production-readiness.md).
#
#   1. pnpm ops:backup   consistent PostgreSQL snapshot (pg_dump 16, custom
#                        format) + object/tombstone inventories + manifest
#   2. pnpm ops:storage mirror   every object in the Garage bucket, copied into
#                        <snapshot>/objects with objects.sha256
#   3. local retention (BACKUP_KEEP_DAYS, default 7)
#   4. optional off-host copy (BACKUP_OFFSITE_RSYNC, e.g. user@nas:/backups/atlas)
#
# Run from the directory holding docker-compose.yml and .env, e.g. cron:
#   15 3 * * * cd /opt/culture-atlas && infra/onprem/atlas-backup.sh >> /var/log/atlas-backup.log 2>&1
#
# The snapshot is restorable with docs/runbooks/restore-drill.md:
#   pnpm ops:restore-drill -- --backup <snapshot> --objects local:<snapshot>/objects
# Prints paths and counts only; never settings or credentials.
set -euo pipefail

cd "$(dirname "$0")/../.."
if [ ! -f docker-compose.yml ]; then
  echo "atlas-backup: run from the culture atlas checkout (docker-compose.yml not found)" >&2
  exit 2
fi

# BACKUP_DIR / BACKUP_KEEP_DAYS / BACKUP_OFFSITE_RSYNC may be set in .env.
env_value() {
  local name="$1" fallback="$2" line value
  value="${!name:-}"
  if [ -z "$value" ]; then
    line="$(grep -E "^${name}=" .env 2>/dev/null | tail -n 1 || true)"
    value="${line#*=}"
  fi
  printf '%s' "${value:-$fallback}"
}
backup_dir="$(env_value BACKUP_DIR /var/backups/culture-atlas)"
keep_days="$(env_value BACKUP_KEEP_DAYS 7)"
offsite="$(env_value BACKUP_OFFSITE_RSYNC '')"

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
# The ops container runs as the image's node user (uid 1000).
if [ "$(id -u)" = 0 ]; then chown 1000:1000 "$backup_dir"; fi

docker compose --profile ops run --rm -T ops sh -ec '
  pnpm --silent ops:backup
  latest="$(ls -1td /backups/capture-* | head -n 1)"
  pnpm --silent ops:storage mirror "$latest"
  echo "atlas-backup: snapshot $(basename "$latest")"
'

# shellcheck disable=SC2012 # capture-XXXXXX names from mkdtemp
latest="$(ls -1td "$backup_dir"/capture-* | head -n 1)"
if [ -n "$offsite" ]; then
  rsync -a --chmod=D700,F600 "$latest" "$offsite/"
  echo "atlas-backup: copied $(basename "$latest") off-host"
fi
find "$backup_dir" -mindepth 1 -maxdepth 1 -name 'capture-*' -mtime +"$keep_days" -exec rm -rf {} +
echo "atlas-backup: done"
