# Event replay (position tracks)

Every rail incident on [atlantatransitalerts.app](https://atlantatransitalerts.app)
gets a **"▶ Watch it unfold"** player on its event page that animates the actual
train positions across the line schematic — you watch the stretch go cold and
the trains pile up, then recover. The frontend component is `EventReplay.jsx`
(in the `atlanta-transit-alerts` repo); this doc covers the server side that
feeds it.

**Scope: heavy rail only** (Red/Gold/Blue/Green). Bus incidents have no
schematic; streetcar positions live in a separate table with loop geometry and
are out of scope here — a streetcar incident simply gets no track file, so the
player renders nothing.

## The problem it solves

The raw positions live in `rail_observations`, which **rolls off after ~7 days**
(`src/marta/storage.js`). Incidents, though, keep a permanent permalink (90-day
timeline + an `/event/:id` page for each). So a replay can't read the live DB —
for anything older than a week the positions are already gone. The fix:
**archive each incident's position window to R2 before it rolls off**, keyed by
the incident's permalink id.

## Data flow

```
atlanta-transit-insights (server)              R2 (data.atlantatransitalerts.app)     atlanta-transit-alerts (frontend)
─────────────────────────────────             ────────────────────────────────────    ─────────────────────────────────
bin/marta/export-event-tracks.js  (cron, 15m)
  read tmp/web-data/alerts.json  ──────────────►  (authoritative event ids + segments)
  read rail_observations (positions) for each
    replayable rail incident in window
  build compact track, gzip
  rclone ──►  tracks/<eventId>.json (gzip)  ───►  GET tracks/<eventId>.json  ◄──── EventReplay fetches on Play
```

The archiver is **driven off the published `alerts.json`**, not a re-derivation
of incidents from the DB. That's deliberate: the event `id` is a Bluesky rkey,
and `alerts.json` already carries the canonical id plus the segment / direction
fields. Reading it guarantees a track's key matches the page that fetches it,
with zero duplication of `export-web.js`'s pairing logic. The DB is touched only
for raw positions.

## Track file shape (`tracks/<eventId>.json`)

```json
{ "eventId": "3mnebtsoe7n2d", "line": "red",
  "from": "Five Points", "to": "Airport", "stations": [...],
  "onset": 1780153502245, "resolved": 1780155002912,
  "affectedDir": "S",                      // travel-direction code of the cold direction
  "t0": …, "t1": …, "durSec": 4349,
  "vehicles": [ { "id": "101", "dir": "S", "s": [[tSec, lat, lon], …] } ] }
```

Samples are relative seconds from `t0` with 5-dp coords → tiny file, stored
gzipped with `Content-Encoding: gzip` (browsers decode transparently).
`affectedDir` lets the player color the segment red off the *affected*
direction's presence, so an opposite-direction train passing through a
one-directional cold doesn't clear it.

**Affected direction is trivial on MARTA.** Unlike CTA (whose `trDr` direction
codes are noisy, forcing a destination-text match), MARTA's rail feed carries a
clean `N/S/E/W` `DIRECTION` field. `rail_observations.direction`, the detection's
`scope.direction`, and the per-vehicle `dir` baked into the track are all the
same vocabulary, so the archiver passes the detection's direction straight
through as `affectedDir`. Null = undirected; the player falls back to
any-direction occupancy.

**Turnaround legs (`id` suffixes).** A train reverses direction at a terminal
under the *same* `train_id`. Merged into one track, the player's monotonic
de-jitter would drop the entire return leg (every "backward" sample), so the
train appears to vanish and teleport. `buildTrack` therefore **splits a vehicle
at a sustained direction change** (`segmentByDirection`): the outbound leg keeps
the bare `train_id` as its `id`, the return leg becomes `<id>~1` (then `~2`…).
Each leg is a single-direction track that fades out at the terminal and back in
on the return — which is what actually happened. The legs are time-disjoint, so
the "N trains on the line" readout never double-counts. A 1-ping
opposite-direction blip (feed noise) is absorbed, not split.

Pure builders live in `src/shared/eventTracks.js` (unit-tested in
`test/shared/eventTracks.test.js`). The bin
(`bin/marta/export-event-tracks.js`) is thin wiring: load alerts.json → query
positions → `buildTrack` → gzip → rclone. The position query `ORDER BY ts` (and
`buildTrack` re-sorts defensively) so segmentation and the relative-second keys
are correct regardless of row order.

## What gets archived

Rail incidents with a resolvable single line **and** a two-station segment
(`from` + `to`), whose `onset` is within the retention window (default 6.5 days,
safely inside the ~7-day rolloff). A **manifest** (`state/track-manifest.json`)
records which incidents have been archived after they resolved; those are
immutable and skipped. Active incidents re-upload each run until they resolve
(capturing the recovery), then finalize. Bus/streetcar incidents and
segment-less incidents are skipped.

Long incidents are clipped to a 4-hour window (`MAX_WINDOW_MS`): a planned
multi-day reroute surfaces as one days-long "incident" and would otherwise
produce multi-MB tracks; the formation + first hours are the watchable part.

## Storage

One small object per rail incident, **never expired** — a track should live as
long as its (permanent) event page. Uploads are bounded by the manifest to
active + newly-resolved incidents, so R2 Class-A op churn stays tiny. Reuses the
existing **`r2atlanta`** rclone remote (same as the data push / backups) — no
new credentials.

## Schedule

`19-59/15` (see `cron/marta-crontab.txt`) — offset to `:19` so it runs after the
`:14/15` `push-web-data.sh` refreshes `tmp/web-data/alerts.json`. The
healthchecks.io slug `export-event-tracks` is registered in
`scripts/configure-healthchecks.js`.

## Dev / validation

```sh
node bin/marta/export-event-tracks.js --check                  # imports resolve, no env/network
node bin/marta/export-event-tracks.js --dry-run                # build tracks into tmp/event-tracks/, upload nothing
node bin/marta/export-event-tracks.js --dry-run --event=<rkey> # one incident
node bin/marta/export-event-tracks.js --dry-run --alerts=/path/to/alerts.json
```

A dry run reads the live DB but writes only local files and leaves the manifest
untouched. Run it on the server (the laptop's `marta.sqlite` is a stale dev
artifact). First live run backfills every replayable incident still inside the
~7-day window.
