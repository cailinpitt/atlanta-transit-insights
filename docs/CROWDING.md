# Crowding

How the bot turns MARTA's GTFS-realtime occupancy field into "how full were the buses" — a colored route map and a most-crowded-routes digest. The occupancy sibling of [SPEEDMAP.md](./SPEEDMAP.md).

## What it shows

Two bus-only surfaces, both posted to **@martabusinsights**:

- **Crowding map** — a single route's shape over the last hour, segment by segment, each colored by how full the buses there were. Like the speedmap, it shows *where* a route fills up, not just a headline number — a route that reddens only near downtown reads very differently from one packed end-to-end.
- **Crowding rollup** — a "most crowded routes, past hour" digest: the routes with the largest share of standing-room-or-fuller sightings, as a threaded post. The cross-route companion to the single-route map.

Colors (`colorForCrowding`, 4 buckets on the occupancy score):

- 🟩 green — empty / many seats (score < 2)
- 🟨 yellow — few seats (< 3)
- 🟧 orange — standing room only (< 4)
- 🟥 red — crushed or full (≥ 4)

## Why bus-only

Occupancy lives only in the GTFS-realtime bus `VehiclePositions` feed (`occupancyStatus`). The rail `traindata` feed and the streetcar OTP feed carry no occupancy/load field, so crowding is inherently a bus feature. (Speed is the opposite story — rail reconstructs it from position deltas; occupancy can't be reconstructed.)

## How occupancy becomes a score (`src/marta/bus/crowding.js`)

MARTA reports `occupancyStatus` on ~all vehicles; `src/marta/bus/api.js` stores it as the GTFS enum **name** in `bus_observations.occupancy`. `OCCUPANCY_SCORE` maps that name to an ordinal crowding score:

| Status | Score |
|---|---|
| `EMPTY` | 0 |
| `MANY_SEATS_AVAILABLE` | 1 |
| `FEW_SEATS_AVAILABLE` | 2 |
| `STANDING_ROOM_ONLY` | 3 |
| `CRUSHED_STANDING_ROOM_ONLY` | 4 |
| `FULL` | 5 |
| `NOT_ACCEPTING_PASSENGERS`, `NO_DATA_AVAILABLE`, `NOT_BOARDABLE` | excluded (null) |

`FULL` is treated as the most crowded, above `CRUSHED`, regardless of the enum's numeric order. The out-of-service / no-signal statuses are dropped — they aren't a crowding measurement.

### The EMPTY/absent ambiguity

Protobuf decodes an **absent** enum int as `0`, so a stored `EMPTY` can mean either a genuinely empty bus or one the feed didn't tag. That only blurs the *not-crowded* end: the map and rollup therefore **under-report** crowding, never over-claim it — the safe direction for an "err toward silence" feed. The crowded end (standing room and up) is unambiguous.

## The map (`src/marta/map/busCrowding.js`)

Identical construction to the bus speedmap, only the per-segment color scale differs:

1. Each occupancy-bearing observation is projected onto its trip's shape (`src/marta/bus/shapes.js`, the `pdist` analog) → a `{ distFt, score }` sample.
2. Samples bin into 40 equal-length segments; each segment's color is its **average** score (`binSamples` → `colorForCrowding`).
3. The shape polyline is **thinned** before encoding (`thinPolylinePoints`) so the Mapbox static URL stays under its ~8 KB limit — the same fix bus speedmaps needed (a full untthinned bus shape is 20k+ points and 414'd every request).

`bin/marta/bus/crowding-map.js` features the **most crowded** eligible route each run (coverage ≥ `MIN_COVERAGE` 0.3, ≥ `MIN_SAMPLES` 20, standing-or-fuller share ≥ `MIN_CROWDED_FRACTION` 0.15), with a 6 h per-route cooldown so a chronically packed trunk doesn't dominate every hour. Silent when nothing clears the bar.

## The rollup (`bin/marta/bus/crowding-rollup.js`)

`summarizeRouteCrowding` counts, per route, the share of occupancy sightings that were standing-room-or-fuller (`crowdedBinFraction`'s row-level cousin) plus the peak level. A route qualifies at ≥ 15 sightings, ≥ 25% crowded, ≥ 3 crowded sightings; the digest posts only when ≥ 2 routes qualify (a lone crowded route is the map's job), top 10, with a 3 h cooldown.

## Cadence

| Job | Cron | Notes |
|---|---|---|
| `crowding-map` | hourly (`42 * * * *`) | most-crowded route; 6 h per-route cooldown |
| `crowding-rollup` | every 2 h (`52 */2 * * *`) | 3 h cooldown; silent unless ≥ 2 routes crowded |

Both read the recorded observation window (no extra feed fetch) and post fire-and-forget. Crowding is descriptive, not a disruption — like speedmaps, it is **Bluesky-only** and does not flow to the website (`export-web.js` doesn't read it).
