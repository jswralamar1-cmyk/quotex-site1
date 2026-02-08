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

  // السعر + الشموع
  useEffect(() => {
    if (wsRef.current) wsRef.current.close();

    const ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");
    wsRef.current = ws;

    let candle = null;

    ws.onopen = () => {
      ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    };

    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (!d.tick) return;

      const t = Math.floor(d.tick.epoch / 60) * 60;
      const p = d.tick.quote;

      setPrice(p);

      if (!candle || candle.time !== t) {
        candle = { time: t, open: p, high: p, low: p, close: p };
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

      <select value={symbol} onChange={e => setSymbol(e.target.value)}>
        {Object.entries(SYMBOLS).map(([n, v]) => (
          <option key={v} value={v}>{n}</option>
        ))}
      </select>

      <p><b>السعر المباشر:</b> {price}</p>

      <div id="chart" style={{ width: "100%", marginTop: 10 }} />

      <small style={{ color: "gray" }}>
        بيانات مباشرة من Deriv – شموع دقيقة واحدة
      </small>
    </div>
  );
}
