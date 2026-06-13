#!/usr/bin/env node
// Metra line speedmap — corridor colored by how fast trains are actually moving.
// Posts to the Metra analytics account. Metra analog of bin/train/speedmap.js,
// but reads recorded positions from the observations table (observeMetra
// densifies it at 30s) instead of polling the feed live for an hour, and uses
// the GTFS trip_id → schedule index for direction rather than a CTA trDr code.
//
// v1 renders the line's single longest GTFS shape as the corridor (see
// src/metra/speedmap.js#buildLineCorridor); branch coverage is a later refinement.

require('../../src/shared/env');

const Path = require('node:path');
const Fs = require('node:fs');
const argv = require('minimist')(process.argv.slice(2));

const { ALL_LINES, LINE_NAMES, lineLabel } = require('../../src/metra/lines');
const {
  METRA_THRESHOLDS,
  buildLineCorridor,
  computeMetraSamples,
  directionLabel,
} = require('../../src/metra/speedmap');
const { binSegments, summarize } = require('../../src/bus/speedmap');
const { renderMetraSpeedmap } = require('../../src/map/metra/speedmap');
const { getRecentMetraPositions } = require('../../src/shared/observations');
const { loginMetra, postWithImage } = require('../../src/metra/bluesky');
const history = require('../../src/shared/history');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const { formatTimeCT } = require('../../src/shared/format');
const metraLines = require('../../src/metra/data/metraLines.json');

const DRY_RUN = process.env.METRA_DRY_RUN === '1' || argv['dry-run'];
// 1 mi/bin (vs 0.5 for CTA): commuter-rail stations are ~1–3 mi apart, and the
// long Metra corridors (up to 63 mi) would otherwise produce so many bins the
// Mapbox static-map URL exceeds its length limit. MAX_BINS caps the longest
// lines for the same reason — see src/metra/speedmap.js#decimatePolyline.
const FT_PER_BIN = 5280;
const MIN_BINS = 8;
const MAX_BINS = 40;
const DEFAULT_DURATION_MIN = 60;
const MIN_COVERAGE = 0.3;

// Load the schedule index lazily; tolerate its absence (gitignored, regenerated
// by fetch-metra-gtfs). Without it directions resolve to 'unknown' and the map
// renders one combined ribbon rather than failing.
function loadTripIndex() {
  try {
    const p = Path.join(__dirname, '..', '..', 'data', 'metra-gtfs', 'index.json');
    return JSON.parse(Fs.readFileSync(p, 'utf8')).trips || {};
  } catch (_e) {
    console.warn('metra speedmap: schedule index missing — directions will be "unknown"');
    return {};
  }
}

function formatAvg(summary) {
  return summary.avg == null ? 'n/a' : `${summary.avg.toFixed(1)} mph`;
}

function buildPostText(line, dirSummaries, startTime, endTime, callouts) {
  const name = LINE_NAMES[line] || line;
  const window = `${formatTimeCT(startTime)}–${formatTimeCT(endTime)} CT`;
  const body = dirSummaries
    .map(({ label, summary }) => `${label}: ${formatAvg(summary)}`)
    .join(' · ');
  const head = `🚦 Metra ${name} speedmap\n${window}\n${body}`;
  const tail = history.formatCallouts(callouts);
  return (
    `${tail ? `${head}\n${tail}\n\n` : `${head}\n\n`}` +
    '🟥 under 25 mph · 🟧 25–40 · 🟨 40–55 · 🟪 55–70 · 🟩 70+ · ⬜ no data'
  );
}

function buildAltText(line, dirSummaries, durationMin) {
  const name = LINE_NAMES[line] || line;
  const dirs = dirSummaries
    .map(({ label, summary }) => `${label} average ${formatAvg(summary)}`)
    .join('; ');
  return (
    `Speedmap of the Metra ${name} line over a ${durationMin}-minute window, colored by average ` +
    `train speed along the corridor. ${dirs}. Red indicates under 25 mph, orange 25–40, yellow ` +
    '40–55, purple 55–70, green 70 and above, gray no data.'
  );
}

async function main() {
  setup();
  const line = argv.line || history.leastRecentlyPostedSpeedmapRoute('metra', ALL_LINES);
  const durationMin = argv.duration ? Number(argv.duration) : DEFAULT_DURATION_MIN;
  const durationMs = durationMin * 60 * 1000;

  if (!LINE_NAMES[line]) {
    console.error(`Unknown Metra line: ${line}`);
    process.exit(1);
  }

  const corridor = buildLineCorridor(metraLines, line);
  if (!corridor) {
    console.error(`No polyline geometry for Metra ${lineLabel(line)}`);
    process.exit(1);
  }

  const tripIndex = loadTripIndex();
  const startTime = new Date(Date.now() - durationMs);
  const endTime = new Date();
  const rows = getRecentMetraPositions(startTime.getTime()).filter((r) => r.route === line);
  console.log(
    `Metra speedmap ${lineLabel(line)}: ${rows.length} positions over ${durationMin}min, corridor ${(corridor.totalFt / 5280).toFixed(1)} mi`,
  );

  const { byDir, stats } = computeMetraSamples(rows, corridor, tripIndex);
  if (stats.offLine || stats.stationary || stats.dropped || stats.snapJump) {
    console.log(
      `filter: ${stats.offLine} off-line, ${stats.stationary} stationary, ${stats.dropped} out-of-range, ${stats.snapJump} snap-jump`,
    );
  }

  const numBins = Math.min(MAX_BINS, Math.max(MIN_BINS, Math.round(corridor.totalFt / FT_PER_BIN)));
  const binSpeedsByDir = {};
  const dirSummaries = [];
  // Sort directions so the inbound ribbon is consistent run-to-run (1 then 0).
  for (const dir of [...byDir.keys()].sort()) {
    const samples = byDir.get(dir);
    binSpeedsByDir[dir] = binSegments(samples, corridor.totalFt, numBins);
    const summary = summarize(binSpeedsByDir[dir], METRA_THRESHOLDS);
    const label = byDir.size === 1 && dir === 'unknown' ? 'Combined' : directionLabel(dir);
    console.log(
      `  ${label} (dir ${dir}): ${samples.length} samples · avg ${summary.avg?.toFixed(1)} mph`,
    );
    dirSummaries.push({ dir, label, summary, numBins });
  }

  if (dirSummaries.length === 0 || dirSummaries.every((d) => d.summary.avg == null)) {
    console.log(`No Metra samples for ${lineLabel(line)} during the window — not posting`);
    if (!DRY_RUN) recordEmpty(line);
    return;
  }

  // Sparse coverage → mostly-grey map isn't informative.
  const totalBins = dirSummaries.reduce((a, d) => a + d.numBins, 0);
  const validBins = dirSummaries.reduce((a, d) => {
    const s = d.summary;
    return a + s.red + s.orange + s.yellow + (s.purple || 0) + s.green;
  }, 0);
  const coverage = totalBins > 0 ? validBins / totalBins : 0;
  if (coverage < MIN_COVERAGE) {
    console.log(
      `Sparse coverage for ${lineLabel(line)}: ${validBins}/${totalBins} bins (${(coverage * 100).toFixed(0)}%) — not posting`,
    );
    if (!DRY_RUN) recordEmpty(line);
    return;
  }

  const dirAvgs = dirSummaries.map((d) => d.summary.avg).filter((v) => v != null);
  const lineAvgMph = dirAvgs.length ? dirAvgs.reduce((a, v) => a + v, 0) / dirAvgs.length : null;
  const callouts = history.speedmapCallouts({ kind: 'metra', route: line, avgMph: lineAvgMph });
  if (callouts.length) console.log(`Callouts: ${callouts.join(' · ')}`);

  const branchData = [{ points: corridor.points, cumDist: corridor.cumDist, binSpeedsByDir }];
  const image = await renderMetraSpeedmap(branchData);
  const text = buildPostText(line, dirSummaries, startTime, endTime, callouts);
  const alt = buildAltText(line, dirSummaries, durationMin);

  if (DRY_RUN) {
    const outPath = writeDryRunAsset(
      image,
      `metra-speedmap-${line.toLowerCase()}-${Date.now()}.jpg`,
    );
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    return;
  }

  const agent = await loginMetra();
  const result = await postWithImage(agent, text, image, alt);
  const totals = dirSummaries.reduce(
    (acc, { summary }) => {
      acc.red += summary.red;
      acc.orange += summary.orange;
      acc.yellow += summary.yellow;
      acc.purple += summary.purple;
      acc.green += summary.green;
      return acc;
    },
    { red: 0, orange: 0, yellow: 0, purple: 0, green: 0 },
  );
  const valid = totals.red + totals.orange + totals.yellow + totals.purple + totals.green;
  history.recordSpeedmap({
    kind: 'metra',
    route: line,
    direction: null,
    avgMph: lineAvgMph,
    pctRed: valid ? totals.red / valid : 0,
    pctOrange: valid ? totals.orange / valid : 0,
    pctYellow: valid ? totals.yellow / valid : 0,
    pctPurple: valid ? totals.purple / valid : 0,
    pctGreen: valid ? totals.green / valid : 0,
    binSpeeds: [],
    posted: true,
    postUri: result.uri,
  });
  console.log(`Posted: ${result.url}`);
}

// Record a non-posting run so leastRecentlyPostedSpeedmapRoute rotates past this
// line next time instead of retrying it every tick.
function recordEmpty(line) {
  history.recordSpeedmap({
    kind: 'metra',
    route: line,
    direction: null,
    avgMph: null,
    pctRed: 0,
    pctOrange: 0,
    pctYellow: 0,
    pctGreen: 0,
    binSpeeds: [],
    posted: false,
  });
}

if (require.main === module) runBin(main);

module.exports = { buildPostText, buildAltText };
