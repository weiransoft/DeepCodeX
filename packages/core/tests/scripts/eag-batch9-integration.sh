#!/usr/bin/env bash
# ==============================================================================
# EAG-P2 批次 9 端到端集成测试脚本
#
# 功能：
#   在临时项目目录上执行批次 9 CODING Loop 全流程集成测试：
#   环境预检 → 临时目录创建 → 模拟材料准备（plan.md / tasks.md）
#   → 调用 eag-batch9-integration-runner.ts 执行：
#     G-4 门禁 → Phase A 骨架生成 → 上下文装配 → Phase B LLM 填充
#     → STRICT 正向评估 → STRICT 反向评估（含硬编码密钥 → E6 违规）
#     → G-5 门禁 → 输出 integration-report.json
#
# 退出码（与 runner 对齐）：
#   0 = 全部断言通过
#   1 = 环境预检失败 / 入参非法
#   2 = Phase A 骨架生成失败
#   3 = Phase B LLM 填充失败
#   4 = STRICT 评估失败
#   5 = G-4 / G-5 门禁失败
#
# 使用方式：
#   bash tests/scripts/eag-batch9-integration.sh
#
# 设计依据：EAG-P2-BATCH9-REDLINE-FIXTURES-DESIGN.md §3 集成测试脚本设计
# ==============================================================================

set -euo pipefail

# ---------- 日志工具 ----------
# 统一日志格式：[eag-batch9-integration] 消息
log() {
  echo "[eag-batch9-integration] $*"
}

# 失败时输出错误日志并以指定退出码退出
# @param $1 错误消息
# @param $2 退出码（默认 1）
fail() {
  echo "[eag-batch9-integration] ❌ $*" >&2
  exit "${2:-1}"
}

# ---------- Step 0: 环境预检 ----------
log "Step 0: 环境预检"

# node 版本检查（要求 >= 20，tsx 与 node:test 依赖）
command -v node >/dev/null 2>&1 || fail "未找到 node 可执行文件" 1
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "${NODE_MAJOR}" -ge 20 ] || fail "node 版本过低（要求 >= 20，当前 $(node --version)）" 1

# 定位 CORE_DIR（本脚本位于 packages/core/tests/scripts/ 下）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
[ -d "${CORE_DIR}/src/eag/coding" ] || fail "未找到 eag/coding 模块（CORE_DIR=${CORE_DIR}）" 1
[ -f "${CORE_DIR}/src/tests/eag-batch9-integration-runner.ts" ] || fail "未找到集成测试 runner" 1

log "✅ 环境预检通过 (node $(node --version), CORE_DIR=${CORE_DIR})"

# ---------- Step 1: 创建临时项目目录 ----------
TMP_PROJECT_DIR="$(mktemp -d /tmp/eag-batch9-integration.XXXXXX)"
# trap EXIT 确保脚本任意路径退出时清理临时目录（含失败路径）
trap 'log "清理临时目录 ${TMP_PROJECT_DIR}"; rm -rf "${TMP_PROJECT_DIR}"' EXIT
log "Step 1: 临时项目目录 = ${TMP_PROJECT_DIR}"

# ---------- Step 2: 准备模拟输入材料 ----------
log "Step 2: 准备模拟输入材料"
mkdir -p "${TMP_PROJECT_DIR}/docs" "${TMP_PROJECT_DIR}/src"

# plan.md：必须与 PlanParser 解析格式对齐——
#   含 `## 2. 模块切分` 章节 + `### OrderAggregate` 模块段
#   （runner 中 FILE_CLUSTER="OrderAggregate"，SkeletonGenerator 按此名称查找 ModuleSplit）
cat > "${TMP_PROJECT_DIR}/docs/plan.md" <<'EOF'
# 订单管理模块实施计划

## 1. 背景与目标

为订单域生成 DDD 分层骨架代码，覆盖聚合根与领域事件。

## 2. 模块切分

### OrderAggregate

- 模块职责：订单聚合根，负责订单创建/取消/支付
- 依赖模块：无
- 关键文件：
  - src/OrderAggregate.ts
  - src/OrderAggregateCreated.ts

## 3. 接口契约

### OrderAggregate.create

- 类型：领域工厂方法
- 签名：static create(command: OrderAggregateCreateCommand): { aggregate: OrderAggregate; events: DomainEvent[] }
- 描述：创建订单聚合根并发布 OrderAggregateCreated 事件
- 错误码：ORDER_INVALID_STATE

## 4. 验收标准

- 骨架含 TODO(phase-b) 占位标记
- LLM 填充后无占位残留且通过 STRICT 评估
EOF

# tasks.md：任务卡清单（供 runner 读取校验存在性；
# 任务卡结构化数据由 runner 内 buildTaskCard/buildTaskDag 构造）
cat > "${TMP_PROJECT_DIR}/docs/tasks.md" <<'EOF'
# 任务卡清单

- [ ] T-001: OrderAggregate 骨架生成与 LLM 填充
EOF

log "✅ 模拟材料就绪（plan.md / tasks.md）"

# ---------- Step 3: 执行集成测试 ----------
log "Step 3: 执行集成测试（node --import tsx）"

REPORT_FILE="${TMP_PROJECT_DIR}/integration-report.json"

# 在 CORE_DIR 下执行 runner（tsx 需解析包内 tsconfig 与依赖）
# 退出码直接透传（runner 内部已完成分阶段断言与退出码映射）
set +e
(
  cd "${CORE_DIR}"
  node --import tsx src/tests/eag-batch9-integration-runner.ts \
    --tmp-dir "${TMP_PROJECT_DIR}" \
    --report-file "${REPORT_FILE}"
)
RUNNER_EXIT_CODE=$?
set -e

# ---------- Step 4: 收集结果与控制台摘要 ----------
log "Step 4: 收集结果（runner 退出码 = ${RUNNER_EXIT_CODE}）"

if [ "${RUNNER_EXIT_CODE}" -eq 0 ] && [ -f "${REPORT_FILE}" ]; then
  log "✅ 集成测试全部通过，报告文件已生成"
  # 控制台摘要：输出报告中的关键断言结果（phaseA/phaseB/strict/strictReverse/gates 五段）
  node -e "
    const report = require('${REPORT_FILE}');
    const sections = ['phaseA', 'phaseB', 'strict', 'strictReverse', 'gates'];
    for (const name of sections) {
      if (report[name]) {
        console.log('[eag-batch9-integration]   ' + name + ': ' + JSON.stringify(report[name]));
      }
    }
  " || log "⚠️ 报告摘要解析失败（不影响退出码）"
else
  log "❌ 集成测试失败（退出码 = ${RUNNER_EXIT_CODE}）"
fi

# ---------- Step 5: 退出（trap EXIT 自动清理临时目录） ----------
exit "${RUNNER_EXIT_CODE}"
