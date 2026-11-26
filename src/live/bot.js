// ═══════════════════════════════════════════════════════
//  src/live/bot.js — live runner around the pure engine
//
//  Responsibilities the engine deliberately does not have:
//    • connection, reconnection, heartbeat
//    • placing / closing Deriv multiplier contracts and WAITING for confirmation
//    • reconciling the engine's idea of the position with the broker's
//    • persistence and the event log
//
//  Stop model on Deriv multipliers (important):
//    • The INITIAL stop is also sent to Deriv as a server-side stop_loss, so
//      the trade is protected even if this process dies.
//    • Deriv cannot move a multiplier's stop_loss into profit, so the TRAILING
//      stop is enforced by this bot: when the bid/ask crosses the effective stop
//      it sells at market. If the bot is offline while a trade is in profit, only
//      the original server-side stop is still in force.
// ═══════════════════════════════════════════════════════
import { EventEmitter } from "node:events";
import { DerivClient, getWebSocketUrl } from "./deriv.js";
import { ScalperEngine, STATUS } from "../core/engine.js";
import { validateSettings, deepMerge, pipSizeFor } from "../core/settings.js";
import { nativeStopUsd, pnlFor } from "../core/sizing.js";
import { symbolMeta, SYMBOL_META, setLadder } from "../../config/symbols.js";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TYPE_TO_SIDE = { MULTUP: "BUY", MULTDOWN: "SELL" };
const isTransient = (e) => /timeout|closed|not open|ECONN|socket/i.test(e?.message || "");

function parseAllowedMultipliers(text) {
  const m = String(text).match(/(?:Accepts|Allowed)[:\s\[]*[\d,\s\[\]\.]+/i);
  return m ? [...m[0].matchAll(/\d+/g)].map(x => parseInt(x[0], 10)).sort((a, b) => a - b) : [];
}

/** Reads the multiplier values Deriv offers from a contracts_for reply. */
export function parseMultiplierRanges(resp) {
  const list = resp?.contracts_for?.available || [];
  const out = new Set();
  for (const c of list) {
    if (!(c.contract_category === "multiplier" || /^MULT(UP|DOWN)$/.test(c.contract_type || ""))) continue;
    for (const v of c.multiplier_range || []) { const n = Number(v); if (Number.isFinite(n) && n > 0) out.add(n); }
  }
  return [...out].sort((a, b) => a - b);
}

export class Bot extends EventEmitter {
  constructor({ store, env = process.env }) {
    super();
    this.store = store; this.env = env;
    this.settings = store.loadSettings();
    this.engine = new ScalperEngine(this.settings, { logger: (l, m, d) => this.log(l, m, d) });
    const saved = store.loadState();
    if (saved) { this.engine.restore(saved); this.log("info", `Restored saved state (${saved.position ? "open position found" : "flat"}); will reconcile with the broker before trading`); }

    this.client = null; this.connected = false; this.running = false;
    this.accountId = null; this.balance = null; this.currency = "USD";
    this.lastTick = null; this.livePnl = null;
    this.tickMoves = []; this._prevMid = null;     // recent absolute tick-to-tick moves (for the stop sanity check)
    this.mult = new Map();                        // symbol -> multiplier learned from Deriv's errors
    this.waiters = new Map();                     // contractId -> [fn(contract)]
    this.closing = new Set();                     // contractIds being closed by us right now
    this.execChain = Promise.resolve();
    this.baseReconnectMs = 2000;                  // tests shorten this
    this.reconnectDelay = this.baseReconnectMs;
    this._lastSave = 0;
  }

  // ── logging ───────────────────────────────────────────
  log(level, message, data) {
    const ev = { t: Date.now(), level, message, ...(data ? { data } : {}) };
    if (level !== "debug") this.store.appendEvent(ev);
    if (level !== "debug") console.log(`[${new Date(ev.t).toISOString()}] ${level.toUpperCase().padEnd(5)} ${message}`);
    this.emit("event", ev);
  }

  // ── lifecycle ─────────────────────────────────────────
  /** Called at boot: resume automatically if trading was enabled or a position may be open. */
  autoStart() {
    if (this.settings.enabled || this.engine.s.position) this.start({ fromBoot: true });
  }

  start({ fromBoot = false } = {}) {
    if (!fromBoot) {
      this.settings = { ...this.settings, enabled: true };
      this.store.saveSettings(this.settings);
      this.engine.updateSettings(this.settings);
      this.engine.enable();
    }
    if (this.running) return;
    this.running = true;
    this._loop().catch(e => this.log("error", `Connection loop crashed: ${e.message}`));
  }

  /** Stops NEW entries. An open trade keeps its stops unless closePosition is set. */
  stop({ closePosition = false } = {}) {
    this.settings = { ...this.settings, enabled: false };
    this.store.saveSettings(this.settings);
    this.engine.updateSettings(this.settings);
    this.log("warn", `Trading stopped by user${closePosition ? " (closing position)" : ""}`);
    if (closePosition) {
      const cmds = this.engine.disable("stopped by user", { closePosition: true });
      if (cmds.length) this._execute(cmds, this.lastTick);
    }
  }

  /** Emergency switch: no new entries, close any open trade now. */
  emergency() {
    this.settings = { ...this.settings, enabled: false };
    this.store.saveSettings(this.settings);
    this.engine.updateSettings(this.settings);
    this.log("error", "EMERGENCY DISABLE");
    const cmds = this.engine.disable("emergency switch", { closePosition: true });
    if (cmds.length) this._execute(cmds, this.lastTick);
    this._persist(true);
  }

  resume() { this.engine.enable(); this.log("info", "Halts cleared (execution-failure / emergency flags reset)"); this._persist(true); }

  async shutdown() {
    this.running = false;
    this._persist(true);
    this.client?.close();
  }

  // ── connection loop ───────────────────────────────────
  async _loop() {
    while (this.running) {
      try {
        const closed = await this._connectOnce();
        this.reconnectDelay = this.baseReconnectMs;
        await closed;
      } catch (e) {
        this.log("error", `Connection failed: ${e.message}`);
      }
      this.connected = false;
      if (!this.running) break;
      this.engine.onConnectionLost();
      this.log("warn", `Reconnecting in ${this.reconnectDelay / 1000}s…`);
      await sleep(this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    }
  }

  async _connectOnce() {
    const e = this.env, s = this.settings;
    if (s.mode === "real" && e.ALLOW_REAL !== "true") throw new Error('mode is "real" but ALLOW_REAL=true is not set in the environment');
    this.log("info", `Connecting to Deriv (${s.mode})…`);
    const { url, accountId } = await getWebSocketUrl({ token: e.DERIV_PAT_TOKEN, appId: e.DERIV_APP_ID, mode: s.mode });
    this.accountId = accountId;

    const client = new DerivClient();
    this.client = client;
    const closed = new Promise(res => client.once("close", () => { this.log("warn", "Deriv connection closed"); res(); }));
    client.on("log", (l, m) => this.log(l, m));
    client.on("tick", (t) => this._onTick(t));
    client.on("contract", (c) => this._onContract(c));
    client.on("balance", (b) => this._onBalance(b));
    await client.connect(url);
    this.log("info", `Connected (account ${accountId})`);

    const bal = await client.send({ balance: 1, subscribe: 1 }, { stream: true });
    this._onBalance(bal.balance);
    this.engine.s.needsReconcile = true;          // no entries until the broker's positions have been checked
    await this._subscribeTicks(s.symbol);
    await this._loadLadder(s.symbol);
    const startRes = await this._reconcile("startup");
    this.log("info", `Broker state checked: ${startRes}`);
    this.connected = true;
    this._startPeriodic(client);
    return closed;
  }

  _startPeriodic(client) {
    const timer = setInterval(() => {
      if (this.client !== client || !client.open) return clearInterval(timer);
      if (this.engine.s.pending) return;
      this._reconcile("periodic").catch(e => this.log("warn", `Periodic reconcile failed: ${e.message}`));
    }, 30000);
    client.once("close", () => clearInterval(timer));
  }

  /** Asks Deriv which multipliers this symbol really offers (built-in lists can be out of date). */
  async _loadLadder(symbol) {
    try {
      const r = await this.client.send({ contracts_for: symbol, currency: this.currency });
      const ladder = parseMultiplierRanges(r);
      if (ladder.length) { setLadder(symbol, ladder); this.log("info", `Deriv offers multipliers ${ladder.join("/")} on ${symbol}`); }
      else this.log("warn", `Deriv did not list multipliers for ${symbol}; using the built-in list`);
    } catch (e) { this.log("warn", `Could not fetch multipliers for ${symbol}: ${e.message}`); }
  }

  /** Mean absolute tick-to-tick move over the last ≤300 ticks (null until 30 ticks seen). */
  typicalTick() {
    const m = this.tickMoves;
    if (m.length < 30) return null;
    return m.reduce((a, b) => a + b, 0) / m.length;
  }

  async _subscribeTicks(symbol) {
    await this.client.send({ ticks: symbol, subscribe: 1 }, { stream: true });
    this.log("info", `Scanning ${symbol} only`);
  }

  // ── streams ───────────────────────────────────────────
  _onBalance(b) {
    if (!b) return;
    const v = Number(b.balance);
    if (Number.isFinite(v)) { this.balance = v; this.engine.setBalance(v); }
    if (b.currency) this.currency = b.currency;
  }

  _onTick(t) {
    if (!t || t.symbol !== this.settings.symbol) return;
    const quote = Number(t.quote);
    const tick = { epoch: Number(t.epoch), bid: Number(t.bid ?? t.quote), ask: Number(t.ask ?? t.quote) };
    if (![tick.epoch, tick.bid, tick.ask].every(Number.isFinite)) return;
    this.lastTick = { ...tick, quote };
    const mid = (tick.bid + tick.ask) / 2;
    if (this._prevMid != null && mid !== this._prevMid) { this.tickMoves.push(Math.abs(mid - this._prevMid)); if (this.tickMoves.length > 300) this.tickMoves.shift(); }
    this._prevMid = mid;
    const cmds = this.engine.onTick(tick);
    if (cmds.length) this._execute(cmds, tick);
    this._persist(false);
  }

  _onContract(c) {
    const id = String(c.contract_id);
    const pos = this.engine.position;
    if (pos && String(pos.contractId) === id) this.livePnl = Number(c.profit);
    for (const fn of this.waiters.get(id) || []) fn(c);
    const sold = c.is_sold === 1 || c.is_sold === true || ["sold", "closed"].includes(String(c.status).toLowerCase());
    if (sold && pos && String(pos.contractId) === id && !this.closing.has(id)) {
      // closed by Deriv (the server-side stop, or a stop-out) — we did not ask for it
      this._confirmClose(c, "native_stop");
    }
  }

  _waitForContract(id, predicate, ms) {
    return new Promise((resolve) => {
      const key = String(id), list = this.waiters.get(key) || [];
      const done = (c) => { clearTimeout(timer); this.waiters.set(key, (this.waiters.get(key) || []).filter(f => f !== fn)); resolve(c); };
      const fn = (c) => { if (predicate(c)) done(c); };
      const timer = setTimeout(() => done(null), ms);
      list.push(fn); this.waiters.set(key, list);
    });
  }

  // ── command execution (strictly one at a time) ────────
  _execute(cmds, tick) {
    for (const cmd of cmds) {
      this.execChain = this.execChain.then(() => (cmd.type === "OPEN" ? this._open(cmd, tick) : this._close(cmd, tick)))
        .catch(e => this.log("error", `Execution error: ${e.message}`));
    }
  }

  async _buy(cmd, multiplier) {
    const snap = this.engine.s.pending?.snapshot;
    const nativeStop = nativeStopUsd(this.settings, { stake: cmd.stake, multiplier, slDist: snap.slDist, entryPrice: cmd.refPrice });
    const payload = {
      proposal: 1, contract_type: cmd.side === "BUY" ? "MULTUP" : "MULTDOWN", underlying_symbol: cmd.symbol,
      amount: cmd.stake, basis: "stake", currency: this.currency, multiplier,
      ...(nativeStop ? { limit_order: { stop_loss: nativeStop } } : {}),
    };
    if (!nativeStop) {
      const usd = cmd.stake * multiplier * (snap.slDist / cmd.refPrice);
      const why = usd >= cmd.stake ? `the stop would lose $${usd.toFixed(2)}, which is not less than the $${cmd.stake} stake`
        : `the stop is only $${usd.toFixed(4)}, below Deriv's $${this.settings.risk.minNativeStopUsd} minimum`;
      this.log("warn", `No server-side stop placed: ${why}. Only the bot's own stop protects this trade`);
    }
    let prop;
    try { prop = await this.client.send(payload); }
    catch (e) { e.request = payload; throw e; }
    const buyReq = { buy: prop.proposal.id, price: Number(prop.proposal.ask_price) };
    let buy;
    try { buy = await this.client.send(buyReq); }
    catch (e) { e.request = { proposal: payload, buy: buyReq }; throw e; }
    return { buy: buy.buy, nativeStop, multiplier };
  }

  async _open(cmd) {
    if (!this.engine.s.pending || this.engine.s.pending.type !== "OPEN") return;
    const auto = this.settings.multiplier === "auto";
    let multiplier = auto ? (this.mult.get(cmd.symbol) ?? cmd.multiplier) : cmd.multiplier;

    // stop sanity: a stop smaller than normal tick noise is hit by random jitter, not by a real move
    const r = this.settings.risk, snap = this.engine.s.pending?.snapshot, tt = this.typicalTick();
    if (r.stopSanityEnabled && tt && snap) {
      const ticks = snap.slDist / tt;
      if (ticks < r.minStopTicks) {
        this.engine.onOpenSkipped(`the ${snap.slDist} stop is only ${ticks.toFixed(2)}x a typical tick move (${tt.toPrecision(3)}); raise the pip size or stop pips`, "stopTooTight");
        return;
      }
      if (ticks < 3) this.log("warn", `Stop is only ${ticks.toFixed(1)}x a typical tick move (${tt.toPrecision(3)}) — likely to be hit by noise`);
    }

    let res;
    try {
      try { res = await this._buy(cmd, multiplier); }
      catch (e) {
        const allowed = /multiplier|Accepts|Allowed|acceptable range/i.test(e.message) ? parseAllowedMultipliers(e.message) : [];
        if (allowed.length) setLadder(cmd.symbol, allowed);            // learn the real list
        if (!allowed.length || isTransient(e)) throw e;
        if (!auto) throw Object.assign(new Error(`x${multiplier} is not offered on ${cmd.symbol} (allowed: ${allowed.join(", ")}). Pick one of those or set the multiplier to auto`), { request: e.request, reply: e.message });
        multiplier = allowed[0]; this.mult.set(cmd.symbol, multiplier);
        this.log("info", `Deriv only accepts ${allowed.join("/")} for ${cmd.symbol} — retrying once with x${multiplier}`);
        res = await this._buy(cmd, multiplier);
      }
    } catch (e) {
      if (isTransient(e)) {
        // we cannot know whether the order went through — never assume, never resend blindly
        this.log("error", `Order outcome unknown (${e.message}) — reconciling before any new order`);
        this.engine.onConnectionLost();
        await this._reconcile("order-uncertain").catch(() => {});
      } else {
        let req = ""; try { req = e.request ? ` | request: ${JSON.stringify(e.request)}` : ""; } catch {}
        this.log("error", `Deriv rejected the order: ${e.message}${req}`);
        this.engine.onOpenRejected(e.message);
      }
      return;
    }

    const contractId = res.buy.contract_id;
    // subscribe for the entry spot + live P/L, and learn the actual fill price
    let first = null;
    try {
      const sub = await this.client.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }, { stream: true });
      first = sub.proposal_open_contract;
      if (!(first?.entry_spot || first?.entry_tick)) first = (await this._waitForContract(contractId, c => c.entry_spot || c.entry_tick, 4000)) || first;
    } catch (e) { this.log("warn", `Could not subscribe to contract ${contractId}: ${e.message}`); }

    const entryPrice = Number(first?.entry_spot ?? first?.entry_tick ?? cmd.refPrice);
    const entryEpoch = Number(first?.entry_tick_time ?? first?.date_start ?? res.buy.start_time ?? Date.now() / 1000);
    this.engine.onOpenConfirmed({ contractId: String(contractId), entryPrice, entryEpoch, stake: cmd.stake, multiplier: res.multiplier, nativeStopUsd: res.nativeStop, orderId: res.buy.transaction_id ?? null });
    this._persist(true);
  }

  async _close(cmd) {
    const pos = this.engine.position;
    if (!pos?.contractId) { this.log("warn", "CLOSE requested but no contract id is known — reconciling"); await this._reconcile("close-no-id").catch(() => {}); return; }
    const id = String(pos.contractId);
    this.closing.add(id);
    try {
      let sold = null;
      // register the waiter BEFORE sending, so the contract update can never slip past us
      const soldWait = this._waitForContract(id, c => c.is_sold === 1 || c.is_sold === true || String(c.status).toLowerCase() === "sold", 5000);
      try {
        await this.client.send({ sell: Number(id), price: 0 });
        sold = await soldWait;
      } catch (e) {
        if (/sold|closed|expired|already/i.test(e.message)) this.log("info", `Contract ${id} was already closed at Deriv`);
        else if (isTransient(e)) { this.engine.onConnectionLost(); this.log("error", `Close outcome unknown (${e.message}) — reconciling`); return; }
        else { this.engine.onCloseRejected(e.message); return; }
      }
      if (!sold) sold = (await this.client.send({ proposal_open_contract: 1, contract_id: Number(id) }).catch(() => null))?.proposal_open_contract;
      if (sold && (sold.is_sold === 1 || sold.is_sold === true || String(sold.status).toLowerCase() === "sold")) {
        this._confirmClose(sold, cmd.reason === "retry" ? "stop" : cmd.reason);
      } else {
        this.engine.onCloseRejected("could not confirm the sale"); // stays managed; will retry
      }
    } finally {
      this.closing.delete(id);
    }
  }

  _confirmClose(c, reason) {
    const pos = this.engine.position;
    if (!pos) return;
    const lt = this.lastTick;
    const fallback = lt ? (pos.side === "BUY" ? lt.bid : lt.ask) : pos.entryPrice;
    const exitPrice = Number(c.sell_spot ?? c.exit_tick ?? fallback);
    const exitEpoch = Number(c.sell_time ?? c.exit_tick_time ?? lt?.epoch ?? Date.now() / 1000);
    const profit = Number(c.profit);
    const trade = this.engine.onCloseConfirmed({
      exitPrice, exitEpoch, reason, exitMid: lt ? (lt.bid + lt.ask) / 2 : null,
      pnlOverride: Number.isFinite(profit) ? profit : null,      // Deriv's own cash P/L is authoritative
    });
    if (trade) this._recordTrade(trade);
    this.livePnl = null;
    this._persist(true);
  }

  _recordTrade(t) {
    this.store.appendTrade(t);
    this.emit("trade", t);
    this.log("trade", `${t.side} ${t.exitReason} | ${t.entryPrice} → ${t.exitPrice} | net $${t.netPnl.toFixed(4)}`, { id: t.id });
  }

  // ── broker reconciliation ─────────────────────────────
  async _detail(contractId) {
    const r = await this.client.send({ proposal_open_contract: 1, contract_id: Number(contractId) });
    return r.proposal_open_contract;
  }

  async _brokerPosition() {
    const resp = await this.client.send({ portfolio: 1 });
    const list = (resp.portfolio?.contracts || []).filter(c =>
      TYPE_TO_SIDE[c.contract_type] && (c.symbol ?? c.underlying_symbol ?? c.underlying) === this.settings.symbol);
    if (list.length > 1) this.log("error", `Broker has ${list.length} open multipliers on ${this.settings.symbol}; managing only the first. Close the others manually.`);
    if (!list.length) return null;
    const c = list[0], d = await this._detail(c.contract_id);
    return {
      contractId: String(c.contract_id), side: TYPE_TO_SIDE[c.contract_type],
      entryPrice: Number(d?.entry_spot ?? d?.entry_tick ?? c.buy_price),
      entryEpoch: Number(d?.date_start ?? c.date_start ?? Date.now() / 1000),
      stake: Number(d?.buy_price ?? c.buy_price), multiplier: Number(d?.multiplier ?? this.mult.get(this.settings.symbol) ?? symbolMeta(this.settings.symbol).ladder[0]),
    };
  }

  async _reconcile(why) {
    const bp = await this._brokerPosition();
    const res = this.engine.reconcile(bp);
    if (res === "adopted") {
      await this.client.send({ proposal_open_contract: 1, contract_id: Number(bp.contractId), subscribe: 1 }, { stream: true }).catch(() => {});
    } else if (res === "vanished") {
      const pos = this.engine.position;
      const cid = String(pos.contractId);
      this.closing.add(cid);                       // the detail reply must not be mistaken for a native stop
      let d = null; try { d = pos.contractId ? await this._detail(pos.contractId) : null; } catch {} finally { this.closing.delete(cid); }
      const isSold = d && (d.is_sold === 1 || d.is_sold === true || String(d.status).toLowerCase() === "sold");
      if (d && !isSold) {
        // the portfolio list and the contract detail disagree: believe the detail, keep managing the trade
        this.log("warn", `Portfolio did not list ${pos.contractId} but the contract is still open — keeping it`);
        this.engine.reconcile({ contractId: String(pos.contractId), side: pos.side, entryPrice: pos.entryPrice, entryEpoch: pos.entryEpoch, stake: pos.stake, multiplier: pos.multiplier });
        return "ok";
      }
      this.log("warn", `Position ${pos.contractId} is no longer open at the broker — recording how it closed`);
      this._confirmClose(d || {}, "broker_closed");
      this.engine.reconcile(null);
    }
    this._persist(true);
    return res;
  }

  // ── settings ──────────────────────────────────────────
  updateSettings(patch) {
    const next = validateSettings(deepMerge(this.settings, patch));
    if (next.mode === "real" && this.env.ALLOW_REAL !== "true") throw Object.assign(new Error('Real-money mode is locked: set ALLOW_REAL=true in the server environment first'), { status: 403 });
    const busy = this.engine.position || this.engine.s.pending;
    const symbolChanged = next.symbol !== this.settings.symbol, modeChanged = next.mode !== this.settings.mode;
    if ((symbolChanged || modeChanged) && busy) throw Object.assign(new Error("Close the open position before changing the symbol or account mode (one symbol, one position at a time)"), { status: 409 });

    this.settings = next;
    this.store.saveSettings(next);
    this.engine.updateSettings(next);            // pip / stop / trail changes apply to the NEXT position
    if (symbolChanged) {
      this.engine.resetMarket(); this.lastTick = null; this.tickMoves = []; this._prevMid = null;
      this.log("info", `Symbol changed to ${next.symbol}`);
      if (this.client?.open) this.client.send({ forget_all: "ticks" }).then(() => this._subscribeTicks(next.symbol)).then(() => this._loadLadder(next.symbol)).catch(e => this.log("error", `Could not switch tick stream: ${e.message}`));
    }
    if (modeChanged && this.client) { this.log("info", `Account mode changed to ${next.mode} — reconnecting`); this.client.close(); }
    if (next.enabled && !this.running) this.start({ fromBoot: true });
    return next;
  }

  // ── dashboard snapshot ────────────────────────────────
  snapshot() {
    const s = this.engine.s, p = s.position, lt = this.lastTick;
    let floating = null, position = null;
    if (p) {
      const exit = lt ? (p.side === "BUY" ? lt.bid : lt.ask) : null;
      floating = this.livePnl ?? (exit != null ? pnlFor({ side: p.side, entry: p.entryPrice, exit, stake: p.stake, multiplier: p.multiplier }) : null);
      position = { ...p, floatingPnl: floating, currentPrice: exit };
    }
    const trades = this.store.trades;
    let eq = 0, peak = 0, dd = 0;
    for (const t of trades) { eq += t.netPnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
    const curDD = peak - eq;
    return {
      now: Date.now(), running: this.running, connected: this.connected, accountId: this.accountId,
      mode: this.settings.mode, balance: this.balance, currency: this.currency,
      status: s.status, symbol: this.settings.symbol, lastTick: lt,
      position, pendingOrder: s.pending ? s.pending.type : null, typicalTick: this.typicalTick(),
      stats: {
        completedTrades: s.totalTrades, realizedPnl: s.totalPnl, dailyPnl: s.dailyPnl, tradesToday: s.tradesToday,
        consecLosses: s.consecLosses, currentDrawdown: curDD, maxDrawdown: dd, execFailures: s.execFailures,
      },
      halted: s.disabledReason, blockedReason: this.settings.enabled && !s.disabledReason ? this.engine.currentBlock() : null,
      blockedCounts: s.blocked, needsReconcile: s.needsReconcile, enabled: this.settings.enabled,
      realAllowed: this.env.ALLOW_REAL === "true",
      pipSize: pipSizeFor(this.settings),
    };
  }

  // ── persistence ───────────────────────────────────────
  _persist(force) {
    const now = Date.now();
    if (!force && now - this._lastSave < 3000) return;
    this._lastSave = now;
    try { this.store.saveState(this.engine.serialize()); } catch (e) { this.log("warn", `Could not save state: ${e.message}`); }
  }
}

export { SYMBOL_META, STATUS };
