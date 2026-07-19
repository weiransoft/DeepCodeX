#!/usr/bin/env bash
# ==============================================================================
# EAG-P3 批次 12 C2 场景 2：CODING Loop E2E 测试触发脚本
#
# 功能：
#   验证 EAG-P3 批次 12 C2 场景 2 CODING Loop E2E 测试：
#   环境预检 → tsc 类型检查 → 运行 eag-e2e-coding.test.ts → 控制台摘要
#
# 验证范围（对齐设计文档 §4.3.2 场景 2）：
#   1. tsc --noEmit 0 errors
#   2. CODING Loop E2E 测试通过（含 G-3/G-4/G-5 门禁 + PR 描述四段结构）
#
# 退出码：
#   0 = 全部检查通过
#   1 = 环境预检失败
#   2 = tsc 类型检查失败
#   3 = CODING Loop E2E 测试失败
#
# 使用方式：
#   bash tests/scripts/eag-batch12-e2e-coding.sh
#
# 设计依据：
# - EAG-P3 批次 12 设计文档 §4.3.2 场景 2 CODING Loop E2E
# - EAG 方案 §5.10.3 CODING Loop 设计
# - EAG 方案 §5.12.1 G-3/G-4/G-5 门禁
# ==============================================================================

set -euo pipefail

log() {
  echo "[eag-batch12-e2e-coding] $*"
}

fail() {
  echo "[eag-batch12-e2e-coding] ❌ $*" >&2
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
[ -f "${CORE_DIR}/src/tests/eag-e2e-coding.test.ts" ] || fail "未找到测试文件 eag-e2e-coding.test.ts" 1

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

# ---------- Step 2: CODING Loop E2E 测试 ----------
log "Step 2: CODING Loop E2E 测试（eag-e2e-coding.test.ts）"

set +e
(
  cd "${CORE_DIR}"
  node --import tsx --test src/tests/eag-e2e-coding.test.ts 2>&1
)
CODING_TEST_EXIT_CODE=$?
set -e

if [ "${CODING_TEST_EXIT_CODE}" -ne 0 ]; then
  fail "CODING Loop E2E 测试失败（退出码 = ${CODING_TEST_EXIT_CODE}）" 3
fi
log "✅ CODING Loop E2E 测试通过"

# ---------- Step 3: 控制台摘要 ----------
log "Step 3: 集成测试摘要"
log "  - tsc 类型检查：✅ 通过（0 errors）"
log "  - CODING Loop E2E 测试：✅ 全部通过"
log ""
log "🎉 EAG-P3 批次 12 C2 场景 2（CODING Loop E2E）全部通过"
log "   验证范围："
log "   - spec.md → CodingOrchestrator → 真实 TypeScript 代码生成"
log "   - G-3 门禁（任务卡声明清晰度）"
log "   - G-4 门禁（实现与任务卡契约一致性）"
log "   - G-5 门禁（代码质量红线）"
log "   - PR 描述四段结构（Summary / Changes / Testing / Compliance）"

exit 0
