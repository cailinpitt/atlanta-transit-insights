// Shared dropout/gap model for the server-rendered vehicle timelapses — train
// (snapshot, bunching, gap) and bus (bunching). The CTA feeds briefly drop
// vehicles all the time (GPS loss, tunnels, prediction suppression near
// terminals/yards, the train 0,0 glitch, a single missed poll). Before this,
// each video reinvented "what to do when a vehicle vanishes":
//   - train bunchingVideo only dead-reckoned vehicles missing from the *final*
//     snapshot; one dropped for a few interior ticks hard-disappeared then
//     popped back in. train snapshotVideo had no ghosting at all.
//   - bus bunchingVideo bridged interior gaps (fillInteriorGaps) but with no cap
//     — a 20-min unknown was fabricated as a smooth glide — and reimplemented
//     turnaround / tail-ghost logic separately.
//
// This kernel unifies the handling and mirrors the frontend EventReplay's
// `vehicleSample` semantics so every surface behaves the same:
//   - short gaps (<= MAX_BRIDGE_MS) are bridged by interpolation, dimmed by how
//     stale the position is,
//   - long interior gaps fade to a parked ghost on each side and draw nothing
//     through the unknown middle (we genuinely don't know where the vehicle was),
//   - a tail drop (vehicle never returns) dead-reckons along the polyline at last
//     known speed, fading out — or, if it dropped at a real terminal, plays a
//     turnaround glyph,
//   - every vehicle eases in at its own first sample.
//
// Pure + rendering-agnostic: callers pass cleaned per-vehicle series and a
// `pointAlong(track)` projector; the kernel returns plain render objects with an
// `opacity` (and `ghost`/`turnaround` flags) per frame.

const { haversineFt } = require('./geo');

// Bridge feed gaps up to 8 min — matches the frontend's MAX_GAP_SEC. Long
// enough to paper over routine terminal layovers / tunnel dropouts, short
// enough that a genuinely cold stretch (pulse-cold needs 15+ min) still empties.
const MAX_BRIDGE_MS = 8 * 60 * 1000;
// Within this of a real sample → full opacity; past it a bridged dot dims.
const STALE_FULL_MS = 45 * 1000;
// Ease a vehicle in over this much real time at its first sample, and fade the
// ghost at the edges of a long (un-bridgeable) gap.
const EDGE_FADE_MS = 20 * 1000;
const BRIDGE_MIN_OPACITY = 0.5;
const GHOST_OPACITY = 0.5;
// Floor a dead-reckoned tail ghost stays at least this visible so it doesn't
// fully vanish mid-clip (the dropout is the story on a focused clip).
const GHOST_MIN_OPACITY = 0.15;

// Terminal turnaround lifecycle (a tail drop at a real line end).
const TURNAROUND_NEAR_TERMINAL_FT = 1320; // ~0.25 mi
const TURNAROUND_GLIDE_MS = 2_500;
const TURNAROUND_HOLD_MS = 3_000;
const TURNAROUND_FADE_MS = 2_000;

// Build a per-vehicle time-series from cleaned snapshots. Each element carries
// the real timestamp, position, optional polyline `track` distance, a per-sample
// dead-reckon `speed` (ft/s along track), and the original vehicle `payload`
// (heading/destination/pdist/etc.) to copy onto rendered frames.
//
// Accessors keep the kernel mode-agnostic:
//   itemsOf(snapshot) → the vehicle array (train: `.trains`, bus: `.vehicles`)
//   idOf(vehicle)     → stable id (train: `.rn`, bus: `.vid`)
//   trackOf(vehicle, snapIdx) → polyline track distance, or null.
function buildVehicleSeries(
  snapshots,
  { itemsOf = (s) => s.trains, idOf = (v) => v.rn, trackOf = () => null } = {},
) {
  const byId = new Map();
  for (let si = 0; si < snapshots.length; si++) {
    for (const v of itemsOf(snapshots[si]) ?? []) {
      const id = idOf(v);
      if (id == null) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push({
        t: snapshots[si].ts,
        snapIdx: si,
        lat: v.lat,
        lon: v.lon,
        track: trackOf(v, si),
        payload: v,
      });
    }
  }
  // Per-sample forward speed (ft/s) from the *previous* sample, for tail/ghost
  // dead-reckoning. 0 when track is unavailable or the vehicle was stationary.
  for (const series of byId.values()) {
    series.sort((a, b) => a.t - b.t);
    for (let i = 0; i < series.length; i++) {
      const prev = series[i - 1];
      const cur = series[i];
      if (prev && cur.track != null && prev.track != null && cur.t > prev.t) {
        cur.speed = ((cur.track - prev.track) / (cur.t - prev.t)) * 1000;
      } else {
        cur.speed = 0;
      }
    }
  }
  return byId;
}

// Staleness dimming for a bridged position: full until STALE_FULL_MS, then ramps
// down to BRIDGE_MIN_OPACITY by the midpoint of a max-length bridge.
function bridgeOpacity(staleMs) {
  if (staleMs <= STALE_FULL_MS) return 1;
  const span = MAX_BRIDGE_MS / 2 - STALE_FULL_MS;
  return Math.max(
    BRIDGE_MIN_OPACITY,
    1 - ((staleMs - STALE_FULL_MS) / span) * (1 - BRIDGE_MIN_OPACITY),
  );
}

// Position along the polyline if both endpoints are snapped, else a straight
// lat/lon lerp (off-polyline vehicles, or a failed snap).
function interpPos(a, b, f, pointAlong) {
  if (pointAlong && a.track != null && b.track != null) {
    const p = pointAlong(a.track + (b.track - a.track) * f);
    if (p) return { lat: p.lat, lon: p.lon };
  }
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

function payloadFields(p) {
  if (!p) return {};
  const { lat: _lat, lon: _lon, ...rest } = p;
  return rest;
}

// The terminal this tail drop should glide to, or null. An explicit
// `opts.turnaroundEnd` wins (the caller proved a turnaround — e.g. a bus that
// reappeared on a different pid); otherwise fall back to proximity against the
// line's real terminal endpoints.
function resolveTurnaround(last, opts) {
  if (opts.turnaroundEnd) return opts.turnaroundEnd;
  return (
    (opts.realTerminalEnds ?? []).find(
      (end) => haversineFt({ lat: last.lat, lon: last.lon }, end) <= TURNAROUND_NEAR_TERMINAL_FT,
    ) ?? null
  );
}

// Render state for the tail of a series (frameTs is past the last sample): a
// turnaround glyph if it dropped at a real terminal, else a fading dead-reckoned
// ghost. Returns null once fully gone.
function tailState(last, frameTs, opts) {
  const { pointAlong, videoEndTs, tailFadeMs, turnaroundPark, turnaroundGlideMs } = opts;
  const ageMs = frameTs - last.t;
  if (ageMs < 0) return null;

  const terminal = resolveTurnaround(last, opts);
  if (terminal) {
    const glideMs = turnaroundGlideMs ?? TURNAROUND_GLIDE_MS;
    if (ageMs < glideMs) {
      const f = ageMs / glideMs;
      return {
        ...payloadFields(last.payload),
        lat: last.lat + (terminal.lat - last.lat) * f,
        lon: last.lon + (terminal.lon - last.lon) * f,
        opacity: 1,
      };
    }
    // `turnaroundPark` (bus): hold the U-turn glyph at the terminus, full
    // opacity, for the rest of the clip — it reached the end and reversed, and
    // that final state should stay readable. Default (train): hold then fade.
    if (turnaroundPark) {
      return {
        ...payloadFields(last.payload),
        lat: terminal.lat,
        lon: terminal.lon,
        opacity: 1,
        turnaround: true,
      };
    }
    const post = ageMs - glideMs;
    if (post > TURNAROUND_HOLD_MS + TURNAROUND_FADE_MS) return null;
    const opacity =
      post <= TURNAROUND_HOLD_MS
        ? 1
        : Math.max(0, 1 - (post - TURNAROUND_HOLD_MS) / TURNAROUND_FADE_MS);
    return {
      ...payloadFields(last.payload),
      lat: terminal.lat,
      lon: terminal.lon,
      opacity,
      turnaround: true,
    };
  }

  // Mid-line tail drop → dead-reckon at last-known speed, fading out.
  // pointAlong clamps at the polyline ends, so the ghost parks at the terminal
  // rather than flying off.
  //   - default (bunching): fade across the rest of the clip, never fully gone
  //     (the dropout IS the story on a small, focused clip).
  //   - `tailFadeMs` set (system snapshot): fade fully to nothing over a fixed
  //     window so dozens of end-of-service vehicles don't linger as clutter.
  if (tailFadeMs != null && ageMs >= tailFadeMs) return null;
  let { lat, lon } = last;
  if (pointAlong && last.track != null) {
    const p = pointAlong(last.track + last.speed * (ageMs / 1000));
    if (p) {
      lat = p.lat;
      lon = p.lon;
    }
  }
  const fadeMs = tailFadeMs ?? Math.max(1, (videoEndTs ?? frameTs) - last.t);
  const minOpacity = tailFadeMs != null ? 0 : GHOST_MIN_OPACITY;
  return {
    ...payloadFields(last.payload),
    lat,
    lon,
    opacity: Math.max(minOpacity, 1 - ageMs / fadeMs),
    ghost: true,
  };
}

// The render state of one vehicle series at frame time `t` (ms), or null when it
// shouldn't be drawn. Handles bridge / long-gap ghost / entry fade / tail.
function vehicleStateAt(series, t, opts = {}) {
  if (!series || series.length === 0) return null;
  const first = series[0].t;
  const last = series[series.length - 1].t;
  if (t < first) return null; // hasn't entered the clip yet
  if (t > last) return tailState(series[series.length - 1], t, opts);

  let i = 0;
  while (i < series.length - 1 && series[i + 1].t <= t) i++;
  const a = series[i];
  const b = series[Math.min(i + 1, series.length - 1)];
  const gap = b.t - a.t;

  let lat;
  let lon;
  let opacity;
  let ghost = false;
  let payload = a.payload;
  if (gap > MAX_BRIDGE_MS) {
    // Too long to bridge: ghost out from the near endpoint, draw nothing through
    // the middle, ghost back in approaching the far endpoint.
    const sinceA = t - a.t;
    const untilB = b.t - t;
    if (sinceA <= EDGE_FADE_MS) {
      let p = { lat: a.lat, lon: a.lon };
      if (opts.pointAlong && a.track != null) {
        const q = opts.pointAlong(a.track + a.speed * (sinceA / 1000));
        if (q) p = q;
      }
      lat = p.lat;
      lon = p.lon;
      opacity = GHOST_OPACITY * (1 - sinceA / EDGE_FADE_MS);
      ghost = true;
    } else if (untilB <= EDGE_FADE_MS) {
      lat = b.lat;
      lon = b.lon;
      opacity = GHOST_OPACITY * (1 - untilB / EDGE_FADE_MS);
      ghost = true;
      payload = b.payload;
    } else {
      return null;
    }
  } else {
    const f = gap === 0 ? 0 : (t - a.t) / gap;
    const p = interpPos(a, b, f, opts.pointAlong);
    lat = p.lat;
    lon = p.lon;
    opacity = bridgeOpacity(Math.min(t - a.t, b.t - t));
  }

  // Ease in only at the vehicle's *entry*. We deliberately don't fade out
  // approaching its last sample: a vehicle still present at the clip's end must
  // stay solid (a trailing fade would zero it at t==last), and one that leaves
  // early is faded out by tailState's dead-reckoned ghost instead — so applying
  // both would dip then pop.
  const lead = t - first;
  if (lead < EDGE_FADE_MS) opacity *= lead / EDGE_FADE_MS;

  return { ...payloadFields(payload), lat, lon, opacity, ghost };
}

// Real-terminal endpoints of a polyline, minus Loop-trunk apexes (disappearances
// at the inner Loop end of a round-trip line are normal mid-circuit turnarounds,
// not "arrived at the end of the run"). `inLoopTrunk` injected to avoid a cycle;
// omit it (bus end-to-end polylines) to treat both endpoints as real terminals.
function realTerminalEnds(linePts, inLoopTrunk) {
  if (!linePts || linePts.length < 2) return [];
  const toLatLon = (pt) =>
    Array.isArray(pt) ? { lat: pt[0], lon: pt[1] } : { lat: pt.lat, lon: pt.lon };
  const ends = [toLatLon(linePts[0]), toLatLon(linePts[linePts.length - 1])];
  return inLoopTrunk ? ends.filter(({ lat, lon }) => !inLoopTrunk(lat, lon)) : ends;
}

module.exports = {
  MAX_BRIDGE_MS,
  STALE_FULL_MS,
  EDGE_FADE_MS,
  GHOST_OPACITY,
  GHOST_MIN_OPACITY,
  BRIDGE_MIN_OPACITY,
  TURNAROUND_NEAR_TERMINAL_FT,
  buildVehicleSeries,
  vehicleStateAt,
  realTerminalEnds,
};
