// ═══════════════════════════════════════════════════════
//  src/core/engine.js — M1 momentum stop-and-reverse engine
//
//  PURE and deterministic: no network, no wall-clock, no files.
//  The live bot and the backtester drive the SAME engine, so a
//  backtest exercises exactly the rules that trade live.
//
//  Input : ticks  { epoch (seconds), bid, ask }
//  Output: commands the caller must execute, e.g.
//            { type: "OPEN",  side, ... }   -> then call onOpenConfirmed / onOpenRejected
//            { type: "CLOSE", reason, ... } -> then call onCloseConfirmed / onCloseRejected
//  The engine NEVER assumes an order worked: it stays in OPENING_POSITION /
//  POSITION_CLOSING until the caller confirms.
// ═══════════════════════════════════════════════════════
import { distancesFor } from "./settings.js";
import { computeSize, pnlFor, dirSign } from "./sizing.js";

export const STATUS = Object.freeze({
  INITIALIZING: "INITIALIZING",
  WAITING_FOR_CANDLE_CLOSE: "WAITING_FOR_CANDLE_CLOSE",
  SIGNAL_DETECTED: "SIGNAL_DETECTED",
  OPENING_POSITION: "OPENING_POSITION",
  POSITION_ACTIVE: "POSITION_ACTIVE",
  TRAILING_STOP_MONITORING: "TRAILING_STOP_MONITORING",
  POSITION_CLOSING: "POSITION_CLOSING",
  WAITING_FOR_NEXT_CANDLE: "WAITING_FOR_NEXT_CANDLE",
  ERROR_OR_RECOVERY: "ERROR_OR_RECOVERY",
});

export const CANDLE_SECS = 60;
const bucketOf = (epoch) => Math.floor(epoch / CANDLE_SECS) * CANDLE_SECS;
const utcDay = (epoch) => new Date(epoch * 1000).toISOString().slice(0, 10);
const IN_POSITION = new Set([STATUS.POSITION_ACTIVE, STATUS.TRAILING_STOP_MONITORING, STATUS.POSITION_CLOSING]);

export function candleDirection(c) {
  if (c.close > c.open) return "BULLISH";
  if (c.close < c.open) return "BEARISH";
  return "NEUTRAL";
}

/** Pure stop maths for ONE tick. Returns the updated stop fields and whether the stop was hit. */
export function manageStop(pos, tick) {
  const buy = pos.side === "BUY";
  const exitPx = buy ? tick.bid : tick.ask;           // BUY exits on the sell side, SELL on the buy side

  // 1) Test the stop that was in force BEFORE this tick moved anything (no look-ahead:
  //    a single tick can never both raise the stop and hit it).
  const hit = buy ? exitPx <= pos.effectiveSl : exitPx >= pos.effectiveSl;
  if (hit) return { hit: true, exitPx };

  // 2) Track the most favourable executable price since entry.
  const extreme = buy ? Math.max(pos.extreme, exitPx) : Math.min(pos.extreme, exitPx);
  const candidate = buy ? extreme - pos.trailDist : extreme + pos.trailDist;

  // 3) Trail only once it is allowed to act, and only ever in the protective direction.
  const eligible = pos.trailActivation === "immediate"
    ? true
    : buy ? candidate >= pos.entryPrice : candidate <= pos.entryPrice;
  let effectiveSl = pos.effectiveSl;
  let trailSl = pos.trailSl;
  if (eligible) {
    trailSl = trailSl == null ? candidate : (buy ? Math.max(trailSl, candidate) : Math.min(trailSl, candidate));
    // Effective SL = max(initial, trail) for BUY, min(initial, trail) for SELL, and never loosens.
    const best = buy ? Math.max(pos.initialSl, trailSl) : Math.min(pos.initialSl, trailSl);
    effectiveSl = buy ? Math.max(effectiveSl, best) : Math.min(effectiveSl, best);
  }
  return { hit: false, exitPx, extreme, trailSl, effectiveSl };
}

export class ScalperEngine {
  /**
   * @param {object} settings  validated settings (see settings.js)
   * @param {object} [opts]    { logger(level, message, data) }
   */
  constructor(settings, { logger } = {}) {
    this.settings = settings;
    this.logger = logger || (() => {});
    this.s = {
      status: STATUS.INITIALIZING,
      candle: null,                  // currently forming candle
      lastProcessedCandleEpoch: 0,   // each completed candle is evaluated once
      lastEntryCandleEpoch: 0,       // each signal candle can open at most one trade
      closeCandleEpoch: null,        // M1 bucket in which the last position closed
      pending: null,                 // {type:"OPEN"|"CLOSE", ...} awaiting broker confirmation
      position: null,
      lastTick: null,
      balance: 0,
      day: null, dailyPnl: 0, consecLosses: 0, tradesToday: 0,
      totalPnl: 0, totalTrades: 0,
      execFailures: 0,
      needsReconcile: false,         // true -> no new orders until reconciled with the broker
      disabledReason: null,          // set by the emergency switch / risk halts
      warmupDone: false,             // first candle after a cold start is partial -> never a signal
      nextTradeId: 1,
      retryCloseAfter: 0,
      blocked: {},                   // how many entry signals each risk control suppressed
    };
  }

  // ── public getters ────────────────────────────────────
  get status() { return this.s.status; }
  get position() { return this.s.position; }
  get inPosition() { return IN_POSITION.has(this.s.status) || this.s.position !== null; }

  setBalance(b) { if (Number.isFinite(b)) this.s.balance = b; }
  updateSettings(settings) { this.settings = settings; }     // applies to the NEXT position only

  log(level, message, data) { this.logger(level, message, data); }

  // ═════════════════════════════════════════════════════
  //  MAIN ENTRY: one price tick
  // ═════════════════════════════════════════════════════
  onTick(tick) {
    const cmds = [];
    if (!tick || !Number.isFinite(tick.epoch) || !Number.isFinite(tick.bid) || !Number.isFinite(tick.ask)) return cmds;
    const s = this.s;
    if (s.lastTick && tick.epoch < s.lastTick.epoch) return cmds;   // out-of-order tick: ignore
    s.lastTick = tick;

    // daily counters roll over on the UTC day of the tick (deterministic in backtests)
    const dayNum = Math.floor(tick.epoch / 86400);
    if (this._dayNum !== dayNum) {                 // only format the date when the UTC day number changes
      this._dayNum = dayNum;
      const day = utcDay(tick.epoch);
      if (s.day !== day) { s.day = day; s.dailyPnl = 0; s.consecLosses = 0; s.tradesToday = 0; this._riskHaltLogged = false; }
    }

    if (s.status === STATUS.INITIALIZING) s.status = STATUS.WAITING_FOR_CANDLE_CLOSE;

    // ── build M1 candles from mid prices ──
    const bucket = bucketOf(tick.epoch);
    const mid = (tick.bid + tick.ask) / 2;
    let completed = null;
    if (!s.candle) {
      s.candle = { epoch: bucket, open: mid, high: mid, low: mid, close: mid, partialStart: !s.warmupDone && tick.epoch - bucket > 3 };
    } else if (bucket > s.candle.epoch) {
      completed = s.candle;
      s.candle = { epoch: bucket, open: mid, high: mid, low: mid, close: mid, partialStart: false };
    } else {
      const c = s.candle;
      c.high = Math.max(c.high, mid); c.low = Math.min(c.low, mid); c.close = mid;
    }

    // ── manage an open position BEFORE looking at the candle ──
    if (s.position && !s.pending && (s.status === STATUS.POSITION_ACTIVE || s.status === STATUS.TRAILING_STOP_MONITORING)) {
      s.status = STATUS.TRAILING_STOP_MONITORING;   // monitoring is immediate
      const r = manageStop(s.position, tick);
      if (r.hit) {
        const p = s.position;
        const reason = p.trailSl != null && p.effectiveSl !== p.initialSl ? "trailing_stop" : "initial_stop";
        s.status = STATUS.POSITION_CLOSING;
        s.pending = { type: "CLOSE", reason, since: tick.epoch };
        cmds.push({ type: "CLOSE", reason, contractId: p.contractId, tradeId: p.id, refPrice: r.exitPx, stop: p.effectiveSl });
        this.log("info", `Stop hit (${reason}) @ ${r.exitPx} | stop ${p.effectiveSl}`, { tradeId: p.id });
      } else {
        const p = s.position;
        if (r.effectiveSl !== p.effectiveSl) {
          this.log("debug", `Stop moved ${p.effectiveSl} -> ${r.effectiveSl}`, { tradeId: p.id, extreme: r.extreme });
        }
        p.extreme = r.extreme; p.trailSl = r.trailSl; p.effectiveSl = r.effectiveSl;
        if (p.trailSl != null && p.effectiveSl !== p.initialSl) p.trailActive = true;
      }
    } else if (s.position && s.pending?.type === "CLOSE" && tick.epoch >= s.retryCloseAfter && s.retryCloseAfter > 0) {
      // a rejected close is retried (the stop is still breached) — see onCloseRejected
      s.retryCloseAfter = 0;
      cmds.push({ type: "CLOSE", reason: s.pending.reason, contractId: s.position.contractId, tradeId: s.position.id, retry: true, refPrice: s.position.side === "BUY" ? tick.bid : tick.ask });
    }

    // ── a candle just completed (this tick is the first tick of the next one) ──
    if (completed) this._onCandleCompleted(completed, bucket, tick, cmds);
    return cmds;
  }

  // ═════════════════════════════════════════════════════
  //  CANDLE → SIGNAL → ENTRY
  // ═════════════════════════════════════════════════════
  _onCandleCompleted(c, newBucket, tick, cmds) {
    const s = this.s;
    if (c.epoch <= s.lastProcessedCandleEpoch) return;           // each candle exactly once
    s.lastProcessedCandleEpoch = c.epoch;

    const dir = candleDirection(c);
    const first = !s.warmupDone;
    s.warmupDone = true;
    if (first && c.partialStart) { this.log("info", `Skipping start-up candle ${c.epoch} (began mid-minute, incomplete)`); return; }

    if (this.inPosition || s.pending) {
      this.log("debug", `Candle ${c.epoch} ${dir}: ignored — position/order in progress`);
      return;
    }
    if (s.status === STATUS.ERROR_OR_RECOVERY || s.needsReconcile) {
      this.log("warn", `Candle ${c.epoch} ${dir}: not trading — waiting for broker reconciliation`);
      return;
    }
    if (c.epoch + CANDLE_SECS !== newBucket) {
      this.log("warn", `Candle ${c.epoch} is stale (data gap) — not an entry signal`);
      s.status = STATUS.WAITING_FOR_NEXT_CANDLE;
      return;
    }
    if (s.closeCandleEpoch != null && c.epoch < s.closeCandleEpoch) return;
    if (c.epoch <= s.lastEntryCandleEpoch) return;               // unique signal per candle

    s.status = STATUS.WAITING_FOR_NEXT_CANDLE;
    if (dir === "NEUTRAL") { this.log("info", `Candle ${c.epoch} neutral (open == close) — staying flat`); return; }

    const block = this._riskBlock(tick);
    if (block) {
      const key = block.startsWith("spread") ? "spread" : block.startsWith("daily") ? "dailyLoss" : block.includes("consecutive") ? "consecLosses" : "disabled";
      s.blocked[key] = (s.blocked[key] || 0) + 1;
      if (!this._riskHaltLogged || block.startsWith("spread")) this.log("warn", `Entry blocked: ${block}`);
      if (!block.startsWith("spread")) this._riskHaltLogged = true;
      return;
    }

    const side = dir === "BULLISH" ? "BUY" : "SELL";
    const { slDist, trailDist, pip } = distancesFor(this.settings);
    const refPrice = side === "BUY" ? tick.ask : tick.bid;
    let size;
    try {
      size = computeSize(this.settings, { symbol: this.settings.symbol, balance: s.balance, entryPrice: refPrice, slDist });
    } catch (e) {
      this.log("error", `Cannot size trade: ${e.message}`);
      return;
    }

    s.status = STATUS.SIGNAL_DETECTED;
    s.lastEntryCandleEpoch = c.epoch;
    s.pending = {
      type: "OPEN", side, signalCandleEpoch: c.epoch, since: tick.epoch,
      candleDirection: dir, refMid: (tick.bid + tick.ask) / 2, spread: tick.ask - tick.bid,
      snapshot: { slDist, trailDist, pip, slPips: this.settings.slPips, trailPips: this.settings.trailPips, trailActivation: this.settings.trailActivation },
    };
    s.status = STATUS.OPENING_POSITION;
    this.log("info", `Signal: candle ${c.epoch} ${dir} (O ${c.open} C ${c.close}) -> ${side}`, { candle: c });
    cmds.push({
      type: "OPEN", side, symbol: this.settings.symbol, signalCandleEpoch: c.epoch,
      candleDirection: dir, refPrice, refMid: (tick.bid + tick.ask) / 2,
      spread: tick.ask - tick.bid,
      stake: size.stake, multiplier: size.multiplier, nativeStopUsd: size.nativeStopUsd, sizeNotes: size.notes,
      snapshot: { slDist, trailDist, pip, slPips: this.settings.slPips, trailPips: this.settings.trailPips, trailActivation: this.settings.trailActivation },
    });
  }

  _riskBlock(tick) {
    const s = this.s, r = this.settings.risk;
    if (!this.settings.enabled || s.disabledReason) return `bot disabled${s.disabledReason ? ` (${s.disabledReason})` : ""}`;
    if (r.dailyLossEnabled && r.dailyLossUsd > 0 && -s.dailyPnl >= r.dailyLossUsd) return `daily loss limit reached ($${(-s.dailyPnl).toFixed(2)} >= $${r.dailyLossUsd})`;
    if (r.consecLossEnabled && s.consecLosses >= r.consecLossMax) return `${s.consecLosses} consecutive losses (limit ${r.consecLossMax})`;
    if (r.spreadFilterEnabled && r.maxSpreadPoints > 0 && tick.ask - tick.bid > r.maxSpreadPoints) return `spread ${(tick.ask - tick.bid).toFixed(5)} > max ${r.maxSpreadPoints}`;
    return null;
  }

  // ═════════════════════════════════════════════════════
  //  BROKER CONFIRMATIONS
  // ═════════════════════════════════════════════════════
  /** The broker confirmed the entry. Stops are computed from the ACTUAL fill price. */
  onOpenConfirmed({ contractId, entryPrice, entryEpoch, stake, multiplier, nativeStopUsd = null, orderId = null }) {
    const s = this.s, pend = s.pending;
    if (!pend || pend.type !== "OPEN") { this.log("warn", "onOpenConfirmed without a pending OPEN — ignored"); return null; }
    const snap = pend.snapshot;
    const { slDist } = snap;
    const buy = pend.side === "BUY";
    const initialSl = buy ? entryPrice - slDist : entryPrice + slDist;       // fresh stop for THIS trade
    const lt = s.lastTick;
    const startExtreme = lt ? (buy ? Math.min(entryPrice, lt.bid) : Math.max(entryPrice, lt.ask)) : entryPrice;
    s.position = {
      id: s.nextTradeId++, side: pend.side, symbol: this.settings.symbol, contractId: contractId ?? null, orderId,
      entryPrice, entryEpoch, entryCandleEpoch: bucketOf(entryEpoch), signalCandleEpoch: pend.signalCandleEpoch,
      candleDirection: pend.candleDirection, refEntryMid: pend.refMid, spreadAtEntry: pend.spread,
      stake, multiplier, nativeStopUsd,
      slDist, trailDist: snap.trailDist, slPips: snap.slPips, trailPips: snap.trailPips, trailActivation: snap.trailActivation, pip: snap.pip,
      initialSl, trailSl: null, effectiveSl: initialSl, extreme: startExtreme, trailActive: false,
    };
    s.pending = null;
    s.execFailures = 0;
    s.status = STATUS.POSITION_ACTIVE;
    this.log("info", `Opened ${pend.side} @ ${entryPrice} | SL ${initialSl} | stake $${stake} x${multiplier}`, { tradeId: s.position.id, contractId });
    return s.position;
  }

  /** The runner decided NOT to send this entry (e.g. stop far too tight). Not an execution failure. */
  onOpenSkipped(reason, key = "skipped") {
    const s = this.s;
    if (!s.pending || s.pending.type !== "OPEN") return;
    s.pending = null;
    s.status = STATUS.WAITING_FOR_NEXT_CANDLE;
    s.blocked[key] = (s.blocked[key] || 0) + 1;
    this.log("warn", `Entry skipped: ${reason}`);
  }

  onOpenRejected(reason) {
    const s = this.s;
    if (!s.pending || s.pending.type !== "OPEN") return;
    s.pending = null;
    s.execFailures++;
    s.status = STATUS.WAITING_FOR_NEXT_CANDLE;       // the signal candle is consumed — no same-candle retry
    this.log("error", `Order rejected: ${reason} (failure ${s.execFailures}/${this.settings.risk.maxExecFailures})`);
    if (s.execFailures >= this.settings.risk.maxExecFailures) this.disable(`too many execution failures (${reason})`);
  }

  /** The broker confirmed the position is closed. Returns the finished trade record. */
  onCloseConfirmed({ exitPrice, exitEpoch, reason, exitMid = null, commission = 0, pnlOverride = null, contractId = null }) {
    const s = this.s, p = s.position;
    if (!p) { this.log("warn", "onCloseConfirmed with no open position — ignored"); return null; }
    const grossPnl = pnlFor({ side: p.side, entry: p.refEntryMid ?? p.entryPrice, exit: exitMid ?? exitPrice, stake: p.stake, multiplier: p.multiplier });
    const execPnl = pnlOverride ?? pnlFor({ side: p.side, entry: p.entryPrice, exit: exitPrice, stake: p.stake, multiplier: p.multiplier });
    const netPnl = execPnl - commission;
    const trade = {
      id: p.id, symbol: p.symbol, side: p.side, contractId: p.contractId ?? contractId, orderId: p.orderId,
      signalCandleEpoch: p.signalCandleEpoch, candleDirection: p.candleDirection,
      entryEpoch: p.entryEpoch, entryPrice: p.entryPrice, exitEpoch, exitPrice,
      stake: p.stake, multiplier: p.multiplier,
      slPips: p.slPips, trailPips: p.trailPips, trailActivation: p.trailActivation, pip: p.pip,
      initialSl: p.initialSl, finalStop: p.effectiveSl, trailActive: p.trailActive, extreme: p.extreme,
      exitReason: reason, grossPnl, tradingCosts: grossPnl - execPnl + commission, commission, netPnl,
      durationSecs: exitEpoch - p.entryEpoch, spreadAtEntry: p.spreadAtEntry,
      mfePoints: Math.max(0, (p.extreme - p.entryPrice) * dirSign(p.side)),
    };
    s.position = null; s.pending = null; s.retryCloseAfter = 0;
    s.dailyPnl += netPnl; s.totalPnl += netPnl; s.totalTrades++; s.tradesToday++;
    s.consecLosses = netPnl < 0 ? s.consecLosses + 1 : 0;
    s.closeCandleEpoch = bucketOf(exitEpoch);              // must wait for THIS candle to complete
    s.status = STATUS.WAITING_FOR_NEXT_CANDLE;
    this.log("info", `Closed ${p.side} (${reason}) @ ${exitPrice} | net $${netPnl.toFixed(4)}`, { tradeId: p.id });
    return trade;
  }

  onCloseRejected(reason, retryAfterSecs = 1) {
    const s = this.s;
    if (!s.position) return;
    s.execFailures++;
    this.log("error", `Close rejected: ${reason} — retrying`);
    s.retryCloseAfter = (s.lastTick?.epoch ?? 0) + retryAfterSecs;
    s.status = STATUS.POSITION_CLOSING;                    // stays pending; the stop is still breached
    if (!s.pending) s.pending = { type: "CLOSE", reason: "retry", since: s.lastTick?.epoch ?? 0 };
  }

  // ═════════════════════════════════════════════════════
  //  CONNECTION / RECONCILIATION
  // ═════════════════════════════════════════════════════
  /** Connection dropped: do not assume anything about an open or half-opened position. */
  onConnectionLost() {
    const s = this.s;
    s.needsReconcile = true;
    if (s.pending?.type === "OPEN" || !s.position) s.status = STATUS.ERROR_OR_RECOVERY;
    this.log("warn", "Connection lost — new orders blocked until the broker state is reconciled");
  }

  /**
   * brokerPosition: null if the broker holds no position for this strategy, else
   *   { contractId, side, entryPrice, entryEpoch, stake, multiplier }.
   * Returns "ok" | "adopted" | "vanished" so the caller can fetch close details when needed.
   */
  reconcile(brokerPosition) {
    const s = this.s;
    let result = "ok";
    if (s.position && !brokerPosition) {
      result = "vanished";                                  // caller reports it via onCloseConfirmed
    } else if (!s.position && brokerPosition) {
      this._adopt(brokerPosition); result = "adopted";
    } else if (s.position && brokerPosition) {
      if (s.position.contractId == null) s.position.contractId = brokerPosition.contractId;
      if (s.pending?.type === "OPEN") s.pending = null;
    } else if (s.pending?.type === "OPEN") {
      s.pending = null;                                     // the order never reached the broker
      s.status = STATUS.WAITING_FOR_NEXT_CANDLE;
    }
    if (result !== "vanished") {
      s.needsReconcile = false;
      if (s.status === STATUS.ERROR_OR_RECOVERY) s.status = s.position ? STATUS.POSITION_ACTIVE : STATUS.WAITING_FOR_NEXT_CANDLE;
    }
    this.log(result === "ok" ? "debug" : "info", `Reconciled with broker: ${result}`);
    return result;
  }

  _adopt(bp) {
    const s = this.s;
    const { slDist, trailDist, pip } = distancesFor(this.settings);
    const buy = bp.side === "BUY";
    const initialSl = buy ? bp.entryPrice - slDist : bp.entryPrice + slDist;
    s.position = {
      id: s.nextTradeId++, side: bp.side, symbol: this.settings.symbol, contractId: bp.contractId, orderId: null,
      entryPrice: bp.entryPrice, entryEpoch: bp.entryEpoch, entryCandleEpoch: bucketOf(bp.entryEpoch),
      signalCandleEpoch: null, candleDirection: null, refEntryMid: bp.entryPrice, spreadAtEntry: null,
      stake: bp.stake, multiplier: bp.multiplier, nativeStopUsd: null,
      slDist, trailDist, slPips: this.settings.slPips, trailPips: this.settings.trailPips,
      trailActivation: this.settings.trailActivation, pip,
      initialSl, trailSl: null, effectiveSl: initialSl, extreme: bp.entryPrice, trailActive: false, adopted: true,
    };
    s.pending = null;
    s.status = STATUS.POSITION_ACTIVE;
    this.log("warn", `Adopted existing broker position ${bp.contractId} (${bp.side} @ ${bp.entryPrice}) with fresh stops`);
  }

  // ═════════════════════════════════════════════════════
  //  EMERGENCY SWITCH + PERSISTENCE
  // ═════════════════════════════════════════════════════
  /** Stops all NEW entries. An open position keeps its stops unless closePosition is true. */
  disable(reason = "manual", { closePosition = false } = {}) {
    const s = this.s;
    s.disabledReason = reason;
    this.log("warn", `Trading disabled: ${reason}`);
    if (closePosition && s.position && !s.pending) {
      s.status = STATUS.POSITION_CLOSING;
      s.pending = { type: "CLOSE", reason: "emergency_disable", since: s.lastTick?.epoch ?? 0 };
      return [{ type: "CLOSE", reason: "emergency_disable", contractId: s.position.contractId, tradeId: s.position.id }];
    }
    return [];
  }
  enable() { this.s.disabledReason = null; this.s.execFailures = 0; this.s.consecLosses = 0; this._riskHaltLogged = false; }

  /** Why a signal arriving right now would NOT be traded (null if it would). For the dashboard. */
  currentBlock() { return this._riskBlock(this.s.lastTick || { bid: 0, ask: 0 }); }

  /** Called when the dashboard switches symbol (only allowed while flat): forget the old market's candles. */
  resetMarket() {
    const s = this.s;
    if (s.position || s.pending) throw new Error("cannot switch market while a position or order is open");
    s.candle = null; s.lastTick = null; s.lastProcessedCandleEpoch = 0; s.lastEntryCandleEpoch = 0;
    s.closeCandleEpoch = null; s.warmupDone = false; s.status = STATUS.INITIALIZING;
  }

  serialize() { return JSON.parse(JSON.stringify(this.s)); }
  restore(saved) {
    this.s = { ...this.s, ...saved };
    this.s.candle = null;                          // never resume a half-built candle
    this.s.warmupDone = false;
    this.s.lastTick = null;
    this.s.pending = null;
    if (this.s.position) this.s.status = STATUS.POSITION_ACTIVE;
    else if (this.s.status !== STATUS.ERROR_OR_RECOVERY) this.s.status = STATUS.INITIALIZING;
    this.s.needsReconcile = true;                  // always confirm with the broker before trading
  }
}
