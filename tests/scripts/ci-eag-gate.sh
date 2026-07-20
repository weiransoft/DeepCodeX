#!/usr/bin/env bash
# ==============================================================================
# EAG-P3 批次 12 CI EAG 门禁脚本（C3 CI 强化）
#
# 功能（对齐设计文档 §5.6 / §5.1 D-C3-9 / D-C3-14）：
#   EAG 专属 CI 门禁，包含 4 步检查：
#   1. fixtures 完整性校验（落地遗留 L-5：validateTcsFixtures() 纳入 CI）
#   2. EAG 静态扫描（tsc --noEmit --strict）
#   3. EAG 集成测试（批次 9/10/11/12/13 集成测试）
#   4. 全量回归测试（packages/core 全部单元测试）
#
# 退出码：
#   0 = 全部检查通过
#   1 = 环境预检失败 / 入参非法
#   2 = fixtures 完整性失败
#   3 = EAG 静态扫描失败
#   4 = EAG 集成测试失败
#   5 = 全量回归测试失败
#
# 使用方式：
#   bash tests/scripts/ci-eag-gate.sh
#
# 设计依据：
# - EAG-P3 批次 12 设计文档 §5.6 ci-eag-gate.sh
# - EAG-P3 批次 12 设计文档 §5.1 D-C3-9 / D-C3-14
# - 用户规则 C-9（测试 shell 脚本归位 tests/scripts/）
# - 用户规则 C-4（不可变优先）
# ==============================================================================

set -euo pipefail

# ---------- 日志工具 ----------
# 统一日志格式：[ci-eag-gate] 消息
log() {
  echo "[ci-eag-gate] $*"
}

# 失败时输出错误日志并以指定退出码退出
# @param $1 错误消息
# @param $2 退出码（默认 1）
fail() {
  echo "[ci-eag-gate] ❌ $*" >&2
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

[ -d "${CORE_DIR}/src/eag" ] || fail "未找到 eag 模块（CORE_DIR=${CORE_DIR}）" 1
[ -f "${CORE_DIR}/src/eag/tcs/fixtures/index.ts" ] || fail "未找到 tcs/fixtures/index.ts（validateTcsFixtures 入口）" 1

log "✅ 环境预检通过 (node $(node --version), CORE_DIR=${CORE_DIR})"

# ---------- Step 1: fixtures 完整性校验（遗留 L-5 闭环） ----------
log "Step 1: fixtures 完整性校验（validateTcsFixtures）"

# validateTcsFixtures() 真实 API（packages/core/src/eag/tcs/fixtures/index.ts）：
#   - 校验通过返回 null
#   - 校验失败返回 ReadonlyArray<string>（错误信息列表）
#
# 设计文档 §5.6 示例代码使用了 result.valid / result.errors，
# 但实际 API 直接返回 null 或 ReadonlyArray<string>，此处按真实 API 实现。
set +e
(
  cd "${CORE_DIR}"
  node --import tsx -e "
    import { validateTcsFixtures } from './src/eag/tcs/fixtures/index.ts';
    const result = validateTcsFixtures();
    if (result !== null) {
      console.error('fixtures 完整性失败：');
      for (const err of result) {
        console.error('  - ' + err);
      }
      process.exit(1);
    }
    console.log('✅ fixtures 完整性通过');
  " 2>&1
)
FIXTURES_EXIT_CODE=$?
set -e

if [ "${FIXTURES_EXIT_CODE}" -ne 0 ]; then
  fail "fixtures 完整性失败（退出码 = ${FIXTURES_EXIT_CODE}）" 2
fi
log "✅ fixtures 完整性通过"

# ---------- Step 2: EAG 静态扫描 ----------
log "Step 2: EAG 静态扫描（tsc --noEmit --strict）"

# 显式启用 strict 模式校验（对齐设计文档 §5.3）
# 防止开发者临时修改 tsconfig.json 关闭 strict
set +e
(
  cd "${CORE_DIR}"
  npx tsc --noEmit --strict 2>&1
)
TSC_EXIT_CODE=$?
set -e

if [ "${TSC_EXIT_CODE}" -ne 0 ]; then
  fail "EAG 静态扫描失败（退出码 = ${TSC_EXIT_CODE}）" 3
fi
log "✅ EAG 静态扫描通过"

# ---------- Step 3: EAG 集成测试 ----------
log "Step 3: EAG 集成测试"

# 按顺序调用批次 9/10/11/12/13 集成测试脚本（仅当脚本存在时）
# 设计文档 §5.6 示例仅包含 batch10/11/12，此处加入 batch9（L-6 闭环）
# batch13 纳入 CI 门禁（EAG-P4 批次 13 收尾同步，对齐批次 12 收尾时纳入 batch12 的演进原则）
for script in \
  eag-batch9-integration.sh \
  eag-batch10-integration.sh \
  eag-batch11-integration.sh \
  eag-batch12-integration.sh \
  eag-batch13-integration.sh; do

  if [ -f "${SCRIPT_DIR}/${script}" ]; then
    log "运行 ${script}..."
    set +e
    bash "${SCRIPT_DIR}/${script}"
    SCRIPT_EXIT=$?
    set -e
    if [ "${SCRIPT_EXIT}" -ne 0 ]; then
      fail "${script} 失败（退出码 = ${SCRIPT_EXIT}）" 4
    fi
    log "✅ ${script} 通过"
  else
    log "ℹ️ 跳过不存在的脚本：${script}"
  fi
done
log "✅ EAG 集成测试通过"

# ---------- Step 4: 全量回归测试 ----------
log "Step 4: 全量回归测试（packages/core 全部单元测试）"

# 使用 node --import tsx --test 运行 packages/core 下全部 *.test.ts
# 不使用 mock（对齐用户规则 C-6）
set +e
(
  cd "${CORE_DIR}"
  node --import tsx --test src/tests/*.test.ts 2>&1
)
REGRESSION_EXIT_CODE=$?
set -e

if [ "${REGRESSION_EXIT_CODE}" -ne 0 ]; then
  fail "全量回归测试失败（退出码 = ${REGRESSION_EXIT_CODE}）" 5
fi
log "✅ 全量回归测试通过"

# ---------- 摘要 ----------
log "🎉 EAG 门禁全部通过"
log "  - fixtures 完整性：✅"
log "  - EAG 静态扫描：✅"
log "  - EAG 集成测试：✅"
log "  - 全量回归测试：✅"

exit 0
