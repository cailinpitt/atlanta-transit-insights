const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { cumulativeDistances } = require('../../shared/geo');
const { colorForCrowding } = require('../bus/crowding');
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

// Crowding map: the route shape with each segment colored by how full buses were
// there over the window. Same construction as renderBusSpeedmap (including the
// polyline thinning that keeps the Mapbox static URL under its ~8KB limit) — only
// the per-bin color scale differs (occupancy, not speed).
async function renderBusCrowdingMap(shape, binScores) {
  const points = shape.points;
  const cumDist = cumulativeDistances(points);
  const slices = sliceIntoSegments(points, cumDist, binScores.length);
  const fullEncoded = encodeURIComponent(
    encode(thinPolylinePoints(points).map((p) => [p.lat, p.lon])),
  );
  const overlays = [`path-${SPEEDMAP_HALO_STROKE}+${ROUTE_HALO_COLOR}(${fullEncoded})`];

  for (let i = 0; i < slices.length; i++) {
    if (slices[i].length < 2) continue;
    const encoded = encodeURIComponent(
      encode(thinPolylinePoints(slices[i], 30).map((p) => [p.lat, p.lon])),
    );
    overlays.push(`path-${SPEEDMAP_SEGMENT_STROKE}+${colorForCrowding(binScores[i])}(${encoded})`);
  }

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${WIDTH}x${HEIGHT}@2x?access_token=${token}&padding=30`;
  const data = await fetchMapboxStatic(url);
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

module.exports = { renderBusCrowdingMap };
