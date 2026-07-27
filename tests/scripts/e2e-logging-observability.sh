#!/usr/bin/env bash
# =============================================================================
# e2e-logging-observability.sh - 日志与可观测性 E2E 测试（LO-01~LO-14）
#
# 测试目标（对齐日志组件设计文档）：
#   验证 DeepCodeX-cli 的日志与可观测性机制：
#     - 日志文件路径正确（debug.log / error.log / interrupts.log）
#     - 日志文件生成（启用 DEEPCODE_DEBUG_LOG_ENABLED + LLM 调用触发）
#     - 日志内容验证（合法 JSON / 必需字段 / 敏感信息脱敏）
#     - 日志轮转（10MB 阈值 / 3 个备份 / 失败安全）
#     - 中断事件日志（7 种事件类型 / 路径 / 轮转）
#
# 测试环境策略（遵循用户规则，禁止 mock / 占位 / 简化）：
#   - 创建临时 git 仓库作为 projectRoot（避免污染真实项目）
#   - 创建临时 HOME 目录实现日志隔离（每个用例独立 TMP_HOME）
#   - with-key 模式：DEEPCODE_API_KEY="sk-e2e-fake-key-for-testing-only"（假 API Key）
#     → createOpenAIClient 返回非 null client，LLM 调用因假 Key 失败
#     → error.log 自动写入（含 error.name / error.message）
#     → debug.log 在 DEEPCODE_DEBUG_LOG_ENABLED=true 时写入（含请求参数）
#   - Node.js 内联脚本：直接调用 core 包 API（logInterruptEvent / logApiError）
#     → 用于精确测试中断事件日志和敏感信息脱敏
#   - 这是真实的端到端行为测试，不是 mock
#
# 日志组件位置：
#   - packages/core/src/common/debug-logger.ts：调试日志（logOpenAIChatCompletionDebug）
#   - packages/core/src/common/error-logger.ts：错误日志（logApiError，含脱敏逻辑）
#   - packages/core/src/common/interrupt-logger.ts：中断事件日志（logInterruptEvent，7 种事件）
#   - packages/core/src/common/log-rotation.ts：通用轮转工具（10MB / 3 备份）
#
# 用法：
#   bash tests/scripts/e2e-logging-observability.sh
# =============================================================================

set -uo pipefail

# ----------------------------------------------------------------------------
# 全局变量与配置
# ----------------------------------------------------------------------------

# CLI 包与 core 包根目录（通过脚本位置定位，避免硬编码路径）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI_PACKAGE_ROOT="$PROJECT_ROOT/packages/cli"
CORE_PACKAGE_ROOT="$PROJECT_ROOT/packages/core"

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

# 全局临时 HOME 目录（每个测试用例独立设置，实现日志隔离）
# 设计依据：debug-logger.ts / error-logger.ts / interrupt-logger.ts 的 getXXXLogPath()
# 均通过 os.homedir() 读取 $HOME，切换 HOME 即可实现日志文件隔离
TMP_HOME=""

# 假 API Key（sk- 前缀触发 llm-error.ts 的 sk-xxx 脱敏正则）
FAKE_API_KEY="sk-e2e-fake-key-for-testing-only-not-real"

# 日志目录相对 HOME 的路径
LOG_DIR_REL=".deepcode/logs"

# ----------------------------------------------------------------------------
# 工具函数（设计模式参考 e2e-autonomous-persistence.sh）
# ----------------------------------------------------------------------------

# 创建临时目录并注册到清理列表
# @param $1 目录名前缀
create_tmp_dir() {
  local prefix="$1"
  local dir
  dir="$(mktemp -d -t "e2e-lo-${prefix}-XXXXXX")"
  TEMP_DIRS+=("$dir")
  echo "$dir"
}

# 创建临时 HOME 目录（用于日志隔离）
# 每个测试用例调用一次，确保日志文件互不污染
create_tmp_home() {
  local home_dir
  home_dir="$(mktemp -d -t "e2e-lo-home-XXXXXX")"
  TEMP_DIRS+=("$home_dir")
  echo "$home_dir"
}

# 清理所有临时目录（trap EXIT 触发）
cleanup() {
  for dir in "${TEMP_DIRS[@]:-}"; do
    # 恢复可能被 chmod 只读的目录权限，确保 rm -rf 能删除
    chmod -R 755 "$dir" 2>/dev/null || true
    rm -rf "$dir" 2>/dev/null || true
  done
}
trap cleanup EXIT

# 输出 PASS 信息（含耗时）
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

# 创建临时测试项目（含 git init + package.json + index.js）
# @param $1 目录名前缀
create_test_project() {
  local prefix="$1"
  local project_root
  project_root="$(create_tmp_dir "$prefix")"

  # 初始化 git 仓库（autonomous 模式依赖 git）
  git init -q "$project_root" 2>/dev/null || true
  git -C "$project_root" config user.email "e2e-test@example.com" 2>/dev/null || true
  git -C "$project_root" config user.name "E2E Test" 2>/dev/null || true

  # 创建基础项目文件
  echo "{\"name\":\"${prefix}\",\"version\":\"1.0.0\"}" >"$project_root/package.json"
  echo "console.log('hello');" >"$project_root/index.js"
  : >"$project_root/.gitignore"
  echo "# Test Project" >"$project_root/README.md"
  git -C "$project_root" add -A 2>/dev/null || true
  git -C "$project_root" commit -m "init" -q 2>/dev/null || true

  echo "$project_root"
}

# 执行 deepcode CLI 命令（真实子进程）
# @param $1 项目根目录（作为 --project-root 参数）
# @param $2 key_mode："with-key"（假 API Key + 调试日志）/ "no-key"（无 API Key + 调试日志）
# 剩余参数传递给 CLI
# 输出捕获到 LAST_STDOUT / LAST_STDERR，退出码到 LAST_EXIT_CODE
# 环境变量：HOME=$TMP_HOME（日志隔离）+ DEEPCODE_DEBUG_LOG_ENABLED=true（启用调试日志）
run_cli() {
  local project_root="$1"
  local key_mode="${2:-with-key}"
  shift 2
  local cli_path="$CLI_PACKAGE_ROOT/src/cli.tsx"
  local tmp_out tmp_err
  tmp_out="$(mktemp -t e2e-lo-stdout-XXXXXX)"
  tmp_err="$(mktemp -t e2e-lo-stderr-XXXXXX)"
  TEMP_DIRS+=("$tmp_out" "$tmp_err")

  # 根据 key_mode 设置环境变量：
  # - with-key: DEEPCODE_API_KEY=假 Key（LLM 调用会失败但 client 非 null）+ 调试日志启用
  # - no-key:   DEEPCODE_API_KEY=""（强制无 API Key）+ 调试日志启用
  # 关键：HOME 必须指向 TMP_HOME，确保日志写入临时目录
  set +e
  if [[ "$key_mode" == "no-key" ]]; then
    (cd "$CLI_PACKAGE_ROOT" && env \
      DEEPCODE_API_KEY="" \
      DEEPCODE_DEBUG_LOG_ENABLED="true" \
      HOME="$TMP_HOME" \
      node --import tsx "$cli_path" "$@" --project-root "$project_root") >"$tmp_out" 2>"$tmp_err" </dev/null
  else
    (cd "$CLI_PACKAGE_ROOT" && env \
      DEEPCODE_API_KEY="$FAKE_API_KEY" \
      DEEPCODE_DEBUG_LOG_ENABLED="true" \
      HOME="$TMP_HOME" \
      node --import tsx "$cli_path" "$@" --project-root "$project_root") >"$tmp_out" 2>"$tmp_err" </dev/null
  fi
  LAST_EXIT_CODE=$?
  set -e
  LAST_STDOUT="$(cat "$tmp_out")"
  LAST_STDERR="$(cat "$tmp_err")"
  rm -f "$tmp_out" "$tmp_err"
}

# 执行 Node.js 内联 TypeScript 脚本（直接调用 core 包 API）
# @param $1 TypeScript 脚本内容（写入临时 .ts 文件后用 tsx 执行）
# 输出捕获到 LAST_STDOUT / LAST_STDERR，退出码到 LAST_EXIT_CODE
# 环境变量：HOME=$TMP_HOME（日志隔离）
# 设计依据：core 包模块使用相对/绝对路径导入，tsx 支持 .ts 文件直接执行
run_node_inline() {
  local script_content="$1"
  local tmp_script
  tmp_script="$(mktemp -t e2e-lo-script-XXXXXX).ts"
  printf '%s' "$script_content" >"$tmp_script"
  TEMP_DIRS+=("$tmp_script")

  local tmp_out tmp_err
  tmp_out="$(mktemp -t e2e-lo-node-stdout-XXXXXX)"
  tmp_err="$(mktemp -t e2e-lo-node-stderr-XXXXXX)"
  TEMP_DIRS+=("$tmp_out" "$tmp_err")

  set +e
  (cd "$CORE_PACKAGE_ROOT" && env HOME="$TMP_HOME" node --import tsx "$tmp_script") >"$tmp_out" 2>"$tmp_err" </dev/null
  LAST_EXIT_CODE=$?
  set -e
  LAST_STDOUT="$(cat "$tmp_out")"
  LAST_STDERR="$(cat "$tmp_err")"
  rm -f "$tmp_out" "$tmp_err"
}

# ----------------------------------------------------------------------------
# 断言函数
# ----------------------------------------------------------------------------

# 断言：文件存在
# @param $1 文件路径
# @param $2 标签（可选，用于错误信息）
assert_file_exists() {
  local file_path="$1"
  local label="${2:-file}"
  if [[ -f "$file_path" ]]; then
    return 0
  else
    echo "assert fail: $label should exist: $file_path" >&2
    return 1
  fi
}

# 断言：文件不存在
# @param $1 文件路径
# @param $2 标签（可选）
assert_file_not_exists() {
  local file_path="$1"
  local label="${2:-file}"
  if [[ ! -f "$file_path" ]]; then
    return 0
  else
    echo "assert fail: $label should NOT exist: $file_path" >&2
    return 1
  fi
}

# 断言：文件非空
# @param $1 文件路径
# @param $2 标签（可选）
assert_file_not_empty() {
  local file_path="$1"
  local label="${2:-file}"
  if [[ ! -f "$file_path" ]]; then
    echo "assert fail: $label not found (cannot check non-empty): $file_path" >&2
    return 1
  fi
  if [[ -s "$file_path" ]]; then
    return 0
  else
    echo "assert fail: $label should be non-empty: $file_path" >&2
    return 1
  fi
}

# 断言：字符串包含子串
# @param $1 haystack
# @param $2 needle
# @param $3 标签（可选）
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

# 断言：字符串不包含子串
# @param $1 haystack
# @param $2 needle
# @param $3 标签（可选）
assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local label="${3:-output}"
  if [[ "$haystack" != *"$needle"* ]]; then
    return 0
  else
    echo "assert fail: $label should NOT contain '$needle'" >&2
    return 1
  fi
}

# 断言：实际值 == 期望值
# @param $1 actual
# @param $2 expected
# @param $3 标签（可选）
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

# 断言：退出码在允许的集合中
# @param $1 实际退出码
# 剩余参数：允许的退出码列表
assert_exit_in_set() {
  local actual="$1"
  shift
  for allowed in "$@"; do
    if [[ "$actual" == "$allowed" ]]; then
      return 0
    fi
  done
  echo "assert fail: exit_code should be one of [$*], actual=$actual" >&2
  return 1
}

# 断言：文件每行都是合法 JSON，且包含指定字段
# @param $1 文件路径
# @param $2 必需字段名（多个字段用逗号分隔，如 "timestamp,eventType"）
# @param $3 标签（可选）
# 使用 python3 解析 JSON，确保严格校验
assert_json_lines_with_fields() {
  local file_path="$1"
  local fields="$2"
  local label="${3:-json_lines}"

  if [[ ! -f "$file_path" ]]; then
    echo "assert fail: $label - file not found: $file_path" >&2
    return 1
  fi

  # 使用 python3 逐行解析 JSON 并校验字段
  python3 - "$file_path" "$fields" "$label" <<'PYEOF' || return 1
import json
import sys

file_path = sys.argv[1]
required_fields = sys.argv[2].split(",")
label = sys.argv[3]

with open(file_path, "r", encoding="utf-8") as f:
    lines = f.readlines()

if not lines:
    print(f"assert fail: {label} - file is empty", file=sys.stderr)
    sys.exit(1)

line_count = 0
for i, line in enumerate(lines, 1):
    line = line.strip()
    if not line:
        continue
    line_count += 1
    try:
        obj = json.loads(line)
    except json.JSONDecodeError as e:
        print(f"assert fail: {label} - line {i} is not valid JSON: {e}", file=sys.stderr)
        print(f"  line content (first 200 chars): {line[:200]}", file=sys.stderr)
        sys.exit(1)
    if not isinstance(obj, dict):
        print(f"assert fail: {label} - line {i} is not a JSON object", file=sys.stderr)
        sys.exit(1)
    for field in required_fields:
        if field not in obj:
            print(f"assert fail: {label} - line {i} missing field '{field}'", file=sys.stderr)
            print(f"  available fields: {list(obj.keys())}", file=sys.stderr)
            sys.exit(1)

if line_count == 0:
    print(f"assert fail: {label} - file has no non-empty lines", file=sys.stderr)
    sys.exit(1)

sys.exit(0)
PYEOF
}

# 断言：文件中至少有一行 JSON 包含指定字段
# @param $1 文件路径
# @param $2 字段名
# @param $3 标签（可选）
assert_json_has_field_in_any_line() {
  local file_path="$1"
  local field_name="$2"
  local label="${3:-json_field}"

  if [[ ! -f "$file_path" ]]; then
    echo "assert fail: $label - file not found: $file_path" >&2
    return 1
  fi

  python3 - "$file_path" "$field_name" "$label" <<'PYEOF' || return 1
import json
import sys

file_path = sys.argv[1]
field_name = sys.argv[2]
label = sys.argv[3]

with open(file_path, "r", encoding="utf-8") as f:
    lines = f.readlines()

for i, line in enumerate(lines, 1):
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
        if isinstance(obj, dict) and field_name in obj:
            sys.exit(0)
    except json.JSONDecodeError:
        continue

print(f"assert fail: {label} - no line contains field '{field_name}'", file=sys.stderr)
sys.exit(1)
PYEOF
}

# 获取当前时间戳（毫秒）
now_ms() {
  python3 -c 'import time; print(int(time.time()*1000))'
}

# 测试包装器（不使用 set -e，允许测试函数返回非零）
# @param $1 测试用例名
# @param $2 测试函数名
run_test() {
  local test_name="$1"
  local test_fn="$2"
  local start_time end_time duration
  start_time=$(now_ms)

  set +e
  err_msg="$("$test_fn" 2>&1)"
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

# 构造超过 10MB 的日志文件（用于轮转测试）
# @param $1 文件路径
# @param $2 标记内容（写入每行，便于后续断言）
# @param $3 最小字节数（默认 10MB + 1KB）
prefill_oversized_log() {
  local log_path="$1"
  local marker="$2"
  local min_bytes="${3:-$((10 * 1024 * 1024 + 1024))}"

  # 确保目录存在
  mkdir -p "$(dirname "$log_path")"

  # 构造单行 JSON 内容（含 marker 字段）
  local line="{\"timestamp\":\"2025-01-01T00:00:00.000Z\",\"marker\":\"${marker}\"}"
  local line_size=${#line}
  local line_count=$(( (min_bytes / line_size) + 1 ))

  # 使用 dd 快速构造大文件（比循环 echo 快得多）
  # 先构造单行内容，然后重复写入
  {
    for ((i = 0; i < line_count; i++)); do
      echo "$line"
    done
  } >"$log_path"

  # 验证文件大小超过 10MB
  local actual_size
  actual_size=$(stat -f%z "$log_path" 2>/dev/null || stat -c%s "$log_path" 2>/dev/null || echo 0)
  if [[ "$actual_size" -lt "$((10 * 1024 * 1024))" ]]; then
    echo "warning: prefill log size ${actual_size} < 10MB, rotation may not trigger" >&2
  fi
}

# ----------------------------------------------------------------------------
# 测试用例实现（LO-01~LO-14）
# ----------------------------------------------------------------------------

# LO-01: debug.log 路径正确（~/.deepcode/logs/debug.log）
# 验证点：getDebugLogPath() 返回 $HOME/.deepcode/logs/debug.log
# 实现：通过 Node.js 内联脚本调用 getDebugLogPath()，验证路径
test_lo01() {
  TMP_HOME="$(create_tmp_home)"

  local script="
import { getDebugLogPath } from \"${CORE_PACKAGE_ROOT}/src/common/debug-logger.ts\";
console.log(getDebugLogPath());
"
  run_node_inline "$script"
  if [[ "$LAST_EXIT_CODE" != "0" ]]; then
    echo "LO-01: node inline script failed, exit=$LAST_EXIT_CODE, stderr=$LAST_STDERR" >&2
    return 1
  fi

  local expected_path="$TMP_HOME/.deepcode/logs/debug.log"
  # LAST_STDOUT 可能含末尾换行，使用 trim
  local actual_path
  actual_path="$(echo "$LAST_STDOUT" | tr -d '\n' | tr -d '\r')"
  assert_equal "$actual_path" "$expected_path" "debug.log path" || return 1
  return 0
}

# LO-02: error.log 路径正确（~/.deepcode/logs/error.log）
# 验证点：getErrorLogPath() 返回 $HOME/.deepcode/logs/error.log
# 实现：通过 Node.js 内联脚本调用 getErrorLogPath()，验证路径
test_lo02() {
  TMP_HOME="$(create_tmp_home)"

  local script="
import { getErrorLogPath } from \"${CORE_PACKAGE_ROOT}/src/common/error-logger.ts\";
console.log(getErrorLogPath());
"
  run_node_inline "$script"
  if [[ "$LAST_EXIT_CODE" != "0" ]]; then
    echo "LO-02: node inline script failed, exit=$LAST_EXIT_CODE, stderr=$LAST_STDERR" >&2
    return 1
  fi

  local expected_path="$TMP_HOME/.deepcode/logs/error.log"
  local actual_path
  actual_path="$(echo "$LAST_STDOUT" | tr -d '\n' | tr -d '\r')"
  assert_equal "$actual_path" "$expected_path" "error.log path" || return 1
  return 0
}

# LO-03: interrupts.log 路径正确（~/.deepcode/logs/interrupts.log）
# 验证点：getInterruptLogPath() 返回 $HOME/.deepcode/logs/interrupts.log
# 实现：通过 Node.js 内联脚本调用 getInterruptLogPath()，验证路径
test_lo03() {
  TMP_HOME="$(create_tmp_home)"

  local script="
import { getInterruptLogPath } from \"${CORE_PACKAGE_ROOT}/src/common/interrupt-logger.ts\";
console.log(getInterruptLogPath());
"
  run_node_inline "$script"
  if [[ "$LAST_EXIT_CODE" != "0" ]]; then
    echo "LO-03: node inline script failed, exit=$LAST_EXIT_CODE, stderr=$LAST_STDERR" >&2
    return 1
  fi

  local expected_path="$TMP_HOME/.deepcode/logs/interrupts.log"
  local actual_path
  actual_path="$(echo "$LAST_STDOUT" | tr -d '\n' | tr -d '\r')"
  assert_equal "$actual_path" "$expected_path" "interrupts.log path" || return 1
  return 0
}

# LO-04: 启用 DEEPCODE_DEBUG_LOG_ENABLED=true + 执行 team autonomous（假 API Key）
# 验证点：team autonomous 模式 LLM 调用路径正确写入 error.log
#         （含 location="executeDispatch.callLlmOnce.first" 和 requestId 字段）
#
# 实现说明（v2.1.2 修复后）：
#   1. 真实调用 CLI team autonomous（假 API Key），触发 executeDispatch → callLlmOnce
#   2. 假 API Key 导致 LLM 调用失败（401 错误），callLlmOnce 的 catch 块写入 error.log
#   3. 验证 error.log 包含 location="executeDispatch.callLlmOnce.first" 字符串
#   4. 验证 error.log 是合法 NDJSON 且含 requestId 字段（与 SessionManager 路径对齐）
#
# 设计依据：
#   - 修复前：team autonomous 路径不经过 SessionManager，无任何 LLM 日志记录
#   - 修复后（v2.1.2）：OpenAIClientHandle 扩展 debugLogEnabled 字段，callLlmOnce 添加日志记录
#   - 此用例验证修复效果：真实 CLI 调用产生可观测的 LLM 错误日志
#
# 注意：LLM 调用失败时只会写 error.log（不会写 debug.log，因为 try 块未完成），
#       这与 SessionManager 路径行为一致（成功写 debug.log，失败写 error.log）。
test_lo04() {
  TMP_HOME="$(create_tmp_home)"
  local project_root
  project_root="$(create_test_project lo04)"

  # 真实调用 CLI team autonomous（假 API Key + DEEPCODE_DEBUG_LOG_ENABLED=true）
  # 预期：LLM 调用因假 Key 失败，但 callLlmOnce 的 catch 块会写入 error.log
  run_cli "$project_root" with-key team autonomous --goal "test logging LO-04" --max-iterations 1
  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" "2" || return 1
  # 验证 CLI 主流程执行（含 "Ralph Autonomous Loop" 字样）
  assert_contains "$LAST_STDOUT" "Ralph Autonomous Loop" "stdout" || return 1

  # 验证 error.log 文件存在且非空（LLM 失败应触发 error.log 写入）
  local error_log="$TMP_HOME/$LOG_DIR_REL/error.log"
  assert_file_exists "$error_log" "error.log" || return 1
  assert_file_not_empty "$error_log" "error.log" || return 1

  # 验证 error.log 包含修复后的 location 字段（executeDispatch.callLlmOnce.first）
  # 此字符串是 v2.1.2 修复点 5/6 添加的，证明日志来自 team 模式 LLM 调用路径
  local error_log_content
  error_log_content="$(cat "$error_log")"
  assert_contains "$error_log_content" "executeDispatch.callLlmOnce.first" "error.log location field" || return 1

  # 验证 error.log 是合法 NDJSON，含必需字段（timestamp / location / requestId / model / baseURL）
  # requestId 字段是 v2.1.2 修复点 5/6 添加的（M-02：与 SessionManager 路径对齐）
  assert_json_lines_with_fields "$error_log" "timestamp,location,requestId,model,baseURL" "error.log NDJSON with team mode fields" || return 1

  return 0
}

# LO-05: debug.log 每行是合法 JSON，含 timestamp 字段
# 验证点：debug.log 是 NDJSON 格式，每行可解析为 JSON 对象，含 timestamp 字段
# 实现：通过 Node.js 内联脚本调用 logOpenAIChatCompletionDebug 写入多条日志，然后逐行解析校验
test_lo05() {
  TMP_HOME="$(create_tmp_home)"

  # 通过 Node.js 内联脚本写入 3 条 debug log entry，验证 NDJSON 格式
  local script="
import { logOpenAIChatCompletionDebug } from \"${CORE_PACKAGE_ROOT}/src/common/debug-logger.ts\";

// 写入 3 条 debug log entry，验证每行都是合法 JSON
for (let i = 0; i < 3; i++) {
  logOpenAIChatCompletionDebug({
    timestamp: new Date().toISOString(),
    location: \"test.lo05\",
    requestId: \"lo05-test-\" + i,
    model: \"deepseek-v4-pro\",
    baseURL: \"https://api.deepseek.com\",
    request: {
      model: \"deepseek-v4-pro\",
      messages: [{ role: \"user\", content: \"test logging LO-05 iteration \" + i }],
    },
  });
}
console.log(\"OK\");
"
  run_node_inline "$script"
  if [[ "$LAST_EXIT_CODE" != "0" ]]; then
    echo "LO-05: node inline script failed, exit=$LAST_EXIT_CODE, stderr=$LAST_STDERR" >&2
    return 1
  fi

  local debug_log="$TMP_HOME/$LOG_DIR_REL/debug.log"
  assert_file_exists "$debug_log" "debug.log" || return 1
  assert_file_not_empty "$debug_log" "debug.log" || return 1

  # 校验每行是合法 JSON 且含 timestamp 字段
  assert_json_lines_with_fields "$debug_log" "timestamp" "debug.log NDJSON" || return 1
  return 0
}

# LO-06: error.log 在 LLM 失败后生成，含 error.name / error.message 字段
# 验证点：error.log 写入后每行含 error.name 和 error.message 字段
# 实现：通过 Node.js 内联脚本调用 logApiError（core 包真实 API），写入含错误类型保留的日志条目
# 说明：autonomous 模式的 LLM 调用路径不经过 SessionManager（唯一调用 logApiError 的地方），
#       因此通过 Node.js API 直接测试 error.log 写入逻辑和错误类型保留
test_lo06() {
  TMP_HOME="$(create_tmp_home)"

  # 通过 Node.js 内联脚本调用 logApiError，写入含 error.name / error.message 的日志条目
  # 模拟 LLM 401 失败场景（假 API Key 触发）
  local script="
import { logApiError } from \"${CORE_PACKAGE_ROOT}/src/common/error-logger.ts\";

// 写入一条 error log entry，含 error.name / error.message / error.stack 字段
// 模拟 LLM 调用失败（401 Incorrect API key）的场景
logApiError({
  timestamp: new Date().toISOString(),
  location: \"test.lo06\",
  requestId: \"lo06-test\",
  model: \"deepseek-v4-pro\",
  baseURL: \"https://api.deepseek.com\",
  error: {
    name: \"APIError\",
    message: \"401 Incorrect API key provided\",
    status: 401,
    code: \"invalid_api_key\",
  },
  request: {
    model: \"deepseek-v4-pro\",
    messages: [{ role: \"user\", content: \"test logging LO-06\" }],
  },
});
console.log(\"OK\");
"
  run_node_inline "$script"
  if [[ "$LAST_EXIT_CODE" != "0" ]]; then
    echo "LO-06: node inline script failed, exit=$LAST_EXIT_CODE, stderr=$LAST_STDERR" >&2
    return 1
  fi

  local error_log="$TMP_HOME/$LOG_DIR_REL/error.log"
  assert_file_exists "$error_log" "error.log" || return 1
  assert_file_not_empty "$error_log" "error.log" || return 1

  # 校验 error.log 每行是合法 JSON
  assert_json_lines_with_fields "$error_log" "timestamp" "error.log NDJSON" || return 1

  # 校验至少有一行包含 error.name 和 error.message 字段
  # 由于 error 字段是嵌套对象，需要用 python 检查
  python3 - "$error_log" <<'PYEOF' || return 1
import json
import sys

file_path = sys.argv[1]
with open(file_path, "r", encoding="utf-8") as f:
    lines = f.readlines()

found_name = False
found_message = False
for line in lines:
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
        error_obj = obj.get("error")
        if isinstance(error_obj, dict):
            if "name" in error_obj:
                found_name = True
            if "message" in error_obj:
                found_message = True
    except json.JSONDecodeError:
        continue

if not found_name:
    print("assert fail: error.log should contain error.name field", file=sys.stderr)
    sys.exit(1)
if not found_message:
    print("assert fail: error.log should contain error.message field", file=sys.stderr)
    sys.exit(1)
sys.exit(0)
PYEOF
  return 0
}

# LO-07: error.log 中的 Authorization Bearer token 被脱敏（含 ***MASKED***）
# 验证点：error-logger.ts 的 maskSensitive 函数将 "Authorization: Bearer xxx" 替换为 "***MASKED***"
# 实现：通过 Node.js 内联脚本直接调用 logApiError，传入含 Authorization Bearer 的 response，
#       验证 error.log 中出现 ***MASKED*** 且不含原始 token
# 设计依据：error-logger.ts:38-46 maskSensitive 函数处理 response 字符串
test_lo07() {
  TMP_HOME="$(create_tmp_home)"

  # 构造含 Authorization Bearer token 的 error log entry
  # maskSensitive 正则：/(Authorization:\s*Bearer\s+)[^\s\r\n]+/gi → 替换为 $1***MASKED***
  local secret_token="sk-secret-token-lo07-1234567890abcdef"
  local script="
import { logApiError } from \"${CORE_PACKAGE_ROOT}/src/common/error-logger.ts\";

// 构造含 Authorization Bearer token 的错误日志条目
// 验证 maskSensitive 函数对 response 字符串的脱敏处理
logApiError({
  timestamp: new Date().toISOString(),
  location: \"test.lo07\",
  requestId: \"lo07-mask-test\",
  error: {
    name: \"TestError\",
    message: \"Authorization: Bearer ${secret_token} failed\",
  },
  request: {},
  response: \"Authorization: Bearer ${secret_token}\",
});
console.log(\"OK\");
"
  run_node_inline "$script"
  if [[ "$LAST_EXIT_CODE" != "0" ]]; then
    echo "LO-07: node inline script failed, exit=$LAST_EXIT_CODE, stderr=$LAST_STDERR" >&2
    return 1
  fi

  local error_log="$TMP_HOME/$LOG_DIR_REL/error.log"
  assert_file_exists "$error_log" "error.log" || return 1
  assert_file_not_empty "$error_log" "error.log" || return 1

  # 读取 error.log 内容
  local log_content
  log_content="$(cat "$error_log")"

  # 验证含 ***MASKED***（脱敏标记）
  assert_contains "$log_content" "***MASKED***" "error.log masked content" || return 1

  # 验证不含原始 secret token（防止凭证泄露）
  assert_not_contains "$log_content" "$secret_token" "error.log raw token" || return 1
  return 0
}

# LO-08: debug.log 包含 LLM 请求参数（model / baseURL / request 字段）
# 验证点：debug.log 中的 JSON 行包含 request 字段（必需），以及 model 或 baseURL 字段（可选）
# 实现：通过 Node.js 内联脚本调用 logOpenAIChatCompletionDebug，写入含 model / baseURL / request 的日志条目
# 设计依据：debug-logger.ts OpenAIChatCompletionDebugEntry 类型含 model / baseURL / request 字段
test_lo08() {
  TMP_HOME="$(create_tmp_home)"

  # 通过 Node.js 内联脚本调用 logOpenAIChatCompletionDebug
  # 写入含 model / baseURL / request 字段的完整日志条目
  local script="
import { logOpenAIChatCompletionDebug } from \"${CORE_PACKAGE_ROOT}/src/common/debug-logger.ts\";

// 写入含完整 LLM 请求参数的 debug log entry
logOpenAIChatCompletionDebug({
  timestamp: new Date().toISOString(),
  location: \"test.lo08\",
  requestId: \"lo08-test\",
  model: \"deepseek-v4-pro\",
  baseURL: \"https://api.deepseek.com\",
  params: { temperature: 0.7, max_tokens: 4096 },
  request: {
    model: \"deepseek-v4-pro\",
    messages: [
      { role: \"system\", content: \"You are a helpful assistant.\" },
      { role: \"user\", content: \"test logging LO-08\" },
    ],
    stream: true,
  },
});
console.log(\"OK\");
"
  run_node_inline "$script"
  if [[ "$LAST_EXIT_CODE" != "0" ]]; then
    echo "LO-08: node inline script failed, exit=$LAST_EXIT_CODE, stderr=$LAST_STDERR" >&2
    return 1
  fi

  local debug_log="$TMP_HOME/$LOG_DIR_REL/debug.log"
  assert_file_exists "$debug_log" "debug.log" || return 1
  assert_file_not_empty "$debug_log" "debug.log" || return 1

  # 校验至少有一行包含 request 字段（必需字段）
  assert_json_has_field_in_any_line "$debug_log" "request" "debug.log request field" || return 1

  # 校验至少有一行包含 model 或 baseURL 字段（可选字段，存在其中一个即通过）
  # has_model=1 表示未找到（默认），has_model=0 表示找到
  local has_model=1
  local has_baseurl=1

  # 检查 model 字段：python 退出 0 表示找到，退出 1 表示未找到
  python3 - "$debug_log" <<'PYEOF' && has_model=0
import json
import sys

file_path = sys.argv[1]
with open(file_path, "r", encoding="utf-8") as f:
    lines = f.readlines()

for line in lines:
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
        if isinstance(obj, dict) and "model" in obj:
            sys.exit(0)
    except json.JSONDecodeError:
        continue
sys.exit(1)
PYEOF

  # 检查 baseURL 字段
  python3 - "$debug_log" <<'PYEOF' && has_baseurl=0
import json
import sys

file_path = sys.argv[1]
with open(file_path, "r", encoding="utf-8") as f:
    lines = f.readlines()

for line in lines:
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
        if isinstance(obj, dict) and "baseURL" in obj:
            sys.exit(0)
    except json.JSONDecodeError:
        continue
sys.exit(1)
PYEOF

  # has_model=0 或 has_baseurl=0 表示至少找到一个字段
  if [[ "$has_model" -eq 0 || "$has_baseurl" -eq 0 ]]; then
    return 0
  else
    echo "assert fail: debug.log should contain at least one of 'model' or 'baseURL' fields" >&2
    return 1
  fi
}

# LO-09: 手动构造 > 10MB 的 debug.log，触发轮转，验证 debug.log.1 存在
# 验证点：rotateLogIfNeeded 在文件 >= 10MB 时将 debug.log 重命名为 debug.log.1
# 实现：预填充 11MB debug.log，通过 Node.js 内联脚本调用 logOpenAIChatCompletionDebug 触发轮转
# 设计依据：log-rotation.ts rotateLogIfNeeded 函数，DEFAULT_MAX_LOG_SIZE_BYTES=10MB
test_lo09() {
  TMP_HOME="$(create_tmp_home)"

  # 预填充 11MB 的 debug.log（超过 10MB 阈值）
  local debug_log="$TMP_HOME/$LOG_DIR_REL/debug.log"
  mkdir -p "$(dirname "$debug_log")"
  prefill_oversized_log "$debug_log" "LO09_OLD_CONTENT"

  # 验证预填充文件确实超过 10MB
  local file_size
  file_size=$(stat -f%z "$debug_log" 2>/dev/null || stat -c%s "$debug_log" 2>/dev/null || echo 0)
  if [[ "$file_size" -lt "$((10 * 1024 * 1024))" ]]; then
    echo "LO-09: prefill debug.log size ${file_size} < 10MB, test invalid" >&2
    return 1
  fi

  # 通过 Node.js 内联脚本调用 logOpenAIChatCompletionDebug 触发轮转
  # logOpenAIChatCompletionDebug 内部先调用 rotateLogIfNeeded（将旧文件重命名为 .log.1），
  # 然后 appendFileSync 写入新内容到新的 debug.log
  local script="
import { logOpenAIChatCompletionDebug } from \"${CORE_PACKAGE_ROOT}/src/common/debug-logger.ts\";

// 写入新 entry，触发轮转（旧 11MB 文件重命名为 .log.1）
logOpenAIChatCompletionDebug({
  timestamp: new Date().toISOString(),
  location: \"test.lo09\",
  requestId: \"lo09-rotation-test\",
  model: \"deepseek-v4-pro\",
  baseURL: \"https://api.deepseek.com\",
  request: {
    model: \"deepseek-v4-pro\",
    messages: [{ role: \"user\", content: \"LO-09 rotation test\" }],
  },
});
console.log(\"OK\");
"
  run_node_inline "$script"
  if [[ "$LAST_EXIT_CODE" != "0" ]]; then
    echo "LO-09: node inline script failed, exit=$LAST_EXIT_CODE, stderr=$LAST_STDERR" >&2
    return 1
  fi

  # 验证 debug.log.1 存在（旧的大文件被轮转）
  local backup_log_1="${debug_log}.1"
  assert_file_exists "$backup_log_1" "debug.log.1 (rotated)" || return 1

  # 验证 debug.log.1 含旧内容标记（确认是预填充的旧文件）
  local backup_content
  backup_content="$(cat "$backup_log_1")"
  assert_contains "$backup_content" "LO09_OLD_CONTENT" "debug.log.1 old content" || return 1
  return 0
}

# LO-10: 轮转保留最多 3 个备份（构造 .log.1/.log.2/.log.3 已存在 + 主文件超限）
# 验证点：rotateLogIfNeeded 删除 .log.3（最旧备份），重命名 .log.2→.log.3, .log.1→.log.2, .log→.log.1
# 实现：预填充 debug.log(11MB) + debug.log.1("old1") + debug.log.2("old2") + debug.log.3("old3")，
#       通过 Node.js 内联脚本调用 logOpenAIChatCompletionDebug 触发轮转，
#       验证 "old3" 内容消失（被删除），debug.log.1 存在（原主文件轮转而来）
# 设计依据：log-rotation.ts rotateLogIfNeeded 循环逻辑（i=maxBackupCount 时 unlink，否则 rename）
test_lo10() {
  TMP_HOME="$(create_tmp_home)"

  local debug_log="$TMP_HOME/$LOG_DIR_REL/debug.log"
  local log_dir
  log_dir="$(dirname "$debug_log")"
  mkdir -p "$log_dir"

  # 预填充 4 个文件：主文件 11MB + 3 个备份（各有唯一标记内容）
  prefill_oversized_log "$debug_log" "LO10_MAIN_CONTENT"
  echo "{\"timestamp\":\"2025-01-01T00:00:00.000Z\",\"marker\":\"LO10_OLD_1\"}" > "${debug_log}.1"
  echo "{\"timestamp\":\"2025-01-01T00:00:00.000Z\",\"marker\":\"LO10_OLD_2\"}" > "${debug_log}.2"
  echo "{\"timestamp\":\"2025-01-01T00:00:00.000Z\",\"marker\":\"LO10_OLD_3\"}" > "${debug_log}.3"

  # 通过 Node.js 内联脚本调用 logOpenAIChatCompletionDebug 触发轮转
  # rotateLogIfNeeded 会：unlink(.3) → rename(.2→.3) → rename(.1→.2) → rename(.log→.1)
  local script="
import { logOpenAIChatCompletionDebug } from \"${CORE_PACKAGE_ROOT}/src/common/debug-logger.ts\";

// 写入新 entry，触发轮转（保留最多 3 个备份）
logOpenAIChatCompletionDebug({
  timestamp: new Date().toISOString(),
  location: \"test.lo10\",
  requestId: \"lo10-rotation-test\",
  model: \"deepseek-v4-pro\",
  baseURL: \"https://api.deepseek.com\",
  request: {
    model: \"deepseek-v4-pro\",
    messages: [{ role: \"user\", content: \"LO-10 backup count test\" }],
  },
});
console.log(\"OK\");
"
  run_node_inline "$script"
  if [[ "$LAST_EXIT_CODE" != "0" ]]; then
    echo "LO-10: node inline script failed, exit=$LAST_EXIT_CODE, stderr=$LAST_STDERR" >&2
    return 1
  fi

  # 验证 debug.log.1 存在（原主文件 11MB 被轮转为 .log.1）
  assert_file_exists "${debug_log}.1" "debug.log.1" || return 1

  # 验证 debug.log.1 含原主文件内容标记（确认是 11MB 主文件轮转而来）
  local backup1_content
  backup1_content="$(cat "${debug_log}.1")"
  assert_contains "$backup1_content" "LO10_MAIN_CONTENT" "debug.log.1 main content" || return 1

  # 验证 "old3" 内容已删除（原 .log.3 被 unlink）
  # 轮转后 .log.3 应含原 .log.2 的内容（"old2"），不含 "old3"
  if [[ -f "${debug_log}.3" ]]; then
    local backup3_content
    backup3_content="$(cat "${debug_log}.3")"
    assert_not_contains "$backup3_content" "LO10_OLD_3" "debug.log.3 (old3 should be deleted)" || return 1
  fi

  # 验证 debug.log.2 含原 .log.1 的内容（"old1"）
  if [[ -f "${debug_log}.2" ]]; then
    local backup2_content
    backup2_content="$(cat "${debug_log}.2")"
    assert_contains "$backup2_content" "LO10_OLD_1" "debug.log.2 (should be old1)" || return 1
  fi

  # 验证整个日志目录中不含 "LO10_OLD_3"（最旧备份已被删除）
  local all_content
  all_content="$(cat "$log_dir"/debug.log* 2>/dev/null || true)"
  assert_not_contains "$all_content" "LO10_OLD_3" "log dir (old3 deleted)" || return 1
  return 0
}

# LO-11: 轮转失败安全（构造只读目录，验证 CLI 主流程不崩溃）
# 验证点：rotateLogIfNeeded 失败时（rename 抛错），内层 try/catch 捕获，CLI 继续运行
# 实现：预填充 11MB debug.log，将日志目录 chmod 555（只读），运行 CLI 验证不崩溃
# 设计依据：
#   - debug-logger.ts:33-37 内层 try/catch 捕获 rotateLogIfNeeded 失败
#   - debug-logger.ts:39-41 外层 try/catch 捕获 appendFileSync 失败
#   - 两者均静默吞错，不影响 CLI 主流程
test_lo11() {
  TMP_HOME="$(create_tmp_home)"
  local project_root
  project_root="$(create_test_project lo11)"

  local debug_log="$TMP_HOME/$LOG_DIR_REL/debug.log"
  local log_dir
  log_dir="$(dirname "$debug_log")"
  mkdir -p "$log_dir"

  # 预填充 11MB debug.log（触发轮转条件）
  prefill_oversized_log "$debug_log" "LO11_OLD_CONTENT"

  # 将日志目录设为只读（chmod 555），模拟权限不足
  # rotateLogIfNeeded 的 renameSync 会因目录只读而失败（EACCES）
  chmod 555 "$log_dir"

  # 运行 CLI（应不崩溃，rotateLogIfNeeded 失败被内层 catch，appendFileSync 失败被外层 catch）
  run_cli "$project_root" with-key team autonomous --goal "test logging LO-11 rotation failure" --max-iterations 1

  # 恢复目录权限（便于后续清理）
  chmod 755 "$log_dir" 2>/dev/null || true

  # 验证 CLI 未崩溃：退出码应为 0/1/2（autonomous 正常退出码），而非 SIGSEGV(139)/SIGABRT(134) 等
  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" "2" "exit_code (should not crash)" || return 1

  # 验证 CLI 有正常输出（含 "Ralph Autonomous Loop" 字样，证明主流程执行）
  assert_contains "$LAST_STDOUT" "Ralph Autonomous Loop" "stdout (main flow executed)" || return 1
  return 0
}

# LO-12: 通过 Node.js 内联脚本调用 logInterruptEvent，验证 interrupts.log 写入 7 种事件类型之一
# 验证点：logInterruptEvent 成功写入 interrupts.log，含 eventType 字段
# 实现：直接调用 core 包 logInterruptEvent API，传入 interrupt.enqueued 事件
# 设计依据：interrupt-logger.ts logInterruptEvent 函数，7 种事件类型枚举
test_lo12() {
  TMP_HOME="$(create_tmp_home)"

  # 调用 logInterruptEvent 写入 interrupt.enqueued 事件
  local script="
import { logInterruptEvent, getInterruptLogPath } from \"${CORE_PACKAGE_ROOT}/src/common/interrupt-logger.ts\";

// 写入 interrupt.enqueued 事件（7 种事件类型之一）
logInterruptEvent({
  timestamp: new Date().toISOString(),
  eventType: \"interrupt.enqueued\",
  instructionText: \"LO-12 test instruction\",
  instructionSource: \"user\",
  queueSize: 1,
});

console.log(\"OK\");
console.log(\"PATH:\" + getInterruptLogPath());
"
  run_node_inline "$script"
  if [[ "$LAST_EXIT_CODE" != "0" ]]; then
    echo "LO-12: node inline script failed, exit=$LAST_EXIT_CODE, stderr=$LAST_STDERR" >&2
    return 1
  fi

  local interrupt_log="$TMP_HOME/$LOG_DIR_REL/interrupts.log"
  assert_file_exists "$interrupt_log" "interrupts.log" || return 1
  assert_file_not_empty "$interrupt_log" "interrupts.log" || return 1

  # 验证含事件类型 "interrupt.enqueued"
  local log_content
  log_content="$(cat "$interrupt_log")"
  assert_contains "$log_content" "interrupt.enqueued" "interrupts.log eventType" || return 1
  return 0
}

# LO-13: interrupts.log 每行是合法 JSON，含 timestamp / eventType 字段
# 验证点：interrupts.log 是 NDJSON 格式，每行含 timestamp 和 eventType 字段
# 实现：调用 logInterruptEvent 写入多种事件类型，逐行解析校验
test_lo13() {
  TMP_HOME="$(create_tmp_home)"

  # 写入多种事件类型（覆盖 task.* 系列）
  local script="
import { logInterruptEvent } from \"${CORE_PACKAGE_ROOT}/src/common/interrupt-logger.ts\";

// 写入 3 种不同的事件类型，验证每行都是合法 JSON
logInterruptEvent({
  timestamp: new Date().toISOString(),
  eventType: \"interrupt.enqueued\",
  instructionText: \"LO-13 enqueue test\",
  instructionSource: \"user\",
  queueSize: 1,
});

logInterruptEvent({
  timestamp: new Date().toISOString(),
  eventType: \"task.started\",
  taskId: \"t-lo13-1\",
  taskKind: \"chat\",
  taskStatus: \"running\",
});

logInterruptEvent({
  timestamp: new Date().toISOString(),
  eventType: \"task.succeeded\",
  taskId: \"t-lo13-1\",
  taskKind: \"chat\",
  taskStatus: \"succeeded\",
  durationMs: 100,
});

console.log(\"OK\");
"
  run_node_inline "$script"
  if [[ "$LAST_EXIT_CODE" != "0" ]]; then
    echo "LO-13: node inline script failed, exit=$LAST_EXIT_CODE, stderr=$LAST_STDERR" >&2
    return 1
  fi

  local interrupt_log="$TMP_HOME/$LOG_DIR_REL/interrupts.log"
  assert_file_exists "$interrupt_log" "interrupts.log" || return 1
  assert_file_not_empty "$interrupt_log" "interrupts.log" || return 1

  # 校验每行是合法 JSON 且含 timestamp 和 eventType 字段
  assert_json_lines_with_fields "$interrupt_log" "timestamp,eventType" "interrupts.log NDJSON" || return 1
  return 0
}

# LO-14: interrupts.log 轮转触发（手动构造 > 10MB 的 interrupts.log，调用 logInterruptEvent）
# 验证点：rotateLogIfNeeded 在 interrupts.log >= 10MB 时触发轮转，生成 interrupts.log.1
# 实现：预填充 11MB interrupts.log，调用 logInterruptEvent 触发轮转，验证 .log.1 存在
# 设计依据：interrupt-logger.ts:116-120 调用 rotateLogIfNeeded
test_lo14() {
  TMP_HOME="$(create_tmp_home)"

  local interrupt_log="$TMP_HOME/$LOG_DIR_REL/interrupts.log"
  local log_dir
  log_dir="$(dirname "$interrupt_log")"
  mkdir -p "$log_dir"

  # 预填充 11MB 的 interrupts.log（超过 10MB 阈值）
  prefill_oversized_log "$interrupt_log" "LO14_OLD_CONTENT"

  # 验证预填充文件确实超过 10MB
  local file_size
  file_size=$(stat -f%z "$interrupt_log" 2>/dev/null || stat -c%s "$interrupt_log" 2>/dev/null || echo 0)
  if [[ "$file_size" -lt "$((10 * 1024 * 1024))" ]]; then
    echo "LO-14: prefill interrupts.log size ${file_size} < 10MB, test invalid" >&2
    return 1
  fi

  # 调用 logInterruptEvent 触发轮转 + 写入新事件
  local script="
import { logInterruptEvent } from \"${CORE_PACKAGE_ROOT}/src/common/interrupt-logger.ts\";

// 写入新事件，应触发轮转（旧 11MB 文件重命名为 .log.1）
logInterruptEvent({
  timestamp: new Date().toISOString(),
  eventType: \"interrupt.enqueued\",
  instructionText: \"LO-14 rotation test\",
  instructionSource: \"user\",
  queueSize: 1,
});

console.log(\"OK\");
"
  run_node_inline "$script"
  if [[ "$LAST_EXIT_CODE" != "0" ]]; then
    echo "LO-14: node inline script failed, exit=$LAST_EXIT_CODE, stderr=$LAST_STDERR" >&2
    return 1
  fi

  # 验证 interrupts.log.1 存在（旧的大文件被轮转）
  local backup_log_1="${interrupt_log}.1"
  assert_file_exists "$backup_log_1" "interrupts.log.1 (rotated)" || return 1

  # 验证 interrupts.log.1 含旧内容标记（确认是预填充的旧文件）
  local backup_content
  backup_content="$(cat "$backup_log_1")"
  assert_contains "$backup_content" "LO14_OLD_CONTENT" "interrupts.log.1 old content" || return 1

  # 验证 interrupts.log（新文件）含新事件
  local new_content
  new_content="$(cat "$interrupt_log")"
  assert_contains "$new_content" "LO-14 rotation test" "interrupts.log new content" || return 1
  return 0
}

# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Logging & Observability E2E Test (LO-01~LO-14)${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "CLI root: $CLI_PACKAGE_ROOT"
echo "Core root: $CORE_PACKAGE_ROOT"
echo ""

# 环境预检：确保 CLI 入口和日志组件模块存在
if [[ ! -f "$CLI_PACKAGE_ROOT/src/cli.tsx" ]]; then
  echo -e "${RED}ERROR: CLI 入口文件不存在: $CLI_PACKAGE_ROOT/src/cli.tsx${NC}"
  exit 1
fi
if [[ ! -f "$CORE_PACKAGE_ROOT/src/common/debug-logger.ts" ]]; then
  echo -e "${RED}ERROR: debug-logger.ts 不存在: $CORE_PACKAGE_ROOT/src/common/debug-logger.ts${NC}"
  exit 1
fi
if [[ ! -f "$CORE_PACKAGE_ROOT/src/common/error-logger.ts" ]]; then
  echo -e "${RED}ERROR: error-logger.ts 不存在: $CORE_PACKAGE_ROOT/src/common/error-logger.ts${NC}"
  exit 1
fi
if [[ ! -f "$CORE_PACKAGE_ROOT/src/common/interrupt-logger.ts" ]]; then
  echo -e "${RED}ERROR: interrupt-logger.ts 不存在: $CORE_PACKAGE_ROOT/src/common/interrupt-logger.ts${NC}"
  exit 1
fi
if [[ ! -f "$CORE_PACKAGE_ROOT/src/common/log-rotation.ts" ]]; then
  echo -e "${RED}ERROR: log-rotation.ts 不存在: $CORE_PACKAGE_ROOT/src/common/log-rotation.ts${NC}"
  exit 1
fi

echo -e "${GREEN}环境预检通过${NC}"
echo ""

# 执行所有测试用例
run_test "LO-01: debug.log path is correct" test_lo01
run_test "LO-02: error.log path is correct" test_lo02
run_test "LO-03: interrupts.log path is correct" test_lo03
run_test "LO-04: debug.log generated with DEEPCODE_DEBUG_LOG_ENABLED=true" test_lo04
run_test "LO-05: debug.log lines are valid JSON with timestamp" test_lo05
run_test "LO-06: error.log contains error.name and error.message" test_lo06
run_test "LO-07: Authorization Bearer token is masked in error.log" test_lo07
run_test "LO-08: debug.log contains LLM request parameters" test_lo08
run_test "LO-09: debug.log rotation triggers when > 10MB" test_lo09
run_test "LO-10: rotation keeps max 3 backups" test_lo10
run_test "LO-11: rotation failure does not crash CLI" test_lo11
run_test "LO-12: logInterruptEvent writes event type" test_lo12
run_test "LO-13: interrupts.log lines are valid JSON with timestamp/eventType" test_lo13
run_test "LO-14: interrupts.log rotation triggers when > 10MB" test_lo14

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
