/* A Cloudflare Worker whose entire job is to hold one secret.
 *
 * yootri is a static page. It can talk to Strava directly — measured from a
 * page served at http://localhost:8000, both of these answered with a body
 * readable from script rather than being blocked before a response existed:
 *
 *     GET  https://www.strava.com/api/v3/athlete   -> 401, body readable
 *     POST https://www.strava.com/oauth/token      -> 400, body readable
 *
 * So Strava sends permissive CORS on both, and no proxy is needed to *reach*
 * anything. What a browser cannot do is hold `client_secret`, which Strava's
 * token exchange requires and which has no PKCE alternative. Publishing it in
 * a page served from a public repo would let anyone run an OAuth consent
 * screen wearing this application's name — a harm to whoever they pointed it
 * at, not to us. Hence a Worker, and hence a Worker that does nothing else:
 * the browser fetches activities itself with the token this hands back.
 *
 * **It stores nothing.** No KV, no D1, no cache. A token exists here only for
 * the milliseconds of one request and is never written down. That is what keeps
 * yootri's local-first position intact with this deployed: there is no store to
 * be breached and no record of anybody's training on any server.
 *
 * Deploy:  see README.md in this directory.
 * Secrets: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET — `wrangler secret put`,
 *          never a file in this repo, which GitHub Pages publishes wholesale.
 */

const TOKEN_URL = 'https://www.strava.com/oauth/token';

/** Origins allowed to call this. Anything else gets no CORS headers and so
    cannot read the reply, whatever it managed to send. */
const allowedOrigins = (env) =>
  String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!allowedOrigins(env).includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
  });

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return cors ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 });
    }
    if (!cors) return json({ error: 'origin not allowed' }, 403);
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'body must be JSON' }, 400, cors);
    }

    /* Exactly two things may be asked for, and the shape of each is fixed here
       rather than forwarded. A pass-through proxy would let a caller put
       anything in the form body next to our secret. */
    const form = new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
    });

    if (body.code) {
      form.set('grant_type', 'authorization_code');
      form.set('code', String(body.code));
    } else if (body.refresh_token) {
      form.set('grant_type', 'refresh_token');
      form.set('refresh_token', String(body.refresh_token));
    } else {
      return json({ error: 'send either code or refresh_token' }, 400, cors);
    }

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });

    const text = await res.text();

    /* Hand back the token and nothing else. Strava's reply also carries the
       athlete's profile — name, city, photo — and there is no reason for any of
       it to travel through here or to be stored in a browser by this app. */
    let out;
    try {
      const parsed = JSON.parse(text);
      out = res.ok
        ? {
            access_token: parsed.access_token,
            refresh_token: parsed.refresh_token,
            expires_at: parsed.expires_at,
          }
        : { error: parsed.message || 'Strava refused the exchange' };
    } catch (e) {
      out = { error: 'Strava sent something that was not JSON' };
    }

    return json(out, res.ok ? 200 : res.status, cors);
  },
};
