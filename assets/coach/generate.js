/* Turn one week's hour budget into actual sessions.

   This is the layer the reference model doesn't have: plan_model.py prescribes
   how many hours a week should hold, not what to do in them or on which days.

   Everything here is deterministic — same inputs, same output, no clock and no
   randomness — so a regenerated week is stable and a diff against it is
   meaningful. The engine never invents time: if the budget exceeds what the
   athlete actually has, it fills the available time and reports the shortfall
   rather than quietly scheduling a week that cannot happen. */

import { DAYS, allowedDays, maxPerWeek } from './profile.js';
import { minToDur, durToMin, REST_DUR } from './duration.js';
import { dayBudgets } from './shape.js';
import { ZONE_FOR_LABEL } from './paces.js';

const MIN_SESSION = 20; // below this it isn't a session, it's a gesture
const ROUND_TO = 5;

/* Per-discipline shaping. `pref` is the session length the generator aims for
   when deciding how many sessions a discipline's time should be split into;
   `long` weights that discipline's single longest session against its others. */
const DISC = {
  Swim: { pref: 50, min: 25, max: 120, long: 1.2 },
  Bike: { pref: 90, min: 30, max: 360, long: 2.0 },
  Run: { pref: 55, min: 20, max: 180, long: 1.8 },
  Strength: { pref: 45, min: 20, max: 75, long: 1.0 },
};

/* Share of the week each discipline takes, by block family. Hand-chosen to
   express a conventional shape — base builds aerobic volume, build trades some
   swim and strength time for run intensity, peak is bike-and-run specific.
   Not fitted to anything; see ../yootri-rnd/FINDINGS.md. */
const SPLITS = {
  Prep: { Swim: 0.25, Bike: 0.35, Run: 0.25, Strength: 0.15 },
  Base: { Swim: 0.22, Bike: 0.43, Run: 0.25, Strength: 0.1 },
  Build: { Swim: 0.18, Bike: 0.45, Run: 0.3, Strength: 0.07 },
  Peak: { Swim: 0.15, Bike: 0.47, Run: 0.33, Strength: 0.05 },
  Race: { Swim: 0.2, Bike: 0.4, Run: 0.4 },
};

/* Long-session targets, in minutes, by race distance.

   Anchored to race demand rather than to weekly volume. A 70.3 bike leg takes
   roughly three hours whether you train six hours a week or eighteen, so the
   long ride should stop growing once it reaches that — extra weekly volume is
   better spent on another session than on a fourth hour in the saddle. The
   athlete with less time needs the race-specific session *more*, not less.
   Strength has no race-day equivalent and so has no entry.

   sprint and olympic are no longer offered as distances (see RACE_TYPES in
   events.js) but keep their rows here, because a plan is self-contained: a
   season already built for one has to go on being sized and validated as one
   rather than falling back to the default and quietly becoming a 70.3. */
const RACE_DEMAND = {
  sprint: { Swim: 30, Bike: 75, Run: 40 },
  olympic: { Swim: 45, Bike: 105, Run: 60 },
  '70.3': { Swim: 60, Bike: 165, Run: 100 },
  ironman: { Swim: 75, Bike: 300, Run: 150 },
};
const DEFAULT_RACE = '70.3';
// However long the race is, one session should not eat its whole discipline.
const MAX_LONG_SHARE = 0.7;

const demandFor = (raceType) => RACE_DEMAND[raceType] ?? RACE_DEMAND[DEFAULT_RACE];

/**
 * Total race-specific work a distance calls for, in minutes — the sum of the
 * long-session targets above. Exported so the validator can ask whether a
 * plan's volume bears any relation to the race it is aimed at, without a second
 * definition of what each distance demands. Falls back exactly as generation
 * does, so the two never disagree about an unrecognised race type.
 */
export const raceDemandMinutes = (raceType) =>
  Object.values(demandFor(raceType)).reduce((a, b) => a + b, 0);

const FOCUS = {
  Swim: { Prep: 'Technique drills', Base: 'Endurance sets', Build: 'Threshold sets', Peak: 'Race-pace sets', Race: 'Sharpen' },
  Bike: { Prep: 'Endurance spin', Base: 'Long ride', Build: 'Threshold intervals', Peak: 'Race-pace hold', Race: 'Openers' },
  Run: { Prep: 'Easy aerobic', Base: 'Long run', Build: 'Tempo', Peak: 'Race-pace brick run', Race: 'Shakeout' },
  Strength: { Prep: 'Core & stability', Base: 'Core & stability', Build: 'Power & durability', Peak: 'Maintenance', Race: 'Mobility' },
};

const ZONE = {
  Swim: { Prep: 'Z2', Base: 'Z2', Build: 'Z3–Z4', Peak: 'Z3', Race: 'Z2' },
  Bike: { Prep: 'Z2', Base: 'Z2', Build: 'Z3–Z4', Peak: 'Z3', Race: 'Z2' },
  Run: { Prep: 'Z2', Base: 'Z2', Build: 'Z3–Z4', Peak: 'Z3', Race: 'Z1–Z2' },
  Strength: { Prep: '—', Base: '—', Build: '—', Peak: '—', Race: '—' },
};

/* The pace band a Run session is asking for, so a card can turn it into real
   minutes-per-kilometre against whatever benchmark the athlete has now.

   Derived from the session's own zone label rather than from a second block
   table. A card reading "Z3–Z4" beside a band saying "easy" would be the app
   disagreeing with itself in the space of one line, and a second table is how
   that happens. It also means a zone edited by hand — or by the coach — carries
   the matching pace without anything else being told.

   Running only. A swim marked Z3 is not a threshold run. */
const paceZoneFor = (disc, zone) => (disc === 'Run' ? ZONE_FOR_LABEL[zone] : undefined);

/** Map a block name onto its family, so "Base 1".."Base 3" share one shape. */
export function blockFamily(block) {
  const b = String(block ?? '');
  if (b.startsWith('Base')) return 'Base';
  if (b.startsWith('Build')) return 'Build';
  // A Taper week is the Peak block's own down week spliced in for a tune-up
  // race (see `interludes` in season.js), so it wants the peak shape too.
  if (b.startsWith('Peak') || b.startsWith('Taper')) return 'Peak';
  if (b.startsWith('Race')) return 'Race';
  return 'Prep';
}

/** The discipline split for a block: an exact block override beats a family
    override, which beats the built-in default. */
export function resolveSplit(block, profile) {
  const family = blockFamily(block);
  return profile?.splits?.[block] ?? profile?.splits?.[family] ?? SPLITS[family];
}

const roundTo = (n, step = ROUND_TO) => Math.round(n / step) * step;

/** Total training minutes in a set of sessions. */
export function weekMinutes(sessions) {
  return sessions.reduce((a, s) => a + durToMin(s.dur), 0);
}

/** Days a discipline can actually use this week: allowed by the athlete's own
    constraints, and given enough of the week's shape to hold a session. Asking
    `allowedDays` alone would count days the shape leaves empty, and every count
    downstream — how many sessions fit, whether a discipline is worth keeping at
    all — would be answered against days nothing can be placed on. */
function usableDays(profile, disc, budgets) {
  const floor = Math.max(MIN_SESSION, DISC[disc]?.min ?? MIN_SESSION);
  return allowedDays(profile, disc).filter((d) => budgets.perDay[d] >= floor);
}

/** Decide how much of the week each discipline gets, dropping any that has
    nowhere to go or too little time to be worth scheduling, and giving its
    share back to the others. */
function discTargets(target, block, profile, budgets) {
  const split = resolveSplit(block, profile);
  let live = Object.keys(split).filter(
    (d) => usableDays(profile, d, budgets).length > 0 && maxPerWeek(profile, d) > 0,
  );

  // Iterate: dropping a starved discipline raises everyone else's share, which
  // can rescue a discipline that was itself just under the bar.
  for (let guard = 0; guard < live.length + 1; guard++) {
    const sum = live.reduce((a, d) => a + split[d], 0);
    if (sum <= 0) return {};
    const targets = Object.fromEntries(live.map((d) => [d, (target * split[d]) / sum]));
    const starved = live.filter((d) => targets[d] < Math.max(MIN_SESSION, DISC[d].min));
    if (!starved.length) return targets;
    if (starved.length === live.length) {
      // Everything is starved: keep only the single biggest share so the week
      // holds one real session rather than a handful of token ones.
      const best = live.reduce((a, b) => (split[b] > split[a] ? b : a));
      return { [best]: target };
    }
    live = live.filter((d) => !starved.includes(d));
  }
  return {};
}

/** Split one discipline's time into individual session lengths, longest first.
    The first entry is the race-anchored long session where the discipline has
    one; everything else divides what is left. */
function sessionSizes(disc, minutes, profile, raceType, budgets) {
  const cfg = DISC[disc];
  const floor = Math.max(MIN_SESSION, cfg.min);
  const cap = Math.min(maxPerWeek(profile, disc), usableDays(profile, disc, budgets).length);
  const demand = demandFor(raceType)[disc];

  if (!demand) {
    // No race-day equivalent (strength): even split, no long session.
    let n = Math.max(1, Math.min(cap, Math.round(minutes / cfg.pref)));
    while (n > 1 && minutes / n < floor) n--;
    return Array.from({ length: n }, () => Math.min(cfg.max, minutes / n));
  }

  const long = Math.min(demand, minutes * MAX_LONG_SHARE, cfg.max);
  const rest = minutes - long;

  let n = 1 + Math.max(0, Math.min(cap - 1, Math.round(rest / cfg.pref)));
  while (n > 1 && rest / (n - 1) < floor) n--;

  if (n === 1) return [Math.min(cfg.max, minutes)];
  return [long, ...Array.from({ length: n - 1 }, () => rest / (n - 1))].sort((a, b) => b - a);
}

/** Place sessions on days, never exceeding the day's prescribed budget.
    Disciplines with the longest single session are placed first so the long ride
    gets the big day before anything else claims it — and because the shape puts
    the big day where a coach would, that is now Saturday by prescription rather
    than by whichever day happened to have the most room left over. */
function place(targets, profile, family, raceType, budgets) {
  const remaining = { ...budgets.perDay };
  const placed = [];

  const order = Object.keys(targets).sort(
    (a, b) => DISC[b].long * targets[b] - DISC[a].long * targets[a],
  );

  for (const disc of order) {
    const sizes = sessionSizes(disc, targets[disc], profile, raceType, budgets);
    const days = usableDays(profile, disc, budgets);
    const used = new Set();

    for (const [rank, size] of sizes.entries()) {
      // Prefer a day this discipline isn't already on, so sessions spread out;
      // fall back to doubling up only if there's nowhere else with room.
      const pick = (pool) =>
        pool
          .filter((d) => remaining[d] >= Math.max(MIN_SESSION, DISC[disc].min))
          .sort((a, b) => remaining[b] - remaining[a] || DAYS.indexOf(a) - DAYS.indexOf(b))[0];

      const day = pick(days.filter((d) => !used.has(d))) ?? pick(days);
      if (!day) continue;

      const mins = Math.min(size, remaining[day], DISC[disc].max);
      if (mins < Math.max(MIN_SESSION, DISC[disc].min)) continue;

      remaining[day] -= mins;
      used.add(day);
      placed.push({ day, disc, minutes: mins, family, isLong: rank === 0 });
    }
  }
  return { placed, remaining };
}

/** Put something on the days the shape budgeted but the per-discipline pass
    walked past. How many sessions a discipline splits into comes from what that
    discipline wants, which has no way to know the week's shape left a short
    Friday open. Left alone those minutes are unreachable — `reconcile` can only
    grow sessions that already exist — so the week would come in under budget
    with an empty day sitting next to the shortfall.

    The day goes to whichever discipline is furthest below its own target, so
    filling a gap also repairs the split the placement pass could not honour.

    Bounded by what the week still owes, never by the day's own room: with the
    shape switched off a day's "remaining" is its whole availability, and an
    unbounded pass would cheerfully fill seven empty days for a one-hour week. */
function fillGaps(placed, remaining, targets, profile, family, target) {
  const spent = (disc) => placed.reduce((a, s) => a + (s.disc === disc ? s.minutes : 0), 0);
  const count = (disc) => placed.filter((s) => s.disc === disc).length;
  let short = target - placed.reduce((a, s) => a + s.minutes, 0);

  for (const day of DAYS) {
    if (short < MIN_SESSION) break;
    if (remaining[day] < MIN_SESSION) continue;
    if (placed.some((s) => s.day === day)) continue;

    const disc = Object.keys(targets)
      .filter((d) => remaining[day] >= Math.max(MIN_SESSION, DISC[d].min)
        && count(d) < maxPerWeek(profile, d)
        && allowedDays(profile, d).includes(day))
      .sort((a, b) => targets[b] - spent(b) - (targets[a] - spent(a)))[0];
    if (!disc) continue;

    const mins = Math.min(remaining[day], DISC[disc].max, short);
    if (mins < Math.max(MIN_SESSION, DISC[disc].min)) continue;
    remaining[day] -= mins;
    short -= mins;
    placed.push({ day, disc, minutes: mins, family, isLong: false });
  }
}

/** Round to whole 5-minute blocks, then push the total back toward the budget
    using whatever day capacity is left. */
function reconcile(placed, remaining, target) {
  // Round to the nearest block where the day can pay for it, down otherwise —
  // and either way hand the difference back to the day. Rounding a session down
  // frees time that the growth pass below is entitled to spend somewhere else;
  // when `remaining` came from raw availability there was enough slack to hide
  // that, but a day budgeted to the minute has none.
  for (const s of placed) {
    const rounded = roundTo(s.minutes);
    const next = rounded - s.minutes <= remaining[s.day]
      ? rounded
      : Math.floor(s.minutes / ROUND_TO) * ROUND_TO;
    remaining[s.day] += s.minutes - next;
    s.minutes = next;
  }

  const total = () => placed.reduce((a, s) => a + s.minutes, 0);
  const byLongest = [...placed].sort((a, b) => b.minutes - a.minutes);

  // Too little: grow the longest sessions that still have room on their day.
  // Grow the ordinary sessions before the race-anchored long one — the whole
  // point of anchoring it is that it stops growing once it meets race demand.
  const canGrow = (x) => remaining[x.day] >= ROUND_TO && x.minutes + ROUND_TO <= DISC[x.disc].max;
  let guard = 0;
  while (target - total() >= ROUND_TO && guard++ < 200) {
    const s = byLongest.find((x) => !x.isLong && canGrow(x)) ?? byLongest.find(canGrow);
    if (!s) break;
    s.minutes += ROUND_TO;
    remaining[s.day] -= ROUND_TO;
  }

  // Too much: shrink the longest sessions that can afford it.
  guard = 0;
  while (total() - target >= ROUND_TO && guard++ < 200) {
    const s = byLongest.find(
      (x) => x.minutes - ROUND_TO >= Math.max(MIN_SESSION, DISC[x.disc].min),
    );
    if (!s) break;
    s.minutes -= ROUND_TO;
    remaining[s.day] += ROUND_TO;
  }

  return placed;
}

/**
 * Generate one week of sessions.
 *
 * @param {object}  opts
 * @param {number}  opts.hours     planned hours for the week (from the season model)
 * @param {string}  opts.block     block name, e.g. "Base 2"
 * @param {object}  opts.profile   a normalized profile
 * @param {string} [opts.idPrefix] prefix for session ids; callers pass the week
 *                                 key so ids are unique across a whole plan
 * @param {string} [opts.raceDay]  weekday a race falls on this week; nothing is
 *                                 scheduled on it or after it
 * @returns {{sessions: object[], budgetMinutes: number, plannedMinutes: number, shortfallMinutes: number}}
 */
export function generateWeek({ hours, block, profile, idPrefix = 'w', raceDay = null }) {
  const family = blockFamily(block);
  const budgetMinutes = Math.max(0, Math.round((Number(hours) || 0) * 60));

  /* A race week is built around the day the race is on, not around the week it
     happens to sit in. The season model lands the last week *containing* the
     race rather than the last week *ending* on it, so a Saturday race has a
     Sunday after it — and without this the week's biggest remaining day is
     exactly where the placement pass would put a long ride, the day after the
     race. Race day itself carries no session: the race is the event on the
     calendar, and entering it as a twelve-hour session would trip the
     single-session ceiling and distort every volume total on the chart. */
  const raceIndex = DAYS.indexOf(raceDay);
  const closedDays = raceIndex < 0 ? [] : DAYS.slice(raceIndex);

  // The shape table decides how the week falls across its days; availability is
  // only the ceiling that shape is clipped to. `targetMinutes` is what the
  // athlete can actually absorb — where a budget bigger than the week gets cut.
  const budgets = dayBudgets({ budgetMinutes, profile, closedDays });
  const target = budgets.targetMinutes;

  const targets = discTargets(target, block, profile, budgets);
  const { placed, remaining } = place(targets, profile, family, profile.raceType, budgets);
  fillGaps(placed, remaining, targets, profile, family, target);
  reconcile(placed, remaining, target);

  const work = placed
    .filter((s) => s.minutes > 0)
    .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || b.minutes - a.minutes);

  const sessions = [];
  const busy = new Set(work.map((s) => s.day));

  for (const day of DAYS) {
    for (const s of work.filter((x) => x.day === day)) {
      const zone = ZONE[s.disc][family];
      const paceZone = paceZoneFor(s.disc, zone);
      sessions.push({
        id: '',
        day,
        disc: s.disc,
        focus: FOCUS[s.disc][family],
        dur: minToDur(s.minutes),
        zone,
        // Absent rather than undefined on everything that is not a run, so a
        // stored session carries no field it has no use for.
        ...(paceZone ? { paceZone } : {}),
      });
    }
    if (!busy.has(day)) {
      sessions.push({
        id: '',
        day,
        disc: 'Rest',
        focus: 'Recovery & mobility',
        dur: REST_DUR,
        zone: '—',
      });
    }
  }

  sessions.forEach((s, i) => {
    s.id = `${idPrefix}-${i}`;
  });

  const plannedMinutes = weekMinutes(sessions);
  return {
    sessions,
    budgetMinutes,
    plannedMinutes,
    shortfallMinutes: Math.max(0, budgetMinutes - plannedMinutes),
  };
}
