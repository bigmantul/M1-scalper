import test from "node:test";
import assert from "node:assert/strict";
import { ScalperEngine, STATUS, manageStop, candleDirection } from "../src/core/engine.js";
import { validateSettings } from "../src/core/settings.js";
import { simulateCandles, simulateTicks } from "../backtest/simulator.js";

const T0 = 1_700_000_040;               // exactly on a minute boundary
const K = (n) => T0 + 60 * n;           // epoch of candle n

// 1 pip == 1 price point so the numbers in the tests are easy to read
function mkSettings(patch = {}) {
  return validateSettings({
    enabled: true, symbol: "R_100", pipSizes: { R_100: 1 },
    slPips: 20, trailPips: 15, trailActivation: "breakeven",
    sizing: { mode: "fixed", stake: 10 },
    ...patch,
  });
}

/** Drives the engine tick by tick with an instant, perfect broker. */
function harness(patch = {}, { spread = 0, autoConfirm = true } = {}) {
  const settings = mkSettings(patch);
  const engine = new ScalperEngine(settings);
  engine.setBalance(1000);
  const trades = [], opens = [], closes = [];
  const step = (epoch, price) => {
    const tick = { epoch, bid: price - spread / 2, ask: price + spread / 2 };
    const cmds = engine.onTick(tick);
    for (const c of cmds) {
      if (c.type === "OPEN") {
        opens.push({ ...c, at: epoch });
        if (autoConfirm) engine.onOpenConfirmed({ contractId: `c${opens.length}`, entryPrice: c.side === "BUY" ? tick.ask : tick.bid, entryEpoch: epoch, stake: c.stake, multiplier: c.multiplier });
      } else if (c.type === "CLOSE") {
        closes.push({ ...c, at: epoch });
        const pos = engine.position;
        const t = engine.onCloseConfirmed({ exitPrice: pos.side === "BUY" ? tick.bid : tick.ask, exitEpoch: epoch, reason: c.reason });
        if (t) trades.push(t);
      }
    }
    return cmds;
  };
  return { engine, settings, step, trades, opens, closes };
}

// ── candle direction ─────────────────────────────────
test("candle direction from open/close", () => {
  assert.equal(candleDirection({ open: 1, close: 2 }), "BULLISH");
  assert.equal(candleDirection({ open: 2, close: 1 }), "BEARISH");
  assert.equal(candleDirection({ open: 2, close: 2 }), "NEUTRAL");
});

test("bullish completed candle -> BUY at the next candle's first tick", () => {
  const h = harness();
  h.step(K(0), 100); h.step(K(0) + 30, 102); h.step(K(0) + 59, 101);
  assert.equal(h.opens.length, 0, "must not trade inside the forming candle");
  h.step(K(1), 101);
  assert.equal(h.opens.length, 1);
  assert.equal(h.opens[0].side, "BUY");
  assert.equal(h.opens[0].at, K(1));
  assert.equal(h.engine.position.entryPrice, 101);
  assert.equal(h.engine.position.initialSl, 81, "initial SL = entry - 20 pips");
});

test("bearish completed candle -> SELL with SL 20 pips above entry", () => {
  const h = harness();
  h.step(K(0), 100); h.step(K(0) + 30, 98); h.step(K(0) + 59, 99);
  h.step(K(1), 99);
  assert.equal(h.opens[0].side, "SELL");
  assert.equal(h.engine.position.initialSl, 119);
});

test("neutral candle (open == close) opens nothing and the bot stays flat", () => {
  const h = harness();
  h.step(K(0), 100); h.step(K(0) + 20, 105); h.step(K(0) + 59, 100);
  h.step(K(1), 100);
  assert.equal(h.opens.length, 0);
  assert.equal(h.engine.status, STATUS.WAITING_FOR_NEXT_CANDLE);
  // next directional candle is acted on
  h.step(K(1) + 30, 103); h.step(K(2), 103);
  assert.equal(h.opens.length, 1);
  assert.equal(h.opens[0].side, "BUY");
});

test("a candle is evaluated once: duplicate ticks never create a second signal", () => {
  const h = harness({}, { autoConfirm: false });
  h.step(K(0), 100); h.step(K(0) + 59, 101);
  h.step(K(1), 101);
  h.step(K(1), 101);
  h.step(K(1) + 1, 101);
  assert.equal(h.opens.length, 1);
});

test("data gap: a stale candle is not an entry signal", () => {
  const h = harness();
  h.step(K(0), 100); h.step(K(0) + 59, 101);
  h.step(K(2), 101);                       // candle 1 had no ticks at all
  assert.equal(h.opens.length, 0);
});

// ── trailing stop ────────────────────────────────────
function enterBuyAt101() {
  const h = harness();
  h.step(K(0), 100); h.step(K(0) + 59, 101); h.step(K(1), 101);
  assert.equal(h.engine.position.entryPrice, 101);
  return h;
}

test("breakeven activation keeps the full 20-pip risk until the trail reaches entry", () => {
  const h = enterBuyAt101();
  h.step(K(1) + 10, 111);                  // trail candidate 96 < entry -> not allowed yet
  assert.equal(h.engine.position.effectiveSl, 81);
  h.step(K(1) + 20, 116);                  // candidate 101 == entry -> activates at breakeven
  assert.equal(h.engine.position.effectiveSl, 101);
  h.step(K(1) + 30, 130);
  assert.equal(h.engine.position.effectiveSl, 115);
});

test("trailing stop only ever moves in the protective direction", () => {
  const h = enterBuyAt101();
  h.step(K(1) + 10, 130);
  const sl = h.engine.position.effectiveSl;
  assert.equal(sl, 115);
  h.step(K(1) + 20, 122); h.step(K(1) + 25, 118);
  assert.equal(h.engine.position.effectiveSl, sl, "pullback must not loosen the stop");
  h.step(K(1) + 30, 140);
  assert.equal(h.engine.position.effectiveSl, 125);
});

test("BUY closes when the bid reaches the trailing stop; no take profit exists", () => {
  const h = enterBuyAt101();
  h.step(K(1) + 10, 200);                  // huge move: nothing closes it
  assert.equal(h.closes.length, 0);
  h.step(K(1) + 20, 185);                  // stop is 185
  assert.equal(h.closes.length, 1);
  assert.equal(h.closes[0].reason, "trailing_stop");
  assert.equal(h.trades[0].exitPrice, 185);
  assert.ok(h.trades[0].netPnl > 0);
});

test("initial stop closes a losing BUY at -20 pips", () => {
  const h = enterBuyAt101();
  h.step(K(1) + 10, 90);
  h.step(K(1) + 20, 81);
  assert.equal(h.closes[0].reason, "initial_stop");
  assert.ok(h.trades[0].netPnl < 0);
});

test("SELL trailing mirrors BUY (stop only moves down)", () => {
  const h = harness();
  h.step(K(0), 100); h.step(K(0) + 59, 99); h.step(K(1), 99);       // SELL @ 99, SL 119
  assert.equal(h.engine.position.effectiveSl, 119);
  h.step(K(1) + 10, 89);                   // candidate 104 > entry -> not allowed yet
  assert.equal(h.engine.position.effectiveSl, 119);
  h.step(K(1) + 20, 84);                   // candidate 99 == entry -> breakeven
  assert.equal(h.engine.position.effectiveSl, 99);
  h.step(K(1) + 30, 60);
  assert.equal(h.engine.position.effectiveSl, 75);
  h.step(K(1) + 40, 70);                   // bounce, stop must not rise
  assert.equal(h.engine.position.effectiveSl, 75);
  h.step(K(1) + 45, 75);
  assert.equal(h.closes[0].reason, "trailing_stop");
});

test("'immediate' activation tightens to the trail distance from the first tick", () => {
  const h = harness({ trailActivation: "immediate" });
  h.step(K(0), 100); h.step(K(0) + 59, 101); h.step(K(1), 101);
  h.step(K(1) + 5, 101);
  assert.equal(h.engine.position.effectiveSl, 86, "max(initial 81, trail 101-15)");
});

test("manageStop never lets one tick both raise the stop and hit it", () => {
  const pos = { side: "BUY", entryPrice: 100, initialSl: 80, effectiveSl: 80, trailSl: null, extreme: 100, trailDist: 15, trailActivation: "immediate" };
  const r = manageStop(pos, { bid: 79, ask: 79 });
  assert.equal(r.hit, true);
});

// ── re-entry timing ──────────────────────────────────
function closeInsideCandle1(candle1Last) {
  const h = enterBuyAt101();                // BUY @101 at K1
  h.step(K(1) + 10, 130);                   // stop 115
  h.step(K(1) + 35, 112);                   // closes inside candle 1 (the "10:00:35" example)
  assert.equal(h.trades.length, 1);
  assert.equal(h.engine.status, STATUS.WAITING_FOR_NEXT_CANDLE);
  h.step(K(1) + 50, candle1Last);           // rest of candle 1
  return h;
}

test("after a close the bot waits for the current candle to finish — no instant re-entry", () => {
  const h = closeInsideCandle1(140);
  assert.equal(h.opens.length, 1, "no new entry while the closing candle is still forming");
  h.step(K(1) + 59, 140);
  assert.equal(h.opens.length, 1);
});

test("scenario A — continuation: bullish candle after a BUY closes -> new BUY, fresh stops", () => {
  const h = closeInsideCandle1(140);        // candle 1: open 101 -> close 140 = bullish
  h.step(K(2), 140);
  assert.equal(h.opens.length, 2);
  assert.equal(h.opens[1].side, "BUY");
  assert.equal(h.opens[1].at, K(2));
  const p = h.engine.position;
  assert.equal(p.entryPrice, 140);
  assert.equal(p.initialSl, 120, "fresh stop from the NEW entry, not the old position's stop");
  assert.equal(p.trailSl, null, "trailing tracker reset");
  assert.equal(p.trailActive, false);
});

test("scenario B — reversal: bearish candle after a BUY closes -> new SELL", () => {
  const h = closeInsideCandle1(90);         // candle 1: open 101 -> close 90 = bearish
  h.step(K(2), 90);
  assert.equal(h.opens[1].side, "SELL");
  assert.equal(h.engine.position.initialSl, 110);
});

test("scenario C — neutral candle after a close: stay flat until a directional candle", () => {
  const h = closeInsideCandle1(101);        // candle 1: open 101, close 101 = neutral
  h.step(K(2), 101);
  assert.equal(h.opens.length, 1);
  h.step(K(2) + 30, 99); h.step(K(3), 99);  // candle 2 bearish
  assert.equal(h.opens[1].side, "SELL");
});

test("a stop hit on the very first tick of the next candle still waits for THAT candle", () => {
  const h = enterBuyAt101();
  h.step(K(1) + 10, 130);                   // stop 115
  h.step(K(2), 100);                        // first tick of candle 2 breaches the stop
  assert.equal(h.trades.length, 1);
  assert.equal(h.opens.length, 1, "candle 1 ended before the position was flat");
  h.step(K(2) + 30, 95); h.step(K(3), 95);  // candle 2 completes bearish
  assert.equal(h.opens[1].side, "SELL");
});

test("no second position while one is active, even across several candles", () => {
  const h = enterBuyAt101();
  h.step(K(1) + 30, 110); h.step(K(2), 112); h.step(K(2) + 30, 114); h.step(K(3), 115);
  assert.equal(h.opens.length, 1);
});

// ── order handling ───────────────────────────────────
test("engine does not assume an order succeeded: stays in OPENING_POSITION until confirmed", () => {
  const h = harness({}, { autoConfirm: false });
  h.step(K(0), 100); h.step(K(0) + 59, 101); h.step(K(1), 101);
  assert.equal(h.engine.status, STATUS.OPENING_POSITION);
  assert.equal(h.engine.position, null);
  h.step(K(1) + 30, 103); h.step(K(2), 103);
  assert.equal(h.opens.length, 1, "no duplicate order while the first is unconfirmed");
});

test("rejected order is not retried on the same candle; repeated failures disable the bot", () => {
  const h = harness({ risk: { maxExecFailures: 2 } }, { autoConfirm: false });
  h.step(K(0), 100); h.step(K(0) + 59, 101); h.step(K(1), 101);
  h.engine.onOpenRejected("boom");
  h.step(K(1) + 5, 102);
  assert.equal(h.opens.length, 1);
  h.step(K(1) + 30, 103); h.step(K(2), 103);        // next candle -> allowed to try again
  assert.equal(h.opens.length, 2);
  h.engine.onOpenRejected("boom again");
  assert.ok(h.engine.s.disabledReason, "disabled after maxExecFailures");
  h.step(K(2) + 30, 104); h.step(K(3), 104);
  assert.equal(h.opens.length, 2);
});

test("a rejected close is retried and never leaves the position unmanaged", () => {
  const h = enterBuyAt101();
  h.step(K(1) + 10, 130);
  const tick = { epoch: K(1) + 20, bid: 110, ask: 110 };
  const cmds = h.engine.onTick(tick);
  assert.equal(cmds[0].type, "CLOSE");
  h.engine.onCloseRejected("temporary error", 1);
  const retry = h.engine.onTick({ epoch: K(1) + 22, bid: 109, ask: 109 });
  assert.equal(retry[0]?.type, "CLOSE");
  assert.equal(retry[0].retry, true);
});

// ── risk controls ────────────────────────────────────
function signalBlockedBy(patchEngine, patchSettings = {}, spread = 0) {
  const h = harness(patchSettings, { spread });
  patchEngine?.(h.engine);
  h.step(K(0), 100); h.step(K(0) + 59, 101); h.step(K(1), 101);
  return h.opens.length === 0;
}
test("daily loss limit blocks new entries", () => {
  assert.ok(signalBlockedBy((e) => { e.s.day = new Date(K(0) * 1000).toISOString().slice(0, 10); e.s.dailyPnl = -11; }, { risk: { dailyLossUsd: 10 } }));
});
test("max consecutive losses blocks new entries", () => {
  assert.ok(signalBlockedBy((e) => { e.s.day = new Date(K(0) * 1000).toISOString().slice(0, 10); e.s.consecLosses = 3; }, { risk: { consecLossMax: 3 } }));
});
test("spread filter blocks wide-spread entries; other limits stay independent", () => {
  assert.ok(signalBlockedBy(null, { risk: { spreadFilterEnabled: true, maxSpreadPoints: 1 } }, 3));
  assert.ok(!signalBlockedBy(null, { risk: { spreadFilterEnabled: false, maxSpreadPoints: 1 } }, 3));
});
test("risk limits can be switched off independently", () => {
  assert.ok(!signalBlockedBy((e) => { e.s.day = new Date(K(0) * 1000).toISOString().slice(0, 10); e.s.dailyPnl = -50; }, { risk: { dailyLossEnabled: false } }));
});
test("emergency disable stops new entries", () => {
  assert.ok(signalBlockedBy((e) => e.disable("manual")));
});
test("loss never increases the next stake (no martingale)", () => {
  const h = harness({ sizing: { mode: "fixed", stake: 7 } });
  h.engine.s.consecLosses = 2; h.engine.s.dailyPnl = -5;
  h.step(K(0), 100); h.step(K(0) + 59, 101); h.step(K(1), 101);
  assert.equal(h.opens[0].stake, 7);
});

// ── persistence / reconciliation ─────────────────────
test("restored state refuses to trade until reconciled with the broker", () => {
  const h = harness();
  const saved = h.engine.serialize();
  const e2 = new ScalperEngine(mkSettings()); e2.setBalance(1000); e2.restore(saved);
  const cmds = [];
  for (const [t, p] of [[K(0), 100], [K(0) + 59, 101], [K(1), 101]]) cmds.push(...e2.onTick({ epoch: t, bid: p, ask: p }));
  assert.equal(cmds.length, 0);
  e2.reconcile(null);
  for (const [t, p] of [[K(1) + 30, 103], [K(2), 103]]) cmds.push(...e2.onTick({ epoch: t, bid: p, ask: p }));
  assert.equal(cmds[0]?.type, "OPEN");
});

test("an existing broker position is adopted with fresh stops, never ignored", () => {
  const e = new ScalperEngine(mkSettings()); e.setBalance(1000);
  e.restore(e.serialize());
  const r = e.reconcile({ contractId: "abc", side: "BUY", entryPrice: 100, entryEpoch: K(0), stake: 10, multiplier: 5 });
  assert.equal(r, "adopted");
  assert.equal(e.position.initialSl, 80);
  assert.equal(e.status, STATUS.POSITION_ACTIVE);
});

test("position that vanished at the broker is reported, not silently dropped", () => {
  const h = enterBuyAt101();
  h.engine.onConnectionLost();
  assert.equal(h.engine.reconcile(null), "vanished");
  assert.ok(h.engine.position, "kept until the caller confirms how it closed");
  const t = h.engine.onCloseConfirmed({ exitPrice: 95, exitEpoch: K(1) + 40, reason: "broker_closed" });
  assert.equal(t.exitReason, "broker_closed");
  assert.equal(h.engine.position, null);
});

test("connection loss during an unconfirmed OPEN blocks trading until reconciled", () => {
  const h = harness({}, { autoConfirm: false });
  h.step(K(0), 100); h.step(K(0) + 59, 101); h.step(K(1), 101);
  h.engine.onConnectionLost();
  assert.equal(h.engine.status, STATUS.ERROR_OR_RECOVERY);
  h.engine.reconcile(null);                                   // order never reached the broker
  assert.equal(h.engine.status, STATUS.WAITING_FOR_NEXT_CANDLE);
});

// ── simulator ────────────────────────────────────────
test("tick simulator: full BUY → reversal SELL cycle with costs", () => {
  const S = mkSettings({ costs: { spreadPoints: 0.5, slippagePoints: 0, commissionUsd: 0.01 } });
  const ticks = [
    [0, 100], [30, 102], [59, 101],            // candle 0 bullish
    [60, 101], [70, 130], [95, 112],           // BUY @101.25, stop 115, closes @111.75
    [110, 90],                                 // candle 1 closes bearish (101 -> 90)
    [120, 90], [130, 60], [150, 80],           // SELL @89.75 ...
  ].map(([o, q]) => ({ epoch: K(0) + o, quote: q }));
  const r = simulateTicks(ticks, S);
  assert.equal(r.trades[0].side, "BUY");
  assert.equal(r.trades[0].entryPrice, 101.25, "BUY fills at the ask: quote 101 + half the 0.5 spread");
  assert.equal(r.trades[0].exitPrice, 111.75, "closes at the bid (quote 112 - 0.25) on the tick that breaches the trailing stop");
  assert.equal(r.trades[1].side, "SELL");
  assert.equal(r.trades[1].entryPrice, 89.75, "SELL fills at the bid: quote 90 - 0.25");
  assert.ok(r.trades[0].tradingCosts > 0, "spread + commission recorded as costs");
});

test("candle simulator flags ambiguous bars and uses the worse outcome", () => {
  const S = mkSettings();
  const bars = [
    { epoch: K(0), open: 100, high: 101, low: 99, close: 101 },     // bullish -> BUY at next open
    { epoch: K(1), open: 101, high: 125, low: 105, close: 120 },    // O→L→H→C holds; O→H→L→C stops out at 110/105
    { epoch: K(2), open: 120, high: 121, low: 119, close: 120 },
  ];
  const r = simulateCandles(bars, S);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].ambiguous, true);
  assert.equal(r.trades[0].exitReason, "trailing_stop");
  assert.equal(r.ambiguous, 1);
});

test("candle simulator: unambiguous bars are not flagged", () => {
  const S = mkSettings();
  const bars = [
    { epoch: K(0), open: 100, high: 101, low: 99, close: 101 },
    { epoch: K(1), open: 101, high: 103, low: 100, close: 102 },
    { epoch: K(2), open: 102, high: 103, low: 70, close: 72 },      // crashes through the initial stop either way
  ];
  const r = simulateCandles(bars, S);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].ambiguous, undefined);
  assert.equal(r.trades[0].exitReason, "initial_stop");
});

test("onOpenSkipped clears the pending order and counts the block", () => {
  const h = harness({}, { autoConfirm: false });
  h.step(K(0), 100); h.step(K(0) + 59, 101); h.step(K(1), 101);
  h.engine.onOpenSkipped("too tight", "stopTooTight");
  assert.equal(h.engine.s.pending, null);
  assert.equal(h.engine.s.blocked.stopTooTight, 1);
  assert.equal(h.engine.s.execFailures, 0);
  assert.equal(h.engine.status, STATUS.WAITING_FOR_NEXT_CANDLE);
});
