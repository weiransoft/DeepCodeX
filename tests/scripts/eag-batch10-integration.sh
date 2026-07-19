#!/usr/bin/env bash
# ==============================================================================
# EAG-P3 批次 10 端到端集成测试脚本
#
# 功能：
#   验证 EAG-P3 批次 10 session.ts 命令 Hook 集成 + 候选规则检测 Hook 的完整流程：
#   环境预检 → tsc 类型检查 → 新增单元测试（eag-session-commands-hook.test.ts）
#   → 既有 hook 测试零回归（eag-session-hook.test.ts）→ 控制台摘要
#
# 验证范围（对齐设计文档 §4.18.3 / §4.18.4）：
#   1. tsc --noEmit 0 errors（session.ts 修改无类型错误）
#   2. 新增 33 个测试用例全部通过：
#      - G1-G5：/eag-design 命令（判定 + 依赖校验 + 请求装配 + 结果渲染）
#      - H1-H5：/eag-test 命令
#      - I1-I5：/eag-run 命令
#      - J1-J4：/eag-resume 命令
#      - K1-K5：/eag-status 命令
#      - L1-L6：候选规则检测 Hook（含防误学红线 ≥2 次才推送）
#      - M1-M3：SessionManagerOptions 字段传递与向后兼容
#   3. 既有 eag-session-hook.test.ts（21 个测试）零回归
#
# 退出码：
#   0 = 全部检查通过（tsc 0 errors + 新测试全过 + 既有测试零回归）
#   1 = 环境预检失败 / 入参非法
#   2 = tsc 类型检查失败
#   3 = 新增单元测试失败
#   4 = 既有 hook 测试回归
#
# 使用方式：
#   bash tests/scripts/eag-batch10-integration.sh
#
# 设计依据：
# - EAG-P3 批次 10 设计文档 §4.18.3 命令 Hook 集成
# - EAG-P3 批次 10 设计文档 §4.18.4 候选规则检测 Hook
# - EAG 方案 §5.5.4 防误学红线
# - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先）
# ==============================================================================

set -euo pipefail

# ---------- 日志工具 ----------
# 统一日志格式：[eag-batch10-integration] 消息
log() {
  echo "[eag-batch10-integration] $*"
}

# 失败时输出错误日志并以指定退出码退出
# @param $1 错误消息
# @param $2 退出码（默认 1）
fail() {
  echo "[eag-batch10-integration] ❌ $*" >&2
  exit "${2:-1}"
}

# ---------- Step 0: 环境预检 ----------
log "Step 0: 环境预检"

# node 版本检查（要求 >= 20，tsx 与 node:test 依赖）
command -v node >/dev/null 2>&1 || fail "未找到 node 可执行文件" 1
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "${NODE_MAJOR}" -ge 20 ] || fail "node 版本过低（要求 >= 20，当前 $(node --version)）" 1

# 定位 CORE_DIR（packages/core，session.ts 所在包）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CORE_DIR="${PROJECT_ROOT}/packages/core"
[ -d "${CORE_DIR}/src/eag" ] || fail "未找到 eag 模块（CORE_DIR=${CORE_DIR}）" 1
[ -f "${CORE_DIR}/src/session.ts" ] || fail "未找到 session.ts（CORE_DIR=${CORE_DIR}）" 1
[ -f "${CORE_DIR}/src/tests/eag-session-commands-hook.test.ts" ] || fail "未找到新增测试文件 eag-session-commands-hook.test.ts" 1
[ -f "${CORE_DIR}/src/tests/eag-session-hook.test.ts" ] || fail "未找到既有测试文件 eag-session-hook.test.ts" 1

log "✅ 环境预检通过 (node $(node --version), CORE_DIR=${CORE_DIR})"

# ---------- Step 1: tsc 类型检查 ----------
log "Step 1: tsc 类型检查（tsc --noEmit）"

set +e
(
  cd "${CORE_DIR}"
  npx tsc --noEmit 2>&1
)
TSC_EXIT_CODE=$?
set -e

if [ "${TSC_EXIT_CODE}" -ne 0 ]; then
  fail "tsc 类型检查失败（退出码 = ${TSC_EXIT_CODE}）" 2
fi
log "✅ tsc 类型检查通过（0 errors）"

# ---------- Step 2: 新增单元测试 ----------
log "Step 2: 新增单元测试（eag-session-commands-hook.test.ts）"

set +e
(
  cd "${CORE_DIR}"
  node --import tsx --test src/tests/eag-session-commands-hook.test.ts 2>&1
)
NEW_TESTS_EXIT_CODE=$?
set -e

if [ "${NEW_TESTS_EXIT_CODE}" -ne 0 ]; then
  fail "新增单元测试失败（退出码 = ${NEW_TESTS_EXIT_CODE}）" 3
fi
log "✅ 新增单元测试全部通过"

# ---------- Step 3: 既有 hook 测试零回归 ----------
log "Step 3: 既有 hook 测试零回归（eag-session-hook.test.ts）"

set +e
(
  cd "${CORE_DIR}"
  node --import tsx --test src/tests/eag-session-hook.test.ts 2>&1
)
EXISTING_TESTS_EXIT_CODE=$?
set -e

if [ "${EXISTING_TESTS_EXIT_CODE}" -ne 0 ]; then
  fail "既有 hook 测试回归（退出码 = ${EXISTING_TESTS_EXIT_CODE}）" 4
fi
log "✅ 既有 hook 测试零回归"

# ---------- Step 4: 控制台摘要 ----------
log "Step 4: 集成测试摘要"
log "  - tsc 类型检查：✅ 通过（0 errors）"
log "  - 新增单元测试（eag-session-commands-hook.test.ts）：✅ 全部通过"
log "  - 既有 hook 测试（eag-session-hook.test.ts）：✅ 零回归"
log ""
log "🎉 EAG-P3 批次 10 集成测试全部通过"
log "   验证范围："
log "   - 5 个命令分支（/eag-design /eag-test /eag-run /eag-resume /eag-status）"
log "   - 候选规则检测 Hook（detectRuleCandidateHook，落地 L-4）"
log "   - 防误学红线（≥2 次才推送确认请求）"
log "   - SessionManagerOptions 字段传递与向后兼容"

# ---------- Step 5: 退出 ----------
exit 0
