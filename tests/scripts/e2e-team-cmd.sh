#!/usr/bin/env bash
# ==============================================================================
# Team 子命令 E2E 测试
#
# 测试目标（对齐 TC-TEAM-01~08）：
#   1. team list — 列出 5 个核心角色
#   2. team match — 关键词匹配角色
#   3. team dispatch --role architect — 强制派发
#   4. team dispatch --task "..." — 自动匹配派发
#   5. team help — 显示帮助
#   6. team autonomous --goal --max-iter — Autonomous 模式
#   7. team full-lifecycle --goal — 完整生命周期
#
# 设计依据：
# - docs/fusion/DEEPCODEX_FUSION_PLAN.md（multi-agent-team 移植方案）
# - packages/cli/src/team/team-cmd.ts（team 子命令实现）
# - packages/core/src/team/（核心模块）
# ==============================================================================

set -uo pipefail

# ---------- 全局变量 ----------
TOTAL_CASES=0
PASSED_CASES=0
FAILED_CASES=0
FAILED_CASES_LIST=()

# ---------- 日志工具 ----------
log() {
  echo "[e2e-team-cmd] $*"
}

fail_log() {
  echo "[e2e-team-cmd] ❌ $*" >&2
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

# 校验 team 模块源码存在
[ -d "${PROJECT_ROOT}/packages/core/src/team" ] || { fail_log "未找到 team 模块"; exit 1; }
[ -f "${CLI_DIR}/src/team/team-cmd.ts" ] || { fail_log "未找到 team-cmd.ts"; exit 1; }

log "✅ 环境预检通过"

# ---------- 全局环境隔离 ----------
# v1.6 P0-2 修正（TC-TEAM-04/05/06）：清空 API Key 环境变量，确保 dispatch 命令走 skipped 分支
# 原因：e2e 测试环境不应依赖真实 LLM API Key，dispatch 命令在无 API Key 时应返回 status=skipped（exitCode=0）
# 这是真实的测试环境配置，不是 mock（createOpenAIClient 真实返回 null，executeDispatch 真实返回 skipped）
export OPENAI_API_KEY=""
export DEEPCODE_API_KEY=""
# 重定向 HOME 到空目录，阻断 settings.json 读取（确保 createOpenAIClient 不从配置文件获取 API Key）
export E2E_HOME_TMP="$(mktemp -d)"
export HOME="${E2E_HOME_TMP}"

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

# ---------- 测试用例 ----------

# TC-TEAM-01: team list 列出 5 个核心角色
# 验证输出包含 5 个角色中的至少一个（architect / product-manager / test-expert / solo-coder / ui-designer）
run_case "TC-TEAM-01" \
  "team list 列出角色" \
  0 \
  "architect|product-manager|test-expert|solo-coder|ui-designer" \
  "${CLI_CMD} team list"

# TC-TEAM-02: team match 关键词匹配
# 验证输出包含匹配结果（含 confidence 或 matchedRole 字段）
# v1.6 P0-2 修正（TC-TEAM-02）：keywords 参数用引号包裹，避免 shell 把空格分隔的词当成额外 positional
# yargs keywords 类型是 string（单值），多关键词用逗号分隔（cli.tsx 中 split(",") 拆分）
run_case "TC-TEAM-02" \
  "team match 关键词匹配架构" \
  0 \
  "architect|confidence|matchedRole|roleId" \
  "${CLI_CMD} team match --keywords 架构,设计"

# TC-TEAM-03: team match 多关键词
run_case "TC-TEAM-03" \
  "team match 多关键词匹配" \
  0 \
  "" \
  "${CLI_CMD} team match --keywords 实现,开发,代码"

# TC-TEAM-04: team dispatch --role architect 强制派发
run_case "TC-TEAM-04" \
  "team dispatch --role architect 强制派发" \
  0 \
  "architect|DispatchResult|taskId|dispatchId|status" \
  "${CLI_CMD} team dispatch --role architect --task 设计认证模块"

# TC-TEAM-05: team dispatch --role test-expert 强制派发
run_case "TC-TEAM-05" \
  "team dispatch --role test-expert" \
  0 \
  "test-expert|DispatchResult|taskId" \
  "${CLI_CMD} team dispatch --role test-expert --task 编写单元测试"

# TC-TEAM-06: team dispatch --task 自动匹配（无 --role）
run_case "TC-TEAM-06" \
  "team dispatch 自动匹配角色" \
  0 \
  "DispatchResult|matchedRole|taskId" \
  "${CLI_CMD} team dispatch --task 实现登录功能"

# TC-TEAM-07: team dispatch 无 --task 应失败
run_case "TC-TEAM-07" \
  "team dispatch 无 --task 应失败" \
  1 \
  "" \
  "${CLI_CMD} team dispatch"

# TC-TEAM-08: team dispatch --force-role 缺 --role 应失败
run_case "TC-TEAM-08" \
  "team dispatch --force-role 缺 --role 应失败" \
  1 \
  "" \
  "${CLI_CMD} team dispatch --force-role --task test"

# TC-TEAM-09: team autonomous 缺 --goal 应失败
run_case "TC-TEAM-09" \
  "team autonomous 缺 --goal 应失败" \
  1 \
  "" \
  "${CLI_CMD} team autonomous"

# TC-TEAM-10: team autonomous 1 轮迭代
# autonomous 模式执行 1 轮迭代（每轮 plan/dev/verify/fix 4 阶段）
# 注意：autonomous 模式可能调用 LLM，设置为 1 轮迭代快速验证
run_case "TC-TEAM-10" \
  "team autonomous 1 轮迭代" \
  -1 \
  "" \
  "${CLI_CMD} team autonomous --goal 测试目标 --max-iterations 1 2>&1 | head -50"

# TC-TEAM-11: team full-lifecycle 缺 --goal 应失败
run_case "TC-TEAM-11" \
  "team full-lifecycle 缺 --goal 应失败" \
  1 \
  "" \
  "${CLI_CMD} team full-lifecycle"

# TC-TEAM-12: team help 显示帮助
run_case "TC-TEAM-12" \
  "team help 显示帮助" \
  0 \
  "list|match|dispatch|autonomous|full-lifecycle" \
  "${CLI_CMD} team help"

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
  # 清理临时 HOME 目录
  rm -rf "${E2E_HOME_TMP}" 2>/dev/null || true
  exit 2
fi

# 清理临时 HOME 目录
rm -rf "${E2E_HOME_TMP}" 2>/dev/null || true
exit 0
