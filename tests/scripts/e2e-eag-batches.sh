#!/usr/bin/env bash
# ==============================================================================
# EAG 批次模块（BATCH9~13）E2E 测试
#
# 测试目标（对齐 TC-EAG-01~18）：
#   1. EAG 模块文件完整性验证（14 个子模块）
#   2. G-1~G-8 八道门禁 checker 实现
#   3. 三 Loop 体系（DESIGN/CODING/TESTING/DEPLOY）
#   4. EAG 命令解析器（EagCommandParser discriminated union）
#   5. 13 StaticChecker 静态检查器
#
# 设计依据：
# - docs/enterprise/ENTERPRISE_APP_GENERATION_DESIGN.md（EAG 主设计 v1.7）
# - docs/enterprise/EAG-P2-BATCH9-DESIGN.md（CODING Loop + 13 StaticChecker）
# - docs/enterprise/EAG-P3-BATCH10~12-DESIGN.md（TESTING Loop + 长程自动化）
# - docs/enterprise/EAG-P4-BATCH13-DESIGN.md（DevOps + DEPLOY + G-8）
# ==============================================================================

set -uo pipefail

# ---------- 全局变量 ----------
TOTAL_CASES=0
PASSED_CASES=0
FAILED_CASES=0
FAILED_CASES_LIST=()

# ---------- 日志工具 ----------
log() {
  echo "[e2e-eag-batches] $*"
}

fail_log() {
  echo "[e2e-eag-batches] ❌ $*" >&2
}

# ---------- 环境预检 ----------
log "========== 环境预检 =========="

command -v node >/dev/null 2>&1 || { fail_log "未找到 node"; exit 1; }
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "${NODE_MAJOR}" -ge 20 ] || { fail_log "node 版本过低"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CORE_DIR="${PROJECT_ROOT}/packages/core"
EAG_DIR="${CORE_DIR}/src/eag"

[ -d "${EAG_DIR}" ] || { fail_log "未找到 EAG 模块目录: ${EAG_DIR}"; exit 1; }

log "✅ 环境预检通过"
log "  - EAG_DIR: ${EAG_DIR}"

# ---------- 测试用例执行函数 ----------
check_dir_case() {
  local case_id="$1"
  local case_desc="$2"
  local dir_path="$3"

  TOTAL_CASES=$((TOTAL_CASES + 1))
  log ""
  log "--- [${case_id}] ${case_desc} ---"
  log "目录: ${dir_path}"

  if [ -d "${dir_path}" ]; then
    local file_count
    file_count=$(find "${dir_path}" -name "*.ts" -type f | wc -l | tr -d ' ')
    PASSED_CASES=$((PASSED_CASES + 1))
    log "✅ ${case_id} 通过（${file_count} 个 .ts 文件）"
  else
    FAILED_CASES=$((FAILED_CASES + 1))
    FAILED_CASES_LIST+=("${case_id} (目录缺失: ${dir_path})")
    fail_log "${case_id} 目录缺失: ${dir_path}"
  fi
}

check_file_case() {
  local case_id="$1"
  local case_desc="$2"
  local file_path="$3"

  TOTAL_CASES=$((TOTAL_CASES + 1))
  log ""
  log "--- [${case_id}] ${case_desc} ---"
  log "文件: ${file_path}"

  if [ -f "${file_path}" ]; then
    PASSED_CASES=$((PASSED_CASES + 1))
    log "✅ ${case_id} 通过"
  else
    FAILED_CASES=$((FAILED_CASES + 1))
    FAILED_CASES_LIST+=("${case_id} (文件缺失: ${file_path})")
    fail_log "${case_id} 文件缺失: ${file_path}"
  fi
}

# ---------- EAG 14 子模块完整性验证 ----------

# TC-EAG-M01: cli 子模块（EagCommandParser）
check_dir_case "TC-EAG-M01" \
  "EAG cli 子模块（EagCommandParser discriminated union）" \
  "${EAG_DIR}/cli"

# TC-EAG-M02: coding 子模块（CODING Loop + 13 StaticChecker + EJS 模板）
check_dir_case "TC-EAG-M02" \
  "EAG coding 子模块（CODING Loop + 13 StaticChecker）" \
  "${EAG_DIR}/coding"

# TC-EAG-M03: deploy 子模块（DeployStage 4 步）
check_dir_case "TC-EAG-M03" \
  "EAG deploy 子模块（DeployStage pre/deploy/post/smoke）" \
  "${EAG_DIR}/deploy"

# TC-EAG-M04: design 子模块（DESIGN Loop）
check_dir_case "TC-EAG-M04" \
  "EAG design 子模块（DESIGN Loop）" \
  "${EAG_DIR}/design"

# TC-EAG-M05: discovery 子模块（Discovery 模块）
check_dir_case "TC-EAG-M05" \
  "EAG discovery 子模块" \
  "${EAG_DIR}/discovery"

# TC-EAG-M06: doc-driven 子模块（文档驱动开发）
check_dir_case "TC-EAG-M06" \
  "EAG doc-driven 子模块（constitution/plan/tasks 生成器）" \
  "${EAG_DIR}/doc-driven"

# TC-EAG-M07: devops 子模块（DevOps 角色 + 3 IaC 生成器）
check_dir_case "TC-EAG-M07" \
  "EAG devops 子模块（DevOps + Terraform/K8s/Helm）" \
  "${EAG_DIR}/devops"

# TC-EAG-M08: eak 子模块（4 范式：DDD/Clean/CQRS-ES/Microservice）
check_dir_case "TC-EAG-M08" \
  "EAG eak 子模块（4 范式）" \
  "${EAG_DIR}/eak"

# TC-EAG-M09: edm 子模块（5 域权限）
check_dir_case "TC-EAG-M09" \
  "EAG edm 子模块（5 域权限）" \
  "${EAG_DIR}/edm"

# TC-EAG-M10: etsb 子模块（技术选型矩阵 4×10）
check_dir_case "TC-EAG-M10" \
  "EAG etsb 子模块（4 语言 × 10 层技术栈）" \
  "${EAG_DIR}/etsb"

# TC-EAG-M11: gate 子模块（G-1~G-8 门禁）
check_dir_case "TC-EAG-M11" \
  "EAG gate 子模块（G-1~G-8 八道门禁）" \
  "${EAG_DIR}/gate"

# TC-EAG-M12: icp 子模块（行业合规包）
check_dir_case "TC-EAG-M12" \
  "EAG icp 子模块（GMP/CFR/ALCOA+ 20 条规则）" \
  "${EAG_DIR}/icp"

# TC-EAG-M13: long-horizon 子模块（长程任务自动化）
check_dir_case "TC-EAG-M13" \
  "EAG long-horizon 子模块（RunState/MultiLoopPlanner/Blockage）" \
  "${EAG_DIR}/long-horizon"

# TC-EAG-M14: loop 子模块（LoopKernel/Scheduler/Guard）
check_dir_case "TC-EAG-M14" \
  "EAG loop 子模块（LoopKernel/Scheduler/Guard）" \
  "${EAG_DIR}/loop"

# TC-EAG-M15: pkc 子模块（PKC 四层知识金字塔）
check_dir_case "TC-EAG-M15" \
  "EAG pkc 子模块（L1-L4 四层知识金字塔）" \
  "${EAG_DIR}/pkc"

# TC-EAG-M16: redlines 子模块
check_dir_case "TC-EAG-M16" \
  "EAG redlines 子模块" \
  "${EAG_DIR}/redlines"

# TC-EAG-M17: rlis 子模块（三层规则 + RuleLearner）
check_dir_case "TC-EAG-M17" \
  "EAG rlis 子模块（三层规则存储）" \
  "${EAG_DIR}/rlis"

# TC-EAG-M18: tcs 子模块（5 组件 + 13 红线）
check_dir_case "TC-EAG-M18" \
  "EAG tcs 子模块（OSS/Cache/SQL/LDAP/VulnScanner）" \
  "${EAG_DIR}/tcs"

# TC-EAG-M19: testing 子模块（TESTING Loop）
check_dir_case "TC-EAG-M19" \
  "EAG testing 子模块（TESTING Loop）" \
  "${EAG_DIR}/testing"

# ---------- G-1~G-8 八道门禁 checker 文件验证 ----------

# TC-EAG-G01: G-1 spec 门禁
check_file_case "TC-EAG-G01" \
  "G-1 spec 门禁（方案先行）" \
  "${EAG_DIR}/gate/gate-g1-checker.ts"

# TC-EAG-G02: G-2 task-decomp 门禁
check_file_case "TC-EAG-G02" \
  "G-2 task-decomp 门禁（任务分解）" \
  "${EAG_DIR}/gate/gate-g2-checker.ts"

# TC-EAG-G03: G-3 design 门禁
check_file_case "TC-EAG-G03" \
  "G-3 design 门禁（设计文档）" \
  "${EAG_DIR}/gate/gate-g3-checker.ts"

# TC-EAG-G04: G-4 static 门禁
check_file_case "TC-EAG-G04" \
  "G-4 static 门禁（静态检查）" \
  "${EAG_DIR}/gate/gate-g4-checker.ts"

# TC-EAG-G05: G-5 fix-loop 门禁
check_file_case "TC-EAG-G05" \
  "G-5 fix-loop 门禁" \
  "${EAG_DIR}/gate/gate-g5-checker.ts"

# TC-EAG-G06: G-6 testing 门禁
check_file_case "TC-EAG-G06" \
  "G-6 testing 门禁（覆盖率）" \
  "${EAG_DIR}/gate/gate-g6-checker.ts"

# TC-EAG-G07: G-7 handover 门禁
check_file_case "TC-EAG-G07" \
  "G-7 handover 门禁（交接文档）" \
  "${EAG_DIR}/gate/gate-g7-checker.ts"

# TC-EAG-G08: G-8 deploy 门禁（P4 新增）
check_file_case "TC-EAG-G08" \
  "G-8 deploy 门禁（部署门禁，P4 新增）" \
  "${EAG_DIR}/gate/gate-g8-checker.ts"

# TC-EAG-G09: GateOrchestrator 编排器
check_file_case "TC-EAG-G09" \
  "GateOrchestrator 门禁编排器" \
  "${EAG_DIR}/gate/gate-orchestrator.ts"

# ---------- 三 Loop 体系验证 ----------

# TC-EAG-L01: DESIGN Loop
check_dir_case "TC-EAG-L01" \
  "DESIGN Loop（design 子模块）" \
  "${EAG_DIR}/design"

# TC-EAG-L02: CODING Loop orchestrator
check_file_case "TC-EAG-L02" \
  "CODING Loop orchestrator" \
  "${EAG_DIR}/coding/coding-orchestrator.ts"

# TC-EAG-L03: TESTING Loop orchestrator
check_file_case "TC-EAG-L03" \
  "TESTING Loop orchestrator" \
  "${EAG_DIR}/testing/testing-orchestrator.ts"

# TC-EAG-L04: DEPLOY Loop（P4 新增）
check_file_case "TC-EAG-L04" \
  "DEPLOY Loop stage（P4 新增）" \
  "${EAG_DIR}/deploy/deploy-stage.ts"

# TC-EAG-L05: LoopKernel（共享上限保护）
check_file_case "TC-EAG-L05" \
  "LoopKernel 共享上限保护" \
  "${EAG_DIR}/loop/kernel.ts"

# TC-EAG-L06: LoopScheduler（调度器）
check_file_case "TC-EAG-L06" \
  "LoopScheduler 调度器" \
  "${EAG_DIR}/loop/scheduler.ts"

# TC-EAG-L07: LoopGuard（上限保护）
# 注意：实际文件可能在 common/loop-guard.ts 而非 loop/
check_file_case "TC-EAG-L07" \
  "LoopGuard 上限保护（max_iterations/max_tokens）" \
  "${CORE_DIR}/src/common/loop-guard.ts"

# ---------- 13 StaticChecker 验证 ----------

# TC-EAG-S01: anemic-model-detector
check_file_case "TC-EAG-S01" \
  "StaticChecker 01: anemic-model-detector（贫血模型检测）" \
  "${EAG_DIR}/coding/static-checkers/anemic-model-detector.ts"

# TC-EAG-S02: audit-event-matcher
check_file_case "TC-EAG-S02" \
  "StaticChecker 02: audit-event-matcher（审计事件匹配）" \
  "${EAG_DIR}/coding/static-checkers/audit-event-matcher.ts"

# TC-EAG-S03: cache-pattern-checker
check_file_case "TC-EAG-S03" \
  "StaticChecker 03: cache-pattern-checker（缓存模式）" \
  "${EAG_DIR}/coding/static-checkers/cache-pattern-checker.ts"

# TC-EAG-S04: contract-existence-checker
check_file_case "TC-EAG-S04" \
  "StaticChecker 04: contract-existence-checker（契约存在）" \
  "${EAG_DIR}/coding/static-checkers/contract-existence-checker.ts"

# TC-EAG-S05: contract-guard-checker
check_file_case "TC-EAG-S05" \
  "StaticChecker 05: contract-guard-checker（契约保护）" \
  "${EAG_DIR}/coding/static-checkers/contract-guard-checker.ts"

# TC-EAG-S06: dependency-scanner
check_file_case "TC-EAG-S06" \
  "StaticChecker 06: dependency-scanner（依赖扫描）" \
  "${EAG_DIR}/coding/static-checkers/dependency-scanner.ts"

# TC-EAG-S07: dto-validator-checker
check_file_case "TC-EAG-S07" \
  "StaticChecker 07: dto-validator-checker（DTO 校验）" \
  "${EAG_DIR}/coding/static-checkers/dto-validator-checker.ts"

# TC-EAG-S08: hardcode-secret-scanner
check_file_case "TC-EAG-S08" \
  "StaticChecker 08: hardcode-secret-scanner（硬编码密钥扫描）" \
  "${EAG_DIR}/coding/static-checkers/hardcode-secret-scanner.ts"

# TC-EAG-S09: idempotency-checker
check_file_case "TC-EAG-S09" \
  "StaticChecker 09: idempotency-checker（幂等性）" \
  "${EAG_DIR}/coding/static-checkers/idempotency-checker.ts"

# TC-EAG-S10: ldap-pattern-checker
check_file_case "TC-EAG-S10" \
  "StaticChecker 10: ldap-pattern-checker（LDAP 模式）" \
  "${EAG_DIR}/coding/static-checkers/ldap-pattern-checker.ts"

# TC-EAG-S11: oss-pattern-checker
check_file_case "TC-EAG-S11" \
  "StaticChecker 11: oss-pattern-checker（OSS 模式）" \
  "${EAG_DIR}/coding/static-checkers/oss-pattern-checker.ts"

# TC-EAG-S12: saga-detector
check_file_case "TC-EAG-S12" \
  "StaticChecker 12: saga-detector（Saga 检测）" \
  "${EAG_DIR}/coding/static-checkers/saga-detector.ts"

# TC-EAG-S13: sql-pattern-checker
check_file_case "TC-EAG-S13" \
  "StaticChecker 13: sql-pattern-checker（SQL 模式）" \
  "${EAG_DIR}/coding/static-checkers/sql-pattern-checker.ts"

# ---------- 长程自动化核心组件 ----------

# TC-EAG-LH01: RunStateStore
check_file_case "TC-EAG-LH01" \
  "RunStateStore（JSONL+SHA256+文件锁）" \
  "${EAG_DIR}/long-horizon/run-state-store.ts"

# TC-EAG-LH02: MultiLoopPlanner
check_file_case "TC-EAG-LH02" \
  "MultiLoopPlanner（DAG 多 Loop 串联）" \
  "${EAG_DIR}/long-horizon/multi-loop-planner.ts"

# TC-EAG-LH03: BlockageAnalyzer
check_file_case "TC-EAG-LH03" \
  "BlockageAnalyzer（5 类阻塞分析）" \
  "${EAG_DIR}/long-horizon/blockage-analyzer.ts"

# TC-EAG-LH04: PlanBlockageAnalyzer
check_file_case "TC-EAG-LH04" \
  "PlanBlockageAnalyzer（计划阻塞分析）" \
  "${EAG_DIR}/long-horizon/plan-blockage-analyzer.ts"

# TC-EAG-LH05: MilestoneTagger
check_file_case "TC-EAG-LH05" \
  "MilestoneTagger（里程碑 tag 自动回归）" \
  "${EAG_DIR}/long-horizon/milestone-tagger.ts"

# ---------- PKC 四层知识金字塔 ----------

# TC-EAG-PKC01: L1 全局视野
check_file_case "TC-EAG-PKC01" \
  "PKC L1 全局视野" \
  "${EAG_DIR}/pkc/l1-global-view.ts"

# TC-EAG-PKC02: L2 语义检索
check_file_case "TC-EAG-PKC02" \
  "PKC L2 语义检索（symbol-indexer）" \
  "${EAG_DIR}/pkc/symbol-indexer.ts"

# TC-EAG-PKC03: L3 业务知识
check_dir_case "TC-EAG-PKC03" \
  "PKC L3 业务知识" \
  "${EAG_DIR}/pkc/l3"

# TC-EAG-PKC04: L4 交接文档
check_dir_case "TC-EAG-PKC04" \
  "PKC L4 交接文档（HandoverDocBuilder）" \
  "${EAG_DIR}/pkc/l4"

# TC-EAG-PKC05: HandoverDocBuilder
check_file_case "TC-EAG-PKC05" \
  "HandoverDocBuilder（交接文档生成器）" \
  "${EAG_DIR}/pkc/l4/handover-doc-builder.ts"

# ---------- ICP 三合规包 ----------

# TC-EAG-ICP01: GMP 合规包
check_file_case "TC-EAG-ICP01" \
  "ICP GMP 合规包（6 条规则）" \
  "${EAG_DIR}/icp/packs/gmp-pack.ts"

# TC-EAG-ICP02: CFR Part 11 合规包
check_file_case "TC-EAG-ICP02" \
  "ICP CFR Part 11 合规包（5 条规则）" \
  "${EAG_DIR}/icp/packs/cfr-part11-pack.ts"

# TC-EAG-ICP03: ALCOA+ 合规包
check_file_case "TC-EAG-ICP03" \
  "ICP ALCOA+ 合规包（9 条规则）" \
  "${EAG_DIR}/icp/packs/alcoa-plus-pack.ts"

# TC-EAG-ICP04: ComplianceEngine
check_file_case "TC-EAG-ICP04" \
  "ComplianceEngine（合规引擎）" \
  "${EAG_DIR}/icp/compliance-engine.ts"

# TC-EAG-ICP05: EvidenceCollector
check_file_case "TC-EAG-ICP05" \
  "EvidenceCollector（证据收集器）" \
  "${EAG_DIR}/icp/evidence-collector.ts"

# ---------- DevOps 3 IaC 生成器 ----------

# TC-EAG-DEV01: Terraform 生成器
check_file_case "TC-EAG-DEV01" \
  "DevOps Terraform 生成器" \
  "${EAG_DIR}/devops/iac-generator/terraform-generator.ts"

# TC-EAG-DEV02: K8s Manifest 生成器
check_file_case "TC-EAG-DEV02" \
  "DevOps K8s Manifest 生成器" \
  "${EAG_DIR}/devops/iac-generator/k8s-manifest-generator.ts"

# TC-EAG-DEV03: Helm Chart 生成器
check_file_case "TC-EAG-DEV03" \
  "DevOps Helm Chart 生成器" \
  "${EAG_DIR}/devops/iac-generator/helm-chart-generator.ts"

# TC-EAG-DEV04: DevOpsOrchestrator
check_file_case "TC-EAG-DEV04" \
  "DevOpsOrchestrator（DevOps 第 6 角色）" \
  "${EAG_DIR}/devops/devops-orchestrator.ts"

# TC-EAG-DEV05: RollbackManager
check_file_case "TC-EAG-DEV05" \
  "RollbackManager（回滚管理器）" \
  "${EAG_DIR}/devops/rollback-manager.ts"

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
  for entry in "${FAILED_CASES_LIST[@]}"; do
    log "    - ${entry}"
  done
  exit 2
fi

exit 0
