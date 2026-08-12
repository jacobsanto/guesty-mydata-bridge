#!/usr/bin/env bash
# Creates a verified PostgreSQL custom-format dump and encrypts/copies it with
# restic. Run on the Hetzner host, never inside the application container.
set -euo pipefail

backup_dir="${GUESTY_BRIDGE_BACKUP_DIR:-/srv/guesty-mydata-backups}"
retention_days="${GUESTY_BRIDGE_BACKUP_RETENTION_DAYS:-35}"
compose_bin="${DOCKER_COMPOSE_BIN:-docker compose}"

for required in RESTIC_REPOSITORY RESTIC_PASSWORD_FILE POSTGRES_DB POSTGRES_USER; do
  if [[ -z "${!required:-}" ]]; then
    echo "${required} is required" >&2
    exit 64
  fi
done
for command in docker restic pg_restore; do
  command -v "$command" >/dev/null || { echo "${command} is required" >&2; exit 69; }
done
[[ "$backup_dir" = /* && "$backup_dir" != "/" ]] || { echo "GUESTY_BRIDGE_BACKUP_DIR must be a specific absolute directory" >&2; exit 64; }
[[ -f "$RESTIC_PASSWORD_FILE" ]] || { echo "RESTIC_PASSWORD_FILE does not exist" >&2; exit 66; }
[[ "$retention_days" =~ ^[1-9][0-9]*$ ]] || { echo "GUESTY_BRIDGE_BACKUP_RETENTION_DAYS must be a positive integer" >&2; exit 64; }

umask 077
install -d -m 700 "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_path="${backup_dir}/bridge-${timestamp}.dump"
checksum_path="${dump_path}.sha256"
cleanup() { rm -f "$dump_path" "$checksum_path"; }
trap cleanup EXIT

# The password remains in Docker's service environment; it is never placed on
# the host command line or in this script's output.
${compose_bin} exec -T postgres sh -ceu 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$dump_path"
test -s "$dump_path"
pg_restore --list "$dump_path" >/dev/null
sha256sum "$dump_path" > "$checksum_path"

restic backup --tag guesty-mydata --tag postgres --tag "backup-${timestamp}" "$dump_path" "$checksum_path"
restic forget --tag guesty-mydata --keep-daily "$retention_days" --prune

echo "Backup completed and verified: ${timestamp}"
