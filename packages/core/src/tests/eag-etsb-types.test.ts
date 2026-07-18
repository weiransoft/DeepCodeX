/**
 * EAG-P1 批次 4 单元测试：ETSB 核心类型定义完整性
 *
 * 测试范围：
 * - T1. TechLanguage 类型与 TECH_LANGUAGES 常量
 * - T2. TechLayer 类型与 TECH_LAYERS 常量（10 层）
 * - T3. TechStackOption 接口（name + priority + notes?）
 * - T4. TechStackMatrixCell 接口（language + layer + options）
 * - T5. TechStackMatrix 接口（嵌套 Record 结构）
 * - T6. TechStackDecision 接口（layer + selectedOption + reason + alternatives + risks）
 * - T7. TechStackDecisionTable 接口（language + decisions + humanConfirmed）
 * - T8. DeploymentBlueprintId 类型与 DEPLOYMENT_BLUEPRINT_IDS 常量
 * - T9. DeploymentBlueprint 接口（id + name + topology + applicabilitySignals + components）
 * - T10. TechStackLock 接口（locked + decisionTable + lockedAt + lockedBy）
 * - T11. TechStackSelectionInput 接口（language + 4 个可选信号）
 * - T12. 常量已冻结（Object.isFrozen）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实类型实例（构造真实对象验证字段赋值）
 * - 类型层面验证通过构造真实对象 + 字段访问实现
 *
 * 设计依据：
 * - EAG 方案 §5.6 ETSB 模块定义
 * - eag/etsb/types.ts 源文件（被测对象）
 *
 * @module core/tests/eag-etsb-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TECH_LANGUAGES,
  TECH_LAYERS,
  DEPLOYMENT_BLUEPRINT_IDS,
  type TechLanguage,
  type TechLayer,
  type TechStackOption,
  type TechStackMatrixCell,
  type TechStackMatrix,
  type TechStackDecision,
  type TechStackDecisionTable,
  type DeploymentBlueprintId,
  type DeploymentBlueprint,
  type TechStackLock,
  type TechStackSelectionInput,
} from "../eag/etsb/types";

// ============================================================================
// T1. TechLanguage 类型与 TECH_LANGUAGES 常量
// ============================================================================

test("T1a. TECH_LANGUAGES 长度 = 4", () => {
  assert.equal(TECH_LANGUAGES.length, 4);
});

test("T1b. TECH_LANGUAGES 包含全部 4 个语言", () => {
  const expected: TechLanguage[] = ["typescript", "java", "python", "go"];
  assert.deepEqual([...TECH_LANGUAGES], expected);
});

test("T1c. TECH_LANGUAGES 已冻结（Object.isFrozen）", () => {
  assert.ok(Object.isFrozen(TECH_LANGUAGES));
});

test("T1d. TechLanguage 类型可正确赋值 4 个字面量", () => {
  const langs: TechLanguage[] = ["typescript", "java", "python", "go"];
  assert.equal(langs.length, 4);
});

// ============================================================================
// T2. TechLayer 类型与 TECH_LAYERS 常量（10 层）
// ============================================================================

test("T2a. TECH_LAYERS 长度 = 10", () => {
  assert.equal(TECH_LAYERS.length, 10);
});

test("T2b. TECH_LAYERS 包含全部 10 个层", () => {
  const expected: TechLayer[] = [
    "frontend",
    "backend-framework",
    "orm",
    "cache",
    "message-queue",
    "object-storage",
    "search",
    "task-scheduler",
    "auth",
    "api-contract",
  ];
  assert.deepEqual([...TECH_LAYERS], expected);
});

test("T2c. TECH_LAYERS 已冻结", () => {
  assert.ok(Object.isFrozen(TECH_LAYERS));
});

test("T2d. TechLayer 类型可正确赋值 10 个字面量", () => {
  const layers: TechLayer[] = [
    "frontend",
    "backend-framework",
    "orm",
    "cache",
    "message-queue",
    "object-storage",
    "search",
    "task-scheduler",
    "auth",
    "api-contract",
  ];
  assert.equal(layers.length, 10);
});

// ============================================================================
// T3. TechStackOption 接口（name + priority + notes?）
// ============================================================================

test("T3a. TechStackOption 接口可正确赋值（含 notes）", () => {
  const option: TechStackOption = {
    name: "React 18 + TypeScript + Ant Design",
    priority: 1,
    notes: "企业级中后台首选",
  };
  assert.equal(option.name, "React 18 + TypeScript + Ant Design");
  assert.equal(option.priority, 1);
  assert.equal(option.notes, "企业级中后台首选");
});

test("T3b. TechStackOption 接口 notes 字段可选", () => {
  const option: TechStackOption = {
    name: "Redis（ioredis）",
    priority: 1,
  };
  assert.equal(option.notes, undefined);
});

test("T3c. TechStackOption priority 可为 1（首选）或 2（备选）", () => {
  const primary: TechStackOption = { name: "NestJS", priority: 1 };
  const alternative: TechStackOption = { name: "Express", priority: 2 };
  assert.equal(primary.priority, 1);
  assert.equal(alternative.priority, 2);
});

// ============================================================================
// T4. TechStackMatrixCell 接口（language + layer + options）
// ============================================================================

test("T4. TechStackMatrixCell 接口可正确赋值（含 options 数组）", () => {
  const cell: TechStackMatrixCell = {
    language: "typescript",
    layer: "frontend",
    options: [
      { name: "React 18 + TypeScript + Ant Design", priority: 1 },
      { name: "Vue 3 + Element Plus", priority: 2 },
    ],
  };
  assert.equal(cell.language, "typescript");
  assert.equal(cell.layer, "frontend");
  assert.equal(cell.options.length, 2);
  assert.equal(cell.options[0].priority, 1);
});

// ============================================================================
// T5. TechStackMatrix 接口（嵌套 Record 结构）
// ============================================================================

test("T5a. TechStackMatrix 接口支持嵌套 Record 结构", () => {
  const matrix: TechStackMatrix = {
    cells: {
      typescript: {
        frontend: [{ name: "React 18", priority: 1 }],
      },
    } as unknown as TechStackMatrix["cells"],
  };
  assert.equal(matrix.cells.typescript.frontend[0].name, "React 18");
});

test("T5b. TechStackMatrix 嵌套查询可获取 options", () => {
  const matrix: TechStackMatrix = {
    cells: {
      typescript: {
        frontend: [
          { name: "React 18", priority: 1 },
          { name: "Vue 3", priority: 2 },
        ],
      },
    } as unknown as TechStackMatrix["cells"],
  };
  const options = matrix.cells.typescript.frontend;
  assert.equal(options.length, 2);
  assert.equal(options[0].priority, 1);
  assert.equal(options[1].priority, 2);
});

// ============================================================================
// T6. TechStackDecision 接口
// ============================================================================

test("T6a. TechStackDecision 接口可正确赋值（含全部字段）", () => {
  const decision: TechStackDecision = {
    layer: "frontend",
    selectedOption: { name: "React 18 + TypeScript + Ant Design", priority: 1 },
    reason: "企业级中后台首选，生态成熟",
    alternatives: [{ name: "Vue 3 + Element Plus", priority: 2 }],
    risks: ["技术栈锁定后任何变更必须用户显式批准（SEED-06 规则）"],
  };
  assert.equal(decision.layer, "frontend");
  assert.equal(decision.selectedOption.priority, 1);
  assert.ok(decision.reason.length > 0);
  assert.equal(decision.alternatives.length, 1);
  assert.equal(decision.risks.length, 1);
});

test("T6b. TechStackDecision risks 可为空数组", () => {
  const decision: TechStackDecision = {
    layer: "cache",
    selectedOption: { name: "Redis", priority: 1 },
    reason: "通用缓存方案",
    alternatives: [],
    risks: [],
  };
  assert.equal(decision.risks.length, 0);
  assert.equal(decision.alternatives.length, 0);
});

// ============================================================================
// T7. TechStackDecisionTable 接口
// ============================================================================

test("T7a. TechStackDecisionTable 接口可正确赋值（含 10 层决策）", () => {
  const decisions: TechStackDecision[] = [
    "frontend",
    "backend-framework",
    "orm",
    "cache",
    "message-queue",
    "object-storage",
    "search",
    "task-scheduler",
    "auth",
    "api-contract",
  ].map((layer) => ({
    layer: layer as TechLayer,
    selectedOption: { name: "测试方案", priority: 1 },
    reason: "测试理由",
    alternatives: [],
    risks: [],
  }));
  const table: TechStackDecisionTable = {
    language: "typescript",
    decisions,
    humanConfirmed: false,
  };
  assert.equal(table.language, "typescript");
  assert.equal(table.decisions.length, 10);
  assert.equal(table.humanConfirmed, false);
});

test("T7b. TechStackDecisionTable humanConfirmed 可为 true（已确认）", () => {
  const table: TechStackDecisionTable = {
    language: "java",
    decisions: [],
    humanConfirmed: true,
  };
  assert.equal(table.humanConfirmed, true);
});

// ============================================================================
// T8. DeploymentBlueprintId 类型与 DEPLOYMENT_BLUEPRINT_IDS 常量
// ============================================================================

test("T8a. DEPLOYMENT_BLUEPRINT_IDS 长度 = 3", () => {
  assert.equal(DEPLOYMENT_BLUEPRINT_IDS.length, 3);
});

test("T8b. DEPLOYMENT_BLUEPRINT_IDS 包含全部 3 个蓝图 ID", () => {
  const expected: DeploymentBlueprintId[] = ["spa-monolith", "bff-microservice", "cloud-native-microservice"];
  assert.deepEqual([...DEPLOYMENT_BLUEPRINT_IDS], expected);
});

test("T8c. DEPLOYMENT_BLUEPRINT_IDS 已冻结", () => {
  assert.ok(Object.isFrozen(DEPLOYMENT_BLUEPRINT_IDS));
});

test("T8d. DeploymentBlueprintId 类型可正确赋值 3 个字面量", () => {
  const ids: DeploymentBlueprintId[] = ["spa-monolith", "bff-microservice", "cloud-native-microservice"];
  assert.equal(ids.length, 3);
});

// ============================================================================
// T9. DeploymentBlueprint 接口
// ============================================================================

test("T9a. DeploymentBlueprint 接口可正确赋值（含全部字段）", () => {
  const blueprint: DeploymentBlueprint = {
    id: "spa-monolith",
    name: "前后端分离单体",
    topology: "SPA + 单后端 + 单库 + Redis",
    applicabilitySignals: ["中小团队", "业务边界未稳", "快速交付"],
    components: ["SPA 前端", "单体后端", "单数据库", "Redis 缓存"],
  };
  assert.equal(blueprint.id, "spa-monolith");
  assert.equal(blueprint.name, "前后端分离单体");
  assert.ok(blueprint.topology.length > 0);
  assert.equal(blueprint.applicabilitySignals.length, 3);
  assert.equal(blueprint.components.length, 4);
});

test("T9b. DeploymentBlueprint 三套蓝图 ID 都可赋值", () => {
  const bp1: DeploymentBlueprint = {
    id: "spa-monolith",
    name: "前后端分离单体",
    topology: "",
    applicabilitySignals: [],
    components: [],
  };
  const bp2: DeploymentBlueprint = {
    id: "bff-microservice",
    name: "BFF 微服务",
    topology: "",
    applicabilitySignals: [],
    components: [],
  };
  const bp3: DeploymentBlueprint = {
    id: "cloud-native-microservice",
    name: "云原生微服务",
    topology: "",
    applicabilitySignals: [],
    components: [],
  };
  assert.equal(bp1.id, "spa-monolith");
  assert.equal(bp2.id, "bff-microservice");
  assert.equal(bp3.id, "cloud-native-microservice");
});

// ============================================================================
// T10. TechStackLock 接口
// ============================================================================

test("T10a. TechStackLock 接口可正确赋值（locked=true 场景）", () => {
  const lock: TechStackLock = {
    locked: true,
    decisionTable: {
      language: "typescript",
      decisions: [],
      humanConfirmed: true,
    },
    lockedAt: "2026-07-18T10:30:00.000Z",
    lockedBy: "架构师张三",
  };
  assert.equal(lock.locked, true);
  assert.equal(lock.decisionTable.language, "typescript");
  assert.equal(lock.lockedAt, "2026-07-18T10:30:00.000Z");
  assert.equal(lock.lockedBy, "架构师张三");
});

test("T10b. TechStackLock 接口可正确赋值（locked=false 场景）", () => {
  const lock: TechStackLock = {
    locked: false,
    decisionTable: {
      language: "java",
      decisions: [],
      humanConfirmed: true,
    },
    lockedAt: "2026-07-18T10:30:00.000Z",
    lockedBy: "架构师张三",
  };
  assert.equal(lock.locked, false);
});

// ============================================================================
// T11. TechStackSelectionInput 接口
// ============================================================================

test("T11a. TechStackSelectionInput 仅 language 必填", () => {
  const input: TechStackSelectionInput = {
    language: "typescript",
  };
  assert.equal(input.language, "typescript");
  assert.equal(input.concurrency, undefined);
  assert.equal(input.teamStackLegacy, undefined);
  assert.equal(input.deployEnv, undefined);
  assert.equal(input.compliance, undefined);
});

test("T11b. TechStackSelectionInput 可填全部信号", () => {
  const input: TechStackSelectionInput = {
    language: "typescript",
    concurrency: "high",
    teamStackLegacy: "java",
    deployEnv: "cloud-native",
    compliance: "strict",
  };
  assert.equal(input.concurrency, "high");
  assert.equal(input.teamStackLegacy, "java");
  assert.equal(input.deployEnv, "cloud-native");
  assert.equal(input.compliance, "strict");
});

test("T11c. TechStackSelectionInput concurrency 三档全部合法", () => {
  const concurrencies: NonNullable<TechStackSelectionInput["concurrency"]>[] = ["low", "medium", "high"];
  assert.equal(concurrencies.length, 3);
});

test("T11d. TechStackSelectionInput deployEnv 三档全部合法", () => {
  const envs: NonNullable<TechStackSelectionInput["deployEnv"]>[] = ["single-server", "cluster", "cloud-native"];
  assert.equal(envs.length, 3);
});

test("T11e. TechStackSelectionInput compliance 两档全部合法", () => {
  const compliances: NonNullable<TechStackSelectionInput["compliance"]>[] = ["general", "strict"];
  assert.equal(compliances.length, 2);
});

// ============================================================================
// T12. 常量已冻结（Object.isFrozen）
// ============================================================================

test("T12a. TECH_LANGUAGES 已冻结", () => {
  assert.ok(Object.isFrozen(TECH_LANGUAGES));
});

test("T12b. TECH_LAYERS 已冻结", () => {
  assert.ok(Object.isFrozen(TECH_LAYERS));
});

test("T12c. DEPLOYMENT_BLUEPRINT_IDS 已冻结", () => {
  assert.ok(Object.isFrozen(DEPLOYMENT_BLUEPRINT_IDS));
});
