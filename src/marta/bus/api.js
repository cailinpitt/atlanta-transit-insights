// MARTA bus GTFS-realtime adapter.
//
// MARTA publishes standard GTFS-rt v2.0 protobuf for bus — VehiclePositions and
// TripUpdates — over public, unauthenticated HTTPS (no API key, unlike rail).
// This mirrors src/metra/api.js (the protobuf-decode reference) but normalizes
// to MARTA's feed reality, observed from captured fixtures:
//
//   VehiclePositions (1 entity per active vehicle):
//     trip.tripId            join key to static GTFS
//     trip.routeId           PUBLIC route number ("20"), not GTFS route_id
//     trip.directionId       UNRELIABLE (seen 0,5,9,11,14) — ignore; use trips.txt
//     position.lat/lon       always present
//     position.bearing       usually present
//     position.speed         present on ~57% of vehicles, m/s, quantized ~5mph
//     vehicle.id / .label    fleet id + run number
//     occupancyStatus        usually present
//
//   TripUpdates (1 entity per active trip):
//     trip.{tripId,routeId,startTime,startDate}
//     stopTimeUpdate[]: stopSequence, stopId, arrival/departure {time, scheduledTime}
//       MARTA carries scheduledTime (not `delay`), so adherence = time - scheduledTime.
//
// Parsers are pure and exported so feeds can be validated from a fixture buffer
// without network or DB. Recording into SQLite is deliberately out of scope
// here (see src/shared/observations.js when the storage port lands).
const axios = require('axios');
const GtfsRt = require('gtfs-realtime-bindings');
const { withRetry } = require('../../shared/retry');

const VEHICLE_POSITIONS_URL =
  'https://gtfs-rt.itsmarta.com/TMGTFSRealTimeWebService/vehicle/vehiclepositions.pb';
const TRIP_UPDATES_URL =
  'https://gtfs-rt.itsmarta.com/TMGTFSRealTimeWebService/tripupdate/tripupdates.pb';

const { transit_realtime } = GtfsRt;
const FeedMessage = transit_realtime.FeedMessage;

// protobufjs decodes 64-bit fields as Long objects; everything downstream wants
// plain numbers (epoch seconds). Null-safe.
function longToNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function reverseEnum(enumObj) {
  const out = {};
  for (const [name, val] of Object.entries(enumObj)) out[val] = name;
  return out;
}
const TRIP_REL = reverseEnum(transit_realtime.TripDescriptor.ScheduleRelationship);
const STOP_REL = reverseEnum(transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship);
const OCCUPANCY = reverseEnum(transit_realtime.VehiclePosition.OccupancyStatus);
const relName = (map, v) => (v == null ? null : (map[v] ?? String(v)));

// protobufjs sets unset scalar fields to their type default (0) on the message
// PROTOTYPE, so a plain read can't tell "0 on the wire" from "absent." We only
// want values actually transmitted (MARTA omits speed/bearing for many
// vehicles), so gate on own-property presence and finiteness.
function wireNum(msg, key) {
  if (!msg || !Object.hasOwn(msg, key)) return null;
  const v = msg[key];
  return Number.isFinite(v) ? v : null;
}

function decodeFeed(buffer) {
  return FeedMessage.decode(new Uint8Array(buffer));
}

// --- Normalizers (pure; one per entity type) ---

function parseVehiclePosition(entity) {
  const v = entity.vehicle;
  if (!v) return null;
  const trip = v.trip || {};
  const pos = v.position || {};
  return {
    entityId: entity.id ?? null,
    tripId: trip.tripId ?? null,
    // Public route number from the realtime feed. Resolve to the canonical
    // static route via gtfs.resolveRoute({ tripId, realtimeRouteId }).
    realtimeRouteId: trip.routeId ?? null,
    startDate: trip.startDate ?? null,
    scheduleRelationship: relName(TRIP_REL, trip.scheduleRelationship),
    vehicleId: v.vehicle?.id ?? null,
    label: v.vehicle?.label ?? null,
    lat: Number.isFinite(pos.latitude) ? pos.latitude : null,
    lon: Number.isFinite(pos.longitude) ? pos.longitude : null,
    bearing: wireNum(pos, 'bearing'),
    // metres/second when present (~57% of vehicles); null otherwise. Detectors
    // must tolerate missing speed.
    speed: wireNum(pos, 'speed'),
    occupancy: relName(OCCUPANCY, v.occupancyStatus),
    ts: longToNum(v.timestamp),
  };
}

function parseTripUpdate(entity) {
  const tu = entity.tripUpdate;
  if (!tu) return null;
  const trip = tu.trip || {};
  return {
    entityId: entity.id ?? null,
    tripId: trip.tripId ?? null,
    realtimeRouteId: trip.routeId ?? null,
    startTime: trip.startTime ?? null,
    startDate: trip.startDate ?? null,
    scheduleRelationship: relName(TRIP_REL, trip.scheduleRelationship),
    vehicleId: tu.vehicle?.id ?? null,
    label: tu.vehicle?.label ?? null,
    timestamp: longToNum(tu.timestamp),
    stopUpdates: (tu.stopTimeUpdate || []).map((s) => {
      const arrivalTime = longToNum(s.arrival?.time);
      const arrivalScheduledTime = longToNum(s.arrival?.scheduledTime);
      return {
        stopSequence: Number.isFinite(s.stopSequence) ? s.stopSequence : null,
        stopId: s.stopId ?? null,
        scheduleRelationship: relName(STOP_REL, s.scheduleRelationship),
        arrivalTime,
        arrivalScheduledTime,
        departureTime: longToNum(s.departure?.time),
        departureScheduledTime: longToNum(s.departure?.scheduledTime),
        // MARTA omits GTFS-rt `delay`; adherence is predicted minus scheduled.
        // Positive = late. Null when either side is missing.
        scheduleDeviationSec:
          arrivalTime != null && arrivalScheduledTime != null
            ? arrivalTime - arrivalScheduledTime
            : null,
      };
    }),
  };
}

// --- Public fetchers (pure-ish: fetch + decode + normalize, no DB writes) ---

async function fetchBuffer(url, label) {
  const { data } = await withRetry(
    () => axios.get(url, { responseType: 'arraybuffer', timeout: 15000 }),
    { label },
  );
  return Buffer.from(data);
}

async function getVehiclePositions() {
  const feed = decodeFeed(await fetchBuffer(VEHICLE_POSITIONS_URL, 'MARTA bus VehiclePositions'));
  return {
    feedTimestamp: longToNum(feed.header?.timestamp),
    vehicles: (feed.entity || []).map(parseVehiclePosition).filter(Boolean),
  };
}

async function getTripUpdates() {
  const feed = decodeFeed(await fetchBuffer(TRIP_UPDATES_URL, 'MARTA bus TripUpdates'));
  return {
    feedTimestamp: longToNum(feed.header?.timestamp),
    tripUpdates: (feed.entity || []).map(parseTripUpdate).filter(Boolean),
  };
}

module.exports = {
  VEHICLE_POSITIONS_URL,
  TRIP_UPDATES_URL,
  getVehiclePositions,
  getTripUpdates,
  // Exposed for fixture-based tests (decode from a buffer, no network).
  decodeFeed,
  parseVehiclePosition,
  parseTripUpdate,
};
