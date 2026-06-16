#!/usr/bin/env node
require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { loadShapes } = require('../../../src/marta/bus/shapes');
const { buildLineGeometry } = require('../../../src/marta/rail/lines');
const { buildLineTermini, terminusFor } = require('../../../src/marta/rail/termini');
const { buildLineSpeedmaps } = require('../../../src/marta/rail/speedmap');
const {
  buildStreetcarGeometry,
  buildStreetcarSpeedmaps,
  colorForStreetcarSpeed,
} = require('../../../src/marta/streetcar/speedmap');
const { STREETCAR_LINE } = require('../../../src/marta/streetcar/api');
const storage = require('../../../src/marta/storage');
const incidents = require('../../../src/marta/shared/incidents');
const { loginTrain, postWithImage } = require('../../../src/marta/shared/bluesky');
const { setup, writeDryRunAsset, runBin } = require('../../../src/marta/shared/runBin');
const { renderRailSpeedmap } = require('../../../src/marta/map/railSpeedmap');
const { buildSpeedmapPostText, buildSpeedmapAltText } = require('../../../src/marta/rail/post');
const {
  buildStreetcarSpeedmapPostText,
  buildStreetcarSpeedmapAltText,
} = require('../../../src/marta/streetcar/post');

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

function pctSummary(summary) {
  const total = summary.red + summary.orange + summary.yellow + summary.purple + summary.green;
  return {
    pctRed: total ? summary.red / total : 0,
    pctOrange: total ? summary.orange / total : 0,
    pctYellow: total ? summary.yellow / total : 0,
    pctGreen: total ? summary.green / total : 0,
  };
}

// Per-line rendering + post-text specifics. The streetcar is just another line
// in the pool, so it shares the picker, the coverage gate, the renderer, and the
// `kind: 'rail'` speedmap_runs history (its rotation slot sits alongside the four
// heavy lines) — it only diverges in geometry source, color bands, and wording.
function makeStyles({ lineGeom, termini, scGeomByLine, startTime, endTime }) {
  return {
    rail: {
      geomFor: (m) => lineGeom.get(m.line),
      renderOpts: {},
      build: (m, callouts) => {
        const terminus = terminusFor(termini, m.line, m.direction);
        return {
          text: buildSpeedmapPostText(
            m.line,
            m.direction,
            m.summary,
            startTime,
            endTime,
            callouts,
            terminus,
          ),
          alt: buildSpeedmapAltText(m.line, m.direction, m.summary, terminus),
          dryName: `rail-speedmap-${m.line}-${m.direction}-${Date.now()}.jpg`,
        };
      },
    },
    streetcar: {
      geomFor: () => scGeomByLine.get(STREETCAR_LINE),
      renderOpts: { colorFn: colorForStreetcarSpeed },
      build: (m, callouts) => ({
        text: buildStreetcarSpeedmapPostText(m.summary, startTime, endTime, callouts),
        alt: buildStreetcarSpeedmapAltText(m.summary),
        dryName: `streetcar-speedmap-${m.direction}-${Date.now()}.jpg`,
      }),
    },
  };
}

async function main() {
  setup();
  const gtfs = loadGtfs(GTFS_DIR);
  const shapes = loadShapes(GTFS_DIR);
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - WINDOW_MS);
  const minCoverage = argv['min-coverage'] != null ? Number(argv['min-coverage']) : MIN_COVERAGE;

  const lineGeom = buildLineGeometry(gtfs, shapes);
  const termini = buildLineTermini(gtfs);
  const scGeomByLine = buildStreetcarGeometry(gtfs, shapes);

  // One candidate pool: the four heavy lines + the streetcar ("SC"), each keyed
  // "<line>/<direction>". The streetcar rides the same rotation as the rest.
  const maps = new Map([
    ...buildLineSpeedmaps(storage.getRecentRailObservationsAll(startTime.getTime()), {
      lineGeom,
      numBins: NUM_BINS,
    }),
    ...buildStreetcarSpeedmaps(storage.getRecentStreetcarObservations(startTime.getTime()), {
      geom: scGeomByLine,
      numBins: NUM_BINS,
    }),
  ]);
  if (maps.size === 0) {
    console.log(
      'No recent rail or streetcar observations in the window - is observe-rail running?',
    );
    return;
  }

  const eligibleLines = [
    ...new Set(
      [...maps.values()]
        .filter((m) => m.summary.bins > 0 && m.summary.covered / m.summary.bins >= minCoverage)
        .map((m) => String(m.line))
        .filter(Boolean),
    ),
  ].sort();
  // `--line RED|GOLD|BLUE|GREEN|SC` forces one; otherwise rotate to whichever
  // eligible line (streetcar included) has gone longest without a speedmap.
  const line = argv.line
    ? String(argv.line).toUpperCase()
    : incidents.leastRecentlyPostedSpeedmapRoute('rail', eligibleLines);
  if (!line) {
    console.log('No rail or streetcar line has enough speed coverage to post a speedmap');
    return;
  }

  const map = bestMapForLine(maps, line);
  if (!map) {
    console.log(`No speedmap samples for ${line}`);
    return;
  }

  const style = line === STREETCAR_LINE ? 'streetcar' : 'rail';
  const styles = makeStyles({ lineGeom, termini, scGeomByLine, startTime, endTime })[style];

  const coverage = map.summary.bins > 0 ? map.summary.covered / map.summary.bins : 0;
  if (coverage < minCoverage) {
    console.log(
      `Sparse coverage for ${line}: ${map.summary.covered}/${map.summary.bins} bins (${(coverage * 100).toFixed(0)}%) - not posting (raise with --min-coverage)`,
    );
    if (!argv['dry-run']) {
      incidents.recordSpeedmap({
        kind: 'rail',
        route: map.line,
        direction: map.direction,
        avgMph: null,
        binSpeeds: [],
        posted: false,
      });
    }
    return;
  }

  const callouts = incidents.speedmapCallouts({
    kind: 'rail',
    route: map.line,
    avgMph: map.summary.avg,
  });
  const image = await renderRailSpeedmap(styles.geomFor(map), map.bins, styles.renderOpts);
  const { text, alt, dryName } = styles.build(map, callouts);

  if (argv['dry-run']) {
    const out = writeDryRunAsset(image, dryName);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${out}`);
    return;
  }

  const agent = await loginTrain();
  const result = await postWithImage(agent, text, image, alt);
  incidents.recordSpeedmap({
    kind: 'rail',
    route: map.line,
    direction: map.direction,
    avgMph: map.summary.avg,
    ...pctSummary(map.summary),
    binSpeeds: map.bins,
    posted: true,
    postUri: result.uri,
  });
  console.log(`Posted: ${result.url}`);
}

runBin(main);
