#!/usr/bin/env node
require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { loadShapes } = require('../../../src/marta/bus/shapes');
const { buildRouteSpeedmaps } = require('../../../src/marta/bus/speedmap');
const storage = require('../../../src/marta/storage');
const incidents = require('../../../src/marta/shared/incidents');
const { loginBus, postWithImage } = require('../../../src/marta/shared/bluesky');
const { setup, writeDryRunAsset, runBin } = require('../../../src/marta/shared/runBin');
const { renderBusSpeedmap } = require('../../../src/marta/map/busSpeedmap');
const { buildPostText, buildAltText } = require('../../../src/marta/bus/speedmapPost');

const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');
const WINDOW_MS = 60 * 60 * 1000;
const NUM_BINS = 40;
const MIN_COVERAGE = 0.3;

function routeTitleFor(gtfs, route) {
  const r = gtfs.routesByShortName.get(String(route));
  const long = r?.route_long_name;
  return long ? `Route ${route} (${long})` : `Route ${route}`;
}

function bestMapForRoute(maps, route) {
  const candidates = [...maps.values()].filter((m) => String(m.route) === String(route));
  candidates.sort(
    (a, b) => b.summary.covered / b.summary.bins - a.summary.covered / a.summary.bins,
  );
  return candidates[0] || null;
}

async function main() {
  setup();
  const gtfs = loadGtfs(GTFS_DIR);
  const shapes = loadShapes(GTFS_DIR);
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - WINDOW_MS);
  const rows = storage.getRecentBusObservationsAll(startTime.getTime());
  if (rows.length === 0) {
    console.log('No recent bus observations in the window - is observe-buses running?');
    return;
  }

  const maps = buildRouteSpeedmaps(rows, { gtfs, shapes, numBins: NUM_BINS });
  const eligibleRoutes = [
    ...new Set(
      [...maps.values()]
        .filter((m) => m.summary.bins > 0 && m.summary.covered / m.summary.bins >= MIN_COVERAGE)
        .map((m) => String(m.route))
        .filter(Boolean),
    ),
  ].sort((a, b) => Number(a) - Number(b));
  const route = argv.route
    ? String(argv.route)
    : incidents.leastRecentlyPostedSpeedmapRoute('bus', eligibleRoutes);
  if (!route) {
    console.log('No route has enough speed-bearing coverage to post a speedmap');
    return;
  }

  const map = bestMapForRoute(maps, route);
  if (!map) {
    console.log(`No speedmap samples for route ${route}`);
    return;
  }
  const coverage = map.summary.bins > 0 ? map.summary.covered / map.summary.bins : 0;
  if (coverage < MIN_COVERAGE) {
    console.log(
      `Sparse coverage for route ${route}: ${map.summary.covered}/${map.summary.bins} bins (${(coverage * 100).toFixed(0)}%) - not posting`,
    );
    if (!argv['dry-run']) {
      incidents.recordSpeedmap({
        kind: 'bus',
        route,
        direction: map.shapeId,
        avgMph: null,
        pctRed: 0,
        pctOrange: 0,
        pctYellow: 0,
        pctGreen: 0,
        binSpeeds: [],
        posted: false,
      });
    }
    return;
  }

  const shape = shapes.get(map.shapeId);
  const routeTitle = routeTitleFor(gtfs, route);
  const sampleTrip = [...gtfs.tripsById.values()].find((t) => t.shape_id === map.shapeId);
  const direction = sampleTrip?.trip_headsign || null;
  const callouts = incidents.speedmapCallouts({ kind: 'bus', route, avgMph: map.summary.avg });
  const image = await renderBusSpeedmap(shape, map.bins);
  const text = buildPostText(routeTitle, direction, map.summary, startTime, endTime, callouts);
  const alt = buildAltText(routeTitle, direction, map.summary);

  if (argv['dry-run']) {
    const out = writeDryRunAsset(image, `speedmap-${route}-${map.shapeId}-${Date.now()}.jpg`);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${out}`);
    return;
  }

  const agent = await loginBus();
  const result = await postWithImage(agent, text, image, alt);
  const total = map.summary.red + map.summary.orange + map.summary.yellow + map.summary.green;
  incidents.recordSpeedmap({
    kind: 'bus',
    route,
    direction: map.shapeId,
    avgMph: map.summary.avg,
    pctRed: total ? map.summary.red / total : 0,
    pctOrange: total ? map.summary.orange / total : 0,
    pctYellow: total ? map.summary.yellow / total : 0,
    pctGreen: total ? map.summary.green / total : 0,
    binSpeeds: map.bins,
    posted: true,
    postUri: result.uri,
  });
  console.log(`Posted: ${result.url}`);
}

runBin(main);
