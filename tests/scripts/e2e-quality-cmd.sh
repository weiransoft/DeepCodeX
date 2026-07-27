#!/usr/bin/env bash
# =============================================================================
# e2e-quality-cmd.sh - quality-check CLI 顶级命令 Shell E2E 测试
#
# 测试目标：
#   通过真实 shell 调用 `deepcode quality-check <subcommand>`，验证 CLI 顶级
#   命令在端到端场景下的完整行为，覆盖命令路由、参数解析、退出码传递、
#   stdout/stderr 输出分离等关键链路。
#
# 设计原则（遵循项目规则）：
#   - 禁止 mock：所有测试通过真实 CLI 进程执行，使用真实文件系统与真实 quality 包
#   - 每个测试用例独立隔离：独立临时目录 + trap 统一清理
#   - 退出码语义：0=通过，1=失败（断言不匹配），非零=测试框架错误
#
# 用法：
#   bash tests/scripts/e2e-quality-cmd.sh
#
# 退出码：
#   0 = 所有测试通过
#   1 = 至少一个测试失败
# =============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# 全局变量与配置
# ----------------------------------------------------------------------------

# CLI 包根目录（用于定位 src/cli.tsx）
CLI_PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/packages/cli"

# 测试统计
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
TOTAL_COUNT=0

# 临时目录集合（trap 时统一清理）
TEMP_DIRS=()

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
# 工具函数
# ----------------------------------------------------------------------------

# 创建唯一临时目录
create_tmp_dir() {
  local prefix="$1"
  local dir
  dir="$(mktemp -d -t "quality-e2e-${prefix}-XXXXXX")"
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

# 打印测试结果
print_pass() {
  local test_name="$1"
  local duration="${2:-}"
  PASS_COUNT=$((PASS_COUNT + 1))
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  echo -e "${GREEN}✔${NC} ${test_name} (${duration}ms)"
}

print_fail() {
  local test_name="$1"
  local reason="${2:-}"
  local duration="${3:-}"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  echo -e "${RED}✖${NC} ${test_name} (${duration}ms)"
  if [[ -n "$reason" ]]; then
    echo -e "  ${RED}原因:${NC} $reason"
  fi
}

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

# 执行 deepcode quality-check CLI 命令（真实子进程）
# 参数：$1..$N = quality-check 子命令参数
# 输出：设置全局变量 LAST_STDOUT, LAST_STDERR, LAST_EXIT_CODE
run_quality_cli() {
  local cli_path="$CLI_PACKAGE_ROOT/src/cli.tsx"
  # 捕获 stdout 与 stderr 分离
  local tmp_out tmp_err
  tmp_out="$(mktemp -t quality-e2e-stdout-XXXXXX)"
  tmp_err="$(mktemp -t quality-e2e-stderr-XXXXXX)"
  TEMP_DIRS+=("$tmp_out" "$tmp_err")

  # 注意：不能用 `|| true` 否则会丢失退出码
  # 使用 set +e 临时关闭错误退出，捕获真实退出码
  # cwd 必须设为 CLI_PACKAGE_ROOT，否则 tsx 解析 @vegamo/deepcode-core 时
  # 会因找不到 packages/core/dist/eag/long-horizon.js 而失败
  set +e
  (cd "$CLI_PACKAGE_ROOT" && node --import tsx "$cli_path" quality-check "$@") >"$tmp_out" 2>"$tmp_err"
  LAST_EXIT_CODE=$?
  set -e
  LAST_STDOUT="$(cat "$tmp_out")"
  LAST_STDERR="$(cat "$tmp_err")"
  rm -f "$tmp_out" "$tmp_err"
}

# 断言函数
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

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local label="${3:-输出}"
  if [[ "$haystack" != *"$needle"* ]]; then
    return 0
  else
    echo "断言失败: $label 不应包含 '$needle'" >&2
    return 1
  fi
}

# 测试包装器：自动计时与结果打印
run_test() {
  local test_name="$1"
  shift
  local start_time end_time duration
  start_time=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000000000))')

  # 使用 $$（shell PID）作为临时错误文件后缀，避免并发冲突
  # 注意：路径中不能出现 "$$".txt 这样的写法，否则双引号会被解析为字符串开始
  local err_file="/tmp/test-error-$$.txt"
  if "$@" 2>"$err_file"; then
    end_time=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000000000))')
    duration=$(( (end_time - start_time) / 1000000 ))
    print_pass "$test_name" "$duration"
  else
    end_time=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000000000))')
    duration=$(( (end_time - start_time) / 1000000 ))
    local reason
    reason="$(cat "$err_file" 2>/dev/null || echo '未知错误')"
    print_fail "$test_name" "$reason" "$duration"
  fi
  rm -f "$err_file"
}

# ----------------------------------------------------------------------------
# Fixtures：真实项目结构构造
# ----------------------------------------------------------------------------

# 创建多语言项目（TypeScript + JavaScript + Python）
create_multi_language_project() {
  local project_root="$1"
  mkdir -p "$project_root/src" "$project_root/scripts" "$project_root/node_modules/fake-lib" "$project_root/dist"

  # TypeScript 主入口
  cat > "$project_root/src/index.ts" << 'EOF'
import { User } from "./user";
import { greet } from "./utils";

export function main(): string {
  const u = new User("alice");
  return greet(u.name);
}

main();
EOF

  # TypeScript 类
  cat > "$project_root/src/user.ts" << 'EOF'
export class User {
  public name: string;
  constructor(name: string) { this.name = name; }
  public greet(): string { return "hi, " + this.name; }
}
EOF

  # TypeScript 工具函数
  cat > "$project_root/src/utils.ts" << 'EOF'
export function greet(name: string): string {
  if (!name) return 'anon';
  return `hello, ${name}`;
}
EOF

  # JavaScript 文件
  cat > "$project_root/src/helper.js" << 'EOF'
function helper() { return 'helper'; }
module.exports = { helper };
EOF

  # Python 脚本
  cat > "$project_root/scripts/build.py" << 'EOF'
def main():
    print('building...')

if __name__ == '__main__':
    main()
EOF

  # node_modules 中的假库（应被跳过）
  echo "module.exports = function() { return 'fake'; };" > "$project_root/node_modules/fake-lib/index.js"

  # dist 构建产物（应被跳过）
  echo "console.log('built');" > "$project_root/dist/bundle.js"

  # 非代码文件
  echo "# Test Project" > "$project_root/README.md"
}

# 创建 DOM 数据 JSON 文件（含 a11y 问题）
create_dom_audit_file() {
  local dir="$1"
  local filename="${2:-dom.json}"
  cat > "$dir/$filename" << 'EOF'
{
  "images": [
    {"tag":"img","selector":"img.hero","alt":null,"src":"hero.png","natural_width":800,"natural_height":400,"complete":true},
    {"tag":"img","selector":"img.logo","alt":"Logo","src":"logo.png","natural_width":120,"natural_height":60,"complete":true}
  ],
  "form_controls": [
    {"tag":"input","type":"text","id":"username","name":"username","selector":"input#username","has_label":false,"has_aria_label":false,"has_aria_labelledby":false,"required":true,"placeholder":"请输入用户名"}
  ],
  "buttons": [
    {"selector":"button.submit","text":"提交","width":120,"height":44,"visible":true,"disabled":false},
    {"selector":"button.small","text":"X","width":20,"height":20,"visible":true,"disabled":false}
  ],
  "links": [{"selector":"a.help","text":"查看帮助","href":"/help","target":null}],
  "headings": [{"level":1,"text":"登录"}],
  "errors": []
}
EOF
  echo "$dir/$filename"
}

# ----------------------------------------------------------------------------
# 测试用例
# ----------------------------------------------------------------------------

# 测试 A1: help 子命令
test_a1_help() {
  run_quality_cli "help"
  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
  # yargs 会先输出自己的 help，然后 cli.tsx 输出 formatQualityHelp()
  if [[ "$LAST_STDOUT" == *"DeepCodeX Quality Check"* ]] || [[ "$LAST_STDOUT" == *"Quality gate"* ]]; then
    return 0
  else
    echo "断言失败: stdout 应包含帮助文本标识，实际: ${LAST_STDOUT:0:200}" >&2
    return 1
  fi
}

# 测试 B1: codemap 对真实项目生成代码地图
test_b1_codemap_basic() {
  local project_root
  project_root="$(create_tmp_dir e2e-codemap-basic)"
  create_multi_language_project "$project_root"
  run_quality_cli "codemap" "$project_root"
  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
  assert_contains "$LAST_STDOUT" "Code Map:" "stdout" || return 1
}

# 测试 B2: codemap JSON 格式
test_b2_codemap_json() {
  local project_root
  project_root="$(create_tmp_dir e2e-codemap-json)"
  create_multi_language_project "$project_root"
  run_quality_cli "codemap" "$project_root" "--format" "json"
  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
  # 验证 JSON 可解析
  if ! echo "$LAST_STDOUT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'stats' in d; assert d['stats']['fileCount'] > 0" 2>/dev/null; then
    echo "断言失败: stdout 应为可解析的 JSON，包含 stats.fileCount > 0" >&2
    return 1
  fi
}

# 测试 B3: codemap --output 写入文件
test_b3_codemap_output() {
  local project_root output_path
  project_root="$(create_tmp_dir e2e-codemap-output)"
  create_multi_language_project "$project_root"
  output_path="$project_root/code-map.md"
  run_quality_cli "codemap" "$project_root" "--format" "markdown" "--output" "$output_path"
  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
  if [[ ! -f "$output_path" ]]; then
    echo "断言失败: 输出文件应存在: $output_path" >&2
    return 1
  fi
  local file_content
  file_content="$(cat "$output_path")"
  assert_contains "$file_content" "Code Map:" "输出文件内容" || return 1
}

# 测试 B4: codemap --skip-dirs 跳过指定目录
test_b4_codemap_skip_dirs() {
  local project_root
  project_root="$(create_tmp_dir e2e-codemap-skip)"
  create_multi_language_project "$project_root"
  run_quality_cli "codemap" "$project_root" "--format" "json" "--skip-dirs" "node_modules,dist"
  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
  # 验证 node_modules 和 dist 中的文件未被扫描
  if echo "$LAST_STDOUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
files = [n for n in d.get('nodes',[]) if n.get('kind')=='file']
has_nm = any('node_modules' in n.get('relativePath','') for n in files)
has_dist = any(n.get('relativePath','').startswith('dist/') for n in files)
assert not has_nm, '不应扫描 node_modules'
assert not has_dist, '不应扫描 dist'
" 2>/dev/null; then
    return 0
  else
    echo "断言失败: 不应扫描 node_modules 和 dist" >&2
    return 1
  fi
}

# 测试 B5: codemap 多语言项目语言分布
test_b5_codemap_multilang() {
  local project_root
  project_root="$(create_tmp_dir e2e-codemap-multilang)"
  create_multi_language_project "$project_root"
  run_quality_cli "codemap" "$project_root" "--format" "json" "--skip-dirs" "node_modules,dist"
  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
  if echo "$LAST_STDOUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
langs = list(d.get('stats',{}).get('languageBreakdown',{}).keys())
assert 'typescript' in langs, f'应识别 typescript: {langs}'
assert 'javascript' in langs, f'应识别 javascript: {langs}'
assert 'python' in langs, f'应识别 python: {langs}'
" 2>/dev/null; then
    return 0
  else
    echo "断言失败: 应识别 typescript/javascript/python 三种语言" >&2
    return 1
  fi
}

# 测试 C1: uiux 真实巡检（含 a11y 问题）
test_c1_uiux_basic() {
  local project_root dom_file
  project_root="$(create_tmp_dir e2e-uiux-basic)"
  dom_file="$(create_dom_audit_file "$project_root")"
  run_quality_cli "uiux" "--dom-file" "$dom_file"
  # DOM 中有 a11y 问题（img 无 alt + input 无 label + 按钮过小），exitCode=1
  assert_equal "$LAST_EXIT_CODE" "1" "退出码" || return 1
  assert_contains "$LAST_STDOUT" "UI/UX" "stdout" || return 1
}

# 测试 C2: uiux 缺 --dom-file 时 exitCode=2
test_c2_uiux_missing_param() {
  run_quality_cli "uiux"
  assert_equal "$LAST_EXIT_CODE" "2" "退出码" || return 1
  # stderr 应有错误信息
  if [[ -z "$LAST_STDERR" ]]; then
    echo "断言失败: stderr 应有错误信息" >&2
    return 1
  fi
}

# 测试 C3: uiux 文件不存在时 exitCode=2
test_c3_uiux_missing_file() {
  run_quality_cli "uiux" "--dom-file" "/tmp/nonexistent-dom-file.json"
  assert_equal "$LAST_EXIT_CODE" "2" "退出码" || return 1
}

# 测试 D1: visual 缺 --current 时 exitCode=2
test_d1_visual_missing_param() {
  run_quality_cli "visual"
  assert_equal "$LAST_EXIT_CODE" "2" "退出码" || return 1
}

# 测试 E1: all 子命令（仅 codemap 可用）
test_e1_all_codemap_only() {
  local project_root
  project_root="$(create_tmp_dir e2e-all-codemap-only)"
  create_multi_language_project "$project_root"
  run_quality_cli "all" "--project-root" "$project_root"
  # codemap 通过，uiux/visual 因缺少必填参数被跳过，exitCode=0
  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
  assert_contains "$LAST_STDOUT" "Code Map" "stdout" || return 1
}

# 测试 E2: all 子命令全量检查（含 uiux 失败）
test_e2_all_with_uiux() {
  local project_root dom_file
  project_root="$(create_tmp_dir e2e-all-full)"
  create_multi_language_project "$project_root"
  dom_file="$(create_dom_audit_file "$project_root")"
  run_quality_cli "all" "--dom-file" "$dom_file" "--project-root" "$project_root"
  # codemap 通过(0) + uiux 失败(1) → exitCode=max(0,1)=1
  assert_equal "$LAST_EXIT_CODE" "1" "退出码" || return 1
  assert_contains "$LAST_STDOUT" "Code Map" "stdout" || return 1
  assert_contains "$LAST_STDOUT" "UI/UX" "stdout" || return 1
}

# 测试 F1: 未知子命令返回非零退出码
test_f1_unknown_subcommand() {
  run_quality_cli "unknown-sub"
  # yargs choices 校验失败返回 exitCode=1
  if [[ "$LAST_EXIT_CODE" -ne 0 ]]; then
    return 0
  else
    echo "断言失败: 未知子命令应返回非零退出码，实际: $LAST_EXIT_CODE" >&2
    return 1
  fi
}

# 测试 F2: codemap 路径不存在 exitCode=2
test_f2_codemap_missing_path() {
  run_quality_cli "codemap" "/nonexistent/path/that/does/not/exist"
  assert_equal "$LAST_EXIT_CODE" "2" "退出码" || return 1
}

# 测试 G1: 退出码 0（检查通过）
test_g1_exit_zero() {
  local project_root
  project_root="$(create_tmp_dir e2e-exit-0)"
  create_multi_language_project "$project_root"
  run_quality_cli "codemap" "$project_root"
  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
}

# 测试 G2: 退出码 1（检查未通过）
test_g2_exit_one() {
  local project_root dom_file
  project_root="$(create_tmp_dir e2e-exit-1)"
  dom_file="$(create_dom_audit_file "$project_root")"
  run_quality_cli "uiux" "--dom-file" "$dom_file"
  assert_equal "$LAST_EXIT_CODE" "1" "退出码" || return 1
}

# 测试 H1: stdout/stderr 分离
test_h1_stdout_stderr_separation() {
  local project_root
  project_root="$(create_tmp_dir e2e-stdout-stderr)"
  create_multi_language_project "$project_root"
  run_quality_cli "codemap" "$project_root"
  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
  if [[ -z "$LAST_STDOUT" ]]; then
    echo "断言失败: stdout 应有内容" >&2
    return 1
  fi
  if [[ -n "$LAST_STDERR" ]]; then
    echo "断言失败: stderr 应为空，实际: $LAST_STDERR" >&2
    return 1
  fi
}

# 测试 H2: --quiet + --output 模式
test_h2_quiet_with_output() {
  local project_root output_path
  project_root="$(create_tmp_dir e2e-quiet)"
  create_multi_language_project "$project_root"
  output_path="$project_root/map.md"
  run_quality_cli "codemap" "$project_root" "--quiet" "--output" "$output_path"
  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
  assert_contains "$LAST_STDOUT" "✅" "stdout（应含结论行）" || return 1
  assert_not_contains "$LAST_STDOUT" "文件数:" "stdout（--quiet 不应含统计详情）" || return 1
  if [[ ! -f "$output_path" ]]; then
    echo "断言失败: 输出文件应存在" >&2
    return 1
  fi
}

# 测试 I1: 完整工作流（codemap → uiux）
test_i1_full_workflow() {
  local project_root dom_file
  project_root="$(create_tmp_dir e2e-full-workflow)"
  create_multi_language_project "$project_root"
  dom_file="$(create_dom_audit_file "$project_root")"

  # 步骤 1: codemap
  run_quality_cli "codemap" "$project_root" "--format" "json"
  assert_equal "$LAST_EXIT_CODE" "0" "codemap 退出码" || return 1

  # 步骤 2: uiux
  run_quality_cli "uiux" "--dom-file" "$dom_file" "--format" "json"
  assert_equal "$LAST_EXIT_CODE" "1" "uiux 退出码（应失败）" || return 1
}

# 测试 I2: 大型项目性能验证（< 30s）
test_i2_large_project_performance() {
  local project_root src_dir
  project_root="$(create_tmp_dir e2e-large-project)"
  src_dir="$project_root/src"
  mkdir -p "$src_dir"

  # 生成 15 个 TypeScript 文件
  for i in $(seq 1 15); do
    cat > "$src_dir/module-$i.ts" << EOF
export class Module$i {
  private value: number;
  constructor(v: number) { this.value = v; }
  public compute(): number {
    let result = this.value;
    for (let j = 0; j < 10; j++) { result += j * $i; }
    return result;
  }
}
EOF
  done

  local start_time end_time duration
  start_time=$(date +%s)
  run_quality_cli "codemap" "$project_root" "--format" "json"
  end_time=$(date +%s)
  duration=$((end_time - start_time))

  assert_equal "$LAST_EXIT_CODE" "0" "退出码" || return 1
  if [[ $duration -ge 30 ]]; then
    echo "断言失败: 应在 30s 内完成，实际: ${duration}s" >&2
    return 1
  fi
}

# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------

echo -e "${BLUE}============================================================${NC}"
echo -e "${BLUE}quality-check CLI 顶级命令 Shell E2E 测试${NC}"
echo -e "${BLUE}============================================================${NC}"
echo ""
echo "CLI 路径: $CLI_PACKAGE_ROOT/src/cli.tsx"
echo ""

# 检查 node 与 tsx 是否可用
if ! command -v node &>/dev/null; then
  echo -e "${RED}错误: node 命令不可用${NC}" >&2
  exit 1
fi

if ! node -e "require.resolve('tsx')" 2>/dev/null; then
  if ! [[ -d "$CLI_PACKAGE_ROOT/../../node_modules/tsx" ]]; then
    echo -e "${YELLOW}警告: tsx 模块可能未安装，测试可能失败${NC}" >&2
  fi
fi

echo -e "${BLUE}--- 开始执行测试 ---${NC}"
echo ""

# 执行所有测试
run_test "A1: help 子命令（exitCode=0）" test_a1_help
run_test "B1: codemap 对真实项目生成代码地图" test_b1_codemap_basic
run_test "B2: codemap --format json 输出可解析 JSON" test_b2_codemap_json
run_test "B3: codemap --output 写入文件" test_b3_codemap_output
run_test "B4: codemap --skip-dirs 跳过指定目录" test_b4_codemap_skip_dirs
run_test "B5: codemap 多语言项目语言分布" test_b5_codemap_multilang
run_test "C1: uiux 真实巡检（含 a11y 问题，exitCode=1）" test_c1_uiux_basic
run_test "C2: uiux 缺 --dom-file（exitCode=2）" test_c2_uiux_missing_param
run_test "C3: uiux 文件不存在（exitCode=2）" test_c3_uiux_missing_file
run_test "D1: visual 缺 --current（exitCode=2）" test_d1_visual_missing_param
run_test "E1: all 子命令仅 codemap 可用（exitCode=0）" test_e1_all_codemap_only
run_test "E2: all 全量检查（含 uiux 失败，exitCode=1）" test_e2_all_with_uiux
run_test "F1: 未知子命令返回非零退出码" test_f1_unknown_subcommand
run_test "F2: codemap 路径不存在（exitCode=2）" test_f2_codemap_missing_path
run_test "G1: 退出码 0（检查通过）" test_g1_exit_zero
run_test "G2: 退出码 1（检查未通过）" test_g2_exit_one
run_test "H1: stdout/stderr 分离" test_h1_stdout_stderr_separation
run_test "H2: --quiet + --output 模式" test_h2_quiet_with_output
run_test "I1: 完整工作流（codemap → uiux）" test_i1_full_workflow
run_test "I2: 大型项目性能验证（< 30s）" test_i2_large_project_performance

echo ""
echo -e "${BLUE}--- 测试结果汇总 ---${NC}"
echo ""
echo -e "总测试数: ${TOTAL_COUNT}"
echo -e "${GREEN}通过: ${PASS_COUNT}${NC}"
echo -e "${RED}失败: ${FAIL_COUNT}${NC}"
echo -e "${YELLOW}跳过: ${SKIP_COUNT}${NC}"
echo ""

if [[ $FAIL_COUNT -eq 0 ]]; then
  echo -e "${GREEN}============================================================${NC}"
  echo -e "${GREEN}✅ 所有测试通过！${NC}"
  echo -e "${GREEN}============================================================${NC}"
  exit 0
else
  echo -e "${RED}============================================================${NC}"
  echo -e "${RED}❌ 有 ${FAIL_COUNT} 个测试失败${NC}"
  echo -e "${RED}============================================================${NC}"
  exit 1
fi
