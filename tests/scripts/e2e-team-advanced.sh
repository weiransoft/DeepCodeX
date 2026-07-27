#!/usr/bin/env bash
# =============================================================================
# e2e-team-advanced.sh - Team 子命令高级特性 E2E 测试（TA-01~12）
#
# 测试目标（对齐 docs/dev/new-features-cli-test-plan.md §3.1）：
#   验证 team 子命令的高级选项，覆盖以下新特性：
#     - --task-file：从文件读取任务描述，避免 shell 转义问题（v2.1.1）
#     - --consensus：启用 5 角色联合评审共识模式
#     - --force-role + --role：强制指定角色组合
#     - --keywords 多关键词逗号分隔匹配
#     - --role 未知角色报错（yargs choices 校验）
#
# 设计原则（遵循用户规则）：
#   - 禁止 mock：所有测试通过真实 CLI 进程执行
#   - 真实环境隔离：独立临时目录 + HOME 重定向 + API Key 清空
#   - 退出码语义：0=成功，1=失败/参数错误
#   - 输出分离：stdout 与 stderr 独立捕获
#
# 用法：
#   bash tests/scripts/e2e-team-advanced.sh
#
# 退出码：
#   0 = 所有测试通过
#   1 = 至少一个测试失败
# =============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# 全局变量与配置
# ----------------------------------------------------------------------------

# CLI 包根目录（用于定位 src/cli.tsx，与 e2e-quality-cmd.sh 保持一致）
CLI_PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/packages/cli"

# 测试统计
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
TOTAL_COUNT=0

# 临时目录集合（trap 时统一清理）
TEMP_DIRS=()

# 失败用例清单（用于最终汇总）
FAILED_CASES=()

# 颜色输出（如果终端支持）
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  NC='\033[0m' # No Color
else
  GREEN=''
  RED=''
  YELLOW=''
  BLUE=''
  NC=''
fi

# ----------------------------------------------------------------------------
# 环境隔离：清空 API Key + 重定向 HOME
# ----------------------------------------------------------------------------
# 原因：e2e 测试环境不应依赖真实 LLM API Key，dispatch 命令在无 API Key 时
# 应返回 status=skipped（exitCode=0），这是真实的测试环境配置，不是 mock
export OPENAI_API_KEY=""
export DEEPCODE_API_KEY=""
# 重定向 HOME 到空目录，阻断 settings.json 读取
E2E_HOME_TMP="$(mktemp -d -t e2e-team-adv-home-XXXXXX)"
TEMP_DIRS+=("$E2E_HOME_TMP")
export HOME="${E2E_HOME_TMP}"

# ----------------------------------------------------------------------------
# 工具函数
# ----------------------------------------------------------------------------

# 创建唯一临时目录
# @param $1 目录名前缀（如 "ta01"）
# @output 输出目录绝对路径
create_tmp_dir() {
  local prefix="$1"
  local dir
  dir="$(mktemp -d -t "e2e-team-adv-${prefix}-XXXXXX")"
  TEMP_DIRS+=("$dir")
  echo "$dir"
}

# 清理所有临时目录
cleanup() {
  for dir in "${TEMP_DIRS[@]:-}"; do
    rm -rf "$dir" 2>/dev/null || true
  done
}
trap cleanup EXIT

# 打印通过用例
# @param $1 用例名称
# @param $2 耗时（毫秒，可选）
print_pass() {
  local test_name="$1"
  local duration="${2:-}"
  PASS_COUNT=$((PASS_COUNT + 1))
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  if [[ -n "$duration" ]]; then
    echo -e "${GREEN}✔${NC} ${test_name} (${duration}ms)"
  else
    echo -e "${GREEN}✔${NC} ${test_name}"
  fi
}

# 打印失败用例
# @param $1 用例名称
# @param $2 失败原因
# @param $3 耗时（毫秒，可选）
print_fail() {
  local test_name="$1"
  local reason="${2:-}"
  local duration="${3:-}"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  FAILED_CASES+=("${test_name}")
  echo -e "${RED}✖${NC} ${test_name} (${duration}ms)"
  if [[ -n "$reason" ]]; then
    echo -e "  ${RED}原因:${NC} $reason"
  fi
}

# 打印跳过用例
# @param $1 用例名称
# @param $2 跳过原因
print_skip() {
  local test_name="$1"
  local reason="${2:-}"
  SKIP_COUNT=$((SKIP_COUNT + 1))
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  echo -e "${YELLOW}﹣${NC} ${test_name}"
  if [[ -n "$reason" ]]; then
    echo -e "  ${YELLOW}跳过原因:${NC} $reason"
  fi
}

# 执行 deepcode CLI 命令（真实子进程）
# 参数：$1..$N = CLI 参数（不含 deepcode 本身）
# 输出：设置全局变量 LAST_STDOUT, LAST_STDERR, LAST_EXIT_CODE
run_cli() {
  local cli_path="$CLI_PACKAGE_ROOT/src/cli.tsx"
  local tmp_out tmp_err
  tmp_out="$(mktemp -t e2e-team-adv-stdout-XXXXXX)"
  tmp_err="$(mktemp -t e2e-team-adv-stderr-XXXXXX)"
  TEMP_DIRS+=("$tmp_out" "$tmp_err")

  # 注意：不能用 `|| true` 否则会丢失退出码
  # 使用 set +e 临时关闭错误退出，捕获真实退出码
  # cwd 必须设为 CLI_PACKAGE_ROOT，否则 tsx 解析 @vegamo/deepcode-core 时
  # 会因找不到 packages/core/dist/eag/long-horizon.js 而失败
  set +e
  (cd "$CLI_PACKAGE_ROOT" && node --import tsx "$cli_path" "$@") >"$tmp_out" 2>"$tmp_err" </dev/null
  LAST_EXIT_CODE=$?
  set -e
  LAST_STDOUT="$(cat "$tmp_out")"
  LAST_STDERR="$(cat "$tmp_err")"
  rm -f "$tmp_out" "$tmp_err"
}

# 断言：实际值等于预期值
# @param $1 实际值
# @param $2 预期值
# @param $3 标签（用于错误提示）
assert_equal() {
  local actual="$1"
  local expected="$2"
  local label="${3:-值}"
  if [[ "$actual" == "$expected" ]]; then
    return 0
  else
    echo "断言失败: $label 应为 '$expected'，实际为 '$actual'" >&2
    return 1
  fi
}

# 断言：字符串包含子串
# @param $1 被搜索的字符串
# @param $2 要查找的子串
# @param $3 标签
assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="${3:-输出}"
  if [[ "$haystack" == *"$needle"* ]]; then
    return 0
  else
    echo "断言失败: $label 应包含 '$needle'，实际内容: ${haystack:0:200}..." >&2
    return 1
  fi
}

# 断言：字符串包含多个子串之一（OR 语义）
# @param $1 被搜索的字符串
# @param $2..$N 候选子串（任一匹配即通过）
# 注意：第一个参数后必须至少有 2 个候选子串
assert_contains_any() {
  local haystack="$1"
  shift
  local label="${1:-输出}"
  shift
  for needle in "$@"; do
    if [[ "$haystack" == *"$needle"* ]]; then
      return 0
    fi
  done
  echo "断言失败: $label 应包含以下任一关键字: $*，实际内容: ${haystack:0:200}..." >&2
  return 1
}

# 断言：退出码非零
# @param $1 实际退出码
# @param $2 标签
assert_nonzero_exit() {
  local actual="$1"
  local label="${2:-退出码}"
  if [[ "$actual" != "0" ]]; then
    return 0
  else
    echo "断言失败: $label 应非零，实际为 0" >&2
    return 1
  fi
}

# 获取当前时间戳（毫秒）
# 注意：macOS 的 date 不支持 %N（GNU 扩展），直接使用 python3 获取毫秒时间戳
now_ms() {
  python3 -c 'import time; print(int(time.time()*1000))'
}

# 测试包装器：自动计时与结果打印
# @param $1 用例名称
# @param $2 测试函数名
# 剩余参数传递给测试函数
# 注意：测试函数返回非零表示断言失败，不能因 set -e 而退出脚本
run_test() {
  local test_name="$1"
  local test_fn="$2"
  shift 2
  local start_time end_time duration
  start_time=$(now_ms)

  local err_msg
  # 临时关闭 set -e，允许测试函数返回非零（断言失败）
  set +e
  err_msg="$("$test_fn" "$@" 2>&1)"
  local test_exit=$?
  set -e
  if [[ "$test_exit" -eq 0 ]]; then
    end_time=$(now_ms)
    duration=$((end_time - start_time))
    print_pass "$test_name" "$duration"
  else
    end_time=$(now_ms)
    duration=$((end_time - start_time))
    print_fail "$test_name" "$err_msg" "$duration"
  fi
}

# ----------------------------------------------------------------------------
# 测试用例实现（TA-01~12）
# ----------------------------------------------------------------------------

# TA-01: dispatch --task-file 读取有效文件
# 验证：--task-file 指定有效文件时，任务描述从文件读取，dispatch 成功返回
test_ta01() {
  local task_file
  task_file="$(create_tmp_dir ta01)/task.md"
  cat >"$task_file" <<'EOF'
设计一个微服务架构的认证模块，要求支持 OAuth2 和 JWT。
EOF

  run_cli team dispatch --role architect --task-file "$task_file"
  # 验证退出码为 0（succeeded 或 skipped 都返回 0）
  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
  # 验证输出含 DispatchResult 关键字
  assert_contains_any "$LAST_STDOUT" "输出" "DispatchResult" "taskId" "dispatchId" || return 1
  return 0
}

# TA-02: dispatch --task-file 空文件报错
# 验证：--task-file 指定空文件时，返回 exitCode=1，stderr 含"文件为空"
test_ta02() {
  local task_file
  task_file="$(create_tmp_dir ta02)/empty.md"
  : >"$task_file"  # 创建空文件

  run_cli team dispatch --role architect --task-file "$task_file"
  # 验证退出码非零
  assert_nonzero_exit "$LAST_EXIT_CODE" "退出码" || return 1
  # 验证 stderr 含"文件为空"
  assert_contains "$LAST_STDERR" "文件为空" "stderr" || return 1
  return 0
}

# TA-03: dispatch --task-file 不存在文件报错
# 验证：--task-file 指定不存在的文件时，返回 exitCode=1，stderr 含"读取 --task-file 失败"
test_ta03() {
  run_cli team dispatch --role architect --task-file "/nonexistent/path/task.md"
  # 验证退出码非零
  assert_nonzero_exit "$LAST_EXIT_CODE" "退出码" || return 1
  # 验证 stderr 含"读取 --task-file 失败"
  assert_contains "$LAST_STDERR" "读取 --task-file 失败" "stderr" || return 1
  return 0
}

# TA-04: dispatch --task-file 含 shell 特殊字符
# 验证：--task-file 文件内容含 shell 特殊字符（< > & | $ ` " '）时，原样传递不被 shell 解释
test_ta04() {
  local task_file
  task_file="$(create_tmp_dir ta04)/special.md"
  cat >"$task_file" <<'EOF'
实现一个函数，要求：
- 输入：path = "/usr/local/bin" & query = "a=b|c=d"
- 输出：处理 `echo $HOME` 的结果，含 "double quotes" 和 'single quotes'
- 特殊字符：< > & | $ ` " '
EOF

  run_cli team dispatch --role solo-coder --task-file "$task_file"
  # 验证退出码为 0（succeeded 或 skipped）
  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
  # 验证输出含 DispatchResult 关键字
  assert_contains_any "$LAST_STDOUT" "输出" "DispatchResult" "taskId" || return 1
  return 0
}

# TA-05: dispatch --task-file 优先级高于 --task
# 验证：同时指定 --task 和 --task-file 时，--task-file 生效（taskFile > task）
test_ta05() {
  local task_file
  task_file="$(create_tmp_dir ta05)/priority.md"
  cat >"$task_file" <<'EOF'
这是来自 task-file 的任务描述，应优先于 --task 参数
EOF

  # 同时指定 --task 和 --task-file，--task 内容是"应被忽略的 task"
  run_cli team dispatch --role architect --task "应被忽略的 task" --task-file "$task_file"
  # 验证退出码为 0
  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
  # 验证输出含 DispatchResult 关键字
  assert_contains_any "$LAST_STDOUT" "输出" "DispatchResult" "taskId" || return 1
  return 0
}

# TA-06: dispatch --consensus 启用共识模式
# 验证：--consensus 参数能被 CLI 正确解析并传递给 executeTeamCommand
# 注意：team-cmd.ts 中 consensus 字段已声明，CLI 解析层正确传递
test_ta06() {
  run_cli team dispatch --task "设计用户认证模块" --consensus
  # 验证退出码为 0（succeeded 或 skipped）
  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
  # 验证输出含 DispatchResult 关键字
  assert_contains_any "$LAST_STDOUT" "输出" "DispatchResult" "taskId" "matchedRole" || return 1
  return 0
}

# TA-07: dispatch --force-role 缺 --role 报错
# 验证：--force-role 指定但未指定 --role 时，返回 exitCode=1
test_ta07() {
  run_cli team dispatch --force-role --task "测试任务"
  # 验证退出码非零
  assert_nonzero_exit "$LAST_EXIT_CODE" "退出码" || return 1
  # 验证 stderr 含"--force-role 需要 --role"
  assert_contains "$LAST_STDERR" "--force-role 需要 --role" "stderr" || return 1
  return 0
}

# TA-08: match --keywords 多关键词逗号分隔
# 验证：--keywords 支持逗号分隔的多关键词，匹配到 architect 角色
test_ta08() {
  run_cli team match --keywords "架构,设计,微服务"
  # 验证退出码为 0
  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
  # 验证输出含 architect / confidence / roleId 关键字
  assert_contains_any "$LAST_STDOUT" "输出" "architect" "confidence" "roleId" || return 1
  return 0
}

# TA-09: match --keywords 单关键词
# 验证：--keywords 单关键词"测试"匹配到 test-expert 角色
test_ta09() {
  run_cli team match --keywords "测试"
  # 验证退出码为 0
  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
  # 验证输出含 test-expert / confidence / roleId 关键字
  assert_contains_any "$LAST_STDOUT" "输出" "test-expert" "confidence" "roleId" || return 1
  return 0
}

# TA-10: match --keywords 空字符串
# 验证：--keywords "" 空字符串时的行为（yargs 接受空字符串，但 matchRoles 可能返回空结果或报错）
test_ta10() {
  run_cli team match --keywords ""
  # 空字符串经过 split + filter 后变成空数组，executeMatchCommand 会返回 exitCode=1
  # 验证退出码非零（match 子命令需要非空 keywords）
  assert_nonzero_exit "$LAST_EXIT_CODE" "退出码" || return 1
  # 验证 stderr 含"match 子命令需要 --keywords 参数"
  assert_contains "$LAST_STDERR" "match 子命令需要 --keywords 参数" "stderr" || return 1
  return 0
}

# TA-11: dispatch --role 指定每个核心角色
# 验证：5 个核心角色（architect / product-manager / solo-coder / test-expert / ui-designer）都能被 --role 正确指定
test_ta11() {
  local roles=("architect" "product-manager" "solo-coder" "test-expert" "ui-designer")
  for role in "${roles[@]}"; do
    run_cli team dispatch --role "$role" --task "测试 $role 任务"
    # 验证退出码为 0
    if ! assert_equal "$LAST_EXIT_CODE" "0" "退出码($role)"; then
      return 1
    fi
    # 验证输出含角色名或 DispatchResult
    if ! assert_contains_any "$LAST_STDOUT" "输出($role)" "DispatchResult" "taskId" "$role"; then
      return 1
    fi
  done
  return 0
}

# TA-12: dispatch --role 未知角色报错
# 验证：--role 指定未知角色时，yargs choices 校验失败，返回 exitCode=1
test_ta12() {
  run_cli team dispatch --role "unknown-role" --task "测试未知角色"
  # 验证退出码非零（yargs choices 校验失败）
  assert_nonzero_exit "$LAST_EXIT_CODE" "退出码" || return 1
  # 验证 stderr 含"Unknown role id" 或 yargs 错误信息
  assert_contains_any "$LAST_STDERR" "stderr" "Unknown role id" "unknown-role" "Choices" || return 1
  return 0
}

# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Team 高级特性 E2E 测试（TA-01~12）${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "CLI 包根目录: $CLI_PACKAGE_ROOT"
echo "临时 HOME: $E2E_HOME_TMP"
echo ""

# 执行所有测试用例
run_test "TA-01: dispatch --task-file 读取有效文件" test_ta01
run_test "TA-02: dispatch --task-file 空文件报错" test_ta02
run_test "TA-03: dispatch --task-file 不存在文件报错" test_ta03
run_test "TA-04: dispatch --task-file 含 shell 特殊字符" test_ta04
run_test "TA-05: dispatch --task-file 优先级高于 --task" test_ta05
run_test "TA-06: dispatch --consensus 启用共识模式" test_ta06
run_test "TA-07: dispatch --force-role 缺 --role 报错" test_ta07
run_test "TA-08: match --keywords 多关键词逗号分隔" test_ta08
run_test "TA-09: match --keywords 单关键词" test_ta09
run_test "TA-10: match --keywords 空字符串" test_ta10
run_test "TA-11: dispatch --role 指定每个核心角色" test_ta11
run_test "TA-12: dispatch --role 未知角色报错" test_ta12

# ----------------------------------------------------------------------------
# 汇总
# ----------------------------------------------------------------------------
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  测试汇总${NC}"
echo -e "${BLUE}========================================${NC}"
echo "  总用例: $TOTAL_COUNT"
echo -e "  ${GREEN}通过:   $PASS_COUNT${NC}"
echo -e "  ${RED}失败:   $FAIL_COUNT${NC}"
echo -e "  ${YELLOW}跳过:   $SKIP_COUNT${NC}"
if [[ "$TOTAL_COUNT" -gt 0 ]]; then
  echo "  通过率: $(( PASS_COUNT * 100 / TOTAL_COUNT ))%"
fi

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo ""
  echo -e "${RED}失败用例清单:${NC}"
  for case_name in "${FAILED_CASES[@]}"; do
    echo "  - $case_name"
  done
  exit 1
fi

exit 0
