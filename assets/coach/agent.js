/* Talking to a language model directly from the browser, with the athlete's own
   API key.

   This repo is public and served statically, so no key can ever be committed.
   The athlete pastes their own; it lives in localStorage and goes straight to
   whichever provider they picked. The trade is a fair one for a bring-your-own-
   key tool, but it is worth naming: anything that can run script on this page
   can read the key. It is why the key is never written into a plan and never
   synced.

   Which provider is which lives in providers.js. This file knows only the
   normalised shape that module returns, so the tool loop below has no
   provider-specific branching in it.

   The division of labour is deliberate and enforced by construction: the model
   chooses *what* to change by calling tools; the engine decides *what that
   means* in minutes. Nothing here lets a model emit a duration. */

import { TOOL_DEFS, callTool } from './tools.js';
import { getProvider, resolveModel, describeTransportError, DEFAULT_PROVIDER_ID } from './providers.js';

export { PROVIDERS, DEFAULT_PROVIDER_ID, getProvider, resolveModel } from './providers.js';

/* Kept as named exports because index.html imports them; the storage key for a
   given provider is providers.js's business now. */
export const KEY_STORAGE = 'yootri_anthropic_key';

const MAX_TOOL_STEPS = 12;

export const SYSTEM_PROMPT = `You are a triathlon coach embedded in the athlete's own training planner.

You do not write training sessions yourself. A deterministic engine owns every number — hours, session lengths, ramp rates, discipline splits. You decide *what should change* and call the tools; the engine works out what that means in minutes and days.

How to work:
- Read before you write. get_plan_summary orients you; get_week and get_profile answer specifics; get_compliance tells you how training has actually been going. Do not guess at numbers you can look up.
- Make the smallest change that addresses what was asked. A bad week is set_week_budget, not a whole-season refit. Changing the season is for a change in circumstances, not a change in mood.
- Watch the scope of what you are asked. "This week" and "from now on" are different requests. Constraints and availability are standing rules that reshape every week in the season; week budgets affect one week. If someone describes a one-off ("no pool this week", "away next weekend") and the only tool that fits is a standing rule, do not silently make it permanent — adjust what you can and tell them plainly what you could not do.
- How a week falls across its days comes from a shape table indexed by the week's volume, clipped to the athlete's availability, with anything displaced spread over the days that have room. Do not try to hand-place a week day by day: set_week_shape steers it, and set_availability marks what is genuinely impossible.
- Your changes are staged as a draft. The athlete reviews a diff and decides whether to apply it. Say plainly what you changed and why; do not claim it is done.
- If a tool reports an error, read it and correct the call rather than repeating it.

The calendar:
- A season can hold more than one race. Exactly one is the *primary* race: the whole season is sized to it, it ends with a two-week peak block and a race week, and moving it changes how many weeks the plan has. Only a 70.3 or an IRONMAN can be the primary race, because the volume model is sized by race distance.
- Any other race can be *secondary* — a tune-up inside the build. The season is rebuilt with a one-week taper and a race week landing on it, taken out of whatever block it falls in. It does not make the season longer: the primary race's date is what decides the length. A marathon, a half marathon or a shorter triathlon can only ever be secondary.
- A race in the last three weeks gets no separate taper: those weeks are already the primary race's own peak and race week. get_events tells you which races the season built a taper for and which it did not. Say what it says rather than promising one.
- Nothing is scheduled on a race day or on the days after it in that week. So a race early in the week leaves the rest of that week clear, and that is the plan being correct rather than a gap to fill.

Scope:
- You plan training and nothing else. You are not a clinician, and this is not a medical service. If you are asked a health question — whether something is serious, what is wrong, or what to do about it — say plainly that it is outside what you can help with and is a question for a doctor or physiotherapist. Then help with the training side if there is one, usually by adjusting the schedule around the time they expect to be away.

Coaching judgement:
- When the numbers disagree with the athlete's plan, say so once, plainly, and then do what they asked. It is their training.
- Distinguish a missed session from illness. Missing sessions is a scheduling problem; being ill is not, and they do not call for the same change.
- Be concise. This is a side panel, not an essay. Lead with what you did or found.`;

/**
 * Build the HTTP request. Pure, so the shape can be tested without a network.
 * Delegates to the provider; kept here because callers already import it.
 */
export function buildRequest({
  provider = getProvider(DEFAULT_PROVIDER_ID), model, apiKey, baseUrl,
  messages, tools, system, effort = 'medium', maxTokens = 4000,
}) {
  return provider.buildRequest({
    apiKey,
    baseUrl,
    model: resolveModel(provider, model),
    messages,
    tools,
    system: system ?? SYSTEM_PROMPT,
    maxTokens,
    effort,
  });
}

export function describeHttpError(status, body, provider = getProvider(DEFAULT_PROVIDER_ID)) {
  return provider.describeHttpError(status, body);
}

async function post({ provider, model, apiKey, baseUrl, messages, tools, system, effort, maxTokens, fetchImpl }) {
  const { url, headers, body } = buildRequest({
    provider, model, apiKey, baseUrl, messages, tools, system, effort, maxTokens,
  });

  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    // The request never reached the provider. On a static page the most common
    // cause is an origin the provider will not serve, so say so specifically.
    throw new Error(describeTransportError(provider, e));
  }

  let parsed;
  try {
    parsed = await res.json();
  } catch {
    parsed = null; // not JSON at all — a proxy page, or an empty body
  }

  if (!res.ok) {
    // The API explains itself far better than a status code does; the provider
    // leads with its words and keeps the generic advice as context.
    const err = new Error(provider.describeHttpError(res.status, parsed));
    err.status = res.status;
    throw err;
  }

  // A 200 is not a promise that the body is the shape we expect. Version skew,
  // a captive portal, or a proxy can all return something else, and reading a
  // field off it produced a bare "Cannot read properties of undefined" with
  // nothing to act on. Fail here instead, saying what actually came back.
  const detail = provider.apiErrorMessage(parsed);
  if (detail) throw new Error(`The API returned an error: ${detail}`);

  const result = provider.parseResponse(parsed);
  if (result.malformed) {
    throw new Error(
      `Unexpected reply from the API (HTTP ${res.status}): ${result.snippet}. ` +
      'If this persists, hard-reload the page — a stale cached script can cause it.',
    );
  }
  return result;
}

/**
 * Run one conversational turn to completion, executing any tools the model
 * calls. Mutating tools write into `session.draft`; the stored plan is never
 * touched here.
 *
 * Never throws — a failure comes back as `{ error: true, text }` so the panel
 * can show it like any other message.
 */
export async function runTurn({
  apiKey, session, messages, fetchImpl = fetch, onText, effort = 'medium',
  provider = getProvider(DEFAULT_PROVIDER_ID), model, baseUrl, maxTokens = 4000,
}) {
  const convo = messages.slice();
  const tools = provider.translateTools(TOOL_DEFS);

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    let res;
    try {
      res = await post({
        provider, model, apiKey, baseUrl, messages: convo, tools, effort, maxTokens, fetchImpl,
      });
    } catch (e) {
      return { error: true, text: e.message, messages: convo };
    }

    // Classifiers can decline with a normal 200 and an empty body; reading
    // content without checking would render that as a blank reply.
    if (res.stopReason === 'refusal') {
      return {
        refused: true,
        text: res.text || 'The model declined to answer that one. Try rephrasing it.',
        messages: convo,
      };
    }

    convo.push(...provider.formatAssistant(res));

    if (res.stopReason !== 'tool_use' || !res.toolCalls.length) {
      if (onText) onText(res.text);
      return { text: res.text, messages: convo };
    }

    const results = res.toolCalls.map((c) => {
      // A provider that could not parse the model's arguments reports it as a
      // tool error, so the model gets a chance to correct the call.
      if (c.argError) {
        return { id: c.id, content: `${c.name} failed: ${c.argError}.`, isError: true };
      }
      const r = callTool(session, c.name, c.input);
      return { id: c.id, content: r.content, isError: r.isError };
    });
    convo.push(...provider.formatToolResults(results));
  }

  return {
    text: 'I stopped after too many steps without reaching an answer. Try asking for something smaller.',
    messages: convo,
  };
}

/**
 * Rewrite only the human-readable wording of a generated week.
 *
 * The model is handed the sessions and asked for replacement `focus` text keyed
 * by id. Everything else — day, discipline, duration, zone — is copied from the
 * engine's output, so a hallucinated duration or an invented session simply has
 * nowhere to land.
 */
export async function polishWeek({
  apiKey, sessions, block, fetchImpl = fetch,
  provider = getProvider(DEFAULT_PROVIDER_ID), model, baseUrl,
}) {
  const brief = sessions
    .filter((s) => s.dur && s.dur !== '—')
    .map((s) => ({ id: s.id, day: s.day, disc: s.disc, dur: s.dur, zone: s.zone }));
  if (!brief.length) return sessions;

  const system =
    'You write the one-line title for each training session in a week. ' +
    'Reply with JSON only: an object mapping each session id to its new title. ' +
    'No prose, no code fence, no other keys. Titles are short, specific and ' +
    'coach-like — say what the session is for, not what it is called.';

  let res;
  try {
    res = await post({
      provider,
      model,
      apiKey,
      baseUrl,
      system,
      effort: 'low',
      maxTokens: 2000,
      messages: [{
        role: 'user',
        content: `Block: ${block}\nSessions:\n${JSON.stringify(brief, null, 1)}`,
      }],
      fetchImpl,
    });
  } catch {
    return sessions; // wording is a nicety; never fail a week over it
  }
  if (res.stopReason === 'refusal') return sessions;

  let map;
  try {
    map = JSON.parse(res.text);
  } catch {
    return sessions;
  }
  if (!map || typeof map !== 'object') return sessions;

  // Copy forward from the engine's sessions, taking only the wording. An id the
  // model invented has nothing to attach to and is dropped.
  return sessions.map((s) =>
    (typeof map[s.id] === 'string' && map[s.id].trim())
      ? { ...s, focus: map[s.id].trim().slice(0, 120) }
      : s);
}
