#!/usr/bin/env bash
# ==============================================================================
# DeepCodeX-cli 端到端测试主控脚本
#
# 功能：
#   根据设计文档（enterprise 9 + fusion 17 = 26 个文档）构建完整 e2e 测试套件，
#   从 CLI 入口验证各机制组件的实现情况、执行质量、与设计差异。
#
# 测试维度（对齐测试专家报告 22 维度）：
#   1. CLI 基础参数解析（--version / --help / --once / --no-tty / -p / -r）
#   2. Team 子命令（list / match / dispatch）
#   3. Rules 子命令（list / add / show / path / remove）
#   4. V2 模块完整性与单元测试
#   5. EAG 批次模块（BATCH9~13）实现验证
#   6. 核心架构机制（G-1~G-8 门禁 / 三 Loop / PKC / TCS / EAK / EDM / ETSB / RLIS）
#   7. 设计-实现差异验证（5 个 P1 缺失文件 + 关键 ADR 落实）
#
# 退出码：
#   0 = 全部测试通过
#   1 = 环境预检失败
#   2 = 一个或多个测试套件失败（详细见报告）
#
# 使用方式：
#   bash tests/scripts/run-e2e-tests.sh
#   bash tests/scripts/run-e2e-tests.sh --quiet    # 安静模式，仅输出结果
#   bash tests/scripts/run-e2e-tests.sh --no-v2    # 跳过 V2 测试套件
#
# 设计依据：
# - docs/enterprise/*.md（9 个 EAG 设计文档）
# - docs/fusion/*.md（17 个 V2 + 融合方案设计文档）
# - multi-agent-team 测试专家报告 22 维度 160+ 用例
# - 用户规则 C-9（测试 shell 脚本归位 tests/scripts/）
# ==============================================================================

set -uo pipefail

# ---------- 全局变量 ----------
# QUIET_MODE=1 时仅输出结果，不输出详细过程
QUIET_MODE=0
# SKIP_V2=1 时跳过 V2 测试套件（V2 测试可能耗时较长）
SKIP_V2=0
# 测试结果统计
TOTAL_SUITES=0
PASSED_SUITES=0
FAILED_SUITES=0
# 失败套件列表（用于最终汇总）
FAILED_LIST=()
# 测试报告文件
REPORT_FILE=""
# 开始时间（用于计算总耗时）
START_TIME=$(date +%s)

# ---------- 参数解析 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quiet)
      QUIET_MODE=1
      shift
      ;;
    --no-v2)
      SKIP_V2=1
      shift
      ;;
    --help|-h)
      cat <<EOF
Usage: bash run-e2e-tests.sh [OPTIONS]

Options:
  --quiet    安静模式，仅输出结果
  --no-v2    跳过 V2 测试套件
  --help     显示帮助
EOF
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      exit 1
      ;;
  esac
done

# ---------- 日志工具 ----------
# 统一日志格式：[e2e-master] 消息
log() {
  if [ "${QUIET_MODE}" -eq 0 ]; then
    echo "[e2e-master] $*"
  fi
}

# 失败时输出错误日志
fail() {
  echo "[e2e-master] ❌ $*" >&2
}

# ---------- 环境预检 ----------
log "========== 环境预检 =========="

# node 版本检查（要求 >= 20，tsx 与 node:test 依赖）
command -v node >/dev/null 2>&1 || { fail "未找到 node 可执行文件"; exit 1; }
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "${NODE_MAJOR}" -ge 20 ] || { fail "node 版本过低（要求 >= 20，当前 $(node --version)）"; exit 1; }

# 定位项目根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CORE_DIR="${PROJECT_ROOT}/packages/core"
CLI_DIR="${PROJECT_ROOT}/packages/cli"

# 校验关键目录存在
[ -d "${CORE_DIR}/src" ] || { fail "未找到 core 模块源码目录: ${CORE_DIR}/src"; exit 1; }
[ -d "${CLI_DIR}/src" ] || { fail "未找到 cli 模块源码目录: ${CLI_DIR}/src"; exit 1; }
[ -d "${CORE_DIR}/src/eag" ] || { fail "未找到 EAG 模块目录: ${CORE_DIR}/src/eag"; exit 1; }
[ -d "${CORE_DIR}/src/v2" ] || { fail "未找到 V2 模块目录: ${CORE_DIR}/src/v2"; exit 1; }
[ -d "${CORE_DIR}/src/team" ] || { fail "未找到 team 模块目录: ${CORE_DIR}/src/team"; exit 1; }

# 创建测试报告目录
REPORT_DIR="${PROJECT_ROOT}/tests/e2e-reports"
mkdir -p "${REPORT_DIR}"
REPORT_FILE="${REPORT_DIR}/e2e-report-$(date +%Y%m%d-%H%M%S).md"

log "✅ 环境预检通过 (node $(node --version))"
log "  - PROJECT_ROOT: ${PROJECT_ROOT}"
log "  - CORE_DIR: ${CORE_DIR}"
log "  - CLI_DIR: ${CLI_DIR}"
log "  - REPORT_FILE: ${REPORT_FILE}"

# ---------- 测试套件执行函数 ----------
# 执行单个测试套件并记录结果
# @param $1 套件名称（用于日志和报告）
# @param $2 脚本路径（绝对路径）
# @param $3 描述（用于报告）
run_suite() {
  local suite_name="$1"
  local script_path="$2"
  local description="$3"

  TOTAL_SUITES=$((TOTAL_SUITES + 1))
  local suite_start=$(date +%s)

  log ""
  log "========== [${TOTAL_SUITES}] ${suite_name} =========="
  log "描述: ${description}"
  log "脚本: ${script_path}"

  if [ ! -f "${script_path}" ]; then
    fail "测试脚本不存在: ${script_path}"
    FAILED_SUITES=$((FAILED_SUITES + 1))
    FAILED_LIST+=("${suite_name} (脚本不存在)")
    return
  fi

  # 执行测试脚本，捕获输出
  local suite_log="${REPORT_DIR}/.suite-${TOTAL_SUITES}-$(basename "${script_path}" .sh).log"
  set +e
  bash "${script_path}" > "${suite_log}" 2>&1
  local exit_code=$?
  set -e

  local suite_end=$(date +%s)
  local duration=$((suite_end - suite_start))

  if [ "${exit_code}" -eq 0 ]; then
    PASSED_SUITES=$((PASSED_SUITES + 1))
    log "✅ ${suite_name} 通过（${duration}s）"
    echo "✅ PASS | ${suite_name} | ${duration}s | ${description}" >> "${REPORT_FILE}.tmp"
  else
    FAILED_SUITES=$((FAILED_SUITES + 1))
    FAILED_LIST+=("${suite_name} (exit=${exit_code})")
    fail "❌ ${suite_name} 失败（exit=${exit_code}, ${duration}s）"
    echo "❌ FAIL | ${suite_name} | ${duration}s | ${description} | exit=${exit_code}" >> "${REPORT_FILE}.tmp"
    # 输出最后 20 行日志用于诊断
    if [ "${QUIET_MODE}" -eq 0 ]; then
      log "--- 失败日志（最后 20 行）---"
      tail -20 "${suite_log}" 2>/dev/null || true
      log "--- 日志结束 ---"
    fi
  fi
}

# ---------- 执行所有测试套件 ----------
log ""
log "========================================"
log "  DeepCodeX-cli E2E 测试套件开始执行"
log "========================================"
log ""

# 初始化报告文件
{
  echo "# DeepCodeX-cli E2E 测试报告"
  echo ""
  echo "- **执行时间**: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "- **Node 版本**: $(node --version)"
  echo "- **项目路径**: ${PROJECT_ROOT}"
  echo ""
  echo "## 测试套件结果"
  echo ""
  echo "| 状态 | 套件 | 耗时 | 描述 |"
  echo "|------|------|------|------|"
} > "${REPORT_FILE}.tmp"

# 套件 1: CLI 基础测试
run_suite "CLI 基础参数解析" \
  "${SCRIPT_DIR}/e2e-cli-basic.sh" \
  "验证 --version / --help / --once / --no-tty / -p / -r / 错误参数处理"

# 套件 2: Team 子命令测试
run_suite "Team 子命令" \
  "${SCRIPT_DIR}/e2e-team-cmd.sh" \
  "验证 team list / match / dispatch 子命令，对齐 multi-agent-team 设计"

# 套件 3: Rules 子命令测试
run_suite "Rules 子命令" \
  "${SCRIPT_DIR}/e2e-rules-cmd.sh" \
  "验证 rules list / add / show / path / remove 三层规则管理"

# 套件 4: V2 模块完整性与单元测试
if [ "${SKIP_V2}" -eq 0 ]; then
  run_suite "V2 模块完整性与单元测试" \
    "${SCRIPT_DIR}/e2e-v2-modules.sh" \
    "验证 V2 上下文记忆层 6 子域文件完整性与单元测试通过率"
else
  log "ℹ️ 跳过 V2 测试套件（--no-v2）"
fi

# 套件 5: EAG 批次模块验证
run_suite "EAG 批次模块" \
  "${SCRIPT_DIR}/e2e-eag-batches.sh" \
  "验证 EAG BATCH9~13 模块文件完整性与 G-1~G-8 门禁 checker 实现"

# 套件 6: 核心架构机制验证
run_suite "核心架构机制" \
  "${SCRIPT_DIR}/e2e-arch-mechanisms.sh" \
  "验证三 Loop / PKC / TCS / EAK / EDM / ETSB / RLIS / Karpathy / Ponytail / Cybernetics 机制实现"

# 套件 7: 设计-实现差异验证
run_suite "设计-实现差异" \
  "${SCRIPT_DIR}/e2e-design-impl-diff.sh" \
  "验证 26 个设计文档声明 vs 源码实现一致性，重点检测 5 个 P1 缺失文件"

# ---------- 生成最终报告 ----------
END_TIME=$(date +%s)
TOTAL_DURATION=$((END_TIME - START_TIME))

# 追加汇总信息到报告
{
  echo ""
  echo "## 汇总"
  echo ""
  echo "| 指标 | 值 |"
  echo "|------|-----|"
  echo "| 总套件数 | ${TOTAL_SUITES} |"
  echo "| 通过 | ${PASSED_SUITES} |"
  echo "| 失败 | ${FAILED_SUITES} |"
  echo "| 总耗时 | ${TOTAL_DURATION}s |"
  echo "| 通过率 | $(( PASSED_SUITES * 100 / TOTAL_SUITES ))% |"
  echo ""
  if [ "${FAILED_SUITES}" -gt 0 ]; then
    echo "## 失败套件清单"
    echo ""
    for entry in "${FAILED_LIST[@]}"; do
      echo "- ${entry}"
    done
  else
    echo "## ✅ 所有测试套件通过"
  fi
  echo ""
  echo "## 评估维度"
  echo ""
  echo "| 维度 | 测试覆盖 |"
  echo "|------|---------|"
  echo "| CLI 参数解析 | ✅ 7 用例（--version / --help / --once / --no-tty / -p / -r / 错误处理） |"
  echo "| Team 子命令 | ✅ 3 子命令（list / match / dispatch） |"
  echo "| Rules 子命令 | ✅ 5 子命令（list / add / show / path / remove） |"
  echo "| V2 模块 | ✅ 6 子域文件完整性 + 单元测试 |"
  echo "| EAG 批次 | ✅ BATCH9~13 模块 + G-1~G-8 门禁 |"
  echo "| 核心架构机制 | ✅ 三 Loop / PKC / TCS / EAK / EDM / ETSB / RLIS / Karpathy / Ponytail / Cybernetics |"
  echo "| 设计-实现差异 | ✅ 26 文档声明 vs 源码实现一致性 |"
} >> "${REPORT_FILE}.tmp"

# 移动最终报告
mv "${REPORT_FILE}.tmp" "${REPORT_FILE}"

# ---------- 最终输出 ----------
log ""
log "========================================"
log "  E2E 测试执行完成"
log "========================================"
log "  总套件: ${TOTAL_SUITES}"
log "  通过:   ${PASSED_SUITES}"
log "  失败:   ${FAILED_SUITES}"
log "  耗时:   ${TOTAL_DURATION}s"
log "  通过率: $(( PASSED_SUITES * 100 / TOTAL_SUITES ))%"
log ""
log "  报告文件: ${REPORT_FILE}"

if [ "${FAILED_SUITES}" -gt 0 ]; then
  log ""
  log "  失败套件:"
  for entry in "${FAILED_LIST[@]}"; do
    log "    - ${entry}"
  done
  exit 2
fi

exit 0
