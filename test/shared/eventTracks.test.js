const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LINE_TO_FEED,
  pickReplayableIncident,
  buildTrack,
  segmentByDirection,
} = require('../../src/shared/eventTracks');

const NOW = 1_700_000_000_000;

// A published rail incident in the legacy/flat shape (observations[] + flat
// lifecycle fields), as the older export path emits it.
function incident(over = {}) {
  return {
    id: 'rkey1',
    mode: 'rail',
    routes: ['red'],
    first_seen_ts: NOW,
    resolved_ts: NOW + 1800_000,
    active: false,
    observations: [
      {
        line: 'red',
        from_station: 'Five Points',
        to_station: 'Airport',
        direction: 'S',
        direction_label: 'southbound',
        onset_ts: NOW - 600_000,
        ts: NOW,
        resolved_ts: NOW + 1800_000,
        stations: ['Five Points', 'Garnett', 'Airport'],
      },
    ],
    official_alert: null,
    ...over,
  };
}

test('pickReplayableIncident pulls fields from the primary observation', () => {
  const r = pickReplayableIncident(incident());
  assert.equal(r.eventId, 'rkey1');
  assert.equal(r.line, 'red');
  assert.equal(r.lineFeed, 'RED');
  assert.equal(r.from, 'Five Points');
  assert.equal(r.to, 'Airport');
  assert.equal(r.direction, 'S');
  assert.deepEqual(r.stations, ['Five Points', 'Garnett', 'Airport']);
  assert.equal(r.onset, NOW - 600_000); // onset_ts preferred over ts
  assert.equal(r.resolved, NOW + 1800_000);
  assert.equal(r.active, false);
});

test('pickReplayableIncident reads v2 detections and official_alert fields', () => {
  const r = pickReplayableIncident({
    id: 'v2',
    mode: 'rail',
    routes: ['gold'],
    lifecycle: { first_seen_ts: NOW, resolved_ts: NOW + 1800_000, active: false },
    official_alert: {
      id: 'alert',
      lifecycle: { first_seen_ts: NOW, resolved_ts: NOW + 1800_000, active: false },
      scope: {
        from_station: 'Doraville',
        to_station: 'Airport',
      },
    },
    detections: [
      {
        id: 1,
        source: 'pulse-cold',
        scope: {
          route: 'gold',
          from_station: 'Doraville',
          to_station: 'Lindbergh Center',
          direction: 'S',
          direction_label: 'southbound',
          stations: ['Doraville', 'Chamblee', 'Lindbergh Center'],
        },
        lifecycle: { first_seen_ts: NOW, onset_ts: NOW - 300_000, resolved_ts: null, active: true },
      },
    ],
  });
  assert.equal(r.eventId, 'v2');
  assert.equal(r.line, 'gold');
  assert.equal(r.lineFeed, 'GOLD');
  assert.equal(r.from, 'Doraville');
  assert.equal(r.to, 'Lindbergh Center');
  assert.equal(r.direction, 'S');
  assert.deepEqual(r.stations, ['Doraville', 'Chamblee', 'Lindbergh Center']);
  assert.equal(r.onset, NOW - 300_000);
});

test('pickReplayableIncident rejects buses, streetcar, and segment-less incidents', () => {
  assert.equal(pickReplayableIncident(incident({ mode: 'bus' })), null);
  assert.equal(pickReplayableIncident(incident({ mode: 'streetcar' })), null);
  assert.equal(
    pickReplayableIncident(incident({ observations: [{ line: 'red', ts: NOW }] })),
    null,
  );
  assert.equal(pickReplayableIncident(null), null);
});

test('pickReplayableIncident falls back to the official_alert block for an alert-only incident', () => {
  const r = pickReplayableIncident(
    incident({
      observations: [],
      routes: ['blue'],
      official_alert: {
        scope: { from_station: 'Indian Creek', to_station: 'Five Points' },
        lifecycle: { first_seen_ts: NOW, resolved_ts: null, active: true },
      },
    }),
  );
  assert.equal(r.line, 'blue');
  assert.equal(r.lineFeed, 'BLUE');
  assert.equal(r.from, 'Indian Creek');
  assert.equal(r.to, 'Five Points');
  assert.equal(r.onset, NOW);
});

test('LINE_TO_FEED covers the four heavy-rail lines', () => {
  assert.deepEqual(LINE_TO_FEED, { red: 'RED', gold: 'GOLD', blue: 'BLUE', green: 'GREEN' });
});

test('buildTrack groups by vehicle with relative-second, rounded samples', () => {
  const rows = [
    { ts: NOW, vehicle_id: '101', dir: 'S', lat: 33.753746, lon: -84.391655 },
    { ts: NOW + 30_000, vehicle_id: '101', dir: 'S', lat: 33.749812, lon: -84.388123 },
    { ts: NOW, vehicle_id: '102', dir: 'N', lat: 33.79, lon: -84.32 },
  ];
  const track = buildTrack(
    {
      eventId: 'rkey1',
      line: 'red',
      from: 'A',
      to: 'B',
      stations: ['A', 'B'],
      onset: NOW,
      resolved: NOW + 1800_000,
      affectedDir: 'S',
    },
    rows,
    NOW,
  );
  assert.equal(track.line, 'red');
  assert.equal(track.affectedDir, 'S');
  assert.equal(track.durSec, 30);
  assert.equal(track.vehicles.length, 2);
  // Sorted by sample count desc → 101 (2 samples) first.
  assert.equal(track.vehicles[0].id, '101');
  assert.deepEqual(track.vehicles[0].s[0], [0, 33.75375, -84.39165]); // t0-relative, 5dp
  assert.equal(track.vehicles[0].s[1][0], 30);
});

test('buildTrack sorts unordered rows and keys relative seconds off the earliest', () => {
  // Rows deliberately out of ts order — buildTrack must sort before keying.
  const rows = [
    { ts: NOW + 30_000, vehicle_id: '9', dir: 'S', lat: 33.81, lon: -84.39 },
    { ts: NOW, vehicle_id: '9', dir: 'S', lat: 33.8, lon: -84.39 },
  ];
  const track = buildTrack({ eventId: 'k', line: 'red', onset: NOW }, rows, NOW);
  assert.equal(track.vehicles.length, 1);
  assert.equal(track.vehicles[0].s[0][0], 0);
  assert.equal(track.vehicles[0].s[1][0], 30);
  assert.equal(track.vehicles[0].s[0][1], 33.8); // earliest sample is the t0 one
});

test('buildTrack splits a turnaround (same train_id, dir flip) into two legs', () => {
  // One train that goes out (dir S) then reverses (dir N) at a terminal.
  const rows = [];
  for (let i = 0; i < 4; i++)
    rows.push({
      ts: NOW + i * 30_000,
      vehicle_id: '700',
      dir: 'S',
      lat: 33.8 - i * 0.01,
      lon: -84.39,
    });
  for (let i = 4; i < 8; i++)
    rows.push({
      ts: NOW + i * 30_000,
      vehicle_id: '700',
      dir: 'N',
      lat: 33.8 - (7 - i) * 0.01,
      lon: -84.39,
    });
  const track = buildTrack({ eventId: 'k', line: 'gold', onset: NOW }, rows, NOW);
  const ids = track.vehicles.map((v) => v.id).sort();
  assert.deepEqual(ids, ['700', '700~1']);
  const byId = Object.fromEntries(track.vehicles.map((v) => [v.id, v]));
  assert.equal(byId['700'].dir, 'S');
  assert.equal(byId['700~1'].dir, 'N');
  // Legs are time-disjoint: the outbound ends before the return begins.
  assert.ok(byId['700'].s[byId['700'].s.length - 1][0] < byId['700~1'].s[0][0]);
});

test('segmentByDirection absorbs a single-ping direction blip', () => {
  const rows = [
    { ts: 1, dir: 'S' },
    { ts: 2, dir: 'S' },
    { ts: 3, dir: 'N' }, // lone blip — not a real turnaround
    { ts: 4, dir: 'S' },
    { ts: 5, dir: 'S' },
  ];
  const segs = segmentByDirection(rows);
  assert.equal(segs.length, 1, 'a 1-ping flip should not split the track');
  assert.equal(segs[0].dir, 'S');
  assert.equal(segs[0].rows.length, 5);
});

test('buildTrack returns null when nothing is positioned', () => {
  assert.equal(buildTrack({ eventId: 'x', line: 'red' }, []), null);
  assert.equal(
    buildTrack({ eventId: 'x', line: 'red' }, [{ ts: NOW, vehicle_id: '1', lat: null }]),
    null,
  );
});
