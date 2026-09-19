// MARTA Atlanta Streetcar realtime adapter.
//
// The streetcar is absent from every *documented* MARTA feed — the GTFS-rt bus
// VehiclePositions feed carries no ATLSC route or streetcar fleet, and the rail
// `traindata` REST feed is heavy-rail only. But the public rider app
// (itsmarta.com/ride, live map tracker.itsmarta.com) is backed by an
// OpenTripPlanner (OTP1) GraphQL endpoint that DOES expose the streetcar with
// realtime vehicle positions. Source verified 2026-06-15.
//
//   Endpoint (public, no auth / API key, introspection enabled):
//     https://tracker.itsmarta.com/otp/routers/default/index/graphql
//   Streetcar route: the sole mode TRAM route — shortName "SC", "Atlanta
//   Streetcar". Its numeric id rotates (26982 -> 29224), so it is never pinned:
//   see resolveRouteId().
//   Vehicle positions live under route.patterns[].vehiclePositions[].
//
// Caveats: this is the rider app's backend, NOT a published developer feed, so
// it can change without notice — parse defensively and poll politely. `speed`
// and `heading` come back null, so (like heavy rail) speed must be reconstructed
// from position deltas between polls, not read off the feed.
//
// Parsers are pure and exported so fixtures validate without network.
const Fs = require('node:fs');
const Path = require('node:path');
const axios = require('axios');
const { withRetry } = require('../../shared/retry');
const { parseCsv, routeMode } = require('../gtfs');

const OTP_URL = 'https://tracker.itsmarta.com/otp/routers/default/index/graphql';

// MARTA rotates the streetcar's numeric route id whenever it republishes the
// feed (26982 -> 29224), and OTP answers an unknown id with `route: null`
// rather than an error — so a pinned id silently yields zero vehicles forever,
// which is exactly how the streetcar went dark unnoticed. Nothing here is
// pinned: `resolveRouteId` derives the id every run (see its comment). This
// constant is only the last-resort seed if both derivations fail.
const STREETCAR_ROUTE_ID_FALLBACK = 'MARTA:29224';

// Where fetch-static-gtfs.js extracts the feed. routes.txt is ~90 rows, so
// reading it per run is cheap — unlike loadGtfs(), which also parses 45k trips.
const GTFS_ROUTES_TXT = Path.join(
  __dirname,
  '..',
  '..',
  '..',
  'data',
  'marta',
  'gtfs',
  'routes.txt',
);
// Line key we store streetcar rows under — the streetcar analog of a rail LINE
// (RED/GOLD/BLUE/GREEN). Kept distinct so it never collides with heavy rail.
const STREETCAR_LINE = 'SC';

// The streetcar is the only TRAM-mode route MARTA publishes, so mode is a
// stable selector where the id is not. Used only to recover from a rotated id.
const ROUTES_QUERY = '{ routes { gtfsId shortName longName mode } }';

// One round-trip: every pattern's live vehicle positions for the streetcar route.
const vehiclesQuery = (routeId) => `{
  route(id: "${routeId}") {
    patterns {
      directionId
      vehiclePositions {
        vehicleId
        label
        lat
        lon
        speed
        heading
        lastUpdate
        trip { gtfsId }
      }
    }
  }
}`;

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// OTP `lastUpdate` is an ISO-8601 string with offset, e.g.
// "2026-06-15T19:08:53-04:00". Date.parse honors the offset → epoch ms.
function parseLastUpdate(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// Flatten the route→patterns→vehiclePositions response into one record per live
// vehicle. `polledAt` (our fetch time) is the authoritative clock for position
// deltas; `eventTs` is the feed's own per-vehicle stamp. Shape mirrors a rail
// train record so the same position-delta speedmap machinery can consume it.
function parseStreetcarVehicles(data, polledAt = Date.now()) {
  const patterns = data?.route?.patterns || [];
  const out = [];
  for (const pattern of patterns) {
    const direction = pattern?.directionId != null ? String(pattern.directionId) : null;
    for (const vp of pattern?.vehiclePositions || []) {
      if (vp?.vehicleId == null) continue;
      out.push({
        vehicleId: String(vp.vehicleId),
        label: vp.label != null ? String(vp.label) : null,
        line: STREETCAR_LINE,
        direction,
        tripId: vp.trip?.gtfsId ?? null,
        lat: toNum(vp.lat),
        lon: toNum(vp.lon),
        // null in practice (OTP doesn't get them from the streetcar feed), but
        // carried through in case the feed starts populating them.
        speed: toNum(vp.speed),
        heading: toNum(vp.heading),
        eventTs: parseLastUpdate(vp.lastUpdate),
        polledAt,
      });
    }
  }
  return out;
}

async function postQuery(query, label) {
  const { data } = await withRetry(
    () =>
      axios.post(
        OTP_URL,
        { query },
        { headers: { 'content-type': 'application/json' }, timeout: 20000 },
      ),
    { label },
  );
  if (data?.errors?.length) {
    throw new Error(`OTP streetcar query error: ${JSON.stringify(data.errors).slice(0, 300)}`);
  }
  return data?.data;
}

// Pick the streetcar out of the full route list by mode, falling back to the
// long name. Exported pure so a fixture can exercise it without the network.
function pickStreetcarRoute(routes) {
  const list = routes || [];
  return (
    list.find((r) => String(r?.mode).toUpperCase() === 'TRAM') ||
    list.find((r) => /streetcar/i.test(String(r?.longName || ''))) ||
    null
  );
}

// The streetcar is the sole route_type 0 row in MARTA's static GTFS, and OTP
// ids are `<agency_id>:<route_id>` (verified across all five non-bus routes:
// GTFS 29224/29226/29227/29228/29229 == OTP MARTA:29224/...). So the local
// feed — which cron re-fetches nightly at 03:30 — tracks MARTA's id rotations
// for free, with no network call and no constant to maintain.
function streetcarIdFromGtfs(file = GTFS_ROUTES_TXT) {
  try {
    const route = (parseCsv(Fs.readFileSync(file, 'utf8')) || []).find(
      (r) => routeMode(r) === 'streetcar',
    );
    if (!route?.route_id) return null;
    return `${route.agency_id || 'MARTA'}:${route.route_id}`;
  } catch {
    // Missing/unreadable GTFS checkout — fall through to the OTP lookup.
    return null;
  }
}

// Cached for the life of the process; each cron tick is a fresh process.
let _resolvedRouteId = null;

// Resolution order, all automatic — nothing here needs hand-editing when MARTA
// rotates the id:
//   1. local GTFS routes.txt (offline, nightly-fresh)
//   2. OTP's own route list, by mode TRAM (covers a missing/stale checkout)
//   3. the fallback seed
async function resolveRouteId({ skipGtfs = false } = {}) {
  if (_resolvedRouteId) return _resolvedRouteId;
  if (!skipGtfs) {
    const fromGtfs = streetcarIdFromGtfs();
    if (fromGtfs) {
      _resolvedRouteId = fromGtfs;
      return _resolvedRouteId;
    }
  }
  const data = await postQuery(ROUTES_QUERY, 'MARTA streetcar OTP routes');
  const route = pickStreetcarRoute(data?.routes);
  if (!route?.gtfsId) throw new Error('OTP lists no TRAM-mode route; cannot resolve the streetcar');
  _resolvedRouteId = String(route.gtfsId);
  return _resolvedRouteId;
}

// Record to the MARTA history DB by default; { record: false } for diagnostic
// fetches. storage is required lazily so the pure-parser path stays DB-free.
async function fetchStreetcarVehicles({ record = true } = {}) {
  const polledAt = Date.now();
  let routeId = (await resolveRouteId().catch(() => null)) || STREETCAR_ROUTE_ID_FALLBACK;
  let data = await postQuery(vehiclesQuery(routeId), 'MARTA streetcar OTP vehicles');

  // OTP answers an id it doesn't know with `route: null` — no error, no rows.
  // If the GTFS checkout is staler than OTP (or we fell back to the seed), ask
  // OTP directly and retry once. Never silently return an empty fleet.
  if (!data?.route) {
    _resolvedRouteId = null;
    const resolved = await resolveRouteId({ skipGtfs: true });
    if (resolved !== routeId) {
      console.warn(`MARTA streetcar: ${routeId} did not resolve; OTP says ${resolved}`);
      routeId = resolved;
      data = await postQuery(vehiclesQuery(routeId), 'MARTA streetcar OTP vehicles');
    }
    if (!data?.route) {
      throw new Error(`OTP returned no route for the streetcar (tried ${routeId})`);
    }
  }

  const vehicles = parseStreetcarVehicles(data, polledAt);
  if (record) require('../storage').recordStreetcarObservations(vehicles, polledAt);
  return { polledAt, vehicles };
}

module.exports = {
  OTP_URL,
  STREETCAR_ROUTE_ID_FALLBACK,
  streetcarIdFromGtfs,
  pickStreetcarRoute,
  resolveRouteId,
  STREETCAR_LINE,
  vehiclesQuery,
  fetchStreetcarVehicles,
  parseStreetcarVehicles,
  parseLastUpdate,
};
