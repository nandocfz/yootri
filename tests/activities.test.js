import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STANDARD_DISTANCES, DISTANCE_TOLERANCE,
  readActivitiesCsv, normalizeActivity, benchmarkCandidates, parseClock,
  trackDistanceMeters, lapTotals,
} from '../assets/coach/activities.js';

/* Reading an activity export, so a benchmark can come out of a season of
   training rather than out of memory.

   Two rules govern everything here. Reading is **total** — a file that is not
   what it claims comes back as a sentence to show the athlete, never as a
   throw. And **heart rate is discarded at the parse boundary**: the columns are
   read past and never enter the returned record, so nothing downstream has to
   remember to strip them. */

/* A Garmin Connect activity export, trimmed to the columns that matter and
   keeping the ones that do not — including the two heart-rate columns, which
   are here precisely so the tests can prove they do not survive. */
const HEADER = 'Activity Type,Date,Favorite,Title,Distance,Calories,Time,Avg HR,Max HR,Avg Pace,Total Ascent';
const csv = (...rows) => [HEADER, ...rows].join('\n');

const RACE_10K = '"Running","2026-06-15 09:32:10","false","Sentrum 10K","10.00","612","00:42:00","168","181","4:12","55"';
const EASY_RUN = '"Running","2026-06-18 06:02:00","false","Morning Run","8.05","480","00:48:30","142","155","6:01","40"';
const A_RIDE = '"Cycling","2026-06-20 10:00:00","false","Long ride","90.00","2400","03:10:00","135","160","2:07","880"';

/* ---- the CSV reader ---- */

test('a Garmin export comes back as activities', () => {
  const out = readActivitiesCsv(csv(RACE_10K, EASY_RUN));
  assert.equal(out.ok, true);
  assert.equal(out.activities.length, 2);

  const [first] = out.activities;
  assert.equal(first.date, '2026-06-15');
  assert.equal(first.distanceMeters, 10000);
  assert.equal(first.timeSeconds, 2520);
  assert.equal(first.title, 'Sentrum 10K');
});

test('heart rate does not survive the parse', () => {
  // The single enforcement point for keeping heart rate out of a stored plan.
  // If this ever fails, the field is one sync away from Firestore.
  const out = readActivitiesCsv(csv(RACE_10K));
  const record = out.activities[0];
  const keys = Object.keys(record).join(' ').toLowerCase();
  assert.equal(keys.includes('hr'), false, `no hr key: ${Object.keys(record)}`);
  assert.equal(keys.includes('heart'), false);
  assert.equal(JSON.stringify(out).includes('168'), false, 'the value is gone too, not just the key');
});

test('only running is read; the bike ride is left where it is', () => {
  const out = readActivitiesCsv(csv(RACE_10K, A_RIDE, EASY_RUN));
  assert.equal(out.activities.length, 2);
  assert.equal(out.activities.every((a) => /run/i.test(a.type)), true);
});

test('trail and treadmill runs count as running', () => {
  const out = readActivitiesCsv(csv(
    '"Trail Running","2026-05-01 09:00:00","false","Hills","10.00","700","01:02:00","150","170","6:12","400"',
    '"Treadmill Running","2026-05-02 09:00:00","false","Indoor","5.00","300","00:24:00","150","170","4:48","0"',
  ));
  assert.equal(out.activities.length, 2);
});

test('a quoted field containing a comma does not split the row', () => {
  const out = readActivitiesCsv(csv(
    '"Running","2026-06-15 09:32:10","false","Oslo, Norway 10K","10.00","612","00:42:00","168","181","4:12","55"',
  ));
  assert.equal(out.activities.length, 1);
  assert.equal(out.activities[0].title, 'Oslo, Norway 10K');
  assert.equal(out.activities[0].distanceMeters, 10000);
});

test('a time can be H:MM:SS or M:SS', () => {
  const out = readActivitiesCsv(csv(
    '"Running","2026-06-15 09:00:00","false","A","10.00","612","1:02:03","168","181","6:12","55"',
    '"Running","2026-06-16 09:00:00","false","B","2.00","120","9:30","168","181","4:45","5"',
  ));
  assert.equal(out.activities[0].timeSeconds, 3723);
  assert.equal(out.activities[1].timeSeconds, 570);
});

test('a file exported in miles is read in miles when it is said to be', () => {
  // Garmin writes the account's own unit and does not say which it used, so the
  // athlete tells us rather than the parser guessing and being confidently wrong.
  const out = readActivitiesCsv(csv(
    '"Running","2026-06-15 09:00:00","false","Ten miles","10.00","612","01:10:00","168","181","7:00","55"',
  ), { unit: 'mi' });
  assert.equal(Math.round(out.activities[0].distanceMeters), 16093);
});

test('a distance written with a thousands separator still reads as a number', () => {
  const out = readActivitiesCsv(csv(
    '"Running","2026-06-15 09:00:00","false","Long","1,234.50","612","02:00:00","168","181","5:50","55"',
  ));
  assert.equal(out.activities[0].distanceMeters, 1234500);
});

test('rows that cannot be read are skipped, not fatal', () => {
  const out = readActivitiesCsv(csv(
    RACE_10K,
    '"Running","not a date","false","X","10.00","612","00:42:00","168","181","4:12","55"',
    '"Running","2026-06-16 09:00:00","false","Y","0","0","00:00:00","168","181","0:00","0"',
    '',
  ));
  assert.equal(out.ok, true);
  assert.equal(out.activities.length, 1);
  assert.equal(out.skipped, 2);
});

/* ---- everything a file can be instead of an export ---- */

test('an empty file says so, in a sentence', () => {
  const out = readActivitiesCsv('');
  assert.equal(out.ok, false);
  assert.match(out.reason, /[a-z]/);
  assert.ok(out.reason.length > 20, 'a reason worth showing, not a code');
});

test('a file with no recognisable columns says which ones it wanted', () => {
  const out = readActivitiesCsv('name,email\nbob,bob@example.com');
  assert.equal(out.ok, false);
  assert.match(out.reason, /Distance|Time/);
});

test('a header with no rows under it is not an error, just nothing', () => {
  const out = readActivitiesCsv(HEADER);
  assert.equal(out.ok, true);
  assert.deepEqual(out.activities, []);
});

test('reading is total: nothing throws, whatever it is handed', () => {
  for (const junk of [null, undefined, 0, ' ', '{"json":true}', 'a'.repeat(50000)]) {
    assert.doesNotThrow(() => readActivitiesCsv(junk));
    const out = readActivitiesCsv(junk);
    assert.equal(out.ok === true && out.activities.length > 0, false);
  }
});

/* ---- the shape the XML paths hand over ---- */

test('an activity parsed elsewhere normalizes the same way', () => {
  // index.html reads TCX and GPX with DOMParser, which an engine module may not
  // touch, and hands the result in here so there is one definition of clean.
  const a = normalizeActivity({ date: '2026-6-5', distanceMeters: '10000', timeSeconds: '2520', type: 'Running' });
  assert.equal(a.date, '2026-06-05');
  assert.equal(a.distanceMeters, 10000);
  assert.equal(a.timeSeconds, 2520);
});

test('an activity that is not usable normalizes to null', () => {
  assert.equal(normalizeActivity(null), null);
  assert.equal(normalizeActivity({ date: '2026-06-05', distanceMeters: 0, timeSeconds: 100 }), null);
  assert.equal(normalizeActivity({ date: 'never', distanceMeters: 10000, timeSeconds: 2520 }), null);
});

/* ---- picking the benchmarks out ---- */

const at = (date, meters, seconds) => ({ date, distanceMeters: meters, timeSeconds: seconds, type: 'Running' });

test('the best effort at each standard distance is offered', () => {
  const candidates = benchmarkCandidates([
    at('2026-06-15', 10000, 2520),
    at('2026-06-01', 10000, 2700),   // same distance, slower - not offered
    at('2026-05-01', 5000, 1180),
    at('2026-04-01', 8000, 2200),    // not a standard distance - not offered
  ], { today: '2026-08-25' });

  assert.deepEqual(candidates.map((c) => c.standard).sort(), ['10k', '5k']);
  assert.equal(candidates.find((c) => c.standard === '10k').timeSeconds, 2520);
});

test('a distance within three percent counts as the standard one', () => {
  const near = benchmarkCandidates([at('2026-06-15', 10250, 2520)], { today: '2026-08-25' });
  assert.equal(near[0].standard, '10k');

  const notNear = benchmarkCandidates([at('2026-06-15', 11000, 2520)], { today: '2026-08-25' });
  assert.deepEqual(notNear, []);
  assert.equal(DISTANCE_TOLERANCE, 0.03);
});

test('candidates come back best first, each with the VDOT it implies', () => {
  const candidates = benchmarkCandidates([
    at('2026-06-15', 10000, 2700),
    at('2026-05-01', 5000, 1140),
  ], { today: '2026-08-25' });

  assert.ok(candidates[0].vdot > candidates[1].vdot);
  assert.ok(candidates.every((c) => c.vdot > 0));
  assert.equal(candidates[0].source, 'file');
});

test('an effort older than the window is not offered as current fitness', () => {
  const old = benchmarkCandidates([at('2024-06-15', 10000, 2400)], { today: '2026-08-25' });
  assert.deepEqual(old, []);

  const kept = benchmarkCandidates([at('2024-06-15', 10000, 2400)], { today: '2026-08-25', days: 3000 });
  assert.equal(kept.length, 1);
});

test('a GPS glitch is not a personal best', () => {
  // 10 km at 30 km/h. The trace is broken, not the athlete transformed.
  assert.deepEqual(benchmarkCandidates([at('2026-06-15', 10000, 1200)], { today: '2026-08-25' }), []);
});

test('nothing usable gives an empty list rather than a wrong suggestion', () => {
  assert.deepEqual(benchmarkCandidates([], { today: '2026-08-25' }), []);
  assert.deepEqual(benchmarkCandidates(null, { today: '2026-08-25' }), []);
});

test('the standard distances are exported as data', () => {
  assert.deepEqual(STANDARD_DISTANCES.map((d) => d.key), ['5k', '10k', 'half', 'marathon']);
  assert.equal(STANDARD_DISTANCES.find((d) => d.key === 'half').meters, 21097.5);
});

/* ---- the clock ---- */

test('a time reads the same typed as exported', () => {
  assert.equal(parseClock('42:00'), 2520);
  assert.equal(parseClock('1:02:03'), 3723);
  assert.equal(parseClock('00:42:00'), 2520);
  assert.equal(parseClock('42:00.5'), 2520.5);
  assert.equal(parseClock('90'), 90);
});

test('anything that is not a time is null, not a number to trust', () => {
  assert.equal(parseClock(''), null);
  assert.equal(parseClock(null), null);
  assert.equal(parseClock('forty two'), null);
  assert.equal(parseClock('1:2:3:4'), null);
  assert.equal(parseClock('-5:00'), null);
});

/* ---- measuring a track ---------------------------------------------------

   A GPX carries no distance, only where you were, so it has to be measured.
   The page walks the XML — `DOMParser` is a browser thing an engine module may
   not touch — but the arithmetic is here, where it can be checked. */

test('a track is measured, and one point is no distance at all', () => {
  assert.equal(trackDistanceMeters([]), 0);
  assert.equal(trackDistanceMeters([{ lat: 59.9139, lon: 10.7522 }]), 0);
  assert.equal(trackDistanceMeters(null), 0);
});

test('five kilometres due north measures five kilometres', () => {
  // 0.0449664 degrees of latitude is 5 km on a sphere of radius 6371 km.
  const pts = [
    { lat: 59.9139, lon: 10.7522 },
    { lat: 59.9363832, lon: 10.7522 },
    { lat: 59.9588664, lon: 10.7522 },
  ];
  assert.ok(Math.abs(trackDistanceMeters(pts) - 5000) < 1, trackDistanceMeters(pts));
});

test('distance east shrinks with the cosine of the latitude', () => {
  // A degree of longitude at 60 degrees north is half what it is at the equator.
  const atEquator = trackDistanceMeters([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }]);
  const atSixty = trackDistanceMeters([{ lat: 60, lon: 0 }, { lat: 60, lon: 1 }]);
  assert.ok(Math.abs(atSixty / atEquator - 0.5) < 0.001);
});

test('a point with no usable coordinates does not poison the total', () => {
  // A trackpoint can arrive without a fix. Better a slightly short track than
  // a NaN that makes the whole activity vanish with no reason given.
  const withHole = trackDistanceMeters([
    { lat: 59.9139, lon: 10.7522 },
    { lat: 'nope', lon: undefined },
    { lat: 59.9588664, lon: 10.7522 },
  ]);
  assert.ok(Number.isFinite(withHole));
});

test('laps add up to the activity', () => {
  assert.deepEqual(
    lapTotals([{ distanceMeters: 5000, timeSeconds: 1260 }, { distanceMeters: 5000, timeSeconds: 1260 }]),
    { distanceMeters: 10000, timeSeconds: 2520 },
  );
  assert.deepEqual(lapTotals([]), { distanceMeters: 0, timeSeconds: 0 });
  assert.deepEqual(lapTotals([{ distanceMeters: 'x' }, { distanceMeters: 100, timeSeconds: 30 }]),
    { distanceMeters: 100, timeSeconds: 30 });
});
