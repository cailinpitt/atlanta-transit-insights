# Speedmaps

How the bot builds the "this is how fast a route was actually moving" image — the colored map where red means crawling and green means moving well.

## What a speedmap shows

A speedmap is a one-hour snapshot of how fast vehicles were moving on a single route, segment by segment. The route is divided into equal-length pieces (40 for bus, 30 for rail), each colored by the average speed observed there during the window.

It's a way to see exactly *where* a route is slow — not just the headline average. A green-with-one-red-block speedmap means the whole route runs fine except for one chokepoint; a route that's red end-to-end has a different problem entirely.

Colors:

- **Bus** (`BUS_THRESHOLDS`): red < 5 mph, orange < 10, yellow < 15, green ≥ 15.
- **Rail** (`RAIL_THRESHOLDS`): red < 15, orange < 25, yellow < 35, purple < 45, green ≥ 45.
- **Streetcar**: red < 4, orange < 8, yellow < 12, purple < 16, green ≥ 16 (heavy rail's slow cousin).

## How speed is measured — the two MARTA cases

This is the biggest departure from the CTA original. CTA had to derive every speed from `pdist` deltas. MARTA splits into two cases:

### Bus — reported speed, single snapshot (`src/marta/bus/speedmap.js`)

MARTA's GTFS-realtime bus feed reports `speed` (m/s) directly on **~57% of vehicles**. So a bus speedmap works from a *single* snapshot: each speed-bearing observation becomes one `{ distFt, mph }` sample, placed on the route by projecting its lat/lon onto its trip's shape (`src/marta/bus/shapes.js`; see [BUNCHING.md](./BUNCHING.md#the-pdist-analog--srcmartabusshapesjs)). No paired-observation differencing, no Δt math. Implausible reported speeds (well over 60 mph in service) are rejected as GPS/feed glitches.

### Rail & streetcar — speed from position deltas (`src/marta/rail/speedmap.js`)

The rail feed reports no speed, so it's reconstructed: each consecutive pair of observations of the same train becomes one `{ distFt, mph }` sample, `mph = Δalong-line / Δt`. Guards:

- `MIN_DT_MS` 10 s / `MAX_DT_MS` 5 min — need a real time gap, but a pair spanning an outage isn't a clean sample.
- `MAX_MPH` 75 — rejects GPS jumps and the once-per-lap shape wraparound at Five Points.
- Samples group by `line/direction`.

Validated on real server data (RED/S ~35 mph, BLUE/W ~27 mph).

The **streetcar** (`src/marta/streetcar/speedmap.js`) reuses the same builder + renderer with a single "SC"-keyed loop geometry, a tighter speed cap that rejects the once-per-lap loop wraparound, and its own much slower buckets. `bin/marta/rail/speedmap.js` treats it as **just another line** ("SC") in one candidate pool with RED/GOLD/BLUE/GREEN.

## The technical version

### Binning into segments

`binSamples` divides the shape into `numBins` equal-length segments (40 bus / 30 rail) and averages every sample whose `distFt` lands inside each. Bins with no samples stay null (honest no-data) rather than being interpolated over.

### Summarize and color

`summarize()` computes the overall average plus the count of bins in each color bucket (`BUS_THRESHOLDS` / `RAIL_THRESHOLDS`). The map renderers (`src/marta/map/busSpeedmap.js`, `src/marta/map/railSpeedmap.js`) draw the polyline with each segment colored, plus a header showing route, direction, time window, and average speed.

### Coverage gate

A speedmap is only worth posting if enough of the route has data. `bin/marta/bus/speedmap.js` filters to routes whose covered/total bin ratio ≥ `MIN_COVERAGE` (0.3) and skips a run entirely when nothing clears it ("No route has enough speed-bearing coverage to post a speedmap").

## Route selection

- **Bus** speedmaps rotate hourly. Among routes with enough coverage in the last hour, `incidents.leastRecentlyPostedSpeedmapRoute('bus', …)` picks the one whose most recent posted speedmap is oldest; never-picked routes jump to the front so coverage fans out evenly.
- **Rail** rotation pools RED/GOLD/BLUE/GREEN/SC under one unified `kind: 'rail'`, picking whichever eligible line has gone longest without a speedmap. Force a specific one with `--line RED|GOLD|BLUE|GREEN|SC`.

Both bins post the image to the relevant account (`@martabusinsights` / `@martatraininsights`) and support `--dry-run` (write image + text, don't post). The rail bin also takes `--min-coverage <0–1>` to force a sparse map for inspection.

## Why this approach

Average speed is a useful headline number, but the *geographic distribution* of slowness is what tells riders something they didn't already know — a route's overall average can stay flat while one specific stretch has gotten 30% slower. The bin granularity is a compromise: fine enough to highlight specific chokepoints, coarse enough that each bin gets enough samples to be meaningful in a one-hour window.

## Files

- `src/marta/bus/speedmap.js` — bus sampling (reported speed), binning, color thresholds.
- `src/marta/rail/speedmap.js` — rail/streetcar sampling (position deltas), `buildLineSpeedmaps`.
- `src/marta/streetcar/speedmap.js` — streetcar wrapper (SC loop geometry, slow buckets).
- `src/marta/bus/shapes.js` — projection to `distFt`.
- `src/marta/map/{busSpeedmap,railSpeedmap}.js` — image rendering.
- `src/marta/bus/speedmapPost.js` — post text helpers.
- `src/marta/shared/incidents.js` — `leastRecentlyPostedSpeedmapRoute`, speedmap history.
- `bin/marta/bus/speedmap.js`, `bin/marta/rail/speedmap.js` — cron entry points.
