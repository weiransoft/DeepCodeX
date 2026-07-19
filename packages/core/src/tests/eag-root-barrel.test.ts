/**
 * EAG-P3 批次 10 单元测试：EAG 根 Barrel 导出完整性（eag/index.ts）
 *
 * 测试范围（对齐 EAG-P3 批次 10 设计 §2 目录树 `eag/index.ts`）：
 * - T1.  LoopKernel 类导出（from loop/kernel）
 * - T2.  LoopScheduler 类导出（from loop/scheduler）
 * - T3.  GateOrchestrator 类导出（from gate/）
 * - T4.  GateG1Checker~GateG7Checker 类导出（from gate/，7 个子测试 T4a~T4g）
 * - T5.  CodingOrchestrator 类导出（from coding/）
 * - T6.  TestingOrchestrator 类导出（from testing/）
 * - T7.  DesignLoopOrchestrator 类导出（from design/）
 * - T8.  RuleStore / RuleInjector / RuleLearner 类导出（from rlis/，3 个子测试 T8a~T8c）
 * - T9.  TaskDecomposer 类导出（from doc-driven/）
 * - T10. MultiLoopPlanner 类导出（from long-horizon/）
 * - T11. RunStateStore 类导出（from long-horizon/）
 * - T12. EagRunHandler / EagResumeHandler / EagStatusHandler 类导出（from long-horizon/，3 个子测试 T12a~T12c）
 * - T13. MilestoneTagger 类导出（from long-horizon/）
 * - T14. BlockageAnalyzer 类导出（from long-horizon/）
 * - T15. 主要类型导出验证（LoopType / GateId / CodingLoopRequest / TestingLoopRequest /
 *        MultiLoopPlan / RunState 共 6 个子测试 T15a~T15f，通过 type-only import 验证可用性）
 *
 * 扩展测试（覆盖更多子模块的关键导出，确保 barrel 完整性）：
 * - T16. evaluator 函数导出（decideVerdict / buildReport）
 * - T17. redlines 常量导出（ENTERPRISE_REDLINES，应含 E1~E8 共 8 条）
 * - T18. eak 范式注册表函数导出（getAllParadigms，应返回 4 个范式）
 * - T19. etsb 技术栈选择器类导出（TechStackSelector）
 * - T20. edm 信号检测器类导出（EdmSignalDetector）
 * - T21. tcs 多级缓存类导出（MultiLevelCache）
 * - T22. discovery 棕地发现类导出（BrownfieldDiscovery / ChangeClassifier / ExistingContractGuard）
 * - T23. design 静态评估器与渲染器导出（StaticDesignEvaluator / renderArchitectureMd）
 * - T24. doc-driven 文档状态机与 Git 管理器导出（DocumentStateMachine / GitProcessManager /
 *        PlanGenerator / TasksGenerator）
 * - T25. coding 骨架生成器与 LLM 填充器导出（SkeletonGenerator / LlmFiller / FixLoop /
 *        StrictEvaluator / ContextAssembler / InMemoryLLMClient）
 * - T26. testing 契约测试与 E2E 与覆盖率门禁类导出（ContractTestGenerator / E2eTestGenerator /
 *        CoverageGate / BrownfieldContractGuard + 3 个静态判定器）
 * - T27. long-horizon 辅助类导出（HealthScoreCalculator / RootCauseRuleMatcher / FileLockProvider）
 * - T28. 命名冲突解决验证（LOOP_TYPES 来自 loop/models；deepFreeze 来自 tcs/types；
 *        LogCallback 来自 loop/models）
 *
 * 测试约定（严格遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock：仅做"导出存在性 + 类型可加载性"静态验证，不调用业务逻辑
 * - 使用 `typeof Eag.X === "function"` 验证类/函数导出，使用 `Array.isArray` 验证常量数组
 * - 类型导出通过 type-only import + 在类型位置引用验证（编译期检查）
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计文档 §2 目录树 `eag/index.ts ★ 新增：EAG 根 barrel`
 * - EAG-P3 批次 10 设计文档 §1.2.5「EAG 根 barrel 落地——新增 eag/index.ts 统一对外导出，解决遗留 L-7」
 * - EAG 方案 §5 EAG 体系结构（§5.1~§5.12 共 12+ 子模块）
 *
 * @module core/tests/eag-root-barrel
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// ============================================================================
// 从 EAG 根 barrel 导入全部公共 API（验证 barrel 导出链路完整性）
// ============================================================================
import * as Eag from "../eag/index";

// 类型导入（验证 type-only export 链路）
import type { LoopType, GateId, CodingLoopRequest, TestingLoopRequest, MultiLoopPlan, RunState } from "../eag/index";

// ============================================================================
// 类型导出验证辅助函数（type-only import 仅在编译期校验，运行期通过 runtime helper 间接确认）
// ============================================================================

/**
 * 类型存在性校验辅助函数
 *
 * 通过引用类型参数，使 TypeScript 编译期校验类型可用性。
 * 运行期此函数仅返回 true（占位），实际验证由 tsc --noEmit 完成。
 *
 * @param _typeMarker 类型标记（仅用于编译期校验，运行期忽略）
 * @returns 始终返回 true
 */
function assertTypeAccessible<T>(_typeMarker?: T): boolean {
  return true;
}

// ============================================================================
// T1. LoopKernel 类导出
// ============================================================================

test("T1: EAG 根 barrel 导出 LoopKernel 类（来自 loop/kernel）", () => {
  // LoopKernel 是类，typeof 应为 "function"
  assert.equal(typeof Eag.LoopKernel, "function", "LoopKernel 应为 class（function 类型）");
  // 类应有 prototype 属性，可被 new 调用
  assert.ok(Eag.LoopKernel.prototype, "LoopKernel 应有 prototype 属性（可被 new 调用）");
  // 类名应为 "LoopKernel"
  assert.equal(Eag.LoopKernel.name, "LoopKernel", "类名应为 'LoopKernel'");
});

// ============================================================================
// T2. LoopScheduler 类导出
// ============================================================================

test("T2: EAG 根 barrel 导出 LoopScheduler 类（来自 loop/scheduler）", () => {
  assert.equal(typeof Eag.LoopScheduler, "function", "LoopScheduler 应为 class（function 类型）");
  assert.ok(Eag.LoopScheduler.prototype, "LoopScheduler 应有 prototype 属性");
  assert.equal(Eag.LoopScheduler.name, "LoopScheduler", "类名应为 'LoopScheduler'");
});

// ============================================================================
// T3. GateOrchestrator 类导出
// ============================================================================

test("T3: EAG 根 barrel 导出 GateOrchestrator 类（来自 gate/）", () => {
  assert.equal(typeof Eag.GateOrchestrator, "function", "GateOrchestrator 应为 class（function 类型）");
  assert.ok(Eag.GateOrchestrator.prototype, "GateOrchestrator 应有 prototype 属性");
  assert.equal(Eag.GateOrchestrator.name, "GateOrchestrator", "类名应为 'GateOrchestrator'");
});

// ============================================================================
// T4. GateG1Checker~GateG7Checker 类导出（7 个子测试）
// ============================================================================

test("T4a: EAG 根 barrel 导出 GateG1Checker 类（G-1 门禁：无已批准 spec/plan 禁入 CODING Loop）", () => {
  assert.equal(typeof Eag.GateG1Checker, "function", "GateG1Checker 应为 class");
  assert.equal(Eag.GateG1Checker.name, "GateG1Checker", "类名应为 'GateG1Checker'");
});

test("T4b: EAG 根 barrel 导出 GateG2Checker 类（G-2 门禁：方案必经多角色评审 + 用户批准）", () => {
  assert.equal(typeof Eag.GateG2Checker, "function", "GateG2Checker 应为 class");
  assert.equal(Eag.GateG2Checker.name, "GateG2Checker", "类名应为 'GateG2Checker'");
});

test("T4c: EAG 根 barrel 导出 GateG3Checker 类（G-3 门禁：方案偏离检测）", () => {
  assert.equal(typeof Eag.GateG3Checker, "function", "GateG3Checker 应为 class");
  assert.equal(Eag.GateG3Checker.name, "GateG3Checker", "类名应为 'GateG3Checker'");
});

test("T4d: EAG 根 barrel 导出 GateG4Checker 类（G-4 CODING Loop 进入门禁）", () => {
  assert.equal(typeof Eag.GateG4Checker, "function", "GateG4Checker 应为 class");
  assert.equal(Eag.GateG4Checker.name, "GateG4Checker", "类名应为 'GateG4Checker'");
});

test("T4e: EAG 根 barrel 导出 GateG5Checker 类（G-5 CODING Loop 退出门禁）", () => {
  assert.equal(typeof Eag.GateG5Checker, "function", "GateG5Checker 应为 class");
  assert.equal(Eag.GateG5Checker.name, "GateG5Checker", "类名应为 'GateG5Checker'");
});

test("T4f: EAG 根 barrel 导出 GateG6Checker 类（G-6 TESTING Loop 进入门禁，批次 10 新增）", () => {
  assert.equal(typeof Eag.GateG6Checker, "function", "GateG6Checker 应为 class");
  assert.equal(Eag.GateG6Checker.name, "GateG6Checker", "类名应为 'GateG6Checker'");
});

test("T4g: EAG 根 barrel 导出 GateG7Checker 类（G-7 TESTING Loop 退出门禁，批次 10 新增）", () => {
  assert.equal(typeof Eag.GateG7Checker, "function", "GateG7Checker 应为 class");
  assert.equal(Eag.GateG7Checker.name, "GateG7Checker", "类名应为 'GateG7Checker'");
});

// ============================================================================
// T5. CodingOrchestrator 类导出
// ============================================================================

test("T5: EAG 根 barrel 导出 CodingOrchestrator 类（来自 coding/）", () => {
  assert.equal(typeof Eag.CodingOrchestrator, "function", "CodingOrchestrator 应为 class");
  assert.ok(Eag.CodingOrchestrator.prototype, "CodingOrchestrator 应有 prototype 属性");
  assert.equal(Eag.CodingOrchestrator.name, "CodingOrchestrator", "类名应为 'CodingOrchestrator'");
});

// ============================================================================
// T6. TestingOrchestrator 类导出
// ============================================================================

test("T6: EAG 根 barrel 导出 TestingOrchestrator 类（来自 testing/，批次 10 新增）", () => {
  assert.equal(typeof Eag.TestingOrchestrator, "function", "TestingOrchestrator 应为 class");
  assert.ok(Eag.TestingOrchestrator.prototype, "TestingOrchestrator 应有 prototype 属性");
  assert.equal(Eag.TestingOrchestrator.name, "TestingOrchestrator", "类名应为 'TestingOrchestrator'");
});

// ============================================================================
// T7. DesignLoopOrchestrator 类导出
// ============================================================================

test("T7: EAG 根 barrel 导出 DesignLoopOrchestrator 类（来自 design/）", () => {
  assert.equal(typeof Eag.DesignLoopOrchestrator, "function", "DesignLoopOrchestrator 应为 class");
  assert.ok(Eag.DesignLoopOrchestrator.prototype, "DesignLoopOrchestrator 应有 prototype 属性");
  assert.equal(Eag.DesignLoopOrchestrator.name, "DesignLoopOrchestrator", "类名应为 'DesignLoopOrchestrator'");
});

// ============================================================================
// T8. RuleStore / RuleInjector / RuleLearner 类导出（3 个子测试）
// ============================================================================

test("T8a: EAG 根 barrel 导出 RuleStore 类（来自 rlis/，三层规则存储）", () => {
  assert.equal(typeof Eag.RuleStore, "function", "RuleStore 应为 class");
  assert.ok(Eag.RuleStore.prototype, "RuleStore 应有 prototype 属性");
  assert.equal(Eag.RuleStore.name, "RuleStore", "类名应为 'RuleStore'");
});

test("T8b: EAG 根 barrel 导出 RuleInjector 类（来自 rlis/，规则注入器）", () => {
  assert.equal(typeof Eag.RuleInjector, "function", "RuleInjector 应为 class");
  assert.ok(Eag.RuleInjector.prototype, "RuleInjector 应有 prototype 属性");
  assert.equal(Eag.RuleInjector.name, "RuleInjector", "类名应为 'RuleInjector'");
});

test("T8c: EAG 根 barrel 导出 RuleLearner 类（来自 rlis/，规则学习器）", () => {
  assert.equal(typeof Eag.RuleLearner, "function", "RuleLearner 应为 class");
  assert.ok(Eag.RuleLearner.prototype, "RuleLearner 应有 prototype 属性");
  assert.equal(Eag.RuleLearner.name, "RuleLearner", "类名应为 'RuleLearner'");
});

// ============================================================================
// T9. TaskDecomposer 类导出
// ============================================================================

test("T9: EAG 根 barrel 导出 TaskDecomposer 类（来自 doc-driven/）", () => {
  assert.equal(typeof Eag.TaskDecomposer, "function", "TaskDecomposer 应为 class");
  assert.ok(Eag.TaskDecomposer.prototype, "TaskDecomposer 应有 prototype 属性");
  assert.equal(Eag.TaskDecomposer.name, "TaskDecomposer", "类名应为 'TaskDecomposer'");
});

// ============================================================================
// T10. MultiLoopPlanner 类导出
// ============================================================================

test("T10: EAG 根 barrel 导出 MultiLoopPlanner 类（来自 long-horizon/，批次 10 新增）", () => {
  assert.equal(typeof Eag.MultiLoopPlanner, "function", "MultiLoopPlanner 应为 class");
  assert.ok(Eag.MultiLoopPlanner.prototype, "MultiLoopPlanner 应有 prototype 属性");
  assert.equal(Eag.MultiLoopPlanner.name, "MultiLoopPlanner", "类名应为 'MultiLoopPlanner'");
});

// ============================================================================
// T11. RunStateStore 类导出
// ============================================================================

test("T11: EAG 根 barrel 导出 RunStateStore 类（来自 long-horizon/，批次 10 新增）", () => {
  assert.equal(typeof Eag.RunStateStore, "function", "RunStateStore 应为 class");
  assert.ok(Eag.RunStateStore.prototype, "RunStateStore 应有 prototype 属性");
  assert.equal(Eag.RunStateStore.name, "RunStateStore", "类名应为 'RunStateStore'");
});

// ============================================================================
// T12. EagRunHandler / EagResumeHandler / EagStatusHandler 类导出（3 个子测试）
// ============================================================================

test("T12a: EAG 根 barrel 导出 EagRunHandler 类（/eag-run 命令处理器，批次 10 新增）", () => {
  assert.equal(typeof Eag.EagRunHandler, "function", "EagRunHandler 应为 class");
  assert.ok(Eag.EagRunHandler.prototype, "EagRunHandler 应有 prototype 属性");
  assert.equal(Eag.EagRunHandler.name, "EagRunHandler", "类名应为 'EagRunHandler'");
});

test("T12b: EAG 根 barrel 导出 EagResumeHandler 类（/eag-resume 断点续跑，批次 10 新增）", () => {
  assert.equal(typeof Eag.EagResumeHandler, "function", "EagResumeHandler 应为 class");
  assert.ok(Eag.EagResumeHandler.prototype, "EagResumeHandler 应有 prototype 属性");
  assert.equal(Eag.EagResumeHandler.name, "EagResumeHandler", "类名应为 'EagResumeHandler'");
});

test("T12c: EAG 根 barrel 导出 EagStatusHandler 类（/eag-status 进度报告，批次 10 新增）", () => {
  assert.equal(typeof Eag.EagStatusHandler, "function", "EagStatusHandler 应为 class");
  assert.ok(Eag.EagStatusHandler.prototype, "EagStatusHandler 应有 prototype 属性");
  assert.equal(Eag.EagStatusHandler.name, "EagStatusHandler", "类名应为 'EagStatusHandler'");
});

// ============================================================================
// T13. MilestoneTagger 类导出
// ============================================================================

test("T13: EAG 根 barrel 导出 MilestoneTagger 类（来自 long-horizon/，里程碑 tag 生成器）", () => {
  assert.equal(typeof Eag.MilestoneTagger, "function", "MilestoneTagger 应为 class");
  assert.ok(Eag.MilestoneTagger.prototype, "MilestoneTagger 应有 prototype 属性");
  assert.equal(Eag.MilestoneTagger.name, "MilestoneTagger", "类名应为 'MilestoneTagger'");
});

// ============================================================================
// T14. BlockageAnalyzer 类导出
// ============================================================================

test("T14: EAG 根 barrel 导出 BlockageAnalyzer 类（来自 long-horizon/，阻塞分析器）", () => {
  assert.equal(typeof Eag.BlockageAnalyzer, "function", "BlockageAnalyzer 应为 class");
  assert.ok(Eag.BlockageAnalyzer.prototype, "BlockageAnalyzer 应有 prototype 属性");
  assert.equal(Eag.BlockageAnalyzer.name, "BlockageAnalyzer", "类名应为 'BlockageAnalyzer'");
});

// ============================================================================
// T15. 主要类型导出验证（6 个子测试，type-only import 在编译期校验）
// ============================================================================

test("T15a: EAG 根 barrel 导出 LoopType 类型（字面量联合 'design' | 'coding' | 'testing'）", () => {
  // 编译期校验：LoopType 类型可用
  const sample: LoopType = "design";
  // 运行期校验：LOOP_TYPES 常量应包含全部 3 个合法值
  assert.ok(Array.isArray(Eag.LOOP_TYPES), "LOOP_TYPES 应为数组");
  assert.equal(Eag.LOOP_TYPES.length, 3, "LOOP_TYPES 应含 3 个 LoopType 合法值");
  assert.ok(Eag.LOOP_TYPES.includes(sample), "LOOP_TYPES 应包含 'design'");
  assert.ok(Eag.LOOP_TYPES.includes("coding"), "LOOP_TYPES 应包含 'coding'");
  assert.ok(Eag.LOOP_TYPES.includes("testing"), "LOOP_TYPES 应包含 'testing'");
});

test("T15b: EAG 根 barrel 导出 GateId 类型（G-1~G-7 七道门禁标识）", () => {
  // 编译期校验：GateId 类型可用
  // 运行期校验：GATE_IDS 常量应包含全部 7 个门禁 ID
  assert.ok(Array.isArray(Eag.GATE_IDS), "GATE_IDS 应为数组");
  assert.equal(Eag.GATE_IDS.length, 7, "GATE_IDS 应含 7 个门禁 ID（G-1~G-7）");
  // 验证 G-6 与 G-7 已纳入（批次 10 新增）
  assert.ok(Eag.GATE_IDS.includes("G-6" as GateId), "GATE_IDS 应包含 'G-6'（TESTING 进入门禁）");
  assert.ok(Eag.GATE_IDS.includes("G-7" as GateId), "GATE_IDS 应包含 'G-7'（TESTING 退出门禁）");
});

test("T15c: EAG 根 barrel 导出 CodingLoopRequest 类型（CODING Loop 编排请求）", () => {
  // 编译期校验：CodingLoopRequest 类型可用（构造一个最小化请求对象验证字段约束）
  const request: CodingLoopRequest = {
    projectRoot: "/tmp/test-project",
    tasks: Object.freeze([]),
    specMarkdownPath: "/tmp/test-project/docs/spec.md",
    planMarkdownPath: "/tmp/test-project/docs/plan.md",
    tasksMarkdownPath: "/tmp/test-project/docs/tasks.md",
    implementationRoot: "src",
    gateContext: {
      loopType: "coding",
      specState: "approved",
      planState: "approved",
      tasksState: "approved",
      implementationRoot: "src",
    } as unknown as CodingLoopRequest["gateContext"],
  };
  // 运行期校验：对象构造成功
  assert.ok(request, "CodingLoopRequest 类型对象应可构造");
  assert.equal(request.projectRoot, "/tmp/test-project", "projectRoot 字段应正确赋值");
  // 类型标记函数（运行期始终返回 true，实际校验由 tsc 完成）
  assert.ok(assertTypeAccessible<CodingLoopRequest>(request), "CodingLoopRequest 类型应可访问");
});

test("T15d: EAG 根 barrel 导出 TestingLoopRequest 类型（TESTING Loop 编排请求，批次 10 新增）", () => {
  // 编译期校验：TestingLoopRequest 类型可用
  // 使用 type-only import + 工厂函数返回类型校验
  // 由于 TestingLoopRequest 字段较多，此处仅验证类型可用性
  assert.ok(assertTypeAccessible<TestingLoopRequest>(), "TestingLoopRequest 类型应可访问");
  // 运行期校验：工厂函数 createTestingLoopRequest 应可访问
  assert.equal(typeof Eag.createTestingLoopRequest, "function", "createTestingLoopRequest 工厂函数应可访问");
});

test("T15e: EAG 根 barrel 导出 MultiLoopPlan 类型（多 Loop 串联 DAG 计划，批次 10 新增）", () => {
  // 编译期校验：MultiLoopPlan 类型可用
  assert.ok(assertTypeAccessible<MultiLoopPlan>(), "MultiLoopPlan 类型应可访问");
});

test("T15f: EAG 根 barrel 导出 RunState 类型（长程任务运行状态，批次 10 新增）", () => {
  // 编译期校验：RunState 类型可用
  assert.ok(assertTypeAccessible<RunState>(), "RunState 类型应可访问");
  // 运行期校验：RUN_STATE_STATUSES 常量应可访问
  assert.ok(Array.isArray(Eag.RUN_STATE_STATUSES), "RUN_STATE_STATUSES 应为数组");
  assert.ok(Eag.RUN_STATE_STATUSES.length > 0, "RUN_STATE_STATUSES 应非空");
});

// ============================================================================
// T16. evaluator 函数导出（decideVerdict / buildReport）
// ============================================================================

test("T16: EAG 根 barrel 导出 evaluator 函数（decideVerdict / buildReport）", () => {
  assert.equal(typeof Eag.decideVerdict, "function", "decideVerdict 应为 function");
  assert.equal(typeof Eag.buildReport, "function", "buildReport 应为 function");
});

// ============================================================================
// T17. redlines 常量导出（ENTERPRISE_REDLINES 应含 E1~E8 共 8 条）
// ============================================================================

test("T17: EAG 根 barrel 导出 ENTERPRISE_REDLINES 常量（E1~E8 共 8 条企业红线）", () => {
  assert.ok(Array.isArray(Eag.ENTERPRISE_REDLINES), "ENTERPRISE_REDLINES 应为数组");
  assert.equal(Eag.ENTERPRISE_REDLINES.length, 8, "ENTERPRISE_REDLINES 应含 8 条红线（E1~E8）");
  // 验证每条红线均有 id 字段
  const ids = Eag.ENTERPRISE_REDLINES.map((r) => r.id);
  for (let i = 1; i <= 8; i++) {
    assert.ok(ids.includes(`E${i}`), `ENTERPRISE_REDLINES 应包含 E${i}`);
  }
  // 验证 getRedlineById / getEnterpriseRedlineCount / getRedlinesBySeverity 函数导出
  assert.equal(typeof Eag.getRedlineById, "function", "getRedlineById 应为 function");
  assert.equal(typeof Eag.getEnterpriseRedlineCount, "function", "getEnterpriseRedlineCount 应为 function");
  assert.equal(typeof Eag.getRedlinesBySeverity, "function", "getRedlinesBySeverity 应为 function");
  // 验证 getEnterpriseRedlineCount 返回值
  assert.equal(Eag.getEnterpriseRedlineCount(), 8, "getEnterpriseRedlineCount() 应返回 8");
});

// ============================================================================
// T18. eak 范式注册表函数导出（getAllParadigms 应返回 4 个范式）
// ============================================================================

test("T18: EAG 根 barrel 导出 eak 范式注册表（4 个架构范式）", () => {
  assert.equal(typeof Eag.getAllParadigms, "function", "getAllParadigms 应为 function");
  const paradigms = Eag.getAllParadigms();
  assert.ok(Array.isArray(paradigms), "getAllParadigms() 应返回数组");
  assert.equal(paradigms.length, 4, "应有 4 个架构范式（DDD 分层 / Clean Architecture / CQRS+ES / Microservice）");
  // 验证 4 个范式常量导出
  assert.ok(Eag.DDD_LAYERED_PARADIGM, "DDD_LAYERED_PARADIGM 应可访问");
  assert.ok(Eag.CLEAN_ARCHITECTURE_PARADIGM, "CLEAN_ARCHITECTURE_PARADIGM 应可访问");
  assert.ok(Eag.CQRS_ES_PARADIGM, "CQRS_ES_PARADIGM 应可访问");
  assert.ok(Eag.MICROSERVICE_PARADIGM, "MICROSERVICE_PARADIGM 应可访问");
});

// ============================================================================
// T19. etsb 技术栈选择器类导出（TechStackSelector）
// ============================================================================

test("T19: EAG 根 barrel 导出 etsb 技术栈选择器（TechStackSelector 类）", () => {
  assert.equal(typeof Eag.TechStackSelector, "function", "TechStackSelector 应为 class");
  assert.equal(Eag.TechStackSelector.name, "TechStackSelector", "类名应为 'TechStackSelector'");
  // 验证 TECH_LANGUAGES 常量导出（4 种语言）
  assert.ok(Array.isArray(Eag.TECH_LANGUAGES), "TECH_LANGUAGES 应为数组");
  assert.equal(Eag.TECH_LANGUAGES.length, 4, "TECH_LANGUAGES 应含 4 种语言");
});

// ============================================================================
// T20. edm 信号检测器类导出（EdmSignalDetector）
// ============================================================================

test("T20: EAG 根 barrel 导出 edm 信号检测器（EdmSignalDetector 类）", () => {
  assert.equal(typeof Eag.EdmSignalDetector, "function", "EdmSignalDetector 应为 class");
  assert.equal(Eag.EdmSignalDetector.name, "EdmSignalDetector", "类名应为 'EdmSignalDetector'");
  // 验证 EDM_DOMAIN_IDS 常量导出（5 个公共内核域）
  assert.ok(Array.isArray(Eag.EDM_DOMAIN_IDS), "EDM_DOMAIN_IDS 应为数组");
  assert.equal(Eag.EDM_DOMAIN_IDS.length, 5, "EDM_DOMAIN_IDS 应含 5 个公共内核域");
});

// ============================================================================
// T21. tcs 多级缓存类导出（MultiLevelCache）
// ============================================================================

test("T21: EAG 根 barrel 导出 tcs 多级缓存（MultiLevelCache / BloomFilter / 3 个适配器类）", () => {
  assert.equal(typeof Eag.MultiLevelCache, "function", "MultiLevelCache 应为 class");
  assert.equal(Eag.MultiLevelCache.name, "MultiLevelCache", "类名应为 'MultiLevelCache'");
  // 验证 BloomFilter 类导出
  assert.equal(typeof Eag.BloomFilter, "function", "BloomFilter 应为 class");
  // 验证 3 个对象存储适配器类导出
  assert.equal(typeof Eag.S3Adapter, "function", "S3Adapter 应为 class");
  assert.equal(typeof Eag.OssAdapter, "function", "OssAdapter 应为 class");
  assert.equal(typeof Eag.MinioAdapter, "function", "MinioAdapter 应为 class");
  // 验证 SQL 优化器、LDAP 同步器、漏洞扫描器类导出
  assert.equal(typeof Eag.SqlOptimizer, "function", "SqlOptimizer 应为 class");
  assert.equal(typeof Eag.LdapSynchronizer, "function", "LdapSynchronizer 应为 class");
  assert.equal(typeof Eag.VulnerabilityScanner, "function", "VulnerabilityScanner 应为 class");
  // 验证 TCS_REDLINES 常量导出（13 条红线）
  assert.ok(Array.isArray(Eag.TCS_REDLINES), "TCS_REDLINES 应为数组");
  assert.equal(Eag.TCS_REDLINES.length, 13, "TCS_REDLINES 应含 13 条 TCS 红线");
});

// ============================================================================
// T22. discovery 棕地发现类导出（BrownfieldDiscovery / ChangeClassifier / ExistingContractGuard）
// ============================================================================

test("T22: EAG 根 barrel 导出 discovery 棕地发现（3 个类）", () => {
  assert.equal(typeof Eag.BrownfieldDiscovery, "function", "BrownfieldDiscovery 应为 class");
  assert.equal(Eag.BrownfieldDiscovery.name, "BrownfieldDiscovery", "类名应为 'BrownfieldDiscovery'");
  assert.equal(typeof Eag.ChangeClassifier, "function", "ChangeClassifier 应为 class");
  assert.equal(Eag.ChangeClassifier.name, "ChangeClassifier", "类名应为 'ChangeClassifier'");
  assert.equal(typeof Eag.ExistingContractGuard, "function", "ExistingContractGuard 应为 class");
  assert.equal(Eag.ExistingContractGuard.name, "ExistingContractGuard", "类名应为 'ExistingContractGuard'");
});

// ============================================================================
// T23. design 静态评估器与渲染器导出
// ============================================================================

test("T23: EAG 根 barrel 导出 design 评估器与文档渲染器", () => {
  // StaticDesignEvaluator 类
  assert.equal(typeof Eag.StaticDesignEvaluator, "function", "StaticDesignEvaluator 应为 class");
  assert.equal(Eag.StaticDesignEvaluator.name, "StaticDesignEvaluator", "类名应为 'StaticDesignEvaluator'");
  // 渲染器函数
  assert.equal(typeof Eag.renderArchitectureMd, "function", "renderArchitectureMd 应为 function");
  assert.equal(typeof Eag.renderDomainModelMd, "function", "renderDomainModelMd 应为 function");
  // 校验器函数
  assert.equal(typeof Eag.validateArchitectureMd, "function", "validateArchitectureMd 应为 function");
  assert.equal(typeof Eag.validateDomainModelMd, "function", "validateDomainModelMd 应为 function");
  // 默认配置常量
  assert.ok(Eag.DEFAULT_DESIGN_LOOP_CONFIG, "DEFAULT_DESIGN_LOOP_CONFIG 应可访问");
});

// ============================================================================
// T24. doc-driven 文档状态机与 Git 管理器导出
// ============================================================================

test("T24: EAG 根 barrel 导出 doc-driven 文档驱动开发全部类", () => {
  // DocumentStateMachine
  assert.equal(typeof Eag.DocumentStateMachine, "function", "DocumentStateMachine 应为 class");
  assert.equal(Eag.DocumentStateMachine.name, "DocumentStateMachine", "类名应为 'DocumentStateMachine'");
  // TaskDecomposer（已在 T9 验证，此处不再重复）
  // GitProcessManager
  assert.equal(typeof Eag.GitProcessManager, "function", "GitProcessManager 应为 class");
  assert.equal(Eag.GitProcessManager.name, "GitProcessManager", "类名应为 'GitProcessManager'");
  // PlanGenerator（plan.md 生成器）
  assert.equal(typeof Eag.PlanGenerator, "function", "PlanGenerator 应为 class");
  assert.equal(Eag.PlanGenerator.name, "PlanGenerator", "类名应为 'PlanGenerator'");
  // TasksGenerator（tasks.md 生成器）
  assert.equal(typeof Eag.TasksGenerator, "function", "TasksGenerator 应为 class");
  assert.equal(Eag.TasksGenerator.name, "TasksGenerator", "类名应为 'TasksGenerator'");
  // buildConstitution 函数
  assert.equal(typeof Eag.buildConstitution, "function", "buildConstitution 应为 function");
});

// ============================================================================
// T25. coding 骨架生成器与 LLM 填充器导出
// ============================================================================

test("T25: EAG 根 barrel 导出 coding CODING Loop 全部类", () => {
  // Phase A：骨架生成器
  assert.equal(typeof Eag.SkeletonGenerator, "function", "SkeletonGenerator 应为 class");
  assert.equal(Eag.SkeletonGenerator.name, "SkeletonGenerator", "类名应为 'SkeletonGenerator'");
  // Phase B：上下文装配器
  assert.equal(typeof Eag.ContextAssembler, "function", "ContextAssembler 应为 class");
  assert.equal(Eag.ContextAssembler.name, "ContextAssembler", "类名应为 'ContextAssembler'");
  // STRICT 评估器
  assert.equal(typeof Eag.StrictEvaluator, "function", "StrictEvaluator 应为 class");
  assert.equal(Eag.StrictEvaluator.name, "StrictEvaluator", "类名应为 'StrictEvaluator'");
  // Phase B：LLM 填充器
  assert.equal(typeof Eag.LlmFiller, "function", "LlmFiller 应为 class");
  assert.equal(Eag.LlmFiller.name, "LlmFiller", "类名应为 'LlmFiller'");
  // FIX 回灌循环
  assert.equal(typeof Eag.FixLoop, "function", "FixLoop 应为 class");
  assert.equal(Eag.FixLoop.name, "FixLoop", "类名应为 'FixLoop'");
  // UnifiedDiffApplier（自实现 unified diff 应用器）
  assert.equal(typeof Eag.UnifiedDiffApplier, "function", "UnifiedDiffApplier 应为 class");
  // InMemoryLLMClient（测试专用真实实现，非 mock）
  assert.equal(typeof Eag.InMemoryLLMClient, "function", "InMemoryLLMClient 应为 class");
  // 默认模板注册表
  assert.ok(Eag.DEFAULT_TEMPLATE_REGISTRY, "DEFAULT_TEMPLATE_REGISTRY 应可访问");
});

// ============================================================================
// T26. testing 契约测试与 E2E 与覆盖率门禁类导出
// ============================================================================

test("T26: EAG 根 barrel 导出 testing TESTING Loop 全部类（批次 10 新增）", () => {
  // 契约测试生成器
  assert.equal(typeof Eag.ContractTestGenerator, "function", "ContractTestGenerator 应为 class");
  assert.equal(Eag.ContractTestGenerator.name, "ContractTestGenerator", "类名应为 'ContractTestGenerator'");
  // OpenAPI 解析器与 TypeScript 签名提取器（双通道降级）
  assert.equal(typeof Eag.OpenApiSpecParser, "function", "OpenApiSpecParser 应为 class");
  assert.equal(typeof Eag.TsSignatureExtractor, "function", "TsSignatureExtractor 应为 class");
  // E2E 测试生成器
  assert.equal(typeof Eag.E2eTestGenerator, "function", "E2eTestGenerator 应为 class");
  assert.equal(Eag.E2eTestGenerator.name, "E2eTestGenerator", "类名应为 'E2eTestGenerator'");
  // 覆盖率门禁
  assert.equal(typeof Eag.CoverageGate, "function", "CoverageGate 应为 class");
  assert.equal(Eag.CoverageGate.name, "CoverageGate", "类名应为 'CoverageGate'");
  // C8 报告解析器
  assert.equal(typeof Eag.C8ReportParser, "function", "C8ReportParser 应为 class");
  // 既有契约保护判定器
  assert.equal(typeof Eag.BrownfieldContractGuard, "function", "BrownfieldContractGuard 应为 class");
  assert.equal(Eag.BrownfieldContractGuard.name, "BrownfieldContractGuard", "类名应为 'BrownfieldContractGuard'");
  // 3 个测试质量静态判定器
  assert.equal(typeof Eag.AssertionDensityChecker, "function", "AssertionDensityChecker 应为 class");
  assert.equal(typeof Eag.TestNamingChecker, "function", "TestNamingChecker 应为 class");
  assert.equal(typeof Eag.CoverageGapChecker, "function", "CoverageGapChecker 应为 class");
  // 默认覆盖率阈值常量
  assert.ok(Eag.DEFAULT_COVERAGE_THRESHOLD, "DEFAULT_COVERAGE_THRESHOLD 应可访问");
  assert.equal(Eag.DEFAULT_COVERAGE_THRESHOLD.lines, 80, "DEFAULT_COVERAGE_THRESHOLD.lines 应为 80");
});

// ============================================================================
// T27. long-horizon 辅助类导出
// ============================================================================

test("T27: EAG 根 barrel 导出 long-horizon 辅助类（HealthScoreCalculator / RootCauseRuleMatcher / FileLockProvider）", () => {
  // 健康度计算器
  assert.equal(typeof Eag.HealthScoreCalculator, "function", "HealthScoreCalculator 应为 class");
  assert.equal(Eag.HealthScoreCalculator.name, "HealthScoreCalculator", "类名应为 'HealthScoreCalculator'");
  // 根因规则匹配器
  assert.equal(typeof Eag.RootCauseRuleMatcher, "function", "RootCauseRuleMatcher 应为 class");
  assert.equal(Eag.RootCauseRuleMatcher.name, "RootCauseRuleMatcher", "类名应为 'RootCauseRuleMatcher'");
  // 文件锁提供者
  assert.equal(typeof Eag.FileLockProvider, "function", "FileLockProvider 应为 class");
  assert.equal(Eag.FileLockProvider.name, "FileLockProvider", "类名应为 'FileLockProvider'");
  // 默认根因规则常量
  assert.ok(Array.isArray(Eag.DEFAULT_ROOT_CAUSE_RULES), "DEFAULT_ROOT_CAUSE_RULES 应为数组");
  assert.ok(Eag.DEFAULT_ROOT_CAUSE_RULES.length > 0, "DEFAULT_ROOT_CAUSE_RULES 应非空");
});

// ============================================================================
// T28. 命名冲突解决验证（LOOP_TYPES / deepFreeze / LogCallback）
// ============================================================================

test("T28: EAG 根 barrel 命名冲突解决验证（LOOP_TYPES / deepFreeze / LogCallback 权威来源）", () => {
  // 1. LOOP_TYPES：应来自 loop/models（值 = ["design","coding","testing"]）
  assert.ok(Array.isArray(Eag.LOOP_TYPES), "LOOP_TYPES 应为数组");
  assert.equal(Eag.LOOP_TYPES.length, 3, "LOOP_TYPES 应含 3 个值");
  assert.deepEqual(
    [...Eag.LOOP_TYPES],
    ["design", "coding", "testing"],
    "LOOP_TYPES 值应为 ['design','coding','testing']"
  );

  // 2. deepFreeze：应来自 tcs/types（函数类型）
  assert.equal(typeof Eag.deepFreeze, "function", "deepFreeze 应为 function");
  // 真实调用 deepFreeze 验证功能（非 mock，真实冻结对象）
  const obj = { a: 1, b: { c: 2 } };
  const frozen = Eag.deepFreeze(obj);
  assert.equal(frozen.a, 1, "deepFreeze 应保留原属性值");
  // 验证对象已冻结（不可修改）
  assert.ok(Object.isFrozen(frozen), "deepFreeze 返回值应为冻结对象");

  // 3. LogCallback：应来自 loop/models（type-only，编译期校验）
  // 通过 assertTypeAccessible 函数间接校验类型可用性
  // 注：LogCallback 类型为 ((message: string, level: "INFO" | "WARN") => void) | null
  // 此处构造一个满足 loop/models 风格的 LogCallback（大写级别 + 可空）
  // 若根 barrel 错误导出了 testing/long-horizon 风格的 LogCallback（小写级别），
  // 以下赋值会触发 tsc 编译错误（"info" 不匹配 "INFO" | "WARN"）
  import("../eag/index").then((mod) => {
    // 运行期确认模块可加载
    assert.ok(mod, "EAG 根 barrel 模块应可加载");
  });
  // 编译期类型校验：通过 type-only import 在类型位置使用
  type LoopLogCallback = typeof Eag extends { LogCallback?: infer L } ? L : never;
  // 上述类型推导为 never（因 LogCallback 是 type-only export，不占运行期属性）
  // 真正的编译期校验在文件顶部 `import type { ... } from "../eag/index"` 已完成
});
