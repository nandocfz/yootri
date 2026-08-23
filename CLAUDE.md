# yootri

Vanilla-JS triathlon training planner. No build step, no dependencies. Served at
the repo root by GitHub Pages — **anything committed here is public**.

## Layout

- `index.html` — the app: markup, styles, DOM, rendering, storage, cloud sync.
  Its main script is a `<script type="module">` that imports the engine below.
- `assets/coach/*.js` — the engine: pure ES modules, no DOM, no I/O. This is
  where the training model, session generation, validation and plan operations
  live, so they can be tested without a browser.
- `assets/nocturne.css` — the "Nocturne" design-system base.
- `tests/` — `npm test` (plain `node --test`, no test framework).

Because assets use relative paths and ES modules need a real origin, serve the
folder rather than opening the file: `python3 -m http.server 8000`.

## The engine

| Module | Responsibility |
| --- | --- |
| `season.js` | Annual hours → weekly hours. Port of `../yootri-rnd/plan_model.py`; `fitToRace` lands the block model on a runway of N weeks. |
| `generate.js` | One week's hour budget → actual sessions. Deterministic. |
| `profile.js` | Athlete profile: availability, constraints, per-block discipline splits. |
| `validate.js` | Deterministic rules. `error` = physically impossible (blocks an apply); `warn` = coaching judgement (the athlete's call). |
| `plan.js` | Plan-level operations and the draft → diff → apply flow. |
| `migrate.js` | Schema v2 → v3. `legacy-plan.js` is the frozen old template it needs. |
| `portable.js` | The plan-file envelope: what `exportPlan` writes and what `Import plan…` will accept. Import is total — every bad file comes back as a reason, never a throw. |
| `duration.js` | `"H:MM"` ↔ minutes, the format the app already stores. |
| `calendar.js` | Week-and-weekday ↔ real date, and the Monday-start month grid the calendar view draws. |
| `events.js` | The athlete's events. One is the *goal event*, and it is the only source of the plan's race date and distance. |

**Nothing edits a stored plan in place.** A change builds a *draft* (a detached
copy), which is diffed, validated, shown, and only written by `applyDraft`. That
is what makes it safe to point an agent at a training plan, and it is why the
Plan setup form goes through the same ceremony a model would.

Events live on the plan as `events`, alongside `weekBudgets` — both are fields
added without a schema bump, because `migratePlan` passes a v3 record through
untouched and export/import/sync all carry unknown top-level fields. The one
event flagged `goal` owns `profile.raceDate` and `profile.raceType`; moving it
re-fits the season through the same draft → diff → apply flow the setup form
uses, which is why Plan setup only *shows* the race date.

Plans are schema v3: absolute week keys (`w0`…`w15`), materialized sessions, and
a stored `season`. A plan is self-contained, so changing the engine never
reshapes a season somebody is midway through. `adoptPlan` migrates older records
on the way in and writes the upgrade back immediately.

## R&D notebooks

Exploratory work on **training-load / physiology models** and **chart
prototyping** lives outside this repo, in `../yootri-rnd/` (Python notebooks,
deliberately not version controlled).

**Before changing training-load computation, session generation, validation
thresholds or the SVG season chart, read `../yootri-rnd/FINDINGS.md`.** It
records what was tried, what the numbers said, and what was ruled out — the
notebooks themselves are noisy and are only worth opening when a finding points
at one. It also records which constants are unfitted guesses, which matters
before tuning any of them.

If a session concludes something worth keeping, write it back to that
`FINDINGS.md`. It is the only durable record; there is no git history behind it.

## Working here

- Engine changes are test-first; `npm test` must stay green — CI runs it on
  Node 20, 22 and 24 for every pull request, alongside a repo-hygiene check
  (`.github/scripts/check-repo-hygiene.mjs`) that guards what gets published.
- `index.html` is not importable, so `tests/index-html.test.js` checks it as
  text: its module scripts parse, and every module, named export and asset it
  references exists. Rename an engine export and that is what catches it.
- The coaching constants (discipline splits, session lengths, ramp ceilings) are
  deliberately *not* universal truths. Prefer making something profile-driven
  over tuning a default toward one athlete.
