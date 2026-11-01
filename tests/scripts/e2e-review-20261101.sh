#!/usr/bin/env bash
# =============================================================================
# e2e-review-20261101.sh —— 2026-11-01 修复轮次的端到端验证套件（可复跑）
#
# 为什么单独一个入口：
#   本轮修复的问题大多"单测绿但线上坏"——竖排是 CSS 布局、保存失败是跨进程
#   文件读写、任务卡空转是磁盘状态不一致、kubectl 挂死是子进程超时。这些只有
#   端到端跑才能暴露。把它们固化成脚本，避免下次改动又悄悄退回原状。
#
# 覆盖 6 组场景：
#   1. 桌面配置链路：坏 settings.json 仍能保存 + 思考强度注入引擎环境（Rust 真实文件）
#   2. 系统管理 UI：单选行横排 / 思考强度下拉 / 添加即落盘（Chrome 真实渲染 + 几何测量）
#   3. 图引擎：token 预算不终止 + 隔离不得报 completed（真实命令 handler 链路）
#   4. tasks.md：三种状态行方言的真实文件读写闭环 + 守卫不空转
#   5. 外围硬化：kubectl 挂死超时 / LDAP batchSize=0 / 护栏命令来源
#   6. 既有套件回归：team autonomous 持久化 + 架构机制
#
# 用法：
#   bash tests/scripts/e2e-review-20261101.sh            # 全部
#   bash tests/scripts/e2e-review-20261101.sh --fast     # 跳过第 6 组（约省 8 分钟）
#
# 退出码：0 = 全部通过；1 = 有失败；2 = 环境不可用
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CORE="${ROOT}/packages/core"
FAST=0
[[ "${1:-}" == "--fast" ]] && FAST=1

TOTAL=0
PASSED=0
FAILED=0
FAILED_NAMES=()

run_step() {
  local name="$1"
  shift
  TOTAL=$((TOTAL + 1))
  local start
  start=$(date +%s)
  echo ""
  echo "=============================================================="
  echo "[${TOTAL}] ${name}"
  echo "=============================================================="
  if "$@"; then
    PASSED=$((PASSED + 1))
    echo "✅ ${name} 通过（$(( $(date +%s) - start ))s）"
  else
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("${name}")
    echo "❌ ${name} 失败（$(( $(date +%s) - start ))s）"
  fi
}

# ---------- 1. 桌面配置链路 ----------
step_desktop_config() {
  cd "${ROOT}/desktop/src-tauri" || return 1
  local log rc
  log="$(mktemp)"
  cargo test --lib config_persist::tests:: -- --test-threads 1 > "${log}" 2>&1
  rc=$?
  tail -20 "${log}"
  rm -f "${log}"
  return "${rc}"
}

# ---------- 2. 系统管理 UI ----------
step_ui() {
  cd "${ROOT}" || return 1
  node tests/scripts/e2e-settings-drawer-ui.mjs
}

# ---------- 3. 图引擎 ----------
step_graph() {
  cd "${CORE}" || return 1
  node --import tsx e2e/e2e-graph-token-budget.ts
}

# ---------- 4. tasks.md 状态行 ----------
step_tasks() {
  cd "${CORE}" || return 1
  node --import tsx e2e/e2e-tasks-md-dialects.ts
}

# ---------- 5. 外围硬化 ----------
step_peripheral() {
  cd "${CORE}" || return 1
  node --import tsx e2e/e2e-peripheral-hardening.ts
}

# ---------- 6a. autonomous 持久化 ----------
step_autonomous() {
  cd "${ROOT}" || return 1
  bash tests/scripts/e2e-autonomous-persistence.sh
}

# ---------- 6b. 架构机制 ----------
step_arch() {
  cd "${ROOT}" || return 1
  bash tests/scripts/e2e-arch-mechanisms.sh
}

run_step "1. 桌面配置链路（坏 settings.json + 思考强度注入）" step_desktop_config
run_step "2. 系统管理 UI 真实渲染（横排 / 思考强度 / 即时落盘）" step_ui
run_step "3. 图引擎（token 预算软化 + 隔离终态）" step_graph
run_step "4. tasks.md 三种状态行方言文件闭环" step_tasks
run_step "5. 外围硬化（kubectl / LDAP / 护栏来源）" step_peripheral

if [[ "${FAST}" -eq 0 ]]; then
  run_step "6a. team autonomous 持久化（既有套件）" step_autonomous
  run_step "6b. 架构机制（既有套件）" step_arch
else
  echo ""
  echo "ℹ️  --fast：跳过第 6 组（既有套件）"
fi

# ---------- 汇总 ----------
echo ""
echo "=============================================================="
echo "  E2E 汇总"
echo "=============================================================="
echo "  套件：${TOTAL}  通过：${PASSED}  失败：${FAILED}"
if [[ "${FAILED}" -gt 0 ]]; then
  echo "  失败清单："
  for n in "${FAILED_NAMES[@]}"; do echo "    - ${n}"; done
  exit 1
fi
echo "  ✅ 全部通过"
exit 0
