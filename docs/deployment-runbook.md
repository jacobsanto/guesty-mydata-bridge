# Deployment runbook

This runbook deploys one application instance backed by PostgreSQL. Every new
deployment starts against the AADE sandbox, with automatic daily closing and
production transmission disabled.

## Required secrets and records

Keep secrets in the platform secret manager or in an uncommitted `.env` file.
Never put them in Git, a ticket, chat, image, log, or database backup note.

- `ADMIN_API_TOKEN`: a unique high-entropy bearer token for the admin API.
- `POLICY_ACCOUNTING_APPROVER_TOKEN` and `POLICY_TECHNICAL_APPROVER_TOKEN`:
  two separate high-entropy credentials, each bound to a named actor through
  `POLICY_ACCOUNTING_ACTOR` and `POLICY_TECHNICAL_ACTOR`. They must differ from
  each other and from the admin token. A policy cannot become production-ready
  without both immutable approvals.
- `DATA_ENCRYPTION_KEY`: exactly 32 random bytes, base64 encoded.
- `GUESTY_CLIENT_ID`, `GUESTY_CLIENT_SECRET`, `GUESTY_WEBHOOK_SECRET`, and the
  stable `GUESTY_ACCOUNT_ID` from the connected Guesty account.
- PostgreSQL host, port, database, user, and a unique password.
- `DB_POOL_MAX` at least `2` (`10` is the deployment default), because schema
  initialization holds a dedicated PostgreSQL advisory-lock connection.
- Per-company AADE user ID and subscription key. Enter these through the admin
  UI after deployment; do not place them in global environment variables.

Generate independent application secrets locally:

```bash
openssl rand -base64 48
openssl rand -base64 32
```

Use separate generated values for the admin, accounting-approval and
technical-approval tokens; the second command produces the
`DATA_ENCRYPTION_KEY`.

## External production prerequisites

The repository does not provision or approve the external systems required for
production. Before activation, the operator must have:

- a Guesty Pro account with Open API access, the required reservation webhook
  subscription, and representative real reservations for every active channel;
- separate AADE myDATA credentials for every legal entity, tested first in the
  correct sandbox and then in the correct production environment;
- accountant-confirmed taxable gross and document policy for every exact
  `listing/platform/source`, including Booking.com, Airbnb, each other OTA or
  direct source, and the Guesty Booking Engine;
- public DNS and TLS termination for the webhook, PostgreSQL 16, a platform
  secret manager, encrypted off-site backups, and a tested restore procedure;
- named operational and accounting owners for the review queue, reconciliation
  inbox, uncertain transmissions/cancellations, and production activation.

## Render deployment

1. Commit and push the reviewed repository to a private GitHub repository.
2. In Render, create a Blueprint from `render.yaml`.
3. Select an appropriate paid PostgreSQL plan with backups and a paid Web
   Service plan that does not sleep. Keep `numInstances` at `1`.
4. Supply every `sync: false` secret in Render. Sandbox acceptance is recorded
   in the application only after both verified documents and PDFs are reviewed.
5. Deploy manually. Automatic deploys are deliberately disabled.
6. Confirm `GET https://<render-host>/health/ready` succeeds and inspect the
   startup logs for a successful PostgreSQL schema initialization.
   This endpoint proves basic process/database availability only; fiscal
   readiness is reported by the authenticated `/api/readiness` endpoint.
7. Open `https://<render-host>/admin`, enter the bearer token, configure each
   company and listing, and run the Guesty and myDATA sandbox connection tests.
8. Register this Guesty webhook URL and subscribe it to the required reservation
   events:

   `https://<render-host>/api/webhook/guesty-reservation`

9. Stage representative Guesty reservations for every observed
   `listing/platform/source`. Create a draft unified policy for each exact
   combination, classify every Guest Folio line explicitly, and capture three
   final Welcome/myDATA samples with their actual MARK, PDF SHA-256, document
   type, series and taxable gross. The bridge recomputes each amount from the
   immutable staged Guesty folio and permits approval only at exact zero-cent
   difference. Create a separate TAKK policy and capture an exact low, high and
   seasonal-boundary 8.2 example. Cover at least the normal,
   discount, additional-fee, tax, alteration and cancellation cases relevant to
   that channel. Include Airbnb Resolution Center cases when they occur.
   Treat Airbnb, Booking.com, Guesty Booking Engine and every other OTA/direct
   source as independent channels. Never copy an approved unified policy to a channel
   merely because its line names or displayed total look similar.
10. Have the named accounting and technical owners approve only policies whose
    required samples all pass, then make the immutable admin decision. Unknown
    or ambiguous lines must remain blocked; do not add catch-all include rules.
    Legacy billing rules and financial profiles are retained only for audit and
    sandbox investigation: they can neither approve nor drive a production
    issue. Migrate their useful observations into an exact unified policy, then
    retire them after the historical retention period; readiness displays them
    as migration warnings rather than treating them as fiscal evidence.
11. Send a controlled reservation through sandbox, run daily close manually,
    verify the transmitted document through the API, review the MARK/UID and PDF,
    and obtain accountant approval.
12. Inspect `GET /api/connections/guesty/reconciliation-inbox?status=unresolved`.
    Correct every missing/inactive mapping and call
    `POST /api/connections/guesty/reconciliation-inbox/retry` until the inbox is
    empty. Do not delete or bypass unresolved entries.

Do not expose the Render PostgreSQL public endpoint unless it is temporarily
required for a controlled maintenance task. The Blueprint connects over the
private Render network.

## Hetzner Cloud deployment with Docker Compose

Prerequisites are Docker Engine with the Compose plugin, a TLS reverse proxy,
DNS, firewall access limited to ports 80/443, and encrypted off-host backups.

```bash
cp .env.production.example .env
chmod 600 .env
docker compose config
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:3001/health/ready
```

Replace every placeholder before `docker compose up`. Compose binds the app only
to `127.0.0.1:3001`; terminate TLS in Caddy, Nginx, or Traefik and proxy to that
address. Configure the public Guesty webhook as:

`https://<production-host>/api/webhook/guesty-reservation`

Keep one app replica. The daily scheduler runs inside the web process, and one
replica avoids duplicated scheduler work and migration races during startup.
The Compose template explicitly declares `DB_PRIVATE_NETWORK=true` because its
PostgreSQL port is not published outside the private Docker bridge. Managed or
remote PostgreSQL must instead use `DB_SSL=true` with certificate verification.

### Encrypted off-site backups and restore drill

The repository supplies host-operated scripts under `scripts/ops/`. They make a
PostgreSQL custom-format dump, verify it with `pg_restore --list`, encrypt and
copy it to an off-site [restic](https://restic.net/) repository, and apply
retention there. The application container never receives the restic password.

On the Hetzner host, install Docker Compose, `restic` and PostgreSQL client
tools (`pg_restore`). Create a dedicated non-login `guesty-ops` account, a
root-owned `/etc/guesty-mydata/backup.env` (mode `600`), and a separate restic
password file (mode `600`). The service account needs access to the Docker
socket only through the carefully reviewed local operations policy.

`/etc/guesty-mydata/backup.env` contains only deployment values, never fiscal
documents or AADE credentials:

```bash
POSTGRES_DB=guesty_mydata
POSTGRES_USER=guesty_backup
RESTIC_REPOSITORY=s3:https://<encrypted-offsite-bucket>/guesty-mydata
RESTIC_PASSWORD_FILE=/etc/guesty-mydata/restic-password
GUESTY_BRIDGE_BACKUP_DIR=/srv/guesty-mydata-backups
GUESTY_BRIDGE_BACKUP_RETENTION_DAYS=35
GUESTY_BRIDGE_HEALTH_URL=http://127.0.0.1:3001/health/ready
GUESTY_BRIDGE_BACKUP_MAX_AGE_HOURS=26
GUESTY_BRIDGE_RESTORE_DRILL_MAX_AGE_DAYS=35
# Optional endpoint controlled by the operator; receives only a short plain-text
# operational alert, never XML, PDFs, credentials, reservation data or MARKs.
GUESTY_BRIDGE_ALERT_WEBHOOK_URL=https://<your-monitoring-receiver>/guesty-mydata
```

Initialize the empty restic repository once under controlled access, then copy
the two systemd unit files and enable the timer:

```bash
sudo install -m 644 scripts/ops/backup-postgres.service /etc/systemd/system/
sudo install -m 644 scripts/ops/backup-postgres.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now backup-postgres.timer
sudo systemctl list-timers backup-postgres.timer
sudo systemctl start backup-postgres.service
```

Run a restore drill at least monthly and after every schema/encryption-key
change. Fetch a chosen verified dump from restic to an absolute, protected host
path, then run the drill. It restores only into a timestamped temporary
database and removes that database at the end; it never drops the live
`POSTGRES_DB`.

```bash
bash scripts/ops/restore-drill-postgres.sh /srv/guesty-mydata-backups/VERIFIED.dump
```

Record the restic snapshot ID, dump SHA-256, restore-drill timestamp, reviewer
and result in the operations register. An absent or failed drill is a production
readiness failure. The script writes an immutable-age monitor receipt only after
the temporary-database verification passes. Then enable the five-minute monitor:

```bash
sudo install -m 755 scripts/ops/monitor-bridge-health.sh /srv/guesty-mydata-bridge/scripts/ops/
sudo install -m 644 scripts/ops/monitor-bridge-health.service /etc/systemd/system/
sudo install -m 644 scripts/ops/monitor-bridge-health.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now monitor-bridge-health.timer
sudo systemctl start monitor-bridge-health.service
sudo systemctl status monitor-bridge-health.service --no-pager
```

The monitor fails its systemd run (and posts the terse configured alert) if the
local app health endpoint fails, the last verified encrypted backup is older
than 26 hours, or the last successful restore drill is older than 35 days.
Connect systemd service failures and the optional webhook to the operator's
monitoring/paging receiver before production activation.

## Runtime safety model

- The scheduled close runs Guesty reconciliation before deciding what is due.
  If reconciliation fails, every company execution for that tick is skipped and
  no staged fiscal document is transmitted as if the Guesty view were complete.
- Unmapped or inactive Guesty reservations are retained in the reconciliation
  inbox while the successful watermark advances. The next reconciliation and
  the explicit retry endpoint revisit those entries after configuration is fixed.
  A general Guesty fetch/search outage still fails the run and keeps the prior
  successful watermark unchanged.
- Unified policies are independent for every exact
  `company × listing × Guesty account × platform × source`. No Booking.com,
  Airbnb, other OTA/direct, or Guesty Booking Engine policy is inherited by
  another combination. Legacy financial profiles remain audit/sandbox-only and
  can never authorize production issuance.
- The production submission guard evaluates tenant-scoped readiness with
  `GET /api/readiness?company_id=<id>`. A fiscal issue in another company does
  not block this company's submissions; runtime-wide configuration remains a
  global prerequisite.
- A verified invoice MARK and its exact PDF bytes, SHA-256, issuer/recipient and
  render snapshot are archived atomically. PDF download serves only this
  MARK-bound artifact. Branding changes do not rewrite an issued PDF.
- A successful `CancelInvoice` initially stores its cancellation MARK as pending
  verification. Before the next daily close submits new invoices for that
  company, it automatically verifies every due pending cancellation through
  `RequestTransmittedDocs`. Failure blocks that company's close. The manual
  reconcile endpoint remains available for uncertain or operator-driven recovery.

## Sandbox acceptance gate

Before production activation, all of the following must be recorded:

1. Successful Guesty authenticated connection check within the last 24 hours.
2. Successful AADE sandbox connection check for every active company within the
   last 24 hours.
3. Accountant-reviewed sandbox capability evidence for every document family
   actually used by the company: `2.1+8.2` and `5.1`, and/or `11.2+8.2` and
   `11.4`, plus one `CancelInvoice` whose cancellation MARK was independently
   confirmed through `RequestTransmittedDocs`. Evidence includes request XML,
   AADE responses, MARK/UID where returned, verification, and final PDFs.
4. Every active listing mapped to the correct company, document rule, series,
   counterpart where TPY is used, and high/low TAKK amount and category.
5. Every observed active `listing/platform/source` covered by one approved,
   versioned unified policy with the required exact passing calibration samples,
   immutable decision and accounting/technical approvals.
6. No unresolved reservation review items.
7. No unresolved Guesty reconciliation inbox entries after an explicit retry.
8. `GET /api/readiness?company_id=<id>` reports sandbox ready for each company;
   the unscoped endpoint is used as an overall operations view.

## Controlled production activation

Take a fresh database backup first. Then, in one maintenance window:

1. Stop incoming Guesty deliveries or record the start time for replay checks.
2. Confirm that Admin shows no missing sandbox capability for any company. Each
   acceptance run is bound to the issuer VAT, current encrypted AADE credentials,
   and fiscal contract version; credential rotation requires new evidence.
3. Set `MYDATA_ENV=production`.
4. Set `MYDATA_PRODUCTION_ENABLED=true` only after both previous values have
   been independently reviewed.
5. Redeploy one instance and rerun every company connection test.
6. Run Guesty reconciliation, retry the unresolved inbox and verify that its
   successful watermark covers the maintenance window before enabling sends.
7. Issue and immediately verify one controlled low-risk production document.
8. Confirm the document has one immutable PDF artifact and that repeated PDF
   downloads match its archived SHA-256.
9. Enable `DAILY_CLOSE_ENABLED=true` only after that document and its PDF have
   been approved. Redeploy and confirm the next scheduled business date.
10. Restore or replay any Guesty deliveries received during the maintenance
   window and check the review queue.

Never use a production AADE credential while `MYDATA_ENV=sandbox`, or a sandbox
credential while `MYDATA_ENV=production`.

## Backup and restore

For Render, enable the provider's scheduled backups and point-in-time recovery
where available. Export a periodic logical backup to encrypted off-provider
storage and test restoration into a separate database.

For Docker Compose, create a logical backup without exposing the password on the
command line:

Keep backups outside the repository and Docker build context:

```bash
export GUESTY_BRIDGE_BACKUP_DIR="/srv/guesty-mydata-backups"
mkdir -p "$GUESTY_BRIDGE_BACKUP_DIR"
chmod 700 "$GUESTY_BRIDGE_BACKUP_DIR"
docker compose exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$GUESTY_BRIDGE_BACKUP_DIR/bridge-$(date +%F-%H%M%S).dump"
```

Encrypt and copy the dump off-host. A backup is not accepted until a test restore
has completed successfully. To restore, first stop the app and use a new empty
database. The following operation overwrites database contents and therefore
requires explicit approval and a verified backup:

The database dump contains fiscal XML, Guesty-derived snapshots, recipient data,
and the exact archived PDF bytes. Treat the dump as sensitive accounting and
personal data both at rest and in transit; storage encryption is an external
deployment responsibility.

```bash
docker compose stop app
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < "$GUESTY_BRIDGE_BACKUP_DIR/VERIFIED.dump"
docker compose start app
```

After restoration, confirm tenant-scoped readiness, document counts, MARK/UID
records, one `fiscal_pdf_artifacts` row for every verified active fiscal document,
artifact SHA-256 integrity, recent daily-close runs, the Guesty successful
watermark, reconciliation inbox, and connection checks before reopening webhook
traffic.

## Encryption-key escrow

`DATA_ENCRYPTION_KEY` protects AADE credentials and the persisted Guesty token.
Loss of this key makes those encrypted values unrecoverable even when a database
backup exists.

AADE credentials use authenticated encryption bound to the company's VAT number
and the exact credential field. Changing a VAT number re-encrypts both fields;
copying ciphertext between companies or fields is intentionally rejected.

- Store one copy in the deployment secret manager.
- Store a second encrypted copy in the organization's password vault or offline
  escrow, accessible to two named custodians.
- Record only its identifier and creation date in the operations register.
- Test escrow recovery during a restore drill without printing the key.

For a controlled rotation, stop the scheduler and take a verified backup. Set
the new value in `DATA_ENCRYPTION_KEY` and the old value temporarily in
`DATA_ENCRYPTION_KEY_PREVIOUS`, run `npm run migrate`, restart, and verify every
company myDATA connection plus the Guesty connection. The migration
re-encrypts company/legacy credentials and the persisted Guesty token with the
new key. Remove `DATA_ENCRYPTION_KEY_PREVIOUS` and restart again only after all
checks pass. Never keep the previous key configured after the maintenance
window.

## Rollback

Record the Git commit and container image digest for every release. If the new
release fails before any schema or fiscal operation, deploy the previous image.
If database changes or myDATA transmissions occurred, do not blindly restore an
old database or resend documents: stop the scheduler, preserve the current
database, compare MARK/UID and daily-close records, and decide recovery with the
accountant.

For a VPS rollback:

```bash
docker compose stop app
docker image ls guesty-mydata-bridge --digests
# Set the reviewed previous image reference in compose.yaml, then:
docker compose up -d --no-deps app
curl --fail http://127.0.0.1:3001/health/ready
```

Keep `MYDATA_PRODUCTION_ENABLED=false` during investigation unless continued
production transmission is an explicit, reviewed decision.

## Current operational gaps

The following capabilities are not implemented by this repository and must not
be assumed during production planning:

- PDF email/Guesty-message delivery, a delivery outbox, recipient delivery audit,
  bounce handling, and retry are absent. PDFs are archived and downloadable by
  an authenticated admin only.
- The admin API remains a shared operational bearer credential and does not
  provide per-user identity, company membership, MFA or a full RBAC product.
  Policy activation is nevertheless separately protected by named accounting
  and technical approval credentials.
- The scheduler runs inside the single web process with one global timezone and
  close time. There is no external durable scheduler, per-company timezone, or
  supported multi-replica leader election.
- The supplied backup, restore-drill and five-minute monitor workflows still
  require host installation, a configured encrypted off-site repository,
  protected password file and a connected external alert receiver.
- Schema initialization is performed by the application migration command/startup
  code; there is no independently versioned rollback migration chain.
- Logging is console-based. The bundled monitor covers app health, backup age
  and restore-drill age, but there is no full metrics/tracing stack or automatic
  paging for reconciliation lag, unresolved inbox age, failed closes, uncertain
  MARKs or PDF archive corruption.
- Fiscal retries do not provide a general exponential-backoff job queue or a
  separately operated dead-letter queue. The Guesty reconciliation inbox is
  specific to unresolved mapping/inactive-listing records and their retry errors;
  it is not a universal job queue.

Production deployment therefore requires external backup automation,
monitoring/alerting, access-control compensating controls, and an explicit manual
PDF delivery process until those application features are implemented.
