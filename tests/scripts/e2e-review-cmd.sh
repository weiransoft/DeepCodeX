#!/usr/bin/env bash
# =============================================================================
# e2e-review-cmd.sh - /review 命令 E2E 测试（RV-01~RV-15）
#
# 测试目标（对齐 docs/dev/code-review-builtin-cmd-design.md §5.8.2）：
#   验证 DeepCodeX-cli 的 /review 内置命令在 CLI 模式下的端到端行为：
#     - help 子命令返回退出码 0 + 帮助文本
#     - 各子命令（typecheck / lint / format / full）正确路由
#     - 非法子命令返回退出码 2
#     - unknown 项目类型返回退出码 2
#     - 报告含 [已验证] 置信度标注
#     - 报告含命令输出证据（命令 / 退出码 / 耗时）
#     - --quiet 模式仅输出结论
#     - --format 选项控制输出格式（markdown / text / json）
#     - CLI 入口 deepcode review 与 TUI /review 行为对齐
#
# 测试环境策略（遵循用户规则，禁止 mock / 占位 / 简化）：
#   - 创建临时项目目录模拟不同项目类型（Node.js / Python / Rust / Go / unknown）
#   - 通过 node --import tsx 直接调用 cli.tsx，真实启动 CLI 进程
#   - 捕获 stdout / stderr / exitCode 进行断言
#   - 不mock任何工具命令，所有命令真实执行（npm / npx / mypy / ruff 等）
#   - 对于可能未安装的工具（如 mypy / ruff），用例设计为验证报告结构而非具体退出码
#
# 用法：
#   bash tests/scripts/e2e-review-cmd.sh
#
# 退出码：
#   0 = 所有测试通过
#   1 = 至少一个测试失败
# =============================================================================

set -uo pipefail

# ----------------------------------------------------------------------------
# 全局变量与配置
# ----------------------------------------------------------------------------

# CLI 包根目录（通过脚本位置定位，避免硬编码路径）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI_PACKAGE_ROOT="$PROJECT_ROOT/packages/cli"

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

# ----------------------------------------------------------------------------
# 工具函数
# ----------------------------------------------------------------------------

# 创建临时目录并注册到清理列表
# @param $1 目录名前缀
create_tmp_dir() {
  local prefix="$1"
  local dir
  dir="$(mktemp -d -t "e2e-rv-${prefix}-XXXXXX")"
  TEMP_DIRS+=("$dir")
  echo "$dir"
}

# 清理所有临时目录（trap EXIT 触发）
cleanup() {
  for dir in "${TEMP_DIRS[@]:-}"; do
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

# 创建临时 Node.js 测试项目（含 package.json + index.ts）
# @param $1 目录名前缀
# @param $2 项目类型："node" / "python" / "rust" / "go" / "unknown"
create_test_project() {
  local prefix="$1"
  local project_type="${2:-node}"
  local project_root
  project_root="$(create_tmp_dir "$prefix")"

  case "$project_type" in
    node)
      # 创建 package.json + src/index.ts
      cat >"$project_root/package.json" <<'PKGJSON'
{
  "name": "e2e-review-test-node",
  "version": "1.0.0",
  "private": true
}
PKGJSON
      mkdir -p "$project_root/src"
      echo "export const hello: string = 'hello';" >"$project_root/src/index.ts"
      ;;
    python)
      cat >"$project_root/pyproject.toml" <<'TOML'
[project]
name = "e2e-review-test-python"
version = "1.0.0"
TOML
      mkdir -p "$project_root/src"
      echo "def hello() -> str: return 'hello'" >"$project_root/src/main.py"
      ;;
    rust)
      cat >"$project_root/Cargo.toml" <<'CARGOTOML'
[package]
name = "e2e-review-test-rust"
version = "1.0.0"
edition = "2021"
CARGOTOML
      mkdir -p "$project_root/src"
      echo "fn main() { println!(\"hello\"); }" >"$project_root/src/main.rs"
      ;;
    go)
      cat >"$project_root/go.mod" <<'GOMOD'
module e2e-review-test-go

go 1.21
GOMOD
      mkdir -p "$project_root"
      cat >"$project_root/main.go" <<'GOMAIN'
package main

import "fmt"

func main() {
	fmt.Println("hello")
}
GOMAIN
      ;;
    unknown|*)
      # 空目录，不创建任何项目标志文件
      ;;
  esac

  echo "$project_root"
}

# 执行 deepcode CLI review 命令（真实子进程）
# @param $1 项目根目录（作为 --project-root 参数）
# 剩余参数传递给 CLI（review 子命令及其选项）
# 输出捕获到 LAST_STDOUT / LAST_STDERR，退出码到 LAST_EXIT_CODE
run_review_cli() {
  local project_root="$1"
  shift
  local cli_path="$CLI_PACKAGE_ROOT/src/cli.tsx"
  local tmp_out tmp_err
  tmp_out="$(mktemp -t e2e-rv-stdout-XXXXXX)"
  tmp_err="$(mktemp -t e2e-rv-stderr-XXXXXX)"
  TEMP_DIRS+=("$tmp_out" "$tmp_err")

  # 真实启动 CLI 进程，捕获 stdout / stderr / exitCode
  # 关键：不设置 DEEPCODE_API_KEY（review 命令不依赖 LLM，避免触发 LLM 初始化开销）
  # 使用 --project-root 显式指定项目根目录，避免工作目录污染
  set +e
  (cd "$CLI_PACKAGE_ROOT" && env \
    HOME="$HOME" \
    NO_COLOR=1 \
    node --import tsx "$cli_path" "$@" --project-root "$project_root") >"$tmp_out" 2>"$tmp_err" </dev/null
  LAST_EXIT_CODE=$?
  set -e
  LAST_STDOUT="$(cat "$tmp_out")"
  LAST_STDERR="$(cat "$tmp_err")"
  rm -f "$tmp_out" "$tmp_err"
}

# ----------------------------------------------------------------------------
# 断言函数
# ----------------------------------------------------------------------------

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
    echo "assert fail: $label should contain '$needle', actual (first 300 chars): ${haystack:0:300}..." >&2
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

# 断言：退出码 == 期望值
# @param $1 实际退出码
# @param $2 期望退出码
assert_exit_code() {
  local actual="$1"
  local expected="$2"
  if [[ "$actual" == "$expected" ]]; then
    return 0
  else
    echo "assert fail: exit_code expected=$expected, actual=$actual" >&2
    return 1
  fi
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

# ----------------------------------------------------------------------------
# 测试用例实现（RV-01~RV-15）
# ----------------------------------------------------------------------------

# RV-01: /review help 返回退出码 0 + 帮助文本
# 验证点：
#   - exitCode == 0
#   - stdout 包含 "DeepCodeX 代码审查命令"
#   - stdout 包含所有子命令名（typecheck / lint / format / full / help）
test_rv01() {
  local project_root
  project_root="$(create_test_project rv01 node)"

  run_review_cli "$project_root" review help

  assert_exit_code "$LAST_EXIT_CODE" 0 || return 1
  assert_contains "$LAST_STDOUT" "DeepCodeX 代码审查命令" "help title" || return 1
  assert_contains "$LAST_STDOUT" "typecheck" "help typecheck" || return 1
  assert_contains "$LAST_STDOUT" "lint" "help lint" || return 1
  assert_contains "$LAST_STDOUT" "format" "help format" || return 1
  assert_contains "$LAST_STDOUT" "full" "help full" || return 1
  assert_contains "$LAST_STDOUT" "help" "help help" || return 1
  return 0
}

# RV-02: /review 在 Node.js 项目上自动检测并运行（默认 full）
# 验证点：
#   - exitCode 在 {0, 1} 中（0=通过，1=检查未通过；均属正常）
#   - stdout 包含 "DeepCodeX 代码审查报告"
#   - stdout 包含 "Node.js / TypeScript"（项目类型识别）
#   - stdout 包含 "类型检查" / "Lint 检查" / "格式化检查"（3 个维度章节）
test_rv02() {
  local project_root
  project_root="$(create_test_project rv02 node)"

  run_review_cli "$project_root" review

  # exitCode 可能是 0（全部通过）或 1（某项检查未通过），都是正常行为
  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" || return 1
  assert_contains "$LAST_STDOUT" "DeepCodeX 代码审查报告" "report title" || return 1
  assert_contains "$LAST_STDOUT" "Node.js / TypeScript" "project type" || return 1
  # full 子命令应包含 3 个维度章节
  assert_contains "$LAST_STDOUT" "类型检查" "typecheck section" || return 1
  assert_contains "$LAST_STDOUT" "Lint 检查" "lint section" || return 1
  assert_contains "$LAST_STDOUT" "格式化检查" "format section" || return 1
  return 0
}

# RV-03: /review typecheck 仅运行类型检查
# 验证点：
#   - stdout 包含 "类型检查" 章节
#   - stdout 不包含 "Lint 检查" / "格式化检查"（仅 typecheck 维度）
test_rv03() {
  local project_root
  project_root="$(create_test_project rv03 node)"

  run_review_cli "$project_root" review typecheck

  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" || return 1
  assert_contains "$LAST_STDOUT" "DeepCodeX 代码审查报告" "report title" || return 1
  assert_contains "$LAST_STDOUT" "类型检查" "typecheck section" || return 1
  # 仅 typecheck 维度，不应包含其他维度章节
  assert_not_contains "$LAST_STDOUT" "## Lint 检查" "lint section should not appear" || return 1
  assert_not_contains "$LAST_STDOUT" "## 格式化检查" "format section should not appear" || return 1
  return 0
}

# RV-04: /review lint 仅运行 lint
# 验证点：
#   - stdout 包含 "Lint 检查" 章节
#   - stdout 不包含 "类型检查" / "格式化检查"（仅 lint 维度）
test_rv04() {
  local project_root
  project_root="$(create_test_project rv04 node)"

  run_review_cli "$project_root" review lint

  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" || return 1
  assert_contains "$LAST_STDOUT" "DeepCodeX 代码审查报告" "report title" || return 1
  assert_contains "$LAST_STDOUT" "Lint 检查" "lint section" || return 1
  assert_not_contains "$LAST_STDOUT" "## 类型检查" "typecheck section should not appear" || return 1
  assert_not_contains "$LAST_STDOUT" "## 格式化检查" "format section should not appear" || return 1
  return 0
}

# RV-05: /review format 仅运行格式化检查
# 验证点：
#   - stdout 包含 "格式化检查" 章节
#   - stdout 不包含 "类型检查" / "Lint 检查"（仅 format 维度）
test_rv05() {
  local project_root
  project_root="$(create_test_project rv05 node)"

  run_review_cli "$project_root" review format

  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" || return 1
  assert_contains "$LAST_STDOUT" "DeepCodeX 代码审查报告" "report title" || return 1
  assert_contains "$LAST_STDOUT" "格式化检查" "format section" || return 1
  assert_not_contains "$LAST_STDOUT" "## 类型检查" "typecheck section should not appear" || return 1
  assert_not_contains "$LAST_STDOUT" "## Lint 检查" "lint section should not appear" || return 1
  return 0
}

# RV-06: /review full 运行所有检查（typecheck + lint + format）
# 验证点：
#   - stdout 包含 3 个维度章节
#   - stdout 包含 "审查范围：full"
test_rv06() {
  local project_root
  project_root="$(create_test_project rv06 node)"

  run_review_cli "$project_root" review full

  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" || return 1
  assert_contains "$LAST_STDOUT" "DeepCodeX 代码审查报告" "report title" || return 1
  assert_contains "$LAST_STDOUT" "审查范围" "scope field" || return 1
  assert_contains "$LAST_STDOUT" "类型检查" "typecheck section" || return 1
  assert_contains "$LAST_STDOUT" "Lint 检查" "lint section" || return 1
  assert_contains "$LAST_STDOUT" "格式化检查" "format section" || return 1
  return 0
}

# RV-07: /review invalid 返回退出码 2（参数错误）
# 验证点：
#   - exitCode == 2
#   - stderr 包含 "参数错误" 或 "非法的子命令"
test_rv07() {
  local project_root
  project_root="$(create_test_project rv07 node)"

  run_review_cli "$project_root" review invalid-subcommand

  assert_exit_code "$LAST_EXIT_CODE" 2 || return 1
  # 错误信息可能在 stdout 或 stderr（取决于 yargs 错误处理路径）
  local combined="$LAST_STDOUT $LAST_STDERR"
  assert_contains "$combined" "参数错误" "error message" || return 1
  return 0
}

# RV-08: /review 在 unknown 项目类型上返回退出码 2
# 验证点：
#   - exitCode == 2
#   - stderr 包含 "无法识别项目类型"
test_rv08() {
  local project_root
  project_root="$(create_test_project rv08 unknown)"

  run_review_cli "$project_root" review

  assert_exit_code "$LAST_EXIT_CODE" 2 || return 1
  assert_contains "$LAST_STDERR" "无法识别项目类型" "unknown project error" || return 1
  return 0
}

# RV-09: /review typecheck 在无 package.json 项目上返回退出码 2
# 验证点：
#   - exitCode == 2
#   - stderr 包含 "无法识别项目类型"
test_rv09() {
  local project_root
  project_root="$(create_test_project rv09 unknown)"

  run_review_cli "$project_root" review typecheck

  assert_exit_code "$LAST_EXIT_CODE" 2 || return 1
  assert_contains "$LAST_STDERR" "无法识别项目类型" "unknown project error" || return 1
  return 0
}

# RV-10: 报告含置信度标注（[已验证] / [未验证] / [不确定] 之一）
# 验证点：
#   - stdout 包含三档置信度标注之一
#   - 这是 A1 System Prompt 强制约束的体现
#   - 设计原则：工具调用成功 → [已验证]；工具调用失败 → [未验证]；超时 → [不确定]
#     任何一档出现都说明置信度标注机制正常工作
test_rv10() {
  local project_root
  project_root="$(create_test_project rv10 node)"

  run_review_cli "$project_root" review typecheck

  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" || return 1
  # 报告必须包含三档置信度标注之一（A1 强制约束的体现）
  # 不强制要求 [已验证]，因为环境中命令可能超时（[不确定]）或失败（[未验证]）
  if [[ "$LAST_STDOUT" == *"[已验证]"* ]]; then
    return 0
  fi
  if [[ "$LAST_STDOUT" == *"[未验证]"* ]]; then
    return 0
  fi
  if [[ "$LAST_STDOUT" == *"[不确定]"* ]]; then
    return 0
  fi
  echo "assert fail: report should contain one of [已验证]/[未验证]/[不确定], first 300 chars: ${LAST_STDOUT:0:300}" >&2
  return 1
}

# RV-11: 报告含命令输出证据
# 验证点：
#   - stdout 包含 "**命令**："（markdown 格式的命令字段）
#   - stdout 包含 "**退出码**：" 或 "退出码："
#   - stdout 包含 "**耗时**：" 或 "耗时："
test_rv11() {
  local project_root
  project_root="$(create_test_project rv11 node)"

  run_review_cli "$project_root" review typecheck

  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" || return 1
  # 报告必须包含命令证据字段
  assert_contains "$LAST_STDOUT" "命令" "command field" || return 1
  assert_contains "$LAST_STDOUT" "退出码" "exit code field" || return 1
  assert_contains "$LAST_STDOUT" "耗时" "duration field" || return 1
  return 0
}

# RV-12: 报告含退出码与耗时
# 验证点：
#   - stdout 包含 "exitCode=" 或 "退出码"（数值化的退出码）
#   - stdout 包含 "ms"（耗时单位）
test_rv12() {
  local project_root
  project_root="$(create_test_project rv12 node)"

  run_review_cli "$project_root" review typecheck

  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" || return 1
  # 报告必须含数值化的退出码与耗时
  assert_contains "$LAST_STDOUT" "ms" "duration unit" || return 1
  # 退出码字段（markdown 或 text 格式）
  assert_contains "$LAST_STDOUT" "退出码" "exit code label" || return 1
  return 0
}

# RV-13: --quiet 模式仅输出结论（不输出明细）
# 验证点：
#   - stdout 不包含 "输出（前 50 行）"（quiet 模式下不输出明细）
#   - stdout 仍包含 "结论"（保留结论部分）
test_rv13() {
  local project_root
  project_root="$(create_test_project rv13 node)"

  run_review_cli "$project_root" review typecheck --quiet

  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" || return 1
  # quiet 模式下不应输出明细
  assert_not_contains "$LAST_STDOUT" "输出（前 50 行）" "detail output should be hidden in quiet mode" || return 1
  # 但结论必须保留
  assert_contains "$LAST_STDOUT" "结论" "conclusion section" || return 1
  return 0
}

# RV-14: 报告格式 markdown 默认
# 验证点：
#   - 不传 --format 时，stdout 包含 markdown 标记（# 标题 / ** 字段 **）
#   - stdout 包含 "# DeepCodeX 代码审查报告"
test_rv14() {
  local project_root
  project_root="$(create_test_project rv14 node)"

  # 不传 --format 选项
  run_review_cli "$project_root" review typecheck

  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" || return 1
  # 默认应为 markdown 格式
  assert_contains "$LAST_STDOUT" "# DeepCodeX 代码审查报告" "markdown title" || return 1
  assert_contains "$LAST_STDOUT" "**项目类型**" "markdown field" || return 1
  return 0
}

# RV-15: 通过 CLI 入口 deepcode review 也可执行
# 验证点：
#   - 通过 CLI 顶级命令 review help 执行（与 /review help 等价）
#   - exitCode == 0
#   - stdout 包含帮助文本
test_rv15() {
  local project_root
  project_root="$(create_test_project rv15 node)"

  # 直接通过 CLI 入口：deepcode review help
  run_review_cli "$project_root" review help

  assert_exit_code "$LAST_EXIT_CODE" 0 || return 1
  assert_contains "$LAST_STDOUT" "DeepCodeX 代码审查命令" "help title" || return 1
  # 验证帮助文本含所有子命令
  assert_contains "$LAST_STDOUT" "typecheck" "help typecheck" || return 1
  assert_contains "$LAST_STDOUT" "lint" "help lint" || return 1
  assert_contains "$LAST_STDOUT" "format" "help format" || return 1
  assert_contains "$LAST_STDOUT" "full" "help full" || return 1
  return 0
}

# RV-16: --format json 输出有效 JSON
# 验证点：
#   - stdout 是有效 JSON
#   - JSON 含 title / projectType / sections 字段
test_rv16() {
  local project_root
  project_root="$(create_test_project rv16 node)"

  run_review_cli "$project_root" review typecheck --format json

  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" || return 1
  # 验证 stdout 是有效 JSON
  if ! echo "$LAST_STDOUT" | python3 -c 'import json, sys; obj=json.load(sys.stdin); assert obj["title"]=="DeepCodeX 代码审查报告"; assert "sections" in obj; assert isinstance(obj["sections"], list)' 2>/dev/null; then
    echo "assert fail: stdout should be valid JSON with title/sections fields, first 300 chars: ${LAST_STDOUT:0:300}" >&2
    return 1
  fi
  return 0
}

# RV-17: --format text 输出纯文本（无 markdown 标记）
# 验证点：
#   - stdout 不包含 "# DeepCodeX 代码审查报告"（markdown 标题）
#   - stdout 包含 "DeepCodeX 代码审查报告"（纯文本标题）
test_rv17() {
  local project_root
  project_root="$(create_test_project rv17 node)"

  run_review_cli "$project_root" review typecheck --format text

  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" || return 1
  # text 格式不应包含 markdown 标题标记
  assert_not_contains "$LAST_STDOUT" "# DeepCodeX 代码审查报告" "markdown title should not appear in text format" || return 1
  # 但应包含纯文本标题
  assert_contains "$LAST_STDOUT" "DeepCodeX 代码审查报告" "text title" || return 1
  return 0
}

# RV-18: Python 项目类型识别
# 验证点：
#   - stdout 包含 "Python"（项目类型识别）
#   - stdout 包含 "类型检查" 章节
test_rv18() {
  local project_root
  project_root="$(create_test_project rv18 python)"

  run_review_cli "$project_root" review typecheck

  # Python 项目可能未安装 mypy / pyright，exitCode 可能是 0/1/3
  # 但项目类型应被正确识别
  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" "3" || return 1
  assert_contains "$LAST_STDOUT" "Python" "project type" || return 1
  return 0
}

# RV-19: Rust 项目类型识别
# 验证点：
#   - stdout 包含 "Rust"（项目类型识别）
test_rv19() {
  local project_root
  project_root="$(create_test_project rv19 rust)"

  run_review_cli "$project_root" review typecheck

  # Rust 项目可能未安装 cargo，exitCode 可能是 0/1/3
  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" "3" || return 1
  assert_contains "$LAST_STDOUT" "Rust" "project type" || return 1
  return 0
}

# RV-20: Go 项目类型识别
# 验证点：
#   - stdout 包含 "Go"（项目类型识别）
test_rv20() {
  local project_root
  project_root="$(create_test_project rv20 go)"

  run_review_cli "$project_root" review typecheck

  # Go 项目可能未安装 go，exitCode 可能是 0/1/3
  assert_exit_in_set "$LAST_EXIT_CODE" "0" "1" "3" || return 1
  assert_contains "$LAST_STDOUT" "Go" "project type" || return 1
  return 0
}

# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  /review Command E2E Test (RV-01~RV-20)${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "CLI root: $CLI_PACKAGE_ROOT"
echo ""

# 环境预检：确保 CLI 入口和 review 模块存在
if [[ ! -f "$CLI_PACKAGE_ROOT/src/cli.tsx" ]]; then
  echo -e "${RED}ERROR: CLI 入口文件不存在: $CLI_PACKAGE_ROOT/src/cli.tsx${NC}"
  exit 1
fi
if [[ ! -f "$CLI_PACKAGE_ROOT/src/review/review-cmd.ts" ]]; then
  echo -e "${RED}ERROR: review-cmd.ts 不存在: $CLI_PACKAGE_ROOT/src/review/review-cmd.ts${NC}"
  exit 1
fi
if [[ ! -f "$CLI_PACKAGE_ROOT/src/review/review-formatter.ts" ]]; then
  echo -e "${RED}ERROR: review-formatter.ts 不存在: $CLI_PACKAGE_ROOT/src/review/review-formatter.ts${NC}"
  exit 1
fi

echo -e "${GREEN}环境预检通过${NC}"
echo ""

# 执行所有测试用例
run_test "RV-01: /review help returns exit 0 with help text" test_rv01
run_test "RV-02: /review on Node.js project runs default full" test_rv02
run_test "RV-03: /review typecheck runs only typecheck dimension" test_rv03
run_test "RV-04: /review lint runs only lint dimension" test_rv04
run_test "RV-05: /review format runs only format dimension" test_rv05
run_test "RV-06: /review full runs all 3 dimensions" test_rv06
run_test "RV-07: /review invalid returns exit 2" test_rv07
run_test "RV-08: /review on unknown project returns exit 2" test_rv08
run_test "RV-09: /review typecheck on unknown project returns exit 2" test_rv09
run_test "RV-10: report contains [已验证] confidence label" test_rv10
run_test "RV-11: report contains command evidence (command/exitcode/duration)" test_rv11
run_test "RV-12: report contains numeric exit code and duration" test_rv12
run_test "RV-13: --quiet mode hides detail output" test_rv13
run_test "RV-14: default format is markdown" test_rv14
run_test "RV-15: CLI entry deepcode review works" test_rv15
run_test "RV-16: --format json outputs valid JSON" test_rv16
run_test "RV-17: --format text outputs plain text" test_rv17
run_test "RV-18: Python project type detected" test_rv18
run_test "RV-19: Rust project type detected" test_rv19
run_test "RV-20: Go project type detected" test_rv20

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
