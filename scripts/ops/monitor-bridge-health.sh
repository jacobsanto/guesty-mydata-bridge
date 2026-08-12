#!/usr/bin/env bash
# Host-side monitor for the private Hetzner deployment. It checks only health
# and operation receipts: no fiscal XML, Guesty payload, AADE credential or
# bearer token is read or sent to the optional alert receiver.
set -euo pipefail

health_url="${GUESTY_BRIDGE_HEALTH_URL:-http://127.0.0.1:3001/health/ready}"
backup_dir="${GUESTY_BRIDGE_BACKUP_DIR:-/srv/guesty-mydata-backups}"
backup_max_hours="${GUESTY_BRIDGE_BACKUP_MAX_AGE_HOURS:-26}"
restore_max_days="${GUESTY_BRIDGE_RESTORE_DRILL_MAX_AGE_DAYS:-35}"
alert_webhook="${GUESTY_BRIDGE_ALERT_WEBHOOK_URL:-}"

[[ "$backup_dir" = /* && "$backup_dir" != "/" ]] || { echo "GUESTY_BRIDGE_BACKUP_DIR must be a specific absolute directory" >&2; exit 64; }
[[ "$backup_max_hours" =~ ^[1-9][0-9]*$ ]] || { echo "GUESTY_BRIDGE_BACKUP_MAX_AGE_HOURS must be a positive integer" >&2; exit 64; }
[[ "$restore_max_days" =~ ^[1-9][0-9]*$ ]] || { echo "GUESTY_BRIDGE_RESTORE_DRILL_MAX_AGE_DAYS must be a positive integer" >&2; exit 64; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 69; }
command -v stat >/dev/null || { echo "stat is required" >&2; exit 69; }

failures=()
if ! curl --fail --silent --show-error --max-time 10 "$health_url" >/dev/null; then
  failures+=("bridge /health/ready is unavailable")
fi

now="$(date +%s)"
check_age() {
  local path="$1" max_seconds="$2" label="$3" modified age
  if [[ ! -f "$path" ]]; then
    failures+=("${label} receipt is missing")
    return
  fi
  modified="$(stat -c %Y "$path")"
  age=$((now - modified))
  if (( age < 0 || age > max_seconds )); then
    failures+=("${label} receipt is overdue (${age}s old)")
  fi
}

check_age "${backup_dir}/last-successful-backup.json" "$((backup_max_hours * 3600))" "encrypted backup"
check_age "${backup_dir}/last-successful-restore-drill.json" "$((restore_max_days * 86400))" "restore drill"

if (( ${#failures[@]} == 0 )); then
  echo "Guesty myDATA operational monitor: healthy"
  exit 0
fi

message="Guesty myDATA operational alert: ${failures[*]}"
echo "$message" >&2
if [[ -n "$alert_webhook" ]]; then
  # The operator controls this endpoint. Only a terse operational status is
  # transmitted; it must not be a webhook that expects fiscal data.
  curl --fail --silent --show-error --max-time 10 -H 'Content-Type: text/plain; charset=utf-8' --data "$message" "$alert_webhook" >&2 || true
fi
exit 1
