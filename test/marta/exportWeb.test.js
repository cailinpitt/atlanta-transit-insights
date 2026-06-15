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

test('keeps nonmatching route detections as bot-only incidents', () => {
  const ts = NOW + 4 * 60_000;
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
    ts,
  );

  const out = buildExport(storage.getDb(), NOW + 10 * 60_000);
  const botOnly = out.incidents.find((incident) => incident.id === 'gap999');
  assert.ok(botOnly);
  assert.equal(botOnly.official_alert, null);
  assert.deepEqual(botOnly.routes, ['999']);
  assert.equal(botOnly.detections[0].source, 'gap');
  assert.equal(botOnly.lifecycle.active, true);
  assert.equal(botOnly.lifecycle.resolved_ts, null);
});

test('ages stale bot-only detections out of active status', () => {
  const ts = NOW - 2 * 60 * 60_000;
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
      postUri: 'at://did:plc:bus/app.bsky.feed.post/oldgap',
    },
    ts,
  );

  const out = buildExport(storage.getDb(), NOW);
  const botOnly = out.incidents.find((incident) => incident.id === 'oldgap');
  assert.ok(botOnly);
  assert.equal(botOnly.lifecycle.active, false);
  assert.equal(botOnly.lifecycle.resolved_ts, ts + 45 * 60_000);
  assert.equal(botOnly.detections[0].lifecycle.active, false);
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
  assert.deepEqual(rail.detections.map((det) => det.source).sort(), ['bunching', 'ghost']);
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
