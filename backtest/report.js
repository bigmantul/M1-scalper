// ═══════════════════════════════════════════════════════
//  backtest/report.js — performance statistics
// ═══════════════════════════════════════════════════════

const sum = (a) => a.reduce((x, y) => x + y, 0);
const avg = (a) => (a.length ? sum(a) / a.length : 0);

export function computeStats(trades, startBalance = 1000) {
  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl < 0);
  const grossProfit = sum(wins.map(t => t.netPnl));
  const grossLoss = sum(losses.map(t => t.netPnl));           // negative number
  const net = sum(trades.map(t => t.netPnl));
  const costs = sum(trades.map(t => t.tradingCosts));
  const commission = sum(trades.map(t => t.commission));

  // closed-trade equity curve → max drawdown
  let eq = startBalance, peak = startBalance, maxDD = 0, maxDDPct = 0;
  let streak = 0, maxStreak = 0;
  for (const t of trades) {
    eq += t.netPnl;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak - eq);
    maxDDPct = Math.max(maxDDPct, peak > 0 ? (peak - eq) / peak * 100 : 0);
    streak = t.netPnl < 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }

  const side = (s) => {
    const ts = trades.filter(t => t.side === s);
    return { trades: ts.length, winRate: ts.length ? ts.filter(t => t.netPnl > 0).length / ts.length * 100 : 0, net: sum(ts.map(t => t.netPnl)) };
  };
  const reasons = {};
  for (const t of trades) reasons[t.exitReason] = (reasons[t.exitReason] || 0) + 1;

  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    grossProfit, grossLoss, netProfit: net,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : (grossProfit > 0 ? Infinity : 0),
    avgWin: avg(wins.map(t => t.netPnl)), avgLoss: avg(losses.map(t => t.netPnl)),
    avgPerTrade: trades.length ? net / trades.length : 0,
    maxDrawdown: maxDD, maxDrawdownPct: maxDDPct, maxConsecLosses: maxStreak,
    avgDurationSecs: avg(trades.map(t => t.durationSecs)),
    tradingCosts: costs, commission, spreadAndSlippage: costs - commission,
    grossBeforeCosts: sum(trades.map(t => t.grossPnl)),
    long: side("BUY"), short: side("SELL"),
    exitReasons: reasons,
    ambiguousTrades: trades.filter(t => t.ambiguous).length,
    endBalance: startBalance + net,
  };
}

/** Tags each trade with the volatility / trend regime of the 20 M1 bars before entry. */
export function byMarketCondition(trades, bars, startBalance) {
  if (!trades.length || bars.length < 25) return {};
  const idx = new Map(bars.map((b, i) => [b.epoch, i]));
  const feats = trades.map(t => {
    const i = idx.get(Math.floor(t.entryEpoch / 60) * 60);
    if (i == null || i < 21) return null;
    const w = bars.slice(i - 20, i);
    const atrPct = avg(w.map(b => (b.high - b.low) / b.close));
    const net = Math.abs(w[w.length - 1].close - w[0].open);
    const path = sum(w.map(b => Math.abs(b.close - b.open))) || 1e-12;
    return { atrPct, er: net / path };
  });
  const atrs = feats.filter(Boolean).map(f => f.atrPct).sort((a, b) => a - b);
  if (atrs.length < 3) return {};
  const lo = atrs[Math.floor(atrs.length / 3)], hi = atrs[Math.floor(atrs.length * 2 / 3)];
  const ers = feats.filter(Boolean).map(f => f.er).sort((a, b) => a - b);
  const medER = ers[Math.floor(ers.length / 2)];
  const groups = {};
  trades.forEach((t, k) => {
    const f = feats[k]; if (!f) return;
    const vol = f.atrPct <= lo ? "low volatility" : f.atrPct >= hi ? "high volatility" : "mid volatility";
    const trend = f.er >= medER ? "trending" : "choppy";
    (groups[vol] ||= []).push(t); (groups[trend] ||= []).push(t);
  });
  return Object.fromEntries(Object.entries(groups).map(([k, ts]) => {
    const s = computeStats(ts, startBalance);
    return [k, { trades: s.trades, winRate: s.winRate, net: s.netProfit, profitFactor: s.profitFactor }];
  }));
}

export const fmt = (n, d = 2) => (n === Infinity ? "∞" : Number.isFinite(n) ? n.toFixed(d) : String(n));

export function printStats(title, st) {
  const L = [];
  L.push(`── ${title} ──`);
  L.push(`Trades            ${st.trades}   (wins ${st.wins} / losses ${st.losses}, win rate ${fmt(st.winRate, 1)}%)`);
  L.push(`Gross profit      $${fmt(st.grossProfit)}    Gross loss  $${fmt(st.grossLoss)}`);
  L.push(`Net profit        $${fmt(st.netProfit)}    Profit factor ${fmt(st.profitFactor)}`);
  L.push(`Avg win / loss    $${fmt(st.avgWin, 4)} / $${fmt(st.avgLoss, 4)}    Avg per trade $${fmt(st.avgPerTrade, 4)}`);
  L.push(`Max drawdown      $${fmt(st.maxDrawdown)} (${fmt(st.maxDrawdownPct, 2)}%)    Max consecutive losses ${st.maxConsecLosses}`);
  L.push(`Avg duration      ${fmt(st.avgDurationSecs, 0)}s`);
  L.push(`Trading costs     $${fmt(st.tradingCosts, 4)}  (spread+slippage $${fmt(st.spreadAndSlippage, 4)}, commission $${fmt(st.commission, 4)})`);
  L.push(`Long              ${st.long.trades} trades, win ${fmt(st.long.winRate, 1)}%, net $${fmt(st.long.net)}`);
  L.push(`Short             ${st.short.trades} trades, win ${fmt(st.short.winRate, 1)}%, net $${fmt(st.short.net)}`);
  L.push(`Exits             ${Object.entries(st.exitReasons).map(([k, v]) => `${k}:${v}`).join("  ")}`);
  if (st.blocked && Object.keys(st.blocked).length) L.push(`Entries blocked  ${Object.entries(st.blocked).map(([k, v]) => `${k}:${v}`).join("  ")}  (risk limits suppressed these signals)`);
  if (st.ambiguousTrades) L.push(`Ambiguous trades  ${st.ambiguousTrades} (OHLC order unknown — worse outcome used)`);
  return L.join("\n");
}
