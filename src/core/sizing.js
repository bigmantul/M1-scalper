// ═══════════════════════════════════════════════════════
//  src/core/sizing.js
//  Deriv multiplier maths:  pnl = stake × multiplier × (Δprice / entry)
//  No martingale: size never depends on the previous trade's result.
// ═══════════════════════════════════════════════════════
import { symbolMeta } from "../../config/symbols.js";

export const dirSign = (side) => (side === "BUY" ? 1 : -1);

export function pnlFor({ side, entry, exit, stake, multiplier }) {
  return stake * multiplier * ((exit - entry) / entry) * dirSign(side);
}

export function pickMultiplier(settings, symbol) {
  return settings.multiplier === "auto" ? symbolMeta(symbol).ladder[0] : settings.multiplier;
}

/**
 * @returns {{stake:number, multiplier:number, riskUsd:number, nativeStopUsd:number|null, notes:string[]}}
 *   riskUsd       = dollars lost if the initial stop is hit (before spread / slippage)
 *   nativeStopUsd = the server-side stop amount to send with the order (null if below
 *                   Deriv's minimum, in which case only the bot's own stop protects the trade)
 */
/** Deriv rejects server-side stops under $0.10; a lower value saved in old settings is raised to that floor. */
export const DERIV_MIN_STOP_USD = 0.10;
export const minNative = (settings) => Math.max(DERIV_MIN_STOP_USD, Number(settings.risk.minNativeStopUsd) || 0);

export function computeSize(settings, { symbol, balance, entryPrice, slDist }) {
  const notes = [];
  const multiplier = pickMultiplier(settings, symbol);
  const slFrac = slDist / entryPrice;            // stop distance as a fraction of price
  const s = settings.sizing;

  let stake;
  if (s.mode === "riskPct") {
    if (!(balance > 0)) throw new Error("riskPct sizing needs a positive balance");
    const riskUsd = balance * (s.riskPct / 100);
    stake = riskUsd / (multiplier * slFrac);
  } else {
    stake = s.stake;
  }

  stake = Math.max(stake, s.minStake);
  stake = Math.min(stake, s.maxStake);
  if (s.maxExposurePct > 0 && balance > 0) {
    const cap = balance * (s.maxExposurePct / 100);
    if (stake > cap) { stake = cap; notes.push(`stake capped by maxExposurePct (${s.maxExposurePct}%)`); }
  }
  stake = Math.floor(stake * 100) / 100;          // round DOWN to cents — never size up by rounding
  if (balance > 0 && stake > balance) throw new Error(`stake $${stake} exceeds balance $${balance}`);
  if (stake < s.minStake) throw new Error(`stake $${stake} is below the minimum $${s.minStake}`);

  const riskUsd = stake * multiplier * slFrac;
  let nativeStopUsd = +riskUsd.toFixed(2);
  if (nativeStopUsd < minNative(settings)) {
    notes.push(`initial stop is only $${riskUsd.toFixed(4)}, below the minimum server-side stop ($${minNative(settings)}); only the bot's own stop will protect this trade`);
    nativeStopUsd = null;
  } else if (nativeStopUsd >= stake) {
    notes.push(`initial stop $${nativeStopUsd} is >= stake, so the contract will stop out at the stake first`);
    nativeStopUsd = null;
  }
  return { stake, multiplier, riskUsd, nativeStopUsd, notes };
}

/** What the dashboard shows next to the pip inputs so the user sees the real-money meaning. */
export function riskPreview(settings, { symbol, refPrice, balance = 0 }) {
  const pip = settings.pipSizes?.[symbol] ?? symbolMeta(symbol).pipSize;
  const candle = settings.exitModel === "candle_step";
  // candle model: the real stop is the signal candle's extreme (unknown until it closes) — size the preview with the fallback distance
  const slDist = (candle ? settings.candleSl.fallbackPips : settings.slPips) * pip, trailDist = (candle ? settings.stepTrail.stepPips : settings.trailPips) * pip;
  const out = {
    symbol, pipSize: pip, slPoints: slDist, trailPoints: trailDist, candleStop: candle,
    ...(candle ? { breakevenPoints: settings.breakeven.triggerPips * pip, stepPoints: settings.stepTrail.stepPips * pip, breakevenOn: settings.breakeven.enabled, breakevenPips: settings.breakeven.triggerPips, activationPips: settings.stepTrail.enabled ? settings.stepTrail.activationPips : 0 } : {}),
    slPctOfPrice: refPrice ? (slDist / refPrice) * 100 : null,
    trailPctOfPrice: refPrice ? (trailDist / refPrice) * 100 : null,
    multiplier: pickMultiplier(settings, symbol),
  };
  if (refPrice) {
    try { Object.assign(out, computeSize(settings, { symbol, balance, entryPrice: refPrice, slDist })); }
    catch (e) { out.error = e.message; }
  }
  return out;
}

/** Server-side stop amount (USD) for a given stake/multiplier, or null if it can't be placed. */
export function nativeStopUsd(settings, { stake, multiplier, slDist, entryPrice }) {
  const usd = +(stake * multiplier * (slDist / entryPrice)).toFixed(2);
  if (usd < minNative(settings) || usd >= stake) return null;
  return usd;
}
