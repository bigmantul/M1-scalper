# Deploying on Render, and running the bot

## 1. Put the code on GitHub
```bash
unzip m1-scalper.zip && cd m1-scalper
git init && git add . && git commit -m "M1 scalper"
# create an EMPTY PRIVATE repo on github.com first, then:
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```
`.env` and `data/` are git-ignored, so no secrets or trade history are uploaded. Keep the repo private.

## 2. Pick the right Render instance (important)
| | Free | Starter ($7/mo) or higher |
|---|---|---|
| Stays running | **No** — sleeps after ~15 min without web traffic, so the bot stops watching your trade | Yes, always on |
| Persistent disk | **No** — settings, bot state and trade history are wiped on every restart/deploy | Yes |

Use **Starter or higher for anything that trades**, even on demo. Check Render's pricing page for current terms.
The free tier is only good for poking at the dashboard; if you try it, set `KEEP_ALIVE=true` (the app pings
itself every 10 min) — but you will still lose data on restart and it is not safe with a real open trade.

## 3. Create the service
Option A — Blueprint (fastest): Render dashboard → **New → Blueprint** → pick the repo. It reads `render.yaml`,
creates the service with a 1 GB disk and asks you for the three secrets.

Option B — by hand: **New → Web Service** → connect the repo, then:
- Runtime **Node**, Branch `main`
- Build command `npm ci` · Start command `npm start`
- Instance type **Starter**
- **Disks → Add disk**: name `scalper-data`, mount path `/var/data`, 1 GB
- **Settings → Health Check Path**: `/health`
- **Auto-Deploy**: set to *Off* (so a push never restarts the bot while a trade is open)

## 4. Environment variables
| Key | Value |
|---|---|
| `DERIV_PAT_TOKEN` | your Deriv personal access token (needs read + trade scopes) |
| `DERIV_APP_ID` | your Deriv app id |
| `DASHBOARD_PASSWORD` | a long unique password (8+ chars; the server refuses to start without it) |
| `HOST` | `0.0.0.0` |
| `DATA_DIR` | `/var/data` (must match the disk mount path) |
| `NODE_VERSION` | `20` |
| `ALLOW_REAL` | leave unset until you deliberately go live |

Render supplies `PORT` itself — don't set it.

## 5. First launch checklist
1. Wait for the deploy to show **Live**. Open `https://<your-service>.onrender.com/health` → `{"ok":true,...}`.
2. Open the main URL, sign in with `DASHBOARD_PASSWORD`.
3. Header should say **DEMO**. Choose a symbol, check the **risk preview** under Stops, adjust pips, **Save settings**.
4. Click **Start**. In the Render **Logs** tab you should see `Connected (account …)`, `Scanning <symbol> only`, `Reconciled with broker: ok`.
5. The dashboard connection pill turns green. The first trade comes after the next full M1 candle completes.

## 6. Operating it
**Controls**
- **Start** – enables entries and connects. **Stop (keep trade)** – no new entries; an open trade keeps its stops and is still managed. **Stop + close trade** – stop and close now. **Emergency** – stop and close immediately, entries stay blocked until you press Start again.
- **Clear halt** appears when the bot has blocked itself (daily-loss limit, loss streak, repeated order failures). It resets the loss streak and failure flags, never the daily loss.

**Changing settings** – edit, check the preview, **Save**. Stop/trail/pip/stake changes apply to the *next* trade. Symbol and account can only change while no trade is open.

**Reading the dashboard** – status pill: *waiting for candle close* (flat, watching), *opening position*, *position active / trailing stop monitoring*, *position closing*, *waiting for next candle* (just closed; waits for the candle to finish), *error or recovery* (reconnecting/reconciling; no new orders). Position card shows entry, current stop, whether trailing is active, floating P/L.

**Daily routine** – glance at the connection pill, today's P/L, consecutive losses and the activity log. Download the trade CSV regularly (Render's disk is not a backup).

**Updating the code** – push to GitHub, then in Render press **Manual Deploy** only when the position card says *Flat*. A restart is safe (state is saved and reconciled with Deriv on boot), but the trailing stop is not watched during the ~1 min restart.

**If something looks wrong** – press **Emergency**, then check Render **Logs**. Common messages: `No server-side stop placed…` (your pip stop is below Deriv's minimum or larger than the stake — widen/narrow the pips), `Order rejected…` (stake/multiplier limits), `Reconnecting…` (Deriv dropped; it retries and reconciles by itself).

## 7. Going from demo to real money
Do this only after at least a couple of weeks of demo results you trust.
1. Render → Environment → add `ALLOW_REAL=true` → save (the service restarts).
2. Make sure the bot is flat, set **Account → Real money** in the dashboard, Save, then Start (it asks you to confirm).
3. Start with the smallest stake and the daily-loss limit set to an amount you can afford to lose.
To go back: set Account to Demo (while flat) and remove `ALLOW_REAL`.

## 8. Security
Use a long unique `DASHBOARD_PASSWORD`; anyone with it can trade your account. Use a Deriv token with only the scopes you need, and rotate it if it ever leaks. Keep the GitHub repo private.
