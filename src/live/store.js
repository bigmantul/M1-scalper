// ═══════════════════════════════════════════════════════
//  src/live/store.js — persistence (settings, engine state, trades, events)
//  Plain JSON files under DATA_DIR (default ./data). Writes are atomic.
// ═══════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { validateSettings, DEFAULT_SETTINGS } from "../core/settings.js";

export class Store {
  constructor(dir = process.env.DATA_DIR || path.resolve("data")) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.f = (n) => path.join(dir, n);
    this.events = [];                       // ring buffer for the dashboard
    this.trades = this._readJsonl("trades.jsonl");
  }

  _atomicWrite(file, text) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }
  _readJsonl(name) {
    try {
      return fs.readFileSync(this.f(name), "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  loadSettings() {
    try { return validateSettings(JSON.parse(fs.readFileSync(this.f("settings.json"), "utf8"))); }
    catch { return validateSettings(DEFAULT_SETTINGS); }
  }
  saveSettings(s) { this._atomicWrite(this.f("settings.json"), JSON.stringify(s, null, 2)); }

  loadState() { try { return JSON.parse(fs.readFileSync(this.f("state.json"), "utf8")); } catch { return null; } }
  saveState(state) { this._atomicWrite(this.f("state.json"), JSON.stringify(state)); }

  appendTrade(t) { this.trades.push(t); fs.appendFileSync(this.f("trades.jsonl"), JSON.stringify(t) + "\n"); }

  appendEvent(ev) {
    this.events.push(ev);
    if (this.events.length > 500) this.events.shift();
    const file = this.f("events.jsonl");
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + ".1");
      fs.appendFileSync(file, JSON.stringify(ev) + "\n");
    } catch { /* logging must never crash trading */ }
  }
}
