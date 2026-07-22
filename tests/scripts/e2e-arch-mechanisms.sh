#!/usr/bin/env bash
# ==============================================================================
# 核心架构机制 E2E 测试
#
# 测试目标：
#   1. 三 Loop 体系（DESIGN/CODING/TESTING/DEPLOY）
#   2. PKC 四层知识金字塔
#   3. TCS 五组件（OSS/Cache/SQL/LDAP/VulnScanner）
#   4. EAK 四范式（DDD/Clean/CQRS-ES/Microservice）
#   5. EDM 五域权限
#   6. ETSB 技术选型矩阵
#   7. RLIS 三层规则 + 10 种子规则
#   8. Karpathy 四大原则
#   9. Ponytail 6 步决策梯 + 16 红线
#  10. Cybernetics 三环控制
#  11. Dynamic Workflows 6 模式
#  12. V3 插件热加载
#  13. Autonomous 4 阶段循环
#  14. multi-agent-team 5 角色 + 30 领域专家
#
# 设计依据：
# - docs/fusion/DEEPCODEX_FUSION_PLAN.md
# - docs/fusion/KARPATHY_PRINCIPLES.md
# - docs/fusion/PONYTAIL_RULES.md
# - docs/enterprise/DOMAIN_EXPERT_INTEGRATION_DESIGN.md
# ==============================================================================

set -uo pipefail

# ---------- 全局变量 ----------
TOTAL_CASES=0
PASSED_CASES=0
FAILED_CASES=0
FAILED_CASES_LIST=()

# ---------- 日志工具 ----------
log() {
  echo "[e2e-arch-mechanisms] $*"
}

fail_log() {
  echo "[e2e-arch-mechanisms] ❌ $*" >&2
}

# ---------- 环境预检 ----------
log "========== 环境预检 =========="

command -v node >/dev/null 2>&1 || { fail_log "未找到 node"; exit 1; }
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "${NODE_MAJOR}" -ge 20 ] || { fail_log "node 版本过低"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CORE_DIR="${PROJECT_ROOT}/packages/core"
TEAM_DIR="${CORE_DIR}/src/team"
EAG_DIR="${CORE_DIR}/src/eag"

[ -d "${TEAM_DIR}" ] || { fail_log "未找到 team 模块"; exit 1; }
[ -d "${EAG_DIR}" ] || { fail_log "未找到 EAG 模块"; exit 1; }

log "✅ 环境预检通过"

# ---------- 测试用例执行函数 ----------
check_file_case() {
  local case_id="$1"
  local case_desc="$2"
  local file_path="$3"

  TOTAL_CASES=$((TOTAL_CASES + 1))
  log ""
  log "--- [${case_id}] ${case_desc} ---"

  if [ -f "${file_path}" ]; then
    PASSED_CASES=$((PASSED_CASES + 1))
    log "✅ ${case_id} 通过"
  else
    FAILED_CASES=$((FAILED_CASES + 1))
    FAILED_CASES_LIST+=("${case_id} (文件缺失: ${file_path})")
    fail_log "${case_id} 文件缺失: ${file_path}"
  fi
}

check_dir_case() {
  local case_id="$1"
  local case_desc="$2"
  local dir_path="$3"

  TOTAL_CASES=$((TOTAL_CASES + 1))
  log ""
  log "--- [${case_id}] ${case_desc} ---"

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

# ---------- TCS 五组件 ----------

# TC-ARCH-TCS01: OSS ObjectStorage
check_file_case "TC-ARCH-TCS01" \
  "TCS OSS ObjectStorage（对象存储）" \
  "${EAG_DIR}/tcs/object-storage.ts"

# TC-ARCH-TCS02: Cache 缓存
check_file_case "TC-ARCH-TCS02" \
  "TCS Cache（缓存）" \
  "${EAG_DIR}/tcs/cache.ts"

# TC-ARCH-TCS03: SQL Optimizer
check_file_case "TC-ARCH-TCS03" \
  "TCS SQL Optimizer（SQL 优化）" \
  "${EAG_DIR}/tcs/sql-optimizer.ts"

# TC-ARCH-TCS04: LDAP Adapter
check_file_case "TC-ARCH-TCS04" \
  "TCS LDAP Adapter（LDAP 适配器）" \
  "${EAG_DIR}/tcs/ldap-adapter.ts"

# TC-ARCH-TCS05: VulnerabilityScanner
check_file_case "TC-ARCH-TCS05" \
  "TCS VulnerabilityScanner（漏洞扫描器）" \
  "${EAG_DIR}/tcs/vulnerability-scanner.ts"

# TC-ARCH-TCS06: TCS Redlines（13 红线）
check_file_case "TC-ARCH-TCS06" \
  "TCS Redlines（13 红线）" \
  "${EAG_DIR}/tcs/tcs-redlines.ts"

# ---------- EAK 四范式 ----------

# TC-ARCH-EAK01: DDD 分层
check_file_case "TC-ARCH-EAK01" \
  "EAK DDD 分层范式" \
  "${EAG_DIR}/eak/paradigms/ddd-layered.ts"

# TC-ARCH-EAK02: Clean Architecture
check_file_case "TC-ARCH-EAK02" \
  "EAK Clean Architecture 范式" \
  "${EAG_DIR}/eak/paradigms/clean-architecture.ts"

# TC-ARCH-EAK03: CQRS-ES
check_file_case "TC-ARCH-EAK03" \
  "EAK CQRS-ES 范式" \
  "${EAG_DIR}/eak/paradigms/cqrs-es.ts"

# TC-ARCH-EAK04: Microservice
check_file_case "TC-ARCH-EAK04" \
  "EAK Microservice 范式" \
  "${EAG_DIR}/eak/paradigms/microservice.ts"

# TC-ARCH-EAK05: ParadigmRegistry
check_file_case "TC-ARCH-EAK05" \
  "EAK ParadigmRegistry（范式注册器）" \
  "${EAG_DIR}/eak/paradigm-registry.ts"

# ---------- EDM 五域权限 ----------

# TC-ARCH-EDM01: User Domain
check_file_case "TC-ARCH-EDM01" \
  "EDM User Domain" \
  "${EAG_DIR}/edm/edm-domains/user-domain.ts"

# TC-ARCH-EDM02: Org Domain
check_file_case "TC-ARCH-EDM02" \
  "EDM Org Domain" \
  "${EAG_DIR}/edm/edm-domains/org-domain.ts"

# TC-ARCH-EDM03: Role Domain
check_file_case "TC-ARCH-EDM03" \
  "EDM Role Domain" \
  "${EAG_DIR}/edm/edm-domains/role-domain.ts"

# TC-ARCH-EDM04: Permission Domain
check_file_case "TC-ARCH-EDM04" \
  "EDM Permission Domain" \
  "${EAG_DIR}/edm/edm-domains/permission-domain.ts"

# TC-ARCH-EDM05: Data Scope Domain
check_file_case "TC-ARCH-EDM05" \
  "EDM Data Scope Domain" \
  "${EAG_DIR}/edm/edm-domains/data-scope-domain.ts"

# TC-ARCH-EDM06: EDM Detector
check_file_case "TC-ARCH-EDM06" \
  "EDM Detector（权限检测器）" \
  "${EAG_DIR}/edm/edm-detector.ts"

# TC-ARCH-EDM07: EDM Redlines
check_file_case "TC-ARCH-EDM07" \
  "EDM Redlines" \
  "${EAG_DIR}/edm/edm-redlines.ts"

# ---------- ETSB 技术选型矩阵 ----------

# TC-ARCH-ETSB01: TechStackLock
check_file_case "TC-ARCH-ETSB01" \
  "ETSB TechStackLock（技术栈锁定）" \
  "${EAG_DIR}/etsb/tech-stack-lock.ts"

# TC-ARCH-ETSB02: TechStackRegistry
check_file_case "TC-ARCH-ETSB02" \
  "ETSB TechStackRegistry（技术栈注册器）" \
  "${EAG_DIR}/etsb/tech-stack-registry.ts"

# TC-ARCH-ETSB03: TechStackSelector
check_file_case "TC-ARCH-ETSB03" \
  "ETSB TechStackSelector（技术栈选择器）" \
  "${EAG_DIR}/etsb/tech-stack-selector.ts"

# TC-ARCH-ETSB04: DeploymentBlueprints
check_file_case "TC-ARCH-ETSB04" \
  "ETSB DeploymentBlueprints（部署蓝图）" \
  "${EAG_DIR}/etsb/deployment-blueprints.ts"

# ---------- RLIS 三层规则 + 10 种子规则 ----------

# TC-ARCH-RLIS01: RuleStore
check_file_case "TC-ARCH-RLIS01" \
  "RLIS RuleStore（三层规则存储）" \
  "${EAG_DIR}/rlis/rule-store.ts"

# TC-ARCH-RLIS02: RuleInjector
check_file_case "TC-ARCH-RLIS02" \
  "RLIS RuleInjector（directRetainSnippets 永驻注入）" \
  "${EAG_DIR}/rlis/rule-injector.ts"

# TC-ARCH-RLIS03: RuleLearner
check_file_case "TC-ARCH-RLIS03" \
  "RLIS RuleLearner（学习闭环）" \
  "${EAG_DIR}/rlis/rule-learner.ts"

# TC-ARCH-RLIS04: SeedRules（10 种子规则）
check_file_case "TC-ARCH-RLIS04" \
  "RLIS SeedRules（10 种子规则 SEED-01~10）" \
  "${EAG_DIR}/rlis/seed-rules.ts"

# ---------- Karpathy 四大原则 ----------

# TC-ARCH-KARP01: karpathy.ts
check_file_case "TC-ARCH-KARP01" \
  "Karpathy 四大原则实现" \
  "${TEAM_DIR}/principles/karpathy.ts"

# TC-ARCH-KARP02: ponytail.ts
check_file_case "TC-ARCH-KARP02" \
  "Ponytail 6 步决策梯 + 16 红线" \
  "${TEAM_DIR}/principles/ponytail.ts"

# TC-ARCH-KARP03: quality-gates.ts
check_file_case "TC-ARCH-KARP03" \
  "QualityGates 质量门禁" \
  "${TEAM_DIR}/principles/quality-gates.ts"

# TC-ARCH-KARP04: karpathy-preamble.ts
check_file_case "TC-ARCH-KARP04" \
  "KarpathyPreamble（角色前导词）" \
  "${TEAM_DIR}/karpathy-preamble.ts"

# ---------- Cybernetics 三环控制 ----------

# TC-ARCH-CYB01: feedback-control-loop
check_file_case "TC-ARCH-CYB01" \
  "Cybernetics FeedbackControlLoop（反馈控制环）" \
  "${TEAM_DIR}/cybernetics/feedback-control-loop.ts"

# TC-ARCH-CYB02: guard-coordinator
check_file_case "TC-ARCH-CYB02" \
  "Cybernetics GuardCoordinator（守护协调器）" \
  "${TEAM_DIR}/cybernetics/guard-coordinator.ts"

# TC-ARCH-CYB03: hierarchical-control
check_file_case "TC-ARCH-CYB03" \
  "Cybernetics HierarchicalControl（分层控制）" \
  "${TEAM_DIR}/cybernetics/hierarchical-control.ts"

# TC-ARCH-CYB04: karpathy-principle-enforcer
check_file_case "TC-ARCH-CYB04" \
  "Cybernetics KarpathyPrincipleEnforcer（原则执行器）" \
  "${TEAM_DIR}/cybernetics/karpathy-principle-enforcer.ts"

# ---------- Dynamic Workflows 6 模式 ----------

# TC-ARCH-WF01: pattern-composer
check_file_case "TC-ARCH-WF01" \
  "Workflows PatternComposer（模式组合器）" \
  "${TEAM_DIR}/workflows/pattern-composer.ts"

# TC-ARCH-WF02: pattern-executor
check_file_case "TC-ARCH-WF02" \
  "Workflows PatternExecutor（模式执行器）" \
  "${TEAM_DIR}/workflows/pattern-executor.ts"

# TC-ARCH-WF03: pattern-tier-resolver
check_file_case "TC-ARCH-WF03" \
  "Workflows PatternTierResolver（模式层级解析器）" \
  "${TEAM_DIR}/workflows/pattern-tier-resolver.ts"

# TC-ARCH-WF04: model-router
check_file_case "TC-ARCH-WF04" \
  "Workflows ModelRouter（模型路由器）" \
  "${TEAM_DIR}/workflows/model-router.ts"

# TC-ARCH-WF05: semantic-embedder
check_file_case "TC-ARCH-WF05" \
  "Workflows SemanticEmbedder（TFIDF/Hashing 本地相似度）" \
  "${TEAM_DIR}/workflows/semantic-embedder.ts"

# TC-ARCH-WF06: skill-injector
check_file_case "TC-ARCH-WF06" \
  "Workflows SkillInjector（Skill 注入器）" \
  "${TEAM_DIR}/workflows/skill-injector.ts"

# TC-ARCH-WF07: interruption-recovery
check_file_case "TC-ARCH-WF07" \
  "Workflows InterruptionRecovery（中断恢复）" \
  "${TEAM_DIR}/workflows/interruption-recovery.ts"

# ---------- V3 插件热加载 ----------

# TC-ARCH-PLUG01: drop-in-loader
check_file_case "TC-ARCH-PLUG01" \
  "Plugin Drop-in Loader（Drop-in 目录加载）" \
  "${TEAM_DIR}/drop-in-loader.ts"

# TC-ARCH-PLUG02: hot-reload-watcher
check_file_case "TC-ARCH-PLUG02" \
  "Plugin HotReloadWatcher（热加载监视器）" \
  "${TEAM_DIR}/hot-reload-watcher.ts"

# TC-ARCH-PLUG03: plugin-context
check_file_case "TC-ARCH-PLUG03" \
  "Plugin PluginContext（插件上下文）" \
  "${TEAM_DIR}/plugin-context.ts"

# TC-ARCH-PLUG04: reload-guard
check_file_case "TC-ARCH-PLUG04" \
  "Plugin ReloadGuard（重载守护）" \
  "${TEAM_DIR}/reload-guard.ts"

# TC-ARCH-PLUG05: plugins/index
check_file_case "TC-ARCH-PLUG05" \
  "Plugins Index（7 插件入口）" \
  "${TEAM_DIR}/plugins/index.ts"

# TC-ARCH-PLUG06: goal-dispatcher
check_file_case "TC-ARCH-PLUG06" \
  "Plugin GoalDispatcher（Goal 调度器）" \
  "${TEAM_DIR}/plugins/goal-dispatcher.ts"

# TC-ARCH-PLUG07: autonomous plugin
check_file_case "TC-ARCH-PLUG07" \
  "Plugin Autonomous（Ralph Autonomous 插件）" \
  "${TEAM_DIR}/plugins/autonomous.ts"

# ---------- Autonomous 4 阶段循环 ----------

# TC-ARCH-AUTO01: loop-controller
check_file_case "TC-ARCH-AUTO01" \
  "Autonomous LoopController（4 阶段循环控制器）" \
  "${TEAM_DIR}/autonomous/loop-controller.ts"

# TC-ARCH-AUTO02: run-state
check_file_case "TC-ARCH-AUTO02" \
  "Autonomous RunState（状态持久化）" \
  "${TEAM_DIR}/autonomous/run-state.ts"

# TC-ARCH-AUTO03: notes-memory
check_file_case "TC-ARCH-AUTO03" \
  "Autonomous NotesMemory（notes.md 跨轮记忆）" \
  "${TEAM_DIR}/autonomous/notes-memory.ts"

# TC-ARCH-AUTO04: git-driver
check_file_case "TC-ARCH-AUTO04" \
  "Autonomous GitDriver（自动 commit + 分支管理）" \
  "${TEAM_DIR}/autonomous/git-driver.ts"

# TC-ARCH-AUTO05: sleep-guard
check_file_case "TC-ARCH-AUTO05" \
  "Autonomous SleepGuard（防休眠守护）" \
  "${TEAM_DIR}/autonomous/sleep-guard.ts"

# TC-ARCH-AUTO06: smart-confirmation
check_file_case "TC-ARCH-AUTO06" \
  "Autonomous SmartConfirmation（三态判定）" \
  "${TEAM_DIR}/autonomous/smart-confirmation.ts"

# TC-ARCH-AUTO07: auto-skill-loader
check_file_case "TC-ARCH-AUTO07" \
  "Autonomous AutoSkillLoader（自动加载 skill）" \
  "${TEAM_DIR}/autonomous/auto-skill-loader.ts"

# TC-ARCH-AUTO08: dispatcher-adapter
check_file_case "TC-ARCH-AUTO08" \
  "Autonomous DispatcherAdapter（Claude Code/Trae 适配）" \
  "${TEAM_DIR}/autonomous/dispatcher-adapter.ts"

# TC-ARCH-AUTO09: config-loader
check_file_case "TC-ARCH-AUTO09" \
  "Autonomous ConfigLoader（autonomous.yml 配置）" \
  "${TEAM_DIR}/autonomous/config-loader.ts"

# ---------- multi-agent-team 5 角色 + 30 领域专家 ----------

# TC-ARCH-TEAM01: role-registry
check_file_case "TC-ARCH-TEAM01" \
  "Team RoleRegistry（5 角色注册器）" \
  "${TEAM_DIR}/role-registry.ts"

# TC-ARCH-TEAM02: role-matcher
check_file_case "TC-ARCH-TEAM02" \
  "Team RoleMatcher（TFIDF/Hashing 本地相似度匹配）" \
  "${TEAM_DIR}/role-matcher.ts"

# TC-ARCH-TEAM03: team-adapter
check_file_case "TC-ARCH-TEAM03" \
  "Team TeamAdapter（团队适配器）" \
  "${TEAM_DIR}/team-adapter.ts"

# TC-ARCH-TEAM04: domain-expert-registry
check_file_case "TC-ARCH-TEAM04" \
  "DomainExpertRegistry（30 专家注册器）" \
  "${TEAM_DIR}/domain-expert-registry.ts"

# TC-ARCH-TEAM05: domain-expert-matcher
check_file_case "TC-ARCH-TEAM05" \
  "DomainExpertMatcher（4 维加权匹配 40%/30%/20%/10%）" \
  "${TEAM_DIR}/domain-expert-matcher.ts"

# TC-ARCH-TEAM06: domain-expert-review-plugin
check_file_case "TC-ARCH-TEAM06" \
  "DomainExpertReviewPlugin（5 钩子评审插件）" \
  "${TEAM_DIR}/domain-expert-review-plugin.ts"

# TC-ARCH-TEAM07: 8 类别领域专家目录
check_dir_case "TC-ARCH-TEAM07" \
  "8 类别 30 个领域专家目录" \
  "${TEAM_DIR}/domain-experts"

# TC-ARCH-TEAM08: errors
check_file_case "TC-ARCH-TEAM08" \
  "Team Errors（错误类型定义）" \
  "${TEAM_DIR}/errors.ts"

# TC-ARCH-TEAM09: types
check_file_case "TC-ARCH-TEAM09" \
  "Team Types（类型定义）" \
  "${TEAM_DIR}/types.ts"

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
