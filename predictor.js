// 📈 Прогноз направления цены на 5 минут по живому потоку Bybit (WebSocket):
//   стакан 50 уровней, лента сделок (CVD), Open Interest, фандинг, ликвидации.
//   13 факторов → онлайн-логистическая регрессия. Каждые 5 с прогноз записывается,
//   через 5 мин сверяется с реальной ценой: так считается честная точность, и модель на этом дообучается.
"use strict";
const WebSocketImpl = globalThis.WebSocket || require("ws");

const WS_URL = process.env.BYBIT_WS_PUBLIC || "wss://stream.bybit.com/v5/public/linear";
const H = +process.env.PRED_HORIZON_SEC || 300;   // горизонт, сек
const WARM = +process.env.PRED_WARM_SEC || 60;    // прогрев после подписки, сек
const FEATS = [
  ["obi5", "стакан 5 ур.", 0.5], ["obi20", "стакан 20 ур.", 0.4], ["micro", "microprice", 0.4], ["depthFlow", "приток ликвидности", 0.4],
  ["cvd1", "CVD 1м", 0.6], ["cvd5", "CVD 5м", 0.3], ["aggr30", "перевес сделок 30с", 0.3], ["whale", "киты 2м", 0.4],
  ["mom1", "импульс 1м", 0.3], ["oi", "OI+цена", 0.4], ["div", "дивергенция CVD", 0.3], ["liq", "ликвидации", 0.2], ["fund", "фандинг", 0.15],
];
const PRIOR = 0.35, LR = 0.03, L2 = 0.002;
const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const sig = (x) => 1 / (1 + Math.exp(-x));
const now = () => Date.now();
function win(arr, ms, t) { const c = t - ms; let i = 0; while (i < arr.length && arr[i].t < c) i++; return i ? arr.slice(i) : arr; }
function at(arr, t) { for (let i = arr.length - 1; i >= 0; i--) if (arr[i].t <= t) return arr[i]; return null; }

function createPredictor({ lsGet, lsSet, log }) {
  const prior = () => { const w = {}; for (const [k, , p] of FEATS) w[k] = p * PRIOR; return w; };
  const M = Object.assign({ w: prior(), b: 0, n: 0 }, lsGet("pred.model", {}));
  for (const [k] of FEATS) if (!Number.isFinite(M.w[k])) M.w[k] = prior()[k];
  const DONE = lsGet("pred.done", []);       // [t, pUp, y, sym]
  let saveAt = 0;
  const save = () => { if (now() - saveAt < 10000) return; saveAt = now(); if (DONE.length > 3000) DONE.splice(0, DONE.length - 3000); lsSet("pred.model", M); lsSet("pred.done", DONE); };

  const S = {};       // sym -> state
  const fresh = (sym) => ({ sym, bids: new Map(), asks: new Map(), trades: [], px: [], oi: [], liq: [], obiHist: [], ticker: {}, t0: now(), samples: [], whaleTh: Infinity, wAt: 0, sAt: 0, last: null });
  let ws = null, alive = false, wantSet = new Set(), subSet = new Set(), pingT = null, reconT = null;

  const topics = (s) => [`orderbook.50.${s}`, `publicTrade.${s}`, `tickers.${s}`, `allLiquidation.${s}`];
  function send(op, syms) {
    if (!alive || !syms.length) return;
    const args = syms.flatMap(topics);
    for (let i = 0; i < args.length; i += 10) ws.send(JSON.stringify({ op, args: args.slice(i, i + 10) }));
  }
  function connect() {
    clearTimeout(reconT);
    try { ws = new WebSocketImpl(WS_URL); } catch (e) { log("📈 прогноз: WebSocket не создан: " + e.message, "err"); reconT = setTimeout(connect, 5000); return; }
    ws.onopen = () => {
      alive = true; subSet = new Set();
      for (const s of Object.keys(S)) { S[s].bids.clear(); S[s].asks.clear(); }
      sync();
      clearInterval(pingT); pingT = setInterval(() => { try { alive && ws.send('{"op":"ping"}'); } catch (e) { /* */ } }, 20000);
    };
    ws.onmessage = (e) => { try { onMsg(JSON.parse(typeof e.data === "string" ? e.data : e.data.toString())); } catch (err) { /* битое сообщение */ } };
    ws.onclose = () => { alive = false; clearInterval(pingT); reconT = setTimeout(connect, 3000); };
    ws.onerror = () => { try { ws.close(); } catch (e) { /* */ } };
  }
  function sync() {
    const add = [...wantSet].filter(s => !subSet.has(s)), del = [...subSet].filter(s => !wantSet.has(s));
    for (const s of add) { if (!S[s]) S[s] = fresh(s); subSet.add(s); }
    for (const s of del) { subSet.delete(s); delete S[s]; }
    send("subscribe", add); send("unsubscribe", del);
  }
  function want(list) {
    const next = new Set(list.filter(Boolean));
    if (next.size === wantSet.size && [...next].every(s => wantSet.has(s))) return;
    wantSet = next; sync();
  }

  function onMsg(m) {
    if (!m.topic) return;
    const sym = m.topic.split(".").pop(), st = S[sym]; if (!st) return;
    const t = now(), d = m.data;
    if (m.topic.startsWith("orderbook")) {
      if (m.type === "snapshot" || d.u === 1) { st.bids.clear(); st.asks.clear(); }
      for (const [p, q] of d.b || []) +q === 0 ? st.bids.delete(p) : st.bids.set(p, +q);
      for (const [p, q] of d.a || []) +q === 0 ? st.asks.delete(p) : st.asks.set(p, +q);
    } else if (m.topic.startsWith("publicTrade")) {
      for (const x of d) st.trades.push({ t: +x.T, s: x.S === "Buy" ? 1 : -1, n: +x.p * +x.v });
    } else if (m.topic.startsWith("tickers")) {
      Object.assign(st.ticker, d);
      if (d.openInterest) st.oi.push({ t, v: +d.openInterest });
    } else if (m.topic.startsWith("allLiquidation")) {
      for (const x of d) st.liq.push({ t: +x.T, s: x.S === "Buy" ? -1 : 1, n: +x.p * +x.v });   // Buy = ликвидирован лонг → давление вниз
    }
  }

  const top = (map, desc, n) => [...map.entries()].map(([p, q]) => [+p, q]).sort((a, b) => desc ? b[0] - a[0] : a[0] - b[0]).slice(0, n);
  function features(st, t) {
    const B = top(st.bids, true, 20), A = top(st.asks, false, 20); if (!B.length || !A.length) return null;
    const bid = B[0][0], ask = A[0][0], mid = (bid + ask) / 2, spread = ask - bid;
    if (!(ask > bid)) return null;
    const sum = (a, n) => a.slice(0, n).reduce((s, x) => s + x[1], 0), wsum = (a) => a.reduce((s, x, i) => s + x[1] / (1 + i * 0.25), 0);
    const b5 = sum(B, 5), a5 = sum(A, 5), b20 = wsum(B), a20 = wsum(A), f = {};
    f.obi5 = (b5 - a5) / (b5 + a5 || 1);
    f.obi20 = (b20 - a20) / (b20 + a20 || 1);
    const bq = B[0][1], aq = A[0][1], micro = (bid * aq + ask * bq) / (aq + bq || 1);
    f.micro = clamp((micro - mid) / (spread / 2));
    st.obiHist.push({ t, v: f.obi20 }); st.obiHist = win(st.obiHist, 30000, t);
    const o10 = at(st.obiHist, t - 10000); f.depthFlow = o10 ? clamp((f.obi20 - o10.v) * 2.5) : 0;
    st.trades = win(st.trades, 360000, t);
    const cvd = (ms) => { let s = 0, a = 0; for (const x of win(st.trades, ms, t)) { s += x.s * x.n; a += x.n; } return [a ? s / a : 0, s]; };
    const [c1] = cvd(60000), [c5, c5usd] = cvd(300000); f.cvd1 = c1; f.cvd5 = c5;
    const t30 = win(st.trades, 30000, t), bc = t30.filter(x => x.s > 0).length; f.aggr30 = t30.length ? (2 * bc - t30.length) / t30.length : 0;
    if (t - st.wAt > 10000) { st.wAt = t; const ns = st.trades.map(x => x.n).sort((a, b) => a - b); st.whaleTh = ns.length > 50 ? ns[Math.floor(ns.length * 0.985)] : Infinity; }
    const big = win(st.trades, 120000, t).filter(x => x.n >= st.whaleTh);
    const bs = big.reduce((s, x) => s + x.s * x.n, 0), ba = big.reduce((s, x) => s + x.n, 0);
    f.whale = ba ? (bs / ba) * Math.min(1, big.length / 4) : 0;
    st.px.push({ t, v: mid }); st.px = win(st.px, 900000, t);
    let r2 = 0, rn = 0; for (let i = Math.max(1, st.px.length - 300); i < st.px.length; i++) { const r = Math.log(st.px[i].v / st.px[i - 1].v); r2 += r * r; rn++; }
    const sd = Math.sqrt(r2 / (rn || 1)) || 1e-5;
    const p60 = at(st.px, t - 60000), p300 = at(st.px, t - 300000);
    const r1 = p60 ? Math.log(mid / p60.v) : 0, r5 = p300 ? Math.log(mid / p300.v) : 0;
    f.mom1 = Math.tanh(r1 / (sd * Math.sqrt(60)) / 2);
    const pS = Math.tanh(r5 / (sd * Math.sqrt(300)));
    st.oi = win(st.oi, 900000, t); const oN = st.oi[st.oi.length - 1], o5 = at(st.oi, t - 300000) || st.oi[0];
    const dOI = oN && o5 ? (oN.v - o5.v) / o5.v * 100 : 0, oiS = Math.tanh(dOI / 0.2);
    f.oi = oiS > 0 ? pS * Math.abs(oiS) : -0.3 * pS * Math.abs(oiS);        // OI растёт = новые позиции подтверждают движение
    f.div = (Math.sign(c5) !== Math.sign(pS) && Math.abs(c5) > 0.08) ? pS * Math.min(Math.abs(c5) * 3, Math.abs(pS)) : 0;
    st.liq = win(st.liq, 120000, t);
    const ls = st.liq.reduce((s, x) => s + x.s * x.n, 0), la = st.liq.reduce((s, x) => s + x.n, 0);
    f.liq = la ? (ls / la) * Math.min(1, la / (Number.isFinite(st.whaleTh) ? st.whaleTh * 3 : Infinity)) : 0;
    const fr = +st.ticker.fundingRate || 0; f.fund = -Math.tanh(fr / 0.0003);
    for (const k in f) if (!Number.isFinite(f[k])) f[k] = 0;
    return { f, mid, dOI, c5usd, fr };
  }
  const predict = (f) => { let z = M.b; for (const [k] of FEATS) z += M.w[k] * f[k]; return sig(z); };

  function learn(st, t, mid) {
    const keep = [];
    for (const s of st.samples) {
      if (t - s.t < H * 1000) { keep.push(s); continue; }
      const ret = (mid - s.mid) / s.mid; if (Math.abs(ret) < 1e-4) continue;   // флэт не считаю
      const y = ret > 0 ? 1 : 0, g = y - predict(s.f);
      for (const [k, , pr] of FEATS) M.w[k] += LR * (g * s.f[k] - L2 * (M.w[k] - pr * PRIOR));
      M.b += LR * g * 0.5; M.n++;
      DONE.push([s.t, +s.p.toFixed(4), y, st.sym]);
    }
    st.samples = keep;
  }

  function tick() {
    const t = now();
    for (const st of Object.values(S)) {
      try {
        const r = features(st, t); if (!r) continue;
        learn(st, t, r.mid);
        const p = predict(r.f);
        st.last = { t, p, f: r.f, mid: r.mid, dOI: r.dOI, c5usd: r.c5usd, fr: r.fr };
        if ((t - st.t0) / 1000 >= WARM && t - st.sAt >= 5000) { st.sAt = t; st.samples.push({ t, mid: r.mid, f: { ...r.f }, p }); }
      } catch (e) { /* следующая секунда */ }
    }
    save();
  }
  setInterval(tick, 1000);
  connect();

  // прогноз по монете: ready — данных хватает (прогрев прошёл и стакан свежий)
  function get(sym) {
    const st = S[sym], t = now();
    if (!st || !st.last) return { ready: false, why: alive ? "подписка…" : "нет связи с WebSocket" };
    const warm = (t - st.t0) / 1000;
    if (t - st.last.t > 5000) return { ready: false, why: "данные устарели" };
    if (warm < WARM) return { ready: false, why: `прогрев ${Math.ceil(WARM - warm)} с`, pUp: st.last.p };
    return { ready: true, pUp: st.last.p, full: warm >= H, f: st.last.f };
  }
  function stats() {
    const n = DONE.length, hit = (a) => a.filter(x => (x[1] > 0.5) === (x[2] === 1)).length;
    const conf = DONE.filter(x => Math.abs(x[1] - 0.5) > 0.1);
    const day = DONE.filter(x => now() - x[0] < 86400000);
    return { n, acc: n ? hit(DONE) / n : null, confN: conf.length, confAcc: conf.length ? hit(conf) / conf.length : null,
      dayN: day.length, dayAcc: day.length ? hit(day) / day.length : null,
      brier: n ? DONE.reduce((s, x) => s + (x[1] - x[2]) ** 2, 0) / n : null, ws: alive, subs: subSet.size, learned: M.n,
      weights: FEATS.map(([k, name]) => [name, +M.w[k].toFixed(3)]) };
  }
  function reset() { M.w = prior(); M.b = 0; M.n = 0; DONE.length = 0; saveAt = 0; save(); }
  return { want, get, stats, reset };
}

module.exports = { createPredictor };
