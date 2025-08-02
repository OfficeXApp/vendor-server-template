import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { ConfigProvider as AntDesignConfigProvider } from "antd";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AntDesignConfigProvider>
      <App />
    </AntDesignConfigProvider>
  </StrictMode>,
);
