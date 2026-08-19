/**
 * EAG DESIGN Loop 装配单元测试（S3.2 接线批次，2026-08-19）
 *
 * 测试范围（ui/core/eag-orchestrator-assembly.ts 的 buildDesignOrchestrator）：
 * - 成功路径：真实装配三角色（LlmProductManager + FeedbackAwareArchitect +
 *   FeedbackCapturingEvaluator(StaticDesignEvaluator)）→ DesignLoopOrchestrator 实例
 * - 失败安全：任一组件构造异常 → 返回 undefined + error 日志（fail-closed，
 *   /eag-design 命令降级为"未注入"，不阻断 CLI 启动）
 * - 日志断言：成功记录"装配完成"，失败记录"装配失败"
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock：直接调用真实装配函数，LLM 客户端工厂传真实函数
 *   （装配阶段不发起 LLM 调用，工厂仅在命令执行时被惰性调用）
 *
 * @module tests/eag-design-assembly
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDesignOrchestrator } from "../ui/core/eag-orchestrator-assembly";
import type { AssemblyLogCallback } from "../ui/core/eag-orchestrator-assembly";
import { DesignLoopOrchestrator } from "@vegamo/deepcode-core";

// ============================================================================
// 成功路径
// ============================================================================

test("A1. buildDesignOrchestrator 真实装配三角色并返回 DesignLoopOrchestrator 实例", () => {
  // level 为可选参数（AssemblyLogCallback 签名），日志记录类型需兼容 undefined
  const logs: Array<{ message: string; level: string | undefined }> = [];
  const log: AssemblyLogCallback = (message, level) => logs.push({ message, level });

  const orchestrator = buildDesignOrchestrator(() => null, log);

  // 实例断言：装配产物为 DesignLoopOrchestrator（真实类，非空壳对象）
  assert.ok(orchestrator, "装配应返回实例（createLLMClient 返回 null 不影响装配，仅命令执行时失败）");
  assert.ok(orchestrator instanceof DesignLoopOrchestrator, "应为 DesignLoopOrchestrator 实例");
  assert.equal(typeof orchestrator.run, "function", "应暴露 run() 方法");

  // 日志断言：成功装配记录 info 级日志
  const completed = logs.find((l) => l.message.includes("DesignLoopOrchestrator 装配完成"));
  assert.ok(completed, "应记录装配完成日志");
  assert.equal(completed?.level, "info");
});

test("A2. buildDesignOrchestrator 默认日志回调（无 log 参数）不抛错", () => {
  // 默认空操作日志回调路径冒烟（App.tsx 始终注入日志，此处覆盖默认值分支）
  const orchestrator = buildDesignOrchestrator(() => null);
  assert.ok(orchestrator instanceof DesignLoopOrchestrator);
});

// ============================================================================
// 失败安全（fail-closed）
// ============================================================================

test("A3. 组件构造异常时返回 undefined 并记录 error 日志（fail-closed）", () => {
  // level 为可选参数（AssemblyLogCallback 签名），日志记录类型需兼容 undefined
  const logs: Array<{ message: string; level: string | undefined }> = [];
  const log: AssemblyLogCallback = (message, level) => logs.push({ message, level });

  // 非函数 createLLMClient：LlmProductManager 构造函数抛错 → 装配层捕获
  const orchestrator = buildDesignOrchestrator(undefined as unknown as () => null, log);

  assert.equal(orchestrator, undefined, "构造失败应返回 undefined（命令降级为不可用）");
  const failed = logs.find((l) => l.message.includes("DesignLoopOrchestrator 装配失败"));
  assert.ok(failed, "应记录装配失败日志");
  assert.equal(failed?.level, "error");
  assert.ok(failed?.message.includes("createLLMClient"), "失败日志应含具体原因");
});

test("A4. 失败安全不阻断 CLI 启动：装配失败后仍可返回 undefined 而非抛出异常", () => {
  // 抛出型 createLLMClient 工厂（装配期不被调用，仅验证装配函数本身不抛）
  const throwingFactory = () => {
    throw new Error("装配期不应调用 LLM 工厂");
  };
  const orchestrator = buildDesignOrchestrator(throwingFactory);
  assert.ok(orchestrator instanceof DesignLoopOrchestrator, "装配期不调用工厂（惰性调用语义）");
});
