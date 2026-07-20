#!/usr/bin/env bash
# ==============================================================================
# 领域专家集成（DomainExpert Integration）端到端集成测试脚本
#
# 功能：
#   验证 woagent 角色纳入 DeepCodeX-cli 专家群的完整集成链路：
#   环境预检 → tsc 类型检查 → ESLint 静态检查 → 领域专家全量单元测试
#   → 既有 team 模块回归 → 测试数量统计 → 输出汇总报告
#
# 覆盖范围（对齐 DOMAIN_EXPERT_INTEGRATION_DESIGN.md §5 测试策略）：
#   1. Phase 1-3 类型定义：types.ts（DomainExpert / DomainExpertMatchResult / ExpertOpinion / DomainExpertDispatchResult）
#   2. Phase 2+3 DomainExpertRegistry + 8 个 experts 文件（30 个领域专家定义）
#   3. Phase 4 DomainExpertMatcher（三策略 + 4 维加权评分）
#   4. Phase 5 DomainExpertReviewPlugin（5 钩子真实实现）
#   5. 错误处理：ExpertInvocationError（5 phase：no-client/timeout/network/parse/empty）
#   6. 既有 team 模块零回归：team/tests/*.test.ts 全套
#
# 退出码：
#   0 = 全部检查通过（tsc 0 errors + ESLint 0 errors + 全量测试 0 fail + 测试数 ≥ 205）
#   1 = 环境预检失败 / 入参非法
#   2 = tsc 类型检查失败
#   3 = ESLint 静态检查失败
#   4 = 领域专家单元测试失败
#   5 = 既有 team 模块回归失败
#   6 = 测试用例总数不足 205（设计文档 §5 约束）
#
# 使用方式：
#   bash tests/scripts/domain-expert-integration.sh
#
# 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §5 测试策略 + §6 实施计划 Phase 6
# ==============================================================================

set -euo pipefail

# ---------- 日志工具 ----------
# 统一日志格式：[domain-expert-integration] 消息
log() {
  echo "[domain-expert-integration] $*"
}

# 失败时输出错误日志并以指定退出码退出
# @param $1 错误消息
# @param $2 退出码（默认 1）
fail() {
  echo "[domain-expert-integration] ❌ $*" >&2
  exit "${2:-1}"
}

# ---------- Step 0: 环境预检 ----------
log "Step 0: 环境预检"

# node 版本检查（要求 >= 20，tsx 与 node:test 依赖）
command -v node >/dev/null 2>&1 || fail "未找到 node 可执行文件" 1
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "${NODE_MAJOR}" -ge 20 ] || fail "node 版本过低（要求 >= 20，当前 $(node --version)）" 1

# npx 可用性检查（tsc / eslint / tsx 通过 npx 调用）
command -v npx >/dev/null 2>&1 || fail "未找到 npx 可执行文件" 1

# 定位 CORE_DIR（packages/core，team 模块所在包）
# 脚本位于 tests/scripts/ 下，需向上两级到项目根目录，再进入 packages/core
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CORE_DIR="${PROJECT_ROOT}/packages/core"

# 校验领域专家核心模块路径存在
[ -d "${CORE_DIR}/src/team/domain-experts" ] || fail "未找到 team/domain-experts 目录（CORE_DIR=${CORE_DIR}）" 1
[ -f "${CORE_DIR}/src/team/domain-expert-registry.ts" ] || fail "未找到 DomainExpertRegistry 实现" 1
[ -f "${CORE_DIR}/src/team/domain-expert-matcher.ts" ] || fail "未找到 DomainExpertMatcher 实现" 1
[ -f "${CORE_DIR}/src/team/domain-expert-review-plugin.ts" ] || fail "未找到 DomainExpertReviewPlugin 实现" 1
[ -f "${CORE_DIR}/src/team/errors.ts" ] || fail "未找到 errors.ts（ExpertInvocationError 定义）" 1
[ -f "${CORE_DIR}/src/team/types.ts" ] || fail "未找到 types.ts" 1

# 校验领域专家测试文件存在
[ -f "${CORE_DIR}/src/team/tests/domain-expert-registry.test.ts" ] || fail "未找到 domain-expert-registry.test.ts" 1
[ -f "${CORE_DIR}/src/team/tests/domain-expert-matcher.test.ts" ] || fail "未找到 domain-expert-matcher.test.ts" 1
[ -f "${CORE_DIR}/src/team/tests/domain-expert-review-plugin.test.ts" ] || fail "未找到 domain-expert-review-plugin.test.ts" 1

# 校验领域专家定义文件存在（8 个类别文件 + index.ts）
EXPERTS_DIR="${CORE_DIR}/src/team/domain-experts"
EXPERT_FILES=(
  "${EXPERTS_DIR}/strategy-experts.ts"
  "${EXPERTS_DIR}/product-experts.ts"
  "${EXPERTS_DIR}/project-management-experts.ts"
  "${EXPERTS_DIR}/support-experts.ts"
  "${EXPERTS_DIR}/specialized-experts.ts"
  "${EXPERTS_DIR}/academic-experts.ts"
  "${EXPERTS_DIR}/marketing-experts.ts"
  "${EXPERTS_DIR}/sales-experts.ts"
  "${EXPERTS_DIR}/index.ts"
)
for file in "${EXPERT_FILES[@]}"; do
  [ -f "${file}" ] || fail "文件不存在：${file}" 1
done

log "✅ 环境预检通过 (node $(node --version), CORE_DIR=${CORE_DIR})"

# ---------- Step 1: tsc 类型检查 ----------
log "Step 1: tsc --noEmit 类型检查"

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

# ---------- Step 2: ESLint 静态检查（领域专家全部核心文件） ----------
log "Step 2: ESLint 静态检查（领域专家全部核心文件）"

# 领域专家核心改动文件清单（对齐 Phase 1-5 全部产出）
DOMAIN_EXPERT_CORE_FILES=(
  # Phase 1 类型定义
  "${CORE_DIR}/src/team/types.ts"
  "${CORE_DIR}/src/team/plugin-context.ts"
  # Phase 2+3 Registry + experts
  "${CORE_DIR}/src/team/domain-expert-registry.ts"
  "${CORE_DIR}/src/team/domain-experts/strategy-experts.ts"
  "${CORE_DIR}/src/team/domain-experts/product-experts.ts"
  "${CORE_DIR}/src/team/domain-experts/project-management-experts.ts"
  "${CORE_DIR}/src/team/domain-experts/support-experts.ts"
  "${CORE_DIR}/src/team/domain-experts/specialized-experts.ts"
  "${CORE_DIR}/src/team/domain-experts/academic-experts.ts"
  "${CORE_DIR}/src/team/domain-experts/marketing-experts.ts"
  "${CORE_DIR}/src/team/domain-experts/sales-experts.ts"
  "${CORE_DIR}/src/team/domain-experts/index.ts"
  # Phase 4 Matcher
  "${CORE_DIR}/src/team/domain-expert-matcher.ts"
  # Phase 5 Plugin + errors
  "${CORE_DIR}/src/team/domain-expert-review-plugin.ts"
  "${CORE_DIR}/src/team/errors.ts"
  # 共享常量
  "${CORE_DIR}/src/team/karpathy-preamble.ts"
  # barrel 导出
  "${CORE_DIR}/src/team/index.ts"
  # 测试文件
  "${CORE_DIR}/src/team/tests/domain-expert-registry.test.ts"
  "${CORE_DIR}/src/team/tests/domain-expert-matcher.test.ts"
  "${CORE_DIR}/src/team/tests/domain-expert-review-plugin.test.ts"
)

# 校验所有文件存在
for file in "${DOMAIN_EXPERT_CORE_FILES[@]}"; do
  [ -f "${file}" ] || fail "文件不存在：${file}" 1
done

set +e
npx eslint "${DOMAIN_EXPERT_CORE_FILES[@]}" 2>&1
ESLINT_EXIT_CODE=$?
set -e

if [ "${ESLINT_EXIT_CODE}" -ne 0 ]; then
  fail "ESLint 静态检查失败（退出码 = ${ESLINT_EXIT_CODE}）" 3
fi
log "✅ ESLint 静态检查通过（0 errors，${#DOMAIN_EXPERT_CORE_FILES[@]} 个核心文件）"

# ---------- Step 3: 领域专家单元测试 ----------
log "Step 3: 领域专家单元测试（Phase 1-5 全覆盖）"

# 领域专家测试文件清单（按 Phase 顺序）
DOMAIN_EXPERT_TEST_FILES=(
  # Phase 2+3 DomainExpertRegistry
  "${CORE_DIR}/src/team/tests/domain-expert-registry.test.ts"
  # Phase 4 DomainExpertMatcher
  "${CORE_DIR}/src/team/tests/domain-expert-matcher.test.ts"
  # Phase 5 DomainExpertReviewPlugin
  "${CORE_DIR}/src/team/tests/domain-expert-review-plugin.test.ts"
)

set +e
# 输出完整日志到文件，控制台仅显示末尾 50 行
DOMAIN_EXPERT_LOG="${PROJECT_ROOT}/domain-expert-unit-test.log"
npx tsx --test "${DOMAIN_EXPERT_TEST_FILES[@]}" 2>&1 | tee "${DOMAIN_EXPERT_LOG}" | tail -50
DOMAIN_EXPERT_TEST_EXIT_CODE=${PIPESTATUS[0]}
set -e

if [ "${DOMAIN_EXPERT_TEST_EXIT_CODE}" -ne 0 ]; then
  log "❌ 领域专家单元测试失败（退出码 = ${DOMAIN_EXPERT_TEST_EXIT_CODE}），完整日志：${DOMAIN_EXPERT_LOG}"
  fail "领域专家单元测试失败（退出码 = ${DOMAIN_EXPERT_TEST_EXIT_CODE}）" 4
fi

# 统计测试用例总数
DOMAIN_EXPERT_TEST_COUNT=$(grep -E "^ℹ tests" "${DOMAIN_EXPERT_LOG}" | tail -1 | awk '{print $3}')
DOMAIN_EXPERT_PASS_COUNT=$(grep -E "^ℹ pass" "${DOMAIN_EXPERT_LOG}" | tail -1 | awk '{print $3}')
DOMAIN_EXPERT_FAIL_COUNT=$(grep -E "^ℹ fail" "${DOMAIN_EXPERT_LOG}" | tail -1 | awk '{print $3}')
log "✅ 领域专家单元测试通过（tests=${DOMAIN_EXPERT_TEST_COUNT}, pass=${DOMAIN_EXPERT_PASS_COUNT}, fail=${DOMAIN_EXPERT_FAIL_COUNT}）"

# ---------- Step 4: 既有 team 模块回归 ----------
log "Step 4: 既有 team 模块回归（零回归验证）"

# 收集所有 team/tests/*.test.ts 文件（包含领域专家测试 + 既有测试）
TEAM_TEST_FILES=$(find "${CORE_DIR}/src/team/tests" -name "*.test.ts" -type f | sort)

if [ -z "${TEAM_TEST_FILES}" ]; then
  fail "未找到任何 team/tests/*.test.ts 测试文件" 1
fi

TEAM_TEST_COUNT=$(echo "${TEAM_TEST_FILES}" | wc -l | tr -d ' ')
log "  共发现 ${TEAM_TEST_COUNT} 个 team 测试文件"

set +e
# 使用 xargs 并行执行所有 team 测试
# 输出完整日志到 TEAM_LOG 文件，控制台仅显示末尾 30 行
TEAM_LOG="${PROJECT_ROOT}/domain-expert-team-regression.log"
echo "${TEAM_TEST_FILES}" | xargs npx tsx --test 2>&1 | tee "${TEAM_LOG}" | tail -30
TEAM_TEST_EXIT_CODE=${PIPESTATUS[1]}
set -e

if [ "${TEAM_TEST_EXIT_CODE}" -ne 0 ]; then
  log "❌ 既有 team 模块回归失败（退出码 = ${TEAM_TEST_EXIT_CODE}），完整日志：${TEAM_LOG}"
  fail "既有 team 模块回归失败（退出码 = ${TEAM_TEST_EXIT_CODE}）" 5
fi

# 统计 team 模块总测试数
TEAM_TOTAL_TESTS=$(grep -E "^ℹ tests" "${TEAM_LOG}" | tail -1 | awk '{print $3}')
log "✅ 既有 team 模块回归通过（${TEAM_TEST_COUNT} 个测试文件，零回归）"

# ---------- Step 5: 测试数量校验（≥205） ----------
log "Step 5: 测试数量校验（设计文档 §5 约束：≥ 205 个测试用例）"

# 领域专家单元测试数 + 既有 team 测试数（去重后）
TOTAL_TESTS="${TEAM_TOTAL_TESTS:-0}"

# 设计文档 §5 要求：领域专家集成至少 205 个测试用例
MIN_REQUIRED_TESTS=205

if [ "${TOTAL_TESTS}" -lt "${MIN_REQUIRED_TESTS}" ]; then
  log "❌ 测试用例总数不足：${TOTAL_TESTS} < ${MIN_REQUIRED_TESTS}（设计文档 §5 约束）"
  fail "测试用例总数不足（${TOTAL_TESTS} < ${MIN_REQUIRED_TESTS}）" 6
fi
log "✅ 测试用例总数满足约束（${TOTAL_TESTS} ≥ ${MIN_REQUIRED_TESTS}）"

# ---------- Step 6: 汇总报告 ----------
log "Step 6: 汇总报告"
cat <<EOF

========================================
领域专家集成（DomainExpert Integration）测试报告
========================================
✅ Step 0: 环境预检通过 (node $(node --version))
✅ Step 1: tsc --noEmit 类型检查通过（0 errors）
✅ Step 2: ESLint 静态检查通过（0 errors，${#DOMAIN_EXPERT_CORE_FILES[@]} 个核心文件）
✅ Step 3: 领域专家单元测试通过（tests=${DOMAIN_EXPERT_TEST_COUNT}, pass=${DOMAIN_EXPERT_PASS_COUNT}, fail=${DOMAIN_EXPERT_FAIL_COUNT}）
✅ Step 4: 既有 team 模块回归通过（${TEAM_TEST_COUNT} 个测试文件，零回归）
✅ Step 5: 测试数量校验通过（${TOTAL_TESTS} ≥ ${MIN_REQUIRED_TESTS}）

覆盖范围：
  - Phase 1 类型定义：types.ts（8 个领域专家 schema + DomainExpertDispatchResult）
  - Phase 2+3 DomainExpertRegistry + 8 个 experts 文件（30 个领域专家定义）
  - Phase 4 DomainExpertMatcher（keyword/ai/hybrid 三策略 + 4 维加权评分）
  - Phase 5 DomainExpertReviewPlugin（matches/before/execute/after/cleanup 5 钩子真实实现）
  - 错误处理：ExpertInvocationError（5 phase：no-client/timeout/network/parse/empty）
  - 互斥关系：mutexWith=["architect-review", "test-expert-review"]（P1-NEW-3）
  - 跨任务传播：ctx.task.upstreamContext["domainExpertReviews"]

验证标准（全部通过）：
  - tsc --noEmit: 0 errors
  - ESLint: 0 errors
  - 领域专家单元测试: 100% pass
  - 既有 team 模块回归: 零回归
  - 测试用例总数: ${TOTAL_TESTS} ≥ ${MIN_REQUIRED_TESTS}

设计文档：DOMAIN_EXPERT_INTEGRATION_DESIGN.md v1.1.1
========================================
EOF

log "🎉 领域专家集成测试全部通过"
exit 0
