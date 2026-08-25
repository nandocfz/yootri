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
folder rather than opening the file: `make dev` (see `tools/dev-server.mjs`).
It serves on `http://localhost:8000/` — spelled `localhost`, because that is the
hostname Firebase authorizes by default and `127.0.0.1` is not, so Google
sign-in works on one and not the other. It also 404s a case-wrong path, which a
case-insensitive macOS filesystem otherwise hides until Pages serves it.

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
| `events.js` | The athlete's events. Races carry a *priority*: one is `primary` and is the only source of the plan's race date and distance, any number are `secondary` and get a taper landed on them. Also holds the lists of distances a race may be, and what each one is called on screen. |
| `paces.js` | Running paces. Daniels' VDOT model over one benchmark result, and the benchmark list that holds it — the one-is-flagged shape `events.js` used before races needed three states. |
| `activities.js` | Reading an activity export. Garmin's activity CSV, plus the arithmetic the page's TCX/GPX readers need. Total, like `portable.js`. |

**Nothing edits a stored plan in place.** A change builds a *draft* (a detached
copy), which is diffed, validated, shown, and only written by `applyDraft`. That
is what makes it safe to point an agent at a training plan, and it is why the
Plan setup form goes through the same ceremony a model would.

Events live on the plan as `events`, alongside `weekBudgets` — both are fields
added without a schema bump, because `migratePlan` passes a v3 record through
untouched and export/import/sync all carry unknown top-level fields. The one
race flagged `priority: 'primary'` owns `profile.raceDate` and `profile.raceType`;
moving it re-fits the season through the same draft → diff → apply flow the setup
form uses, which is why Plan setup only *shows* the race date. `normalizeEvent`
reads a legacy `goal: true` as `primary`, which is how that field changed with no
schema bump — do not reintroduce `goal` as a stored field.

**A season can hold more than one race.** A race marked `secondary` is a tune-up
inside the build: `planLandings` in `season.js` decides where it lands and
`fitToRace` splices in one **taper week** and one **race week**, taken out of
whatever block those weeks were in. The season never gets longer for it — the
primary's date is what decides the length. The secondary taper week is not a new
opinion about how hard a down week should be: it is `multiplier('Peak', 2)`
written out as its own block, so a secondary landing is the primary's landing with
the first peak week removed. `planLandings` is the only place the rule lives — the
page, the validator and the coach tools all ask it rather than re-deriving it, so
the refusal the athlete is shown is the same refusal the model honoured.

**Nothing is scheduled on a race day or on the days after it.** `generateWeek`
takes a `raceDay`, and `raceDayFor` in `plan.js` supplies it for any week a
prioritised race falls in — including one the model refused a taper for, because
the athlete is racing that day either way. A race early in the week therefore
leaves the rest of that week clear; `tests/plan.test.js` pins the Monday case so
it reads as a decision rather than a bug. See `../yootri-rnd/FINDINGS.md`
(25 Aug) for the latent bug this fixed in the *primary* race week.

**yootri plans long-course endurance racing only, and the distance list is three
lists because of it.** Each answers a different question:

- `RACE_TYPES` — what the race a season is *built for* may be: `70.3` and
  `ironman`. This is what a picker offers for a primary race.
- `KNOWN_RACE_TYPES` — what may reach `profile.raceType`, and so what a season may
  be *sized by*: the above plus the retired `sprint` and `olympic`. Every name
  here has a `RACE_DEMAND` row in `generate.js`. A plan is self-contained, so a
  season already built for a sprint has to go on being sized and validated as one
  rather than falling back to the default and quietly becoming a 70.3.
- `SECONDARY_RACE_TYPES` — what a *secondary* race may be: `10k`,
  `half-marathon`, `marathon`, `sprint`, `olympic`, and the long-course two. It
  can afford to be wider precisely because a secondary race never reaches
  `profile.raceType` — it is a label on a taper the model has already decided the
  shape of, so it needs no `RACE_DEMAND` row.

`normalizeEvent` enforces the boundary: a race marked `primary` whose distance is
not in `KNOWN_RACE_TYPES` is **demoted to secondary**, never dropped. Without that
a marathon would reach `profile.raceType`, `demandFor` would fall back to a 70.3,
and the season would be sized for a race nobody entered. `eventProblem` in
`tools.js` refuses the same thing with a sentence the coach can act on.

In the page, `raceTypeOptions()` builds every distance picker from one rule: a
record that already carries a retired distance is handed its own value back, so
opening a panel can never silently re-aim a season, while a race being chosen now
may only pick from the pool its priority allows. **Do not put a short distance
back in `RACE_TYPES` or `KNOWN_RACE_TYPES`, and do not delete the retired rows
from `RACE_DEMAND`.**

**What a distance is stored as and what it is called are two things.** The
stored name — `70.3`, `ironman` — is a key: it indexes `RACE_DEMAND`, it syncs
to Firestore, it is written into every exported plan file, and it is what a
season already under way is sized and validated by. `raceTypeLabel` in
`events.js` maps it to the name the athlete reads (`IM 70.3`, `IRONMAN`); a
distance with no entry is shown as it is stored, which is what a distance out of
a plan file this app did not write wants. Every place a distance is *shown* goes
through it — the pickers'
option text, the Plan setup fit hint, the import preview's Race row, and the
`volume-beyond-race` warning — while every place one is *stored* keeps the key,
including each `<option value>`. **Restyling a name must never change a stored
one**: renaming the key would re-aim every plan that already carries it, because
`demandFor` falls back to the default distance without saying so, and a season
built for an ironman would quietly be sized as a 70.3. Note the copy has no
article before the label — "a IRONMAN" is wrong and "an IM 70.3" only works for
one of the two, so both messages read "…of training for IRONMAN".

Running paces work the same way. `benchmarks` is a third such field: a list of
results the athlete entered or picked out of an export, exactly one flagged
`current`. Every pace on a Run card is derived from that one at *draw* time,
never stored on a session — so replacing a benchmark updates the whole season at
once rather than leaving past weeks asserting last spring's fitness. What
generation does write is `paceZone`, a band name, resolved from the session's
own zone label so a card can never show "Z3–Z4" beside a band saying "easy".

**Heart rate is not ingested, anywhere, and that is load-bearing rather than
incidental.** The whole plan except `chat` syncs to Firestore, so a heart-rate
field that reached a plan would be one sync from being stored. `activities.js`
reads past those columns at the parse boundary and has a test asserting the
value never survives; the Strava mapper in `index.html` does the same. Before
adding it, read `../yootri-rnd/FINDINGS.md` (25 Aug) and §9 item 4 of the
private legal note.

Plans are schema v3: absolute week keys (`w0`…`w15`), materialized sessions, and
a stored `season`. A plan is self-contained, so changing the engine never
reshapes a season somebody is midway through. `adoptPlan` migrates older records
on the way in and writes the upgrade back immediately.

## R&D notebooks

Exploratory work on **training-load / physiology models** and **chart
prototyping** lives outside this repo, in `../yootri-rnd/` (Python notebooks,
deliberately not version controlled).

**Before changing training-load computation, session generation, validation
thresholds, the pace model or the SVG season chart, read
`../yootri-rnd/FINDINGS.md`.** It
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
