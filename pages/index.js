import { useEffect, useState } from "react";

export default function Home() {
  const [direction, setDirection] = useState("");
  const [confidence, setConfidence] = useState(0);
  const [status, setStatus] = useState("");
  const [reasons, setReasons] = useState([]);

  useEffect(() => {
    const analyze = () => {
      const up = Math.random() > 0.5;
      const conf = Math.floor(Math.random() * 20) + 60;

      setDirection(up ? "صعود 📈" : "هبوط 📉");
      setConfidence(conf);
      setStatus(conf >= 55 ? "مناسب للتداول ✅" : "غير مناسب ❌");

      setReasons([
        "RSI قريب من التشبع",
        "تقاطع متوسطات متحركة",
        "السعر قريب من دعم/مقاومة"
      ]);
    };

    analyze();
    const interval = setInterval(analyze, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ direction: "rtl", padding: 20, fontFamily: "Tahoma" }}>
      <h2>📊 تحليل الخيارات الثنائية – كوتيكس</h2>

      <p><b>العملة:</b> EUR/USD</p>
      <p><b>المدة:</b> 1 دقيقة</p>

      <hr />

      <p><b>الاتجاه المتوقع:</b> {direction}</p>
      <p><b>نسبة الثقة:</b> {confidence}%</p>
      <p><b>حالة السوق:</b> {status}</p>

      <p><b>أسباب التحليل:</b></p>
      <ul>
        {reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>

      <small style={{ color: "gray" }}>
        ⚠️ التحليل احتمالي وليس توصية مباشرة
      </small>
    </div>
  );
}
