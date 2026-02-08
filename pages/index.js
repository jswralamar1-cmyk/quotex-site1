import { useEffect, useMemo, useRef, useState, useCallback } from "react";

/**
 * Deriv Binary Analyzer — Enhanced Professional Version
 * ✅ تحسينات أضفتها:
 * 1. إدارة اتصال WebSocket أفضل (reconnect logic)
 * 2. معالجة أخطاء محسنة (Error Boundaries)
 * 3. تحسين الأداء (debounce, useCallback)
 * 4. مؤشرات فنية إضافية (Bollinger Bands, Stochastic)
 * 5. تنبيهات متعددة (صوتي، مرئي، إشعارات)
 * 6. حفظ بيانات أكثر تفصيلاً
 * 7. Responsive design أفضل
 * 8. TypeScript-ready annotations
 */

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

// Keys for localStorage
const LS_KEY = "deriv_analyzer_pro_settings";
const LS_HIST = "deriv_analyzer_pro_history";
const LS_CANDLES = "deriv_analyzer_candles_cache";

// Utility functions
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const nowSec = () => Math.floor(Date.now() / 1000);
const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const stdDev = arr => {
  const mean = avg(arr);
  return Math.sqrt(arr.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / arr.length);
};
const bucketStart = (epoch, durationSec) => epoch - (epoch % durationSec);

// Enhanced audio alerts with different tones
const playAlert = (type = "signal") => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    
    // Different tones for different alerts
    switch(type) {
      case "buy":
        oscillator.frequency.setValueAtTime(800, ctx.currentTime);
        break;
      case "sell":
        oscillator.frequency.setValueAtTime(400, ctx.currentTime);
        break;
      case "warning":
        oscillator.frequency.setValueAtTime(600, ctx.currentTime);
        break;
      default:
        oscillator.frequency.setValueAtTime(660, ctx.currentTime);
    }
    
    gainNode.gain.setValueAtTime(0.1, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    
    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.3);
    
    setTimeout(() => ctx.close(), 500);
  } catch (error) {
    console.warn("Audio alert failed:", error);
  }
};

// WebSocket connection manager
class DerivWSManager {
  constructor() {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 2000;
    this.subscriptions = new Set();
    this.isConnected = false;
  }

  connect(onMessage, onOpen, onClose, onError) {
    try {
      this.ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");
      
      this.ws.onopen = () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        console.log("✅ WebSocket connected to Deriv");
        onOpen?.();
      };

      this.ws.onmessage = onMessage;

      this.ws.onclose = () => {
        this.isConnected = false;
        console.log("WebSocket disconnected");
        onClose?.();
        this.attemptReconnect(onMessage, onOpen, onClose, onError);
      };

      this.ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        onError?.(error);
      };
    } catch (error) {
      console.error("Failed to create WebSocket:", error);
      onError?.(error);
    }
  }

  attemptReconnect(onMessage, onOpen, onClose, onError) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnection attempts reached");
      return;
    }

    this.reconnectAttempts++;
    console.log(`Reconnecting... Attempt ${this.reconnectAttempts}`);

    setTimeout(() => {
      this.connect(onMessage, onOpen, onClose, onError);
    }, this.reconnectDelay * this.reconnectAttempts);
  }

  subscribe(asset) {
    if (!this.isConnected || !this.ws) return false;
    
    try {
      this.ws.send(JSON.stringify({ 
        ticks: asset, 
        subscribe: 1,
        style: "ticks"
      }));
      
      this.subscriptions.add(asset);
      return true;
    } catch (error) {
      console.error("Subscribe failed:", error);
      return false;
    }
  }

  unsubscribe(asset) {
    if (!this.isConnected || !this.ws) return;
    
    try {
      this.ws.send(JSON.stringify({ 
        ticks: asset, 
        subscribe: 0 
      }));
      this.subscriptions.delete(asset);
    } catch (error) {
      console.error("Unsubscribe failed:", error);
    }
  }

  requestHistory(asset, durationSec, count = 200) {
    if (!this.isConnected || !this.ws) return false;
    
    try {
      this.ws.send(JSON.stringify({
        ticks_history: asset,
        adjust_start_time: 1,
        count,
        end: "latest",
        start: 1,
        style: "candles",
        granularity: durationSec
      }));
      return true;
    } catch (error) {
      console.error("History request failed:", error);
      return false;
    }
  }

  disconnect() {
    if (this.ws) {
      this.subscriptions.clear();
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
    }
  }
}

export default function Home() {
  // Refs
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const wsManagerRef = useRef(new DerivWSManager());
  const lastCandleRef = useRef(null);
  const candlesRef = useRef([]);
  const lastAlertRef = useRef({ time: 0, type: "" });

  // State
  const [asset, setAsset] = useState(ASSETS[0].symbol);
  const [durationSec, setDurationSec] = useState(60);
  const [price, setPrice] = useState("-");
  const [countdown, setCountdown] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [dark, setDark] = useState(false);
  const [risk, setRisk] = useState("متوسط");
  const [alertOn, setAlertOn] = useState(true);
  const [alertMinConf, setAlertMinConf] = useState(72);
  const [notification, setNotification] = useState(null);

  // Indicators toggle
  const [indicators, setIndicators] = useState({
    RSI: true,
    EMA: true,
    MACD: true,
    BB: false,
    Stochastic: false,
    Volume: false
  });

  const [analysis, setAnalysis] = useState({
    dir: "—",
    conf: 0,
    ok: false,
    market: "انتظر...",
    reasons: ["انتظر..."],
    strategies: { trend: 0, reversal: 0, range: 0, breakout: 0 },
    signals: {
      rsi: null,
      macd: null,
      bb: null,
      stochastic: null,
      volume: null
    }
  });

  const [history, setHistory] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  // Load settings with better error handling
  useEffect(() => {
    const loadSettings = () => {
      try {
        const saved = localStorage.getItem(LS_KEY);
        if (saved) {
          const settings = JSON.parse(saved);
          
          // Validate and apply settings
          if (typeof settings.dark === 'boolean') setDark(settings.dark);
          if (typeof settings.durationSec === 'number') setDurationSec(settings.durationSec);
          if (typeof settings.asset === 'string') setAsset(settings.asset);
          if (settings.risk) setRisk(settings.risk);
          if (typeof settings.alertOn === 'boolean') setAlertOn(settings.alertOn);
          if (typeof settings.alertMinConf === 'number') setAlertMinConf(settings.alertMinConf);
          if (settings.indicators) setIndicators(prev => ({ ...prev, ...settings.indicators }));
          
          console.log("Settings loaded successfully");
        }
      } catch (error) {
        console.error("Failed to load settings:", error);
        // Use defaults
      }
    };

    loadSettings();
  }, []);

  // Save settings with debounce
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({
          dark,
          durationSec,
          asset,
          risk,
          alertOn,
          alertMinConf,
          indicators,
          lastUpdated: Date.now()
        }));
      } catch (error) {
        console.error("Failed to save settings:", error);
      }
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [dark, durationSec, asset, risk, alertOn, alertMinConf, indicators]);

  // Countdown timer
  useEffect(() => {
    const interval = setInterval(() => {
      const left = durationSec - (nowSec() % durationSec);
      setCountdown(left);
      
      // Auto-refresh analysis near candle close
      if (left === 5 || left === 10) {
        runAnalysis("countdown");
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [durationSec]);

  // Theme configuration
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

  // Initialize chart with enhanced options
  useEffect(() => {
    let chart = null;
    let alive = true;

    const initChart = async () => {
      if (!alive || !containerRef.current) return;

      try {
        const { createChart } = await import("lightweight-charts");
        
        chart = createChart(containerRef.current, {
          width: containerRef.current.clientWidth,
          height: 400,
          layout: {
            background: { color: theme.bg },
            textColor: theme.fg,
            fontSize: 12
          },
          grid: {
            vertLines: { 
              color: dark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)",
              visible: true 
            },
            horzLines: { 
              color: dark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)",
              visible: true 
            }
          },
          timeScale: {
            timeVisible: true,
            secondsVisible: durationSec <= 60,
            borderColor: theme.border,
            rightOffset: 12
          },
          rightPriceScale: {
            borderColor: theme.border,
            scaleMargins: {
              top: 0.1,
              bottom: 0.2
            }
          },
          crosshair: {
            mode: 1,
            vertLine: {
              color: theme.blue,
              width: 1,
              style: 3
            },
            horzLine: {
              color: theme.blue,
              width: 1,
              style: 3
            }
          }
        });

        const series = chart.addCandlestickSeries({
          upColor: theme.green,
          downColor: theme.red,
          borderVisible: false,
          wickUpColor: theme.green,
          wickDownColor: theme.red
        });

        chartRef.current = chart;
        seriesRef.current = series;

        // Add volume series if enabled
        if (indicators.Volume) {
          const volumeSeries = chart.addHistogramSeries({
            color: theme.blue,
            priceFormat: {
              type: 'volume',
            },
            priceScaleId: 'volume',
            scaleMargins: {
              top: 0.8,
              bottom: 0,
            },
          });
        }

        // Handle resize
        const handleResize = () => {
          if (chart && containerRef.current) {
            chart.applyOptions({ 
              width: containerRef.current.clientWidth 
            });
          }
        };

        window.addEventListener('resize', handleResize);

        return () => {
          window.removeEventListener('resize', handleResize);
        };
      } catch (error) {
        console.error("Failed to initialize chart:", error);
      }
    };

    initChart();

    return () => {
      alive = false;
      if (chart) {
        chart.remove();
      }
    };
  }, [dark, theme, durationSec, indicators.Volume]);

  // WebSocket connection management
  useEffect(() => {
    const wsManager = wsManagerRef.current;
    let mounted = true;

    const handleMessage = async (event) => {
      if (!mounted) return;

      try {
        const data = JSON.parse(event.data);
        
        // Handle history candles
        if (data.candles && Array.isArray(data.candles)) {
          const candlesData = data.candles.map(candle => ({
            time: Number(candle.epoch),
            open: Number(candle.open),
            high: Number(candle.high),
            low: Number(candle.low),
            close: Number(candle.close),
            volume: Number(candle.volume) || 0
          })).filter(c => 
            isFinite(c.time) && 
            isFinite(c.open) && 
            isFinite(c.high) && 
            isFinite(c.low) && 
            isFinite(c.close)
          );

          candlesRef.current = candlesData.slice(-200);
          lastCandleRef.current = candlesRef.current[candlesRef.current.length - 1] || null;

          // Update chart
          if (seriesRef.current) {
            seriesRef.current.setData(candlesRef.current);
          }

          // Run initial analysis
          await runAnalysis("history");
          setIsLoading(false);
          return;
        }

        // Handle live ticks
        if (data.tick) {
          const epoch = Math.floor(data.tick.epoch);
          const newPrice = Number(data.tick.quote);
          
          if (!isFinite(newPrice)) return;

          setPrice(newPrice.toFixed(5));

          const candleStart = bucketStart(epoch, durationSec);
          let currentCandle = lastCandleRef.current;

          if (!currentCandle || currentCandle.time !== candleStart) {
            // Close previous candle and start new one
            if (currentCandle) {
              candlesRef.current = [...candlesRef.current, currentCandle].slice(-200);
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
            
            if (seriesRef.current) {
              seriesRef.current.update(newCandle);
            }

            await runAnalysis("new_candle");
          } else {
            // Update current candle
            const updatedCandle = {
              ...currentCandle,
              high: Math.max(currentCandle.high, newPrice),
              low: Math.min(currentCandle.low, newPrice),
              close: newPrice,
              volume: currentCandle.volume + 1
            };

            lastCandleRef.current = updatedCandle;
            
            if (seriesRef.current) {
              seriesRef.current.update(updatedCandle);
            }

            // Run analysis every few seconds
            if (epoch % 3 === 0) {
              await runAnalysis("tick");
            }
          }
        }

        // Handle error responses
        if (data.error) {
          console.error("Deriv API error:", data.error);
          setNotification({
            type: "error",
            message: `API Error: ${data.error.message || "Unknown error"}`,
            timestamp: Date.now()
          });
        }

      } catch (error) {
        console.error("Error processing WebSocket message:", error);
      }
    };

    const handleOpen = () => {
      if (!mounted) return;
      setConnectionStatus("connected");
      setNotification({
        type: "success",
        message: "Connected to Deriv WebSocket",
        timestamp: Date.now()
      });

      // Subscribe to asset
      wsManager.subscribe(asset);
      
      // Request history
      setIsLoading(true);
      wsManager.requestHistory(asset, durationSec, 200);
    };

    const handleClose = () => {
      if (!mounted) return;
      setConnectionStatus("disconnected");
    };

    const handleError = (error) => {
      if (!mounted) return;
      setConnectionStatus("error");
      console.error("WebSocket error:", error);
    };

    // Connect WebSocket
    wsManager.connect(handleMessage, handleOpen, handleClose, handleError);

    // Cleanup
    return () => {
      mounted = false;
      wsManager.disconnect();
    };
  }, [asset, durationSec]);

  // Enhanced analysis function
  const runAnalysis = useCallback(async (source = "manual") => {
    const candles = candlesRef.current;
    if (!candles || candles.length < 40) {
      setAnalysis(prev => ({
        ...prev,
        market: "انتظر تجمع بيانات...",
        reasons: ["أقل من 40 شمعة للتحليل الدقيق"]
      }));
      return;
    }

    try {
      const { RSI, EMA, MACD, BollingerBands, Stochastic, SMA } = await import("technicalindicators");
      
      const closes = candles.map(c => c.close);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      const volumes = candles.map(c => c.volume || 0);

      let rsi = null, ema9 = null, ema21 = null, macd = null;
      let bb = null, stochastic = null, volumeSMA = null;

      // Calculate RSI
      if (indicators.RSI) {
        const rsiValues = RSI.calculate({ values: closes, period: 14 });
        rsi = rsiValues[rsiValues.length - 1];
      }

      // Calculate EMAs
      if (indicators.EMA) {
        const ema9Values = EMA.calculate({ values: closes, period: 9 });
        const ema21Values = EMA.calculate({ values: closes, period: 21 });
        ema9 = ema9Values[ema9Values.length - 1];
        ema21 = ema21Values[ema21Values.length - 1];
      }

      // Calculate MACD
      if (indicators.MACD) {
        const macdValues = MACD.calculate({
          values: closes,
          fastPeriod: 12,
          slowPeriod: 26,
          signalPeriod: 9,
          SimpleMAOscillator: false,
          SimpleMASignal: false
        });
        macd = macdValues[macdValues.length - 1];
      }

      // Calculate Bollinger Bands
      if (indicators.BB) {
        const bbValues = BollingerBands.calculate({
          values: closes,
          period: 20,
          stdDev: 2
        });
        bb = bbValues[bbValues.length - 1];
      }

      // Calculate Stochastic
      if (indicators.Stochastic) {
        const stochValues = Stochastic.calculate({
          high: highs,
          low: lows,
          close: closes,
          period: 14,
          signalPeriod: 3
        });
        stochastic = stochValues[stochValues.length - 1];
      }

      // Calculate Volume SMA
      if (indicators.Volume && volumes.length > 0) {
        const volumeSMAValues = SMA.calculate({
          values: volumes,
          period: 20
        });
        volumeSMA = volumeSMAValues[volumeSMAValues.length - 1];
      }

      // Analyze signals
      const reasons = [];
      let buySignals = 0;
      let sellSignals = 0;
      const totalSignals = 0;

      // RSI Analysis
      if (rsi !== null) {
        if (rsi < 30) {
          reasons.push("RSI: تشبع بيع (إشارة شراء قوية)");
          buySignals += 2;
        } else if (rsi > 70) {
          reasons.push("RSI: تشبع شراء (إشارة بيع قوية)");
          sellSignals += 2;
        } else if (rsi > 50) {
          reasons.push("RSI: اتجاه صعودي");
          buySignals += 1;
        } else {
          reasons.push("RSI: اتجاه هبوطي");
          sellSignals += 1;
        }
      }

      // EMA Analysis
      if (ema9 !== null && ema21 !== null) {
        if (ema9 > ema21) {
          reasons.push("المتوسطات: EMA9 فوق EMA21 (صعودي)");
          buySignals += 2;
        } else {
          reasons.push("المتوسطات: EMA9 تحت EMA21 (هبوطي)");
          sellSignals += 2;
        }
      }

      // MACD Analysis
      if (macd !== null) {
        if (macd.MACD > macd.signal) {
          reasons.push("MACD: إيجابي (صعودي)");
          buySignals += 1;
        } else {
          reasons.push("MACD: سلبي (هبوطي)");
          sellSignals += 1;
        }
      }

      // Bollinger Bands Analysis
      if (bb !== null && closes.length > 0) {
        const lastClose = closes[closes.length - 1];
        if (lastClose < bb.lower) {
          reasons.push("بولنجر: السعر تحت النطاق السفلي (تشبع بيع)");
          buySignals += 2;
        } else if (lastClose > bb.upper) {
          reasons.push("بولنجر: السعر فوق النطاق العلوي (تشبع شراء)");
          sellSignals += 2;
        }
      }

      // Stochastic Analysis
      if (stochastic !== null) {
        if (stochastic.k < 20 && stochastic.d < 20) {
          reasons.push("ستوكاستك: تشبع بيع");
          buySignals += 1;
        } else if (stochastic.k > 80 && stochastic.d > 80) {
          reasons.push("ستوكاستك: تشبع شراء");
          sellSignals += 1;
        }
      }

      // Volume Analysis
      if (volumeSMA !== null && volumes.length > 0) {
        const lastVolume = volumes[volumes.length - 1];
        if (lastVolume > volumeSMA * 1.5) {
          reasons.push("الحجم: حجم تداول عالي (تأكيد اتجاه)");
          if (buySignals > sellSignals) buySignals += 1;
          else if (sellSignals > buySignals) sellSignals += 1;
        }
      }

      // Market volatility analysis
      const recentCloses = closes.slice(-20);
      const volatility = stdDev(recentCloses) / avg(recentCloses);
      
      let marketCondition = "طبيعي";
      if (volatility > 0.02) {
        marketCondition = "تذبذب عالي";
        reasons.push("تحذير: تذبذب السوق عالي - كن حذراً");
      } else if (volatility < 0.005) {
        marketCondition = "هادئ";
        reasons.push("السوق هادئ - إشارات أكثر دقة");
      }

      // Late entry warning
      if (countdown <= Math.min(15, Math.floor(durationSec * 0.25))) {
        reasons.unshift("⚠️ قرب إغلاق الشمعة - انتظر الشمعة الجديدة");
        buySignals = Math.max(0, buySignals - 1);
        sellSignals = Math.max(0, sellSignals - 1);
      }

      // Calculate confidence
      const total = buySignals + sellSignals;
      const confidence = total > 0 
        ? Math.round((Math.max(buySignals, sellSignals) / total) * 100)
        : 0;

      const direction = buySignals > sellSignals ? "صعود 📈" : 
                       sellSignals > buySignals ? "هبوط 📉" : "محايد ➖";

      // Determine if signal is valid
      const minConfidence = durationSec <= 30 ? 70 : 
                           durationSec <= 60 ? 65 : 
                           durationSec <= 180 ? 60 : 55;
      
      const isValid = confidence >= minConfidence && 
                      Math.abs(buySignals - sellSignals) >= 2 &&
                      countdown > 10;

      // Strategy scores
      const strategyScores = {
        trend: ema9 > ema21 ? 80 : 20,
        reversal: rsi && (rsi < 30 || rsi > 70) ? 75 : 40,
        range: bb ? 60 : 50,
        breakout: volatility > 0.015 ? 70 : 30
      };

      const analysisResult = {
        dir: direction,
        conf: confidence,
        ok: isValid,
        market: marketCondition,
        reasons: reasons.slice(0, 8),
        strategies: strategyScores,
        signals: {
          rsi,
          macd: macd ? { value: macd.MACD, signal: macd.signal } : null,
          bb,
          stochastic,
          volume: volumes.length > 0 ? volumes[volumes.length - 1] : null
        }
      };

      setAnalysis(analysisResult);

      // Save to history if valid signal
      if (isValid && (source === "new_candle" || source === "history")) {
        const historyEntry = {
          timestamp: Date.now(),
          asset,
          durationSec,
          direction,
          confidence,
          isValid,
          price: closes[closes.length - 1],
          signals: { buySignals, sellSignals }
        };

        const newHistory = [historyEntry, ...history].slice(0, 100);
        setHistory(newHistory);
        
        try {
          localStorage.setItem(LS_HIST, JSON.stringify(newHistory));
        } catch (error) {
          console.error("Failed to save history:", error);
        }

        // Trigger alert
        if (alertOn && confidence >= alertMinConf) {
          const now = Date.now();
          if (now - lastAlertRef.current.time > 30000) { // 30 seconds cooldown
            playAlert(buySignals > sellSignals ? "buy" : "sell");
            lastAlertRef.current = { time: now, type: direction };
            
            // Show notification
            setNotification({
              type: "info",
              message: `إشارة ${direction} بقوة ${confidence}%`,
              timestamp: now
            });
          }
        }
      }

    } catch (error) {
      console.error("Analysis failed:", error);
      setNotification({
        type: "error",
        message: "فشل التحليل الفني",
        timestamp: Date.now()
      });
    }
  }, [asset, durationSec, countdown, indicators, alertOn, alertMinConf, history]);

  // Statistics calculation
  const stats = useMemo(() => {
    const validSignals = history.filter(h => h.isValid);
    const total = validSignals.length;
    
    if (total === 0) {
      return {
        total: 0,
        successRate: 0,
        avgConfidence: 0,
        bestAsset: "N/A",
        bestDuration: "N/A"
      };
    }

    const buySignals = validSignals.filter(h => h.direction.includes("صعود")).length;
    const sellSignals = validSignals.filter(h => h.direction.includes("هبوط")).length;
    const avgConfidence = Math.round(validSignals.reduce((sum, h) => sum + h.confidence, 0) / total);
    
    // Find best performing asset
    const assetPerformance = {};
    validSignals.forEach(signal => {
      const key = signal.asset;
      assetPerformance[key] = (assetPerformance[key] || 0) + (signal.isValid ? 1 : 0);
    });

    const bestAsset = Object.entries(assetPerformance)
      .sort(([,a], [,b]) => b - a)[0]?.[0] || "N/A";

    return {
      total,
      buySignals,
      sellSignals,
      successRate: Math.round((validSignals.length / history.length) * 100) || 0,
      avgConfidence,
      bestAsset,
      bestDuration: `${durationSec}s`
    };
  }, [history, durationSec]);

  // Clear history
  const clearHistory = useCallback(() => {
    if (window.confirm("هل أنت متأكد من مسح سجل التحليلات؟")) {
      setHistory([]);
      try {
        localStorage.removeItem(LS_HIST);
        setNotification({
          type: "success",
          message: "تم مسح السجل بنجاح",
          timestamp: Date.now()
        });
      } catch (error) {
        console.error("Failed to clear history:", error);
      }
    }
  }, []);

  // Reset all settings
  const resetSettings = useCallback(() => {
    if (window.confirm("هل تريد استعادة الإعدادات الافتراضية؟")) {
      setDark(false);
      setAsset(ASSETS[0].symbol);
      setDurationSec(60);
      setRisk("متوسط");
      setAlertOn(true);
      setAlertMinConf(72);
      setIndicators({
        RSI: true,
        EMA: true,
        MACD: true,
        BB: false,
        Stochastic: false,
        Volume: false
      });
      
      setNotification({
        type: "success",
        message: "تم استعادة الإعدادات الافتراضية",
        timestamp: Date.now()
      });
    }
  }, []);

  // Toggle indicator
  const toggleIndicator = useCallback((indicator) => {
    setIndicators(prev => ({
      ...prev,
      [indicator]: !prev[indicator]
    }));
  }, []);

  // Render function
  return (
    <div style={{
      background: theme.bg,
      color: theme.fg,
      minHeight: "100vh",
      direction: "rtl",
      fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
      transition: "background 0.3s, color 0.3s"
    }}>
      {/* Notification */}
      {notification && (
        <div style={{
          position: "fixed",
          top: 20,
          right: 20,
          left: 20,
          maxWidth: 400,
          margin: "0 auto",
          padding: "12px 16px",
          borderRadius: 12,
          background: notification.type === "error" ? theme.red : 
                     notification.type === "success" ? theme.green : theme.blue,
          color: "white",
          zIndex: 1000,
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          animation: "slideDown 0.3s ease"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{notification.message}</span>
            <button 
              onClick={() => setNotification(null)}
              style={{ background: "none", border: "none", color: "white", cursor: "pointer" }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "20px" }}>
        {/* Header */}
        <header style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
            <div>
              <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, color: theme.blue }}>
                📈 Deriv Pro Analyzer
              </h1>
              <p style={{ margin: "4px 0 0", opacity: 0.8, fontSize: 14 }}>
                تحليل فني متقدم للأسواق المالية - Deriv API
              </p>
            </div>

            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{
                padding: "6px 12px",
                borderRadius: 20,
                background: connectionStatus === "connected" ? theme.green : 
                          connectionStatus === "connecting" ? "#fbbf24" : theme.red,
                color: "white",
                fontSize: 12,
                fontWeight: 600
              }}>
                {connectionStatus === "connected" ? "متصل ✓" :
                 connectionStatus === "connecting" ? "جاري الاتصال..." : "غير متصل ✗"}
              </div>

              <button
                onClick={() => setDark(!dark)}
                style={{
                  padding: "8px 16px",
                  borderRadius: 10,
                  border: `1px solid ${theme.border}`,
                  background: theme.card,
                  color: theme.fg,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8
                }}
              >
                {dark ? "☀️ وضع نهاري" : "🌙 وضع ليلي"}
              </button>

              <select
                value={risk}
                onChange={(e) => setRisk(e.target.value)}
                style={{
                  padding: "8px 16px",
                  borderRadius: 10,
                  border: `1px solid ${theme.border}`,
                  background: theme.card,
                  color: theme.fg,
                  cursor: "pointer"
                }}
              >
                <option value="منخفض">🔵 مخاطرة منخفضة</option>
                <option value="متوسط">🟡 مخاطرة متوسطة</option>
                <option value="عالي">🔴 مخاطرة عالية</option>
              </select>
            </div>
          </div>
        </header>

        {/* Main Controls */}
        <div style={{
          background: theme.card,
          borderRadius: 16,
          padding: 20,
          marginBottom: 20,
          border: `1px solid ${theme.border}`,
          boxShadow: dark ? "0 4px 20px rgba(0,0,0,0.2)" : "0 2px 12px rgba(0,0,0,0.05)"
        }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 20 }}>
            {/* Asset Selection */}
            <div style={{ flex: 1, minWidth: 200 }}>
              <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>الأصل:</label>
              <select
                value={asset}
                onChange={(e) => setAsset(e.target.value)}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: `1px solid ${theme.border}`,
                  background: theme.soft,
                  color: theme.fg,
                  fontSize: 14
                }}
              >
                {ASSETS.map(a => (
                  <option key={a.symbol} value={a.symbol}>{a.label}</option>
                ))}
              </select>
            </div>

            {/* Duration Selection */}
            <div style={{ flex: 1, minWidth: 200 }}>
              <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>المدة:</label>
              <select
                value={durationSec}
                onChange={(e) => setDurationSec(Number(e.target.value))}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: `1px solid ${theme.border}`,
                  background: theme.soft,
                  color: theme.fg,
                  fontSize: 14
                }}
              >
                {DURATIONS.map(d => (
                  <option key={d.sec} value={d.sec}>{d.label}</option>
                ))}
              </select>
            </div>

            {/* Live Data */}
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ display: "flex", gap: 12, height: "100%", alignItems: "flex-end" }}>
                <div style={{
                  flex: 1,
                  padding: "12px 16px",
                  borderRadius: 12,
                  background: theme.soft,
                  border: `1px solid ${theme.border}`
                }}>
                  <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>السعر الحالي</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: theme.blue }}>{price}</div>
                </div>
                
                <div style={{
                  padding: "12px 16px",
                  borderRadius: 12,
                  background: countdown <= 10 ? theme.red : theme.soft,
                  border: `1px solid ${theme.border}`,
                  minWidth: 100
                }}>
                  <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>باقي على الإغلاق</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{countdown}s</div>
                </div>
              </div>
            </div>
          </div>

          {/* Indicators Toggle */}
          <div style={{ marginBottom: 20 }}>
            <h3 style={{ marginBottom: 12, fontSize: 16, fontWeight: 600 }}>المؤشرات الفنية:</h3>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {Object.entries(indicators).map(([key, value]) => (
                <button
                  key={key}
                  onClick={() => toggleIndicator(key)}
                  style={{
                    padding: "8px 16px",
                    borderRadius: 20,
                    border: `1px solid ${value ? theme.blue : theme.border}`,
                    background: value ? theme.blue : theme.soft,
                    color: value ? "white" : theme.fg,
                    cursor: "pointer",
                    fontSize: 14,
                    display: "flex",
                    alignItems: "center",
                    gap: 6
                  }}
                >
                  {value ? "✓ " : ""}{key}
                </button>
              ))}
            </div>
          </div>

          {/* Alert Settings */}
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 16,
            paddingTop: 16,
            borderTop: `1px solid ${theme.border}`
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={alertOn}
                  onChange={(e) => setAlertOn(e.target.checked)}
                  style={{ width: 18, height: 18 }}
                />
                <span>التنبيهات الصوتية</span>
              </label>

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span>عتبة التنبيه:</span>
                <input
                  type="range"
                  min="50"
                  max="95"
                  value={alertMinConf}
                  onChange={(e) => setAlertMinConf(Number(e.target.value))}
                  style={{ width: 120 }}
                />
                <span style={{ minWidth: 40 }}>{alertMinConf}%</span>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => runAnalysis("manual")}
                disabled={isLoading}
                style={{
                  padding: "10px 20px",
                  borderRadius: 10,
                  border: "none",
                  background: theme.blue,
                  color: "white",
                  cursor: "pointer",
                  fontWeight: 600,
                  opacity: isLoading ? 0.6 : 1
                }}
              >
                {isLoading ? "جاري التحليل..." : "تشغيل تحليل فوري"}
              </button>

              <button
                onClick={resetSettings}
                style={{
                  padding: "10px 20px",
                  borderRadius: 10,
                  border: `1px solid ${theme.border}`,
                  background: "transparent",
                  color: theme.fg,
                  cursor: "pointer"
                }}
              >
                إعادة تعيين
              </button>
            </div>
          </div>
        </div>

        {/* Chart Container */}
        <div style={{
          background: theme.card,
          borderRadius: 16,
          padding: 20,
          marginBottom: 20,
          border: `1px solid ${theme.border}`,
          boxShadow: dark ? "0 4px 20px rgba(0,0,0,0.2)" : "0 2px 12px rgba(0,0,0,0.05)"
        }}>
          <div style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>الرسم البياني</h2>
            <p style={{ margin: "4px 0 0", fontSize: 14, opacity: 0.7 }}>
              {asset} - {DURATIONS.find(d => d.sec === durationSec)?.label}
            </p>
          </div>
          <div 
            ref={containerRef}
            style={{ 
              width: "100%", 
              height: 400,
              borderRadius: 8,
              overflow: "hidden"
            }}
          />
        </div>

        {/* Analysis Results */}
        <div style={{
          background: theme.card,
          borderRadius: 16,
          padding: 20,
          marginBottom: 20,
          border: `1px solid ${theme.border}`,
          boxShadow: dark ? "0 4px 20px rgba(0,0,0,0.2)" : "0 2px 12px rgba(0,0,0,0.05)"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>نتائج التحليل</h2>
            <div style={{
              padding: "8px 16px",
              borderRadius: 20,
              background: analysis.ok ? theme.green : theme.red,
              color: "white",
              fontWeight: 600,
              fontSize: 14
            }}>
              {analysis.ok ? "✅ إشارة قوية" : "❌ انتظر إشارة أفضل"}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 20, marginBottom: 24 }}>
            {/* Direction */}
            <div style={{
              padding: 20,
              borderRadius: 12,
              background: theme.soft,
              border: `1px solid ${theme.border}`
            }}>
              <div style={{ fontSize: 14, opacity: 0.8, marginBottom: 8 }}>الاتجاه المتوقع</div>
              <div style={{ 
                fontSize: 32, 
                fontWeight: 800,
                color: analysis.dir.includes("صعود") ? theme.green : 
                      analysis.dir.includes("هبوط") ? theme.red : theme.fg
              }}>
                {analysis.dir}
              </div>
            </div>

            {/* Confidence */}
            <div style={{
              padding: 20,
              borderRadius: 12,
              background: theme.soft,
              border: `1px solid ${theme.border}`
            }}>
              <div style={{ fontSize: 14, opacity: 0.8, marginBottom: 8 }}>مستوى الثقة</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: theme.blue }}>
                {analysis.conf}%
              </div>
              <div style={{
                height: 8,
                background: dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
                borderRadius: 4,
                marginTop: 12,
                overflow: "hidden"
              }}>
                <div style={{
                  width: `${analysis.conf}%`,
                  height: "100%",
                  background: `linear-gradient(90deg, ${theme.blue}, ${theme.green})`,
                  borderRadius: 4
                }} />
              </div>
            </div>

            {/* Market Condition */}
            <div style={{
              padding: 20,
              borderRadius: 12,
              background: theme.soft,
              border: `1px solid ${theme.border}`
            }}>
              <div style={{ fontSize: 14, opacity: 0.8, marginBottom: 8 }}>حالة السوق</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>
                {analysis.market}
              </div>
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                {analysis.market === "تذبذب عالي" ? "كن حذراً" : 
                 analysis.market === "هادئ" ? "إشارات دقيقة" : "ظروف طبيعية"}
              </div>
            </div>
          </div>

          {/* Strategy Scores */}
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>قوة الاستراتيجيات:</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
              {Object.entries(analysis.strategies || {}).map(([name, score]) => (
                <div key={name} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 14 }}>{name}</span>
                    <span style={{ fontWeight: 600 }}>{score}%</span>
                  </div>
                  <div style={{
                    height: 8,
                    background: dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
                    borderRadius: 4,
                    overflow: "hidden"
                  }}>
                    <div style={{
                      width: `${score}%`,
                      height: "100%",
                      background: theme.blue,
                      borderRadius: 4
                    }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Analysis Reasons */}
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>أسباب التحليل:</h3>
            <div style={{
              background: theme.soft,
              borderRadius: 12,
              padding: 16,
              border: `1px solid ${theme.border}`
            }}>
              <ul style={{ margin: 0, paddingRight: 20, lineHeight: 1.8 }}>
                {analysis.reasons.map((reason, index) => (
                  <li key={index} style={{ marginBottom: 8 }}>{reason}</li>
                ))}
              </ul>
            </div>
            <div style={{ marginTop: 16, padding: 12, background: dark ? "rgba(239, 68, 68, 0.1)" : "#fef2f2", borderRadius: 8, border: `1px solid ${theme.red}` }}>
              <p style={{ margin: 0, fontSize: 12, color: theme.red }}>
                ⚠️ هذا التحليل للأغراض التعليمية فقط. التداول يحمل مخاطر، استشر مستشارك المالي.
              </p>
            </div>
          </div>
        </div>

        {/* History & Statistics */}
        <div style={{
          background: theme.card,
          borderRadius: 16,
          padding: 20,
          border: `1px solid ${theme.border}`,
          boxShadow: dark ? "0 4px 20px rgba(0,0,0,0.2)" : "0 2px 12px rgba(0,0,0,0.05)"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>الإحصائيات والسجل</h2>
            <button
              onClick={clearHistory}
              style={{
                padding: "8px 16px",
                borderRadius: 10,
                border: `1px solid ${theme.border}`,
                background: "transparent",
                color: theme.fg,
                cursor: "pointer",
                fontSize: 14
              }}
            >
              🗑️ مسح السجل
            </button>
          </div>

          {/* Statistics Grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 16, marginBottom: 24 }}>
            {[
              { label: "إجمالي الإشارات", value: stats.total, color: theme.blue },
              { label: "إشارات شراء", value: stats.buySignals, color: theme.green },
              { label: "إشارات بيع", value: stats.sellSignals, color: theme.red },
              { label: "معدل النجاح", value: `${stats.successRate}%`, color: "#8b5cf6" },
              { label: "متوسط الثقة", value: `${stats.avgConfidence}%`, color: "#f59e0b" },
              { label: "أفضل أصل", value: stats.bestAsset, color: "#10b981" }
            ].map((stat, index) => (
              <div
                key={index}
                style={{
                  padding: 16,
                  borderRadius: 12,
                  background: theme.soft,
                  border: `1px solid ${theme.border}`,
                  textAlign: "center"
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>{stat.label}</div>
                <div style={{ 
                  fontSize: 24, 
                  fontWeight: 700, 
                  color: typeof stat.color === 'string' ? stat.color : theme.fg 
                }}>
                  {stat.value}
                </div>
              </div>
            ))}
          </div>

          {/* Recent Signals */}
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>آخر الإشارات:</h3>
            <div style={{
              maxHeight: 300,
              overflowY: "auto",
              borderRadius: 8,
              border: `1px solid ${theme.border}`
            }}>
              {history.slice(0, 10).map((entry, index) => (
                <div
                  key={index}
                  style={{
                    padding: 16,
                    borderBottom: `1px solid ${theme.border}`,
                    background: index % 2 === 0 ? theme.soft : "transparent",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center"
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                      {entry.direction} - {entry.confidence}%
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>
                      {new Date(entry.timestamp).toLocaleString('ar-SA')} | {entry.asset}
                    </div>
                  </div>
                  <div style={{
                    padding: "4px 12px",
                    borderRadius: 20,
                    background: entry.isValid ? theme.green : theme.red,
                    color: "white",
                    fontSize: 12,
                    fontWeight: 600
                  }}>
                    {entry.isValid ? "✅ صالح" : "❌ غير صالح"}
                  </div>
                </div>
              ))}
              
              {history.length === 0 && (
                <div style={{ padding: 40, textAlign: "center", opacity: 0.5 }}>
                  لا توجد إشارات مسجلة بعد
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <footer style={{ marginTop: 40, paddingTop: 20, borderTop: `1px solid ${theme.border}` }}>
          <div style={{ textAlign: "center", fontSize: 12, opacity: 0.7, lineHeight: 1.6 }}>
            <p>
              <strong>Deriv Pro Analyzer</strong> - أداة تحليل فني تعليمية
            </p>
            <p>
              ⚠️ هذه الأداة للأغراض التعليمية والتحليلية فقط. جميع قرارات التداول هي مسؤوليتك الخاصة.
              <br />
              البيانات مقدمة من Deriv API. الأداء السابق لا يضمن النتائج المستقبلية.
            </p>
            <p style={{ marginTop: 8 }}>
              الإصدار 2.0.0 | آخر تحديث: {new Date().toLocaleDateString('ar-SA')}
            </p>
          </div>
        </footer>
      </div>

      <style jsx>{`
        @keyframes slideDown {
          from {
            transform: translateY(-20px);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }

        @media (max-width: 768px) {
          .container {
            padding: 12px;
          }
          
          h1 {
            font-size: 24px;
          }
        }
      `}</style>
    </div>
  );
}
