// ═══════════════════════════════════════════════════════
//  backtest/simulator.js
//
//  Drives the REAL ScalperEngine with a simulated broker.
//
//  TICK mode   (preferred): every tick is replayed in order, so the
//    sequence of stop / trail events inside a minute is exact.
//  CANDLE mode (fallback)  : only M1 OHLC is known, so the order in
//    which O/H/L/C happened inside a bar is NOT known. Each bar is
//    replayed through BOTH plausible paths (O→L→H→C and O→H→L→C).
//    If the two paths disagree about the outcome of an open position,
//    the trade is flagged `ambiguous` and the WORSE outcome is used —
//    the simulator never picks the more profitable ending.
// ═══════════════════════════════════════════════════════
import { ScalperEngine } from "../src/core/engine.js";

const DEFAULT_START_BALANCE = 1000;

function makeBroker(settings, trades, counter) {
  const { spreadPoints, slippagePoints, commissionUsd } = settings.costs;
  const half = spreadPoints / 2;
  const tickOf = (epoch, price) => ({ epoch, bid: price - half, ask: price + half, price });

  // execute engine commands synchronously against the current tick
  function run(engine, cmds, tick) {
    for (const cmd of cmds) {
      if (cmd.type === "OPEN") {
        const fill = cmd.side === "BUY" ? tick.ask + slippagePoints : tick.bid - slippagePoints;
        engine.onOpenConfirmed({
          contractId: `sim-${++counter.n}`, entryPrice: fill, entryEpoch: tick.epoch,
          stake: cmd.stake, multiplier: cmd.multiplier, nativeStopUsd: cmd.nativeStopUsd,
        });
      } else if (cmd.type === "CLOSE") {
        const pos = engine.position;
        if (!pos) continue;
        const fill = pos.side === "BUY" ? tick.bid - slippagePoints : tick.ask + slippagePoints;
        const t = engine.onCloseConfirmed({
          exitPrice: fill, exitEpoch: tick.epoch, reason: cmd.reason,
          exitMid: (tick.bid + tick.ask) / 2, commission: commissionUsd,
        });
        if (t) trades.push(t);
      }
    }
  }
  return { tickOf, run };
}

function newEngine(settings, startBalance) {
  const e = new ScalperEngine({ ...settings, enabled: true });
  e.setBalance(startBalance);
  return e;
}

/** Tick mode. ticks: [{epoch, quote}] sorted ascending. */
export function simulateTicks(ticks, settings, { startBalance = DEFAULT_START_BALANCE } = {}) {
  const trades = [], counter = { n: 0 };
  const engine = newEngine(settings, startBalance);
  const broker = makeBroker(settings, trades, counter);
  for (const t of ticks) {
    const tick = broker.tickOf(t.epoch, t.quote);
    engine.setBalance(startBalance + engine.s.totalPnl);
    broker.run(engine, engine.onTick(tick), tick);
  }
  return { trades, engine, ambiguous: 0, mode: "tick" };
}

/** Candle mode. bars: [{epoch, open, high, low, close}] sorted ascending (epoch = open time). */
export function simulateCandles(bars, settings, { startBalance = DEFAULT_START_BALANCE } = {}) {
  const trades = [], counter = { n: 0 };
  const engine = newEngine(settings, startBalance);
  let ambiguous = 0;

  const mk = (b, price, off) => ({ epoch: b.epoch + off, price });
  const OFF = { o: 0, a: 15, b: 30, c: 59 };

  for (const b of bars) {
    const broker = makeBroker(settings, trades, counter);
    engine.setBalance(startBalance + engine.s.totalPnl);

    // 1) the open tick — signals / entries happen here, exactly as live
    const t0 = broker.tickOf(b.epoch + OFF.o, b.open);
    broker.run(engine, engine.onTick(t0), t0);

    // 2) the rest of the bar, through both orderings
    const rest = (first, second) => [mk(b, first, OFF.a), mk(b, second, OFF.b), mk(b, b.close, OFF.c)];
    const pathDown = rest(b.low, b.high);     // O → L → H → C
    const pathUp   = rest(b.high, b.low);     // O → H → L → C

    if (!engine.position) {
      // flat: nothing can happen to a stop, just keep the candle builder fed
      for (const p of pathDown) { const tk = broker.tickOf(p.epoch, p.price); engine.onTick(tk); }
      continue;
    }

    const runPath = (path) => {
      const e = new ScalperEngine({ ...settings, enabled: true });
      e.s = structuredClone(engine.s);
      const out = [], cn = { n: counter.n };
      const br = makeBroker(settings, out, cn);
      for (const p of path) { const tk = br.tickOf(p.epoch, p.price); br.run(e, e.onTick(tk), tk); }
      return { e, out, cn };
    };
    const A = runPath(pathDown), B = runPath(pathUp);
    const closedA = A.out.length > 0, closedB = B.out.length > 0;
    let chosen = A, flag = false;

    if (closedA !== closedB) {
      chosen = closedA ? A : B; flag = true;                       // the path that stops out is the cautious one
    } else if (closedA && closedB) {
      const ta = A.out[0], tb = B.out[0];
      if (ta.exitReason !== tb.exitReason || Math.abs(ta.exitPrice - tb.exitPrice) > 1e-12) {
        flag = true;
        chosen = ta.netPnl <= tb.netPnl ? A : B;                    // worse outcome wins
      }
    }
    engine.s = chosen.e.s;
    counter.n = chosen.cn.n;
    for (const t of chosen.out) { if (flag) t.ambiguous = true; trades.push(t); }
    if (flag) ambiguous++;
  }
  return { trades, engine, ambiguous, mode: "candle" };
}

/** Aggregate tick list into M1 bars (used for regime tagging and the OOS split). */
export function ticksToBars(ticks) {
  const bars = [];
  let cur = null;
  for (const t of ticks) {
    const bucket = Math.floor(t.epoch / 60) * 60;
    if (!cur || cur.epoch !== bucket) { if (cur) bars.push(cur); cur = { epoch: bucket, open: t.quote, high: t.quote, low: t.quote, close: t.quote }; }
    else { cur.high = Math.max(cur.high, t.quote); cur.low = Math.min(cur.low, t.quote); cur.close = t.quote; }
  }
  if (cur) bars.push(cur);
  return bars;
}
