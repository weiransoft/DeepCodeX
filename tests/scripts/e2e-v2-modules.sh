#!/usr/bin/env bash
# ==============================================================================
# V2 模块完整性与单元测试 E2E 测试
#
# 测试目标（对齐 V2-UNIT-01~10 系列 122 用例）：
#   1. V2 6 子域文件完整性验证
#   2. V2 单元测试套件执行
#   3. V2 关键机制实现验证
#
# V2 6 子域（packages/core/src/v2/）：
#   - approval/（9 文件）：SideGit/ApprovalGate/ToolRouter/CommandSafety
#   - codemap/（2 文件）：Generator/RegexASTAnalyzer
#   - context/（8 文件）：DualLayer/Sliding/Relevance/Progressive
#   - diff/（4 文件）：Myers/ApplyPatch/EnhanceDiff/PatchSummary
#   - integration/（4 文件）：v1-adapters/session-hook
#   - memory/（11 文件）：UserGlobal/Experience/Redaction/Privacy
#   - understanding/（2 文件）：DomainModeler/ProjectUnderstanding
#
# 设计依据（docs/fusion/ 为本地设计文档，未入库）：
# - docs/fusion/V2_CONTEXT_MEMORY_TECH_DESIGN.md（V2 主技术方案 v2.6）
# - docs/fusion/V2_CONTEXT_MEMORY_TEST_PLAN.md（V2 测试方案 v2.1）
# - docs/fusion/V2_P0B_ARCHITECT_REVIEW.md（Side-Git 架构师审查）
# - docs/fusion/V2_P1/P2/P3_IMPLEMENTATION_PLAN.md（V2-P1/P2/P3 实施计划）
# ==============================================================================

set -uo pipefail

# ---------- 全局变量 ----------
TOTAL_CASES=0
PASSED_CASES=0
FAILED_CASES=0
FAILED_CASES_LIST=()

# ---------- 日志工具 ----------
log() {
  echo "[e2e-v2-modules] $*"
}

fail_log() {
  echo "[e2e-v2-modules] ❌ $*" >&2
}

# ---------- 环境预检 ----------
log "========== 环境预检 =========="

command -v node >/dev/null 2>&1 || { fail_log "未找到 node"; exit 1; }
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "${NODE_MAJOR}" -ge 20 ] || { fail_log "node 版本过低"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CORE_DIR="${PROJECT_ROOT}/packages/core"
V2_DIR="${CORE_DIR}/src/v2"

[ -d "${V2_DIR}" ] || { fail_log "未找到 V2 模块目录: ${V2_DIR}"; exit 1; }

log "✅ 环境预检通过"
log "  - V2_DIR: ${V2_DIR}"

# ---------- 测试用例执行函数 ----------
# 文件存在性检查用例
check_file_case() {
  local case_id="$1"
  local case_desc="$2"
  local file_path="$3"

  TOTAL_CASES=$((TOTAL_CASES + 1))
  log ""
  log "--- [${case_id}] ${case_desc} ---"
  log "文件: ${file_path}"

  if [ -f "${file_path}" ]; then
    PASSED_CASES=$((PASSED_CASES + 1))
    log "✅ ${case_id} 通过（文件存在）"
  else
    FAILED_CASES=$((FAILED_CASES + 1))
    FAILED_CASES_LIST+=("${case_id} (文件缺失: ${file_path})")
    fail_log "${case_id} 文件缺失: ${file_path}"
  fi
}

# 目录存在性检查用例
check_dir_case() {
  local case_id="$1"
  local case_desc="$2"
  local dir_path="$3"

  TOTAL_CASES=$((TOTAL_CASES + 1))
  log ""
  log "--- [${case_id}] ${case_desc} ---"
  log "目录: ${dir_path}"

  if [ -d "${dir_path}" ]; then
    local file_count
    file_count=$(find "${dir_path}" -name "*.ts" -type f | wc -l | tr -d ' ')
    PASSED_CASES=$((PASSED_CASES + 1))
    log "✅ ${case_id} 通过（${file_count} 个 .ts 文件）"
  else
    FAILED_CASES=$((FAILED_CASES + 1))
    FAILED_CASES_LIST+=("${case_id} (目录缺失: ${dir_path})")
    fail_log "${case_id} 目录缺失: ${dir_path}"
  fi
}

# ---------- V2 6 子域完整性验证 ----------

# TC-V2-01: approval 子域
check_dir_case "TC-V2-01" \
  "V2 approval 子域（SideGit/ApprovalGate/ToolRouter）" \
  "${V2_DIR}/approval"

# TC-V2-02: codemap 子域
check_dir_case "TC-V2-02" \
  "V2 codemap 子域（Generator/RegexASTAnalyzer）" \
  "${V2_DIR}/codemap"

# TC-V2-03: context 子域
check_dir_case "TC-V2-03" \
  "V2 context 子域（DualLayer/Sliding/Relevance/Progressive）" \
  "${V2_DIR}/context"

# TC-V2-04: diff 子域
check_dir_case "TC-V2-04" \
  "V2 diff 子域（Myers/ApplyPatch/EnhanceDiff/PatchSummary）" \
  "${V2_DIR}/diff"

# TC-V2-05: integration 子域
check_dir_case "TC-V2-05" \
  "V2 integration 子域（v1-adapters/session-hook）" \
  "${V2_DIR}/integration"

# TC-V2-06: memory 子域
check_dir_case "TC-V2-06" \
  "V2 memory 子域（UserGlobal/Experience/Redaction）" \
  "${V2_DIR}/memory"

# TC-V2-07: understanding 子域
check_dir_case "TC-V2-07" \
  "V2 understanding 子域（DomainModeler/ProjectUnderstanding）" \
  "${V2_DIR}/understanding"

# TC-V2-08: tests 子域
check_dir_case "TC-V2-08" \
  "V2 tests 子域" \
  "${V2_DIR}/tests"

# ---------- V2 关键组件文件验证 ----------

# TC-V2-09: ApprovalGate 实现
check_file_case "TC-V2-09" \
  "ApprovalGate 实现" \
  "${V2_DIR}/approval/approval-gate.ts"

# TC-V2-10: SideGitManager 实现
check_file_case "TC-V2-10" \
  "SideGitManager 实现" \
  "${V2_DIR}/approval/side-git.ts"

# TC-V2-11: SideGitRecovery 实现
check_file_case "TC-V2-11" \
  "SideGitRecovery 实现（两级完整性检查）" \
  "${V2_DIR}/approval/side-git-recovery.ts"

# TC-V2-12: ToolRouter 实现
check_file_case "TC-V2-12" \
  "ToolRouter 实现（onBeforeToolExecution async 钩子）" \
  "${V2_DIR}/approval/tool-router.ts"

# TC-V2-13: CommandSafety 实现
check_file_case "TC-V2-13" \
  "CommandSafety 实现（Arity Dictionary 50+ 条目）" \
  "${V2_DIR}/approval/command-safety.ts"

# TC-V2-14: ArityClassifier 实现
check_file_case "TC-V2-14" \
  "ArityClassifier 实现" \
  "${V2_DIR}/approval/arity-classifier.ts"

# TC-V2-15: ApprovalDeniedError 实现
check_file_case "TC-V2-15" \
  "ApprovalDeniedError 实现（ES5 原型链修复）" \
  "${V2_DIR}/approval/approval-denied-error.ts"

# TC-V2-16: SideGitCommands 实现
check_file_case "TC-V2-16" \
  "SideGitCommands 实现（/restore /revert_turn /snapshot）" \
  "${V2_DIR}/approval/side-git-commands.ts"

# TC-V2-17: CodeMapGenerator 实现
check_file_case "TC-V2-17" \
  "CodeMapGenerator 实现（6 语言统一正则）" \
  "${V2_DIR}/codemap/generator.ts"

# TC-V2-18: RegexASTAnalyzer 实现
check_file_case "TC-V2-18" \
  "RegexASTAnalyzer 实现" \
  "${V2_DIR}/codemap/regex-analyzer.ts"

# TC-V2-19: DualLayerContextManager 实现
check_file_case "TC-V2-19" \
  "DualLayerContextManager 实现（全局+任务双层）" \
  "${V2_DIR}/context/dual-layer-manager.ts"

# TC-V2-20: SlidingWindowManager 实现
check_file_case "TC-V2-20" \
  "SlidingWindowManager 实现（Token 预算三层分配）" \
  "${V2_DIR}/context/sliding-window.ts"

# TC-V2-21: RelevanceScorer 实现
check_file_case "TC-V2-21" \
  "RelevanceScorer 实现（BFS 距离+TF-IDF+时间衰减）" \
  "${V2_DIR}/context/relevance-scorer.ts"

# TC-V2-22: ProgressiveContextLoader 实现
check_file_case "TC-V2-22" \
  "ProgressiveContextLoader 实现（Metadata/Instruction/Resource 三层）" \
  "${V2_DIR}/context/progressive-loader.ts"

# TC-V2-23: GlobalContext 实现
check_file_case "TC-V2-23" \
  "GlobalContext 实现（8 字段）" \
  "${V2_DIR}/context/global-context.ts"

# TC-V2-24: TaskContextManager 实现
check_file_case "TC-V2-24" \
  "TaskContextManager 实现" \
  "${V2_DIR}/context/task-context-manager.ts"

# TC-V2-25: ContextSynchronizer 实现
check_file_case "TC-V2-25" \
  "ContextSynchronizer 实现（双向同步）" \
  "${V2_DIR}/context/synchronizer.ts"

# TC-V2-26: MyersDiff 实现
check_file_case "TC-V2-26" \
  "MyersDiff 实现（O(ND) 算法自实现）" \
  "${V2_DIR}/diff/myers-diff.ts"

# TC-V2-27: ApplyPatch 实现
check_file_case "TC-V2-27" \
  "ApplyPatch 实现（Fuzzy Matching ±3 行容差）" \
  "${V2_DIR}/diff/apply-patch.ts"

# TC-V2-28: EnhanceDiffPreview 实现
check_file_case "TC-V2-28" \
  "EnhanceDiffPreview 实现" \
  "${V2_DIR}/diff/enhance-diff-preview.ts"

# TC-V2-29: PatchSummary 实现
check_file_case "TC-V2-29" \
  "PatchSummary 实现" \
  "${V2_DIR}/diff/patch-summary.ts"

# TC-V2-30: v1-adapters 实现（V2→V1 唯一入口）
check_file_case "TC-V2-30" \
  "v1-adapters 实现（V2→V1 唯一入口，eslint 强制）" \
  "${V2_DIR}/integration/v1-adapters.ts"

# TC-V2-31: session-hook 实现
check_file_case "TC-V2-31" \
  "session-hook 实现（V2 上下文异步预计算）" \
  "${V2_DIR}/integration/session-hook.ts"

# TC-V2-32: approval-hook 实现
check_file_case "TC-V2-32" \
  "approval-hook 实现" \
  "${V2_DIR}/integration/approval-hook.ts"

# TC-V2-33: edit-handler-hook 实现
check_file_case "TC-V2-33" \
  "edit-handler-hook 实现" \
  "${V2_DIR}/integration/edit-handler-hook.ts"

# TC-V2-34: UserGlobalMemoryManager 实现（7 维度）
check_file_case "TC-V2-34" \
  "UserGlobalMemoryManager 实现（7 维度记忆）" \
  "${V2_DIR}/memory/user-global-memory.ts"

# TC-V2-35: ExperienceRecommender 实现（三路召回 RAG）
check_file_case "TC-V2-35" \
  "ExperienceRecommender 实现（三路召回 RAG）" \
  "${V2_DIR}/memory/experience-recommender.ts"

# TC-V2-36: ContentSummarizer 接口
check_file_case "TC-V2-36" \
  "ContentSummarizer 接口实现" \
  "${V2_DIR}/memory/content-summarizer.ts"

# TC-V2-37: DeepSeekSummarizer 生产实现
check_file_case "TC-V2-37" \
  "DeepSeekSummarizer 生产实现" \
  "${V2_DIR}/memory/deepseek-summarizer.ts"

# TC-V2-38: RuleBasedSummarizer 测试实现（非 mock）
check_file_case "TC-V2-38" \
  "RuleBasedSummarizer 测试实现（非 mock，真实启发式）" \
  "${V2_DIR}/memory/rule-based-summarizer.ts"

# TC-V2-39: summarizer-factory 切换
check_file_case "TC-V2-39" \
  "summarizer-factory 切换实现" \
  "${V2_DIR}/memory/summarizer-factory.ts"

# TC-V2-40: GitignoreFilter 实现
check_file_case "TC-V2-40" \
  "GitignoreFilter 实现（glob 匹配器自实现）" \
  "${V2_DIR}/memory/gitignore-filter.ts"

# TC-V2-41: MemoryStore 实现
check_file_case "TC-V2-41" \
  "MemoryStore 实现" \
  "${V2_DIR}/memory/memory-store.ts"

# TC-V2-42: ProjectMemory 实现
check_file_case "TC-V2-42" \
  "ProjectMemory 实现" \
  "${V2_DIR}/memory/project-memory.ts"

# TC-V2-43: DomainModeler 实现
check_file_case "TC-V2-43" \
  "DomainModeler 实现（业务领域建模）" \
  "${V2_DIR}/understanding/domain-modeler.ts"

# TC-V2-44: ProjectUnderstanding 实现
check_file_case "TC-V2-44" \
  "ProjectUnderstanding 实现" \
  "${V2_DIR}/understanding/project-understanding.ts"

# ---------- V2 单元测试套件执行 ----------
log ""
log "========== V2 单元测试套件执行 =========="

# TC-V2-45: V2 测试目录存在
check_dir_case "TC-V2-45" \
  "V2 测试目录" \
  "${V2_DIR}/tests"

# TC-V2-46: 执行 V2 approval 测试
TOTAL_CASES=$((TOTAL_CASES + 1))
log ""
log "--- [TC-V2-46] V2 approval 单元测试 ---"
set +e
(
  cd "${CORE_DIR}" && node --import tsx --test src/v2/tests/approval/*.test.ts 2>&1
) | tail -30
APPROVAL_TEST_EXIT=$?
set -e
if [ "${APPROVAL_TEST_EXIT}" -eq 0 ]; then
  PASSED_CASES=$((PASSED_CASES + 1))
  log "✅ TC-V2-46 通过"
else
  FAILED_CASES=$((FAILED_CASES + 1))
  FAILED_CASES_LIST+=("TC-V2-46 (approval 测试失败 exit=${APPROVAL_TEST_EXIT})")
  fail_log "TC-V2-46 approval 测试失败"
fi

# TC-V2-47: 执行 V2 codemap 测试
TOTAL_CASES=$((TOTAL_CASES + 1))
log ""
log "--- [TC-V2-47] V2 codemap 单元测试 ---"
set +e
(
  cd "${CORE_DIR}" && node --import tsx --test src/v2/tests/codemap/*.test.ts 2>&1
) | tail -30
CODEMAP_TEST_EXIT=$?
set -e
if [ "${CODEMAP_TEST_EXIT}" -eq 0 ]; then
  PASSED_CASES=$((PASSED_CASES + 1))
  log "✅ TC-V2-47 通过"
else
  FAILED_CASES=$((FAILED_CASES + 1))
  FAILED_CASES_LIST+=("TC-V2-47 (codemap 测试失败 exit=${CODEMAP_TEST_EXIT})")
  fail_log "TC-V2-47 codemap 测试失败"
fi

# TC-V2-48: 执行 V2 context 测试
TOTAL_CASES=$((TOTAL_CASES + 1))
log ""
log "--- [TC-V2-48] V2 context 单元测试 ---"
set +e
(
  cd "${CORE_DIR}" && node --import tsx --test src/v2/tests/context/*.test.ts 2>&1
) | tail -30
CONTEXT_TEST_EXIT=$?
set -e
if [ "${CONTEXT_TEST_EXIT}" -eq 0 ]; then
  PASSED_CASES=$((PASSED_CASES + 1))
  log "✅ TC-V2-48 通过"
else
  FAILED_CASES=$((FAILED_CASES + 1))
  FAILED_CASES_LIST+=("TC-V2-48 (context 测试失败 exit=${CONTEXT_TEST_EXIT})")
  fail_log "TC-V2-48 context 测试失败"
fi

# TC-V2-49: 执行 V2 diff 测试
TOTAL_CASES=$((TOTAL_CASES + 1))
log ""
log "--- [TC-V2-49] V2 diff 单元测试 ---"
set +e
(
  cd "${CORE_DIR}" && node --import tsx --test src/v2/tests/diff/*.test.ts 2>&1
) | tail -30
DIFF_TEST_EXIT=$?
set -e
if [ "${DIFF_TEST_EXIT}" -eq 0 ]; then
  PASSED_CASES=$((PASSED_CASES + 1))
  log "✅ TC-V2-49 通过"
else
  FAILED_CASES=$((FAILED_CASES + 1))
  FAILED_CASES_LIST+=("TC-V2-49 (diff 测试失败 exit=${DIFF_TEST_EXIT})")
  fail_log "TC-V2-49 diff 测试失败"
fi

# TC-V2-50: 执行 V2 memory 测试
TOTAL_CASES=$((TOTAL_CASES + 1))
log ""
log "--- [TC-V2-50] V2 memory 单元测试 ---"
set +e
(
  cd "${CORE_DIR}" && node --import tsx --test src/v2/tests/memory/*.test.ts 2>&1
) | tail -30
MEMORY_TEST_EXIT=$?
set -e
if [ "${MEMORY_TEST_EXIT}" -eq 0 ]; then
  PASSED_CASES=$((PASSED_CASES + 1))
  log "✅ TC-V2-50 通过"
else
  FAILED_CASES=$((FAILED_CASES + 1))
  FAILED_CASES_LIST+=("TC-V2-50 (memory 测试失败 exit=${MEMORY_TEST_EXIT})")
  fail_log "TC-V2-50 memory 测试失败"
fi

# TC-V2-51: 执行 V2 understanding 测试
TOTAL_CASES=$((TOTAL_CASES + 1))
log ""
log "--- [TC-V2-51] V2 understanding 单元测试 ---"
set +e
(
  cd "${CORE_DIR}" && node --import tsx --test src/v2/tests/understanding/*.test.ts 2>&1
) | tail -30
UNDERSTANDING_TEST_EXIT=$?
set -e
if [ "${UNDERSTANDING_TEST_EXIT}" -eq 0 ]; then
  PASSED_CASES=$((PASSED_CASES + 1))
  log "✅ TC-V2-51 通过"
else
  FAILED_CASES=$((FAILED_CASES + 1))
  FAILED_CASES_LIST+=("TC-V2-51 (understanding 测试失败 exit=${UNDERSTANDING_TEST_EXIT})")
  fail_log "TC-V2-51 understanding 测试失败"
fi

# TC-V2-52: 执行 V2 integration 测试
TOTAL_CASES=$((TOTAL_CASES + 1))
log ""
log "--- [TC-V2-52] V2 integration 单元测试 ---"
set +e
(
  cd "${CORE_DIR}" && node --import tsx --test src/v2/tests/integration/*.test.ts 2>&1
) | tail -30
INTEGRATION_TEST_EXIT=$?
set -e
if [ "${INTEGRATION_TEST_EXIT}" -eq 0 ]; then
  PASSED_CASES=$((PASSED_CASES + 1))
  log "✅ TC-V2-52 通过"
else
  FAILED_CASES=$((FAILED_CASES + 1))
  FAILED_CASES_LIST+=("TC-V2-52 (integration 测试失败 exit=${INTEGRATION_TEST_EXIT})")
  fail_log "TC-V2-52 integration 测试失败"
fi

# ---------- 汇总 ----------
log ""
log "========== 汇总 =========="
log "  总用例: ${TOTAL_CASES}"
log "  通过:   ${PASSED_CASES}"
log "  失败:   ${FAILED_CASES}"

if [ "${TOTAL_CASES}" -gt 0 ]; then
  log "  通过率: $(( PASSED_CASES * 100 / TOTAL_CASES ))%"
fi

if [ "${FAILED_CASES}" -gt 0 ]; then
  log ""
  log "  失败用例:"
  for entry in "${FAILED_CASES_LIST[@]}"; do
    log "    - ${entry}"
  done
  exit 2
fi

exit 0
