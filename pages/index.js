import { useEffect, useRef, useState } from "react";

const SYMBOLS = {
  "Volatility 75": "R_75",
  "Volatility 100": "R_100",
  "EUR/USD (OTC)": "frxEURUSD",
  "BTC/USD": "cryBTCUSD"
};

export default function Home() {
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const wsRef = useRef(null);

  const [symbol, setSymbol] = useState("R_75");
  const [price, setPrice] = useState("-");
  const [analysis, setAnalysis] = useState({
    dir: "—",
    conf: 0,
    ok: false,
    reasons: ["انتظر تجمع بيانات..."]
  });

  // نخزن آخر 120 إغلاق (للتحليل)
  const closesRef = useRef([]);
  const candleRef = useRef(null);

  // إنشاء الشارت
  useEffect(() => {
    let alive = true;

    (async () => {
      const { createChart } = await import("lightweight-charts");
      if (!alive) return;

      const chart = createChart(document.getElementById("chart"), {
        width: window.innerWidth - 40,
        height: 300,
        timeScale: { timeVisible: true, secondsVisible: true }
      });

      const series = chart.addCandlestickSeries();
      chartRef.current = chart;
      seriesRef.current = series;
    })();

    return () => { alive = false; };
  }, []);

  // تحليل RSI/EMA/MACD
  async function runAnalysis() {
    const closes = closesRef.current.slice(-120);
    if (closes.length < 35) {
      setAnalysis({ dir: "—", conf: 0, ok: false, reasons: ["انتظر تجمع بيانات أكثر..."] });
      return;
    }

    const { RSI, EMA, MACD } = await import("technicalindicators");

    const rsiArr = RSI.calculate({ values: closes, period: 14 });
    const ema9Arr = EMA.calculate({ values: closes, period: 9 });
    const ema21Arr = EMA.calculate({ values: closes, period: 21 });
    const macdArr = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    });

    const rsi = rsiArr[rsiArr.length - 1];
    const ema9 = ema9Arr[ema9Arr.length - 1];
    const ema21 = ema21Arr[ema21Arr.length - 1];
    const macd = macdArr[macdArr.length - 1];

    let up = 0, down = 0;
    const reasons = [];

    // RSI
    if (rsi < 30) { up += 2; reasons.push("RSI تشبّع بيع (احتمال ارتداد صعود)"); }
    else if (rsi > 70) { down += 2; reasons.push("RSI تشبّع شراء (احتمال ارتداد هبوط)"); }
    else { reasons.push("RSI متوازن"); }

    // EMA Trend
    if (ema9 > ema21) { up += 3; reasons.push("EMA 9 فوق EMA 21 (ترند صاعد)"); }
    else { down += 3; reasons.push("EMA 9 تحت EMA 21 (ترند هابط)"); }

    // MACD
    if (macd && typeof macd.MACD === "number" && typeof macd.signal === "number") {
      if (macd.MACD > macd.signal) { up += 2; reasons.push("MACD إيجابي (زخم صعود)"); }
      else { down += 2; reasons.push("MACD سلبي (زخم هبوط)"); }
    } else {
      reasons.push("MACD غير جاهز بعد");
    }

    const total = up + down;
    const conf = total ? Math.round((Math.max(up, down) / total) * 100) : 0;
    const dir = up > down ? "صعود 📈" : "هبوط 📉";

    const ok = conf >= 60; // شرط بسيط
    if (!ok) reasons.unshift("السوق غير مناسب الآن (ثقة منخفضة)");

    setAnalysis({ dir, conf, ok, reasons: reasons.slice(0, 5) });
  }

  // السعر + الشموع + تخزين إغلاق + تشغيل التحليل
  useEffect(() => {
    if (wsRef.current) wsRef.current.close();
    closesRef.current = [];
    candleRef.current = null;
    setAnalysis({ dir: "—", conf: 0, ok: false, reasons: ["انتظر تجمع بيانات..."] });

    const ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    };

    ws.onmessage = async (e) => {
      const d = JSON.parse(e.data);
      if (!d.tick) return;

      const t = Math.floor(d.tick.epoch / 60) * 60;
      const p = Number(d.tick.quote);

      setPrice(p);

      // شموع دقيقة واحدة
      let candle = candleRef.current;

      if (!candle || candle.time !== t) {
        // إذا كانت عندنا شمعة سابقة، خزّن إغلاقها للتحليل
        if (candle && typeof candle.close === "number") {
          closesRef.current.push(candle.close);
          if (closesRef.current.length > 200) closesRef.current.shift();
          // شغّل التحليل عند نهاية كل شمعة
          await runAnalysis();
        }

        candle = { time: t, open: p, high: p, low: p, close: p };
        candleRef.current = candle;
        seriesRef.current?.update(candle);
      } else {
        candle.high = Math.max(candle.high, p);
        candle.low = Math.min(candle.low, p);
        candle.close = p;
        seriesRef.current?.update(candle);
      }
    };

    return () => ws.close();
  }, [symbol]);

  return (
    <div style={{ direction: "rtl", padding: 20, fontFamily: "Tahoma" }}>
      <h2>📊 تحليل الخيارات الثنائية – Deriv</h2>

      <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
        {Object.entries(SYMBOLS).map(([n, v]) => (
          <option key={v} value={v}>{n}</option>
        ))}
      </select>

      <p><b>السعر المباشر:</b> {price}</p>

      <div id="chart" style={{ width: "100%", marginTop: 10 }} />

      <div style={{
        marginTop: 14,
        padding: 12,
        borderRadius: 12,
        border: "1px solid #eee",
        background: analysis.ok ? "#f2fff5" : "#fff4f4"
      }}>
        <p><b>الاتجاه المتوقع:</b> {analysis.dir}</p>
        <p><b>الثقة:</b> {analysis.conf}%</p>
        <p><b>الحالة:</b> {analysis.ok ? "مناسب ✅" : "غير مناسب ❌"}</p>
        <p><b>أسباب التحليل:</b></p>
        <ul>
          {analysis.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
        <small style={{ color: "gray" }}>⚠️ تحليل احتمالي وليس توصية مباشرة</small>
      </div>
    </div>
  );
}
