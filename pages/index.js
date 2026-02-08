import { useEffect, useMemo, useRef, useState, useCallback } from "react";

const ASSETS = [
  { label: "Volatility 75", symbol: "R_75" },
  { label: "Volatility 100", symbol: "R_100" },
  { label: "EUR/USD (OTC)", symbol: "frxEURUSD" },
  { label: "BTC/USD", symbol: "cryBTCUSD" },
  { label: "ETH/USD", symbol: "cryETHUSD" },
  { label: "GBP/USD", symbol: "frxGBPUSD" }
];

const DURATIONS = [
  { label: "10 ثواني", sec: 10 },
  { label: "30 ثانية", sec: 30 },
  { label: "1 دقيقة", sec: 60 },
  { label: "3 دقائق", sec: 180 },
  { label: "5 دقائق", sec: 300 },
  { label: "15 دقيقة", sec: 900 }
];

const LS_KEY = "deriv_analyzer_pro_settings";
const LS_HIST = "deriv_analyzer_pro_history";

const nowSec = () => Math.floor(Date.now() / 1000);
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const stdDev = (arr) => {
  if (!arr.length) return 0;
  const mean = avg(arr);
  return Math.sqrt(arr.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / arr.length);
};
const bucketStart = (epoch, durationSec) => epoch - (epoch % durationSec);

const playAlert = (type = "signal") => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.setValueAtTime(
      type === "buy" ? 800 : type === "sell" ? 400 : type === "warning" ? 600 : 660,
      ctx.currentTime
    );

    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
    setTimeout(() => ctx.close(), 400);
  } catch {}
};

class DerivWSManager {
  constructor() {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1500;
    this.isConnected = false;
    this.reconnectTimer = null;
  }

  connect(onMessage, onOpen, onClose, onError) {
    try {
      this.ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

      this.ws.onopen = () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        onOpen?.();
      };

      this.ws.onmessage = onMessage;

      this.ws.onclose = () => {
        this.isConnected = false;
        onClose?.();
        this.attemptReconnect(onMessage, onOpen, onClose, onError);
      };

      this.ws.onerror = (err) => onError?.(err);
    } catch (err) {
      onError?.(err);
    }
  }

  attemptReconnect(onMessage, onOpen, onClose, onError) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts++;

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect(onMessage, onOpen, onClose, onError);
    }, this.reconnectDelay * this.reconnectAttempts);
  }

  send(payload) {
    if (!this.isConnected || !this.ws) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  subscribeTicks(asset) {
    return this.send({ ticks: asset, subscribe: 1 });
  }

  requestHistoryCandles(asset, durationSec, count = 200) {
    // ✅ حل 10s/30s: نخلي التاريخ 60 ثانية إذا المدة أقل
    const gran = durationSec < 60 ? 60 : durationSec;

    return this.send({
      ticks_history: asset,
      adjust_start_time: 1,
      count,
      end: "latest",
      start: 1,
      style: "candles",
      granularity: gran
    });
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.isConnected = false;
  }
}

export default function Home() {
  // Chart refs
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const srLinesRef = useRef([]); // support/resistance lines (price lines)

  // Data refs
  const wsManagerRef = useRef(new DerivWSManager());
  const candlesRef = useRef([]);
  const lastCandleRef = useRef(null);

  const lastAlertRef = useRef({ time: 0, type: "" });

  // UI state
  const [asset, setAsset] = useState(ASSETS[0].symbol);
  const [durationSec, setDurationSec] = useState(60);
  const [price, setPrice] = useState("-");
  const [countdown, setCountdown] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [dark, setDark] = useState(false);

  const [alertOn, setAlertOn] = useState(true);
  const [alertMinConf, setAlertMinConf] = useState(72);

  const [notification, setNotification] = useState(null);
  const [history, setHistory] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  const [indicators, setIndicators] = useState({
    RSI: true,
    EMA: true,
    MACD: true,
    BB: false,
    Stochastic: false,
    Volume: true, // ✅ خليته true افتراضياً حتى تشتغل
    SR: true // ✅ دعم/مقاومة
  });

  // Fullscreen
  const [isFull, setIsFull] = useState(false);

  const [analysis, setAnalysis] = useState({
    dir: "—",
    conf: 0,
    ok: false,
    market: "انتظر...",
    reasons: ["انتظر..."],
    short: "—"
  });

  // theme
  const theme = useMemo(() => {
    const bg = dark ? "#0f172a" : "#ffffff";
    const fg = dark ? "#f1f5f9" : "#0f172a";
    const card = dark ? "rgba(30, 41, 59, 0.8)" : "#ffffff";
    const border = dark ? "rgba(148, 163, 184, 0.2)" : "#e2e8f0";
    const soft = dark ? "rgba(30, 41, 59, 0.5)" : "#f8fafc";
    const blue = dark ? "#60a5fa" : "#3b82f6";
    const green = dark ? "#34d399" : "#10b981";
    const red = dark ? "#f87171" : "#ef4444";
    return { bg, fg, card, border, soft, blue, green, red };
  }, [dark]);

  // load settings + history
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) {
        const s = JSON.parse(saved);
        if (typeof s.dark === "boolean") setDark(s.dark);
        if (typeof s.durationSec === "number") setDurationSec(s.durationSec);
        if (typeof s.asset === "string") setAsset(s.asset);
        if (typeof s.alertOn === "boolean") setAlertOn(s.alertOn);
        if (typeof s.alertMinConf === "number") setAlertMinConf(s.alertMinConf);
        if (s.indicators) setIndicators((p) => ({ ...p, ...s.indicators }));
      }
    } catch {}

    try {
      const h = localStorage.getItem(LS_HIST);
      if (h) setHistory(JSON.parse(h));
    } catch {}
  }, []);

  // save settings debounce
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          LS_KEY,
          JSON.stringify({ dark, durationSec, asset, alertOn, alertMinConf, indicators })
        );
      } catch {}
    }, 400);
    return () => clearTimeout(t);
  }, [dark, durationSec, asset, alertOn, alertMinConf, indicators]);

  // countdown
  useEffect(() => {
    const interval = setInterval(() => {
      const left = durationSec - (nowSec() % durationSec);
      setCountdown(left);
    }, 1000);
    return () => clearInterval(interval);
  }, [durationSec]);

  // ✅ تحليل دوري: كل دقيقة (حتى لو ما تكمل 40 شمعة)
  useEffect(() => {
    const interval = setInterval(() => {
      runAnalysis("timer_1m");
    }, 60_000);
    return () => clearInterval(interval);
  }, [asset, durationSec, indicators]); // يعتمد على المؤشرات

  // Helper: update S/R (support/resistance)
  const updateSRLines = useCallback(() => {
    if (!chartRef.current || !candleSeriesRef.current) return;
    if (!indicators.SR) {
      // remove lines if disabled
      srLinesRef.current.forEach((l) => candleSeriesRef.current.removePriceLine(l));
      srLinesRef.current = [];
      return;
    }

    const candles = candlesRef.current;
    if (!candles || candles.length < 20) return;

    // clear old
    srLinesRef.current.forEach((l) => candleSeriesRef.current.removePriceLine(l));
    srLinesRef.current = [];

    const lastN = candles.slice(-50);
    const highs = lastN.map((c) => c.high);
    const lows = lastN.map((c) => c.low);

    const resistance = Math.max(...highs);
    const support = Math.min(...lows);

    const rLine = candleSeriesRef.current.createPriceLine({
      price: resistance,
      color: theme.red,
      lineWidth: 2,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "مقاومة"
    });

    const sLine = candleSeriesRef.current.createPriceLine({
      price: support,
      color: theme.green,
      lineWidth: 2,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "دعم"
    });

    srLinesRef.current = [rLine, sLine];
  }, [indicators.SR, theme.red, theme.green]);

  // init chart + volume
  useEffect(() => {
    let chart = null;
    let alive = true;

    const init = async () => {
      if (!alive || !containerRef.current) return;
      const { createChart } = await import("lightweight-charts");

      chart = createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: isFull ? 520 : 400,
        layout: { background: { color: theme.bg }, textColor: theme.fg, fontSize: 12 },
        grid: {
          vertLines: { color: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)" },
          horzLines: { color: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)" }
        },
        timeScale: { timeVisible: true, secondsVisible: durationSec <= 60, rightOffset: 12 },
        crosshair: { mode: 1 }
      });

      const candleSeries = chart.addCandlestickSeries({
        upColor: theme.green,
        downColor: theme.red,
        borderVisible: false,
        wickUpColor: theme.green,
        wickDownColor: theme.red
      });

      chartRef.current = chart;
      candleSeriesRef.current = candleSeries;

      // ✅ Volume series (جاهز حتى لو Off)
      volumeSeriesRef.current = chart.addHistogramSeries({
        priceFormat: { type: "volume" },
        priceScaleId: "vol",
        scaleMargins: { top: 0.8, bottom: 0 }
      });

      const resize = () => {
        if (!chart || !containerRef.current) return;
        chart.applyOptions({ width: containerRef.current.clientWidth });
      };
      window.addEventListener("resize", resize);

      // load any existing candles
      if (candlesRef.current.length) {
        candleSeries.setData(candlesRef.current);
        const volData = candlesRef.current.map((c) => ({
          time: c.time,
          value: c.volume || 0,
          color: c.close >= c.open ? theme.green : theme.red
        }));
        volumeSeriesRef.current.setData(volData);
      }

      updateSRLines();

      return () => window.removeEventListener("resize", resize);
    };

    init();

    return () => {
      alive = false;
      if (chart) chart.remove();
    };
  }, [dark, theme, durationSec, isFull, updateSRLines]);

  // ✅ toggle indicator
  const toggleIndicator = useCallback((k) => {
    setIndicators((p) => ({ ...p, [k]: !p[k] }));
  }, []);

  // ✅ run analysis: حد أدنى 15 شمعة + fallback سريع
  const runAnalysis = useCallback(
    async (source = "manual") => {
      const candles = candlesRef.current;
      if (!candles || candles.length < 15) {
        setAnalysis({
          dir: "—",
          conf: 0,
          ok: false,
          market: "انتظر...",
          short: "قيد جمع البيانات…",
          reasons: [`عدد الشموع الحالي: ${candles?.length || 0} (نحتاج 15 على الأقل)`]
        });
        return;
      }

      const closes = candles.map((c) => c.close);
      const highs = candles.map((c) => c.high);
      const lows = candles.map((c) => c.low);
      const volumes = candles.map((c) => c.volume || 0);

      // ✅ تحليل سريع دائمًا (حتى قبل اكتمال كل المؤشرات)
      const last = closes[closes.length - 1];
      const prev = closes[closes.length - 2];
      const delta = last - prev;

      let buySignals = 0;
      let sellSignals = 0;
      const reasons = [];

      if (delta > 0) {
        buySignals += 1;
        reasons.push("السعر أعلى من الإغلاق السابق (زخم صعودي سريع)");
      } else if (delta < 0) {
        sellSignals += 1;
        reasons.push("السعر أقل من الإغلاق السابق (زخم هبوطي سريع)");
      }

      // market volatility
      const recent = closes.slice(-20);
      const vol = avg(recent) ? stdDev(recent) / avg(recent) : 0;
      const market = vol > 0.02 ? "تذبذب عالي" : vol < 0.005 ? "هادئ" : "طبيعي";

      try {
        const { RSI, EMA, MACD, BollingerBands, Stochastic, SMA } = await import(
          "technicalindicators"
        );

        // ✅ RSI (needs 14)
        if (indicators.RSI && closes.length >= 15) {
          const rsi = RSI.calculate({ values: closes, period: 14 }).slice(-1)[0];
          if (rsi < 30) {
            buySignals += 2;
            reasons.push("RSI تشبع بيع (شراء)");
          } else if (rsi > 70) {
            sellSignals += 2;
            reasons.push("RSI تشبع شراء (بيع)");
          } else if (rsi > 50) {
            buySignals += 1;
            reasons.push("RSI فوق 50 (ميل صعودي)");
          } else {
            sellSignals += 1;
            reasons.push("RSI تحت 50 (ميل هبوطي)");
          }
        }

        // ✅ EMA
        if (indicators.EMA && closes.length >= 25) {
          const ema9 = EMA.calculate({ values: closes, period: 9 }).slice(-1)[0];
          const ema21 = EMA.calculate({ values: closes, period: 21 }).slice(-1)[0];
          if (ema9 > ema21) {
            buySignals += 2;
            reasons.push("EMA9 فوق EMA21 (ترند صاعد)");
          } else {
            sellSignals += 2;
            reasons.push("EMA9 تحت EMA21 (ترند هابط)");
          }
        }

        // ✅ MACD
        if (indicators.MACD && closes.length >= 35) {
          const macdArr = MACD.calculate({
            values: closes,
            fastPeriod: 12,
            slowPeriod: 26,
            signalPeriod: 9,
            SimpleMAOscillator: false,
            SimpleMASignal: false
          });
          const m = macdArr.slice(-1)[0];
          if (m && m.MACD > m.signal) {
            buySignals += 1;
            reasons.push("MACD إيجابي");
          } else if (m) {
            sellSignals += 1;
            reasons.push("MACD سلبي");
          }
        }

        // ✅ Bollinger
        if (indicators.BB && closes.length >= 25) {
          const bb = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 }).slice(
            -1
          )[0];
          if (bb) {
            if (last < bb.lower) {
              buySignals += 2;
              reasons.push("بولنجر: تحت النطاق السفلي (شراء)");
            } else if (last > bb.upper) {
              sellSignals += 2;
              reasons.push("بولنجر: فوق النطاق العلوي (بيع)");
            }
          }
        }

        // ✅ Stochastic
        if (indicators.Stochastic && closes.length >= 20) {
          const st = Stochastic.calculate({
            high: highs,
            low: lows,
            close: closes,
            period: 14,
            signalPeriod: 3
          }).slice(-1)[0];
          if (st) {
            if (st.k < 20 && st.d < 20) {
              buySignals += 1;
              reasons.push("ستوكاستك: تشبع بيع");
            } else if (st.k > 80 && st.d > 80) {
              sellSignals += 1;
              reasons.push("ستوكاستك: تشبع شراء");
            }
          }
        }

        // ✅ Volume confirm
        if (indicators.Volume && volumes.length >= 25) {
          const vSMA = SMA.calculate({ values: volumes, period: 20 }).slice(-1)[0];
          const vLast = volumes[volumes.length - 1];
          if (vSMA && vLast > vSMA * 1.4) {
            reasons.push("حجم عالي (تأكيد محتمل)");
            if (buySignals > sellSignals) buySignals += 1;
            else if (sellSignals > buySignals) sellSignals += 1;
          }
        }
      } catch {
        // technicalindicators may fail build/runtime, keep quick analysis only
        reasons.push("تنبيه: تعذّر تحميل بعض المؤشرات (استخدمنا تحليل سريع)");
      }

      // ✅ كل دقيقة: خلي النتيجة واضحة ومختصرة
      const total = buySignals + sellSignals;
      const conf = total ? Math.round((Math.max(buySignals, sellSignals) / total) * 100) : 0;

      const dir =
        buySignals > sellSignals ? "صعود 📈" : sellSignals > buySignals ? "هبوط 📉" : "محايد ➖";

      // ✅ صلاحية الإشارة
      const ok = conf >= 60 && Math.abs(buySignals - sellSignals) >= 2;

      const short =
        dir === "محايد ➖"
          ? "لا توجد أفضلية واضحة الآن"
          : dir.includes("صعود")
          ? `توصية: صعود لمدة ${Math.min(60, durationSec)} ثانية (إذا تحب دخول سريع)`
          : `توصية: هبوط لمدة ${Math.min(60, durationSec)} ثانية (إذا تحب دخول سريع)`;

      setAnalysis({
        dir,
        conf,
        ok,
        market,
        short,
        reasons: reasons.slice(0, 8)
      });

      // ✅ سجل + تنبيه
      if (ok && (source === "timer_1m" || source === "new_candle" || source === "manual")) {
        const entry = {
          timestamp: Date.now(),
          asset,
          durationSec,
          direction: dir,
          confidence: conf,
          isValid: ok
        };
        const newHist = [entry, ...history].slice(0, 100);
        setHistory(newHist);
        try {
          localStorage.setItem(LS_HIST, JSON.stringify(newHist));
        } catch {}

        if (alertOn && conf >= alertMinConf) {
          const now = Date.now();
          if (now - lastAlertRef.current.time > 30_000) {
            playAlert(dir.includes("صعود") ? "buy" : "sell");
            lastAlertRef.current = { time: now, type: dir };
            setNotification({ type: "info", message: `إشارة ${dir} (${conf}%)`, timestamp: now });
          }
        }
      }
    },
    [asset, durationSec, indicators, history, alertOn, alertMinConf]
  );

  // WebSocket
  useEffect(() => {
    const ws = wsManagerRef.current;
    let mounted = true;

    const onMessage = async (event) => {
      if (!mounted) return;
      try {
        const data = JSON.parse(event.data);

        // candles history
        if (data.candles && Array.isArray(data.candles)) {
          const candlesData = data.candles
            .map((c) => ({
              time: Number(c.epoch),
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
              volume: Number(c.volume) || 0
            }))
            .filter((c) => isFinite(c.time) && isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close))
            .slice(-200);

          candlesRef.current = candlesData;
          lastCandleRef.current = candlesData[candlesData.length - 1] || null;

          if (candleSeriesRef.current) candleSeriesRef.current.setData(candlesData);

          // ✅ update volume chart
          if (volumeSeriesRef.current) {
            const volData = candlesData.map((c) => ({
              time: c.time,
              value: c.volume || 0,
              color: c.close >= c.open ? theme.green : theme.red
            }));
            volumeSeriesRef.current.setData(volData);
          }

          updateSRLines();
          setIsLoading(false);

          // تحليل مباشر بعد استلام التاريخ
          runAnalysis("history");
          return;
        }

        // ticks live
        if (data.tick) {
          const epoch = Math.floor(data.tick.epoch);
          const newPrice = Number(data.tick.quote);
          if (!isFinite(newPrice)) return;

          setPrice(newPrice.toFixed(5));

          const candleStart = bucketStart(epoch, durationSec);
          let current = lastCandleRef.current;

          if (!current || current.time !== candleStart) {
            if (current) {
              candlesRef.current = [...candlesRef.current, current].slice(-200);
            }

            const newCandle = {
              time: candleStart,
              open: newPrice,
              high: newPrice,
              low: newPrice,
              close: newPrice,
              volume: 1
            };

            lastCandleRef.current = newCandle;

            if (candleSeriesRef.current) candleSeriesRef.current.update(newCandle);

            // ✅ volume update per candle
            if (volumeSeriesRef.current) {
              volumeSeriesRef.current.update({
                time: candleStart,
                value: 1,
                color: theme.green
              });
            }

            updateSRLines();
            runAnalysis("new_candle");
          } else {
            const updated = {
              ...current,
              high: Math.max(current.high, newPrice),
              low: Math.min(current.low, newPrice),
              close: newPrice,
              volume: (current.volume || 0) + 1
            };

            lastCandleRef.current = updated;
            if (candleSeriesRef.current) candleSeriesRef.current.update(updated);

            if (volumeSeriesRef.current) {
              volumeSeriesRef.current.update({
                time: updated.time,
                value: updated.volume || 0,
                color: updated.close >= updated.open ? theme.green : theme.red
              });
            }

            // ✅ تحليل خفيف كل 15 ثانية (حتى يصير واضح ومتجدد)
            if (epoch % 15 === 0) runAnalysis("tick_15s");
          }
        }

        if (data.error) {
          setNotification({
            type: "error",
            message: `Deriv: ${data.error.message || "خطأ"}`,
            timestamp: Date.now()
          });
          setIsLoading(false);
        }
      } catch {}
    };

    const onOpen = () => {
      if (!mounted) return;
      setConnectionStatus("connected");
      setNotification({ type: "success", message: "✅ تم الاتصال بالسيرفر", timestamp: Date.now() });

      ws.subscribeTicks(asset);
      setIsLoading(true);
      ws.requestHistoryCandles(asset, durationSec, 200);
    };

    const onClose = () => mounted && setConnectionStatus("disconnected");
    const onError = () => mounted && setConnectionStatus("error");

    setConnectionStatus("connecting");
    ws.connect(onMessage, onOpen, onClose, onError);

    return () => {
      mounted = false;
      ws.disconnect();
    };
  }, [asset, durationSec, theme.green, theme.red, updateSRLines, runAnalysis]);

  const clearHistory = useCallback(() => {
    if (!window.confirm("تمسح السجل؟")) return;
    setHistory([]);
    try { localStorage.removeItem(LS_HIST); } catch {}
  }, []);

  const fullscreenToggle = useCallback(() => setIsFull((v) => !v), []);

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
      {notification && (
        <div
          style={{
            position: "fixed",
            top: 20,
            right: 20,
            left: 20,
            maxWidth: 440,
            margin: "0 auto",
            padding: "12px 16px",
            borderRadius: 12,
            background:
              notification.type === "error" ? theme.red : notification.type === "success" ? theme.green : theme.blue,
            color: "white",
            zIndex: 1000,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)"
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
            <div>{notification.message}</div>
            <button
              onClick={() => setNotification(null)}
              style={{ background: "transparent", border: "none", color: "white", cursor: "pointer" }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: 20 }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, color: theme.blue }}>📈 Deriv Pro Analyzer</h1>
            <div style={{ opacity: 0.8, fontSize: 13 }}>تحليل واضح + شموع + دعم/مقاومة + Volume + Fullscreen</div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span
              style={{
                padding: "6px 10px",
                borderRadius: 20,
                color: "white",
                background:
                  connectionStatus === "connected" ? theme.green : connectionStatus === "connecting" ? "#fbbf24" : theme.red,
                fontSize: 12
              }}
            >
              {connectionStatus === "connected" ? "متصل ✓" : connectionStatus === "connecting" ? "جاري الاتصال..." : "غير متصل ✗"}
            </span>

            <button
              onClick={() => setDark((v) => !v)}
              style={{ padding: "8px 14px", borderRadius: 10, border: `1px solid ${theme.border}`, background: theme.card, color: theme.fg, cursor: "pointer" }}
            >
              {dark ? "☀️ نهاري" : "🌙 ليلي"}
            </button>
          </div>
        </div>

        {/* Controls */}
        <div style={{ background: theme.card, borderRadius: 16, padding: 16, border: `1px solid ${theme.border}`, marginTop: 16 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>الأصل</div>
              <select
                value={asset}
                onChange={(e) => setAsset(e.target.value)}
                style={{ width: "100%", padding: 10, borderRadius: 10, border: `1px solid ${theme.border}`, background: theme.soft, color: theme.fg }}
              >
                {ASSETS.map((a) => (
                  <option key={a.symbol} value={a.symbol}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>المدة</div>
              <select
                value={durationSec}
                onChange={(e) => setDurationSec(Number(e.target.value))}
                style={{ width: "100%", padding: 10, borderRadius: 10, border: `1px solid ${theme.border}`, background: theme.soft, color: theme.fg }}
              >
                {DURATIONS.map((d) => (
                  <option key={d.sec} value={d.sec}>
                    {d.label}
                  </option>
                ))}
              </select>
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                ملاحظة: للـ 10s/30s التاريخ يستخدم 1 دقيقة تلقائيًا حتى ما يصير خطأ.
              </div>
            </div>

            <div style={{ flex: 1, minWidth: 220, display: "flex", gap: 10 }}>
              <div style={{ flex: 1, padding: 12, borderRadius: 12, background: theme.soft, border: `1px solid ${theme.border}` }}>
                <div style={{ fontSize: 12, opacity: 0.75 }}>السعر</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: theme.blue }}>{price}</div>
              </div>
              <div style={{ padding: 12, borderRadius: 12, background: countdown <= 10 ? theme.red : theme.soft, border: `1px solid ${theme.border}`, minWidth: 110 }}>
                <div style={{ fontSize: 12, opacity: 0.75 }}>باقي</div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{countdown}s</div>
              </div>
            </div>
          </div>

          {/* Indicators */}
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>الخيارات</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {Object.entries(indicators).map(([k, v]) => (
                <button
                  key={k}
                  onClick={() => toggleIndicator(k)}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 20,
                    border: `1px solid ${v ? theme.blue : theme.border}`,
                    background: v ? theme.blue : theme.soft,
                    color: v ? "white" : theme.fg,
                    cursor: "pointer",
                    fontSize: 13
                  }}
                >
                  {v ? "✓ " : ""}{k}
                </button>
              ))}

              <button
                onClick={fullscreenToggle}
                style={{
                  padding: "8px 14px",
                  borderRadius: 20,
                  border: `1px solid ${theme.border}`,
                  background: theme.card,
                  color: theme.fg,
                  cursor: "pointer",
                  fontSize: 13
                }}
              >
                {isFull ? "🗗 خروج من التكبير" : "🗖 تكبير الشارت"}
              </button>

              <button
                onClick={() => runAnalysis("manual")}
                disabled={isLoading}
                style={{
                  padding: "8px 14px",
                  borderRadius: 20,
                  border: "none",
                  background: theme.green,
                  color: "white",
                  cursor: "pointer",
                  fontSize: 13,
                  opacity: isLoading ? 0.7 : 1
                }}
              >
                {isLoading ? "تحميل..." : "تحليل الآن"}
              </button>

              <button
                onClick={clearHistory}
                style={{
                  padding: "8px 14px",
                  borderRadius: 20,
                  border: `1px solid ${theme.border}`,
                  background: "transparent",
                  color: theme.fg,
                  cursor: "pointer",
                  fontSize: 13
                }}
              >
                🗑️ مسح السجل
              </button>
            </div>
          </div>

          {/* Alerts */}
          <div style={{ marginTop: 12, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={alertOn} onChange={(e) => setAlertOn(e.target.checked)} />
              <span>تنبيهات صوتية</span>
            </label>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span>عتبة:</span>
              <input type="range" min="50" max="95" value={alertMinConf} onChange={(e) => setAlertMinConf(Number(e.target.value))} />
              <b>{alertMinConf}%</b>
            </div>
          </div>
        </div>

        {/* Chart */}
        <div style={{ background: theme.card, borderRadius: 16, padding: 16, border: `1px solid ${theme.border}`, marginTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: 16 }}>الرسم البياني</div>
              <div style={{ opacity: 0.7, fontSize: 13 }}>{asset} — {DURATIONS.find(d => d.sec === durationSec)?.label}</div>
            </div>
          </div>

          <div
            style={{
              marginTop: 12,
              height: isFull ? 520 : 400,
              borderRadius: 10,
              overflow: "hidden",
              border: `1px solid ${theme.border}`
            }}
            ref={containerRef}
          />
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 8 }}>
            * Volume يظهر أسفل الشارت + دعم/مقاومة خطوط تلقائية.
          </div>
        </div>

        {/* Analysis */}
        <div style={{ background: theme.card, borderRadius: 16, padding: 16, border: `1px solid ${theme.border}`, marginTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div style={{ fontWeight: 900, fontSize: 18 }}>نتائج التحليل</div>
            <div style={{ padding: "6px 12px", borderRadius: 999, background: analysis.ok ? theme.green : theme.red, color: "white", fontWeight: 800 }}>
              {analysis.ok ? "✅ إشارة واضحة" : "⏳ انتظر"}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginTop: 12 }}>
            <div style={{ background: theme.soft, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 14 }}>
              <div style={{ opacity: 0.75 }}>الاتجاه</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: analysis.dir.includes("صعود") ? theme.green : analysis.dir.includes("هبوط") ? theme.red : theme.fg }}>
                {analysis.dir}
              </div>
              <div style={{ marginTop: 8, opacity: 0.85, fontWeight: 700 }}>{analysis.short}</div>
            </div>

            <div style={{ background: theme.soft, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 14 }}>
              <div style={{ opacity: 0.75 }}>الثقة</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: theme.blue }}>{analysis.conf}%</div>
              <div style={{ marginTop: 8, opacity: 0.8 }}>حالة السوق: <b>{analysis.market}</b></div>
            </div>

            <div style={{ background: theme.soft, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 14 }}>
              <div style={{ opacity: 0.75, marginBottom: 8 }}>أسباب</div>
              <ul style={{ margin: 0, paddingRight: 18, lineHeight: 1.7 }}>
                {analysis.reasons?.slice(0, 6).map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          </div>

          <div style={{ marginTop: 12, padding: 10, borderRadius: 10, background: dark ? "rgba(239,68,68,0.12)" : "#fef2f2", border: `1px solid ${theme.red}`, fontSize: 12, color: theme.red }}>
            ⚠️ تنبيه: هذا للتحليل التعليمي فقط. التداول مسؤوليتك.
          </div>
        </div>

        {/* History */}
        <div style={{ background: theme.card, borderRadius: 16, padding: 16, border: `1px solid ${theme.border}`, marginTop: 16 }}>
          <div style={{ fontWeight: 900, fontSize: 18 }}>السجل (آخر 10)</div>
          <div style={{ marginTop: 10, borderRadius: 10, overflow: "hidden", border: `1px solid ${theme.border}` }}>
            {history.slice(0, 10).map((h, i) => (
              <div key={i} style={{ padding: 12, background: i % 2 ? "transparent" : theme.soft, display: "flex", justifyContent: "space-between", gap: 10 }}>
                <div>
                  <div style={{ fontWeight: 800 }}>{h.direction} — {h.confidence}%</div>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>{new Date(h.timestamp).toLocaleString("ar-IQ")} | {h.asset}</div>
                </div>
                <div style={{ padding: "4px 10px", borderRadius: 999, background: h.isValid ? theme.green : theme.red, color: "white", fontWeight: 800, fontSize: 12 }}>
                  {h.isValid ? "صالح" : "ضعيف"}
                </div>
              </div>
            ))}
            {history.length === 0 && <div style={{ padding: 18, opacity: 0.6 }}>لا يوجد سجل بعد</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
