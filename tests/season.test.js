import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SEASON,
  multiplier,
  weeklyHours,
  seasonWeeks,
  seasonHours,
  fitToRace,
  planLandings,
} from '../assets/coach/season.js';

/* Golden values taken from ../yootri-rnd/plan_model.py, which is the reference
   implementation. If these drift, the JS port is wrong — not the test. */

test('weeklyHours matches the reference model on its own documented examples', () => {
  assert.equal(weeklyHours(500, 'Base 2', 3), 13.5);   // third loading week
  assert.equal(weeklyHours(500, 'Base 2', 4), 6.5);    // its recovery week
  assert.equal(weeklyHours(900, 'Base 2', 3), 24.0);   // same week, bigger budget
});

test('weeklyHours scales linearly with the annual budget', () => {
  assert.equal(weeklyHours(1000, 'Base 2', 3), weeklyHours(500, 'Base 2', 3) * 2);
});

test('recovery weeks use the season-wide floor, not a fraction of their block', () => {
  // Base 1 and Base 3 have different loads; their recovery weeks should match.
  assert.equal(weeklyHours(700, 'Base 1', 4), weeklyHours(700, 'Base 3', 4));
});

test('multiplier ramps across a block loading weeks and resets on recovery', () => {
  assert.equal(multiplier('Base 2', 1), 1.4 * 0.85);
  assert.equal(multiplier('Base 2', 3), 1.4);
  assert.equal(multiplier('Base 2', 4), 0.7);
});

test('a flat block holds every loading week at its full load', () => {
  // Build 1 overrides ramp to (1.0, 1.0): intensity rises, volume does not.
  assert.equal(multiplier('Build 1', 1), multiplier('Build 1', 3));
});

test('the default season spans 27 weeks', () => {
  assert.equal(seasonWeeks(), 27);
});

test('the default season spends only part of the annual budget', () => {
  // The blocks cover 27 of 52 weeks, so they cannot sum to the annual figure.
  // This is the FINDINGS.md constraint: annual hours is a scale, not a total.
  const spent = seasonHours(700);
  assert.ok(Math.abs(spent - 391.5288) < 0.001, `expected ~391.53, got ${spent}`);
  assert.ok(spent / 700 < 0.6, 'season should spend well under the full budget');
});

test('unknown block names are rejected rather than silently defaulted', () => {
  assert.throws(() => multiplier('Sharpening', 1), /unknown period/i);
});

test('week numbers outside a block are rejected', () => {
  assert.throws(() => multiplier('Peak', 3), /weeks 1..2/);
});

test('DEFAULT_SEASON is exposed as data so a plan can carry its own copy', () => {
  const names = DEFAULT_SEASON.blocks.map((b) => b.name);
  assert.deepEqual(names, ['Prep', 'Base 1', 'Base 2', 'Base 3', 'Build 1', 'Build 2', 'Peak', 'Race']);
});

/* fitToRace — resolving the block model onto a concrete number of weeks.
   This has no equivalent in plan_model.py; the reference model describes a
   season's shape, not how to land it on a given race date. */

test('a full-length season resolves to every block in order', () => {
  const s = fitToRace({ annualHours: 700, weeks: 27 });
  assert.equal(s.length, 27);
  assert.equal(s[0].block, 'Prep');
  assert.equal(s[0].week, 1);
  assert.equal(s.at(-1).block, 'Race');
});

test('every resolved week carries its own hours and recovery flag', () => {
  const s = fitToRace({ annualHours: 700, weeks: 27 });
  assert.ok(s.every((w) => w.hours > 0), 'no week should be zero hours');
  assert.equal(s[3].recovery, false, 'Prep has no recovery week');
  assert.equal(s[7].recovery, true, 'Base 1 week 4 is a recovery week');
  assert.equal(s[7].hours, weeklyHours(700, 'Base 1', 4));
});

test('resolved weeks are numbered from the start, ending at the race', () => {
  const s = fitToRace({ annualHours: 700, weeks: 27 });
  assert.deepEqual(s.map((w) => w.absWeek).slice(0, 3), [0, 1, 2]);
  assert.equal(s.at(-1).absWeek, 26);
});

test('a short runway keeps the race-specific end and drops the front', () => {
  // 16 weeks of the 27-week season = the last 16. Index 11 of the full season
  // is Base 2 week 4, so that is where a 16-week plan starts.
  const s = fitToRace({ annualHours: 700, weeks: 16 });
  assert.equal(s.length, 16);
  assert.equal(s[0].block, 'Base 2');
  assert.equal(s[0].week, 4);
  assert.equal(s.at(-1).block, 'Race');
  assert.equal(s.at(-1).absWeek, 15);
});

test('a long runway extends the front with prep weeks, not extra race weeks', () => {
  const s = fitToRace({ annualHours: 700, weeks: 32 });
  assert.equal(s.length, 32);
  assert.ok(s.slice(0, 5).every((w) => w.block === 'Prep'), 'extra weeks are prep');
  assert.equal(s.at(-1).block, 'Race');
  assert.equal(s.at(-2).block, 'Peak');
});

test('the taper is never truncated away, even on a very short runway', () => {
  const s = fitToRace({ annualHours: 700, weeks: 3 });
  assert.deepEqual(s.map((w) => w.block), ['Peak', 'Peak', 'Race']);
});

test('fitToRace rejects a runway that cannot hold a plan', () => {
  assert.throws(() => fitToRace({ annualHours: 700, weeks: 0 }), /at least one week/i);
});

test('resolved weeks carry the load multiplier that produced them', () => {
  // Downstream rules need to know whether a week is genuinely hard. Inferring
  // that from volume fails in a flat season, where half the weeks sit below the
  // mean by construction. The model already knows; it should say so.
  const season = fitToRace({ annualHours: 700, weeks: 27 });
  assert.ok(season.every((w) => typeof w.load === 'number' && w.load > 0));
  assert.equal(season[0].load, multiplier('Prep', 1));
  assert.ok(season[0].load < 1, 'a prep week is easier than a flat average week');
  const hard = season.find((w) => w.block === 'Base 3' && w.week === 3);
  assert.ok(hard.load > 1, 'the last loading week of Base 3 is harder than average');
});

/* Landing a secondary race on the runway.

   A season can hold more than one race. The primary one fixes the length and
   keeps the model's own two-week peak plus race week; every other race gets a
   *landing* — one taper week and one race week, spliced into whatever block it
   falls in. The season never gets longer, because the primary's date is what
   decides how long it is. */

test('the taper interlude is exactly the peak block down week', () => {
  // The claim the whole design rests on: a secondary landing is the primary's
  // landing with the first peak week removed. Nothing new is invented, so this
  // is an equality and not an approximation.
  assert.equal(multiplier('Taper', 1), multiplier('Peak', 2));
  assert.equal(weeklyHours(700, 'Taper', 1), weeklyHours(700, 'Peak', 2));
});

test('an interlude is not part of the season sequence', () => {
  // It is spliced in, never walked through. If it leaked into the block list
  // every season would silently grow a week and spend a week's more budget.
  assert.equal(seasonWeeks(), 27);
  assert.ok(!DEFAULT_SEASON.blocks.some((b) => b.name === 'Taper'));
  assert.ok(Math.abs(seasonHours(700) - 391.5288) < 0.001);
});

test('a landing puts a taper week before the race week', () => {
  const s = fitToRace({ annualHours: 700, weeks: 20, landings: [8] });
  assert.equal(s[7].block, 'Taper');
  assert.equal(s[8].block, 'Race');
  assert.equal(s[7].hours, weeklyHours(700, 'Taper', 1));
  assert.equal(s[8].hours, weeklyHours(700, 'Race', 1));
  assert.equal(s[7].load, multiplier('Taper', 1));
  assert.equal(s[8].load, multiplier('Race', 1));
});

test('a landing does not lengthen the season', () => {
  // The primary race date decides the runway. A tune-up race comes out of the
  // block it falls in; it does not push the season along.
  const plain = fitToRace({ annualHours: 700, weeks: 20 });
  const landed = fitToRace({ annualHours: 700, weeks: 20, landings: [8] });
  assert.equal(landed.length, plain.length);
  assert.deepEqual(landed.map((w) => w.absWeek), plain.map((w) => w.absWeek));
});

test('the weeks after a landing resume the block they were in', () => {
  const plain = fitToRace({ annualHours: 700, weeks: 20 });
  const landed = fitToRace({ annualHours: 700, weeks: 20, landings: [8] });
  for (let i = 0; i < plain.length; i++) {
    if (i === 7 || i === 8) continue;
    assert.deepEqual(landed[i], plain[i], `week ${i} should be untouched`);
  }
});

test('no landings leaves the season exactly as it was', () => {
  // Every existing caller passes none of this, so the old output is the
  // contract. Byte-identical, not merely equivalent.
  const before = fitToRace({ annualHours: 700, weeks: 27 });
  assert.equal(JSON.stringify(fitToRace({ annualHours: 700, weeks: 27, landings: [] })), JSON.stringify(before));
  assert.equal(JSON.stringify(fitToRace({ annualHours: 700, weeks: 27 })), JSON.stringify(before));
});

test('more than one race can land in a season', () => {
  const s = fitToRace({ annualHours: 700, weeks: 30, landings: [6, 16] });
  assert.deepEqual([s[5].block, s[6].block], ['Taper', 'Race']);
  assert.deepEqual([s[15].block, s[16].block], ['Taper', 'Race']);
});

test('a race in the first week lands without a taper week before it', () => {
  // There is no week before week 0 to taper in. The race week is still built.
  const s = fitToRace({ annualHours: 700, weeks: 20, landings: [0] });
  assert.equal(s[0].block, 'Race');
  assert.deepEqual(planLandings({ weeks: 20, landings: [0] }).applied, [{ absWeek: 0, taperWeek: null }]);
});

/* planLandings — which races the season model will actually build for, and why
   it turned the others down. Exported so the page and the validator explain a
   refusal with the same words rather than each deriving its own. */

test('a landing inside the primary taper is refused', () => {
  // The last three weeks are the primary race's own peak and race week. They
  // are what the whole season was built to arrive at; nothing overwrites them.
  const { applied, refused } = planLandings({ weeks: 20, landings: [17, 18, 19] });
  assert.deepEqual(applied, []);
  assert.deepEqual(refused, [
    { absWeek: 17, reason: 'in-primary-taper' },
    { absWeek: 18, reason: 'in-primary-taper' },
    { absWeek: 19, reason: 'in-primary-taper' },
  ]);
  assert.deepEqual(planLandings({ weeks: 20, landings: [16] }).applied, [{ absWeek: 16, taperWeek: 15 }]);
});

test('two races too close together give the earlier one its taper', () => {
  // A landing needs the week before it free. Two weeks apart is the closest
  // two races can be and both still get one.
  assert.deepEqual(planLandings({ weeks: 20, landings: [6, 7] }).refused, [{ absWeek: 7, reason: 'too-close' }]);
  assert.deepEqual(planLandings({ weeks: 20, landings: [6, 7] }).applied, [{ absWeek: 6, taperWeek: 5 }]);
  assert.deepEqual(planLandings({ weeks: 20, landings: [6, 8] }).applied, [
    { absWeek: 6, taperWeek: 5 },
    { absWeek: 8, taperWeek: 7 },
  ]);
});

test('a race outside the runway is refused rather than clamped', () => {
  // Clamping would build a taper for a race the season does not reach.
  const { applied, refused } = planLandings({ weeks: 20, landings: [-1, 20, 99] });
  assert.deepEqual(applied, []);
  assert.deepEqual(refused.map((r) => r.reason), ['outside-season', 'outside-season', 'outside-season']);
});

test('planLandings is deterministic whatever order the races arrive in', () => {
  const forwards = planLandings({ weeks: 24, landings: [4, 10, 11, 22] });
  const backwards = planLandings({ weeks: 24, landings: [22, 11, 10, 4] });
  assert.deepEqual(forwards, backwards);
  assert.deepEqual(forwards.applied.map((a) => a.absWeek), [4, 10]);
});

test('the same race asked for twice is landed once', () => {
  assert.deepEqual(planLandings({ weeks: 20, landings: [8, 8] }).applied, [{ absWeek: 8, taperWeek: 7 }]);
  assert.deepEqual(planLandings({ weeks: 20, landings: [8, 8] }).refused, []);
});

test('fitToRace lands only what planLandings applied', () => {
  // The two must never disagree: the page explains a refusal that the season
  // model then quietly honoured anyway would be worse than either alone.
  const s = fitToRace({ annualHours: 700, weeks: 20, landings: [6, 7, 18] });
  assert.equal(s[5].block, 'Taper');
  assert.equal(s[6].block, 'Race');
  assert.notEqual(s[7].block, 'Race', 'the too-close race was not landed');
  assert.equal(s[18].block, 'Peak', 'the primary taper is untouched');
  assert.equal(s.at(-1).block, 'Race');
});

test('a landing never damages the race the season was built for', () => {
  for (const weeks of [4, 8, 16, 27, 34]) {
    for (const at of Array.from({ length: weeks }, (_, i) => i)) {
      const s = fitToRace({ annualHours: 700, weeks, landings: [at] });
      assert.equal(s.length, weeks);
      assert.equal(s.at(-1).block, 'Race', `weeks=${weeks} landing=${at}`);
      if (weeks >= 3) {
        assert.equal(s.at(-2).block, 'Peak', `weeks=${weeks} landing=${at}`);
        assert.equal(s.at(-3).block, 'Peak', `weeks=${weeks} landing=${at}`);
      }
    }
  }
});
