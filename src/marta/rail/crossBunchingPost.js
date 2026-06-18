// Post text for a cross-line rail pileup (2+ lines stacked at one spot, e.g.
// RED + GOLD at Five Points or on the shared N-S trunk). Port of cta-insights
// src/train/crossBunchingPost.js. Headline is a PLACE; trains are grouped by
// line with the disc number each carries on the map.
const { lineTitle } = require('./post');
const { groupByLine } = require('./crossBunching');
const { formatCallouts } = require('../shared/incidents');
const { formatDistance, keycapNumber } = require('../shared/format');

// `ctx` = { placeName }.
function buildPostText(cluster, ctx, callouts = []) {
  const { placeName } = ctx;
  const { byLine } = groupByLine(cluster);
  const where = placeName ? ` at ${placeName}` : '';
  const head = `🚆 ${cluster.trains.length} trains from ${byLine.length} lines stacked up${where}`;
  const lines = byLine
    .map((g) => {
      const list = g.trains.map((x) => `#${x.trainId} (${keycapNumber(x.n)})`).join(', ');
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

module.exports = { buildPostText, buildAltText };
