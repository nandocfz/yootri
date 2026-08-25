/* The typed surface the coach agent is allowed to touch.

   This is the safety boundary of the whole feature. The model never writes
   session data: it calls these tools, they call the engine, and the engine
   computes every number. The worst a confused or adversarial model can do is
   produce a draft that the validator rejects at the diff.

   Two rules hold for every tool here:

     1. Writes go into `session.draft`, never into `session.plan`.
     2. A rejected call leaves no draft behind — no half-applied state.

   Reads operate on the draft when one exists, so the model can see the
   consequences of its own pending changes before proposing them. */

import { loadPlan, blockAt, weekCount, sessionsAt, refit, diffPlans, landingsOf, raceDayFor } from './plan.js';
import { normalizeProfile, resolveWeekShape, SPREAD_MODES, DAYS, DISCIPLINES } from './profile.js';
import { generateWeek } from './generate.js';
import { trailingCompliance, weekCompliance } from './actuals.js';
import { suggest } from './adapt.js';
import { seasonFit, volumeBeyondRace } from './validate.js';
import { durToMin } from './duration.js';
import { paceTableFor, formatPace, ZONES } from './paces.js';
import { planLandings, LONG_RUNWAY_WEEKS } from './season.js';
import { weekIndexOf, weekdayOf } from './calendar.js';
import { weeksUntil, parseISO, toISO } from './dates.js';
import {
  EVENT_KINDS, EVENT_PRIORITIES, RACE_TYPES, KNOWN_RACE_TYPES, SECONDARY_RACE_TYPES,
  STORABLE_RACE_TYPES, raceTypeLabel, normalizeEvents, upsertEvent, removeEvent,
  goalEvent, raceFieldsOf,
} from './events.js';

const clone = (x) => structuredClone(x);
const weekKey = (w) => `w${w}`;
const ok = (data) => ({ content: typeof data === 'string' ? data : JSON.stringify(data), isError: false });
const fail = (msg) => ({ content: msg, isError: true });

/** A working session: the stored plan, plus whatever the model has proposed. */
export function createSession(plan) {
  return { plan, draft: null };
}

/** The plan a read should see: the draft if there is one, else the stored plan. */
const current = (s) => s.draft ?? s.plan;

/** Start (or continue) a draft. */
const draftOf = (s) => s.draft ?? clone(s.plan);

/* Week numbering, and the one place it is translated.

   The engine counts `absWeek` from 0. The athlete and the app both count from
   1 — the board says "Week 1 of 16" and the diff says "Week 4". A model handed
   a 0-based tool interface has no way to know that, so "cut week 3" quietly
   became week 4 on screen: both halves were behaving as documented and the
   athlete still got the wrong week.

   So the tools speak the athlete's language. Everything crossing this boundary
   is 1-based in both directions, and the conversion happens here and nowhere
   else — the engine below never sees anything but absWeek. */
const toIndex = (plan, w) => Math.max(0, Math.min((Number(w) || 1) - 1, weekCount(plan) - 1));
const weekLabel = (i) => i + 1;

/** Regenerate a range of weeks from the draft's own profile and season. */
function rebuild(draft, from, to) {
  for (const w of draft.season) {
    if (w.absWeek < from || w.absWeek > to) continue;
    draft.weeks[weekKey(w.absWeek)] = generateWeek({
      hours: w.hours,
      block: w.block,
      profile: draft.profile,
      idPrefix: weekKey(w.absWeek),
      // Or regenerating a range would schedule training on a race day.
      raceDay: raceDayFor(draft, w.absWeek),
    }).sessions;
  }
  return draft;
}

const summariseWeek = (plan, w) => {
  const info = blockAt(plan, w);
  const sessions = sessionsAt(plan, w);
  const c = weekCompliance(plan, w);
  return {
    week: weekLabel(w),
    block: info.block,
    recovery: info.recovery,
    plannedMinutes: c.plannedMinutes,
    actualMinutes: c.actualMinutes,
    sessions: sessions
      .filter((x) => durToMin(x.dur) > 0)
      .map((x) => ({ id: x.id, day: x.day, disc: x.disc, minutes: durToMin(x.dur), focus: x.focus })),
  };
};

/* ---- Events ---------------------------------------------------------------

   The one place the model can change what the season is *for*, rather than how
   it is trained. The safety property is the same as everywhere else here — the
   write lands in `session.draft` and the athlete approves a diff — but the blast
   radius is larger, because making a race primary re-lengths the whole runway.
   So the guards below are deliberately talkative: a refusal the model can read
   and correct is worth more than one it can only retry. */

/** An id for an event the model created. Unlike a session id it is never
    regenerated, so it only has to be unique within the plan. */
const mintEventId = (now = Date.now()) =>
  `ev-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The priority a tool was asked for, as the engine spells it. 'none' is the
    model's word for "a marker on the calendar", which the engine stores as no
    priority at all. */
const PRIORITY_INPUT = [...EVENT_PRIORITIES, 'none'];
const asPriority = (v) => (v === 'none' ? null : v);

const eventsOf = (plan) => normalizeEvents(plan.events);
const findEvent = (plan, id) => eventsOf(plan).find((ev) => ev.id === String(id ?? '')) ?? null;

/** What one event looks like to the model: what it is, and where in the season
    it falls. The week is 1-based, like every other week these tools speak. */
const describeEvent = (plan, ev) => {
  const at = weekIndexOf(plan.start, ev.date);
  return {
    id: ev.id,
    name: ev.name,
    date: ev.date,
    weekday: weekdayOf(ev.date),
    kind: ev.kind,
    raceType: ev.raceType,
    raceTypeName: ev.raceType ? raceTypeLabel(ev.raceType) : null,
    priority: ev.priority ?? 'none',
    // Null rather than clamped: a race the plan does not reach is a real thing
    // to have on the calendar, and saying "week 1" for it would be a lie.
    week: Number.isInteger(at) && at >= 0 && at < weekCount(plan) ? weekLabel(at) : null,
  };
};

/** Whether the season model built a taper for a given secondary race, in the
    words the athlete would be shown. Null when there is nothing to say. */
function landingNote(plan, ev) {
  if (!ev || ev.priority !== 'secondary') return null;
  const at = weekIndexOf(plan.start, ev.date);
  const { applied, refused } = planLandings({ weeks: weekCount(plan), landings: landingsOf(plan) });

  if (applied.some((a) => a.absWeek === at)) {
    return `Week ${weekLabel(at)} is now its race week` +
      (at > 0 ? `, with week ${weekLabel(at - 1)} as a taper week before it.` : '.');
  }
  return {
    'in-primary-taper':
      'It falls inside the taper for the race the season is built around, so no separate taper week was built for it.',
    'too-close':
      'It is too close to another race for both to have a taper week, so only the earlier one has one.',
    'outside-season':
      'It falls outside this season, so it is a marker on the calendar and nothing was built for it.',
  }[refused.find((r) => r.absWeek === at)?.reason] ?? null;
}

/**
 * Write an edited event list into the draft and refit around it.
 *
 * The primary race owns the race date and distance, so this is also the only
 * place they change: they are read back off the list rather than passed in,
 * which is what stops the profile and the calendar disagreeing about the race.
 */
function writeEvents(s, base, next, lead) {
  const events = normalizeEvents(next);
  const race = raceFieldsOf(events);

  const profile = {
    ...base.profile,
    raceDate: race.raceDate,
    // Null means the primary race did not say, so keep the distance the profile
    // already holds rather than overwriting it with nothing.
    ...(race.raceType ? { raceType: race.raceType } : {}),
  };

  // The runway only moves when there is a race to aim it at. With none, the
  // weeks already built stay as they are — they have already been trained.
  const weeks = race.raceDate ? weeksUntil(base.start, race.raceDate) : null;
  const draft = refit({ ...base, events }, {
    profile,
    ...(Number.isFinite(weeks) && weeks > 0 ? { weeks } : {}),
  });
  s.draft = draft;

  const said = [lead];
  if (weekCount(draft) !== weekCount(base)) {
    said.push(`The season is now ${weekCount(draft)} weeks, ending ${race.raceDate}.`);
  }
  if (weekCount(draft) > LONG_RUNWAY_WEEKS) {
    said.push(`That is a long runway: past ${LONG_RUNWAY_WEEKS} weeks the early weeks come out as ` +
      'a repeat of the first block rather than a shape built for them, so a plan starting closer ' +
      'to the date would be a better season. Say so.');
  }
  if (!race.raceDate) {
    said.push('There is no race the season is built around now, so it keeps its current length.');
  }
  return { draft, said };
}

/** Guards shared by every tool that writes an event. Each returns a sentence
    the model can act on, or null when there is nothing wrong. */
function eventProblem(base, { date, kind, raceType, priority }) {
  if (date !== undefined) {
    if (!toISO(parseISO(date))) {
      return `"${date}" is not a date. Use YYYY-MM-DD.`;
    }
    if (toISO(parseISO(date)) < base.start) {
      return `${date} is before this plan starts (${base.start}), so the calendar has nowhere ` +
        'to show it. The athlete would need to move the start date or begin a new plan for that race.';
    }
  }
  if (kind !== undefined && !EVENT_KINDS.includes(kind)) {
    return `"${kind}" is not an event kind. Use one of: ${EVENT_KINDS.join(', ')}.`;
  }
  if (raceType !== undefined && raceType !== null) {
    if (kind === 'other') return 'Only a race carries a distance.';
    if (!STORABLE_RACE_TYPES.includes(raceType)) {
      return `"${raceType}" is not a distance yootri knows. Use one of: ${STORABLE_RACE_TYPES.join(', ')}.`;
    }
  }
  if (priority !== undefined && !PRIORITY_INPUT.includes(priority)) {
    return `"${priority}" is not a priority. Use one of: ${PRIORITY_INPUT.join(', ')}.`;
  }
  if (priority === 'primary') {
    if (kind === 'other') {
      return 'Only a race can be the race the season is built around.';
    }
    if (raceType && !KNOWN_RACE_TYPES.includes(raceType)) {
      return `A ${raceTypeLabel(raceType)} cannot be the race a season is built around: the volume ` +
        `model is sized by race distance and only knows ${RACE_TYPES.map(raceTypeLabel).join(' and ')}. ` +
        'Make it secondary instead — the season will still build a taper week and a race week for it.';
    }
  }
  return null;
}

export const TOOL_DEFS = [
  {
    name: 'get_plan_summary',
    description:
      'Overview of the whole season: number of weeks, the blocks and their lengths, planned hours per week, the athlete\'s annual hour budget and race details. Call this first to orient yourself before proposing anything.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_week',
    description:
      'The sessions in one week, with planned and actual minutes. Use it to check the effect of a change you just made, or to answer a question about a specific week.',
    input_schema: {
      type: 'object',
      properties: { week: { type: 'integer', description: 'Which week of the season, counting from 1 — the same number the athlete sees on the board.' } },
      required: ['week'],
    },
  },
  {
    name: 'get_profile',
    description:
      'The athlete\'s constraints: how many minutes are available each weekday, discipline rules such as "no swimming on Mondays" or a weekly session cap, per-block discipline splits, annual hours and race distance.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_compliance',
    description:
      'How the recent past actually went: the ratio of completed to planned training over the preceding weeks, and mean RPE where it was recorded. Use this before suggesting the plan is too hard or too easy — say what the numbers show rather than guessing.',
    input_schema: {
      type: 'object',
      properties: {
        upto_week: { type: 'integer', description: 'Look at the weeks before this one. Counts from 1, as the athlete sees it.' },
        weeks: { type: 'integer', description: 'How many preceding weeks to average. Default 2.' },
      },
      required: ['upto_week'],
    },
  },
  {
    name: 'get_adaptation_suggestions',
    description:
      'Deterministic read of what the logged weeks suggest doing about a given week — falling behind, comfortably ahead, effort creeping up at the same volume, or one discipline being skipped. Each suggestion carries the numbers behind it. Prefer these to your own judgement about whether a plan is too hard: the thresholds here are consistent and testable, yours are not. An empty list means the evidence does not support saying anything, which is a real answer.',
    input_schema: {
      type: 'object',
      properties: { week: { type: 'integer', description: 'The week being planned, counting from 1 — the same number the athlete sees on the board.' } },
      required: ['week'],
    },
  },
  {
    name: 'get_training_paces',
    description:
      'The athlete\'s running paces: the benchmark result they entered or imported, the VDOT it works out to, and the target pace band for easy, threshold, interval and repetition running, in both min/km and min/mile. Use it whenever you are asked how fast to run something. These are the same numbers the athlete sees in the app, so quoting them keeps you consistent with it — and unlike your own estimate, they are derived from a result this athlete actually ran. An answer saying there is no benchmark yet is a real answer: say so and ask them to add one rather than guessing a pace.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_annual_hours',
    description:
      'Change the athlete\'s annual hour budget and refit the whole season to it. This is a scale, not a total the season sums to: a typical week is roughly annual hours divided by 52.',
    input_schema: {
      type: 'object',
      properties: { hours: { type: 'number', description: 'Annual training hours.' } },
      required: ['hours'],
    },
  },
  {
    name: 'set_availability',
    description:
      'Set how many minutes are available on one weekday, and refit the season around it. Zero makes it a rest day.',
    input_schema: {
      type: 'object',
      properties: {
        day: { type: 'string', enum: DAYS },
        minutes: { type: 'integer', description: 'Minutes available on that day.' },
      },
      required: ['day', 'minutes'],
    },
  },
  {
    name: 'set_week_budget',
    description:
      'Pin one specific week to a number of training hours and rebuild just that week. This is the right tool for a one-off — a busy week, travel, illness, a race. The pin sticks: later season-wide changes will not silently undo it.',
    input_schema: {
      type: 'object',
      properties: {
        week: { type: 'integer', description: 'Which week of the season, counting from 1 — the same number the athlete sees on the board.' },
        hours: { type: 'number', description: 'Hours for that week.' },
      },
      required: ['week', 'hours'],
    },
  },
  {
    name: 'set_constraint',
    description:
      'Add a STANDING rule about when a discipline can happen: restrict it to certain days, keep it off certain days, or cap sessions per week. This applies to the whole season, every week, and refits all of them — use it only for something ongoing ("the pool is shut on Mondays", "never more than three swims a week"). For a one-off week, do NOT use this: use set_week_budget, and say in your reply that a single-week discipline change is not something you can make yet.',
    input_schema: {
      type: 'object',
      properties: {
        discipline: { type: 'string', enum: DISCIPLINES },
        rule: { type: 'string', enum: ['onlyDays', 'avoidDays', 'maxPerWeek'] },
        days: { type: 'array', items: { type: 'string', enum: DAYS }, description: 'For onlyDays and avoidDays.' },
        count: { type: 'integer', description: 'For maxPerWeek.' },
      },
      required: ['discipline', 'rule'],
    },
  },
  {
    name: 'set_split',
    description:
      'Set how a block divides its time between disciplines — for example strength-led early season, or no swimming until Base 3. Weights are relative and are normalised; omit a discipline to leave it out of that block entirely.',
    input_schema: {
      type: 'object',
      properties: {
        block: { type: 'string', description: 'A block name such as "Base 3", or a family such as "Base".' },
        weights: {
          type: 'object',
          description: 'Discipline to relative weight, e.g. {"Bike": 0.5, "Run": 0.3, "Strength": 0.2}.',
          additionalProperties: { type: 'number' },
        },
      },
      required: ['block', 'weights'],
    },
  },
  {
    name: 'set_week_shape',
    description:
      'Steer how a week\'s hours fall across its days. The engine already spreads a rest day\'s hours over the rest of the week; this says where they should land ("push them to the weekend"), pins a day to a fixed length, or hands the week back to plain availability. A STANDING rule: it reshapes every week in the season.',
    input_schema: {
      type: 'object',
      properties: {
        spread: {
          type: 'string',
          description: `Where displaced hours go: ${SPREAD_MODES.join(', ')}, or a weekday name to send them all to one day.`,
        },
        pins: {
          type: 'object',
          description: 'Weekday to an exact number of minutes, e.g. {"Wed": 45}. A pin fixes the day; availability only caps it.',
          additionalProperties: { type: 'integer' },
        },
        enabled: {
          type: 'boolean',
          description: 'False falls back to filling each day up to its available time, with no prescribed shape.',
        },
      },
    },
  },
  {
    name: 'move_session',
    description:
      'Move one session to a different day of its week, keeping its duration and type. Use this for scheduling clashes rather than regenerating the week.',
    input_schema: {
      type: 'object',
      properties: {
        week: { type: 'integer', description: 'Which week the session is in, counting from 1 — the same number the athlete sees on the board.' },
        session_id: { type: 'string' },
        day: { type: 'string', enum: DAYS },
      },
      required: ['week', 'session_id', 'day'],
    },
  },
  {
    name: 'regenerate_weeks',
    description:
      'Rebuild a range of weeks from the current profile and season, discarding manual edits in that range. Use it after changing constraints that should reshape existing weeks.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'integer', description: 'First week, counting from 1.' },
        to: { type: 'integer', description: 'Last week, inclusive, counting from 1.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_events',
    description:
      "Everything on the athlete's calendar: races and anything else worth seeing next to the training, with the week of the season each falls in. Also says which races the season model built a taper week and a race week for, and why it could not for the others. Call this before changing any event — every other event tool needs an id from here.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'add_event',
    description:
      "Put something new on the calendar. A race marked 'secondary' is a tune-up inside the build: the season is rebuilt with a taper week and a race week landing on it, taken out of the block it falls in — it does not make the season longer. A race marked 'primary' is the race the whole season is built around, and changing that re-lengths the runway to its date. Use 'none' for a race being noted rather than trained for, and for anything that is not a race.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What to call it, e.g. "Ironman Cascais".' },
        date: { type: 'string', description: 'The day it is on, as YYYY-MM-DD.' },
        kind: { type: 'string', enum: EVENT_KINDS, description: "'race', or 'other' for anything else." },
        race_type: {
          type: 'string',
          enum: STORABLE_RACE_TYPES,
          description: `The distance. Only ${RACE_TYPES.join(' and ')} can be the race a season is built around; the rest can only be secondary.`,
        },
        priority: { type: 'string', enum: PRIORITY_INPUT, description: 'What this race is to the season.' },
      },
      required: ['date'],
    },
  },
  {
    name: 'move_event',
    description:
      'Change the date of something already on the calendar, and refit the season around where it now falls. Moving the primary race changes how long the season is.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'From get_events.' },
        date: { type: 'string', description: 'The new day, as YYYY-MM-DD.' },
      },
      required: ['event_id', 'date'],
    },
  },
  {
    name: 'set_event_priority',
    description:
      "Change what a race is to the season: 'primary' rebuilds the whole season around it, 'secondary' gives it a taper week and a race week where it falls, 'none' leaves it as a marker and takes back any taper built for it. Making one race primary stands the previous primary down to secondary rather than removing it — it is still a race the athlete is doing.",
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'From get_events.' },
        priority: { type: 'string', enum: PRIORITY_INPUT },
      },
      required: ['event_id', 'priority'],
    },
  },
  {
    name: 'remove_event',
    description:
      'Take something off the calendar and refit the season without it. Removing the race the season is built around leaves the weeks already built alone — they have been trained — but the season is no longer aimed at anything, so say so.',
    input_schema: {
      type: 'object',
      properties: { event_id: { type: 'string', description: 'From get_events.' } },
      required: ['event_id'],
    },
  },
];

const HANDLERS = {
  get_plan_summary(s) {
    const p = current(s);
    const runs = [];
    for (const w of p.season) {
      const last = runs[runs.length - 1];
      if (last && last.block === w.block) last.weeks++;
      else runs.push({ block: w.block, weeks: 1, startWeek: weekLabel(w.absWeek) });
    }
    // Whether the budget actually fits the athlete's week. Without this the
    // model has to notice for itself that annualHours and the weekly minutes
    // below disagree, which is exactly the kind of judgement that belongs in
    // tested code rather than in its head.
    const fit = seasonFit(p.season, p.profile);
    const beyond = volumeBeyondRace(p.season, p.profile);

    return ok({
      totalWeeks: weekCount(p),
      annualHours: Math.round(p.profile.annualHours),
      raceType: p.profile.raceType,
      raceDate: p.profile.raceDate,
      startDate: p.start,
      blocks: runs,
      // A season can hold more than one race, and the blocks above already show
      // where the tune-ups landed. Listing them here saves a second call to
      // work out what a mid-season Taper and Race block are doing there.
      events: eventsOf(p).map((ev) => describeEvent(p, ev)),
      weeklyPlannedMinutes: p.season.map((w) => weekCompliance(p, w.absWeek).plannedMinutes),
      fit: fit ? {
        weeklyCapacityMinutes: fit.capacityMinutes,
        variationRetained: Number(fit.retained.toFixed(3)),
        clippedWeeks: fit.clippedWeeks,
        suggestedAnnualHours: fit.suggestedAnnualHours,
        // Null unless the volume is out of proportion to the race, so its
        // presence is itself the finding.
        raceDemandMultiple: beyond ? Number(beyond.multiple.toFixed(1)) : null,
      } : null,
    });
  },

  get_week(s, input) {
    const p = current(s);
    return ok(summariseWeek(p, toIndex(p, input.week)));
  },

  get_profile(s) {
    const p = current(s);
    return ok({
      annualHours: Math.round(p.profile.annualHours),
      raceType: p.profile.raceType,
      raceDate: p.profile.raceDate,
      availability: p.profile.availability,
      constraints: p.profile.constraints,
      splits: p.profile.splits ?? null,
      weekShape: resolveWeekShape(p.profile),
    });
  },

  get_compliance(s, input) {
    const p = current(s);
    const c = trailingCompliance(p, toIndex(p, input.upto_week), Number(input.weeks) || 2);
    return ok({
      weeksConsidered: c.weeks,
      plannedMinutes: c.plannedMinutes,
      actualMinutes: c.actualMinutes,
      ratio: Number(c.ratio.toFixed(3)),
      meanRpe: c.meanRpe,
    });
  },

  get_adaptation_suggestions(s, input) {
    const p = current(s);
    const list = suggest(p, { week: toIndex(p, input.week) });
    if (!list.length) {
      return ok('No suggestions: the logged weeks do not support saying anything yet.');
    }
    // A suggestion carries a ready-made tool call, and adapt.js speaks the
    // engine's 0-based absWeek. Left alone the model would copy that week
    // straight into a tool that now counts from 1, landing a week early.
    return ok(list.map((x) => ({
      code: x.code, severity: x.severity, message: x.message,
      evidence: x.evidence,
      action: x.action
        ? { ...x.action, input: { ...x.action.input, ...('week' in (x.action.input ?? {}) ? { week: weekLabel(x.action.input.week) } : {}) } }
        : null,
    })));
  },

  get_training_paces(s) {
    const table = paceTableFor(current(s).benchmarks);
    if (!table) {
      return ok('No training paces yet: the athlete has not entered a running result for them to be derived from. Ask them to add a recent race or time trial — a distance and a time — in the Training paces panel.');
    }

    const zones = {};
    for (const z of ZONES) {
      const band = table.zones[z.key];
      zones[z.key] = {
        name: z.label,
        perKm: `${formatPace(band.fast)} - ${formatPace(band.slow)}`,
        perMile: `${formatPace(band.fast, 'mi')} - ${formatPace(band.slow, 'mi')}`,
      };
    }

    const { id, current: _current, ...benchmark } = table.benchmark;
    return ok({ benchmark, vdot: Number(table.vdot.toFixed(1)), zones });
  },

  set_annual_hours(s, input) {
    const hours = Number(input.hours);
    if (!Number.isFinite(hours) || hours <= 0) return fail('hours must be a positive number.');
    const base = draftOf(s);
    s.draft = refit(base, { profile: { ...base.profile, annualHours: hours } });
    return ok(`Annual hours set to ${Math.round(hours)} and the season refitted.`);
  },

  set_availability(s, input) {
    if (!DAYS.includes(input.day)) {
      return fail(`"${input.day}" is not a weekday. Use one of: ${DAYS.join(', ')}.`);
    }
    const mins = Number(input.minutes);
    if (!Number.isFinite(mins) || mins < 0) return fail('minutes must be zero or more.');
    const base = draftOf(s);
    const availability = { ...base.profile.availability, [input.day]: Math.round(mins) };
    s.draft = refit(base, { profile: { ...base.profile, availability } });
    return ok(`${input.day} set to ${Math.round(mins)} minutes and the season refitted.`);
  },

  set_week_budget(s, input) {
    const base = draftOf(s);
    const week = toIndex(base, input.week);
    const hours = Number(input.hours);
    if (!Number.isFinite(hours) || hours < 0) return fail('hours must be zero or more.');

    const draft = clone(base);
    // Pin it on the plan, not just on the resolved season, so a later refit in
    // the same turn does not quietly undo it.
    draft.weekBudgets = { ...(draft.weekBudgets ?? {}), [weekKey(week)]: hours };
    draft.season = draft.season.map((w) => (w.absWeek === week ? { ...w, hours } : w));
    rebuild(draft, week, week);
    s.draft = draft;
    return ok(`Week ${weekLabel(week)} pinned to ${hours} hours and rebuilt. It will keep that budget through later changes.`);
  },

  set_constraint(s, input) {
    if (!DISCIPLINES.includes(input.discipline)) {
      return fail(`"${input.discipline}" is not a discipline. Use one of: ${DISCIPLINES.join(', ')}.`);
    }
    const rule = input.rule;
    let value;
    if (rule === 'maxPerWeek') {
      value = Number(input.count);
      if (!Number.isFinite(value) || value < 0) return fail('maxPerWeek needs a count of zero or more.');
    } else if (rule === 'onlyDays' || rule === 'avoidDays') {
      value = Array.isArray(input.days) ? input.days.filter((d) => DAYS.includes(d)) : [];
      if (!value.length) return fail(`${rule} needs at least one valid day.`);
    } else {
      return fail('rule must be onlyDays, avoidDays or maxPerWeek.');
    }

    const base = draftOf(s);
    const constraints = base.profile.constraints
      .filter((c) => !(c.disc === input.discipline && c.rule === rule))
      .concat([{ disc: input.discipline, rule, value }]);
    s.draft = refit(base, { profile: { ...base.profile, constraints } });
    return ok(`Constraint applied: ${input.discipline} ${rule}. Season refitted.`);
  },

  set_split(s, input) {
    if (!input.block || typeof input.weights !== 'object' || !input.weights) {
      return fail('set_split needs a block name and a weights object.');
    }
    const base = draftOf(s);
    const splits = { ...(base.profile.splits ?? {}), [input.block]: input.weights };
    const profile = normalizeProfile({ ...base.profile, splits });
    if (!profile.splits?.[input.block]) {
      return fail(`Those weights were not usable. Use discipline names (${DISCIPLINES.join(', ')}) with numbers above zero.`);
    }
    s.draft = refit(base, { profile });
    return ok(`Split set for ${input.block}. Season refitted.`);
  },

  set_week_shape(s, input) {
    const base = draftOf(s);
    const shape = { ...resolveWeekShape(base.profile) };

    if (input.spread !== undefined) {
      const spread = String(input.spread);
      if (!SPREAD_MODES.includes(spread) && !DAYS.includes(spread)) {
        return fail(`"${spread}" is not a spread policy. Use one of: ${SPREAD_MODES.join(', ')}, or a weekday.`);
      }
      shape.spread = spread;
    }

    if (input.pins !== undefined) {
      if (!input.pins || typeof input.pins !== 'object') return fail('pins must be an object of weekday to minutes.');
      const pins = {};
      for (const [day, v] of Object.entries(input.pins)) {
        if (!DAYS.includes(day)) {
          return fail(`"${day}" is not a weekday. Use one of: ${DAYS.join(', ')}.`);
        }
        const mins = Number(v);
        if (!Number.isFinite(mins) || mins < 0) return fail(`the pin for ${day} must be zero or more minutes.`);
        pins[day] = Math.round(mins);
      }
      shape.pins = pins;
    }

    if (input.enabled !== undefined) shape.enabled = input.enabled !== false;

    s.draft = refit(base, { profile: { ...base.profile, weekShape: shape } });

    const said = [
      input.spread !== undefined ? `displaced hours go to ${shape.spread}` : null,
      input.pins !== undefined
        ? (Object.keys(shape.pins).length
          ? `pinned ${Object.entries(shape.pins).map(([d, m]) => `${d} to ${m} min`).join(', ')}`
          : 'pins cleared')
        : null,
      input.enabled !== undefined ? (shape.enabled ? 'shaping on' : 'shaping off') : null,
    ].filter(Boolean);
    return ok(`Week shape updated (${said.join('; ') || 'no change'}) and the season refitted.`);
  },

  move_session(s, input) {
    if (!DAYS.includes(input.day)) {
      return fail(`"${input.day}" is not a weekday. Use one of: ${DAYS.join(', ')}.`);
    }
    const base = draftOf(s);
    const week = toIndex(base, input.week);
    const sessions = clone(base.weeks[weekKey(week)] ?? []);
    const hit = sessions.find((x) => x.id === input.session_id);
    if (!hit) return fail(`No session "${input.session_id}" in week ${weekLabel(week)}. Call get_week first.`);

    hit.day = input.day;
    const draft = clone(base);
    draft.weeks[weekKey(week)] = sessions;
    s.draft = draft;
    return ok(`Moved ${hit.disc} to ${input.day} in week ${weekLabel(week)}.`);
  },

  regenerate_weeks(s, input) {
    const base = draftOf(s);
    const from = toIndex(base, input.from);
    const to = toIndex(base, input.to);
    if (to < from) return fail('"to" must not be before "from".');
    s.draft = rebuild(clone(base), from, to);
    return ok(`Weeks ${weekLabel(from)}–${weekLabel(to)} rebuilt from the current profile.`);
  },

  get_events(s) {
    const p = current(s);
    const events = eventsOf(p);
    const { applied, refused } = planLandings({ weeks: weekCount(p), landings: landingsOf(p) });
    return ok({
      startDate: p.start,
      totalWeeks: weekCount(p),
      events: events.map((ev) => describeEvent(p, ev)),
      tunedUpWeeks: applied.map((a) => ({
        raceWeek: weekLabel(a.absWeek),
        taperWeek: a.taperWeek === null ? null : weekLabel(a.taperWeek),
      })),
      // Present only when something was turned down, so its presence is the
      // finding — the same shape get_plan_summary uses for the fit warnings.
      noTaperBuilt: refused.map((r) => ({ week: weekLabel(r.absWeek), reason: r.reason })),
    });
  },

  add_event(s, input) {
    const base = draftOf(s);
    const kind = input.kind ?? (input.race_type || input.priority ? 'race' : 'other');
    const priority = input.priority ?? 'none';
    const raceType = input.race_type ?? null;

    const wrong = eventProblem(base, { date: input.date, kind, raceType, priority });
    if (wrong) return fail(wrong);

    const ev = {
      id: mintEventId(),
      name: input.name,
      date: input.date,
      kind,
      raceType,
      priority: asPriority(priority),
    };
    const { draft, said } = writeEvents(s, base, upsertEvent(eventsOf(base), ev),
      `Added ${ev.name || 'an event'} on ${ev.date}.`);

    const note = landingNote(draft, findEvent(draft, ev.id));
    return ok([...said, note].filter(Boolean).join(' '));
  },

  move_event(s, input) {
    const base = draftOf(s);
    const ev = findEvent(base, input.event_id);
    if (!ev) return fail(`No event "${input.event_id}" on this calendar. Call get_events first.`);

    const wrong = eventProblem(base, { date: input.date });
    if (wrong) return fail(wrong);

    const { draft, said } = writeEvents(s, base, upsertEvent(eventsOf(base), { ...ev, date: input.date }),
      `Moved ${ev.name || 'the event'} from ${ev.date} to ${input.date}.`);

    const note = landingNote(draft, findEvent(draft, ev.id));
    return ok([...said, note].filter(Boolean).join(' '));
  },

  set_event_priority(s, input) {
    const base = draftOf(s);
    const ev = findEvent(base, input.event_id);
    if (!ev) return fail(`No event "${input.event_id}" on this calendar. Call get_events first.`);

    const wrong = eventProblem(base, { kind: ev.kind, raceType: ev.raceType, priority: input.priority });
    if (wrong) return fail(wrong);

    const stood = input.priority === 'primary' ? goalEvent(eventsOf(base)) : null;
    const { draft, said } = writeEvents(
      s, base,
      upsertEvent(eventsOf(base), { ...ev, priority: asPriority(input.priority) }),
      `${ev.name || 'The event'} on ${ev.date} is now ${input.priority === 'none' ? 'a marker only' : `a ${input.priority} race`}.` +
        (stood && stood.id !== ev.id
          ? ` ${stood.name || 'The previous race'} on ${stood.date} is now secondary.`
          : ''),
    );

    const note = landingNote(draft, findEvent(draft, ev.id));
    return ok([...said, note].filter(Boolean).join(' '));
  },

  remove_event(s, input) {
    const base = draftOf(s);
    const ev = findEvent(base, input.event_id);
    if (!ev) return fail(`No event "${input.event_id}" on this calendar. Call get_events first.`);

    const { said } = writeEvents(s, base, removeEvent(eventsOf(base), ev.id),
      `Removed ${ev.name || 'the event'} on ${ev.date}.`);
    return ok(said.join(' '));
  },
};

/**
 * Run one tool call. Never throws: a failure is reported back to the model as an
 * error result so it can correct itself, and leaves no partial draft behind.
 */
export function callTool(session, name, input = {}) {
  const handler = HANDLERS[name];
  if (!handler) return fail(`Unknown tool "${name}". Available: ${TOOL_DEFS.map((t) => t.name).join(', ')}.`);

  const before = session.draft;
  try {
    const result = handler(session, input ?? {});
    if (result.isError) session.draft = before; // a rejected call changes nothing
    return result;
  } catch (e) {
    session.draft = before;
    return fail(`${name} failed: ${e.message}`);
  }
}

/** What the athlete would be approving, if they applied the session now. */
export function sessionDiff(session) {
  if (!session.draft) return { weeks: [], issues: [], blocked: false, totalDeltaMinutes: 0 };
  return diffPlans(session.plan, session.draft);
}
