#!/usr/bin/env bash
# ==============================================================================
# EAG-P2 批次 9 集成测试 shell（遗留 L-6 闭环）
#
# 功能：
#   调用既有 packages/core/src/tests/eag-batch9-integration-runner.ts，
#   将调用入口归位到 tests/scripts/ 目录（用户规则 C-9）。
#
# 工作流程：
#   1. 环境预检（node 版本 + runner 文件存在性）
#   2. 创建临时目录并写入 plan.md / tasks.md（与 runner 内部 FILE_CLUSTER 严格对齐）
#   3. 调用 `node --import tsx <runner> --tmp-dir <tmp> --report-file <report>`
#   4. 校验退出码与报告文件
#   5. 清理临时目录（无论成功或失败）
#
# 退出码（与 runner 内部 EXIT_CODES 对齐）：
#   0 = 全部检查通过
#   1 = 环境预检失败 / 入参非法
#   2 = Phase A 骨架生成失败（IA 断言失败或生成器抛错）
#   3 = Phase B LLM 填充失败（IB 断言失败或填充器抛错）
#   4 = STRICT 评估失败（IS 断言失败或评估器抛错）
#   5 = G-4/G-5 门禁失败（IG4/IG5 断言失败）
#
# 使用方式：
#   bash tests/scripts/eag-batch9-integration.sh
#
# 设计依据：
# - EAG-P3 批次 12 设计文档 §5.7 eag-batch9-integration.sh
# - EAG-P3 批次 12 设计文档 §5.1 D-C3-10（L-6 闭环）
# - 用户规则 C-9（测试 shell 脚本归位 tests/scripts/）
# - packages/core/src/tests/eag-batch9-integration-runner.ts（runner 实现）
# ==============================================================================

set -euo pipefail

# ---------- 日志工具 ----------
# 统一日志格式：[eag-batch9-integration] 消息
log() {
  echo "[eag-batch9-integration] $*"
}

# 失败时输出错误日志并以指定退出码退出
# @param $1 错误消息
# @param $2 退出码（默认 1）
fail() {
  echo "[eag-batch9-integration] ❌ $*" >&2
  exit "${2:-1}"
}

# ---------- Step 0: 环境预检 ----------
log "Step 0: 环境预检"

# node 版本检查（要求 >= 20，tsx 与 node:test 依赖）
command -v node >/dev/null 2>&1 || fail "未找到 node 可执行文件" 1
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "${NODE_MAJOR}" -ge 20 ] || fail "node 版本过低（要求 >= 20，当前 $(node --version)）" 1

# 定位 runner 文件
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CORE_DIR="${PROJECT_ROOT}/packages/core"
RUNNER="${CORE_DIR}/src/tests/eag-batch9-integration-runner.ts"

[ -f "${RUNNER}" ] || fail "未找到 batch9 集成测试 runner：${RUNNER}" 1
[ -d "${CORE_DIR}/src/eag" ] || fail "未找到 eag 模块（CORE_DIR=${CORE_DIR}）" 1

log "✅ 环境预检通过 (node $(node --version), RUNNER=${RUNNER})"

# ---------- Step 1: 创建临时目录与 plan.md / tasks.md ----------
log "Step 1: 创建临时目录与 plan.md / tasks.md"

# 使用 mktemp -d 创建独立临时目录（避免并发执行时冲突）
TMP_DIR="$(mktemp -d -t eag-batch9-integration-XXXXXX 2>/dev/null || mktemp -d)"
[ -d "${TMP_DIR}" ] || fail "临时目录创建失败" 1

# 注册清理函数（脚本退出时自动删除临时目录）
cleanup() {
  local exit_code=$?
  if [ -n "${TMP_DIR:-}" ] && [ -d "${TMP_DIR}" ]; then
    rm -rf "${TMP_DIR}"
    log "🧹 已清理临时目录：${TMP_DIR}"
  fi
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM

# 创建 docs/ 子目录（runner 期望 plan.md / tasks.md 位于 tmpDir/docs/）
DOCS_DIR="${TMP_DIR}/docs"
mkdir -p "${DOCS_DIR}"
PLAN_FILE="${DOCS_DIR}/plan.md"
TASKS_FILE="${DOCS_DIR}/tasks.md"
REPORT_FILE="${TMP_DIR}/integration-report.json"

# 写入 plan.md（与 runner 内部 FILE_CLUSTER="OrderAggregate" 严格对齐）
# 模块名必须为 "OrderAggregate"，否则 SkeletonGenerator 无法定位 ModuleSplit
cat > "${PLAN_FILE}" <<'EOF'
# 实现方案（plan.md）

## 1. 实现方案

本节为方案概述：实现订单聚合根的创建与取消能力。

## 2. 模块切分

### OrderAggregate
- 模块职责：OrderAggregate 聚合根，负责订单创建/取消
- 依赖模块：无
- 关键文件：src/domain/order/OrderAggregate.ts

## 3. 接口契约

（略）

## 4. 数据迁移

（略）

## 5. 风险与回退

（略）
EOF

# 写入 tasks.md（runner 仅校验非空字符串，但保留任务卡 T-001 引用以与 runner 内部 TASK_CARD_ID 对齐）
cat > "${TASKS_FILE}" <<'EOF'
# 任务清单（tasks.md）

## T-001：OrderAggregate 骨架生成与 LLM 填充

- 需求：实现 OrderAggregate 聚合根
- 验收标准：
  1. 骨架含 TODO(phase-b) 占位标记
  2. LLM 填充后无占位残留且通过 STRICT 评估
- 依赖：无
EOF

log "✅ 临时目录已创建：${TMP_DIR}"
log "  - plan.md：${PLAN_FILE}"
log "  - tasks.md：${TASKS_FILE}"

# ---------- Step 2: 调用 runner 执行集成测试 ----------
log "Step 2: 调用 EAG-P2 批次 9 集成测试 runner"

# 直接通过 node --import tsx 执行 runner.ts（非 node:test 模式，runner 自带 main() 入口）
# 退出码与 runner 内部 EXIT_CODES 严格对齐
set +e
(
  cd "${CORE_DIR}"
  node --import tsx "${RUNNER}" \
    --tmp-dir "${TMP_DIR}" \
    --report-file "${REPORT_FILE}" 2>&1
)
RUNNER_EXIT_CODE=$?
set -e

# ---------- Step 3: 校验退出码与报告文件 ----------
log "Step 3: 校验退出码与报告文件"

if [ "${RUNNER_EXIT_CODE}" -ne 0 ]; then
  fail "EAG-P2 批次 9 集成测试失败（退出码 = ${RUNNER_EXIT_CODE}）" "${RUNNER_EXIT_CODE}"
fi

# 校验报告文件存在性（runner 应在 tmpDir/integration-report.json 输出报告）
if [ ! -f "${REPORT_FILE}" ]; then
  fail "集成测试报告文件未生成：${REPORT_FILE}" 1
fi

# 校验报告文件非空
REPORT_SIZE="$(wc -c < "${REPORT_FILE}" | tr -d ' ')"
if [ "${REPORT_SIZE}" -eq 0 ]; then
  fail "集成测试报告文件为空：${REPORT_FILE}" 1
fi

log "✅ 集成测试报告已生成（${REPORT_SIZE} bytes）：${REPORT_FILE}"

# ---------- Step 4: 摘要 ----------
log "🎉 EAG-P2 批次 9 集成测试全部通过"
log "  - 环境预检：✅"
log "  - 临时目录与 plan.md / tasks.md：✅"
log "  - runner 执行：✅（退出码 0）"
log "  - 报告文件校验：✅（${REPORT_SIZE} bytes）"

exit 0
