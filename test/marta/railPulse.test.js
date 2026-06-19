const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectDeadSegments,
  detectFeedGap,
  stationsAlongLine,
} = require('../../src/marta/rail/pulse');
const disruptionPost = require('../../src/marta/rail/disruptionPost');
const {
  stableSegmentTag,
  overlapFraction,
  buildDisruption,
} = require('../../bin/marta/rail/pulse');

// --- synthetic straight-line geometry (constant lat, varying lon, explicit
// distFt), mirroring test/marta/railSpeedmap.test.js ---
function straightShape(distPerVertex, n, { lat = 33.75, lon0 = -84.4, dlon = 0.01 } = {}) {
  const points = [];
  for (let i = 0; i < n; i++) points.push({ lat, lon: lon0 + i * dlon, distFt: i * distPerVertex });
  return { line: 'RED', points, lengthFt: (n - 1) * distPerVertex };
}
const FT_PER_VERTEX = 600;
const N_VERTICES = 60; // length 35,400 ft (~6.7 mi)
const GEOM = straightShape(FT_PER_VERTEX, N_VERTICES);
const LEN = GEOM.lengthFt;

// lat/lon for a given along-track distFt (interpolate the straight line).
function locAt(distFt) {
  const t = distFt / FT_PER_VERTEX;
  const i = Math.floor(t);
  const frac = t - i;
  const a = GEOM.points[Math.min(i, N_VERTICES - 1)];
  const b = GEOM.points[Math.min(i + 1, N_VERTICES - 1)];
  return { lat: a.lat + (b.lat - a.lat) * frac, lon: a.lon + (b.lon - a.lon) * frac };
}

// Stations every 3000 ft along the line.
const STATIONS = [];
for (let d = 3000; d <= LEN - 3000; d += 3000) {
  const { lat, lon } = locAt(d);
  STATIONS.push({ name: `S${d} Station`, lat, lon, lines: ['red'], _d: d });
}

const MIN = 60 * 1000;
const NOW = 1_700_000_000_000;

function obsAt(distFt, ts, { direction = 'N', trainId = 't' } = {}) {
  const { lat, lon } = locAt(distFt);
  return { ts, lat, lon, direction, trainId };
}

// Build covered observations across [loFt, hiFt] over `ticks` 1-min steps ending
// at NOW, with one stationary train per `stepFt`-spaced distFt (distinct ids so
// no single train brackets the cold run).
function coveredObs(loFt, hiFt, { ticks = 20, stepFt = 1000, direction = 'N', tag = 'c' } = {}) {
  const out = [];
  for (let d = loFt; d <= hiFt; d += stepFt) {
    const id = `${tag}${d}`;
    for (let k = 0; k < ticks; k++) {
      out.push(obsAt(d, NOW - (ticks - 1 - k) * MIN, { direction, trainId: id }));
    }
  }
  return out;
}

test('detectFeedGap flags a ≥5-min hole in the global snapshot timeline', () => {
  const dense = [];
  for (let k = 0; k < 30; k++) dense.push({ ts: NOW - k * MIN });
  assert.equal(detectFeedGap({ positions: dense, now: NOW }).gap, false);

  const sparse = [{ ts: NOW - 20 * MIN }, { ts: NOW - 19 * MIN }, { ts: NOW }];
  assert.equal(detectFeedGap({ positions: sparse, now: NOW }).gap, true);
});

test('stationsAlongLine projects roster stations onto the geometry in order', () => {
  const got = stationsAlongLine(STATIONS, 'RED', GEOM);
  assert.equal(got.length, STATIONS.length);
  // ascending along-track
  for (let i = 1; i < got.length; i++) assert.ok(got[i].trackDist >= got[i - 1].trackDist);
});

test('skips when there are no observations', () => {
  const res = detectDeadSegments({
    line: 'RED',
    geom: GEOM,
    stations: STATIONS,
    headwayMin: 5,
    now: NOW,
    opts: { recentPositions: [] },
  });
  assert.equal(res.skipped, 'noobs');
});

test('a cold middle stretch fires a multi-station candidate', () => {
  // Trains run in [6000,12000] and [21000,30000]; the middle (~13k–20k) is cold.
  const recent = [
    ...coveredObs(6000, 12000, { tag: 'a' }),
    ...coveredObs(21000, 30000, { tag: 'b' }),
  ];
  const res = detectDeadSegments({
    line: 'RED',
    geom: GEOM,
    stations: STATIONS,
    headwayMin: 5,
    now: NOW,
    opts: { lookbackMs: 20 * MIN, recentPositions: recent, longLookbackPositions: recent },
  });
  assert.equal(res.skipped, null);
  assert.ok(res.candidates.length >= 1, 'expected a cold-segment candidate');
  const c = res.candidates[0];
  assert.equal(c.direction, 'N');
  assert.ok(c.coldStations >= 2, `expected ≥2 cold stations, got ${c.coldStations}`);
  // Endpoints are real roster stations strictly inside the cold run.
  assert.ok(c.fromStation._d > 12000 && c.toStation._d < 21000);
  assert.notEqual(c.fromStation.name, c.toStation.name);
});

test('a cold stretch inside the terminal zone does not fire', () => {
  // Cover everything EXCEPT the first ~4500 ft (terminal zone) → the only cold
  // stretch sits in the excluded scan range.
  const recent = coveredObs(4500, 33000, { tag: 'z' });
  const res = detectDeadSegments({
    line: 'RED',
    geom: GEOM,
    stations: STATIONS,
    headwayMin: 5,
    now: NOW,
    opts: { lookbackMs: 20 * MIN, recentPositions: recent, longLookbackPositions: recent },
  });
  // No multi-station cold run in the scannable middle.
  assert.equal(res.candidates.length, 0);
});

test('a train that crosses the cold run between snapshots vetoes it (fast traversal)', () => {
  const recent = [
    ...coveredObs(6000, 12000, { tag: 'a' }),
    ...coveredObs(21000, 30000, { tag: 'b' }),
    // One express train whose consecutive obs bracket the cold middle.
    obsAt(11000, NOW - 3 * MIN, { trainId: 'x' }),
    obsAt(22000, NOW - 2 * MIN, { trainId: 'x' }),
  ];
  const res = detectDeadSegments({
    line: 'RED',
    geom: GEOM,
    stations: STATIONS,
    headwayMin: 5,
    now: NOW,
    opts: { lookbackMs: 20 * MIN, recentPositions: recent, longLookbackPositions: recent },
  });
  assert.equal(res.candidates.length, 0, 'fast traversal should suppress the candidate');
});

test('a train going silent stationary inside the run is reclassified as held', () => {
  // Held train sat at 16,500 ft from t-26 to t-16, then GPS went silent — its
  // bin reads cold (last seen >15 min ago) and the tail is stationary.
  const held = [];
  for (let k = 0; k <= 10; k++) held.push(obsAt(16500, NOW - (26 - k) * MIN, { trainId: 'h' }));
  const recent = [
    ...coveredObs(6000, 12000, { tag: 'a' }),
    ...coveredObs(21000, 30000, { tag: 'b' }),
    ...held,
  ];
  const res = detectDeadSegments({
    line: 'RED',
    geom: GEOM,
    stations: STATIONS,
    headwayMin: 5,
    now: NOW,
    opts: { lookbackMs: 30 * MIN, recentPositions: recent, longLookbackPositions: recent },
  });
  assert.ok(res.candidates.length >= 1);
  assert.equal(res.candidates[0].kind, 'held');
  assert.ok(res.candidates[0].heldEvidence.stationaryMs >= 5 * MIN);
});

// --- post text builders ---
const COLD_DISRUPTION = {
  line: 'GOLD',
  suspendedSegment: { from: 'LENOX Station', to: 'CHAMBLEE Station' },
  terminus: 'Airport',
  source: 'observed',
  kind: 'cold',
  evidence: {
    runLengthMi: 6.7,
    minutesSinceLastTrain: 29,
    coldStations: 3,
    headwayMin: 10,
    expectedTrains: 2,
    trainsOutsideRun: 4,
  },
};

test('buildPostText renders a rider-facing cold disruption under 300 graphemes', () => {
  const text = disruptionPost.buildPostText(COLD_DISRUPTION, { alertOpen: false });
  assert.match(text, /Gold Line: trains toward Airport stalled/);
  assert.match(text, /Between Lenox and Chamblee\./); // SCREAMING names normalized
  assert.match(text, /scheduled every 10 min/);
  assert.match(text, /Inferred from live train positions/);
  assert.ok([...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].length <= 300);
});

test('buildPostText reflects an open MARTA alert in the footer', () => {
  const text = disruptionPost.buildPostText(COLD_DISRUPTION, { alertOpen: true });
  assert.match(text, /See MARTA alert in this thread/);
});

test('held + synthetic disruptions get their own framing', () => {
  const held = {
    ...COLD_DISRUPTION,
    source: 'observed-held',
    kind: 'held',
    evidence: { held: { trainCount: 1, stationaryMs: 12 * MIN }, coldStationNames: ['Lenox'] },
  };
  assert.match(disruptionPost.buildPostText(held), /trains stuck around Lenox/);
  assert.match(disruptionPost.buildPostText(held), /stationary 12\+ min/);

  const synth = {
    ...COLD_DISRUPTION,
    evidence: { synthetic: true, coldStations: 18, lookbackMin: 45, headwayMin: 10 },
  };
  assert.match(disruptionPost.buildPostText(synth), /No trains observed anywhere on the line/);
});

test('clear text + alt text name the segment rider-facing', () => {
  assert.match(disruptionPost.buildClearPostText(COLD_DISRUPTION), /Lenox ↔ Chamblee/);
  assert.match(disruptionPost.buildAltText(COLD_DISRUPTION), /between Lenox and Chamblee/);
  assert.match(disruptionPost.buildClearCardTitle(COLD_DISRUPTION), /Lenox ↔ Chamblee again/);
});

// --- bin pure helpers ---
test('stableSegmentTag is order-preserving and slug-stable', () => {
  const tag = stableSegmentTag({
    fromStation: { name: 'LENOX Station' },
    toStation: { name: 'Chamblee Station' },
  });
  assert.equal(tag, 'lenox_station__chamblee_station');
});

test('overlapFraction measures run overlap by the shorter run', () => {
  assert.equal(overlapFraction({ lo: 0, hi: 100 }, { lo: 50, hi: 150 }), 0.5);
  assert.equal(overlapFraction({ lo: 0, hi: 100 }, { lo: 200, hi: 300 }), 0);
  assert.equal(overlapFraction({ lo: 0, hi: 100 }, { lo: 0, hi: 100 }), 1);
});

test('buildDisruption carries from/to coords + canonical evidence', () => {
  const candidate = {
    runLoFt: 13000,
    runHiFt: 20000,
    runLengthFt: 7000,
    fromStation: { name: 'S15000 Station', lat: 33.75, lon: -84.35 },
    toStation: { name: 'S18000 Station', lat: 33.75, lon: -84.33 },
    coldStations: 2,
    coldStationNames: ['S15000 Station', 'S18000 Station'],
    trainsOutsideRun: 3,
    expectedTrains: 2,
    headwayMin: 5,
    lastSeenInRunMs: null,
    coldThresholdMs: 15 * MIN,
    lookbackMs: 20 * MIN,
  };
  const d = buildDisruption('RED', candidate, 'North Springs', NOW);
  assert.equal(d.fromLoc.lat, 33.75);
  assert.equal(d.evidence.from, 'S15000 Station');
  assert.equal(d.terminus, 'North Springs');
  assert.equal(d.source, 'observed');
});
