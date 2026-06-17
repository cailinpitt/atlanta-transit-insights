// Classify a MARTA *rail* service alert as a single-departure cancellation and
// pull the rider-facing facts out of its prose. This is the MARTA analog of
// cta-insights src/metra/cancellationAlert.js — but where Metra resolves an
// annulled train against the GTFS timetable, MARTA gives us no per-train
// schedule: the cancellation lives only in editorial prose on the OTP alert
// ("...the 3:59 p.m. Blue line departure from Indian Creek is cancelled.").
// So we parse the prose instead of a schedule index.
//
// A "single-departure cancellation" is one that names a SPECIFIC cancelled
// departure — a clock time tied to cancellation language. That point-in-time
// fact is what lets the website model it as a terminal cancellation (upcoming →
// cancelled) instead of an open ongoing→resolved disruption. Vague notices
// ("Green line single-tracking", "reduced service due to police activity") name
// no specific departure and return null — the caller keeps the ordinary
// ongoing→resolved model for those, even though they may loosely imply missing
// trains.
//
// Pure: no feed, no DB. `anchorTs` (the alert's service-day anchor) is injected
// so the parsed wall-clock time resolves to an absolute epoch ms; `line` is
// injected for the title label. Mirrors the inject-everything style of the
// schedule/significance modules.

// Cancellation/annulment language — a sentence must match one of these (and
// carry a clock time) to count as a single-departure cancellation. Mirrors the
// CTA CANCELLATION_PATTERNS set.
const CANCEL_RE = /\b(?:cancell?ed|cancellations?|will\s+not\s+operate|annull?ed|not\s+running)\b/i;

// A clock time like "3:59 p.m." / "11:30am". Captures hour, minute, meridiem.
const TIME_RE = /\b(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?/i;

// Origin station named in the cancelled-departure clause, e.g.
// "...departure from Indian Creek is cancelled" → "Indian Creek". Run of words
// after "from", stopping before the linking verb + cancellation keyword. The
// linking-verb group is what halts the (lazy) name capture: MARTA writes both
// "from Indian Creek IS cancelled" and "from Doraville WAS canceled", and
// because this regex carries the /i flag, [A-Z] also matches lowercase — so
// without an explicit verb stop the lazy run would happily swallow "was" into
// the origin ("Doraville was"). Enumerate the verbs MARTA actually uses so the
// capture ends at the station name while still allowing a leading article
// ("from the Airport cancelled" → "the Airport"). Optional overall.
const ORIGIN_RE =
  /\bfrom\s+([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*)*?)\s+(?:(?:is|was|were|are|has\s+been|have\s+been|had\s+been|will\s+(?:not\s+)?be)\s+)?(?:cancel|will\s+not\s+operate|annull?ed)/i;

// Collapse the dots in "a.m."/"p.m." so they don't masquerade as sentence
// terminators when we split on periods ("the 3:59 p.m. Blue line departure"
// must NOT break after "p."). TIME_RE matches the dotless form too.
function normalizeMeridiem(text) {
  return String(text || '').replace(/\b([ap])\.\s*m\.?/gi, '$1m');
}

// Split prose into sentence-ish clauses so a trailing aside ("Delays continuing
// on the Blue line.") can't pull a time into the cancellation sentence. Run on
// meridiem-normalized text so clock times stay intact.
//
// Don't break after a single-letter initial like "H." or "E.": MARTA names
// stations such as "H. E. Holmes", and splitting there would strand the clock
// time ("the 2:10 p.m. … departure from H.") in one fragment and the
// "cancelled" keyword ("Holmes is cancelled.") in another — so the sentence
// that needs BOTH never forms and the cancellation silently fails to classify.
function sentences(text) {
  return normalizeMeridiem(text)
    .split(/(?<=[.!?])(?<!\b[A-Z]\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Title-case a rail line key/name for display: "blue"/"BLUE" → "Blue".
function titleCaseLine(line) {
  const s = String(line || '').trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// "3:59 p.m." (h, m, meridiem) → { depLabel: "3:59 PM", secOfDay } in ET
// wall-clock seconds-since-midnight. Returns null on an impossible time.
function parseClock(h, m, mer) {
  let hour = Number(h);
  const min = Number(m);
  if (!Number.isFinite(hour) || !Number.isFinite(min) || min > 59) return null;
  const pm = String(mer).toLowerCase() === 'p';
  if (hour === 12) hour = pm ? 12 : 0;
  else if (pm) hour += 12;
  if (hour > 23) return null;
  const depLabel = `${((hour + 11) % 12) + 1}:${String(min).padStart(2, '0')} ${pm ? 'PM' : 'AM'}`;
  return { depLabel, secOfDay: hour * 3600 + min * 60 };
}

// Epoch ms of midnight on `ts`'s calendar day in America/New_York. Pure
// reimplementation of the startOfDayET pattern in src/marta/shared/incidents.js
// (kept inline so this module carries no storage/DB dependency).
function etMidnightMs(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  const offsetMs = d.getTime() - asUtc;
  return Date.UTC(get('year'), get('month') - 1, get('day')) + offsetMs;
}

// Classify a rail alert's text as a single-departure cancellation, or null.
// Returns the TIME-INDEPENDENT descriptor; the caller derives upcoming/cancelled
// state from `now` vs scheduledDepMs.
//   { line, scheduledDepMs, depLabel, origin, title }
//
// The caller is responsible for ensuring the alert is rail-scoped (the website
// only models rail cancellations this way); we focus on the prose.
function classifyRailCancellation({ headline, description, line, anchorTs = Date.now() } = {}) {
  const text = [headline, description].filter(Boolean).join(' \n ');
  if (!text) return null;

  // Find the sentence that names a specific cancelled departure: it must carry
  // BOTH cancellation language and a clock time.
  const sentence = sentences(text).find((s) => CANCEL_RE.test(s) && TIME_RE.test(s));
  if (!sentence) return null;

  const timeMatch = TIME_RE.exec(sentence);
  const clock = timeMatch && parseClock(timeMatch[1], timeMatch[2], timeMatch[3]);
  if (!clock) return null;

  const scheduledDepMs = etMidnightMs(anchorTs) + clock.secOfDay * 1000;
  const originMatch = ORIGIN_RE.exec(sentence);
  const origin = originMatch ? originMatch[1].trim() : null;

  const lineLabel = titleCaseLine(line);
  const linePart = lineLabel ? `${lineLabel} Line ` : '';
  const fromPart = origin ? ` from ${origin}` : '';
  const title = `${clock.depLabel} ${linePart}departure${fromPart} cancelled`;

  return { line: lineLabel || null, scheduledDepMs, depLabel: clock.depLabel, origin, title };
}

module.exports = { classifyRailCancellation };
