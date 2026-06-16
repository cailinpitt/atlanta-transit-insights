const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { cumulativeDistances } = require('../../shared/geo');
const { colorForRailSpeed } = require('../rail/speedmap');
const {
  STYLE,
  WIDTH,
  HEIGHT,
  ROUTE_HALO_COLOR,
  SPEEDMAP_SEGMENT_STROKE,
  SPEEDMAP_HALO_STROKE,
  sliceIntoSegments,
  requireMapboxToken,
  fetchMapboxStatic,
  thinPolylinePoints,
} = require('./common');

// `colorFn` maps a bin's mph to a hex color; the streetcar passes its own so the
// slower bands paint correctly (same 5-color scheme, lower thresholds).
async function renderRailSpeedmap(line, binSpeeds, { colorFn = colorForRailSpeed } = {}) {
  const points = line.points;
  const cumDist = cumulativeDistances(points);
  const slices = sliceIntoSegments(points, cumDist, binSpeeds.length);
  const fullEncoded = encodeURIComponent(
    encode(thinPolylinePoints(points).map((p) => [p.lat, p.lon])),
  );
  const overlays = [`path-${SPEEDMAP_HALO_STROKE}+${ROUTE_HALO_COLOR}(${fullEncoded})`];

  for (let i = 0; i < slices.length; i++) {
    if (slices[i].length < 2) continue;
    const encoded = encodeURIComponent(
      encode(thinPolylinePoints(slices[i], 30).map((p) => [p.lat, p.lon])),
    );
    overlays.push(`path-${SPEEDMAP_SEGMENT_STROKE}+${colorFn(binSpeeds[i])}(${encoded})`);
  }

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${WIDTH}x${HEIGHT}@2x?access_token=${token}&padding=30`;
  const data = await fetchMapboxStatic(url);
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

module.exports = { renderRailSpeedmap };
