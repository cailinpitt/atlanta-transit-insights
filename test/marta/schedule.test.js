const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseGtfsTime,
  median,
  hourOfSec,
  headwayFromDepartures,
  dayTypeForCalendarRow,
  dayTypeFor,
  hourFor,
  headwayForShape,
  headwayForRoute,
  tripMinutesForShape,
  activeTripsForRoute,
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
