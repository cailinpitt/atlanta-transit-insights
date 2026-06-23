// Post text for a cross-route bus pileup (2+ routes stacked at one spot). Port
// of cta-insights src/bus/crossBunchingPost.js. The headline is a PLACE; buses
// are grouped by route with the disc number each carries on the map. MARTA
// derives route titles from GTFS, so the bin passes them in via ctx.routeTitles.
const { groupByRoute } = require('./crossBunching');
const { formatCallouts } = require('../shared/incidents');
const { formatDistance, keycapNumber, formatDeviation } = require('../shared/format');

// `ctx` = { placeName, routeTitles?: Map<route, label> }. `opts.deviations` is an
// optional Map vehicleId → minutes (+late / −early) for the per-bus adherence tag.
function buildPostText(cluster, ctx, callouts = [], opts = {}) {
  const { placeName, routeTitles } = ctx;
  const deviations = opts.deviations;
  const labelFor = (r) => routeTitles?.get(r) || `Route ${r}`;
  const { byRoute } = groupByRoute(cluster);
  const where = placeName ? ` near ${placeName}` : '';
  const head = `🚍 ${cluster.vehicles.length} buses from ${byRoute.length} routes bunched${where}`;
  const lines = byRoute
    .map((g) => {
      const list = g.vids
        .map((x) => {
          const n = keycapNumber(x.n);
          const d = formatDeviation(deviations?.get(x.vehicleId));
          return d ? `#${x.vehicleId} (${n}, ${d})` : `#${x.vehicleId} (${n})`;
        })
        .join(', ');
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

function buildVideoPostText(video, cluster) {
  const elapsed = video?.elapsedSec
    ? `${Math.max(1, Math.round(video.elapsedSec / 60))} min`
    : 'Several minutes';
  return `${elapsed} of recent movement from this ${cluster.vehicles.length}-bus, ${cluster.routeCount}-route pileup.`;
}

function buildVideoAltText(cluster, ctx = {}) {
  const where = ctx.placeName ? ` near ${ctx.placeName}` : '';
  return `Timelapse map${where} showing recent movement of ${cluster.vehicles.length} bunched buses from ${cluster.routeCount} routes.`;
}

module.exports = { buildPostText, buildAltText, buildVideoPostText, buildVideoAltText };
