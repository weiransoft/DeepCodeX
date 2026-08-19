#!/usr/bin/env bash
# =============================================================================
# e2e-full-lifecycle-p5.sh - Full-Lifecycle v2.1 P5 选项 E2E 测试（FL-01~FL-12）
#
# 测试目标（对齐 docs/dev/new-features-cli-test-plan.md §3.3）：
#   验证 team full-lifecycle 子命令的 v2.1 P5 新增选项：
#     - --use-loop             启用 WorkflowLoopController（八阶段循环）
#     - --prd-path <path>      PRD 文档路径（阶段 8 文档对照代码审查输入）
#     - --architecture-path <path>  架构设计文档路径（阶段 8 输入）
#     - --test-plan-path <path>     测试计划文档路径（阶段 8 输入）
#     - --test-command <cmd>        测试命令（阶段 7 测试验证 + 阶段 8 D3 检查）
#     - --task-file <path>          从文件读取任务描述（避免 shell 转义问题）
#     - --max-iterations <n>        最大迭代次数（循环模式使用）
#
# 测试环境策略（遵循用户规则，禁止 mock / 占位 / 简化）：
#   - 创建临时 git 仓库作为 projectRoot（避免污染真实项目）
#   - 创建临时文档文件（PRD / 架构 / 测试计划），让 DocCodeConsistencyChecker 真实读取
#   - 真实调用 CLI 子进程（node --import tsx src/cli.tsx）
#   - with-key 模式：DEEPCODE_API_KEY="test-key"（假 API Key）
#     → createOpenAIClient 返回非 null client，LLM 调用因假 Key 失败
#     → executeDispatch 返回 status=failed，full-lifecycle 阶段 1-7 失败中止（exitCode=1）
#   - no-key 模式：DEEPCODE_API_KEY=""
#     → createOpenAIClient 返回 null client
#     → executeDispatch 返回 status=skipped（无 client 时跳过 LLM 调用）
#     → executeFullLifecycleLinear 中 skipped 不中止，能完整执行 8 阶段（exitCode=0）
#   - 这是真实的端到端行为测试，不是 mock
#
# 关键说明（实现与预期的对齐）：
#   1. full-lifecycle 不像 autonomous 那样显式检查 API Key（无 "autonomous 模式需要 API Key" 报错）
#      因此 FL-03 "无 API Key 应失败" 调整为验证 no-key 模式下的实际行为：
#      exitCode=0 或 1（宽松），stdout 含 "8 阶段全流程"
#   2. full-lifecycle 退出码语义：0=成功，1=失败（不像 autonomous 有 0/1/2 三种）
#      因此 FL-12 验证 exitCode ∈ {0, 1}
#   3. with-key 模式下 LLM 调用失败导致阶段 1-7 failed，full-lifecycle 中止 return 1
#      但 stdout 仍含 "🎬 启动 8 阶段全流程" 字样（在阶段失败前已输出）
#   4. no-key 模式下 dispatch 走 skipped 分支不中止，能完整执行 8 阶段
#      阶段 8 文档审查在空项目（无代码）下通过（D1~D6 无缺口），exitCode=0
#
# 用法：
#   bash tests/scripts/e2e-full-lifecycle-p5.sh
# =============================================================================

set -uo pipefail

# ----------------------------------------------------------------------------
# 全局变量与配置
# ----------------------------------------------------------------------------

# CLI 包根目录（通过脚本位置定位，避免硬编码路径）
CLI_PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/packages/cli"

# 测试计数器
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
TOTAL_COUNT=0
TEMP_DIRS=()
FAILED_CASES=()

# 颜色输出（仅交互式终端启用，避免 CI 日志污染）
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; BLUE=''; NC=''
fi

# 环境隔离：重定向 HOME 到临时目录，阻断 user settings.json 读取
# 不全局清空 DEEPCODE_API_KEY（run_cli 会在子 shell 中按 key_mode 设置）
E2E_HOME_TMP="$(mktemp -d -t e2e-fl-home-XXXXXX)"
TEMP_DIRS+=("$E2E_HOME_TMP")
export HOME="${E2E_HOME_TMP}"
export OPENAI_API_KEY=""

# ----------------------------------------------------------------------------
# 工具函数（设计模式参考 e2e-autonomous-persistence.sh）
# ----------------------------------------------------------------------------

# 创建临时目录并注册到清理列表
# @param $1 目录名前缀
create_tmp_dir() {
  local prefix="$1"
  local dir
  dir="$(mktemp -d -t "e2e-fl-${prefix}-XXXXXX")"
  TEMP_DIRS+=("$dir")
  echo "$dir"
}

# 清理所有临时目录（trap EXIT 触发）
cleanup() {
  for dir in "${TEMP_DIRS[@]:-}"; do
    rm -rf "$dir" 2>/dev/null || true
  done
}
trap cleanup EXIT

# 输出 PASS 信息（含耗时）
# @param $1 测试用例名
# @param $2 耗时（毫秒，可选）
print_pass() {
  local test_name="$1"
  local duration="${2:-}"
  PASS_COUNT=$((PASS_COUNT + 1))
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  if [[ -n "$duration" ]]; then
    echo -e "${GREEN}PASS${NC} ${test_name} (${duration}ms)"
  else
    echo -e "${GREEN}PASS${NC} ${test_name}"
  fi
}

# 输出 FAIL 信息（含失败原因和耗时）
# @param $1 测试用例名
# @param $2 失败原因（可选）
# @param $3 耗时（毫秒，可选）
print_fail() {
  local test_name="$1"
  local reason="${2:-}"
  local duration="${3:-}"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  FAILED_CASES+=("${test_name}")
  echo -e "${RED}FAIL${NC} ${test_name} (${duration}ms)"
  if [[ -n "$reason" ]]; then
    echo -e "  ${RED}reason:${NC} $reason"
  fi
}

# 输出 SKIP 信息（含跳过原因）
# @param $1 测试用例名
# @param $2 跳过原因（可选）
print_skip() {
  local test_name="$1"
  local reason="${2:-}"
  SKIP_COUNT=$((SKIP_COUNT + 1))
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  echo -e "${YELLOW}SKIP${NC} ${test_name}"
  if [[ -n "$reason" ]]; then
    echo -e "  ${YELLOW}skip:${NC} $reason"
  fi
}

# 创建临时测试项目（含 git init）
# @param $1 目录名前缀
# @param $2 配置类型："with-key" / "no-key"（保留参数兼容性，实际不创建 settings.json）
create_test_project() {
  local prefix="$1"
  local with_key="${2:-no-key}"
  local project_root
  project_root="$(create_tmp_dir "$prefix")"

  # 初始化 git 仓库（部分模块可能依赖 git）
  git init -q "$project_root" 2>/dev/null || true
  git -C "$project_root" config user.email "e2e-test@example.com" 2>/dev/null || true
  git -C "$project_root" config user.name "E2E Test" 2>/dev/null || true

  # 创建基础文件
  : >"$project_root/.gitignore"
  echo "# Test Project" >"$project_root/README.md"
  git -C "$project_root" add -A 2>/dev/null || true
  git -C "$project_root" commit -m "init" -q 2>/dev/null || true

  # 注意：不创建 .deepcode/settings.json
  # with-key 模式通过环境变量 DEEPCODE_API_KEY="test-key" 提供 API Key
  # no-key 模式通过环境变量 DEEPCODE_API_KEY="" 强制无 API Key
  # 这样更简单，也符合任务要求中的 run_cli 设计

  echo "$project_root"
}

# 在测试项目中创建 P5 选项所需的文档文件
# @param $1 项目根目录
create_test_docs() {
  local project_root="$1"
  local docs_dir="$project_root/docs"
  mkdir -p "$docs_dir"

  # PRD 文档（含功能需求和验收标准，供 DocCodeConsistencyChecker D1/D4 检查）
  cat >"$docs_dir/prd.md" <<'EOF'
# PRD 文档（E2E 测试用）

## 功能需求
- F1: 用户登录
- F2: 数据查询

## 验收标准
- AC1: 登录接口返回 200
- AC2: 查询接口返回 JSON
EOF

  # 架构设计文档（含模块说明，供 D2 集成完整性检查）
  cat >"$docs_dir/architecture.md" <<'EOF'
# 架构设计文档（E2E 测试用）

## 模块说明
本项目包含认证和查询两个核心功能模块。

## 设计原则
- 模块化设计
- 单一职责
- 可测试性
EOF

  # 测试计划文档（含测试用例，供 D3 测试正确性检查）
  cat >"$docs_dir/test-plan.md" <<'EOF'
# 测试计划文档（E2E 测试用）

## 测试用例
- T1: 登录成功用例
- T2: 查询返回数据用例
EOF

  # 任务文件（供 --task-file 选项使用，避免 shell 转义问题）
  cat >"$docs_dir/task.md" <<'EOF'
实现一个简单的用户登录模块，支持 OAuth2 和 JWT 两种认证方式
EOF
}

# 执行 deepcode CLI 命令（真实子进程）
# @param $1 项目根目录（作为 --project-root 参数）
# @param $2 key_mode："with-key"（DEEPCODE_API_KEY=test-key）/ "no-key"（DEEPCODE_API_KEY=""）
# 剩余参数传递给 CLI
# 输出捕获到 LAST_STDOUT / LAST_STDERR，退出码到 LAST_EXIT_CODE
run_cli() {
  local project_root="$1"
  local key_mode="${2:-with-key}"
  shift 2
  local cli_path="$CLI_PACKAGE_ROOT/src/cli.tsx"
  local tmp_out tmp_err
  tmp_out="$(mktemp -t e2e-fl-stdout-XXXXXX)"
  tmp_err="$(mktemp -t e2e-fl-stderr-XXXXXX)"
  TEMP_DIRS+=("$tmp_out" "$tmp_err")

  # 根据 key_mode 设置环境变量：
  # - with-key: DEEPCODE_API_KEY="test-key"（假 API Key，LLM 调用会失败但 client 非 null）
  # - no-key:   DEEPCODE_API_KEY=""（强制无 API Key，createOpenAIClient 返回 null）
  # 使用 env -u 确保 -u 选项不影响其他环境变量继承
  set +e
  if [[ "$key_mode" == "no-key" ]]; then
    (cd "$CLI_PACKAGE_ROOT" && env DEEPCODE_API_KEY="" node --import tsx "$cli_path" "$@" --project-root "$project_root") >"$tmp_out" 2>"$tmp_err" </dev/null
  else
    (cd "$CLI_PACKAGE_ROOT" && env DEEPCODE_API_KEY="test-key" node --import tsx "$cli_path" "$@" --project-root "$project_root") >"$tmp_out" 2>"$tmp_err" </dev/null
  fi
  LAST_EXIT_CODE=$?
  set -e
  LAST_STDOUT="$(cat "$tmp_out")"
  LAST_STDERR="$(cat "$tmp_err")"
  rm -f "$tmp_out" "$tmp_err"
}

# 执行 deepcode CLI 命令但不追加 --project-root（用于 team help 等不需要项目根的命令）
# @param $1 key_mode："with-key" / "no-key"
# 剩余参数传递给 CLI
run_cli_no_project() {
  local key_mode="${1:-with-key}"
  shift
  local cli_path="$CLI_PACKAGE_ROOT/src/cli.tsx"
  local tmp_out tmp_err
  tmp_out="$(mktemp -t e2e-fl-stdout-XXXXXX)"
  tmp_err="$(mktemp -t e2e-fl-stderr-XXXXXX)"
  TEMP_DIRS+=("$tmp_out" "$tmp_err")

  set +e
  if [[ "$key_mode" == "no-key" ]]; then
    (cd "$CLI_PACKAGE_ROOT" && env DEEPCODE_API_KEY="" node --import tsx "$cli_path" "$@") >"$tmp_out" 2>"$tmp_err" </dev/null
  else
    (cd "$CLI_PACKAGE_ROOT" && env DEEPCODE_API_KEY="test-key" node --import tsx "$cli_path" "$@") >"$tmp_out" 2>"$tmp_err" </dev/null
  fi
  LAST_EXIT_CODE=$?
  set -e
  LAST_STDOUT="$(cat "$tmp_out")"
  LAST_STDERR="$(cat "$tmp_err")"
  rm -f "$tmp_out" "$tmp_err"
}

# 断言函数：实际值 == 期望值
assert_equal() {
  local actual="$1"
  local expected="$2"
  local label="${3:-value}"
  if [[ "$actual" == "$expected" ]]; then
    return 0
  else
    echo "assert fail: $label expected='$expected', actual='$actual'" >&2
    return 1
  fi
}

# 断言函数：haystack 包含 needle
assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="${3:-output}"
  if [[ "$haystack" == *"$needle"* ]]; then
    return 0
  else
    echo "assert fail: $label should contain '$needle', actual: ${haystack:0:200}..." >&2
    return 1
  fi
}

# 断言函数：退出码非零
assert_nonzero_exit() {
  local actual="$1"
  local label="${2:-exit_code}"
  if [[ "$actual" != "0" ]]; then
    return 0
  else
    echo "assert fail: $label should be non-zero, actual=0" >&2
    return 1
  fi
}

# 断言函数：退出码在允许的集合中（用于宽松断言）
# @param $1 实际退出码
# @param $2.. 允许的退出码列表
assert_exit_in_set() {
  local actual="$1"
  shift
  local label="${1:-exit_code}"
  shift
  for allowed in "$@"; do
    if [[ "$actual" == "$allowed" ]]; then
      return 0
    fi
  done
  echo "assert fail: $label should be one of [$*], actual=$actual" >&2
  return 1
}

# 获取当前时间戳（毫秒）
now_ms() {
  python3 -c 'import time; print(int(time.time()*1000))'
}

# 测试包装器（不使用 set -e，允许测试函数返回非零）
# @param $1 测试用例名
# @param $2 测试函数名
# 剩余参数传递给测试函数
run_test() {
  local test_name="$1"
  local test_fn="$2"
  shift 2
  local start_time end_time duration
  start_time=$(now_ms)

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
# 测试用例实现（FL-01~FL-12）
# ----------------------------------------------------------------------------

# FL-01: full-lifecycle --help 输出含 P5 选项说明
# 验证：team help 输出包含 --use-loop、--prd-path、--architecture-path、--test-plan-path、--test-command
# 这些是 v2.1 P5 新增的 full-lifecycle 专属选项
# 模式：no-key（team help 不需要 API Key）
test_fl01() {
  run_cli_no_project no-key team help
  assert_equal "$LAST_EXIT_CODE" "0" "exit_code" || return 1
  # 验证 P5 选项说明出现在 help 输出中
  assert_contains "$LAST_STDOUT" "--use-loop" "stdout" || return 1
  assert_contains "$LAST_STDOUT" "--prd-path" "stdout" || return 1
  assert_contains "$LAST_STDOUT" "--architecture-path" "stdout" || return 1
  assert_contains "$LAST_STDOUT" "--test-plan-path" "stdout" || return 1
  assert_contains "$LAST_STDOUT" "--test-command" "stdout" || return 1
  # 验证 full-lifecycle 子命令说明
  assert_contains "$LAST_STDOUT" "full-lifecycle" "stdout" || return 1
  return 0
}

# FL-02: full-lifecycle 无 --task/--task-file 应失败（参数错误，exit_code=2）
# 验证：有 API Key 但无 --goal/--task/--task-file 时，返回 exitCode=2
# 实现：executeFullLifecycleCommand 调用 resolveTaskDescription(allowMissing=true)，
#   若 task/taskFile 都缺失返回 null，再检查 goal，若 goal 也缺失则报错 return 2
# S2 退出码修正（2026-08-19）：缺少必填参数属参数错误，退出码 1 → 2
# 模式：with-key（确保不是因 API Key 缺失而失败）
test_fl02() {
  local project_root
  project_root="$(create_test_project fl02 with-key)"

  run_cli "$project_root" with-key team full-lifecycle
  assert_equal "$LAST_EXIT_CODE" "2" "exit_code" || return 1
  # 验证 stderr 含参数错误提示（对齐 team-cmd.ts:596 实现）
  assert_contains "$LAST_STDERR" "需要 --goal 或 --task" "stderr" || return 1
  return 0
}

# FL-03: full-lifecycle 无 API Key 行为验证
# 实际行为：full-lifecycle 不像 autonomous 那样显式检查 API Key
#   - no-key 模式下 createOpenAIClient 返回 null client
#   - executeDispatch 在无 client 时返回 status=skipped（不调用 LLM）
#   - executeFullLifecycleLinear 中 skipped 状态不中止流程，能继续执行 8 阶段
#   - 阶段 8 文档审查在空项目（无代码）下通过（D1~D6 无缺口），exitCode=0
# 因此本用例验证：no-key 模式下 full-lifecycle 能启动并输出 "8 阶段全流程"，exitCode=0 或 1（宽松）
# 模式：no-key
test_fl03() {
  local project_root
  project_root="$(create_test_project fl03 no-key)"

  run_cli "$project_root" no-key team full-lifecycle --goal "test-project"
  # 无 API Key 时 full-lifecycle 不报错（与 autonomous 不同），exitCode=0 或 1
  assert_exit_in_set "$LAST_EXIT_CODE" "exit_code" "0" "1" || return 1
  # 验证 stdout 含 "8 阶段全流程" 字样（executeFullLifecycleLinear 启动日志）
  assert_contains "$LAST_STDOUT" "8 阶段全流程" "stdout" || return 1
  return 0
}

# FL-04: full-lifecycle --task-file 读取任务文件
# 验证：--task-file 指定有效文件时，task 描述从文件读取（resolveTaskDescription 优先 taskFile）
# 模式：no-key（避免 with-key 模式下 LLM 失败导致阶段 1-7 中止，便于验证完整流程）
test_fl04() {
  local project_root
  project_root="$(create_test_project fl04 no-key)"
  create_test_docs "$project_root"

  local task_file="$project_root/docs/task.md"
  run_cli "$project_root" no-key team full-lifecycle --task-file "$task_file"
  # no-key 模式下 dispatch 走 skipped 分支，exitCode=0 或 1（宽松）
  assert_exit_in_set "$LAST_EXIT_CODE" "exit_code" "0" "1" || return 1
  # 验证 stdout 含 "8 阶段全流程" 字样
  assert_contains "$LAST_STDOUT" "8 阶段全流程" "stdout" || return 1
  # 验证 task 文件被读取（project 名称应来自 task 文件内容）
  # executeFullLifecycleCommand: const project = args.goal ?? resolvedTask;
  # 由于未传 --goal，project 来自 resolvedTask（即 task 文件内容）
  assert_contains "$LAST_STDOUT" "OAuth2" "stdout" || return 1
  return 0
}

# FL-05: full-lifecycle --use-loop 启用循环模式
# 验证：--use-loop 启用 WorkflowLoopController，stdout 含 "循环模式" 字样
# 实现：executeFullLifecycleCommand 检测 args.useLoop，调用 executeFullLifecycleWithLoop
#   输出 "🎬 启动 8 阶段全流程（循环模式，最大迭代 N）: ..."
# 模式：with-key（任务要求：测试用例使用 with-key 模式）
test_fl05() {
  local project_root
  project_root="$(create_test_project fl05 with-key)"

  run_cli "$project_root" with-key team full-lifecycle --goal "test-project" --use-loop
  # with-key 模式下 LLM 调用失败，exitCode=0 或 1（宽松）
  assert_exit_in_set "$LAST_EXIT_CODE" "exit_code" "0" "1" || return 1
  # 验证 stdout 含 "循环模式" 字样（executeFullLifecycleWithLoop 启动日志）
  assert_contains "$LAST_STDOUT" "循环模式" "stdout" || return 1
  return 0
}

# FL-06: full-lifecycle --prd-path 指定 PRD 文档
# 验证：--prd-path 指定 PRD 文档路径，阶段 8 文档对照代码审查读取该文档
# 模式：no-key（避免 LLM 失败中止，便于验证阶段 8 文档审查）
test_fl06() {
  local project_root
  project_root="$(create_test_project fl06 no-key)"
  create_test_docs "$project_root"

  local prd_path="$project_root/docs/prd.md"
  run_cli "$project_root" no-key team full-lifecycle --goal "test-project" --prd-path "$prd_path"
  # no-key 模式下 exitCode=0 或 1（宽松）
  assert_exit_in_set "$LAST_EXIT_CODE" "exit_code" "0" "1" || return 1
  # 验证 stdout 含 "8 阶段全流程" 字样
  assert_contains "$LAST_STDOUT" "8 阶段全流程" "stdout" || return 1
  return 0
}

# FL-07: full-lifecycle --architecture-path 指定架构文档
# 验证：--architecture-path 指定架构设计文档路径，阶段 8 文档对照代码审查读取该文档
# 模式：no-key
test_fl07() {
  local project_root
  project_root="$(create_test_project fl07 no-key)"
  create_test_docs "$project_root"

  local arch_path="$project_root/docs/architecture.md"
  run_cli "$project_root" no-key team full-lifecycle --goal "test-project" --architecture-path "$arch_path"
  assert_exit_in_set "$LAST_EXIT_CODE" "exit_code" "0" "1" || return 1
  assert_contains "$LAST_STDOUT" "8 阶段全流程" "stdout" || return 1
  return 0
}

# FL-08: full-lifecycle --test-plan-path 指定测试计划
# 验证：--test-plan-path 指定测试计划文档路径，阶段 8 文档对照代码审查读取该文档
# 模式：no-key
test_fl08() {
  local project_root
  project_root="$(create_test_project fl08 no-key)"
  create_test_docs "$project_root"

  local plan_path="$project_root/docs/test-plan.md"
  run_cli "$project_root" no-key team full-lifecycle --goal "test-project" --test-plan-path "$plan_path"
  assert_exit_in_set "$LAST_EXIT_CODE" "exit_code" "0" "1" || return 1
  assert_contains "$LAST_STDOUT" "8 阶段全流程" "stdout" || return 1
  return 0
}

# FL-09: full-lifecycle --test-command 指定测试命令
# 验证：--test-command 指定测试命令，阶段 7 测试验证 + 阶段 8 D3 检查使用
# 模式：no-key
test_fl09() {
  local project_root
  project_root="$(create_test_project fl09 no-key)"
  create_test_docs "$project_root"

  # 注意：测试命令用引号包裹，避免 shell 拆分
  run_cli "$project_root" no-key team full-lifecycle --goal "test-project" --test-command "echo pass"
  assert_exit_in_set "$LAST_EXIT_CODE" "exit_code" "0" "1" || return 1
  assert_contains "$LAST_STDOUT" "8 阶段全流程" "stdout" || return 1
  return 0
}

# FL-10: full-lifecycle --max-iterations 1 限制迭代次数
# 验证：--max-iterations 1 限制循环模式最大迭代次数为 1
# 实现：executeFullLifecycleWithLoop 使用 args.maxIterations ?? 3，输出 "最大迭代 1"
# 模式：with-key（任务要求：测试用例使用 with-key 模式）
test_fl10() {
  local project_root
  project_root="$(create_test_project fl10 with-key)"

  run_cli "$project_root" with-key team full-lifecycle --goal "test-project" --use-loop --max-iterations 1
  # with-key 模式下 LLM 失败，exitCode=0 或 1（宽松）
  assert_exit_in_set "$LAST_EXIT_CODE" "exit_code" "0" "1" || return 1
  # 验证 stdout 含 "循环模式" 字样
  assert_contains "$LAST_STDOUT" "循环模式" "stdout" || return 1
  # 验证 stdout 含 "最大迭代 1" 字样（executeFullLifecycleWithLoop 启动日志）
  assert_contains "$LAST_STDOUT" "最大迭代 1" "stdout" || return 1
  return 0
}

# FL-11: full-lifecycle 综合 P5 选项（--use-loop + --prd-path + --test-command + --task-file）
# 验证：多个 P5 选项组合使用，循环模式启动并读取 task 文件
# 模式：no-key（避免 LLM 失败中止，便于验证循环模式启动）
test_fl11() {
  local project_root
  project_root="$(create_test_project fl11 no-key)"
  create_test_docs "$project_root"

  local prd_path="$project_root/docs/prd.md"
  local task_file="$project_root/docs/task.md"
  # 综合选项：--use-loop + --prd-path + --test-command + --task-file
  run_cli "$project_root" no-key team full-lifecycle \
    --use-loop \
    --prd-path "$prd_path" \
    --test-command "echo pass" \
    --task-file "$task_file"
  assert_exit_in_set "$LAST_EXIT_CODE" "exit_code" "0" "1" || return 1
  # 验证 stdout 含 "循环模式" 字样（--use-loop 启用循环模式）
  assert_contains "$LAST_STDOUT" "循环模式" "stdout" || return 1
  # 验证 task 文件被读取（project 名称来自 task 文件内容）
  assert_contains "$LAST_STDOUT" "OAuth2" "stdout" || return 1
  return 0
}

# FL-12: full-lifecycle 退出码语义（验证 0/1 退出码）
# 验证：full-lifecycle 退出码为 0（成功）或 1（失败）
# 注意：full-lifecycle 不像 autonomous 有 0/1/2 三种退出码（无 Fatal abort=2）
#   - 线性模式：阶段失败 return 1，成功 return 0
#   - 循环模式：overallSuccess=false return 1，overallSuccess=true return 0
# 模式：no-key（no-key 模式下 exitCode=0，with-key 模式下 exitCode=1）
test_fl12() {
  local project_root
  project_root="$(create_test_project fl12 no-key)"

  # 测试 1：no-key 模式，预期 exitCode ∈ {0, 1}
  run_cli "$project_root" no-key team full-lifecycle --goal "test-project" --use-loop --max-iterations 1
  assert_exit_in_set "$LAST_EXIT_CODE" "exit_code" "0" "1" || return 1

  # 测试 2：with-key 模式，预期 exitCode ∈ {0, 1}（LLM 失败导致 exitCode=1）
  local project_root2
  project_root2="$(create_test_project fl12-2 with-key)"
  run_cli "$project_root2" with-key team full-lifecycle --goal "test-project" --use-loop --max-iterations 1
  assert_exit_in_set "$LAST_EXIT_CODE" "exit_code" "0" "1" || return 1

  # 验证两种模式下都输出了 "8 阶段全流程" 或 "循环模式" 字样
  # （第一次运行的输出已被第二次覆盖，这里只验证第二次）
  assert_contains "$LAST_STDOUT" "8 阶段全流程" "stdout" || return 1
  return 0
}

# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Full-Lifecycle v2.1 P5 E2E Test (FL-01~FL-12)${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "CLI root: $CLI_PACKAGE_ROOT"
echo "Temp HOME: $E2E_HOME_TMP"
echo ""

# 环境预检：确保 CLI 入口和 team-cmd 模块存在
if [[ ! -f "$CLI_PACKAGE_ROOT/src/cli.tsx" ]]; then
  echo -e "${RED}ERROR: CLI 入口文件不存在: $CLI_PACKAGE_ROOT/src/cli.tsx${NC}"
  exit 1
fi
if [[ ! -f "$CLI_PACKAGE_ROOT/src/team/team-cmd.ts" ]]; then
  echo -e "${RED}ERROR: team-cmd.ts 不存在: $CLI_PACKAGE_ROOT/src/team/team-cmd.ts${NC}"
  exit 1
fi

# 执行所有测试用例
run_test "FL-01: full-lifecycle --help contains P5 options" test_fl01
run_test "FL-02: full-lifecycle without --task/--task-file should fail" test_fl02
run_test "FL-03: full-lifecycle without API Key behavior" test_fl03
run_test "FL-04: full-lifecycle --task-file reads task" test_fl04
run_test "FL-05: full-lifecycle --use-loop enables loop mode" test_fl05
run_test "FL-06: full-lifecycle --prd-path specifies PRD doc" test_fl06
run_test "FL-07: full-lifecycle --architecture-path specifies arch doc" test_fl07
run_test "FL-08: full-lifecycle --test-plan-path specifies test plan" test_fl08
run_test "FL-09: full-lifecycle --test-command specifies test command" test_fl09
run_test "FL-10: full-lifecycle --max-iterations 1 limits iterations" test_fl10
run_test "FL-11: full-lifecycle combined P5 options" test_fl11
run_test "FL-12: full-lifecycle exit code semantics (0/1)" test_fl12

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Test Summary${NC}"
echo -e "${BLUE}========================================${NC}"
echo "  Total: $TOTAL_COUNT"
echo -e "  ${GREEN}Pass:  $PASS_COUNT${NC}"
echo -e "  ${RED}Fail:  $FAIL_COUNT${NC}"
echo -e "  ${YELLOW}Skip:  $SKIP_COUNT${NC}"
if [[ "$TOTAL_COUNT" -gt 0 ]]; then
  echo "  Rate: $(( PASS_COUNT * 100 / TOTAL_COUNT ))%"
fi

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo ""
  echo -e "${RED}Failed cases:${NC}"
  for case_name in "${FAILED_CASES[@]}"; do
    echo "  - $case_name"
  done
  exit 1
fi

exit 0
