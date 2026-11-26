// A small fake of Deriv's REST (accounts / OTP) + WebSocket API, just enough to
// exercise the live bot end to end: ticks, balance, proposal/buy, contract
// updates, sell, portfolio, server-side stop-outs and dropped connections.
import http from "node:http";
import { WebSocketServer } from "ws";

export async function startFakeDeriv() {
  const fake = {
    quote: { bid: 100, ask: 100 }, symbol: "R_100",
    contracts: new Map(),          // id -> contract
    proposals: [], buys: [], sells: [], received: [],
    clients: new Set(), tickSubs: new Set(), pocSubs: new Map(),
    nextId: 1000, balance: 1000, failNextBuy: null, dropOnBuy: false,
    mode: "demo",
  };

  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url.endsWith("/options/accounts")) {
      return res.end(JSON.stringify({ data: { accounts: [{ account_id: "REAL1", account_type: "real" }, { account_id: "DEMO1", account_type: "demo" }] } }));
    }
    const m = req.url.match(/\/options\/accounts\/(\w+)\/otp$/);
    if (req.method === "POST" && m) {
      fake.mode = m[1] === "DEMO1" ? "demo" : "real";
      return res.end(JSON.stringify({ data: { url: `ws://127.0.0.1:${server.address().port}/ws?acct=${m[1]}` } }));
    }
    res.statusCode = 404; res.end("{}");
  });
  const wss = new WebSocketServer({ server, path: "/ws" });

  const poc = (c) => ({
    contract_id: c.id, contract_type: c.type, symbol: fake.symbol, underlying: fake.symbol, buy_price: c.stake, multiplier: c.multiplier,
    entry_spot: c.entry, entry_tick: c.entry, entry_tick_time: c.startTime, date_start: c.startTime,
    is_sold: c.sold ? 1 : 0, status: c.sold ? "sold" : "open",
    profit: c.sold ? c.profit : fake.pnl(c, c.type === "MULTUP" ? fake.quote.bid : fake.quote.ask),
    ...(c.sold ? { sell_spot: c.exit, exit_tick: c.exit, sell_time: c.sellTime, sell_price: c.stake + c.profit } : {}),
  });
  fake.pnl = (c, px) => +(c.stake * c.multiplier * ((px - c.entry) / c.entry) * (c.type === "MULTUP" ? 1 : -1)).toFixed(4);

  const pushPoc = (c) => { for (const [ws, ids] of fake.pocSubs) if (ids.has(c.id) && ws.readyState === 1) ws.send(JSON.stringify({ msg_type: "proposal_open_contract", proposal_open_contract: poc(c) })); };

  wss.on("connection", (ws) => {
    fake.clients.add(ws); fake.pocSubs.set(ws, new Set());
    ws.on("close", () => { fake.clients.delete(ws); fake.tickSubs.delete(ws); fake.pocSubs.delete(ws); });
    ws.on("message", (raw) => {
      const q = JSON.parse(raw), reply = (o) => ws.send(JSON.stringify({ ...o, req_id: q.req_id }));
      fake.received.push(q);
      if (q.ping) return reply({ msg_type: "ping", ping: "pong" });
      if (q.balance) return reply({ msg_type: "balance", balance: { balance: fake.balance, currency: "USD" } });
      if (q.ticks) { fake.tickSubs.add(ws); fake.symbol = q.ticks; return reply({ msg_type: "tick", tick: { symbol: q.ticks, epoch: 0, quote: fake.quote.bid, bid: fake.quote.bid, ask: fake.quote.ask } }); }
      if (q.forget_all) { fake.tickSubs.delete(ws); return reply({ msg_type: "forget_all", forget_all: [] }); }
      if (q.contracts_for) {
        if (!fake.ladder) return reply({ error: { code: "x", message: "contracts_for unavailable" } });
        return reply({ msg_type: "contracts_for", contracts_for: { available: [{ contract_category: "multiplier", contract_type: "MULTUP", multiplier_range: fake.ladder }, { contract_category: "multiplier", contract_type: "MULTDOWN", multiplier_range: fake.ladder }, { contract_category: "callput", contract_type: "CALL" }] } });
      }
      if (q.portfolio) return reply({ msg_type: "portfolio", portfolio: { contracts: [...fake.contracts.values()].filter(c => !c.sold).map(c => ({ contract_id: c.id, contract_type: c.type, symbol: fake.symbol, buy_price: c.stake, date_start: c.startTime })) } });
      if (q.proposal) {
        fake.proposals.push(q);
        if (fake.failNextBuy === "multiplier") { fake.failNextBuy = null; return reply({ error: { code: "ContractBuyValidationError", message: "Invalid multiplier. Accepts 10,20,30." } }); }
        return reply({ msg_type: "proposal", proposal: { id: `p${fake.proposals.length}`, ask_price: q.amount, _q: q } });
      }
      if (q.buy) {
        if (fake.dropOnBuy) { fake.dropOnBuy = false; return ws.terminate(); }         // order outcome unknown to the bot
        if (fake.failNextBuy === "stake") { fake.failNextBuy = null; return reply({ error: { code: "x", message: "Enter an amount equal to or lower than 5." } }); }
        const p = fake.proposals[fake.proposals.length - 1];
        const id = fake.nextId++;
        const c = { id, type: p.contract_type, stake: p.amount, multiplier: p.multiplier, stop: p.limit_order?.stop_loss ?? null,
          entry: p.contract_type === "MULTUP" ? fake.quote.ask : fake.quote.bid, startTime: fake.lastEpoch || 0, sold: false };
        fake.contracts.set(id, c); fake.buys.push(c);
        return reply({ msg_type: "buy", buy: { contract_id: id, buy_price: c.stake, start_time: c.startTime, transaction_id: id + 1 } });
      }
      if (q.proposal_open_contract) {
        const c = fake.contracts.get(q.contract_id);
        if (!c) return reply({ error: { code: "x", message: "Contract not found" } });
        if (q.subscribe) fake.pocSubs.get(ws).add(c.id);
        return reply({ msg_type: "proposal_open_contract", proposal_open_contract: poc(c) });
      }
      if (q.sell) {
        const c = fake.contracts.get(q.sell);
        if (!c || c.sold) return reply({ error: { code: "x", message: "This contract has already been sold." } });
        fake.sells.push(c.id);
        c.sold = true; c.exit = c.type === "MULTUP" ? fake.quote.bid : fake.quote.ask; c.sellTime = fake.lastEpoch || 0; c.profit = fake.pnl(c, c.exit);
        reply({ msg_type: "sell", sell: { sold_for: c.stake + c.profit, contract_id: c.id } });
        return pushPoc(c);
      }
    });
  });

  fake.pushTick = (epoch, bid, ask = bid, symbol = fake.symbol) => {
    fake.quote = { bid, ask }; fake.lastEpoch = epoch;
    for (const ws of fake.tickSubs) if (ws.readyState === 1) ws.send(JSON.stringify({ msg_type: "tick", tick: { symbol, epoch, quote: (bid + ask) / 2, bid, ask } }));
  };
  /** Deriv closes a contract on its own (server-side stop-loss). */
  fake.serverStop = (id, exit) => {
    const c = fake.contracts.get(id); c.sold = true; c.exit = exit; c.sellTime = fake.lastEpoch; c.profit = fake.pnl(c, exit); pushPoc(c);
  };
  /** A contract that exists at the broker but that the bot knows nothing about. */
  fake.addContract = (o) => { const id = fake.nextId++; const c = { id, type: "MULTUP", stake: 10, multiplier: 5, startTime: fake.lastEpoch || 0, sold: false, entry: 100, ...o }; fake.contracts.set(id, c); return c; };
  fake.dropAll = () => { for (const ws of fake.clients) ws.terminate(); };
  fake.url = () => `http://127.0.0.1:${server.address().port}`;
  fake.close = () => new Promise((res) => { for (const ws of fake.clients) ws.terminate(); wss.close(); server.close(() => res()); });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return fake;
}
