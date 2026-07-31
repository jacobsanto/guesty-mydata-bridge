# Deployment runbook

This runbook deploys one application instance backed by PostgreSQL. Every new
deployment starts against the AADE sandbox, with automatic daily closing and
production transmission disabled.

## Required secrets and records

Keep secrets in the platform secret manager or in an uncommitted `.env` file.
Never put them in Git, a ticket, chat, image, log, or database backup note.

- `ADMIN_API_TOKEN`: a unique high-entropy bearer token for the admin API.
- `DATA_ENCRYPTION_KEY`: exactly 32 random bytes, base64 encoded.
- `GUESTY_CLIENT_ID`, `GUESTY_CLIENT_SECRET`, and
  `GUESTY_WEBHOOK_SECRET` from Guesty.
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

The first value can be used for `ADMIN_API_TOKEN`; the second is the
`DATA_ENCRYPTION_KEY`.

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
7. Open `https://<render-host>/admin`, enter the bearer token, configure each
   company and listing, and run the Guesty and myDATA sandbox connection tests.
8. Register this Guesty webhook URL and subscribe it to the required reservation
   events:

   `https://<render-host>/api/webhook/guesty-reservation`

9. Stage representative Guesty reservations for every observed
   `listing/platform/source`. Create a draft financial profile for each exact
   combination, classify every Guest Folio line explicitly, and calibrate it
   against accountant-confirmed taxable gross amounts. Cover at least the normal,
   discount, additional-fee, tax, alteration and cancellation cases relevant to
   that channel. Include Airbnb Resolution Center cases when they occur.
   Treat Airbnb, Booking.com, Guesty Booking Engine and every other OTA/direct
   source as independent channels. Never copy an approved profile to a channel
   merely because its line names or displayed total look similar.
10. Approve only profiles whose required samples all pass. Unknown or ambiguous
    lines must remain blocked; do not add catch-all include rules.
    Replace any legacy billing rules that identify only `source` with exact
    `platform/source` rules; readiness deliberately blocks while legacy rules
    remain active.
11. Send a controlled reservation through sandbox, run daily close manually,
    verify the transmitted document through the API, review the MARK/UID and PDF,
    and obtain accountant approval.

Do not expose the Render PostgreSQL public endpoint unless it is temporarily
required for a controlled maintenance task. The Blueprint connects over the
private Render network.

## VPS deployment with Docker Compose

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
5. Every observed active `listing/platform/source` covered by an approved,
   versioned financial profile with the required passing calibration samples.
6. No unresolved reservation review items.
7. `GET /api/readiness` reports sandbox ready.

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
6. Issue and immediately verify one controlled low-risk production document.
7. Enable `DAILY_CLOSE_ENABLED=true` only after that document and its PDF have
   been approved. Redeploy and confirm the next scheduled business date.
8. Restore or replay any Guesty deliveries received during the maintenance
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

```bash
docker compose stop app
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < "$GUESTY_BRIDGE_BACKUP_DIR/VERIFIED.dump"
docker compose start app
```

After restoration, confirm readiness, document counts, MARK/UID records, recent
daily-close runs, and connection checks before reopening webhook traffic.

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
