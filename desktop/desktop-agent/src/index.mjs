#!/usr/bin/env node
/**
 * deepcode-desktop-agent —— 独立 sidecar 入口。
 *
 * 启动方式（引擎侧 McpManager / settings.json 的 mcpServers 配置）：
 *   node desktop/desktop-agent/src/index.mjs
 * 环境变量：
 *   DEEPCODE_AGENT_BACKEND=mock|windows|auto   （默认 auto：win32 → windows，其余 → mock）
 *   DEEPCODE_AGENT_POLICY=<path>               显式指定策略文件；缺省读 ~/.deepcode/desktop-agent.json
 *   DEEPCODE_AGENT_UIA_BRIDGE=1                启用 Windows UIA 桥（需交互式桌面会话）
 *
 * 生命周期分工（方案 §5）：引擎进程由壳侧 supervisor 管（健康检查/崩溃恢复），
 * 本进程由引擎 McpManager 按 settings.json 的 mcpServers 拉起（stdio 单 client），
 * 进程内的 PowerShell 桥由 sidecar 自己管（ping/退避/崩溃上限）。壳拿不到本进程的
 * 句柄，所以「策略变更」走文件通道：每次工具调用前重判 desktop-agent.json，
 * 授权与撤销都即时生效，无需重启引擎。本进程不监听端口，不与引擎抢回环端口。
 *
 * 安全：默认 enabled=false。即便进程被拉起，未经 desktop_agent_toggle
 * 显式开启，任何观察/动作都会被 PolicyGuard 拒绝。外部策略文件在
 * policy-load.mjs 中二次硬化（每次重载都重跑），不能放宽锁定字段；
 * 文件损坏或消失一律 fail-closed 回落到默认关闭。
 */

import { DesktopAgent, TOOLS } from "./agent.mjs";
import { createMcpServer } from "./mcp-server.mjs";
import { createMockBackend } from "./backends/mock.mjs";
import { createWindowsBackend } from "./backends/windows.mjs";
import { loadPolicy, PolicyReloader } from "./modules/policy-load.mjs";

function createBackend() {
  const requested = process.env.DEEPCODE_AGENT_BACKEND ?? "auto";
  if (requested === "mock") return createMockBackend();
  if (requested === "windows") return createWindowsBackend();
  return process.platform === "win32" ? createWindowsBackend() : createMockBackend();
}

const loaded = loadPolicy();
if (loaded.error) {
  // 日志一律 stderr：stdout 只允许出现 MCP 协议帧
  console.error(`[agent] 策略加载失败，回落安全默认值：${loaded.error}（${loaded.path}）`);
}

// 策略热重载：壳与 sidecar 之间只有策略文件这一条通道，所以「撤销即时生效」
// 靠的是每个工具调用前重判文件内容，而不是重启引擎（见 modules/policy-load.mjs）。
// 回调只写 stderr，绝不污染 stdout 的 JSON-RPC 帧。
const reloader = new PolicyReloader({
  path: loaded.path,
  source: loaded.source,
  onReload: ({ revision, reason, allowScreenshot, visionAppCount }) =>
    console.error(
      `[agent] policy rev=${revision} ${reason} ` +
        `allowScreenshot=${allowScreenshot} visionApps=${visionAppCount}`
    ),
  onError: (reason) =>
    console.error(`[agent] 策略重载失败，回落安全默认值（fail-closed）：${reason}`),
});

const initial = reloader.current();
const agent = new DesktopAgent({
  backend: createBackend(),
  policy: initial.policy,
  limits: initial.policy,
  reloader,
});
const server = createMcpServer(agent, { log: (...a) => console.error(...a) });

console.error(
  `[agent] started backend=${agent.backend.name} enabled=${loaded.policy.enabled} ` +
    `policy=${loaded.source}:${loaded.path} tools=${TOOLS.length}`
);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.error(`[agent] ${sig} received, shutting down`);
    server.close();
    // 先优雅关桥（发 shutdown 让 PowerShell 主循环 break），超时才 kill；
    // 兜底定时器防止桥僵死时进程退不掉 —— 遗留 powershell.exe 比晚退 1.5s 糟糕得多
    const hardExit = setTimeout(() => process.exit(0), 3_000);
    hardExit.unref?.();
    Promise.resolve(agent.backend.shutdown?.() ?? agent.backend.close?.())
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}
