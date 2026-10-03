/**
 * 前端入口：挂载 React SPA（styles.css 与 a2ui.css 经 esbuild css loader 合并输出 bundle.css）。
 */
import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./a2ui/a2ui.css";

/**
 * 全局错误边界（白屏防护 2026-10-03）：
 *
 * 现象：工具执行完成后整个页面瞬间全白。根因：任一组件在渲染/提交阶段抛出
 * 未捕获异常（如助手正文可读化 + A2UI 管线对畸形工具结果载荷的解析边界），
 * React 18 会卸载整棵组件树——SPA 无回退渲染即整页白屏，且无任何可见提示。
 *
 * 策略：包裹 App 根组件，捕获渲染期异常后渲染可自解释的降级页——
 * 保留错误消息供用户截图反馈，提供「重新加载」按钮恢复会话
 * （对话历史持久在服务端，刷新即可从 /api/chats 完整恢复）。
 */
class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  /** React 渲染期异常统一入口：记录错误并切换到降级页 */
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  /**  componentDidCatch：把原始错误打到控制台，便于远程排障（F12 可查） */
  componentDidCatch(error: Error, info: { componentStack: string }): void {
    console.error("[DeepCodeX] 渲染崩溃：", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div style={{ padding: 48, maxWidth: 720, margin: "0 auto", fontFamily: "system-ui, sans-serif" }}>
        <h2 style={{ marginBottom: 12 }}>页面渲染出错</h2>
        <p style={{ color: "#666", marginBottom: 16 }}>
          界面遇到意外错误已自动保护（对话记录保存在服务端，不会丢失）。请重新加载恢复会话；若反复出现请将下方错误信息与复现步骤反馈。
        </p>
        <pre
          style={{
            background: "#f5f5f5",
            padding: 12,
            borderRadius: 6,
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {String(this.state.error.stack ?? this.state.error)}
        </pre>
        <button
          type="button"
          style={{ marginTop: 16, padding: "8px 20px", cursor: "pointer" }}
          onClick={() => window.location.reload()}
        >
          重新加载
        </button>
      </div>
    );
  }
}

/** 挂载点（index.html 中 #root） */
const container = document.getElementById("root");
if (container === null) {
  throw new Error("挂载点 #root 不存在，请检查 index.html");
}

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
);
