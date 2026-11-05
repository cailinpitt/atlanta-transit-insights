// Daily vehicle-position archive: one sorted Parquet file per (kind, Atlanta
// calendar day, revision), kept on the server and published to the public data
// bucket. The live position tables only hold a short hot window; see
// docs/POSITIONS.md.

const TZ = 'America/New_York';
const START_DATE = '2026-09-28';
const HOT_WINDOW_DAYS = 14;
const KINDS = ['bus', 'rail', 'streetcar'];
const MANIFEST_VERSION = 2;
const SCHEMA_VERSION = 2;

const BASE_URL = 'https://data.atlantatransitalerts.app/';

const TABLES = {
  bus: 'bus_observations',
  rail: 'rail_observations',
  streetcar: 'streetcar_observations',
};

// A train's identity is (line, direction, train_id); train ids repeat across lines.
const SORT_ORDER = {
  bus: ['route', 'vehicle_id', 'ts'],
  rail: ['line', 'direction', 'train_id', 'ts'],
  streetcar: ['line', 'vehicle_id', 'ts'],
};

// The feed's own timestamp for each kind, summarized per file as <field>_min/_max.
const SOURCE_TS = { bus: 'vehicle_ts', rail: 'event_ts', streetcar: 'event_ts' };

// docs/POSITIONS.md mirrors this list (a test keeps them in sync).
const KNOWN_GAPS = [
  {
    start: '2026-10-28T01:20:00-04:00',
    end: '2026-10-30T18:40:00-04:00',
    feeds: ['rail', 'streetcar'],
    note: 'Effectively dark after a MARTA rail API change; 2026-10-29 has 0 rail rows',
  },
  {
    start: '2026-10-30T18:40:00-04:00',
    end: '2026-10-30T19:07:00-04:00',
    feeds: ['bus', 'rail', 'streetcar'],
    note: '~26.5 min gap during the deploy that fixed the rail API change',
  },
  {
    start: '2026-11-05T15:37:00-05:00',
    end: '2026-11-05T17:37:00-05:00',
    feeds: ['bus', 'rail', 'streetcar'],
    note: 'Server ran out of memory and hung; only a few scattered polls recorded',
  },
];

function field(type, nullable, description, unit) {
  return unit ? { type, unit, nullable, description } : { type, nullable, description };
}

// Published fields per kind, in table column order; nullability follows
// src/marta/storage.js. A poll that returns no vehicles writes no rows.
const SCHEMA = {
  bus: {
    description: 'MARTA bus positions from the GTFS-rt vehicle positions feed',
    fields: {
      ts: field('integer', false, 'Poll time', 'epoch ms'),
      route: field(
        'string',
        false,
        'Public route number from the realtime feed (not GTFS route_id)',
      ),
      trip_id: field('string', true, 'GTFS trip_id, joins to the MARTA static schedule'),
      vehicle_id: field('string', true, 'GTFS-rt vehicle id'),
      label: field(
        'string',
        true,
        'GTFS-rt vehicle label as sent by the feed; distinct from vehicle_id (e.g. vehicle 2303 has label "1603")',
      ),
      lat: field('number', true, 'Latitude', 'degrees'),
      lon: field('number', true, 'Longitude', 'degrees'),
      bearing: field(
        'integer',
        true,
        'Clockwise from true north. MARTA omits zero-valued fields, so 0 never appears and null usually means heading north',
        'degrees',
      ),
      speed: field(
        'number',
        true,
        'MARTA omits zero-valued fields, so 0 never appears and null mostly means stopped, not unknown. Treat values above ~31 as suspect (e.g. a constant 35.76)',
        'm/s',
      ),
      occupancy: field('string', true, 'GTFS-rt occupancy status'),
      vehicle_ts: field(
        'integer',
        true,
        'Feed-reported position time, as-is. Usually lags ts (median ~23s, p99 ~400s, up to ~25 min); around the fall-back DST change it can be up to ~1h ahead',
        'epoch s',
      ),
      start_date: field('string', true, 'Trip service date (YYYYMMDD)'),
    },
  },
  rail: {
    description: 'MARTA heavy rail train positions from the rail traindata API',
    fields: {
      ts: field('integer', false, 'Poll time', 'epoch ms'),
      train_id: field(
        'string',
        false,
        'MARTA train id; not unique within a poll, the unique key is (line, direction, train_id)',
      ),
      line: field('string', false, 'Rail line (RED, GOLD, BLUE, GREEN)'),
      direction: field('string', true, 'Direction (N, S, E, W)'),
      destination: field('string', true, 'Destination station'),
      lat: field('number', true, 'Latitude', 'degrees'),
      lon: field('number', true, 'Longitude', 'degrees'),
      delay_sec: field(
        'integer',
        true,
        'Reported delay; positive = late, negative = early',
        'seconds',
      ),
      event_ts: field(
        'integer',
        true,
        'Feed EVENT_TIME for the train (America/New_York wall clock)',
        'epoch ms',
      ),
    },
  },
  streetcar: {
    description: 'Atlanta Streetcar positions from the MARTA OTP vehicle feed',
    fields: {
      ts: field('integer', false, 'Poll time', 'epoch ms'),
      vehicle_id: field('string', false, 'OTP vehicle id (e.g. "MARTA:1001")'),
      label: field('string', true, 'Fleet number'),
      line: field('string', false, 'Streetcar line (SC)'),
      direction: field('string', true, 'GTFS direction_id ("0" or "1")'),
      trip_id: field(
        'string',
        true,
        'OTP trip id with a "MARTA:" prefix; strip it to join GTFS trips.txt',
      ),
      lat: field('number', true, 'Latitude', 'degrees'),
      lon: field('number', true, 'Longitude', 'degrees'),
      event_ts: field('integer', true, 'Feed lastUpdate for the vehicle', 'epoch ms'),
    },
  },
};

function toRecord(row) {
  const out = {};
  for (const name of Object.keys(SCHEMA[row.kind].fields)) out[name] = row[name] ?? null;
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

function filePath(kind, date, sha256) {
  if (!KINDS.includes(kind) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[a-f0-9]{64}$/.test(sha256))
    throw new Error('Invalid archive kind, date or SHA-256');
  return `${kind}/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.${sha256}.parquet`;
}

function newManifest() {
  return { manifest_version: MANIFEST_VERSION, days: {}, published: null };
}

function verifiedDay(entry) {
  return (
    entry?.verified === true &&
    KINDS.every((kind) => {
      const file = entry.files?.[kind];
      return (
        file?.format === 'parquet' &&
        file.schema_version === SCHEMA_VERSION &&
        /^[a-f0-9]{64}$/.test(file.sha256) &&
        file.data_revision === file.sha256 &&
        file.path?.endsWith(`.${file.sha256}.parquet`) &&
        Number.isSafeInteger(file.rows) &&
        file.rows >= 0 &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes > 0
      );
    })
  );
}

// Rows older than the hot window may be deleted, but never past the first day
// that hasn't been verified AND committed in the published Parquet manifest.
function rolloffCutoff(manifest, now = Date.now(), startDate = START_DATE) {
  const today = localDate(now);
  let cutoff = localMidnight(addDays(today, -HOT_WINDOW_DAYS));
  for (const date of completedDays(now, startDate)) {
    const { start } = dayBounds(date);
    if (start >= cutoff) break;
    const entry = manifest.days?.[date];
    if (
      manifest.manifest_version !== MANIFEST_VERSION ||
      !manifest.published ||
      !entry?.committed ||
      !verifiedDay(entry)
    ) {
      cutoff = start;
      break;
    }
  }
  return cutoff;
}

function weekday(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  });
}

// Also used to inventory the old index during the one-time migration.
function indexDays(previous) {
  const out = {};
  for (const day of previous?.days || []) {
    if (day?.date && day.files) out[day.date] = day.files;
  }
  return out;
}

// Never silently drop published history or mix NDJSON and Parquet in an index.
function buildIndex(manifest, generatedAt = Date.now(), previous = null) {
  const byDate = {};
  for (const [date, entry] of Object.entries(manifest.days)) {
    if (verifiedDay(entry)) byDate[date] = entry.files;
  }
  for (const date of Object.keys(indexDays(previous))) {
    if (!byDate[date]) throw new Error(`Refusing to drop published day ${date}`);
  }
  const dates = Object.keys(byDate).sort().reverse();
  const days = dates.map((date) => {
    const files = byDate[date];
    const rows = {};
    for (const kind of Object.keys(files)) rows[kind] = files[kind].rows;
    return { date, weekday: weekday(date), rows, files };
  });
  return {
    manifest_version: MANIFEST_VERSION,
    schema_version: SCHEMA_VERSION,
    title: 'MARTA vehicle positions archive',
    generated_at: new Date(generatedAt).toISOString(),
    timezone: TZ,
    days_are: 'Local calendar days in `timezone`, midnight to midnight',
    format: 'parquet',
    compression: 'zstd',
    sort_order: SORT_ORDER,
    previous_manifest: manifest.published?.path ?? null,
    base_url: BASE_URL,
    coverage: { first: dates.at(-1) ?? null, latest: dates[0] ?? null, days: dates.length },
    feeds: SCHEMA,
    known_gaps: KNOWN_GAPS,
    days,
  };
}

module.exports = {
  TZ,
  START_DATE,
  HOT_WINDOW_DAYS,
  KINDS,
  TABLES,
  MANIFEST_VERSION,
  SCHEMA_VERSION,
  SORT_ORDER,
  SOURCE_TS,
  SCHEMA,
  BASE_URL,
  KNOWN_GAPS,
  toRecord,
  addDays,
  localDate,
  localMidnight,
  dayBounds,
  completedDays,
  filePath,
  newManifest,
  verifiedDay,
  rolloffCutoff,
  indexDays,
  buildIndex,
};
