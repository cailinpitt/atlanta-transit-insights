#!/usr/bin/env node
// Bus crowding map (martabusinsights). Picks the MOST crowded eligible route over
// the last hour and posts its shape color-coded by how full buses were along it.
// Occupancy analog of the bus speedmap; a per-route cooldown keeps a chronically
// packed route from dominating every run so other routes still surface.
require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { loadShapes } = require('../../../src/marta/bus/shapes');
const { buildRouteCrowdingMaps, crowdedBinFraction } = require('../../../src/marta/bus/crowding');
const storage = require('../../../src/marta/storage');
const { acquireCooldown } = require('../../../src/marta/shared/state');
const { loginBus, postWithImage } = require('../../../src/marta/shared/bluesky');
const { setup, writeDryRunAsset, runBin } = require('../../../src/marta/shared/runBin');
const { renderBusCrowdingMap } = require('../../../src/marta/map/busCrowding');
const { buildMapPostText, buildMapAltText } = require('../../../src/marta/bus/crowdingPost');

const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');
const WINDOW_MS = 60 * 60 * 1000;
const NUM_BINS = 40;
const MIN_COVERAGE = 0.3;
// Only post a route that's genuinely crowded: at least this share of its mapped
// (covered) segments standing-room-or-fuller, over enough samples to trust.
const MIN_CROWDED_FRACTION = 0.15;
const MIN_SAMPLES = 20;
// A featured route is rested this long so the rotation surfaces other routes
// rather than re-posting the same chronically-packed trunk every hour.
const ROUTE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function routeTitleFor(gtfs, route) {
  const r = gtfs.routesByShortName.get(String(route));
  const long = r?.route_long_name;
  return long ? `Route ${route} (${long})` : `Route ${route}`;
}

// Per route, the most-crowded shape with enough coverage + samples. Returns
// Map<route, map>. Routes with no qualifying shape are omitted.
function bestCrowdedMapByRoute(maps) {
  const byRoute = new Map();
  for (const m of maps.values()) {
    if (!m.route) continue;
    if (m.sampleCount < MIN_SAMPLES) continue;
    if (!(m.summary.bins > 0) || m.summary.covered / m.summary.bins < MIN_COVERAGE) continue;
    const frac = crowdedBinFraction(m.summary);
    const cur = byRoute.get(String(m.route));
    if (!cur || frac > crowdedBinFraction(cur.summary)) byRoute.set(String(m.route), m);
  }
  return byRoute;
}

async function main() {
  setup();
  const gtfs = loadGtfs(GTFS_DIR);
  const shapes = loadShapes(GTFS_DIR);
  const now = Date.now();
  const endTime = new Date(now);
  const startTime = new Date(now - WINDOW_MS);
  const rows = storage.getRecentBusObservationsAll(startTime.getTime());
  if (rows.length === 0) {
    console.log('No recent bus observations in the window - is observe-buses running?');
    return;
  }

  const maps = buildRouteCrowdingMaps(rows, { gtfs, shapes, numBins: NUM_BINS });
  const byRoute = bestCrowdedMapByRoute(maps);
  // Most crowded first; the explicit --route flag overrides selection for testing.
  const ranked = [...byRoute.entries()]
    .filter(([, m]) => crowdedBinFraction(m.summary) >= MIN_CROWDED_FRACTION)
    .sort((a, b) => crowdedBinFraction(b[1].summary) - crowdedBinFraction(a[1].summary));

  let chosen = null;
  if (argv.route) {
    chosen = byRoute.get(String(argv.route)) || null;
    if (!chosen) {
      console.log(`Route ${argv.route} has no eligible crowding map in the window`);
      return;
    }
  } else {
    // Walk most-crowded first, skipping routes still resting under their cooldown.
    for (const [route, map] of ranked) {
      if (argv['dry-run'] || acquireCooldown(`crowding_map_bus_${route}`, now, ROUTE_COOLDOWN_MS)) {
        chosen = map;
        break;
      }
      console.log(`crowding-map: route ${route} on cooldown, skipping`);
    }
  }
  if (!chosen) {
    console.log('No bus route is crowded enough (or all on cooldown) to post a crowding map');
    return;
  }

  const route = String(chosen.route);
  const shape = shapes.get(chosen.shapeId);
  const routeTitle = routeTitleFor(gtfs, route);
  const sampleTrip = [...gtfs.tripsById.values()].find((t) => t.shape_id === chosen.shapeId);
  const direction = sampleTrip?.trip_headsign || null;
  const image = await renderBusCrowdingMap(shape, chosen.bins);
  const text = buildMapPostText(routeTitle, direction, chosen.summary, startTime, endTime);
  const alt = buildMapAltText(routeTitle, direction, chosen.summary);

  if (argv['dry-run']) {
    const out = writeDryRunAsset(image, `crowding-${route}-${chosen.shapeId}-${Date.now()}.jpg`);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${out}`);
    return;
  }

  const agent = await loginBus();
  const result = await postWithImage(agent, text, image, alt);
  console.log(`Posted crowding map for route ${route}: ${result.url}`);
}

module.exports = { bestCrowdedMapByRoute, MIN_CROWDED_FRACTION, MIN_COVERAGE };

if (require.main === module) runBin(main);
