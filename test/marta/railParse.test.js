const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const {
  parseTrainData,
  parseDelaySeconds,
  parseEventTime,
  zonedToEpoch,
  LINES,
} = require('../../src/marta/rail/api');

const rows = JSON.parse(
  Fs.readFileSync(Path.join(__dirname, 'fixtures', 'rail-traindata.json'), 'utf8'),
);
const parsed = parseTrainData(rows, 1_781_000_000_000);

test('traindata splits into tracked trains and scheduled estimates', () => {
  assert.ok(parsed.trains.length > 0, 'has tracked trains');
  assert.ok(parsed.scheduled.length > 0, 'has scheduled estimates');
  // Every arrival is one or the other.
  assert.equal(
    parsed.arrivals.filter((a) => a.isRealtime).length + parsed.scheduled.length,
    parsed.arrivals.length,
  );
});

test('tracked trains carry stable identity + a real position', () => {
  for (const t of parsed.trains) {
    assert.ok(t.trainId, 'has train id');
    assert.ok(LINES.includes(t.line), `line ${t.line} is a MARTA rail line`);
    assert.ok(['N', 'S', 'E', 'W'].includes(t.direction), `direction ${t.direction}`);
    assert.ok(Number.isFinite(t.lat) && Number.isFinite(t.lon), 'has position');
    // Atlanta-ish bounding box sanity.
    assert.ok(
      t.lat > 33 && t.lat < 34.2 && t.lon > -85 && t.lon < -84,
      'position in metro Atlanta',
    );
    assert.ok(t.upcoming.length > 0, 'has upcoming station predictions');
    // Upcoming stations sorted by soonest arrival.
    const waits = t.upcoming.map((u) => u.waitingSeconds);
    assert.deepEqual(
      waits,
      [...waits].sort((a, b) => a - b),
      'upcoming sorted by waitingSeconds',
    );
  }
});

test('identity key is (line, direction, trainId) — TRAIN_ID alone is reused', () => {
  const keys = new Set(parsed.trains.map((t) => t.key));
  assert.equal(keys.size, parsed.trains.length, 'no duplicate train records');
});

test('scheduled estimates have no train id and no position', () => {
  for (const s of parsed.scheduled) {
    assert.equal(s.isRealtime, false);
    assert.equal(s.trainId, null, 'scheduled rows have empty TRAIN_ID');
    assert.equal(s.lat, null);
    assert.equal(s.lon, null);
    assert.ok(s.station, 'still names a station');
    assert.ok(Number.isFinite(s.waitingSeconds), 'still has a waiting time');
  }
});

test('DELAY parses as signed seconds', () => {
  assert.equal(parseDelaySeconds('T0S'), 0);
  assert.equal(parseDelaySeconds('T249S'), 249);
  assert.equal(parseDelaySeconds('T-21S'), -21);
  assert.equal(parseDelaySeconds(undefined), null);
  assert.equal(parseDelaySeconds(''), null);
  assert.equal(parseDelaySeconds('garbage'), null);
});

test('EVENT_TIME parses America/New_York wall clock to epoch', () => {
  // 06/13/2026 8:32:53 PM EDT (UTC-4) = 2026-06-14T00:32:53Z.
  assert.equal(parseEventTime('06/13/2026 8:32:53 PM'), Date.UTC(2026, 5, 14, 0, 32, 53));
  // Winter date, EST (UTC-5): 01/15/2026 9:00:00 AM = 2026-01-15T14:00:00Z.
  assert.equal(zonedToEpoch(2026, 1, 15, 9, 0, 0), Date.UTC(2026, 0, 15, 14, 0, 0));
  assert.equal(parseEventTime('not a time'), null);
});

test('every realtime arrival row resolves a position; scheduled never does', () => {
  for (const a of parsed.arrivals) {
    if (a.isRealtime) {
      assert.ok(Number.isFinite(a.lat) && Number.isFinite(a.lon));
      assert.ok(a.trainId);
    } else {
      assert.equal(a.lat, null);
    }
  }
});
