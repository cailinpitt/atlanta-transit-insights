// Post text for a cross-route bus pileup (2+ routes stacked at one spot). Port
// of cta-insights src/bus/crossBunchingPost.js. The headline is a PLACE; buses
// are grouped by route with the disc number each carries on the map. MARTA
// derives route titles from GTFS, so the bin passes them in via ctx.routeTitles.
const { groupByRoute } = require('./crossBunching');
const { formatCallouts } = require('../shared/incidents');
const { formatDistance, keycapNumber } = require('../shared/format');

// `ctx` = { placeName, routeTitles?: Map<route, label> }.
function buildPostText(cluster, ctx, callouts = []) {
  const { placeName, routeTitles } = ctx;
  const labelFor = (r) => routeTitles?.get(r) || `Route ${r}`;
  const { byRoute } = groupByRoute(cluster);
  const where = placeName ? ` near ${placeName}` : '';
  const head = `🚍 ${cluster.vehicles.length} buses from ${byRoute.length} routes bunched${where}`;
  const lines = byRoute
    .map((g) => {
      const list = g.vids.map((x) => `#${x.vehicleId} (${keycapNumber(x.n)})`).join(', ');
      return `${labelFor(g.route)}: ${list}`;
    })
    .join('\n');
  const base = `${head}\n\n${lines}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildAltText(cluster, ctx) {
  const { placeName } = ctx;
  const where = placeName ? ` near ${placeName}` : '';
  const routes = cluster.routes.map((r) => `Route ${r}`).join(', ');
  return `Map${where} showing ${cluster.vehicles.length} buses from ${cluster.routeCount} routes (${routes}) bunched within ${formatDistance(cluster.spanFt)} of each other.`;
}

module.exports = { buildPostText, buildAltText };
