// ═══════════════════════════════════════════════════════
//  src/live/deriv.js — Deriv auth + WebSocket client
//
//  Auth flow (same as the old bot): PAT + App ID -> REST list
//  accounts -> REST OTP -> authenticated WebSocket URL.
//  Requests are matched to responses by req_id (not by msg_type),
//  so concurrent requests can never swallow each other's replies.
// ═══════════════════════════════════════════════════════
import { EventEmitter } from "node:events";
import WebSocket from "ws";

const REST_BASE = () => process.env.DERIV_REST_BASE || "https://api.derivws.com/trading/v1";

function headers(token, appId) {
  if (!token || token.startsWith("pat_your")) throw new Error("DERIV_PAT_TOKEN is not set");
  if (!appId || appId.startsWith("your_")) throw new Error("DERIV_APP_ID is not set");
  return { Authorization: `Bearer ${token}`, "Deriv-App-ID": appId, "Content-Type": "application/json" };
}

export async function getWebSocketUrl({ token, appId, mode }) {
  const base = REST_BASE();
  const r = await fetch(`${base}/options/accounts`, { headers: headers(token, appId) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Failed to fetch accounts [${r.status}]: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const accounts = data?.data?.accounts || data?.data || data?.accounts || (Array.isArray(data) ? data : null);
  if (!accounts?.length) throw new Error("No trading accounts found — check the PAT token scopes");

  const wantDemo = mode !== "real";
  const kind = (a) => (a.account_type || a.type || "").toLowerCase();
  const account = accounts.find(a => wantDemo ? /demo|virtual/.test(kind(a)) : /real|live/.test(kind(a)));
  // Never silently fall back to a different account type: a "demo" bot must not trade a real account.
  if (!account) throw new Error(`No ${wantDemo ? "demo" : "real"} account found on this token`);
  const id = account.account_id || account.accountId || account.id || account.loginid || account.login_id;
  if (!id) throw new Error(`Could not read account id (keys: ${Object.keys(account).join(", ")})`);

  const o = await fetch(`${base}/options/accounts/${id}/otp`, { method: "POST", headers: headers(token, appId) });
  const ot = await o.text();
  if (!o.ok) throw new Error(`OTP failed [${o.status}]: ${ot.slice(0, 300)}`);
  const url = JSON.parse(ot)?.data?.url || JSON.parse(ot)?.url;
  if (!url) throw new Error("No WebSocket URL in the OTP response");
  return { url, accountId: id };
}

export class DerivClient extends EventEmitter {
  constructor({ staleMs = 20000, requestTimeoutMs = 15000 } = {}) {
    super();
    this.ws = null; this.reqId = 0; this.pending = new Map();
    this.staleMs = staleMs; this.requestTimeoutMs = requestTimeoutMs;
    this.lastMsgAt = 0; this._timers = [];
  }

  get open() { return this.ws?.readyState === WebSocket.OPEN; }

  connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let opened = false;
      ws.on("open", () => {
        opened = true; this.lastMsgAt = Date.now();
        this._timers.push(setInterval(() => { if (this.open) ws.send(JSON.stringify({ ping: 1 })); }, 15000));
        // connection-loss detection: ticks flow every 1–2s, so silence means a dead socket
        this._timers.push(setInterval(() => {
          if (this.open && Date.now() - this.lastMsgAt > this.staleMs) { this.emit("log", "warn", "No data from Deriv — recycling the connection"); try { ws.terminate(); } catch {} }
        }, 5000));
        resolve();
      });
      ws.on("message", (raw) => this._onMessage(raw));
      ws.on("error", (e) => { if (!opened) reject(e); else this.emit("log", "error", `WebSocket error: ${e.message}`); });
      ws.on("close", (code) => {
        this._timers.forEach(clearInterval); this._timers = [];
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("connection closed")); }
        this.pending.clear();
        if (!opened) reject(new Error(`closed before open (${code})`));
        this.emit("close", code);
      });
    });
  }

  close() { try { this.ws?.terminate(); } catch {} }

  _onMessage(raw) {
    this.lastMsgAt = Date.now();
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.req_id && this.pending.has(m.req_id)) {
      const p = this.pending.get(m.req_id);
      // streams keep delivering under the same req_id after the first reply — only resolve once
      if (!p.done) {
        p.done = true; clearTimeout(p.timer);
        if (m.error) p.reject(Object.assign(new Error(m.error.message || "Deriv error"), { code: m.error.code, details: m.error }));
        else p.resolve(m);
        if (!p.keep) this.pending.delete(m.req_id);
      }
    } else if (m.error && !m.req_id) {
      this.emit("log", "warn", `Deriv error: ${m.error.message}`);
    }
    switch (m.msg_type) {
      case "tick": this.emit("tick", m.tick); break;
      case "proposal_open_contract": if (m.proposal_open_contract) this.emit("contract", m.proposal_open_contract); break;
      case "balance": this.emit("balance", m.balance); break;
      default: break;
    }
  }

  /** Sends a request; resolves with the first response carrying the same req_id. */
  send(payload, { stream = false } = {}) {
    if (!this.open) return Promise.reject(new Error("WebSocket is not open"));
    const req_id = ++this.reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(req_id); reject(new Error(`timeout waiting for ${Object.keys(payload)[0]}`)); }, this.requestTimeoutMs);
      this.pending.set(req_id, { resolve, reject, timer, keep: stream, done: false });
      this.ws.send(JSON.stringify({ ...payload, req_id }));
    });
  }
}
