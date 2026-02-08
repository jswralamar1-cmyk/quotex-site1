import { useEffect, useRef, useState } from "react";
import { createChart } from "lightweight-charts";

const SYMBOLS = {
  "Volatility 75": "R_75",
  "Volatility 100": "R_100",
  "EUR/USD (OTC)": "frxEURUSD",
  "BTC/USD": "cryBTCUSD"
};

export default function Home() {
  const chartContainerRef = useRef();
  const candleSeriesRef = useRef();
  const wsRef = useRef(null);

  const [symbol, setSymbol] = useState("R_75");
  const [price, setPrice] = useState("-");

  useEffect(() => {
    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: 300,
      layout: {
        background: { color: "#ffffff" },
        textColor: "#000"
      },
      grid: {
        vertLines: { color: "#eee" },
        horzLines: { color: "#eee" }
      },
      timeScale: { timeVisible: true, secondsVisible: true }
    });

    const candleSeries = chart.addCandlestickSeries();
    candleSeriesRef.current = candleSeries;

    return () => chart.remove();
  }, []);

  useEffect(() => {
    if (wsRef.current) wsRef.current.close();

    candleSeriesRef.current.setData([]);

    const socket = new WebSocket(
      "wss://ws.derivws.com/websockets/v3?app_id=1089"
    );

    wsRef.current = socket;

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          ticks: symbol,
          subscribe: 1
        })
      );
    };

    let lastCandle = null;

    socket.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (!data.tick) return;

      const t = Math.floor(data.tick.epoch);
      const p = data.tick.quote;

      setPrice(p);

      if (!lastCandle || t - lastCandle.time >= 60) {
        lastCandle = {
          time: t,
          open: p,
          high: p,
          low: p,
          close: p
        };
        candleSeriesRef.current.update(lastCandle);
      } else {
        lastCandle.high = Math.max(lastCandle.high, p);
        lastCandle.low = Math.min(lastCandle.low, p);
        lastCandle.close = p;
        candleSeriesRef.current.update(lastCandle);
      }
    };

    return () => socket.close();
  }, [symbol]);

  return (
    <div style={{ direction: "rtl", padding: 20, fontFamily: "Tahoma" }}>
      <h2>📊 تحليل الخيارات الثنائية – Deriv</h2>

      <select
        onChange={(e) => setSymbol(e.target.value)}
        style={{ marginBottom: 10 }}
      >
        {Object.entries(SYMBOLS).map(([name, code]) => (
          <option key={code} value={code}>
            {name}
          </option>
        ))}
      </select>

      <p><b>السعر المباشر:</b> {price}</p>

      <div
        ref={chartContainerRef}
        style={{ width: "100%", marginTop: 10 }}
      />

      <small style={{ color: "gray" }}>
        بيانات مباشرة من Deriv – شموع دقيقة واحدة
      </small>
    </div>
  );
}
