/**
 * EAG-P6 Phase 3 单元测试 + 集成测试
 *
 * 测试范围（86 个 TC）：
 *
 * A. role-knowledge-slices 测试（18 个 TC）
 *    - TC-ROLE-001~018：5 角色 × 4 阶段切片完整性 + skill 融合关键内容 + 查询函数 + 冻结性
 *
 * B. role-signal-detector 测试（27 个 TC）
 *    - TC-SIGNAL-001~027：关键词匹配 + 语义匹配（TFIDF/Hashing/embedding）+ 任务类型推断
 *      + 综合置信度排序 + 低置信度过滤 + 可解释性 + 冻结性
 *
 * C. role-prompt-customizer 测试（15 个 TC）
 *    - TC-CUSTOM-001~015：单角色定制 + 多角色定制 + 协作角色选择 + 去重 + 置信度过滤
 *      + skill 融合注入 + 冻结性
 *
 * D. five-stage-prompt-assembler 测试（22 个 TC）
 *    - TC-PROMPT-001~022：五段式组装 + Token 预算分配（10/15/50/15/10）+ 截断策略
 *      + skill 融合注入 + 冻结性
 *
 * E. 集成测试（4 个 TC）
 *    - TC-INT-001：FiveStagePromptAssembler + RolePromptCustomizer 集成
 *    - TC-INT-002：FiveStagePromptAssembler + RolePromptCustomizer + DynamicWindowManager 集成
 *    - TC-INT-003：RoleSignalDetector + RolePromptCustomizer + FiveStagePromptAssembler 集成
 *    - TC-INT-004：Phase 1+2+3 全链路集成（StaticSymbolGraph + DynamicWindowManager
 *      + RoleSignalDetector + RolePromptCustomizer + FiveStagePromptAssembler）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象与真实图谱数据
 * - 测试图谱与 Phase 2 测试一致：5 节点 5 边环形结构
 *
 * 测试图谱设计（5 节点 5 边，环形结构，与 Phase 2 测试一致）：
 *   UserService ──e1──→ login ──e2──→ verifyToken ──e3──→ AuthModule ──e4──→ logger
 *       ↑                                                                    │
 *       └────────────────────── e5 ──────────────────────────────────────────┘
 *
 * @module core/tests/eag-p6-prompt-assembler
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// ============================================================================
// 导入待测试模块
// ============================================================================

// Phase 3 模块
import {
  ROLE_KINDS,
  ROLE_PHASES,
  PHASE_KNOWLEDGE_SLICES,
  toV2LoopPhase,
  getPhaseKnowledgeSlice,
  listAllPhaseKnowledgeSlices,
  listSlicesByRole,
  listSlicesByPhase,
  type RoleKind,
  type RolePhase,
  type PhaseKnowledgeSlice,
} from "../v2/prompt/role-knowledge-slices";
import {
  DEFAULT_DETECTOR_OPTIONS,
  ROLE_KEYWORDS,
  ROLE_DESCRIPTIONS,
  TASK_TYPE_TO_ROLE,
  TASK_TYPE_KEYWORDS,
  TASK_TYPES,
  inferTaskType,
  RoleSignalDetector,
  detectRoleSignals,
  type RoleSignal,
  type TaskContext,
  type TaskType,
  type SemanticFallbackLevel,
} from "../v2/prompt/role-signal-detector";
import {
  DEFAULT_CUSTOMIZER_OPTIONS,
  ROLE_IDENTITY_DESCRIPTIONS,
  RolePromptCustomizer,
  customizeRolePrompt,
  customizeRolePromptFromSignals,
  type RolePromptCustomization,
} from "../v2/prompt/role-prompt-customizer";
import {
  DEFAULT_TOTAL_TOKEN_BUDGET,
  FIVE_STAGE_RATIOS,
  FiveStagePromptAssembler,
  assembleFiveStagePrompt,
  type FiveStagePromptInput,
  type FiveStagePromptResult,
  type TokenBudgetBreakdown,
} from "../v2/prompt/five-stage-prompt-assembler";

// Phase 2 模块（用于集成测试）
import { CodeMapSnippetProvider } from "../v2/context/code-map-snippet-provider";
import { DynamicWindowManager } from "../v2/context/dynamic-window-manager";
import { StaticSymbolGraph } from "../v2/context/static-symbol-graph";
import type { EdgeRecord, StaticGraphData, SymbolRecord } from "../v2/context/symbol-graph-types";
import type { DynamicWindowQuery, DynamicWindowResult, LoopPhase } from "../v2/context/dynamic-window-types";

// ============================================================================
// 测试数据：5 节点 5 边的环形图谱（与 Phase 2 测试一致）
// ============================================================================

/**
 * 测试图谱节点列表（5 个符号，覆盖 class/function 两种 kind）
 *
 * importance 设计（用于验证 DW-3 风险热点排序）：
 * - logger: 0.9（最高，验证风险热点排序）
 * - UserService: 0.8
 * - login: 0.7
 * - verifyToken: 0.6
 * - AuthModule: 0.5（最低）
 *
 * 注：部分符号含 embedding 字段，用于测试 RoleSignalDetector 的 embedding 降级链
 */
const TEST_SYMBOLS: SymbolRecord[] = [
  {
    symbolId: "src/A.ts:UserService",
    kind: "class",
    name: "UserService",
    signature: "class UserService { login(email, password): Promise<AuthToken> }",
    filePath: "src/A.ts",
    startLine: 10,
    endLine: 80,
    summary: "用户服务类，封装登录与权限校验",
    importance: 0.8,
    embedding: [0.1, 0.2, 0.3, 0.4],
  },
  {
    symbolId: "src/B.ts:login",
    kind: "function",
    name: "login",
    signature: "login(email: string, password: string): Promise<AuthToken>",
    filePath: "src/B.ts",
    startLine: 5,
    endLine: 30,
    summary: "用户登录函数，校验凭证后颁发 token",
    importance: 0.7,
    embedding: [0.2, 0.3, 0.4, 0.5],
  },
  {
    symbolId: "src/C.ts:verifyToken",
    kind: "function",
    name: "verifyToken",
    signature: "verifyToken(token: string): Promise<boolean>",
    filePath: "src/C.ts",
    startLine: 1,
    endLine: 20,
    summary: "验证 JWT token 有效性",
    importance: 0.6,
  },
  {
    symbolId: "src/D.ts:AuthModule",
    kind: "class",
    name: "AuthModule",
    signature: "class AuthModule { authenticate(req): Promise<User> }",
    filePath: "src/D.ts",
    startLine: 15,
    endLine: 50,
    summary: "认证模块，集成 OAuth 与 JWT",
    importance: 0.5,
  },
  {
    symbolId: "src/E.ts:logger",
    kind: "function",
    name: "logger",
    signature: "logger(level: string, message: string): void",
    filePath: "src/E.ts",
    startLine: 1,
    endLine: 10,
    summary: "日志记录函数",
    importance: 0.9,
  },
];

/**
 * 测试图谱边列表（5 条边，形成环形结构）
 */
const TEST_EDGES: EdgeRecord[] = [
  {
    edgeId: "e1",
    srcSymbolId: "src/A.ts:UserService",
    dstSymbolId: "src/B.ts:login",
    edgeKind: "CALLS",
    confidence: "HIGH",
  },
  {
    edgeId: "e2",
    srcSymbolId: "src/B.ts:login",
    dstSymbolId: "src/C.ts:verifyToken",
    edgeKind: "CALLS",
    confidence: "HIGH",
  },
  {
    edgeId: "e3",
    srcSymbolId: "src/C.ts:verifyToken",
    dstSymbolId: "src/D.ts:AuthModule",
    edgeKind: "CALLS",
    confidence: "MEDIUM",
  },
  {
    edgeId: "e4",
    srcSymbolId: "src/D.ts:AuthModule",
    dstSymbolId: "src/E.ts:logger",
    edgeKind: "CALLS",
    confidence: "LOW",
  },
  {
    edgeId: "e5",
    srcSymbolId: "src/E.ts:logger",
    dstSymbolId: "src/A.ts:UserService",
    edgeKind: "CALLS",
    confidence: "MEDIUM",
  },
];

/** 测试图谱数据包（符号 + 边） */
const TEST_GRAPH_DATA: StaticGraphData = {
  symbolRecords: TEST_SYMBOLS,
  edgeRecords: TEST_EDGES,
};

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 构造测试用的 CodeMapSnippetProvider（使用 StaticSymbolGraph 真实图谱）
 */
function createTestProvider(): CodeMapSnippetProvider {
  const adapter = new StaticSymbolGraph(TEST_GRAPH_DATA);
  return new CodeMapSnippetProvider(adapter, () => true);
}

/**
 * 构造测试用的 DynamicWindowManager（使用真实 CodeMapSnippetProvider）
 */
function createTestManager(): DynamicWindowManager {
  const provider = createTestProvider();
  return new DynamicWindowManager(provider, () => true);
}

/**
 * 构造测试用的 DynamicWindowQuery
 */
function createTestQuery(
  phase: LoopPhase,
  focusPoints: ReadonlyArray<string> = ["UserService"],
  impactRoots: ReadonlyArray<string> = ["src/A.ts:UserService"],
  role: string = "solo_coder"
): DynamicWindowQuery {
  return {
    focusPoints,
    impactRoots,
    riskTopN: 5,
    maxSnippets: 30,
    role,
    phase,
  };
}

// ============================================================================
// A. role-knowledge-slices 测试（18 个 TC）
// ============================================================================

test("TC-ROLE-001: ROLE_KINDS 包含 5 个角色（architect/product_manager/solo_coder/test_expert/ui_designer）", () => {
  assert.equal(ROLE_KINDS.length, 5, "ROLE_KINDS 应包含 5 个角色");
  assert.ok(ROLE_KINDS.includes("architect"), "应包含 architect");
  assert.ok(ROLE_KINDS.includes("product_manager"), "应包含 product_manager");
  assert.ok(ROLE_KINDS.includes("solo_coder"), "应包含 solo_coder");
  assert.ok(ROLE_KINDS.includes("test_expert"), "应包含 test_expert");
  assert.ok(ROLE_KINDS.includes("ui_designer"), "应包含 ui_designer");
});

test("TC-ROLE-002: ROLE_PHASES 包含 4 个阶段（design/coding/testing/handover）", () => {
  assert.equal(ROLE_PHASES.length, 4, "ROLE_PHASES 应包含 4 个阶段");
  assert.ok(ROLE_PHASES.includes("design"), "应包含 design");
  assert.ok(ROLE_PHASES.includes("coding"), "应包含 coding");
  assert.ok(ROLE_PHASES.includes("testing"), "应包含 testing");
  assert.ok(ROLE_PHASES.includes("handover"), "应包含 handover");
});

test("TC-ROLE-003: PHASE_KNOWLEDGE_SLICES 包含 20 个切片（5 角色 × 4 阶段）", () => {
  assert.equal(PHASE_KNOWLEDGE_SLICES.length, 20, "应包含 5×4=20 个切片");
  // 验证每个角色都有 4 个阶段切片
  for (const role of ROLE_KINDS) {
    const roleSlices = PHASE_KNOWLEDGE_SLICES.filter((s) => s.role === role);
    assert.equal(roleSlices.length, 4, `角色 ${role} 应有 4 个阶段切片`);
  }
  // 验证每个阶段都有 5 个角色切片
  for (const phase of ROLE_PHASES) {
    const phaseSlices = PHASE_KNOWLEDGE_SLICES.filter((s) => s.phase === phase);
    assert.equal(phaseSlices.length, 5, `阶段 ${phase} 应有 5 个角色切片`);
  }
});

test("TC-ROLE-004: 每个切片字段非空（phaseGoal/keyChecks/commonPitfalls/outputFormat/historicalExperience）", () => {
  for (const slice of PHASE_KNOWLEDGE_SLICES) {
    assert.ok(slice.phaseGoal.length > 0, `${slice.role}/${slice.phase} phaseGoal 不应为空`);
    assert.ok(slice.keyChecks.length > 0, `${slice.role}/${slice.phase} keyChecks 不应为空`);
    assert.ok(slice.commonPitfalls.length > 0, `${slice.role}/${slice.phase} commonPitfalls 不应为空`);
    assert.ok(slice.outputFormat.length > 0, `${slice.role}/${slice.phase} outputFormat 不应为空`);
    assert.ok(slice.historicalExperience.length > 0, `${slice.role}/${slice.phase} historicalExperience 不应为空`);
  }
});

test('TC-ROLE-005: architect design 切片含 skill 融合关键内容 "四步分析框架"', () => {
  const slice = getPhaseKnowledgeSlice("architect", "design");
  assert.ok(slice.phaseGoal.includes("四步分析框架"), 'architect design 切片应含 "四步分析框架"');
  assert.ok(slice.phaseGoal.includes("架构风格识别"), 'architect design 切片应含 "架构风格识别"');
});

test('TC-ROLE-006: product_manager design 切片含 skill 融合关键内容 "bite-sized" 与 "每步 2-5 分钟可验证"', () => {
  const slice = getPhaseKnowledgeSlice("product_manager", "design");
  const fullText = `${slice.phaseGoal} ${slice.keyChecks.join(" ")} ${slice.historicalExperience}`;
  assert.ok(
    fullText.includes("bite-sized") || fullText.includes("2-5 分钟"),
    'product_manager design 切片应含 "bite-sized" 或 "2-5 分钟"'
  );
});

test('TC-ROLE-007: solo_coder coding 切片含 skill 融合关键内容 "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST"', () => {
  const slice = getPhaseKnowledgeSlice("solo_coder", "coding");
  const fullText = `${slice.phaseGoal} ${slice.keyChecks.join(" ")} ${slice.commonPitfalls.join(" ")} ${slice.historicalExperience}`;
  assert.ok(
    fullText.includes("NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST"),
    'solo_coder coding 切片应含 "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST"'
  );
});

test('TC-ROLE-008: test_expert testing 切片含 skill 融合关键内容 "假设→插桩→复现→分析→修复→验证"', () => {
  const slice = getPhaseKnowledgeSlice("test_expert", "testing");
  const fullText = `${slice.phaseGoal} ${slice.keyChecks.join(" ")} ${slice.commonPitfalls.join(" ")} ${slice.historicalExperience}`;
  assert.ok(fullText.includes("假设"), 'test_expert testing 切片应含 "假设"');
  assert.ok(fullText.includes("插桩"), 'test_expert testing 切片应含 "插桩"');
  assert.ok(fullText.includes("复现"), 'test_expert testing 切片应含 "复现"');
  assert.ok(fullText.includes("验证"), 'test_expert testing 切片应含 "验证"');
});

test('TC-ROLE-009: ui_designer design 切片含 skill 融合关键内容 "反 AI-slop" 与禁用字体清单', () => {
  const slice = getPhaseKnowledgeSlice("ui_designer", "design");
  const fullText = `${slice.phaseGoal} ${slice.keyChecks.join(" ")} ${slice.commonPitfalls.join(" ")} ${slice.historicalExperience}`;
  assert.ok(
    fullText.includes("AI-slop") || fullText.includes("AI slop"),
    'ui_designer design 切片应含 "AI-slop" 或 "AI slop"'
  );
  // 禁用字体清单（Inter/Roboto/Arial/system-ui）
  assert.ok(
    fullText.includes("Inter") || fullText.includes("Roboto") || fullText.includes("Arial"),
    "ui_designer design 切片应含禁用字体清单"
  );
});

test("TC-ROLE-010: getPhaseKnowledgeSlice 返回正确切片（architect/coding）", () => {
  const slice = getPhaseKnowledgeSlice("architect", "coding");
  assert.equal(slice.role, "architect");
  assert.equal(slice.phase, "coding");
  assert.ok(slice.phaseGoal.length > 0);
});

test("TC-ROLE-011: getPhaseKnowledgeSlice 非法 role 抛错", () => {
  assert.throws(() => getPhaseKnowledgeSlice("invalid_role" as RoleKind, "design"), /非法 RoleKind/);
});

test("TC-ROLE-012: getPhaseKnowledgeSlice 非法 phase 抛错", () => {
  assert.throws(() => getPhaseKnowledgeSlice("architect", "invalid_phase" as RolePhase), /非法 RolePhase/);
});

test("TC-ROLE-013: listAllPhaseKnowledgeSlices 返回全部 20 个切片", () => {
  const slices = listAllPhaseKnowledgeSlices();
  assert.equal(slices.length, 20);
  assert.ok(Object.isFrozen(slices), "返回的数组应已冻结");
});

test("TC-ROLE-014: listSlicesByRole 返回该角色的 4 个阶段切片", () => {
  const slices = listSlicesByRole("solo_coder");
  assert.equal(slices.length, 4);
  for (const slice of slices) {
    assert.equal(slice.role, "solo_coder");
  }
});

test("TC-ROLE-015: listSlicesByPhase 返回该阶段的 5 个角色切片", () => {
  const slices = listSlicesByPhase("testing");
  assert.equal(slices.length, 5);
  for (const slice of slices) {
    assert.equal(slice.phase, "testing");
  }
});

test("TC-ROLE-016: toV2LoopPhase handover → deploy 映射正确", () => {
  assert.equal(toV2LoopPhase("handover"), "deploy");
});

test("TC-ROLE-017: toV2LoopPhase 其他 phase 一一映射（design/coding/testing）", () => {
  assert.equal(toV2LoopPhase("design"), "design");
  assert.equal(toV2LoopPhase("coding"), "coding");
  assert.equal(toV2LoopPhase("testing"), "testing");
});

test("TC-ROLE-018: 所有切片与顶层常量已 Object.freeze 冻结", () => {
  // 顶层常量
  assert.ok(Object.isFrozen(ROLE_KINDS), "ROLE_KINDS 应已冻结");
  assert.ok(Object.isFrozen(ROLE_PHASES), "ROLE_PHASES 应已冻结");
  assert.ok(Object.isFrozen(PHASE_KNOWLEDGE_SLICES), "PHASE_KNOWLEDGE_SLICES 应已冻结");
  // 每个切片
  for (const slice of PHASE_KNOWLEDGE_SLICES) {
    assert.ok(Object.isFrozen(slice), `${slice.role}/${slice.phase} 切片应已冻结`);
    assert.ok(Object.isFrozen(slice.keyChecks), `${slice.role}/${slice.phase} keyChecks 应已冻结`);
    assert.ok(Object.isFrozen(slice.commonPitfalls), `${slice.role}/${slice.phase} commonPitfalls 应已冻结`);
  }
});

// ============================================================================
// B. role-signal-detector 测试（27 个 TC）
// ============================================================================

test('TC-SIGNAL-001: 关键词匹配 - "架构" → architect 置信度最高', () => {
  const detector = new RoleSignalDetector();
  const signals = detector.detect({
    title: "架构设计任务",
    description: "请设计微服务架构并输出 ADR",
  });
  assert.ok(signals.length > 0, "应检测到至少 1 个角色信号");
  assert.equal(signals[0]?.role, "architect", "主角色应为 architect");
});

test('TC-SIGNAL-002: 关键词匹配 - "测试" → test_expert 置信度最高', () => {
  const detector = new RoleSignalDetector();
  const signals = detector.detect({
    title: "测试任务",
    description: "请编写单元测试与自动化测试",
  });
  assert.ok(signals.length > 0);
  assert.equal(signals[0]?.role, "test_expert");
});

test('TC-SIGNAL-003: 关键词匹配 - "实现" → solo_coder 置信度最高', () => {
  const detector = new RoleSignalDetector();
  const signals = detector.detect({
    title: "实现功能",
    description: "请开发新功能并编写代码",
  });
  assert.ok(signals.length > 0);
  assert.equal(signals[0]?.role, "solo_coder");
});

test('TC-SIGNAL-004: 关键词匹配 - "UI设计" → ui_designer 置信度最高', () => {
  const detector = new RoleSignalDetector();
  const signals = detector.detect({
    title: "UI设计任务",
    description: "请设计界面并产出视觉规范",
  });
  assert.ok(signals.length > 0);
  assert.equal(signals[0]?.role, "ui_designer");
});

test('TC-SIGNAL-005: 关键词匹配 - "需求" → product_manager 置信度最高', () => {
  const detector = new RoleSignalDetector();
  const signals = detector.detect({
    title: "需求分析任务",
    description: "请编写 PRD 与用户故事",
  });
  assert.ok(signals.length > 0);
  assert.equal(signals[0]?.role, "product_manager");
});

test("TC-SIGNAL-006: 关键词匹配 - 多角色混合任务（架构+测试）", () => {
  const detector = new RoleSignalDetector();
  // 使用丰富的任务描述，确保 architect 与 test_expert 都能达到置信度阈值
  // architect 关键词命中：架构、设计、微服务、ADR、架构师 = 5/17 ≈ 0.294
  // test_expert 关键词命中：测试、测试专家、自动化、单元测试 = 4/15 ≈ 0.267
  const signals = detector.detect({
    title: "架构设计 + 测试用例编写 + 自动化测试",
    description: "请架构师设计微服务架构并输出 ADR，测试专家编写单元测试与自动化测试用例",
  });
  assert.ok(signals.length >= 2, "应检测到至少 2 个角色信号");
  // architect 与 test_expert 都应在结果中
  const roles = signals.map((s) => s.role);
  assert.ok(roles.includes("architect"), "应包含 architect");
  assert.ok(roles.includes("test_expert"), "应包含 test_expert");
});

test("TC-SIGNAL-007: 语义匹配 - 无 embedding 时降级到 TFIDF", () => {
  const detector = new RoleSignalDetector();
  const context: TaskContext = {
    title: "架构设计",
    description: "设计微服务架构",
    // 不提供 symbols，触发 TFIDF 降级
  };
  const level = detector.getSemanticFallbackLevel(context);
  assert.equal(level, "tfidf", "无 embedding 时应降级到 tfidf");
});

test("TC-SIGNAL-008: 语义匹配 - 有 embedding 时使用 embedding 层级", () => {
  const detector = new RoleSignalDetector();
  const context: TaskContext = {
    title: "架构设计",
    description: "设计微服务架构",
    symbols: TEST_SYMBOLS, // 部分符号含 embedding
  };
  const level = detector.getSemanticFallbackLevel(context);
  assert.equal(level, "embedding", "有 embedding 时应使用 embedding 层级");
});

test("TC-SIGNAL-009: 任务类型推断 - design → architect", () => {
  assert.equal(inferTaskType("架构设计 ADR"), "design");
});

test("TC-SIGNAL-010: 任务类型推断 - implementation → solo_coder", () => {
  assert.equal(inferTaskType("实现功能 编码 TDD"), "implementation");
});

test("TC-SIGNAL-011: 任务类型推断 - testing → test_expert", () => {
  assert.equal(inferTaskType("测试 验收 自动化"), "testing");
});

test("TC-SIGNAL-012: 任务类型推断 - review → architect", () => {
  assert.equal(inferTaskType("代码审查 评审 review"), "review");
});

test("TC-SIGNAL-013: 任务类型推断 - planning → product_manager", () => {
  assert.equal(inferTaskType("规划 需求 PRD 用户故事"), "planning");
});

test("TC-SIGNAL-014: 任务类型推断 - ui → ui_designer", () => {
  assert.equal(inferTaskType("UI 界面 前端 视觉"), "ui");
});

test("TC-SIGNAL-015: 任务类型推断 - 空文本返回 null", () => {
  assert.equal(inferTaskType(""), null);
  assert.equal(inferTaskType("   "), null);
});

test("TC-SIGNAL-016: 综合置信度按降序排序", () => {
  const detector = new RoleSignalDetector();
  // 使用丰富的任务描述，确保多个角色都能达到置信度阈值
  // architect 命中：架构、设计、架构师、ADR = 4/17 ≈ 0.235
  // test_expert 命中：测试、测试专家、自动化 = 3/15 = 0.2
  // solo_coder 命中：实现、代码、独立开发者 = 3/15 = 0.2
  const signals = detector.detect({
    title: "架构设计测试实现",
    description: "架构师设计架构输出 ADR，测试专家编写测试用例与自动化测试，独立开发者实现代码",
  });
  assert.ok(signals.length >= 2, "应检测到至少 2 个角色信号");
  // 验证降序排序
  for (let i = 1; i < signals.length; i++) {
    const prev = signals[i - 1];
    const curr = signals[i];
    if (prev === undefined || curr === undefined) continue;
    assert.ok(prev.confidence >= curr.confidence, `信号应按置信度降序排序：${prev.confidence} >= ${curr.confidence}`);
  }
});

test("TC-SIGNAL-017: 低置信度过滤（< minConfidenceThreshold）", () => {
  const detector = new RoleSignalDetector({
    minConfidenceThreshold: 0.5, // 高阈值
  });
  const signals = detector.detect({
    title: "架构",
    description: "架构",
  });
  // 所有信号的置信度应 >= 0.5
  for (const signal of signals) {
    assert.ok(signal.confidence >= 0.5, `信号置信度 ${signal.confidence} 应 >= 0.5`);
  }
});

test("TC-SIGNAL-018: RoleSignal 包含可解释原因（reasons 非空）", () => {
  const detector = new RoleSignalDetector();
  const signals = detector.detect({
    title: "架构设计",
    description: "设计微服务架构",
  });
  assert.ok(signals.length > 0);
  for (const signal of signals) {
    assert.ok(signal.reasons.length > 0, `${signal.role} 信号应包含原因`);
  }
});

test("TC-SIGNAL-019: RoleSignal 已 Object.freeze 冻结", () => {
  const detector = new RoleSignalDetector();
  const signals = detector.detect({
    title: "架构设计",
    description: "设计微服务架构",
  });
  assert.ok(Object.isFrozen(signals), "signals 数组应已冻结");
  for (const signal of signals) {
    assert.ok(Object.isFrozen(signal), "每个 RoleSignal 应已冻结");
    assert.ok(Object.isFrozen(signal.reasons), "reasons 数组应已冻结");
  }
});

test("TC-SIGNAL-020: getSemanticFallbackLevel 返回正确层级", () => {
  const detector = new RoleSignalDetector();
  // TFIDF 降级
  const tfidfLevel = detector.getSemanticFallbackLevel({
    title: "架构",
    description: "设计",
  });
  assert.equal(tfidfLevel, "tfidf");
  // embedding 层级
  const embeddingLevel = detector.getSemanticFallbackLevel({
    title: "架构",
    description: "设计",
    symbols: TEST_SYMBOLS,
  });
  assert.equal(embeddingLevel, "embedding");
  // none 层级（空文本）
  const noneLevel = detector.getSemanticFallbackLevel({
    title: "",
    description: "",
  });
  assert.equal(noneLevel, "none");
});

test("TC-SIGNAL-021: 自定义选项生效（keywordWeight 调整）", () => {
  const detector = new RoleSignalDetector({
    keywordWeight: 0.8,
    semanticWeight: 0.1,
    taskTypeWeight: 0.1,
  });
  const options = detector.getOptions();
  assert.equal(options.keywordWeight, 0.8);
  assert.equal(options.semanticWeight, 0.1);
  assert.equal(options.taskTypeWeight, 0.1);
  assert.ok(Object.isFrozen(options), "options 应已冻结");
});

test("TC-SIGNAL-022: 角色关键词表覆盖用户任务描述要求的 5 个关键词", () => {
  // 用户任务描述明确要求的关键词映射
  assert.ok(ROLE_KEYWORDS.architect.includes("架构"));
  assert.ok(ROLE_KEYWORDS.test_expert.includes("测试"));
  assert.ok(ROLE_KEYWORDS.solo_coder.includes("实现"));
  assert.ok(ROLE_KEYWORDS.ui_designer.some((k) => k.includes("UI设计")));
  assert.ok(ROLE_KEYWORDS.product_manager.includes("需求"));
});

test("TC-SIGNAL-023: TASK_TYPE_TO_ROLE 涵盖 6 种任务类型", () => {
  assert.equal(Object.keys(TASK_TYPE_TO_ROLE).length, 6);
  assert.equal(TASK_TYPE_TO_ROLE.design, "architect");
  assert.equal(TASK_TYPE_TO_ROLE.implementation, "solo_coder");
  assert.equal(TASK_TYPE_TO_ROLE.testing, "test_expert");
  assert.equal(TASK_TYPE_TO_ROLE.review, "architect");
  assert.equal(TASK_TYPE_TO_ROLE.planning, "product_manager");
  assert.equal(TASK_TYPE_TO_ROLE.ui, "ui_designer");
});

test("TC-SIGNAL-024: TASK_TYPES 包含 6 种任务类型", () => {
  assert.equal(TASK_TYPES.length, 6);
  assert.ok(TASK_TYPES.includes("design"));
  assert.ok(TASK_TYPES.includes("implementation"));
  assert.ok(TASK_TYPES.includes("testing"));
  assert.ok(TASK_TYPES.includes("review"));
  assert.ok(TASK_TYPES.includes("planning"));
  assert.ok(TASK_TYPES.includes("ui"));
});

test("TC-SIGNAL-025: DEFAULT_DETECTOR_OPTIONS 权重之和 = 1.0", () => {
  const sum =
    DEFAULT_DETECTOR_OPTIONS.keywordWeight +
    DEFAULT_DETECTOR_OPTIONS.semanticWeight +
    DEFAULT_DETECTOR_OPTIONS.taskTypeWeight;
  // 浮点数比较，使用近似相等
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `权重之和应为 1.0，实际为 ${sum}`);
});

test("TC-SIGNAL-026: ROLE_DESCRIPTIONS 包含 5 角色描述文档", () => {
  assert.equal(Object.keys(ROLE_DESCRIPTIONS).length, 5);
  for (const role of ROLE_KINDS) {
    assert.ok(ROLE_DESCRIPTIONS[role].length > 0, `${role} 描述文档不应为空`);
  }
});

test("TC-SIGNAL-027: 空任务上下文返回空数组（无任何信号命中）", () => {
  const detector = new RoleSignalDetector();
  const signals = detector.detect({
    title: "",
    description: "",
  });
  // 空文本时所有角色置信度都为 0，应被过滤
  assert.equal(signals.length, 0, "空任务上下文应返回空数组（所有信号被过滤）");
});

// ============================================================================
// C. role-prompt-customizer 测试（15 个 TC）
// ============================================================================

test("TC-CUSTOM-001: customize 单角色定制 - 主角色切片正确", () => {
  const customizer = new RolePromptCustomizer();
  const result = customizer.customize("architect", "design");
  assert.equal(result.primaryRole, "architect");
  assert.equal(result.primarySlice.role, "architect");
  assert.equal(result.primarySlice.phase, "design");
});

test("TC-CUSTOM-002: customize 单角色定制 - 无协作角色", () => {
  const customizer = new RolePromptCustomizer();
  const result = customizer.customize("solo_coder", "coding");
  assert.equal(result.collaboratorRoles.length, 0);
  assert.equal(result.collaboratorSlices.length, 0);
});

test("TC-CUSTOM-003: customize 单角色定制 - fullPrompt 包含 karpathyPreamble", () => {
  const customizer = new RolePromptCustomizer();
  const result = customizer.customize("architect", "design");
  assert.ok(result.fullPrompt.includes("Karpathy"), "fullPrompt 应包含 Karpathy 4 原则");
  assert.ok(result.fullPrompt.includes("Ponytail"), "fullPrompt 应包含 Ponytail 16 红线");
  assert.equal(result.karpathyPreamble, result.fullPrompt.slice(0, result.karpathyPreamble.length));
});

test("TC-CUSTOM-004: customize 单角色定制 - fullPrompt 包含 roleIdentityPrompt", () => {
  const customizer = new RolePromptCustomizer();
  const result = customizer.customize("test_expert", "testing");
  assert.ok(result.fullPrompt.includes(result.roleIdentityPrompt), "fullPrompt 应包含 roleIdentityPrompt");
  assert.ok(result.roleIdentityPrompt.includes("测试专家"), 'roleIdentityPrompt 应包含 "测试专家"');
});

test("TC-CUSTOM-005: customize 单角色定制 - fullPrompt 包含 phaseKnowledgePrompt", () => {
  const customizer = new RolePromptCustomizer();
  const result = customizer.customize("ui_designer", "design");
  assert.ok(result.fullPrompt.includes(result.phaseKnowledgePrompt), "fullPrompt 应包含 phaseKnowledgePrompt");
  assert.ok(result.phaseKnowledgePrompt.includes("ui_designer"), "phaseKnowledgePrompt 应包含角色名");
});

test("TC-CUSTOM-006: customize 非法 role 抛错", () => {
  const customizer = new RolePromptCustomizer();
  assert.throws(() => customizer.customize("invalid_role" as RoleKind, "design"), /非法 RoleKind/);
});

test("TC-CUSTOM-007: customizeFromSignals 主角色选择正确（取 confidence 最高）", () => {
  const customizer = new RolePromptCustomizer();
  // 构造真实 RoleSignal[]（按 confidence 降序）
  const signals: ReadonlyArray<RoleSignal> = [
    {
      role: "architect",
      confidence: 0.8,
      source: "keyword",
      reasons: ["关键词命中：架构"],
    },
    {
      role: "solo_coder",
      confidence: 0.3,
      source: "keyword",
      reasons: ["关键词命中：实现"],
    },
  ];
  const result = customizer.customizeFromSignals(signals, "design");
  assert.equal(result.primaryRole, "architect", "主角色应为 architect（confidence 最高）");
});

test("TC-CUSTOM-008: customizeFromSignals 协作角色选择正确", () => {
  const customizer = new RolePromptCustomizer();
  const signals: ReadonlyArray<RoleSignal> = [
    { role: "architect", confidence: 0.8, source: "keyword", reasons: [] },
    { role: "solo_coder", confidence: 0.5, source: "keyword", reasons: [] },
    { role: "test_expert", confidence: 0.4, source: "keyword", reasons: [] },
  ];
  const result = customizer.customizeFromSignals(signals, "coding");
  assert.equal(result.collaboratorRoles.length, 2, "应有 2 个协作角色");
  assert.equal(result.collaboratorRoles[0], "solo_coder");
  assert.equal(result.collaboratorRoles[1], "test_expert");
});

test("TC-CUSTOM-009: customizeFromSignals 协作角色数量上限（默认 2）", () => {
  const customizer = new RolePromptCustomizer();
  const signals: ReadonlyArray<RoleSignal> = [
    { role: "architect", confidence: 0.8, source: "keyword", reasons: [] },
    { role: "solo_coder", confidence: 0.7, source: "keyword", reasons: [] },
    { role: "test_expert", confidence: 0.6, source: "keyword", reasons: [] },
    { role: "ui_designer", confidence: 0.5, source: "keyword", reasons: [] },
    { role: "product_manager", confidence: 0.4, source: "keyword", reasons: [] },
  ];
  const result = customizer.customizeFromSignals(signals, "design");
  assert.equal(
    result.collaboratorRoles.length,
    DEFAULT_CUSTOMIZER_OPTIONS.maxCollaborators,
    `协作角色数量应等于 maxCollaborators=${DEFAULT_CUSTOMIZER_OPTIONS.maxCollaborators}`
  );
});

test("TC-CUSTOM-010: customizeFromSignals 协作角色置信度过滤", () => {
  const customizer = new RolePromptCustomizer({
    collaboratorConfidenceThreshold: 0.5,
  });
  const signals: ReadonlyArray<RoleSignal> = [
    { role: "architect", confidence: 0.8, source: "keyword", reasons: [] },
    { role: "solo_coder", confidence: 0.6, source: "keyword", reasons: [] }, // 通过
    { role: "test_expert", confidence: 0.3, source: "keyword", reasons: [] }, // 被过滤
  ];
  const result = customizer.customizeFromSignals(signals, "coding");
  assert.equal(result.collaboratorRoles.length, 1);
  assert.equal(result.collaboratorRoles[0], "solo_coder");
});

test("TC-CUSTOM-011: customizeFromSignals 主角色与协作角色去重", () => {
  const customizer = new RolePromptCustomizer();
  // 构造重复角色（architect 出现两次）
  const signals: ReadonlyArray<RoleSignal> = [
    { role: "architect", confidence: 0.8, source: "keyword", reasons: [] },
    { role: "architect", confidence: 0.7, source: "semantic", reasons: [] }, // 重复，应被过滤
    { role: "solo_coder", confidence: 0.5, source: "keyword", reasons: [] },
  ];
  const result = customizer.customizeFromSignals(signals, "design");
  assert.equal(result.primaryRole, "architect");
  // 协作角色不应包含 architect
  assert.ok(!result.collaboratorRoles.includes("architect"), "协作角色不应包含主角色");
  assert.equal(result.collaboratorRoles[0], "solo_coder");
});

test("TC-CUSTOM-012: customizeFromSignals 空 signals 抛错", () => {
  const customizer = new RolePromptCustomizer();
  assert.throws(() => customizer.customizeFromSignals([], "design"), /signals 不能为空/);
});

test("TC-CUSTOM-013: customizeFromSignals 主角色置信度不足抛错", () => {
  const customizer = new RolePromptCustomizer({
    primaryConfidenceThreshold: 0.9,
  });
  const signals: ReadonlyArray<RoleSignal> = [
    { role: "architect", confidence: 0.5, source: "keyword", reasons: [] }, // 不足 0.9
  ];
  assert.throws(() => customizer.customizeFromSignals(signals, "design"), /主角色置信度不足/);
});

test("TC-CUSTOM-014: RolePromptCustomization 已 Object.freeze 冻结", () => {
  const customizer = new RolePromptCustomizer();
  const result = customizer.customize("architect", "design");
  assert.ok(Object.isFrozen(result), "RolePromptCustomization 应已冻结");
  assert.ok(Object.isFrozen(result.collaboratorRoles), "collaboratorRoles 应已冻结");
  assert.ok(Object.isFrozen(result.collaboratorSlices), "collaboratorSlices 应已冻结");
});

test('TC-CUSTOM-015: skill 融合关键内容注入（architect 含 "四步分析框架"）', () => {
  const customizer = new RolePromptCustomizer();
  const result = customizer.customize("architect", "design");
  assert.ok(result.fullPrompt.includes("四步分析框架"), 'fullPrompt 应注入 "四步分析框架" skill 融合内容');
});

// ============================================================================
// D. five-stage-prompt-assembler 测试（22 个 TC）
// ============================================================================

/**
 * 构造测试用的 FiveStagePromptInput
 */
function createTestInput(totalTokenBudget?: number, dynamicWindow?: DynamicWindowResult): FiveStagePromptInput {
  const roleCustomization = customizeRolePrompt("architect", "design");
  const taskContext: TaskContext = {
    title: "架构设计任务",
    description: "请设计微服务架构并输出 ADR",
    focusPoints: ["UserService"],
    impactRoots: ["src/A.ts:UserService"],
  };
  return {
    taskContext,
    roleCustomization,
    dynamicWindow,
    totalTokenBudget,
  };
}

test("TC-PROMPT-001: assemble 五段全部生成（非空）", () => {
  const assembler = new FiveStagePromptAssembler();
  const result = assembler.assemble(createTestInput());
  assert.ok(result.systemConstraint.length > 0, "段 1 系统约束不应为空");
  assert.ok(result.taskContextText.length > 0, "段 2 任务上下文不应为空");
  assert.ok(result.codeMapSnippetText.length > 0, "段 3 代码地图片段不应为空");
  assert.ok(result.historicalExperienceText.length > 0, "段 4 历史经验不应为空");
  assert.ok(result.outputRequirement.length > 0, "段 5 输出要求不应为空");
  assert.ok(result.fullPrompt.length > 0, "fullPrompt 不应为空");
});

test("TC-PROMPT-002: assemble 段 1 系统约束包含 Karpathy 4 原则", () => {
  const assembler = new FiveStagePromptAssembler();
  const result = assembler.assemble(createTestInput());
  assert.ok(result.systemConstraint.includes("Think Before Coding"), '段 1 应包含 "Think Before Coding"');
  assert.ok(result.systemConstraint.includes("Simplicity First"), '段 1 应包含 "Simplicity First"');
  assert.ok(result.systemConstraint.includes("Surgical Changes"), '段 1 应包含 "Surgical Changes"');
  assert.ok(result.systemConstraint.includes("Goal-Driven"), '段 1 应包含 "Goal-Driven"');
});

test("TC-PROMPT-003: assemble 段 1 系统约束包含 Ponytail 16 红线", () => {
  const assembler = new FiveStagePromptAssembler();
  const result = assembler.assemble(createTestInput());
  assert.ok(result.systemConstraint.includes("Ponytail"), '段 1 应包含 "Ponytail"');
  assert.ok(result.systemConstraint.includes("R-01"), '段 1 应包含 "R-01" 红线');
  assert.ok(result.systemConstraint.includes("R-16"), '段 1 应包含 "R-16" 红线');
});

test("TC-PROMPT-004: assemble 段 2 任务上下文包含标题", () => {
  const assembler = new FiveStagePromptAssembler();
  const result = assembler.assemble(createTestInput());
  assert.ok(result.taskContextText.includes("架构设计任务"), "段 2 应包含任务标题");
});

test("TC-PROMPT-005: assemble 段 2 任务上下文包含描述", () => {
  const assembler = new FiveStagePromptAssembler();
  const result = assembler.assemble(createTestInput());
  assert.ok(result.taskContextText.includes("微服务架构"), "段 2 应包含任务描述");
});

test("TC-PROMPT-006: assemble 段 2 任务上下文包含焦点符号", () => {
  const assembler = new FiveStagePromptAssembler();
  const result = assembler.assemble(createTestInput());
  assert.ok(result.taskContextText.includes("UserService"), "段 2 应包含焦点符号 UserService");
});

test("TC-PROMPT-007: assemble 段 2 任务上下文包含角色身份", () => {
  const assembler = new FiveStagePromptAssembler();
  const result = assembler.assemble(createTestInput());
  assert.ok(result.taskContextText.includes("架构师"), '段 2 应包含角色身份 "架构师"');
});

test("TC-PROMPT-008: assemble 段 3 代码地图片段 - 有 dynamicWindow", () => {
  // 构造真实 DynamicWindowResult
  const manager = createTestManager();
  const dwResult = manager.computeWindow(createTestQuery("coding"));
  const assembler = new FiveStagePromptAssembler();
  const result = assembler.assemble(createTestInput(4000, dwResult));
  assert.ok(
    result.codeMapSnippetText.includes("UserService") ||
      result.codeMapSnippetText.includes("login") ||
      result.codeMapSnippetText.includes("verifyToken"),
    "段 3 应包含 CodeMap 符号"
  );
});

test("TC-PROMPT-009: assemble 段 3 代码地图片段 - 无 dynamicWindow", () => {
  const assembler = new FiveStagePromptAssembler();
  const result = assembler.assemble(createTestInput());
  assert.ok(
    result.codeMapSnippetText.includes("无可用 CodeMap 片段") || result.codeMapSnippetText.includes("CodeMap"),
    "段 3 无 dynamicWindow 时应显示占位提示"
  );
});

test("TC-PROMPT-010: assemble 段 3 代码地图片段 - 空 snippets", () => {
  const assembler = new FiveStagePromptAssembler();
  // 构造空 snippets 的 DynamicWindowResult
  const emptyDwResult: DynamicWindowResult = {
    snippets: [],
    totalTokens: 0,
    source: "dw1",
    droppedLowRelevance: 0,
  };
  const result = assembler.assemble(createTestInput(4000, emptyDwResult));
  assert.ok(
    result.codeMapSnippetText.includes("无可用 CodeMap 片段") || result.codeMapSnippetText.includes("CodeMap"),
    "段 3 空 snippets 时应显示占位提示"
  );
});

test("TC-PROMPT-011: assemble 段 4 历史经验包含主角色经验", () => {
  const assembler = new FiveStagePromptAssembler();
  const result = assembler.assemble(createTestInput());
  assert.ok(result.historicalExperienceText.includes("历史经验"), '段 4 应包含 "历史经验"');
  assert.ok(result.historicalExperienceText.includes("architect"), "段 4 应包含主角色名 architect");
});

test("TC-PROMPT-012: assemble 段 4 历史经验包含协作角色经验（多角色）", () => {
  const assembler = new FiveStagePromptAssembler();
  // 构造含协作角色的 RolePromptCustomization
  const signals: ReadonlyArray<RoleSignal> = [
    { role: "architect", confidence: 0.8, source: "keyword", reasons: [] },
    { role: "solo_coder", confidence: 0.5, source: "keyword", reasons: [] },
  ];
  const roleCustomization = customizeRolePromptFromSignals(signals, "coding");
  const input: FiveStagePromptInput = {
    taskContext: {
      title: "架构 + 实现",
      description: "设计架构并实现功能",
    },
    roleCustomization,
  };
  const result = assembler.assemble(input);
  assert.ok(result.historicalExperienceText.includes("solo_coder"), "段 4 应包含协作角色 solo_coder 的历史经验");
});

test("TC-PROMPT-013: assemble 段 5 输出要求包含主角色格式", () => {
  const assembler = new FiveStagePromptAssembler();
  const result = assembler.assemble(createTestInput());
  assert.ok(
    result.outputRequirement.includes("输出格式") || result.outputRequirement.includes("Markdown"),
    "段 5 应包含输出格式"
  );
});

test("TC-PROMPT-014: assemble 段 5 输出要求包含验收标准", () => {
  const assembler = new FiveStagePromptAssembler();
  const result = assembler.assemble(createTestInput());
  assert.ok(result.outputRequirement.includes("验收标准"), "段 5 应包含验收标准");
});

test("TC-PROMPT-015: assemble Token 预算分配 - 10% / 15% / 50% / 15% / 10%", () => {
  const assembler = new FiveStagePromptAssembler();
  const total = 4000;
  const result = assembler.assemble(createTestInput(total));
  const budget = result.tokenBudget;
  assert.equal(budget.total, total);
  // 10% / 15% / 50% / 15% / 10% = 400 / 600 / 2000 / 600 / 400
  assert.equal(budget.systemConstraintBudget, Math.floor(total * 0.1));
  assert.equal(budget.taskContextBudget, Math.floor(total * 0.15));
  assert.equal(budget.codeMapSnippetBudget, Math.floor(total * 0.5));
  assert.equal(budget.historicalExperienceBudget, Math.floor(total * 0.15));
  assert.equal(budget.outputRequirementBudget, Math.floor(total * 0.1));
});

test("TC-PROMPT-016: assemble Token 预算 - 默认 4000", () => {
  const assembler = new FiveStagePromptAssembler();
  const result = assembler.assemble(createTestInput()); // 不指定 totalTokenBudget
  assert.equal(result.tokenBudget.total, DEFAULT_TOTAL_TOKEN_BUDGET, `默认总预算应为 ${DEFAULT_TOTAL_TOKEN_BUDGET}`);
});

test("TC-PROMPT-017: assemble Token 预算 - 自定义", () => {
  const assembler = new FiveStagePromptAssembler();
  const customBudget = 8000;
  const result = assembler.assemble(createTestInput(customBudget));
  assert.equal(result.tokenBudget.total, customBudget);
  assert.equal(result.tokenBudget.codeMapSnippetBudget, Math.floor(customBudget * 0.5));
});

test("TC-PROMPT-018: assemble 截断策略 - 段内超出预算截断", () => {
  const assembler = new FiveStagePromptAssembler();
  // 极小预算，强制截断
  const tinyBudget = 100;
  const result = assembler.assemble(createTestInput(tinyBudget));
  // 段 1 预算 = 100 * 0.1 = 10 tokens = 40 chars
  // Karpathy 前缀远超 40 chars，应被截断
  assert.ok(result.systemConstraint.length <= 50, `段 1 应被截断到 ≤50 chars，实际 ${result.systemConstraint.length}`);
  assert.ok(result.systemConstraint.includes("[truncated]"), "段 1 截断后应包含 [truncated] 标记");
});

test("TC-PROMPT-019: assemble fullPrompt 包含五段标记", () => {
  const assembler = new FiveStagePromptAssembler();
  const result = assembler.assemble(createTestInput());
  assert.ok(result.fullPrompt.includes("段 1：系统约束"), "fullPrompt 应包含段 1 标记");
  assert.ok(result.fullPrompt.includes("段 2：任务上下文"), "fullPrompt 应包含段 2 标记");
  assert.ok(result.fullPrompt.includes("段 3：代码地图片段"), "fullPrompt 应包含段 3 标记");
  assert.ok(result.fullPrompt.includes("段 4：历史经验"), "fullPrompt 应包含段 4 标记");
  assert.ok(result.fullPrompt.includes("段 5：输出要求"), "fullPrompt 应包含段 5 标记");
});

test("TC-PROMPT-020: assemble FiveStagePromptResult 已 Object.freeze 冻结", () => {
  const assembler = new FiveStagePromptAssembler();
  const result = assembler.assemble(createTestInput());
  assert.ok(Object.isFrozen(result), "FiveStagePromptResult 应已冻结");
  assert.ok(Object.isFrozen(result.tokenBudget), "tokenBudget 应已冻结");
});

test("TC-PROMPT-021: assemble 段 3 截断策略 - 多片段截断", () => {
  const assembler = new FiveStagePromptAssembler();
  // 构造含大量片段的 DynamicWindowResult
  const manager = createTestManager();
  const dwResult = manager.computeWindow(createTestQuery("testing"));
  // 极小预算，强制段 3 截断
  const tinyBudget = 200; // 段 3 预算 = 200 * 0.5 = 100 tokens = 400 chars
  const result = assembler.assemble(createTestInput(tinyBudget, dwResult));
  // 段 3 应被截断（无法容纳所有片段）
  assert.ok(
    result.codeMapSnippetText.length <= 500,
    `段 3 应被截断到 ≤500 chars，实际 ${result.codeMapSnippetText.length}`
  );
});

test("TC-PROMPT-022: FIVE_STAGE_RATIOS 比例之和 = 1.0", () => {
  const sum =
    FIVE_STAGE_RATIOS.SYSTEM_CONSTRAINT +
    FIVE_STAGE_RATIOS.TASK_CONTEXT +
    FIVE_STAGE_RATIOS.CODEMAP_SNIPPET +
    FIVE_STAGE_RATIOS.HISTORICAL_EXPERIENCE +
    FIVE_STAGE_RATIOS.OUTPUT_REQUIREMENT;
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `五段比例之和应为 1.0，实际为 ${sum}`);
});

// ============================================================================
// E. 集成测试（4 个 TC）
// ============================================================================

test("TC-INT-001: FiveStagePromptAssembler + RolePromptCustomizer 集成", () => {
  // 1. 使用 RolePromptCustomizer 定制角色 prompt
  const customizer = new RolePromptCustomizer();
  const roleCustomization = customizer.customize("architect", "design");

  // 2. 使用 FiveStagePromptAssembler 组装五段式 prompt
  const assembler = new FiveStagePromptAssembler();
  const input: FiveStagePromptInput = {
    taskContext: {
      title: "架构设计任务",
      description: "请设计微服务架构并输出 ADR",
      focusPoints: ["UserService"],
    },
    roleCustomization,
  };
  const result = assembler.assemble(input);

  // 3. 验证集成结果
  assert.ok(result.fullPrompt.length > 0);
  assert.ok(result.fullPrompt.includes("Karpathy"), "应包含 Karpathy 4 原则");
  assert.ok(result.fullPrompt.includes("架构师"), "应包含角色身份");
  assert.ok(result.fullPrompt.includes("架构设计任务"), "应包含任务标题");
  assert.ok(result.fullPrompt.includes("四步分析框架"), "应包含 skill 融合内容");
  assert.ok(result.fullPrompt.includes("ADR"), "应包含输出格式要求");
});

test("TC-INT-002: FiveStagePromptAssembler + RolePromptCustomizer + DynamicWindowManager 集成", () => {
  // 1. 使用 DynamicWindowManager 计算动态窗口
  const manager = createTestManager();
  const dwResult = manager.computeWindow(createTestQuery("coding"));

  // 2. 使用 RolePromptCustomizer 定制角色 prompt
  const customizer = new RolePromptCustomizer();
  const roleCustomization = customizer.customize("solo_coder", "coding");

  // 3. 使用 FiveStagePromptAssembler 组装五段式 prompt
  const assembler = new FiveStagePromptAssembler();
  const input: FiveStagePromptInput = {
    taskContext: {
      title: "实现登录功能",
      description: "请使用 TDD 实现 UserService.login",
      focusPoints: ["UserService", "login"],
      impactRoots: ["src/A.ts:UserService"],
    },
    roleCustomization,
    dynamicWindow: dwResult,
    totalTokenBudget: 4000,
  };
  const result = assembler.assemble(input);

  // 4. 验证集成结果
  assert.ok(result.fullPrompt.length > 0);
  assert.ok(result.fullPrompt.includes("Karpathy"), "应包含 Karpathy 4 原则");
  assert.ok(result.fullPrompt.includes("solo_coder"), "应包含角色名");
  assert.ok(result.fullPrompt.includes("NO PRODUCTION CODE"), "应包含 solo_coder TDD 铁律");
  // 段 3 应包含 CodeMap 片段（非占位提示）
  assert.ok(!result.codeMapSnippetText.includes("无可用 CodeMap 片段"), "段 3 应包含真实 CodeMap 片段");
  // Token 预算应正确分配
  assert.equal(result.tokenBudget.total, 4000);
  assert.equal(result.tokenBudget.codeMapSnippetBudget, 2000);
});

test("TC-INT-003: RoleSignalDetector + RolePromptCustomizer + FiveStagePromptAssembler 集成", () => {
  // 1. 使用 RoleSignalDetector 检测角色信号
  const detector = new RoleSignalDetector();
  const signals = detector.detect({
    title: "架构设计 + 实现",
    description: "请设计微服务架构并实现核心功能",
    focusPoints: ["UserService"],
  });
  assert.ok(signals.length > 0, "应检测到至少 1 个角色信号");

  // 2. 使用 RolePromptCustomizer 基于信号定制角色 prompt
  const customizer = new RolePromptCustomizer();
  const roleCustomization = customizer.customizeFromSignals(signals, "design");

  // 3. 使用 FiveStagePromptAssembler 组装五段式 prompt
  const assembler = new FiveStagePromptAssembler();
  const input: FiveStagePromptInput = {
    taskContext: {
      title: "架构设计 + 实现",
      description: "请设计微服务架构并实现核心功能",
      focusPoints: ["UserService"],
    },
    roleCustomization,
  };
  const result = assembler.assemble(input);

  // 4. 验证集成结果
  assert.ok(result.fullPrompt.length > 0);
  // 主角色应为 architect（"架构" 关键词命中）
  assert.equal(roleCustomization.primaryRole, "architect");
  // fullPrompt 应包含主角色身份
  assert.ok(result.fullPrompt.includes("架构师"), "应包含主角色身份");
});

test("TC-INT-004: Phase 1+2+3 全链路集成（StaticSymbolGraph + DynamicWindowManager + RoleSignalDetector + RolePromptCustomizer + FiveStagePromptAssembler）", () => {
  // 1. Phase 1：使用 StaticSymbolGraph 构建真实图谱
  const adapter = new StaticSymbolGraph(TEST_GRAPH_DATA);

  // 2. Phase 2：使用 DynamicWindowManager 计算动态窗口
  const provider = new CodeMapSnippetProvider(adapter, () => true);
  const manager = new DynamicWindowManager(provider, () => true);
  const dwResult = manager.computeWindow(createTestQuery("coding"));
  assert.ok(dwResult.snippets.length > 0, "应返回非空 CodeMap 片段");

  // 3. Phase 3a：使用 RoleSignalDetector 检测角色信号
  const detector = new RoleSignalDetector();
  const signals = detector.detect({
    title: "实现 UserService.login 功能",
    description: "请使用 TDD 实现 UserService 类的 login 方法",
    focusPoints: ["UserService", "login"],
    symbols: TEST_SYMBOLS, // 部分符号含 embedding
  });
  assert.ok(signals.length > 0, "应检测到角色信号");
  // solo_coder 应在结果中（"实现"、"代码" 关键词命中）
  assert.ok(
    signals.some((s) => s.role === "solo_coder"),
    "应检测到 solo_coder 信号"
  );

  // 4. Phase 3b：使用 RolePromptCustomizer 基于信号定制角色 prompt
  const customizer = new RolePromptCustomizer();
  const roleCustomization = customizer.customizeFromSignals(signals, "coding");
  assert.ok(
    roleCustomization.primaryRole === "solo_coder" || roleCustomization.primaryRole === "architect",
    "主角色应为 solo_coder 或 architect"
  );

  // 5. Phase 3c：使用 FiveStagePromptAssembler 组装五段式 prompt
  const assembler = new FiveStagePromptAssembler();
  const input: FiveStagePromptInput = {
    taskContext: {
      title: "实现 UserService.login 功能",
      description: "请使用 TDD 实现 UserService 类的 login 方法",
      focusPoints: ["UserService", "login"],
      symbols: TEST_SYMBOLS,
    },
    roleCustomization,
    dynamicWindow: dwResult,
    totalTokenBudget: 4000,
  };
  const result = assembler.assemble(input);

  // 6. 验证全链路集成结果
  assert.ok(result.fullPrompt.length > 0, "fullPrompt 不应为空");
  assert.ok(result.fullPrompt.includes("Karpathy"), "应包含 Karpathy 4 原则");
  assert.ok(
    result.fullPrompt.includes("UserService") || result.fullPrompt.includes("login"),
    "段 3 应包含 CodeMap 符号"
  );
  assert.ok(result.tokenBudget.codeMapSnippetBudget === 2000, "段 3 预算应为 2000");
  assert.ok(result.tokenBudget.systemConstraintBudget === 400, "段 1 预算应为 400");

  // 7. 验证语义匹配降级链使用 embedding 层级（因 TEST_SYMBOLS 含 embedding）
  const fallbackLevel = detector.getSemanticFallbackLevel({
    title: "实现 UserService.login 功能",
    description: "请使用 TDD 实现 UserService 类的 login 方法",
    symbols: TEST_SYMBOLS,
  });
  assert.equal(fallbackLevel, "embedding", "语义匹配应使用 embedding 层级（因 TEST_SYMBOLS 含 embedding）");
});
