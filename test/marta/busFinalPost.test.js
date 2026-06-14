const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const { spawnSync } = require('node:child_process');

const TMP_DB = Path.join(Os.tmpdir(), `marta-busfinal-test-${process.pid}-${Date.now()}.sqlite`);
process.env.MARTA_HISTORY_DB_PATH = TMP_DB;

const storage = require('../../src/marta/storage');
const incidents = require('../../src/marta/shared/incidents');
const { formatGhostLine } = require('../../src/marta/bus/ghostPost');
const { buildPostText, buildAltText } = require('../../src/marta/bus/speedmapPost');

test.after(() => {
  storage.closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try {
      Fs.unlinkSync(TMP_DB + ext);
    } catch {
      /* best effort */
    }
  }
});

test('formatGhostLine summarizes missing buses and effective headway', () => {
  const line = formatGhostLine(
    {
      route: '20',
      direction: '0',
      expectedActive: 10,
      observedActive: 4,
      missing: 6,
      headway: 8,
    },
    'Route 20 (Peachtree St)',
  );
  assert.match(line, /Route 20 \(Peachtree St\) dir 0/);
  assert.match(line, /6 of 10 missing \(60%\)/);
  assert.match(line, /every ~20 min instead of ~8/);
});

test('speedmap post text and alt text describe the route and bands', () => {
  const summary = { avg: 9.25 };
  const start = new Date('2026-06-14T14:00:00Z');
  const end = new Date('2026-06-14T15:00:00Z');
  const text = buildPostText('Route 20 (Peachtree St)', 'Doraville', summary, start, end, [
    'slowest reported in 14 days',
  ]);
  assert.match(text, /^🚦 Route 20 \(Peachtree St\) - Doraville/);
  assert.match(text, /average speed 9\.3 mph/);
  assert.match(text, /📊 slowest reported in 14 days/);
  assert.match(text, /🟥 under 5 mph/);

  const alt = buildAltText('Route 20 (Peachtree St)', 'Doraville', summary);
  assert.match(alt, /Speedmap of Route 20 \(Peachtree St\) doraville/);
  assert.match(alt, /Overall average: 9\.3 mph/);
});

test('speedmap callouts and route rotation use posted history', () => {
  const route = '20';
  const now = 1_781_000_000_000;
  for (const avgMph of [12, 11, 10]) {
    incidents.recordSpeedmap(
      {
        kind: 'bus',
        route,
        direction: 'S1',
        avgMph,
        pctRed: 0,
        pctOrange: 0,
        pctYellow: 0,
        pctGreen: 1,
        binSpeeds: [avgMph],
        posted: true,
      },
      now,
    );
  }
  assert.deepEqual(incidents.speedmapCallouts({ kind: 'bus', route, avgMph: 8 }, now), [
    'slowest reported in 14 days',
  ]);
  assert.equal(incidents.leastRecentlyPostedSpeedmapRoute('bus', ['20', '21']), '21');
});

test('ghost and speedmap bins --check resolve imports', () => {
  for (const name of ['ghosts.js', 'speedmap.js']) {
    const bin = Path.join(__dirname, '..', '..', 'bin', 'marta', 'bus', name);
    const res = spawnSync(process.execPath, [bin, '--check'], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${name}: ${res.stderr}`);
    assert.match(res.stdout, /OK: imports resolved/);
  }
});
