/* Generative weekly-volume model — a JS port of ../yootri-rnd/plan_model.py.
   That file is the reference implementation; tests/season.test.js pins this port
   to its numbers. Change the shape here only alongside a finding written back to
   ../yootri-rnd/FINDINGS.md.

   The model is generative rather than fitted. Weekly volume is:

       annual / 52 * multiplier(block, week)

   so `annual` is a *scale*, not a total the season sums to — the default blocks
   cover 27 of 52 weeks and spend ~56% of the budget. Never present the sum of a
   season as an annual figure. */

export const WEEKS_PER_YEAR = 52;

/* Round, hand-chosen starting values expressing a conventional periodization
   shape: a gentle prep block, three progressively heavier base blocks, build
   blocks that trade volume for intensity, then a taper into the race. Nothing
   here is fitted to any published table.

   load     — multiplier for the block's hardest loading week, as a multiple of
              the flat average week (annual / 52).
   recovery — 1-indexed weeks within the block that are recovery weeks.
   ramp     — optional per-block override; [1, 1] holds every loading week flat. */
export const DEFAULT_SEASON = {
  blocks: [
    { name: 'Prep', weeks: 4, load: 0.9, recovery: [], ramp: [1.0, 1.0] },
    { name: 'Base 1', weeks: 4, load: 1.3, recovery: [4] },
    { name: 'Base 2', weeks: 4, load: 1.4, recovery: [4] },
    { name: 'Base 3', weeks: 4, load: 1.5, recovery: [4] },
    // Build blocks hold volume roughly flat: intensity is what rises here, and
    // you cannot raise both at once.
    { name: 'Build 1', weeks: 4, load: 1.3, recovery: [4], ramp: [1.0, 1.0] },
    { name: 'Build 2', weeks: 4, load: 1.25, recovery: [4], ramp: [1.0, 1.0] },
    // Peak tapers — volume comes down into competition, it does not build.
    { name: 'Peak', weeks: 2, load: 1.1, recovery: [], ramp: [1.0, 0.8] },
    { name: 'Race', weeks: 1, load: 0.7, recovery: [] },
  ],
  /* Blocks that are never walked through, only spliced in — see fitToRace.

     A secondary race gets the primary's landing with the first peak week
     removed: one taper week, then the model's own Race week. So Taper is not a
     new opinion about how hard a down week should be, it is the Peak block's
     own second week written out on its own — same load, same ramp position,
     and tests/season.test.js asserts the two are equal rather than close.

     Kept out of `blocks` because `expand`, `seasonWeeks` and `seasonHours` walk
     that list: an interlude in there would add a week to every season and a
     week's hours to every budget. */
  interludes: [
    { name: 'Taper', weeks: 1, load: 1.1, recovery: [], ramp: [0.8, 0.8] },
  ],
  ramp: [0.85, 1.0],
  recovery: 0.7,
  roundTo: 0.5,
};

const norm = (s) => String(s ?? '').trim().toLowerCase();

const allBlocks = (season) => [...season.blocks, ...(season.interludes ?? [])];

export function blockOf(period, season = DEFAULT_SEASON) {
  const hit = allBlocks(season).find((b) => norm(b.name) === norm(period));
  if (!hit) {
    const names = allBlocks(season).map((b) => b.name).join(', ');
    throw new Error(`unknown period ${JSON.stringify(period)}; choose from [${names}]`);
  }
  return hit;
}

/** Weekly volume as a multiple of the flat average week. */
export function multiplier(period, week = 1, season = DEFAULT_SEASON) {
  const b = blockOf(period, season);
  const loading = [];
  for (let i = 1; i <= b.weeks; i++) if (!b.recovery.includes(i)) loading.push(i);

  // Blocks with a single loading pattern accept "all", so callers can ask for a
  // block that doesn't progress week to week without inventing a week number.
  const w = norm(week) === 'all' ? loading[0] : Number(week);
  if (!Number.isInteger(w) || w < 1 || w > b.weeks) {
    throw new Error(`${b.name} has weeks 1..${b.weeks}; got ${JSON.stringify(week)}`);
  }

  if (b.recovery.includes(w)) return season.recovery;

  const [lo, hi] = b.ramp ?? season.ramp;
  const pos = loading.indexOf(w);
  const frac = loading.length === 1 ? hi : lo + ((hi - lo) * pos) / (loading.length - 1);
  return b.load * frac;
}

/** Planned hours for one week. `annualHours` is a scale, not a total. */
export function weeklyHours(annualHours, period, week = 1, season = DEFAULT_SEASON) {
  if (!(annualHours >= 0)) throw new Error('annualHours must be >= 0');
  const hours = (annualHours / WEEKS_PER_YEAR) * multiplier(period, week, season);
  if (!season.roundTo) return hours;
  return Math.round(hours / season.roundTo) * season.roundTo;
}

export function seasonWeeks(season = DEFAULT_SEASON) {
  return season.blocks.reduce((a, b) => a + b.weeks, 0);
}

/** Expand the block model into a flat week-by-week list. */
function expand(season) {
  const out = [];
  for (const b of season.blocks) {
    for (let w = 1; w <= b.weeks; w++) {
      out.push({ block: b.name, week: w, recovery: b.recovery.includes(w) });
    }
  }
  return out;
}

/* Which block names are part of a taper — the run of weeks that comes down into
   a race, whether the season's own or a landing's. One definition, because
   validate.js polices the same set and two regexes would drift. */
const TAPER_FAMILY_RE = /^(Peak|Taper|Race)/i;
export const isTaperBlock = (block) => TAPER_FAMILY_RE.test(String(block ?? ''));

/** How many weeks at the end of the season belong to the race it was built for.
    Read off the block table rather than hardcoded, so it stays right if the
    tail is ever reshaped. */
function primaryTailWeeks(season) {
  let weeks = 0;
  for (let i = season.blocks.length - 1; i >= 0; i--) {
    if (!isTaperBlock(season.blocks[i].name)) break;
    weeks += season.blocks[i].weeks;
  }
  return weeks;
}

/** The closest two races can be and both still get a taper week: a landing
    needs the week before it free, and a race week is not a taper. */
export const MIN_LANDING_GAP = 2;

/** Past this, `fitToRace` is padding the front by repeating the first block
    rather than building a shape for the runway — a long run of Prep and then
    the normal blocks. Structurally valid, not a good plan, so the page and the
    coach both say so before the athlete commits to a date that far out.

    An unfitted guess, like the rest of the coaching numbers: roughly where a
    season stops being one build and starts being two. See
    ../yootri-rnd/FINDINGS.md, 23 Aug. */
export const LONG_RUNWAY_WEEKS = 30;

/**
 * Which secondary races the season model will build for, and why it turned the
 * others down.
 *
 * Exported because three callers need the same answer and must not each derive
 * their own: `fitToRace` splices what this applies, the validator explains what
 * it refused, and the page says so before the athlete commits.
 *
 * @param {object} opts
 * @param {number} opts.weeks      length of the runway
 * @param {number[]} opts.landings absolute weeks the secondary races fall in
 * @returns {{applied: {absWeek: number, taperWeek: number|null}[],
 *            refused: {absWeek: number, reason: string}[]}}
 */
export function planLandings({ weeks, landings = [], season = DEFAULT_SEASON } = {}) {
  const n = Number(weeks);
  // The last weeks are the primary race's own peak and race week — what the
  // whole season was built to arrive at. Nothing overwrites them.
  const firstTailWeek = Number.isInteger(n) && n > 0 ? Math.max(0, n - primaryTailWeeks(season)) : 0;

  const wanted = [...new Set((Array.isArray(landings) ? landings : []).map(Number))]
    .sort((a, b) => (Number.isNaN(a) ? 1 : Number.isNaN(b) ? -1 : a - b));

  const applied = [];
  const refused = [];

  for (const absWeek of wanted) {
    if (!Number.isInteger(absWeek) || absWeek < 0 || absWeek >= n) {
      // Not clamped: clamping would build a taper for a race the season never
      // reaches, which is worse than saying the race is outside it.
      refused.push({ absWeek, reason: 'outside-season' });
      continue;
    }
    if (absWeek >= firstTailWeek) {
      refused.push({ absWeek, reason: 'in-primary-taper' });
      continue;
    }
    const last = applied.at(-1);
    if (last && absWeek - last.absWeek < MIN_LANDING_GAP) {
      refused.push({ absWeek, reason: 'too-close' });
      continue;
    }
    // Week 0 has no week before it to taper in. The race week is still built:
    // a race in the first week of the plan is still a race.
    applied.push({ absWeek, taperWeek: absWeek > 0 ? absWeek - 1 : null });
  }

  return { applied, refused };
}

/** Resolve the block model onto a concrete runway of `weeks`, landing the last
    week on the race.

    A short runway drops weeks from the *front*: the taper and race-specific work
    are what you cannot skip, whereas base volume is what you never got to build.
    A long runway pads the front with prep weeks rather than stretching the taper.

    `landings` are the weeks any *secondary* races fall in. Each one that
    `planLandings` accepts is spliced in as a taper week and a race week, taken
    out of whatever block it landed in. The season does not get longer for them:
    the primary race's date is what decides how long it is.

    Returns plain data — a plan stores this once rather than recomputing it, so a
    later change to the model never silently reshapes an athlete's saved season. */
export function fitToRace({ annualHours, weeks, landings = [], season = DEFAULT_SEASON }) {
  const n = Number(weeks);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`a season needs at least one week; got ${JSON.stringify(weeks)}`);
  }

  const full = expand(season);
  let chosen;

  if (n <= full.length) {
    chosen = full.slice(full.length - n);
  } else {
    const prep = season.blocks[0];
    const pad = [];
    for (let i = 0; i < n - full.length; i++) {
      const w = (i % prep.weeks) + 1;
      pad.push({ block: prep.name, week: w, recovery: prep.recovery.includes(w) });
    }
    chosen = pad.concat(full);
  }

  // `chosen` is already indexed by absolute week, so a landing is a straight
  // splice. Two weeks of whatever block it fell in become the tune-up race's
  // taper and race week; the weeks either side keep the labels they had.
  for (const { absWeek, taperWeek } of planLandings({ weeks: n, landings, season }).applied) {
    chosen[absWeek] = { block: 'Race', week: 1, recovery: false };
    if (taperWeek !== null) chosen[taperWeek] = { block: 'Taper', week: 1, recovery: false };
  }

  return chosen.map((e, i) => ({
    ...e,
    absWeek: i,
    // Carry the multiplier, not just the resulting hours. Downstream rules need
    // to know whether a week is genuinely hard, and that cannot be inferred
    // reliably from volume — in a flat season half the weeks sit below the mean
    // by construction. A load at or above 1.0 is at or above a flat average week.
    load: multiplier(e.block, e.week, season),
    hours: weeklyHours(annualHours, e.block, e.week, season),
  }));
}

/** Total hours the season actually prescribes. Deliberately unrounded, and
    deliberately not equal to `annualHours` — see the note at the top. */
export function seasonHours(annualHours, season = DEFAULT_SEASON) {
  const raw = { ...season, roundTo: null };
  let total = 0;
  for (const b of season.blocks) {
    for (let w = 1; w <= b.weeks; w++) total += weeklyHours(annualHours, b.name, w, raw);
  }
  return total;
}
