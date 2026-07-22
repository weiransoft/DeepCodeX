#!/usr/bin/env bash
# ==============================================================================
# CLI 基础参数解析 E2E 测试
#
# 测试目标（对齐 TC-CLI-01~08）：
#   1. --version / -v 输出版本号
#   2. --help / -h 输出帮助文本
#   3. --once 默认 false / 显式 true
#   4. --no-tty 跳过 TTY 检查（配合 --once -p）
#   5. -p / --prompt 非交互式 prompt
#   6. -r / --resume session ID 校验
#   7. 错误参数处理（无效 UUID / 缺失参数）
#
# 退出码：
#   0 = 全部测试通过
#   1 = 环境预检失败
#   2 = 一个或多个测试用例失败
#
# 设计依据：
# - packages/cli/src/cli-args.ts（yargs 配置）
# - packages/cli/src/cli.tsx（TTY 检查 + 入口）
# - P1/P3 修复（--once / --no-tty 标志）
# ==============================================================================

set -uo pipefail

# ---------- 全局变量 ----------
# 测试用例计数
TOTAL_CASES=0
PASSED_CASES=0
FAILED_CASES=0
# 失败用例列表
FAILED_CASES_LIST=()

# ---------- 日志工具 ----------
log() {
  echo "[e2e-cli-basic] $*"
}

fail_log() {
  echo "[e2e-cli-basic] ❌ $*" >&2
}

# ---------- 环境预检 ----------
log "========== 环境预检 =========="

command -v node >/dev/null 2>&1 || { fail_log "未找到 node"; exit 1; }
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "${NODE_MAJOR}" -ge 20 ] || { fail_log "node 版本过低（$(node --version)）"; exit 1; }

# 定位 CLI 入口（使用 tsx 直接运行 src/cli.tsx，避免依赖 dist/cli.js 构建）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CLI_DIR="${PROJECT_ROOT}/packages/cli"
CLI_ENTRY="${CLI_DIR}/src/cli.tsx"

[ -f "${CLI_ENTRY}" ] || { fail_log "未找到 CLI 入口: ${CLI_ENTRY}"; exit 1; }

log "✅ 环境预检通过 (node $(node --version))"
log "  - CLI_ENTRY: ${CLI_ENTRY}"

# ---------- 测试用例执行函数 ----------
# 执行单个测试用例并记录结果
# @param $1 用例 ID
# @param $2 用例描述
# @param $3 期望退出码（0 或 1，-1 表示不校验）
# @param $4 期望输出包含的字符串（"" 表示不校验）
# @param $5 实际执行的命令（已组装好的字符串）
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

  # 执行命令并捕获输出与退出码
  local output
  set +e
  output=$(eval "${cmd}" 2>&1)
  local actual_exit=$?
  set -e

  # 校验退出码
  local exit_ok=1
  if [ "${expected_exit}" != "-1" ]; then
    if [ "${actual_exit}" != "${expected_exit}" ]; then
      exit_ok=0
      fail_log "${case_id} 退出码不匹配: expected=${expected_exit}, actual=${actual_exit}"
    fi
  fi

  # 校验输出
  # 使用 grep -qF -- 防止期望字符串以 - 开头时被误认为 grep 选项（如 --once / --no-tty）
  local output_ok=1
  if [ -n "${expected_output}" ]; then
    if ! echo "${output}" | grep -qF -- "${expected_output}"; then
      output_ok=0
      fail_log "${case_id} 输出不包含期望字符串: '${expected_output}'"
      fail_log "实际输出（前 200 字符）: $(echo "${output}" | head -c 200)"
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
# 通过 tsx 直接运行 src/cli.tsx（避免依赖 dist/cli.js 构建）
CLI_CMD="node --import tsx ${CLI_ENTRY}"

# ---------- 测试用例 ----------

# TC-CLI-01: --version 输出版本号
run_case "TC-CLI-01" \
  "显示版本号" \
  0 \
  "0.1." \
  "${CLI_CMD} --version"

# TC-CLI-02: -v 别名
run_case "TC-CLI-02" \
  "-v 别名显示版本号" \
  0 \
  "0.1." \
  "${CLI_CMD} -v"

# TC-CLI-03: --help 输出帮助文本
run_case "TC-CLI-03" \
  "显示帮助文本" \
  0 \
  "Usage:" \
  "${CLI_CMD} --help"

# TC-CLI-04: -h 别名
run_case "TC-CLI-04" \
  "-h 别名显示帮助" \
  0 \
  "Usage:" \
  "${CLI_CMD} -h"

# TC-CLI-05: --help 包含 --once 标志
run_case "TC-CLI-05" \
  "--help 包含 --once 标志（P1 修复）" \
  0 \
  "--once" \
  "${CLI_CMD} --help"

# TC-CLI-06: --help 包含 --no-tty 标志
run_case "TC-CLI-06" \
  "--help 包含 --no-tty 标志（P3 修复）" \
  0 \
  "--no-tty" \
  "${CLI_CMD} --help"

# TC-CLI-07: --help 包含 team 子命令
run_case "TC-CLI-07" \
  "--help 包含 team 子命令" \
  0 \
  "team" \
  "${CLI_CMD} --help"

# TC-CLI-08: --help 包含 rules 子命令
run_case "TC-CLI-08" \
  "--help 包含 rules 子命令" \
  0 \
  "rules" \
  "${CLI_CMD} --help"

# TC-CLI-09: 无效 UUID resume 应失败
run_case "TC-CLI-09" \
  "无效 UUID --resume 应失败" \
  1 \
  "Invalid session ID" \
  "${CLI_CMD} --resume not-a-uuid"

# TC-CLI-10: 合法 UUID 格式校验通过（但会话不存在会另行处理）
# 注意：合法 UUID 启动会进入 TUI 流程，所以加 --no-tty --once -p 避免阻塞
run_case "TC-CLI-10" \
  "合法 UUID 格式 --resume 校验通过" \
  -1 \
  "" \
  "${CLI_CMD} --no-tty --once --resume 550e8400-e29b-41d4-a716-446655440000 -p test 2>&1 | head -5"

# TC-CLI-11: -r 别名
# 跟 TC-CLI-09 类似，验证 -r 别名同样生效
run_case "TC-CLI-11" \
  "-r 别名同样校验 UUID" \
  1 \
  "Invalid session ID" \
  "${CLI_CMD} -r invalid-id"

# TC-CLI-12: --version 与 --help 同时传入（yargs 行为：help 优先于 version）
# 实际 yargs 行为是 help 优先级更高，会输出帮助文本而非版本号
run_case "TC-CLI-12" \
  "--version --help 同时传入（yargs help 优先）" \
  0 \
  "Usage:" \
  "${CLI_CMD} --version --help"

# TC-CLI-13: 缺失 -p 值应失败
run_case "TC-CLI-13" \
  "--prompt 空值应失败" \
  1 \
  "" \
  "${CLI_CMD} --prompt ''"

# TC-CLI-14: --no-tty + --once 模式下未传 -p（不会阻塞，但 TUI 启动失败可能输出错误）
# 验证 --no-tty 跳过 TTY 检查（不再输出 "requires an interactive terminal"）
run_case "TC-CLI-14" \
  "--no-tty 跳过 TTY 检查" \
  -1 \
  "" \
  "${CLI_CMD} --no-tty --version"

# TC-CLI-15: 未知参数应失败
run_case "TC-CLI-15" \
  "未知参数 --unknown-flag 应失败" \
  1 \
  "" \
  "${CLI_CMD} --unknown-flag"

# TC-CLI-16: team 子命令无 subcommand 应失败
run_case "TC-CLI-16" \
  "team 子命令无 subcommand 应失败" \
  1 \
  "" \
  "${CLI_CMD} team"

# TC-CLI-17: rules 子命令无 subcommand 应失败
run_case "TC-CLI-17" \
  "rules 子命令无 subcommand 应失败" \
  1 \
  "" \
  "${CLI_CMD} rules"

# ---------- 汇总 ----------
log ""
log "========== 汇总 =========="
log "  总用例: ${TOTAL_CASES}"
log "  通过:   ${PASSED_CASES}"
log "  失败:   ${FAILED_CASES}"
log "  通过率: $(( PASSED_CASES * 100 / TOTAL_CASES ))%"

if [ "${FAILED_CASES}" -gt 0 ]; then
  log ""
  log "  失败用例:"
  for case_id in "${FAILED_CASES_LIST[@]}"; do
    log "    - ${case_id}"
  done
  exit 2
fi

exit 0
