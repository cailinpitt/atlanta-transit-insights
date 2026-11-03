# Vehicle position archive

Every MARTA bus, rail and streetcar position we poll is written to
`bus_observations`, `rail_observations` and `streetcar_observations`. Those
tables keep a **14-day hot window**, enough for every detector (the longest
lookback is 7 days) and for `export-event-tracks` (6.5 days). Completed Atlanta
calendar days are archived as **Parquet only**, one file per feed/day/revision.
The new contract below takes effect when the operator completes the cutover;
deploying this code alone does not migrate the public archive.

## Format and layout

- One sort order per feed, ascending; identifiers sort as strings and null
  `vehicle_id`s sort last:
  - bus: **`route, vehicle_id, ts`**
  - rail: **`line, direction, train_id, ts`** (a train's identity is
    `(line, direction, train_id)`; train ids repeat across lines)
  - streetcar: **`line, vehicle_id, ts`**
- ZSTD level 3; requested row groups of 122,880 rows; no outer gzip wrapper.
- Explicit types: identifiers/dates are strings, timestamps and integer fields
  are `BIGINT`, coordinates and `speed` are `DOUBLE`. Coordinates are not rounded.
- Original fields, nulls and duplicate multiplicities are retained. Values are
  not normalized: `ts` is poll time in epoch ms; bus `vehicle_ts` stays in epoch
  **seconds**, as the feed sends it; rail and streetcar `event_ts` are epoch ms.
- Bus `start_date` is **YYYYMMDD** (the GTFS-rt trip service date), separate
  from the archive calendar day.
- Partitions run midnight to midnight in `America/New_York`, including 23/25-hour
  DST days. Archive dates start at 2026-09-28. These are calendar days, not
  necessarily scheduled service dates.
- Latitude and longitude are retained as scalar columns. Geometry is constructed
  by GIS consumers when needed.

Files have content-addressed URLs:

```text
https://data.atlantatransitalerts.app/positions/{bus,rail,streetcar}/YYYY/MM/YYYY-MM-DD.{sha256}.parquet
```

A correction produces a new path; old Parquet objects and manifests remain
available. `--reexport-date` records the replaced path/checksum. Do not remove
old Parquet revisions with bucket lifecycle rules.

## Discovery and reproducible downloads

`https://data.atlantatransitalerts.app/positions/index.json` becomes a small
**version-2 pointer**, rather than the old index's list of days:

```json
{
  "manifest_version": 2,
  "path": "positions/manifests/<sha256>.json",
  "sha256": "<sha256>",
  "bytes": 12345
}
```

Resolve `path` relative to `https://data.atlantatransitalerts.app/`, verify its
bytes/checksum, then read the immutable manifest. It has `manifest_version: 2`,
`schema_version: 2`, `title`, `generated_at`, `timezone`, `days_are`,
`format: "parquet"`, `compression: "zstd"`, `sort_order` (an object keyed by
feed), `previous_manifest`, `base_url`, `coverage`, `feeds`, `known_gaps` and
`days` (newest first). Field types, units, nullability and caveats are in
`feeds`; see `SCHEMA` in `src/marta/positionsArchive.js`.

Each day has `date`, `weekday`, per-feed `rows`, and `files`. Each file records
`path`, `format`, `schema_version`, `data_revision` (the SHA-256), `sha256`,
`bytes`, `rows`, `ts_min`, `ts_max`, the feed's own timestamp range
(`vehicle_ts_min`/`vehicle_ts_max` for bus, in epoch seconds;
`event_ts_min`/`event_ts_max` for rail and streetcar, in epoch ms), `writer`
and `quality`. Time bounds are inclusive observed extrema, null for no values.
Quality contains distinct poll times and invalid/missing coordinate row counts.
Empty feeds (e.g. rail on 2026-10-29) still have a typed Parquet file. These
counts describe recorded data; they do not assert polling completeness.

Pin the immutable manifest URL for repeatable analysis. Never glob all Parquet
objects for a day: a directory may contain superseded revisions. The public
manifest lists one canonical object per feed/day.

Shell, with `curl`, `jq` and the DuckDB CLI (after cutover):

```sh
base=https://data.atlantatransitalerts.app
manifest=$(curl -s "$base/positions/index.json" | jq -r .path)
file=$(curl -s "$base/$manifest" | jq -r '.days[0].files.rail.path')
curl -so rail.parquet "$base/$file"
duckdb -c "SELECT line, count(*) AS rows FROM 'rail.parquet' GROUP BY line ORDER BY line"
```

Python download and checksum verification (after cutover):

```python
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen
import pandas as pd

base = "https://data.atlantatransitalerts.app/"
def fetch(path):
    request = Request(base + path, headers={"User-Agent": "positions-parquet-example/1"})
    with urlopen(request) as response:
        return response.read()

def verified_bytes(file):
    body = fetch(file["path"])
    assert len(body) == file["bytes"]
    assert hashlib.sha256(body).hexdigest() == file["sha256"]
    return body

pointer = json.loads(fetch("positions/index.json"))
assert pointer["manifest_version"] == 2
manifest = json.loads(verified_bytes(pointer))
file = manifest["days"][0]["files"]["bus"]
Path("bus.parquet").write_bytes(verified_bytes(file))
df = pd.read_parquet("bus.parquet", columns=["route", "vehicle_id", "ts", "lat", "lon"])
```

Install `pandas` and `pyarrow` for this example. For large files, stream downloads
and hashing instead of retaining the downloaded bytes in memory.

DuckDB CLI against that local file (or a manifest-selected HTTPS URL):

```sql
SELECT route, vehicle_id, to_timestamp(ts / 1000.0) AS poll_time,
       to_timestamp(vehicle_ts) AS position_time, lat, lon
FROM read_parquet('bus.parquet')
WHERE route = '39'
ORDER BY vehicle_id, ts
LIMIT 20;
```

An HTTP reader can fetch selected columns and skip row groups using statistics;
actual savings depend on the query and host. The per-feed orders favor
trajectories and compression. A short time window across all routes or an area
query can still touch many groups.

GIS consumers can construct points with GeoPandas (longitude first):

```python
import geopandas as gpd
valid = df["lat"].between(-90, 90) & df["lon"].between(-180, 180)
gdf = gpd.GeoDataFrame(
    df.loc[valid].copy(),
    geometry=gpd.points_from_xy(df.loc[valid, "lon"], df.loc[valid, "lat"]),
    crs="OGC:CRS84",
)
```

## Fields

The authoritative descriptions are in the manifest's `feeds`, generated from
`src/marta/positionsArchive.js`. Types follow the SQLite schema in
`src/marta/storage.js`.

### bus

| field | type | null? | notes |
|-------|------|-------|-------|
| `ts` | integer | no | poll time, epoch ms |
| `route` | string | no | public route number from the realtime feed, not the GTFS `route_id`; join on `trip_id` |
| `trip_id` | string | yes | GTFS `trip_id` |
| `vehicle_id` | string | yes | GTFS-rt vehicle id |
| `label` | string | yes | GTFS-rt vehicle label as the feed sends it; a separate identifier from `vehicle_id` (e.g. vehicle `2303` has label `1603`) |
| `lat`, `lon` | number | yes | |
| `bearing` | integer | yes | degrees clockwise from true north. MARTA omits zero-valued fields, so `0` never appears and null usually means heading north |
| `speed` | number | yes | m/s. `0` never appears for the same reason, so null (~44% of rows) mostly means stopped (~0), not unknown. Some vehicles report implausible values (e.g. vehicle 4756 at a constant 35.76 m/s); treat values above ~31 m/s as suspect |
| `occupancy` | string | yes | GTFS-rt occupancy status (`EMPTY`, `MANY_SEATS_AVAILABLE`, `FEW_SEATS_AVAILABLE`, `STANDING_ROOM_ONLY`, `CRUSHED_STANDING_ROOM_ONLY`, `FULL`) |
| `vehicle_ts` | integer | yes | feed-reported position time, epoch **seconds**, stored as-is. Usually lags `ts` (median ~23s, p99 ~400s, up to ~25 min); around the fall-back DST change MARTA's feed has run up to ~1h ahead of `ts` |
| `start_date` | string | yes | trip service date, `YYYYMMDD` |

### rail

| field | type | null? | notes |
|-------|------|-------|-------|
| `ts` | integer | no | poll time, epoch ms |
| `train_id` | string | no | not unique within a poll; the unique key is (`line`, `direction`, `train_id`) |
| `line` | string | no | `RED`, `GOLD`, `BLUE`, `GREEN` |
| `direction` | string | yes | `N`, `S`, `E`, `W` |
| `destination` | string | yes | destination station |
| `lat`, `lon` | number | yes | |
| `delay_sec` | integer | yes | reported delay, positive = late, negative = early. Null on ~2–4% of rows |
| `event_ts` | integer | yes | feed `EVENT_TIME` (America/New_York wall clock), epoch ms |

### streetcar

| field | type | null? | notes |
|-------|------|-------|-------|
| `ts` | integer | no | poll time, epoch ms |
| `vehicle_id` | string | no | OTP vehicle id, e.g. `MARTA:1001` |
| `label` | string | yes | fleet number, e.g. `1001` |
| `line` | string | no | `SC` |
| `direction` | string | yes | GTFS `direction_id`, `"0"` or `"1"` |
| `trip_id` | string | yes | OTP trip id with a `MARTA:` prefix; strip it to join GTFS `trips.txt` |
| `lat`, `lon` | number | yes | |
| `event_ts` | integer | yes | feed `lastUpdate`, epoch ms |

## Collection caveats

- Positions are polled about every 30 seconds.
- A poll that returns no vehicles writes no rows, so a feed outage and a
  period with no service look the same in the archive.

### Known gaps

Times are Atlanta time. Missing polls mean missing rows, not reduced service,
so leave these windows out of fleet and headway counts. The same list is in
the manifest as `known_gaps`; keep this table in sync with `KNOWN_GAPS` in
`src/marta/positionsArchive.js` (a test checks).

| Start | End | Kinds | Missing | Note |
|---|---|---|---|---|
| 2026-10-28 | 2026-10-30 | rail, streetcar | 01:20 to 18:40 | Effectively dark after a MARTA rail API change; 2026-10-29 has 0 rail rows |
| 2026-10-30 | 2026-10-30 | bus, rail, streetcar | 18:40 to 19:07 | ~26.5 min gap during the deploy that fixed the rail API change |

On 2026-11-01 (~06:00Z to 11:00Z), 403 rail rows were stored with `event_ts`
1h early, from a DST bug in the `EVENT_TIME` parser. The parser is fixed and
these rows were corrected in place before the day was archived, so the archive
is unaffected.

## Daily publication and retention

`bin/marta/export-positions.js` runs nightly at 02:40 server time
(America/Chicago, so 03:40 ET; `cron/marta-crontab.txt`), before the 04:23 DB
backup. It reads completed days directly from SQLite with `better-sqlite3`,
appends typed rows to a disk-backed DuckDB staging database, and sorts/writes
Parquet. The pinned `@duckdb/node-api` release bundles DuckDB; production needs
no external DuckDB CLI, extension download, query service or NDJSON intermediate.

The writer uses one thread and a `256MB` DuckDB memory limit (override with
`POSITIONS_MEMORY_LIMIT`). This is a DuckDB buffer limit, not a total process RSS
limit. Leave disk space for staging/spill and the permanent archive; process
feeds/days sequentially. Validate resources on the deployment host.

1. Validate schema and partition boundaries. Every field must match its
   declared type and nullability (integers must be safe integers, so a REAL
   that SQLite affinity left in an INTEGER column is rejected), `ts` must fall
   inside the day, and bus `start_date` must be YYYYMMDD. Write into a
   temporary directory.
2. Read back each file and compare every field with **symmetric `EXCEPT ALL`**,
   including duplicate multiplicity. Validate schema metadata, hash and rename
   the completed output to its immutable path.
3. Persist pending state. Upload every feed, then stream remote bytes through
   SHA-256 and size checks. ETags are not treated as SHA-256. Uploads pass
   `--s3-no-head`: R2 returns 501 to rclone v1.60's versioned HEAD after a PUT,
   and the remote re-hash already verifies the object.
4. Upload and verify an immutable manifest. Update and verify `index.json`
   **last**, then persist the day's committed state.
5. Delete old positions in hourly batches, stopping at the first day lacking
   all three verified Parquet files and a committed manifest. An upload or
   publication error aborts before deletion. Pending publication is retried
   even when the next run has no new days.

Parquet and immutable manifests use one-year immutable caching. The latest
pointer uses a five-minute cache. Parquet is served as
`application/vnd.apache.parquet` without `Content-Encoding: gzip`. Objects go
to `r2atlanta:atlanta-transit-alerts-data/positions/`.

```sh
npm run marta:export-positions:dry                  # scratch outputs; no upload or DB/state change
node bin/marta/export-positions.js --limit 3        # at most three unfinished days
node bin/marta/export-positions.js --publish-index
node bin/marta/export-positions.js --reexport-date 2026-11-01
```

Corrections from SQLite are limited to completed days still inside the 14-day
hot window; older data cannot be rebuilt from a pruned table. For older revisions,
restore the complete source into a separate database and implement/validate the
correction before publication; do not remove manifest entries to force a re-export.

Overrides are `MARTA_HISTORY_DB_PATH`, `POSITIONS_MANIFEST_PATH`,
`POSITIONS_ARCHIVE_DIR` and `RCLONE_REMOTE`. Daily export and migration share an
exclusive `<manifest path>.lock`. After a hard crash, confirm the recorded PID
is gone and no exporter/migration is running before removing a stale lock and
retrying. Corrupt, missing or legacy state fails closed; restore it rather than
silently rebuilding pruned history as empty files. An intentionally new archive
with a complete SQLite history can initialize its state to
`{"manifest_version":2,"days":{},"published":null}`. Existing archives must migrate.

## One-time migration and cutover

This is a breaking distribution change. The operator coordinates the date and
updates the subscription/download UI (`atlanta-transit-alerts`) and consumers
outside this repository. Deploying this code before migrating is safe but the
nightly exporter will fail closed against the legacy manifest (no upload, no
pruning) until the migration completes, so migrate promptly. Observers can
continue. The migration does not prune SQLite.

```sh
npm ci
npm run marta:migrate-positions                    # stage and verify historical Parquet
npm run marta:migrate-positions -- --cutover       # verify all replacements; switch index last
npm run marta:export-positions                     # catch up completed days; nightly cron resumes
# After updating public links/consumers and verifying the public host:
npm run marta:migrate-positions -- --retire-ndjson
```

The first command inventories **both** the local legacy manifest
(`state/positions-manifest.json`, keyed by date with `files` and `uploaded`) and
the published `index.json` (either the original oldest-first format with
`schema` or the newest-first format with `feeds`/`known_gaps`), including
published days absent from local state. It downloads missing inputs from the
configured bucket, checks original size/SHA-256/row count, streams conversion,
and rejects unexpected fields. Legacy days with 0 rows (rail and streetcar on
2026-10-29, streetcar on 2026-10-28) become typed empty Parquet files. It
preserves the old index until `--cutover`. Progress is saved in
`<manifest path>.parquet-migration`; retries reuse validated outputs. A
`<manifest path>.ndjson-backup` preserves the old metadata, while the new
state's per-day `sources` ledger records input and destination checksums and
validation counts. Metadata backups are not parallel NDJSON archives.

The matching legacy index is saved as `archive/positions/index.ndjson-backup.json`
(under `POSITIONS_ARCHIVE_DIR` when overridden), including days found only in the
published index. Keep both metadata backups through the cutover.

Retirement verifies the published manifest and each Parquet replacement again
before deleting the corresponding old `.ndjson.gz` object and local file. It is
resumable and records retirement in the ledger. It never deletes superseded
Parquet revisions. Remove old links and purge or expire cached NDJSON responses
at the CDN; old endpoints should disappear, not return Parquet under a `.gz` URL.
No daily NDJSON producer remains after this change.

Before retiring inputs, test the **actual public Parquet URL** with HEAD, a
`Range: bytes=0-3` GET (expect `206` and `PAR1`), and a remote DuckDB query. For
browser consumers check CORS and exposure of `Accept-Ranges`, `Content-Range`,
`Content-Length` and `ETag`; disable transformations/outer compression. Local
writer tests and simulated upload failures do not establish production CDN or
R2 configuration.

If staging fails, rerun it after fixing the cause; the old index and inputs are
intact. If the latest-pointer upload succeeds but verification/state saving
fails, rerun `--cutover`: it recognizes the new pointer and completes state.
Before retirement, rolling back the cutover requires restoring the old manifest,
its matching old index and old exporter together. After retirement, restore from
Parquet; do not restart the legacy exporter over pruned SQLite history.

The DB backup excludes the position tables ([MARTA_BACKUPS.md](MARTA_BACKUPS.md));
the verified object archive is their off-box copy. Keep local manifest state
backed up too. Scripts that query old incidents in SQLite still only work inside
the hot window; load manifest-selected Parquet files for older data.
