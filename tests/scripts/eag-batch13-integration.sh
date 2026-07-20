#!/usr/bin/env bash
# ==============================================================================
# EAG-P4 批次 13 端到端集成测试脚本
#
# 功能：
#   验证 EAG-P4 批次 13 DevOps 第 6 角色编排器 + /eag-deploy 命令链路完整性：
#   环境预检 → tsc 类型检查 → ESLint 静态检查 → 批次 13 全量单元测试
#   → 既有 EAG 全套回归 → 输出汇总报告
#
# 覆盖范围（对齐 EAG-P4-BATCH13-DESIGN.md §6.1 Phase 8）：
#   1. Phase 1-3 类型定义：eag-devops-types / eag-gate-types
#   2. Phase 4-5 IaC 生成器 + 阶段组件：
#      - eag-devops-iac-terraform / eag-devops-iac-k8s / eag-devops-iac-helm
#      - eag-deploy-pre-checker / eag-deploy-post-checker / eag-deploy-smoke-test-runner
#      - eag-deploy-stage
#   3. Phase 5 G-8 门禁：eag-gate-g8-checker
#   4. Phase 6 DevOpsOrchestrator 5 步编排：eag-devops-orchestrator
#   5. Phase 7 CLI 命令链路：
#      - eag-cli-command-parser（/eag-deploy 解析 + DeployRequest 字段校验）
#      - eag-session-commands-hook（handleEagDeployCommand + renderDevOpsResult + N1-N11）
#   6. 既有 EAG 测试零回归：eag-*.test.ts 全套
#
# 退出码：
#   0 = 全部检查通过（tsc 0 errors + ESLint 0 errors + 全量测试 0 fail）
#   1 = 环境预检失败 / 入参非法
#   2 = tsc 类型检查失败
#   3 = ESLint 静态检查失败
#   4 = 批次 13 单元测试失败
#   5 = 既有 EAG 全套回归失败
#
# 使用方式：
#   bash tests/scripts/eag-batch13-integration.sh
#
# 设计依据：EAG-P4-BATCH13-DESIGN.md §6.1 Phase 8 + §6.2 测试策略
# ==============================================================================

set -euo pipefail

# ---------- 日志工具 ----------
# 统一日志格式：[eag-batch13-integration] 消息
log() {
  echo "[eag-batch13-integration] $*"
}

# 失败时输出错误日志并以指定退出码退出
# @param $1 错误消息
# @param $2 退出码（默认 1）
fail() {
  echo "[eag-batch13-integration] ❌ $*" >&2
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

# 定位 CORE_DIR（packages/core，eag 模块所在包）
# 脚本位于 tests/scripts/ 下，需向上两级到项目根目录，再进入 packages/core
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CORE_DIR="${PROJECT_ROOT}/packages/core"

# 校验批次 13 核心模块路径存在
[ -d "${CORE_DIR}/src/eag/devops" ] || fail "未找到 eag/devops 模块（CORE_DIR=${CORE_DIR}）" 1
[ -f "${CORE_DIR}/src/eag/devops/devops-orchestrator.ts" ] || fail "未找到 DevOpsOrchestrator 实现" 1
[ -f "${CORE_DIR}/src/eag/cli/eag-command-parser.ts" ] || fail "未找到 EagCommandParser 实现" 1
[ -f "${CORE_DIR}/src/session.ts" ] || fail "未找到 session.ts" 1

# 校验批次 13 测试文件存在
[ -f "${CORE_DIR}/src/tests/eag-devops-orchestrator.test.ts" ] || fail "未找到 eag-devops-orchestrator.test.ts" 1
[ -f "${CORE_DIR}/src/tests/eag-cli-command-parser.test.ts" ] || fail "未找到 eag-cli-command-parser.test.ts" 1
[ -f "${CORE_DIR}/src/tests/eag-session-commands-hook.test.ts" ] || fail "未找到 eag-session-commands-hook.test.ts" 1

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

# ---------- Step 2: ESLint 静态检查（批次 13 全部核心文件） ----------
log "Step 2: ESLint 静态检查（批次 13 全部核心文件）"

# 批次 13 核心改动文件清单（对齐 commit 27015e9 + 311d575 + Phase 1-6 全部产出）
# P1-4 修复（架构师审查）：补全 9 个遗漏的 batch13 核心源码文件
BATCH13_CORE_FILES=(
  # Phase 1-3 类型定义
  "${CORE_DIR}/src/eag/devops/types.ts"
  # Phase 4 IaC 生成器
  "${CORE_DIR}/src/eag/devops/iac-generator/terraform-generator.ts"
  "${CORE_DIR}/src/eag/devops/iac-generator/k8s-manifest-generator.ts"
  "${CORE_DIR}/src/eag/devops/iac-generator/helm-chart-generator.ts"
  # Phase 5 阶段组件 + G-8 门禁
  "${CORE_DIR}/src/eag/deploy/pre-deploy-checker.ts"
  "${CORE_DIR}/src/eag/deploy/post-deploy-checker.ts"
  "${CORE_DIR}/src/eag/deploy/smoke-test-runner.ts"
  "${CORE_DIR}/src/eag/deploy/deploy-stage.ts"
  "${CORE_DIR}/src/eag/gate/gate-g8-checker.ts"
  # Phase 6 DevOpsOrchestrator + RollbackManager 占位
  "${CORE_DIR}/src/eag/devops/devops-orchestrator.ts"
  "${CORE_DIR}/src/eag/devops/rollback-manager.ts"
  # Phase 7 CLI 链路
  "${CORE_DIR}/src/eag/cli/eag-command-parser.ts"
  "${CORE_DIR}/src/eag/cli/index.ts"
  "${CORE_DIR}/src/session.ts"
  # 测试文件
  "${CORE_DIR}/src/tests/eag-devops-orchestrator.test.ts"
  "${CORE_DIR}/src/tests/eag-cli-command-parser.test.ts"
  "${CORE_DIR}/src/tests/eag-session-commands-hook.test.ts"
)

# 校验所有文件存在
for file in "${BATCH13_CORE_FILES[@]}"; do
  [ -f "${file}" ] || fail "文件不存在：${file}" 1
done

set +e
npx eslint "${BATCH13_CORE_FILES[@]}" 2>&1
ESLINT_EXIT_CODE=$?
set -e

if [ "${ESLINT_EXIT_CODE}" -ne 0 ]; then
  fail "ESLint 静态检查失败（退出码 = ${ESLINT_EXIT_CODE}）" 3
fi
log "✅ ESLint 静态检查通过（0 errors，$((${#BATCH13_CORE_FILES[@]})) 个核心文件）"

# ---------- Step 3: 批次 13 单元测试 ----------
log "Step 3: 批次 13 单元测试（Phase 1-7 全覆盖）"

# 批次 13 测试文件清单（按 Phase 顺序）
BATCH13_TEST_FILES=(
  # Phase 1-3 类型定义
  "${CORE_DIR}/src/tests/eag-devops-types.test.ts"
  # Phase 4 IaC 生成器
  "${CORE_DIR}/src/tests/eag-devops-iac-terraform.test.ts"
  "${CORE_DIR}/src/tests/eag-devops-iac-k8s.test.ts"
  "${CORE_DIR}/src/tests/eag-devops-iac-helm.test.ts"
  # Phase 5 阶段组件 + G-8 门禁
  "${CORE_DIR}/src/tests/eag-deploy-pre-checker.test.ts"
  "${CORE_DIR}/src/tests/eag-deploy-post-checker.test.ts"
  "${CORE_DIR}/src/tests/eag-deploy-smoke-test-runner.test.ts"
  "${CORE_DIR}/src/tests/eag-deploy-stage.test.ts"
  "${CORE_DIR}/src/tests/eag-gate-g8-checker.test.ts"
  # Phase 6 DevOpsOrchestrator 5 步编排
  "${CORE_DIR}/src/tests/eag-devops-orchestrator.test.ts"
  # Phase 7 CLI 命令链路
  "${CORE_DIR}/src/tests/eag-cli-command-parser.test.ts"
  "${CORE_DIR}/src/tests/eag-session-commands-hook.test.ts"
)

set +e
npx tsx --test "${BATCH13_TEST_FILES[@]}" 2>&1
BATCH13_TEST_EXIT_CODE=$?
set -e

if [ "${BATCH13_TEST_EXIT_CODE}" -ne 0 ]; then
  fail "批次 13 单元测试失败（退出码 = ${BATCH13_TEST_EXIT_CODE}）" 4
fi
log "✅ 批次 13 单元测试全部通过"

# ---------- Step 4: 既有 EAG 全套回归 ----------
log "Step 4: 既有 EAG 全套回归（零回归验证）"

# 收集所有 eag-*.test.ts 文件（包含批次 13 测试 + 既有测试，重复运行以验证集成后零回归）
EAG_TEST_FILES=$(find "${CORE_DIR}/src/tests" -name "eag-*.test.ts" -type f | sort)

if [ -z "${EAG_TEST_FILES}" ]; then
  fail "未找到任何 eag-*.test.ts 测试文件" 1
fi

EAG_TEST_COUNT=$(echo "${EAG_TEST_FILES}" | wc -l | tr -d ' ')
log "  共发现 ${EAG_TEST_COUNT} 个 EAG 测试文件"

set +e
# 使用 xargs 并行执行所有 EAG 测试（与既有命令一致）
# 输出完整日志到 EAG_LOG 文件，便于 CI 调试，控制台仅显示末尾 30 行（P2-3 修复）
EAG_LOG="${PROJECT_ROOT}/eag-batch13-eag-regression.log"
echo "${EAG_TEST_FILES}" | xargs npx tsx --test 2>&1 | tee "${EAG_LOG}" | tail -30
EAG_TEST_EXIT_CODE=${PIPESTATUS[1]}
set -e

if [ "${EAG_TEST_EXIT_CODE}" -ne 0 ]; then
  log "❌ 既有 EAG 全套回归失败（退出码 = ${EAG_TEST_EXIT_CODE}），完整日志：${EAG_LOG}"
  fail "既有 EAG 全套回归失败（退出码 = ${EAG_TEST_EXIT_CODE}）" 5
fi
log "✅ 既有 EAG 全套回归通过（零回归，完整日志：${EAG_LOG}）"

# ---------- Step 5: 汇总报告 ----------
log "Step 5: 汇总报告"
cat <<EOF

========================================
EAG-P4 批次 13 集成测试报告
========================================
✅ Step 0: 环境预检通过 (node $(node --version))
✅ Step 1: tsc --noEmit 类型检查通过（0 errors）
✅ Step 2: ESLint 静态检查通过（0 errors，$((${#BATCH13_CORE_FILES[@]})) 个核心文件）
✅ Step 3: 批次 13 单元测试通过（$((${#BATCH13_TEST_FILES[@]})) 个测试文件）
✅ Step 4: 既有 EAG 全套回归通过（${EAG_TEST_COUNT} 个测试文件，零回归）

覆盖范围：
  - Phase 1-3 类型定义：eag-devops-types / eag-gate-types
  - Phase 4 IaC 生成器：terraform / k8s / helm
  - Phase 5 阶段组件：pre-checker / post-checker / smoke-test-runner / deploy-stage
  - Phase 5 G-8 门禁：eag-gate-g8-checker
  - Phase 6 DevOpsOrchestrator 5 步编排
  - Phase 7 CLI 命令链路：EagCommandParser v2 + SessionManager 集成
    - /eag-deploy 命令判定 + DeployRequest 字段校验（M1-M17）
    - handleEagDeployCommand 全链路（N1-N11，含 P1 修复覆盖）

验证标准（全部通过）：
  - tsc --noEmit: 0 errors
  - ESLint: 0 errors
  - 批次 13 单元测试: 100% pass
  - 既有 EAG 全套回归: 零回归
========================================
EOF

log "🎉 集成测试全部通过"
exit 0
