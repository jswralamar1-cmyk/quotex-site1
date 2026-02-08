import { useEffect, useMemo, useRef, useState, useCallback } from "react";

/**
 * ✅ Quotex Signals Scanner — HEAVY (Signals Only)
 * ------------------------------------------------
 * ✔ بدون تحكم/اختيارات (Signals فقط)
 * ✔ يجيب "هواي عملات" تلقائياً (من Deriv Active Symbols)
 * ✔ يعرضها بشكل Cards واضح مثل Scanner
 * ✔ كل زوج/أصل له: سعر + اتجاه + ثقة + أسباب
 *
 * ملاحظة مهمة:
 * - هذا السكّانر يجلب البيانات من Deriv WebSocket (مو من Quotex مباشرة)
 * - لأن Quotex ما يوفر API رسمي مباشر للشموع.
 */

// ========= CONFIG (No UI controls) =========
const APP_ID = 1089;
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const GRANULARITY = 60; // 1m candles (ثابت)
const HISTORY_COUNT = 200;
const MIN_CANDLES_FOR_FULL = 35; // حتى يشتغل MACD مضبوط
const MIN_CANDLES_MIN = 15; // minimum fallback

const MAX_ASSETS = 80; // حتى ما يصير ضغط اشتراكات كبير
const ANALYZE_EVERY_MS = 60_000; // كل دقيقة
const TICK_REFRESH_MS = 15_000; // تحديث خفيف كل 15 ثانية

// ========= UTILS =========
const bucketStart = (epoch, durationSec) => epoch - (epoch % durationSec);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
const stdDev = (arr) => {
  if (!arr.length) return 0;
  const m = avg(arr);
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / arr.length;
  return Math.sqrt(v);
};

// ========= SIMPLE INDICATORS (fast, no libs) =========
function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = avg(values.slice(0, period));
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi(values, period = 14) {
  if (!values || values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function macd(values, fast = 12, slow = 26, signal = 9) {
  if (!values || values.length < slow + signal + 5) return null;

  const macdLine = [];
  for (let i = 0; i < values.length; i++) {
    const slice = values.slice(0, i + 1);
    const ef = ema(slice, fast);
    const es = ema(slice, slow);
    if (ef != null && es != null) macdLine.push(ef - es);
  }
  if (macdLine.length < signal + 3) return null;
  const signalLine = ema(macdLine, signal);
  const lastMacd = macdLine[macdLine.length - 1];
  return {
    macd: lastMacd,
    signal: signalLine,
    hist: signalLine != null ? lastMacd - signalLine : null
  };
}

// ========= AUDIO ALERT =========
const playAlert = (type = "signal") => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.setValueAtTime(type === "buy" ? 800 : type === "sell" ? 420 : 660, ctx.currentTime);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.22);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.22);
    setTimeout(() => ctx.close(), 350);
  } catch {}
};

// ========= WS MANAGER =========
class WSManager {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnect = 8;
    this.baseDelay = 900;

    this.onMessage = null;
    this.onOpen = null;
    this.onClose = null;
    this.onError = null;

    this.subscribed = new Set();
    this.historyQueue = [];
    this.historyTimer = null;
  }

  connect({ onMessage, onOpen, onClose, onError }) {
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.onError = onError;

    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.onOpen?.();
        [...this.subscribed].forEach((s) => this.send({ ticks: s, subscribe: 1 }));
      };

      this.ws.onmessage = (ev) => this.onMessage?.(ev);

      this.ws.onclose = () => {
        this.isConnected = false;
        this.stopHistoryPump();
        this.onClose?.();
        this.reconnect();
      };

      this.ws.onerror = (e) => this.onError?.(e);
    } catch (e) {
      this.onError?.(e);
      this.reconnect();
    }
  }

  reconnect() {
    if (this.reconnectAttempts >= this.maxReconnect) return;
    this.reconnectAttempts++;
    const delay = this.baseDelay * this.reconnectAttempts;
    setTimeout(() => {
      this.connect({
        onMessage: this.onMessage,
        onOpen: this.onOpen,
        onClose: this.onClose,
        onError: this.onError
      });
    }, delay);
  }

  send(payload) {
    if (!this.ws || !this.isConnected) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  disconnect() {
    this.stopHistoryPump();
    this.subscribed.clear();
    this.isConnected = false;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }

  subscribe(symbol) {
    this.subscribed.add(symbol);
    return this.send({ ticks: symbol, subscribe: 1 });
  }

  requestActiveSymbols() {
    return this.send({ active_symbols: "brief", product_type: "basic" });
  }

  queueHistory(symbol) {
    this.historyQueue.push(symbol);
    this.startHistoryPump();
  }

  startHistoryPump() {
    if (this.historyTimer) return;
    this.historyTimer = setInterval(() => {
      if (!this.isConnected) return;
      const sym = this.historyQueue.shift();
      if (!sym) {
        this.stopHistoryPump();
        return;
      }
      this.send({
        ticks_history: sym,
        adjust_start_time: 1,
        count: HISTORY_COUNT,
        end: "latest",
        start: 1,
        style: "candles",
        granularity: GRANULARITY
      });
    }, 140);
  }

  stopHistoryPump() {
    if (this.historyTimer) clearInterval(this.historyTimer);
    this.historyTimer = null;
    this.historyQueue = [];
  }
}

// ========= MAIN =========
export default function Home() {
  const wsRef = useRef(new WSManager());

  // store per symbol
  const storeRef = useRef({});

  const [status, setStatus] = useState("connecting");
  const [cards, setCards] = useState([]);
  const [note, setNote] = useState(null);
  const [dark, setDark] = useState(true);

  const [sound, setSound] = useState(true);
  const lastAlertRef = useRef({ t: 0, key: "" });

  const theme = useMemo(() => {
    const bg = dark ? "#0b1220" : "#ffffff";
    const fg = dark ? "#e5e7eb" : "#0b1220";
    const card = dark ? "rgba(17,24,39,0.75)" : "#ffffff";
    const border = dark ? "rgba(148,163,184,0.18)" : "#e5e7eb";
    const soft = dark ? "rgba(17,24,39,0.45)" : "#f8fafc";
    const blue = dark ? "#60a5fa" : "#2563eb";
    const green = dark ? "#34d399" : "#16a34a";
    const red = dark ? "#f87171" : "#dc2626";
    const amber = dark ? "#fbbf24" : "#f59e0b";
    return { bg, fg, card, border, soft, blue, green, red, amber };
  }, [dark]);

  // ======== analysis per symbol ========
  const analyzeSymbol = useCallback(
    (sym) => {
      const item = storeRef.current[sym];
      if (!item) return;

      const candles = item.candles || [];
      const lastCandle = item.lastCandle;

      const merged = lastCandle ? [...candles, lastCandle] : [...candles];
      const closes = merged.map((c) => c.close).filter((x) => Number.isFinite(x));

      if (closes.length < MIN_CANDLES_MIN) {
        item.analysis = {
          dir: "WAIT",
          conf: 0,
          tag: "انتظر",
          color: "muted",
          market: "جمع بيانات",
          reasons: [`عدد الشموع: ${closes.length} (نحتاج ${MIN_CANDLES_MIN}+ )`],
          updatedAt: Date.now()
        };
        return;
      }

      const last = closes[closes.length - 1];
      const prev = closes[closes.length - 2];
      const delta = last - prev;

      let buy = 0;
      let sell = 0;
      const reasons = [];

      if (delta > 0) {
        buy += 1;
        reasons.push("زخم سريع: الإغلاق أعلى من السابق");
      } else if (delta < 0) {
        sell += 1;
        reasons.push("زخم سريع: الإغلاق أقل من السابق");
      }

      const recent = closes.slice(-20);
      const v = avg(recent) ? stdDev(recent) / avg(recent) : 0;
      const market = v > 0.02 ? "تذبذب عالي" : v < 0.005 ? "هادئ" : "طبيعي";

      const r = rsi(closes, 14);
      if (r != null) {
        if (r < 30) {
          buy += 2;
          reasons.push("RSI: تشبع بيع (شراء)");
        } else if (r > 70) {
          sell += 2;
          reasons.push("RSI: تشبع شراء (بيع)");
        } else if (r >= 52) {
          buy += 1;
          reasons.push("RSI فوق 52 (ميل صعودي)");
        } else if (r <= 48) {
          sell += 1;
          reasons.push("RSI تحت 48 (ميل هبوطي)");
        } else {
          reasons.push("RSI قريب من المنتصف (محايد)");
        }
      }

      const e9 = ema(closes, 9);
      const e21 = ema(closes, 21);
      if (e9 != null && e21 != null) {
        if (e9 > e21) {
          buy += 2;
          reasons.push("EMA9 فوق EMA21 (ترند صاعد)");
        } else {
          sell += 2;
          reasons.push("EMA9 تحت EMA21 (ترند هابط)");
        }
      }

      const m = macd(closes, 12, 26, 9);
      if (m && m.macd != null && m.signal != null) {
        if (m.macd > m.signal) {
          buy += 1;
          reasons.push("MACD إيجابي");
        } else {
          sell += 1;
          reasons.push("MACD سلبي");
        }
      } else if (closes.length < MIN_CANDLES_FOR_FULL) {
        reasons.push("MACD يحتاج شموع أكثر (تحليل مختصر)");
      }

      const total = buy + sell;
      const conf = total ? Math.round((Math.max(buy, sell) / total) * 100) : 0;

      let dir = "WAIT";
      if (buy > sell) dir = "CALL";
      else if (sell > buy) dir = "PUT";

      const ok = conf >= 60 && Math.abs(buy - sell) >= 2;

      const tag = !ok ? "انتظر" : dir === "CALL" ? "CALL ⬆️" : dir === "PUT" ? "PUT ⬇️" : "انتظر";
      const color = !ok ? "muted" : dir === "CALL" ? "green" : "red";

      item.analysis = {
        dir,
        conf: ok ? conf : Math.max(0, conf - 10),
        tag,
        color,
        market,
        reasons: reasons.slice(0, 3),
        updatedAt: Date.now()
      };

      if (sound && ok && conf >= 72) {
        const key = `${sym}:${dir}`;
        const now = Date.now();
        if (now - lastAlertRef.current.t > 25_000 || lastAlertRef.current.key !== key) {
          playAlert(dir === "CALL" ? "buy" : "sell");
          lastAlertRef.current = { t: now, key };
        }
      }
    },
    [sound]
  );

  const rebuildCards = useCallback(() => {
    const map = storeRef.current;
    const list = Object.values(map)
      .map((x) => ({
        symbol: x.symbol,
        name: x.name || x.symbol,
        market: x.market || "",
        price: x.price,
        analysis: x.analysis,
        lastUpdate: x.lastUpdate
      }))
      .sort((a, b) => (b.analysis?.conf ?? 0) - (a.analysis?.conf ?? 0));

    setCards(list);
  }, []);

  // ======== connect + load symbols + subscribe ========
  useEffect(() => {
    const ws = wsRef.current;
    let mounted = true;

    const onOpen = () => {
      if (!mounted) return;
      setStatus("connected");
      setNote({ type: "ok", msg: "✅ تم الاتصال — جاري تحميل الأصول..." });
      ws.requestActiveSymbols();
    };

    const onClose = () => mounted && setStatus("disconnected");
    const onError = () => mounted && setStatus("error");

    const onMessage = (event) => {
      if (!mounted) return;

      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      // active symbols
      if (data.active_symbols && Array.isArray(data.active_symbols)) {
        const wantedMarkets = new Set(["forex", "cryptocurrency", "commodities"]);

        const filtered = data.active_symbols
          .filter((s) => wantedMarkets.has(s.market))
          .filter((s) => s.symbol && s.display_name)
          .map((s) => ({ symbol: s.symbol, name: s.display_name, market: s.market }));

        const priority = (s) => {
          const n = (s.name || "").toUpperCase();
          const sym = (s.symbol || "").toUpperCase();
          if (
            n.includes("EUR/USD") ||
            n.includes("GBP/USD") ||
            n.includes("USD/JPY") ||
            n.includes("USD/CHF") ||
            n.includes("AUD/USD") ||
            n.includes("USD/CAD")
          )
            return 0;
          if (n.includes("XAU") || n.includes("GOLD") || n.includes("XAG") || n.includes("SILVER")) return 1;
          if (n.includes("BTC") || n.includes("ETH")) return 2;
          if (sym.startsWith("FRX")) return 3;
          if (sym.startsWith("CRY")) return 4;
          return 9;
        };

        filtered.sort((a, b) => priority(a) - priority(b));

        const picked = filtered.slice(0, MAX_ASSETS);

        const map = storeRef.current;
        picked.forEach((s) => {
          map[s.symbol] =
            map[s.symbol] || {
              symbol: s.symbol,
              name: s.name,
              market: s.market,
              price: undefined,
              candles: [],
              lastCandle: null,
              analysis: {
                dir: "WAIT",
                conf: 0,
                tag: "انتظر",
                color: "muted",
                market: "—",
                reasons: ["..."],
                updatedAt: Date.now()
              },
              lastUpdate: undefined
            };
        });

        setNote({
          type: "info",
          msg: `📡 تم تحميل ${picked.length} أصل (Forex + Crypto + Commodities) — جاري جلب التاريخ والاشتراك...`
        });

        picked.forEach((s) => {
          ws.subscribe(s.symbol);
          ws.queueHistory(s.symbol);
        });

        rebuildCards();
        return;
      }

      // candles history
      if (data.candles && Array.isArray(data.candles) && data.echo_req?.ticks_history) {
        const sym = data.echo_req.ticks_history;
        const item = storeRef.current[sym];
        if (!item) return;

        const candles = data.candles
          .map((c) => ({
            time: Number(c.epoch),
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
            volume: Number(c.volume) || 0
          }))
          .filter(
            (c) =>
              Number.isFinite(c.time) &&
              Number.isFinite(c.open) &&
              Number.isFinite(c.high) &&
              Number.isFinite(c.low) &&
              Number.isFinite(c.close)
          )
          .slice(-HISTORY_COUNT);

        item.candles = candles;
        item.lastCandle = candles[candles.length - 1] || null;
        item.lastUpdate = Date.now();

        analyzeSymbol(sym);
        rebuildCards();
        return;
      }

      // ticks
      if (data.tick && data.tick.symbol) {
        const sym = data.tick.symbol;
        const item = storeRef.current[sym];
        if (!item) return;

        const epoch = Math.floor(data.tick.epoch);
        const px = Number(data.tick.quote);
        if (!Number.isFinite(px)) return;

        item.price = px;
        item.lastUpdate = Date.now();

        const candleStart = bucketStart(epoch, GRANULARITY);
        const cur = item.lastCandle;

        if (!cur || cur.time !== candleStart) {
          if (cur) item.candles = [...item.candles, cur].slice(-HISTORY_COUNT);

          item.lastCandle = {
            time: candleStart,
            open: px,
            high: px,
            low: px,
            close: px,
            volume: 1
          };

          analyzeSymbol(sym);
          rebuildCards();
        } else {
          item.lastCandle = {
            ...cur,
            high: Math.max(cur.high, px),
            low: Math.min(cur.low, px),
            close: px,
            volume: (cur.volume || 0) + 1
          };
        }
      }

      if (data.error) {
        setNote({ type: "err", msg: `❌ خطأ: ${data.error.message || "غير معروف"}` });
      }
    };

    setStatus("connecting");
    ws.connect({ onMessage, onOpen, onClose, onError });

    return () => {
      mounted = false;
      ws.disconnect();
    };
  }, [analyzeSymbol, rebuildCards]);

  // ======== periodic analysis ========
  useEffect(() => {
    const t1 = setInterval(() => {
      const map = storeRef.current;
      Object.keys(map).forEach((sym) => analyzeSymbol(sym));
      rebuildCards();
    }, ANALYZE_EVERY_MS);

    const t2 = setInterval(() => {
      const map = storeRef.current;
      Object.keys(map).forEach((sym) => {
        const it = map[sym];
        if (!it) return;
        if ((it.candles?.length || 0) >= MIN_CANDLES_MIN) analyzeSymbol(sym);
      });
      rebuildCards();
    }, TICK_REFRESH_MS);

    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [analyzeSymbol, rebuildCards]);

  // ======== stats ========
  const stats = useMemo(() => {
    const total = cards.length;
    const calls = cards.filter((c) => c.analysis?.dir === "CALL" && c.analysis?.color !== "muted").length;
    const puts = cards.filter((c) => c.analysis?.dir === "PUT" && c.analysis?.color !== "muted").length;
    const wait = total - calls - puts;
    return { total, calls, puts, wait };
  }, [cards]);

  const badge = (color) => {
    if (color === "green") return { bg: theme.green, fg: "#fff" };
    if (color === "red") return { bg: theme.red, fg: "#fff" };
    return { bg: theme.soft, fg: theme.fg };
  };

  const timeAgo = (ts) => {
    if (!ts) return "—";
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return "الآن";
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m`;
  };

  return (
    <div
      style={{
        background: theme.bg,
        color: theme.fg,
        minHeight: "100vh",
        direction: "rtl",
        fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif"
      }}
    >
      {note && (
        <div style={{ position: "fixed", top: 16, left: 16, right: 16, maxWidth: 900, margin: "0 auto", zIndex: 9999 }}>
          <div
            style={{
              padding: "12px 14px",
              borderRadius: 14,
              border: `1px solid ${theme.border}`,
              background: note.type === "err" ? "rgba(239,68,68,0.22)" : "rgba(59,130,246,0.18)",
              backdropFilter: "blur(10px)",
              display: "flex",
              justifyContent: "space-between",
              gap: 10,
              alignItems: "center"
            }}
          >
            <div style={{ fontWeight: 700 }}>{note.msg}</div>
            <button onClick={() => setNote(null)} style={{ border: "none", background: "transparent", color: theme.fg, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>
              ✕
            </button>
          </div>
        </div>
      )}

      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "26px 18px" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 28, fontWeight: 900, color: theme.blue }}>⚡ Quotex Signals Scanner</div>
            <div style={{ opacity: 0.8, fontSize: 13, marginTop: 2 }}>إشارات فقط (CALL/PUT/WAIT) — تحديث كل دقيقة — Cards واضحة لكل الأصول</div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ padding: "7px 12px", borderRadius: 999, border: `1px solid ${theme.border}`, background: theme.card, fontWeight: 800, fontSize: 12 }}>
              الحالة:{" "}
              <span style={{ color: status === "connected" ? theme.green : status === "connecting" ? theme.amber : theme.red }}>
                {status === "connected" ? "متصل ✓" : status === "connecting" ? "جاري الاتصال..." : status === "error" ? "خطأ" : "غير متصل"}
              </span>
            </span>

            <button onClick={() => setDark((v) => !v)} style={{ padding: "9px 12px", borderRadius: 12, border: `1px solid ${theme.border}`, background: theme.card, color: theme.fg, cursor: "pointer", fontWeight: 700 }}>
              {dark ? "☀️ نهاري" : "🌙 ليلي"}
            </button>

            <button onClick={() => setSound((v) => !v)} style={{ padding: "9px 12px", borderRadius: 12, border: `1px solid ${theme.border}`, background: theme.card, color: theme.fg, cursor: "pointer", fontWeight: 700 }}>
              {sound ? "🔊 صوت: ON" : "🔇 صوت: OFF"}
            </button>
          </div>
        </div>

        {/* Stats */}
        <div style={{ marginTop: 14, background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 16, padding: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {[
            { label: "الأصول", value: stats.total, c: theme.blue },
            { label: "CALL", value: stats.calls, c: theme.green },
            { label: "PUT", value: stats.puts, c: theme.red },
            { label: "WAIT", value: stats.wait, c: theme.fg }
          ].map((x, i) => (
            <div key={i} style={{ flex: "1 1 160px", minWidth: 160, borderRadius: 14, border: `1px solid ${theme.border}`, background: theme.soft, padding: "10px 12px" }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>{x.label}</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: x.c }}>{x.value}</div>
            </div>
          ))}

          <div style={{ flex: "2 1 280px", minWidth: 260, fontSize: 12, opacity: 0.78, lineHeight: 1.7 }}>
            ✅ إشارات قوية تظهر فقط لما تتوفر أفضلية واضحة.<br />
            ⚠️ البيانات من Deriv WebSocket (للتحليل التعليمي).
          </div>
        </div>

        {/* Cards */}
        <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
          {cards.map((c) => {
            const a = c.analysis || {};
            const b = badge(a.color);
            const conf = clamp(a.conf || 0, 0, 100);

            return (
              <div
                key={c.symbol}
                style={{
                  background: theme.card,
                  border: `1px solid ${theme.border}`,
                  borderRadius: 16,
                  padding: 14,
                  boxShadow: dark ? "0 10px 30px rgba(0,0,0,0.35)" : "0 8px 20px rgba(0,0,0,0.07)"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontWeight: 900, fontSize: 16 }}>{c.name}</div>
                    <div style={{ fontSize: 12, opacity: 0.75 }}>
                      {c.symbol} {c.market ? `• ${c.market}` : ""}
                    </div>
                  </div>

                  <div style={{ padding: "6px 10px", borderRadius: 999, background: b.bg, color: b.fg, fontWeight: 900, fontSize: 12, whiteSpace: "nowrap" }}>
                    {a.tag || "انتظر"}
                  </div>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 140px", background: theme.soft, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 10 }}>
                    <div style={{ fontSize: 12, opacity: 0.75 }}>السعر</div>
                    <div style={{ fontSize: 18, fontWeight: 900, color: theme.blue }}>{typeof c.price === "number" ? c.price.toFixed(5) : "—"}</div>
                  </div>

                  <div style={{ flex: "1 1 140px", background: theme.soft, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 10 }}>
                    <div style={{ fontSize: 12, opacity: 0.75 }}>الثقة</div>
                    <div style={{ fontSize: 18, fontWeight: 900, color: a.color === "green" ? theme.green : a.color === "red" ? theme.red : theme.fg }}>
                      {conf}%
                    </div>
                    <div style={{ height: 8, background: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)", borderRadius: 99, overflow: "hidden", marginTop: 8 }}>
                      <div style={{ width: `${conf}%`, height: "100%", background: a.color === "green" ? theme.green : a.color === "red" ? theme.red : theme.blue }} />
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85 }}>
                  حالة السوق: <b>{a.market || "—"}</b> • تحديث: <b>{timeAgo(c.lastUpdate)}</b>
                </div>

                <div style={{ marginTop: 10, background: theme.soft, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 10 }}>
                  <div style={{ fontWeight: 900, fontSize: 12, marginBottom: 6 }}>الأسباب</div>
                  <ul style={{ margin: 0, paddingRight: 18, lineHeight: 1.7, fontSize: 12 }}>
                    {(a.reasons || []).slice(0, 3).map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 16, padding: 12, borderRadius: 14, background: dark ? "rgba(239,68,68,0.10)" : "#fef2f2", border: `1px solid ${theme.red}`, color: theme.red, fontSize: 12, lineHeight: 1.7 }}>
          ⚠️ هذا السكّانر للتحليل التعليمي فقط. التداول مسؤوليتك.
        </div>
      </div>
    </div>
  );
}
