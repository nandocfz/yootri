import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SHAPE_TABLE, shapeRow, dayBudgets } from '../assets/coach/shape.js';
import { DAYS, normalizeProfile } from '../assets/coach/profile.js';

/* The table is the athlete's own, transcribed from a spreadsheet. Its internal
   consistency is the thing worth pinning: a fat-fingered row would quietly
   reshape every week at that volume and nothing else would notice. */

const rows = () => Object.entries(DEFAULT_SHAPE_TABLE).map(([k, v]) => [Number(k), v]);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const perDayList = (r) => DAYS.map((d) => r.perDay[d]);

test('every table row sums exactly to the weekly total it is keyed by', () => {
  for (const [weekly, days] of rows()) {
    assert.equal(sum(days), weekly, `row ${weekly} sums to ${sum(days)}`);
  }
});

test('the table covers 4:00 to 22:30 in half-hour steps', () => {
  const keys = rows().map(([k]) => k).sort((a, b) => a - b);
  assert.equal(keys[0], 240);
  assert.equal(keys.at(-1), 1350);
  assert.equal(keys.length, 38);
  keys.forEach((k, i) => assert.equal(k, 240 + i * 30));
});

test('every table row gives seven days in quarter-hour units', () => {
  for (const [weekly, days] of rows()) {
    assert.equal(days.length, DAYS.length, `row ${weekly}`);
    for (const m of days) assert.equal(m % 15, 0, `row ${weekly} has ${m}`);
  }
});

test('shapeRow returns a known row unchanged', () => {
  assert.deepEqual(shapeRow(720), [60, 120, 60, 120, 90, 180, 90]);
  assert.deepEqual(shapeRow(390), [0, 75, 45, 60, 60, 90, 60]);
});

test('shapeRow interpolates between rows and still sums to the ask', () => {
  const row = shapeRow(705); // halfway between the 11:30 and 12:00 rows
  assert.deepEqual(row, [60, 120, 60, 105, 90, 180, 90]);
  assert.equal(sum(row), 705);
});

test('shapeRow scales the lightest row down below the table floor', () => {
  const row = shapeRow(120); // half of the 4:00 row
  assert.deepEqual(row, [0, 30, 0, 30, 0, 45, 15]);
  assert.equal(sum(row), 120);
});

test('shapeRow holds the heaviest shape above the table ceiling', () => {
  const row = shapeRow(1500);
  assert.equal(sum(row), 1500);
  // The 22:30 shape is kept; only its scale changes.
  const top = DEFAULT_SHAPE_TABLE[1350];
  row.forEach((m, i) => assert.ok(Math.abs(m / 1500 - top[i] / 1350) < 1e-9));
});

/* --- dayBudgets ---------------------------------------------------------- */

const roomy = normalizeProfile({
  availability: { Mon: 180, Tue: 180, Wed: 180, Thu: 180, Fri: 180, Sat: 360, Sun: 300 },
});
const mondayRest = normalizeProfile({ ...roomy, availability: { ...roomy.availability, Mon: 0 } });
const dflt = normalizeProfile({}); // 11.5 h across the week, Monday already 0

test('a week that fits inside availability gets the table row verbatim', () => {
  const r = dayBudgets({ budgetMinutes: 720, profile: roomy });
  assert.deepEqual(perDayList(r), [60, 120, 60, 120, 90, 180, 90]);
  assert.equal(r.targetMinutes, 720);
});

test('a rest day pushes its hours out across the rest of the week', () => {
  // The worked example: 12 h, Monday off. The hour does not vanish.
  const r = dayBudgets({ budgetMinutes: 720, profile: mondayRest });
  assert.deepEqual(perDayList(r), [0, 130, 65, 130, 100, 195, 100]);
  assert.equal(sum(perDayList(r)), 720);
});

test('no day is ever budgeted beyond the time the athlete says they have', () => {
  for (const budget of [240, 390, 690, 720, 900, 1350]) {
    for (const p of [roomy, mondayRest, dflt]) {
      const r = dayBudgets({ budgetMinutes: budget, profile: p });
      for (const d of DAYS) {
        assert.ok(r.perDay[d] <= p.availability[d],
          `${budget}: ${d} budgeted ${r.perDay[d]} against ${p.availability[d]}`);
      }
    }
  }
});

test('a light week spreads instead of piling onto the biggest day', () => {
  // The default profile at 6:30. Greedy packing put 185 of 390 minutes on
  // Saturday and left two days empty; the table spreads across five.
  const r = dayBudgets({ budgetMinutes: 390, profile: dflt });
  assert.deepEqual(perDayList(r), [0, 75, 45, 60, 60, 90, 60]);
});

test('a budget the week cannot hold falls back to the time available', () => {
  const r = dayBudgets({ budgetMinutes: 750, profile: dflt }); // capacity is 690
  assert.equal(r.targetMinutes, 690);
  assert.deepEqual(perDayList(r), DAYS.map((d) => dflt.availability[d]));
});

test('the budget is spent in full whenever the week can hold it', () => {
  for (const budget of [240, 300, 390, 465, 690, 720, 705, 900]) {
    const r = dayBudgets({ budgetMinutes: budget, profile: roomy });
    assert.equal(sum(perDayList(r)), budget, `budget ${budget}`);
  }
});

test('every day budget is a whole five minutes', () => {
  for (const budget of [240, 465, 705, 887, 1350]) {
    const r = dayBudgets({ budgetMinutes: budget, profile: mondayRest });
    for (const d of DAYS) assert.equal(r.perDay[d] % 5, 0, `${budget}: ${d}`);
  }
});

test('hours the table wants on an unavailable day go to days that have room', () => {
  // Wednesday is out entirely; the table's 60 minutes for it must reappear.
  const p = normalizeProfile({ ...roomy, availability: { ...roomy.availability, Wed: 0 } });
  const r = dayBudgets({ budgetMinutes: 720, profile: p });
  assert.equal(r.perDay.Wed, 0);
  assert.equal(sum(perDayList(r)), 720);
});

test('a week whose shape the table zeroes still uses the days that are left', () => {
  // At 4:00 the table trains four days. An athlete free only on the other three
  // must still get their four hours rather than an empty week.
  const p = normalizeProfile({
    availability: { Mon: 180, Tue: 0, Wed: 180, Thu: 0, Fri: 180, Sat: 0, Sun: 0 },
  });
  const r = dayBudgets({ budgetMinutes: 240, profile: p });
  assert.equal(sum(perDayList(r)), 240);
});

test('dayBudgets is deterministic', () => {
  const a = dayBudgets({ budgetMinutes: 705, profile: mondayRest });
  const b = dayBudgets({ budgetMinutes: 705, profile: mondayRest });
  assert.deepEqual(a, b);
});

test('an athlete with no time at all gets an empty week rather than a throw', () => {
  const p = normalizeProfile({ availability: Object.fromEntries(DAYS.map((d) => [d, 0])) });
  const r = dayBudgets({ budgetMinutes: 720, profile: p });
  assert.equal(r.targetMinutes, 0);
  assert.equal(sum(perDayList(r)), 0);
});

/* --- steering the shape ---------------------------------------------------
   Availability alone already covers the common case: a day set to 0 is a rest
   day and its hours reappear elsewhere. These are the knobs for when the
   athlete wants to say where "elsewhere" is. */

test('the shape can be switched off, leaving each day its whole availability', () => {
  const p = normalizeProfile({ weekShape: { enabled: false } });
  const r = dayBudgets({ budgetMinutes: 390, profile: p });
  assert.deepEqual(perDayList(r), DAYS.map((d) => p.availability[d]));
  assert.equal(r.targetMinutes, 390);
});

test('a pinned day gets exactly what it was pinned to', () => {
  const p = normalizeProfile({ ...roomy, weekShape: { pins: { Wed: 120 } } });
  const r = dayBudgets({ budgetMinutes: 720, profile: p });
  assert.equal(r.perDay.Wed, 120);
  assert.equal(sum(perDayList(r)), 720, 'the rest of the week absorbs the difference');
});

test('a pin is still capped by the time available that day', () => {
  const p = normalizeProfile({
    ...roomy,
    availability: { ...roomy.availability, Wed: 60 },
    weekShape: { pins: { Wed: 120 } },
  });
  assert.equal(dayBudgets({ budgetMinutes: 720, profile: p }).perDay.Wed, 60);
});

test('pins that overrun the week are scaled back rather than overspending it', () => {
  const p = normalizeProfile({ ...roomy, weekShape: { pins: { Sat: 300, Sun: 300 } } });
  const r = dayBudgets({ budgetMinutes: 240, profile: p });
  assert.equal(sum(perDayList(r)), 240);
  assert.equal(r.perDay.Sat, 120);
  assert.equal(r.perDay.Sun, 120);
});

test('a rest day can be told to push its hours to the weekend', () => {
  const p = normalizeProfile({ ...mondayRest, weekShape: { spread: 'weekend' } });
  const r = dayBudgets({ budgetMinutes: 720, profile: p });
  // The table's own Tue–Fri figures stand; only Monday's hour moves, and it
  // lands on Saturday and Sunday in their own proportion rather than everywhere.
  assert.deepEqual(perDayList(r), [0, 120, 60, 120, 90, 220, 110]);
});

test('a rest day can be told to push its hours to one named day', () => {
  const p = normalizeProfile({ ...mondayRest, weekShape: { spread: 'Wed' } });
  const r = dayBudgets({ budgetMinutes: 720, profile: p });
  assert.deepEqual(perDayList(r), [0, 120, 120, 120, 90, 180, 90]);
});

test('spreading evenly gives every day with room the same share', () => {
  const p = normalizeProfile({ ...mondayRest, weekShape: { spread: 'even' } });
  const r = dayBudgets({ budgetMinutes: 720, profile: p });
  assert.deepEqual(perDayList(r), [0, 130, 70, 130, 100, 190, 100]);
});

test('a week below the table is left to fill the time available', () => {
  // The table starts at 4:00 because below that there is no distribution to
  // prescribe — an hour is one session, and scaling the 4:00 row down just
  // shatters it into slivers too short to train.
  const r = dayBudgets({ budgetMinutes: 60, profile: dflt });
  assert.deepEqual(perDayList(r), DAYS.map((d) => dflt.availability[d]));
  assert.equal(r.targetMinutes, 60);
});

test('no day is ever given less than a session is worth', () => {
  // Saturday is out, so the table's biggest share has to go somewhere. Spread
  // over the three days the table gives nothing to, it becomes 15 minutes each —
  // under the floor the generator will schedule, so those minutes vanish from
  // the plan and the week comes in three quarters of an hour short.
  const p = normalizeProfile({
    availability: { Mon: 240, Tue: 60, Wed: 240, Thu: 45, Fri: 45, Sat: 0, Sun: 90 },
    weekShape: { spread: 'weekend' },
  });
  const r = dayBudgets({ budgetMinutes: 240, profile: p });
  assert.equal(sum(perDayList(r)), 240, 'the week still has to spend its budget');
  for (const d of DAYS) {
    assert.ok(r.perDay[d] === 0 || r.perDay[d] >= 20,
      `${d} was given ${r.perDay[d]} minutes — too little to train`);
  }
});

/* Closed days — the days a week cannot use at all.

   A race week is the case this exists for: nothing is trained on race day, and
   nothing after it. Availability is the athlete's standing ceiling and must not
   be edited to say so, because it would still say so next week. */

test('a closed day is given nothing', () => {
  const p = normalizeProfile({});
  const r = dayBudgets({ budgetMinutes: 600, profile: p, closedDays: ['Sat', 'Sun'] });
  assert.equal(r.perDay.Sat, 0);
  assert.equal(r.perDay.Sun, 0);
});

test('a closed day hands its minutes to the days that are left', () => {
  // Not lost, and not silently shrinking the week: the same rule a rest day in
  // `availability` already follows.
  const p = normalizeProfile({});
  const open = dayBudgets({ budgetMinutes: 300, profile: p });
  const closed = dayBudgets({ budgetMinutes: 300, profile: p, closedDays: ['Sun'] });
  assert.equal(sum(perDayList(open)), open.targetMinutes);
  assert.equal(sum(perDayList(closed)), closed.targetMinutes);
  assert.ok(closed.perDay.Sat >= open.perDay.Sat, 'Saturday takes some of what Sunday gave up');
});

test('closing a day lowers what the week can hold', () => {
  // Capacity is the sum of the days that are open. A week whose budget outran
  // the days left has to come down, exactly as it does for a rest day.
  const p = normalizeProfile({ availability: { Mon: 60, Tue: 60, Wed: 60, Thu: 60, Fri: 60, Sat: 60, Sun: 60 } });
  const r = dayBudgets({ budgetMinutes: 420, profile: p, closedDays: ['Fri', 'Sat', 'Sun'] });
  assert.equal(r.targetMinutes, 240);
  assert.equal(sum(perDayList(r)), 240);
});

test('closing days works with the shape switched off too', () => {
  const p = normalizeProfile({ weekShape: { enabled: false } });
  const r = dayBudgets({ budgetMinutes: 600, profile: p, closedDays: ['Sun'] });
  assert.equal(r.perDay.Sun, 0);
});

test('a pin on a closed day does not reopen it', () => {
  // A pin is an instruction, but it cannot invent time on a day the week does
  // not have — the same rule that already caps a pin at the day's availability.
  const p = normalizeProfile({ weekShape: { pins: { Sun: 90 } } });
  const r = dayBudgets({ budgetMinutes: 600, profile: p, closedDays: ['Sun'] });
  assert.equal(r.perDay.Sun, 0);
});

test('closing nothing is the same as not asking', () => {
  const p = normalizeProfile({});
  const plain = dayBudgets({ budgetMinutes: 540, profile: p });
  assert.deepEqual(dayBudgets({ budgetMinutes: 540, profile: p, closedDays: [] }), plain);
  assert.deepEqual(dayBudgets({ budgetMinutes: 540, profile: p, closedDays: ['Blursday'] }), plain);
});
