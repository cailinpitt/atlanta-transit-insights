# Vehicle position archive

Every MARTA bus, rail and streetcar position we poll is written to
`bus_observations`, `rail_observations` and `streetcar_observations`. Those
tables only keep a **14-day hot window**, enough for every detector (the
longest lookback is 7 days) and for `export-event-tracks` (6.5 days). Older
days live in a daily file archive that is also published for anyone to
download.

## Getting the data

Index: <https://data.atlantatransitalerts.app/positions/index.json>

The index lists every archived day with each file's path, row count, size and
sha256, plus the field list for each kind. Files are at:

```
https://data.atlantatransitalerts.app/positions/{bus,rail,streetcar}/YYYY/MM/YYYY-MM-DD.ndjson.gz
```

- One file per kind per Atlanta service day (midnight to midnight
  `America/New_York`), starting 2026-09-28.
- Gzipped NDJSON: one JSON object per line, ordered by `ts`.
- `ts` is when we polled the feed (epoch ms). Bus `vehicle_ts` is the GTFS-rt
  timestamp in epoch **seconds**; rail and streetcar `event_ts` are epoch ms.
- Positions are polled about every 30 seconds.
- A poll that returns no vehicles writes no rows, so a feed outage and a
  period with no service look the same in the archive.

## Fields

The authoritative descriptions are in `index.json` (`schema`), generated from
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
| `occupancy` | string | yes | GTFS-rt occupancy status |
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

## Known gaps and issues

- **2026-10-28 ~01:20 ET to 2026-10-30 ~18:40 ET:** rail and streetcar were
  effectively dark after a MARTA rail API change (2026-10-29 has 0 rail rows).
- **2026-10-30 ~18:40 ET:** a ~26.5 min gap on all feeds during the deploy
  that fixed the above.
- **2026-11-01 ~06:00Z to 11:00Z:** 403 rail rows were stored with `event_ts`
  1h early, from a DST bug in the `EVENT_TIME` parser. The parser is fixed and
  these rows were corrected in place before the day was archived, so the
  archive is unaffected.

```sh
curl -sO https://data.atlantatransitalerts.app/positions/rail/2026/10/2026-10-30.ndjson.gz
gzip -dc 2026-10-30.ndjson.gz | head
```

```python
import pandas as pd
df = pd.read_json("https://data.atlantatransitalerts.app/positions/bus/2026/10/2026-10-30.ndjson.gz", lines=True)
```

## How it runs

`bin/marta/export-positions.js` runs nightly at 02:40 server time
(America/Chicago, so 03:40 ET; `cron/marta-crontab.txt`), before the 04:23 DB
backup:

1. For each finished day since 2026-09-28 that isn't uploaded yet, it writes
   one file per kind to `archive/positions/` (the permanent copy on the
   server).
2. It uploads the files to `r2atlanta:atlanta-transit-alerts-data/positions/`
   and records them in `state/positions-manifest.json`. `positions/index.json`
   is rebuilt from the manifest.
3. It deletes position rows older than 14 days, but never past the first day
   that isn't uploaded yet. A failed run leaves the data in the DB for the
   next night.

Finished days never change, so a day is exported once. To re-export one,
delete its entry from the manifest and its files from `archive/positions/`.

```sh
npm run marta:export-positions:dry                  # write to tmp/positions-dry-run, no upload or delete
node bin/marta/export-positions.js --limit 3        # export at most 3 days this run
node bin/marta/export-positions.js --publish-index  # re-upload index.json only
```

The DB backup leaves the position tables out (`docs/MARTA_BACKUPS.md`); the R2
copy of the archive is the off-box backup for positions.
