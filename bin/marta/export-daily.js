#!/usr/bin/env node
// Export daily MARTA incident counts for the public web calendar.
//
// Usage:
//   node bin/marta/export-daily.js <alerts.json> [output-path]

const Fs = require('node:fs');

const ATLANTA_TZ = 'America/New_York';
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ATLANTA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function atlantaDate(epochMs) {
  return dayFmt.format(new Date(epochMs));
}

function modeKind(mode) {
  // Streetcar counts with rail on the website (the consumer's legacyKind maps
  // streetcar -> train), so the calendar/stats must too — otherwise a
  // streetcar-only day shows 0 in the counts while the incident list still
  // renders the event, and the two surfaces disagree.
  if (mode === 'rail' || mode === 'streetcar') return 'train';
  if (mode === 'bus') return 'bus';
  return null;
}

function ensureDay(byDay, date) {
  let rec = byDay.get(date);
  if (!rec) {
    rec = {
      train_count: 0,
      bus_count: 0,
      train_merged_count: 0,
      bus_merged_count: 0,
      by_line: {},
      by_route: {},
    };
    byDay.set(date, rec);
  }
  return rec;
}

function bumpRoute(rec, kind, route) {
  if (!route) return;
  const target = kind === 'train' ? rec.by_line : rec.by_route;
  target[route] = (target[route] || 0) + 1;
}

function buildDaily(payload) {
  const byDay = new Map();
  let dataStart = payload?.data_start_ts ?? null;

  for (const incident of payload?.incidents ?? []) {
    const ts = incident.lifecycle?.first_seen_ts;
    if (ts == null) continue;
    if (dataStart == null || ts < dataStart) dataStart = ts;

    const kind = modeKind(incident.mode);
    if (!kind) continue;
    const rec = ensureDay(byDay, atlantaDate(ts));
    if (kind === 'train') {
      rec.train_count += 1;
      rec.train_merged_count += 1;
    } else {
      rec.bus_count += 1;
      rec.bus_merged_count += 1;
    }
    for (const route of incident.routes ?? []) bumpRoute(rec, kind, route);
  }

  return {
    generated_at: payload?.generated_at ?? Date.now(),
    data_start_ts: dataStart,
    days: [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, rec]) => ({ date, ...rec })),
  };
}

function main() {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input) {
    console.error('usage: export-daily.js <alerts.json> [output-path]');
    process.exit(2);
  }
  const payload = JSON.parse(Fs.readFileSync(input, 'utf8'));
  const out = `${JSON.stringify(buildDaily(payload))}\n`;
  if (output) Fs.writeFileSync(output, out, 'utf8');
  else process.stdout.write(out);
}

if (require.main === module) main();

module.exports = { buildDaily };
