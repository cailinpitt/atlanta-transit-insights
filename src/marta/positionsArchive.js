// Daily vehicle-position archive: one gzipped NDJSON file per (kind, Atlanta
// service day), kept on the server and published to the public data bucket.
// The live position tables only hold a short hot window; see
// docs/POSITIONS.md.

const TZ = 'America/New_York';
const START_DATE = '2026-09-28';
const HOT_WINDOW_DAYS = 14;

// Published field lists per kind, in table column order. `ts` is when we
// polled the feed (epoch ms).
const KINDS = {
  bus: {
    table: 'bus_observations',
    schema: {
      ts: 'Poll time, epoch ms',
      route: 'Public route number from the realtime feed',
      trip_id: 'GTFS trip_id, joins to the MARTA static schedule',
      vehicle_id: 'GTFS-rt vehicle id',
      label: 'Vehicle label',
      lat: 'Latitude',
      lon: 'Longitude',
      bearing: 'Bearing in degrees',
      speed: 'Speed in m/s (null when the feed omits it)',
      occupancy: 'GTFS-rt occupancy status',
      vehicle_ts: 'GTFS-rt position timestamp, epoch SECONDS',
      start_date: 'Trip service date (YYYYMMDD)',
    },
  },
  rail: {
    table: 'rail_observations',
    schema: {
      ts: 'Poll time, epoch ms',
      train_id: 'MARTA train id',
      line: 'Rail line (RED, GOLD, BLUE, GREEN)',
      direction: 'Direction (N, S, E, W)',
      destination: 'Destination station',
      lat: 'Latitude',
      lon: 'Longitude',
      delay_sec: 'Reported delay in seconds',
      event_ts: 'Feed EVENT_TIME for the train, epoch ms',
    },
  },
  streetcar: {
    table: 'streetcar_observations',
    schema: {
      ts: 'Poll time, epoch ms',
      vehicle_id: 'OTP vehicle id (e.g. "MARTA:1001")',
      label: 'Fleet number',
      line: 'Streetcar line (SC)',
      direction: 'GTFS direction_id (0 or 1)',
      trip_id: 'Trip id',
      lat: 'Latitude',
      lon: 'Longitude',
      event_ts: 'Feed lastUpdate for the vehicle, epoch ms',
    },
  },
};

function toRecord(kind, row) {
  const out = {};
  for (const field of Object.keys(KINDS[kind].schema)) out[field] = row[field];
  return out;
}

function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function localDate(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

// Local midnight for a YYYY-MM-DD date, as epoch ms. DST flips at 2am, so
// midnight is always unambiguous; probe both offsets and keep the one that
// lands on 00:00 local.
function localMidnight(date) {
  const [y, m, d] = date.split('-').map(Number);
  for (const offsetHours of [4, 5]) {
    const candidate = Date.UTC(y, m - 1, d, offsetHours);
    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(candidate));
    if (localDate(candidate) === date && hour === '00') return candidate;
  }
  throw new Error(`No ${TZ} midnight for ${date}`);
}

function dayBounds(date) {
  return { start: localMidnight(date), end: localMidnight(addDays(date, 1)) };
}

// Every finished day from START_DATE through yesterday (Atlanta time).
function completedDays(now = Date.now(), startDate = START_DATE) {
  const today = localDate(now);
  const days = [];
  for (let d = startDate; d < today; d = addDays(d, 1)) days.push(d);
  return days;
}

function filePath(kind, date) {
  return `${kind}/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.ndjson.gz`;
}

// Rows older than the hot window may be deleted, but never past the first day
// that hasn't been archived and uploaded yet.
function rolloffCutoff(manifest, now = Date.now(), startDate = START_DATE) {
  const today = localDate(now);
  let cutoff = localMidnight(addDays(today, -HOT_WINDOW_DAYS));
  for (const date of completedDays(now, startDate)) {
    const { start } = dayBounds(date);
    if (start >= cutoff) break;
    if (!manifest[date]?.uploaded) {
      cutoff = start;
      break;
    }
  }
  return cutoff;
}

function buildIndex(manifest, generatedAt = Date.now()) {
  const days = Object.keys(manifest)
    .filter((date) => manifest[date].uploaded)
    .sort()
    .map((date) => ({ date, files: manifest[date].files }));
  const schema = {};
  for (const [kind, { schema: s }] of Object.entries(KINDS)) schema[kind] = s;
  return {
    generated_at: new Date(generatedAt).toISOString(),
    timezone: TZ,
    format: 'gzipped NDJSON, one JSON object per line, ordered by ts',
    schema,
    days,
  };
}

module.exports = {
  START_DATE,
  HOT_WINDOW_DAYS,
  KINDS,
  toRecord,
  addDays,
  localDate,
  localMidnight,
  dayBounds,
  completedDays,
  filePath,
  rolloffCutoff,
  buildIndex,
};
