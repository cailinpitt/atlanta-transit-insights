# Web data origin (R2)

The high-churn public data files (`alerts.json`, `daily-counts.json`, and
`alerts.csv`) are served from **Cloudflare R2** at
`https://data.atlantatransitalerts.app`, not committed into the frontend Pages
repo. This keeps the every-few-minutes data churn (and the deploy it would
trigger) out of the `atlanta-transit-alerts` site repo.

## Data flow

```
atlanta-transit-insights (server)             atlanta-transit-alerts (GitHub Pages)
─────────────────────────────────             ─────────────────────────────────────
bin/marta/push-web-data.sh                     runtime: client fetch()s
  marta/export-web.js   -> tmp/web-data/alerts.json    https://data.atlanta…/alerts.json
  marta/export-daily.js -> tmp/web-data/daily-counts   (always fresh)
  export-csv.js         -> tmp/web-data/alerts.csv
  marta/export-standard-site.js -> standard-site.json  (standard.site manifest)
  cmp vs .last  ── unchanged? stop
        │ changed
        ├─ rclone copyto … r2atlanta:atlanta-transit-alerts-data    build time: site fetches the
        │   (Cache-Control: public, max-age=30)         same files from R2 into public/data/,
        └─ POST repository_dispatch ─────────►          then prerenders OG cards / feed
            {event_type: data-updated} to
            cailinpitt/atlanta-transit-alerts
```

A second, independent job writes to the same R2 origin: **`bin/marta/export-event-tracks.js`**
(`19-59/15`) archives each rail incident's vehicle-position window to
`tracks/<eventId>.json` so `/event/:id` pages can replay the disruption after
`rail_observations` roll off. It's keyed by event id and fetched lazily by the
frontend's `EventReplay` (not part of the `alerts.json` payload). See
[REPLAY.md](./REPLAY.md).

- **Live app data** comes straight from R2 — fresh regardless of when the site
  was last built.
- **Prerendered per-incident OG cards** (for social crawlers) still need a build,
  triggered two ways:
  - **event-driven** — `push-web-data.sh` fires `repository_dispatch` on change,
  - **catch-up** — the site's scheduled deploy as a backstop for any missed dispatch.

## The publisher — `bin/marta/push-web-data.sh`

Runs from cron (`14-59/15` — the every-post `webPushTrigger` flush kicks it
immediately on change; this run is the backstop). It:

1. Regenerates `alerts.json` (`bin/marta/export-web.js`), `daily-counts.json`
   (`bin/marta/export-daily.js`), `alerts.csv` (`bin/export-csv.js`), and
   `standard-site.json` (`bin/marta/export-standard-site.js`) into `tmp/web-data/`.
2. `cmp`s each against the previous run in `tmp/web-data/.last` — **exits early
   if nothing changed** (no upload, no rebuild).
3. `rclone copyto`s each changed file to the R2 bucket with
   `Cache-Control: public, max-age=30`.
4. POSTs a `repository_dispatch` (`event_type: data-updated`) to the site repo to
   trigger a rebuild of the prerendered cards.

Configurable via env (defaults in parens): `ATLANTA_INSIGHTS` (repo path),
`RCLONE_REMOTE` (`r2atlanta:atlanta-transit-alerts-data`), `DISPATCH_REPO`
(`cailinpitt/atlanta-transit-alerts`), `GITHUB_DISPATCH_TOKEN` (also read from
`.env` if unset). The crontab passes `NODE` explicitly because cron's `PATH`
usually lacks node.

## One-time setup

### R2 bucket + custom domain (Cloudflare dashboard)

Requires the `atlantatransitalerts.app` zone on Cloudflare. Then:

1. **R2 → Create bucket** → `atlanta-transit-alerts-data` (separate from the DB
   backups bucket used by `scripts/marta/backup-db.sh` — see
   [`MARTA_BACKUPS.md`](./MARTA_BACKUPS.md)).
2. **Bucket → Settings → Custom Domains → Connect Domain** →
   `data.atlantatransitalerts.app`. Cloudflare provisions the cert and creates the
   proxied DNS record.
3. **Bucket → Settings → CORS policy** → allow `GET`/`HEAD` from `*` (the data is
   public):

   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

### Edge caching (REQUIRED — do not skip)

**Without this, every poll and every visitor is proxied to the R2 origin, and
R2's TTFB spikes badly under load.** With it, origin is touched only on the ~30s
revalidation per edge colo and everyone else gets a fast edge HIT.

The blocker is that **R2 always emits `Vary: Origin` on any CORS-matched
response — even with `AllowedOrigins: ["*"]`**. Cloudflare refuses to cache any
response whose `Vary` is anything other than `Accept-Encoding`, so the file sits
at `cf-cache-status: DYNAMIC` until the header is stripped at the edge. Two rules
on the `atlantatransitalerts.app` zone fix it:

1. **Transform Rules → Modify Response Header → Create:** If _Hostname equals
   `data.atlantatransitalerts.app`_ → **Remove** header `Vary`. (Runs before the
   object is cached, so it makes the response cacheable. CORS still works —
   `Access-Control-Allow-Origin: *` is origin-independent.)
2. **Caching → Cache Rules → Create:** If _Hostname equals
   `data.atlantatransitalerts.app`_ → Cache eligibility **Eligible for cache**;
   Edge TTL **"Use cache-control header if present"** (respects the upload's
   `max-age=30`).

Verify:

```sh
curl -sI -H 'Origin: https://atlantatransitalerts.app' \
  https://data.atlantatransitalerts.app/alerts.json | grep -i 'cf-cache-status\|vary'
```

Expect **no** `Vary: Origin`, and `cf-cache-status` flips `MISS` → `HIT` on
repeat requests (resetting to `REVALIDATED` every ~30s).

### R2 write credentials (server)

The data bucket needs its own token + rclone remote, separate from the DB-backup
token:

1. **R2 → Manage R2 API Tokens → Create** → Object Read & Write, scoped to
   **`atlanta-transit-alerts-data`** only. Save the Access Key ID, Secret, and
   the account S3 endpoint.
2. On the server, add a dedicated `r2atlanta` remote (creds stay in
   `~/.config/rclone/rclone.conf`, never in git):

   ```sh
   rclone config create r2atlanta s3 \
     provider=Cloudflare \
     access_key_id=<ACCESS_KEY_ID> \
     secret_access_key=<SECRET_ACCESS_KEY> \
     endpoint=https://<account-id>.r2.cloudflarestorage.com \
     acl=private
   ```

   Verify: `rclone lsf r2atlanta:atlanta-transit-alerts-data` returns cleanly.

### GitHub dispatch token (server)

`push-web-data.sh` needs a token to fire the rebuild. Create a **fine-grained
PAT** scoped to the `cailinpitt/atlanta-transit-alerts` repo with **Contents:
Read and write** (sufficient to POST `repository_dispatch`). Put it in the
server's `.env` as `GITHUB_DISPATCH_TOKEN`, so both cron and the event-driven
spawn inherit it.

## Notes

- `alerts.json` is produced by `bin/marta/export-web.js`; the public data shape
  is documented in the consumer-facing changelog. Keep that changelog updated
  when the shape changes.
- The frontend cutover (point the site at the R2 origin, stop tracking the data
  files in git) lives in the `atlanta-transit-alerts` repo — verify the data-base
  URL and any fetch fallback there, not here.
