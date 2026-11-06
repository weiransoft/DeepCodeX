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
 * 生命周期由壳管理（P1 阶段为「配置即生效」的最小接线，完整 AgentLifecycle
 * 见方案 §5；本进程自身不监听端口，只走 stdio，天然不与引擎抢回环端口）。
 *
 * 安全：默认 enabled=false。即便进程被拉起，未经 desktop_agent_toggle
 * 显式开启，任何观察/动作都会被 PolicyGuard 拒绝。外部策略文件在
 * policy-load.mjs 中二次硬化，不能放宽锁定字段。
 */

import { DesktopAgent, TOOLS } from "./agent.mjs";
import { createMcpServer } from "./mcp-server.mjs";
import { createMockBackend } from "./backends/mock.mjs";
import { createWindowsBackend } from "./backends/windows.mjs";
import { loadPolicy } from "./modules/policy-load.mjs";

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

const agent = new DesktopAgent({
  backend: createBackend(),
  policy: loaded.policy,
  limits: loaded.policy,
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
    process.exit(0);
  });
}
