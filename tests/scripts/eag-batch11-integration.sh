#!/usr/bin/env bash
# ==============================================================================
# EAG-P3 批次 11 完整集成测试脚本（S1 + S2 + S3 + B1 + B2 + B3 + B4 + B5）
#
# 功能：
#   串联 EAG-P3 批次 11 全部改进项与功能交付的单元测试：
#   环境预检 → tsc 类型检查 → 8 个测试模块逐一验证 → 控制台摘要
#
# 验证范围（对齐设计文档 §10.1 实施顺序 + §10.2 测试策略）：
#   Phase 1：S2 改进 - 根 barrel 类型源头（eag-root-barrel.test.ts）
#   Phase 2：S1 改进 - testing-orchestrator.ts G-6/G-7 注入（eag-testing-orchestrator.test.ts）
#   Phase 3：B1 ICP 合规包首版（6 个测试文件）
#   Phase 4：B5 gate-g7-checker.ts 合规证据扩展（2 个测试文件）
#   Phase 5：B2 PKC L4 交接文档层（4 个测试文件）
#   Phase 6：B4 pkc/types.ts IMPLEMENTED_PKC_LAYERS 修正（eag-pkc-types.test.ts）
#   Phase 7：B3 棕地增量测试选择器（6 个测试文件）
#   Phase 8：S3 session.ts 抽取 CLI 命令解析器（2 个测试文件）
#
# 退出码：
#   0 = 全部检查通过
#   1 = 环境预检失败
#   2 = tsc 类型检查失败
#   3 = 单个测试模块失败
#   4 = 多个测试模块失败（回归）
#
# 使用方式：
#   bash tests/scripts/eag-batch11-integration.sh
#
# 设计依据：
# - EAG-P3 批次 11 设计文档 §10.1 实施顺序
# - EAG-P3 批次 11 设计文档 §10.2.2 集成测试脚本位置
# - EAG-P3 批次 11 设计文档 §10.2.3 测试规范（不使用 mock / 中文详细注释）
# - 用户规则 C-9（测试 shell 脚本置于 tests/scripts/）
# ==============================================================================

set -euo pipefail

# ---------- 日志工具 ----------
# 统一日志格式：[eag-batch11-integration] 消息
log() {
  echo "[eag-batch11-integration] $*"
}

# 失败时输出错误日志并以指定退出码退出
# @param $1 错误消息
# @param $2 退出码（默认 1）
fail() {
  echo "[eag-batch11-integration] ❌ $*" >&2
  exit "${2:-1}"
}

# 记录失败的测试模块（用于多模块失败时的回归报告）
FAILED_MODULES=()

# 单模块测试函数
# @param $1 模块名称（S1 / S2 / S3 / B1 / B2 / B3 / B4 / B5）
# @param $2 测试文件名（不含路径前缀）
run_module() {
  local module_name="$1"
  local test_file="$2"

  log "  - 运行模块 ${module_name}（${test_file}）..."

  set +e
  (
    cd "${CORE_DIR}"
    node --import tsx --test --test-timeout=120000 "src/tests/${test_file}" 2>&1
  )
  local exit_code=$?
  set -e

  if [ "${exit_code}" -ne 0 ]; then
    log "    ❌ 模块 ${module_name} 失败（退出码 = ${exit_code}）"
    FAILED_MODULES+=("${module_name}")
    return 1
  else
    log "    ✅ 模块 ${module_name} 通过"
    return 0
  fi
}

# ---------- Step 0: 环境预检 ----------
log "Step 0: 环境预检"

# node 版本检查（要求 >= 20，tsx 与 node:test 依赖）
command -v node >/dev/null 2>&1 || fail "未找到 node 可执行文件" 1
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "${NODE_MAJOR}" -ge 20 ] || fail "node 版本过低（要求 >= 20，当前 $(node --version)）" 1

# 定位 CORE_DIR（packages/core，eag 模块所在包）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CORE_DIR="${PROJECT_ROOT}/packages/core"
[ -d "${CORE_DIR}/src/eag" ] || fail "未找到 eag 模块（CORE_DIR=${CORE_DIR}）" 1

# 检查批次 11 关键源码文件是否存在
[ -f "${CORE_DIR}/src/eag/cli/eag-command-parser.ts" ] || fail "未找到 S3 改进源码 eag/cli/eag-command-parser.ts" 1
[ -f "${CORE_DIR}/src/eag/icp/types.ts" ] || fail "未找到 B1 ICP 源码 eag/icp/types.ts" 1
[ -f "${CORE_DIR}/src/eag/icp/compliance-engine.ts" ] || fail "未找到 B1 ICP 编排器 eag/icp/compliance-engine.ts" 1
[ -f "${CORE_DIR}/src/eag/icp/packs/gmp-pack.ts" ] || fail "未找到 B1 GMP 合规包 eag/icp/packs/gmp-pack.ts" 1
[ -f "${CORE_DIR}/src/eag/icp/packs/cfr-part11-pack.ts" ] || fail "未找到 B1 CFR 合规包 eag/icp/packs/cfr-part11-pack.ts" 1
[ -f "${CORE_DIR}/src/eag/icp/packs/alcoa-plus-pack.ts" ] || fail "未找到 B1 ALCOA+ 合规包 eag/icp/packs/alcoa-plus-pack.ts" 1
[ -f "${CORE_DIR}/src/eag/pkc/l4/handover-doc-builder.ts" ] || fail "未找到 B2 L4 交接文档构建器 eag/pkc/l4/handover-doc-builder.ts" 1
[ -d "${CORE_DIR}/src/eag/pkc/l4/section-builders" ] || fail "未找到 B2 L4 SectionBuilder 目录" 1
[ -f "${CORE_DIR}/src/eag/testing/incremental/incremental-test-selector.ts" ] || fail "未找到 B3 增量测试选择器 eag/testing/incremental/incremental-test-selector.ts" 1
[ -f "${CORE_DIR}/src/eag/testing/testing-orchestrator.ts" ] || fail "未找到 S1 改进源码 eag/testing/testing-orchestrator.ts" 1
[ -f "${CORE_DIR}/src/eag/index.ts" ] || fail "未找到 S2 改进源码 eag/index.ts" 1
[ -f "${CORE_DIR}/src/session.ts" ] || fail "未找到 S3 改进源码 session.ts" 1

# 检查全部测试文件存在性
for test_file in \
  "eag-root-barrel.test.ts" \
  "eag-testing-orchestrator.test.ts" \
  "eag-cli-command-parser.test.ts" \
  "eag-session-commands-hook.test.ts" \
  "eag-icp-types.test.ts" \
  "eag-icp-gmp-pack.test.ts" \
  "eag-icp-cfr-part11-pack.test.ts" \
  "eag-icp-alcoa-plus-pack.test.ts" \
  "eag-icp-compliance-engine.test.ts" \
  "eag-icp-evidence-collector.test.ts" \
  "eag-pkc-l4-types.test.ts" \
  "eag-pkc-l4-section-builders.test.ts" \
  "eag-pkc-l4-handover-doc-builder.test.ts" \
  "eag-pkc-l4-confidence.test.ts" \
  "eag-incremental-types.test.ts" \
  "eag-incremental-git-diff-analyzer.test.ts" \
  "eag-incremental-blast-radius-bfs.test.ts" \
  "eag-incremental-risk-scorer.test.ts" \
  "eag-incremental-test-selector.test.ts" \
  "eag-incremental-boundary.test.ts" \
  "eag-pkc-types.test.ts" \
  "eag-gate-g7-checker.test.ts" \
  "eag-gate-g7-compliance.test.ts"; do
  [ -f "${CORE_DIR}/src/tests/${test_file}" ] || fail "未找到测试文件 ${test_file}" 1
done

log "✅ 环境预检通过"
log "  - node: $(node --version)"
log "  - CORE_DIR: ${CORE_DIR}"
log "  - 源码文件: ✅ S1/S2/S3 + B1/B2/B3 + B4/B5 全部就位"
log "  - 测试文件: ✅ 23 个测试文件齐全"

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

# ---------- Step 2: 按实施顺序运行 8 个测试模块 ----------
log "Step 2: 按实施顺序运行 8 个测试模块（Phase 1~8）"

# Phase 1：S2 改进 - 根 barrel 类型源头
log "Phase 1：S2 改进 - 根 barrel 类型源头"
run_module "S2" "eag-root-barrel.test.ts" || true

# Phase 2：S1 改进 - testing-orchestrator.ts G-6/G-7 注入
log "Phase 2：S1 改进 - testing-orchestrator.ts G-6/G-7 注入"
run_module "S1" "eag-testing-orchestrator.test.ts" || true

# Phase 3：B1 ICP 合规包首版（6 个测试文件）
log "Phase 3：B1 ICP 合规包首版"
run_module "B1-types" "eag-icp-types.test.ts" || true
run_module "B1-gmp" "eag-icp-gmp-pack.test.ts" || true
run_module "B1-cfr" "eag-icp-cfr-part11-pack.test.ts" || true
run_module "B1-alcoa" "eag-icp-alcoa-plus-pack.test.ts" || true
run_module "B1-engine" "eag-icp-compliance-engine.test.ts" || true
run_module "B1-collector" "eag-icp-evidence-collector.test.ts" || true

# Phase 4：B5 gate-g7-checker.ts 合规证据扩展（2 个测试文件）
log "Phase 4：B5 gate-g7-checker.ts 合规证据扩展"
run_module "B5-checker" "eag-gate-g7-checker.test.ts" || true
run_module "B5-compliance" "eag-gate-g7-compliance.test.ts" || true

# Phase 5：B2 PKC L4 交接文档层（4 个测试文件）
log "Phase 5：B2 PKC L4 交接文档层"
run_module "B2-types" "eag-pkc-l4-types.test.ts" || true
run_module "B2-sections" "eag-pkc-l4-section-builders.test.ts" || true
run_module "B2-builder" "eag-pkc-l4-handover-doc-builder.test.ts" || true
run_module "B2-confidence" "eag-pkc-l4-confidence.test.ts" || true

# Phase 6：B4 pkc/types.ts IMPLEMENTED_PKC_LAYERS 修正
log "Phase 6：B4 pkc/types.ts IMPLEMENTED_PKC_LAYERS 修正"
run_module "B4" "eag-pkc-types.test.ts" || true

# Phase 7：B3 棕地增量测试选择器（6 个测试文件）
log "Phase 7：B3 棕地增量测试选择器"
run_module "B3-types" "eag-incremental-types.test.ts" || true
run_module "B3-gitdiff" "eag-incremental-git-diff-analyzer.test.ts" || true
run_module "B3-bfs" "eag-incremental-blast-radius-bfs.test.ts" || true
run_module "B3-scorer" "eag-incremental-risk-scorer.test.ts" || true
run_module "B3-selector" "eag-incremental-test-selector.test.ts" || true
run_module "B3-boundary" "eag-incremental-boundary.test.ts" || true

# Phase 8：S3 session.ts 抽取 CLI 命令解析器（2 个测试文件）
log "Phase 8：S3 session.ts 抽取 CLI 命令解析器"
run_module "S3-parser" "eag-cli-command-parser.test.ts" || true
run_module "S3-session-hook" "eag-session-commands-hook.test.ts" || true

# ---------- Step 3: 结果汇总与退出码判定 ----------
log "Step 3: 集成测试结果汇总"

if [ "${#FAILED_MODULES[@]}" -eq 0 ]; then
  log "  - tsc 类型检查：✅ 通过（0 errors）"
  log "  - Phase 1 S2 根 barrel 类型源头：✅ 通过"
  log "  - Phase 2 S1 testing-orchestrator G-6/G-7 注入：✅ 通过"
  log "  - Phase 3 B1 ICP 合规包（6 文件）：✅ 通过"
  log "  - Phase 4 B5 G-7 合规证据扩展（2 文件）：✅ 通过"
  log "  - Phase 5 B2 PKC L4 交接文档（4 文件）：✅ 通过"
  log "  - Phase 6 B4 IMPLEMENTED_PKC_LAYERS 修正：✅ 通过"
  log "  - Phase 7 B3 棕地增量测试选择器（6 文件）：✅ 通过"
  log "  - Phase 8 S3 CLI 命令解析器（2 文件）：✅ 通过"
  log ""
  log "🎉 EAG-P3 批次 11 集成测试全部通过"
  log "   验证范围："
  log "   - 3 项改进 S1/S2/S3 全部通过"
  log "   - 5 项交付 B1/B2/B3/B4/B5 全部通过"
  log "   - 23 个测试文件全部通过"
  log "   - tsc 类型检查 0 errors"
  exit 0
elif [ "${#FAILED_MODULES[@]}" -eq 1 ]; then
  log "  ❌ 失败的模块：${FAILED_MODULES[0]}"
  fail "测试模块 ${FAILED_MODULES[0]} 失败" 3
else
  log "  ❌ 失败的模块（${#FAILED_MODULES[@]} 个）："
  for module in "${FAILED_MODULES[@]}"; do
    log "    - ${module}"
  done
  fail "多个测试模块失败（回归）" 4
fi
