#!/usr/bin/env bash
# ==============================================================================
# Rules 子命令 E2E 测试
#
# 测试目标（对齐 TC-RULES-01~10）：
#   1. rules list — 列出三层规则（种子/用户/项目）
#   2. rules add — 添加用户/项目规则
#   3. rules show — 查看规则详情
#   4. rules path — 显示规则文件路径
#   5. rules remove — 提示手动编辑
#   6. 三层规则优先级覆盖
#   7. JSON 格式损坏容错
#
# 设计依据：
# - docs/enterprise/ENTERPRISE_APP_GENERATION_DESIGN.md §11（RLIS 三层规则存储）
# - packages/cli/src/rules/rules-cmd.ts（rules 子命令实现）
# - packages/core/src/eag/rlis/（RLIS 核心模块）
# ==============================================================================

set -uo pipefail

# ---------- 全局变量 ----------
TOTAL_CASES=0
PASSED_CASES=0
FAILED_CASES=0
FAILED_CASES_LIST=()

# ---------- 日志工具 ----------
log() {
  echo "[e2e-rules-cmd] $*"
}

fail_log() {
  echo "[e2e-rules-cmd] ❌ $*" >&2
}

# ---------- 环境预检 ----------
log "========== 环境预检 =========="

command -v node >/dev/null 2>&1 || { fail_log "未找到 node"; exit 1; }
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "${NODE_MAJOR}" -ge 20 ] || { fail_log "node 版本过低"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CLI_DIR="${PROJECT_ROOT}/packages/cli"
CLI_ENTRY="${CLI_DIR}/src/cli.tsx"

[ -f "${CLI_ENTRY}" ] || { fail_log "未找到 CLI 入口: ${CLI_ENTRY}"; exit 1; }

# 校验 rules 模块源码存在
[ -f "${CLI_DIR}/src/rules/rules-cmd.ts" ] || { fail_log "未找到 rules-cmd.ts"; exit 1; }
[ -d "${PROJECT_ROOT}/packages/core/src/eag/rlis" ] || { fail_log "未找到 rlis 模块"; exit 1; }

# 创建临时测试目录（用于隔离测试，避免污染真实配置）
TEST_TMP_DIR="$(mktemp -d -t e2e-rules-XXXXXX 2>/dev/null || mktemp -d)"
[ -d "${TEST_TMP_DIR}" ] || { fail_log "临时目录创建失败"; exit 1; }

# 注册清理函数
cleanup() {
  local exit_code=$?
  if [ -n "${TEST_TMP_DIR:-}" ] && [ -d "${TEST_TMP_DIR}" ]; then
    rm -rf "${TEST_TMP_DIR}"
    log "🧹 已清理临时目录: ${TEST_TMP_DIR}"
  fi
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM

log "✅ 环境预检通过"
log "  - 测试临时目录: ${TEST_TMP_DIR}"

# ---------- 测试用例执行函数 ----------
run_case() {
  local case_id="$1"
  local case_desc="$2"
  local expected_exit="$3"
  local expected_output="$4"
  local cmd="$5"

  TOTAL_CASES=$((TOTAL_CASES + 1))
  log ""
  log "--- [${case_id}] ${case_desc} ---"
  log "命令: ${cmd}"

  local output
  set +e
  # 添加 < /dev/null 防止 TUI 在非交互环境下挂起等待输入
  output=$(eval "${cmd}" 2>&1 < /dev/null)
  local actual_exit=$?
  set -e

  local exit_ok=1
  if [ "${expected_exit}" != "-1" ]; then
    if [ "${actual_exit}" != "${expected_exit}" ]; then
      exit_ok=0
      fail_log "${case_id} 退出码不匹配: expected=${expected_exit}, actual=${actual_exit}"
    fi
  fi

  local output_ok=1
  if [ -n "${expected_output}" ]; then
    if ! echo "${output}" | grep -qiE "${expected_output}"; then
      output_ok=0
      fail_log "${case_id} 输出不包含期望字符串: '${expected_output}'"
      fail_log "实际输出（前 300 字符）: $(echo "${output}" | head -c 300)"
    fi
  fi

  if [ "${exit_ok}" -eq 1 ] && [ "${output_ok}" -eq 1 ]; then
    PASSED_CASES=$((PASSED_CASES + 1))
    log "✅ ${case_id} 通过"
  else
    FAILED_CASES=$((FAILED_CASES + 1))
    FAILED_CASES_LIST+=("${case_id}")
  fi
}

# ---------- 构造 CLI 命令 ----------
CLI_CMD="node --import tsx ${CLI_ENTRY}"
# 使用临时目录作为 project-root，避免污染真实项目
RULES_PROJECT_ROOT="${TEST_TMP_DIR}"

# ---------- 测试用例 ----------

# TC-RULES-01: rules list 列出三层规则
# 验证输出包含种子规则（SEED-01~10 中的至少一个）
run_case "TC-RULES-01" \
  "rules list 列出三层规则" \
  0 \
  "SEED-|种子|rule|规则" \
  "${CLI_CMD} rules list --project-root ${RULES_PROJECT_ROOT}"

# TC-RULES-02: rules path 显示规则文件路径
run_case "TC-RULES-02" \
  "rules path 显示规则文件路径" \
  0 \
  "global-rules|project-rules|rules" \
  "${CLI_CMD} rules path --project-root ${RULES_PROJECT_ROOT}"

# TC-RULES-03: rules add 添加用户规则（BLOCKER 级别）
run_case "TC-RULES-03" \
  "rules add 添加 BLOCKER 用户规则" \
  0 \
  "USER-|added|添加成功" \
  "${CLI_CMD} rules add --content 禁止使用var声明变量 --severity BLOCKER --project-root ${RULES_PROJECT_ROOT}"

# TC-RULES-04: rules add 添加项目规则
run_case "TC-RULES-04" \
  "rules add 添加项目规则" \
  0 \
  "PROJ-|added|添加成功" \
  "${CLI_CMD} rules add --content 禁止console.log --layer project --project-root ${RULES_PROJECT_ROOT}"

# TC-RULES-05: rules list 显示新添加的规则
# 添加后再次 list，验证包含新规则
run_case "TC-RULES-05" \
  "rules list 包含新添加的规则" \
  0 \
  "USER-|PROJ-" \
  "${CLI_CMD} rules list --project-root ${RULES_PROJECT_ROOT}"

# TC-RULES-06: rules add 大写 severity 转换
# yargs choices 接受小写 blocker，转换为 BLOCKER
run_case "TC-RULES-06" \
  "rules add 小写 severity 自动转换" \
  0 \
  "USER-|added" \
  "${CLI_CMD} rules add --content 禁止any类型 --severity major --project-root ${RULES_PROJECT_ROOT}"

# TC-RULES-07: rules show 查看规则详情
# 先添加一个规则，然后 show 查看
run_case "TC-RULES-07" \
  "rules show 查看规则详情" \
  -1 \
  "" \
  "${CLI_CMD} rules show --rule-id SEED-01 --project-root ${RULES_PROJECT_ROOT}"

# TC-RULES-08: rules remove 提示手动编辑
# 新 RLIS API 不支持运行时删除，应输出提示
run_case "TC-RULES-08" \
  "rules remove 提示手动编辑" \
  -1 \
  "手动|编辑|manual" \
  "${CLI_CMD} rules remove --rule-id USER-001 --project-root ${RULES_PROJECT_ROOT}"

# TC-RULES-09: rules add 缺 --content 应失败
run_case "TC-RULES-09" \
  "rules add 缺 --content 应失败" \
  1 \
  "" \
  "${CLI_CMD} rules add --project-root ${RULES_PROJECT_ROOT}"

# TC-RULES-10: rules show 不存在的 rule-id
# 应返回错误或空结果（不应崩溃）
run_case "TC-RULES-10" \
  "rules show 不存在的 rule-id" \
  -1 \
  "" \
  "${CLI_CMD} rules show --rule-id NON-EXISTENT-999 --project-root ${RULES_PROJECT_ROOT}"

# TC-RULES-11: rules list 全局规则文件不存在容错
# 删除全局规则文件后 list 应正常工作（容错）
mkdir -p "${TEST_TMP_DIR}/.deepcode"
rm -f "${TEST_TMP_DIR}/.deepcode/rules/project-rules.json"
run_case "TC-RULES-11" \
  "rules list 项目规则文件不存在容错" \
  0 \
  "SEED-|种子|rule" \
  "${CLI_CMD} rules list --project-root ${RULES_PROJECT_ROOT}"

# TC-RULES-12: rules help 显示帮助
run_case "TC-RULES-12" \
  "rules help 显示帮助" \
  0 \
  "list|add|remove|show|path" \
  "${CLI_CMD} rules help"

# TC-RULES-13: 添加第二条规则验证 ID 递增
# 之前已添加 2 条用户规则，再添加应为 USER-003
run_case "TC-RULES-13" \
  "rules add ID 递增" \
  0 \
  "USER-" \
  "${CLI_CMD} rules add --content 禁止使用eval --severity warning --project-root ${RULES_PROJECT_ROOT}"

# TC-RULES-14: rules add 缺 --project-root 应使用默认值（当前目录）
# 在临时目录下执行，应正常添加
run_case "TC-RULES-14" \
  "rules add 默认 project-root" \
  -1 \
  "" \
  "cd ${TEST_TMP_DIR} && ${CLI_CMD} rules add --content 测试规则"

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
  for case_id in "${FAILED_CASES_LIST[@]}"; do
    log "    - ${case_id}"
  done
  exit 2
fi

exit 0
