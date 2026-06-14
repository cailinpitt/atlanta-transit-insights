# MARTA feeds — validated reality

What the MARTA data feeds actually contain, verified against captured fixtures
(`test/marta/fixtures/`) rather than the developer docs. This is the ground
truth the detector port reasons about; update it when a capture surprises us.

Capture tooling:

- `scripts/marta/fetch-static-gtfs.js` — static GTFS → `data/marta/gtfs/`
- `scripts/marta/capture-bus-vp.js` — bus VehiclePositions snapshot
- `scripts/marta/capture-bus-tu.js` — bus TripUpdates snapshot
- `scripts/marta/build-bus-fixtures.js` — trim captures into committed fixtures

Adapters: `src/marta/bus/api.js` (GTFS-rt) and `src/marta/gtfs.js` (static + the join).

## Static GTFS — `itsmarta.com/google_transit_feed/google_transit.zip`

Public, unauthenticated, ~20 MB. **86 routes**: 81 bus (`route_type=3`),
4 rail (`route_type=1`), 1 streetcar (`route_type=0`). ~52k trips, ~7k stops.

Rail lines and brand colors (from `routes.txt`):

| route_id | line  | color   |
|----------|-------|---------|
| 26987    | RED   | CE242B  |
| 26985    | GOLD  | D4A723  |
| 26984    | BLUE  | 0075B2  |
| 26986    | GREEN | 009D4B  |
| 26982    | Atlanta Streetcar | FF00FF |

Stations: 44 parent stations (`location_type=1`), 214 child platforms
(`parent_station` set). Use parent↔child for station/platform pages.

## Bus GTFS-realtime — `gtfs-rt.itsmarta.com/TMGTFSRealTimeWebService/…`

Standard GTFS-rt v2.0 protobuf, public, **no API key**. `FULL_DATASET` each
poll. Two endpoints: `vehicle/vehiclepositions.pb`, `tripupdate/tripupdates.pb`.

### The realtime → static join

The single most important fact: **the realtime feed reports the *public* route
number in `trip.routeId`** (e.g. `"20"`), **not** the internal GTFS `route_id`
(e.g. `26915`). The stable shared key is `trip_id`. Canonical route:

```
realtime entity ──trip_id──▶ trips.txt ──route_id──▶ routes.txt
```

`gtfs.resolveRoute({ tripId, realtimeRouteId })` does this, falling back to
`route_short_name` only when a trip is missing from a stale static feed. The
realtime public number happens to equal `route_short_name`, which the join
asserts as a drift check (`shortNameMatches`).

### VehiclePositions

One entity per active vehicle (~180 observed midday).

| field | notes |
|-------|-------|
| `trip.tripId` | join key |
| `trip.routeId` | **public route number**, not `route_id` |
| `trip.directionId` | **UNRELIABLE** — observed values 0, 5, 9, 11, 14. Ignore it; take `direction_id` from `trips.txt`. |
| `position.lat/lon` | always present |
| `position.bearing` | usually present |
| `position.speed` | **only ~57% of vehicles**, metres/second, quantized to ~5 mph steps (max ~26.8 m/s ≈ 60 mph). Detectors must tolerate `null`. |
| `vehicle.id` / `.label` | fleet id + run number |
| `occupancyStatus` | usually present |

`parseVehiclePosition` deliberately **omits** `directionId` so nothing
downstream is tempted to trust it. It distinguishes on-wire `speed`/`bearing`
from protobufjs prototype defaults via own-property checks.

### TripUpdates

One entity per active trip (~365 observed midday), with predicted **and**
scheduled stop times.

- `trip.{tripId, routeId, startTime, startDate}` — `directionId` present here but
  same caveat as above.
- `stopTimeUpdate[]`: `stopSequence`, `stopId`, `arrival`/`departure`
  `{ time, scheduledTime }`.
- MARTA does **not** populate GTFS-rt `delay`. Schedule adherence is therefore
  `arrival.time − arrival.scheduledTime` (positive = late), exposed as
  `scheduleDeviationSec`.

## Rail realtime — `developerservices.itsmarta.com:18096/…/traindata`

Needs `MARTA_TRAIN_KEY` (`apiKey` query param). Returns a flat JSON array, one
row per **(train → upcoming station)** arrival prediction. Adapter:
`src/marta/rail/api.js`. Capture: `scripts/marta/capture-rail.js`.

**Feasibility gate result: PATH A — confirmed with TRUE positions.** The plan
feared station-arrival predictions with no identity or position. Reality is much
stronger. Two row kinds, split by `IS_REALTIME`:

| | `IS_REALTIME="true"` (tracked) | `IS_REALTIME="false"` (scheduled) |
|---|---|---|
| `TRAIN_ID` | real, e.g. `"402"` | **empty** |
| `LATITUDE`/`LONGITUDE` | **real train position** | **absent** |
| `DELAY` | signed `T<sec>S` (`T-21S`=21s early, `T0S`=on time) | absent |
| meaning | a train being tracked live | a future scheduled arrival |

Observed midday: ~330 tracked rows / ~340 scheduled rows, ~43 distinct trains.

What makes Path A work (verified against two snapshots 150s apart):

- **Identity is stable.** 41/43 `TRAIN_ID`s persisted across the gap; the 2 that
  dropped reached a terminal, 2 new ones were dispatched.
- **Positions are real and move.** All rows for one train share one lat/lon (it's
  the *train's* position, not the station's). Between snapshots, 31 trains moved
  0.4–1.8 mi (≈ plausible inter-station speeds) — so **speed is computable from
  position deltas**, enabling true rail speedmaps, not just headway maps.
- **Identity key is `(LINE, DIRECTION, TRAIN_ID)`** — `TRAIN_ID` alone (e.g.
  `401`/`402`) is reused across lines and directions.

Directions: `N`/`S` (Red, Gold), `E`/`W` (Blue, Green). `EVENT_TIME` is each
train's last-update wall clock in **America/New_York** (parsed via a DST-correct
offset inversion, no tz library). `WAITING_SECONDS` is the authoritative
seconds-to-arrival; `NEXT_ARR` is a redundant local clock string.

Implication: rail can target near-full CTA parity — true speedmaps, gaps,
bunches, and ghosts (scheduled rows with no materializing train) — rather than
the plan's honest-fallback "delay/headway map."

## Not yet validated

- **Official alerts** — no documented stable API; source-adapter spike pending
  (plan Phase 6).
