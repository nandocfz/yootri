import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ENVELOPE_TYPE, ENVELOPE_VERSION,
  exportEnvelope, readPlanFile, adoptImported, summarizePlan,
} from '../assets/coach/portable.js';
import { newPlan, loadPlan, weekCount, weekTotals, sessionsAt } from '../assets/coach/plan.js';

/* A plan worth round-tripping: a season that is *not* the 16-week default, a
   budget that is not the default 500h, and some history. Everything the old
   import silently threw away is in here on purpose. */
const fullPlan = () => {
  const p = newPlan({
    name: 'My 70.3',
    startISO: '2026-01-05',
    raceDate: '2026-07-05',
    raceType: 'ironman',
    profile: { annualHours: 800 },
    now: 1737000000000,
  });
  const first = p.weeks.w0[0].id;
  const second = p.weeks.w1[0].id;
  return {
    ...p,
    done: { [first]: true },
    actuals: { [second]: { status: 'partial', dur: '0:40' } },
    weekBudgets: { w3: 4 },
    chat: [{ role: 'user', content: 'make week 3 easier' }],
  };
};

/* A v2 plan as the app used to store one: a sparse overlay keyed "Phase_N",
   template-derived session ids, and a phase-relative view. */
const v2Plan = () => ({
  id: 'p-abc123',
  name: 'My old plan',
  start: '2026-01-05',
  weeks: {
    Base_1: [
      { d: 'Tue', day: 'Tue', disc: 'Swim', focus: 'Threshold sets', dur: '0:50', zone: 'Z3', id: 'Base-1-2' },
      { d: 'Sat', day: 'Sat', disc: 'Bike', focus: 'Long ride', dur: '3:00', zone: 'Z2', id: 'Base-1-6' },
    ],
  },
  done: { 'Base-1-2': true },
  chartmode: 'cumulative',
  charthidden: { Swim: true },
  view: { phase: 'Build', week: 2 },
  updatedAt: 1737000000000,
});

const wrote = (plan) => JSON.stringify(exportEnvelope(plan));

/* ---- the envelope ---- */

test('exportEnvelope stamps a type and version so import can recognise the file', () => {
  const env = exportEnvelope(fullPlan());
  assert.equal(env._type, ENVELOPE_TYPE);
  assert.equal(env.version, ENVELOPE_VERSION);
  assert.equal(typeof env.exportedFrom, 'string');
});

test('exportEnvelope leaves the conversation behind', () => {
  const env = exportEnvelope(fullPlan());
  assert.ok(!('chat' in env.plan), 'chat is local, and never travels in a file');
});

test('exportEnvelope does not mutate the plan it was given', () => {
  const p = fullPlan();
  const snap = JSON.parse(JSON.stringify(p));
  exportEnvelope(p);
  assert.deepEqual(p, snap);
});

/* ---- the round trip: the regression this module exists for ---- */

test('a written plan reads back identical, minus the conversation', () => {
  const p = fullPlan();
  const { chat, ...rest } = p;
  const res = readPlanFile(wrote(p));
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(res.plan, rest);
});

test('the profile survives the round trip', () => {
  const p = fullPlan();
  const back = readPlanFile(wrote(p)).plan;
  assert.deepEqual(back.profile, p.profile);
  assert.equal(back.profile.annualHours, 800, 'not reset to the 500h default');
  assert.equal(back.profile.raceType, 'ironman');
  assert.equal(back.profile.raceDate, '2026-07-05');
});

test('the season survives the round trip, so the chart targets the right curve', () => {
  const p = fullPlan();
  const back = readPlanFile(wrote(p)).plan;
  assert.deepEqual(back.season, p.season);
  assert.notEqual(weekCount(p), 16, 'the fixture must not be the default length');
  assert.equal(weekCount(back), weekCount(p));
});

test('every week of the season comes back with its sessions', () => {
  const p = fullPlan();
  const back = readPlanFile(wrote(p)).plan;
  assert.deepEqual(weekTotals(back), weekTotals(p));
});

test('logged actuals and pinned week budgets survive the round trip', () => {
  const p = fullPlan();
  const back = readPlanFile(wrote(p)).plan;
  assert.deepEqual(back.actuals, p.actuals);
  assert.deepEqual(back.done, p.done);
  assert.deepEqual(back.weekBudgets, p.weekBudgets);
});

test('a bare plan object is accepted as well as an envelope', () => {
  const p = fullPlan();
  const { chat, ...rest } = p;
  const res = readPlanFile(JSON.stringify(rest));
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(res.plan, rest);
});

/* ---- older files ---- */

test('a v2 file is upgraded on the way in rather than rejected', () => {
  const res = readPlanFile(JSON.stringify(v2Plan()));
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.upgraded, true);
  assert.equal(res.plan.schema, 3);
  assert.equal(weekCount(res.plan), 16);
  assert.ok(sessionsAt(res.plan, 1).some((s) => s.id === 'Base-1-2'), 'saved weeks are carried across');
});

test('a current file is not reported as upgraded', () => {
  assert.equal(readPlanFile(wrote(fullPlan())).upgraded, false);
});

test('a season week missing from the file reads back as an empty week', () => {
  const p = fullPlan();
  const { chat, ...rest } = p;
  delete rest.weeks.w2;
  const res = readPlanFile(JSON.stringify(rest));
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(res.plan.weeks.w2, [], 'a hole must not crash a render');
  assert.equal(weekCount(res.plan), weekCount(p));
});

/* ---- rejections: each one says what is actually wrong ---- */

const rejections = [
  ['not-json', '{ "plan": '],
  ['not-an-object', '[1, 2, 3]'],
  ['wrong-type', JSON.stringify({ _type: 'strava-export', version: 1, plan: {} })],
  ['no-weeks', JSON.stringify({ id: 'p-1', name: 'x', schema: 3, start: '2026-01-05', season: [{ absWeek: 0 }] })],
  ['bad-start', JSON.stringify({ ...fullPlan(), start: 'someday' })],
  ['no-season', JSON.stringify({ ...fullPlan(), season: [] })],
];

for (const [code, text] of rejections) {
  test(`a file rejected for ${code} says so`, () => {
    const res = readPlanFile(text);
    assert.equal(res.ok, false);
    assert.equal(res.code, code);
    assert.ok(res.reason && res.reason.length > 10, 'the reason is shown to the athlete verbatim');
  });
}

test('every rejection reads differently, so the message is worth showing', () => {
  const reasons = rejections.map(([, text]) => readPlanFile(text).reason);
  assert.equal(new Set(reasons).size, reasons.length);
});

test('an unreadable file never throws — import must fail as data, not as a crash', () => {
  for (const text of ['', 'null', 'undefined', '"a string"', '{}', '[]']) {
    assert.doesNotThrow(() => readPlanFile(text), text);
    assert.equal(readPlanFile(text).ok, false, text);
  }
});

/* ---- adopting what was read ---- */

test('adoptImported mints a fresh id, so importing your own export duplicates it', () => {
  const p = readPlanFile(wrote(fullPlan())).plan;
  const next = adoptImported(p, { id: 'p-fresh', name: 'Imported', now: 42 });
  assert.equal(next.id, 'p-fresh');
  assert.notEqual(next.id, p.id);
  assert.equal(next.name, 'Imported');
  assert.equal(next.updatedAt, 42);
});

test('adoptImported starts the plan with no conversation', () => {
  const p = readPlanFile(wrote(fullPlan())).plan;
  assert.deepEqual(adoptImported(p, { id: 'p-1', name: 'x', now: 1 }).chat, []);
});

test('adoptImported keeps history whose session exists and drops the rest', () => {
  const p = readPlanFile(wrote(fullPlan())).plan;
  const live = p.weeks.w0[0].id;
  const withGhosts = {
    ...p,
    done: { ...p.done, 'ghost-1': true },
    actuals: { ...p.actuals, 'ghost-2': { status: 'done' } },
  };
  const next = adoptImported(withGhosts, { id: 'p-1', name: 'x', now: 1 });
  assert.equal(next.done[live], true);
  assert.ok(!('ghost-1' in next.done));
  assert.ok(!('ghost-2' in next.actuals));
  assert.equal(Object.keys(next.actuals).length, 1, 'the real logged session is kept');
});

test('adoptImported does not mutate the plan it was given', () => {
  const p = readPlanFile(wrote(fullPlan())).plan;
  const snap = JSON.parse(JSON.stringify(p));
  adoptImported(p, { id: 'p-1', name: 'x', now: 1 });
  assert.deepEqual(p, snap);
});

/* ---- the preview ---- */

test('summarizePlan reports what the athlete is about to adopt', () => {
  const p = fullPlan();
  const s = summarizePlan(p);
  assert.equal(s.name, 'My 70.3');
  assert.equal(s.start, '2026-01-05');
  assert.equal(s.weeks, weekCount(p));
  assert.equal(s.raceType, 'ironman');
  assert.equal(s.raceDate, '2026-07-05');
  assert.equal(s.annualHours, 800);
  assert.equal(s.plannedMinutes, weekTotals(p).reduce((a, b) => a + b, 0));
  assert.equal(s.doneCount, 1);
  assert.equal(s.actualCount, 1);
});

test('summarizePlan survives a plan with no history', () => {
  const s = summarizePlan(loadPlan({ id: 'p-1', name: 'x', start: '2026-01-05', weeks: {}, done: {} }));
  assert.equal(s.doneCount, 0);
  assert.equal(s.actualCount, 0);
  assert.equal(s.weeks, 16);
});

/* ---- the file shipped with the app ---- */

test('the example plan in the repo is importable', () => {
  const text = readFileSync(new URL('../assets/example-plan.json', import.meta.url), 'utf8');
  const res = readPlanFile(text);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.plan.schema, 3);
  assert.equal(res.upgraded, false, 'the shipped example must already be current');
  assert.ok(weekCount(res.plan) > 0);
});

/* ---- benchmarks -------------------------------------------------------

   Benchmarks ride on the plan as a top-level field with no schema bump, which
   only works because `migratePlan` passes a v3 record through untouched and the
   envelope carries whatever the plan carries. These lock that down: it is an
   easy property to break and an invisible one to lose. */

const withBenchmark = () => ({
  ...fullPlan(),
  benchmarks: [{
    id: 'bm-1', date: '2026-06-15', distanceMeters: 10000, timeSeconds: 2520,
    source: 'manual', label: 'Sentrumsløpet', current: true,
  }],
});

test('a benchmark survives the export/import round trip', () => {
  const back = readPlanFile(wrote(withBenchmark()));
  assert.equal(back.ok, true);
  assert.deepEqual(back.plan.benchmarks.map((b) => b.id), ['bm-1']);
  assert.equal(back.plan.benchmarks[0].timeSeconds, 2520);
  assert.equal(back.plan.benchmarks[0].current, true);
});

test('an imported benchmark survives being adopted under a fresh identity', () => {
  const back = readPlanFile(wrote(withBenchmark()));
  const adopted = adoptImported(back.plan, { now: 1737000000000, id: 'p-new' });
  assert.equal(adopted.id, 'p-new');
  assert.deepEqual(adopted.benchmarks.map((b) => b.id), ['bm-1']);
});

test('a plan file carrying a broken benchmark imports without it, not without the plan', () => {
  const broken = { ...fullPlan(), benchmarks: [{ id: 'x', date: 'never' }, { nope: true }] };
  const back = readPlanFile(wrote(broken));
  assert.equal(back.ok, true, 'a bad benchmark is not a bad plan');
  assert.deepEqual(back.plan.benchmarks, []);
});

test('a plan file with no benchmarks at all imports with an empty list', () => {
  const { benchmarks, ...none } = withBenchmark();
  const back = readPlanFile(wrote(none));
  assert.equal(back.ok, true);
  assert.deepEqual(back.plan.benchmarks, []);
});
