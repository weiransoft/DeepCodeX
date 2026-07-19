#!/usr/bin/env bash
# ==============================================================================
# EAG-P3 批次 12 完整集成测试脚本（C1 + C2 + C3）
#
# 功能：
#   串联 EAG-P3 批次 12 全部 C2 端到端场景测试：
#   环境预检 → tsc 类型检查 → 4 个独立 E2E 场景 + 1 个全流程串联测试 → 控制台摘要
#
# 验证范围（对齐设计文档 §4.5 Step 8 实施步骤）：
#   1. tsc --noEmit 0 errors
#   2. C2 场景 1 DESIGN Loop E2E 通过
#   3. C2 场景 2 CODING Loop E2E 通过
#   4. C2 场景 3 TESTING Loop E2E 通过
#   5. C2 场景 4 HANDOVER E2E 通过
#   6. C2 场景 5 全流程串联 E2E 通过
#   7. 全部 fixtures 完整性校验（requirement.md / qa-benchmark.json / ICP 配置等）
#
# 退出码：
#   0 = 全部检查通过
#   1 = 环境预检失败
#   2 = tsc 类型检查失败
#   3 = 单个 E2E 场景测试失败
#   4 = 多个 E2E 场景测试失败（回归）
#
# 使用方式：
#   bash tests/scripts/eag-batch12-integration.sh
#
# 设计依据：
# - EAG-P3 批次 12 设计文档 §4.5 实施步骤
# - EAG-P3 批次 12 设计文档 §4.6 风险与回退
# - 用户规则 C-9（测试 shell 脚本置于 tests/scripts/）
# ==============================================================================

set -euo pipefail

log() {
  echo "[eag-batch12-integration] $*"
}

fail() {
  echo "[eag-batch12-integration] ❌ $*" >&2
  exit "${2:-1}"
}

# 记录失败的测试场景（用于多场景失败时的回归报告）
FAILED_SCENARIOS=()

# 单场景测试函数
# @param $1 场景名称（design / coding / testing / handover / full-pipeline）
# @param $2 测试文件名（不含路径前缀）
run_scenario() {
  local scenario_name="$1"
  local test_file="$2"

  log "  - 运行场景 ${scenario_name}（${test_file}）..."

  set +e
  (
    cd "${CORE_DIR}"
    # 全流程串联测试使用 600 秒超时，其他场景使用 120 秒
    if [ "${scenario_name}" = "full-pipeline" ]; then
      node --import tsx --test --test-timeout=600000 "src/tests/${test_file}" 2>&1
    else
      node --import tsx --test --test-timeout=120000 "src/tests/${test_file}" 2>&1
    fi
  )
  local exit_code=$?
  set -e

  if [ "${exit_code}" -ne 0 ]; then
    log "    ❌ 场景 ${scenario_name} 失败（退出码 = ${exit_code}）"
    FAILED_SCENARIOS+=("${scenario_name}")
    return 1
  else
    log "    ✅ 场景 ${scenario_name} 通过"
    return 0
  fi
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

# 检查 5 个 E2E 测试文件
for test_file in \
  "eag-e2e-design.test.ts" \
  "eag-e2e-coding.test.ts" \
  "eag-e2e-testing.test.ts" \
  "eag-e2e-handover.test.ts" \
  "eag-e2e-full-pipeline.test.ts"; do
  [ -f "${CORE_DIR}/src/tests/${test_file}" ] || fail "未找到测试文件 ${test_file}" 1
done

# 检查 fixtures 完整性
FIXTURES_DIR="${CORE_DIR}/src/tests/fixtures/e2e-scenarios"
[ -f "${FIXTURES_DIR}/greenfield-order-service/requirement.md" ] || fail "未找到 fixture requirement.md" 1
[ -f "${FIXTURES_DIR}/greenfield-order-service/expected-spec.md" ] || fail "未找到 fixture expected-spec.md" 1
[ -f "${FIXTURES_DIR}/greenfield-order-service/expected-tasks.md" ] || fail "未找到 fixture expected-tasks.md" 1
[ -f "${FIXTURES_DIR}/greenfield-order-service/expected-architecture.md" ] || fail "未找到 fixture expected-architecture.md" 1
[ -f "${FIXTURES_DIR}/greenfield-order-service/qa-benchmark.json" ] || fail "未找到 fixture qa-benchmark.json" 1
[ -f "${FIXTURES_DIR}/icp-config/pharma-gmp.yml" ] || fail "未找到 ICP 配置 pharma-gmp.yml" 1
[ -f "${FIXTURES_DIR}/icp-config/alcoa-plus.yml" ] || fail "未找到 ICP 配置 alcoa-plus.yml" 1

# 验证 qa-benchmark.json 含 50 条 facts
QA_COUNT=$(node -e "const d=require('${FIXTURES_DIR}/greenfield-order-service/qa-benchmark.json'); console.log(d.facts.length)" 2>/dev/null || echo "0")
[ "${QA_COUNT}" -eq 50 ] || fail "qa-benchmark.json 必须含 50 条 facts，实际 ${QA_COUNT}" 1

# 检查 5 个 E2E 测试触发脚本
for script_file in \
  "eag-batch12-e2e-design.sh" \
  "eag-batch12-e2e-coding.sh" \
  "eag-batch12-e2e-testing.sh" \
  "eag-batch12-e2e-handover.sh" \
  "eag-batch12-e2e-full-pipeline.sh"; do
  [ -f "${SCRIPT_DIR}/${script_file}" ] || fail "未找到 shell 脚本 ${script_file}" 1
done

log "✅ 环境预检通过"
log "  - node: $(node --version)"
log "  - CORE_DIR: ${CORE_DIR}"
log "  - fixtures 完整性: ✅ 7 个 fixture 文件齐全"
log "  - qa-benchmark.json: ✅ 50 条 facts"
log "  - shell 脚本: ✅ 5 个 E2E 触发脚本齐全"

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

# ---------- Step 2: 5 个 C2 E2E 场景测试 ----------
log "Step 2: 5 个 C2 E2E 场景测试"

run_scenario "design" "eag-e2e-design.test.ts" || true
run_scenario "coding" "eag-e2e-coding.test.ts" || true
run_scenario "testing" "eag-e2e-testing.test.ts" || true
run_scenario "handover" "eag-e2e-handover.test.ts" || true
run_scenario "full-pipeline" "eag-e2e-full-pipeline.test.ts" || true

# ---------- Step 3: 结果汇总与退出码判定 ----------
log "Step 3: 集成测试结果汇总"

if [ "${#FAILED_SCENARIOS[@]}" -eq 0 ]; then
  log "  - tsc 类型检查：✅ 通过（0 errors）"
  log "  - C2 场景 1 DESIGN Loop E2E：✅ 通过"
  log "  - C2 场景 2 CODING Loop E2E：✅ 通过"
  log "  - C2 场景 3 TESTING Loop E2E：✅ 通过"
  log "  - C2 场景 4 HANDOVER E2E：✅ 通过"
  log "  - C2 场景 5 全流程串联 E2E：✅ 通过"
  log ""
  log "🎉 EAG-P3 批次 12 C2 端到端场景测试全部通过"
  log "   验证范围："
  log "   - 5 个 E2E 测试文件全部通过"
  log "   - 7 个 fixture 文件完整性校验通过"
  log "   - tsc 类型检查 0 errors"
  exit 0
elif [ "${#FAILED_SCENARIOS[@]}" -eq 1 ]; then
  log "  ❌ 失败的场景：${FAILED_SCENARIOS[0]}"
  fail "C2 E2E 场景 ${FAILED_SCENARIOS[0]} 失败" 3
else
  log "  ❌ 失败的场景（${#FAILED_SCENARIOS[@]} 个）："
  for scenario in "${FAILED_SCENARIOS[@]}"; do
    log "    - ${scenario}"
  done
  fail "多个 C2 E2E 场景测试失败（回归）" 4
fi
