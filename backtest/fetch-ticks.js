// Downloads real tick history from Deriv — run this ON YOUR OWN MACHINE with your PAT in .env
// (the sandbox this project was written in cannot reach Deriv, so this script is untested against
//  the live API; it pages backwards from "now" using ticks_history).
//   node backtest/fetch-ticks.js R_100 --days=7 [--mode=demo]
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { DerivClient, getWebSocketUrl } from "../src/live/deriv.js";

const args = process.argv.slice(2);
const symbol = args.find(a => !a.startsWith("--")) || "R_100";
const opt = Object.fromEntries(args.filter(a => a.startsWith("--")).map(a => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }));
const days = Number(opt.days ?? 7), mode = opt.mode || "demo";

const { url } = await getWebSocketUrl({ token: process.env.DERIV_PAT_TOKEN, appId: process.env.DERIV_APP_ID, mode });
const c = new DerivClient({ requestTimeoutMs: 30000 });
await c.connect(url);

const stopAt = Math.floor(Date.now() / 1000) - days * 86400;
let end = "latest", all = [];
while (true) {
  const r = await c.send({ ticks_history: symbol, style: "ticks", count: 5000, end });
  const times = r.history?.times || [], prices = r.history?.prices || [];
  if (!times.length) break;
  all = times.map((t, i) => [Number(t), Number(prices[i])]).concat(all);
  process.stdout.write(`\r${all.length.toLocaleString()} ticks, back to ${new Date(times[0] * 1000).toISOString()}   `);
  if (times[0] <= stopAt) break;
  end = times[0] - 1;
  await new Promise(r => setTimeout(r, 250));              // stay well inside rate limits
}
c.close();
const seen = new Set(), ticks = all.filter(([t]) => t >= stopAt && !seen.has(t) && seen.add(t)).sort((a, b) => a[0] - b[0]);
fs.mkdirSync("data", { recursive: true });
const file = path.join("data", `${symbol}.json`);
fs.writeFileSync(file, JSON.stringify({ symbol, source: "deriv", ticks }));
console.log(`\nSaved ${ticks.length.toLocaleString()} ticks → ${file}`);
