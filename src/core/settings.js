// ═══════════════════════════════════════════════════════
//  src/core/settings.js — defaults + validation
//  Everything here is editable from the dashboard. Nothing in
//  the strategy code hard-codes 20 / 15 / M1.
// ═══════════════════════════════════════════════════════
import { SYMBOLS, SYMBOL_META } from "../../config/symbols.js";

export const DEFAULT_SETTINGS = {
  symbol: "R_100",             // ONE symbol at a time
  mode: "demo",                // "demo" | "real" (real also needs ALLOW_REAL=true in .env)
  enabled: false,              // master switch / emergency disable

  slPips: 20,                  // initial stop-loss distance
  trailPips: 15,               // fixed trailing distance
  // "breakeven": trail only takes over once (extreme -/+ trailPips) has reached
  //              the entry price, so the full initial risk (slPips) is kept
  //              until then.   "immediate": effective SL = max(initial, trail) from the first tick.
  trailActivation: "breakeven",
  pipSizes: {},                // per-symbol override, in PRICE POINTS. Falls back to config/symbols.js

  multiplier: "auto",          // "auto" = smallest rung of the symbol's ladder, or a number
  sizing: {
    mode: "fixed",             // "fixed" (stake in USD) | "riskPct" (% of balance lost at the initial SL)
    stake: 1,
    riskPct: 1,
    maxStake: 100,
    maxExposurePct: 0,         // 0 = off. Max stake as % of balance.
    minStake: 1,
  },

  risk: {
    dailyLossEnabled: true,   dailyLossUsd: 10,
    consecLossEnabled: true,  consecLossMax: 10,
    spreadFilterEnabled: false, maxSpreadPoints: 0,
    maxExecFailures: 3,        // consecutive order failures before the bot disables itself
    minNativeStopUsd: 0.01,    // smallest server-side stop Deriv will accept
  },

  // backtest-only cost model (the live bot pays real spread / slippage)
  costs: { spreadPoints: 0, slippagePoints: 0, commissionUsd: 0 },
};

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

export function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObj(v) && isObj(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

const num = (v, name, { min = -Infinity, max = Infinity, gt } = {}) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  if (v < min || v > max) throw new Error(`${name} must be between ${min} and ${max}`);
  if (gt !== undefined && !(v > gt)) throw new Error(`${name} must be greater than ${gt}`);
  return v;
};
const bool = (v, name) => { if (typeof v !== "boolean") throw new Error(`${name} must be true or false`); return v; };

/** Returns a fully-merged, validated settings object or throws Error(message). */
export function validateSettings(candidate) {
  const s = deepMerge(DEFAULT_SETTINGS, candidate || {});
  if (!SYMBOLS.includes(s.symbol)) throw new Error(`Unknown symbol "${s.symbol}"`);
  if (!["demo", "real"].includes(s.mode)) throw new Error(`mode must be "demo" or "real"`);
  bool(s.enabled, "enabled");
  num(s.slPips, "slPips", { gt: 0, max: 100000 });
  num(s.trailPips, "trailPips", { gt: 0, max: 100000 });
  if (!["breakeven", "immediate"].includes(s.trailActivation)) throw new Error(`trailActivation must be "breakeven" or "immediate"`);
  if (!isObj(s.pipSizes)) throw new Error("pipSizes must be an object");
  for (const [sym, p] of Object.entries(s.pipSizes)) {
    if (!SYMBOLS.includes(sym)) throw new Error(`pipSizes: unknown symbol "${sym}"`);
    num(p, `pipSizes.${sym}`, { gt: 0 });
  }
  if (s.multiplier !== "auto") num(s.multiplier, "multiplier", { gt: 0, max: 5000 });
  if (!["fixed", "riskPct"].includes(s.sizing.mode)) throw new Error(`sizing.mode must be "fixed" or "riskPct"`);
  num(s.sizing.stake, "sizing.stake", { gt: 0 });
  num(s.sizing.riskPct, "sizing.riskPct", { gt: 0, max: 100 });
  num(s.sizing.maxStake, "sizing.maxStake", { gt: 0 });
  num(s.sizing.maxExposurePct, "sizing.maxExposurePct", { min: 0, max: 100 });
  num(s.sizing.minStake, "sizing.minStake", { gt: 0 });
  if (s.sizing.minStake > s.sizing.maxStake) throw new Error("sizing.minStake cannot exceed sizing.maxStake");
  bool(s.risk.dailyLossEnabled, "risk.dailyLossEnabled");  num(s.risk.dailyLossUsd, "risk.dailyLossUsd", { min: 0 });
  bool(s.risk.consecLossEnabled, "risk.consecLossEnabled"); num(s.risk.consecLossMax, "risk.consecLossMax", { min: 1 });
  bool(s.risk.spreadFilterEnabled, "risk.spreadFilterEnabled"); num(s.risk.maxSpreadPoints, "risk.maxSpreadPoints", { min: 0 });
  num(s.risk.maxExecFailures, "risk.maxExecFailures", { min: 1 });
  num(s.risk.minNativeStopUsd, "risk.minNativeStopUsd", { min: 0 });
  num(s.costs.spreadPoints, "costs.spreadPoints", { min: 0 });
  num(s.costs.slippagePoints, "costs.slippagePoints", { min: 0 });
  num(s.costs.commissionUsd, "costs.commissionUsd", { min: 0 });
  return s;
}

/** Pip size in price points for the given symbol (dashboard override → config default). */
export function pipSizeFor(settings, symbol = settings.symbol) {
  return settings.pipSizes?.[symbol] ?? SYMBOL_META[symbol].pipSize;
}

/** Stop / trail distances in PRICE POINTS for the selected symbol. */
export function distancesFor(settings, symbol = settings.symbol) {
  const pip = pipSizeFor(settings, symbol);
  return { pip, slDist: settings.slPips * pip, trailDist: settings.trailPips * pip };
}
