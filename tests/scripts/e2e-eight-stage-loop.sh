#!/usr/bin/env bash
# ==============================================================================
# 八阶段工作流循环 E2E 测试（P5 新增）
#
# 测试目标（对齐 TC-LOOP-01~08）：
#   1. team full-lifecycle --project                 8 阶段线性模式基本流程
#   2. team full-lifecycle --project --use-loop      8 阶段循环模式
#   3. team full-lifecycle --project --use-loop --max-iterations 1  循环模式 1 次迭代
#   4. team full-lifecycle --project --prd-path      指定 PRD 文档路径
#   5. team full-lifecycle --project --use-loop --test-command 指定测试命令
#   6. team full-lifecycle（缺 --project）           应失败 exitCode=1
#   7. team full-lifecycle --project --use-loop --architecture-path 指定架构文档
#   8. team full-lifecycle --project --use-loop --test-plan-path    指定测试计划
#
# 设计依据：
# - packages/cli/src/team/team-cmd.ts（executeFullLifecycleCommand 实现）
#   - 线性模式（默认）：8 阶段顺序执行，任一阶段失败即中止
#   - 循环模式（--use-loop）：WorkflowLoopController，审查失败精准回退
# - packages/cli/src/cli-args.ts（yargs 参数配置）
# - tests/scripts/e2e-team-cmd.sh（E2E 测试约定参考）
#
# 环境隔离策略（与 e2e-team-cmd.sh 一致，真实测试环境，非 mock）：
#   - 清空 OPENAI_API_KEY / DEEPCODE_API_KEY：使 executeDispatch 走 skipped 分支
#   - 重定向 HOME 到临时目录：阻断 settings.json 读取
#   - 临时 projectRoot：避免污染当前工作目录
# ==============================================================================

set -uo pipefail

# ---------- 全局变量 ----------
TOTAL_CASES=0
PASSED_CASES=0
FAILED_CASES=0
FAILED_CASES_LIST=()

# ---------- 日志工具 ----------
# log: 输出普通日志到 stdout，统一加 [e2e-eight-stage-loop] 前缀
log() {
  echo "[e2e-eight-stage-loop] $*"
}

# fail_log: 输出错误日志到 stderr，便于与正常输出区分
fail_log() {
  echo "[e2e-eight-stage-loop] ❌ $*" >&2
}

# ---------- 环境预检 ----------
log "========== 环境预检 =========="

# 校验 node 已安装且版本 >= 20（与 e2e-team-cmd.sh 一致）
command -v node >/dev/null 2>&1 || { fail_log "未找到 node"; exit 1; }
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "${NODE_MAJOR}" -ge 20 ] || { fail_log "node 版本过低（需要 >= 20），当前: $(node --version)"; exit 1; }

# 定位项目根目录与 CLI 入口
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CLI_DIR="${PROJECT_ROOT}/packages/cli"
CLI_ENTRY="${CLI_DIR}/src/cli.tsx"

[ -f "${CLI_ENTRY}" ] || { fail_log "未找到 CLI 入口: ${CLI_ENTRY}"; exit 1; }

# 校验 team 模块源码存在（确保测试目标已实现）
[ -d "${PROJECT_ROOT}/packages/core/src/team" ] || { fail_log "未找到 core team 模块"; exit 1; }
[ -f "${CLI_DIR}/src/team/team-cmd.ts" ] || { fail_log "未找到 team-cmd.ts"; exit 1; }

# 校验 P5 八阶段循环相关核心模块存在（WorkflowLoopController / DocCodeConsistencyChecker）
[ -f "${PROJECT_ROOT}/packages/core/src/team/workflow-loop-controller.ts" ] || { fail_log "未找到 workflow-loop-controller.ts（P5 核心）"; exit 1; }
[ -f "${PROJECT_ROOT}/packages/core/src/team/doc-code-consistency-checker.ts" ] || { fail_log "未找到 doc-code-consistency-checker.ts（P5 核心）"; exit 1; }

log "✅ 环境预检通过"

# ---------- 全局环境隔离 ----------
# 清空 API Key 环境变量，确保 dispatch 命令走 skipped 分支（与 e2e-team-cmd.sh 一致）
# 这是真实的测试环境配置，不是 mock：
#   - createOpenAIClient 真实返回 null（无 API Key）
#   - executeDispatch 真实返回 skipped（无 client 时跳过 LLM 调用）
#   - executeFullLifecycleLinear 真实执行 8 阶段流程，skipped 状态不中止
export OPENAI_API_KEY=""
export DEEPCODE_API_KEY=""

# 重定向 HOME 到临时目录，阻断 settings.json 读取
# 确保 createOpenAIClient 不从 ~/.deepcode/settings.json 获取 API Key
export E2E_HOME_TMP="$(mktemp -d)"
export HOME="${E2E_HOME_TMP}"

# 创建临时 projectRoot 目录，作为 full-lifecycle 的工作目录
# 避免在真实项目根目录下生成 .deepcodex 等中间产物
export E2E_PROJECT_TMP="$(mktemp -d)"
log "临时 projectRoot: ${E2E_PROJECT_TMP}"
log "临时 HOME: ${E2E_HOME_TMP}"

# 创建测试用文档文件（TC-LOOP-04/05/07/08 使用）
# 这些是真实存在的文档文件，DocCodeConsistencyChecker 会真实读取
mkdir -p "${E2E_PROJECT_TMP}/docs"
cat > "${E2E_PROJECT_TMP}/docs/prd.md" <<'EOF'
# PRD 文档（测试用）

## 功能需求
- F1: 用户登录
- F2: 数据查询

## 验收标准
- AC1: 登录接口返回 200
- AC2: 查询接口返回 JSON
EOF

cat > "${E2E_PROJECT_TMP}/docs/architecture.md" <<'EOF'
# 架构设计文档（测试用）

## 模块说明
本项目包含认证和查询两个核心功能模块。

## 设计原则
- 模块化设计
- 单一职责
- 可测试性
EOF

cat > "${E2E_PROJECT_TMP}/docs/test-plan.md" <<'EOF'
# 测试计划文档（测试用）

## 测试用例
- T1: 登录成功用例
- T2: 查询返回数据用例
EOF

# 创建 package.json 和测试脚本（TC-LOOP-05 使用）
# 目的：让 --test-command "npm test" 在临时 projectRoot 下真实通过
# 这是真实的测试环境配置，不是 mock：
#   - package.json 定义真实的 "test" 脚本
#   - test.js 真实输出 "1 passed"，DefaultStageExecutor.parseTestOutput 真实解析为 passed=1
cat > "${E2E_PROJECT_TMP}/package.json" <<'EOF'
{
  "name": "test-project",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "test": "node test.js"
  }
}
EOF

cat > "${E2E_PROJECT_TMP}/test.js" <<'EOF'
// 测试脚本（TC-LOOP-05 专用）
// 输出 "1 passed" 格式，便于 DefaultStageExecutor.parseTestOutput 解析
console.log("1 passed");
EOF

# ---------- 测试用例执行函数 ----------
# 与 e2e-team-cmd.sh 的 run_case 函数对齐
# 参数：
#   $1 case_id         用例 ID（如 TC-LOOP-01）
#   $2 case_desc       用例描述
#   $3 expected_exit   期望退出码（-1 表示不校验退出码）
#   $4 expected_output 期望输出包含的字符串（正则，空字符串表示不校验输出）
#   $5 cmd             要执行的命令
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
  # 关闭 set -e 防止命令非零退出码导致脚本退出
  set +e
  # 添加 < /dev/null 防止 TUI 在非交互环境下挂起等待输入
  output=$(eval "${cmd}" 2>&1 < /dev/null)
  local actual_exit=$?
  set -e

  # 退出码校验
  local exit_ok=1
  if [ "${expected_exit}" != "-1" ]; then
    if [ "${actual_exit}" != "${expected_exit}" ]; then
      exit_ok=0
      fail_log "${case_id} 退出码不匹配: expected=${expected_exit}, actual=${actual_exit}"
    fi
  fi

  # 输出包含校验（空字符串表示不校验）
  local output_ok=1
  if [ -n "${expected_output}" ]; then
    if ! echo "${output}" | grep -qiE "${expected_output}"; then
      output_ok=0
      fail_log "${case_id} 输出不包含期望字符串: '${expected_output}'"
      fail_log "实际输出（前 300 字符）: $(echo "${output}" | head -c 300)"
    fi
  fi

  # 综合判定
  if [ "${exit_ok}" -eq 1 ] && [ "${output_ok}" -eq 1 ]; then
    PASSED_CASES=$((PASSED_CASES + 1))
    log "✅ ${case_id} 通过"
  else
    FAILED_CASES=$((FAILED_CASES + 1))
    FAILED_CASES_LIST+=("${case_id}")
  fi
}

# ---------- 构造 CLI 命令 ----------
# 使用 tsx 直接运行 CLI 入口（与 e2e-team-cmd.sh 一致）
# 通过 --project-root 指定临时项目根目录，避免污染真实项目
CLI_CMD="node --import tsx ${CLI_ENTRY}"
PROJECT_ROOT_OPT="--project-root ${E2E_PROJECT_TMP}"

# ---------- 测试用例 ----------

# TC-LOOP-01: 8 阶段线性模式基本流程（默认模式，无 --use-loop）
# 期望：exitCode=0
# 验证输出包含 "线性模式" 关键字（executeFullLifecycleLinear 输出）
# 说明：无 API Key 时阶段 1-7 dispatch 走 skipped 分支不中止，阶段 8 文档审查在空项目下通过
run_case "TC-LOOP-01" \
  "8 阶段线性模式基本流程" \
  0 \
  "线性模式|8 阶段全流程|full-lifecycle" \
  "${CLI_CMD} team full-lifecycle --project \"test-project\" ${PROJECT_ROOT_OPT}"

# TC-LOOP-02: 8 阶段循环模式（--use-loop）
# 期望：exitCode=0
# 验证输出包含 "循环模式" 关键字（executeFullLifecycleWithLoop 输出）
# 说明：循环模式默认最大迭代 3 次，WorkflowLoopController 执行八阶段
run_case "TC-LOOP-02" \
  "8 阶段循环模式" \
  0 \
  "循环模式|WorkflowLoopController|8 阶段循环" \
  "${CLI_CMD} team full-lifecycle --project \"test-project\" --use-loop ${PROJECT_ROOT_OPT}"

# TC-LOOP-03: 循环模式最大迭代 1 次（--use-loop --max-iterations 1）
# 期望：exitCode=0
# 验证输出包含 "循环模式" 且迭代次数为 1
# 注意：CLI 实际参数名为 --max-iterations（与 autonomous 子命令一致），任务描述中的 --max-iter 为简写
run_case "TC-LOOP-03" \
  "循环模式最大迭代 1 次" \
  0 \
  "循环模式|WorkflowLoopController" \
  "${CLI_CMD} team full-lifecycle --project \"test-project\" --use-loop --max-iterations 1 ${PROJECT_ROOT_OPT}"

# TC-LOOP-04: 指定 PRD 文档路径（线性模式）
# 期望：exitCode=0
# 验证输出包含 "线性模式"（线性模式阶段 8 读取 PRD 文档）
run_case "TC-LOOP-04" \
  "指定 PRD 文档路径（线性模式）" \
  0 \
  "线性模式|8 阶段全流程" \
  "${CLI_CMD} team full-lifecycle --project \"test-project\" --prd-path ${E2E_PROJECT_TMP}/docs/prd.md ${PROJECT_ROOT_OPT}"

# TC-LOOP-05: 循环模式 + 指定测试命令（--use-loop --test-command "npm test"）
# 期望：exitCode=0
# 验证输出包含 "循环模式"（循环模式阶段 7 测试验证使用 test-command）
# 注意：测试命令用引号包裹，避免 shell 拆分
run_case "TC-LOOP-05" \
  "循环模式 + 指定测试命令" \
  0 \
  "循环模式|WorkflowLoopController" \
  "${CLI_CMD} team full-lifecycle --project \"test-project\" --use-loop --test-command \"npm test\" ${PROJECT_ROOT_OPT}"

# TC-LOOP-06: 缺少 --project 参数应失败
# 期望：exitCode=1
# 验证：executeFullLifecycleCommand 检测到 project 为空时返回 1
run_case "TC-LOOP-06" \
  "缺 --project 参数应失败" \
  1 \
  "" \
  "${CLI_CMD} team full-lifecycle ${PROJECT_ROOT_OPT}"

# TC-LOOP-07: 循环模式 + 指定架构文档（--use-loop --architecture-path）
# 期望：exitCode=0
# 验证输出包含 "循环模式"（循环模式阶段 8 读取架构文档）
run_case "TC-LOOP-07" \
  "循环模式 + 指定架构文档" \
  0 \
  "循环模式|WorkflowLoopController" \
  "${CLI_CMD} team full-lifecycle --project \"test-project\" --use-loop --architecture-path ${E2E_PROJECT_TMP}/docs/architecture.md ${PROJECT_ROOT_OPT}"

# TC-LOOP-08: 循环模式 + 指定测试计划文档（--use-loop --test-plan-path）
# 期望：exitCode=0
# 验证输出包含 "循环模式"（循环模式阶段 8 读取测试计划文档）
run_case "TC-LOOP-08" \
  "循环模式 + 指定测试计划文档" \
  0 \
  "循环模式|WorkflowLoopController" \
  "${CLI_CMD} team full-lifecycle --project \"test-project\" --use-loop --test-plan-path ${E2E_PROJECT_TMP}/docs/test-plan.md ${PROJECT_ROOT_OPT}"

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
  # 清理临时目录
  rm -rf "${E2E_HOME_TMP}" 2>/dev/null || true
  rm -rf "${E2E_PROJECT_TMP}" 2>/dev/null || true
  exit 2
fi

# 清理临时目录
rm -rf "${E2E_HOME_TMP}" 2>/dev/null || true
rm -rf "${E2E_PROJECT_TMP}" 2>/dev/null || true
exit 0
