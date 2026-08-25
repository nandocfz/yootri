/* Running paces, derived from one performance the athlete actually ran.

   A plan says how long to run. It does not say how fast, and "Z2" on a card is
   a label rather than a number — it means something different for every athlete
   who reads it. This module turns one benchmark performance (a distance, and
   the time it took) into the pace bands that give that label a number.

   The arithmetic is Daniels and Gilbert's, published, and not ours. Three
   pieces:

     oxygenCost(v)          the oxygen a given running velocity costs
     fractionAtDuration(t)  the share of VDOT an effort of t minutes can hold
     VDOT = cost / fraction

   and the whole thing runs backwards to get a pace: take a share of VDOT, and
   invert the first equation for the velocity that costs it.

   Two things are ours rather than Daniels', and both are guesses recorded as
   guesses in ../yootri-rnd/FINDINGS.md: `ZONE_FOR_LABEL`, which decides that a
   card reading "Z3–Z4" wants threshold pace, and `MAX_VELOCITY`, the ceiling
   above which a time is a mis-typed or mis-measured one rather than a fast one.

   Pure: numbers in, numbers out. Nothing here reaches into a plan, and nothing
   formats for a locale beyond `formatPace`, which the page asks for explicitly. */

import { parseISO, toISO } from './dates.js';

export const MILE_METERS = 1609.344;

/* Daniels' published bands, as a share of VDOT. Exported as data so they can be
   tuned without reading the code — the same reason adapt.js exports THRESHOLDS. */
export const ZONES = Object.freeze([
  { key: 'easy', label: 'Easy', lo: 0.59, hi: 0.74 },
  { key: 'threshold', label: 'Threshold', lo: 0.83, hi: 0.88 },
  { key: 'interval', label: 'Interval', lo: 0.95, hi: 1.00 },
  { key: 'repetition', label: 'Repetition', lo: 1.05, hi: 1.10 },
]);

/* 25 km/h — 1:26 per kilometre, faster than any human has run one. Anything at
   or above this is a broken GPS trace or a time typed into the wrong box, and
   the honest answer to it is "no VDOT" rather than a very impressive one. */
const MAX_VELOCITY = 25_000 / 60;

/** Oxygen cost of running at `v` metres per minute. */
export function oxygenCost(v) {
  return -4.60 + 0.182258 * v + 0.000104 * v * v;
}

/** The share of VDOT an effort lasting `t` minutes can be held at. */
export function fractionAtDuration(t) {
  return 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t);
}

/** The inverse of `oxygenCost`: the velocity that costs `vo2`. */
export function velocityAtCost(vo2) {
  const a = 0.000104;
  const b = 0.182258;
  return (-b + Math.sqrt(b * b + 4 * a * (vo2 + 4.60))) / (2 * a);
}

const positive = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);

/**
 * The VDOT a benchmark implies, or null when it does not imply one.
 *
 * Total: a missing field, a distance of zero, a negative time and a pace no
 * human has run all come back as null, because every caller here is about to
 * put the answer on screen next to somebody's training.
 */
export function vdotFrom(benchmark) {
  const meters = positive(benchmark?.distanceMeters);
  const seconds = positive(benchmark?.timeSeconds);
  if (!meters || !seconds) return null;

  const minutes = seconds / 60;
  const velocity = meters / minutes;
  if (velocity >= MAX_VELOCITY) return null;

  const vdot = oxygenCost(velocity) / fractionAtDuration(minutes);
  return positive(vdot);
}

/**
 * The four pace bands for a VDOT, in **seconds per kilometre**, fast end first.
 * Null in, null out — a table of NaN rendered onto a session card is worse than
 * no table at all.
 */
export function pacesFrom(vdot) {
  const v = positive(vdot);
  if (!v) return null;

  const secondsPerKm = (share) => 1000 / velocityAtCost(v * share) * 60;

  const out = {};
  for (const zone of ZONES) {
    // The *higher* share of VDOT is the *faster* pace, so it is the low number.
    out[zone.key] = { fast: secondsPerKm(zone.hi), slow: secondsPerKm(zone.lo) };
  }
  return out;
}

/** A pace as "M:SS", per kilometre or — asked for `'mi'` — per mile. */
export function formatPace(secondsPerKm, unit = 'km') {
  const secs = Number(secondsPerKm);
  if (!Number.isFinite(secs) || secs <= 0) return '—';

  // Round before splitting, or 4:59.7 formats as the nonexistent "4:60".
  const total = Math.round(unit === 'mi' ? secs * (MILE_METERS / 1000) : secs);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/* Which pace band a session's existing zone label is asking for.

   The labels are the generator's (`Z2`, `Z3–Z4`, with an en dash) plus the ones
   the frozen legacy template carries. This mapping is a coaching judgement and
   an unfitted guess: it says a card marked Z3 wants threshold pace, and that a
   mixed Z2–Z3 session is predominantly easy. Tune it here.

   Null-prototyped so that a session whose zone reads "constructor" — from a
   hand-edited file, or a model — looks up as unknown rather than as a function. */
export const ZONE_FOR_LABEL = Object.freeze(Object.assign(Object.create(null), {
  'Z1': 'easy',
  'Z2': 'easy',
  'Z1–Z2': 'easy',
  'Z2–Z3': 'easy',
  'Z3': 'threshold',
  'Z4': 'threshold',
  'Z2–Z4': 'threshold',
  'Z3–Z4': 'threshold',
  'Z5': 'interval',
}));

/* ---- the benchmark list ------------------------------------------------

   A benchmark is a result the athlete entered — typed in, picked out of an
   exported activity file, or pulled from a connected account. The list carries
   however many they have kept, and exactly one of them is flagged `current`:
   the one every pace on screen is derived from.

   That is deliberately the same shape as the event list, and the functions
   below mirror events.js one for one. The invariant is the same ("there is
   never more than one of it"), the input is equally untrusted, and having two
   lists in this app that behave differently would be a worse cost than the
   duplication. */

export const BENCHMARK_SOURCES = ['manual', 'file', 'strava'];

const text = (v) => String(v ?? '').trim();

/**
 * One benchmark in canonical form, or null when it is not usable — no id, an
 * unreadable date, a missing distance or time, or a pace no human has run.
 * Total: bad input is dropped, not thrown, because benchmarks arrive from
 * storage, from imported plan files and from parsed activity exports.
 *
 * @param {object} raw
 * @param {object} [opts]
 * @param {string} [opts.id] id to use when `raw` has none (a new benchmark)
 */
export function normalizeBenchmark(raw, { id } = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const benchmarkId = text(raw.id) || text(id);
  const date = toISO(parseISO(raw.date));
  if (!benchmarkId || !date) return null;

  const distanceMeters = positive(Number(raw.distanceMeters));
  const timeSeconds = positive(Number(raw.timeSeconds));
  if (!distanceMeters || !timeSeconds) return null;

  // Refuse at the door anything no pace can be derived from. Storing it would
  // put a benchmark on screen with a blank pace table beside it and no way for
  // the athlete to find out which of the two numbers they mis-typed.
  if (vdotFrom({ distanceMeters, timeSeconds }) === null) return null;

  return {
    id: benchmarkId,
    date,
    distanceMeters,
    timeSeconds,
    source: BENCHMARK_SOURCES.includes(raw.source) ? raw.source : 'manual',
    label: text(raw.label),
    current: raw.current === true,
  };
}

/**
 * A whole list in canonical form: usable benchmarks only, one per id, in date
 * order, with at most one flagged current.
 *
 * When a record claims two current benchmarks the **more recent** one wins.
 * That case only comes from data this app did not write — `upsertBenchmark`
 * stands the previous one down before it gets here — so the rule only has to be
 * deterministic. Of two claims about how fit somebody is *now*, the newer one
 * is the better claim, which is where this parts company with the event list's
 * earliest-wins goal rule.
 */
export function normalizeBenchmarks(list) {
  const seen = new Set();
  const benchmarks = (Array.isArray(list) ? list : [])
    .map((raw) => normalizeBenchmark(raw))
    .filter((b) => {
      if (!b || seen.has(b.id)) return false;
      seen.add(b.id);
      return true;
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let claimed = false;
  for (let i = benchmarks.length - 1; i >= 0; i--) {
    if (!benchmarks[i].current) continue;
    if (claimed) benchmarks[i] = { ...benchmarks[i], current: false };
    claimed = true;
  }
  return benchmarks;
}

/** The benchmark every pace is derived from, or null when nothing is flagged. */
export function currentBenchmark(benchmarks) {
  return (Array.isArray(benchmarks) ? benchmarks : []).find((b) => b && b.current) ?? null;
}

/**
 * Add a benchmark, or replace the one with the same id. Flagging one as current
 * stands the previous current down, so the invariant holds by construction
 * rather than by whoever normalizes last. A benchmark that cannot be stored
 * leaves the list exactly as it was.
 */
export function upsertBenchmark(benchmarks, benchmark) {
  const list = Array.isArray(benchmarks) ? benchmarks : [];
  const next = normalizeBenchmark(benchmark);
  if (!next) return list;

  const others = list
    .filter((b) => b && b.id !== next.id)
    .map((b) => (next.current && b.current ? { ...b, current: false } : b));

  return normalizeBenchmarks([...others, next]);
}

export function removeBenchmark(benchmarks, id) {
  return normalizeBenchmarks((Array.isArray(benchmarks) ? benchmarks : []).filter((b) => b && b.id !== id));
}

/**
 * Everything the page and the coach need in one read: the benchmark in use, the
 * VDOT it implies, and the four pace bands. Null when nothing is flagged
 * current — there is no house default pace, and inventing one would be worse
 * than an empty panel that says why it is empty.
 */
export function paceTableFor(benchmarks) {
  const benchmark = currentBenchmark(benchmarks);
  if (!benchmark) return null;

  const vdot = vdotFrom(benchmark);
  const zones = pacesFrom(vdot);
  if (!zones) return null;

  return { benchmark, vdot, zones };
}
