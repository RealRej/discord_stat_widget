# Rank Widget Site

A small hosted web app so friends can look up League of Legends stats and
push them to their own Discord profile, without you running anything on your
own computer.

## What each person needs

- **You (site owner):** one Riot Games API key. It works for looking up
  *anyone*, so you don't need one key per friend.
- **Each friend who wants the Discord push:** their own Discord bot
  application (Application ID + Bot Token) and their own Discord User ID.
  The dashboard walks them through getting these. This part can't be shared
  — Discord's profile-push feature is tied to one specific app + user pair.

Everyone can use the *lookup* part (no Discord setup needed) — only the
"push to my Discord profile" button requires the per-person Discord setup.

## Running it locally first (no setup required)

```bash
npm install
npm start
```

Then open http://localhost:3000. That's it — if you don't set `DATABASE_URL`,
the app automatically uses a local SQLite file at `data/local.db` instead of
Postgres, and generates a temporary encryption key for the session. Accounts,
credentials, and login all work immediately. This is genuinely fine for
testing on your own machine, or even for just you and friends *on the same
network* (see "Sharing over your local network" below).

The only thing that still needs a real value even locally is `RIOT_API_KEY`
— get one free from https://developer.riotgames.com, then either put it in
a `.env` file (copy `.env.example` to `.env` first) or set it as an
environment variable before running `npm start`.

The two things you *don't* get locally: your friends outside your house
can't reach `localhost`, and the temporary encryption key means saved
Discord tokens are forgotten on restart. Both are solved by deploying (below).

### Sharing over your local network

If your friends are on the same Wi-Fi, they can reach your machine directly
— find your local IP (`ipconfig` on Windows, `ifconfig` or `ip addr` on
Mac/Linux, usually something like `192.168.1.x`) and share
`http://YOUR_LOCAL_IP:3000`. No deployment needed, but your computer has to
stay on and running for it to work.

## Deploying so it's reachable from anywhere (optional)

## 1. Create the database (Supabase, free)

1. Go to https://supabase.com, sign up, and create a new project (no credit
   card required).
2. In the project, go to **Project Settings → Database → Connection string**
   and copy the URI (starts with `postgresql://...`).
3. Keep this for step 3 below — it's your `DATABASE_URL`.

## 2. Push this project to GitHub

Create a new GitHub repo and push this folder to it (Render deploys from
GitHub). If you're not already using git:

```bash
cd widget-site
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

## 3. Deploy on Render (free)

1. Go to https://render.com and sign up (no credit card required for the
   free tier).
2. **New +** → **Web Service** → connect the GitHub repo you just pushed.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Under **Environment**, add these variables:
   - `RIOT_API_KEY` — your key from https://developer.riotgames.com
   - `DATABASE_URL` — the Supabase connection string from step 1
   - `MASTER_KEY` — a random 64-character string (generate with the command
     in `.env.example`)
   - `SESSION_SECRET` — another random string, different from `MASTER_KEY`
   - `ADMIN_USERNAME` *(optional)* — a username that should automatically get
     an admin account the first time the server starts (e.g. `rej`)
   - `ADMIN_PASSWORD` *(optional)* — the password for that account. Set both
     of these only in Render's Environment tab, never in a file you commit
     to GitHub — anyone who can see your repo could otherwise read it.
     The admin account gets a small panel on the dashboard listing everyone
     who's registered and whether they've finished their Discord setup.
5. Click **Create Web Service**. After the first deploy finishes, Render
   gives you a URL like `https://your-app.onrender.com` — that's what you
   send to your friends.

### Two things to know about the free tier

- **Render's free web service sleeps after 15 minutes of no traffic.** The
  first visit after that takes ~30-50 seconds to wake back up. Fine for a
  friend group, just don't expect instant loads if nobody's used it in a
  while.
- **Your Riot personal API key expires every 24 hours.** Regenerate it at
  https://developer.riotgames.com and paste the new value into Render's
  Environment tab whenever lookups start failing. There's no way around this
  short of applying to Riot for a Production key, which requires an approved
  use case.

- **Each friend also has to link their Discord account** on the dashboard's
  Settings panel, via a manually-obtained OAuth2 access token (steps are
  spelled out right there in the UI). This token expires after about 7 days
  — Discord's implicit-grant flow doesn't issue a renewable one — so this
  isn't a one-time-forever step; expect to redo it roughly weekly. This is
  in addition to a one-time manual "enable Social SDK for your application"
  step in the Discord Developer Portal that isn't automatable from this site
  at all (it requires your own logged-in browser session there).

## Using it

- Send friends the Render URL. They create an account (this is just a
  username/password for *this site* — unrelated to Discord or Riot
  passwords).
- Anyone can type a Riot ID + tag and see the stat card immediately.
- To push to their own Discord profile, each friend follows the steps shown
  in the "Your Discord connection" panel on the dashboard once, then the
  push button works from then on.
- **Only one non-admin person can run a lookup or push at a time.** Riot's
  API rate limit is per key, not per person, so two people hitting it
  simultaneously would fight over the same limit. If someone else is
  currently using it, you'll get a clear notification telling you to try
  again shortly — there's no queue, just a short wait. The admin account is
  exempt from this and can always use the site, even while someone else is
  active.
- **The admin account can edit or delete anyone's account** from the panel
  at the bottom of the dashboard — useful for fixing a typo in a friend's
  Discord setup without needing their password, or removing an account
  that's no longer needed. Editing never shows you someone's existing bot
  token, only lets you overwrite it.

## Security notes

- Bot tokens are encrypted (AES-256-GCM) before being stored in the
  database, using `MASTER_KEY`, which lives only in Render's environment —
  never in the database itself. If you ever lose `MASTER_KEY`, stored tokens
  become unreadable and everyone needs to re-enter them.
- Passwords are hashed with bcrypt, never stored in plain text.
- The Riot API key is shared server-side and never exposed to the browser.
- Treat `MASTER_KEY` and `SESSION_SECRET` like passwords — don't commit them
  to the GitHub repo (they're read from Render's environment, not from a
  file in this project).
