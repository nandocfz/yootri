import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dateOf, weekIndexOf, monthOf, firstOfMonth, addMonths, monthGrid, clampMonth,
} from '../assets/coach/calendar.js';

/* A month view has to agree with the week board about which calendar date a
   session falls on, so both sides derive it here. Like dates.js this is all UTC
   day-numbers: a grid built with local Date arithmetic would slip a day across a
   daylight-saving boundary, and the session would appear to move.

   2026-08-17 is a Monday throughout these tests. */

test('the first day of week zero is the start date itself', () => {
  assert.equal(dateOf('2026-08-17', 0, 'Mon'), '2026-08-17');
  assert.equal(dateOf('2026-08-17', 0, 'Sun'), '2026-08-23');
});

test('dateOf walks whole weeks forward from the start', () => {
  assert.equal(dateOf('2026-08-17', 1, 'Mon'), '2026-08-24');
  assert.equal(dateOf('2026-08-17', 2, 'Wed'), '2026-09-02');
  assert.equal(dateOf('2026-08-17', 15, 'Sun'), '2026-12-06');
});

test('dateOf survives a daylight-saving change', () => {
  // UK clocks go back on 2026-10-25, inside week 9.
  assert.equal(dateOf('2026-08-17', 9, 'Mon'), '2026-10-19');
  assert.equal(dateOf('2026-08-17', 10, 'Mon'), '2026-10-26');
});

test('dateOf has no answer rather than a wrong one', () => {
  assert.equal(dateOf('2026-08-17', 0, 'Funday'), null);
  assert.equal(dateOf(null, 0, 'Mon'), null);
  assert.equal(dateOf('2026-08-17', null, 'Mon'), null);
});

test('every day of the start week is week zero', () => {
  assert.equal(weekIndexOf('2026-08-17', '2026-08-17'), 0);
  assert.equal(weekIndexOf('2026-08-17', '2026-08-20'), 0);
  assert.equal(weekIndexOf('2026-08-17', '2026-08-23'), 0, 'Sunday still belongs to that week');
  assert.equal(weekIndexOf('2026-08-17', '2026-08-24'), 1);
});

test('a date before the plan starts is a negative week, not zero', () => {
  // Clamping here would render week 0 sessions onto dates the plan never covers.
  assert.equal(weekIndexOf('2026-08-17', '2026-08-16'), -1);
  assert.equal(weekIndexOf('2026-08-17', '2026-07-27'), -3);
});

test('weekIndexOf works from any day of the start week', () => {
  assert.equal(weekIndexOf('2026-08-19', '2026-08-24'), weekIndexOf('2026-08-17', '2026-08-24'));
});

test('weekIndexOf and dateOf are inverses across daylight saving', () => {
  for (const absWeek of [8, 9, 10, 11]) {
    const iso = dateOf('2026-08-17', absWeek, 'Wed');
    assert.equal(weekIndexOf('2026-08-17', iso), absWeek, iso);
  }
});

test('monthOf keeps the month a date belongs to', () => {
  assert.equal(monthOf('2027-07-25'), '2027-07');
  assert.equal(monthOf('2026-12-31'), '2026-12');
  assert.equal(monthOf('nonsense'), null);
});

test('firstOfMonth is the first of that month', () => {
  assert.equal(firstOfMonth('2027-07'), '2027-07-01');
  assert.equal(firstOfMonth('bad'), null);
});

test('addMonths crosses the year boundary in both directions', () => {
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2027-01', -1), '2026-12');
  assert.equal(addMonths('2026-08', 11), '2027-07');
  assert.equal(addMonths('2026-08', 0), '2026-08');
});

test('a month grid is whole Monday-to-Sunday rows covering the month', () => {
  // August 2026 begins on a Saturday and ends on a Monday, so it needs six rows
  // running 2026-07-27 to 2026-09-06.
  const grid = monthGrid('2026-08', { startISO: '2026-08-17', weeks: 16 });

  assert.equal(grid.month, '2026-08');
  assert.equal(grid.rows.length, 6);
  assert.equal(grid.rows[0].mondayISO, '2026-07-27');
  assert.equal(grid.rows[5].mondayISO, '2026-08-31');

  for (const row of grid.rows) {
    assert.equal(row.days.length, 7);
    assert.equal(row.days[0].day, 'Mon');
    assert.equal(row.days[6].day, 'Sun');
    assert.equal(row.days[0].iso, row.mondayISO);
  }
  assert.equal(grid.rows[5].days[6].iso, '2026-09-06');
});

test('a grid row knows which week of the plan it is', () => {
  const grid = monthGrid('2026-08', { startISO: '2026-08-17', weeks: 16 });
  assert.deepEqual(grid.rows.map((r) => r.absWeek), [null, null, null, 0, 1, 2]);
});

test('days spilling in from the neighbouring months are marked', () => {
  const grid = monthGrid('2026-08', { startISO: '2026-08-17', weeks: 16 });
  const first = grid.rows[0].days;
  assert.equal(first[0].inMonth, false, '2026-07-27 is July');
  assert.equal(first[5].inMonth, true, '2026-08-01 is the Saturday');
  assert.equal(grid.rows[5].days[1].inMonth, false, '2026-09-01 is September');
});

test('a day outside the plan runway is not part of the plan', () => {
  const grid = monthGrid('2026-08', { startISO: '2026-08-17', weeks: 16 });
  const before = grid.rows[0].days[0];
  assert.equal(before.absWeek, null);
  assert.equal(before.inPlan, false);

  const inside = grid.rows[3].days[0];
  assert.equal(inside.absWeek, 0);
  assert.equal(inside.inPlan, true);
  assert.equal(inside.day, 'Mon');
});

test('a month entirely before the plan still renders, with no plan days', () => {
  const grid = monthGrid('2026-05', { startISO: '2026-08-17', weeks: 16 });
  assert.ok(grid.rows.length >= 4);
  assert.ok(grid.rows.every((r) => r.absWeek === null));
  assert.ok(grid.rows.every((r) => r.days.every((d) => d.inPlan === false)));
});

test('the plan runway ends where the season does', () => {
  // A 16-week season from 2026-08-17 ends with week 15: 2026-11-30 to 2026-12-06.
  const grid = monthGrid('2026-12', { startISO: '2026-08-17', weeks: 16 });
  assert.equal(grid.rows[0].mondayISO, '2026-11-30');
  assert.equal(grid.rows[0].absWeek, 15);
  assert.equal(grid.rows[1].absWeek, null, 'week 16 does not exist');
});

test('a grid crossing daylight saving keeps seven-day rows', () => {
  // UK clocks go back on 2026-10-25.
  const grid = monthGrid('2026-10', { startISO: '2026-08-17', weeks: 16 });
  const row = grid.rows.find((r) => r.mondayISO === '2026-10-26');
  assert.ok(row, 'the week after the change is present');
  assert.equal(row.days[6].iso, '2026-11-01');
  assert.equal(row.absWeek, 10);
});

test('a grid has no answer rather than a wrong one', () => {
  assert.equal(monthGrid('bad', { startISO: '2026-08-17', weeks: 16 }), null);
  assert.equal(monthGrid('2026-08', { startISO: null, weeks: 16 }), null);
});

test('a month inside the plan is left where it is', () => {
  assert.equal(clampMonth('2026-10', { fromISO: '2026-08-17', toISO: '2026-12-06' }), '2026-10');
  assert.equal(clampMonth('2026-08', { fromISO: '2026-08-17', toISO: '2026-12-06' }), '2026-08');
  assert.equal(clampMonth('2026-12', { fromISO: '2026-08-17', toISO: '2026-12-06' }), '2026-12');
});

test('a month with no relation to the plan is pulled back to one that has', () => {
  // A stored month survives an import, a cloud merge and a moved start date.
  // Trusting one from a different year strands the calendar on an empty grid
  // with nothing on it to navigate back by.
  assert.equal(clampMonth('2025-08', { fromISO: '2026-08-17', toISO: '2026-12-06' }), '2026-08');
  assert.equal(clampMonth('2028-01', { fromISO: '2026-08-17', toISO: '2026-12-06' }), '2026-12');
});

test('clamping has no answer rather than a wrong one', () => {
  assert.equal(clampMonth('nonsense', { fromISO: '2026-08-17', toISO: '2026-12-06' }), null);
  assert.equal(clampMonth('2026-10', { fromISO: null, toISO: '2026-12-06' }), null);
  assert.equal(clampMonth(null, { fromISO: '2026-08-17', toISO: '2026-12-06' }), null);
});

test('a range that ends before it starts still gives a usable month', () => {
  assert.equal(clampMonth('2027-01', { fromISO: '2026-08-17', toISO: '2026-01-01' }), '2026-08');
});
