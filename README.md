# M1 Scalper

Momentum stop-and-reverse scalper for Deriv synthetic indices, with a dashboard that controls everything.

**Strategy (exactly as specified):** after every *completed* M1 candle, enter at the start of the next candle in that
candle's direction (bullish → BUY, bearish → SELL, doji → stay flat). Fixed initial stop (default 20 pips), fixed
trailing stop (default 15 pips), **no take profit**. When a stop closes the trade, wait for the current candle to
finish, read its direction, then enter at the next candle's open. One symbol, one position at a time.

**Deploying on Render + operating the bot → see [DEPLOY.md](DEPLOY.md).** `/health` is the health-check endpoint.

## Run it

```bash
npm install
cp .env.example .env        # add DERIV_PAT_TOKEN, DERIV_APP_ID, DASHBOARD_PASSWORD
npm start                   # http://127.0.0.1:3000
npm test                    # run the full test suite
```

In the dashboard: pick a symbol (all 48 from the old bot are listed), set pip size / stop / trail / stake / limits,
read the **risk preview**, Save, then Start. Start on **Demo** first.

## Backtest

```bash
node backtest/fetch-ticks.js R_100 --days=7      # real ticks, run on your machine (needs .env)
node backtest/generate-ticks.js R_100 --days=10   # synthetic data: pipeline check only, has no edge
node backtest/run.js R_100 --pip=0.1 --spread=0.02 --slip=0.01 --sensitivity
```

Uses the same engine as live trading. Reports every statistic in the spec, in-sample vs out-of-sample (`--oos=0.3`),
long vs short, performance by market condition, and a stop × trail sensitivity grid. Tick data gives exact intrabar
order; OHLC-only data replays each bar both ways, flags ambiguous trades and **uses the worse outcome**.
`--no-limits` switches the risk limits off; blocked entries are counted in the report otherwise.

## Things you must know

1. **Trailing is enforced by the bot, not by Deriv.** Deriv multipliers can't move a stop-loss into profit. The initial
   stop is also sent to Deriv as a server-side stop (so a crash can't leave a trade unprotected), but once the trail
   passes breakeven only this process protects the profit. If the bot is offline, only the original stop remains.
2. **Pip sizes are starting guesses** (`config/symbols.js`: 10 × tick for symbols with ≥2 decimals, else 1 × tick).
   The dashboard shows what your pips mean in price points, % of price and dollars. If the initial stop is below
   Deriv's minimum (or larger than the stake) no server-side stop can be sent; the preview and log say so.
3. **Trailing activation** — the spec asked the developer to confirm this. Default `breakeven`: the trail only takes
   over once `best price − 15 pips` reaches the entry, so the full 20-pip risk is kept. `immediate` tightens risk to
   15 pips from the first tick. Switchable in the dashboard.
4. **Not yet proven against the real Deriv API.** The live path is tested end to end against a faithful fake
   (`test/fake-deriv.js`), but Deriv field names and error texts are assumed from the old bot. Run on **demo** and watch
   the activity log before trusting it; `fetch-ticks.js` is likewise untested against the live API.
5. Risk limits reset at 00:00 UTC. "Clear halt" resets the consecutive-loss streak and failure flags (never the daily loss).
6. Real-money mode needs `ALLOW_REAL=true` in the server environment; the dashboard cannot unlock it.

## Layout

```
config/symbols.js     48 symbols, decimals, default pips, multiplier ladders
src/core/             engine (pure state machine), settings, sizing
src/live/             deriv client, bot runner, persistence
src/server.js         dashboard API; public/index.html is the UI
backtest/             simulator, report, run / generate-ticks / fetch-ticks
test/                 engine rules, simulator, live flow vs fake Deriv
```

## Safety guards worth knowing

- **Stop sanity check** (Risk section of the dashboard): if the stop is smaller than *N ×* a typical tick move on the chosen symbol, the bot skips the entry (counted as `stopTooTight`) instead of opening a trade that random jitter will stop out. The preview shows your stop as a multiple of a typical tick once ticks are flowing.
- **Multiplier**: on connect the bot asks Deriv which multipliers the symbol offers. `auto` uses the smallest. A multiplier you type that Deriv doesn't offer is rejected with the allowed list, never silently changed.
- **Rejected orders** are logged with the exact request sent to Deriv.

## Exit model: signal-candle stop, breakeven, step trail (default)

Entries are unchanged: the previous *completed* M1 candle's direction, opened at the next candle's first tick (doji = no trade, one entry per candle, one position).

- **Initial stop** = the signal candle's **low** (BUY) or **high** (SELL). If that level is not a valid stop against the real price (a gap), the entry is skipped, or a fallback distance is used if you set `candleSl.policy = fallback`.
- **Breakeven**: once the best price reaches `breakeven.triggerPips` (default 5), the stop moves to entry (+ `bufferPips`). One-way.
- **Step trail**: locked pips = `max(0, floor(maxProfit / step) × step − offset)` (defaults 5 / 5), based on the best price reached, so retracements never loosen it and a jump over several milestones goes straight to the highest stop. Breakeven and the step trail are independent switches.
- **No take profit.** Exit reasons: `initial_stop`, `breakeven_stop`, `trailing_stop`.
- Only the initial stop is placed at Deriv (as a loss amount, $0.10 minimum). Deriv cannot move a multiplier stop into profit, so breakeven and trailing are enforced by the bot while it is running.
- The original fixed-pip model is still available: set **Exit model** to "Fixed SL + fixed trail" on the dashboard.
