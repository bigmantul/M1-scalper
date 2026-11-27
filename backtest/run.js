// ═══════════════════════════════════════════════════════
//  backtest/run.js
//    node backtest/run.js R_100 [--file=data/R_100.json] [--oos=0.3] [--sensitivity]
//         [--sl=20 --trail=15 --activation=breakeven|immediate --pip=0.1 --stake=1 --mult=auto]
//         [--spread=0 --slip=0 --commission=0 --balance=1000]
//
//  Uses the SAME engine as live trading. Settings come from data/settings.json
//  (what you saved in the dashboard) unless a flag overrides them.
// ═══════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { validateSettings, deepMerge } from "../src/core/settings.js";
import { riskPreview } from "../src/core/sizing.js";
import { simulateTicks, simulateCandles, ticksToBars } from "./simulator.js";
import { computeStats, byMarketCondition, printStats, fmt } from "./report.js";

const argv = process.argv.slice(2);
const symbolArg = argv.find(a => !a.startsWith("--"));
const opt = Object.fromEntries(argv.filter(a => a.startsWith("--")).map(a => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }));

// ── settings ────────────────────────────────────────────
let saved = {};
try { saved = JSON.parse(fs.readFileSync(path.resolve(process.env.DATA_DIR || "data", "settings.json"), "utf8")); } catch {}
const symbol = symbolArg || saved.symbol || "R_100";
const patch = { symbol, enabled: true };
if (opt.sl) patch.slPips = Number(opt.sl);
if (opt.model) patch.exitModel = opt.model;               // candle_step | legacy
if (opt.trail) patch.trailPips = Number(opt.trail);
if (opt.activation) patch.trailActivation = opt.activation;
if (opt.pip) patch.pipSizes = { [symbol]: Number(opt.pip) };
if (opt.stake) patch.sizing = { mode: "fixed", stake: Number(opt.stake) };
if (opt.mult) patch.multiplier = opt.mult === "auto" ? "auto" : Number(opt.mult);
patch.costs = { spreadPoints: Number(opt.spread ?? saved.costs?.spreadPoints ?? 0), slippagePoints: Number(opt.slip ?? saved.costs?.slippagePoints ?? 0), commissionUsd: Number(opt.commission ?? saved.costs?.commissionUsd ?? 0) };
if (opt["no-limits"]) patch.risk = { dailyLossEnabled: false, consecLossEnabled: false, spreadFilterEnabled: false };
const settings = validateSettings(deepMerge(saved, patch));
const startBalance = Number(opt.balance ?? 1000);

// ── data ────────────────────────────────────────────────
const file = opt.file || path.join("data", `${symbol}.json`);
if (!fs.existsSync(file)) {
  console.error(`No data file at ${file}.\n  Synthetic (pipeline check only):  node backtest/generate-ticks.js ${symbol} --days=7\n  Real history (your machine):      node backtest/fetch-ticks.js ${symbol} --days=7`);
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
let ticks = null, bars = null;
if (Array.isArray(raw.ticks)) ticks = raw.ticks.map(([epoch, quote]) => ({ epoch, quote }));
else if (Array.isArray(raw.candles) && raw.candles[0]?.open != null) bars = raw.candles;
else { console.error("Unsupported data file: need { ticks:[[epoch,quote],…] } (best) or { candles:[{epoch,open,high,low,close},…] } of M1 bars. Old M15/H1/D1 files cannot test an M1 strategy."); process.exit(1); }

const mode = ticks ? "tick" : "candle";
const marketBars = bars || ticksToBars(ticks);
const n = ticks ? ticks.length : bars.length;
const sim = (data, s = settings) => (ticks ? simulateTicks(data, s, { startBalance }) : simulateCandles(data, s, { startBalance }));

// split in-sample / out-of-sample by time (never shuffled), on a minute boundary
const oos = Number(opt.oos ?? 0.3);
function split(data) {
  if (!(oos > 0 && oos < 1)) return [data, []];
  const key = ticks ? "epoch" : "epoch";
  const cut = data[Math.floor(data.length * (1 - oos))][key];
  const edge = Math.ceil(cut / 60) * 60;
  return [data.filter(d => d[key] < edge), data.filter(d => d[key] >= edge)];
}
const data = ticks || bars;
const [inSample, outSample] = split(data);

// ── report ──────────────────────────────────────────────
const days = (data[data.length - 1].epoch - data[0].epoch) / 86400;
console.log(`\nSymbol ${symbol} | ${mode} data (${source(raw)}) | ${n.toLocaleString()} rows ≈ ${days.toFixed(1)} days`);
const refPrice = (ticks ? ticks[0].quote : bars[0].close);
const pv = riskPreview(settings, { symbol, refPrice, balance: startBalance });
if (settings.exitModel === "candle_step") console.log(`Exit model: signal-candle SL, breakeven ${settings.breakeven.enabled ? "+" + settings.breakeven.triggerPips : "off"}, step trail ${settings.stepTrail.enabled ? settings.stepTrail.stepPips + "/" + settings.stepTrail.lockOffsetPips : "off"} pips, 1 pip = ${pv.pipSize}`);
else console.log(`Stops: SL ${settings.slPips} pips, trail ${settings.trailPips} pips (${settings.trailActivation}), 1 pip = ${pv.pipSize} → SL ${fmt(pv.slPoints, 4)} pts (${fmt(pv.slPctOfPrice, 3)}% of price) | stake $${pv.stake} ×${pv.multiplier} | costs: spread ${settings.costs.spreadPoints}, slippage ${settings.costs.slippagePoints}, commission $${settings.costs.commissionUsd}`);
if (mode === "candle") console.log("NOTE: OHLC-only data — the order of events inside each minute is unknown. Bars where it changes the result are flagged ambiguous and the WORSE outcome is used.");
if (raw.source === "synthetic") console.log("NOTE: synthetic random-walk data. It has no edge by construction — this only proves the machinery runs.");

const full = sim(data);
const stats = (r) => ({ ...computeStats(r.trades, startBalance), blocked: r.engine.s.blocked });
const fullStats = stats(full);
console.log("\n" + printStats("FULL PERIOD", fullStats));

if (outSample.length) {
  const a = stats(sim(inSample)), b = stats(sim(outSample));
  console.log("\n" + printStats(`IN-SAMPLE (first ${Math.round((1 - oos) * 100)}%)`, a));
  console.log("\n" + printStats(`OUT-OF-SAMPLE (last ${Math.round(oos * 100)}%)`, b));
}

const cond = byMarketCondition(full.trades, marketBars, startBalance);
if (Object.keys(cond).length) {
  console.log("\n── By market condition (20 M1 bars before entry) ──");
  for (const [k, v] of Object.entries(cond)) console.log(`${k.padEnd(16)} ${String(v.trades).padStart(5)} trades  win ${fmt(v.winRate, 1).padStart(5)}%  net $${fmt(v.net).padStart(9)}  PF ${fmt(v.profitFactor)}`);
}

// ── parameter sensitivity ───────────────────────────────
if (opt.sensitivity) {
  const sls = [10, 15, 20, 30, 40], trails = [5, 10, 15, 20, 25];
  console.log(`\n── Parameter sensitivity: net P/L in-sample | out-of-sample (current: SL ${settings.slPips}, trail ${settings.trailPips}) ──`);
  console.log("SL \\ trail".padEnd(11) + trails.map(t => String(t).padStart(18)).join(""));
  for (const sl of sls) {
    let row = String(sl).padEnd(11);
    for (const tr of trails) {
      const s = { ...settings, slPips: sl, trailPips: tr };
      const a = computeStats(sim(inSample, s).trades, startBalance).netProfit;
      const b = outSample.length ? computeStats(sim(outSample, s).trades, startBalance).netProfit : NaN;
      row += `${fmt(a, 1)} | ${Number.isNaN(b) ? "n/a" : fmt(b, 1)}`.padStart(18);
    }
    console.log(row);
  }
  console.log("A setting that wins in-sample but loses out-of-sample is curve-fitting, not an edge. Look for broad regions that hold up in BOTH columns.");
}

// ── outputs ─────────────────────────────────────────────
fs.mkdirSync("results", { recursive: true });
const cols = ["id", "side", "signalCandleEpoch", "candleDirection", "entryEpoch", "entryPrice", "exitEpoch", "exitPrice", "initialSl", "finalStop", "exitReason", "grossPnl", "tradingCosts", "netPnl", "durationSecs", "ambiguous"];
fs.writeFileSync(path.join("results", `trades-${symbol}.csv`), [cols.join(","), ...full.trades.map(t => cols.map(c => JSON.stringify(t[c] ?? "")).join(","))].join("\n"));
console.log(`\nTrade log → results/trades-${symbol}.csv`);

function source(r) { return r.source || "unknown source"; }
