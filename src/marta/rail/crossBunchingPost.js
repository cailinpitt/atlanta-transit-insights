// Post text for a cross-line rail pileup (2+ lines stacked at one spot, e.g.
// RED + GOLD at Five Points or on the shared N-S trunk). Port of cta-insights
// src/train/crossBunchingPost.js. Headline is a PLACE; trains are grouped by
// line with the disc number each carries on the map.
const { lineTitle } = require('./post');
const { groupByLine } = require('./crossBunching');
const { formatCallouts } = require('../shared/incidents');
const { formatDistance, keycapNumber, formatDeviation } = require('../shared/format');

// `ctx` = { placeName }. `opts.deviations` is an optional Map trainId → minutes
// (+late / −early) for the per-train schedule-adherence annotation.
function buildPostText(cluster, ctx, callouts = [], opts = {}) {
  const { placeName } = ctx;
  const deviations = opts.deviations;
  const { byLine } = groupByLine(cluster);
  const where = placeName ? ` at ${placeName}` : '';
  const head = `🚆 ${cluster.trains.length} trains from ${byLine.length} lines stacked up${where}`;
  const lines = byLine
    .map((g) => {
      const list = g.trains
        .map((x) => {
          const n = keycapNumber(x.n);
          const d = formatDeviation(deviations?.get(x.trainId));
          return d ? `#${x.trainId} (${n}, ${d})` : `#${x.trainId} (${n})`;
        })
        .join(', ');
      return `${lineTitle(g.line)}: ${list}`;
    })
    .join('\n');
  const base = `${head}\n\n${lines}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildAltText(cluster, ctx) {
  const { placeName } = ctx;
  const where = placeName ? ` at ${placeName}` : '';
  const lines = cluster.lines.map((l) => lineTitle(l)).join(', ');
  return `Map${where} showing ${cluster.trains.length} trains from ${cluster.lineCount} lines (${lines}) bunched within ${formatDistance(cluster.spanFt)} of each other.`;
}

function buildVideoPostText(video, cluster) {
  const elapsed = video?.elapsedSec
    ? `${Math.max(1, Math.round(video.elapsedSec / 60))} min`
    : 'Several minutes';
  return `${elapsed} of recent movement from this ${cluster.trains.length}-train, ${cluster.lineCount}-line pileup.`;
}

function buildVideoAltText(cluster, ctx = {}) {
  const where = ctx.placeName ? ` at ${ctx.placeName}` : '';
  return `Timelapse map${where} showing recent movement of ${cluster.trains.length} bunched trains from ${cluster.lineCount} lines.`;
}

module.exports = { buildPostText, buildAltText, buildVideoPostText, buildVideoAltText };
