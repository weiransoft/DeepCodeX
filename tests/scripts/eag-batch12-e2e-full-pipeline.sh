#!/usr/bin/env bash
# ==============================================================================
# EAG-P3 批次 12 C2 场景 5：全流程串联 E2E 测试触发脚本
#
# 功能：
#   验证 EAG-P3 批次 12 C2 场景 5 全流程串联 E2E 测试：
#   环境预检 → tsc 类型检查 → 运行 eag-e2e-full-pipeline.test.ts → 控制台摘要
#
# 验证范围（对齐设计文档 §4.3.5 全流程串联 E2E）：
#   1. tsc --noEmit 0 errors
#   2. 全流程串联测试通过：
#      - 4 阶段端到端协同（DESIGN → CODING → TESTING → HANDOVER）
#      - 跨会话续跑（真实子进程 + SIGKILL 模拟）
#      - 全流程耗时 ≤600 秒
#      - 阶段间产出正确传递
#
# 退出码：
#   0 = 全部检查通过
#   1 = 环境预检失败
#   2 = tsc 类型检查失败
#   3 = 全流程串联 E2E 测试失败
#
# 使用方式：
#   bash tests/scripts/eag-batch12-e2e-full-pipeline.sh
#
# 设计依据：
# - EAG-P3 批次 12 设计文档 §4.3.5 全流程串联 E2E
# - EAG 方案 §6.1 / §6.2 / §6.3 三类端到端场景
# - EAG 方案 §8.7 跨会话续跑（kill -9 + /eag-resume 恢复）
# ==============================================================================

set -euo pipefail

log() {
  echo "[eag-batch12-e2e-full-pipeline] $*"
}

fail() {
  echo "[eag-batch12-e2e-full-pipeline] ❌ $*" >&2
  exit "${2:-1}"
}

# ---------- Step 0: 环境预检 ----------
log "Step 0: 环境预检"

command -v node >/dev/null 2>&1 || fail "未找到 node 可执行文件" 1
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "${NODE_MAJOR}" -ge 20 ] || fail "node 版本过低（要求 >= 20，当前 $(node --version)）" 1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CORE_DIR="${PROJECT_ROOT}/packages/core"
[ -d "${CORE_DIR}/src/eag" ] || fail "未找到 eag 模块（CORE_DIR=${CORE_DIR}）" 1
[ -f "${CORE_DIR}/src/tests/eag-e2e-full-pipeline.test.ts" ] || fail "未找到测试文件 eag-e2e-full-pipeline.test.ts" 1
[ -f "${CORE_DIR}/src/tests/fixtures/e2e-scenarios/greenfield-order-service/requirement.md" ] || fail "未找到 fixture requirement.md" 1

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

# ---------- Step 2: 全流程串联 E2E 测试 ----------
log "Step 2: 全流程串联 E2E 测试（eag-e2e-full-pipeline.test.ts）"
log "  注：全流程串联测试含 4 阶段协同 + 跨会话续跑（SIGKILL 模拟），可能耗时较长"

set +e
(
  cd "${CORE_DIR}"
  # 设置测试超时为 600 秒（对齐设计文档 R-P3-9 全流程 ≤600 秒）
  node --import tsx --test --test-timeout=600000 src/tests/eag-e2e-full-pipeline.test.ts 2>&1
)
FULL_PIPELINE_TEST_EXIT_CODE=$?
set -e

if [ "${FULL_PIPELINE_TEST_EXIT_CODE}" -ne 0 ]; then
  fail "全流程串联 E2E 测试失败（退出码 = ${FULL_PIPELINE_TEST_EXIT_CODE}）" 3
fi
log "✅ 全流程串联 E2E 测试通过"

# ---------- Step 3: 控制台摘要 ----------
log "Step 3: 集成测试摘要"
log "  - tsc 类型检查：✅ 通过（0 errors）"
log "  - 全流程串联 E2E 测试：✅ 全部通过"
log ""
log "🎉 EAG-P3 批次 12 C2 场景 5（全流程串联 E2E）全部通过"
log "   验证范围："
log "   - DESIGN → CODING → TESTING → HANDOVER 4 阶段串联协同"
log "   - 跨会话续跑（真实子进程 + SIGKILL 信号模拟 + 子进程重启恢复）"
log "   - 全流程耗时 ≤600 秒（对齐 R-P3-9）"
log "   - 阶段间产出正确传递（DESIGN 产出 spec.md → CODING 输入 / CODING 产出代码 → TESTING 输入 / TESTING 产出测试 → HANDOVER 输入）"
log "   - PKC L1~L4 / ICP 合规包 / G-1~G-7 门禁 / 增量测试选择器协同"

exit 0
