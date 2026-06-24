const RAIL_STATIONS = require('./rail-stations.json');
const { normalizeStationKey } = require('./alert/stations');

const ACCESS_PATTERNS = [/\belevator\b/i, /\bescalator\b/i, /\baccessib/i, /\bentrance\b/i];

function textForAlert(alert) {
  return [alert?.header, alert?.description].filter(Boolean).join(' ');
}

function slugifyStation(name) {
  if (!name) return null;
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
}

function displayStationName(name) {
  return String(name || '')
    .replace(/\s*\bstation\b\s*$/i, '')
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function classifyUnit(text) {
  if (/\belevator\b/i.test(text || '')) return 'elevator';
  if (/\bescalator\b/i.test(text || '')) return 'escalator';
  if (/\bentrance\b/i.test(text || '')) return 'entrance';
  return 'other';
}

function isAccessibilityAlert(alert) {
  if (!alert) return false;
  if (alert.effect === 'ACCESSIBILITY_ISSUE') return true;
  return ACCESS_PATTERNS.some((re) => re.test(textForAlert(alert)));
}

function routeLines(alert) {
  const lines = new Set();
  for (const e of alert?.informedEntities || []) {
    const route = String(e.routeId || '')
      .trim()
      .toLowerCase();
    if (['red', 'gold', 'blue', 'green'].includes(route)) lines.add(route);
    if (e.routeType === 0 || route.includes('streetcar')) lines.add('streetcar');
  }
  return [...lines];
}

function stationCandidates(stations = RAIL_STATIONS) {
  return stations
    .map((s) => ({
      rawName: s.name,
      name: displayStationName(s.name),
      slug: slugifyStation(s.name),
      lines: s.lines || [],
      key: normalizeStationKey(s.name),
    }))
    .sort((a, b) => b.name.length - a.name.length);
}

function matchRosterStation(text, stations = RAIL_STATIONS) {
  const normalizedText = normalizeStationKey(text || '');
  if (!normalizedText) return null;
  for (const s of stationCandidates(stations)) {
    const escaped = s.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\ /g, '[ -]+');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(normalizedText)) return s;
  }
  return null;
}

function parseRawStationName(text) {
  const patterns = [
    /\bat\s+([A-Za-z0-9][A-Za-z0-9./&' -]+?)(?:\s+station)?(?:\s+is\b|\s+will\b|\s+has\b|\s+for\b|[.,;]|$)/i,
    /\b(?:elevator|escalator|entrance)\s+(?:at|near)\s+([A-Za-z0-9][A-Za-z0-9./&' -]+?)(?:\s+station)?(?:\s+is\b|\s+will\b|\s+has\b|\s+for\b|[.,;]|$)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text || '');
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function parseUnitLabel(text) {
  const unit = /\b(elevator|escalator|entrance)\b/i.exec(text || '');
  if (!unit) return null;
  const after = text.slice(unit.index + unit[0].length);
  const m =
    /^\s+(.+?)(?:\s+(?:at|near)\s+[A-Z0-9][A-Za-z0-9./&' -]+(?:\s+station)?\b|\s+is\b|\s+will\b|\s+has\b|[.;]|$)/i.exec(
      after,
    );
  if (!m?.[1]) return null;
  const label = m[1]
    .replace(/^(?:for|to|from)\s+$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return label || null;
}

function parseStationAndUnit(text, stations = RAIL_STATIONS) {
  const roster = matchRosterStation(text, stations);
  const stationName = roster?.name || parseRawStationName(text);
  return {
    stationName,
    stationSlug: roster?.slug ?? null,
    stationLines: roster?.lines || [],
    unitLabel: parseUnitLabel(text),
  };
}

function sourceId(alert) {
  const raw = String(alert?.id || '');
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (/^Alert:/.test(decoded)) return decoded;
  } catch {
    // keep raw id
  }
  return raw;
}

function toOutageRows(alerts, stations = RAIL_STATIONS, now = Date.now()) {
  return (alerts || []).filter(isAccessibilityAlert).map((alert) => {
    const text = textForAlert(alert);
    const parsed = parseStationAndUnit(text, stations);
    const lines = parsed.stationLines.length ? parsed.stationLines : routeLines(alert);
    return {
      sourceId: sourceId(alert),
      agency: 'marta',
      stationName: parsed.stationName,
      stationSlug: parsed.stationSlug,
      lines,
      unitType: classifyUnit(text),
      unitLabel: parseUnitLabel(alert.description) || parsed.unitLabel,
      headline: alert.header || null,
      description: alert.description || null,
      sourceUrl: alert.url || null,
      firstSeenTs: now,
    };
  });
}

module.exports = {
  ACCESS_PATTERNS,
  classifyUnit,
  isAccessibilityAlert,
  parseStationAndUnit,
  toOutageRows,
  slugifyStation,
};
