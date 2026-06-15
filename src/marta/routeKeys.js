const RAIL_ROUTES = new Map([
  ['BLUE', 'blue'],
  ['GOLD', 'gold'],
  ['GREEN', 'green'],
  ['RED', 'red'],
]);

// Atlanta Streetcar identifiers. The GTFS route is short_name "ATLSC"
// (route_id 26982, route_type 0). NOTE: do NOT add 'A' here — route "A" in the
// realtime feed is the "Rapid A Line" BRT (route_type 3, a bus) whose vehicles
// sprawl well past downtown; tagging it streetcar mislabeled Rapid-A alerts 🚋.
const STREETCAR_ROUTES = new Set(['ATLSC', 'STREETCAR']);

function routeKey(route) {
  return String(route || '').trim();
}

function isStreetcarRoute(route) {
  return STREETCAR_ROUTES.has(routeKey(route).toUpperCase());
}

function canonicalRoute(route) {
  const key = routeKey(route);
  const upper = key.toUpperCase();
  if (STREETCAR_ROUTES.has(upper)) return 'streetcar';
  return RAIL_ROUTES.get(upper) ?? key;
}

function canonicalMode(mode, routes = []) {
  const routeList = Array.isArray(routes) ? routes : [routes];
  if (routeList.some(isStreetcarRoute)) return 'streetcar';
  if (mode === 'rail' || mode === 'train') return 'rail';
  return mode;
}

function routeMatchKey(route) {
  return canonicalRoute(route).toUpperCase();
}

module.exports = {
  canonicalMode,
  canonicalRoute,
  isStreetcarRoute,
  routeMatchKey,
};
