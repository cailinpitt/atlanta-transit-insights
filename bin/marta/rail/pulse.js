#!/usr/bin/env node
// MARTA rail dead-segment ("pulse") detector bin — posts to @martaalertinsights
// when a stretch of track between stations has seen no train pass through for
// longer than the schedule allows. Port of cta-insights bin/train/pulse.js,
// collapsed to MARTA's four point-to-point lines and N/S/E/W feed directions.
//
// Per-(line, direction) state lives in pulse_state. A candidate must overlap the
// prior tick's run by ≥50% for MIN_CONSECUTIVE_TICKS before it posts (debounce),
// and CLEAR_TICKS_TO_RESET clean ticks before the ✅ clear reply. active_post_uri
// pins the canonical post for the live outage so re-posts are suppressed and the
// clear targets the right thread. The post threads under any open official MARTA
// rail alert for the line. When a whole line goes dark while the schedule says it
// should be running, a synthetic full-line candidate is flagged.
//
// Set PULSE_DRY_RUN=1 (or --dry-run) to exercise detection/render without
// posting. Cold-start guards (MIN_DISTINCT_TS, feed-gap, the detector's
// coverage/span gates) stop a freshly-populated table from looking like a
// system-wide outage.

require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { loadShapes } = require('../../../src/marta/bus/shapes');
const { buildLineGeometry, projectTrain } = require('../../../src/marta/rail/lines');
const { buildLineTermini, terminusFor } = require('../../../src/marta/rail/termini');
const {
  loadScheduleIndex,
  headwayForLine,
  activeForLine,
} = require('../../../src/marta/bus/schedule');
const {
  detectDeadSegments,
  detectFeedGap,
  stationsAlongLine,
  FEED_GAP_LOOKBACK_MS,
  DEFAULT_LOOKBACK_MS,
} = require('../../../src/marta/rail/pulse');
const storage = require('../../../src/marta/storage');
const incidents = require('../../../src/marta/shared/incidents');
const { acquireCooldown, clearCooldown } = require('../../../src/marta/shared/state');
const {
  loginAlerts,
  postWithImage,
  postText,
  postWithExternal,
  resolveReplyRef,
} = require('../../../src/marta/shared/bluesky');
const { findUnresolvedRailAlertForLine } = require('../../../src/marta/alert/store');
const { resolvedEventLink, rkeyFromAtUri } = require('../../../src/marta/shared/eventLink');
const { eventAssociatedRefs } = require('../../../src/marta/shared/standardSite');
const { renderRailDisruptionMap } = require('../../../src/marta/map/railIncidents');
const {
  buildPostText,
  buildAltText,
  buildClearPostText,
  buildClearCardTitle,
} = require('../../../src/marta/rail/disruptionPost');
const { lineTitle } = require('../../../src/marta/rail/post');
const stations = require('../../../src/marta/rail-stations.json');
const { setup, writeDryRunAsset, runBin } = require('../../../src/marta/shared/runBin');

const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');
const ALL_LINES = ['RED', 'GOLD', 'BLUE', 'GREEN'];

const DRY_RUN = process.env.PULSE_DRY_RUN === '1' || argv['dry-run'];

const LOOKBACK_MS = DEFAULT_LOOKBACK_MS; // 20 min base window
const LOOKBACK_BUFFER_MS = 5 * 60 * 1000;
const COLD_HEADWAY_MULT_FOR_LOOKBACK = 2.5; // mirror the detector's cold multiplier
const RAMP_UP_LOOKBACK_MS = 2 * 60 * 60 * 1000;
// Synthetic full-line silence requirement as a multiple of scheduled headway —
// clears a normal turnaround layover by a comfortable margin while still
// catching a multi-hour shutdown.
const SYNTHETIC_HEADWAY_MULT = 3;
// 3 consecutive ticks ≈ 4 min of persistence before posting; 5 clean ticks ≈
// 8 min before the ✅ reply, at the 2-min rail-pulse cron cadence (matches CTA).
const MIN_CONSECUTIVE_TICKS = 3;
const CLEAR_TICKS_TO_RESET = 5;
const POST_COOLDOWN_MS = 90 * 60 * 1000;
const MIN_HOUR = 5; // owl-service edge: wait until daytime patterns kick in
const MIN_DISTINCT_TS = 3;
const COLD_START_GRACE_MS = 6 * 60 * 60 * 1000;
const RECENTLY_ACTIVE_MS = 60 * 60 * 1000;
const CLEAR_MAX_PERP_FT = 1000;

function etHourNow(now = new Date()) {
  return (
    Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hourCycle: 'h23',
        hour: '2-digit',
      }).format(now),
    ) % 24
  );
}

function slugStation(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// Cooldown key derives from the bracketing stations rather than raw ft bounds —
// single-bin drift between ticks no longer changes the key, so the cooldown
// actually suppresses re-posts of the same outage.
function stableSegmentTag(candidate) {
  return `${slugStation(candidate.fromStation.name)}__${slugStation(candidate.toStation.name)}`;
}

function overlapFraction(a, b) {
  if (!a || !b) return 0;
  const lo = Math.max(a.lo, b.lo);
  const hi = Math.min(a.hi, b.hi);
  if (hi <= lo) return 0;
  const shorter = Math.min(a.hi - a.lo, b.hi - b.lo);
  return shorter > 0 ? (hi - lo) / shorter : 0;
}

function toObs(rows) {
  return rows.map((r) => ({
    ts: r.ts,
    lat: r.lat,
    lon: r.lon,
    direction: r.direction,
    trainId: r.trainId,
    destination: r.destination,
  }));
}

function safeHeadway(idx, line, now) {
  try {
    return headwayForLine(idx, line, new Date(now));
  } catch (_e) {
    return null;
  }
}

function safeActive(idx, line, now) {
  try {
    return activeForLine(idx, line, new Date(now)) || 0;
  } catch (_e) {
    return 0;
  }
}

function buildDisruption(line, candidate, terminus, now) {
  const onsetSourceTs = candidate.onsetTs ?? candidate.lastSeenInRunMs ?? null;
  const minutesSinceLastTrain =
    onsetSourceTs != null ? Math.round((now - onsetSourceTs) / 60000) : null;
  return {
    line,
    suspendedSegment: { from: candidate.fromStation.name, to: candidate.toStation.name },
    fromLoc: {
      lat: candidate.fromStation.lat,
      lon: candidate.fromStation.lon,
      name: candidate.fromStation.name,
    },
    toLoc: {
      lat: candidate.toStation.lat,
      lon: candidate.toStation.lon,
      name: candidate.toStation.name,
    },
    terminus: terminus || null,
    source: candidate.kind === 'held' ? 'observed-held' : 'observed',
    kind: candidate.kind || 'cold',
    runLoFt: candidate.runLoFt,
    runHiFt: candidate.runHiFt,
    evidence: {
      runLengthMi: Math.round((candidate.runLengthFt / 5280) * 10) / 10,
      minutesSinceLastTrain,
      lookbackMin: Math.round(candidate.lookbackMs / 60000),
      coldThresholdMin: Math.round(candidate.coldThresholdMs / 60000),
      trainsOutsideRun: candidate.trainsOutsideRun,
      coldStations: candidate.coldStations,
      coldStationNames: candidate.coldStationNames,
      expectedTrains: candidate.expectedTrains,
      headwayMin: candidate.headwayMin != null ? candidate.headwayMin : null,
      synthetic: candidate.synthetic === true,
      held: candidate.heldEvidence || null,
      from: candidate.fromStation.name,
      to: candidate.toStation.name,
    },
  };
}

async function handleCandidate(ctx, line, direction, candidate) {
  const { lineGeom, termini, agentGetter, now } = ctx;
  const prior = storage.getPulseState(line, direction);
  let consecutive = 1;
  let startedTs = now;
  if (prior && prior.run_lo_ft != null) {
    const frac = overlapFraction(
      { lo: prior.run_lo_ft, hi: prior.run_hi_ft },
      { lo: candidate.runLoFt, hi: candidate.runHiFt },
    );
    if (frac >= 0.5) {
      consecutive = (prior.consecutive_ticks || 0) + 1;
      startedTs = prior.started_ts || now;
    }
  }

  const segmentTag = stableSegmentTag(candidate);
  const cooldownKey = `rail_pulse_${line}_${direction}_${segmentTag}`;
  const activePostUri = prior?.active_post_uri || null;
  const activePostTs = prior?.active_post_ts || null;
  // Pin from/to once posted so the boundaries can't drift between ticks and make
  // the clear reply name different stations than the original post.
  const fromStationToWrite = activePostUri
    ? prior.from_station || candidate.fromStation.name
    : candidate.fromStation.name;
  const toStationToWrite = activePostUri
    ? prior.to_station || candidate.toStation.name
    : candidate.toStation.name;

  storage.upsertPulseState({
    line,
    direction,
    runLoFt: candidate.runLoFt,
    runHiFt: candidate.runHiFt,
    fromStation: fromStationToWrite,
    toStation: toStationToWrite,
    startedTs,
    lastSeenTs: now,
    consecutiveTicks: consecutive,
    clearTicks: 0,
    postedCooldownKey: cooldownKey,
    activePostUri,
    activePostTs,
  });

  if (activePostUri) {
    console.log(
      `[${lineTitle(line)}/${direction}] active pulse ${activePostUri} still in effect — refreshing state, no re-post`,
    );
    return;
  }

  const onsetSourceTs = candidate.onsetTs ?? candidate.lastSeenInRunMs ?? null;
  const minutesSinceLastTrain =
    onsetSourceTs != null ? Math.round((now - onsetSourceTs) / 60000) : null;

  if (consecutive < MIN_CONSECUTIVE_TICKS) {
    console.log(
      `[${lineTitle(line)}/${direction}] candidate ${candidate.fromStation.name}→${candidate.toStation.name} tick ${consecutive}/${MIN_CONSECUTIVE_TICKS}`,
    );
    incidents.recordMetaSignal({
      kind: 'rail',
      line,
      direction,
      source: candidate.kind === 'held' ? 'pulse-held' : 'pulse-cold',
      severity: 0.5,
      detail: {
        fromStation: candidate.fromStation.name,
        toStation: candidate.toStation.name,
        consecutiveTicks: consecutive,
        minutesSinceLastTrain,
        coldThresholdMin:
          candidate.coldThresholdMs != null ? Math.round(candidate.coldThresholdMs / 60000) : null,
      },
      posted: false,
    });
    return;
  }

  const terminus = terminusFor(termini, line, direction);
  const disruption = buildDisruption(line, candidate, terminus, now);
  const geom = lineGeom.get(line);

  if (DRY_RUN) {
    let image = null;
    try {
      image = await renderRailDisruptionMap(disruption, geom, {
        title: `${lineTitle(line)}${terminus ? ` - ${direction}` : ''}`,
      });
    } catch (e) {
      console.warn(`renderRailDisruptionMap failed: ${e.message}`);
    }
    const text = buildPostText(disruption, { alertOpen: false });
    const alt = buildAltText(disruption);
    const stub = image
      ? writeDryRunAsset(image, `rail-pulse-${line}-${direction}-${now}.jpg`)
      : '(render failed)';
    console.log(
      `--- DRY RUN pulse ${lineTitle(line)}/${direction} ---\n${text}\n\nAlt: ${alt}\nImage: ${stub}`,
    );
    incidents.recordDisruption(
      {
        kind: 'rail',
        line,
        direction,
        source: disruption.source,
        posted: false,
        postUri: null,
        evidence: disruption.evidence,
      },
      startedTs,
    );
    return;
  }

  if (!acquireCooldown(cooldownKey, now, POST_COOLDOWN_MS)) {
    console.log(`[${lineTitle(line)}/${direction}] on cooldown ${cooldownKey}, skipping`);
    incidents.recordDisruption(
      {
        kind: 'rail',
        line,
        direction,
        source: disruption.source,
        posted: false,
        postUri: null,
        evidence: disruption.evidence,
      },
      startedTs,
    );
    return;
  }

  let image;
  try {
    image = await renderRailDisruptionMap(disruption, geom, {
      title: lineTitle(line),
    });
  } catch (e) {
    console.error(`renderRailDisruptionMap failed for ${lineTitle(line)}: ${e.stack || e.message}`);
    return;
  }

  const agent = await agentGetter();
  const alertUri = findUnresolvedRailAlertForLine(line);
  const replyRef = alertUri ? await resolveReplyRef(agent, alertUri) : null;
  const alertOpen = !!replyRef;
  const text = buildPostText(disruption, { alertOpen });
  const alt = buildAltText(disruption);

  const result = await postWithImage(agent, text, image, alt, replyRef);
  console.log(`Posted pulse ${lineTitle(line)}/${direction}: ${result.url}`);
  incidents.recordDisruption(
    {
      kind: 'rail',
      line,
      direction,
      source: disruption.source,
      posted: true,
      postUri: result.uri,
      evidence: disruption.evidence,
    },
    startedTs,
  );
  incidents.recordMetaSignal({
    kind: 'rail',
    line,
    direction,
    source: candidate.kind === 'held' ? 'pulse-held' : 'pulse-cold',
    severity: 1,
    detail: { fromStation: candidate.fromStation.name, toStation: candidate.toStation.name },
    posted: true,
  });

  storage.upsertPulseState({
    line,
    direction,
    runLoFt: candidate.runLoFt,
    runHiFt: candidate.runHiFt,
    fromStation: candidate.fromStation.name,
    toStation: candidate.toStation.name,
    startedTs,
    lastSeenTs: now,
    consecutiveTicks: consecutive,
    clearTicks: 0,
    postedCooldownKey: cooldownKey,
    activePostUri: result.uri,
    activePostTs: now,
  });
}

async function handleClear(ctx, line, direction) {
  const { now } = ctx;
  const prior = storage.getPulseState(line, direction);
  if (!prior) return;
  const clearTicks = (prior.clear_ticks || 0) + 1;
  const clearStartedTs = prior.clear_started_ts || now;
  if (clearTicks >= CLEAR_TICKS_TO_RESET) {
    console.log(`[${lineTitle(line)}/${direction}] cleared after ${clearTicks} clean ticks`);
    await postClearReply(ctx, line, direction, { ...prior, clear_started_ts: clearStartedTs });
    if (prior.posted_cooldown_key) clearCooldown(prior.posted_cooldown_key);
    storage.clearPulseState(line, direction);
    return;
  }
  storage.upsertPulseState({
    line: prior.line,
    direction: prior.direction,
    runLoFt: prior.run_lo_ft,
    runHiFt: prior.run_hi_ft,
    fromStation: prior.from_station,
    toStation: prior.to_station,
    startedTs: prior.started_ts,
    lastSeenTs: now,
    consecutiveTicks: prior.consecutive_ticks,
    clearTicks,
    postedCooldownKey: prior.posted_cooldown_key,
    activePostUri: prior.active_post_uri,
    activePostTs: prior.active_post_ts,
    clearStartedTs,
  });
}

// First moment a direction-matched train re-entered [runLoFt, runHiFt] after the
// outage started — the real recovery time, so the recorded clear backdates past
// the up-to-one-cron-tick detection lag. Returns ts or null.
function firstEnteredSegmentTs(ctx, { line, direction, runLoFt, runHiFt, startedTs }) {
  if (runLoFt == null || runHiFt == null || !startedTs) return null;
  const geom = ctx.lineGeom.get(line);
  if (!geom) return null;
  const rows = ctx.allRows.filter(
    (r) => r.line === line && r.direction === direction && r.ts > startedTs,
  );
  for (const r of rows) {
    const proj = projectTrain(ctx.lineGeom, r);
    if (!proj || proj.offsetFt > CLEAR_MAX_PERP_FT) continue;
    if (proj.distFt >= runLoFt && proj.distFt <= runHiFt) return r.ts;
  }
  return null;
}

async function postClearReply(ctx, line, direction, prior) {
  const { agentGetter } = ctx;
  if (!prior?.active_post_uri) return;
  const fromStation = prior.from_station;
  const toStation = prior.to_station;
  if (!fromStation || !toStation) return;

  if (incidents.hasObservedClearForPulse({ kind: 'rail', pulseUri: prior.active_post_uri })) {
    console.log(
      `[${lineTitle(line)}/${direction}] clear reply already posted for ${prior.active_post_uri} — skipping`,
    );
    return;
  }

  const alertUri = findUnresolvedRailAlertForLine(line);
  const disruption = { line, suspendedSegment: { from: fromStation, to: toStation } };
  const text = buildClearPostText(disruption, { alertOpen: !!alertUri });

  if (DRY_RUN) {
    console.log(`--- DRY RUN clear reply for ${lineTitle(line)}/${direction} ---\n${text}`);
    return;
  }

  const agent = await agentGetter();
  const replyRef =
    (alertUri ? await resolveReplyRef(agent, alertUri) : null) ||
    (await resolveReplyRef(agent, prior.active_post_uri));
  if (!replyRef) {
    console.warn(`[${lineTitle(line)}/${direction}] could not resolve reply ref for clear post`);
    return;
  }
  const link = resolvedEventLink(prior.active_post_uri, buildClearCardTitle(disruption));
  // Mint the event's standard.site document + attach associatedRefs so the clear
  // card renders enhanced immediately, not after the page-side rebuild.
  const rkey = rkeyFromAtUri(prior.active_post_uri);
  const associatedRefs =
    link && rkey
      ? await eventAssociatedRefs(agent, { rkey, title: link.title, publishedAt: Date.now() })
      : null;
  const result = link
    ? await postWithExternal(agent, text, link, replyRef, associatedRefs)
    : await postText(agent, text, replyRef);
  console.log(`Posted pulse clear ${lineTitle(line)}/${direction}: ${result.url}`);
  const recordedTs =
    firstEnteredSegmentTs(ctx, {
      line,
      direction,
      runLoFt: prior.run_lo_ft,
      runHiFt: prior.run_hi_ft,
      startedTs: prior.started_ts,
    }) ||
    prior.clear_started_ts ||
    Date.now();
  incidents.recordDisruption(
    {
      kind: 'rail',
      line,
      direction,
      source: 'observed-clear',
      posted: true,
      postUri: result.uri,
    },
    recordedTs,
  );
}

// Whole line dark while the schedule says it should be running — synthesize a
// full-line candidate so a system shutdown still gets flagged.
async function maybeSyntheticFullLineCandidate(ctx, line) {
  const { lineGeom, idx, allRows, now } = ctx;
  const expected = safeActive(idx, line, now);
  if (expected <= 0) return;

  const sixHourObs = allRows.filter((r) => r.line === line && r.ts >= now - COLD_START_GRACE_MS);
  const recentlyActive = allRows.some((r) => r.line === line && r.ts >= now - RECENTLY_ACTIVE_MS);
  if (sixHourObs.length === 0 || !recentlyActive) {
    console.log(
      `pulse: zero observations on ${lineTitle(line)} but ${expected} trips expected — within cold-start grace, skipping synthetic candidate`,
    );
    return;
  }

  const headwayMin = safeHeadway(idx, line, now);
  const requiredSilenceMs = Math.max(
    LOOKBACK_MS,
    SYNTHETIC_HEADWAY_MULT * (headwayMin || 0) * 60 * 1000,
  );
  if (requiredSilenceMs > LOOKBACK_MS) {
    const within = allRows.some((r) => r.line === line && r.ts >= now - requiredSilenceMs);
    if (within) {
      console.log(
        `pulse: ${lineTitle(line)} silent in last ${LOOKBACK_MS / 60000} min but had obs in last ${Math.round(requiredSilenceMs / 60000)} min (≥${SYNTHETIC_HEADWAY_MULT}× headway) — not synthesizing`,
      );
      return;
    }
  }

  const geom = lineGeom.get(line);
  const onLine = stationsAlongLine(stations, line, geom);
  if (onLine.length < 2) return;
  console.log(
    `pulse: ${lineTitle(line)} silent ≥${Math.round(requiredSilenceMs / 60000)} min but ${expected} trips expected — synthesizing full-line candidate`,
  );
  const synthetic = {
    line,
    direction: 'all',
    runLoFt: 0,
    runHiFt: geom.lengthFt,
    runLengthFt: geom.lengthFt,
    fromStation: onLine[0].station,
    toStation: onLine[onLine.length - 1].station,
    coldBins: 0,
    totalBins: 0,
    observedTrainsInWindow: 0,
    lastSeenInRunMs: null,
    onsetTs: null,
    coldThresholdMs: requiredSilenceMs,
    lookbackMs: requiredSilenceMs,
    trainsOutsideRun: 0,
    coldStations: onLine.length,
    coldStationNames: onLine.map((s) => s.station.name),
    expectedTrains: expected,
    headwayMin,
    synthetic: true,
  };
  await handleCandidate(ctx, line, 'all', synthetic);
}

async function main() {
  setup();
  const gtfs = loadGtfs(GTFS_DIR);
  const shapes = loadShapes(GTFS_DIR);
  const lineGeom = buildLineGeometry(gtfs, shapes);
  const termini = buildLineTermini(gtfs);
  const idx = loadScheduleIndex();
  const now = Date.now();

  console.log(
    `rail-pulse: scanning ${ALL_LINES.length} lines for dead segments (posts after ${MIN_CONSECUTIVE_TICKS} consecutive ticks, clears after ${CLEAR_TICKS_TO_RESET})`,
  );

  if (etHourNow(new Date(now)) < MIN_HOUR) {
    console.log(`Skipping pulse before ${MIN_HOUR} AM ET`);
    return;
  }

  // One 2h fetch covers the per-line lookback, the ramp-up slice, and the
  // feed-gap window.
  const allRows = storage.getRecentRailObservationsAll(now - RAMP_UP_LOOKBACK_MS);
  if (allRows.length === 0) {
    console.log(
      'rail-pulse: no rail observations in the last 2h — is observe-rail running? skipping',
    );
    return;
  }

  const lookbackRows = allRows.filter((r) => r.ts >= now - LOOKBACK_MS);
  const distinctTs = new Set(lookbackRows.map((r) => r.ts)).size;
  if (distinctTs < MIN_DISTINCT_TS) {
    console.log(
      `rail-pulse: only ${distinctTs} distinct snapshot(s) in last ${LOOKBACK_MS / 60000} min (need ${MIN_DISTINCT_TS}) — warming up, skipping`,
    );
    return;
  }

  const feedGap = detectFeedGap({
    positions: allRows.filter((r) => r.ts >= now - FEED_GAP_LOOKBACK_MS).map((r) => ({ ts: r.ts })),
    now,
  });
  if (feedGap.gap) {
    console.log(
      `rail-pulse: ${Math.round(feedGap.maxGapMs / 60000)}-min gap in the global feed within the last ${FEED_GAP_LOOKBACK_MS / 60000} min — upstream outage / stale recovery, skipping tick`,
    );
    return;
  }

  let agent = null;
  const agentGetter = async () => {
    if (!agent) agent = await loginAlerts();
    return agent;
  };
  const ctx = { lineGeom, termini, idx, allRows, agentGetter, now };

  for (const line of ALL_LINES) {
    const geom = lineGeom.get(line);
    if (!geom) continue;

    // Wind-down guard: the schedule says <1 trip active this hour → service is
    // ending / between hours. Don't flag the cold tail behind the last train,
    // and leave any open pulse_state intact (advancing clears here would post a
    // bogus "running again" reply the moment scheduled service drops).
    if (safeActive(idx, line, now) < 1) {
      console.log(
        `rail-pulse: ${lineTitle(line)} winding down (schedule <1 trip/hr) — leaving state intact`,
      );
      continue;
    }

    const headwayMin = safeHeadway(idx, line, now);
    const headwayDrivenLookbackMs = headwayMin
      ? COLD_HEADWAY_MULT_FOR_LOOKBACK * headwayMin * 60 * 1000 + LOOKBACK_BUFFER_MS
      : 0;
    const lineLookbackMs = Math.max(LOOKBACK_MS, headwayDrivenLookbackMs);

    const recent = allRows.filter((r) => r.line === line && r.ts >= now - LOOKBACK_MS);
    if (recent.length === 0) {
      await maybeSyntheticFullLineCandidate(ctx, line);
      continue;
    }

    const lineRecent = allRows.filter((r) => r.line === line && r.ts >= now - lineLookbackMs);
    const longRecent = allRows.filter((r) => r.line === line);

    const pinnedRanges = new Map();
    for (const row of storage.listPulseStateForLine(line)) {
      if (row.run_lo_ft != null && row.run_hi_ft != null) {
        pinnedRanges.set(row.direction, { lo: row.run_lo_ft, hi: row.run_hi_ft });
      }
    }

    // Approximate the trips that should have dispatched in the window, for the
    // dispatch-continuity veto (trips/hr × window fraction).
    const expectedDispatchesInWindow = Math.round(
      safeActive(idx, line, now) * (lineLookbackMs / (60 * 60 * 1000)),
    );

    let detection;
    try {
      detection = detectDeadSegments({
        line,
        geom,
        stations,
        headwayMin,
        now,
        opts: {
          lookbackMs: lineLookbackMs,
          recentPositions: toObs(lineRecent),
          longLookbackPositions: toObs(longRecent),
          pinnedRanges,
          expectedDispatchesInWindow,
        },
      });
    } catch (e) {
      console.error(`pulse detect failed for ${lineTitle(line)}: ${e.stack || e.message}`);
      continue;
    }

    if (detection.skipped) {
      // sparse-coverage / sparse-span just mean we can't evaluate this tick —
      // advance clear-ticks for any open pulse so a stale FP doesn't pin forever
      // (a real outage keeps re-firing once coverage recovers).
      if (
        (detection.skipped === 'sparse-coverage' || detection.skipped === 'sparse-span') &&
        recent.length > 0
      ) {
        const open = storage.listPulseStateForLine(line).filter((r) => r.active_post_uri != null);
        for (const row of open) await handleClear(ctx, line, row.direction);
        if (open.length > 0) {
          console.log(
            `rail-pulse: ${lineTitle(line)} — detector skipped (${detection.skipped}) but advancing clear-ticks for ${open.length} open pulse(s)`,
          );
          continue;
        }
      }
      console.log(
        `rail-pulse: ${lineTitle(line)} — detector skipped (${detection.skipped}); leaving state intact`,
      );
      continue;
    }

    const candidates = detection.candidates;
    if (candidates.length === 0) {
      for (const row of storage.listPulseStateForLine(line))
        await handleClear(ctx, line, row.direction);
      continue;
    }

    // Put directions with an existing active post first so the segment dedup
    // preserves the canonical post; held before cold.
    const activeDirs = new Set(
      storage
        .listPulseStateForLine(line)
        .filter((r) => r.active_post_uri != null)
        .map((r) => r.direction),
    );
    candidates.sort((a, b) => {
      const aActive = activeDirs.has(a.direction) ? 1 : 0;
      const bActive = activeDirs.has(b.direction) ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      const aHeld = a.kind === 'held' ? 1 : 0;
      const bHeld = b.kind === 'held' ? 1 : 0;
      return bHeld - aHeld;
    });

    const seenDirs = new Set();
    const seenSegments = new Set();
    for (const c of candidates) {
      if (seenDirs.has(c.direction)) continue;
      seenDirs.add(c.direction);
      const segKey = `${c.fromStation?.name}__${c.toStation?.name}`;
      if (seenSegments.has(segKey)) {
        storage.clearPulseState(line, c.direction);
        continue;
      }
      seenSegments.add(segKey);
      try {
        await handleCandidate(ctx, line, c.direction, c);
      } catch (e) {
        console.error(
          `handleCandidate failed for ${lineTitle(line)}/${c.direction}: ${e.stack || e.message}`,
        );
      }
    }

    for (const row of storage.listPulseStateForLine(line)) {
      if (!seenDirs.has(row.direction)) await handleClear(ctx, line, row.direction);
    }
  }
}

module.exports = { stableSegmentTag, overlapFraction, etHourNow, buildDisruption };

if (require.main === module) runBin(main);
