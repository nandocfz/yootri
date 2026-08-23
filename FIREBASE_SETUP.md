# Cloud sync setup

Cloud sync is **optional**. yootri stores everything in the browser and works
fully without it. Set this up only if you want plans to follow you between
devices, or you are hosting your own copy and want sync to work on your domain.

If you skip this, the app runs local-only and says so. Nothing is broken.

## What sync does and does not do

- Plans sync per signed-in Google account, at `users/{uid}/plans/{planId}`.
- Conflicts resolve last-write-wins by the plan's `updatedAt`.
- **Your API key is never synced.** It stays in this browser.
- **Coach conversations are never synced.** They stay in this browser too, and
  are stripped from the payload before it is written.

## 1. Create a Firebase project

1. Go to the [Firebase console](https://console.firebase.google.com/) and create
   a project. Google Analytics is not needed.
2. Add a **Web app** to it. Firebase hands you a config object.

## 2. Enable Google sign-in

**Build → Authentication → Sign-in method → Google → Enable.** Set a support
email and save.

## 3. Authorize your domain

**Authentication → Settings → Authorized domains → Add domain.**

Add every origin you serve from. `localhost` is there by default — which is why
`make dev` serves on `http://localhost:8000/` and sign-in just works locally,
and why the same app at `http://127.0.0.1:8000/` cannot sign in. The bare IP is
not on that list, and the port is not part of it either way. Add your production
domain (for example `yootri.example.com`).

This is the step that catches forks. Until your domain is on this list, sign-in
fails and the app falls back to local-only.

## 4. Create the Firestore database

**Build → Firestore Database → Create database.** Pick a region near you.

Start in production mode — the rules in the next step replace whatever you pick.

## 5. Deploy the security rules

The rules in [`firestore.rules`](firestore.rules) restrict every path to the
account that owns it and deny everything else by default. Deploy them **before**
you rely on sync.

From the console: **Firestore Database → Rules**, paste the contents of
`firestore.rules`, and publish.

Or with the Firebase CLI:

```bash
firebase deploy --only firestore:rules
```

## 6. Point the app at your project

In `index.html`, near the bottom, replace the `firebaseConfig` object with the
one from your own web app:

```js
const firebaseConfig = {
  apiKey: '…',
  authDomain: '<project>.firebaseapp.com',
  projectId: '<project>',
  storageBucket: '<project>.firebasestorage.app',
  messagingSenderId: '…',
  appId: '…',
};
```

A Firebase web `apiKey` is a public client identifier, not a secret. It is meant
to ship in client code, and it is safe to commit. What actually protects the data
is the security rules from step 5 — which is why deploying them is not optional.

You can additionally restrict the key in the Google Cloud console under
**APIs & Services → Credentials**, by setting HTTP referrer restrictions to your
own domains.

## Checking it worked

Serve the app (`make dev`), open it, and sign in. The header chip should change
from **Local only** to your email address. Make a change, open the same account
in another browser, and the plan should arrive.

If the chip still says **Local only**, click it — the panel reports what Firebase
said. An authorized-domain problem is by far the most common cause.
