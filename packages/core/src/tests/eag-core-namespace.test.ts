/**
 * EAG 公共 API 命名空间导出测试（repair-plan.md §3.2）
 *
 * 验证 `packages/core/src/index.ts` 通过 `Eag` / `EagP5` 命名空间
 * 完整导出 EAG 能力，供 CLI 层通过 `@vegamo/deepcode-core` 单一入口访问。
 *
 * 测试范围：
 * - T1. core/index.ts 导出 Eag 命名空间
 * - T2. core/index.ts 导出 EagP5 命名空间
 * - T3. Eag 命名空间包含 eag/index.ts 聚合的核心类（CodingOrchestrator / TestingOrchestrator /
 *       AutonomousOrchestrator / GateOrchestrator / LoopScheduler / SymbolGraphStore）
 * - T4. EagP5 命名空间包含 P5 专属类（AutonomousOrchestrator / BlockerGuardChain /
 *       SymbolGraphStore / P5RunStateStore / P5NotesMemory）
 * - T5. Eag 命名空间与 EagP5 命名空间为不同对象，可独立使用
 * - T6. Eag / EagP5 类型命名空间可访问（编译期检查）
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock：仅验证导出存在性与类型可加载性
 * - 通过 `typeof Core.Eag.X === "function"` 验证类导出
 *
 * @module core/tests/eag-core-namespace
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// 从 core 公共 API 导入模块命名空间，再通过 Core.Eag / Core.EagP5 访问子命名空间
import * as Core from "../index.js";

// 类型导出验证（编译期检查）
import type { Eag as EagNs, EagP5 as EagP5Ns } from "../index.js";

test("T1: core/index.ts 导出 Eag 命名空间", () => {
  assert.ok(Core.Eag, "Core.Eag 命名空间应已导出");
  assert.ok(typeof Core.Eag.CodingOrchestrator === "function", "Core.Eag.CodingOrchestrator 应为类");
});

test("T2: core/index.ts 导出 EagP5 命名空间", () => {
  assert.ok(Core.EagP5, "Core.EagP5 命名空间应已导出");
  assert.ok(typeof Core.EagP5.AutonomousOrchestrator === "function", "Core.EagP5.AutonomousOrchestrator 应为类");
});

test("T3: Eag 命名空间包含 eag/index.ts 聚合的核心类", () => {
  assert.ok(typeof Core.Eag.CodingOrchestrator === "function", "Eag.CodingOrchestrator 应为类");
  assert.ok(typeof Core.Eag.TestingOrchestrator === "function", "Eag.TestingOrchestrator 应为类");
  assert.ok(typeof Core.Eag.AutonomousOrchestrator === "function", "Eag.AutonomousOrchestrator 应为类");
  assert.ok(typeof Core.Eag.GateOrchestrator === "function", "Eag.GateOrchestrator 应为类");
  assert.ok(typeof Core.Eag.LoopScheduler === "function", "Eag.LoopScheduler 应为类");
  assert.ok(typeof Core.Eag.SymbolGraphStore === "function", "Eag.SymbolGraphStore 应为类");
});

test("T4: EagP5 命名空间包含 P5 专属类", () => {
  assert.ok(typeof Core.EagP5.AutonomousOrchestrator === "function", "EagP5.AutonomousOrchestrator 应为类");
  assert.ok(typeof Core.EagP5.BlockerGuardChain === "function", "EagP5.BlockerGuardChain 应为类");
  assert.ok(typeof Core.EagP5.SymbolGraphStore === "function", "EagP5.SymbolGraphStore 应为类");
  assert.ok(typeof Core.EagP5.P5RunStateStore === "function", "EagP5.P5RunStateStore 应为类");
  assert.ok(typeof Core.EagP5.P5NotesMemory === "function", "EagP5.P5NotesMemory 应为类");
});

test("T5: Eag 与 EagP5 命名空间为不同对象，可独立使用", () => {
  assert.notStrictEqual(Core.Eag, Core.EagP5, "Core.Eag 与 Core.EagP5 应为不同命名空间对象");
  // Eag 聚合了 eag/index.ts（含 p5），因此也能访问 P5 类
  assert.ok(typeof Core.Eag.AutonomousOrchestrator === "function", "Eag 也可访问 AutonomousOrchestrator");
  // EagP5 只包含 p5 子系统，不包含 coding/testing 等模块
  assert.equal(typeof Core.EagP5.CodingOrchestrator, "undefined", "EagP5 不包含 CodingOrchestrator");
});

// 类型导出编译期校验（运行期无实际作用，仅确保 type-only import 不报错）
test("T6: Eag / EagP5 类型命名空间可访问", () => {
  // 通过引用类型参数触发编译期检查
  const _eagTypeCheck: typeof EagNs | undefined = undefined;
  const _eagP5TypeCheck: typeof EagP5Ns | undefined = undefined;
  assert.equal(_eagTypeCheck, undefined);
  assert.equal(_eagP5TypeCheck, undefined);
});
