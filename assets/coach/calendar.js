/* The calendar grid: which real date a planned week-and-weekday lands on, and
   the month of Monday-start rows that shows it.

   All UTC day-numbers, for the same reason dates.js is — see the note there. A
   grid built from local Date arithmetic slips by a day across a daylight-saving
   boundary, which would draw a session on the wrong date without anything
   having moved. Dates leave here as ISO strings and nothing else: turning one
   into words a reader sees is the page's job, since only the page knows the
   locale. */

import { parseISO, toISO, addDays, mondayOf } from './dates.js';
import { DAYS } from './profile.js';

const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** A week index that the caller asked for, or null when it is not a number. */
const weekNumber = (absWeek) =>
  absWeek == null || absWeek === '' || !Number.isFinite(Number(absWeek)) ? null : Number(absWeek);

/**
 * The date a session sits on: week `absWeek` of a plan starting `startISO`, on
 * weekday `dayName`. This is the one place the mapping is written down, so the
 * week board and the month grid cannot disagree about it.
 */
export function dateOf(startISO, absWeek, dayName) {
  const dayIndex = DAYS.indexOf(dayName);
  const monday = mondayOf(startISO);
  const week = weekNumber(absWeek);
  if (dayIndex < 0 || !monday || week === null) return null;
  return toISO(addDays(parseISO(monday), week * 7 + dayIndex));
}

/**
 * Which weekday a date is, named as the rest of the engine names them.
 *
 * The inverse of `dateOf`'s weekday half, and UTC for the same reason: a local
 * Date would answer with yesterday's weekday for anyone west of Greenwich, and
 * a race week would then be built around the wrong day.
 */
export function weekdayOf(iso) {
  const d = parseISO(iso);
  return d ? DAYS[(d.getUTCDay() + 6) % 7] : null;
}

/**
 * The reverse: which week of the plan a date falls in. Deliberately *not*
 * clamped — a date before the plan starts comes back negative, and one past the
 * end comes back too large, so a caller can tell "outside the plan" from
 * "week 0". Clamping here would draw week 0's sessions on dates the plan never
 * covers.
 */
export function weekIndexOf(startISO, iso) {
  const from = mondayOf(startISO);
  const to = mondayOf(iso);
  if (!from || !to) return null;
  return Math.round((parseISO(to) - parseISO(from)) / (7 * 86400000));
}

/** "2027-07-25" -> "2027-07". */
export function monthOf(iso) {
  const d = parseISO(iso);
  if (!d) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** "2027-07" -> "2027-07-01". */
export function firstOfMonth(monthKey) {
  const m = MONTH_RE.exec(String(monthKey ?? ''));
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

/** Step a month key forward or back. Handles the year boundary. */
export function addMonths(monthKey, n) {
  const first = firstOfMonth(monthKey);
  const step = Number(n);
  if (!first || !Number.isFinite(step)) return null;
  const d = parseISO(first);
  return monthOf(toISO(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + step, 1))));
}

/**
 * Pull a month key into the span a plan actually occupies.
 *
 * The month being looked at is stored on the plan, and a stored value outlives
 * the thing it described: a plan file arrives from somebody else's season, a
 * cloud merge brings one back, the start date moves. A month from another year
 * renders a grid with nothing on it and no landmark to navigate back by, so it
 * is not worth trusting when the plan itself says where it is.
 *
 * @param {string} monthKey "YYYY-MM"
 * @param {object} opts
 * @param {string} opts.fromISO first day the plan covers
 * @param {string} opts.toISO   last day worth showing (the season's end, or a
 *                              later event, whichever is further out)
 */
export function clampMonth(monthKey, { fromISO, toISO } = {}) {
  const month = firstOfMonth(monthKey) ? monthOf(firstOfMonth(monthKey)) : null;
  const first = monthOf(fromISO);
  const last = monthOf(toISO);
  if (!month || !first) return null;
  // A range with no end, or one that ends before it starts, still has a start.
  const end = last && last >= first ? last : first;
  if (month < first) return first;
  if (month > end) return end;
  return month;
}

/**
 * One month as whole Monday-to-Sunday rows, each tagged with the plan week it
 * is. Rows run from the Monday on or before the 1st to the Sunday on or after
 * the last day, so the grid is always rectangular and a row is always exactly
 * one plan week.
 *
 * `absWeek` is null on a row outside the runway, and `inPlan` says the same
 * per day — a month can sit entirely before the plan starts or after it ends
 * and still needs to draw, because that is where an event you have not built
 * for yet lives.
 *
 * @param {string} monthKey  "YYYY-MM"
 * @param {object} opts
 * @param {string} opts.startISO first Monday of the plan
 * @param {number} [opts.weeks]  length of the season; unbounded when absent
 */
export function monthGrid(monthKey, { startISO, weeks } = {}) {
  const first = firstOfMonth(monthKey);
  const start = mondayOf(startISO);
  if (!first || !start) return null;

  const month = monthOf(first);
  const total = Number(weeks);
  const span = Number.isFinite(total) && total > 0 ? Math.round(total) : Infinity;
  const inRunway = (week) => (week === null || week < 0 || week >= span ? null : week);

  const firstDay = parseISO(first);
  const lastDay = new Date(Date.UTC(firstDay.getUTCFullYear(), firstDay.getUTCMonth() + 1, 0));

  const rows = [];
  let cursor = parseISO(mondayOf(first));
  const lastMonday = parseISO(mondayOf(toISO(lastDay)));
  while (cursor <= lastMonday) {
    const mondayISO = toISO(cursor);
    // Every day of a row shares the row's week, so it is resolved once. Asking
    // per day would let a rounding difference put two days of one week in two
    // different weeks.
    const absWeek = inRunway(weekIndexOf(start, mondayISO));
    const days = DAYS.map((day, dayIndex) => {
      const iso = toISO(addDays(cursor, dayIndex));
      return { iso, day, absWeek, inMonth: monthOf(iso) === month, inPlan: absWeek !== null };
    });
    rows.push({ mondayISO, absWeek, days });
    cursor = addDays(cursor, 7);
  }

  return { month, rows };
}
