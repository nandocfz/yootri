import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadPlan, blockAt, weekCount, sessionsAt, setSessionsAt,
  refit, diffPlans, applyDraft, weekTotals, newPlan, pruneHistory, mintPlanId, moveSession,
} from '../assets/coach/plan.js';
import { normalizeProfile, DAYS } from '../assets/coach/profile.js';
import { durToMin } from '../assets/coach/duration.js';

const anyDay = (m) => Object.fromEntries(DAYS.map((d) => [d, m]));
const v2 = () => ({
  id: 'p-1', name: 'My 70.3', start: '2026-01-05',
  weeks: {}, done: {}, view: { phase: 'Base', week: 0 },
});

test('loadPlan migrates a v2 plan on the way in', () => {
  const p = loadPlan(v2());
  assert.equal(p.schema, 3);
  assert.equal(weekCount(p), 16);
});

test('loadPlan leaves a v3 plan alone', () => {
  const once = loadPlan(v2());
  assert.deepEqual(loadPlan(once), once);
});

test('blockAt reports which block a week belongs to', () => {
  const p = loadPlan(v2());
  assert.equal(blockAt(p, 0).block, p.season[0].block);
  assert.equal(blockAt(p, weekCount(p) - 1).block, 'Race');
});

test('blockAt clamps rather than returning undefined off the end', () => {
  const p = loadPlan(v2());
  assert.equal(blockAt(p, 999).absWeek, weekCount(p) - 1);
  assert.equal(blockAt(p, -5).absWeek, 0);
});

test('sessionsAt returns a copy, so callers cannot edit the plan by accident', () => {
  const p = loadPlan(v2());
  sessionsAt(p, 0)[0].dur = '9:99';
  assert.notEqual(sessionsAt(p, 0)[0].dur, '9:99');
});

test('setSessionsAt writes without mutating the plan it was given', () => {
  const p = loadPlan(v2());
  const before = JSON.parse(JSON.stringify(p));
  const next = setSessionsAt(p, 2, [{ id: 'x', day: 'Mon', disc: 'Run', dur: '1:00', focus: '', zone: '' }]);
  assert.equal(sessionsAt(next, 2).length, 1);
  assert.deepEqual(p, before, 'the original plan must be untouched');
});

/* Re-fitting produces a draft. Nothing is written until it is applied. */

test('refit returns a new plan and leaves the original alone', () => {
  const p = loadPlan(v2());
  const before = JSON.parse(JSON.stringify(p));
  const draft = refit(p, { profile: { ...p.profile, annualHours: 800 } });
  assert.notDeepEqual(draft.weeks, p.weeks, 'the draft should differ');
  assert.deepEqual(p, before, 'the source plan must be untouched');
});

test('refit rebuilds the season from the new profile', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: { ...p.profile, annualHours: 800 } });
  assert.ok(draft.profile.annualHours === 800);
  assert.ok(
    weekTotals(draft).reduce((a, b) => a + b, 0) > weekTotals(p).reduce((a, b) => a + b, 0),
    'a bigger budget should produce a bigger season',
  );
});

test('refit honours availability, so a squeezed week cannot overflow', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: { ...p.profile, availability: anyDay(45) } });
  for (const [i, mins] of weekTotals(draft).entries()) {
    assert.ok(mins <= 45 * 7, `week ${i} plans ${mins} against 315 available`);
  }
});

test('refit can be scoped to a range, leaving other weeks alone', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: { ...p.profile, annualHours: 900 }, from: 2, to: 4 });
  assert.deepEqual(sessionsAt(draft, 0), sessionsAt(p, 0), 'week 0 untouched');
  assert.deepEqual(sessionsAt(draft, 7), sessionsAt(p, 7), 'week 7 untouched');
  assert.notDeepEqual(sessionsAt(draft, 3), sessionsAt(p, 3), 'week 3 refitted');
});

/* The diff is what the athlete actually approves. */

test('an unchanged draft produces an empty diff', () => {
  const p = loadPlan(v2());
  const d = diffPlans(p, p);
  assert.deepEqual(d.weeks, []);
  assert.equal(d.totalDeltaMinutes, 0);
});

test('the diff reports per-week volume before and after', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: { ...p.profile, annualHours: 800 } });
  const d = diffPlans(p, draft);
  assert.ok(d.weeks.length > 0);
  for (const w of d.weeks) {
    assert.equal(typeof w.absWeek, 'number');
    assert.equal(w.deltaMinutes, w.afterMinutes - w.beforeMinutes);
  }
  assert.equal(
    d.totalDeltaMinutes,
    d.weeks.reduce((a, w) => a + w.deltaMinutes, 0),
  );
});

test('the diff names sessions added, removed and changed', () => {
  const p = loadPlan(v2());
  const week0 = sessionsAt(p, 0);
  const edited = [
    { ...week0[0], dur: '2:00' },                                        // changed
    ...week0.slice(1, -1),                                               // untouched
    { id: 'brand-new', day: 'Fri', disc: 'Run', dur: '0:40', focus: 'x', zone: 'Z2' }, // added
  ];                                                                     // last one dropped
  const d = diffPlans(p, setSessionsAt(p, 0, edited));
  const w = d.weeks.find((x) => x.absWeek === 0);
  assert.equal(w.added.length, 1);
  assert.equal(w.added[0].id, 'brand-new');
  assert.equal(w.removed.length, 1);
  assert.equal(w.changed.length, 1);
  assert.equal(w.changed[0].before.dur, week0[0].dur);
  assert.equal(w.changed[0].after.dur, '2:00');
});

test('the diff carries validation issues so the UI can warn before applying', () => {
  const p = loadPlan(v2());
  // One day deliberately over its available time.
  const over = [{ id: 'x', day: 'Mon', disc: 'Run', dur: '9:00', focus: '', zone: 'Z2' }];
  const d = diffPlans(p, setSessionsAt(p, 0, over));
  assert.ok(d.issues.some((i) => i.code === 'day-over-capacity' && i.level === 'error'));
  assert.equal(d.blocked, true, 'an impossible week must block the apply');
});

test('a merely questionable draft warns but does not block', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: { ...p.profile, annualHours: 2000 } });
  const d = diffPlans(p, draft);
  assert.equal(d.blocked, false);
});

/* Applying is the only thing that changes the stored plan. */

test('applyDraft returns the draft content with a fresh timestamp', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: { ...p.profile, annualHours: 800 } });
  const applied = applyDraft(p, draft, { now: 12345 });
  assert.deepEqual(applied.weeks, draft.weeks);
  assert.equal(applied.updatedAt, 12345);
  assert.equal(applied.id, p.id, 'identity is preserved');
});

test('applyDraft does not mutate either input', () => {
  const p = loadPlan(v2());
  const draft = refit(p, { profile: { ...p.profile, annualHours: 800 } });
  const snapP = JSON.parse(JSON.stringify(p));
  const snapD = JSON.parse(JSON.stringify(draft));
  applyDraft(p, draft, { now: 1 });
  assert.deepEqual(p, snapP);
  assert.deepEqual(draft, snapD);
});

test('completion flags survive an apply where the session survived', () => {
  const p = loadPlan(v2());
  const keep = sessionsAt(p, 0)[0].id;
  const withDone = { ...p, done: { [keep]: true } };
  const applied = applyDraft(withDone, setSessionsAt(withDone, 1, []), { now: 1 });
  assert.equal(applied.done[keep], true);
});

test('completion flags for sessions that no longer exist are dropped', () => {
  const p = loadPlan(v2());
  const withDone = { ...p, done: { 'ghost-session': true, ...{} } };
  const applied = applyDraft(withDone, withDone, { now: 1 });
  assert.equal(applied.done['ghost-session'], undefined, 'stale flags should not accumulate');
});

test('logged actuals for sessions that no longer exist are dropped', () => {
  const p = loadPlan(v2());
  const keep = sessionsAt(p, 0)[0].id;
  const withLogs = { ...p, actuals: { [keep]: { status: 'done' }, 'ghost-session': { status: 'done' } } };
  const applied = applyDraft(withLogs, withLogs, { now: 1 });
  assert.deepEqual(applied.actuals, { [keep]: { status: 'done' } });
});

test('pruneHistory keeps only what the weeks it is given still contain', () => {
  const weeks = { w0: [{ id: 'a' }], w1: [{ id: 'b' }] };
  const out = pruneHistory(weeks, { done: { a: true, gone: true }, actuals: { b: { status: 'done' } } });
  assert.deepEqual(out.done, { a: true });
  assert.deepEqual(out.actuals, { b: { status: 'done' } });
});

test('pruneHistory copes with a plan that has no history at all', () => {
  assert.deepEqual(pruneHistory({ w0: [{ id: 'a' }] }), { done: {}, actuals: {} });
  assert.deepEqual(pruneHistory(undefined, { done: { a: true } }), { done: {}, actuals: {} });
});

test('mintPlanId does not hand out the same id twice in a millisecond', () => {
  const ids = new Set(Array.from({ length: 500 }, () => mintPlanId(1)));
  assert.equal(ids.size, 500, 'a repeat would overwrite the plan it collided with');
});

test('a per-week budget override survives a later refit', () => {
  // Two tool calls in one turn — "make next week 4h" then "no swimming" — must
  // not undo each other. A refit rebuilds the season from the profile, so an
  // override recorded on the plan has to be reapplied on top of it.
  const p = loadPlan(v2());
  const pinned = { ...p, weekBudgets: { w3: 4 } };
  const draft = refit(pinned, { profile: { ...p.profile, annualHours: 900 } });
  assert.equal(weekTotals(draft)[3], 240, 'week 3 should still be the pinned 4h');
  assert.notEqual(weekTotals(draft)[4], 240, 'other weeks follow the new budget');
});

test('week budget overrides are ignored when they name a week that is gone', () => {
  const p = loadPlan(v2());
  const pinned = { ...p, weekBudgets: { w99: 4 } };
  assert.doesNotThrow(() => refit(pinned, {}));
});

test('applying a draft keeps the conversation that happened while it was drafted', () => {
  // The draft is snapshotted when the coach calls its first tool — before it has
  // replied. Taking the chat from the draft therefore rewinds the transcript and
  // loses the coach's own answer. Chat is conversation state, like done and
  // actuals: it belongs to the plan being replaced, not to the proposal.
  const p = loadPlan(v2());
  const mid = refit(p, { profile: { ...p.profile, annualHours: 800 } });
  const withChat = {
    ...p,
    chat: [{ role: 'user', content: 'more hours' }, { role: 'coach', content: 'done' }],
  };
  const applied = applyDraft(withChat, mid, { now: 1 });
  assert.equal(applied.chat.length, 2);
  assert.equal(applied.chat[1].role, 'coach');
});

/* Starting a new season without losing the old one. */

test('newPlan sizes the season from the race date', () => {
  const p = newPlan({ name: 'Ironman 2027', startISO: '2026-08-17', raceDate: '2027-06-14' });
  assert.equal(weekCount(p), 44);
  assert.equal(p.season.at(-1).block, 'Race', 'the taper lands on race week');
});

test('newPlan falls back to a sensible length with no race date', () => {
  const p = newPlan({ name: 'Untitled', startISO: '2026-08-17' });
  assert.ok(weekCount(p) >= 8, `got ${weekCount(p)} weeks`);
  assert.equal(p.profile.raceDate, null);
});

test('a short runway keeps the race-specific end', () => {
  const p = newPlan({ name: 'Sprint', startISO: '2026-08-17', raceDate: '2026-10-05' });
  assert.equal(weekCount(p), 8);
  assert.equal(p.season.at(-1).block, 'Race');
});

test('newPlan inherits a profile when given one', () => {
  const mine = normalizeProfile({
    annualHours: 620,
    availability: { ...anyDay(120), Wed: 0 },
    constraints: [{ disc: 'Swim', rule: 'maxPerWeek', value: 2 }],
  });
  const p = newPlan({ name: 'Next', startISO: '2026-08-17', raceDate: '2027-01-04', profile: mine });
  assert.equal(p.profile.annualHours, 620);
  assert.equal(p.profile.availability.Wed, 0);
  assert.equal(p.profile.constraints.length, 1);
});

test('an inherited profile does not drag the old race date along with it', () => {
  const mine = normalizeProfile({ annualHours: 620, raceDate: '2026-09-01', raceType: 'olympic' });
  const p = newPlan({ name: 'Next', startISO: '2026-08-17', raceDate: '2027-01-04', raceType: 'ironman', profile: mine });
  assert.equal(p.profile.raceDate, '2027-01-04');
  assert.equal(p.profile.raceType, 'ironman');
});

test('a fitted plan arrives with training in it', () => {
  const p = newPlan({ name: 'A', startISO: '2026-08-17', raceDate: '2026-12-07', mode: 'fitted' });
  const totals = weekTotals(p);
  assert.ok(totals.every((m) => m > 0), 'every week should hold training');
});

test('an empty plan arrives as a blank calendar of the right length', () => {
  const p = newPlan({ name: 'B', startISO: '2026-08-17', raceDate: '2026-12-07', mode: 'empty' });
  assert.equal(weekCount(p), weekCount(newPlan({ name: 'A', startISO: '2026-08-17', raceDate: '2026-12-07' })));
  assert.deepEqual(weekTotals(p), weekTotals(p).map(() => 0), 'no training anywhere');
  assert.ok(p.season.length > 0, 'but it still knows its block structure');
});

test('an empty plan still shows every day, so there is somewhere to drop a session', () => {
  const p = newPlan({ name: 'B', startISO: '2026-08-17', raceDate: '2026-12-07', mode: 'empty' });
  const week = sessionsAt(p, 0);
  assert.deepEqual(week.map((s) => s.day), DAYS);
  assert.ok(week.every((s) => s.disc === 'Rest'));
});

test('a new plan starts with no history of its own', () => {
  const p = newPlan({ name: 'C', startISO: '2026-08-17', raceDate: '2026-12-07' });
  assert.deepEqual(p.done, {});
  assert.deepEqual(p.actuals, {});
  assert.deepEqual(p.chat, []);
  assert.equal(p.schema, 3);
});

test('new plans get distinct ids so they cannot overwrite each other', () => {
  const a = newPlan({ name: 'A', startISO: '2026-08-17' });
  const b = newPlan({ name: 'B', startISO: '2026-08-17' });
  assert.notEqual(a.id, b.id);
});

test('refit can resize a season when the race date moves', () => {
  const p = newPlan({ name: 'A', startISO: '2026-08-17', raceDate: '2026-12-07' });
  const before = weekCount(p);
  const draft = refit(p, { profile: { ...p.profile, raceDate: '2027-03-01' }, weeks: 28 });
  assert.notEqual(before, 28, 'the fixture should actually be resized by this');
  assert.equal(weekCount(draft), 28);
  assert.equal(draft.season.at(-1).block, 'Race');
});

test('refit keeps the season length when not told otherwise', () => {
  const p = newPlan({ name: 'A', startISO: '2026-08-17', raceDate: '2026-12-07' });
  assert.equal(weekCount(refit(p, { profile: { ...p.profile, annualHours: 700 } })), weekCount(p));
});

/* ---- Moving a session ---------------------------------------------------- */

test('a session moved within its week just changes day', () => {
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  const next = moveSession(p, { id: s.id, toWeek: 0, day: 'Fri' });
  const moved = sessionsAt(next, 0).find((x) => x.id === s.id);
  assert.equal(moved.day, 'Fri');
  assert.equal(moved.focus, s.focus, 'nothing else about it changes');
  assert.equal(moved.dur, s.dur);
});

test('a session moved to another week leaves the week it came from', () => {
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  const next = moveSession(p, { id: s.id, toWeek: 1, day: 'Tue', mintId: () => 'mv-1' });

  assert.equal(sessionsAt(next, 0).some((x) => x.id === s.id), false, 'gone from week 0');
  const landed = sessionsAt(next, 1).find((x) => x.id === 'mv-1');
  assert.equal(landed.day, 'Tue');
  assert.equal(landed.focus, s.focus);
});

test('a session crossing weeks is given a new id', () => {
  // Generated ids are `w{week}-{n}`, so a session dragged out of week 0 keeps a
  // week-0 id. "Reset week" on week 0 then mints that same id again, and done
  // flags, logged actuals and the diff are all keyed by id — two live sessions
  // sharing one is a silent corruption.
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  const moved = moveSession(p, { id: s.id, toWeek: 1, day: 'Tue', mintId: () => 'mv-1' });
  const reset = refit(moved, { from: 0, to: 0 });

  const ids = Object.values(reset.weeks).flat().map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'every live session has its own id');
});

test('a moved session keeps its tick and its log under the new id', () => {
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  const withHistory = { ...p, done: { [s.id]: true }, actuals: { [s.id]: { status: 'done', min: 45 } } };

  const next = moveSession(withHistory, { id: s.id, toWeek: 2, day: 'Sat', mintId: () => 'mv-1' });

  assert.equal(next.done['mv-1'], true);
  assert.deepEqual(next.actuals['mv-1'], { status: 'done', min: 45 });
  assert.equal(next.done[s.id], undefined, 'the old id is not left behind');
  assert.equal(next.actuals[s.id], undefined);
});

test('a moved session with no history does not invent any', () => {
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  const next = moveSession(p, { id: s.id, toWeek: 1, day: 'Tue', mintId: () => 'mv-1' });
  assert.deepEqual(next.done, {});
  assert.deepEqual(next.actuals, {});
});

test('moveSession does not mutate the plan it was given', () => {
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  const before = JSON.stringify(p);
  moveSession(p, { id: s.id, toWeek: 1, day: 'Tue', mintId: () => 'mv-1' });
  assert.equal(JSON.stringify(p), before);
});

test('moving a session nobody has changes nothing', () => {
  const p = loadPlan(v2());
  assert.deepEqual(moveSession(p, { id: 'no-such-session', toWeek: 1, day: 'Tue' }), p);
});

test('a session cannot be moved off the end of the season', () => {
  // Silently clamping would drop it into the last week instead, which is not
  // what anybody dragging it meant.
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  assert.deepEqual(moveSession(p, { id: s.id, toWeek: weekCount(p), day: 'Tue' }), p);
  assert.deepEqual(moveSession(p, { id: s.id, toWeek: -1, day: 'Tue' }), p);
});

test('a session cannot be moved onto a day that does not exist', () => {
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  assert.deepEqual(moveSession(p, { id: s.id, toWeek: 1, day: 'Funday' }), p);
});

test('week volumes follow the session that moved', () => {
  const p = loadPlan(v2());
  const s = sessionsAt(p, 0).find((x) => durToMin(x.dur) > 0);
  const before = weekTotals(p);
  const next = weekTotals(moveSession(p, { id: s.id, toWeek: 1, day: 'Tue', mintId: () => 'mv-1' }));

  assert.equal(next[0], before[0] - durToMin(s.dur));
  assert.equal(next[1], before[1] + durToMin(s.dur));
});

test('a new plan starts with its race already on the calendar', () => {
  const p = newPlan({ name: 'Cascais', startISO: '2026-08-17', raceDate: '2027-07-25', raceType: 'ironman', now: 1 });
  assert.equal(p.events.length, 1);
  assert.equal(p.events[0].date, '2027-07-25');
  assert.equal(p.events[0].raceType, 'ironman');
  assert.equal(p.events[0].goal, true);
});

test('a new plan with no race date starts with an empty calendar', () => {
  const p = newPlan({ name: 'Base', startISO: '2026-08-17', now: 1 });
  assert.deepEqual(p.events, []);
});

/* ---- benchmarks -------------------------------------------------------

   A benchmark is the running result every pace on a Run card is derived from.
   It rides on the plan as a top-level field, the way `events` and `weekBudgets`
   do, so a v3 record passes through `migratePlan` carrying it untouched. */

const bm = (over = {}) => ({
  id: 'bm-1', date: '2026-06-15', distanceMeters: 10000, timeSeconds: 2520,
  source: 'manual', label: '', current: true, ...over,
});

test('a new plan starts with no benchmarks rather than no field', () => {
  // An absent field means every reader needs its own `?? []`; an empty array
  // means none of them do.
  assert.deepEqual(newPlan({ name: 'x', startISO: '2026-01-05' }).benchmarks, []);
});

test('a new season inherits the benchmarks, the way it inherits constraints', () => {
  // The athlete's 10k did not get slower because they picked a new race.
  const p = newPlan({ name: 'x', startISO: '2026-01-05', benchmarks: [bm()] });
  assert.deepEqual(p.benchmarks.map((b) => b.id), ['bm-1']);
  assert.equal(p.benchmarks[0].current, true);
});

test('loadPlan cleans the benchmarks it was handed', () => {
  // Unlike events, which the page normalizes, benchmarks are read by the coach
  // tool and by the card renderer directly. Cleaning them at the one door every
  // reader comes through is what stops the panel and the coach disagreeing.
  const p = loadPlan({
    ...newPlan({ name: 'x', startISO: '2026-01-05' }),
    benchmarks: [
      bm({ id: 'b', date: '2026-06-15' }),
      bm({ id: 'a', date: '2025-03-01' }),
      { id: 'junk', date: 'never' },
      null,
    ],
  });
  assert.deepEqual(p.benchmarks.map((b) => b.id), ['a', 'b'], 'junk dropped, date order');
  assert.deepEqual(p.benchmarks.filter((x) => x.current).map((x) => x.id), ['b'],
    'two claims to current resolve to the more recent');
});

test('loadPlan stays idempotent once benchmarks are on the plan', () => {
  const once = loadPlan({ ...newPlan({ name: 'x', startISO: '2026-01-05' }), benchmarks: [bm()] });
  assert.deepEqual(loadPlan(once), once);
});

test('applying a draft carries the benchmark it was built with', () => {
  const p = newPlan({ name: 'x', startISO: '2026-01-05' });
  const draft = { ...structuredClone(p), benchmarks: [bm()] };
  assert.deepEqual(applyDraft(p, draft).benchmarks.map((b) => b.id), ['bm-1']);
});

test('a changed pace zone shows up in the diff the athlete approves', () => {
  // paceZone is what a Run card resolves its pace from, so moving a session
  // from easy to threshold is a change worth seeing before it is applied.
  const before = newPlan({ name: 'x', startISO: '2026-01-05' });
  const after = structuredClone(before);
  const target = after.weeks.w0.find((s) => s.disc === 'Run');
  assert.ok(target, 'the fixture has a Run session to change');
  target.paceZone = 'interval';

  const d = diffPlans(before, after);
  assert.equal(d.weeks.length, 1);
  assert.equal(d.weeks[0].changed.length, 1);
  assert.equal(d.weeks[0].changed[0].after.paceZone, 'interval');
});

test('a v2 plan loads with an empty benchmark list, not a missing one', () => {
  // v2 predates benchmarks entirely, so there is nothing to carry across — but
  // the field is present, so no reader downstream needs its own fallback.
  assert.deepEqual(loadPlan(v2()).benchmarks, []);
});
