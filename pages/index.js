import { useEffect, useRef, useState } from "react";

const SYMBOLS = {
  "Volatility 75": "R_75",
  "Volatility 100": "R_100",
  "EUR/USD (OTC)": "frxEURUSD",
  "BTC/USD": "cryBTCUSD"
};

export default function Home() {
  const chartContainerRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const chartRef = useRef(null);
  const wsRef = useRef(null);

  const [symbol, setSymbol] = useState("R_75");
  const [price, setPrice] = useState("-");

  // إنشاء الشارت (Client-only)
  useEffect(() => {
    let isMounted = true;

    async function initChart() {
      if (!chartContainerRef.current) return;

      const mod = await import("lightweight-charts");
      if (!isMounted) return;

      const chart = mod.createChart(chartContainerRef.current, {
        width: chartContainerRef.current.clientWidth,
        height: 320,
        timeScale: { timeVisible: true, secondsVisible: true }
      });

      const candleSeries = chart.addCandlestickSeries();

      chartRef.current = chart;
      candleSeriesRef.current = candleSeries;

      const onResize = () => {
        if (!chartContainerRef.current || !chartRef.current) return;
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth
        });
      };
      window.addEventListener("resize", onResize);

      return () => window.removeEventListener("resize", onResize);
    }

    initChart();

    return () => {
      isMounted = false;
      try {
        if (wsRef.current) wsRef.current.close();
      } catch {}
      try {
        if (chartRef.current) chartRef.current.remove();
      } catch {}
    };
  }, []);

  // اشتراك الأسعار وتحديث الشموع (شموع 1 دقيقة)
  useEffect(() => {
    if (!candleSeriesRef.current) return;

    // أغلق الاشتراك السابق
    try {
      if (wsRef.current) wsRef.current.close();
    } catch {}

    // امسح بيانات الشارت
    candleSeriesRef.current.setData([]);

    const socket = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");
    wsRef.current = socket;

    let lastCandle = null;

    socket.onopen = () => {
      socket.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    };

    socket.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (!data.tick) return;

      const t = Math.floor(data.tick.epoch);
      const p = Number(data.tick.quote);

      setPrice(p);

      // نجمع ticks داخل شمعة دقيقة واحدة
      if (!lastCandle || t - lastCandle.time >= 60) {
        lastCandle = { time: t, open: p, high: p, low: p, close: p };
        candleSeriesRef.current.update(lastCandle);
      } else {
        lastCandle.high = Math.max(lastCandle.high, p);
        lastCandle.low = Math.min(lastCandle.low, p);
        lastCandle.close = p;
        candleSeriesRef.current.update(lastCandle);
      }
    };

    socket.onerror = () => {
      // إذا صار خطأ بالسوكت، نخلي السعر يظل ظاهر بس بدون تحديثات
    };

    return () => {
      try {
        socket.close();
      } catch {}
    };
  }, [symbol]);

  return (
    <div style={{ direction: "rtl", padding: 20, fontFamily: "Tahoma" }}>
      <h2>📊 تحليل الخيارات الثنائية – Deriv</h2>

      <div style={{ marginBottom: 10 }}>
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
          {Object.entries(SYMBOLS).map(([name, code]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <p><b>السعر المباشر:</b> {price}</p>

      <div ref={chartContainerRef} style={{ width: "100%", marginTop: 10 }} />

      <small style={{ color: "gray" }}>
        بيانات مباشرة من Deriv – شموع دقيقة واحدة
      </small>
    </div>
  );
}
