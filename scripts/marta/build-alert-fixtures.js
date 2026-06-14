#!/usr/bin/env node
// Build official-alert test fixtures.
//
//   service-alerts-empty.pb      — the REAL feed captured while no alerts were
//                                   active (proves the empty-feed path). Copied
//                                   from the latest capture if present, else a
//                                   freshly encoded empty FeedMessage.
//   service-alerts-synthetic.pb  — a SYNTHETIC ServiceAlerts feed we encode here
//                                   to exercise the parser, because MARTA's live
//                                   feed was empty at first discovery. Replace
//                                   the synthetic fixture with a trimmed REAL
//                                   capture once scripts/marta/capture-alerts.js
//                                   catches a genuine alert (and confirm the
//                                   informedEntity.routeId form then).
const Fs = require('node:fs');
const Path = require('node:path');
const GtfsRt = require('gtfs-realtime-bindings');

const FeedMessage = GtfsRt.transit_realtime.FeedMessage;
const { Cause, Effect } = GtfsRt.transit_realtime.Alert;
const CAPTURES = Path.join(__dirname, '..', '..', 'data', 'marta', 'captures');
const OUT = Path.join(__dirname, '..', '..', 'test', 'marta', 'fixtures');

function en(text) {
  return { translation: [{ language: 'en', text }] };
}

function buildSynthetic() {
  // Two representative alerts: a rail line suspension and a bus detour. Field
  // shapes follow GTFS-rt; values are invented. NOTE: routeId form here is a
  // guess (rail line name / public bus number) pending a real capture.
  const now = 1_781_400_000;
  const feed = {
    header: { gtfsRealtimeVersion: '2.0', incrementality: 'FULL_DATASET', timestamp: now },
    entity: [
      {
        id: 'marta-synthetic-rail-1',
        alert: {
          activePeriod: [{ start: now, end: now + 3600 }],
          informedEntity: [{ routeId: 'RED', routeType: 1 }],
          cause: Cause.MAINTENANCE,
          effect: Effect.NO_SERVICE,
          headerText: en('Red Line: No service between Airport and Five Points'),
          descriptionText: en(
            'Red Line trains are not running between Airport and Five Points due to track maintenance. Shuttle buses are operating.',
          ),
          url: en('https://itsmarta.com/alerts'),
        },
      },
      {
        id: 'marta-synthetic-bus-1',
        alert: {
          activePeriod: [{ start: now }],
          informedEntity: [{ routeId: '20', stopId: '500350' }],
          cause: Cause.CONSTRUCTION,
          effect: Effect.DETOUR,
          headerText: en('Route 20: Detour on Peachtree St'),
          descriptionText: en(
            'Route 20 is detouring around Peachtree St construction; some stops are missed.',
          ),
        },
      },
    ],
  };
  return Buffer.from(FeedMessage.encode(FeedMessage.fromObject(feed)).finish());
}

function main() {
  Fs.mkdirSync(OUT, { recursive: true });

  const realEmpty = Path.join(CAPTURES, 'service-alerts-latest.pb');
  let emptyBuf;
  if (Fs.existsSync(realEmpty)) {
    emptyBuf = Fs.readFileSync(realEmpty);
    // Guard: only use it as the "empty" fixture if it really is empty.
    const n = FeedMessage.decode(new Uint8Array(emptyBuf)).entity.length;
    if (n !== 0) {
      console.log(`  note: latest capture has ${n} alerts — use it for the real fixture instead`);
    }
  } else {
    emptyBuf = Buffer.from(
      FeedMessage.encode(
        FeedMessage.fromObject({
          header: { gtfsRealtimeVersion: '2.0', incrementality: 'FULL_DATASET', timestamp: 0 },
          entity: [],
        }),
      ).finish(),
    );
  }

  Fs.writeFileSync(Path.join(OUT, 'service-alerts-empty.pb'), emptyBuf);
  Fs.writeFileSync(Path.join(OUT, 'service-alerts-synthetic.pb'), buildSynthetic());
  console.log(`Alert fixtures written → ${OUT}`);
  console.log(`  service-alerts-empty.pb ${emptyBuf.length}B`);
}

main();
