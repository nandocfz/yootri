/* The shape of a week — how one week's hour budget spreads across its seven days.

   `season.js` says how many hours a week holds. `generate.js` says what to do in
   them. Between the two sat a gap nobody owned: *which days*. The generator used
   to seed each day from `profile.availability` and pack greedily, which made
   availability do two incompatible jobs at once — the ceiling ("the most I could
   train on a Wednesday") and the prescription ("what I should train on a
   Wednesday"). Whenever the budget sat below capacity the greedy packer produced
   weeks no coach would write: 47% of a 6.5 h week on Saturday, a 25-minute
   Tuesday, and two accidental rest days.

   This module owns the prescription, so availability can go back to being only a
   ceiling. The table below is the athlete's own, hand-authored per volume — it is
   a coaching opinion, not a fitted model, and belongs with the discipline splits
   in that respect (see ../yootri-rnd/FINDINGS.md).

   Pure and deterministic, like the rest of the engine: no DOM, no clock, no
   randomness. And it never invents time — a day is only ever budgeted up to what
   the athlete said they had. */

import { DAYS, resolveWeekShape } from './profile.js';

const ROUND_TO = 5; // the granularity generate.js already speaks in
// Below this a day's budget cannot hold anything: it is generate.js's own
// MIN_SESSION, and a budget under it is time the week can never spend.
const MIN_DAY = 20;
const EPS = 1e-6;

/* Recommended daily distribution, keyed by the week's total minutes, values in
   minutes for Mon…Sun. Runs from 4:00 (an easy or maintenance week, or a sprint
   athlete's whole season) to 22:30 (ironman volume). It stops there deliberately:
   past that is professional territory, and holding the 22:30 *shape* is a more
   honest answer than extrapolating a column nobody wrote down.

   Every row sums exactly to its key, and `season.js` rounds weekly hours to 0.5 h,
   so in practice a generated week lands on a row rather than between two.

   Note the shape moves with volume rather than scaling: Monday stays empty until
   8:30, and Saturday's share falls from 37.5% of a 4 h week to 21.4% of a 22:30
   one. That is the part a fixed set of day weights could not express, and the
   reason the table is indexed by volume at all. */
export const DEFAULT_SHAPE_TABLE = {
  //     Mon  Tue  Wed  Thu  Fri  Sat  Sun
  240: [   0,  60,   0,  60,   0,  90,  30],
  270: [   0,  60,   0,  45,  30,  90,  45],
  300: [   0,  60,   0,  60,  30,  90,  60],
  330: [   0,  60,  30,  60,  30,  90,  60],
  360: [   0,  75,  30,  60,  45,  90,  60],
  390: [   0,  75,  45,  60,  60,  90,  60],
  420: [   0,  90,  45,  75,  60,  90,  60],
  450: [   0,  90,  45,  75,  60, 120,  60],
  480: [   0,  90,  60,  75,  60, 120,  75],
  510: [  30,  90,  60,  75,  60, 120,  75],
  540: [  45,  90,  60,  90,  60, 120,  75],
  570: [  45,  90,  60,  90,  60, 150,  75],
  600: [  45, 120,  60,  90,  60, 150,  75],
  630: [  60, 120,  60,  90,  60, 150,  90],
  660: [  60, 120,  60,  90,  90, 150,  90],
  690: [  60, 120,  60,  90,  90, 180,  90],
  720: [  60, 120,  60, 120,  90, 180,  90],
  750: [  60, 120,  60, 120,  90, 210,  90],
  780: [  60, 150,  60, 120,  90, 210,  90],
  810: [  60, 150,  60, 120,  90, 210, 120],
  840: [  60, 150,  60, 120,  90, 240, 120],
  870: [  60, 150,  90, 120,  90, 240, 120],
  900: [  60, 150,  90, 150,  90, 240, 120],
  930: [  60, 150,  90, 150, 120, 240, 120],
  960: [  60, 180,  90, 150, 120, 240, 120],
  990: [  60, 180,  90, 150, 120, 240, 150],
  1020: [ 60, 180, 120, 150, 120, 240, 150],
  1050: [ 60, 180, 120, 150, 120, 270, 150],
  1080: [ 60, 180, 120, 180, 120, 270, 150],
  1110: [ 60, 210, 120, 180, 120, 270, 150],
  1140: [ 60, 210, 120, 180, 150, 270, 150],
  1170: [ 60, 210, 120, 180, 150, 270, 180],
  1200: [ 60, 210, 150, 180, 150, 270, 180],
  1230: [ 60, 210, 150, 180, 150, 300, 180],
  1260: [ 60, 210, 150, 210, 150, 300, 180],
  1290: [ 60, 210, 150, 210, 180, 300, 180],
  1320: [ 60, 240, 150, 210, 180, 300, 180],
  1350: [ 60, 240, 150, 210, 180, 300, 210],
};

const keysOf = (table) => Object.keys(table).map(Number).sort((a, b) => a - b);

/**
 * The prescribed day-by-day shape for a week of `weeklyMinutes`, as an array of
 * seven minute figures in `DAYS` order. Always sums to what was asked for.
 *
 * Off-grid budgets interpolate between the rows either side — a pinned week
 * budget need not be a round half-hour. Outside the table the nearest row's
 * shape is scaled, which keeps the answer proportional rather than clipped.
 */
export function shapeRow(weeklyMinutes, table = DEFAULT_SHAPE_TABLE) {
  const want = Math.max(0, Number(weeklyMinutes) || 0);
  const keys = keysOf(table);
  if (!keys.length) return DAYS.map(() => 0);

  const scale = (key) => table[key].map((m) => (m * want) / key);

  if (want <= keys[0]) return scale(keys[0]);
  if (want >= keys.at(-1)) return scale(keys.at(-1));

  const hi = keys.findIndex((k) => k >= want);
  if (keys[hi] === want) return [...table[want]];

  const [a, b] = [keys[hi - 1], keys[hi]];
  const t = (want - a) / (b - a);
  return table[a].map((m, i) => m * (1 - t) + table[b][i] * t);
}

/** Round the water-filled figures to whole `ROUND_TO` blocks without losing or
    inventing minutes: floor everything, then hand the remainder back to the days
    that lost the most to rounding. Ties go to the earlier day, so the result is
    stable rather than dependent on object order. */
function quantize(raw, caps, target) {
  const unit = (m) => m / ROUND_TO;
  const out = {};
  const rem = {};
  for (const d of DAYS) {
    const u = unit(raw[d]);
    out[d] = Math.floor(u + EPS);
    rem[d] = u - out[d];
  }

  const cap = Object.fromEntries(DAYS.map((d) => [d, Math.floor(unit(caps[d]) + EPS)]));
  let short = Math.round(unit(target)) - DAYS.reduce((a, d) => a + out[d], 0);

  const order = [...DAYS].sort((x, y) => rem[y] - rem[x] || DAYS.indexOf(x) - DAYS.indexOf(y));
  for (let pass = 0; pass < DAYS.length && short > 0; pass++) {
    for (const d of order) {
      if (short <= 0) break;
      if (out[d] >= cap[d]) continue;
      out[d]++;
      short--;
    }
  }

  return Object.fromEntries(DAYS.map((d) => [d, out[d] * ROUND_TO]));
}

/** One pass of the prescription: give every unblocked day its share of the
    week, clip each to what the day can hold, and hand what the ceilings turned
    away to the days that still have room. Pure in `blocked`, so the caller can
    try again with a different set of days. */
function prescribe({ weight, avail, fixed, pinned, target, blocked, spread }) {
  const open = DAYS.filter((d) => !Object.hasOwn(fixed, d) && !blocked.has(d));
  const openWeight = open.reduce((a, d) => a + weight[d], 0);
  const rest = target - pinned;

  /* Scaling the row by `rest` rather than looking up a lighter row is what lets
     a week the athlete cannot fully absorb keep the shape its own volume calls
     for, instead of borrowing the shape of a smaller week. */
  const raw = Object.fromEntries(DAYS.map((d) => [d, 0]));
  for (const d of DAYS) {
    if (Object.hasOwn(fixed, d)) raw[d] = fixed[d];
    else if (blocked.has(d)) raw[d] = 0;
    else raw[d] = Math.min(openWeight > 0 ? (weight[d] * rest) / openWeight : 0, avail[d]);
  }

  const roomLeft = (d) => avail[d] - raw[d] > EPS;
  const preferred = spread === 'weekend' ? ['Sat', 'Sun']
    : DAYS.includes(spread) ? [spread] : null;
  const share = (d) => (spread === 'even' ? 1 : weight[d]);
  let left = target - DAYS.reduce((a, d) => a + raw[d], 0);

  // Each pass either fills a day to its ceiling or spends what is left, so this
  // settles well inside the guard.
  for (let guard = 0; guard < DAYS.length * 2 + 2 && left > EPS; guard++) {
    let live = open.filter(roomLeft);
    if (!live.length) break;

    // A named day, or the weekend, takes the overflow first, and only falls back
    // to the rest of the week once it is full.
    if (preferred) {
      const first = live.filter((d) => preferred.includes(d));
      if (first.length) live = first;
    }

    // Days the table gives nothing to still have to take the overflow when
    // there is nowhere else for it to go, or an athlete whose free days the
    // table happens to zero would be handed an empty week.
    const total = live.reduce((a, d) => a + share(d), 0);
    const flat = total <= 0;

    let placed = 0;
    for (const d of live) {
      const want = raw[d] + (left * (flat ? 1 : share(d))) / (flat ? live.length : total);
      const got = Math.min(want, avail[d]);
      placed += got - raw[d];
      raw[d] = got;
    }
    if (placed <= EPS) break;
    left -= placed;
  }

  return raw;
}

/**
 * How many minutes each day of one week should hold.
 *
 * The table gives the shape; `profile.availability` gives the ceiling. Where the
 * two disagree — a rest day the table wants to train on, a Tuesday smaller than
 * it asks for — the minutes are not lost, they are handed to the days that still
 * have room, in proportion to what the table wanted for them. That is what makes
 * "Monday is a full rest day" spread an hour over the other six rather than
 * silently shrink the week.
 *
 * The shape is looked up on the *budget*, not on the clipped target, so an
 * athlete whose week cannot hold the whole budget still gets the shape their
 * volume calls for rather than the shape of a lighter week.
 *
 * `closedDays` are days this *particular* week cannot use — race day and the
 * days after it. They are not a profile edit: availability is the athlete's
 * standing ceiling, and editing it to close a day would still be closing it
 * next week. Closing a day here is exactly a rest day for one week, so the
 * minutes it gives up reappear on the days that are left rather than vanishing.
 *
 * @param {object}  opts
 * @param {number}  opts.budgetMinutes  what the season model asked for
 * @param {object}  opts.profile        a normalized profile
 * @param {string[]} [opts.closedDays]  weekdays this week cannot use at all
 * @param {object} [opts.table]         override the built-in table
 * @returns {{perDay: Record<string, number>, targetMinutes: number}}
 */
export function dayBudgets({ budgetMinutes, profile, closedDays = [], table = DEFAULT_SHAPE_TABLE }) {
  const budget = Math.max(0, Math.round(Number(budgetMinutes) || 0));
  const shut = new Set(Array.isArray(closedDays) ? closedDays : [closedDays]);
  const avail = Object.fromEntries(
    DAYS.map((d) => [d, shut.has(d) ? 0 : profile?.availability?.[d] || 0]),
  );
  const capacity = DAYS.reduce((a, d) => a + avail[d], 0);
  const target = Math.min(budget, capacity);
  const shape = resolveWeekShape(profile);

  // Switched off, a day's whole availability is its budget again — which is what
  // the generator packed against before this module existed. One branch, rather
  // than a second placement algorithm kept alive forever beside the first.
  //
  // The same applies below the table's lightest row. It starts at 4:00 because
  // that is where a week stops being a distribution and becomes one or two
  // sessions; scaling the 4:00 row down to fit an hour shatters it into slivers
  // shorter than anything worth training, and the week then cannot spend its own
  // budget. A pinned "I was ill this week" hour is a real case, so this matters.
  const floor = Math.min(...keysOf(table));
  if (!shape.enabled || budget < floor) return { perDay: { ...avail }, targetMinutes: target };

  const row = shapeRow(budget, table);
  const weight = Object.fromEntries(DAYS.map((d, i) => [d, row[i]]));

  /* Pins come off the top: a pin is an instruction, not a preference. They are
     still capped by the day itself — the engine does not invent time for a pin
     any more than for anything else — and a set of pins that overruns the week
     is scaled back rather than allowed to overspend it. */
  const fixed = {};
  for (const d of DAYS) {
    if (Object.hasOwn(shape.pins ?? {}, d)) fixed[d] = Math.min(shape.pins[d], avail[d]);
  }
  let pinned = Object.values(fixed).reduce((a, b) => a + b, 0);
  if (pinned > target) {
    const squeeze = pinned > 0 ? target / pinned : 0;
    for (const d of Object.keys(fixed)) fixed[d] *= squeeze;
    pinned = target;
  }

  /* A day handed less than a session's worth of time is time the week can never
     spend: the generator has a floor below which it will not schedule, so those
     minutes simply vanish from the plan. It happens whenever the shape has to
     redistribute across more days than the leftover can support — Saturday out
     of action on a 4 h week leaves three days holding fifteen minutes each, and
     the week comes in three quarters of an hour short.

     So drop the smallest such day and try again: with one fewer day to go round,
     the rest clear the floor. One at a time, because dropping all of them at
     once throws away days the next pass would have been able to use. Pins are
     never dropped — a short day the athlete asked for is their business. */
  const blocked = new Set();
  let raw = prescribe({ weight, avail, fixed, pinned, target, blocked, spread: shape.spread });
  const runtOf = (r) => DAYS
    .filter((d) => !Object.hasOwn(fixed, d) && !blocked.has(d) && r[d] > EPS && r[d] < MIN_DAY)
    .sort((a, b) => r[a] - r[b] || DAYS.indexOf(a) - DAYS.indexOf(b))[0];
  const spent = (r) => DAYS.reduce((a, d) => a + r[d], 0);

  for (let guard = 0; guard < DAYS.length && runtOf(raw); guard++) {
    const drop = runtOf(raw);
    blocked.add(drop);
    const next = prescribe({ weight, avail, fixed, pinned, target, blocked, spread: shape.spread });
    // Only keep the retry if it actually spends more of the week. Dropping a day
    // can cost more than the runt was worth when the survivors are already full.
    if (spent(next) + EPS < spent(raw)) { blocked.delete(drop); break; }
    raw = next;
  }

  // A pinned day is capped at its pin, so handing back rounding remainders
  // cannot quietly push it past the figure the athlete asked for.
  const caps = Object.fromEntries(
    DAYS.map((d) => [d, Object.hasOwn(fixed, d) ? fixed[d] : avail[d]]),
  );
  return { perDay: quantize(raw, caps, target), targetMinutes: target };
}
