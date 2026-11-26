// Synthetic tick generator — for checking that the pipeline runs, NOT for judging the strategy.
// A random walk has no edge by construction: expect roughly break-even before costs.
//   node backtest/generate-ticks.js R_100 --days=7 --seed=1 [--momentum=0.2] [--start=1000] [--vol=1.0]
import fs from "node:fs";
import path from "node:path";
import { symbolMeta } from "../config/symbols.js";

const args = process.argv.slice(2);
const symbol = args.find(a => !a.startsWith("--")) || "R_100";
const opt = Object.fromEntries(args.filter(a => a.startsWith("--")).map(a => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }));
const days = Number(opt.days ?? 7), seed = Number(opt.seed ?? 1), momentum = Number(opt.momentum ?? 0);
const meta = symbolMeta(symbol);
const volNum = Number((symbol.match(/(\d+)/g) || ["100"]).pop());
const annualVol = Number(opt.vol ?? Math.min(volNum, 100) / 100);
const tickSecs = symbol.startsWith("1HZ") ? 1 : 2;

function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rand = rng(seed);
const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());

const sigma = annualVol / Math.sqrt(365 * 86400 / tickSecs);
let price = Number(opt.start ?? 1000), prev = 0;
const start = Math.floor(Date.now() / 1000 / 86400) * 86400 - days * 86400;
const ticks = [];
for (let t = start; t < start + days * 86400; t += tickSecs) {
  const r = sigma * gauss() + momentum * prev;
  prev = r; price *= 1 + r;
  ticks.push([t, +price.toFixed(meta.decimals)]);
}
fs.mkdirSync("data", { recursive: true });
const file = path.join("data", `${symbol}.json`);
fs.writeFileSync(file, JSON.stringify({ symbol, source: "synthetic", seed, ticks }));
console.log(`Wrote ${ticks.length.toLocaleString()} synthetic ticks (${days}d, vol ${annualVol}, momentum ${momentum}) → ${file}`);
