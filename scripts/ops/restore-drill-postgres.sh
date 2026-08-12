#!/usr/bin/env bash
# Restores one custom-format dump into a temporary database, checks key fiscal
# tables and removes only that temporary database. It never touches POSTGRES_DB.
set -euo pipefail

dump_path="${1:-}"
compose_bin="${DOCKER_COMPOSE_BIN:-docker compose}"

[[ -n "$dump_path" && -f "$dump_path" ]] || { echo "Usage: $0 /absolute/path/to/bridge.dump" >&2; exit 64; }
[[ "$dump_path" = /* ]] || { echo "The dump path must be absolute" >&2; exit 64; }
for required in POSTGRES_DB POSTGRES_USER; do
  [[ -n "${!required:-}" ]] || { echo "${required} is required" >&2; exit 64; }
done
command -v docker >/dev/null || { echo "docker is required" >&2; exit 69; }
command -v pg_restore >/dev/null || { echo "pg_restore is required" >&2; exit 69; }
pg_restore --list "$dump_path" >/dev/null

safe_stamp="$(date -u +%Y%m%d%H%M%S)"
drill_db="guesty_mydata_restore_drill_${safe_stamp}"
cleanup() {
  ${compose_bin} exec -T postgres sh -ceu 'dropdb -U "$POSTGRES_USER" --if-exists "$1"' -- "$drill_db" >/dev/null 2>&1 || true
}
trap cleanup EXIT

${compose_bin} exec -T postgres sh -ceu 'createdb -U "$POSTGRES_USER" "$1"' -- "$drill_db"
${compose_bin} exec -T postgres sh -ceu 'pg_restore -U "$POSTGRES_USER" -d "$1" --exit-on-error' -- "$drill_db" < "$dump_path"

${compose_bin} exec -T postgres sh -ceu '
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -Atc "
    SELECT CASE WHEN COUNT(*) = 4 THEN 1 ELSE 0 END
    FROM information_schema.tables
    WHERE table_schema = '\''public'\''
      AND table_name IN ('\''companies'\'', '\''fiscal_documents'\'', '\''fiscal_pdf_artifacts'\'', '\''sync_cursors'\'')
  " | grep -qx 1
' -- "$drill_db"

echo "Restore drill passed in temporary database: ${drill_db}"
