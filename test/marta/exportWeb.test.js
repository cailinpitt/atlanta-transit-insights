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

test('a lone bot detector does NOT attach to an official alert (CTA alignment)', () => {
  // A single gap/bunch/ghost is NOT in the alert pairing pool — only roundups +
  // route-silence disruptions are (see the roundup-merge test below). So a lone
  // same-line gap must NOT fold under the alert; the alert stays marta-only and
  // the gap surfaces nowhere on the site. This is what stops a stray 2-car bunch
  // from two hours earlier attaching to a later official alert.
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
  // Marta-only: the lone gap was not folded in.
  assert.deepEqual(incident.sources, ['marta']);
  assert.equal(incident.official_alert.id, 'alert-121');
  assert.equal(incident.detections.length, 0);
  assert.equal(incident.lifecycle.active, true);
  // The lone gap surfaces nowhere as its own incident.
  assert.equal(
    out.incidents.some((i) => (i.detections || []).some((d) => d.post_url === atUriToUrl(GAP_URI))),
    false,
  );
  // Official "delays" alert (effect SIGNIFICANT_DELAYS) → delay status.
  assert.equal(incident.status?.type, 'delay');
});

test('a roundup merges into a matching official alert, carrying its evidence', () => {
  // The CTA-aligned positive path: bot evidence reaches an alert only through a
  // multi-signal roundup. The roundup (and the raw detector it bundles) fold
  // under the official alert as one official+bot incident.
  seedAlert(
    {
      alertId: 'alert-220',
      mode: 'bus',
      routes: '220',
      headline: 'Route 220 delays',
      postUri: 'at://did:plc:alerts/app.bsky.feed.post/alert220',
    },
    NOW + 100 * 60_000,
  );
  incidents.recordRoundupAnchor({
    kind: 'bus',
    line: '220',
    postUri: 'at://did:plc:martaalerts/app.bsky.feed.post/roundup220',
    postCid: 'cid-roundup220',
    ts: NOW + 101 * 60_000,
    signals: ['gap', 'bunching'],
    bullets: [{ source: 'gap', detail: { ratio: 3.1 } }],
  });
  incidents.recordGap(
    {
      kind: 'bus',
      route: '220',
      direction: 'shape-b',
      gapFt: 30_000,
      gapMin: 40,
      expectedMin: 12,
      ratio: 3.1,
      nearStop: null,
      posted: true,
      postUri: 'at://did:plc:bus/app.bsky.feed.post/gap220',
    },
    NOW + 102 * 60_000,
  );

  const out = buildExport(storage.getDb(), NOW + 110 * 60_000);
  const incident = out.incidents.find((i) => i.official_alert?.id === 'alert-220');
  assert.ok(incident);
  assert.deepEqual(incident.sources, ['marta', 'bot']);
  // Roundup anchor + its evidence gap both fold under the alert.
  assert.deepEqual(
    incident.detections.map((d) => d.source),
    ['roundup', 'gap'],
  );
  // The roundup did not also stand alone.
  assert.equal(
    out.incidents.some((i) => i.id === 'roundup220'),
    false,
  );
  assert.equal(incident.status?.type, 'delay');
});

test('a roundup that cleared before the alert began is NOT merged (interval guard)', () => {
  // Onset proximity alone is not enough — a roundup whose own interval ended
  // well before the alert started must not attach (mirrors CTA's interval guard).
  const roundupTs = NOW + 200 * 60_000;
  incidents.recordRoundupAnchor({
    kind: 'bus',
    line: '230',
    postUri: 'at://did:plc:martaalerts/app.bsky.feed.post/roundup230',
    postCid: 'cid-roundup230',
    ts: roundupTs,
    signals: ['bunching'],
    bullets: [{ source: 'bunching', detail: {} }],
  });
  // Resolve the roundup ~5 min after it fired, well before the alert is seen.
  const r230 = incidents.listUnresolvedRoundupAnchors('bus').find((r) => r.line === '230');
  incidents.markRoundupResolved(r230.id, null, roundupTs + 5 * 60_000);
  // Alert begins ~90 min after the roundup cleared — inside the 2h proximity
  // window but with no interval overlap.
  seedAlert(
    {
      alertId: 'alert-230',
      mode: 'bus',
      routes: '230',
      headline: 'Route 230 delays',
      postUri: 'at://did:plc:alerts/app.bsky.feed.post/alert230',
    },
    roundupTs + 95 * 60_000,
  );

  const out = buildExport(storage.getDb(), roundupTs + 120 * 60_000);
  const incident = out.incidents.find((i) => i.official_alert?.id === 'alert-230');
  assert.ok(incident);
  // The stale roundup did not attach; the alert is marta-only.
  assert.deepEqual(incident.sources, ['marta']);
  // The roundup stands on its own instead.
  assert.ok(out.incidents.some((i) => i.id === 'roundup230'));
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

test('reconciliation resolves a detector folded (via roundup) under an official alert', () => {
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
  // The gap reaches the alert only as evidence of a roundup (CTA alignment).
  incidents.recordRoundupAnchor({
    kind: 'bus',
    line: '998',
    postUri: 'at://did:plc:martaalerts/app.bsky.feed.post/roundup998',
    postCid: 'cid-roundup998',
    ts: ts - 30_000,
    signals: ['gap'],
    bullets: [{ source: 'gap', detail: { ratio: 3.2 } }],
  });
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
  // A roundup whose signals include a gap is a delay incident.
  assert.equal(incident.status?.type, 'delay');
  assert.equal(
    out.incidents.some((row) => row.id === 'gap996'),
    false,
  );
});

test('status: a detour alert is classified as a detour (not a delay); a gapless roundup gets no status', () => {
  // Official alert whose nature is a detour (not delays), no paired gap.
  seedAlert(
    {
      alertId: 'alert-detour',
      mode: 'bus',
      routes: '55',
      headline: 'Route 55 detour',
      description: 'Route 55 is detouring around road construction.',
      effect: 'DETOUR',
      postUri: 'at://did:plc:alerts/app.bsky.feed.post/detour55',
    },
    NOW + 80 * 60_000,
  );
  // Roundup driven purely by bunching — a gapless bot incident.
  incidents.recordRoundupAnchor({
    kind: 'bus',
    line: '60',
    postUri: 'at://did:plc:martaalerts/app.bsky.feed.post/roundup60',
    postCid: 'cid-roundup60',
    ts: NOW + 80 * 60_000,
    signals: ['bunching'],
    bullets: [{ source: 'bunching', detail: {} }],
  });

  const out = buildExport(storage.getDb(), NOW + 85 * 60_000);
  const detour = out.incidents.find((i) => i.official_alert?.id === 'alert-detour');
  assert.ok(detour);
  // Producer-classified detour status — distinct from delay, drives the
  // website's blue "Detour" badge and collapsed Detours band.
  assert.equal(detour.status?.type, 'detour');
  const bunchRoundup = out.incidents.find((i) => i.id === 'roundup60');
  assert.ok(bunchRoundup);
  assert.equal(bunchRoundup.status, undefined);
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
  // Roundup carries the two gaps under the alert (CTA alignment).
  incidents.recordRoundupAnchor({
    kind: 'bus',
    line: '997',
    postUri: 'at://did:plc:martaalerts/app.bsky.feed.post/roundup997',
    postCid: 'cid-roundup997',
    ts: NOW + 59 * 60_000,
    signals: ['gap'],
    bullets: [{ source: 'gap', detail: { ratio: 4 } }],
  });
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

test('a roundup folds rail bunching and ghosts under a matching rail alert', () => {
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
  incidents.recordRoundupAnchor({
    kind: 'rail',
    line: 'BLUE',
    postUri: 'at://did:plc:martaalerts/app.bsky.feed.post/roundupblue',
    postCid: 'cid-roundupblue',
    ts: NOW + 21 * 60_000,
    signals: ['bunching', 'ghost'],
    bullets: [{ source: 'bunching', detail: {} }],
  });
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
  assert.deepEqual(rail.sources, ['marta', 'bot']);
  // Roundup anchor + its bunching/ghost evidence all fold under the rail alert.
  assert.deepEqual(rail.detections.map((det) => det.source).sort(), [
    'bunching',
    'ghost',
    'roundup',
  ]);
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

test('consolidates a churned alert + its later "all clear" into one incident', () => {
  // MARTA posts each update as a fresh alert_id; the delay and its "resumed"
  // follow-up ~3 min later must collapse into ONE incident with official_alerts[].
  const t0 = NOW + 300 * 60_000;
  seedAlert(
    {
      alertId: 'sc-delay',
      mode: 'streetcar',
      routes: 'ATLSC',
      headline: 'Streetcar delays',
      description: 'Heavy traffic delays in Streetcar service.',
      effect: null,
      postUri: 'at://did:plc:alerts/app.bsky.feed.post/scdelay',
    },
    t0,
  );
  // First alert resolves (drops from feed) ~20 min later.
  alerts.recordAlertResolved({ alertId: 'sc-delay', replyUri: null }, t0 + 20 * 60_000);
  // The "all clear" follow-up appears ~3 min after the first resolved.
  seedAlert(
    {
      alertId: 'sc-clear',
      mode: 'streetcar',
      routes: 'ATLSC',
      headline: 'Streetcar service alert',
      description: 'Update: Streetcars resumed normal schedule.',
      effect: null,
      postUri: 'at://did:plc:alerts/app.bsky.feed.post/scclear',
    },
    t0 + 23 * 60_000,
  );

  const out = buildExport(storage.getDb(), t0 + 60 * 60_000);
  const merged = out.incidents.filter(
    (i) => i.mode === 'streetcar' && (i.official_alerts || i.official_alert),
  );
  // Exactly one streetcar incident, anchored on the earliest (delay) post.
  const sc = merged.find((i) => i.id === 'scdelay');
  assert.ok(sc, 'merged incident keyed on the earliest alert rkey');
  assert.equal(sc.official_alerts.length, 2);
  assert.deepEqual(
    sc.official_alerts.map((a) => a.id),
    ['sc-delay', 'sc-clear'],
  );
  // The "all clear" did NOT stand up as its own incident.
  assert.equal(
    out.incidents.some((i) => i.id === 'scclear'),
    false,
  );
  // Lifecycle spans both.
  assert.equal(sc.lifecycle.first_seen_ts, t0);
});

test('does NOT consolidate two same-line alerts hours apart', () => {
  const t0 = NOW + 500 * 60_000;
  seedAlert(
    {
      alertId: 'gold-am',
      mode: 'rail',
      routes: 'GOLD',
      headline: 'Gold Line delays',
      postUri: 'at://did:plc:alerts/app.bsky.feed.post/goldam',
    },
    t0,
  );
  alerts.recordAlertResolved({ alertId: 'gold-am', replyUri: null }, t0 + 15 * 60_000);
  // A genuinely separate Gold disruption 3h later.
  seedAlert(
    {
      alertId: 'gold-pm',
      mode: 'rail',
      routes: 'GOLD',
      headline: 'Gold Line delays',
      postUri: 'at://did:plc:alerts/app.bsky.feed.post/goldpm',
    },
    t0 + 3 * 60 * 60_000,
  );

  const out = buildExport(storage.getDb(), t0 + 4 * 60 * 60_000);
  assert.ok(out.incidents.find((i) => i.id === 'goldam'));
  assert.ok(out.incidents.find((i) => i.id === 'goldpm'));
  // Neither carries the other as an official_alerts member.
  const am = out.incidents.find((i) => i.id === 'goldam');
  assert.ok(!am.official_alerts || am.official_alerts.length <= 1);
});

test('an agency-wide (no-routes) alert does NOT absorb bot obs', () => {
  // Empty alert routes match no bot obs (CTA alignment) — a system-wide notice
  // must not vacuum up every roundup in the window.
  const ts = NOW + 600 * 60_000;
  alerts.recordAlertSeen(
    {
      alertId: 'agency-wide',
      mode: 'general',
      routes: null,
      headline: 'System-wide service notice',
      description: 'MARTA is experiencing delays.',
      effect: 'SIGNIFICANT_DELAYS',
      postUri: 'at://did:plc:alerts/app.bsky.feed.post/agencywide',
    },
    ts,
  );
  incidents.recordRoundupAnchor({
    kind: 'bus',
    line: '700',
    postUri: 'at://did:plc:martaalerts/app.bsky.feed.post/roundup700',
    postCid: 'cid-roundup700',
    ts: ts + 60_000,
    signals: ['gap', 'bunching'],
    bullets: [{ source: 'gap', detail: { ratio: 3 } }],
  });

  const out = buildExport(storage.getDb(), ts + 10 * 60_000);
  const alert = out.incidents.find((i) => i.official_alert?.id === 'agency-wide');
  assert.ok(alert);
  assert.deepEqual(alert.sources, ['marta'], 'agency-wide alert stays marta-only');
  // The roundup stands on its own.
  assert.ok(out.incidents.some((i) => i.id === 'roundup700'));
});

test('incident routes union every alert version (a narrowed multi-line alert keeps all lines)', () => {
  const ts = NOW + 700 * 60_000;
  // First seen as a Red+Gold alert…
  alerts.recordAlertSeen(
    {
      alertId: 'multiline',
      mode: 'rail',
      routes: 'RED,GOLD',
      headline: 'Red and Gold Line delays',
      description: 'Delays on Red and Gold lines.',
      postUri: 'at://did:plc:alerts/app.bsky.feed.post/multiline',
    },
    ts,
  );
  // …then edited (narrowed) to just Red before resolving. routes is overwritten
  // last-write-wins, but the Gold chapter is preserved in alert_versions.
  alerts.recordAlertSeen(
    {
      alertId: 'multiline',
      mode: 'rail',
      routes: 'RED',
      headline: 'Red Line delays',
      description: 'Delays continuing on the Red line.',
    },
    ts + 5 * 60_000,
  );

  const out = buildExport(storage.getDb(), ts + 10 * 60_000);
  const inc = out.incidents.find((i) => i.official_alert?.id === 'multiline');
  assert.ok(inc);
  assert.deepEqual([...inc.routes].sort(), ['gold', 'red']);
});

test('a cold disruption back-dates incident onset from minutesSinceLastTrain', () => {
  const ts = NOW + 800 * 60_000;
  incidents.recordDisruption(
    {
      kind: 'rail',
      line: 'BLUE',
      direction: null,
      source: 'observed',
      posted: true,
      postUri: 'at://did:plc:rail/app.bsky.feed.post/coldblue',
      evidence: { minutesSinceLastTrain: 25, coldThresholdMin: 18 },
    },
    ts,
  );

  const out = buildExport(storage.getDb(), ts + 10 * 60_000);
  const inc = out.incidents.find(
    (i) =>
      i.id?.startsWith('coldblue') || (i.detections || []).some((d) => d.source === 'pulse-cold'),
  );
  assert.ok(inc);
  const onset = ts - 25 * 60_000;
  // Bot-only incident: first_seen tracks the post ts; the back-dated start is
  // carried separately as onset_ts.
  assert.equal(inc.lifecycle.first_seen_ts, ts);
  assert.equal(inc.lifecycle.onset_ts, onset, 'incident onset back-dated 25 min');
  const det = inc.detections[0];
  assert.equal(det.lifecycle.onset_ts, onset, 'detection onset surfaced');
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
