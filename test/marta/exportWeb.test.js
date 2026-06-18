const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const { spawnSync } = require('node:child_process');

const TMP_DB = Path.join(Os.tmpdir(), `marta-exportweb-test-${process.pid}-${Date.now()}.sqlite`);
process.env.MARTA_HISTORY_DB_PATH = TMP_DB;

const storage = require('../../src/marta/storage');
const incidents = require('../../src/marta/shared/incidents');
const alerts = require('../../src/marta/alert/store');
const { atUriToUrl, buildExport } = require('../../bin/marta/export-web');

test.after(() => {
  storage.closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try {
      Fs.unlinkSync(TMP_DB + ext);
    } catch {
      /* best effort */
    }
  }
});

const NOW = 1_781_000_000_000;
const ALERT_URI = 'at://did:plc:alerts/app.bsky.feed.post/alert123';
const GAP_URI = 'at://did:plc:bus/app.bsky.feed.post/gap123';
const OTHER_URI = 'at://did:plc:bus/app.bsky.feed.post/gap999';
const RAIL_URI = 'at://did:plc:rail/app.bsky.feed.post/rail123';

function seedAlert(over = {}, now = NOW) {
  alerts.recordAlertSeen(
    {
      alertId: 'alert-121',
      mode: 'bus',
      routes: '121',
      headline: 'Route 121 delays',
      description: 'Delays due to police activity.',
      cause: 'POLICE_ACTIVITY',
      effect: 'SIGNIFICANT_DELAYS',
      activeStartTs: now - 5 * 60_000,
      activeEndTs: null,
      postUri: ALERT_URI,
      ...over,
    },
    now,
  );
}

test('converts at-uri posts to bsky.app URLs', () => {
  assert.equal(
    atUriToUrl('at://did:plc:test/app.bsky.feed.post/abc123'),
    'https://bsky.app/profile/did:plc:test/post/abc123',
  );
  assert.equal(atUriToUrl(null), null);
  assert.equal(atUriToUrl('not-a-uri'), null);
});

test('pairs posted bot detections with matching official alerts', () => {
  seedAlert();
  incidents.recordGap(
    {
      kind: 'bus',
      route: '121',
      direction: 'shape-a',
      gapFt: 48_000,
      gapMin: 92,
      expectedMin: 28,
      ratio: 3.28,
      nearStop: 'N INDIAN CREEK DR @ DIAL DR',
      posted: true,
      postUri: GAP_URI,
    },
    NOW + 3 * 60_000,
  );

  const out = buildExport(storage.getDb(), NOW + 10 * 60_000);
  assert.equal(out.schema_version, 2);
  assert.equal(out.data_start_ts, NOW);
  assert.equal(out.incidents.length, 1);

  const incident = out.incidents[0];
  assert.equal(incident.agency, 'marta');
  assert.equal(incident.mode, 'bus');
  assert.deepEqual(incident.routes, ['121']);
  assert.deepEqual(incident.sources, ['marta', 'bot']);
  assert.equal(incident.official_alert.id, 'alert-121');
  assert.equal(incident.official_alert.post_url, atUriToUrl(ALERT_URI));
  assert.equal(incident.detections.length, 1);
  assert.equal(incident.detections[0].source, 'gap');
  assert.equal(incident.detections[0].post_url, atUriToUrl(GAP_URI));
  assert.equal(incident.lifecycle.active, true);
});

test('drops an unpaired single detector instead of making a standalone event', () => {
  // A lone gap on a route with no official alert and no roundup must NOT become
  // its own incident — matching CTA, where website events come only from
  // official alerts and multi-signal roundups. The post still goes to Bluesky;
  // it just doesn't spawn an event page on its own.
  incidents.recordGap(
    {
      kind: 'bus',
      route: '999',
      direction: 'shape-z',
      gapFt: 20_000,
      gapMin: 30,
      expectedMin: 10,
      ratio: 3,
      nearStop: null,
      posted: true,
      postUri: OTHER_URI,
    },
    NOW + 4 * 60_000,
  );

  const out = buildExport(storage.getDb(), NOW + 10 * 60_000);
  assert.equal(
    out.incidents.some((incident) => incident.id === 'gap999'),
    false,
  );
  assert.equal(
    out.incidents.some((incident) => (incident.routes || []).includes('999')),
    false,
  );
});

test('co-posted route-silence disruptions get distinct incident ids', () => {
  // thin-gaps / pulse bundle several silent routes into one Bluesky rollup post,
  // so each route's disruption row shares one post_uri. The export must still
  // give each route its own incident id, or co-posted routes collide on one
  // event page and all but the first are unreachable on the site.
  const SHARED_URI = 'at://did:plc:bus/app.bsky.feed.post/rollup777';
  incidents.recordDisruption(
    {
      kind: 'bus',
      line: '21',
      source: 'observed-thin',
      posted: true,
      postUri: SHARED_URI,
      evidence: { headwayMin: 40, windowMin: 80, missedTrips: 2 },
    },
    NOW + 60 * 60_000,
  );
  incidents.recordDisruption(
    {
      kind: 'bus',
      line: '116',
      source: 'observed-thin',
      posted: true,
      postUri: SHARED_URI,
      evidence: { headwayMin: 30, windowMin: 60, missedTrips: 2 },
    },
    NOW + 60 * 60_000,
  );

  const out = buildExport(storage.getDb(), NOW + 65 * 60_000);
  const r21 = out.incidents.filter(
    (i) => (i.routes || []).includes('21') && i.sources[0] === 'bot',
  );
  const r116 = out.incidents.filter(
    (i) => (i.routes || []).includes('116') && i.sources[0] === 'bot',
  );
  assert.equal(r21.length, 1);
  assert.equal(r116.length, 1);
  assert.equal(r21[0].id, 'rollup777-21');
  assert.equal(r116[0].id, 'rollup777-116');
  assert.notEqual(r21[0].id, r116[0].id);
});

test('reconciliation resolves a detector folded under an official alert', () => {
  const ts = NOW + 40 * 60_000;
  seedAlert(
    {
      alertId: 'alert-998',
      mode: 'bus',
      routes: '998',
      headline: 'Route 998 delays',
      postUri: 'at://did:plc:alerts/app.bsky.feed.post/alert998',
    },
    ts - 60_000,
  );
  incidents.recordGap(
    {
      kind: 'bus',
      route: '998',
      direction: 'shape-y',
      gapFt: 21_000,
      gapMin: 32,
      expectedMin: 10,
      ratio: 3.2,
      nearStop: null,
      posted: true,
      postUri: 'at://did:plc:bus/app.bsky.feed.post/closedgap',
    },
    ts,
  );
  incidents.reconcileGapEvents({ kind: 'bus', current: [], now: NOW + 45 * 60_000 });

  const out = buildExport(storage.getDb(), NOW + 50 * 60_000);
  const incident = out.incidents.find((row) => row.official_alert?.id === 'alert-998');
  assert.ok(incident);
  const gapDet = incident.detections.find((det) => det.source === 'gap');
  assert.ok(gapDet);
  assert.equal(gapDet.lifecycle.active, false);
  assert.equal(gapDet.lifecycle.resolved_ts, ts);
});

test('uses alerts-account roundup as bot incident anchor and folds detector evidence under it', () => {
  const roundupTs = NOW + 50 * 60_000;
  incidents.recordRoundupAnchor({
    kind: 'bus',
    line: '996',
    postUri: 'at://did:plc:martaalerts/app.bsky.feed.post/roundup996',
    postCid: 'cid-roundup',
    ts: roundupTs,
    signals: ['gap', 'bunching'],
    bullets: [{ source: 'gap', detail: { ratio: 3.5 } }],
  });
  incidents.recordGap(
    {
      kind: 'bus',
      route: '996',
      direction: 'shape-r',
      gapFt: 20_000,
      gapMin: 35,
      expectedMin: 10,
      ratio: 3.5,
      nearStop: null,
      posted: true,
      postUri: 'at://did:plc:bus/app.bsky.feed.post/gap996',
    },
    roundupTs + 60_000,
  );

  const out = buildExport(storage.getDb(), roundupTs + 5 * 60_000);
  const incident = out.incidents.find((row) => row.id === 'roundup996');
  assert.ok(incident);
  assert.equal(incident.official_alert, null);
  assert.deepEqual(incident.sources, ['bot']);
  assert.equal(incident.detections[0].source, 'roundup');
  assert.equal(
    incident.detections[0].post_url,
    'https://bsky.app/profile/did:plc:martaalerts/post/roundup996',
  );
  assert.deepEqual(
    incident.detections.map((det) => det.source),
    ['roundup', 'gap'],
  );
  assert.equal(
    out.incidents.some((row) => row.id === 'gap996'),
    false,
  );
});

test('reconciliation resolves the superseded detector but keeps the newest active', () => {
  seedAlert(
    {
      alertId: 'alert-997',
      mode: 'bus',
      routes: '997',
      headline: 'Route 997 delays',
      postUri: 'at://did:plc:alerts/app.bsky.feed.post/alert997',
    },
    NOW + 59 * 60_000,
  );
  incidents.recordGap(
    {
      kind: 'bus',
      route: '997',
      direction: 'shape-x',
      gapFt: 20_000,
      gapMin: 30,
      expectedMin: 10,
      ratio: 3,
      nearStop: null,
      posted: true,
      postUri: 'at://did:plc:bus/app.bsky.feed.post/oldergap',
    },
    NOW + 60 * 60_000,
  );
  incidents.recordGap(
    {
      kind: 'bus',
      route: '997',
      direction: 'shape-x',
      gapFt: 30_000,
      gapMin: 45,
      expectedMin: 10,
      ratio: 4.5,
      nearStop: null,
      posted: true,
      postUri: 'at://did:plc:bus/app.bsky.feed.post/newergap',
    },
    NOW + 70 * 60_000,
  );
  incidents.reconcileGapEvents({
    kind: 'bus',
    current: [{ route: '997', direction: 'shape-x' }],
    now: NOW + 75 * 60_000,
  });

  const out = buildExport(storage.getDb(), NOW + 80 * 60_000);
  const incident = out.incidents.find((row) => row.official_alert?.id === 'alert-997');
  assert.ok(incident);
  const byRkey = (rkey) => incident.detections.find((det) => det.post_url?.endsWith(`/${rkey}`));
  const older = byRkey('oldergap');
  const newer = byRkey('newergap');
  assert.ok(older);
  assert.ok(newer);
  assert.equal(older.lifecycle.active, false);
  assert.equal(older.lifecycle.resolved_ts, NOW + 70 * 60_000);
  assert.equal(newer.lifecycle.active, true);
});

test('pairs rail bunching and ghosts with matching rail alerts', () => {
  seedAlert(
    {
      alertId: 'rail-blue',
      mode: 'rail',
      routes: 'BLUE',
      headline: 'Blue Line delays',
      postUri: 'at://did:plc:alerts/app.bsky.feed.post/railalert',
    },
    NOW + 20 * 60_000,
  );
  incidents.recordBunching(
    {
      kind: 'rail',
      route: 'BLUE',
      direction: 'W',
      vehicleCount: 2,
      severityFt: 1200,
      nearStop: null,
      posted: true,
      postUri: RAIL_URI,
    },
    NOW + 21 * 60_000,
  );
  incidents.recordGhostEvent({
    kind: 'rail',
    route: 'BLUE',
    direction: null,
    observed: 4,
    expected: 8,
    missing: 4,
    postUri: RAIL_URI,
    ts: NOW + 22 * 60_000,
  });

  const out = buildExport(storage.getDb(), NOW + 30 * 60_000);
  const rail = out.incidents.find((incident) => incident.official_alert?.id === 'rail-blue');
  assert.ok(rail);
  assert.equal(rail.mode, 'rail');
  assert.deepEqual(rail.routes, ['blue']);
  assert.deepEqual(rail.detections.map((det) => det.source).sort(), ['bunching', 'ghost']);
});

test('a rail single-departure cancellation gets a status block and does NOT merge a same-line bunch', () => {
  const seenTs = NOW + 60 * 60_000;
  seedAlert(
    {
      alertId: 'rail-blue-cancel',
      mode: 'rail',
      routes: 'BLUE',
      headline: 'Rail Service Alert for Blue Line',
      description:
        'Update: Due to a previous issue on a Blue line train, the 3:59 p.m. Blue line departure from Indian Creek is cancelled. Delays continuing on the Blue line.',
      postUri: 'at://did:plc:alerts/app.bsky.feed.post/railcancel',
    },
    seenTs,
  );
  // A contemporaneous same-line bunch that WOULD merge into an ordinary alert —
  // a cancellation must not absorb it.
  incidents.recordBunching(
    {
      kind: 'rail',
      route: 'BLUE',
      direction: 'E',
      vehicleCount: 3,
      severityFt: 2089,
      nearStop: null,
      posted: true,
      postUri: 'at://did:plc:rail/app.bsky.feed.post/cancelbunch',
    },
    seenTs + 60_000,
  );

  // Export AFTER the 3:59 PM departure on the seen day → terminal 'cancelled'.
  const afterDep = require('../../src/marta/alert/cancellation').classifyRailCancellation({
    headline: 'x',
    description: 'The 3:59 p.m. departure is cancelled.',
    line: 'blue',
    anchorTs: seenTs,
  }).scheduledDepMs;
  const out = buildExport(storage.getDb(), afterDep + 60_000);
  const inc = out.incidents.find((i) => i.official_alert?.id === 'rail-blue-cancel');
  assert.ok(inc);
  assert.equal(inc.status?.type, 'cancellation');
  assert.equal(inc.status.state, 'cancelled');
  assert.equal(inc.status.origin, 'Indian Creek');
  assert.equal(inc.status.title, '3:59 PM Blue Line departure from Indian Creek cancelled');
  assert.deepEqual(inc.sources, ['marta']);
  assert.equal(inc.detections.length, 0, 'cancellation must not absorb the bunch');

  // Before the departure → 'upcoming'.
  const before = buildExport(storage.getDb(), afterDep - 60 * 60_000);
  const incBefore = before.incidents.find((i) => i.official_alert?.id === 'rail-blue-cancel');
  assert.equal(incBefore.status.state, 'upcoming');
});

test('exports an ATLSC alert as streetcar; route A bunching is bus, not streetcar', () => {
  seedAlert(
    {
      alertId: 'streetcar-alert',
      mode: 'streetcar',
      routes: 'ATLSC',
      headline: 'Atlanta Streetcar delays',
      postUri: 'at://did:plc:alerts/app.bsky.feed.post/streetcaralert',
    },
    NOW + 31 * 60_000,
  );
  // Route "A" is the Rapid A Line BRT (a bus), NOT the streetcar. A bunching on
  // it classifies as bus, so it must NOT fold into the ATLSC streetcar alert
  // (mode mismatch). Left unpaired, the lone detector never surfaces as its own
  // incident either — so route "A" appears nowhere in the export.
  incidents.recordBunching(
    {
      kind: 'bus',
      route: 'A',
      direction: 'rapid-a-shape',
      vehicleCount: 2,
      severityFt: 900,
      nearStop: 'SUMMERHILL',
      posted: true,
      postUri: 'at://did:plc:bus/app.bsky.feed.post/rapidabunch',
    },
    NOW + 32 * 60_000,
  );

  const out = buildExport(storage.getDb(), NOW + 40 * 60_000);
  const streetcar = out.incidents.find((incident) => incident.id === 'streetcaralert');
  assert.ok(streetcar);
  assert.equal(streetcar.mode, 'streetcar');
  assert.deepEqual(streetcar.routes, ['streetcar']);
  // The Rapid A bunching did not merge into the streetcar alert.
  assert.deepEqual(streetcar.detections, []);
  // And route "A" surfaces nowhere — not as streetcar, not as a bus incident.
  assert.equal(
    out.incidents.some((incident) => incident.routes.includes('A')),
    false,
  );
});

test('bin writes the schema-v2 payload', () => {
  const bin = Path.join(__dirname, '..', '..', 'bin', 'marta', 'export-web.js');
  const outPath = Path.join(Os.tmpdir(), `marta-alerts-${process.pid}-${Date.now()}.json`);
  const res = spawnSync(process.execPath, [bin, outPath], {
    encoding: 'utf8',
    env: { ...process.env, MARTA_HISTORY_DB_PATH: TMP_DB },
  });
  try {
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(Fs.readFileSync(outPath, 'utf8'));
    assert.equal(payload.schema_version, 2);
    assert.ok(Array.isArray(payload.incidents));
  } finally {
    try {
      Fs.unlinkSync(outPath);
    } catch {
      /* best effort */
    }
  }
});
