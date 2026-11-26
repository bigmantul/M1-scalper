// ═══════════════════════════════════════════════════════
//  src/server.js — dashboard API + static UI + bot process
//
//  This dashboard can place real trades, so:
//    • DASHBOARD_PASSWORD is mandatory (the server refuses to start without it)
//    • it listens on 127.0.0.1 unless HOST is set (set HOST=0.0.0.0 when deploying)
//    • real-money mode additionally needs ALLOW_REAL=true in the environment
// ═══════════════════════════════════════════════════════
import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./live/store.js";
import { Bot } from "./live/bot.js";
import { SYMBOL_META } from "../config/symbols.js";
import { validateSettings, deepMerge } from "./core/settings.js";
import { riskPreview } from "./core/sizing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ bot, password }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "50kb" }));
  app.use((_, res, next) => { res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" }); next(); });

  // Behind Render's proxy the real client IP is in X-Forwarded-For (needed for the login rate limit)
  if (process.env.TRUST_PROXY || process.env.RENDER) app.set("trust proxy", 1);

  // ── health (no login, no secrets) ─────────────────────
  // Render calls this to decide whether the service is alive. It reports the PROCESS, not Deriv:
  // a Deriv outage must not make Render kill and restart a bot that is managing an open trade.
  const startedAt = Date.now();
  const health = (_, res) => res.json({ ok: true, uptimeSecs: Math.round((Date.now() - startedAt) / 1000), botRunning: bot.running, derivConnected: bot.connected });
  app.get("/health", health);
  app.get("/healthz", health);
  app.get("/ping", (_, res) => res.type("text").send("pong"));

  // ── auth ──────────────────────────────────────────────
  const tokens = new Map();                         // token -> expiry ms
  const fails = new Map();                          // ip -> {n, until}
  const safeEq = (a, b) => { const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };

  app.post("/api/login", (req, res) => {
    const ip = req.ip, f = fails.get(ip) || { n: 0, until: 0 };
    if (Date.now() < f.until) return res.status(429).json({ error: "Too many attempts — wait a minute" });
    if (!safeEq(req.body?.password ?? "", password)) {
      f.n++; if (f.n >= 5) { f.until = Date.now() + 60_000; f.n = 0; }
      fails.set(ip, f);
      return res.status(401).json({ error: "Wrong password" });
    }
    fails.delete(ip);
    const token = crypto.randomBytes(32).toString("hex");
    tokens.set(token, Date.now() + 12 * 3600_000);
    res.json({ token });
  });

  const auth = (req, res, next) => {
    const h = req.headers.authorization;
    const token = h?.startsWith("Bearer ") ? h.slice(7) : req.query.token;
    const exp = token && tokens.get(token);
    if (!exp || exp < Date.now()) { if (token) tokens.delete(token); return res.status(401).json({ error: "Not authorised" }); }
    next();
  };

  // ── data ──────────────────────────────────────────────
  const symbolList = () => Object.values(SYMBOL_META).map(m => ({
    symbol: m.symbol, group: m.group, decimals: m.decimals, defaultPip: m.pipSize,
    pip: bot.settings.pipSizes?.[m.symbol] ?? m.pipSize, ladder: m.ladder,
  }));
  const recent = (n) => bot.store.trades.slice(-n).reverse();

  app.get("/api/state", auth, (_, res) => {
    res.json({ snapshot: bot.snapshot(), settings: bot.settings, symbols: symbolList(), trades: recent(50), events: bot.store.events.slice(-150) });
  });

  app.post("/api/settings", auth, (req, res) => {
    try { const s = bot.updateSettings(req.body?.settings || {}); res.json({ ok: true, settings: s, symbols: symbolList() }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });

  // live preview of what the pip numbers mean in price / dollars, for UNSAVED form values
  app.post("/api/risk-preview", auth, (req, res) => {
    try {
      const merged = validateSettings(deepMerge(bot.settings, req.body?.settings || {}));
      const lt = bot.lastTick && bot.settings.symbol === merged.symbol ? (bot.lastTick.bid + bot.lastTick.ask) / 2 : Number(req.body?.price) || null;
      const out = riskPreview(merged, { symbol: merged.symbol, refPrice: lt, balance: bot.balance || 0 });
      const tt = bot.settings.symbol === merged.symbol ? bot.typicalTick() : null;
      if (tt && out?.slPoints) { out.typicalTick = tt; out.stopInTicks = out.slPoints / tt; out.minStopTicks = merged.risk.minStopTicks; }
      res.json(out);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post("/api/bot/start", auth, (_, res) => { bot.start(); res.json({ ok: true }); });
  app.post("/api/bot/stop", auth, (req, res) => { bot.stop({ closePosition: !!req.body?.closePosition }); res.json({ ok: true }); });
  app.post("/api/bot/emergency", auth, (_, res) => { bot.emergency(); res.json({ ok: true }); });
  app.post("/api/bot/resume", auth, (_, res) => { bot.resume(); res.json({ ok: true }); });

  app.get("/api/trades", auth, (req, res) => {
    const n = Math.min(Number(req.query.limit) || 100, 1000);
    res.json({ trades: recent(n) });
  });
  app.get("/api/trades.csv", auth, (_, res) => {
    const cols = ["id", "symbol", "side", "signalCandleEpoch", "candleDirection", "entryEpoch", "entryPrice", "exitEpoch", "exitPrice", "stake", "multiplier", "slPips", "trailPips", "initialSl", "finalStop", "exitReason", "grossPnl", "tradingCosts", "netPnl", "durationSecs", "contractId"];
    const lines = [cols.join(",")];
    for (const t of bot.store.trades) lines.push(cols.map(c => JSON.stringify(t[c] ?? "")).join(","));
    res.type("text/csv").set("Content-Disposition", "attachment; filename=trades.csv").send(lines.join("\n"));
  });

  // ── live stream (Server-Sent Events) ──────────────────
  app.get("/api/stream", auth, (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("state", bot.snapshot());
    const timer = setInterval(() => send("state", bot.snapshot()), 1000);
    const onEvent = (ev) => send("log", ev), onTrade = (t) => send("trade", t);
    bot.on("event", onEvent); bot.on("trade", onTrade);
    req.on("close", () => { clearInterval(timer); bot.off("event", onEvent); bot.off("trade", onTrade); });
  });

  app.use(express.static(path.join(__dirname, "../public")));
  app.use("/api", (_, res) => res.status(404).json({ error: "Not found" }));
  return app;
}

// ── boot (skipped when imported by tests) ───────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password || password.length < 8) {
    console.error("DASHBOARD_PASSWORD is required (at least 8 characters). The dashboard can place trades, so it never runs without one.");
    process.exit(1);
  }
  const store = new Store();
  const bot = new Bot({ store });
  const app = createApp({ bot, password });
  const port = Number(process.env.PORT) || 3000, host = process.env.HOST || "127.0.0.1";
  const server = app.listen(port, host, () => {
    console.log(`\nM1 scalper dashboard → http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
    console.log(`Mode: ${bot.settings.mode} | symbol: ${bot.settings.symbol} | trading ${bot.settings.enabled ? "ENABLED" : "stopped"}`);
    bot.autoStart();
  });
  // Optional keep-alive: pings this service's own public URL so an idle instance is not spun down.
  // (Only useful on hosts that sleep idle services. Real trading belongs on an always-on paid instance.)
  const publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
  if (process.env.KEEP_ALIVE === "true" && publicUrl) {
    setInterval(() => fetch(`${publicUrl}/ping`).catch(() => {}), 10 * 60 * 1000).unref();
    console.log(`Keep-alive ping enabled → ${publicUrl}/ping every 10 min`);
  }
  const bye = async () => { console.log("Shutting down…"); await bot.shutdown(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
  process.on("unhandledRejection", (e) => bot.log("error", `Unhandled rejection: ${e?.message || e}`));
}
