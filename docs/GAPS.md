# Gap detection

How the bot finds long stretches of route with no vehicles in service — the rider experience of "the schedule says every 10 minutes, but I've been waiting 30."

## What a "gap" means

MARTA's schedule implies headways: how often vehicles should arrive on each route. A **gap** is when the actual distance between two consecutive vehicles is large enough — relative to that schedule — that riders in between are waiting much longer than promised.

Where [bunching](./BUNCHING.md) is "vehicles too close," gaps are the inverse: vehicles too far apart.

## The plain-English version

Every few minutes, the bot:

1. Reads the latest observed positions of every bus/train (recorded by the observe loop).
2. Sorts vehicles by their position along the route.
3. For each pair of consecutive vehicles, estimates how long it would take a vehicle to cover the empty stretch at typical service speed.
4. Compares that estimate to the scheduled headway.
5. If the gap is more than 2.5× scheduled — and at least 15 minutes for buses or 12 for trains — flags it.

A train post looks like this:

> 🚇 Red Line — to North Springs
>
> No trains across ~2.1 mi — a ~24 min gap, scheduled around every 7 min this hour

The post **names the empty stretch as a range** between the two stops/stations flanking it, rather than collapsing it onto a single midpoint — a long gap can span several stops, so a single anchor both under-states the hole and disagrees with the map. It also frames the number as a **gap between vehicles**, not "no vehicle for ~24 min": the span measures the distance between the two vehicles bracketing the stretch (at the midpoint, a rider has waited only about half that).

The map highlights the empty stretch, tags the two flanking vehicles **L** (last seen) and **N** (next up), and labels the flanking stops the post names.

## The technical version

### The `pdist` analog

MARTA is GTFS-realtime — vehicles report `trip_id` + lat/lon, not distance-along-route. So distance-along-route is reconstructed by projecting each vehicle's position onto its trip's GTFS shape (`src/marta/bus/shapes.js#projectToShape` → `distFt`; rail uses the per-line geometry in `src/marta/rail/lines.js`). See [BUNCHING.md](./BUNCHING.md#the-pdist-analog--srcmartabusshapesjs) for the projection details. Everything below operates on `{shapeId, distFt}` (bus) or `{line, distFt}` (rail) samples.

### The core comparison

We don't have ride times for empty stretches — no vehicle is there to measure. So we estimate them from a typical service speed:

- Buses: **`TYPICAL_SPEED_FT_PER_MIN` = 880 ft/min** (~10 mph, including stops and signals).
- Trains: **2,640 ft/min** (~30 mph cruise + dwell).

For two consecutive vehicles separated by `gapFt` along the route:

```
gapMin = gapFt / TYPICAL_SPEED_FT_PER_MIN
ratio  = gapMin / expectedHeadwayMin
```

The number is intentionally crude. It's only used as a *ratio* against the scheduled headway, not as a literal ETA. **`RATIO_THRESHOLD` = 2.5** is the bar: a gap two and a half times the schedule is worth posting.

### Where the expected headway comes from — the schedule index

`scripts/marta/build-schedule-index.js` streams GTFS `stop_times.txt` and writes `data/marta/schedule-index.json` (gitignored, rebuilt nightly by cron). It records, keyed by (shape|route|line, dayType, hour): the median scheduled headway, the median trip duration, and the active-trip count.

**Headways are measured per shape**, not per direction — a direction often runs several shapes at once (a through trip plus a branch), and mashing them together yields bogus ~0-min gaps when two leave together. The route/line rollup is the median of its shape headways.

- **Bus** gap detection reads `headwayForShape` with a `headwayForRoute` fallback (`src/marta/bus/schedule.js`).
- **Rail** gap detection reads `headwayForLine` (`src/marta/rail/gaps.js`). Line-level aggregates deliberately sidestep the rail feed's N/S/E/W direction labels not lining up cleanly with GTFS `direction_id`.

### Buses — `src/marta/bus/gaps.js`

`detectBusGaps(vehicles, { headwayFor, lengthFor, stopsFor })` is the CTA algorithm, generic over `{shapeId, distFt}`; `gapsFromObservations` wires it to MARTA sources. Per shape:

1. Sort by `distFt`.
2. For each adjacent pair: skip if either bus is inside the start/end terminal zone (`terminalZoneFt`, a route-length-scaled buffer — buses there are doing layovers, not running headways).
3. Compute `gapMin` and `ratio`. Reject if `gapMin < ABSOLUTE_MIN_MIN` (15-min absolute floor — protects 30-min-headway routes from spamming on a 31-min drift) or `ratio < 2.5`.
4. For each surviving gap, find the stops **flanking** it (`flankBefore` behind the trailing bus, `flankAfter` ahead of the leading bus, with lat/lon) to name the stretch as a range in the post and label both ends on the map. Falls back to a single anchor ("near X") when a flank is missing.
5. Sort surviving gaps by `ratio` desc — biggest deviations first.

### Trains — `src/marta/rail/gaps.js`

Same idea on the per-line geometry, with `ABSOLUTE_MIN_MIN = 12` (rail headways are tighter) and `headwayForLine` for the expected value. The post (`src/marta/rail/post.js`) names the flanking stations and renders the gap onto a line map (`src/marta/map/railIncidents.js`).

### Why a ratio, not a literal ETA

Gap times computed this way are wrong in absolute terms — a real bus at PM peak averages slower than 10 mph. But the schedule headway has the same kind of modeling error baked in, and when you take their ratio the error cancels: a true 3× deviation looks like 3× regardless of the constant. That's why the post says "~24 min" with a tilde — it's deliberately approximate.

## Timelapse reply

After the still gap post goes out, the bot threads a ~10-minute timelapse (`src/marta/bus/video.js` / `src/marta/rail/video.js`, via the maps in `src/marta/map/{busGap,railIncidents}.js`), built from the observe-loop DB history. The clip follows the trailing ("Next up") vehicle approaching the wait stop so the camera holds still while the next vehicle advances across the empty stretch — the motion *is* the story. Motion + dropout handling go through the shared `src/shared/videoTracks.js` kernel (see [BUNCHING.md](./BUNCHING.md#timelapse-video)).

## Why this approach

The signal we want is "the schedule said one thing, reality is much worse" — and the only ground truth we have is the live spacing of in-service vehicles. By comparing a model-estimated gap to a model-derived headway and gating with a ratio, we catch big deviations without needing a perfect ETA. The terminal-zone exclusion and the absolute-minute floor are the two filters that keep false positives low.

## Cooldowns and the cap

Gap posting reuses the `src/marta/shared/incidents.js` lifecycle: per-shape/route (bus) and per-line (rail) cooldowns plus a daily cap with severity-escalation overrides. The cooldown uses a decaying margin (1.25× → 1.1× over the hour) with a sustained-severity escape (≥ 20 min & ≥ 3.0×), so an aging/worsening gap re-posts rather than being suppressed by an earlier, milder one on the same route.

## Files

- `src/marta/bus/shapes.js` — projection to `distFt` (the `pdist` analog).
- `src/marta/bus/schedule.js` — schedule index loader + `headwayForShape` / `headwayForRoute` / `headwayForLine`.
- `src/marta/bus/gaps.js` — bus gap detection (`detectBusGaps`, `gapsFromObservations`).
- `src/marta/rail/gaps.js` — rail gap detection (line-level headways).
- `src/marta/bus/gapPost.js`, `src/marta/rail/post.js` — post + alt + video reply text.
- `src/marta/map/{busGap,railIncidents}.js` — still gap maps + timelapse framing.
- `src/marta/{bus,rail}/video.js`, `src/shared/videoTracks.js` — timelapse capture + dropout kernel.
- `src/shared/geo.js` — terminal-zone helper (`terminalZoneFt`).
- `src/marta/shared/incidents.js` — cooldown / cap / escalation.
- `scripts/marta/build-schedule-index.js` — nightly schedule-index build.
- `bin/marta/bus/gaps.js`, `bin/marta/rail/gaps.js` — cron entry points (`--dry-run`, `--check`).
