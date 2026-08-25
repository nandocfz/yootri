/* Deterministic rules that gate anything written into a plan — whether it came
   from the generator, a drag-and-drop, or the coach agent.

   Two levels, and the distinction matters:
     error — the week is not physically possible (more training than hours in
             the day, a session on a day the athlete told us was impossible).
             An apply is blocked.
     warn  — the week is possible but questionable (a steep ramp, a stalled
             taper). Surfaced next to the diff and applied if the athlete says so.

   Coaching judgement stays advisory. The engine refuses to write impossibilities,
   not to overrule the person doing the training. */

import { DAYS, allowedDays, weeklyAvailableMinutes } from './profile.js';
import { raceDemandMinutes } from './generate.js';
import { raceTypeLabel } from './events.js';
import { isTaperBlock } from './season.js';
import { durToMin } from './duration.js';

const MIN_SESSION = 20;
const MAX_SESSION = 6 * 60;
const MAX_RAMP = 1.1; // classic 10%/week guidance
const MAX_LOADING_RUN = 4; // consecutive hard weeks before recovery is overdue
const MAX_BLOCK_STEP = 1.25; // a new block may re-step, but not double
const WEEKS_PER_YEAR = 52; // annual hours is a scale over the year, not a season total
const MIN_SEASON_WEEKS = 4; // below this there is no periodisation to speak of
// Below this fraction of the model's intended week-to-week variation, the season
// has stopped periodising. Unfitted; see ../yootri-rnd/FINDINGS.md for the sweep
// that placed it, and for why "any clipping at all" is the wrong test.
export const MIN_VARIATION_RETAINED = 0.5;
// How far a peak week may exceed the race-specific work its distance calls for.
// This is what stops an athlete with a genuinely empty diary being handed a
// 57-hour week for a sprint: MIN_VARIATION_RETAINED cannot see that, because
// nothing is being clipped. Unfitted, and it has one hard constraint — the New
// plan panel carries the current annual hours across, so a sprint plan starting
// at the stock 500 h (6.0x on an unlimited week) must sit below it.
export const MAX_RACE_DEMAND_MULTIPLE = 7;

const issue = (level, code, weekIndex, message) => ({ level, code, weekIndex, message });

const fmtH = (min) => `${(min / 60).toFixed(1).replace(/\.0$/, '')}h`;

/** Total training minutes in a week. */
export function totalMinutes(sessions) {
  return sessions.reduce((a, s) => a + durToMin(s.dur), 0);
}

/** The biggest week the athlete could actually train, in minutes. The generator
    clips each week to the time available, so this is `min(budget, capacity)` —
    the same model seasonFit uses. */
function peakAchievableMinutes(season, profile) {
  const capacity = weeklyAvailableMinutes(profile);
  return season.reduce(
    (a, w) => Math.max(a, Math.min(Math.round((w.hours ?? 0) * 60), capacity)), 0);
}

/**
 * Is this plan carrying far more volume than its race asks for? Answers with the
 * numbers when it is, and `null` when the plan is proportionate.
 *
 * Judged on what the athlete's week can actually hold, never on the raw budget.
 * Volume nobody has time to do is seasonFit's business; warning twice about one
 * mistake, in two different currencies, would only muddy both.
 */
export function volumeBeyondRace(season, profile) {
  if (!Array.isArray(season) || !season.length || !profile) return null;
  const demandMinutes = raceDemandMinutes(profile.raceType);
  const peakMinutes = peakAchievableMinutes(season, profile);
  if (!demandMinutes || !peakMinutes) return null;

  const multiple = peakMinutes / demandMinutes;
  return multiple > MAX_RACE_DEMAND_MULTIPLE
    ? { peakMinutes, demandMinutes, multiple }
    : null;
}

/**
 * How much of the season model's intended week-to-week variation survives the
 * time the athlete actually has.
 */
export function seasonFit(season, profile) {
  if (!Array.isArray(season) || season.length < MIN_SEASON_WEEKS) return null;

  // No time at all is a different problem, and one the per-day rules already
  // report far more usefully than "your season does not periodise" would.
  const capacityMinutes = weeklyAvailableMinutes(profile);
  if (!capacityMinutes) return null;

  const intended = season.map((w) => Math.round((w.hours ?? 0) * 60));
  const built = intended.map((m) => Math.min(m, capacityMinutes));
  const range = (a) => Math.max(...a) - Math.min(...a);

  // A season with no variation to begin with cannot have lost any. Every week
  // pinned to the same budget is a deliberate choice, not a collapse.
  if (range(intended) <= 0) return null;

  // The model's own multiplier is carried on every week by fitToRace, so the
  // peak is exact rather than re-derived from hours already rounded to 0.5.
  const loads = season.map((w) => w.load).filter((x) => typeof x === 'number');
  const peakLoad = loads.length === season.length ? Math.max(...loads) : null;

  return {
    retained: range(built) / range(intended),
    capacityMinutes,
    clippedWeeks: intended.filter((m) => m > capacityMinutes).length,
    suggestedAnnualHours: peakLoad
      ? Math.round((capacityMinutes / 60) * WEEKS_PER_YEAR / peakLoad / 10) * 10
      : null,
  };
}

/**
 * Check a single week in isolation.
 * @param {object[]} sessions
 * @param {{profile: object, budgetMinutes?: number, weekIndex?: number}} ctx
 */
export function validateWeek(sessions, { profile, budgetMinutes, weekIndex = 0 } = {}) {
  const out = [];

  const perDay = {};
  for (const s of sessions) perDay[s.day] = (perDay[s.day] ?? 0) + durToMin(s.dur);

  for (const d of DAYS) {
    const have = profile.availability[d] || 0;
    const used = perDay[d] ?? 0;
    if (used > have) {
      out.push(
        issue('error', 'day-over-capacity', weekIndex,
          `${d} is scheduled for ${fmtH(used)} but only ${fmtH(have)} is available.`),
      );
    }
  }

  for (const s of sessions) {
    const mins = durToMin(s.dur);
    if (mins === 0) continue; // rest entries are not sessions

    if (mins < MIN_SESSION) {
      out.push(
        issue('warn', 'session-too-short', weekIndex,
          `${s.disc} on ${s.day} is only ${mins} minutes — too short to be worth the trip.`),
      );
    }
    if (mins > MAX_SESSION) {
      out.push(
        issue('warn', 'session-too-long', weekIndex,
          `${s.disc} on ${s.day} is ${fmtH(mins)} — check that is deliberate.`),
      );
    }
    if (s.disc !== 'Rest' && !allowedDays(profile, s.disc).includes(s.day)) {
      out.push(
        issue('error', 'constraint-violated', weekIndex,
          `${s.disc} is scheduled on ${s.day}, which your constraints rule out.`),
      );
    }
  }

  if (Number.isFinite(budgetMinutes)) {
    const planned = totalMinutes(sessions);
    if (planned < budgetMinutes) {
      out.push(
        issue('warn', 'budget-shortfall', weekIndex,
          `Week plans ${fmtH(planned)} against a ${fmtH(budgetMinutes)} budget (${budgetMinutes} min).`),
      );
    }
  }

  return out;
}

/* A race the season model could not build a taper week for, said in the words
   the athlete needs rather than the reason code `planLandings` returns.

   `outside-season` has no entry on purpose. The calendar draws a race beyond
   the end of the plan deliberately — that is exactly the race you have not
   built for yet — so warning about every parked future race would be noise. */
const REFUSED_LANDING = {
  'in-primary-taper': ['race-in-primary-taper',
    'A race here falls inside the taper for the race this season is built around, ' +
    'so no separate taper week was built for it.'],
  'too-close': ['races-too-close',
    'A race here is too close to another race in this plan for both to have a taper ' +
    'week, so only the earlier one has one.'],
};

/**
 * Check a whole season — the rules that only exist across weeks.
 * @param {{absWeek: number, block: string, recovery: boolean, sessions: object[]}[]} weeks
 * @param {object} [ctx]
 * @param {object} [ctx.profile]
 * @param {{absWeek: number, reason: string}[]} [ctx.refusedLandings] races the
 *        season model turned down a taper for; see planLandings in season.js
 */
export function validateSeason(weeks, { profile, refusedLandings } = {}) {
  const out = [];

  weeks.forEach((w, i) => {
    if (profile) out.push(...validateWeek(w.sessions, { profile, weekIndex: w.absWeek ?? i }));
  });

  for (const r of refusedLandings ?? []) {
    const said = REFUSED_LANDING[r?.reason];
    if (said) out.push(issue('warn', said[0], r.absWeek, said[1]));
  }

  /* Is the plan aimed at the race it says it is? A budget can be absurd for a
     distance without ever being clipped — an athlete who reports an empty diary
     has the capacity to absorb it, so seasonFit stays silent by construction.
     Judged on what the week can actually hold, never on the raw budget: volume
     the athlete has no time to do is the flattening rule's business, not this
     one, and warning about training that will never happen helps nobody. */
  const beyond = profile ? volumeBeyondRace(weeks, profile) : null;
  if (beyond) {
    out.push(
      issue('warn', 'volume-beyond-race', null,
        `The hardest week reaches ${fmtH(beyond.peakMinutes)} of training for ` +
        `${raceTypeLabel(profile.raceType) || 'this race'} — around ${Math.round(beyond.multiple)} times ` +
        `the race-specific work the distance itself calls for. Check that the race ` +
        `distance and the annual hours are both right.`),
    );
  }

  /* Has the hour budget outrun the athlete's week badly enough that the season
     no longer periodises? Every week clipped to the same ceiling is not a hard
     week followed by an easy one — it is one flat week repeated, and the taper
     disappears with it. A warn, not an error: the weeks are all buildable, they
     are simply not the season that was asked for. */
  const fit = profile ? seasonFit(weeks, profile) : null;
  if (fit && fit.retained < MIN_VARIATION_RETAINED) {
    const suggestion = fit.suggestedAnnualHours
      ? ` Around ${fit.suggestedAnnualHours} annual hours would periodise within the time you have.`
      : '';
    out.push(
      issue('warn', 'season-flattened', null,
        `${Math.round(profile.annualHours)} annual hours asks for up to ` +
        `${fmtH(Math.max(...weeks.map((w) => Math.round((w.hours ?? 0) * 60))))} in a week ` +
        `against the ${fmtH(fit.capacityMinutes)} you have, so ${fit.clippedWeeks} of ` +
        `${weeks.length} weeks land on the same ceiling and the season barely varies.` +
        suggestion),
    );
  }

  // Ramp is measured against the last *loading* week, and only within a block.
  // The 10%/week convention describes progression inside a build; a new block
  // deliberately re-steps, and the model's own Prep -> Base 1 transition is a
  // 23% step up out of an easy block. Flagging that taught the athlete to
  // ignore every warning the app would ever show. Block transitions get their
  // own, looser ceiling so the reset does not become a blind spot.
  let lastLoading = null;
  let lastBlock = null;
  let blockPeak = null;
  let blockLoaded = false;
  let lastLoadingBlockPeak = null;
  let enteredBlock = false;
  let loadingRun = 0;

  weeks.forEach((w, i) => {
    const idx = w.absWeek ?? i;
    const mins = totalMinutes(w.sessions);
    const block = String(w.block ?? '');

    if (lastBlock !== null && block !== lastBlock) {
      // Measured against the last block that actually *loaded*, not simply the
      // one before. A season can now hold a tune-up race, and a taper week and
      // a race week are deliberate down weeks — resuming training after one is
      // a return to where the athlete was, not a step up from a rest week. Held
      // as the last loading block rather than skipped, so the ceiling still
      // applies coming out of a race and does not become a blind spot.
      if (blockLoaded) lastLoadingBlockPeak = blockPeak;
      blockPeak = null;
      blockLoaded = false;
      lastLoading = null;
      enteredBlock = true;
    }
    lastBlock = block;

    if (w.recovery) {
      loadingRun = 0;
      return;
    }

    if (enteredBlock && lastLoadingBlockPeak !== null && mins > lastLoadingBlockPeak * MAX_BLOCK_STEP) {
      const pct = Math.round((mins / lastLoadingBlockPeak - 1) * 100);
      out.push(
        issue('warn', 'block-step-too-steep', idx,
          `${block} opens ${pct}% above the previous block's hardest week (${fmtH(lastLoadingBlockPeak)} → ${fmtH(mins)}).`),
      );
    }
    enteredBlock = false;

    // A week only accrues fatigue debt if it is actually hard. `load` is the
    // model's own multiplier against a flat average week; where it is missing
    // (hand-built weeks, migrated plans) fall back to counting every non-recovery
    // week, which is conservative rather than silently skipping the rule.
    const isLoading = typeof w.load === 'number' ? w.load >= 1 : true;
    blockLoaded = blockLoaded || isLoading;

    if (isLoading) {
      loadingRun++;
      if (loadingRun > MAX_LOADING_RUN) {
        out.push(
          issue('warn', 'recovery-overdue', idx,
            `${loadingRun} hard weeks in a row without a recovery week.`),
        );
      }
    } else {
      loadingRun = 0;
    }

    if (lastLoading !== null && mins > lastLoading * MAX_RAMP) {
      const pct = Math.round((mins / lastLoading - 1) * 100);
      out.push(
        issue('warn', 'ramp-too-steep', idx,
          `Volume jumps ${pct}% over the previous loading week (${fmtH(lastLoading)} → ${fmtH(mins)}).`),
      );
    }
    lastLoading = mins;
    blockPeak = Math.max(blockPeak ?? 0, mins);
  });

  /* The taper must actually taper: within a run of taper weeks, volume only
     comes down.

     Within a run, and not simply from the first one to the end of the season.
     A season can hold a tune-up race now, and the weeks after its race week are
     the plan resuming rather than a taper going backwards — measured to the end
     this fired on every one of them.

     A run's first week is deliberately not compared with the week before it. A
     race landing straight after a recovery week would read as volume rising
     into the taper when it is the recovery week that was the low point. */
  for (let i = 1; i < weeks.length; i++) {
    if (!isTaperBlock(weeks[i].block) || !isTaperBlock(weeks[i - 1].block)) continue;
    const prev = totalMinutes(weeks[i - 1].sessions);
    const cur = totalMinutes(weeks[i].sessions);
    if (cur > prev) {
      out.push(
        issue('warn', 'taper-not-decreasing', weeks[i].absWeek ?? i,
          `Volume rises into race week (${fmtH(prev)} → ${fmtH(cur)}); the taper should only come down.`),
      );
    }
  }

  return out;
}
