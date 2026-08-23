/* Events the athlete puts on the calendar: races, and anything else worth
   seeing next to the training.

   One of them can be the *goal event* — the race the season is aimed at. That
   one is the single source of truth for the plan's race date and distance, so
   the rule this module exists to keep is that there is never more than one of
   it, whatever arrives from storage or from a plan file somebody else wrote.

   Everything here is pure: a list goes in, a new list comes out. Nothing
   reaches into a plan, and dates stay ISO strings — the page formats them,
   because only the page knows the reader's locale. */

import { parseISO, toISO } from './dates.js';

/** Race distances the generator sizes a season for (see RACE_DEMAND in
    generate.js). Offering one it does not know would silently fall back to the
    default distance, so an event may only carry a name from this list. */
export const RACE_TYPES = ['sprint', 'olympic', '70.3', 'ironman'];

export const EVENT_KINDS = ['race', 'other'];

const text = (v) => String(v ?? '').trim();

/**
 * One event in canonical form, or null when it is not usable — a missing or
 * unparseable date, or no id to file it under. Total: bad input is dropped, not
 * thrown, because events arrive from storage and from imported plan files.
 *
 * @param {object} raw
 * @param {object} [opts]
 * @param {string} [opts.id] id to use when `raw` has none (a new event)
 */
export function normalizeEvent(raw, { id } = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const eventId = text(raw.id) || text(id);
  const date = toISO(parseISO(raw.date));
  if (!eventId || !date) return null;

  const kind = EVENT_KINDS.includes(raw.kind) ? raw.kind : 'other';
  const raceType = kind === 'race' && RACE_TYPES.includes(raw.raceType) ? raw.raceType : null;

  return {
    id: eventId,
    name: text(raw.name),
    date,
    kind,
    raceType,
    // Only a race can be the goal: the goal event sets the race date *and* the
    // distance the season is built for, and a non-race has no distance to give.
    goal: kind === 'race' && raw.goal === true,
    note: text(raw.note),
  };
}

/**
 * A whole list in canonical form: usable events only, one per id, in date
 * order, with at most one goal event.
 *
 * When a record claims two goal events the earliest wins. That case only comes
 * from data this app did not write — `upsertEvent` stands the previous goal
 * down before it gets here — so the rule just has to be deterministic.
 */
export function normalizeEvents(list) {
  const seen = new Set();
  const events = (Array.isArray(list) ? list : [])
    .map((raw) => normalizeEvent(raw))
    .filter((ev) => {
      if (!ev || seen.has(ev.id)) return false;
      seen.add(ev.id);
      return true;
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let claimed = false;
  return events.map((ev) => {
    if (!ev.goal) return ev;
    if (claimed) return { ...ev, goal: false };
    claimed = true;
    return ev;
  });
}

/** The race the season is aimed at, or null when nothing is flagged. */
export function goalEvent(events) {
  return (Array.isArray(events) ? events : []).find((ev) => ev && ev.goal) ?? null;
}

/**
 * Add an event, or replace the one with the same id. Flagging an event as the
 * goal stands the previous goal down, so the invariant holds by construction
 * rather than by whoever normalizes last. An event that cannot be stored leaves
 * the list exactly as it was.
 */
export function upsertEvent(events, event) {
  const list = Array.isArray(events) ? events : [];
  const next = normalizeEvent(event);
  if (!next) return list;

  const others = list
    .filter((ev) => ev && ev.id !== next.id)
    .map((ev) => (next.goal && ev.goal ? { ...ev, goal: false } : ev));

  return normalizeEvents([...others, next]);
}

export function removeEvent(events, id) {
  return normalizeEvents((Array.isArray(events) ? events : []).filter((ev) => ev && ev.id !== id));
}

/** Events keyed by the day they fall on, so a month grid is one lookup a day. */
export function eventsByDate(events) {
  const byDate = {};
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || !ev.date) continue;
    (byDate[ev.date] ??= []).push(ev);
  }
  return byDate;
}

/**
 * The profile fields the goal event owns. Either is null when the goal event
 * does not say, so a caller can fall back to what the profile already holds
 * instead of overwriting it with nothing.
 */
export function raceFieldsOf(events) {
  const goal = goalEvent(events);
  return { raceDate: goal?.date ?? null, raceType: goal?.raceType ?? null };
}

/**
 * The back-compat seed: a plan stored before events existed has its race date
 * on the profile and nothing on the calendar. Turning that into the goal event
 * means there is still only one place the race is recorded, and the athlete
 * sees the race they already entered rather than an empty calendar.
 */
export function seedEventsFromProfile(profile, { id } = {}) {
  const date = toISO(parseISO(profile?.raceDate));
  if (!date || !id) return [];
  return normalizeEvents([{
    id,
    name: 'Race day',
    date,
    kind: 'race',
    raceType: profile?.raceType,
    goal: true,
  }]);
}
