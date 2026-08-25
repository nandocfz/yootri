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

import { loadPlan, blockAt, weekCount, sessionsAt, refit, diffPlans } from './plan.js';
import { normalizeProfile, resolveWeekShape, SPREAD_MODES, DAYS, DISCIPLINES } from './profile.js';
import { generateWeek } from './generate.js';
import { trailingCompliance, weekCompliance } from './actuals.js';
import { suggest } from './adapt.js';
import { seasonFit, volumeBeyondRace } from './validate.js';
import { durToMin } from './duration.js';
import { paceTableFor, formatPace, ZONES } from './paces.js';

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
