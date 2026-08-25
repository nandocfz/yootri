import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RACE_TYPES, KNOWN_RACE_TYPES, SECONDARY_RACE_TYPES, STORABLE_RACE_TYPES,
  raceTypeLabel, EVENT_KINDS, EVENT_PRIORITIES,
  normalizeEvent, normalizeEvents, upsertEvent, removeEvent,
  goalEvent, secondaryRaces, eventsByDate, raceFieldsOf, seedEventsFromProfile,
} from '../assets/coach/events.js';
import { raceDemandMinutes } from '../assets/coach/generate.js';

/* An event is the athlete's own note on the calendar, and the races among them
   carry a priority: one is `primary` and the season is aimed at it, any number
   are `secondary` and get a taper and a race week built where they land. The
   primary drives the plan's race date and distance, so the invariant that
   matters most here is that there is never more than one of it. */

const cascais = { id: 'ev-1', name: 'Ironman Cascais', date: '2027-07-25', kind: 'race', raceType: 'ironman', priority: 'primary' };

test('an event keeps what it was given', () => {
  const ev = normalizeEvent(cascais);
  assert.equal(ev.id, 'ev-1');
  assert.equal(ev.name, 'Ironman Cascais');
  assert.equal(ev.date, '2027-07-25');
  assert.equal(ev.kind, 'race');
  assert.equal(ev.raceType, 'ironman');
  assert.equal(ev.priority, 'primary');
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
  assert.equal(normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'race', raceType: 'moon marathon' }).raceType, null,
    'a distance nothing here knows is no distance at all');
});

test('only a race carries a priority', () => {
  // A priority is an instruction to the season model, and a non-race has
  // nothing to instruct it with.
  const ev = normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'other', priority: 'primary' });
  assert.equal(ev.priority, null);
  assert.equal(normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'other', priority: 'secondary' }).priority, null);
});

test('a priority nothing recognises is no priority at all', () => {
  assert.equal(normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'race', priority: 'A' }).priority, null);
  assert.equal(normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'race' }).priority, null);
  assert.deepEqual(EVENT_PRIORITIES, ['primary', 'secondary']);
});

test('a plan written before priorities existed is read as it meant', () => {
  // `goal: true` is what every stored plan, plan file and synced record carries.
  // Reading it as `primary` is what lets the field change with no schema bump.
  const ev = normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'race', raceType: 'ironman', goal: true });
  assert.equal(ev.priority, 'primary');
  assert.equal(ev.goal, undefined, 'the old field is read, not carried forward');

  assert.equal(normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'race', goal: false }).priority, null);
  assert.equal(normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'other', goal: true }).priority, null);
});

test('a stated priority beats the legacy flag', () => {
  const ev = normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'race', raceType: '70.3', goal: true, priority: 'secondary' });
  assert.equal(ev.priority, 'secondary');
});

test('only a distance the season can be sized by may be the primary race', () => {
  // The guard on the whole two-list split. A marathon has no RACE_DEMAND row,
  // so a primary marathon would reach profile.raceType, fall back to 70.3
  // inside the generator, and size the season for a race nobody entered.
  for (const t of ['marathon', 'half-marathon', '10k']) {
    const ev = normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'race', raceType: t, priority: 'primary' });
    assert.equal(ev.raceType, t, 'the distance itself is kept');
    assert.equal(ev.priority, 'secondary', `${t} cannot be what a season is built for`);
  }
});

test('a race with no distance given may still be the primary one', () => {
  // raceFieldsOf hands back a null distance so the profile keeps the one it
  // has. Demoting here would move the season's date for want of a distance.
  const ev = normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'race', priority: 'primary' });
  assert.equal(ev.priority, 'primary');
  assert.equal(ev.raceType, null);
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

test('a record claiming two primary races keeps only the earliest', () => {
  const list = normalizeEvents([
    { id: 'late', date: '2027-07-25', kind: 'race', raceType: 'ironman', priority: 'primary' },
    { id: 'early', date: '2026-10-04', kind: 'race', raceType: '70.3', priority: 'primary' },
  ]);
  assert.deepEqual(list.filter((e) => e.priority === 'primary').map((e) => e.id), ['early']);
  // The loser is still a race on the calendar, and still wants a taper.
  assert.equal(list.find((e) => e.id === 'late').priority, 'secondary');
});

test('any number of races may be secondary', () => {
  const list = normalizeEvents([
    cascais,
    { id: 'b', date: '2026-10-04', kind: 'race', raceType: 'marathon', priority: 'secondary' },
    { id: 'c', date: '2027-03-14', kind: 'race', raceType: '70.3', priority: 'secondary' },
  ]);
  assert.deepEqual(secondaryRaces(list).map((e) => e.id), ['b', 'c'], 'in date order');
  assert.deepEqual(secondaryRaces([]), []);
  assert.deepEqual(secondaryRaces(null), []);
});

test('an event with no priority is a marker and nothing more', () => {
  const list = normalizeEvents([cascais, { id: 'note', date: '2026-12-25', kind: 'other' }]);
  assert.deepEqual(secondaryRaces(list).map((e) => e.id), []);
  assert.equal(goalEvent(list).id, 'ev-1');
});

test('the primary race is the one the season is aimed at', () => {
  const list = normalizeEvents([cascais, { id: 'b', date: '2026-10-04', kind: 'race' }]);
  assert.equal(goalEvent(list).id, 'ev-1');
  assert.equal(goalEvent([]), null);
  assert.equal(goalEvent(normalizeEvents([{ id: 'b', date: '2026-10-04' }])), null);
});

test('adding a primary race stands the previous one down to secondary', () => {
  const list = normalizeEvents([cascais]);
  const next = upsertEvent(list, { id: 'ev-2', name: 'Lisbon', date: '2026-10-04', kind: 'race', raceType: '70.3', priority: 'primary' });
  assert.deepEqual(next.filter((e) => e.priority === 'primary').map((e) => e.id), ['ev-2']);
  assert.equal(next.find((e) => e.id === 'ev-1').priority, 'secondary',
    'the old goal race is still on the calendar and still wants a taper');
  assert.equal(next.length, 2);
});

test('adding a secondary race leaves the primary alone', () => {
  const next = upsertEvent(normalizeEvents([cascais]), { id: 'ev-2', date: '2026-10-04', kind: 'race', raceType: 'marathon', priority: 'secondary' });
  assert.deepEqual(next.filter((e) => e.priority === 'primary').map((e) => e.id), ['ev-1']);
  assert.deepEqual(secondaryRaces(next).map((e) => e.id), ['ev-2']);
});

test('upsert replaces an event with the same id rather than duplicating it', () => {
  const next = upsertEvent(normalizeEvents([cascais]), { ...cascais, name: 'Cascais 2027' });
  assert.equal(next.length, 1);
  assert.equal(next[0].name, 'Cascais 2027');
});

test('upsert never edits the list it was handed', () => {
  const list = normalizeEvents([cascais]);
  const before = JSON.stringify(list);
  upsertEvent(list, { id: 'ev-2', date: '2026-10-04', kind: 'race', raceType: '70.3', priority: 'primary' });
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

test('the race fields the plan needs come from the primary race', () => {
  assert.deepEqual(raceFieldsOf(normalizeEvents([cascais])), { raceDate: '2027-07-25', raceType: 'ironman' });
});

test('a secondary race never reaches the profile', () => {
  // The whole reason the distance lists are separate: profile.raceType keys
  // RACE_DEMAND, and a marathon has no row there.
  const list = normalizeEvents([
    cascais,
    { id: 'ev-2', date: '2026-10-04', kind: 'race', raceType: 'marathon', priority: 'secondary' },
  ]);
  assert.deepEqual(raceFieldsOf(list), { raceDate: '2027-07-25', raceType: 'ironman' });
});

test('no primary race means no race fields to impose', () => {
  assert.deepEqual(raceFieldsOf(normalizeEvents([{ id: 'a', date: '2026-10-04' }])), { raceDate: null, raceType: null });
  assert.deepEqual(raceFieldsOf([]), { raceDate: null, raceType: null });
});

test('an older plan is seeded with a primary race from its race date', () => {
  const seeded = seedEventsFromProfile({ raceDate: '2027-07-25', raceType: 'ironman' }, { id: 'ev-seed' });
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].id, 'ev-seed');
  assert.equal(seeded[0].date, '2027-07-25');
  assert.equal(seeded[0].raceType, 'ironman');
  assert.equal(seeded[0].priority, 'primary');
  assert.equal(seeded[0].kind, 'race');
  assert.ok(seeded[0].name, 'it needs something to show on the grid');
});

test('a plan with no race date is seeded with nothing', () => {
  assert.deepEqual(seedEventsFromProfile({ raceDate: null, raceType: '70.3' }, { id: 'ev-seed' }), []);
  assert.deepEqual(seedEventsFromProfile(null, { id: 'ev-seed' }), []);
});

test('every distance a season can be sized by is one it sizes differently', () => {
  // The picker would be offering the same season twice over if two of these
  // fell back to the same demand — and a retired distance that fell back would
  // silently re-aim a season already built for it.
  const demands = new Set(KNOWN_RACE_TYPES.map(raceDemandMinutes));
  assert.equal(demands.size, KNOWN_RACE_TYPES.length);
  assert.ok(KNOWN_RACE_TYPES.every((t) => raceDemandMinutes(t) > 0));
});

test('only the long-course distances are offered for the race the season is built on', () => {
  // yootri plans long-course endurance racing. A sprint or an olympic is raced
  // off a season built for one of these, not off a season of its own.
  assert.deepEqual(RACE_TYPES, ['70.3', 'ironman']);
  assert.ok(!RACE_TYPES.includes('sprint'));
  assert.ok(!RACE_TYPES.includes('olympic'));
});

test('a secondary race may be a distance no season is built for', () => {
  // A marathon or a sprint is a real thing to put in a build. It never sizes
  // the season, so it never needs a RACE_DEMAND row.
  for (const t of ['10k', 'half-marathon', 'marathon', 'sprint', 'olympic']) {
    assert.ok(SECONDARY_RACE_TYPES.includes(t));
  }
  // What a season *is* built for is also raceable as a tune-up.
  assert.ok(RACE_TYPES.every((t) => SECONDARY_RACE_TYPES.includes(t)));
});

test('the wider list never widens what a season can be sized by', () => {
  // If this ever fails, a distance with no RACE_DEMAND row has become
  // season-sizing and the generator is falling back without saying so.
  assert.ok(KNOWN_RACE_TYPES.every((t) => raceDemandMinutes(t) > 0));
  for (const t of SECONDARY_RACE_TYPES) {
    if (KNOWN_RACE_TYPES.includes(t)) continue;
    const ev = normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'race', raceType: t, priority: 'primary' });
    assert.equal(ev.priority, 'secondary');
  }
});

test('a race already built for a retired distance keeps it', () => {
  // Plans are self-contained: retiring a distance must not reach back into a
  // season somebody is midway through and re-read it as a 70.3.
  for (const retired of ['sprint', 'olympic']) {
    assert.ok(KNOWN_RACE_TYPES.includes(retired));
    assert.equal(
      normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'race', raceType: retired }).raceType,
      retired,
    );
    assert.equal(
      normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'race', raceType: retired, goal: true }).priority,
      'primary',
      'a season already built for one goes on being built for it',
    );
  }
});

test('everything offered is also storable', () => {
  assert.ok(RACE_TYPES.every((t) => KNOWN_RACE_TYPES.includes(t)));
  assert.ok(KNOWN_RACE_TYPES.every((t) => STORABLE_RACE_TYPES.includes(t)));
  assert.ok(SECONDARY_RACE_TYPES.every((t) => STORABLE_RACE_TYPES.includes(t)));
  assert.equal(new Set(STORABLE_RACE_TYPES).size, STORABLE_RACE_TYPES.length, 'no duplicates');
});

test('a distance is shown under its racing name', () => {
  // What a distance is called and what it is stored as are two things. The
  // stored name is a RACE_DEMAND key and reaches Firestore, plan files and
  // every season already built; the shown name is copy and may be restyled
  // without re-aiming a single plan.
  assert.equal(raceTypeLabel('70.3'), 'IM 70.3');
  assert.equal(raceTypeLabel('ironman'), 'IRONMAN');
  assert.equal(raceTypeLabel('marathon'), 'Marathon');
  assert.equal(raceTypeLabel('sprint'), 'Sprint');
});

test('a distance with no name of its own is shown as it is stored', () => {
  // Total, like the rest of the module: a distance from a plan file this app
  // did not write still has to render as something. 'constructor' and
  // 'toString' are in the list because the lookup is a plain object.
  for (const t of ['moon marathon', 'constructor', 'toString']) {
    assert.equal(raceTypeLabel(t), t);
  }
  assert.equal(raceTypeLabel(null), '');
  assert.equal(raceTypeLabel(undefined), '');
});

test('every storable distance has a name to show', () => {
  assert.ok(STORABLE_RACE_TYPES.every((t) => raceTypeLabel(t).length > 0));
});

test('a shown name is never a storable distance', () => {
  // The guard on the whole split. A label that got stored would be a name the
  // generator does not size, so the season would fall back to the default
  // without saying so — an IRONMAN plan quietly built as a 70.3.
  for (const t of STORABLE_RACE_TYPES) {
    const label = raceTypeLabel(t);
    if (label === t) continue;
    assert.ok(!STORABLE_RACE_TYPES.includes(label), `${label} must not be storable`);
    assert.equal(
      normalizeEvent({ id: 'e', date: '2027-07-25', kind: 'race', raceType: label }).raceType,
      null,
    );
  }
});

test('an event that cannot be stored leaves the list as it was', () => {
  const list = normalizeEvents([cascais]);
  assert.deepEqual(upsertEvent(list, { id: 'ev-2', date: 'someday' }), list);
  assert.deepEqual(upsertEvent(list, null), list);
});
