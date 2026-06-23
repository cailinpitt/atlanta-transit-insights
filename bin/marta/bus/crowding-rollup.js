#!/usr/bin/env node
// Bus crowding rollup (martabusinsights). A "most crowded routes, past hour"
// digest from the GTFS-rt occupancy field — the cross-route companion to the
// single-route crowding map. Posts as a threaded rollup, fire-and-forget, with a
// cooldown so it self-limits. Stays silent unless several routes are crowded.
require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { summarizeRouteCrowding } = require('../../../src/marta/bus/crowding');
const storage = require('../../../src/marta/storage');
const { acquireCooldown } = require('../../../src/marta/shared/state');
const { loginBus, postText } = require('../../../src/marta/shared/bluesky');
const { setup, runBin } = require('../../../src/marta/shared/runBin');
const { buildRollupThread } = require('../../../src/shared/post');
const { formatCrowdingRollupLine } = require('../../../src/marta/bus/crowdingPost');

const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');
const WINDOW_MS = 60 * 60 * 1000;
// A route qualifies for the digest when, over enough sightings, a real share of
// them were standing-room-or-fuller. The digest only posts when several routes
// clear the bar — a single crowded route is the map's job, not a "digest."
const MIN_SAMPLES = 15;
const MIN_PCT_CROWDED = 0.25;
const MIN_CROWDED_COUNT = 3;
const MIN_ROUTES = 2;
const MAX_ROUTES = 10;
const COOLDOWN_MS = 3 * 60 * 60 * 1000;

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

  const qualifying = summarizeRouteCrowding(rows, { gtfs })
    .filter(
      (r) =>
        r.total >= MIN_SAMPLES && r.pctCrowded >= MIN_PCT_CROWDED && r.crowded >= MIN_CROWDED_COUNT,
    )
    .slice(0, MAX_ROUTES);

  if (qualifying.length < MIN_ROUTES) {
    console.log(
      `Only ${qualifying.length} route(s) crowded above threshold (<${MIN_ROUTES}), staying silent`,
    );
    return;
  }

  const lines = qualifying.map((r) => formatCrowdingRollupLine(r, routeTitleFor(gtfs, r.route)));
  const posts = buildRollupThread('🧍 Most crowded MARTA buses, past hour', lines);
  if (!posts || posts.length === 0) {
    console.log('No lines fit under the post limit, skipping');
    return;
  }

  if (argv['dry-run']) {
    for (let i = 0; i < posts.length; i++) {
      console.log(`\n--- DRY RUN post ${i + 1}/${posts.length} ---\n${posts[i].text}`);
    }
    return;
  }

  if (!acquireCooldown('crowding_rollup_bus', now, COOLDOWN_MS)) {
    console.log('crowding-rollup: cooldown active, skipping');
    return;
  }

  const agent = await loginBus();
  let root = null;
  let parent = null;
  for (let i = 0; i < posts.length; i++) {
    const replyRef = root && parent ? { root, parent } : null;
    const result = await postText(agent, posts[i].text, replyRef);
    console.log(`Posted ${i + 1}/${posts.length}: ${result.url}`);
    if (!root) root = { uri: result.uri, cid: result.cid };
    parent = { uri: result.uri, cid: result.cid };
  }
}

module.exports = { main };

if (require.main === module) runBin(main);
