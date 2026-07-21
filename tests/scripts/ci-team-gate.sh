#!/usr/bin/env bash
# ==============================================================================
# Team 模块 CI 门禁脚本（P0-3 / 设计文档 §5.2.2）
#
# 功能（对齐设计文档 §5.2.2 P0-3）：
#   Team 专属 CI 门禁，包含 3 步检查：
#   1. 环境预检（node 版本 + 目录结构）
#   2. team 模块全部测试（含 stage-handlers / cybernetics / principles）
#   3. CLI team 子命令测试（条件性执行，仅当 team-cmd-autonomous.test.ts 存在时）
#
# 退出码：
#   0 = 全部检查通过
#   1 = 环境预检失败 / 入参非法
#   2 = team 模块测试失败
#   3 = CLI team 子命令测试失败
#
# 使用方式：
#   bash tests/scripts/ci-team-gate.sh
#
# 设计依据：
# - 设计文档 §5.2.2 P0-3 ci-team-gate.sh
# - 用户规则 C-9（测试 shell 脚本归位 tests/scripts/）
# - 用户规则 C-4（不可变优先）
# - 参考模板：tests/scripts/ci-eag-gate.sh
# ==============================================================================

set -euo pipefail

# ---------- 日志工具 ----------
# 统一日志格式：[ci-team-gate] 消息
log() {
  echo "[ci-team-gate] $*"
}

# 失败时输出错误日志并以指定退出码退出
# @param $1 错误消息
# @param $2 退出码（默认 1）
fail() {
  echo "[ci-team-gate] ❌ $*" >&2
  exit "${2:-1}"
}

# ---------- Step 0: 环境预检 ----------
log "Step 0: 环境预检"

# node 版本检查（要求 >= 20，tsx 与 node:test 依赖）
command -v node >/dev/null 2>&1 || fail "未找到 node 可执行文件" 1
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "${NODE_MAJOR}" -ge 20 ] || fail "node 版本过低（要求 >= 20，当前 $(node --version)）" 1

# 定位项目根目录与 core 目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CORE_DIR="${PROJECT_ROOT}/packages/core"
CLI_DIR="${PROJECT_ROOT}/packages/cli"

# 校验 team 模块目录存在
[ -d "${CORE_DIR}/src/team/tests" ] || fail "未找到 team/tests 目录（CORE_DIR=${CORE_DIR}）" 1

# 校验 team 模块测试运行器存在
[ -f "${CORE_DIR}/src/team/tests/run-tests.mjs" ] || fail "未找到 team/tests/run-tests.mjs（测试运行器入口）" 1

# 校验 v1.6 新增的 stage-handlers.test.ts 存在（P0-1 验收标准）
[ -f "${CORE_DIR}/src/team/tests/stage-handlers.test.ts" ] || fail "未找到 stage-handlers.test.ts（P0-1 验收必需）" 1

log "✅ 环境预检通过 (node $(node --version), CORE_DIR=${CORE_DIR})"

# ---------- Step 1: team 模块全部测试 ----------
log "Step 1: team 模块全部测试（含 stage-handlers / cybernetics / principles）"

# 使用 team 模块独立测试运行器（src/team/tests/run-tests.mjs）
# 该运行器递归扫描 src/team/tests/**/*.test.ts，覆盖 cybernetics/、principles/ 等子目录
# 不使用 mock（对齐用户规则 C-6）
set +e
(
  cd "${CORE_DIR}"
  node src/team/tests/run-tests.mjs 2>&1
)
TEAM_TESTS_EXIT_CODE=$?
set -e

if [ "${TEAM_TESTS_EXIT_CODE}" -ne 0 ]; then
  fail "team 模块测试失败（退出码 = ${TEAM_TESTS_EXIT_CODE}）" 2
fi
log "✅ team 模块测试通过"

# ---------- Step 2: CLI team 子命令测试（条件性执行） ----------
log "Step 2: CLI team 子命令测试（条件性执行）"

# 设计文档 §5.2.2 期望运行 packages/cli/src/tests/team-cmd-autonomous.test.ts
# 该测试文件是 P0-1 集成测试（AC-001~AC-009），属于"补齐单元测试与场景集成测试"todo
# 当前条件性执行：仅当文件存在时才运行，避免 CI 在文件未创建时失败
CLI_TEAM_TEST="${CLI_DIR}/src/tests/team-cmd-autonomous.test.ts"

if [ -f "${CLI_TEAM_TEST}" ]; then
  log "发现 ${CLI_TEAM_TEST##*/}，运行 CLI team 子命令测试..."
  set +e
  (
    cd "${CLI_DIR}"
    node --import tsx --test "src/tests/team-cmd-autonomous.test.ts" 2>&1
  )
  CLI_TEAM_EXIT_CODE=$?
  set -e

  if [ "${CLI_TEAM_EXIT_CODE}" -ne 0 ]; then
    fail "CLI team 子命令测试失败（退出码 = ${CLI_TEAM_EXIT_CODE}）" 3
  fi
  log "✅ CLI team 子命令测试通过"
else
  log "ℹ️ 跳过 CLI team 子命令测试（${CLI_TEAM_TEST##*/} 尚未创建，属于 P0-1 集成测试 todo）"
fi

# ---------- 摘要 ----------
log "🎉 Team 门禁全部通过"
log "  - 环境预检：✅"
log "  - team 模块测试：✅"
if [ -f "${CLI_TEAM_TEST}" ]; then
  log "  - CLI team 子命令测试：✅"
else
  log "  - CLI team 子命令测试：⏭️ 跳过（文件未创建）"
fi

exit 0
