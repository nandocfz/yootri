/* Reading an activity export, so a benchmark can come out of a season of
   training rather than out of memory.

   yootri has no server, so there is nothing here that logs into anything. What
   there is instead is a reader for the file the athlete can already download —
   Garmin Connect's activity list exports as CSV — plus `normalizeActivity`, the
   one definition of a clean activity, which the page also feeds from the TCX
   and GPX it parses with `DOMParser` (a thing an engine module may not touch).

   Two rules govern the whole module.

   **Reading is total.** Every way a file can be wrong comes back as
   `{ ok: false, code, reason }`, and the reason is a sentence written to be
   shown to the athlete unedited. This is the same contract `readPlanFile` holds
   in portable.js and for the same reason: somebody holding the wrong file
   learns nothing from "invalid".

   **Heart rate is discarded at the parse boundary.** The columns are read past
   and never enter a returned record. Everything on a plan syncs to Firestore
   bar the conversation, so a heart-rate field that got this far would be one
   sync away from being stored — and this module is the only place it could
   ever enter from. Keeping it out here means nothing downstream has to
   remember to strip it. */

import { parseISO, toISO, addDays } from './dates.js';
import { MILE_METERS, vdotFrom } from './paces.js';

/** The distances a race is run at, and that an effort can be matched to. */
export const STANDARD_DISTANCES = Object.freeze([
  { key: '5k', label: '5 km', meters: 5000 },
  { key: '10k', label: '10 km', meters: 10000 },
  { key: 'half', label: 'Half marathon', meters: 21097.5 },
  { key: 'marathon', label: 'Marathon', meters: 42195 },
]);

/* How far off a standard distance an effort may be and still count as one. A
   GPS trace of a measured 10 km course routinely reads 10.1; at 11 km the
   athlete ran something else. */
export const DISTANCE_TOLERANCE = 0.03;

/** How far back an effort is still evidence of how fit somebody is now. */
export const DEFAULT_WINDOW_DAYS = 365;

const HELP = 'An import wants the .csv that Garmin Connect’s activity list exports, or a single .tcx or .gpx file.';
const fail = (code, reason) => ({ ok: false, code, reason });

/* ---- CSV ---------------------------------------------------------------- */

/* A real scanner rather than `line.split(',')`, because an activity title is
   free text: "Oslo, Norway 10K" is one field, and splitting on the comma
   silently shifts every column after it by one — which shows up not as an error
   but as a distance read out of the calories column. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c !== '"') { field += c; continue; }
      if (text[i + 1] === '"') { field += '"'; i++; continue; }  // an escaped quote
      quoted = false;
      continue;
    }

    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += c;
  }

  row.push(field);
  rows.push(row);
  return rows;
}

/** A header cell reduced to something two spellings of one column agree on. */
const headerKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * "1:02:03" | "9:30" | "42:00.5" -> seconds, or null.
 *
 * Exported because the page needs exactly this to read the time out of the
 * "add a result" box. One definition of what a time may look like, shared
 * between a typed one and an exported one, is worth more than the encapsulation.
 */
export function parseClock(raw) {
  const t = String(raw ?? '').trim();
  if (!t || !/^[\d:.]+$/.test(t)) return null;

  const parts = t.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length > 3) return null;

  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** "1,234.50" -> 1234.5, or null. Garmin writes the reader's own separators. */
function parseNumber(raw) {
  const n = Number(String(raw ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/* Garmin names the sport in one column: "Running", "Trail Running",
   "Treadmill Running". Anything without "run" in it is a different sport, and
   these are running paces. */
const isRun = (type) => /run/i.test(String(type ?? ''));

/**
 * Read a Garmin Connect activity CSV.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {'km'|'mi'} [opts.unit] the unit the export was written in. Garmin
 *   writes the account's own setting and does not record which it used, so the
 *   athlete says rather than the parser guessing and being confidently wrong.
 * @returns {{ok: true, activities: object[], skipped: number} | {ok: false, code: string, reason: string}}
 */
export function readActivitiesCsv(text, { unit = 'km' } = {}) {
  const src = typeof text === 'string' ? text : '';
  if (!src.trim()) {
    return fail('empty', `That file is empty, so there is nothing in it to read. ${HELP}`);
  }

  const rows = parseCsv(src).filter((r) => r.some((cell) => String(cell).trim() !== ''));
  if (!rows.length) {
    return fail('empty', `That file has nothing in it but blank lines. ${HELP}`);
  }

  const header = rows[0].map(headerKey);
  const col = (name) => header.indexOf(name);
  const iDistance = col('distance');
  const iTime = col('time');

  if (iDistance === -1 || iTime === -1) {
    return fail('no-columns',
      `That file has no Distance and Time columns, so there is no way to tell what was run or how long it took. ${HELP}`);
  }

  const iType = col('activitytype');
  const iDate = col('date');
  const iTitle = col('title');
  const perUnit = unit === 'mi' ? MILE_METERS : 1000;

  const activities = [];
  let skipped = 0;

  for (const row of rows.slice(1)) {
    const type = iType === -1 ? 'Running' : row[iType];
    if (!isRun(type)) continue;   // a bike ride is not unreadable, it is just not a run

    const distance = parseNumber(row[iDistance]);
    const activity = normalizeActivity({
      // Garmin writes "2026-06-15 09:32:10"; the clock time is not needed and
      // the day is what a benchmark is filed under.
      date: String(row[iDate] ?? '').trim().split(/[ T]/)[0],
      distanceMeters: distance === null ? null : distance * perUnit,
      timeSeconds: parseClock(row[iTime]),
      type,
      title: iTitle === -1 ? '' : String(row[iTitle] ?? '').trim(),
    });

    if (activity) activities.push(activity);
    else skipped++;
  }

  return { ok: true, activities, skipped };
}

/* ---- one clean activity ------------------------------------------------- */

const positive = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * One activity in canonical form, or null when it is not usable. Total: bad
 * input is dropped rather than thrown, because activities arrive from files
 * somebody else's software wrote.
 *
 * The returned record carries a date, a distance, a time, a sport and a title.
 * It carries nothing else — in particular no heart rate, whatever the input had.
 */
export function normalizeActivity(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const date = toISO(parseISO(raw.date));
  const distanceMeters = positive(raw.distanceMeters);
  const timeSeconds = positive(raw.timeSeconds);
  if (!date || !distanceMeters || !timeSeconds) return null;

  return {
    date,
    distanceMeters,
    timeSeconds,
    type: String(raw.type ?? 'Running').trim(),
    title: String(raw.title ?? '').trim(),
  };
}

/* ---- picking the benchmarks out ----------------------------------------- */

/** The standard distance an effort was run at, or null. */
function standardFor(meters) {
  for (const d of STANDARD_DISTANCES) {
    if (Math.abs(meters - d.meters) / d.meters <= DISTANCE_TOLERANCE) return d;
  }
  return null;
}

/**
 * The efforts worth offering as a benchmark: the best one at each standard
 * distance inside the recency window, best first.
 *
 * The athlete picks. Nothing here adopts a benchmark on its own, which is both
 * simpler than guessing and the reason the paces stay something they entered.
 *
 * Deliberately *not* done: weighting recent efforts above older ones. Every
 * candidate carries the date it was run, the list is short enough to read at a
 * glance, and an athlete looking at "10 km, 42:00, June" against "5 km, 19:40,
 * March" is better placed to say which is them now than any decay curve.
 *
 * @param {object[]} activities
 * @param {object} [opts]
 * @param {string} [opts.today] ISO day to measure the window back from
 * @param {number} [opts.days]  how far back to look
 */
export function benchmarkCandidates(activities, { today, days = DEFAULT_WINDOW_DAYS } = {}) {
  const to = parseISO(today) ?? new Date();
  const from = toISO(addDays(to, -Math.abs(Number(days) || DEFAULT_WINDOW_DAYS)));

  const best = new Map();

  for (const raw of Array.isArray(activities) ? activities : []) {
    const a = normalizeActivity(raw);
    if (!a || !isRun(a.type) || a.date < from) continue;

    const standard = standardFor(a.distanceMeters);
    if (!standard) continue;

    // A pace no human has run is a broken trace, and `vdotFrom` is where that
    // ceiling lives — one definition, rather than a second one here that could
    // disagree with the one guarding what gets stored.
    const vdot = vdotFrom(a);
    if (vdot === null) continue;

    const held = best.get(standard.key);
    if (!held || vdot > held.vdot) {
      best.set(standard.key, {
        date: a.date,
        distanceMeters: a.distanceMeters,
        timeSeconds: a.timeSeconds,
        label: a.title || standard.label,
        standard: standard.key,
        source: 'file',
        vdot,
      });
    }
  }

  return [...best.values()].sort((x, y) => y.vdot - x.vdot);
}

/* ---- what the XML paths need measured ------------------------------------

   A TCX states its distance and its time; a GPX states neither, only where the
   athlete was. The page walks both — `DOMParser` is a browser thing an engine
   module may not touch — but the arithmetic lives here, where `npm test` can
   reach it. */

const EARTH_RADIUS_M = 6371000;
const rad = (deg) => (Number(deg) * Math.PI) / 180;

/**
 * The length of a track, in metres, from its points in order.
 *
 * Haversine on a sphere rather than an ellipsoidal formula: the difference over
 * a running route is a few metres in ten thousand, comfortably inside the GPS
 * noise already in the trace, and well inside the 3% a distance has to be
 * within to count as a standard one.
 *
 * A point that arrived without a fix is skipped rather than propagated: a
 * slightly short track is a better answer than a NaN that makes the whole
 * activity disappear with no reason given.
 */
export function trackDistanceMeters(points) {
  const pts = Array.isArray(points) ? points : [];
  let meters = 0;

  for (let i = 1; i < pts.length; i++) {
    const lat1 = rad(pts[i - 1]?.lat);
    const lat2 = rad(pts[i]?.lat);
    const dLat = lat2 - lat1;
    const dLon = rad(pts[i]?.lon) - rad(pts[i - 1]?.lon);

    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    if (!Number.isFinite(h)) continue;

    meters += 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  return meters;
}

/** A TCX activity is its laps added up. A lap missing a number contributes none. */
export function lapTotals(laps) {
  return (Array.isArray(laps) ? laps : []).reduce((acc, lap) => ({
    distanceMeters: acc.distanceMeters + (positive(lap?.distanceMeters) ?? 0),
    timeSeconds: acc.timeSeconds + (positive(lap?.timeSeconds) ?? 0),
  }), { distanceMeters: 0, timeSeconds: 0 });
}
