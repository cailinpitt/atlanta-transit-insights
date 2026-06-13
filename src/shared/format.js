function formatDistance(ft) {
  if (ft < 1000) return `${Math.round(ft)} ft`;
  return `${(ft / 5280).toFixed(2)} mi`;
}

function formatMinutes(m) {
  return `${Math.round(m)} min`;
}

function formatMinSec(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function elapsedMinutesLabel(totalSec) {
  const m = Math.max(1, Math.round(totalSec / 60));
  return m === 1 ? '1 minute' : `${m} minutes`;
}

// Render a positive integer as keycap-emoji digits (1 → 1️⃣, 13 → 1️⃣3️⃣) so a
// bus's map-disc position reads as a distinct tag, not just another number next
// to its vehicle id and late/early minutes.
function keycapNumber(n) {
  return String(n)
    .split('')
    .map((d) => (d >= '0' && d <= '9' ? `${d}️⃣` : d))
    .join('');
}

// Schedule adherence as plain words, no +/- signs (the signs read ambiguously).
// Positive minutes = behind schedule (late), negative = ahead (early). Rounds to
// the minute; anything that rounds to 0 reads "on time". Returns null for a null/
// non-finite input so callers can simply omit the annotation.
function formatDeviation(min) {
  if (min == null || !Number.isFinite(min)) return null;
  const r = Math.round(min);
  if (r === 0) return 'on time';
  return r > 0 ? `${r} min late` : `${-r} min early`;
}

function formatTimeCT(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Chicago',
  });
}

module.exports = {
  formatDistance,
  formatMinutes,
  formatMinSec,
  elapsedMinutesLabel,
  formatDeviation,
  keycapNumber,
  formatTimeCT,
};
