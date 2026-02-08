import { useEffect, useState } from "react";

const SYMBOLS = {
  "Volatility 75": "R_75",
  "Volatility 100": "R_100",
  "EUR/USD (OTC)": "frxEURUSD",
  "BTC/USD": "cryBTCUSD"
};

export default function Home() {
  const [symbol, setSymbol] = useState("R_75");
  const [price, setPrice] = useState("-");
  const [ws, setWs] = useState(null);

  useEffect(() => {
    const socket = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          ticks: symbol,
          subscribe: 1
        })
      );
    };

    socket.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.tick) {
        setPrice(data.tick.quote);
      }
    };

    setWs(socket);

    return () => {
      socket.close();
    };
  }, [symbol]);

  return (
    <div style={{ direction: "rtl", padding: 20, fontFamily: "Tahoma" }}>
      <h2>📊 تحليل الخيارات الثنائية – Deriv</h2>

      <select
        onChange={(e) => setSymbol(e.target.value)}
        style={{ marginBottom: 15 }}
      >
        {Object.entries(SYMBOLS).map(([name, code]) => (
          <option key={code} value={code}>
            {name}
          </option>
        ))}
      </select>

      <p><b>السعر المباشر:</b> {price}</p>

      <hr />

      <p>🔍 التحليل راح نضيفه بالخطوة الجاية</p>

      <small style={{ color: "gray" }}>
        Demo API من Deriv – بيانات حقيقية
      </small>
    </div>
  );
}
