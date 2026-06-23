# Bunching detection

How the bot finds clusters of buses or trains running too close together — the classic "you wait 20 minutes, then three show up at once" pattern.

## What "bunching" means

In a healthy schedule, vehicles on the same route are spread out evenly. **Bunching** is when two or more vehicles end up running within a short distance of each other, usually because the lead vehicle got delayed (heavy boarding, traffic, signals) and the one behind caught up. The riders behind the bunch suffer a long gap; the bunch itself runs nearly empty after the first vehicle.

The bot watches for clusters and posts a map showing where they are.

## The plain-English version

Every few minutes, the bot:

1. Reads the latest observed positions of every bus or train (recorded by the observe loop — no extra feed fetch).
2. Sorts vehicles by how far they've traveled along their route.
3. Looks for groups where consecutive vehicles are closer together than a "bunching" distance threshold.
4. If a cluster is large enough and not just sitting at a terminal, posts a map.

A bus post looks like this:

> 🚌 Route 110 (Peachtree) Northbound — 3 buses bunched within 2,400 ft

The map shows the route line with each clustered vehicle marked along it, plus nearby streets so a rider can recognize where they are.

## The technical version

### The `pdist` analog — `src/marta/bus/shapes.js`

CTA's Bus Tracker handed us a `pdist` field (feet traveled along the current pattern) for free. MARTA is GTFS-realtime: a vehicle reports `trip_id` + lat/lon, not distance-along-route. So the first job is to **reconstruct** distance-along-route ourselves:

- `shapes.js` loads GTFS `shapes.txt` and turns each `shape_id` into a cumulative-feet polyline (from `shape_dist_traveled`).
- `projectToShape` perpendicular-projects a vehicle's lat/lon onto its trip's shape and returns `distFt` — feet from the shape start.

The whole detector stack runs on the mapping **CTA `pid` ↔ MARTA `shape_id`, CTA `pdist` ↔ projected `distFt`**, so the cluster math below is "are these two buses close along the route?" = a subtraction, exactly as on CTA.

### Buses — `src/marta/bus/bunching.js`

Purely spatial — no schedule index needed. For each shape:

1. Filter to fresh observations.
2. Sort by `distFt`.
3. Sweep adjacent pairs. A consecutive gap of ≤ **`BUNCHING_THRESHOLD_FT` (800 ft, ~2.5 city blocks)** extends the current cluster.
4. Skip clusters that start within **`TERMINAL_DIST_FT` (500 ft)** of the shape start — those are layovers at the origin terminal, not bunching.
5. **Geo-consistency guard** (`GEO_SLACK_FT` = 500 ft): reject a cluster whose straight-line crow-flies span is much larger than its along-shape span — that means the projection folded two distant points onto nearby shape distances (a doubled-back or self-crossing shape), not a real pileup.
6. Rank clusters by size (more vehicles = more severe), tie-break on tighter max-gap.

`bunchesFromObservations` is the bridge: it projects the latest snapshot's positions onto shapes and runs `detectBunches`. `findParkedBusVids` / `assignBusNumbers` carry over from CTA — a bus that moved less than `MOTION_MIN_DELTA_FT` (100 ft) over the window is parked and doesn't anchor a bunch.

The bin (`bin/marta/bus/bunching.js`) iterates ranked candidates and picks the first whose shape and route aren't on cooldown (both shape- and route-level cooldowns exist because opposite-direction shapes on the same route would otherwise post within minutes of each other on the same underlying delay). Additional terminal filtering at post time: even if `distFt` looks fine, if the cluster's nearest stop *is* the first or last named stop, it's a terminal layover and gets skipped.

### Trains — `src/marta/rail/bunching.js`

MARTA rail (Path A) reports true positions, so trains get the same treatment via `src/marta/rail/lines.js` (the rail `pdist` analog): one representative geometry per line (the longest GTFS shape; both directions share track), and `projectTrain` reuses `bus/shapes.projectToShape`. Validated live at ~17 ft median offset.

1. `latestTrainPositions` (`src/marta/rail/trains.js`) takes the freshest projected fix per train.
2. **Drop terminal layovers first** (`isTrainAtTerminal`): a train whose along-line `distFt` sits inside the line's terminal zone (`terminalZoneFt(lengthFt)`) at either end is laying over at a turnback, where trains naturally queue. Removing it *before* clustering — the same per-train gate the cross-line detector uses — stops a layover train from pairing with a train arriving just outside the zone and reading as a bunch. Pass `excludeTerminal: false` to disable (e.g. geometry-only tests).
3. Group by `(line, direction)`, sort by line distance, sweep for clusters.
4. Apply rail-specific severity semantics: when train count ties, the **tighter span is worse**.

The chosen cluster renders as a line map (`src/marta/map/railIncidents.js`) with each train marked at its snapped position. Rail uses the official MARTA line colors (RED, GOLD, BLUE, GREEN).

### Cooldowns and posting

A successful post records the shape (bus) or line/direction (rail) on cooldown so we don't keep firing on the same incident, plus a daily cap (3 bus bunches/day) so a bad day doesn't drown the feed. Both the cap and the route/line cooldown carry a **strict-dominance override**: a candidate strictly worse than every prior post in the window (more vehicles, or same count + larger span for buses / tighter span for trains) bypasses the gate, so a 5-bus pileup at 3:30 isn't suppressed by a 3-bus pileup at 3:00. The lifecycle lives in `src/marta/shared/incidents.js`; bus post text is `src/marta/bus/bunchingPost.js`, rail is `src/marta/rail/post.js`.

### Timelapse video

Each bunching post replies with a ~10-minute timelapse of the cluster (`src/marta/bus/video.js`, `src/marta/rail/video.js`), built from the observe-loop DB history (no extra live polling). All dropout handling routes through the shared **`src/shared/videoTracks.js`** kernel: short feed gaps (≤ 8 min) are **bridged** by interpolation (dimmed by staleness), long interior gaps fade to a ghost on each side and draw nothing through the unknown middle, tail drops dead-reckon forward along the polyline and fade out, and a drop at a real terminal plays a turnaround glyph. When at least one ghost renders, a "signal lost" legend appears for the clip.

Note: this "ghost" is purely a video-rendering treatment for a vehicle that dropped from the feed — distinct from the [ghost-bus detector](./GHOSTING.md) (scheduled trips with no live vehicle all hour).

## Cross-route / cross-line bunching

The per-route detectors group by one shape (`src/marta/bus/bunching.js`, keyed on `shapeId`/`distFt`) or one `(line, direction)` (`src/marta/rail/bunching.js`). They can't see a pileup where vehicles from *different* routes converge on one spot — a knot of buses from different routes at one transit center, or RED + GOLD trains stacked at **Five Points** (where all four rail lines converge) or on the shared N-S / E-W trunks. Each route's `distFt` is a separate coordinate system, so the per-route sweep never compares across routes.

Cross-route bunching is a **geographic** detector. The primitive is `src/marta/shared/geoClusters.js#clusterByProximity`: connected-components clustering on raw lat/lon. The surface detectors (`src/marta/{bus,rail}/crossBunching.js`) run it over the whole fleet snapshot and keep clusters passing three gates:

1. **≥ 2 distinct routes/lines** — else it's ordinary bunching.
2. **≥ 3 vehicles** — a pileup, not a pair.
3. **Congestion** — ≥ 2 members barely-moving. Bus reuses `findParkedBusVids`; rail is intrinsic — a train whose `motionSign` is `null` (moved < 100 ft over the window in `latestTrainPositions`) counts as stopped.

Radius defaults: **660 ft** bus, **1,500 ft** rail. Rank most-vehicles-first, tie-break tightest span.

### Layover gate (bus)

Transit centers are also bus **layover** points: at Doraville, Lindbergh, Five Points, etc. several routes terminate and rest between trips in off-street bays. Those parked buses look exactly like a congested multi-route pileup, so the bus bin tags **layover buses and drops them before clustering** (`detectCrossRouteBunches` accepts a `layoverIds` set). A parked bus is a layover if **either**:

- **At a terminal** — its position projects to within `LAYOVER_TERMINAL_FT` (750 ft) of the start or end of its trip's shape (`isAtTerminal`).
- **Near any route's terminal** — within `LAYOVER_TERMINAL_FT` of *any* shape endpoint network-wide (`collectShapeTerminals` + `nearAnyTerminal`), regardless of which trip the bus is currently tagged with. GTFS-rt often tags a between-trips bus with a trip whose shape runs *through* the layover mid-route, so the own-shape `isAtTerminal` check misses it — this geographic backstop catches a knot of routes resting at a shared layover point (e.g. *Shannon Pkwy @ Lancaster Ln*) that isn't named "station".
- **At a station bay** — its nearest GTFS stop is within `STATION_BAY_FT` (600 ft) and is named like a rail-station bay (`/\bstation\b/i`, e.g. *"Doraville Station - Bay D"*).

The station-bay signal matters because layover bays sit back from the route line: a bus resting in *Bay D* can project too far off its shape to read as "at the terminal" (or fail to project at all), yet the bay name still identifies it. Only **parked** buses are eligible, so a bus driving *through* a terminal on a live run is unaffected.

### Terminal gate (rail)

Both ends of every MARTA line are turnback terminals where trains naturally queue (one arriving, one waiting to depart — and a single train at the turnback can show up on both directions), so a cross-line cluster there is a layover knot, not a real pileup — e.g. RED + GOLD stacked at **Airport**. `detectCrossLineBunches` drops any train whose projected along-line `distFt` sits inside the line's terminal zone (`terminalZoneFt(lengthFt)`, the same gate the per-line detector uses) before clustering (`isTrainAtTerminal`; `latestTrainPositions` supplies `distFt` + `lengthFt`). Pass `excludeTerminal: false` to restore whole-network framing, or a `terminalIds` set to override the derivation in tests.

### Posting & the place key

The bins (`bin/marta/{bus,rail}/cross-bunching.js`) post to the bus / train account with an intersection map (`src/marta/map/crossBunching.js`): each vehicle is a numbered disc colored by route, plus a legend. The lifecycle reuses `src/marta/shared/incidents.js` but is **keyed on the place** (nearest GTFS stop, else a rounded centroid) under a new `kind` (`bus-multi` / `rail-multi`). Place name comes from `nearestStop(gtfs, …)`, which scans all GTFS stops (rail platforms included).

**Route lines under the discs.** Like the per-route maps, the still image and timelapse draw each involved route's polyline baked into the Mapbox base map as a `path-` overlay (black halo + route-colored core), so a viewer sees the lines actually converging on the pileup. `buildRoutePathOverlays` per line: **clips** to the visible frame (grown ~35%), **thins** survivors to ≤ 120 vertices (MARTA rail shapes carry a vertex roughly every 6 ft — ~22k points on RED — so without thinning the encoded overlays would blow the Mapbox static-URL length), and **colors** the core to match that group (rail uses official line colors via `lineColor`; buses fall back to the palette). All halos draw first, then all cores, so a crossing core is never buried under another route's halo. Route-line sourcing is best-effort — a route whose shape won't resolve just posts without its trace line.

### Suppression (cross-route beats per-route)

The cross-route bin runs **1 minute before** the per-route bin. When it posts, it records the cluster's member ids (`bunching_events.member_ids`); the per-route bins consult `incidents.recentCrossBunchMemberIds()` and **skip** any candidate sharing ≥ 2 vehicles with a recently-posted pileup, so the same physical pileup is never posted twice.

Each cross-route post replies with a ~10-min timelapse (`src/marta/map/crossBunchingVideo.js`). Since the cluster spans routes there's no single polyline to glide along, so motion is a free lat/lon interpolation through the shared dropout kernel (`pointAlong` = null) — discs ease between observed positions and fade out if a vehicle drops from the feed.

### Cron

The two cross-bunching jobs are in `cron/marta-crontab.txt`, each scheduled 1 min before its per-route job (`bin/marta/bus/cross-bunching.js` at `1-59/5`, before bus bunching at `2-59/5`; `bin/marta/rail/cross-bunching.js` at `7-59/5`, before rail bunching at `8-59/5`). Apply to the server with `scripts/marta/install-crontab.sh` — it marker-merges the block, substitutes paths, and creates the `state/logs` targets.

## Why this approach

The signal is geometric, not statistical: vehicles on the same shape, close together, in service territory. Most of the code is filtering — terminal layovers, dropped reports, opposite-direction noise — to make sure the post matches what a rider on the street would actually see.

## Files

- `src/marta/bus/shapes.js` — the `pdist` analog: GTFS shapes → cumulative feet + lat/lon projection.
- `src/marta/bus/bunching.js` — bus cluster detection (`detectBunches`, `bunchesFromObservations`).
- `src/marta/rail/lines.js`, `src/marta/rail/trains.js` — rail geometry + latest projected positions.
- `src/marta/rail/bunching.js` — rail cluster detection.
- `src/marta/{bus,rail}/crossBunching.js` — cross-route geographic detection.
- `src/marta/shared/geoClusters.js` — `clusterByProximity` (connected-components on lat/lon).
- `src/marta/bus/bunchingPost.js`, `src/marta/rail/post.js` — post + alt text.
- `src/marta/map/{busBunching,railIncidents,crossBunching,crossBunchingVideo}.js` — map + video renderers.
- `src/marta/{bus,rail}/video.js`, `src/shared/videoTracks.js` — timelapse + the shared dropout kernel.
- `src/marta/shared/incidents.js` — cooldown / cap / member-id suppression / web-export reconcile.
- `bin/marta/{bus,rail}/bunching.js`, `bin/marta/{bus,rail}/cross-bunching.js` — cron entry points.
