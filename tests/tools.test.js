import test from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_DEFS, createSession, callTool, sessionDiff } from '../assets/coach/tools.js';
import { loadPlan, newPlan, sessionsAt } from '../assets/coach/plan.js';
import { setActual } from '../assets/coach/actuals.js';
import { durToMin } from '../assets/coach/duration.js';

const basePlan = () => loadPlan({
  id: 'p-1', name: 'T', start: '2026-01-05', weeks: {}, done: {}, view: { phase: 'Base', week: 0 },
});
const call = (s, name, input) => callTool(s, name, input ?? {});
const parse = (r) => JSON.parse(r.content);

test('every tool declares a name, a description and a schema', () => {
  assert.ok(TOOL_DEFS.length > 0);
  for (const t of TOOL_DEFS) {
    assert.equal(typeof t.name, 'string');
    assert.ok(t.description.length > 20, `${t.name} needs a real description`);
    assert.equal(t.input_schema.type, 'object');
  }
});

test('tool names are unique', () => {
  const names = TOOL_DEFS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test('no tool can emit a session duration directly', () => {
  // The engine owns every number. If a tool took a duration, the model could
  // write "9:99" into a plan and the whole engine-owns-the-maths split is gone.
  for (const t of TOOL_DEFS) {
    const props = Object.keys(t.input_schema.properties ?? {});
    for (const p of props) {
      assert.ok(!/^(dur|duration|minutes_for_session)$/i.test(p),
        `${t.name} exposes a raw duration parameter (${p})`);
    }
  }
});

/* Reading */

test('get_plan_summary describes the season without dumping every session', () => {
  const s = createSession(basePlan());
  const out = parse(call(s, 'get_plan_summary'));
  assert.equal(out.totalWeeks, 16);
  assert.ok(out.annualHours > 0);
  assert.ok(Array.isArray(out.blocks) && out.blocks.length > 0);
  assert.ok(!JSON.stringify(out).includes('"zone"'), 'summary should stay compact');
});

test('get_week returns the sessions for one week', () => {
  const s = createSession(basePlan());
  const out = parse(call(s, 'get_week', { week: 2 }));
  assert.equal(out.week, 2);
  assert.ok(out.sessions.length > 0);
  assert.ok(out.sessions.every((x) => x.day && x.disc));
});

test('get_week clamps rather than failing on a week that does not exist', () => {
  const s = createSession(basePlan());
  // Sixteen weeks, so the last one is week 16 — the number on the board, not
  // the engine's absWeek 15.
  assert.equal(parse(call(s, 'get_week', { week: 999 })).week, 16);
});

test('get_profile reports availability and constraints', () => {
  const s = createSession(basePlan());
  const out = parse(call(s, 'get_profile'));
  assert.ok(out.availability.Sat >= 0);
  assert.ok(Array.isArray(out.constraints));
});

test('get_compliance reports what has actually been done', () => {
  let plan = basePlan();
  for (const x of sessionsAt(plan, 0).filter((v) => durToMin(v.dur) > 0)) {
    plan = setActual(plan, x.id, { status: 'done', rpe: 7 });
  }
  const s = createSession(plan);
  // Week 1 is where the actuals are; ask about the week after it.
  const out = parse(call(s, 'get_compliance', { upto_week: 2, weeks: 1 }));
  assert.equal(out.ratio, 1);
  assert.equal(out.meanRpe, 7);
});

/* Writing — always into a draft */

test('a write tool never touches the stored plan', () => {
  const plan = basePlan();
  const snapshot = JSON.parse(JSON.stringify(plan));
  const s = createSession(plan);
  call(s, 'set_annual_hours', { hours: 800 });
  assert.deepEqual(s.plan, snapshot, 'the stored plan must be untouched');
  assert.ok(s.draft, 'the change should land in a draft');
});

test('reads reflect pending changes, so the model can see its own work', () => {
  const s = createSession(basePlan());
  call(s, 'set_annual_hours', { hours: 900 });
  assert.equal(parse(call(s, 'get_profile')).annualHours, 900);
});

test('set_availability changes one day and refits around it', () => {
  const s = createSession(basePlan());
  call(s, 'set_availability', { day: 'Wed', minutes: 0 });
  const prof = parse(call(s, 'get_profile'));
  assert.equal(prof.availability.Wed, 0);
  const wk = parse(call(s, 'get_week', { week: 3 }));
  assert.ok(wk.sessions.filter((x) => x.day === 'Wed' && x.minutes > 0).length === 0,
    'nothing should be scheduled on a day with no time');
});

test('set_constraint keeps a discipline off the days it cannot happen', () => {
  const s = createSession(basePlan());
  call(s, 'set_constraint', { discipline: 'Swim', rule: 'avoidDays', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] });
  const wk = parse(call(s, 'get_week', { week: 4 }));
  assert.equal(wk.sessions.filter((x) => x.disc === 'Swim').length, 0);
});

test('set_week_budget changes one week without disturbing the others', () => {
  const s = createSession(basePlan());
  const before = parse(call(s, 'get_week', { week: 5 })).plannedMinutes;
  const other = parse(call(s, 'get_week', { week: 6 })).plannedMinutes;
  call(s, 'set_week_budget', { week: 5, hours: 4 });
  assert.equal(parse(call(s, 'get_week', { week: 5 })).plannedMinutes, 240);
  assert.notEqual(before, 240);
  assert.equal(parse(call(s, 'get_week', { week: 6 })).plannedMinutes, other, 'week 6 untouched');
});

test('set_split expresses a per-block preference', () => {
  const s = createSession(basePlan());
  call(s, 'set_split', { block: 'Base 3', weights: { Bike: 0.5, Run: 0.3, Strength: 0.2 } });
  const prof = parse(call(s, 'get_profile'));
  assert.deepEqual(prof.splits['Base 3'], { Bike: 0.5, Run: 0.3, Strength: 0.2 });
});

test('move_session moves a session to another day', () => {
  const s = createSession(basePlan());
  const wk = parse(call(s, 'get_week', { week: 1 }));
  const target = wk.sessions.find((x) => x.minutes > 0);
  call(s, 'move_session', { week: 1, session_id: target.id, day: 'Sun' });
  const after = parse(call(s, 'get_week', { week: 1 }));
  assert.equal(after.sessions.find((x) => x.id === target.id).day, 'Sun');
});

/* Failing safely */

test('an unknown tool reports an error rather than throwing', () => {
  const s = createSession(basePlan());
  const r = call(s, 'delete_everything', {});
  assert.equal(r.isError, true);
  assert.match(r.content, /unknown tool/i);
});

test('nonsense input is rejected with a message the model can act on', () => {
  const s = createSession(basePlan());
  const r = call(s, 'set_availability', { day: 'Blursday', minutes: 60 });
  assert.equal(r.isError, true);
  assert.match(r.content, /Blursday|day/i);
  assert.equal(s.draft, null, 'a rejected call must not leave a half-made draft');
});

test('a tool that would make an impossible week still only writes a draft', () => {
  const s = createSession(basePlan());
  call(s, 'set_availability', { day: 'Mon', minutes: 0 });

  // Look the session up in the draft, the way the model would via get_week —
  // refitting regenerates weeks, so an id read from the stored plan beforehand
  // may since have been reused by a different session.
  const wk = parse(call(s, 'get_week', { week: 0 }));
  const victim = wk.sessions.find((x) => x.minutes > 0);
  const moved = call(s, 'move_session', { week: 0, session_id: victim.id, day: 'Mon' });
  assert.equal(moved.isError, false, moved.content);

  const d = sessionDiff(s);
  assert.ok(d.issues.some((i) => i.level === 'error'), 'the validator should catch it');
  assert.equal(d.blocked, true, 'and the apply must be blocked');
});

test('sessionDiff on an untouched session reports nothing to apply', () => {
  const s = createSession(basePlan());
  const d = sessionDiff(s);
  assert.deepEqual(d.weeks, []);
  assert.equal(d.blocked, false);
});

test('tool results are strings, as the API requires', () => {
  const s = createSession(basePlan());
  for (const name of ['get_plan_summary', 'get_profile']) {
    assert.equal(typeof call(s, name).content, 'string');
  }
});

test('the constraint tool warns that it is season-wide', () => {
  // Testing prose, which is unusual — but this description is load-bearing.
  // Without it a model turns "no pool this week" into "no pool ever", which is
  // exactly what happened the first time this was wired up.
  const t = TOOL_DEFS.find((x) => x.name === 'set_constraint');
  assert.match(t.description, /standing/i);
  assert.match(t.description, /whole season|every week/i);
  assert.match(t.description, /one-off|single-week/i);
});

test('the coach can read deterministic adaptation suggestions', () => {
  let plan = basePlan();
  for (const w of [0, 1]) {
    for (const x of sessionsAt(plan, w).filter((v) => durToMin(v.dur) > 0)) {
      plan = setActual(plan, x.id, { status: 'partial', min: Math.round(durToMin(x.dur) * 0.4) });
    }
  }
  const out = parse(call(createSession(plan), 'get_adaptation_suggestions', { week: 3 }));
  assert.ok(Array.isArray(out) && out.length > 0);
  assert.ok(out.some((x) => x.code === 'under-compliance'));
  assert.ok(out[0].evidence, 'the model should see the numbers, not just a verdict');
});

test('with nothing to say, the adaptation tool says so plainly', () => {
  const r = call(createSession(basePlan()), 'get_adaptation_suggestions', { week: 3 });
  assert.equal(r.isError, false);
  assert.match(r.content, /no suggestions/i);
});

/* Week numbering.

   The engine counts absWeek from 0; the athlete and the board count from 1.
   The tools speak the athlete's language, because a model given a 0-based
   interface turned "cut week 3" into a change to the week labelled Week 4. */

test('a week asked for by number comes back as the same number', () => {
  const s = createSession(basePlan());
  for (const w of [1, 2, 8, 16]) {
    assert.equal(parse(call(s, 'get_week', { week: w })).week, w, `week ${w}`);
  }
});

test('week 1 is the first week of the season, not the second', () => {
  const s = createSession(basePlan());
  const first = parse(call(s, 'get_week', { week: 1 }));
  // sessionsAt speaks the engine's language, so absWeek 0 is the same week.
  const engineFirst = sessionsAt(basePlan(), 0).filter((x) => durToMin(x.dur) > 0);
  assert.deepEqual(first.sessions.map((x) => x.id), engineFirst.map((x) => x.id));
});

test('pinning a budget changes the week the athlete named', () => {
  const s = createSession(basePlan());
  const before = parse(call(s, 'get_week', { week: 4 })).plannedMinutes;
  call(s, 'set_week_budget', { week: 3, hours: 4 });
  assert.equal(parse(call(s, 'get_week', { week: 3 })).plannedMinutes, 240, 'week 3 is the one that changed');
  assert.equal(parse(call(s, 'get_week', { week: 4 })).plannedMinutes, before, 'week 4 untouched');
});

test('what a tool says it did names the week the athlete would recognise', () => {
  const s = createSession(basePlan());
  assert.match(call(s, 'set_week_budget', { week: 3, hours: 4 }).content, /week 3\b/i);
  assert.match(call(createSession(basePlan()), 'regenerate_weeks', { from: 2, to: 4 }).content, /weeks 2–4/i);
});

test('the season summary marks block starts in the athlete numbering', () => {
  const out = parse(call(createSession(basePlan()), 'get_plan_summary'));
  // The first block starts at week 1, never week 0.
  assert.equal(out.blocks[0].startWeek, 1);
  assert.ok(out.blocks.every((b) => b.startWeek >= 1 && b.startWeek <= out.totalWeeks));
});

test('a suggested tool call is handed back in the numbering the tools accept', () => {
  // adapt.js works in absWeek; a suggestion the model copies verbatim must not
  // arrive a week early.
  let plan = basePlan();
  for (let w = 0; w < 3; w++) {
    for (const x of sessionsAt(plan, w).filter((v) => durToMin(v.dur) > 0)) {
      plan = setActual(plan, x.id, { status: 'partial', min: Math.round(durToMin(x.dur) * 0.4) });
    }
  }
  const out = parse(call(createSession(plan), 'get_adaptation_suggestions', { week: 3 }));
  const withAction = out.filter((x) => x.action?.input && 'week' in x.action.input);
  assert.ok(withAction.length, 'expected at least one actionable suggestion');
  for (const x of withAction) {
    assert.equal(x.action.input.week, 3, 'the suggestion should target the week asked about');
  }
});

test('get_plan_summary states whether the budget fits the athlete week', () => {
  // Left to itself the model would have to spot that annualHours and
  // weeklyPlannedMinutes disagree. The conclusion belongs in tested code.
  const flat = newPlan({
    name: 'Flat', startISO: '2026-01-05', now: 0,
    profile: { annualHours: 800, availability: { Mon: 0, Tue: 75, Wed: 90, Thu: 75, Fri: 60, Sat: 240, Sun: 150 } },
  });
  const out = parse(call(createSession(flat), 'get_plan_summary'));
  assert.ok(out.fit, 'the summary carries a fit reading');
  assert.equal(out.fit.weeklyCapacityMinutes, 690);
  assert.equal(out.fit.suggestedAnnualHours, 400);
  assert.ok(out.fit.variationRetained < 0.1);
});

test('a plan whose budget fits says so rather than going quiet', () => {
  const ok = newPlan({
    name: 'Fits', startISO: '2026-01-05', now: 0,
    profile: { annualHours: 400, availability: { Mon: 0, Tue: 75, Wed: 90, Thu: 75, Fri: 60, Sat: 240, Sun: 150 } },
  });
  const out = parse(call(createSession(ok), 'get_plan_summary'));
  assert.equal(out.fit.variationRetained, 1);
});

test('get_plan_summary says when the volume outstrips the race', () => {
  const big = { Mon: 600, Tue: 600, Wed: 600, Thu: 600, Fri: 600, Sat: 600, Sun: 600 };
  const out = parse(call(createSession(newPlan({
    name: 'Overkill', startISO: '2026-01-05', now: 0,
    profile: { annualHours: 2000, raceType: 'sprint', availability: big },
  })), 'get_plan_summary'));
  assert.equal(Math.round(out.fit.raceDemandMultiple), 24);
});

test('a plan in proportion to its race reports no multiple to worry about', () => {
  const out = parse(call(createSession(newPlan({
    name: 'Sane', startISO: '2026-01-05', now: 0,
    profile: { annualHours: 500, raceType: '70.3' },
  })), 'get_plan_summary'));
  assert.equal(out.fit.raceDemandMultiple, null);
});

/* The week's shape */

test('get_profile reports the week shape so the coach need not infer it', () => {
  const s = createSession(basePlan());
  const prof = parse(call(s, 'get_profile'));
  assert.ok('weekShape' in prof, 'the coach cannot steer what it cannot read');
  assert.equal(prof.weekShape.enabled, true);
  assert.equal(prof.weekShape.spread, 'proportional');
});

test('set_week_shape sends displaced hours where the athlete asked', () => {
  const s = createSession(basePlan());
  call(s, 'set_week_shape', { spread: 'weekend' });
  assert.equal(parse(call(s, 'get_profile')).weekShape.spread, 'weekend');
});

test('set_week_shape pins a day to a fixed figure', () => {
  const s = createSession(basePlan());
  call(s, 'set_availability', { day: 'Wed', minutes: 180 });
  call(s, 'set_week_shape', { pins: { Wed: 45 } });
  const wk = parse(call(s, 'get_week', { week: 3 }));
  const wed = wk.sessions.filter((x) => x.day === 'Wed').reduce((a, x) => a + x.minutes, 0);
  assert.ok(wed <= 45, `Wednesday holds ${wed} minutes against a 45-minute pin`);
});

test('set_week_shape can hand the week back to plain availability', () => {
  const s = createSession(basePlan());
  call(s, 'set_week_shape', { enabled: false });
  assert.equal(parse(call(s, 'get_profile')).weekShape.enabled, false);
});

test('set_week_shape rejects a spread policy it does not understand', () => {
  const s = createSession(basePlan());
  const r = call(s, 'set_week_shape', { spread: 'whenever' });
  assert.equal(r.isError, true);
  assert.equal(s.draft, null, 'a rejected call must not leave a half-made draft');
});

test('set_week_shape rejects a pin on something that is not a weekday', () => {
  const s = createSession(basePlan());
  const r = call(s, 'set_week_shape', { pins: { Funday: 60 } });
  assert.equal(r.isError, true);
  assert.equal(s.draft, null);
});

/* ---- training paces ---------------------------------------------------

   A read-only tool, so it takes no draft and changes nothing. It exists so the
   coach quotes the same number the panel shows: asked "what pace on Thursday?",
   a model without this answers from its own head, and its head does not know
   the athlete's benchmark. */

const withBenchmark = () => ({
  ...basePlan(),
  benchmarks: [{
    id: 'bm-1', date: '2026-06-15', distanceMeters: 10000, timeSeconds: 2520,
    source: 'manual', label: 'Sentrum 10K', current: true,
  }],
});

test('the paces tool reports the benchmark, the VDOT and the bands', () => {
  const out = parse(call(createSession(withBenchmark()), 'get_training_paces'));

  assert.equal(out.benchmark.distanceMeters, 10000);
  assert.equal(out.benchmark.timeSeconds, 2520);
  assert.equal(out.benchmark.date, '2026-06-15');
  assert.ok(Math.abs(out.vdot - 49.1) < 0.1);

  assert.deepEqual(Object.keys(out.zones), ['easy', 'threshold', 'interval', 'repetition']);
  assert.equal(out.zones.threshold.perKm, '4:19 - 4:32');
  assert.equal(out.zones.easy.perMile, '8:00 - 9:35');
});

test('the paces tool says plainly that there is no benchmark yet', () => {
  // Not an error: "the athlete has not entered a result" is a real answer, and
  // an error result invites the model to retry a tool that will never work.
  const out = call(createSession(basePlan()), 'get_training_paces');
  assert.equal(out.isError, false);
  assert.match(out.content, /no .*result|has not/i);
});

test('reading the paces leaves no draft behind', () => {
  const s = createSession(withBenchmark());
  call(s, 'get_training_paces');
  assert.equal(sessionDiff(s).weeks.length, 0);
  assert.equal(s.draft, null, 'a read never starts a draft');
});

test('the paces tool description says where the number came from', () => {
  // Tool descriptions are load-bearing safety text here: a model that thinks
  // the app measured this will speak about it very differently from one that
  // knows the athlete typed in a race result.
  const def = TOOL_DEFS.find((t) => t.name === 'get_training_paces');
  assert.ok(def, 'the tool is declared');
  assert.match(def.description, /entered|typed|imported/i);
});
