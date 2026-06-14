// MARTA rail realtime adapter — the rail parity gate (plan Phase 5).
//
// Source: developerservices.itsmarta.com:18096 …/railrealtimearrivals/…/traindata
// Requires MARTA_TRAIN_KEY (apiKey query param). Returns a flat JSON array where
// each row is one (train → upcoming station) arrival prediction. Validated feed
// reality (see docs/MARTA_FEEDS.md), NOT the developer doc:
//
//   Two row kinds, split by IS_REALTIME:
//   • "true"  → a TRACKED train: real TRAIN_ID + real LATITUDE/LONGITUDE +
//               signed DELAY ("T-21S" = 21s early, "T0S" = on time). One row per
//               upcoming station the train will hit; all rows for a train share
//               its (constant) position. This is what makes Path A possible —
//               we have true train identity AND position, not just predictions.
//   • "false" → a SCHEDULED estimate: empty TRAIN_ID, no coordinates, no DELAY.
//               Station + line + direction + waiting time only. A schedule
//               signal (useful for ghost detection), never a position.
//
//   LINE        RED | GOLD | BLUE | GREEN
//   DIRECTION   N|S (Red/Gold), E|W (Blue/Green)
//   STATION     e.g. "AIRPORT STATION"
//   DESTINATION terminal headsign, e.g. "Airport"
//   WAITING_SECONDS  seconds until arrival at STATION
//   NEXT_ARR    local clock string, e.g. "08:35:23 PM"
//   EVENT_TIME  per-train last-update wall clock, America/New_York
//
// Parsers are pure and exported so the rail fixtures validate without network.
const axios = require('axios');
const { withRetry } = require('../../shared/retry');

const RAIL_URL =
  'https://developerservices.itsmarta.com:18096/itsmarta/railrealtimearrivals/developerservices/traindata';

const LINES = ['RED', 'GOLD', 'BLUE', 'GREEN'];

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// DELAY is "T<seconds>S", signed: T0S on-time, T-21S 21s early, T249S 249s late.
// Present only on realtime rows. Returns seconds (positive = late) or null.
function parseDelaySeconds(v) {
  if (!v) return null;
  const m = /^T(-?\d+)S$/.exec(v);
  return m ? Number(m[1]) : null;
}

// Convert a wall-clock instant in a named tz to epoch ms (standard offset
// inversion: ask what wall clock the naive-UTC guess shows in the tz, the gap
// is the offset). Handles EDT/EST without a tz library.
function zonedToEpoch(y, mo, d, h, mi, s, tz = 'America/New_York') {
  const asUTC = Date.UTC(y, mo - 1, d, h, mi, s);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(asUTC));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  // %24 normalizes the "24" some engines emit for midnight.
  const invUTC = Date.UTC(
    g('year'),
    g('month') - 1,
    g('day'),
    g('hour') % 24,
    g('minute'),
    g('second'),
  );
  return asUTC - (invUTC - asUTC);
}

// Parse "MM/DD/YYYY h:mm:ss AM" (America/New_York) → epoch ms, or null.
function parseEventTime(v) {
  if (!v) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)$/i.exec(v.trim());
  if (!m) return null;
  let hour = Number(m[4]) % 12;
  if (/PM/i.test(m[7])) hour += 12;
  return zonedToEpoch(Number(m[3]), Number(m[1]), Number(m[2]), hour, Number(m[5]), Number(m[6]));
}

// Normalize one raw arrival row. `polledAt` (epoch ms, our fetch time) is the
// authoritative clock for position deltas; EVENT_TIME is the feed's own stamp.
function parseArrivalRow(row, polledAt = Date.now()) {
  const isRealtime = row.IS_REALTIME === 'true';
  return {
    isRealtime,
    // Empty string on scheduled rows → null so identity is unambiguous.
    trainId: row.TRAIN_ID ? String(row.TRAIN_ID) : null,
    line: row.LINE || null,
    direction: row.DIRECTION || null,
    destination: row.DESTINATION || null,
    station: row.STATION || null,
    // Position only exists on realtime rows.
    lat: isRealtime ? toNum(row.LATITUDE) : null,
    lon: isRealtime ? toNum(row.LONGITUDE) : null,
    waitingSeconds: toNum(row.WAITING_SECONDS),
    nextArrivalClock: row.NEXT_ARR || null,
    delaySeconds: parseDelaySeconds(row.DELAY),
    eventTime: row.EVENT_TIME || null,
    eventTs: parseEventTime(row.EVENT_TIME),
    polledAt,
  };
}

// Collapse realtime rows into one record per train, carrying its position and
// the ordered list of upcoming station arrivals. The (line, direction, trainId)
// tuple is the identity key — TRAIN_ID alone is reused across lines/directions.
function groupTrains(arrivals) {
  const byTrain = new Map();
  for (const a of arrivals) {
    if (!a.isRealtime || a.trainId == null) continue;
    const key = `${a.line}/${a.direction}/${a.trainId}`;
    let t = byTrain.get(key);
    if (!t) {
      t = {
        key,
        trainId: a.trainId,
        line: a.line,
        direction: a.direction,
        destination: a.destination,
        lat: a.lat,
        lon: a.lon,
        delaySeconds: a.delaySeconds,
        eventTs: a.eventTs,
        polledAt: a.polledAt,
        upcoming: [],
      };
      byTrain.set(key, t);
    }
    t.upcoming.push({
      station: a.station,
      waitingSeconds: a.waitingSeconds,
      nextArrivalClock: a.nextArrivalClock,
    });
  }
  for (const t of byTrain.values()) {
    t.upcoming.sort((x, y) => (x.waitingSeconds ?? Infinity) - (y.waitingSeconds ?? Infinity));
  }
  return [...byTrain.values()];
}

// Parse a full traindata response into the three useful shapes.
function parseTrainData(rows, polledAt = Date.now()) {
  const arrivals = (rows || []).map((r) => parseArrivalRow(r, polledAt));
  return {
    polledAt,
    arrivals,
    // Tracked trains with position — drive speedmaps/gaps/bunches (Path A).
    trains: groupTrains(arrivals),
    // Scheduled station estimates with no live train — a ghost signal.
    scheduled: arrivals.filter((a) => !a.isRealtime),
  };
}

async function fetchTrainData() {
  if (!process.env.MARTA_TRAIN_KEY) throw new Error('MARTA_TRAIN_KEY is not set');
  const polledAt = Date.now();
  const { data } = await withRetry(
    () =>
      axios.get(RAIL_URL, {
        params: { apiKey: process.env.MARTA_TRAIN_KEY },
        timeout: 20000,
      }),
    { label: 'MARTA rail traindata' },
  );
  return parseTrainData(data, polledAt);
}

module.exports = {
  RAIL_URL,
  LINES,
  fetchTrainData,
  // Exposed for fixture-based tests.
  parseTrainData,
  parseArrivalRow,
  groupTrains,
  parseDelaySeconds,
  parseEventTime,
  zonedToEpoch,
};
