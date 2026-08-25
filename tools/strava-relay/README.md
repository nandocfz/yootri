# Strava relay

An optional, **personal-scale** way to get a benchmark result into yootri
without downloading a file first. It is off in the published app and cannot be
switched on by visiting it.

If you just want your training paces, you do not need any of this. Type a race
result into **Training paces**, or drop in the CSV that Garmin Connect's
activity list exports. Both work in every browser with no setup at all.

## Why this is personal-scale and not a feature

Strava restructured developer access on 1 June 2026. The tier that needs no
review is capped at **10 athletes** and requires the developer to hold an active
Strava subscription. That is enough for you and is not enough to ship, so this
is built as a convenience for one person rather than as something the app
offers everybody.

The Garmin route was considered and is closed: the Garmin Connect Developer
Program is [business-only](https://developer.garmin.com/gc-developer-program/program-faq/)
("available for enterprise use… only for business use"), and its Activity API
delivers by push to a registered webhook — a server holding other people's
training data, which is the thing yootri is built not to have.

## What the Worker does, and what it refuses to do

**It holds one secret and stores nothing.**

Measured from a page served at `http://localhost:8000`, both of these came back
with a body readable from script rather than being blocked before a response
existed:

| Request | Result |
| --- | --- |
| `GET https://www.strava.com/api/v3/athlete` | 401, body readable |
| `POST https://www.strava.com/oauth/token` | 400, body readable |

So Strava sends permissive CORS on both, and nothing needs proxying to be
*reached*. The browser fetches your activities itself.

What a browser cannot do is hold `client_secret`, which Strava's token exchange
requires and for which it offers no PKCE alternative. Publishing that secret in
a page served from a public repository would let anyone put an OAuth consent
screen in front of a stranger wearing this application's name.

So the Worker exchanges an authorization code for a token, refreshes a token,
and does nothing else. No KV, no D1, no cache, no logs of what passed through.
A token exists in it for the milliseconds of one request. There is no store to
be breached and no record of anybody's training on any server — which is what
keeps yootri's local-first position intact with this deployed.

It also hands back only `access_token`, `refresh_token` and `expires_at`.
Strava's reply carries the athlete's name, city and photo as well; none of it
has any reason to be here.

## Deploying it

You need a Cloudflare account and `wrangler`.

1. **Create the Strava API application** at
   <https://www.strava.com/settings/api>. Set the *Authorization Callback
   Domain* to the domain you serve yootri from — `localhost` for local use.
   Note the **Client ID** and **Client Secret**.

2. **Set the allowed origins.** Edit `ALLOWED_ORIGINS` in `wrangler.toml` to
   the origins you will call from, comma-separated, including the scheme and
   port: `http://localhost:8000,https://yootri.example.com`.

3. **Put the credentials in, as secrets:**

   ```bash
   cd tools/strava-relay
   wrangler secret put STRAVA_CLIENT_ID
   wrangler secret put STRAVA_CLIENT_SECRET
   ```

   Never put either in a file here. Everything in this repository is served
   publicly by GitHub Pages, `wrangler.toml` included.

4. **Deploy:**

   ```bash
   wrangler deploy
   ```

   Wrangler prints the Worker's URL. That is the `relayUrl` below.

## Turning it on in the browser

There is no button for this in the app, and that is deliberate: with no way for
a visitor to start the flow, no third party's data can reach the relay, so
yootri's record of processing does not change and the app stays a thing that
holds nobody's data but your own.

You switch it on for **one browser** by writing the configuration into that
browser's own storage, the same place your model API key already lives. Open
yootri, open the developer console, and paste:

```js
localStorage.setItem('yootri_strava', JSON.stringify({
  clientId: 'YOUR_CLIENT_ID',
  relayUrl: 'https://yootri-strava-relay.YOUR-SUBDOMAIN.workers.dev',
}));
```

Reload. **Training paces** now offers *Connect Strava*. To switch it off again:

```js
localStorage.removeItem('yootri_strava');
localStorage.removeItem('yootri_strava_token');
```

Revoking yootri's access from Strava's side is under
**Settings → My Apps** at <https://www.strava.com/settings/apps>.

## What crosses the wire

Only `activity:read` is requested — the least Strava offers that returns
activities.

Of what comes back, the app keeps a date, a distance, an elapsed time, a sport
and a title, and only for the single result you pick. Strava also sends heart
rate on every activity; yootri reads past it and never stores it, the same way
it reads past the heart-rate columns in a Garmin CSV. That is not tidiness —
the whole plan except the conversation syncs to Firestore when you are signed
in, so a heart-rate field that got as far as the plan would be one sync from
being stored.

## If you ever open this to other people

Do not, without doing this first. Running the relay for anybody but yourself
makes you a processor of their data, and:

- `yootri-notes/gdpr-records.md` needs its Art. 30 record updated — new
  recipient, new categories, new transfer question;
- the in-app privacy notice needs to say the relay exists and what it touches;
- the 10-athlete cap means you would need Strava's Extended Access review
  anyway.

Nothing in the Worker prevents it. The reason it is safe today is that nobody
else can start the flow.
