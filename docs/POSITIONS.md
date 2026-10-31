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

```sh
curl -sO https://data.atlantatransitalerts.app/positions/rail/2026/10/2026-10-30.ndjson.gz
gzip -dc 2026-10-30.ndjson.gz | head
```

```python
import pandas as pd
df = pd.read_json("https://data.atlantatransitalerts.app/positions/bus/2026/10/2026-10-30.ndjson.gz", lines=True)
```

## How it runs

`bin/marta/export-positions.js` runs nightly at 02:40 (`cron/marta-crontab.txt`),
before the 04:23 DB backup:

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
