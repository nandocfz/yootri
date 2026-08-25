/* Plan-level operations: the boundary the UI and the coach agent both talk to.

   The rule this module exists to enforce is that **nothing edits a stored plan
   in place**. A change is made against a *draft* — a detached copy — which is
   then diffed, validated, shown to the athlete, and only written by applyDraft.

   That indirection is what makes an agent safe to point at a training plan. The
   model can propose whatever it likes; the worst it can do is produce a draft
   that gets rejected at the diff. It is also what makes an undo trivial, because
   the previous plan object is still intact. */

import { migratePlan } from './migrate.js';
import { normalizeProfile } from './profile.js';
import { fitToRace, planLandings } from './season.js';
import { generateWeek } from './generate.js';
import { validateSeason } from './validate.js';
import { durToMin, REST_DUR } from './duration.js';
import { DAYS } from './profile.js';
import { weeksUntil } from './dates.js';
import { weekIndexOf, weekdayOf } from './calendar.js';
import { normalizeEvents, secondaryRaces, seedEventsFromProfile } from './events.js';
import { normalizeBenchmarks } from './paces.js';

const clone = (x) => structuredClone(x);
const weekKey = (absWeek) => `w${absWeek}`;

/** Bring a stored record up to date and make sure its profile is sane.

    Benchmarks are cleaned here too, which is a deliberate difference from
    `events`: the page normalizes those on its way into `state`, but benchmarks
    are read straight off the plan by the card renderer *and* by the coach tool.
    Cleaning them at the one door every reader comes through is what stops those
    two disagreeing about which result the paces came from. */
export function loadPlan(raw) {
  const p = migratePlan(raw);
  const profile = normalizeProfile(p.profile);
  const benchmarks = normalizeBenchmarks(p.benchmarks);

  // Avoid handing back a needlessly different object for an already-clean plan,
  // so `loadPlan(loadPlan(x))` stays deep-equal to `loadPlan(x)`.
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (same(profile, p.profile) && same(benchmarks, p.benchmarks)) return p;
  return { ...p, profile, benchmarks };
}

export const weekCount = (plan) => plan.season.length;

const clampWeek = (plan, absWeek) =>
  Math.max(0, Math.min(Number(absWeek) || 0, weekCount(plan) - 1));

/** Which block a week belongs to, clamped to the season rather than undefined. */
export function blockAt(plan, absWeek) {
  return plan.season[clampWeek(plan, absWeek)];
}

/** A *copy* of a week's sessions — callers must not be able to edit the plan
    just by holding a reference into it. */
export function sessionsAt(plan, absWeek) {
  return clone(plan.weeks[weekKey(clampWeek(plan, absWeek))] ?? []);
}

/** A new plan with one week replaced. Never mutates the input. */
export function setSessionsAt(plan, absWeek, sessions) {
  const next = clone(plan);
  next.weeks[weekKey(clampWeek(plan, absWeek))] = clone(sessions);
  return next;
}

/** An id for a session that has moved week. Deliberately unlike the generated
    `w{week}-{n}` ids, so regenerating the week it left cannot mint the same one
    a second time. */
const mintSessionId = (now = Date.now()) =>
  `mv-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Move a session onto a given week and weekday. Returns a new plan; the input
 * is untouched. Anything it cannot do — an id nothing holds, a week past the
 * end of the season, a weekday that does not exist — gives back the plan
 * exactly as it was: a drag that lands nowhere should do nothing, rather than
 * something approximate.
 *
 * Crossing a week boundary re-mints the session id and carries its completion
 * flag and logged actual across. That is not tidiness. Generated ids are
 * `w{week}-{n}`, so a session dragged out of week 3 still holds a week-3 id;
 * "Reset week" on week 3 mints that id again, and `done`, `actuals` and
 * `diffPlans` are all keyed by id — two live sessions sharing one silently
 * merges their history.
 *
 * @param {object} plan
 * @param {object} opts
 * @param {string} opts.id       session to move
 * @param {number} opts.toWeek   destination absolute week
 * @param {string} opts.day      destination weekday name
 * @param {function} [opts.mintId] injectable, so a test can name the new id
 */
export function moveSession(plan, { id, toWeek, day, mintId = mintSessionId } = {}) {
  const target = Number(toWeek);
  if (!DAYS.includes(day)) return plan;
  if (!Number.isInteger(target) || target < 0 || target >= weekCount(plan)) return plan;

  let from = null;
  for (const [key, sessions] of Object.entries(plan.weeks ?? {})) {
    if ((sessions ?? []).some((s) => s && s.id === id)) {
      from = Number(String(key).slice(1));
      break;
    }
  }
  if (!Number.isInteger(from)) return plan;

  const next = clone(plan);

  // Within one week only the day changes, so the id — and every reference to
  // it — can stay exactly where it is.
  if (from === target) {
    next.weeks[weekKey(target)] = next.weeks[weekKey(target)]
      .map((s) => (s.id === id ? { ...s, day } : s));
    return next;
  }

  const session = next.weeks[weekKey(from)].find((s) => s.id === id);
  next.weeks[weekKey(from)] = next.weeks[weekKey(from)].filter((s) => s.id !== id);

  const movedId = String(mintId());
  next.weeks[weekKey(target)] = [...(next.weeks[weekKey(target)] ?? []), { ...session, id: movedId, day }];

  for (const store of ['done', 'actuals']) {
    if (next[store] && id in next[store]) {
      next[store][movedId] = next[store][id];
      delete next[store][id];
    }
  }

  return next;
}

/** Total training minutes per week, indexed by absolute week. */
export function weekTotals(plan) {
  return plan.season.map((w) =>
    (plan.weeks[weekKey(w.absWeek)] ?? []).reduce((a, s) => a + durToMin(s.dur), 0),
  );
}

/* ---- Where the races fall -------------------------------------------------
   The two functions the calendar and the season model meet in. Everything else
   in this file counts weeks; events are dated. Both take anything carrying
   `start` and `events`, so a plan being built works as well as a stored one.

   Both normalize on the way in. `loadPlan` deliberately does not — events are
   the page's to clean — so an imported file or a coach-written list could
   otherwise reach the season model with a priority on a non-race. */

/** The absolute weeks the plan's secondary races fall in — what `fitToRace`
    lands a taper and race week on. The primary race is not among them: it is
    the week the whole runway already ends on. */
export function landingsOf(plan) {
  return secondaryRaces(normalizeEvents(plan?.events))
    .map((ev) => weekIndexOf(plan?.start, ev.date))
    .filter((w) => Number.isInteger(w));
}

/**
 * The weekday a race falls on in a given week, or null when none does.
 *
 * Every race the athlete marked counts here, including one the season model
 * turned down for a taper: they are racing that day either way, so the week
 * should not schedule training on it. A marker with no priority does not — it
 * changes nothing by definition.
 *
 * Two races in one week give the earlier day, which is the conservative answer.
 */
export function raceDayFor(plan, absWeek) {
  return normalizeEvents(plan?.events)
    .filter((ev) => ev.kind === 'race' && ev.priority && weekIndexOf(plan?.start, ev.date) === absWeek)
    .map((ev) => weekdayOf(ev.date))
    .filter(Boolean)
    .sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b))[0] ?? null;
}

/**
 * Re-fit the plan and hand back a draft. The stored plan is untouched.
 *
 * @param {object} plan
 * @param {object} [opts]
 * @param {object} [opts.profile] replacement profile (annual hours, availability, splits…)
 * @param {number} [opts.from]    first week to regenerate (default: all)
 * @param {number} [opts.to]      last week to regenerate, inclusive
 */
export function refit(plan, { profile, from = 0, to = Infinity, weeks } = {}) {
  const draft = clone(plan);
  draft.profile = normalizeProfile(profile ?? plan.profile);

  // Re-resolve the season whenever the budget changes. The length is kept unless
  // a caller passes one: the race date has not moved just because the hours did,
  // but when it *has* moved the runway genuinely changes.
  draft.season = fitToRace({
    annualHours: draft.profile.annualHours,
    weeks: Number.isFinite(weeks) && weeks > 0 ? Math.round(weeks) : weekCount(plan),
    // Tune-up races come out of the block they fall in. Read off the draft, so
    // a caller that changed the events and the profile in one go gets both.
    landings: landingsOf(draft),
  });

  // Reapply any pinned per-week budgets on top. Without this, "make next week
  // 4 hours" followed by any change that refits the season would silently undo
  // itself — including two tool calls made by the coach in the same turn.
  const pinned = draft.weekBudgets ?? {};
  draft.season = draft.season.map((w) => {
    const hours = Number(pinned[weekKey(w.absWeek)]);
    return Number.isFinite(hours) && hours >= 0 ? { ...w, hours } : w;
  });

  const first = Math.max(0, from);
  const last = Math.min(weekCount(draft) - 1, to);

  for (const w of draft.season) {
    if (w.absWeek < first || w.absWeek > last) continue;
    draft.weeks[weekKey(w.absWeek)] = generateWeek({
      hours: w.hours,
      block: w.block,
      profile: draft.profile,
      idPrefix: weekKey(w.absWeek),
      raceDay: raceDayFor(draft, w.absWeek),
    }).sessions;
  }
  return draft;
}

const SESSION_FIELDS = ['day', 'disc', 'focus', 'dur', 'zone', 'paceZone'];
const sameSession = (a, b) => SESSION_FIELDS.every((f) => a[f] === b[f]);

/**
 * Compare two plans week by week. This is what the athlete approves, so it
 * reports volume deltas first (the headline) and per-session detail second.
 */
export function diffPlans(before, after) {
  const weeks = [];

  const count = Math.max(weekCount(before), weekCount(after));
  for (let i = 0; i < count; i++) {
    const b = before.weeks?.[weekKey(i)] ?? [];
    const a = after.weeks?.[weekKey(i)] ?? [];
    const byId = (list) => new Map(list.map((s) => [s.id, s]));
    const bIds = byId(b);
    const aIds = byId(a);

    const added = a.filter((s) => !bIds.has(s.id));
    const removed = b.filter((s) => !aIds.has(s.id));
    const changed = [];
    for (const [id, bs] of bIds) {
      const as = aIds.get(id);
      if (as && !sameSession(bs, as)) changed.push({ before: bs, after: as });
    }

    if (!added.length && !removed.length && !changed.length) continue;

    const mins = (list) => list.reduce((x, s) => x + durToMin(s.dur), 0);
    const beforeMinutes = mins(b);
    const afterMinutes = mins(a);
    weeks.push({
      absWeek: i,
      block: (after.season?.[i] ?? before.season?.[i])?.block ?? '',
      beforeMinutes,
      afterMinutes,
      deltaMinutes: afterMinutes - beforeMinutes,
      added,
      removed,
      changed,
    });
  }

  const issues = validateSeason(
    (after.season ?? []).map((w) => ({ ...w, sessions: after.weeks?.[weekKey(w.absWeek)] ?? [] })),
    {
      profile: after.profile,
      // A race the season could not build a taper for is a thing the athlete
      // needs told at the diff, where they are deciding — not left to be
      // noticed as a missing taper weeks later.
      refusedLandings: planLandings({
        weeks: weekCount(after),
        landings: landingsOf(after),
      }).refused,
    },
  );

  return {
    weeks,
    issues,
    // Errors mean the week is not physically possible. Warnings are coaching
    // judgement and stay the athlete's call.
    blocked: issues.some((i) => i.level === 'error'),
    totalDeltaMinutes: weeks.reduce((a, w) => a + w.deltaMinutes, 0),
  };
}

/**
 * Completion flags and logged actuals, filtered down to sessions that `weeks`
 * still contains. A plan edited over a season would otherwise accumulate
 * references to sessions nobody can see — and a plan arriving from a file can
 * claim history for sessions it does not carry. Anything still present keeps
 * its history.
 */
export function pruneHistory(weeks, { done, actuals } = {}) {
  const live = new Set(Object.values(weeks ?? {}).flat().map((s) => s.id));
  const keep = (src) =>
    Object.fromEntries(Object.entries(src ?? {}).filter(([id]) => live.has(id)));
  return { done: keep(done), actuals: keep(actuals) };
}

/**
 * Commit a draft. The only function here that produces the plan you store.
 * Returns a new object; both inputs are left alone.
 */
export function applyDraft(plan, draft, { now = Date.now() } = {}) {
  const next = clone(draft);
  next.id = plan.id;
  next.name = plan.name;
  next.updatedAt = now;

  const history = pruneHistory(next.weeks, plan);
  next.done = history.done;
  next.actuals = history.actuals;

  // Chat is conversation state, not plan content. A draft is snapshotted when
  // the coach makes its first tool call — before it has replied — so taking the
  // transcript from the draft would rewind it and swallow the coach's own answer.
  next.chat = plan.chat ?? [];

  return next;
}

/* ---- Starting a new season ------------------------------------------------
   A new plan is a separate record, so creating one never touches the plans you
   already have: their weeks, completions and logs stay exactly where they are.
   This is the "clean canvas" path — a fresh calendar for a new race, with the
   old season still there to look back on. */

export const FALLBACK_WEEKS = 16;

/** A plan id. Unique per record: two plans must never share one, or storing the
    second would overwrite the first. */
export const mintPlanId = (now = Date.now()) =>
  `p-${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Seven rest days: an empty week that still has somewhere to drop a session. */
const emptyWeek = (idPrefix) =>
  DAYS.map((day, i) => ({
    id: `${idPrefix}-${i}`,
    day,
    disc: 'Rest',
    focus: '',
    dur: REST_DUR,
    zone: '—',
  }));

/**
 * Build a new plan.
 *
 * @param {object}  opts
 * @param {string}  opts.name
 * @param {string}  opts.startISO   first Monday of the plan
 * @param {string} [opts.raceDate]  sizes the season; falls back to 16 weeks
 * @param {string} [opts.raceType]
 * @param {object} [opts.profile]   inherited availability/constraints/splits
 * @param {object[]} [opts.benchmarks] inherited running results
 * @param {'fitted'|'empty'} [opts.mode]
 */
export function newPlan({
  name, startISO, raceDate = null, raceType, profile, benchmarks, mode = 'fitted', id, now = Date.now(),
} = {}) {
  // Carry the athlete's own constraints across — their week has not changed
  // just because the race has — but never the previous race.
  const base = normalizeProfile({
    ...(profile ?? {}),
    raceDate,
    ...(raceType ? { raceType } : {}),
  });

  // The race the season is built for is also the first thing on the calendar,
  // so there is one place it is recorded rather than two — and it is needed
  // *before* the weeks are built, because the last one is shaped around the day
  // the race is actually on.
  const events = seedEventsFromProfile(base, { id: `ev-${now.toString(36)}` });
  const dated = { start: startISO, events };

  const weeks = weeksUntil(startISO, raceDate) ?? FALLBACK_WEEKS;
  const season = fitToRace({ annualHours: base.annualHours, weeks, landings: landingsOf(dated) });

  const built = {};
  for (const w of season) {
    const key = weekKey(w.absWeek);
    built[key] = mode === 'empty'
      ? emptyWeek(key)
      : generateWeek({
        hours: w.hours,
        block: w.block,
        profile: base,
        idPrefix: key,
        raceDay: raceDayFor(dated, w.absWeek),
      }).sessions;
  }

  return {
    id: id ?? mintPlanId(now),
    name: name || 'My plan',
    schema: 3,
    start: startISO,
    profile: base,
    season,
    weeks: built,
    events,
    // Carried across for the same reason the constraints are: the athlete's
    // 10 km did not get slower because they picked a new race.
    benchmarks: normalizeBenchmarks(benchmarks),
    done: {},
    actuals: {},
    chat: [],
    chartmode: 'weekly',
    charthidden: {},
    view: { week: 0 },
    updatedAt: now,
  };
}
