const test = require('node:test');
const assert = require('node:assert/strict');
const { detectCrossRouteBunches } = require('../../src/marta/bus/crossBunching');
const busPost = require('../../src/marta/bus/crossBunchingPost');
const { detectCrossLineBunches } = require('../../src/marta/rail/crossBunching');
const railPost = require('../../src/marta/rail/crossBunchingPost');

const NOW = Date.UTC(2026, 5, 17, 16, 0, 0);
const FT_PER_MILLIDEG_LAT = 364;
const dLatForFt = (ft) => ft / FT_PER_MILLIDEG_LAT / 1000;

const busAt = (vehicleId, route, ft) => ({
  vehicleId,
  route,
  lat: 33.75 + dLatForFt(ft),
  lon: -84.39,
  tmstmp: NOW,
});
const trainAt = (trainId, line, ft, motionSign = null) => ({
  trainId,
  line,
  lat: 33.754 + dLatForFt(ft),
  lon: -84.39,
  motionSign,
});

test('bus: headline + per-route grouping with optional GTFS titles', () => {
  const vs = [busAt('5678', '110', 0), busAt('1234', '816', 200), busAt('1235', '816', 400)];
  const [cluster] = detectCrossRouteBunches(vs, { now: NOW });
  const routeTitles = new Map([['816', 'Route 816 (N. Decatur)']]);
  const text = busPost.buildPostText(
    cluster,
    { placeName: 'Decatur & Clairmont', routeTitles },
    [],
  );
  assert.match(text, /3 buses from 2 routes bunched near Decatur & Clairmont/);
  assert.match(text, /Route 816 \(N\. Decatur\): /); // title from map applied
  assert.match(text, /Route 110: /); // fallback label
  assert.match(text, /#1234 \(1️⃣\)/);
});

test('rail: headline names the place and groups trains by line', () => {
  const ts = [trainAt('t1', 'RED', 0), trainAt('t2', 'GOLD', 400), trainAt('t3', 'GOLD', 800)];
  const [cluster] = detectCrossLineBunches(ts);
  const text = railPost.buildPostText(cluster, { placeName: 'Five Points' }, ['callout']);
  assert.match(text, /3 trains from 2 lines stacked up at Five Points/);
  assert.match(text, /Gold Line:/);
  assert.match(text, /Red Line:/);
  assert.match(text, /📊 callout/);
});

test('rail: alt text lists lines and span', () => {
  const ts = [trainAt('t1', 'RED', 0), trainAt('t2', 'GOLD', 400), trainAt('t3', 'BLUE', 800)];
  const [cluster] = detectCrossLineBunches(ts);
  const alt = railPost.buildAltText(cluster, { placeName: 'Five Points' });
  assert.match(alt, /Red Line/);
  assert.match(alt, /3 trains from 3 lines/);
});
