/**
 * 前端入口：挂载 React SPA（styles.css 与 a2ui.css 经 esbuild css loader 合并输出 bundle.css）。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./a2ui/a2ui.css";

/** 挂载点（index.html 中 #root） */
const container = document.getElementById("root");
if (container === null) {
  throw new Error("挂载点 #root 不存在，请检查 index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
