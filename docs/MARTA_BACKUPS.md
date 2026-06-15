# MARTA Database Backups

The MARTA history DB (`state/marta.sqlite`) is backed up off-box to Cloudflare
R2. The backup script uses SQLite's online `.backup`, then integrity-checks,
gzips, and uploads the snapshot.

Scripts:

- `scripts/marta/backup-db.sh`
- `scripts/marta/restore-db.sh`

## Server Setup

The default backup target is:

```text
r2atlanta-db:atlanta-transit-insights-db-backups
```

Configure an rclone remote on the server using the R2 API token scoped to the
`atlanta-transit-insights-db-backups` bucket:

```sh
rclone config create r2atlanta-db s3 \
  provider=Cloudflare \
  access_key_id=<ACCESS_KEY_ID> \
  secret_access_key=<SECRET_ACCESS_KEY> \
  endpoint=https://<account-id>.r2.cloudflarestorage.com \
  acl=private
```

Verify the remote:

```sh
rclone lsf r2atlanta-db:atlanta-transit-insights-db-backups
```

Run the first backup:

```sh
scripts/marta/backup-db.sh
scripts/marta/restore-db.sh --list
```

## Schedule

The MARTA cron block runs a daily backup at 04:23 and logs to:

```text
state/logs/backup-db.log
```

Install or refresh the cron block with:

```sh
scripts/marta/install-crontab.sh
```

## Retention

The script keeps only two local temp backups in `tmp/marta-db-backups/`.
Configure remote retention with an R2 lifecycle rule on the bucket, rather than
scripted deletes from the server.

Suggested rule:

- delete objects after 14 days
- abort incomplete multipart uploads after 1 day

## Restore

```sh
scripts/marta/restore-db.sh --list
scripts/marta/restore-db.sh
scripts/marta/restore-db.sh marta-YYYYMMDD-HHMMSS.sqlite.gz
```

The restore script does not overwrite the live DB. It verifies a restored copy
under `tmp/marta-db-backups/` and prints the manual swap-in steps.
