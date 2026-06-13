// Metra recap — the weekly/monthly performance digest, the Metra analog of the
// CTA bus/train recaps (src/shared/recap.js). Pure aggregation: the bin
// (bin/metra/recap.js) reads disruption_events + the schedule index and injects
// them here, so this module is unit-testable with no DB/clock.
//
// Mental model: Metra is timetabled, so the rider-facing performance number is
// "what fraction of scheduled trains ran roughly on time." We define
//   reliability = (scheduled − disrupted) / scheduled
// where a trip is "disrupted" if it was cancelled (confirmed or inferred) OR ran
// 15+ min late. Those are exactly the events Phase 2/3 record to
// disruption_events (kind='metra'), 90-day rolloff — so this works for both the
// weekly and the monthly window. The scheduled-trip denominator comes from the
// static GTFS index (count of trips whose service_id is active on each day in the
// window), injected as `scheduledByLine`.
//
// This is descriptive data, not an editorial verdict — we report the percentage
// and the counts, never a letter grade (see the killed A–F grade rationale).

const { LINE_NAMES } = require('./lines');

function round1(n) {
  return Math.round(n * 10) / 10;
}

// One trip can be recorded once per source bucket (the bin dedups by
// trip_id+serviceDate), so a delayed trip and a cancelled trip are distinct
// rows. `disrupted` = cancelled + delayed; reliability subtracts that from the
// scheduled count. A line with no scheduled trips in the window (index gap) gets
// reliabilityPct: null and is dropped from the chart/text rather than shown as 0%.
function buildRecap({ events, scheduledByLine }) {
  const byLine = new Map();
  const ensure = (line) => {
    if (!byLine.has(line)) {
      byLine.set(line, { line, scheduled: 0, cancelled: 0, delayed: 0 });
    }
    return byLine.get(line);
  };

  // Seed from the schedule so a line with zero incidents still appears at 100%.
  for (const [line, scheduled] of Object.entries(scheduledByLine || {})) {
    ensure(line).scheduled = scheduled;
  }

  let worstDelay = null;
  for (const ev of events || []) {
    const rec = ensure(ev.line);
    if (ev.source === 'delay') {
      rec.delayed += 1;
      const min = ev.evidence?.delayMin;
      if (Number.isFinite(min) && (!worstDelay || min > worstDelay.delayMin)) {
        worstDelay = {
          line: ev.line,
          delayMin: min,
          headsign: ev.evidence?.headsign || null,
          depLabel: ev.evidence?.scheduledDepLabel || null,
        };
      }
    } else {
      // 'cancellation' or 'cancellation-inferred'
      rec.cancelled += 1;
    }
  }

  const lines = [...byLine.values()].map((r) => {
    const disrupted = r.cancelled + r.delayed;
    const reliabilityPct =
      r.scheduled > 0 ? round1(((r.scheduled - disrupted) / r.scheduled) * 100) : null;
    return { ...r, disrupted, reliabilityPct };
  });

  // Systemwide totals fold in only lines we have a denominator for, so the
  // headline percentage is honest (a line with incidents but no schedule data
  // would otherwise drag the numerator without a matching denominator).
  let sScheduled = 0;
  let sCancelled = 0;
  let sDelayed = 0;
  for (const r of lines) {
    if (r.scheduled <= 0) continue;
    sScheduled += r.scheduled;
    sCancelled += r.cancelled;
    sDelayed += r.delayed;
  }
  const sDisrupted = sCancelled + sDelayed;
  const systemwide = {
    scheduled: sScheduled,
    cancelled: sCancelled,
    delayed: sDelayed,
    disrupted: sDisrupted,
    reliabilityPct: sScheduled > 0 ? round1(((sScheduled - sDisrupted) / sScheduled) * 100) : null,
  };

  return { lines, systemwide, worstDelay };
}

// Chart rows: lines with a real denominator, least-reliable first (worst on top,
// like the gap chart leads with the worst offender).
function chartEntries(recap) {
  return recap.lines
    .filter((r) => r.reliabilityPct != null && r.scheduled > 0)
    .sort((a, b) => a.reliabilityPct - b.reliabilityPct || b.scheduled - a.scheduled);
}

function pluralize(n, singular, plural) {
  return `${n.toLocaleString('en-US')} ${n === 1 ? singular : plural}`;
}

// Compact worst-delay label: "6:30 PM Aurora (BNSF)" — departure + headsign +
// line. Pieces that are missing are simply dropped.
function worstDelayLabel(w) {
  if (!w) return null;
  const head = [w.depLabel, w.headsign].filter(Boolean).join(' ');
  const name = LINE_NAMES[w.line] || w.line;
  const subject = head || name;
  return head ? `${subject} (${name})` : subject;
}

const TITLE_EMOJI = '🚆';

function buildPostText({ recap, windowLabel }) {
  const { systemwide, worstDelay } = recap;
  const lines = [`${TITLE_EMOJI} Metra recap · ${windowLabel}`];

  if (systemwide.reliabilityPct == null || systemwide.scheduled === 0) {
    lines.push('', 'No Metra schedule data for this window.');
    return lines.join('\n');
  }

  lines.push(
    '',
    'On-time (within 15 min, not cancelled):',
    `${systemwide.reliabilityPct}% of ${pluralize(systemwide.scheduled, 'scheduled trip', 'scheduled trips')}`,
  );

  const worst = chartEntries(recap).slice(0, 2);
  if (worst.length > 0 && worst[0].reliabilityPct < 100) {
    const parts = worst
      .filter((r) => r.reliabilityPct < 100)
      .map((r) => `${LINE_NAMES[r.line] || r.line} ${r.reliabilityPct}%`);
    if (parts.length > 0) lines.push('', `Least reliable: ${parts.join(' · ')}`);
  }

  if (systemwide.cancelled > 0) {
    lines.push(`Cancellations: ${systemwide.cancelled.toLocaleString('en-US')}`);
  }
  const wl = worstDelayLabel(worstDelay);
  if (wl) lines.push(`Worst delay: ${worstDelay.delayMin} min — ${wl}`);

  return lines.join('\n');
}

function buildAltText({ recap, windowLabel }) {
  const { systemwide } = recap;
  if (systemwide.reliabilityPct == null || systemwide.scheduled === 0) {
    return `Chart with no data — no Metra schedule was available for ${windowLabel}.`;
  }
  const top = chartEntries(recap)
    .slice(0, 3)
    .map((r) => `${LINE_NAMES[r.line] || r.line} ${r.reliabilityPct}%`)
    .join(', ');
  return `Horizontal bar chart of Metra on-time reliability by line for ${windowLabel}: ${systemwide.reliabilityPct}% systemwide across ${pluralize(systemwide.scheduled, 'scheduled trip', 'scheduled trips')}. A trip counts as on-time if it ran within 15 minutes and was not cancelled. Least reliable: ${top}.`;
}

module.exports = {
  buildRecap,
  chartEntries,
  buildPostText,
  buildAltText,
  worstDelayLabel,
};
