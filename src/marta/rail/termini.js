// Map each rail line's feed direction (N/S/E/W) to its terminus station name,
// derived from GTFS trip headsigns. MARTA rail headsigns read e.g.
// "RED NORTHBOUND TO NORTH SPRINGS STATION" / "BLUE EASTBOUND TO INDIAN CREEK
// STATION", so the compass word maps to the feed's DIRECTION letter and the
// "TO <name> STATION" clause names the terminus. Short-turn headsigns (e.g. RED
// SOUTHBOUND TO LINDBERGH) also appear, so we keep the dominant terminus per
// (line, direction) by trip count.
const RAIL_ROUTE_TYPE = '1';
const HEADSIGN_RE = /(NORTH|SOUTH|EAST|WEST)BOUND TO (.+?)(?:\s+STATION)?$/i;

// Some headsigns abbreviate the terminus; map the derived (title-cased) name to
// the rider-facing station name. Keyed by the derived name so it applies
// regardless of which line/direction produced it.
const DISPLAY_OVERRIDES = {
  'Candler Park': 'Edgewood/Candler Park',
  'H E Holmes': 'Hamilton E. Holmes',
};

// Title-case a SCREAMING station name (e.g. "NORTH SPRINGS" -> "North Springs"),
// then apply any rider-facing display override.
function titleCaseStation(name) {
  const cased = name
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .trim();
  return DISPLAY_OVERRIDES[cased] || cased;
}

// Returns Map<lineShortName, { N?, S?, E?, W? }> of terminus display names.
function buildLineTermini(gtfs) {
  const railRouteIds = new Map(); // route_id -> route_short_name
  for (const r of gtfs.routes) {
    if (String(r.route_type) === RAIL_ROUTE_TYPE) railRouteIds.set(r.route_id, r.route_short_name);
  }

  // line -> dir letter -> Map<terminusName, tripCount>
  const counts = new Map();
  for (const t of gtfs.trips) {
    const line = railRouteIds.get(t.route_id);
    if (!line) continue;
    const m = HEADSIGN_RE.exec((t.trip_headsign || '').trim());
    if (!m) continue;
    const dir = m[1][0].toUpperCase(); // N/S/E/W
    const name = titleCaseStation(m[2]);
    if (!counts.has(line)) counts.set(line, new Map());
    const byDir = counts.get(line);
    if (!byDir.has(dir)) byDir.set(dir, new Map());
    const byName = byDir.get(dir);
    byName.set(name, (byName.get(name) || 0) + 1);
  }

  const out = new Map();
  for (const [line, byDir] of counts) {
    const dirs = {};
    for (const [dir, byName] of byDir) {
      let best = null;
      let bestCount = -1;
      for (const [name, c] of byName) {
        if (c > bestCount) {
          bestCount = c;
          best = name;
        }
      }
      if (best) dirs[dir] = best;
    }
    out.set(line, dirs);
  }
  return out;
}

// Look up the terminus name for a line + feed direction; null when unknown.
function terminusFor(termini, line, direction) {
  if (!termini || !direction) return null;
  return termini.get(line)?.[direction] || null;
}

module.exports = { buildLineTermini, terminusFor };
