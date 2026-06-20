const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseGtfsTime,
  median,
  hourOfSec,
  tripActiveAt,
  tripInServiceDuringHour,
  headwayFromDepartures,
  dayTypeForCalendarRow,
  dayTypeFor,
  hourFor,
  headwayForShape,
  headwayForRoute,
  tripMinutesForShape,
  activeTripsForRoute,
  inServiceForLineAtHour,
} = require('../../src/marta/bus/schedule');

test('parseGtfsTime handles leading spaces and >24h owl times', () => {
  assert.equal(parseGtfsTime(' 6:20:00'), 6 * 3600 + 20 * 60);
  assert.equal(parseGtfsTime('25:15:00'), 25 * 3600 + 15 * 60);
  assert.equal(parseGtfsTime('00:00:00'), 0);
  assert.equal(parseGtfsTime(''), null);
  assert.equal(parseGtfsTime('nope'), null);
});

test('hourOfSec wraps owl times to 0-23', () => {
  assert.equal(hourOfSec(6 * 3600 + 1800), 6);
  assert.equal(hourOfSec(25 * 3600), 1);
});

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('headwayFromDepartures = median consecutive gap in minutes', () => {
  // departures every 10 min.
  assert.equal(headwayFromDepartures([0, 600, 1200, 1800]), 10);
  // uneven: gaps 10, 20 → median 15.
  assert.equal(headwayFromDepartures([0, 600, 1800]), 15);
  assert.equal(headwayFromDepartures([1200]), null, 'one trip has no headway');
  assert.equal(headwayFromDepartures([]), null);
});

test('tripActiveAt snapshots simultaneous service, including owl trips', () => {
  const h = (n) => n * 3600;
  // Trip 10:00–10:35: active at the 10:30 snapshot, not at 9:30 or 11:30.
  assert.equal(tripActiveAt(h(10), h(10) + 2100, h(10) + 1800), true);
  assert.equal(tripActiveAt(h(10), h(10) + 2100, h(9) + 1800), false);
  assert.equal(tripActiveAt(h(10), h(10) + 2100, h(11) + 1800), false);
  // Owl trip encoded 25:10–25:45 (1:10–1:45 AM) is active at the 1:30 snapshot.
  assert.equal(tripActiveAt(h(25) + 600, h(25) + 2700, h(1) + 1800), true);
  assert.equal(tripActiveAt(null, h(10), h(1)), false);
});

test('tripInServiceDuringHour counts any overlap (flow), not just the :30 snapshot', () => {
  const h = (n) => n * 3600;
  // Trip 10:05–10:25 never touches :30 but is in service during hour 10.
  assert.equal(tripInServiceDuringHour(h(10) + 300, h(10) + 1500, 10), true);
  assert.equal(tripActiveAt(h(10) + 300, h(10) + 1500, h(10) + 1800), false);
  // A long trip 10:50–11:40 overlaps BOTH hours 10 and 11 (counted in each).
  assert.equal(tripInServiceDuringHour(h(10) + 3000, h(11) + 2400, 10), true);
  assert.equal(tripInServiceDuringHour(h(10) + 3000, h(11) + 2400, 11), true);
  assert.equal(tripInServiceDuringHour(h(10) + 3000, h(11) + 2400, 9), false);
  assert.equal(tripInServiceDuringHour(h(10) + 3000, h(11) + 2400, 12), false);
  // Owl trip 25:10–25:45 (1:10–1:45 AM) folds onto hour 1.
  assert.equal(tripInServiceDuringHour(h(25) + 600, h(25) + 2700, 1), true);
  assert.equal(tripInServiceDuringHour(null, h(10), 10), false);
});

test('inServiceForLineAtHour sums a specific hour across directions, null before backfill', () => {
  const now = new Date('2026-06-15T15:30:00-04:00'); // a weekday in ET
  const index = {
    routes: {
      49: {
        0: { inServiceByHour: { weekday: { 14: 4, 15: 6 } } },
        1: { inServiceByHour: { weekday: { 15: 5 } } },
      },
      // Route 84 has only the old activeByHour shape (index predates the fix).
      84: { 0: { activeByHour: { weekday: { 15: 3 } } } },
    },
  };
  // Hour 15 sums both directions; hour 14 only direction 0 has service.
  assert.equal(inServiceForLineAtHour(index, '49', 15, now), 11);
  assert.equal(inServiceForLineAtHour(index, '49', 14, now), 4);
  assert.equal(inServiceForLineAtHour(index, '49', 3, now), null, 'no service that hour');
  assert.equal(inServiceForLineAtHour(index, '84', 15, now), null);
  assert.equal(inServiceForLineAtHour(index, '999', 15, now), null);
});

test('dayTypeForCalendarRow classifies the MARTA service rows', () => {
  const wk = {
    monday: '1',
    tuesday: '1',
    wednesday: '1',
    thursday: '1',
    friday: '1',
    saturday: '0',
    sunday: '0',
  };
  const sat = {
    monday: '0',
    tuesday: '0',
    wednesday: '0',
    thursday: '0',
    friday: '0',
    saturday: '1',
    sunday: '0',
  };
  const sun = {
    monday: '0',
    tuesday: '0',
    wednesday: '0',
    thursday: '0',
    friday: '0',
    saturday: '0',
    sunday: '1',
  };
  const holiday = {
    monday: '0',
    tuesday: '0',
    wednesday: '0',
    thursday: '0',
    friday: '0',
    saturday: '0',
    sunday: '0',
  };
  assert.equal(dayTypeForCalendarRow(wk), 'weekday');
  assert.equal(dayTypeForCalendarRow(sat), 'saturday');
  assert.equal(dayTypeForCalendarRow(sun), 'sunday');
  assert.equal(dayTypeForCalendarRow(holiday), null, 'all-zero holiday service is skipped');
});

test('dayTypeFor / hourFor use America/New_York', () => {
  // 2026-06-15 is a Monday; 15:00 UTC = 11:00 EDT.
  const mon = new Date('2026-06-15T15:00:00Z');
  assert.equal(dayTypeFor(mon), 'weekday');
  assert.equal(hourFor(mon), 11);
  // 2026-06-13 is a Saturday; 17:00 UTC = 13:00 EDT.
  const sat = new Date('2026-06-13T17:00:00Z');
  assert.equal(dayTypeFor(sat), 'saturday');
  assert.equal(hourFor(sat), 13);
});

test('index lookups resolve by shape and route+direction', () => {
  const index = {
    shapes: {
      S1: { headways: { weekday: { 11: 12 } }, durations: { weekday: { 11: 40 } } },
    },
    routes: {
      20: { 0: { headways: { weekday: { 11: 15 } }, activeByHour: { weekday: { 11: 8 } } } },
    },
  };
  const mon11 = new Date('2026-06-15T15:00:00Z');
  assert.equal(headwayForShape(index, 'S1', mon11), 12);
  assert.equal(tripMinutesForShape(index, 'S1', mon11), 40);
  assert.equal(headwayForRoute(index, '20', 0, mon11), 15);
  assert.equal(activeTripsForRoute(index, '20', '0', mon11), 8);
  // Missing shape / off-schedule hour → null.
  assert.equal(headwayForShape(index, 'NOPE', mon11), null);
  assert.equal(headwayForShape(index, 'S1', new Date('2026-06-15T08:00:00Z')), null);
});
