// Скальпер по стакану — серверный движок, торгует 24/7. Только лимитки-мейкеры (PostOnly), без маркета.
//  • раз в минуту: скан USDT-перпов по тикерам (оборот, размах за сутки, узкий спред), без акций/ETF/стейблов; 🧠 нейросеть выбирает монеты и сторону;
//  • каждые ~1.5 с по каждой монете: стакан (50 уровней) и последние сделки — без свечей, сигнал раньше графика:
//      дисбаланс стакана I = (заявки на покупку − на продажу) / сумма в пределах depthPct % от цены,
//      поток F = (агрессивные покупки − продажи) / сумма за последние flowSec сек;
//  • вход: I ≥ imb и F ≥ flow (шорт — наоборот) confirm раз подряд, спред ≤ maxSpread % → PostOnly-лимитка в начало стакана, догоняет цену;
//    стакан развернулся, цена ушла дальше chaseMax % или прошло entryTimeout сек — вход отменён;
//  • выход: лимитка тейка +tp %; трейлинг (с +act %, откат trail %, не хуже +minProfit %); стакан развернулся против — выход лимиткой;
//    риск 1:slRR — при −tp×slRR % выход лимиткой с догоном; аварийный стоп hardSl % на бирже (0 = выкл);
//  • Live выкл — симуляция на живом стакане (комиссия мейкера 0.02 %).
"use strict";

const PFX = "mb_";
const MAKER = 0.0002, TAKER = 0.00055;
const DEF = { live: false, simEq: 100, budgetPct: 80, maxCoins: 6, lev: 3, minTurn: 5, maxCand: 40, boxBars: 15, minBox: 0.4, maxBox: 4,
  buf: 0.1, pull: 0.1, chaseMax: 1, entryTimeout: 60, requote: 2, minProfit: 0.2, slRR: 1, hardSl: 0, tp: 0.6, act: 0.35, trail: 0.2, cooldown: 3, dayStop: 10,
  imb: 0.35, flow: 0.3, depthPct: 0.3, flowSec: 10, confirm: 2, maxSpread: 0.08, flipExit: true,
  aiOn: true, aiTune: true, aiEvery: 5, aiMinConf: 60, aiTuneHours: 6,
  longOn: true, shortOn: true, btcFilter: false };
const NUMS = ["simEq", "budgetPct", "maxCoins", "lev", "minTurn", "maxCand", "boxBars", "minBox", "maxBox", "buf", "pull", "chaseMax", "entryTimeout", "requote",
  "minProfit", "slRR", "hardSl", "imb", "flow", "depthPct", "flowSec", "confirm", "maxSpread", "tp", "act", "trail", "cooldown", "dayStop", "aiEvery", "aiMinConf", "aiTuneHours"];
const BOOLS = ["live", "longOn", "shortOn", "btcFilter", "aiOn", "aiTune", "flipExit"];
// в каких рамках ИИ может менять параметры
const AI_BOUNDS = { tp: [0.2, 2], act: [0.15, 1.5], trail: [0.05, 0.8], minProfit: [0.08, 0.8], imb: [0.15, 0.8], flow: [0.1, 0.9], depthPct: [0.1, 1], flowSec: [3, 60], confirm: [1, 5], maxSpread: [0.02, 0.3], cooldown: [0, 30] };
const BLOCK = new Set(("SOXL SOXS UVXY TQQQ SQQQ MSTR NVDA AMDSTOCK AMD INTC MU MRVL CRWV NBIS SNDK SKHY SKHYNIX SAMSUNG SAMSUNGEM DRAM EWY TEM KORU MUU SNXX MSFU " +
  "AGPU CRCL SPCX OKTA LITE CBRS TSLA AAPL GOOGL AMZN META MSFT COIN HOOD PLTR NFLX SPY QQQ XAU XAG PAXG XAUT USDC USDE FDUSD DAI TUSD BUSD USD1 RLUSD PYUSD").split(" "));
const blocked = (sym) => { const b = sym.replace(/USDT$/, ""); return BLOCK.has(b) || /STOCK$/.test(b); };

function create(host) {
  const { bx, lsGet, lsSet, keys } = host;
  const now = () => Date.now(), sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const dayOf = (t) => new Date(t || now()).toISOString().slice(0, 10);

  const CFG = Object.assign({}, DEF, lsGet("mb.cfg", {}));
  if (!lsGet("mb.book1", false)) { Object.assign(CFG, { entryTimeout: 20, chaseMax: 0.3, tp: 0.4, act: 0.25, trail: 0.12, minProfit: 0.15, slRR: 1, btcFilter: false, minTurn: 10 }); lsSet("mb.book1", true); lsSet("mb.plus1", true); }   // стакан: короткие тейки
  if (!lsGet("mb.plus1", false)) { Object.assign(CFG, { pull: 0.1, chaseMax: 1, entryTimeout: 60, requote: 2, tp: 0.6, act: 0.35, trail: 0.2, hardSl: 0, minProfit: 0.2 }); for (const k of ["sl", "tpMax", "slip"]) delete CFG[k]; lsSet("mb.plus1", true); }   // выход только в плюс, только лимитки
  const saveCfg = () => lsSet("mb.cfg", CFG);
  saveCfg();
  let running = !!lsGet("mb.running", false);
  const TRADES = lsGet("mb.trades", []);
  const saveTrades = () => { TRADES.length = Math.min(TRADES.length, 1000); lsSet("mb.trades", TRADES); };
  const OPEN = lsGet("mb.open", {});                  // sym -> {side, open, entry, qty, live, best, trailOn, fee}
  const saveOpen = () => lsSet("mb.open", OPEN);
  const COOL = lsGet("mb.cool", {});
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
  function enqueue(fn) { const p = chain.then(fn); chain = p.catch(() => {}).then(() => sleep(100)); return p; }
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
  const opp = (side) => (side === "Buy" ? "Sell" : "Buy");

  // ---------------- state ----------------
  const C = {};   // sym -> { sym, last, bid, ask, hi, lo, box, atr, pos, work, lev, hedge }
  const coin = (sym) => C[sym] || (C[sym] = { sym, last: 0, bid: 0, ask: 0, hi: 0, lo: 0, box: 0, atr: 0, pos: null, work: null, lev: false, hedge: null });
  let ACTIVE = [], EQ = 0, AVAIL = 0, FOREIGN = new Set(), lastScanAt = 0, scanBusy = false, fastBusy = false, scanTimer = null, fastTimer = null, eqAt = 0;
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
  const simPnl = () => TRADES.reduce((a, t) => a + (t.live ? 0 : t.pnl || 0), 0);
  async function equity() {
    if (isLive()) {
      try { const w = await priv("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" }); const a = (w.list || [])[0] || {}; EQ = +a.totalEquity || 0; AVAIL = +a.totalAvailableBalance || 0; }
      catch (e) { log("баланс: " + e.message, "err"); }
    } else {
      const open = Object.values(C).reduce((a, c) => a + (c.pos && !c.pos.live ? c.pos.upnl || 0 : 0), 0);
      EQ = (CFG.simEq || 100) + simPnl() + open; AVAIL = EQ;
    }
    eqAt = now();
    const d = dayOf();
    if (DAY.day !== d && EQ > 0) { DAY.day = d; DAY.startEq = EQ; DAY.paused = false; saveDay(); }
    if (!DAY.paused && DAY.startEq > 0 && CFG.dayStop > 0 && EQ < DAY.startEq * (1 - CFG.dayStop / 100)) {
      DAY.paused = true; saveDay();
      log(`🛡 Защита дня: депозит ${EQ.toFixed(2)} < −${CFG.dayStop}% от ${DAY.startEq.toFixed(2)} — новые входы не ставлю до завтра (UTC). Открытые позиции веду до выхода.`, "err");
    }
    return EQ;
  }
  const notional = () => Math.max(6, EQ * CFG.budgetPct / 100 * Math.max(1, CFG.lev) / Math.max(1, CFG.maxCoins));

  // ---------------- стакан и поток сделок ----------------
  async function bookRead(sym) {
    const c = coin(sym);
    const [ob, tr] = await Promise.all([
      pub("/v5/market/orderbook", { category: "linear", symbol: sym, limit: 50 }),
      pub("/v5/market/recent-trade", { category: "linear", symbol: sym, limit: 100 }),
    ]);
    const b = (ob.b || []).map(x => [+x[0], +x[1]]), a = (ob.a || []).map(x => [+x[0], +x[1]]);
    if (!b.length || !a.length) return c;
    c.bid = b[0][0]; c.ask = a[0][0];
    const mid = (c.bid + c.ask) / 2, win = mid * CFG.depthPct / 100;
    const bv = b.filter(x => x[0] >= mid - win).reduce((s, x) => s + x[0] * x[1], 0);
    const av = a.filter(x => x[0] <= mid + win).reduce((s, x) => s + x[0] * x[1], 0);
    c.I = bv + av > 0 ? (bv - av) / (bv + av) : 0;
    c.depth = bv + av;
    c.spread = (c.ask - c.bid) / mid * 100;
    const list = tr.list || [], since = now() - CFG.flowSec * 1000;
    let buy = 0, sell = 0, n = 0;
    for (const t of list) { if (+t.time < since) continue; const v = +t.price * +t.size; if (t.side === "Buy") buy += v; else sell += v; n++; }
    c.F = buy + sell > 0 && n >= 3 ? (buy - sell) / (buy + sell) : 0;
    c.flowUsd = buy + sell;
    c.last = list.length ? +list[0].price : mid;
    // сигналы подряд
    const upSig = c.I >= CFG.imb && c.F >= CFG.flow, dnSig = c.I <= -CFG.imb && c.F <= -CFG.flow;
    c.sigL = upSig ? (c.sigL || 0) + 1 : 0;
    c.sigS = dnSig ? (c.sigS || 0) + 1 : 0;
    c.bookAt = now();
    return c;
  }

  // ---------------- скан: ликвидные подвижные монеты (по тикерам, без свечей) ----------------
  async function scan() {
    if (scanBusy) return; scanBusy = true;
    try {
      await equity();
      const t = await pub("/v5/market/tickers", { category: "linear" });
      const rows = (t.list || []).filter(x => /USDT$/.test(x.symbol) && !blocked(x.symbol) && +x.turnover24h >= CFG.minTurn * 1e6 && +x.lastPrice > 0 && +x.bid1Price > 0)
        .map(x => { const mid = (+x.bid1Price + +x.ask1Price) / 2; return { sym: x.symbol, ch24: +(+x.price24hPcnt * 100).toFixed(2), range24: (+x.highPrice24h - +x.lowPrice24h) / +x.lastPrice * 100,
          spread: (+x.ask1Price - +x.bid1Price) / mid * 100, turn: +x.turnover24h }; })
        .filter(x => x.spread <= CFG.maxSpread && !FOREIGN.has(x.sym))
        .sort((a, b) => b.range24 - a.range24).slice(0, CFG.maxCand);
      const held = Object.keys(OPEN);
      let next = rows.slice(0, CFG.maxCoins).map(x => x.sym);
      if (CFG.btcFilter) await btcTrend();
      if (aiReady()) {
        if (now() - AI.at >= CFG.aiEvery * 60000 || AI.err) {
          const cands = rows.slice(0, Math.max(CFG.maxCoins * 2, 8));
          await Promise.all(cands.map(x => bookRead(x.sym).catch(() => null)));
          await aiDecide(cands);
        }
        if (aiFresh()) next = rows.filter(x => AI.picks[x.sym] && AI.picks[x.sym].side !== "none" && AI.picks[x.sym].conf >= CFG.aiMinConf)
          .sort((a, b) => AI.picks[b.sym].conf - AI.picks[a.sym].conf).slice(0, CFG.maxCoins).map(x => x.sym);
        if (CFG.aiTune) aiTuneMaybe();
      }
      for (const s of [...held, ...Object.keys(C).filter(s => C[s].work)]) if (!next.includes(s)) next.push(s);
      const gone = ACTIVE.filter(s => !next.includes(s)), added = next.filter(s => !ACTIVE.includes(s));
      ACTIVE = next; lastScanAt = now();
      if (added.length || gone.length) log(`Скан: ${ACTIVE.map(s => s.replace("USDT", "")).join(", ") || "нет подходящих"}${added.length ? " · + " + added.join(", ") : ""}${gone.length ? " · − " + gone.join(", ") : ""}`);
    } catch (e) { log("скан: " + e.message, "err"); }
    finally { scanBusy = false; }
  }

  // ---------------- лучшая цена мейкера ----------------
  // покупка: на тик ниже ask (≥ bid) — в книге, PostOnly не исполнится как тейкер; продажа: на тик выше bid
  function makerPx(c, side, i) {
    const t = +i.tick;
    if (!(c.bid > 0 && c.ask > 0)) return null;
    return side === "Buy" ? rnd(Math.max(c.bid, c.ask - t), i.tick, "down") : rnd(Math.min(c.ask, c.bid + t), i.tick, "up");
  }

  // вход: в начало стакана — на тик лучше лучшей заявки своей стороны, но мейкером (не пересекая спред)
  function entryPx(c, w, i) {
    const t = +i.tick, L = w.side === "Buy";
    if (!(c.bid > 0 && c.ask > 0)) return null;
    return L ? rnd(Math.min(c.ask - t, c.bid + t), i.tick, "down") : rnd(Math.max(c.bid + t, c.ask - t), i.tick, "up");
  }

  // выход: лучшая цена мейкера, но не хуже входа + minProfit % — в минус не выхожу (кроме ручного «закрыть всё»)
  function exitPx(c, w, i) {
    const m = makerPx(c, w.side, i), o = OPEN[c.sym]; if (!m || !o || w.noFloor) return m;
    const L = o.side === "Buy", floor = o.entry * (1 + (L ? 1 : -1) * CFG.minProfit / 100);
    return L ? rnd(Math.max(+m, floor), i.tick, "up") : rnd(Math.min(+m, floor), i.tick, "down");
  }

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
  const idxOf = (c, side, reduce) => (c.hedge ? ((side === "Buy") !== !!reduce ? 1 : 2) : 0);

  // ---------------- живая лимитка: поставить / переставить / проверить ----------------
  async function liveQuote(c, w) {
    const i = await inst(c.sym);
    const px = w.kind === "entry" ? entryPx(c, w, i) : exitPx(c, w, i); if (!px) return;
    if (w.orderId) {
      // ордер ещё в книге?
      let o = null;
      try { const r = await priv("GET", "/v5/order/realtime", { category: "linear", symbol: c.sym, orderId: w.orderId }); o = (r.list || [])[0] || null; } catch (e) { /* проверю в следующий раз */ return; }
      if (o && o.orderStatus === "Filled") { w.full = true; return; }   // исполнен целиком — позиция появится в следующем цикле
      if (o && ["New", "PartiallyFilled", "Untriggered"].includes(o.orderStatus)) {
        if (o.price === px || now() - w.placedAt < CFG.requote * 1000) return;
        const left = +o.qty - (+o.cumExecQty || 0);
        try { await post("/v5/order/amend", { category: "linear", symbol: c.sym, orderId: w.orderId, price: px }); w.placedAt = now(); w.px = px; return; }
        catch (e) { if (e.code !== 10001 && e.code !== 110001) log(`${c.sym}: перестановка: ${e.message}`, "err"); }
        if (!(left > 0)) return;
      }
      w.orderId = null;   // исполнен, отклонён PostOnly (цена прошла через уровень) или снят — ставлю заново
    }
    let qty;
    if (w.kind === "exit") qty = c.pos ? c.pos.size : 0;
    else {
      qty = +rnd(notional() / +px, i.step, "down");
      if (qty < i.minQty) qty = i.minQty;
      if (qty * +px < i.minNot) qty = +rnd(i.minNot * 1.02 / +px, i.step, "up");
      if (c.pos && c.pos.size > 0) qty = Math.max(0, +rnd(qty - c.pos.size, i.step, "down"));   // частично набрали — добираю остаток
    }
    if (!(qty > 0)) return;
    try {
      const body = { category: "linear", symbol: c.sym, side: w.side, orderType: "Limit", qty: String(qty), price: px, timeInForce: "PostOnly",
        positionIdx: idxOf(c, w.side, w.kind === "exit"), orderLinkId: PFX + (w.kind === "exit" ? "x" : "e") + now() + Math.floor(Math.random() * 1e4) };
      if (w.kind === "exit") body.reduceOnly = true;
      const r = await post("/v5/order/create", body);
      w.orderId = r.orderId; w.placedAt = now(); w.px = px; w.n = (w.n || 0) + 1;
    } catch (e) {
      if (e.code === 110017 || e.code === 110025) { if (w.kind === "exit") w.done = true; return; }   // позиции уже нет
      log(`${c.sym}: лимитка ${w.side}: ${e.message}`, "err");
    }
  }
  async function liveCancel(c, w) {
    if (!w || !w.orderId) return;
    try { await post("/v5/order/cancel", { category: "linear", symbol: c.sym, orderId: w.orderId }); } catch (e) { /* уже нет */ }
    w.orderId = null;
  }

  // ---------------- решения ----------------
  // ---------------- 🧠 ИИ: какие монеты и в какую сторону торговать ----------------
  function tradeStats(sym) {
    const a = TRADES.filter(t => t.live === isLive() && t.pnl != null && (!sym || t.sym === sym)).slice(0, sym ? 10 : 40);
    return a.map(t => ({ sym: t.sym.replace("USDT", ""), side: t.side === "Buy" ? "long" : "short", pnl: +t.pnl.toFixed(3), why: t.why, min: Math.round((t.close - t.open) / 60000), agoMin: Math.round((now() - t.close) / 60000) }));
  }
  async function aiDecide(cands) {
    if (!cands.length) { AI.picks = {}; AI.at = now(); AI.err = ""; saveAi(); return; }
    const coins = cands.map(x => { const c = coin(x.sym); return { sym: x.sym.replace("USDT", ""), ch24hPct: x.ch24, range24hPct: +x.range24.toFixed(2), spreadPct: +x.spread.toFixed(3),
      bookImbalance: c.I != null ? +c.I.toFixed(2) : null, tradeFlow: c.F != null ? +c.F.toFixed(2) : null, flowUsd10s: c.flowUsd != null ? Math.round(c.flowUsd) : null,
      depthUsd: c.depth != null ? Math.round(c.depth) : null, recent: tradeStats(x.sym) }; });
    const prompt = `You pick coins for a Bybit USDT-perpetual ORDER-BOOK scalper (no charts). Every ~1.5 s it reads the order book and the last trades of each picked coin.
It goes LONG when book imbalance >= ${CFG.imb} (bids vs asks within ${CFG.depthPct}% of price) AND taker flow >= ${CFG.flow} over ${CFG.flowSec}s, ${CFG.confirm}x in a row; SHORT mirrored.
Entry and exit only with maker limit orders at the front of the book. Exit: maker take +${CFG.tp}%, trailing from +${CFG.act}% (callback ${CFG.trail}%), exit when the book flips against; risk 1:${CFG.slRR} (−${(CFG.tp * CFG.slRR).toFixed(2)}%). Leverage ${CFG.lev}x. Maker fees ~0.04% round trip.
Goal: maximise trades that reach the take fast. Prefer liquid coins with tight spread, real depth and order flow that follows through; avoid thin books that get spoofed, coins in a one-way crash against the side, or coins that just lost money here.
Coins (bookImbalance and tradeFlow −1..+1 right now; recent = this bot's last trades on the coin): ${JSON.stringify(coins)}
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
      const prompt = `Tune a Bybit order-book scalper (maker limits only). Current params: ${JSON.stringify(cur)}. Allowed ranges: ${JSON.stringify(AI_BOUNDS)}.
Meaning: tp = maker take %, act = trailing activation %, trail = trailing callback %, minProfit = minimum trailing exit profit %, the stop is −tp × ${CFG.slRR} (risk 1:${CFG.slRR}), imb = order-book imbalance threshold, flow = taker-flow threshold, depthPct = book window % around price, flowSec = flow window sec, confirm = signals in a row, maxSpread = max spread %, cooldown = minutes before re-entering a coin.
Since the last tuning: ${since.length} trades, total PnL ${sum.toFixed(3)} USDT, by exit reason ${JSON.stringify(byWhy)}. Trades: ${JSON.stringify(tradeStats().slice(0, 40))}.
Change at most 3 params, small steps, only if the data supports it. Answer ONLY JSON: {"set":{"param":value},"why":"коротко по-русски"}.`;
      const j = await host.fal(prompt, "You are a careful quant tuning a trading bot. Answer only with one JSON object.");
      const ch = [];
      for (const [k, v] of Object.entries(j.set || {})) {
        if (!AI_BOUNDS[k] || !Number.isFinite(+v)) continue;
        const [lo, hi] = AI_BOUNDS[k], nv = +Math.min(hi, Math.max(lo, +v)).toFixed(["confirm", "flowSec", "cooldown"].includes(k) ? 0 : 2);
        if (nv !== CFG[k]) { ch.push(`${k} ${CFG[k]}→${nv}`); CFG[k] = nv; }
      }
      saveCfg();
      AI.tuneAt = now(); AI.tuneN++; AI.tuneNote = (ch.length ? ch.join(", ") : "без изменений") + (j.why ? " · " + String(j.why).slice(0, 200) : ""); saveAi();
      log(`🧠 ИИ-настройка по ${since.length} сделкам (${sum >= 0 ? "+" : ""}${sum.toFixed(2)} USDT): ${AI.tuneNote}`, "ok");
    } catch (e) { log("🧠 ИИ-настройка: " + e.message, "err"); }
    finally { tuning = false; }
  }

  function wantEntry(c) {
    if (!running || DAY.paused || OPEN[c.sym] || (c.pos && c.pos.size > 0) || c.work) return null;
    if ((COOL[c.sym] || 0) > now() || !ACTIVE.includes(c.sym) || FOREIGN.has(c.sym) || !c.bookAt || now() - c.bookAt > 5000) return null;
    if (Object.keys(OPEN).length + Object.values(C).filter(x => x.work && x.work.kind === "entry").length >= CFG.maxCoins) return null;
    if (!(c.spread <= CFG.maxSpread)) return null;
    let okL = CFG.longOn && (!CFG.btcFilter || !BTC.down), okS = CFG.shortOn && (!CFG.btcFilter || !BTC.up);
    if (aiFresh()) {
      const a = AI.picks[c.sym];
      if (!a || a.conf < CFG.aiMinConf) return null;
      okL = okL && (a.side === "long" || a.side === "both"); okS = okS && (a.side === "short" || a.side === "both");
    }
    if (okL && c.sigL >= CFG.confirm) return { side: "Buy", level: c.ask };
    if (okS && c.sigS >= CFG.confirm) return { side: "Sell", level: c.bid };
    return null;
  }
  const bookTxt = (c) => `стакан ${c.I >= 0 ? "+" : ""}${(c.I || 0).toFixed(2)} · поток ${c.F >= 0 ? "+" : ""}${(c.F || 0).toFixed(2)}`;
  // вход ещё актуален? (стакан за нас, цена рядом, время не вышло)
  function entryValid(c, w) {
    if (now() - w.start > CFG.entryTimeout * 1000) return "время вышло";
    const p = c.last, L = w.side === "Buy";
    if (L ? p > w.level * (1 + CFG.chaseMax / 100) : p < w.level * (1 - CFG.chaseMax / 100)) return "цена ушла";
    if (L ? (c.I < 0 && c.F < 0) : (c.I > 0 && c.F > 0)) return "стакан развернулся";
    return null;
  }
  function exitWhy(c, o) {
    const p = c.last, L = o.side === "Buy", dir = L ? 1 : -1;
    if (!p) return null;
    if (o.best == null) o.best = o.entry;
    if (L ? p > o.best : p < o.best) o.best = p;
    const gain = (p / o.entry - 1) * 100 * dir;
    if (!o.trailOn && gain >= CFG.act) { o.trailOn = true; log(`${c.sym}: 🎯 трейлинг включён (+${gain.toFixed(2)}%)`); }
    if (CFG.slRR > 0 && CFG.tp > 0 && gain <= -CFG.tp * CFG.slRR) return "стоп 1:" + CFG.slRR;
    if (o.trailOn && (o.best / p - 1) * 100 * dir >= CFG.trail && gain >= CFG.minProfit) return "трейлинг";
    if (CFG.flipExit && (L ? c.sigS : c.sigL) >= CFG.confirm) return gain >= CFG.minProfit ? "стакан против, в плюс" : "стакан против";
    return null;
  }

  // ---------------- быстрый цикл ----------------
  async function fast() {
    if (fastBusy) return; fastBusy = true;
    try {
      const syms = [...new Set([...ACTIVE, ...Object.keys(OPEN), ...Object.keys(C).filter(s => C[s].work)])];
      await Promise.all(syms.map(s => bookRead(s).catch(e => { coin(s).bookAt = 0; })));
      if (now() - eqAt > 15000) await equity();
      if (isLive()) await fastLive(); else fastSim();
    } catch (e) { log("цикл: " + e.message, "err"); }
    finally { fastBusy = false; }
  }

  async function fastLive() {
    const r = await priv("GET", "/v5/position/list", { category: "linear", settleCoin: "USDT", limit: 200 });
    const live = {}, foreign = new Set();
    for (const p of r.list || []) {
      if (!(+p.size > 0)) continue;
      const c = C[p.symbol];
      if (!OPEN[p.symbol] && !(c && c.work)) { foreign.add(p.symbol); continue; }   // чужая позиция — не трогаю
      live[p.symbol] = p;
    }
    FOREIGN = foreign;
    for (const sym of [...new Set([...ACTIVE, ...Object.keys(OPEN), ...Object.keys(C).filter(s => C[s].work)])]) {
      const c = coin(sym), p = live[sym];
      c.pos = p ? { side: p.side, size: +p.size, avg: +p.avgPrice, upnl: +p.unrealisedPnl || 0, idx: +p.positionIdx || 0, live: true } : null;
      try {
        const w = c.work;
        if (w && w.kind === "entry") {
          if (c.pos) {   // набрали (хотя бы частично): вход закрыт, позиция ведётся
            const bad = entryValid(c, w);
            if (bad || w.full || c.pos.size * c.pos.avg >= notional() * 0.9) { await liveCancel(c, w); c.work = null; await opened(c); }
            else await liveQuote(c, w);
          } else {
            const bad = w.full ? null : entryValid(c, w);
            if (w.full) { if (now() - w.start > CFG.entryTimeout * 1000 + 15000) c.work = null; }   // жду, пока позиция появится
            else if (bad) { await liveCancel(c, w); c.work = null; COOL[sym] = now() + 30000; log(`${sym}: вход ${word(w.side)} отменён — ${bad}`); }
            else await liveQuote(c, w);
          }
          continue;
        }
        if (w && w.kind === "exit") {
          if (!c.pos || w.done) { await liveCancel(c, w); c.work = null; if (OPEN[sym]) await closedLive(sym, w.why); continue; }
          await liveQuote(c, w);
          continue;
        }
        if (OPEN[sym]) {
          if (!c.pos) { await closedLive(sym, OPEN[sym].takeId ? "тейк" : "биржа"); continue; }   // тейк исполнился / аварийный стоп / вручную
          OPEN[sym].qty = c.pos.size;
          const why = exitWhy(c, OPEN[sym]); saveOpen();
          if (why) { await cancelTake(c); c.work = { kind: "exit", side: opp(OPEN[sym].side), why, start: now(), noFloor: /^стоп|^стакан против$/.test(why) }; log(`${sym}: выход (${why}) лимиткой @ ~${fmt(c.last)}`); await liveQuote(c, c.work); }
          else await ensureTake(c);
          continue;
        }
        const e = wantEntry(c);
        if (e) {
          await prep(sym);
          c.work = { kind: "entry", side: e.side, level: e.level, start: now() };
          log(`${sym}: ${e.side === "Buy" ? "↑ покупатели давят" : "↓ продавцы давят"} (${bookTxt(c)}) — ${e.side} лимиткой у ${fmt(e.level)}`);
          await liveQuote(c, c.work);
        }
      } catch (err) { log(`${sym}: ${err.message}`, "err"); }
    }
  }

  // лимитка тейка: стоит на бирже всё время, пока позиция открыта и бот не выходит сам
  async function ensureTake(c) {
    const o = OPEN[c.sym]; if (!o || !(CFG.tp > 0) || !c.pos) return;
    const i = await inst(c.sym), L = o.side === "Buy";
    const px = rnd(o.entry * (1 + (L ? 1 : -1) * CFG.tp / 100), i.tick, L ? "up" : "down");
    if (o.takeId) {
      try {
        const r = await priv("GET", "/v5/order/realtime", { category: "linear", symbol: c.sym, orderId: o.takeId }); const x = (r.list || [])[0];
        if (x && ["New", "PartiallyFilled"].includes(x.orderStatus)) {
          const left = +x.qty - (+x.cumExecQty || 0);
          if (Math.abs(left - c.pos.size) > 1e-12 && c.pos.size > 0) await post("/v5/order/amend", { category: "linear", symbol: c.sym, orderId: o.takeId, qty: String(c.pos.size) }).catch(() => {});
          return;
        }
        if (x && x.orderStatus === "Filled") return;
      } catch (e) { return; }
    }
    if ((L ? c.bid : c.ask) && (L ? +px <= c.bid : +px >= c.ask)) return;   // цена уже за тейком — выйдет трейлинг
    try {
      const r = await post("/v5/order/create", { category: "linear", symbol: c.sym, side: opp(o.side), orderType: "Limit", qty: String(c.pos.size), price: px, timeInForce: "PostOnly",
        reduceOnly: true, positionIdx: c.pos.idx || idxOf(c, opp(o.side), true), orderLinkId: PFX + "t" + now() + Math.floor(Math.random() * 1e4) });
      if (!o.takeId) log(`${c.sym}: тейк лимиткой @ ${px} (+${CFG.tp}%)`);
      o.takeId = r.orderId; saveOpen();
    } catch (e) { if (e.code !== 110017) log(`${c.sym}: тейк: ${e.message}`, "err"); }
  }
  async function cancelTake(c) {
    const o = OPEN[c.sym]; if (!o || !o.takeId) return;
    try { await post("/v5/order/cancel", { category: "linear", symbol: c.sym, orderId: o.takeId }); } catch (e) { /* уже нет */ }
    o.takeId = null; saveOpen();
  }

  async function opened(c) {
    const sym = c.sym, p = c.pos;
    OPEN[sym] = { side: p.side, open: now(), entry: p.avg, qty: p.size, live: true, best: p.avg, trailOn: false }; saveOpen();
    log(`${sym}: ✅ ${word(p.side)} ${p.size} @ ${fmt(p.avg)} (мейкер)`, "ok");
    if (CFG.hardSl > 0) {
      const i = await inst(sym), L = p.side === "Buy";
      const sl = rnd(p.avg * (1 + (L ? -1 : 1) * CFG.hardSl / 100), i.tick, L ? "down" : "up");
      try { await post("/v5/position/trading-stop", { category: "linear", symbol: sym, tpslMode: "Full", positionIdx: p.idx, stopLoss: sl, slTriggerBy: "MarkPrice", slOrderType: "Market" }); }
      catch (e) { if (e.code !== 34040) log(`${sym}: аварийный стоп: ${e.message}`, "err"); }
    }
    await ensureTake(c);
  }

  async function closedLive(sym, why) {
    const o = OPEN[sym]; let pnl = null, exit = null;
    for (let k = 0; k < 3 && pnl == null; k++) {
      if (k) await sleep(3000);
      try {
        const r = await priv("GET", "/v5/position/closed-pnl", { category: "linear", symbol: sym, startTime: o.open - 60000, limit: 20 });
        const l = r.list || [];
        if (l.length) { pnl = l.reduce((a, x) => a + (+x.closedPnl || 0), 0); exit = +l[0].avgExitPrice || null; }
      } catch (e) { /* без цифры */ }
    }
    finish(sym, o, exit, pnl, why);
  }

  function finish(sym, o, exit, pnl, why) {
    const tr = { sym, side: o.side, open: o.open, close: now(), entry: o.entry, exit, qty: o.qty, pnl: pnl == null ? null : +pnl.toFixed(4), why, live: !!o.live };
    TRADES.unshift(tr); saveTrades();
    delete OPEN[sym]; saveOpen();
    const c = coin(sym); c.pos = null; c.work = null;
    COOL[sym] = now() + CFG.cooldown * 60000; lsSet("mb.cool", COOL);
    const p = tr.pnl;
    log(`${sym}: ${word(o.side)} закрыт${exit ? " @ " + fmt(exit) : ""} · ${why} · ${p == null ? "PnL —" : (p >= 0 ? "+" : "") + p.toFixed(3) + " USDT"}`, p != null && p < 0 ? "err" : "ok");
  }

  // ---------------- симуляция: лимитка исполняется, когда цена сделки дошла до неё ----------------
  function fastSim() {
    for (const sym of [...new Set([...ACTIVE, ...Object.keys(OPEN), ...Object.keys(C).filter(s => C[s].work)])]) {
      const c = coin(sym); if (!c.last) continue;
      const tick = INST[sym] ? +INST[sym].tick : c.last * 1e-5;
      const mpx = (side) => side === "Buy" ? Math.max(c.bid, c.ask - tick) : Math.min(c.ask, c.bid + tick);
      const w = c.work;
      const filled = (w) => w.px != null && (w.side === "Buy" ? c.last <= w.px : c.last >= w.px);
      const epx = (w) => w.side === "Buy" ? Math.min(c.ask - tick, c.bid + tick) : Math.max(c.bid + tick, c.ask - tick);
      const xpx = (w) => { const m = mpx(w.side), o = OPEN[sym]; if (!o || w.noFloor) return m; const L = o.side === "Buy", f = o.entry * (1 + (L ? 1 : -1) * CFG.minProfit / 100); return L ? Math.max(m, f) : Math.min(m, f); };
      const requote = (w) => { if (w.px == null || now() - w.placedAt >= CFG.requote * 1000) { w.px = w.kind === "entry" ? epx(w) : xpx(w); w.placedAt = now(); } };
      if (w && w.kind === "entry") {
        if (filled(w)) {
          const entry = w.px, qty = notional() / entry;
          OPEN[sym] = { side: w.side, open: now(), entry, qty, live: false, best: entry, trailOn: false, fee: entry * qty * MAKER,
            take: CFG.tp > 0 ? entry * (1 + (w.side === "Buy" ? 1 : -1) * CFG.tp / 100) : 0 };
          c.work = null; saveOpen();
          log(`${sym}: ✅ ${word(w.side)} @ ${fmt(entry)} (сим, мейкер) · тейк @ ${fmt(OPEN[sym].take)}`, "ok");
        } else {
          const bad = entryValid(c, w);
          if (bad) { c.work = null; COOL[sym] = now() + 30000; log(`${sym}: вход ${word(w.side)} отменён — ${bad}`); }
          else requote(w);
        }
      } else if (w && w.kind === "exit") {
        const o = OPEN[sym];
        if (!o) { c.work = null; }
        else if (filled(w)) { const dir = o.side === "Buy" ? 1 : -1; finish(sym, o, w.px, (w.px - o.entry) * dir * o.qty - o.fee - w.px * o.qty * MAKER, w.why); continue; }
        else requote(w);
      }
      const o = OPEN[sym];
      if (o && !o.live) {
        const dir = o.side === "Buy" ? 1 : -1;
        c.pos = { side: o.side, size: o.qty, avg: o.entry, upnl: (c.last - o.entry) * dir * o.qty, live: false };
        if (CFG.hardSl > 0 && (c.last / o.entry - 1) * 100 * dir <= -CFG.hardSl) {   // аварийный стоп биржи (маркет)
          finish(sym, o, c.last, (c.last - o.entry) * dir * o.qty - o.fee - c.last * o.qty * TAKER, "аварийный стоп"); continue;
        }
        if (!c.work && o.take && (o.side === "Buy" ? c.last >= o.take : c.last <= o.take)) {   // лимитка тейка исполнилась
          finish(sym, o, o.take, (o.take - o.entry) * dir * o.qty - o.fee - o.take * o.qty * MAKER, "тейк"); continue;
        }
        if (!c.work) {
          const why = exitWhy(c, o); saveOpen();
          if (why) { c.work = { kind: "exit", side: opp(o.side), why, start: now(), noFloor: /^стоп|^стакан против$/.test(why) }; requote(c.work); log(`${sym}: выход (${why}) лимиткой @ ~${fmt(c.work.px)}`); }
        }
        continue;
      }
      c.pos = null;
      const e = wantEntry(c);
      if (e) {
        c.work = { kind: "entry", side: e.side, level: e.level, start: now() }; requote(c.work);
        if (!INST[sym]) inst(sym).catch(() => {});
        log(`${sym}: ${e.side === "Buy" ? "↑ покупатели давят" : "↓ продавцы давят"} (${bookTxt(c)}) — ${e.side} лимиткой @ ${fmt(c.work.px)} (сим)`);
      }
    }
  }

  // ---------------- управление ----------------
  function loops() {
    clearInterval(scanTimer); clearInterval(fastTimer);
    scanTimer = setInterval(() => { if (running) scan(); }, +process.env.BOT_SCAN_MS || 60000);
    fastTimer = setInterval(() => { if (running || Object.keys(OPEN).length) fast(); }, 1500);
  }
  async function cleanStale() {   // после перезапуска: снять висящие лимитки этого бота
    if (!isLive()) return;
    try {
      const r = await priv("GET", "/v5/order/realtime", { category: "linear", settleCoin: "USDT", limit: 50 });
      for (const o of r.list || []) if ((o.orderLinkId || "").startsWith(PFX)) await post("/v5/order/cancel", { category: "linear", symbol: o.symbol, orderId: o.orderId }).catch(() => {});
      for (const sym of Object.keys(OPEN)) {   // старые стоп/трейлинг/тейк на бирже (маркет) снимаю — выход только лимиткой в плюс
        OPEN[sym].takeId = null;
        if (CFG.hardSl > 0) continue;
        for (const idx of [0, 1, 2]) await post("/v5/position/trading-stop", { category: "linear", symbol: sym, tpslMode: "Full", positionIdx: idx, stopLoss: "0", takeProfit: "0", trailingStop: "0" }).catch(() => {});
      }
      saveOpen();
    } catch (e) { log("очистка ордеров: " + e.message, "err"); }
  }
  async function start() {
    if (CFG.live && !keys()) throw new Error("Нет BYBIT_API_KEY / BYBIT_API_SECRET — Live недоступен");
    running = true; lsSet("mb.running", true);
    await cleanStale();
    log(`СТАРТ ${isLive() ? "LIVE" : "симуляция"} · по стакану, только лимитки-мейкеры: до ${CFG.maxCoins} монет · вход: стакан ≥ ${CFG.imb} и поток ≥ ${CFG.flow} (${CFG.flowSec} с) ${CFG.confirm}× подряд, спред ≤ ${CFG.maxSpread}% · тейк +${CFG.tp}% · трейлинг с +${CFG.act}% откат ${CFG.trail}% (≥ +${CFG.minProfit}%) · стоп 1:${CFG.slRR} (−${(CFG.tp * CFG.slRR).toFixed(2)}%) · ${CFG.flipExit ? "выход при развороте стакана · " : ""}ИИ ${aiReady() ? "вкл" : "выкл"} · аварийный стоп ${CFG.hardSl || "выкл"}${CFG.hardSl ? "%" : ""} · плечо x${CFG.lev} · ${CFG.budgetPct}% депозита`, "ok");
    loops(); scan();
    return isLive() ? "Запущено — LIVE" : "Запущено — симуляция";
  }
  async function stop() {
    running = false; lsSet("mb.running", false);
    for (const c of Object.values(C)) if (c.work && c.work.kind === "entry") { if (isLive()) await liveCancel(c, c.work); c.work = null; }
    log("СТОП: новые входы не ставлю. Открытые позиции веду до выхода лимиткой.");
    return "Остановлено";
  }
  async function closeAll() {   // выход лимитками-мейкерами по всем позициям бота
    let n = 0;
    for (const sym of Object.keys(OPEN)) {
      const c = coin(sym);
      if (c.work && c.work.kind === "exit") continue;
      if (c.work && isLive()) await liveCancel(c, c.work);
      if (isLive()) await cancelTake(c);
      c.work = { kind: "exit", side: opp(OPEN[sym].side), why: "вручную", start: now(), noFloor: true }; n++;
    }
    if (n && !running) loops();
    return n ? `Закрываю ${n} поз. лимитками` : "Открытых позиций нет";
  }
  function setCfg(x) {
    const wasLive = isLive();
    for (const k of NUMS) if (x[k] != null && x[k] !== "" && Number.isFinite(+x[k])) CFG[k] = +x[k];
    for (const k of BOOLS) if (x[k] != null) CFG[k] = !!x[k];
    CFG.lev = Math.min(Math.max(1, CFG.lev), 10); CFG.maxCoins = Math.min(Math.max(1, Math.round(CFG.maxCoins)), 30);
    CFG.boxBars = Math.min(Math.max(3, Math.round(CFG.boxBars)), 200); CFG.budgetPct = Math.min(Math.max(5, CFG.budgetPct), 95);
    CFG.requote = Math.max(1, CFG.requote); CFG.entryTimeout = Math.max(3, CFG.entryTimeout);
    saveCfg();
    if (wasLive !== isLive()) { for (const c of Object.values(C)) { c.work = null; c.lev = false; c.pos = null; } }
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
      return { sym: s, last: c.last, I: c.I, F: c.F, spread: c.spread, flowUsd: c.flowUsd, sigL: c.sigL || 0, sigS: c.sigS || 0,
        work: c.work ? { kind: c.work.kind, side: c.work.side, px: c.work.px ? +c.work.px : null, why: c.work.why || null, n: c.work.n || 0 } : null,
        pos: c.pos && c.pos.size > 0 ? { side: c.pos.side, size: c.pos.size, avg: c.pos.avg, upnl: c.pos.upnl } : null,
        trailOn: OPEN[s] ? !!OPEN[s].trailOn : false, cool: Math.max(0, (COOL[s] || 0) - now()) };
    });
    const ai = { ready: aiReady(), hasKey: !!host.fal, fresh: aiFresh(), at: AI.at, note: AI.note, err: AI.err, tuneAt: AI.tuneAt, tuneNote: AI.tuneNote, picks: AI.picks };
    return { ai, running, live: isLive(), cfg: CFG, eq: EQ, avail: AVAIL, day: DAY, stats: stats(), coins, trades: TRADES.filter(t => t.live === isLive()).slice(0, 100),
      log: LOG.slice(0, 200), lastScanAt, notional: notional(), btc: CFG.btcFilter ? BTC.why : null };
  }

  (async () => {
    await equity();
    if (running) { log("Перезапуск сервера — продолжаю"); await cleanStale(); loops(); scan(); }
    else if (Object.keys(OPEN).length) loops();
  })();

  return { start, stop, closeAll, setCfg, resetStats, view };
}

module.exports = { create, DEF, blocked };
