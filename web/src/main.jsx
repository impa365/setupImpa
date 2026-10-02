import React from "react";
import { createRoot } from "react-dom/client";

function App() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 32 }}>
      <h1>SetupImpa</h1>
      <p>
        A UI de producao do MVP esta em <code>agent/static</code>. Este pacote Vite/React
        e o ponto de extensao para a proxima iteracao.
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
