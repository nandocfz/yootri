import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MILE_METERS, ZONES, ZONE_FOR_LABEL,
  oxygenCost, fractionAtDuration, velocityAtCost, vdotFrom, pacesFrom, formatPace,
  normalizeBenchmark, normalizeBenchmarks, currentBenchmark, upsertBenchmark, removeBenchmark,
  paceTableFor,
} from '../assets/coach/paces.js';

/* The running-pace model. A single benchmark performance — a distance and the
   time it took — is turned into a VDOT, and VDOT into the pace bands that
   should govern a Run session.

   The arithmetic is Daniels and Gilbert's, not ours, so the tests that matter
   most are the ones pinning it to their published table: if a row of that table
   comes back with the wrong VDOT, the formula has been mistyped. */

const close = (got, want, tol, msg) =>
  assert.ok(Math.abs(got - want) <= tol, `${msg ?? ''} expected ${want} ± ${tol}, got ${got}`);

/* ---- the three formulas ---- */

test('oxygen cost is the published quadratic in metres per minute', () => {
  // -4.60 + 0.182258(250) + 0.000104(250²) = 47.4645, by hand.
  close(oxygenCost(250), 47.4645, 1e-9);
  close(oxygenCost(0), -4.60, 1e-9);
});

test('the fraction of VDOT sustainable falls as the effort gets longer', () => {
  // A three-minute effort runs above VDOT; an hour of it runs well below.
  assert.ok(fractionAtDuration(3) > 1, 'a very short effort exceeds 100%');
  assert.ok(fractionAtDuration(30) < fractionAtDuration(10));
  assert.ok(fractionAtDuration(120) < fractionAtDuration(60));
  close(fractionAtDuration(40), 0.9137614442697204, 1e-12);
});

test('velocity inverts oxygen cost, so a pace survives the round trip', () => {
  for (const v of [120, 200, 250, 333.3, 400]) {
    close(velocityAtCost(oxygenCost(v)), v, 1e-9, `at ${v} m/min`);
  }
});

/* ---- against Daniels' published VDOT table ----

   Nine rows, five fitness levels, two distances each. They agree to better than
   0.06 of a VDOT point, which is far tighter than any coaching decision cares
   about — and tight enough that a transposed digit in a constant would show. */

test('published race times come back as their published VDOT', () => {
  const rows = [
    ['VDOT 30', 5000, 30 * 60 + 40, 30],
    ['VDOT 30', 10000, 63 * 60 + 46, 30],
    ['VDOT 40', 5000, 24 * 60 + 8, 40],
    ['VDOT 40', 10000, 50 * 60 + 3, 40],
    ['VDOT 50', 5000, 19 * 60 + 57, 50],
    ['VDOT 50', 10000, 41 * 60 + 21, 50],
    ['VDOT 60', 5000, 17 * 60 + 3, 60],
    ['VDOT 60', 10000, 35 * 60 + 22, 60],
    ['VDOT 70', 5000, 14 * 60 + 55, 70],
  ];
  for (const [label, distanceMeters, timeSeconds, want] of rows) {
    close(vdotFrom({ distanceMeters, timeSeconds }), want, 0.06, label);
  }
});

test('a faster time over the same distance is a higher VDOT', () => {
  const slower = vdotFrom({ distanceMeters: 10000, timeSeconds: 2520 });
  const faster = vdotFrom({ distanceMeters: 10000, timeSeconds: 2400 });
  assert.ok(faster > slower);
});

/* ---- a benchmark that cannot mean anything ---- */

test('an unusable benchmark is null rather than a number nobody should trust', () => {
  assert.equal(vdotFrom(null), null);
  assert.equal(vdotFrom({}), null);
  assert.equal(vdotFrom({ distanceMeters: 0, timeSeconds: 2400 }), null);
  assert.equal(vdotFrom({ distanceMeters: 10000, timeSeconds: 0 }), null);
  assert.equal(vdotFrom({ distanceMeters: -10000, timeSeconds: 2400 }), null);
  assert.equal(vdotFrom({ distanceMeters: 10000, timeSeconds: -1 }), null);
  assert.equal(vdotFrom({ distanceMeters: '10k', timeSeconds: 2400 }), null);
});

test('a physically impossible pace is refused, not extrapolated', () => {
  // 10 km in four minutes is 150 km/h. There is no VDOT for that.
  assert.equal(vdotFrom({ distanceMeters: 10000, timeSeconds: 240 }), null);
});

/* ---- the zone table ---- */

test('the four zones are exported as data, so the bands are tunable', () => {
  assert.deepEqual(ZONES.map((z) => z.key), ['easy', 'threshold', 'interval', 'repetition']);
  for (const z of ZONES) {
    assert.ok(z.lo > 0 && z.hi > z.lo, `${z.key} has a band`);
    assert.ok(typeof z.label === 'string' && z.label.length, `${z.key} has a label`);
  }
});

test('paces come back in seconds per kilometre, fast end first', () => {
  const paces = pacesFrom(vdotFrom({ distanceMeters: 10000, timeSeconds: 2520 }));

  // Computed from the formulas above for VDOT 49.0644.
  close(paces.easy.fast, 298.0303, 0.01);
  close(paces.easy.slow, 357.2077, 0.01);
  close(paces.threshold.fast, 259.1288, 0.01);
  close(paces.threshold.slow, 271.6817, 0.01);
  close(paces.interval.fast, 233.6365, 0.01);
  close(paces.interval.slow, 243.5543, 0.01);
  close(paces.repetition.fast, 216.2629, 0.01);
  close(paces.repetition.slow, 224.5751, 0.01);
});

test('every zone is faster than the one below it', () => {
  const p = pacesFrom(52);
  assert.ok(p.easy.fast > p.threshold.slow);
  assert.ok(p.threshold.fast > p.interval.slow);
  assert.ok(p.interval.fast > p.repetition.slow);
});

test('no VDOT means no paces, rather than a table of NaN', () => {
  assert.equal(pacesFrom(null), null);
  assert.equal(pacesFrom(0), null);
  assert.equal(pacesFrom(-5), null);
});

/* ---- formatting ---- */

test('a pace formats as minutes and seconds', () => {
  assert.equal(formatPace(252), '4:12');
  assert.equal(formatPace(300), '5:00');
  assert.equal(formatPace(305.6), '5:06');
  assert.equal(formatPace(65), '1:05');
});

test('a pace can be asked for per mile instead', () => {
  // 4:12/km is 6:45/mile.
  assert.equal(formatPace(252, 'mi'), '6:46');
  assert.equal(MILE_METERS, 1609.344);
});

test('a pace that is not a number formats as nothing, not "NaN:NaN"', () => {
  assert.equal(formatPace(null), '—');
  assert.equal(formatPace(NaN), '—');
});

/* ---- mapping the zone labels sessions already carry ---- */

test('the zone labels the generator writes map onto pace zones', () => {
  assert.equal(ZONE_FOR_LABEL['Z2'], 'easy');
  assert.equal(ZONE_FOR_LABEL['Z1–Z2'], 'easy');
  assert.equal(ZONE_FOR_LABEL['Z3–Z4'], 'threshold');
  assert.equal(ZONE_FOR_LABEL['Z5'], 'interval');
});

test('an unknown zone label maps to nothing rather than guessing', () => {
  assert.equal(ZONE_FOR_LABEL['—'], undefined);
  assert.equal(ZONE_FOR_LABEL['Z9'], undefined);
});

/* ---- the benchmark list ------------------------------------------------

   A benchmark is a result the athlete entered. The list follows the same shape
   as the event list, for the same reason: exactly one of them is flagged, and
   that invariant has to survive whatever arrives from storage or from a plan
   file somebody else wrote. */

const tenK = {
  id: 'bm-1',
  date: '2026-06-15',
  distanceMeters: 10000,
  timeSeconds: 2520,
  source: 'manual',
  label: 'Sentrumsløpet',
  current: true,
};

test('a benchmark keeps what it was given', () => {
  const b = normalizeBenchmark(tenK);
  assert.equal(b.id, 'bm-1');
  assert.equal(b.date, '2026-06-15');
  assert.equal(b.distanceMeters, 10000);
  assert.equal(b.timeSeconds, 2520);
  assert.equal(b.source, 'manual');
  assert.equal(b.label, 'Sentrumsløpet');
  assert.equal(b.current, true);
});

test('a date is canonicalised so two spellings of one day are one day', () => {
  assert.equal(normalizeBenchmark({ ...tenK, date: '2026-6-5' }).date, '2026-06-05');
});

test('a benchmark with no distance or no time is not a benchmark', () => {
  assert.equal(normalizeBenchmark({ ...tenK, distanceMeters: 0 }), null);
  assert.equal(normalizeBenchmark({ ...tenK, timeSeconds: null }), null);
  assert.equal(normalizeBenchmark({ ...tenK, distanceMeters: 'ten km' }), null);
});

test('a benchmark with no date is not a benchmark', () => {
  // Every use of a benchmark is "how fit were you, and when" — undated, it
  // cannot be compared against another or aged out.
  assert.equal(normalizeBenchmark({ ...tenK, date: null }), null);
  assert.equal(normalizeBenchmark({ ...tenK, date: 'last June' }), null);
});

test('a benchmark without an id is dropped rather than given a colliding one', () => {
  const { id, ...anon } = tenK;
  assert.equal(normalizeBenchmark(anon), null);
  assert.equal(normalizeBenchmark(anon, { id: 'bm-9' }).id, 'bm-9');
});

test('an unrecognised source falls back rather than being invented', () => {
  assert.equal(normalizeBenchmark({ ...tenK, source: 'a friend told me' }).source, 'manual');
  assert.equal(normalizeBenchmark({ ...tenK, source: 'file' }).source, 'file');
  assert.equal(normalizeBenchmark({ ...tenK, source: 'strava' }).source, 'strava');
});

test('a benchmark nobody can derive a pace from is refused at the door', () => {
  // Same ceiling as vdotFrom: storing it would put a card on screen with no
  // pace on it and no way to find out why.
  assert.equal(normalizeBenchmark({ ...tenK, timeSeconds: 240 }), null);
});

test('a list keeps one benchmark per id, in date order', () => {
  const list = normalizeBenchmarks([
    { ...tenK, id: 'b', date: '2026-06-15' },
    { ...tenK, id: 'a', date: '2026-03-01', current: false },
    { ...tenK, id: 'b', date: '2026-09-01', current: false },
    null,
    { nonsense: true },
  ]);
  assert.deepEqual(list.map((b) => b.id), ['a', 'b']);
  assert.equal(list[1].date, '2026-06-15', 'the first entry for an id wins');
});

test('a list arriving with two current benchmarks keeps the more recent one', () => {
  // Only data this app did not write gets here — upsertBenchmark stands the
  // previous one down. The rule just has to be deterministic, and of two claims
  // about how fit somebody is now, the newer one is the better claim.
  const list = normalizeBenchmarks([
    { ...tenK, id: 'old', date: '2025-05-01', current: true },
    { ...tenK, id: 'new', date: '2026-06-15', current: true },
  ]);
  assert.deepEqual(list.filter((b) => b.current).map((b) => b.id), ['new']);
});

test('the current benchmark is the flagged one, or nothing', () => {
  assert.equal(currentBenchmark(normalizeBenchmarks([tenK])).id, 'bm-1');
  assert.equal(currentBenchmark(normalizeBenchmarks([{ ...tenK, current: false }])), null);
  assert.equal(currentBenchmark([]), null);
  assert.equal(currentBenchmark(undefined), null);
});

test('adding a current benchmark stands the previous one down', () => {
  const before = normalizeBenchmarks([tenK]);
  const after = upsertBenchmark(before, {
    ...tenK, id: 'bm-2', date: '2026-08-01', current: true,
  });
  assert.equal(after.length, 2);
  assert.equal(currentBenchmark(after).id, 'bm-2');
  assert.equal(after.find((b) => b.id === 'bm-1').current, false);
});

test('replacing a benchmark by id does not duplicate it', () => {
  const after = upsertBenchmark(normalizeBenchmarks([tenK]), { ...tenK, timeSeconds: 2400 });
  assert.equal(after.length, 1);
  assert.equal(after[0].timeSeconds, 2400);
});

test('a benchmark that cannot be stored leaves the list exactly as it was', () => {
  const before = normalizeBenchmarks([tenK]);
  assert.deepEqual(upsertBenchmark(before, { id: 'x', date: 'never' }), before);
});

test('removing a benchmark removes only that one', () => {
  const two = upsertBenchmark(normalizeBenchmarks([tenK]), { ...tenK, id: 'bm-2', current: true });
  assert.deepEqual(removeBenchmark(two, 'bm-1').map((b) => b.id), ['bm-2']);
  assert.equal(removeBenchmark(two, 'nope').length, 2);
});

/* ---- what the page and the coach actually ask for ---- */

test('a pace table names the benchmark it came from', () => {
  const table = paceTableFor(normalizeBenchmarks([tenK]));
  assert.equal(table.benchmark.id, 'bm-1');
  close(table.vdot, 49.0644, 0.001);
  close(table.zones.threshold.fast, 259.1288, 0.01);
});

test('no current benchmark means no pace table', () => {
  assert.equal(paceTableFor([]), null);
  assert.equal(paceTableFor(undefined), null);
  assert.equal(paceTableFor(normalizeBenchmarks([{ ...tenK, current: false }])), null);
});
