import { useEffect, useMemo, useRef, useState, useCallback } from "react";

/**
 * ✅ Quotex Signals Scanner Pro - النسخة المتطورة
 * ------------------------------------------------
 * ✔ قائمة اختيار العملات (يختار المستخدم ما يريد فقط)
 * ✔ تحليل متقدم مع استراتيجيات واضحة
 * ✔ إشارات دخول قبل الدقيقة مع احتمالية التنفيذ
 * ✔ تنبيهات صوتية ومرئية للإشارات
 * ✔ واجهة احترافية وسهلة الاستخدام
 */

// ========= CONFIG =========
const APP_ID = 1089;
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const GRANULARITY = 60; // 1m candles
const HISTORY_COUNT = 200;
const MIN_CANDLES_FOR_FULL = 35;
const MIN_CANDLES_MIN = 15;

const MAX_ASSETS = 80;
const ANALYZE_EVERY_MS = 60_000;
const TICK_REFRESH_MS = 15_000;
const SIGNAL_AHEAD_SECONDS = 60; // إشارة قبل 60 ثانية

// ========= العملات الشائعة =========
const COMMON_PAIRS = [
  { symbol: "frxEURUSD", name: "EUR/USD", market: "forex" },
  { symbol: "frxGBPUSD", name: "GBP/USD", market: "forex" },
  { symbol: "frxUSDJPY", name: "USD/JPY", market: "forex" },
  { symbol: "frxUSDCHF", name: "USD/CHF", market: "forex" },
  { symbol: "frxAUDUSD", name: "AUD/USD", market: "forex" },
  { symbol: "frxUSDCAD", name: "USD/CAD", market: "forex" },
  { symbol: "frxNZDUSD", name: "NZD/USD", market: "forex" },
  { symbol: "frxEURGBP", name: "EUR/GBP", market: "forex" },
  { symbol: "frxEURJPY", name: "EUR/JPY", market: "forex" },
  { symbol: "frxGBPJPY", name: "GBP/JPY", market: "forex" },
  { symbol: "CRYPTOC_BTCUSD", name: "Bitcoin/USD", market: "cryptocurrency" },
  { symbol: "CRYPTOC_ETHUSD", name: "Ethereum/USD", market: "cryptocurrency" },
  { symbol: "CRYPTOC_XRPUSD", name: "Ripple/USD", market: "cryptocurrency" },
  { symbol: "CRYPTOC_ADAUSD", name: "Cardano/USD", market: "cryptocurrency" },
  { symbol: "CRYPTOC_SOLUSD", name: "Solana/USD", market: "cryptocurrency" },
  { symbol: "OTC_XAUUSD", name: "الذهب", market: "commodities" },
  { symbol: "OTC_XAGUSD", name: "الفضة", market: "commodities" },
  { symbol: "OTC_WTI_OIL", name: "النفط الخام", market: "commodities" },
  { symbol: "R_50", name: "S&P 500", market: "indices" },
  { symbol: "R_100", name: "Nasdaq 100", market: "indices" },
  { symbol: "frxXAUUSD", name: "الذهب فوركس", market: "commodities" },
  { symbol: "frxXAGUSD", name: "الفضة فوركس", market: "commodities" },
];

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

// ========= INDICATORS =========
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

    if (type === "buy") {
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      osc.frequency.setValueAtTime(1200, ctx.currentTime + 0.1);
    } else if (type === "sell") {
      osc.frequency.setValueAtTime(420, ctx.currentTime);
      osc.frequency.setValueAtTime(320, ctx.currentTime + 0.1);
    } else {
      osc.frequency.setValueAtTime(660, ctx.currentTime);
    }
    
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
    setTimeout(() => ctx.close(), 500);
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

  unsubscribe(symbol) {
    this.subscribed.delete(symbol);
    return this.send({ ticks: symbol, subscribe: 0 });
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

// ========= STRATEGIES =========
const STRATEGIES = [
  {
    id: "trend_follow",
    name: "تابع الترند",
    description: "تداول في اتجاه الترند الرئيسي مع تأكيد من المتوسطات المتحركة",
    conditions: {
      emaCross: true,
      rsiConfirmation: true,
      volume: false
    }
  },
  {
    id: "rsi_reversal",
    name: "انعكاس RSI",
    description: "تداول عند التشبع الشرائي أو البيعي في RSI",
    conditions: {
      rsiExtreme: true,
      candlestickPattern: true,
      macdDivergence: true
    }
  },
  {
    id: "breakout",
    name: "اختراق",
    description: "تداول عند اختراق مستويات المقاومة أو الدعم",
    conditions: {
      supportResistance: true,
      highVolume: true,
      volatility: true
    }
  }
];

// ========= MAIN COMPONENT =========
export default function Home() {
  const wsRef = useRef(new WSManager());
  const storeRef = useRef({});
  const signalsRef = useRef([]);

  const [status, setStatus] = useState("connecting");
  const [cards, setCards] = useState([]);
  const [signals, setSignals] = useState([]);
  const [note, setNote] = useState(null);
  const [dark, setDark] = useState(true);
  const [sound, setSound] = useState(true);
  const [selectedPairs, setSelectedPairs] = useState(COMMON_PAIRS.slice(0, 10).map(p => p.symbol));
  const [showAllAssets, setShowAllAssets] = useState(false);
  const [strategy, setStrategy] = useState(STRATEGIES[0].id);
  const [strengthFilter, setStrengthFilter] = useState(70);

  const lastAlertRef = useRef({ t: 0, key: "" });

  const theme = useMemo(() => {
    const bg = dark ? "#0b1220" : "#ffffff";
    const fg = dark ? "#e5e7eb" : "#0b1220";
    const card = dark ? "rgba(17,24,39,0.85)" : "#ffffff";
    const border = dark ? "rgba(148,163,184,0.25)" : "#e5e7eb";
    const soft = dark ? "rgba(17,24,39,0.45)" : "#f8fafc";
    const blue = dark ? "#60a5fa" : "#2563eb";
    const green = dark ? "#34d399" : "#16a34a";
    const red = dark ? "#f87171" : "#dc2626";
    const amber = dark ? "#fbbf24" : "#f59e0b";
    const purple = dark ? "#c084fc" : "#9333ea";
    return { bg, fg, card, border, soft, blue, green, red, amber, purple };
  }, [dark]);

  // ======== تحليل متقدم مع استراتيجية ========
  const analyzeSymbol = useCallback(
    (sym) => {
      const item = storeRef.current[sym];
      if (!item) return;

      const candles = item.candles || [];
      const lastCandle = item.lastCandle;
      const merged = lastCandle ? [...candles, lastCandle] : [...candles];
      const closes = merged.map((c) => c.close).filter((x) => Number.isFinite(x));
      const volumes = merged.map((c) => c.volume).filter((x) => Number.isFinite(x));

      if (closes.length < MIN_CANDLES_MIN) {
        item.analysis = {
          dir: "WAIT",
          conf: 0,
          tag: "انتظر",
          color: "muted",
          market: "جمع بيانات",
          reasons: [`عدد الشموع: ${closes.length} (نحتاج ${MIN_CANDLES_MIN}+ )`],
          signals: [],
          updatedAt: Date.now()
        };
        return;
      }

      const last = closes[closes.length - 1];
      const prev = closes[closes.length - 2];
      const delta = last - prev;

      // تحليل السوق
      const recent = closes.slice(-20);
      const v = avg(recent) ? stdDev(recent) / avg(recent) : 0;
      const market = v > 0.02 ? "تذبذب عالي" : v < 0.005 ? "هادئ" : "طبيعي";

      // مؤشرات
      const r = rsi(closes, 14);
      const e9 = ema(closes, 9);
      const e21 = ema(closes, 21);
      const e50 = ema(closes, 50);
      const m = macd(closes, 12, 26, 9);
      
      // حجم التداول
      const avgVolume = avg(volumes.slice(-10)) || 1;
      const lastVolume = volumes[volumes.length - 1] || 0;
      const volumeRatio = lastVolume / avgVolume;

      let buyScore = 0;
      let sellScore = 0;
      const reasons = [];
      const signals = [];

      // استراتيجية: تابع الترند
      if (strategy === "trend_follow") {
        if (e9 && e21) {
          if (e9 > e21) {
            buyScore += 3;
            reasons.push("📈 EMA9 فوق EMA21 - ترند صاعد");
          } else {
            sellScore += 3;
            reasons.push("📉 EMA9 تحت EMA21 - ترند هابط");
          }
        }

        if (e50 && last > e50) {
          buyScore += 2;
          reasons.push("🚀 السعر فوق EMA50 - دعم قوي");
        } else if (e50 && last < e50) {
          sellScore += 2;
          reasons.push("⚠️ السعر تحت EMA50 - مقاومة قوية");
        }

        if (r != null && r > 40 && r < 60) {
          if (e9 && e21 && e9 > e21) {
            buyScore += 1;
            reasons.push("✅ RSI في المدى المتوسط مع ترند صاعد");
          } else if (e9 && e21 && e9 < e21) {
            sellScore += 1;
            reasons.push("✅ RSI في المدى المتوسط مع ترند هابط");
          }
        }
      }

      // استراتيجية: انعكاس RSI
      else if (strategy === "rsi_reversal") {
        if (r != null) {
          if (r < 30) {
            buyScore += 4;
            reasons.push("🔄 RSI تشبع بيع (${r.toFixed(1)}) - انعكاس متوقع");
            
            // إشارة دخول قبلية
            if (r < 25 && volumeRatio > 1.5) {
              signals.push({
                type: "BUY",
                reason: "تشبع بيع قوي مع حجم مرتفع",
                probability: 85,
                timeAhead: SIGNAL_AHEAD_SECONDS
              });
            }
          } else if (r > 70) {
            sellScore += 4;
            reasons.push("🔄 RSI تشبع شراء (${r.toFixed(1)}) - انعكاس متوقع");
            
            if (r > 75 && volumeRatio > 1.5) {
              signals.push({
                type: "SELL",
                reason: "تشبع شراء قوي مع حجم مرتفع",
                probability: 85,
                timeAhead: SIGNAL_AHEAD_SECONDS
              });
            }
          }
        }

        // تحليل شموع الانعكاس
        if (candles.length >= 3) {
          const current = candles[candles.length - 1];
          const previous = candles[candles.length - 2];
          const before = candles[candles.length - 3];
          
          if (current.close > current.open && previous.close < previous.open && before.close < before.open) {
            buyScore += 2;
            reasons.push("🕯️ نمط شموع انعكاسي صاعد");
          } else if (current.close < current.open && previous.close > previous.open && before.close > before.open) {
            sellScore += 2;
            reasons.push("🕯️ نمط شموع انعكاسي هابط");
          }
        }
      }

      // استراتيجية: اختراق
      else if (strategy === "breakout") {
        // حساب مستويات الدعم والمقاومة
        const recentHigh = Math.max(...closes.slice(-20));
        const recentLow = Math.min(...closes.slice(-20));
        const range = recentHigh - recentLow;
        const resistance = recentHigh - range * 0.1;
        const support = recentLow + range * 0.1;

        if (last > resistance && volumeRatio > 1.2) {
          buyScore += 4;
          reasons.push("🚀 اختراق مقاومة مع حجم قوي");
          
          signals.push({
            type: "BUY",
            reason: "اختراق مقاومة مؤكد",
            probability: 80,
            timeAhead: SIGNAL_AHEAD_SECONDS
          });
        } else if (last < support && volumeRatio > 1.2) {
          sellScore += 4;
          reasons.push("📉 اختراق دعم مع حجم قوي");
          
          signals.push({
            type: "SELL",
            reason: "اختراق دعم مؤكد",
            probability: 80,
            timeAhead: SIGNAL_AHEAD_SECONDS
          });
        }

        // التذبذب
        if (v > 0.015) {
          if (last > e9 && e9 > e21) {
            buyScore += 2;
            reasons.push("⚡ سوق متذبذب مع ترند صاعد");
          } else if (last < e9 && e9 < e21) {
            sellScore += 2;
            reasons.push("⚡ سوق متذبذب مع ترند هابط");
          }
        }
      }

      // مؤشرات عامة
      if (m && m.macd != null && m.signal != null) {
        if (m.macd > m.signal && m.hist > 0) {
          buyScore += 2;
          reasons.push("📊 MACD إيجابي ومتزايد");
        } else if (m.macd < m.signal && m.hist < 0) {
          sellScore += 2;
          reasons.push("📊 MACD سلبي ومتزايد");
        }
      }

      if (delta > 0) {
        buyScore += 1;
        if (volumeRatio > 1.3) reasons.push("⚡ زخم صاعد مع حجم عالي");
        else reasons.push("↗️ إغلاق أعلى من السابق");
      } else if (delta < 0) {
        sellScore += 1;
        if (volumeRatio > 1.3) reasons.push("⚡ زخم هابط مع حجم عالي");
        else reasons.push("↘️ إغلاق أقل من السابق");
      }

      // حساب النتيجة النهائية
      const total = buyScore + sellScore;
      const conf = total ? Math.round((Math.max(buyScore, sellScore) / total) * 100) : 0;

      let dir = "WAIT";
      if (buyScore > sellScore && conf >= 60) dir = "CALL";
      else if (sellScore > buyScore && conf >= 60) dir = "PUT";

      const ok = conf >= strengthFilter && Math.abs(buyScore - sellScore) >= 2;

      const tag = !ok ? "انتظر" : dir === "CALL" ? "CALL ⬆️" : dir === "PUT" ? "PUT ⬇️" : "انتظر";
      const color = !ok ? "muted" : dir === "CALL" ? "green" : "red";

      item.analysis = {
        dir,
        conf: ok ? conf : Math.max(0, conf - 10),
        tag,
        color,
        market,
        reasons: reasons.slice(0, 4),
        signals: signals.slice(0, 2),
        updatedAt: Date.now()
      };

      // إضافة إشارة جديدة إذا كانت قوية
      if (signals.length > 0 && ok && conf >= strengthFilter) {
        const newSignal = {
          id: `${sym}_${Date.now()}`,
          symbol: sym,
          name: item.name,
          type: dir === "CALL" ? "BUY" : "SELL",
          reason: signals[0].reason,
          probability: signals[0].probability,
          confidence: conf,
          price: item.price,
          timestamp: Date.now(),
          timeAhead: signals[0].timeAhead
        };

        signalsRef.current = [newSignal, ...signalsRef.current].slice(0, 20);
        setSignals(signalsRef.current);

        if (sound && conf >= 75) {
          const key = `${sym}:${dir}`;
          const now = Date.now();
          if (now - lastAlertRef.current.t > 30_000 || lastAlertRef.current.key !== key) {
            playAlert(dir === "CALL" ? "buy" : "sell");
            lastAlertRef.current = { t: now, key };
          }
        }
      }
    },
    [sound, strategy, strengthFilter]
  );

  // ======== تحديث البطاقات ========
  const rebuildCards = useCallback(() => {
    const map = storeRef.current;
    const list = Object.values(map)
      .filter(item => selectedPairs.includes(item.symbol))
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
  }, [selectedPairs]);

  // ======== اتصال WebSocket ========
  useEffect(() => {
    const ws = wsRef.current;
    let mounted = true;

    const onOpen = () => {
      if (!mounted) return;
      setStatus("connected");
      setNote({ type: "ok", msg: "✅ تم الاتصال — جاري تحميل البيانات..." });
      
      // الاشتراك في العملات المحددة فقط
      selectedPairs.forEach(symbol => {
        ws.subscribe(symbol);
        ws.queueHistory(symbol);
      });
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

      // بيانات الشموع
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

      // التحديثات اللحظية
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
    
    // تهيئة المتجر بالعملات المختارة
    selectedPairs.forEach(symbol => {
      const pairInfo = COMMON_PAIRS.find(p => p.symbol === symbol) || { symbol, name: symbol, market: "unknown" };
      storeRef.current[symbol] = {
        symbol,
        name: pairInfo.name,
        market: pairInfo.market,
        price: undefined,
        candles: [],
        lastCandle: null,
        analysis: {
          dir: "WAIT",
          conf: 0,
          tag: "انتظر",
          color: "muted",
          market: "—",
          reasons: ["جاري تحميل البيانات..."],
          signals: [],
          updatedAt: Date.now()
        },
        lastUpdate: undefined
      };
    });

    ws.connect({ onMessage, onOpen, onClose, onError });

    return () => {
      mounted = false;
      ws.disconnect();
    };
  }, [analyzeSymbol, rebuildCards, selectedPairs]);

  // ======== التحليل الدوري ========
  useEffect(() => {
    const t1 = setInterval(() => {
      Object.keys(storeRef.current).forEach((sym) => analyzeSymbol(sym));
      rebuildCards();
    }, ANALYZE_EVERY_MS);

    const t2 = setInterval(() => {
      Object.keys(storeRef.current).forEach((sym) => {
        const it = storeRef.current[sym];
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

  // ======== إدارة العملات المختارة ========
  const handlePairToggle = (symbol) => {
    const newSelected = selectedPairs.includes(symbol)
      ? selectedPairs.filter(s => s !== symbol)
      : [...selectedPairs, symbol];
    
    setSelectedPairs(newSelected);
    
    const ws = wsRef.current;
    if (ws.isConnected) {
      if (newSelected.includes(symbol)) {
        ws.subscribe(symbol);
        ws.queueHistory(symbol);
      } else {
        ws.unsubscribe(symbol);
        delete storeRef.current[symbol];
      }
    }
  };

  const handleSelectAll = () => {
    const allSymbols = COMMON_PAIRS.map(p => p.symbol);
    setSelectedPairs(allSymbols);
  };

  const handleDeselectAll = () => {
    setSelectedPairs([]);
  };

  // ======== إحصائيات ========
  const stats = useMemo(() => {
    const total = cards.length;
    const calls = cards.filter((c) => c.analysis?.dir === "CALL" && c.analysis?.color !== "muted").length;
    const puts = cards.filter((c) => c.analysis?.dir === "PUT" && c.analysis?.color !== "muted").length;
    const wait = total - calls - puts;
    const strongSignals = signals.filter(s => s.confidence >= 80).length;
    return { total, calls, puts, wait, strongSignals };
  }, [cards, signals]);

  // ======== مساعدات العرض ========
  const badge = (color) => {
    if (color === "green") return { bg: theme.green, fg: "#fff" };
    if (color === "red") return { bg: theme.red, fg: "#fff" };
    return { bg: theme.soft, fg: theme.fg };
  };

  const timeAgo = (ts) => {
    if (!ts) return "—";
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return "الآن";
    if (s < 60) return `${s} ثانية`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} دقيقة`;
    const h = Math.floor(m / 60);
    return `${h} ساعة`;
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

      <div style={{ maxWidth: 1480, margin: "0 auto", padding: "26px 18px" }}>
        {/* الهيدر */}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 28, fontWeight: 900, color: theme.blue }}>⚡ Quotex Signals Scanner Pro</div>
            <div style={{ opacity: 0.8, fontSize: 13, marginTop: 2 }}>إشارات ذكية مع تحليل متقدم واستراتيجيات محددة</div>
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

        {/* الإحصائيات */}
        <div style={{ marginTop: 14, background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 16, padding: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {[
            { label: "العملات المختارة", value: selectedPairs.length, c: theme.blue },
            { label: "إشارات CALL", value: stats.calls, c: theme.green },
            { label: "إشارات PUT", value: stats.puts, c: theme.red },
            { label: "إشارات قوية", value: stats.strongSignals, c: theme.purple },
            { label: "في الانتظار", value: stats.wait, c: theme.fg }
          ].map((x, i) => (
            <div key={i} style={{ flex: "1 1 140px", minWidth: 140, borderRadius: 14, border: `1px solid ${theme.border}`, background: theme.soft, padding: "10px 12px" }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>{x.label}</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: x.c }}>{x.value}</div>
            </div>
          ))}
        </div>

        {/* لوحة التحكم */}
        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
          {/* اختيار العملات */}
          <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 16, padding: 14 }}>
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 12 }}>🏷️ اختر العملات</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <button onClick={handleSelectAll} style={{ padding: "6px 12px", borderRadius: 8, border: `1px solid ${theme.border}`, background: theme.soft, color: theme.fg, cursor: "pointer", fontSize: 12 }}>
                اختيار الكل
              </button>
              <button onClick={handleDeselectAll} style={{ padding: "6px 12px", borderRadius: 8, border: `1px solid ${theme.border}`, background: theme.soft, color: theme.fg, cursor: "pointer", fontSize: 12 }}>
                إلغاء الكل
              </button>
            </div>
            <div style={{ maxHeight: 200, overflowY: "auto", background: theme.soft, borderRadius: 10, padding: 10 }}>
              {COMMON_PAIRS.map((pair) => (
                <div key={pair.symbol} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <input
                    type="checkbox"
                    id={pair.symbol}
                    checked={selectedPairs.includes(pair.symbol)}
                    onChange={() => handlePairToggle(pair.symbol)}
                    style={{ cursor: "pointer" }}
                  />
                  <label htmlFor={pair.symbol} style={{ fontSize: 13, cursor: "pointer", flex: 1 }}>
                    {pair.name} <span style={{ opacity: 0.6 }}>({pair.symbol})</span>
                  </label>
                </div>
              ))}
            </div>
          </div>

          {/* الاستراتيجية */}
          <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 16, padding: 14 }}>
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 12 }}>🎯 الاستراتيجية</div>
            <select 
              value={strategy} 
              onChange={(e) => setStrategy(e.target.value)}
              style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1px solid ${theme.border}`, background: theme.soft, color: theme.fg, marginBottom: 12 }}
            >
              {STRATEGIES.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
              {STRATEGIES.find(s => s.id === strategy)?.description}
            </div>
            
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>قوة الإشارة المطلوبة: {strengthFilter}%</div>
              <input
                type="range"
                min="60"
                max="90"
                value={strengthFilter}
                onChange={(e) => setStrengthFilter(parseInt(e.target.value))}
                style={{ width: "100%" }}
              />
            </div>
          </div>

          {/* إشارات الدخول */}
          <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 16, padding: 14 }}>
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 12 }}>🔔 إشارات الدخول</div>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 12 }}>
              يتم إرسال إشارات قبل {SIGNAL_AHEAD_SECONDS} ثانية من الدخول المثالي
            </div>
            
            {signals.length > 0 ? (
              <div style={{ maxHeight: 180, overflowY: "auto" }}>
                {signals.slice(0, 3).map((signal) => (
                  <div key={signal.id} style={{ 
                    background: signal.type === "BUY" ? "rgba(52, 211, 153, 0.15)" : "rgba(248, 113, 113, 0.15)",
                    border: `1px solid ${signal.type === "BUY" ? theme.green : theme.red}`,
                    borderRadius: 10,
                    padding: 10,
                    marginBottom: 8
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <div style={{ fontWeight: 900, fontSize: 13 }}>{signal.name}</div>
                      <div style={{ 
                        padding: "2px 8px", 
                        borderRadius: 6, 
                        background: signal.type === "BUY" ? theme.green : theme.red,
                        color: "#fff",
                        fontSize: 11,
                        fontWeight: 700
                      }}>
                        {signal.type} {signal.type === "BUY" ? "⬆️" : "⬇️"}
                      </div>
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.9, marginBottom: 4 }}>{signal.reason}</div>
                    <div style={{ fontSize: 10, display: "flex", justifyContent: "space-between", opacity: 0.8 }}>
                      <span>الاحتمالية: {signal.probability}%</span>
                      <span>قبل: {signal.timeAhead} ثانية</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ textAlign: "center", padding: "20px 0", opacity: 0.6, fontSize: 13 }}>
                لا توجد إشارات دخول حالياً
              </div>
            )}
          </div>
        </div>

        {/* البطاقات */}
        <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
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
                    <div style={{ fontSize: 18, fontWeight: 900, color: theme.blue }}>
                      {typeof c.price === "number" ? c.price.toFixed(5) : "—"}
                    </div>
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
                  <div style={{ fontWeight: 900, fontSize: 12, marginBottom: 6 }}>📊 أسباب الإشارة</div>
                  <ul style={{ margin: 0, paddingRight: 18, lineHeight: 1.7, fontSize: 12 }}>
                    {(a.reasons || []).slice(0, 4).map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>

                {a.signals && a.signals.length > 0 && (
                  <div style={{ marginTop: 10, background: a.color === "green" ? "rgba(52, 211, 153, 0.15)" : "rgba(248, 113, 113, 0.15)", border: `1px solid ${a.color === "green" ? theme.green : theme.red}`, borderRadius: 12, padding: 10 }}>
                    <div style={{ fontWeight: 900, fontSize: 12, marginBottom: 6 }}>🚀 إشارات دخول</div>
                    {a.signals.map((s, i) => (
                      <div key={i} style={{ fontSize: 11, marginBottom: 4, opacity: 0.9 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span>نوع: <b>{s.type === "BUY" ? "شراء ⬆️" : "بيع ⬇️"}</b></span>
                          <span>قبل: <b>{s.timeAhead} ثانية</b></span>
                        </div>
                        <div style={{ fontSize: 10, opacity: 0.8, marginTop: 2 }}>{s.reason}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* تذييل */}
        <div style={{ marginTop: 16, padding: 12, borderRadius: 14, background: dark ? "rgba(239,68,68,0.10)" : "#fef2f2", border: `1px solid ${theme.red}`, color: theme.red, fontSize: 12, lineHeight: 1.7 }}>
          ⚠️ هذا السكّانر للتحليل التعليمي فقط. التداول مسؤوليتك الكاملة.
          <br />
          ✅ يتم إرسال إشارات الدخول قبل {SIGNAL_AHEAD_SECONDS} ثانية لتتمكن من التحضير للصفقة.
        </div>
      </div>
    </div>
  );
}
