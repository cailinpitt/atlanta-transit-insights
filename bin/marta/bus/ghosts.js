#!/usr/bin/env node
require('../../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { ghostsFromObservations, MISSING_ABS_THRESHOLD } = require('../../../src/marta/bus/ghosts');
const storage = require('../../../src/marta/storage');
const incidents = require('../../../src/marta/shared/incidents');
const { loginBus, postText } = require('../../../src/marta/shared/bluesky');
const { setup, runBin } = require('../../../src/marta/shared/runBin');
const { buildRollupThread } = require('../../../src/shared/post');
const { formatGhostLine } = require('../../../src/marta/bus/ghostPost');

const Path = require('node:path');
const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');
const WINDOW_MS = 60 * 60 * 1000;

function routeTitleFor(gtfs, route) {
  const r = gtfs.routesByShortName.get(String(route));
  const long = r?.route_long_name;
  return long ? `Route ${route} (${long})` : `Route ${route}`;
}

async function main() {
  setup();
  const gtfs = loadGtfs(GTFS_DIR);
  const now = Date.now();
  const rows = storage.getRecentBusObservationsAll(now - WINDOW_MS);
  if (rows.length === 0) {
    console.log('No recent bus observations in the window - is observe-buses running?');
    return;
  }

  const events = ghostsFromObservations(rows, { gtfs, now });
  if (!argv['dry-run']) {
    const closed = incidents.reconcileGhostEvents({
      kind: 'bus',
      current: events.map((e) => ({ route: e.route, direction: e.direction || null })),
      now,
    });
    if (closed.length > 0) {
      console.log(`Resolved ${closed.length} open bus ghost event(s)`);
    }
  }
  if (events.length === 0) {
    console.log('No ghost bus events meet the threshold, staying silent');
    return;
  }

  for (const e of events) {
    incidents.recordMetaSignal({
      kind: 'bus',
      line: e.route,
      direction: e.direction || null,
      source: 'ghost',
      severity: 1,
      detail: { observed: e.observedActive, expected: e.expectedActive, missing: e.missing },
      posted: !argv['dry-run'],
    });
    console.log(
      `  Route ${e.route} ${e.direction}: ${e.observedActive.toFixed(1)} observed vs ${e.expectedActive.toFixed(1)} expected (${e.missing.toFixed(1)} missing across ${e.snapshots} snapshots)`,
    );
  }

  const lines = events.map((e) => formatGhostLine(e, routeTitleFor(gtfs, e.route)));
  const posts = buildRollupThread('👻 Ghost buses, past hour', lines);
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

  const agent = await loginBus();
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
        kind: 'bus',
        route: e.route,
        direction: e.direction || null,
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

module.exports = { MISSING_ABS_THRESHOLD };

runBin(main);
