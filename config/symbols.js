// ═══════════════════════════════════════════════════════
//  config/symbols.js
//
//  Every symbol from the old bot. The dashboard lists all of
//  these; the user picks ONE to trade.
//
//  decimals  : price decimals Deriv reports for the symbol (measured
//              from the old repo's candle data).
//  pipSize   : DEFAULT size of one "pip" in PRICE POINTS. Editable
//              per symbol from the dashboard. Default rule:
//                decimals >= 2  ->  pip = 10 x tick  (forex-style pip)
//                decimals <= 1  ->  pip = 1 x tick
//              These are starting values, not optimal values. Check the
//              dashboard's "risk preview" before trading a symbol.
//  ladder    : best-effort multiplier options, smallest first. The live
//              executor learns the real list from Deriv's error text.
// ═══════════════════════════════════════════════════════

const RAW = {
  // symbol:     [group,      decimals, ladder]
  frxEURUSD: ["Forex", 5, [10, 20, 30, 50, 100]],
  frxGBPUSD: ["Forex", 5, [10, 20, 30, 50, 100]],
  frxUSDJPY: ["Forex", 3, [10, 20, 30, 50, 100]],
  frxUSDCHF: ["Forex", 5, [10, 20, 30, 50, 100]],
  frxAUDUSD: ["Forex", 5, [10, 20, 30, 50, 100]],
  frxUSDCAD: ["Forex", 5, [10, 20, 30, 50, 100]],
  frxNZDUSD: ["Forex", 5, [10, 20, 30, 50, 100]],
  frxGBPJPY: ["Forex", 3, [10, 20, 30, 50, 80]],
  frxEURGBP: ["Forex", 5, [10, 20, 30, 50, 80]],
  frxEURCHF: ["Forex", 5, [10, 20, 30, 50, 80]],
  frxEURCAD: ["Forex", 5, [10, 20, 30, 50, 80]],
  frxEURAUD: ["Forex", 5, [10, 20, 30, 50, 80]],
  frxXAUUSD: ["Metals", 2, [10, 20, 30, 60]],
  frxXAGUSD: ["Metals", 4, [10, 20, 30, 60]],
  cryBTCUSD: ["Crypto", 3, [5, 10, 20, 40]],
  cryETHUSD: ["Crypto", 4, [5, 10, 20, 40]],
  BOOM50:    ["Boom", 3, [5, 10, 20]],
  BOOM500:   ["Boom", 3, [5, 10, 20, 30]],
  BOOM600:   ["Boom", 3, [5, 10, 20, 30]],
  BOOM900:   ["Boom", 3, [5, 10, 20, 30]],
  BOOM1000:  ["Boom", 3, [5, 10, 20, 30]],
  CRASH50:   ["Crash", 3, [5, 10, 20]],
  CRASH500:  ["Crash", 3, [5, 10, 20, 30]],
  CRASH600:  ["Crash", 3, [5, 10, 20, 30]],
  CRASH900:  ["Crash", 3, [5, 10, 20, 30]],
  CRASH1000: ["Crash", 3, [5, 10, 20, 30]],
  JD10:      ["Jump", 2, [10, 20, 30, 50]],
  JD25:      ["Jump", 2, [10, 20, 30, 40]],
  JD50:      ["Jump", 2, [10, 20, 30]],
  JD75:      ["Jump", 2, [5, 10, 20, 25]],
  JD100:     ["Jump", 2, [5, 10, 20, 25]],
  STPRNG:    ["Step", 1, [10, 20, 30, 50]],
  STPRNG2:   ["Step", 1, [10, 20, 30, 50]],
  STPRNG3:   ["Step", 1, [10, 20, 30, 50]],
  STPRNG4:   ["Step", 1, [10, 20, 30, 50]],
  STPRNG5:   ["Step", 1, [10, 20, 30, 50]],
  R_10:      ["Volatility", 3, [10, 20, 50, 100]],
  R_25:      ["Volatility", 3, [10, 20, 50]],
  R_50:      ["Volatility", 4, [10, 20, 30]],
  R_75:      ["Volatility", 4, [5, 10, 20, 25]],
  R_100:     ["Volatility", 2, [5, 10, 20]],
  "1HZ10V":  ["Volatility 1s", 2, [10, 20, 50, 100]],
  "1HZ15V":  ["Volatility 1s", 3, [10, 20, 50, 90]],
  "1HZ25V":  ["Volatility 1s", 2, [10, 20, 50]],
  "1HZ50V":  ["Volatility 1s", 2, [10, 20, 30]],
  "1HZ75V":  ["Volatility 1s", 2, [5, 10, 20, 25]],
  "1HZ90V":  ["Volatility 1s", 3, [5, 10, 20]],
  "1HZ100V": ["Volatility 1s", 2, [5, 10, 20]],
};

function defaultPip(decimals) {
  const tick = Math.pow(10, -decimals);
  return +(decimals >= 2 ? tick * 10 : tick).toFixed(decimals);
}

export const SYMBOL_META = Object.fromEntries(
  Object.entries(RAW).map(([symbol, [group, decimals, ladder]]) => [
    symbol,
    { symbol, group, decimals, tick: +Math.pow(10, -decimals).toFixed(decimals), pipSize: defaultPip(decimals), ladder },
  ])
);

export const SYMBOLS = Object.keys(SYMBOL_META);

export function symbolMeta(symbol) {
  const m = SYMBOL_META[symbol];
  if (!m) throw new Error(`Unknown symbol "${symbol}"`);
  return m;
}
