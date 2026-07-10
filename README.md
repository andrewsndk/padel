# Padel Saturday Sniper 🎾

Auto-joins the Saturday game in the **Padel PORTAL** group on
[racket.id](https://racket.id/groups/4Y4qCwClTWQPAM) the moment a slot opens.

## How it works

racket.id is a Firebase/Expo app that serves data over a realtime WebChannel, and
direct API writes are blocked by security rules. So instead of hitting an API, this
bot drives a **real logged-in browser** (Playwright): it polls the group page and,
the instant a Saturday game shows a free slot, opens it and clicks *join* — exactly
like you would, just faster and unattended. It pings you on Telegram when it acts.

## The GitHub Actions caveat (read this)

GitHub cron can't fire more than every 5 minutes and is often delayed further. Games
here fill in ~3 minutes, so cron frequency alone is useless. This repo works around
that: cron just **starts** the job a little before the expected open time, then
`snipe.mjs` polls every ~6 seconds from inside that single run for ~45 minutes. If
you want tighter-than-cron reliability, run the same script on an always-on box (a
cheap VPS or a Raspberry Pi) via a normal cron/`pm2` instead — the script is identical.

---

## Setup

### 1. Capture your login (local, one time)

```bash
npm install
npm run capture        # opens a browser — log into racket.id, then press Enter
```

This creates `storageState.json`. **That file is your login — never commit it.**

### 2. Test locally

```bash
HEADLESS=false MAX_RUNTIME_MS=120000 npm run snipe
```

Watch it poll. If a Saturday slot happens to be open, confirm it clicks join correctly.
Because the game was full when this was built, the join-button selectors in `snipe.mjs`
(`JOIN_RE`) are best-guesses — verify them on your first live open and tweak if needed.
A screenshot (`joined.png` / `no-join-button.png`) is saved to help.

### 3. Put it on GitHub Actions

1. Push this folder to a **private** GitHub repo.
2. Turn your session into a secret:
   ```bash
   base64 -w0 storageState.json      # Linux
   base64 storageState.json          # macOS
   ```
3. In the repo: **Settings → Secrets and variables → Actions → New repository secret**, add:
   - `STORAGE_STATE_B64` — the base64 blob from step 2 (required)
   - `TELEGRAM_BOT_TOKEN` — optional, for notifications (see below)
   - `TELEGRAM_CHAT_ID` — optional
4. The workflow runs Sundays around the expected open time. Trigger a manual test run
   from the **Actions** tab → *Padel Saturday Sniper* → **Run workflow**.

### 4. Telegram notifications (optional)

1. Message **@BotFather**, `/newbot`, copy the token → `TELEGRAM_BOT_TOKEN`.
2. Message your new bot once, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the `chat.id` → `TELEGRAM_CHAT_ID`.

---

## Tuning

- **Open time wrong?** Edit the two `cron:` lines in `.github/workflows/snipe.yml`.
  They're in **UTC**; Lisbon is UTC+1 in summer, UTC+0 in winter.
- **Different day** (e.g. Sunday too): change `TARGET_DAY_RE` env / regex in `snipe.mjs`.
- **Join button not detected:** adjust `JOIN_RE` / `LEAVE_RE` in `snipe.mjs` using the
  actual button label you see when a slot is open (check the debug screenshot artifact).

## When it stops working

If runs suddenly fail to log in, your session expired (you logged out, changed password,
or the token was revoked). Just re-run `npm run capture` and update `STORAGE_STATE_B64`.

## A note on etiquette

This is a 284-person community group where everyone else signs up by hand. A bot that
grabs a slot in the first second is your call to make, but the organizer may notice.
