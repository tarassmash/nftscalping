// Маркет-мейкер на пробоях — серверный движок, торгует 24/7.
//  • раз в минуту: скан USDT-перпов → самые волатильные монеты (средний диапазон минутных свечей), без акций/ETF/стейблов;
//  • у каждой монеты коридор последних boxBars минут (high/low без текущей свечи);
//  • над коридором — условный BUY (пробой вверх), под коридором — условный SELL (пробой вниз);
//    каждую минуту коридор пересчитывается и заявки переставляются — «сетка идёт за ценой»;
//  • стоп sl % ставится на бирже сразу вместе с заявкой; после входа: трейлинг (включается при +act %, откат trail %) и потолок тейка tpMax %;
//  • одна позиция на монету, после выхода пауза cooldown мин; защита дня: при −dayStop % от депозита на начало дня новые входы не ставятся;
//  • Live выкл — симуляция на живых ценах (те же правила, комиссия taker 0.055 %).
"use strict";

const PFX = "mb_";   // все ордера этого бота: mb_e… вход
const FEE = 0.00055;
const DEF = { live: false, simEq: 100, budgetPct: 80, maxCoins: 6, lev: 3, minTurn: 5, maxCand: 40, boxBars: 15, minBox: 0.4, maxBox: 4,
  aiOn: true, aiTune: true, aiEvery: 5, aiMinConf: 60, aiTuneHours: 6,
  buf: 0.1, slip: 0.15, sl: 0.8, act: 0.5, trail: 0.3, tpMax: 3, cooldown: 3, dayStop: 10, longOn: true, shortOn: true, btcFilter: false };
const NUMS = ["simEq", "budgetPct", "maxCoins", "lev", "minTurn", "maxCand", "boxBars", "minBox", "maxBox", "buf", "slip", "sl", "act", "trail", "tpMax", "cooldown", "dayStop", "aiEvery", "aiMinConf", "aiTuneHours"];
const BOOLS = ["live", "longOn", "shortOn", "btcFilter", "aiOn", "aiTune"];
// в каких рамках ИИ может менять параметры
const AI_BOUNDS = { sl: [0.4, 2], act: [0.2, 2], trail: [0.1, 1], tpMax: [0.5, 6], minBox: [0.2, 2], maxBox: [1, 8], buf: [0, 0.5], boxBars: [5, 60], cooldown: [0, 30] };
// токенизированные акции, ETF, металлы, стейблы — у них гэпы и другая природа движения
const BLOCK = new Set(("SOXL SOXS UVXY TQQQ SQQQ MSTR NVDA AMDSTOCK AMD INTC MU MRVL CRWV NBIS SNDK SKHY SKHYNIX SAMSUNG SAMSUNGEM DRAM EWY TEM KORU MUU SNXX MSFU " +
  "AGPU CRCL SPCX OKTA LITE CBRS TSLA AAPL GOOGL AMZN META MSFT COIN HOOD PLTR NFLX SPY QQQ XAU XAG PAXG XAUT USDC USDE FDUSD DAI TUSD BUSD USD1 RLUSD PYUSD").split(" "));
const blocked = (sym) => { const b = sym.replace(/USDT$/, ""); return BLOCK.has(b) || /STOCK$/.test(b); };

function create(host) {
  const { bx, lsGet, lsSet, keys } = host;
  const now = () => Date.now(), sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const dayOf = (t) => new Date(t || now()).toISOString().slice(0, 10);

  const CFG = Object.assign({}, DEF, lsGet("mb.cfg", {}));
  const saveCfg = () => lsSet("mb.cfg", CFG);
  if (!lsGet("mb.back1", false)) { Object.assign(CFG, { act: 0.5, trail: 0.3, tpMax: 3, sl: 0.8, slip: 0.15 }); for (const k of ["pull", "chaseMax", "entryTimeout", "requote", "hardSl", "tp"]) delete CFG[k]; saveCfg(); lsSet("mb.back1", true); }   // возврат к первой версии
  let running = !!lsGet("mb.running", false);
  const TRADES = lsGet("mb.trades", []);              // закрытые сделки [{sym, side, open, close, entry, exit, pnl, why, live}]
  const saveTrades = () => { TRADES.length = Math.min(TRADES.length, 1000); lsSet("mb.trades", TRADES); };
  const OPEN = lsGet("mb.open", {});                  // sym -> открытая сделка этого бота {side, open, entry, qty, live, best, trailOn}
  const saveOpen = () => lsSet("mb.open", OPEN);
  const COOL = lsGet("mb.cool", {});                  // sym -> до какого времени не входить
  const DAY = Object.assign({ day: "", startEq: 0, paused: false }, lsGet("mb.day", {}));
  const saveDay = () => lsSet("mb.day", DAY);
  const LOG = lsGet("mb.log", []);
  let logSaved = 0;
  function log(msg, cls) {
    LOG.unshift([now(), String(msg), cls || "info"]); LOG.length = Math.min(LOG.length, 400);
    if (now() - logSaved > 2000) { logSaved = now(); lsSet("mb.log", LOG); }
    host.log && host.log(msg);
  }
  const isLive = () => !!(CFG.live && keys());
  const AI = Object.assign({ at: 0, picks: {}, note: "", err: "", tuneAt: now(), tuneNote: "", tuneN: 0, calls: 0 }, lsGet("mb.ai", {}));
  const saveAi = () => lsSet("mb.ai", AI);
  const aiReady = () => !!(CFG.aiOn && host.fal);
  const aiFresh = () => aiReady() && now() - AI.at < Math.max(3, CFG.aiEvery * 3) * 60000 && !AI.err;

  // ---------------- Bybit ----------------
  const pub = (p, q) => bx(p, { query: q });
  async function priv(method, p, params) {
    const call = () => bx(p, { method, query: method === "GET" ? params : null, body: method === "POST" ? params : null, auth: true });
    try { return await call(); } catch (e) { if (e.code === 10006) { await sleep(1500); return call(); } throw e; }
  }
  let chain = Promise.resolve();
  function enqueue(fn) { const p = chain.then(fn); chain = p.catch(() => {}).then(() => sleep(120)); return p; }
  const post = (p, params) => enqueue(() => priv("POST", p, params));

  const INST = {};
  async function inst(sym) {
    if (INST[sym]) return INST[sym];
    const r = await pub("/v5/market/instruments-info", { category: "linear", symbol: sym });
    const x = (r.list || [])[0]; if (!x) throw new Error("нет инструмента " + sym);
    return (INST[sym] = { tick: x.priceFilter.tickSize, step: x.lotSizeFilter.qtyStep, minQty: +x.lotSizeFilter.minOrderQty,
      minNot: +(x.lotSizeFilter.minNotionalValue || 5), maxLev: +((x.leverageFilter || {}).maxLeverage || 10) });
  }
  const decs = (s) => (String(s).split(".")[1] || "").length;
  function rnd(v, step, mode) {
    const s = +step, d = decs(step), f = mode === "up" ? Math.ceil : mode === "down" ? Math.floor : Math.round;
    return (f(v / s + (mode === "up" ? -1e-9 : 1e-9)) * s).toFixed(d);
  }
  const fmt = (v) => v == null || !Number.isFinite(+v) ? "—" : String(+(+v).toPrecision(6));
  const word = (side) => (side === "Buy" ? "лонг" : "шорт");

  // ---------------- state ----------------
  const C = {};   // sym -> { sym, last, hi, lo, box, atr, pos, orders: {Buy, Sell}, lev, hedge, sim: {Buy, Sell} }
  const coin = (sym) => C[sym] || (C[sym] = { sym, last: 0, hi: 0, lo: 0, box: 0, atr: 0, pos: null, orders: {}, lev: false, hedge: null, sim: {} });
  let ACTIVE = [], EQ = 0, AVAIL = 0, FOREIGN = new Set(), lastScanAt = 0, scanBusy = false, fastBusy = false, scanTimer = null, fastTimer = null;
  let BTC = { up: null, down: null, why: "—", at: 0 };

  async function btcTrend() {
    if (now() - BTC.at < 50000) return BTC;
    try {
      const k = await pub("/v5/market/kline", { category: "linear", symbol: "BTCUSDT", interval: "5", limit: 60 });
      const cl = (k.list || []).map(r => +r[4]).reverse();
      const ema = (n) => { const a = 2 / (n + 1); let e = cl[0]; for (const x of cl) e = x * a + e * (1 - a); return e; };
      const e9 = ema(9), e21 = ema(21), last = cl[cl.length - 1];
      BTC = { up: e9 > e21 && last > e21, down: e9 < e21 && last < e21, at: now(), why: `BTC ${last} · EMA9 ${e9.toFixed(0)} ${e9 < e21 ? "<" : ">"} EMA21 ${e21.toFixed(0)}` };
    } catch (e) { BTC.why = "BTC: " + e.message; }
    return BTC;
  }

  // ---------------- деньги ----------------
  async function equity() {
    if (isLive()) {
      try { const w = await priv("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" }); const a = (w.list || [])[0] || {}; EQ = +a.totalEquity || 0; AVAIL = +a.totalAvailableBalance || 0; }
      catch (e) { log("баланс: " + e.message, "err"); }
    } else {
      const open = Object.values(C).reduce((a, c) => a + (c.pos && !c.pos.live ? c.pos.upnl || 0 : 0), 0);
      EQ = (CFG.simEq || 100) + simPnl() + open; AVAIL = EQ;
    }
    const d = dayOf();
    if (DAY.day !== d && EQ > 0) { DAY.day = d; DAY.startEq = EQ; DAY.paused = false; saveDay(); }
    if (!DAY.paused && DAY.startEq > 0 && CFG.dayStop > 0 && EQ < DAY.startEq * (1 - CFG.dayStop / 100)) {
      DAY.paused = true; saveDay();
      log(`🛡 Защита дня: депозит ${EQ.toFixed(2)} < −${CFG.dayStop}% от ${DAY.startEq.toFixed(2)} — новые входы не ставлю до завтра (UTC). Открытые позиции ведутся со стопом и трейлингом.`, "err");
    }
    return EQ;
  }
  const simPnl = () => TRADES.reduce((a, t) => a + (t.live ? 0 : t.pnl || 0), 0);
  const notional = () => Math.max(6, EQ * CFG.budgetPct / 100 * Math.max(1, CFG.lev) / Math.max(1, CFG.maxCoins));

  // ---------------- скан: самые волатильные монеты + коридор ----------------
  async function scan() {
    if (scanBusy) return; scanBusy = true;
    try {
      await equity();
      const t = await pub("/v5/market/tickers", { category: "linear" });
      const rows = (t.list || []).filter(x => /USDT$/.test(x.symbol) && !blocked(x.symbol) && +x.turnover24h >= CFG.minTurn * 1e6 && +x.lastPrice > 0);
      for (const x of rows) if (C[x.symbol]) C[x.symbol].last = +x.lastPrice;
      const ch24 = {}; for (const x of rows) ch24[x.symbol] = +(+x.price24hPcnt * 100).toFixed(2);
      const cand = rows.sort((a, b) => Math.abs(+b.price24hPcnt) - Math.abs(+a.price24hPcnt)).slice(0, CFG.maxCand).map(x => x.symbol);
      const held = Object.keys(C).filter(s => C[s].pos && C[s].pos.size > 0);
      const want = [...new Set([...cand, ...held, ...ACTIVE])];
      const info = [];
      for (let i = 0; i < want.length; i += 8) {
        const part = await Promise.all(want.slice(i, i + 8).map(async (sym) => {
          try {
            const k = await pub("/v5/market/kline", { category: "linear", symbol: sym, interval: "1", limit: CFG.boxBars + 1 });
            const bars = (k.list || []).map(r => ({ h: +r[2], l: +r[3], c: +r[4] }));   // newest first
            if (bars.length < CFG.boxBars + 1) return null;
            const past = bars.slice(1, CFG.boxBars + 1);
            const hi = Math.max(...past.map(b => b.h)), lo = Math.min(...past.map(b => b.l)), mid = (hi + lo) / 2;
            const atr = past.reduce((a, b) => a + (b.h - b.l) / b.c * 100, 0) / past.length;
            return { sym, hi, lo, box: (hi - lo) / mid * 100, atr, last: bars[0].c, closes: bars.slice(0, CFG.boxBars + 1).map(b => b.c).reverse() };
          } catch (e) { return null; }
        }));
        info.push(...part.filter(Boolean));
      }
      for (const x of info) Object.assign(coin(x.sym), { hi: x.hi, lo: x.lo, box: x.box, atr: x.atr, last: x.last });
      const ok = info.filter(x => x.box >= CFG.minBox && x.box <= CFG.maxBox && !FOREIGN.has(x.sym)).sort((a, b) => b.atr - a.atr);
      if (CFG.btcFilter || aiReady()) await btcTrend();
      let next = ok.slice(0, CFG.maxCoins).map(x => x.sym);
      if (aiReady()) {
        if (now() - AI.at >= CFG.aiEvery * 60000 || AI.err) await aiDecide(ok.slice(0, Math.max(CFG.maxCoins * 2, 8)), ch24);
        if (aiFresh()) next = ok.filter(x => AI.picks[x.sym] && AI.picks[x.sym].side !== "none" && AI.picks[x.sym].conf >= CFG.aiMinConf)
          .sort((a, b) => AI.picks[b.sym].conf - AI.picks[a.sym].conf).slice(0, CFG.maxCoins).map(x => x.sym);
      }
      if (aiReady() && CFG.aiTune) aiTuneMaybe();
      for (const s of held) if (!next.includes(s)) next.push(s);
      const gone = ACTIVE.filter(s => !next.includes(s)), added = next.filter(s => !ACTIVE.includes(s));
      ACTIVE = next; lastScanAt = now();
      if (added.length || gone.length) log(`Скан: ${ACTIVE.map(s => s.replace("USDT", "")).join(", ") || "нет подходящих"}${added.length ? " · + " + added.join(", ") : ""}${gone.length ? " · − " + gone.join(", ") : ""}`);
      for (const s of gone) await clearEntries(s);
      for (const s of ACTIVE) { try { await place(s); } catch (e) { log(`${s}: ${e.message}`, "err"); } }
    } catch (e) { log("скан: " + e.message, "err"); }
    finally { scanBusy = false; }
  }

  // ---------------- 🧠 ИИ: какие монеты и в какую сторону торговать ----------------
  function tradeStats(sym) {
    const a = TRADES.filter(t => t.live === isLive() && t.pnl != null && (!sym || t.sym === sym)).slice(0, sym ? 10 : 40);
    return a.map(t => ({ sym: t.sym.replace("USDT", ""), side: t.side === "Buy" ? "long" : "short", pnl: +t.pnl.toFixed(3), why: t.why, min: Math.round((t.close - t.open) / 60000), agoMin: Math.round((now() - t.close) / 60000) }));
  }
  async function aiDecide(cands, ch24) {
    if (!cands.length) { AI.picks = {}; AI.at = now(); AI.err = ""; saveAi(); return; }
    const coins = cands.map(x => {
      const pos = (x.last - x.lo) / Math.max(1e-12, x.hi - x.lo);
      return { sym: x.sym.replace("USDT", ""), boxPct: +x.box.toFixed(2), atr1mPct: +x.atr.toFixed(2), posInBox: +pos.toFixed(2), ch24hPct: ch24[x.sym],
        closes1m: x.closes.map(v => +((v / x.closes[0] - 1) * 100).toFixed(2)), recent: tradeStats(x.sym) };
    });
    const prompt = `You pick trades for a Bybit USDT-perpetual BREAKOUT scalper. For each coin the bot keeps a range = high/low of the last ${CFG.boxBars} one-minute candles.
It enters LONG with a stop order ${CFG.buf}% above the range high, SHORT ${CFG.buf}% below the range low (conditional market order).
Exit: exchange stop ${CFG.sl}% against, trailing stop starting at +${CFG.act}% with ${CFG.trail}% callback, hard take +${CFG.tpMax}%. Leverage ${CFG.lev}x. Fees ~0.11% round trip.
Goal: maximise expected profit after fees. Prefer coins whose breakouts follow through (trend, momentum, compression before breakout) and avoid choppy fake-out coins or those that just lost money here.
BTC 5m trend: ${BTC.why}.
Coins (closes1m = % change of each 1m close vs the first, oldest first; posInBox 0 = at low, 1 = at high; recent = this bot's last trades on the coin):
${JSON.stringify(coins)}
Last trades overall: ${JSON.stringify(tradeStats().slice(0, 20))}
Answer ONLY one JSON object: {"picks":[{"sym":"ABC","side":"long|short|both|none","conf":0-100,"why":"коротко по-русски"}],"note":"одна фраза по-русски о рынке"}. Include every coin.`;
    try {
      const j = await host.fal(prompt, "You are a disciplined crypto scalping risk manager. Answer only with one JSON object.");
      const picks = {};
      for (const p of (j.picks || [])) {
        const sym = String(p.sym || "").toUpperCase().replace(/USDT$/, "") + "USDT";
        const side = ["long", "short", "both", "none"].includes(p.side) ? p.side : "none";
        picks[sym] = { side, conf: Math.max(0, Math.min(100, +p.conf || 0)), why: String(p.why || "").slice(0, 140) };
      }
      AI.picks = picks; AI.note = String(j.note || "").slice(0, 200); AI.at = now(); AI.err = ""; AI.calls++; saveAi();
      const yes = Object.entries(picks).filter(([, p]) => p.side !== "none" && p.conf >= CFG.aiMinConf);
      log(`🧠 ИИ: ${yes.length ? yes.map(([s, p]) => `${s.replace("USDT", "")} ${p.side === "long" ? "↑" : p.side === "short" ? "↓" : "↕"}${p.conf}`).join(", ") : "сейчас не торговать"}${AI.note ? " · " + AI.note : ""}`);
    } catch (e) {
      AI.err = e.message; AI.at = now(); saveAi();
      log(`🧠 ИИ недоступен (${e.message}) — торгую по обычным правилам`, "err");
    }
  }
  let tuning = false;
  async function aiTuneMaybe() {
    if (tuning || now() - (AI.tuneAt || 0) < CFG.aiTuneHours * 3600000) return;
    const since = TRADES.filter(t => t.live === isLive() && t.pnl != null && t.close > (AI.tuneAt || 0));
    if (since.length < 10) return;
    tuning = true;
    try {
      const cur = {}; for (const k of Object.keys(AI_BOUNDS)) cur[k] = CFG[k];
      const sum = since.reduce((a, t) => a + t.pnl, 0), byWhy = {};
      for (const t of since) { const w = byWhy[t.why] || (byWhy[t.why] = { n: 0, pnl: 0 }); w.n++; w.pnl = +(w.pnl + t.pnl).toFixed(3); }
      const prompt = `Tune a Bybit breakout scalper. Current params: ${JSON.stringify(cur)}. Allowed ranges: ${JSON.stringify(AI_BOUNDS)}.
Meaning: sl = stop %, act = trailing activation %, trail = trailing callback %, tpMax = hard take %, minBox/maxBox = allowed range width %, buf = entry offset beyond range %, boxBars = range length in 1m candles, cooldown = minutes before re-entering a coin.
Since the last tuning: ${since.length} trades, total PnL ${sum.toFixed(3)} USDT, by exit reason ${JSON.stringify(byWhy)}. Trades: ${JSON.stringify(tradeStats().slice(0, 40))}.
Change at most 3 params, small steps, only if the data supports it. Answer ONLY JSON: {"set":{"param":value},"why":"коротко по-русски"}.`;
      const j = await host.fal(prompt, "You are a careful quant tuning a trading bot. Answer only with one JSON object.");
      const ch = [];
      for (const [k, v] of Object.entries(j.set || {})) {
        if (!AI_BOUNDS[k] || !Number.isFinite(+v)) continue;
        const [lo, hi] = AI_BOUNDS[k], nv = +Math.min(hi, Math.max(lo, +v)).toFixed(k === "boxBars" || k === "cooldown" ? 0 : 2);
        if (nv !== CFG[k]) { ch.push(`${k} ${CFG[k]}→${nv}`); CFG[k] = nv; }
      }
      saveCfg();
      AI.tuneAt = now(); AI.tuneN++; AI.tuneNote = (ch.length ? ch.join(", ") : "без изменений") + (j.why ? " · " + String(j.why).slice(0, 200) : ""); saveAi();
      log(`🧠 ИИ-настройка по ${since.length} сделкам (${sum >= 0 ? "+" : ""}${sum.toFixed(2)} USDT): ${AI.tuneNote}`, "ok");
    } catch (e) { log("🧠 ИИ-настройка: " + e.message, "err"); }
    finally { tuning = false; }
  }

  // где должны стоять входы монеты сейчас (null — не ставить)
  function targets(c) {
    if (!running || DAY.paused) return {};
    if (c.pos && c.pos.size > 0) return {};
    if ((COOL[c.sym] || 0) > now()) return {};
    if (!ACTIVE.includes(c.sym) || !c.hi || !(c.box >= CFG.minBox && c.box <= CFG.maxBox)) return {};
    const t = {};
    let okLong = CFG.longOn && (!CFG.btcFilter || !BTC.down), okShort = CFG.shortOn && (!CFG.btcFilter || !BTC.up);
    if (aiFresh()) {   // ИИ решает сторону: long / short / both / none
      const p = AI.picks[c.sym];
      if (!p || p.conf < CFG.aiMinConf) return {};
      okLong = okLong && (p.side === "long" || p.side === "both");
      okShort = okShort && (p.side === "short" || p.side === "both");
    }
    const up = c.hi * (1 + CFG.buf / 100), dn = c.lo * (1 - CFG.buf / 100);
    if (okLong && c.last < up * 0.9995) t.Buy = up;      // цена уже за уровнем — не догоняю, жду новый коридор
    if (okShort && c.last > dn * 1.0005) t.Sell = dn;
    return t;
  }

  // ---------------- живые ордера ----------------
  async function prep(sym) {
    const c = coin(sym);
    if (!c.lev) {
      const i = await inst(sym), lev = Math.min(CFG.lev, i.maxLev);
      try { await post("/v5/position/set-leverage", { category: "linear", symbol: sym, buyLeverage: String(lev), sellLeverage: String(lev) }); }
      catch (e) { if (e.code !== 110043) log(`${sym}: плечо: ${e.message}`, "err"); }
      c.lev = true;
    }
    if (c.hedge == null) { try { const r = await priv("GET", "/v5/position/list", { category: "linear", symbol: sym }); c.hedge = (r.list || []).some(p => +p.positionIdx > 0); } catch (e) { c.hedge = false; } }
    return c;
  }
  const idxOf = (c, side) => (c.hedge ? (side === "Buy" ? 1 : 2) : 0);

  async function openEntries(sym) {
    const r = await priv("GET", "/v5/order/realtime", { category: "linear", symbol: sym, orderFilter: "StopOrder" });
    return (r.list || []).filter(o => (o.orderLinkId || "").startsWith(PFX + "e"));
  }

  async function place(sym) {
    const c = coin(sym), t = targets(c);
    if (!isLive()) { // симуляция: заявки просто запоминаются
      for (const side of ["Buy", "Sell"]) {
        if (t[side]) { if (!c.sim[side]) log(`${sym}: ${side === "Buy" ? "BUY выше" : "SELL ниже"} ${fmt(t[side])} (коридор ${fmt(c.lo)}–${fmt(c.hi)}, ${c.box.toFixed(2)}%)`); c.sim[side] = t[side]; }
        else delete c.sim[side];
      }
      c.orders = { Buy: c.sim.Buy, Sell: c.sim.Sell };
      return;
    }
    await prep(sym);
    if (OPEN[sym]) return;
    // позиция могла открыться между циклами — по монете с позицией входы не ставлю
    try { const pr = await priv("GET", "/v5/position/list", { category: "linear", symbol: sym }); if ((pr.list || []).some(p => +p.size > 0)) return; }
    catch (e) { return; }
    const i = await inst(sym), have = await openEntries(sym);
    const shown = {};
    for (const side of ["Buy", "Sell"]) {
      const mine = have.filter(o => o.side === side);
      const tp = t[side];
      if (!tp) { for (const o of mine) await cancel(sym, o.orderId); continue; }
      const trig = rnd(tp, i.tick, side === "Buy" ? "up" : "down");
      const px = rnd(tp * (1 + (side === "Buy" ? 1 : -1) * CFG.slip / 100), i.tick, side === "Buy" ? "up" : "down");
      const sl = rnd(tp * (1 + (side === "Buy" ? -1 : 1) * CFG.sl / 100), i.tick, side === "Buy" ? "down" : "up");
      let qty = +rnd(notional() / tp, i.step, "down");
      if (qty < i.minQty) qty = i.minQty;
      if (qty * tp < i.minNot) qty = +rnd(i.minNot * 1.02 / tp, i.step, "up");
      for (const o of mine.slice(1)) await cancel(sym, o.orderId);
      const o = mine[0];
      if (o && Math.abs(+o.triggerPrice / +trig - 1) < 0.0005) { shown[side] = +o.triggerPrice; continue; }   // на месте
      if (o) {
        try { await post("/v5/order/amend", { category: "linear", symbol: sym, orderId: o.orderId, triggerPrice: trig, price: px, stopLoss: sl }); shown[side] = +trig; continue; }
        catch (e) { await cancel(sym, o.orderId); }
      }
      try {
        await post("/v5/order/create", { category: "linear", symbol: sym, side, orderType: "Limit", qty: String(qty), price: px, triggerPrice: trig,
          triggerDirection: side === "Buy" ? 1 : 2, triggerBy: "LastPrice", timeInForce: "IOC", positionIdx: idxOf(c, side),
          stopLoss: sl, slTriggerBy: "MarkPrice", slOrderType: "Market", tpslMode: "Full", orderLinkId: PFX + "e" + now() + Math.floor(Math.random() * 1e4) });
        shown[side] = +trig;
        log(`${sym}: ${side === "Buy" ? "BUY на пробой вверх" : "SELL на пробой вниз"} @ ${trig} · ${qty} (коридор ${fmt(c.lo)}–${fmt(c.hi)}, ${c.box.toFixed(2)}%) · стоп ${sl}`);
      } catch (e) {
        if (e.code === 110092 || e.code === 110093) continue;   // цена уже у уровня — следующий скан
        log(`${sym}: ${side}: ${e.message}`, "err");
      }
    }
    c.orders = shown;
  }
  async function cancel(sym, orderId) {
    try { await post("/v5/order/cancel", { category: "linear", symbol: sym, orderId }); } catch (e) { if (e.code !== 110001) log(`${sym}: отмена: ${e.message}`, "err"); }
  }
  async function clearEntries(sym) {
    const c = coin(sym); c.sim = {}; c.orders = {};
    if (!isLive()) return;
    try { for (const o of await openEntries(sym)) await cancel(sym, o.orderId); } catch (e) { log(`${sym}: ${e.message}`, "err"); }
  }

  // ---------------- быстрый цикл: позиции, трейлинг, выходы ----------------
  async function fast() {
    if (fastBusy) return; fastBusy = true;
    try { if (isLive()) await fastLive(); else await fastSim(); }
    catch (e) { log("цикл: " + e.message, "err"); }
    finally { fastBusy = false; }
  }

  async function fastLive() {
    const r = await priv("GET", "/v5/position/list", { category: "linear", settleCoin: "USDT", limit: 200 });
    const seen = new Set(), foreign = new Set();
    for (const p of r.list || []) {
      if (!(+p.size > 0)) continue;
      const sym = p.symbol;
      if (!OPEN[sym] && !(C[sym] && C[sym].orders && (C[sym].orders.Buy || C[sym].orders.Sell))) { foreign.add(sym); continue; }   // чужая позиция — не трогаю
      seen.add(sym);
      const c = coin(sym);
      c.pos = { side: p.side, size: +p.size, avg: +p.avgPrice, upnl: +p.unrealisedPnl || 0, idx: +p.positionIdx || 0, live: true, trail: +p.trailingStop || 0, sl: +p.stopLoss || 0 };
      c.last = +p.markPrice || c.last;
      if (!OPEN[sym]) {
        OPEN[sym] = { side: p.side, open: now(), entry: +p.avgPrice, qty: +p.size, live: true, managed: false }; saveOpen();
        log(`${sym}: ✅ пробой — ${word(p.side)} ${p.size} @ ${fmt(p.avgPrice)}`, "ok");
      }
      if (!OPEN[sym].managed) await manage(sym);
    }
    FOREIGN = foreign;
    for (const sym of Object.keys(OPEN)) {
      if (!OPEN[sym].live || seen.has(sym)) continue;
      await closedLive(sym);
    }
  }

  async function manage(sym) {
    const c = coin(sym), o = OPEN[sym], L = c.pos.side === "Buy", i = await inst(sym), avg = c.pos.avg;
    for (const x of await openEntries(sym)) await cancel(sym, x.orderId);   // второй вход (с другой стороны) больше не нужен
    c.orders = {};
    const q = (k, mode) => rnd(avg * (1 + (L ? 1 : -1) * k / 100), i.tick, mode);
    const body = { category: "linear", symbol: sym, tpslMode: "Full", positionIdx: c.pos.idx,
      stopLoss: rnd(avg * (1 + (L ? -1 : 1) * CFG.sl / 100), i.tick, L ? "down" : "up"), slTriggerBy: "MarkPrice", slOrderType: "Market",
      trailingStop: rnd(avg * CFG.trail / 100, i.tick, "up"), activePrice: q(CFG.act, L ? "up" : "down") };
    if (CFG.tpMax > 0) Object.assign(body, { takeProfit: q(CFG.tpMax, L ? "up" : "down"), tpTriggerBy: "LastPrice", tpOrderType: "Market" });
    try {
      await post("/v5/position/trading-stop", body);
      o.managed = true; saveOpen();
      log(`${sym}: стоп ${body.stopLoss} · трейлинг ${CFG.trail}% с ${body.activePrice}${body.takeProfit ? " · тейк макс " + body.takeProfit : ""}`);
    } catch (e) {
      if (e.code === 34040) { o.managed = true; saveOpen(); return; }   // уже стоит
      log(`${sym}: стоп/трейлинг: ${e.message}`, "err");
      if (/activePrice|trailing/i.test(e.message)) {   // цена уже ушла за уровень активации — ставлю трейлинг сразу
        delete body.activePrice;
        try { await post("/v5/position/trading-stop", body); o.managed = true; saveOpen(); } catch (e2) { log(`${sym}: трейлинг: ${e2.message}`, "err"); }
      }
    }
  }

  async function closedLive(sym) {
    const o = OPEN[sym]; let pnl = null, exit = null;
    for (let k = 0; k < 3 && pnl == null; k++) {
      if (k) await sleep(3000);   // биржа записывает закрытую сделку не мгновенно
      try {
        const r = await priv("GET", "/v5/position/closed-pnl", { category: "linear", symbol: sym, startTime: o.open - 60000, limit: 20 });
        const l = r.list || [];
        if (l.length) { pnl = l.reduce((a, x) => a + (+x.closedPnl || 0), 0); exit = +l[0].avgExitPrice || null; }
      } catch (e) { /* без цифры */ }
    }
    finish(sym, o, exit, pnl, "биржа");
  }

  function finish(sym, o, exit, pnl, why) {
    const tr = { sym, side: o.side, open: o.open, close: now(), entry: o.entry, exit, qty: o.qty, pnl: pnl == null ? null : +pnl.toFixed(4), why, live: !!o.live };
    TRADES.unshift(tr); saveTrades();
    delete OPEN[sym]; saveOpen();
    const c = coin(sym); c.pos = null; c.sim = {}; c.orders = {};
    COOL[sym] = now() + CFG.cooldown * 60000; lsSet("mb.cool", COOL);
    const p = tr.pnl;
    log(`${sym}: ${word(o.side)} закрыт${exit ? " @ " + fmt(exit) : ""} · ${why} · ${p == null ? "PnL —" : (p >= 0 ? "+" : "") + p.toFixed(3) + " USDT"}`, p != null && p < 0 ? "err" : "ok");
  }

  // ---------------- симуляция ----------------
  async function fastSim() {
    const syms = [...new Set([...ACTIVE, ...Object.keys(OPEN)])];
    if (!syms.length) return;
    const t = await pub("/v5/market/tickers", { category: "linear" });
    const px = {}; for (const x of t.list || []) px[x.symbol] = +x.lastPrice;
    for (const sym of syms) {
      const c = coin(sym), p = px[sym]; if (!p) continue;
      c.last = p;
      const o = OPEN[sym];
      if (!o) {
        for (const side of ["Buy", "Sell"]) {
          const trig = c.sim[side]; if (!trig) continue;
          if (side === "Buy" ? p >= trig : p <= trig) {
            const lim = trig * (1 + (side === "Buy" ? 1 : -1) * CFG.slip / 100);
            if (side === "Buy" ? p > lim : p < lim) continue;   // проскочило дальше лимита — IOC не исполнился
            const entry = p, qty = notional() / entry;
            OPEN[sym] = { side, open: now(), entry, qty, live: false, best: entry, trailOn: false,
              sl: entry * (1 + (side === "Buy" ? -1 : 1) * CFG.sl / 100), tp: CFG.tpMax > 0 ? entry * (1 + (side === "Buy" ? 1 : -1) * CFG.tpMax / 100) : 0 };
            saveOpen(); c.sim = {}; c.orders = {};
            log(`${sym}: ✅ пробой (сим) — ${word(side)} @ ${fmt(entry)} · стоп ${fmt(OPEN[sym].sl)}`, "ok");
            break;
          }
        }
      }
      const s = OPEN[sym];
      if (!s || s.live) continue;
      const L = s.side === "Buy", dir = L ? 1 : -1;
      if (L ? p > s.best : p < s.best) s.best = p;
      const gain = (p / s.entry - 1) * 100 * dir;
      if (!s.trailOn && gain >= CFG.act) { s.trailOn = true; log(`${sym}: 🎯 трейлинг включён (+${gain.toFixed(2)}%)`); }
      let why = null, exit = p;
      if (L ? p <= s.sl : p >= s.sl) { why = "стоп"; exit = s.sl; }
      else if (s.tp && (L ? p >= s.tp : p <= s.tp)) { why = "тейк макс"; exit = s.tp; }
      else if (s.trailOn && (s.best / p - 1) * 100 * dir >= CFG.trail) why = "трейлинг";
      c.pos = { side: s.side, size: s.qty, avg: s.entry, upnl: (p - s.entry) * dir * s.qty, live: false };
      if (why) { const pnl = (exit - s.entry) * dir * s.qty - (s.entry + exit) * s.qty * FEE; finish(sym, s, exit, pnl, why); }
      else saveOpen();
    }
  }

  // ---------------- управление ----------------
  function loops() {
    clearInterval(scanTimer); clearInterval(fastTimer);
    scanTimer = setInterval(() => { if (running) scan(); }, +process.env.BOT_SCAN_MS || 60000);
    fastTimer = setInterval(() => { if (running || Object.keys(OPEN).length) fast(); }, isLive() ? 4000 : 3000);
  }
  // снять обычные (не условные) лимитки этого бота, оставшиеся от версии «только мейкер»
  async function cleanMakerOrders() {
    if (!isLive()) return;
    try {
      const r = await priv("GET", "/v5/order/realtime", { category: "linear", settleCoin: "USDT", limit: 50 });
      for (const o of r.list || []) if ((o.orderLinkId || "").startsWith(PFX) && !(+o.triggerPrice > 0)) await post("/v5/order/cancel", { category: "linear", symbol: o.symbol, orderId: o.orderId }).catch(() => {});
    } catch (e) { log("очистка ордеров: " + e.message, "err"); }
  }
  async function start() {
    if (CFG.live && !keys()) throw new Error("Нет BYBIT_API_KEY / BYBIT_API_SECRET — Live недоступен");
    running = true; lsSet("mb.running", true);
    await cleanMakerOrders();
    log(`СТАРТ ${isLive() ? "LIVE" : "симуляция"}: до ${CFG.maxCoins} монет · коридор ${CFG.boxBars} мин (${CFG.minBox}–${CFG.maxBox}%) · вход +${CFG.buf}% за границей · стоп ${CFG.sl}% · трейлинг с +${CFG.act}% откат ${CFG.trail}% · тейк макс ${CFG.tpMax}% · плечо x${CFG.lev} · ${CFG.budgetPct}% депозита · защита дня −${CFG.dayStop}%`, "ok");
    loops(); scan();
    return isLive() ? "Запущено — LIVE" : "Запущено — симуляция";
  }
  async function stop() {
    running = false; lsSet("mb.running", false);
    for (const s of Object.keys(C)) await clearEntries(s);
    log("СТОП: входы сняты. Открытые позиции остаются со стопом и трейлингом на бирже.");
    return "Остановлено";
  }
  async function closeAll() {
    let n = 0;
    for (const sym of Object.keys(OPEN)) {
      const o = OPEN[sym], c = coin(sym);
      if (o.live) {
        if (!c.pos) continue;
        try { await post("/v5/order/create", { category: "linear", symbol: sym, side: c.pos.side === "Buy" ? "Sell" : "Buy", orderType: "Market", qty: String(c.pos.size), reduceOnly: true, positionIdx: c.pos.idx, orderLinkId: PFX + "x" + now() }); n++; }
        catch (e) { log(`${sym}: закрытие: ${e.message}`, "err"); }
      } else {
        const p = c.last || o.entry, dir = o.side === "Buy" ? 1 : -1;
        finish(sym, o, p, (p - o.entry) * dir * o.qty - (o.entry + p) * o.qty * FEE, "вручную"); n++;
      }
    }
    return n ? `Закрываю ${n} поз.` : "Открытых позиций нет";
  }
  function setCfg(x) {
    const wasLive = isLive();
    for (const k of NUMS) if (x[k] != null && x[k] !== "" && Number.isFinite(+x[k])) CFG[k] = +x[k];
    for (const k of BOOLS) if (x[k] != null) CFG[k] = !!x[k];
    CFG.lev = Math.min(Math.max(1, CFG.lev), 10); CFG.maxCoins = Math.min(Math.max(1, Math.round(CFG.maxCoins)), 30);
    CFG.boxBars = Math.min(Math.max(3, Math.round(CFG.boxBars)), 200); CFG.budgetPct = Math.min(Math.max(5, CFG.budgetPct), 95);
    saveCfg();
    if (wasLive !== isLive()) { for (const c of Object.values(C)) { c.sim = {}; c.orders = {}; c.lev = false; } if (running) loops(); }
  }
  function resetStats() { TRADES.length = 0; saveTrades(); return "Статистика очищена"; }

  function stats() {
    const d = dayOf(), mode = isLive();
    const mine = TRADES.filter(t => t.live === mode && t.pnl != null);
    const sum = (a) => a.reduce((s, t) => s + t.pnl, 0);
    const today = mine.filter(t => dayOf(t.close) === d);
    const wins = (a) => a.filter(t => t.pnl > 0).length;
    return { today: +sum(today).toFixed(3), todayN: today.length, todayW: wins(today), total: +sum(mine).toFixed(3), totalN: mine.length, totalW: wins(mine) };
  }
  function view() {
    const coins = [...new Set([...ACTIVE, ...Object.keys(OPEN)])].map(s => {
      const c = coin(s);
      return { sym: s, last: c.last, hi: c.hi, lo: c.lo, box: c.box, atr: c.atr, buy: c.orders.Buy || null, sell: c.orders.Sell || null,
        pos: c.pos && c.pos.size > 0 ? { side: c.pos.side, size: c.pos.size, avg: c.pos.avg, upnl: c.pos.upnl } : null,
        trailOn: OPEN[s] ? !!OPEN[s].trailOn : false, cool: Math.max(0, (COOL[s] || 0) - now()) };
    });
    const ai = { ready: aiReady(), hasKey: !!host.fal, fresh: aiFresh(), at: AI.at, note: AI.note, err: AI.err, tuneAt: AI.tuneAt, tuneNote: AI.tuneNote, picks: AI.picks };
    return { ai, running, live: isLive(), cfg: CFG, eq: EQ, avail: AVAIL, day: DAY, stats: stats(), coins, trades: TRADES.filter(t => t.live === isLive()).slice(0, 100),
      log: LOG.slice(0, 200), lastScanAt, notional: notional(), btc: CFG.btcFilter ? BTC.why : null };
  }

  // ---------------- старт процесса ----------------
  (async () => {
    await equity();
    if (running) { log("Перезапуск сервера — продолжаю"); await cleanMakerOrders(); loops(); scan(); }
    else if (Object.keys(OPEN).length) loops();
  })();

  return { start, stop, closeAll, setCfg, resetStats, view };
}

module.exports = { create, DEF, blocked };
