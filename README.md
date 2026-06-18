# atlanta-transit-insights

Bluesky bots that turn live MARTA data into Atlanta-specific transit visualizations.

- **Bus**: [@martabusinsights.atlantatransitalerts.app](https://bsky.app/profile/martabusinsights.atlantatransitalerts.app) — bunching, gaps, ghost buses, speedmaps
- **Train**: [@martatraininsights.atlantatransitalerts.app](https://bsky.app/profile/martatraininsights.atlantatransitalerts.app) — rail (RED/GOLD/BLUE/GREEN) + the Atlanta Streetcar
- **Alerts**: [@martaalertinsights.atlantatransitalerts.app](https://bsky.app/profile/martaalertinsights.atlantatransitalerts.app) — official alerts + bot-detected outages

This README is written for operators running their own copy. If you just want to see the output, follow the accounts above.

> This repo began as a fork-first port of [`cta-insights`](https://github.com/cailinpitt/cta-insights). The architecture and detector concepts carry over; the data adapters are MARTA's. Porting/cleanup history is in [`PORTING.md`](PORTING.md).

## What it posts

> Each major feature has a deep-dive in [`docs/`](docs/): [bunching](docs/BUNCHING.md), [gaps](docs/GAPS.md), [ghosting](docs/GHOSTING.md), [speedmaps](docs/SPEEDMAP.md), [thin-gaps + pulse](docs/THIN_GAPS_AND_PULSE.md), [official alerts](docs/MARTA_ALERTS.md).

### Bus (`@martabusinsights`)
- **Bunching** — clusters of buses on the same route/direction, as an annotated map with a ~10-minute timelapse reply.
- **Gaps** — long stretches with no bus service, compared against the scheduled headway from GTFS.
- **Ghost buses** — rollup of routes with materially fewer active buses than the schedule implies.
- **Speedmap** — a bus route color-coded by observed speed over a 1-hour window (built from MARTA's reported `speed` field).
- **Cross-route pileups** — congestion where buses from *different* routes converge on one transit center.
- **Thin-gaps + pulse** — low-frequency routes that go dark, and higher-frequency routes that blackout entirely (posts to the alerts account).

### Train (`@martatraininsights`)
- **Bunching / gaps / ghosts** — the rail analogs, using true train positions (MARTA rail "Path A") projected onto per-line geometry.
- **Speedmap** — a rail line (or the streetcar) color-coded by observed speed, reconstructed from position deltas (the rail feed reports no speed).
- **Cross-line pileups** — multiple lines stacked at shared track / Five Points.
- **System timelapse** — a smooth, interpolated clip of every train in service.

### Alerts (`@martaalertinsights`)
- **Republished official alerts** — significant MARTA service alerts (from GTFS-rt ServiceAlerts + the OTP backend), filtered to drop elevator/ADA/construction noise, with a threaded resolved reply when they clear.
- **Incident roundup** — correlates sub-threshold detector signals on the same route/line into a single degraded-service post.
- **Bus cancellation rollup** — hourly per-route digest of GTFS-rt `CANCELED` trips.

### Both modes
- **Historical callouts** — posts carry frequency/severity context from prior posts, e.g. *"3rd Route 110 bunch reported today."*

## Setup

1. **Clone and install**
   ```
   git clone https://github.com/cailinpitt/atlanta-transit-insights.git
   cd atlanta-transit-insights
   npm install
   ```

2. **Install `ffmpeg`** — required for timelapse replies.
   ```
   brew install ffmpeg    # macOS
   apt install ffmpeg     # Debian/Ubuntu
   ```

3. **Create `.env`** — `cp .env.example .env` and fill in:

   | Var | What it's for | Where to get it |
   |---|---|---|
   | `MARTA_TRAIN_KEY` | MARTA rail API key | [itsmarta.com/app-developer-resources](https://itsmarta.com/app-developer-resources.aspx) |
   | `MAPBOX_TOKEN` | Mapbox Static Images API | [account.mapbox.com](https://account.mapbox.com/access-tokens/) |
   | `BLUESKY_SERVICE` | Bluesky PDS URL | defaults to `https://bsky.social` |
   | `BLUESKY_{BUS,TRAIN,ALERTS}_IDENTIFIER` | Bot handle or DID | your Bluesky accounts |
   | `BLUESKY_{BUS,TRAIN,ALERTS}_APP_PASSWORD` | Bot app passwords | bsky.app → Settings → App Passwords |
   | `GITHUB_DISPATCH_TOKEN` | (optional) trigger site rebuilds | fine-grained PAT, Contents:write on the site repo |

4. **Fetch GTFS + build the schedule index** — required before any gap or ghost detection runs.
   ```
   npm run marta:fetch-gtfs
   npm run marta:build-schedule-index
   ```

5. **Smoke test** — loads every bus/rail bin with `--check`.
   ```
   npm run smoke
   ```

6. **Try a dry run** — writes an image, does not post.
   ```
   npm run marta:bus-gaps:dry
   ```

## Running it

Everything is cron-driven — no long-running process. A live *observe loop* records feed snapshots into `state/marta.sqlite`; each detector bin reads the latest snapshot, detects, and posts.

The full schedule lives in [`cron/marta-crontab.txt`](cron/marta-crontab.txt). Apply it to the server with:

```
scripts/marta/install-crontab.sh
```

The installer is a safe **marker-merge** — it replaces only the block between `# MARTA-INSIGHTS-START` / `# MARTA-INSIGHTS-END` and never touches your other cron jobs. It substitutes `__REPO__` / `__NODE__` and creates the `state/logs/` targets. Logs land in `state/logs/` (gitignored).

### Log rotation & monitoring

`cron/logrotate.conf` is a template policy; install it with `sudo scripts/install-logrotate.sh`. Liveness can be delegated to [healthchecks.io](https://healthchecks.io) — see `scripts/configure-healthchecks.js` and `cron/healthchecks.env.example`.

## Scripts reference

Detector bins accept `--dry-run` (write the image/text, don't post) and `--check` (import smoke).

### Observe + index
| Command | Description |
|---|---|
| `npm run marta:observe-buses` | Bus position observer (records to `state/marta.sqlite`). Runs every minute. |
| `npm run marta:observe-rail` | Rail observer (positions + arrivals). Runs every minute. |
| `npm run marta:observe-bus-tripupdates` | Bus TripUpdates (cancellations). Runs every 5 min. |
| `npm run marta:fetch-gtfs` | Download MARTA static GTFS. |
| `npm run marta:build-schedule-index` | Build `data/marta/schedule-index.json` (headways + active counts). |
| `npm run marta:status` | Print observe-loop health. |

### Posting (cron entry points)
| Command | Description |
|---|---|
| `npm run marta:bus-gaps` / `:dry` | Bus gap detection |
| `npm run marta:bus-ghosts` / `:dry` | Bus ghost rollup |
| `npm run marta:bus-speedmap` / `:dry` | Bus speedmap (route rotation) |
| `npm run marta:rail-gaps` / `:dry` | Rail gap detection |
| `npm run marta:rail-bunching` / `:dry` | Rail bunching detection |
| `npm run marta:rail-ghosts` / `:dry` | Rail ghost rollup |
| `npm run marta:rail-speedmap` / `:dry` | Rail/streetcar speedmap rotation |
| `node bin/marta/bus/{bunching,cross-bunching,pulse,thin-gaps,cancellations}.js` | Other bus jobs (see crontab) |
| `node bin/marta/rail/{cross-bunching,timelapse}.js` | Other rail jobs |
| `node bin/marta/alerts.js` | Official-alert republish + resolution replies |
| `node bin/marta/incident-roundup.js` | Multi-signal degraded-service roundup |

### Web archive
| Command | Description |
|---|---|
| `npm run marta:export-web [output-path]` | Read `state/marta.sqlite` (readonly) → `alerts.json`. |
| `bin/marta/push-web-data.sh` | Export → upload changed files to R2 → trigger a site rebuild. See [DATA_ORIGIN.md](docs/DATA_ORIGIN.md). |

### Dev
| Command | Description |
|---|---|
| `npm test` | Run the test suite (`node --test`). |
| `npm run smoke` | `--check` import smoke for each bus/rail bin. |
| `npm run lint` / `npm run check` | Biome lint / format + safe fixes. |
| `npm run knip` | Unused files + dependencies (dead-code backstop). |

Formatting + safe lint fixes run automatically on `git commit` via a husky pre-commit hook (`.husky/pre-commit` → `lint-staged`). Config is in `biome.json`.

## How it works

Each major feature has a deep-dive doc in [`docs/`](docs/):
- [BUNCHING.md](docs/BUNCHING.md) — cluster detection for buses and trains
- [GAPS.md](docs/GAPS.md) — long-gap detection vs. scheduled headway
- [GHOSTING.md](docs/GHOSTING.md) — missing-vehicle detection
- [SPEEDMAP.md](docs/SPEEDMAP.md) — colored route speed maps
- [THIN_GAPS_AND_PULSE.md](docs/THIN_GAPS_AND_PULSE.md) — low-frequency + blackout detection
- [MARTA_ALERTS.md](docs/MARTA_ALERTS.md) — official-alert republishing
- [MARTA_FEEDS.md](docs/MARTA_FEEDS.md) — the validated feed reality
- [DATA_ORIGIN.md](docs/DATA_ORIGIN.md) / [MARTA_BACKUPS.md](docs/MARTA_BACKUPS.md) / [MARTA_BOTS.md](docs/MARTA_BOTS.md) — ops

### Data sources
- **MARTA rail `traindata` REST** — true train positions (lat/lon that move snapshot-to-snapshot). See `src/marta/rail/api.js`.
- **MARTA GTFS-realtime** — bus VehiclePositions + TripUpdates, and official ServiceAlerts. See `src/marta/bus/api.js`, `src/marta/alert/api.js`.
- **OTP GraphQL backend** — the streetcar feed and the richer official-alert source. See `src/marta/streetcar/api.js`, `src/marta/alert/otp.js`.
- **GTFS static feed** — the scheduled baseline for gap and ghost detection, compiled into `data/marta/schedule-index.json`.
- **Mapbox Static Images API** — base maps for every rendered image.

See [MARTA_FEEDS.md](docs/MARTA_FEEDS.md) for what each feed actually contains.

### The `pdist` analog
MARTA is GTFS-realtime: a vehicle reports `trip_id` + lat/lon, not distance-along-route. `src/marta/bus/shapes.js` reconstructs distance-along-route by projecting each position onto its trip's GTFS shape. The whole detector stack runs on that projected `distFt`. See [BUNCHING.md](docs/BUNCHING.md#the-pdist-analog--srcmartabusshapesjs).

### Storage
The observe loop records into `state/marta.sqlite` (`src/marta/storage.js`): `bus_observations`, `bus_trip_updates`, `rail_observations`, `rail_arrivals`, 7-day rolloff. Cooldowns, caps, callouts, and `meta_signals` live in the same DB via `src/marta/shared/incidents.js`. SQLite runs in **WAL mode**.

## Contributing and issues

Issues and PRs welcome at [github.com/cailinpitt/atlanta-transit-insights](https://github.com/cailinpitt/atlanta-transit-insights).

MARTA data © Metropolitan Atlanta Rapid Transit Authority. Base maps © Mapbox, © OpenStreetMap contributors.
