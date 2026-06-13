# Porting `cta-insights` → `atlanta-transit-insights`

This repo is a fork-first port of [`cta-insights`](https://github.com/cailinpitt/cta-insights)
to MARTA / Atlanta. Because we copied the Chicago tree wholesale, CTA-specific code
will sit unused until it is either ported or deleted. This file is the source of truth
for **what is CTA-only and slated for removal**, so dead Chicago code doesn't quietly
accumulate.

## The governing rule

> Keep CTA code **only while it is serving as a reference** for the MARTA version you are
> writing. Once the MARTA analog exists — or you've decided there is no analog — **delete
> it in the same change**. Nothing stays in the tree marked "might be useful."

The **MARTA crontab (`cron/crontab.txt`) is the reachability root.** If a `bin/` script
is not in the MARTA schedule and nothing imports it, it is dead. See the knip workflow
below for the mechanical check.

## MARTA vs CTA, in one paragraph

MARTA runs **rail** (Red, Gold, Blue, Green — 4 lines), **bus**, and the **Atlanta
Streetcar**. There is **no commuter-rail analog to Metra**, so the entire `metra/` surface
is destined for deletion — *except* that two pieces of it are the best reference we have:
`metra/api.js` decodes GTFS-realtime protobuf exactly the way MARTA bus will, and the
Metra cancellation/delay/schedule code is timetable-anchored, which is the closest model
to MARTA **rail** if train identity turns out to be stable (rail Path A in `plan.md`).
MARTA **bus** is the strongest parity (GTFS-rt vehicle positions + trip updates). MARTA
**rail** is the risk area: it's a station-arrival REST feed, not vehicle positions, so the
CTA Train Tracker adapter does not transfer directly.

## Status legend

- **PORT** — logic is reusable; swap the CTA adapter/metadata for MARTA.
- **KEEP** — generic infra; rebrand strings/config but no structural change.
- **DELETE** — CTA/Metra-only, no MARTA analog. Remove once any reference value is spent.
- **REFERENCE→DELETE** — keep temporarily as the template for a MARTA module, then delete.

---

## `src/shared/` — mostly KEEP (generic infra)

| Module(s) | Status | Notes |
|---|---|---|
| `history.js`, `observations.js` | PORT | Keep SQLite model; extend observation schema for rail arrival snapshots. Preserve `alerts.json` schema v2 contract. |
| `state.js`, `bluesky.js`, `post.js`, `postDetection.js`, `retry.js`, `runBin.js`, `format.js`, `geo.js`, `polyline.js`, `projection.js`, `stats.js`, `gtfs.js` | KEEP | Generic; rebrand only. |
| `recap.js`, `recapPost.js`, `videoTracks.js`, `eventLink.js`, `eventTracks.js`, `disruption.js`, `directionLabel.js`, `ghostFormat.js`, `ghostsLog.js`, `observationDescribe.js`, `relatedQuotes.js`, `alertPost.js`, `cleanup.js`, `webPushTrigger.js` | KEEP/PORT | Rebrand; `observationDescribe.js` has a `TRAIN_LINES` table to replace. |
| `ctaAlerts.js` | DELETE | CTA Train/Bus Tracker alerts API + Chicago parsing. Replaced by the MARTA official-alert adapter (Phase 6). |
| `trainSegment.js` | PORT | CTA rail segment helper → MARTA rail (rail-path dependent). |

## `src/bus/` — PORT (closest parity)

The big swap is `api.js`: CTA Bus Tracker exposes `pid`/`pdist` (pattern + distance along
pattern); MARTA is GTFS-rt and you join by `trip_id` and map-match to GTFS `shapes`. Every
detector that reasons over `pdist`/`pid` needs a shape-progress adaptation.

| Module(s) | Status | Notes |
|---|---|---|
| `api.js` | PORT | CTA Bus Tracker → MARTA GTFS-rt VehiclePositions/TripUpdates. Use `metra/api.js` as the protobuf-decode reference. |
| `bunching.js`, `gaps.js`, `ghosts.js`, `pulse.js`, `thinGaps.js`, `speedmap.js`, `motion.js`, `heldClusters.js` | PORT | Detector logic reusable; rework `pid`/`pdist` → shape progress. |
| `patterns.js`, `routes.js`, `stops.js` | PORT | CTA pattern model → MARTA GTFS trips/shapes/stops. |
| `bunchingPost.js`, `gapPost.js`, `bunchingVideo.js`, `gapVideo.js`, `bluesky.js` | PORT | Posting/rendering; rebrand. |
| `trafficSignals.js` | DELETE | Chicago OpenStreetMap traffic-signal annotation for timelapse. Re-add for Atlanta only if wanted. |
| `fleet.js` | DELETE | CTA bus fleet/vehicle metadata. |

## `src/train/` — PORT, gated on rail feasibility (Phase 5)

CTA Train Tracker (`ttpositions`) gives true vehicle positions. MARTA rail is a
station-arrival REST feed. Do **not** port these until the rail path (A/B/C in `plan.md`)
is decided — the data model underneath them changes.

| Module(s) | Status | Notes |
|---|---|---|
| `api.js` | DELETE | CTA Train Tracker → replaced by MARTA rail REST adapter. The rail parity gate. |
| `bunching.js`, `gaps.js`, `ghosts.js`, `pulse.js`, `speedmap.js`, `motion.js`, `heldClusters.js` | PORT (rail-path dependent) | Concepts reusable; CTA versions assume vehicle positions + L geometry. |
| `findStation.js` | PORT | Station matching → MARTA rail stations. |
| `snapshot.js`, `snapshotVideo.js` | PORT/DELETE | System timelapse; depends on positions. |
| `bunchingPost.js`, `gapPost.js`, `bunchingVideo.js`, `gapVideo.js`, `bluesky.js` | PORT | Rebrand. |
| Loop-trunk / Purple Express logic (embedded in `pulse.js`, `speedmap.js`) | DELETE | CTA-only geometry quirks (Loop direction flip, express overlay). No MARTA analog. |

## `src/metra/` — DELETE (no commuter-rail analog) — but mine two for reference first

| Module(s) | Status | Notes |
|---|---|---|
| `api.js` | REFERENCE→DELETE | GTFS-rt protobuf decode (positions/tripupdates/alerts). Best template for MARTA **bus** `api.js`. Delete once that exists. |
| `cancellations.js`, `delays.js`, `schedule.js` | REFERENCE→DELETE | Timetable-anchored, `trip_id`-joined detection. Template for MARTA **rail** Path A. Delete once rail path is settled. |
| `metraAlerts.js`, `cancellationAlert.js`, `delayAlert.js`, `lines.js`, `metraStations.js`, `recap.js`, `speedmap.js`, `bluesky.js`, `data/` | DELETE | Metra-specific metadata/posting/rendering. |

## `src/map/` — KEEP infra, PORT geography

| Module(s) | Status | Notes |
|---|---|---|
| `common.js`, `index.js` | KEEP | Generic Mapbox render infra. |
| `heatmap.js` | PORT | `CHICAGO_BBOX` / `LOOP_BBOX` → Atlanta bbox. |
| `disruption.js`, `gapChart.js` | KEEP/PORT | Rebrand. |
| `bus/`, `train/` | PORT | Rail subdir gated on rail path. |
| `metra/` | DELETE | — |

## `bin/` — entrypoints (the crontab roots)

| Entry | Status | Notes |
|---|---|---|
| `bus/*.js` | PORT | Bus detectors/posting. |
| `train/*.js` | PORT (rail gate) | Hold until rail path decided. |
| `metra/*.js` | DELETE | After `src/metra` reference value is spent. |
| `export-web.js`, `export-daily.js`, `export-csv.js`, `export-event-tracks.js` | PORT | Keep schema v2 + server-side pairing; strip Metra, add MARTA agency/mode. |
| `incident-roundup.js`, `audit-alerts.js` | PORT | Multi-signal rollup + audit. |
| `cron-run.sh`, `push-web-data.sh` | KEEP | Rebrand R2 bucket, dispatch repo, healthchecks slugs. |
| `backfill-*.js`, `cleanup-metra-resolved-cancellation-replies.js` | DELETE | One-off CTA/Metra data migrations; not reusable. |

## `scripts/`

| Script | Status | Notes |
|---|---|---|
| `fetch-gtfs.js` | PORT | CTA GTFS → MARTA `google_transit.zip`. |
| `observeBuses.js`, `observeTrains.js` | PORT | Rail observer gated on rail path. |
| `compute-low-frequency-routes.js` | PORT | Recompute for MARTA routes. |
| `backup-db.sh`, `restore-db.sh`, `install-logrotate.sh`, `configure-healthchecks.js` | KEEP | Rebrand. |
| Debug/replay (`demo*.js`, `render-*.js`, `replay-*.js`) | KEEP/PORT | Useful tooling; rebrand as touched. |
| `fetch-metra-gtfs.js` | REFERENCE→DELETE | `trip_id` join reference, then delete. |
| `fetch-signals.js`, `fetch-train-lines.js`, `observeMetra.js`, `capture-metra-cancellation.js` | DELETE | Chicago signals / CTA line geometry / Metra-only. |
| `delete-*-fp.js` (3) | DELETE | CTA incident-specific FP cleanups. |
| `export-*-fixtures.js` | PORT/DELETE | FP-fixture exporters; pattern reusable, CTA data not. |

---

## knip: the mechanical backstop

[`knip`](https://knip.dev) finds unused files and dependencies starting from the real
entrypoints (`bin/`, `scripts/`, `test/`), configured in `knip.json`.

```bash
npm install        # required for an authoritative run (loads knip's biome/husky plugins)
npm run knip       # focused: unused files + dependencies
npx knip           # full report, incl. unused exports (noisier)
```

**What to watch:** the **"Unused files"** section. It is empty today because every `src/`
module is still reachable through a CTA `bin/` entrypoint. As you delete CTA entrypoints
and trim the MARTA crontab, orphaned modules will appear there — those are concrete
deletion candidates. Reconcile them against the **DELETE** rows above and remove them.

**Known noise (ignore):**
- Running `npm run knip` *before* `npm install` reports `@biomejs/biome`, `husky`, and
  `lint-staged` as unused devDependencies — a false positive because knip's plugins for
  those aren't loaded without `node_modules`. Install first.
- `ffmpeg` / `rclone` are spawned from shell scripts knip can't parse; they're listed in
  `ignoreBinaries` in `knip.json` on purpose.

**Suggested CI gate (later):** once the port settles, add `npm run knip` to CI so unused
files fail the build and dead code can't reaccumulate.
