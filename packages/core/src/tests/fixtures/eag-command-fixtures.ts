/**
 * EAG 命令测试共享 fixtures（批次 2 拆分提取）
 *
 * 提取自原 `eag-cli-command-parser.test.ts` 与 `eag-session-commands-hook.test.ts` 共享的
 * helper 函数，避免重复代码。所有 fixture 使用 Object.freeze 冻结（对齐不可变优先 §5.12.4 G-A6d）。
 *
 * 严格遵循"禁止 mock"规则：所有对象为真实结构占位，仅用于字段校验通过路径测试，
 * 不可真正传给 Orchestrator.run()。
 *
 * @module tests/fixtures/eag-command-fixtures
 */

import { SessionManager } from "../../session";
import type { DeployRequest } from "../../eag/cli/eag-command-parser";
import type { CodingLoopRequest } from "../../eag/coding/types";
import type { DesignLoopInput } from "../../eag/design/design-models";
import type { TestingLoopRequest } from "../../eag/testing/types";
import type { EagRunRequest, EagResumeRequest, EagStatusRequest } from "../../eag/long-horizon";

// ============================================================================
// 测试辅助：构造最小请求 fixture（真实结构，非 mock）
// ============================================================================

/**
 * 构造测试用最小 CodingLoopRequest 占位对象
 *
 * 用于 extractCodingLoopRequest 字段校验通过路径测试。
 * 注：此对象仅用于校验通过，不可真正传给 CodingOrchestrator.run()。
 */
export function createMinimalCodingLoopRequest(): CodingLoopRequest {
  return Object.freeze({
    projectRoot: "/test/project",
    specContent: "# spec\n订单管理模块需求规格",
    planContent: "# plan\n订单管理模块实施计划",
    tasksContent: "# tasks\nT-001: OrderAggregate 实现",
    taskDag: Object.freeze({
      nodes: Object.freeze([]),
      topologicalOrder: Object.freeze([]),
    }) as any,
    taskCards: Object.freeze([]) as any,
    techStack: Object.freeze(["TypeScript", "Node.js"]) as any,
    constitutionContent: "# CONSTITUTION\n项目红线声明",
    llmClient: { createMessage: () => ({}), providerName: "test" } as any,
    pkcAccessor: {
      queryBusinessFlows: () => Promise.resolve([]),
      queryRiskHotspots: () => Promise.resolve([]),
      queryL1GlobalView: () => Promise.resolve({}),
    } as any,
    loopGuard: {
      check: () => ({ allowed: true }),
      recordIteration: () => {},
      getConfig: () => ({
        maxIterations: 10,
        maxTokens: 100000,
        maxConsecutiveFailures: 3,
        initialBackoffMs: 1000,
        maxBackoffMs: 30000,
        backoffMultiplier: 2,
        jitterRatio: 0.1,
      }),
      getState: () => ({
        iterationsCompleted: 0,
        tokensConsumed: 0,
        consecutiveFailures: 0,
        totalFailures: 0,
        backoffLevel: 0,
      }),
    } as any,
    maxIterations: 10,
    maxFixRounds: 3,
  }) as CodingLoopRequest;
}

/**
 * 构造测试用最小 DesignLoopInput 占位对象
 *
 * 用于 extractDesignLoopInput 字段校验通过路径测试。
 * 注：此对象仅用于校验通过，不可真正传给 DesignLoopOrchestrator.run()。
 */
export function createMinimalDesignLoopInput(): DesignLoopInput {
  return Object.freeze({
    rawRequirement: "作为一个用户，我希望创建订单，以便管理订单生命周期",
  });
}

/**
 * 构造测试用最小 TestingLoopRequest 占位对象
 *
 * 用于 extractTestingLoopRequest 字段校验通过路径测试。
 * 注：此对象仅用于校验通过，不可真正传给 TestingOrchestrator.run()。
 */
export function createMinimalTestingLoopRequest(): TestingLoopRequest {
  return Object.freeze({
    projectRoot: "/test/project",
    specContent: "# spec\n订单管理模块需求规格",
    planContent: "# plan\n订单管理模块实施计划",
    tasksContent: "# tasks\nT-001: OrderAggregate 实现",
    implementationRoot: "src/",
    taskDag: Object.freeze({ nodes: Object.freeze([]), topologicalOrder: Object.freeze([]) }) as any,
    acceptanceCriteria: Object.freeze([]) as any,
    llmClient: { createMessage: () => ({}), providerName: "test" } as any,
    pkcAccessor: {
      queryBusinessFlows: () => Promise.resolve([]),
      queryRiskHotspots: () => Promise.resolve([]),
      queryL1GlobalView: () => Promise.resolve({}),
    } as any,
    loopGuard: {
      check: () => ({ allowed: true }),
      recordIteration: () => {},
      getConfig: () => ({
        maxIterations: 10,
        maxTokens: 100000,
        maxConsecutiveFailures: 3,
        initialBackoffMs: 1000,
        maxBackoffMs: 30000,
        backoffMultiplier: 2,
        jitterRatio: 0.1,
      }),
      getState: () => ({
        iterationsCompleted: 0,
        tokensConsumed: 0,
        consecutiveFailures: 0,
        totalFailures: 0,
        backoffLevel: 0,
      }),
    } as any,
    coverageThreshold: Object.freeze({ lines: 80, branches: 70, functions: 85, highRiskSymbols: 100 }) as any,
    maxIterations: 10,
  }) as TestingLoopRequest;
}

/**
 * 构造测试用最小 EagRunRequest 占位对象
 *
 * 用于 extractEagRunRequest 字段校验通过路径测试。
 * 注：此对象仅用于校验通过，不可真正传给 EagRunHandler.handle()。
 */
export function createMinimalEagRunRequest(): EagRunRequest {
  return Object.freeze({
    projectRoot: "/test/project",
    userIntent: "我需要一个订单管理微服务",
    loopExecutors: Object.freeze([
      Object.freeze({ loopType: "design", execute: () => Promise.resolve({}) }),
      Object.freeze({ loopType: "coding", execute: () => Promise.resolve({}) }),
    ]) as any,
  }) as EagRunRequest;
}

/**
 * 构造测试用最小 EagResumeRequest 占位对象
 *
 * 用于 extractEagResumeRequest 字段校验通过路径测试。
 */
export function createMinimalEagResumeRequest(): EagResumeRequest {
  return Object.freeze({
    runId: "abc123def456",
    projectRoot: "/test/project",
    userIntent: "我需要一个订单管理微服务",
    loopExecutors: Object.freeze([Object.freeze({ loopType: "design", execute: () => Promise.resolve({}) })]) as any,
  }) as EagResumeRequest;
}

/**
 * 构造测试用最小 EagStatusRequest 占位对象
 *
 * 用于 extractEagStatusRequest 字段校验通过路径测试。
 */
export function createMinimalEagStatusRequest(): EagStatusRequest {
  return Object.freeze({
    projectRoot: "/test/project",
    runId: "abc123def456",
  }) as EagStatusRequest;
}

/**
 * 构造测试用最小 DeployRequest 占位对象（EAG-P4 批次 13 Phase 7 §5.1）
 *
 * 用于 extractDeployRequest 字段校验通过路径测试。
 * 字段对齐设计文档 §5.1 中的 DeployRequest 接口定义。
 */
export function createMinimalDeployRequest(): DeployRequest {
  return Object.freeze({
    projectName: "order-service",
    environment: "prod",
    image: "registry.example.com/order-service:v1.2.3",
    port: 8080,
    replicas: 3,
    iacType: "helm-chart",
    strategy: "blue-green",
  }) as DeployRequest;
}

/**
 * 构造测试用完整 DeployRequest 占位对象（含 dryRun flag）
 *
 * 用于 extractDeployRequest + handleEagDeployCommand 的 dryRun 路径测试。
 */
export function createMinimalDeployRequestWithDryRun(): DeployRequest {
  return Object.freeze({
    projectName: "payment-service",
    environment: "staging",
    image: "registry.example.com/payment-service:v2.0.0",
    port: 9090,
    replicas: 5,
    iacType: "terraform",
    strategy: "canary",
    dryRun: true,
  }) as DeployRequest;
}

/**
 * 构造 SessionManager 测试实例（最小依赖，仅注入 onAssistantMessage 回调）
 *
 * 真实组件装配，非 mock：
 * - SessionManager 为真实类
 * - createOpenAIClient / getResolvedSettings / renderMarkdown / onAssistantMessage 为真实回调
 * - 仅 client 返回 null（测试不依赖 LLM 调用）
 *
 * @param onMessage 消息回调（接收 assistant 消息内容）
 * @param extraOptions 额外 SessionManagerOptions（用于注入 EAG 外挂依赖）
 */
export function createTestManager(
  onMessage: (content: string) => void,
  extraOptions: Record<string, unknown> = {}
): SessionManager {
  return new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: (message: any) => onMessage(message.content),
    ...extraOptions,
  } as any);
}
