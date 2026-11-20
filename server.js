// Маркет-мейкер на пробоях · 24/7 на Railway: торгует сервер, страница только показывает и управляет.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const PASSWORD = (process.env.UI_PASSWORD || "").trim();
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : path.join(__dirname, "data"));
const STORE = path.join(DATA_DIR, "breakout.json");
const ENV = (process.env.BYBIT_ENV || "mainnet").trim().toLowerCase() === "testnet" ? "testnet" : "mainnet";
const KEY = (process.env.BYBIT_API_KEY || "").trim();
const SECRET = (process.env.BYBIT_API_SECRET || "").trim();
const HAS_KEYS = !!(KEY && SECRET);
const REST = (process.env.TEST_BYBIT_URL || "").trim() || (ENV === "testnet" ? "https://api-testnet.bybit.com" : "https://api.bybit.com");
const UI = fs.readFileSync(path.join(__dirname, "ui.html"), "utf8");

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...a) => console.log(ts(), ...a);

// ---------------- storage: one JSON file on the Railway Volume (/data) ----------------
fs.mkdirSync(DATA_DIR, { recursive: true });
let DB = {};
try { DB = JSON.parse(fs.readFileSync(STORE, "utf8")); } catch (e) { DB = {}; }
let dirty = false;
const lsGet = (k, d) => (Object.prototype.hasOwnProperty.call(DB, k) ? JSON.parse(JSON.stringify(DB[k])) : d);
const lsSet = (k, v) => { DB[k] = v; dirty = true; };
function dump() {
  if (!dirty) return;
  dirty = false;
  try { fs.writeFileSync(STORE + ".tmp", JSON.stringify(DB)); fs.renameSync(STORE + ".tmp", STORE); } catch (e) { log("storage write failed", e.message); }
}
setInterval(dump, 2000);
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { dirty = true; dump(); process.exit(0); });

// ---------------- Bybit REST ----------------
let OFFSET = 0;
class BybitErr extends Error { constructor(m, code) { super(m); this.code = code; } }
async function bx(p, { method = "GET", query = null, body = null, auth = false } = {}, retry = true) {
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString() : "";
  const bodyStr = method === "POST" ? JSON.stringify(body || {}) : "";
  const headers = {};
  if (method === "POST") headers["Content-Type"] = "application/json";
  if (auth) {
    if (!HAS_KEYS) throw new BybitErr("нет BYBIT_API_KEY / BYBIT_API_SECRET в Railway → Variables");
    const t = String(Date.now() + OFFSET), recv = "10000";
    const sign = crypto.createHmac("sha256", SECRET).update(t + KEY + recv + (method === "GET" ? qs : bodyStr)).digest("hex");
    Object.assign(headers, { "X-BAPI-API-KEY": KEY, "X-BAPI-TIMESTAMP": t, "X-BAPI-RECV-WINDOW": recv, "X-BAPI-SIGN": sign });
  }
  let res;
  try { res = await fetch(REST + p + (qs ? "?" + qs : ""), { method, headers, body: method === "POST" ? bodyStr : undefined, signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw new BybitErr("нет связи с Bybit: " + (e.cause && e.cause.code || e.message)); }
  const j = await res.json().catch(() => ({}));
  if ((res.status === 403 || res.status === 451) && j.retCode === undefined)
    throw new BybitErr(`Bybit блокирует регион сервера (HTTP ${res.status}). Railway → Settings → Region: Europe или Asia, не US.`, 403);
  if (j.retCode === 10002 && retry) { await syncTime(); return bx(p, { method, query, body, auth }, false); }
  if (j.retCode !== 0) throw new BybitErr((j.retMsg || "HTTP " + res.status) + (j.retCode ? ` (${j.retCode})` : ""), j.retCode);
  return j.result || {};
}
async function syncTime() { try { const r = await bx("/v5/market/time"); OFFSET = Math.round(Number(r.timeNano) / 1e6) - Date.now(); } catch (e) { /* keep */ } }

// ---------------- the bot ----------------
const BOT = require("./bot").create({ bx, lsGet, lsSet, keys: () => HAS_KEYS, log: (m) => log("bot", m) });

function state() { return { env: ENV, keys: HAS_KEYS, password: !!PASSWORD, bot: BOT.view() }; }
async function act(b) {
  const what = String(b.what || "");
  if (b.cfg && typeof b.cfg === "object") BOT.setCfg(b.cfg);
  if (what === "save") return "Сохранено";
  if (what === "start") return await BOT.start();
  if (what === "stop") return await BOT.stop();
  if (what === "closeAll") return await BOT.closeAll();
  if (what === "reset") return BOT.resetStats();
  if (what === "test") {
    await bx("/v5/market/time");
    if (!HAS_KEYS) return "Связь с Bybit OK (ключей нет — только симуляция)";
    const w = await bx("/v5/account/wallet-balance", { query: { accountType: "UNIFIED" }, auth: true });
    const a = (w.list || [])[0] || {};
    return `Связь OK · депозит ${(+a.totalEquity || 0).toFixed(2)} USDT, свободно ${(+a.totalAvailableBalance || 0).toFixed(2)}`;
  }
  return "неизвестная команда";
}

// ---------------- web ----------------
function authorised(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const pass = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(pass), b2 = Buffer.from(PASSWORD);
  return a.length === b2.length && crypto.timingSafeEqual(a, b2);
}
function readBody(req) {
  return new Promise((resolve) => { let s = ""; req.on("data", c => { s += c; if (s.length > 1e5) req.destroy(); }); req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch (e) { resolve({}); } }); });
}
http.createServer(async (req, res) => {
  const json = (code, o) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(o)); };
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/healthz") return json(200, { ok: true });
    if (!authorised(req)) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Breakout MM"' }); return res.end("Нужен пароль (UI_PASSWORD)"); }
    if (url.pathname === "/api/state") return json(200, state());
    if (req.method === "POST" && url.pathname === "/api/act") {
      if (!PASSWORD) return json(200, { error: "Задайте UI_PASSWORD в Railway → Variables, чтобы управлять ботом со страницы" });
      const b = await readBody(req);
      try { const text = await act(b); dump(); return json(200, { text }); }
      catch (e) { return json(200, { error: String(e && e.message || e) }); }
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(UI);
  } catch (e) { return json(500, { error: String(e && e.message || e) }); }
}).listen(PORT, "0.0.0.0", () => log(`BREAKOUT MM :${PORT} · ${ENV} · Bybit keys ${HAS_KEYS ? "yes" : "NO"} · ${PASSWORD ? "password on" : "NO UI_PASSWORD (buttons locked)"} · storage ${STORE}`));

process.on("unhandledRejection", (e) => log("unhandledRejection", e && e.message || e));
process.on("uncaughtException", (e) => log("uncaughtException", e && e.stack || e));
syncTime(); setInterval(syncTime, 30 * 60000);
