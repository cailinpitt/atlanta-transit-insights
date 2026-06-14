#!/usr/bin/env node
require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { loadShapes } = require('../../../src/marta/bus/shapes');
const { buildLineGeometry } = require('../../../src/marta/rail/lines');
const { buildLineSpeedmaps } = require('../../../src/marta/rail/speedmap');
const storage = require('../../../src/marta/storage');
const incidents = require('../../../src/marta/shared/incidents');
const { loginTrain, postWithImage } = require('../../../src/marta/shared/bluesky');
const { setup, writeDryRunAsset, runBin } = require('../../../src/marta/shared/runBin');
const { renderRailSpeedmap } = require('../../../src/marta/map/railSpeedmap');
const { buildSpeedmapPostText, buildSpeedmapAltText } = require('../../../src/marta/rail/post');

const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');
const WINDOW_MS = 60 * 60 * 1000;
const NUM_BINS = 30;
const MIN_COVERAGE = 0.3;

function bestMapForLine(maps, line) {
  const candidates = [...maps.values()].filter((m) => String(m.line) === String(line));
  candidates.sort(
    (a, b) => b.summary.covered / b.summary.bins - a.summary.covered / a.summary.bins,
  );
  return candidates[0] || null;
}

async function main() {
  setup();
  const gtfs = loadGtfs(GTFS_DIR);
  const shapes = loadShapes(GTFS_DIR);
  const lineGeom = buildLineGeometry(gtfs, shapes);
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - WINDOW_MS);
  const rows = storage.getRecentRailObservationsAll(startTime.getTime());
  if (rows.length === 0) {
    console.log('No recent rail observations in the window - is observe-rail running?');
    return;
  }

  const maps = buildLineSpeedmaps(rows, { lineGeom, numBins: NUM_BINS });
  const eligibleLines = [
    ...new Set(
      [...maps.values()]
        .filter((m) => m.summary.bins > 0 && m.summary.covered / m.summary.bins >= MIN_COVERAGE)
        .map((m) => String(m.line))
        .filter(Boolean),
    ),
  ].sort();
  const line = argv.line
    ? String(argv.line).toUpperCase()
    : incidents.leastRecentlyPostedSpeedmapRoute('rail', eligibleLines);
  if (!line) {
    console.log('No rail line has enough speed coverage to post a speedmap');
    return;
  }

  const map = bestMapForLine(maps, line);
  if (!map) {
    console.log(`No rail speedmap samples for ${line}`);
    return;
  }
  const coverage = map.summary.bins > 0 ? map.summary.covered / map.summary.bins : 0;
  if (coverage < MIN_COVERAGE) {
    console.log(
      `Sparse coverage for ${line}: ${map.summary.covered}/${map.summary.bins} bins (${(coverage * 100).toFixed(0)}%) - not posting`,
    );
    if (!argv['dry-run']) {
      incidents.recordSpeedmap({
        kind: 'rail',
        route: line,
        direction: map.direction,
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

  const geom = lineGeom.get(map.line);
  const callouts = incidents.speedmapCallouts({
    kind: 'rail',
    route: map.line,
    avgMph: map.summary.avg,
  });
  const image = await renderRailSpeedmap(geom, map.bins);
  const text = buildSpeedmapPostText(
    map.line,
    map.direction,
    map.summary,
    startTime,
    endTime,
    callouts,
  );
  const alt = buildSpeedmapAltText(map.line, map.direction, map.summary);

  if (argv['dry-run']) {
    const out = writeDryRunAsset(
      image,
      `rail-speedmap-${map.line}-${map.direction}-${Date.now()}.jpg`,
    );
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${out}`);
    return;
  }

  const agent = await loginTrain();
  const result = await postWithImage(agent, text, image, alt);
  const total =
    map.summary.red +
    map.summary.orange +
    map.summary.yellow +
    map.summary.purple +
    map.summary.green;
  incidents.recordSpeedmap({
    kind: 'rail',
    route: map.line,
    direction: map.direction,
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
