import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RACE_TYPES, EVENT_KINDS, normalizeEvent, normalizeEvents, upsertEvent, removeEvent,
  goalEvent, eventsByDate, raceFieldsOf, seedEventsFromProfile,
} from '../assets/coach/events.js';
import { raceDemandMinutes } from '../assets/coach/generate.js';

/* An event is the athlete's own note on the calendar, and one of them — the
   goal event — is what the season is aimed at. That one drives the plan's race
   date and distance, so the invariant that matters most here is that there is
   never more than one of it. */

const cascais = { id: 'ev-1', name: 'Ironman Cascais', date: '2027-07-25', kind: 'race', raceType: 'ironman', goal: true };

test('an event keeps what it was given', () => {
  const ev = normalizeEvent(cascais);
  assert.equal(ev.id, 'ev-1');
  assert.equal(ev.name, 'Ironman Cascais');
  assert.equal(ev.date, '2027-07-25');
  assert.equal(ev.kind, 'race');
  assert.equal(ev.raceType, 'ironman');
  assert.equal(ev.goal, true);
  assert.equal(ev.note, '');
});

test('a date is canonicalised so two spellings of one day are one day', () => {
  assert.equal(normalizeEvent({ id: 'e', date: '2027-7-5' }).date, '2027-07-05');
});

test('an event without a date is not an event', () => {
  assert.equal(normalizeEvent({ id: 'e', name: 'Someday' }), null);
  assert.equal(normalizeEvent({ id: 'e', date: 'next summer' }), null);
});

test('an event without an id is dropped rather than given a colliding one', () => {
  assert.equal(normalizeEvent({ date: '2027-07-25' }), null);
  assert.equal(normalizeEvent({ date: '2027-07-25' }, { id: 'ev-9' }).id, 'ev-9');
});

test('a name is trimmed and an unnamed event is allowed through', () => {
  assert.equal(normalizeEvent({ id: 'e', date: '2027-07-25', name: '  Cascais  ' }).name, 'Cascais');
  assert.equal(normalizeEvent({ id: 'e', date: '2027-07-25' }).name, '');
});

test('an unrecognised kind falls back rather than being invented', () => {
  assert.equal(normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'wedding' }).kind, 'other');
  assert.ok(EVENT_KINDS.includes('race'));
  assert.ok(EVENT_KINDS.includes('other'));
});

test('only a race carries a distance', () => {
  assert.equal(normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'other', raceType: 'ironman' }).raceType, null);
  assert.equal(normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'race', raceType: 'marathon' }).raceType, null,
    'a distance the generator does not know is no distance at all');
});

test('only a race can be the goal event', () => {
  // The goal event sets the plan's race date and distance, so a non-race one
  // would be aiming the season at something it cannot size.
  const ev = normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'other', goal: true });
  assert.equal(ev.goal, false);
});

test('a list comes back in date order', () => {
  const list = normalizeEvents([
    { id: 'c', date: '2027-07-25' },
    { id: 'a', date: '2026-09-01' },
    { id: 'b', date: '2027-01-10' },
  ]);
  assert.deepEqual(list.map((e) => e.id), ['a', 'b', 'c']);
});

test('a list drops what it cannot use instead of throwing', () => {
  const list = normalizeEvents([cascais, null, 'nonsense', { id: 'x' }, { date: '2027-01-01' }]);
  assert.deepEqual(list.map((e) => e.id), ['ev-1']);
  assert.deepEqual(normalizeEvents(null), []);
  assert.deepEqual(normalizeEvents(undefined), []);
});

test('a repeated id is kept once', () => {
  const list = normalizeEvents([
    { id: 'dup', date: '2026-09-01', name: 'first' },
    { id: 'dup', date: '2027-01-10', name: 'second' },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'first');
});

test('a record claiming two goal events keeps only the earliest', () => {
  const list = normalizeEvents([
    { id: 'late', date: '2027-07-25', kind: 'race', goal: true },
    { id: 'early', date: '2026-10-04', kind: 'race', goal: true },
  ]);
  assert.deepEqual(list.filter((e) => e.goal).map((e) => e.id), ['early']);
});

test('the goal event is the one the season is aimed at', () => {
  const list = normalizeEvents([cascais, { id: 'b', date: '2026-10-04', kind: 'race' }]);
  assert.equal(goalEvent(list).id, 'ev-1');
  assert.equal(goalEvent([]), null);
  assert.equal(goalEvent(normalizeEvents([{ id: 'b', date: '2026-10-04' }])), null);
});

test('adding a goal event stands the previous one down', () => {
  const list = normalizeEvents([cascais]);
  const next = upsertEvent(list, { id: 'ev-2', name: 'Lisbon', date: '2026-10-04', kind: 'race', goal: true });
  assert.deepEqual(next.filter((e) => e.goal).map((e) => e.id), ['ev-2']);
  assert.equal(next.length, 2);
});

test('adding a non-goal event leaves the goal alone', () => {
  const next = upsertEvent(normalizeEvents([cascais]), { id: 'ev-2', date: '2026-10-04', kind: 'race' });
  assert.deepEqual(next.filter((e) => e.goal).map((e) => e.id), ['ev-1']);
});

test('upsert replaces an event with the same id rather than duplicating it', () => {
  const next = upsertEvent(normalizeEvents([cascais]), { ...cascais, name: 'Cascais 2027' });
  assert.equal(next.length, 1);
  assert.equal(next[0].name, 'Cascais 2027');
});

test('upsert never edits the list it was handed', () => {
  const list = normalizeEvents([cascais]);
  const before = JSON.stringify(list);
  upsertEvent(list, { id: 'ev-2', date: '2026-10-04', kind: 'race', goal: true });
  assert.equal(JSON.stringify(list), before);
});

test('removing an event leaves the rest', () => {
  const list = normalizeEvents([cascais, { id: 'ev-2', date: '2026-10-04' }]);
  assert.deepEqual(removeEvent(list, 'ev-1').map((e) => e.id), ['ev-2']);
  assert.equal(removeEvent(list, 'nope').length, 2);
});

test('events are grouped by date so a grid can look a day up', () => {
  const list = normalizeEvents([
    cascais,
    { id: 'ev-2', name: 'Parkrun', date: '2027-07-25' },
    { id: 'ev-3', name: 'Lisbon', date: '2026-10-04' },
  ]);
  const byDate = eventsByDate(list);
  assert.deepEqual(byDate['2027-07-25'].map((e) => e.id), ['ev-1', 'ev-2']);
  assert.equal(byDate['2026-10-04'].length, 1);
  assert.equal(byDate['2030-01-01'], undefined);
});

test('the race fields the plan needs come from the goal event', () => {
  assert.deepEqual(raceFieldsOf(normalizeEvents([cascais])), { raceDate: '2027-07-25', raceType: 'ironman' });
});

test('no goal event means no race fields to impose', () => {
  assert.deepEqual(raceFieldsOf(normalizeEvents([{ id: 'a', date: '2026-10-04' }])), { raceDate: null, raceType: null });
  assert.deepEqual(raceFieldsOf([]), { raceDate: null, raceType: null });
});

test('an older plan is seeded with a goal event from its race date', () => {
  const seeded = seedEventsFromProfile({ raceDate: '2027-07-25', raceType: 'ironman' }, { id: 'ev-seed' });
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].id, 'ev-seed');
  assert.equal(seeded[0].date, '2027-07-25');
  assert.equal(seeded[0].raceType, 'ironman');
  assert.equal(seeded[0].goal, true);
  assert.equal(seeded[0].kind, 'race');
  assert.ok(seeded[0].name, 'it needs something to show on the grid');
});

test('a plan with no race date is seeded with nothing', () => {
  assert.deepEqual(seedEventsFromProfile({ raceDate: null, raceType: '70.3' }, { id: 'ev-seed' }), []);
  assert.deepEqual(seedEventsFromProfile(null, { id: 'ev-seed' }), []);
});

test('every distance an event offers is one the generator sizes differently', () => {
  // The picker would be offering the same season four times over if two of
  // these fell back to the same demand.
  const demands = new Set(RACE_TYPES.map(raceDemandMinutes));
  assert.equal(demands.size, RACE_TYPES.length);
  assert.ok(RACE_TYPES.every((t) => raceDemandMinutes(t) > 0));
});

test('an event that cannot be stored leaves the list as it was', () => {
  const list = normalizeEvents([cascais]);
  assert.deepEqual(upsertEvent(list, { id: 'ev-2', date: 'someday' }), list);
  assert.deepEqual(upsertEvent(list, null), list);
});
