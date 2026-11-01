#!/usr/bin/env bash
# DeepCode Desktop M1 headless 冒烟脚本（TC-DT-01x）：
# 不经 Tauri GUI，直接以 cargo test 驱动 EngineManager 核心逻辑：
#   拉起引擎（真实 node 子进程）→ 健康检查通过 → 优雅关闭 → 残留进程检查。
#
# 残留检查（QA 复验修订）：
# - 首选 /bin/ps 精确匹配 mock 引擎脚本名与 `node <cli> web --host 127.0.0.1`；
# - ps 不可用（如沙箱限制）时降级为 lsof 检查 node 进程的 TCP 监听——
#   此时无法按命令行参数区分 mock 引擎与无关 node 开发服务器，发现任何
#   node 监听一律以非零退出交由人工确认，绝不静默假绿；
# - ps 与 lsof 均不可用时直接失败（空转的检查等于没检查）。
set -euo pipefail
cd "$(dirname "$0")/../../src-tauri"

echo "==> [1/3] 引擎生命周期单测（真实子进程：spawn → healthy → SIGTERM 清理）"
cargo test --lib engine::manager::tests -- --test-threads 1

echo "==> [2/3] 端口分配 / settings 读写 / 配置单测"
cargo test --lib -- engine::port engine::settings config::tests --test-threads 1

echo "==> [3/3] 残留进程检查（PRD 验收 4：退出后无引擎残留）"
sleep 1
PATTERN="deepcode-m1-(mock|crash)-engine|node .*web --host 127\.0\.0\.1"
LEAK=""
if PS_OUT="$(/bin/ps ax -o pid,command 2>/dev/null)"; then
  LEAK="$(printf '%s\n' "$PS_OUT" | grep -E "$PATTERN" | grep -v grep || true)"
  if [ -n "$LEAK" ]; then
    echo "❌ 发现残留引擎进程："
    echo "$LEAK"
    exit 1
  fi
elif NODE_LISTEN="$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '$1=="node"' || true)" && [ -n "$NODE_LISTEN" ]; then
  echo "⚠️ /bin/ps 不可用，降级为 lsof 检查（仅能按进程名 node 匹配）"
  echo "❌ 发现 node 进程正在监听 TCP（无法排除 mock 引擎残留，请人工确认 PID）："
  echo "$NODE_LISTEN"
  exit 1
else
  echo "❌ ps 与 lsof 均不可用，无法执行残留检查——检查不允许假绿，判失败"
  exit 1
fi

echo "✅ 冒烟通过：引擎生命周期与退出清理正常，无残留进程"
