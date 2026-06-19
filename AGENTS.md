# AGENTS.md

Operating notes for AI agents editing this repo. Companion to `README.md`
(operator-facing) and `docs/` (per-feature deep-dives).

## What this is

Three Bluesky bots that turn live MARTA data into Atlanta-specific transit posts:

- **`@martabusinsights`** — bus bunching, gaps, ghosts, speedmaps, cross-route pileups.
- **`@martatraininsights`** — rail (RED/GOLD/BLUE/GREEN) + the Atlanta Streetcar (SC): gaps, bunching, ghosts, speedmaps, cross-line pileups, system timelapse.
- **`@martaalertinsights`** — republished official MARTA service alerts, the multi-signal incident roundup, and the hourly bus-cancellation rollup.

**Cron-driven, no daemon.** A live *observe loop* polls the feeds and records into
`state/marta.sqlite`; each detector bin is a one-shot that reads the latest
recorded snapshot (no extra feed fetch), detects → renders → posts → exits.

## Architecture

- **Feeds → adapters.** `src/marta/bus/api.js` (GTFS-rt VehiclePositions/TripUpdates),
  `src/marta/rail/api.js` (rail `traindata` REST, true positions — "Path A"),
  `src/marta/streetcar/api.js` (OTP GraphQL), `src/marta/alert/{api,otp}.js`
  (GTFS-rt ServiceAlerts + OTP). See `docs/MARTA_FEEDS.md` for the validated reality.
- **The `pdist` analog.** MARTA is GTFS-rt: vehicles report `trip_id` + lat/lon,
  not distance-along-route. `src/marta/bus/shapes.js#projectToShape` reconstructs
  `distFt` by projecting lat/lon onto the trip's GTFS shape. Rail uses one
  representative geometry per line (`src/marta/rail/lines.js`). The detector
  mapping is **CTA `pid` ↔ `shape_id`, CTA `pdist` ↔ projected `distFt`**.
- **Schedule index.** `scripts/marta/build-schedule-index.js` → `data/marta/schedule-index.json`
  (gitignored, rebuilt nightly): per-shape headways + per-(route+dir, hour)
  `activeByHour`. Lookups in `src/marta/bus/schedule.js` (`headwayForShape`,
  `headwayForRoute`, `headwayForLine`, `activeForLine`). Powers gaps + ghosts.
- **Storage.** `src/marta/storage.js` owns `state/marta.sqlite`
  (`bus_observations`, `bus_trip_updates`, `rail_observations`, `rail_arrivals`),
  7-day rolloff. The observe loop writes; detectors read the latest snapshot.
- **Detectors** are cores in `src/marta/{bus,rail,streetcar}/<feature>.js`; **bins**
  in `bin/marta/{bus,rail}/<feature>.js` wire them to storage / posting / render.
- **Posting + lifecycle.** `src/marta/shared/`: `bluesky.js` (login/post),
  `incidents.js` (cooldown, cap, callouts, member-id suppression, `meta_signals`,
  `disruption_events`), `state.js`, `postDetection.js`, `runBin.js` (bin
  setup/`--check`/`--dry-run`), `format.js`, `video.js` / `smoothFrames.js`,
  `geoClusters.js`, `eventLink.js`.
- **Reused generic infra** lives in `src/shared/` (rebranded but agency-agnostic):
  `env, geo, post, retry, polyline, projection, videoTracks, ghostFormat,
  observationDescribe, cleanup, webPushTrigger`. **Nothing else remains in
  `src/shared/`** — the CTA/Metra trees were deleted (see `PORTING.md`).

**Read first**: `README.md`, `cron/marta-crontab.txt` (what runs when, with
stagger comments), and the relevant `docs/{BUNCHING,GAPS,GHOSTING,SPEEDMAP,
THIN_GAPS_AND_PULSE,MARTA_ALERTS,MARTA_FEEDS}.md`.

## Hard rules

- `npm test` (308+ tests) and `npm run lint` must both be clean before any commit —
  the deploy gates on both; a red commit halts the live site.
- **Don't add a `Co-Authored-By` trailer to commits.** Keep commit subjects short.
- Don't auto-commit, push, or pull. Wait to be asked.
- **Cron runs on the server.** Build/adjust the block in `cron/marta-crontab.txt`
  and the installer (`scripts/marta/install-crontab.sh`, marker-merge — never
  clobbers other jobs); the operator applies it. Don't run `crontab -`.
- Don't hardcode usernames/paths in committed configs — parameterize and
  substitute at install time (`__REPO__` / `__NODE__`).
- Husky pre-commit runs `biome check --write` on staged `*.{js,json}`. On
  failure, fix the cause and create a new commit (don't amend).
- **Keep dead code out** (`PORTING.md`): when an analog exists, delete the old
  code in the same change. `npm run knip` ("Unused files") is the backstop.
- **The frontend (`atlanta-transit-alerts`) is a dumb client.** Data-quality bugs
  get fixed in this producer and backfilled, not patched downstream.
- **Present data, not commentary.** Neutral archive — descriptive surfaces are
  fine; judgment/scores (e.g. A–F grades) are not.
- When you change bus logic, consider the equivalent rail change (and vice versa).
  The two stay separate but parallel.
- Update docs alongside code so they don't go stale; record public data-shape
  changes in the consumer-facing changelog.

## Where to look for X

| Editing… | Start here |
|---|---|
| Cron schedule / cadence | `cron/marta-crontab.txt` + `scripts/marta/install-crontab.sh` |
| Observation storage (read/write/rolloff) | `src/marta/storage.js` |
| Live capture loop | `scripts/marta/observe-{buses,rail,bus-tripupdates}.js`, `src/marta/observeUtil.js` |
| Schedule index (headways + active counts) | `src/marta/bus/schedule.js`, `scripts/marta/build-schedule-index.js` |
| Static GTFS load + realtime→static join | `src/marta/gtfs.js`, `scripts/marta/fetch-static-gtfs.js` |
| Bus / rail / streetcar feed decode | `src/marta/{bus,rail,streetcar}/api.js` |
| The `pdist` analog (projection) | `src/marta/bus/shapes.js`, `src/marta/rail/lines.js` |
| Bunching / gaps / ghosts (bus) | `src/marta/bus/{bunching,gaps,ghosts}.js` |
| Bunching / gaps / ghosts (rail) | `src/marta/rail/{bunching,gaps,ghosts}.js` |
| Cross-route / cross-line pileups | `src/marta/{bus,rail}/crossBunching.js`, `src/marta/shared/geoClusters.js` |
| Thin-gaps / pulse (low-freq + blackout) | `src/marta/bus/{thinGaps,pulse}.js`, `docs/THIN_GAPS_AND_PULSE.md` |
| Rail dead-segment / pulse (track gap) | `src/marta/rail/pulse.js`, `bin/marta/rail/pulse.js`, `docs/THIN_GAPS_AND_PULSE.md` |
| Speedmaps | `src/marta/bus/speedmap.js`, `src/marta/rail/speedmap.js`, `src/marta/streetcar/speedmap.js` |
| Official alerts (fetch + significance + store) | `src/marta/alert/{api,otp,significance,store,cancellation}.js`, `docs/MARTA_ALERTS.md` |
| Incident roundup (multi-signal correlation) | `bin/marta/incident-roundup.js` |
| Cooldown / cap / callouts / meta-signals | `src/marta/shared/incidents.js` |
| Post text + alt text | `src/marta/{bus,rail}/{bunchingPost,gapPost,ghostPost,speedmapPost,post}.js` |
| Map renderers | `src/marta/map/*.js` |
| Timelapse + dropout/bridge/ghost model | `src/marta/{bus,rail}/video.js`, `src/shared/videoTracks.js` |
| Web export (R2 data) | `bin/marta/{export-web,export-daily}.js`, `bin/export-csv.js`, `bin/marta/push-web-data.sh`, `docs/DATA_ORIGIN.md` |
| Ghost / effective-headway phrasing | `src/shared/ghostFormat.js` |
| Bluesky login / threading / post | `src/marta/shared/bluesky.js` |

## Operational levers (coupled or quota-related only)

Most thresholds are single-file constants — search the relevant
`src/marta/<mode>/<feature>.js`. The load-bearing ones:

| Lever | File | Note |
|---|---|---|
| Bunching distance | `src/marta/bus/bunching.js` | `BUNCHING_THRESHOLD_FT = 800` |
| Gap ratio + floor | `src/marta/bus/gaps.js` | `RATIO_THRESHOLD = 2.5`, `ABSOLUTE_MIN_MIN = 15` (rail: 12) |
| Ghost gates | `src/marta/bus/ghosts.js` | `MISSING_PCT 0.25`, `MISSING_ABS 3` (trailing 2), `MIN_SNAPSHOTS 4` |
| Speedmap coverage gate | `bin/marta/bus/speedmap.js` | `MIN_COVERAGE = 0.3` |
| Rail pulse cold threshold | `src/marta/rail/pulse.js` | `COLD_HEADWAY_MULT 2.5` / `_STRICT 3.5`, `DEFAULT_MIN_COLD_MS 15min` (CTA parity); ticks in `bin/marta/rail/pulse.js` |
| Observation rolloff | `src/marta/storage.js` | 7-day window |
| Alert clear window | `src/marta/alert/store.js` | `ALERT_CLEAR_TICKS = 3` ↔ 2-min alert cadence |

## Dev commands

- `npm test` — full suite (`node --test`).
- `npm run smoke` — `--check` import smoke for every bus/rail bin.
- `npm run lint` / `npm run check` — Biome.
- `npm run knip` — unused files + dependencies (dead-code backstop).
- `npm run marta:*` — convenience wrappers; the `*:dry` variants run a bin without
  posting. Detector bins also accept `--dry-run` and `--check` directly.

## Required env vars

`.env` at repo root (see `.env.example`):

- `MARTA_TRAIN_KEY` — MARTA rail API key.
- `MAPBOX_TOKEN` — static map rendering.
- `BLUESKY_SERVICE` (optional, default `https://bsky.social`).
- `BLUESKY_{BUS,TRAIN,ALERTS}_{IDENTIFIER,APP_PASSWORD}` — the three bot accounts.
- `TEST_ACCOUNT_{IDENTIFIER,PASSWORD}` — optional throwaway for post-output testing.
- `GITHUB_DISPATCH_TOKEN` — optional; lets `push-web-data.sh` trigger a site rebuild.
