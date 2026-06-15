#!/usr/bin/env node
require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { loadShapes } = require('../../../src/marta/bus/shapes');
const { buildLineGeometry } = require('../../../src/marta/rail/lines');
const { railGhostsFromObservations } = require('../../../src/marta/rail/ghosts');
const { MISSING_ABS_THRESHOLD } = require('../../../src/marta/bus/ghosts');
const storage = require('../../../src/marta/storage');
const incidents = require('../../../src/marta/shared/incidents');
const { loginTrain, postText } = require('../../../src/marta/shared/bluesky');
const { setup, runBin } = require('../../../src/marta/shared/runBin');
const { buildRollupThread } = require('../../../src/shared/post');
const { formatGhostLine } = require('../../../src/marta/rail/post');

const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');
const WINDOW_MS = 60 * 60 * 1000;

async function main() {
  setup();
  const gtfs = loadGtfs(GTFS_DIR);
  const shapes = loadShapes(GTFS_DIR);
  const lineGeom = buildLineGeometry(gtfs, shapes);
  const now = Date.now();
  const rows = storage.getRecentRailObservationsAll(now - WINDOW_MS);
  if (rows.length === 0) {
    console.log('No recent rail observations in the window - is observe-rail running?');
    return;
  }

  const drops = [];
  const events = railGhostsFromObservations(rows, {
    lines: [...lineGeom.keys()].sort(),
    now,
    onDrop: (d) => drops.push(d),
  });
  if (!argv['dry-run']) {
    const closed = incidents.reconcileGhostEvents({
      kind: 'rail',
      current: events.map((e) => ({ route: e.route, direction: null })),
      now,
    });
    if (closed.length > 0) console.log(`Resolved ${closed.length} open rail ghost event(s)`);

    // Sub-threshold near-misses feed the roundup correlation (posted=0), matching
    // CTA's bin/train/ghosts.js. Rail collapses direction, so direction stays null.
    for (const d of drops) {
      if (
        d.reason === 'below_abs_threshold' &&
        d.route &&
        d.missing != null &&
        d.missing >= MISSING_ABS_THRESHOLD * 0.5
      ) {
        incidents.recordMetaSignal({
          kind: 'rail',
          line: d.route,
          direction: null,
          source: 'ghost',
          severity: Math.min(1, d.missing / MISSING_ABS_THRESHOLD),
          detail: { observed: d.observedActive, expected: d.expectedActive, missing: d.missing },
          posted: false,
        });
      }
    }
  }
  if (events.length === 0) {
    console.log('No ghost train events meet the threshold, staying silent');
    return;
  }

  for (const e of events) {
    incidents.recordMetaSignal({
      kind: 'rail',
      line: e.route,
      direction: null,
      source: 'ghost',
      severity: 1,
      detail: { observed: e.observedActive, expected: e.expectedActive, missing: e.missing },
      posted: !argv['dry-run'],
    });
    console.log(
      `  ${e.route}: ${e.observedActive.toFixed(1)} observed vs ${e.expectedActive.toFixed(1)} expected (${e.missing.toFixed(1)} missing across ${e.snapshots} snapshots)`,
    );
  }

  const lines = events.map((e) => formatGhostLine(e));
  const posts = buildRollupThread('👻 Ghost trains, past hour', lines);
  if (!posts || posts.length === 0) {
    console.log('No lines fit under the post limit, skipping');
    return;
  }

  if (argv['dry-run'] || process.env.GHOSTS_DRY_RUN) {
    for (let i = 0; i < posts.length; i++) {
      console.log(`\n--- DRY RUN post ${i + 1}/${posts.length} ---\n${posts[i].text}`);
    }
    return;
  }

  const agent = await loginTrain();
  let root = null;
  let parent = null;
  let eventCursor = 0;
  const ts = Date.now();
  for (let i = 0; i < posts.length; i++) {
    const replyRef = root && parent ? { root, parent } : null;
    const result = await postText(agent, posts[i].text, replyRef);
    console.log(`Posted ${i + 1}/${posts.length}: ${result.url}`);
    if (!root) root = { uri: result.uri, cid: result.cid };
    parent = { uri: result.uri, cid: result.cid };

    const slice = events.slice(eventCursor, eventCursor + posts[i].lineCount);
    for (const e of slice) {
      incidents.recordGhostEvent({
        kind: 'rail',
        route: e.route,
        direction: null,
        observed: e.observedActive,
        expected: e.expectedActive,
        missing: e.missing,
        postUri: result.uri,
        ts,
      });
    }
    eventCursor += posts[i].lineCount;
  }
}

runBin(main);
