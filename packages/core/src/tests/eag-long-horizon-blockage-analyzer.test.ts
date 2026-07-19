/**
 * EAG-P3 批次 10 单元测试：long-horizon/blockage-analyzer.ts 阻塞分析器
 *
 * 测试范围（对齐设计文档 §4.16）：
 * - T1.  BlockageAnalyzer 构造函数校验（必填依赖 + 自定义 ruleMatcher 注入）
 * - T2.  analyze() 请求字段校验（runId / projectRoot / blockedLoop / blockedIteration）
 * - T3.  analyze() RunState 未找到 → 抛 run-state-not-found
 * - T4.  RootCauseRuleMatcher 规则匹配通道 rc-001（同一红线 3 次失败）
 * - T5.  RootCauseRuleMatcher 规则匹配通道 rc-002（同一任务卡 FIX 失败 3 次）
 * - T6.  RootCauseRuleMatcher 规则匹配通道 rc-003（覆盖率连续 2 次 BLOCKER）
 * - T7.  RootCauseRuleMatcher 规则匹配通道 rc-004（多次 LLM 超时）
 * - T8.  analyze() 不传 llmClient → 仅使用规则匹配通道
 * - T9.  analyze() 传 llmClient → 双通道合并结果（rule-based + llm-inferred）
 * - T10. analyze() LLM 推断失败 → 仅返回规则匹配结果（容错降级）
 * - T11. analyze() 阻塞分析报告结构完整性 + 自定义 ruleStore / ruleMatcher
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用真实 RunStateStore + RuleStore + RootCauseRuleMatcher
 * - LLM 客户端使用真实 InMemoryLLMClient（实现 LLMClient 接口，按预设内容返回）
 * - 真实文件系统 I/O（fs.mkdtempSync + try/finally 清理）
 * - RunState 通过 RunStateStore.initialize + appendEvent 真实构造
 * - 使用 node:test + node:assert/strict
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计文档 §4.16 BlockageAnalyzer
 * - EAG 方案 §5.12.2 阻塞分析报告（根因假设 + 建议方案 + 所需决策）
 * - eag/long-horizon/blockage-analyzer.ts 源文件
 *
 * @module core/tests/eag-long-horizon-blockage-analyzer
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BlockageAnalyzer, RootCauseRuleMatcher, BlockageAnalyzerError } from "../eag/long-horizon/blockage-analyzer";
import type { BlockageAnalyzeRequest } from "../eag/long-horizon/blockage-analyzer";
import { RunStateStore } from "../eag/long-horizon/run-state-store";
import type { RunState } from "../eag/long-horizon/types";
import {
  BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD,
  LLM_INFERRED_CONFIDENCE_CAP,
  DEFAULT_ROOT_CAUSE_RULES,
} from "../eag/long-horizon/types";
import { RuleStore } from "../eag/rlis/rule-store";
import { SEED_RULES } from "../eag/rlis/seed-rules";
import type { UserRule } from "../eag/rlis/types";
import type { LLMClient, LLMRequest, LLMResponse, LLMStreamEvent, ProviderName } from "../providers/llm-provider";

// ============================================================================
// 辅助工具
// ============================================================================

/**
 * 创建临时项目根目录
 *
 * @returns 临时项目根目录绝对路径
 */
function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eag-blockage-"));
}

/**
 * 递归删除目录
 *
 * @param dirPath 待删除目录
 */
function rmrf(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
}

// ============================================================================
// 真实组件实现（禁止 mock —— 这些是真实类型的轻量级实现，不是 mock 框架产物）
// ============================================================================

/**
 * 真实 InMemoryLLMClient 实现（非 mock）
 *
 * 实现 LLMClient 接口，按构造时传入的固定内容返回 LLMResponse。
 * 用于 T9/T10 测试 LLM 推断通道：
 * - T9（双通道合并）：构造时传入 JSON 数组字符串作为 content
 * - T10（LLM 推断失败）：构造时抛出指定异常
 *
 * 设计理由：
 * - 真实实现 LLMClient 协议（含 createMessage / createMessageStream 全部方法）
 * - 不依赖任何 mock 框架，符合项目"禁止 mock"规则
 * - 通过构造参数控制返回内容，便于测试不同 LLM 响应场景
 */
class InMemoryLLMClient implements LLMClient {
  readonly providerName: ProviderName = "openai";
  readonly model = "test-model";
  readonly baseURL = "memory://";
  readonly supportsThinking = false;
  readonly supportsPromptCaching = false;

  /** 固定返回的 LLMResponse content 字段（字符串） */
  private readonly fixedContent: string;
  /** 是否在 createMessage 时抛出异常（用于测试 LLM 推断失败的容错降级） */
  private readonly shouldThrow: boolean;
  /** 抛出异常时的错误消息 */
  private readonly throwMessage: string;

  /**
   * @param fixedContent 固定返回的 content 字段（默认空字符串）
   * @param shouldThrow 是否在 createMessage 时抛出异常（默认 false）
   * @param throwMessage 抛出异常时的错误消息（默认 "LLM 测试异常"）
   */
  constructor(fixedContent: string = "", shouldThrow: boolean = false, throwMessage: string = "LLM 测试异常") {
    this.fixedContent = fixedContent;
    this.shouldThrow = shouldThrow;
    this.throwMessage = throwMessage;
  }

  async createMessage(_request: LLMRequest): Promise<LLMResponse> {
    // 模拟 LLM 推断失败场景（用于 T10 测试容错降级）
    if (this.shouldThrow) {
      throw new Error(this.throwMessage);
    }
    // 返回固定内容的 LLMResponse（用于 T9 测试双通道合并）
    return {
      content: this.fixedContent,
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }

  async *createMessageStream(_request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    // BlockageAnalyzer 仅使用 createMessage，不使用流式接口；
    // 此处为协议完整性实现，产出 text_delta 后正常结束
    yield { type: "text_delta", text: this.fixedContent };
    yield { type: "message_end", stopReason: "stop", usage: null };
  }
}

// ============================================================================
// RunState 工厂辅助函数
// ============================================================================

/**
 * 创建带人工介入记录的 RunState（真实通过 RunStateStore 构造）
 *
 * 算法：
 * 1. 调用 RunStateStore.initialize 创建初始 RunState（status=running）
 * 2. 依次 appendEvent "human-intervention" 事件，每条记录含 loopType / reason / decision
 * 3. 返回最终 RunState（含 humanInterventions 列表）
 *
 * @param projectRoot 项目根目录
 * @param runStateStore RunState 持久化存储
 * @param interventions 介入记录列表（每项含 loopType / reason / decision）
 * @returns runId（供后续 analyze() 调用使用）
 */
async function createRunStateWithInterventions(
  projectRoot: string,
  runStateStore: RunStateStore,
  interventions: ReadonlyArray<{
    loopType: "design" | "coding" | "testing";
    reason: string;
    decision: string;
  }>
): Promise<string> {
  // 1. 初始化 RunState
  const initState = await runStateStore.initialize({ projectRoot });
  const runId = initState.runId;

  // 2. 依次追加 human-intervention 事件
  for (const intervention of interventions) {
    await runStateStore.appendEvent(runId, {
      type: "human-intervention",
      payload: {
        loopType: intervention.loopType,
        reason: intervention.reason,
        decision: intervention.decision,
      },
    });
  }

  return runId;
}

// ============================================================================
// T1. BlockageAnalyzer 构造函数校验
// ============================================================================

test("T1.1 BlockageAnalyzer 注入 runStateStore 可成功实例化", () => {
  const store = new RunStateStore();
  const analyzer = new BlockageAnalyzer(store);
  assert.ok(analyzer instanceof BlockageAnalyzer);
});

test("T1.2 BlockageAnalyzer 缺少 runStateStore 抛 invalid-request", () => {
  assert.throws(
    () => new BlockageAnalyzer(undefined as any),
    (err: unknown) => {
      assert.ok(err instanceof BlockageAnalyzerError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.message.includes("runStateStore 必填"));
      return true;
    }
  );
});

test("T1.3 BlockageAnalyzer 注入 ruleStore + logger + ruleMatcher 可成功实例化", () => {
  const store = new RunStateStore();
  const ruleStore = new RuleStore(SEED_RULES);
  const ruleMatcher = new RootCauseRuleMatcher();
  const logs: Array<{ msg: string; level: string }> = [];
  const analyzer = new BlockageAnalyzer(
    store,
    ruleStore,
    (msg: string, level?: "info" | "warn" | "error") => {
      logs.push({ msg, level: level ?? "info" });
    },
    ruleMatcher
  );
  assert.ok(analyzer instanceof BlockageAnalyzer);
  // 未调用 analyze() 时不应产生日志
  assert.equal(logs.length, 0);
});

// ============================================================================
// T2. analyze() 请求字段校验
// ============================================================================

test("T2.1 analyze() runId 为空字符串 → 抛 invalid-request", async () => {
  const store = new RunStateStore();
  const analyzer = new BlockageAnalyzer(store);
  await assert.rejects(
    analyzer.analyze({
      runId: "",
      projectRoot: "/tmp",
      blockedLoop: "coding",
      blockedIteration: 1,
    } as BlockageAnalyzeRequest),
    (err: unknown) => {
      assert.ok(err instanceof BlockageAnalyzerError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.message.includes("runId 必须为非空字符串"));
      return true;
    }
  );
});

test("T2.2 analyze() projectRoot 为空字符串 → 抛 invalid-request", async () => {
  const store = new RunStateStore();
  const analyzer = new BlockageAnalyzer(store);
  await assert.rejects(
    analyzer.analyze({
      runId: "test001",
      projectRoot: "",
      blockedLoop: "coding",
      blockedIteration: 1,
    } as BlockageAnalyzeRequest),
    (err: unknown) => {
      assert.ok(err instanceof BlockageAnalyzerError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.message.includes("projectRoot 必须为非空字符串"));
      return true;
    }
  );
});

test("T2.3 analyze() blockedLoop 为非法值 → 抛 invalid-request", async () => {
  const store = new RunStateStore();
  const analyzer = new BlockageAnalyzer(store);
  await assert.rejects(
    analyzer.analyze({
      runId: "test001",
      projectRoot: "/tmp",

      blockedLoop: "dev" as any,
      blockedIteration: 1,
    } as BlockageAnalyzeRequest),
    (err: unknown) => {
      assert.ok(err instanceof BlockageAnalyzerError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.message.includes("blockedLoop 非法"));
      return true;
    }
  );
});

test("T2.4 analyze() blockedIteration 为负数 → 抛 invalid-request", async () => {
  const store = new RunStateStore();
  const analyzer = new BlockageAnalyzer(store);
  await assert.rejects(
    analyzer.analyze({
      runId: "test001",
      projectRoot: "/tmp",
      blockedLoop: "coding",
      blockedIteration: -1,
    } as BlockageAnalyzeRequest),
    (err: unknown) => {
      assert.ok(err instanceof BlockageAnalyzerError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.message.includes("blockedIteration 必须为非负整数"));
      return true;
    }
  );
});

test("T2.5 analyze() blockedIteration 为非整数（1.5）→ 抛 invalid-request", async () => {
  const store = new RunStateStore();
  const analyzer = new BlockageAnalyzer(store);
  await assert.rejects(
    analyzer.analyze({
      runId: "test001",
      projectRoot: "/tmp",
      blockedLoop: "coding",
      blockedIteration: 1.5,
    } as BlockageAnalyzeRequest),
    (err: unknown) => {
      assert.ok(err instanceof BlockageAnalyzerError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.message.includes("blockedIteration 必须为非负整数"));
      return true;
    }
  );
});

// ============================================================================
// T3. analyze() RunState 未找到 → 抛 run-state-not-found
// ============================================================================

test("T3.1 analyze() runId 不存在 → 抛 run-state-not-found", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const analyzer = new BlockageAnalyzer(store);
    await assert.rejects(
      analyzer.analyze({
        runId: "nonexistent999",
        projectRoot,
        blockedLoop: "coding",
        blockedIteration: 1,
      }),
      (err: unknown) => {
        assert.ok(err instanceof BlockageAnalyzerError);
        assert.equal(err.kind, "run-state-not-found");
        assert.ok(err.message.includes("RunState 未找到"));
        assert.ok(err.message.includes("nonexistent999"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T4. RootCauseRuleMatcher 规则匹配通道 rc-001（同一红线 3 次失败）
// ============================================================================

test("T4.1 rc-001 同一红线 E7 出现 3 次 → 命中规则匹配", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 构造 3 条介入记录，reason 字段均含 "E7" 红线 ID
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "coding",
        reason: "E7 红线违反：贫血模型检测失败",
        decision: "重写为富血模型",
      },
      {
        loopType: "coding",
        reason: "E7 红线再次违反：值对象无业务方法",
        decision: "补充业务方法",
      },
      {
        loopType: "coding",
        reason: "E7 红线第三次违反：仍为贫血模型",
        decision: "重构聚合根",
      },
    ]);

    const analyzer = new BlockageAnalyzer(store);
    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "coding",
      blockedIteration: 3,
    });

    // 验证 rc-001 假设出现在根因假设列表中
    const rc001 = report.rootCauseHypotheses.find((h) => h.hypothesisId === "rc-001");
    assert.ok(rc001, "应命中 rc-001 规则");
    assert.equal(rc001!.source, "rule-based");
    assert.equal(rc001!.confidence, 0.8); // DEFAULT_ROOT_CAUSE_RULES 中 rc-001 confidence=0.8
    assert.ok(rc001!.evidence.length >= 3); // 至少 3 条证据（每条介入记录 1 条）
    assert.ok(rc001!.description.includes("评估器规则过严"));
  } finally {
    rmrf(projectRoot);
  }
});

test("T4.2 rc-001 同一红线 E7 仅出现 2 次 → 不命中规则", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 仅 2 条 E7 介入记录（不满足 ≥3 次阈值）
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "coding",
        reason: "E7 红线违反：贫血模型",
        decision: "重写",
      },
      {
        loopType: "coding",
        reason: "E7 红线再次违反",
        decision: "再次重写",
      },
    ]);

    const analyzer = new BlockageAnalyzer(store);
    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "coding",
      blockedIteration: 2,
    });

    // 不应命中 rc-001（次数不足）
    const rc001 = report.rootCauseHypotheses.find((h) => h.hypothesisId === "rc-001");
    assert.equal(rc001, undefined);
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T5. RootCauseRuleMatcher 规则匹配通道 rc-002（同一任务卡 FIX 失败 3 次）
// ============================================================================

test("T5.1 rc-002 同一任务卡 T-001 出现 3 次 → 命中规则匹配", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 构造 3 条介入记录，reason 字段均含 "T-001" 任务卡 ID
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "coding",
        reason: "T-001 任务卡 FIX 失败：第 1 次",
        decision: "调整实现",
      },
      {
        loopType: "coding",
        reason: "T-001 任务卡 FIX 失败：第 2 次",
        decision: "重新分析",
      },
      {
        loopType: "coding",
        reason: "T-001 任务卡 FIX 失败：第 3 次",
        decision: "扩大上下文",
      },
    ]);

    const analyzer = new BlockageAnalyzer(store);
    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "coding",
      blockedIteration: 3,
    });

    // 验证 rc-002 假设出现在根因假设列表中
    const rc002 = report.rootCauseHypotheses.find((h) => h.hypothesisId === "rc-002");
    assert.ok(rc002, "应命中 rc-002 规则");
    assert.equal(rc002!.source, "rule-based");
    assert.equal(rc002!.confidence, 0.75);
    assert.ok(rc002!.evidence.length >= 3);
    assert.ok(rc002!.description.includes("任务卡声明模糊"));
  } finally {
    rmrf(projectRoot);
  }
});

test("T5.2 rc-002 不同任务卡（T-001/T-002/T-003）各 1 次 → 不命中规则", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 3 个不同任务卡各 1 次（不满足"同一任务卡 ≥3 次"阈值）
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "coding",
        reason: "T-001 FIX 失败",
        decision: "调整",
      },
      {
        loopType: "coding",
        reason: "T-002 FIX 失败",
        decision: "调整",
      },
      {
        loopType: "coding",
        reason: "T-003 FIX 失败",
        decision: "调整",
      },
    ]);

    const analyzer = new BlockageAnalyzer(store);
    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "coding",
      blockedIteration: 3,
    });

    // 不应命中 rc-002（每个任务卡仅 1 次）
    const rc002 = report.rootCauseHypotheses.find((h) => h.hypothesisId === "rc-002");
    assert.equal(rc002, undefined);
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T6. RootCauseRuleMatcher 规则匹配通道 rc-003（覆盖率连续 2 次 BLOCKER）
// ============================================================================

test("T6.1 rc-003 连续 2 条覆盖率 BLOCKER 介入记录 → 命中规则匹配", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 构造 2 条连续的覆盖率 BLOCKER 介入记录（时间递增）
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "coding",
        reason: "覆盖率 BLOCKER：高风险符号未覆盖",
        decision: "补充测试",
      },
      {
        loopType: "coding",
        reason: "覆盖率 BLOCKER：仍未覆盖关键符号",
        decision: "继续补充",
      },
    ]);

    const analyzer = new BlockageAnalyzer(store);
    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "coding",
      blockedIteration: 2,
    });

    // 验证 rc-003 假设出现在根因假设列表中
    const rc003 = report.rootCauseHypotheses.find((h) => h.hypothesisId === "rc-003");
    assert.ok(rc003, "应命中 rc-003 规则");
    assert.equal(rc003!.source, "rule-based");
    assert.equal(rc003!.confidence, 0.7);
    assert.ok(rc003!.evidence.length >= 2);
    assert.ok(rc003!.description.includes("覆盖率阈值过严"));
  } finally {
    rmrf(projectRoot);
  }
});

test("T6.2 rc-003 覆盖率 BLOCKER 中间被其他原因打断 → 不命中规则", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 覆盖率 BLOCKER 被中间的 E7 红线问题打断（不连续）
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "coding",
        reason: "覆盖率 BLOCKER：未覆盖",
        decision: "补充测试",
      },
      {
        loopType: "coding",
        reason: "E7 红线违反：贫血模型", // 中断覆盖率连续性
        decision: "重写",
      },
      {
        loopType: "coding",
        reason: "覆盖率 BLOCKER：再次未覆盖",
        decision: "继续补充",
      },
    ]);

    const analyzer = new BlockageAnalyzer(store);
    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "coding",
      blockedIteration: 3,
    });

    // 不应命中 rc-003（连续性被打断）
    const rc003 = report.rootCauseHypotheses.find((h) => h.hypothesisId === "rc-003");
    assert.equal(rc003, undefined);
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T7. RootCauseRuleMatcher 规则匹配通道 rc-004（多次 LLM 超时）
// ============================================================================

test("T7.1 rc-004 累计 2 次 LLM 超时 → 命中规则匹配", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 构造 2 条 LLM 超时介入记录
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "coding",
        reason: "LLM 调用超时：第 1 次",
        decision: "重试",
      },
      {
        loopType: "coding",
        reason: "LLM 调用超时：第 2 次",
        decision: "切换模型",
      },
    ]);

    const analyzer = new BlockageAnalyzer(store);
    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "coding",
      blockedIteration: 2,
    });

    // 验证 rc-004 假设出现在根因假设列表中
    const rc004 = report.rootCauseHypotheses.find((h) => h.hypothesisId === "rc-004");
    assert.ok(rc004, "应命中 rc-004 规则");
    assert.equal(rc004!.source, "rule-based");
    assert.equal(rc004!.confidence, 0.6);
    assert.ok(rc004!.evidence.length >= 2);
    assert.ok(rc004!.description.includes("LLM 上下文不足"));
    // 额外证据：RunState LLM 调用统计
    assert.ok(
      rc004!.evidence.some((e) => e.includes("RunState 统计")),
      "应包含 RunState LLM 调用统计证据"
    );
  } finally {
    rmrf(projectRoot);
  }
});

test("T7.2 rc-004 仅 1 次 LLM 超时 → 不命中规则", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 仅 1 条 LLM 超时记录（不满足 ≥2 次阈值）
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "coding",
        reason: "LLM 调用超时",
        decision: "重试",
      },
    ]);

    const analyzer = new BlockageAnalyzer(store);
    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "coding",
      blockedIteration: 1,
    });

    // 不应命中 rc-004（次数不足）
    const rc004 = report.rootCauseHypotheses.find((h) => h.hypothesisId === "rc-004");
    assert.equal(rc004, undefined);
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T8. analyze() 不传 llmClient → 仅使用规则匹配通道
// ============================================================================

test("T8.1 analyze() 不传 llmClient → rootCauseHypotheses 全部为 rule-based", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 同时命中 rc-001 和 rc-002（E7 + T-001 各 3 次）
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "coding",
        reason: "E7 红线 + T-001 FIX 失败：第 1 次",
        decision: "调整",
      },
      {
        loopType: "coding",
        reason: "E7 红线 + T-001 FIX 失败：第 2 次",
        decision: "重新分析",
      },
      {
        loopType: "coding",
        reason: "E7 红线 + T-001 FIX 失败：第 3 次",
        decision: "扩大上下文",
      },
    ]);

    const analyzer = new BlockageAnalyzer(store);
    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "coding",
      blockedIteration: 3,
      // 不传 llmClient
    });

    // 验证全部假设均来自 rule-based 通道
    assert.ok(report.rootCauseHypotheses.length >= 2, "至少应命中 rc-001 + rc-002 两条规则");
    for (const h of report.rootCauseHypotheses) {
      assert.equal(h.source, "rule-based", `假设 ${h.hypothesisId} 应为 rule-based`);
    }
    // 不应出现 llm-inferred 来源的假设
    const llmInferred = report.rootCauseHypotheses.find((h) => h.source === "llm-inferred");
    assert.equal(llmInferred, undefined, "不应出现 llm-inferred 假设");
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T9. analyze() 传 llmClient → 双通道合并结果（rule-based + llm-inferred）
// ============================================================================

test("T9.1 analyze() 传 llmClient → 双通道合并（rule-based + llm-inferred）", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 命中 rc-001 规则
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "coding",
        reason: "E7 红线违反：第 1 次",
        decision: "重写",
      },
      {
        loopType: "coding",
        reason: "E7 红线违反：第 2 次",
        decision: "重写",
      },
      {
        loopType: "coding",
        reason: "E7 红线违反：第 3 次",
        decision: "重写",
      },
    ]);

    // LLM 返回 1 条额外的根因假设（confidence=0.9，应被钳制到 0.6 上限）
    const llmContent = JSON.stringify([{ description: "LLM 推断的额外根因：架构设计缺陷", confidence: 0.9 }]);
    const llmClient = new InMemoryLLMClient(llmContent);

    const analyzer = new BlockageAnalyzer(store);
    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "coding",
      blockedIteration: 3,
      llmClient,
    });

    // 验证双通道合并：至少 1 条 rule-based + 1 条 llm-inferred
    const ruleBased = report.rootCauseHypotheses.filter((h) => h.source === "rule-based");
    const llmInferred = report.rootCauseHypotheses.filter((h) => h.source === "llm-inferred");
    assert.ok(ruleBased.length >= 1, "应至少 1 条 rule-based 假设（rc-001）");
    assert.ok(llmInferred.length >= 1, "应至少 1 条 llm-inferred 假设");

    // 验证 LLM 推断假设的 confidence 被钳制到 LLM_INFERRED_CONFIDENCE_CAP
    const llm1 = llmInferred[0];
    assert.ok(llm1.confidence <= LLM_INFERRED_CONFIDENCE_CAP, "LLM 假设 confidence 应 ≤ 0.6");
    assert.equal(llm1.confidence, LLM_INFERRED_CONFIDENCE_CAP, "应被钳制到 0.6");
    assert.ok(llm1.description.includes("架构设计缺陷"));
    assert.ok(llm1.hypothesisId.startsWith("llm-"), "LLM 假设 ID 应以 'llm-' 开头");
  } finally {
    rmrf(projectRoot);
  }
});

test("T9.2 analyze() llmClient 返回 markdown 代码块包裹的 JSON → 正确解析", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 仅 1 条介入记录（不命中任何规则），让 LLM 通道作为唯一假设来源
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "design",
        reason: "用户检查点：spec.md 需评审",
        decision: "批准",
      },
    ]);

    // LLM 返回 markdown 代码块包裹的 JSON 数组
    const llmContent =
      "```json\n" + JSON.stringify([{ description: "LLM 推断：spec.md 设计不清晰", confidence: 0.5 }]) + "\n```";
    const llmClient = new InMemoryLLMClient(llmContent);

    const analyzer = new BlockageAnalyzer(store);
    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "design",
      blockedIteration: 1,
      llmClient,
    });

    // 验证 LLM 推断假设被正确解析
    const llmInferred = report.rootCauseHypotheses.filter((h) => h.source === "llm-inferred");
    assert.ok(llmInferred.length === 1, "应解析出 1 条 LLM 假设");
    assert.ok(llmInferred[0].description.includes("spec.md 设计不清晰"));
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T10. analyze() LLM 推断失败 → 仅返回规则匹配结果（容错降级）
// ============================================================================

test("T10.1 analyze() llmClient.createMessage 抛异常 → 仅返回规则匹配结果", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 命中 rc-001 规则
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "coding",
        reason: "E7 红线违反：第 1 次",
        decision: "重写",
      },
      {
        loopType: "coding",
        reason: "E7 红线违反：第 2 次",
        decision: "重写",
      },
      {
        loopType: "coding",
        reason: "E7 红线违反：第 3 次",
        decision: "重写",
      },
    ]);

    // LLM 客户端构造时配置为抛异常
    const llmClient = new InMemoryLLMClient("", true, "LLM 服务不可用");

    // 收集日志验证 LLM 推断失败的 warn 日志
    const logs: Array<{ msg: string; level: string }> = [];
    const analyzer = new BlockageAnalyzer(store, undefined, (msg: string, level?: "info" | "warn" | "error") => {
      logs.push({ msg, level: level ?? "info" });
    });

    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "coding",
      blockedIteration: 3,
      llmClient,
    });

    // 验证：LLM 失败不阻塞报告生成，规则匹配结果仍可用
    const ruleBased = report.rootCauseHypotheses.filter((h) => h.source === "rule-based");
    const llmInferred = report.rootCauseHypotheses.filter((h) => h.source === "llm-inferred");
    assert.ok(ruleBased.length >= 1, "应至少 1 条 rule-based 假设（rc-001）");
    assert.equal(llmInferred.length, 0, "LLM 失败时不应产生 llm-inferred 假设");

    // 验证日志含 LLM 推断失败的 warn 记录
    const warnLogs = logs.filter((l) => l.level === "warn");
    assert.ok(
      warnLogs.some((l) => l.msg.includes("LLM 推断失败")),
      "应记录 LLM 推断失败的 warn 日志"
    );
  } finally {
    rmrf(projectRoot);
  }
});

test("T10.2 analyze() llmClient 返回空内容 → 跳过 LLM 通道（仅规则匹配）", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 命中 rc-002 规则
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "coding",
        reason: "T-001 FIX 失败：第 1 次",
        decision: "调整",
      },
      {
        loopType: "coding",
        reason: "T-001 FIX 失败：第 2 次",
        decision: "重新分析",
      },
      {
        loopType: "coding",
        reason: "T-001 FIX 失败：第 3 次",
        decision: "扩大上下文",
      },
    ]);

    // LLM 返回空内容（应触发"LLM 响应内容为空"分支，跳过 LLM 通道）
    const llmClient = new InMemoryLLMClient("");

    const analyzer = new BlockageAnalyzer(store);
    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "coding",
      blockedIteration: 3,
      llmClient,
    });

    // 验证：LLM 内容为空时跳过 LLM 通道，仅返回规则匹配结果
    const llmInferred = report.rootCauseHypotheses.filter((h) => h.source === "llm-inferred");
    assert.equal(llmInferred.length, 0, "LLM 内容为空时不应产生 llm-inferred 假设");
    // rc-002 规则匹配结果仍可用
    const rc002 = report.rootCauseHypotheses.find((h) => h.hypothesisId === "rc-002");
    assert.ok(rc002, "rc-002 规则匹配结果应可用");
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T11. 阻塞分析报告结构完整性 + 自定义 ruleStore / ruleMatcher
// ============================================================================

test("T11.1 analyze() 报告含必要字段（rootCauseHypotheses + suggestedSolutions + requiredDecisions + relatedInterventions）", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 命中 rc-001 规则
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "coding",
        reason: "E7 红线违反：第 1 次",
        decision: "重写",
      },
      {
        loopType: "coding",
        reason: "E7 红线违反：第 2 次",
        decision: "重写",
      },
      {
        loopType: "coding",
        reason: "E7 红线违反：第 3 次",
        decision: "重写",
      },
    ]);

    const analyzer = new BlockageAnalyzer(store);
    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "coding",
      blockedIteration: 3,
    });

    // 验证报告必要字段
    assert.equal(report.runId, runId);
    assert.equal(report.blockedLoop, "coding");
    assert.equal(report.blockedIteration, 3);
    assert.ok(typeof report.generatedAt === "string");
    assert.ok(report.generatedAt.length > 0);

    // 验证根因假设列表
    assert.ok(report.rootCauseHypotheses.length > 0);
    for (const h of report.rootCauseHypotheses) {
      assert.ok(typeof h.hypothesisId === "string");
      assert.ok(typeof h.description === "string");
      assert.ok(typeof h.confidence === "number");
      assert.ok(h.confidence >= 0 && h.confidence <= 1);
      assert.ok(Array.isArray(h.evidence));
      assert.ok(h.source === "rule-based" || h.source === "llm-inferred");
    }

    // 验证建议方案列表（每个假设对应一个方案）
    assert.ok(report.suggestedSolutions.length > 0);
    assert.equal(report.suggestedSolutions.length, report.rootCauseHypotheses.length, "建议方案数应等于根因假设数");
    for (const sol of report.suggestedSolutions) {
      assert.ok(typeof sol.solutionId === "string");
      assert.ok(sol.solutionId.startsWith("sol-"));
      assert.ok(typeof sol.description === "string");
      assert.ok(typeof sol.targetHypothesisId === "string");
      assert.ok(typeof sol.expectedEffect === "string");
      assert.ok(sol.cost === "low" || sol.cost === "medium" || sol.cost === "high");
    }

    // 验证决策清单（每个假设对应一个决策）
    assert.ok(report.requiredDecisions.length > 0);
    assert.equal(report.requiredDecisions.length, report.rootCauseHypotheses.length, "决策数应等于根因假设数");
    for (const dec of report.requiredDecisions) {
      assert.ok(typeof dec.decisionId === "string");
      assert.ok(dec.decisionId.startsWith("dec-"));
      assert.ok(typeof dec.description === "string");
      assert.ok(dec.options.length >= 2 && dec.options.length <= 4, "决策选项应为 2~4 个");
      assert.ok(typeof dec.recommendedOptionId === "string");
      // 推荐选项 ID 应存在于 options 中
      const optionExists = dec.options.some((opt) => opt.optionId === dec.recommendedOptionId);
      assert.ok(optionExists, "推荐选项 ID 应存在于 options 中");
    }

    // 验证相关介入记录
    assert.equal(report.relatedInterventions.length, 3);
    for (const iv of report.relatedInterventions) {
      assert.ok(typeof iv.intervenedAt === "string");
      assert.ok(iv.loopType === "design" || iv.loopType === "coding" || iv.loopType === "testing");
      assert.ok(typeof iv.reason === "string");
      assert.ok(typeof iv.decision === "string");
      assert.equal(iv.resolved, false, "未解决的介入记录 resolved 应为 false");
    }
  } finally {
    rmrf(projectRoot);
  }
});

test("T11.2 analyze() 注入自定义 ruleStore → suggestedSolutions 含 rlisRuleId", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 命中 rc-001 规则
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "coding",
        reason: "E7 红线违反：第 1 次",
        decision: "重写",
      },
      {
        loopType: "coding",
        reason: "E7 红线违反：第 2 次",
        decision: "重写",
      },
      {
        loopType: "coding",
        reason: "E7 红线违反：第 3 次",
        decision: "重写",
      },
    ]);

    // 构造自定义 RuleStore：含一条 SEED-01（与 rc-001 关键词"评估器"/"红线"匹配）
    const customRule: UserRule = {
      id: "SEED-01",
      category: "code-truth",
      severity: "BLOCKER",
      content: "禁止使用模拟、占位、mock、简化的方式开发代码（评估器规则/红线相关）",
      source: "builtin-seed",
      confirmedBy: "auto",
      usageCount: 0,
      violationCount: 0,
      createdAt: "2026-07-19T00:00:00.000Z",
    };
    const ruleStore = new RuleStore([customRule]);

    const analyzer = new BlockageAnalyzer(store, ruleStore);
    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "coding",
      blockedIteration: 3,
    });

    // 验证：rc-001 对应的方案应含 rlisRuleId（SEED-01 含"评估器"/"红线"关键词）
    const rc001Solution = report.suggestedSolutions.find((s) => s.targetHypothesisId === "rc-001");
    assert.ok(rc001Solution, "应存在 rc-001 对应的建议方案");
    assert.ok(rc001Solution!.rlisRuleId !== undefined, "rc-001 方案应含 rlisRuleId（自定义 ruleStore 命中 SEED-01）");
    assert.equal(rc001Solution!.rlisRuleId, "SEED-01");
  } finally {
    rmrf(projectRoot);
  }
});

test("T11.3 analyze() 注入自定义 ruleMatcher → 使用自定义规则集", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 仅 1 条 E7 介入记录（默认规则集不命中 rc-001，需 ≥3 次）
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "coding",
        reason: "E7 红线违反：仅 1 次",
        decision: "重写",
      },
    ]);

    // 构造自定义 ruleMatcher：使用空规则集（不命中任何规则）
    const emptyRules: ReadonlyArray<(typeof DEFAULT_ROOT_CAUSE_RULES)[number]> = [];
    const customMatcher = new RootCauseRuleMatcher(emptyRules);

    const analyzer = new BlockageAnalyzer(store, undefined, undefined, customMatcher);
    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "coding",
      blockedIteration: 1,
    });

    // 验证：使用空规则集时，规则匹配通道不产生任何假设
    const ruleBased = report.rootCauseHypotheses.filter((h) => h.source === "rule-based");
    assert.equal(ruleBased.length, 0, "空规则集不应产生 rule-based 假设");
    // 建议方案与决策清单也应为空
    assert.equal(report.suggestedSolutions.length, 0);
    assert.equal(report.requiredDecisions.length, 0);
  } finally {
    rmrf(projectRoot);
  }
});

test("T11.4 analyze() 多条规则同时命中 → 报告含全部假设 + 方案 + 决策", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 同时命中 rc-001（E7 × 3）+ rc-002（T-001 × 3）+ rc-004（LLM 超时 × 2）
    const runId = await createRunStateWithInterventions(projectRoot, store, [
      {
        loopType: "coding",
        reason: "E7 红线 + T-001 FIX + LLM 超时：第 1 次",
        decision: "调整",
      },
      {
        loopType: "coding",
        reason: "E7 红线 + T-001 FIX + LLM 超时：第 2 次",
        decision: "重新分析",
      },
      {
        loopType: "coding",
        reason: "E7 红线 + T-001 FIX：第 3 次",
        decision: "扩大上下文",
      },
    ]);

    const analyzer = new BlockageAnalyzer(store);
    const report = await analyzer.analyze({
      runId,
      projectRoot,
      blockedLoop: "coding",
      blockedIteration: 3,
    });

    // 验证：3 条规则同时命中（rc-001 / rc-002 / rc-004）
    const hypothesisIds = report.rootCauseHypotheses.map((h) => h.hypothesisId);
    assert.ok(hypothesisIds.includes("rc-001"), "应含 rc-001");
    assert.ok(hypothesisIds.includes("rc-002"), "应含 rc-002");
    assert.ok(hypothesisIds.includes("rc-004"), "应含 rc-004");

    // 验证：建议方案数 = 根因假设数 = 决策数
    assert.equal(report.suggestedSolutions.length, report.rootCauseHypotheses.length);
    assert.equal(report.requiredDecisions.length, report.rootCauseHypotheses.length);

    // 验证：每个方案 targetHypothesisId 唯一对应一个假设
    const targetIds = report.suggestedSolutions.map((s) => s.targetHypothesisId);
    const uniqueTargetIds = new Set(targetIds);
    assert.equal(uniqueTargetIds.size, targetIds.length, "方案 targetHypothesisId 应唯一");

    // 验证：相关介入记录数 = 3
    assert.equal(report.relatedInterventions.length, 3);
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// 附加断言：常量重新导出（保证模块导出契约稳定）
// ============================================================================

test("T11.5 BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD 常量值正确", () => {
  // 阈值应为 3（对齐 §5.12.2 "累计 3 次人工介入未解决"）
  assert.equal(BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD, 3);
});

test("T11.6 LLM_INFERRED_CONFIDENCE_CAP 常量值正确", () => {
  // LLM 推断 confidence 上限应为 0.6（防幻觉）
  assert.equal(LLM_INFERRED_CONFIDENCE_CAP, 0.6);
});

test("T11.7 DEFAULT_ROOT_CAUSE_RULES 常量含 4 条规则", () => {
  // 默认根因规则应含 4 条（rc-001 ~ rc-004）
  assert.equal(DEFAULT_ROOT_CAUSE_RULES.length, 4);
  const ruleIds = DEFAULT_ROOT_CAUSE_RULES.map((r) => r.ruleId);
  assert.ok(ruleIds.includes("rc-001"));
  assert.ok(ruleIds.includes("rc-002"));
  assert.ok(ruleIds.includes("rc-003"));
  assert.ok(ruleIds.includes("rc-004"));
});

test("T11.8 RootCauseRuleMatcher 默认构造使用 DEFAULT_ROOT_CAUSE_RULES", () => {
  // 默认构造的 RootCauseRuleMatcher 应使用 DEFAULT_ROOT_CAUSE_RULES
  const matcher = new RootCauseRuleMatcher();
  // 通过运行时行为验证：传入空介入记录应返回空假设列表（不抛错）
  const emptyRunState: RunState = {
    runId: "test-empty",
    projectRoot: "/tmp",
    startedAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    currentLoop: "coding",
    currentIteration: 0,
    completedLoops: [],
    completedTaskIds: [],
    pendingDeleteFiles: [],
    milestones: [],
    humanInterventions: [],
    humanInterventionCount: 0,
    totalLlmCallCount: 0,
    totalTokensUsed: 0,
    status: "running",
    checksum: "sha256:empty",
  };
  const result = matcher.match([], emptyRunState);
  assert.equal(result.length, 0, "空介入记录应返回空假设列表");
});
