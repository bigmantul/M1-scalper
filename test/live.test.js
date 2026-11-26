import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeDeriv } from "./fake-deriv.js";
import { Store } from "../src/live/store.js";
import { Bot, parseMultiplierRanges } from "../src/live/bot.js";
import { setLadder, symbolMeta } from "../config/symbols.js";
import { createApp } from "../src/server.js";
import { validateSettings } from "../src/core/settings.js";

const T0 = 1_700_000_040;
const K = (n) => T0 + 60 * n;
const until = async (fn, ms = 4000, what = "condition") => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 15)); }
  throw new Error(`timed out waiting for ${what}`);
};

async function setup({ settings = {}, savedState = null, contracts = [] } = {}) {
  const fake = await startFakeDeriv();
  process.env.DERIV_REST_BASE = fake.url();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scalper-"));
  const store = new Store(dir);
  store.saveSettings(validateSettings({ symbol: "R_100", pipSizes: { R_100: 1 }, sizing: { mode: "fixed", stake: 10 }, enabled: false, ...settings }));
  if (savedState) store.saveState(savedState);
  for (const c of contracts) fake.addContract(c);
  const bot = new Bot({ store, env: { DERIV_PAT_TOKEN: "pat_test", DERIV_APP_ID: "app", ...(settings._env || {}) } });
  bot.baseReconnectMs = 40; bot.reconnectDelay = 40;
  const teardown = async () => { await bot.shutdown(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { fake, bot, store, dir, teardown };
}

/** Pushes the ticks that form a bullish candle 0 and the first tick of candle 1 (→ BUY). */
async function bullishSignal(fake) {
  fake.pushTick(K(0), 100); fake.pushTick(K(0) + 30, 101); fake.pushTick(K(0) + 59, 101);
  fake.pushTick(K(1), 101);
}

test("full live cycle: BUY with server-side stop, trailing stop sells, trade recorded, re-entry waits", async () => {
  const { fake, bot, store, teardown } = await setup();
  try {
    bot.start();
    await until(() => bot.connected, 4000, "connected");
    await until(() => fake.tickSubs.size === 1, 2000, "tick subscription");
    assert.equal(fake.received.filter(m => m.ticks).length, 1, "scans ONLY the selected symbol");

    await bullishSignal(fake);
    await until(() => bot.engine.position, 4000, "position opened");
    const p = bot.engine.position;
    assert.equal(fake.buys.length, 1);
    assert.equal(fake.proposals[0].contract_type, "MULTUP");
    assert.equal(fake.proposals[0].underlying_symbol, "R_100");
    assert.equal(fake.proposals[0].multiplier, 5, "auto = smallest rung of the ladder");
    // stop = stake × multiplier × (20 / 101) = 9.90 → sent to Deriv as a server-side stop
    assert.equal(fake.proposals[0].limit_order.stop_loss, 9.9);
    assert.equal(p.entryPrice, 101);
    assert.equal(p.initialSl, 81);

    fake.pushTick(K(1) + 10, 130);                         // trailing stop → 115
    await until(() => bot.engine.position?.effectiveSl === 115, 2000, "stop at 115");
    fake.pushTick(K(1) + 20, 112);                         // breaches it
    await until(() => store.trades.length === 1, 4000, "trade recorded");

    const t = store.trades[0];
    assert.equal(t.exitReason, "trailing_stop");
    assert.equal(fake.sells.length, 1);
    assert.equal(t.exitPrice, 112);
    assert.equal(t.netPnl, +(10 * 5 * ((112 - 101) / 101)).toFixed(4), "uses Deriv's own profit figure");
    assert.equal(bot.engine.position, null);

    // the bot must now wait for candle 1 to finish; candle 1 = open 101 → close 120 (bullish)
    fake.pushTick(K(1) + 40, 120);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(fake.buys.length, 1, "no re-entry inside the closing candle");
    fake.pushTick(K(2), 120);
    await until(() => fake.buys.length === 2, 4000, "continuation entry");
    assert.equal(fake.proposals[1].contract_type, "MULTUP");
    await until(() => bot.engine.position, 3000);
    assert.equal(bot.engine.position.initialSl, 100, "fresh stop from the new entry (120 - 20)");
  } finally { await teardown(); }
});

test("Deriv closes the trade with its server-side stop: recorded as native_stop", async () => {
  const { fake, bot, store, teardown } = await setup();
  try {
    bot.start(); await until(() => bot.connected);
    await bullishSignal(fake);
    await until(() => bot.engine.position);
    const id = Number(bot.engine.position.contractId);
    fake.pushTick(K(1) + 10, 90);
    fake.serverStop(id, 81);
    await until(() => store.trades.length === 1, 3000, "native stop recorded");
    assert.equal(store.trades[0].exitReason, "native_stop");
    assert.equal(fake.sells.length, 0, "the bot did not try to sell a contract Deriv had already closed");
    assert.equal(bot.engine.position, null);
  } finally { await teardown(); }
});

test("multiplier rejected by Deriv: learns the allowed list and retries once", async () => {
  // pip 0.1 → a 2-point stop (≈2% of price), so the server-side stop fits inside the stake
  const { fake, bot, teardown } = await setup({ settings: { pipSizes: { R_100: 0.1 } } });
  try {
    bot.start(); await until(() => bot.connected);
    fake.failNextBuy = "multiplier";
    await bullishSignal(fake);
    await until(() => fake.buys.length === 1, 4000, "retry succeeded");
    assert.equal(fake.proposals.length, 2);
    assert.equal(fake.proposals[1].multiplier, 10, "smallest accepted value");
    assert.equal(fake.proposals[0].limit_order.stop_loss, 0.99, "first attempt: 10 × 5 × (2/101)");
    assert.equal(fake.proposals[1].limit_order.stop_loss, 1.98, "server-side stop recomputed for the new multiplier: 10 × 10 × (2/101)");
  } finally { await teardown(); }
});

test("stop larger than the stake cannot be sent to Deriv: trade still opens, protected by the bot's own stop", async () => {
  // pip 1.5 on a ~101 price: 20 pips = 30 points ≈ 30% of price → stop = 10 × 5 × 0.297 = $14.85 > $10 stake
  const { fake, bot, teardown } = await setup({ settings: { pipSizes: { R_100: 1.5 } } });
  try {
    bot.start(); await until(() => bot.connected);
    await bullishSignal(fake);
    await until(() => bot.engine.position);
    assert.equal(fake.proposals[0].limit_order, undefined);
    assert.equal(bot.engine.position.nativeStopUsd, null);
  } finally { await teardown(); }
});

test("rejected order (stake cap) is not retried and does not break the connection", async () => {
  const { fake, bot, teardown } = await setup();
  try {
    bot.start(); await until(() => bot.connected);
    fake.failNextBuy = "stake";
    await bullishSignal(fake);
    await until(() => bot.engine.s.execFailures === 1, 3000, "failure counted");
    assert.equal(fake.buys.length, 0);
    assert.equal(bot.engine.s.pending, null);
    assert.ok(bot.connected);
  } finally { await teardown(); }
});

test("connection dropped while the order is in flight: outcome treated as unknown, reconciled, no duplicate order", async () => {
  const { fake, bot, teardown } = await setup();
  try {
    bot.start(); await until(() => bot.connected);
    fake.dropOnBuy = true;
    await bullishSignal(fake);
    await until(() => fake.received.filter(m => m.proposal).length === 1);
    await until(() => !bot.connected, 3000, "disconnect noticed");
    await until(() => bot.connected, 4000, "reconnected");
    await until(() => !bot.engine.s.needsReconcile, 3000, "reconciled");
    assert.equal(fake.buys.length, 0, "the buy never reached Deriv");
    assert.equal(bot.engine.position, null);
    assert.notEqual(bot.engine.status, "OPENING_POSITION");
  } finally { await teardown(); }
});

test("restart with a trade open at the broker: adopted, managed with fresh stops, no second position", async () => {
  const { fake, bot, store, teardown } = await setup({ settings: { enabled: true }, contracts: [{ entry: 100, type: "MULTUP" }] });
  try {
    fake.quote = { bid: 100, ask: 100 };
    bot.autoStart();
    await until(() => bot.engine.position, 4000, "adopted");
    assert.equal(bot.engine.position.entryPrice, 100);
    assert.equal(bot.engine.position.initialSl, 80);
    fake.pushTick(K(0), 100); fake.pushTick(K(0) + 59, 101); fake.pushTick(K(1), 101);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(fake.buys.length, 0, "one position at a time — never opens a second");
    fake.pushTick(K(1) + 5, 79);
    await until(() => store.trades.length === 1, 4000, "adopted position stopped out by the bot");
    assert.equal(store.trades[0].exitReason, "initial_stop");
  } finally { await teardown(); }
});

test("saved position that no longer exists at the broker is closed out in the books, not trusted", async () => {
  const { fake, bot, store, teardown } = await setup({ settings: { enabled: true } });
  try {
    // craft a saved state holding a position whose contract the broker has already settled
    const c = fake.addContract({ entry: 100 }); c.sold = true; c.exit = 95; c.sellTime = K(0); c.profit = -2.5;
    const eng = bot.engine;
    eng.restore({ ...eng.serialize(), position: {
      id: 7, side: "BUY", symbol: "R_100", contractId: String(c.id), entryPrice: 100, entryEpoch: K(0) - 60, entryCandleEpoch: K(0) - 60,
      stake: 10, multiplier: 5, slDist: 20, trailDist: 15, slPips: 20, trailPips: 15, trailActivation: "breakeven", pip: 1,
      initialSl: 80, trailSl: null, effectiveSl: 80, extreme: 100, trailActive: false, refEntryMid: 100,
    } });
    bot.autoStart();
    await until(() => store.trades.length === 1, 4000, "reconciled close recorded");
    assert.equal(store.trades[0].exitReason, "broker_closed");
    assert.equal(store.trades[0].netPnl, -2.5);
    assert.equal(bot.engine.position, null);
  } finally { await teardown(); }
});

test("emergency switch closes the open trade and blocks new entries", async () => {
  const { fake, bot, store, teardown } = await setup();
  try {
    bot.start(); await until(() => bot.connected);
    await bullishSignal(fake);
    await until(() => bot.engine.position);
    fake.pushTick(K(1) + 5, 103);
    bot.emergency();
    await until(() => store.trades.length === 1, 4000, "closed");
    assert.equal(store.trades[0].exitReason, "emergency_disable");
    assert.equal(bot.engine.s.disabledReason, "emergency switch");
    fake.pushTick(K(1) + 40, 120); fake.pushTick(K(2), 120);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(fake.buys.length, 1);
  } finally { await teardown(); }
});

test("demo mode never trades a real account; real mode is locked without ALLOW_REAL", async () => {
  const { fake, bot, teardown } = await setup();
  try {
    bot.start(); await until(() => bot.connected);
    assert.equal(fake.mode, "demo");
    assert.throws(() => bot.updateSettings({ mode: "real" }), /ALLOW_REAL/);
  } finally { await teardown(); }
});

test("symbol can be switched only while flat; stream re-subscribes to the new symbol only", async () => {
  const { fake, bot, teardown } = await setup();
  try {
    bot.start(); await until(() => bot.connected);
    await bullishSignal(fake);
    await until(() => bot.engine.position);
    assert.throws(() => bot.updateSettings({ symbol: "R_50" }), /Close the open position/);
    fake.pushTick(K(1) + 5, 70);                          // stop it out
    await until(() => !bot.engine.position, 4000);
    bot.updateSettings({ symbol: "R_50" });
    await until(() => fake.received.filter(m => m.ticks === "R_50").length === 1, 2000, "new subscription");
    assert.ok(fake.received.some(m => m.forget_all === "ticks"));
    assert.ok(["INITIALIZING", "WAITING_FOR_CANDLE_CLOSE"].includes(bot.engine.status), "old market's candles were discarded");
    assert.equal(bot.engine.s.closeCandleEpoch, null);
    assert.equal(bot.engine.s.lastProcessedCandleEpoch, 0);
  } finally { await teardown(); }
});

// ── dashboard API ────────────────────────────────────
test("dashboard API: auth, settings validation, live risk preview", async () => {
  const { bot, teardown } = await setup();
  const app = createApp({ bot, password: "correct-horse" });
  const srv = await new Promise(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (p, o = {}, tok) => { const r = await fetch(base + p, { ...o, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  try {
    assert.equal((await call("/api/state")).status, 401);
    assert.equal((await call("/api/login", { method: "POST", body: JSON.stringify({ password: "nope" }) })).status, 401);
    const { body: { token } } = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "correct-horse" }) });
    assert.ok(token);

    const st = await call("/api/state", {}, token);
    assert.equal(st.status, 200);
    assert.equal(st.body.symbols.length, 48, "dashboard lists every symbol");

    const ok = await call("/api/settings", { method: "POST", body: JSON.stringify({ settings: { symbol: "R_75", slPips: 25, trailPips: 12, pipSizes: { R_75: 0.5 } } }) }, token);
    assert.equal(ok.status, 200);
    assert.equal(bot.settings.symbol, "R_75"); assert.equal(bot.settings.slPips, 25); assert.equal(bot.settings.pipSizes.R_75, 0.5);

    const bad = await call("/api/settings", { method: "POST", body: JSON.stringify({ settings: { slPips: -5 } }) }, token);
    assert.equal(bad.status, 400);
    const real = await call("/api/settings", { method: "POST", body: JSON.stringify({ settings: { mode: "real" } }) }, token);
    assert.equal(real.status, 403);

    const pv = await call("/api/risk-preview", { method: "POST", body: JSON.stringify({ settings: { symbol: "R_100", slPips: 20, pipSizes: { R_100: 0.1 } }, price: 432.87 }) }, token);
    assert.equal(pv.status, 200);
    assert.equal(pv.body.pipSize, 0.1);
    assert.ok(Math.abs(pv.body.slPoints - 2) < 1e-9);
  } finally { srv.close(); await teardown(); }
});

test("health and ping endpoints answer without a login and leak nothing sensitive", async () => {
  const { bot, teardown } = await setup();
  const app = createApp({ bot, password: "correct-horse" });
  const srv = await new Promise(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    for (const p of ["/health", "/healthz"]) {
      const r = await fetch(base + p); const j = await r.json();
      assert.equal(r.status, 200); assert.equal(j.ok, true);
      assert.deepEqual(Object.keys(j).sort(), ["botRunning", "derivConnected", "ok", "uptimeSecs"]);
    }
    assert.equal(await (await fetch(base + "/ping")).text(), "pong");
    assert.equal((await fetch(base + "/api/state")).status, 401, "everything else still needs the password");
  } finally { srv.close(); await teardown(); }
});

test("rejected order: the exact request sent to Deriv is logged", async () => {
  const { fake, bot, teardown } = await setup();
  try {
    bot.start(); await until(() => bot.connected);
    fake.failNextBuy = "stake";
    await bullishSignal(fake);
    await until(() => bot.engine.s.execFailures === 1);
    const ev = bot.store.events.find(e => /Deriv rejected the order/.test(e.message));
    assert.ok(ev, "rejection logged");
    assert.match(ev.message, /request:/);
    assert.match(ev.message, /"amount":10/);
  } finally { await teardown(); }
});

test("a multiplier typed by the user that Deriv does not offer is rejected, not silently changed", async () => {
  const { fake, bot, teardown } = await setup({ settings: { multiplier: 7, pipSizes: { R_100: 0.1 } } });
  try {
    bot.start(); await until(() => bot.connected);
    fake.failNextBuy = "multiplier";
    await bullishSignal(fake);
    await until(() => bot.engine.s.execFailures === 1);
    assert.equal(fake.proposals.length, 1, "no retry");
    assert.equal(fake.buys.length, 0);
    assert.ok(bot.store.events.some(e => /allowed: 10, 20, 30/.test(e.message)));
  } finally { setLadder("R_100", symbolMeta("R_100").ladder); await teardown(); }
});

test("multiplier list is fetched from Deriv at connect time", async () => {
  const before = [...symbolMeta("R_100").ladder];
  const { fake, bot, teardown } = await setup({ settings: { pipSizes: { R_100: 0.1 } } });
  try {
    fake.ladder = [40, 80];
    bot.start(); await until(() => bot.connected);
    assert.deepEqual(symbolMeta("R_100").ladder, [40, 80]);
    await bullishSignal(fake);
    await until(() => fake.proposals.length >= 1);
    assert.equal(fake.proposals[0].multiplier, 40, "auto picks the smallest live rung");
  } finally { setLadder("R_100", before); await teardown(); }
});

test("parseMultiplierRanges reads multiplier contracts only", () => {
  assert.deepEqual(parseMultiplierRanges({ contracts_for: { available: [{ contract_category: "multiplier", multiplier_range: [20, 10] }, { contract_category: "callput", multiplier_range: [99] }] } }), [10, 20]);
  assert.deepEqual(parseMultiplierRanges({}), []);
});

test("stop far smaller than normal tick noise: entry skipped, nothing sent, not counted as a failure", async () => {
  const { fake, bot, teardown } = await setup({ settings: { pipSizes: { R_100: 0.01 } } });
  try {
    bot.start(); await until(() => bot.connected);
    for (let i = 0; i < 40; i++) fake.pushTick(K(0) + i, i % 2 ? 105 : 100);
    fake.pushTick(K(0) + 59, 101); fake.pushTick(K(1), 101);
    await until(() => bot.engine.s.blocked.stopTooTight === 1, 4000, "entry skipped");
    assert.equal(fake.proposals.length, 0);
    assert.equal(bot.engine.s.execFailures, 0);
  } finally { await teardown(); }
});
