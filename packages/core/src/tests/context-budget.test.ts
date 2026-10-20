/**
 * ContextBudgetProvider 共享上下文压缩接口 —— 单元测试 + 原引擎接入集成验证
 *
 * 设计文档：docs/dev/context-budget-provider.md（本测试对应 §4 测试计划 CB-01~CB-11
 * 及"集成验证"清单）。
 *
 * 覆盖三层：
 * 1. DeterministicContextBudgetProvider 四级压缩（CB-01~06、CB-10、CB-11）
 * 2. ContextEpochState 续跑状态机（CB-07、CB-08）
 * 3. settings.compactStrategy 解析（CB-09）与 session.ts deterministic 分支集成
 *    （无凭据压缩落盘 / activeTokens 重估 / user-assistant 原文保护 / converter 配对）
 *
 * 测试原则（用户规则）：不使用 mock 框架——所有桩均为函数注入式真实组件装配
 * （SessionManager 直接构造 + createLLMClient 缝合点注入）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import {
  DEFAULT_CONTEXT_BUDGET_CONFIG,
  DeterministicContextBudgetProvider,
  ContextEpochState,
} from "../context-budget";
import { resolveSettings, resolveSettingsSources } from "../settings";
import { estimateStreamTokens } from "../stream-aggregator";
import { SessionManager, type SessionMessage } from "../session";
import { createSessionTestEnv, createTempDir } from "./fixtures/session-test-env";

// ==========================================================================
// 测试 Helper
// ==========================================================================

/** 统一时间戳（消息构造用，避免动态时间干扰断言） */
const NOW = "2026-10-12T00:00:00.000Z";

/**
 * 构造最小化 SessionMessage（字段语义与 session.ts SessionMessage 类型对齐）
 *
 * @param id 消息 ID
 * @param role 角色
 * @param content 消息文本内容
 * @param messageParams 附属参数（tool_calls / tool_call_id 等）
 * @returns 完整 SessionMessage 对象
 */
function msg(
  id: string,
  role: SessionMessage["role"],
  content: string,
  messageParams: Record<string, unknown> | null = null
): SessionMessage {
  return {
    id,
    sessionId: "session-cb",
    role,
    content,
    contentParams: null,
    messageParams,
    compacted: false,
    visible: true,
    createTime: NOW,
    updateTime: NOW,
  };
}

/**
 * 构造一条带 tool_calls 的 assistant 消息（协议配对测试用）
 *
 * @param id 消息 ID
 * @param toolCallIds 关联的 tool_call id 列表
 * @returns assistant 消息（messageParams.tool_calls 与 tool 消息的 tool_call_id 对应）
 */
function assistantWithToolCalls(id: string, toolCallIds: string[]): SessionMessage {
  return msg(id, "assistant", "", {
    tool_calls: toolCallIds.map((callId) => ({
      id: callId,
      type: "function",
      function: { name: "bash", arguments: "{}" },
    })),
  });
}

/**
 * 构造一条 tool 结果消息（messageParams.tool_call_id 与 assistant.tool_calls 配对）
 *
 * @param id 消息 ID
 * @param toolCallId 对应的 tool_call id
 * @param content 工具输出文本
 * @returns tool 消息
 */
function toolMsg(id: string, toolCallId: string, content: string): SessionMessage {
  return msg(id, "tool", content, { tool_call_id: toolCallId });
}

// ==========================================================================
// CB-01~CB-06、CB-10、CB-11：DeterministicContextBudgetProvider 四级压缩
// ==========================================================================

/** CB-01 短历史直通：消息条数 ≤ minMessages 时原样返回（新数组、元素引用不变、内容不变） */
test("CB-01 短历史（≤minMessages）直通：新数组 + 元素引用不变", () => {
  const provider = new DeterministicContextBudgetProvider();
  const messages = [msg("m1", "system", "sys"), msg("m2", "user", "hi"), msg("m3", "assistant", "hello")];

  const result = provider.compactForRequest(messages);

  // 数组引用不同（不修改输入数组），元素引用相同（浅拷贝直通，无任何改写）
  assert.notEqual(result, messages, "输出应为新数组");
  assert.equal(result.length, 3, "条数不变");
  assert.equal(result[0], messages[0], "直通路径元素引用应保持不变（未被浅拷贝改写）");
  assert.deepEqual(
    result.map((m) => m.content),
    ["sys", "hi", "hello"],
    "内容应原样直通"
  );
});

/** CB-02 单条大 tool 截断：>toolOutputMaxChars 的 tool 内容截断至上限，保留头部 + 尾注 */
test("CB-02 单条大 tool 截断：截断至 4000 字符 + 精确尾注", () => {
  const provider = new DeterministicContextBudgetProvider();
  const bigContent = "x".repeat(6000);
  const messages = [
    msg("m1", "system", "sys"),
    msg("m2", "user", "task"),
    assistantWithToolCalls("m3", ["call-1"]),
    toolMsg("m4", "call-1", bigContent),
    msg("m5", "assistant", "done"),
  ];

  const result = provider.compactForRequest(messages);
  const tool = result.find((m) => m.id === "m4")!;

  // 截断语义与迁移源逐字一致：头部 4000 字符 + "\n…（已截断，原共 N 字符）"
  assert.equal(tool.content, `${bigContent.slice(0, 4000)}\n…（已截断，原共 6000 字符）`);
  // 其余消息不受第 0 级影响
  assert.equal(result.find((m) => m.id === "m2")!.content, "task");
  assert.equal(result.find((m) => m.id === "m5")!.content, "done");
});

/**
 * CB-03 总量收敛：大量大 tool 输出经第 0 级截断 + 第 2 级丢弃后总量收敛至
 * toolResultsBudgetChars 内；保护窗（最近 4 条 tool）与锚点（首条非 system +
 * 末条消息）不被整条丢弃（仍可被第 0 级截断——"防丢弃不防截断"现行语义）。
 */
test("CB-03 总量收敛至预算内：保护窗 4 条与锚点防整条丢弃", () => {
  const provider = new DeterministicContextBudgetProvider();
  const TOOL_COUNT = 30;
  // 每条 tool 唯一内容（防第 1 级去重干扰）6015 字符，截断后 ≈4018 字符
  const toolContent = (i: number): string => `tool-output-${String(i).padStart(2, "0")}-` + "x".repeat(6000);

  const messages: SessionMessage[] = [msg("sys", "system", "system prompt"), msg("task", "user", "任务卡简报")];
  for (let i = 0; i < TOOL_COUNT; i += 1) {
    messages.push(assistantWithToolCalls(`asst-${i}`, [`call-${i}`]));
    messages.push(toolMsg(`tool-${i}`, `call-${i}`, toolContent(i)));
  }
  messages.push(msg("final", "assistant", "任务完成"));

  const result = provider.compactForRequest(messages);

  assert.equal(result.length, messages.length, "条数与协议配对不变（占位替换，不删除消息）");
  const totalChars = result.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  assert.ok(
    totalChars <= DEFAULT_CONTEXT_BUDGET_CONFIG.toolResultsBudgetChars,
    `总量应收敛至 ${DEFAULT_CONTEXT_BUDGET_CONFIG.toolResultsBudgetChars} 内，实际 ${totalChars}`
  );

  // 锚点：首条非 system（任务卡）与末条消息内容不变（不被丢弃、本场景也未触发截断）
  assert.equal(result.find((m) => m.id === "task")!.content, "任务卡简报");
  assert.equal(result.find((m) => m.id === "final")!.content, "任务完成");

  // 保护窗：最近 4 条 tool（tool-26..tool-29）仍是截断后的完整内容（含"已截断"尾注），
  // 不是丢弃占位
  for (const id of ["tool-26", "tool-27", "tool-28", "tool-29"]) {
    const content = result.find((m) => m.id === id)!.content!;
    assert.ok(content.includes("已截断"), `${id} 在保护窗内应保留截断内容而非丢弃占位`);
    assert.ok(!content.startsWith("（上下文压缩：该工具结果"), `${id} 不应被整条丢弃`);
  }

  // 最老的若干条 tool 已被替换为丢弃占位（第 2 级生效）
  const droppedCount = result.filter((m) => m.content!.startsWith("（上下文压缩：该工具结果")).length;
  assert.ok(droppedCount >= 5, `最老 tool 应被整条丢弃以收敛总量，实际丢弃 ${droppedCount} 条`);
});

/** CB-04 配置参数化：自定义阈值生效（证明四级阈值非硬编码，来自构造配置） */
test("CB-04 配置参数化：自定义 toolOutputMaxChars 生效（非硬编码）", () => {
  const bigTool = "y".repeat(100);
  const messages = [
    msg("m1", "system", "sys"),
    msg("m2", "user", "task"),
    assistantWithToolCalls("m3", ["call-1"]),
    toolMsg("m4", "call-1", bigTool),
    msg("m5", "assistant", "done"),
  ];

  // 默认配置：100 字符 < 4000，不截断
  const defaultResult = new DeterministicContextBudgetProvider().compactForRequest(messages);
  assert.equal(defaultResult.find((m) => m.id === "m4")!.content, bigTool, "默认配置下 100 字符不应截断");

  // 自定义配置：上限 50 → 截断至 50 字符 + 尾注
  const customResult = new DeterministicContextBudgetProvider({ toolOutputMaxChars: 50 }).compactForRequest(messages);
  assert.equal(
    customResult.find((m) => m.id === "m4")!.content,
    `${bigTool.slice(0, 50)}\n…（已截断，原共 100 字符）`,
    "自定义 toolOutputMaxChars=50 应精确生效"
  );
});

/** CB-05 输入只读：入参数组与消息对象均不被修改（冻结对象下运行 = 篡改即抛错） */
test("CB-05 输入只读：冻结输入下运行不抛错且内容不变", () => {
  const provider = new DeterministicContextBudgetProvider();
  const messages = [
    msg("sys", "system", "system prompt"),
    msg("task", "user", "任务卡"),
    assistantWithToolCalls("asst-1", ["call-1"]),
    toolMsg("tool-1", "call-1", "z".repeat(6000)),
    msg("final", "assistant", "done"),
  ];
  // 深冻结：ESM 严格模式下任何写入尝试都会抛 TypeError —— 直接验证"不修改输入"契约
  for (const message of messages) {
    if (message.messageParams) {
      Object.freeze(message.messageParams);
    }
    Object.freeze(message);
  }
  Object.freeze(messages);
  const snapshot = JSON.stringify(messages);

  const result = provider.compactForRequest(messages);

  assert.equal(JSON.stringify(messages), snapshot, "输入数组与消息对象应逐字节不变");
  assert.equal(
    result.find((m) => m.id === "tool-1")!.content!.length,
    4000 + "\n…（已截断，原共 6000 字符）".length,
    "输出应正常截断（证明压缩逻辑真实执行而非空转）"
  );
});

/**
 * CB-06 去重：相同的长 tool 内容保留最新一条，最旧的替换为引用占位；
 * 短于 dedupeMinChars 的重复内容不去重（阈值语义）。
 */
test("CB-06 去重：相同长 tool 内容旧的变引用占位、短重复不去重", () => {
  const provider = new DeterministicContextBudgetProvider({ protectedRecentTools: 1 });
  const longDup = "d".repeat(300);
  const shortDup = "s".repeat(100);
  const messages = [
    msg("sys", "system", "sys"),
    msg("task", "user", "task"),
    assistantWithToolCalls("asst-1", ["call-1"]),
    toolMsg("tool-old", "call-1", longDup),
    assistantWithToolCalls("asst-2", ["call-2"]),
    toolMsg("tool-mid", "call-2", longDup), // 与 tool-old 内容完全相同（保留最新）
    assistantWithToolCalls("asst-3", ["call-3"]),
    toolMsg("tool-short-old", "call-3", shortDup),
    assistantWithToolCalls("asst-4", ["call-4"]),
    toolMsg("tool-short-new", "call-4", shortDup), // 短重复（< dedupeMinChars=200，不去重）
    msg("final", "assistant", "done"),
  ];

  const result = provider.compactForRequest(messages);
  const byId = (id: string): string => result.find((m) => m.id === id)!.content!;

  // 长重复：最旧的变引用占位（含"重复"标记），最新的保留原文
  assert.ok(byId("tool-old").includes("（与较近一次相同结果重复）"), "最旧的长重复 tool 应变引用占位");
  assert.equal(byId("tool-mid"), longDup, "最新的长重复 tool 应保留原文");
  // 短重复：两条都不去重（dedupeMinChars 阈值语义）
  assert.equal(byId("tool-short-old"), shortDup, "短于 dedupeMinChars 的重复不应去重");
  assert.equal(byId("tool-short-new"), shortDup, "短于 dedupeMinChars 的重复不应去重");
});

/**
 * CB-10 第 3 级兜底保真：总量 > requestTotalCharsCeiling（800K）时兜底裁剪，
 * 输出与按迁移语义逐条手工推导的期望完全一致（逐字节级）。
 * 场景构造：全部膨胀在 assistant 消息（第 2 级只丢 tool，无法收敛）→ 必须走第 3 级。
 */
test("CB-10 第 3 级兜底裁剪：>800K 场景输出与迁移语义逐字节一致", () => {
  const provider = new DeterministicContextBudgetProvider();
  const BULK = "a".repeat(90_000); // 10 条 × 90K = 900K > 800K 硬顶
  const messages: SessionMessage[] = [msg("sys", "system", "s"), msg("task", "user", "u")];
  for (let i = 0; i < 10; i += 1) {
    messages.push(msg(`asst-${i}`, "assistant", BULK));
  }

  const result = provider.compactForRequest(messages);

  // 手工推导期望（与迁移语义逐条对齐）：
  // - 首段总量 900,015 > 800,000 → 第 3 级从最老可丢弃消息开始整条占位；
  // - 锚点保护：sys（system 不可丢）、task（首条非 system）、末条 asst-9；
  // - 丢 asst-0（90K→占位 41 字符，总量 810,056 仍 > 800K）→ 继续丢 asst-1
  //   （总量 720,097 ≤ 800K）→ 停止。asst-2..asst-9 原样保留。
  const expectedContents = [
    "s",
    "u",
    "（上下文压缩：该 assistant 消息共 90000 字符已省略）",
    "（上下文压缩：该 assistant 消息共 90000 字符已省略）",
    ...Array(8).fill(BULK), // asst-2..asst-9（含末条锚点）原样保留
  ];
  assert.deepEqual(
    result.map((m) => m.content),
    expectedContents,
    "第 3 级裁剪输出应与迁移语义逐字节一致"
  );
  const totalChars = result.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  assert.ok(totalChars <= DEFAULT_CONTEXT_BUDGET_CONFIG.requestTotalCharsCeiling, "总量应 ≤ 800K 硬顶");
});

/**
 * CB-11 连续压缩收敛：对已压缩结果再次压缩达到不动点（第 2 次应用后逐字节稳定），
 * 且已截断 tool 的内容前缀永不进一步丢失（防落盘后每轮重复压缩导致内容持续缩水）。
 *
 * 语义说明：第 0 级截断的尾注本身会使内容长度略超上限（4000+尾注≈4019>4000），
 * 再次压缩只更新尾注中的"原共 N 字符"元数据（N=上次内容长度），头部 4000 字符
 * 与迁移前 p5 行为完全一致——第二次压缩即达不动点，无信息级联丢失。
 */
test("CB-11 连续压缩收敛：第 2 次应用后达不动点、头部前缀永不丢失", () => {
  const provider = new DeterministicContextBudgetProvider();
  const toolA = "a".repeat(6000);
  const toolB = "b".repeat(7000);
  const messages = [
    msg("sys", "system", "sys"),
    msg("task", "user", "task"),
    assistantWithToolCalls("asst-1", ["call-1"]),
    toolMsg("tool-a", "call-1", toolA),
    assistantWithToolCalls("asst-2", ["call-2"]),
    toolMsg("tool-b", "call-2", toolB),
    msg("final", "assistant", "done"),
  ];

  const run1 = provider.compactForRequest(messages);
  const run2 = provider.compactForRequest(run1);
  const run3 = provider.compactForRequest(run2);

  // 头部前缀在每轮压缩后均完整保留（无信息级联丢失）
  for (const [id, original] of [
    ["tool-a", toolA],
    ["tool-b", toolB],
  ] as const) {
    for (const run of [run1, run2, run3]) {
      const content = run.find((m) => m.id === id)!.content!;
      assert.ok(content.startsWith(original.slice(0, 4000)), `${id} 头部 4000 字符在各轮压缩后应完整保留`);
    }
  }
  // 第 2 次应用后达不动点（run3 与 run2 逐字节一致 → 落盘后重复压缩稳定）
  assert.deepEqual(run3, run2, "第 2 次压缩后应达到不动点（输出逐字节稳定）");
});

// ==========================================================================
// CB-07、CB-08：ContextEpochState 续跑状态机
// ==========================================================================

/**
 * CB-07 EpochState 折算：段额度 = max(名义×0.5, 实测均耗×4)；显式耗尽门禁后 rollover 返回 null。
 *
 * 2026-10-20 段判限口径更新：isSegmentExceeded 按"段增量 > 段额度 ×
 * segmentThreshold(缺省 0.8)"判限（80% 提前压缩），本用例断言同步更新。
 * 本用例显式传 maxRollovers=1（耗尽门禁 API 行为保留——显式配置仍生效）；
 * 缺省配置（Infinity，永不耗尽）的行为由 CB-12 覆盖。
 */
test("CB-07 EpochState：折算公式两条分支 + 显式耗尽门禁（显式 maxRollovers=1）", () => {
  const state = new ContextEpochState(1000, { maxRollovers: 1 });
  assert.equal(state.epoch, 0, "初始 epoch=0");
  assert.equal(state.nominalBudget, 1000, "名义预算只读暴露");

  // 首段判限（80% 口径）：段增量 > 800 即触发压缩
  assert.equal(state.isSegmentExceeded(800), false, "段增量恰好等于 80% 线不算超（恰好等于不算超）");
  assert.equal(state.isSegmentExceeded(801), true, "段增量超过 80% 线即触发压缩");

  // 分支一：实测均耗×4 主导 —— rollover(2400, 5)：均耗=2400/(5-1)=600，600×4=2400 > 500
  assert.equal(state.rollover(2400, 5), 2400, "段额度应取 max(名义×0.5=500, 均耗×4=2400)=2400");
  assert.equal(state.epoch, 1, "rollover 后 epoch=1");
  assert.equal(state.baseline, 2400, "新段基线 = 折叠时累计 token");
  assert.equal(state.budget, 2400, "新段额度只读暴露");

  // 续跑段按"段增量"判限：起步（累计=基线）不被误杀（软预算修复核心语义）
  assert.equal(state.isSegmentExceeded(2400), false, "续跑段起步（增量=0）不应被误判超限");
  assert.equal(state.isSegmentExceeded(2400 + Math.floor(2400 * 0.8)), false, "段增量 = 80% 线，不算超限");
  assert.equal(state.isSegmentExceeded(2400 + Math.floor(2400 * 0.8) + 1), true, "段增量超过 80% 线即触发压缩");

  // 耗尽门禁（显式 maxRollovers=1 仍生效）：已续跑 1 次 → 再 rollover 返回 null
  assert.equal(state.isRolloverExhausted(), true, "达到 maxRollovers 后应判耗尽");
  assert.equal(state.rollover(5000, 8), null, "续跑耗尽后 rollover 应返回 null");

  // 分支二：名义×0.5 主导 —— 均耗很小时取半额下限
  const state2 = new ContextEpochState(1000, { maxRollovers: 1 });
  assert.equal(state2.rollover(200, 10), 500, "段额度应取 max(名义×0.5=500, 均耗×4≈89)=500");
});

/**
 * CB-12 缺省配置永不耗尽（2026-10-20 需求变更：移除 Token 预算硬终止）：
 * 缺省 maxRollovers=Infinity（原 3）——续跑折叠不再设次数上限，Token 消耗
 * 不再终止运行；压缩可无限续跑，防失控交给模型循环/空循环熔断与全局轮数
 * 上限（调用方已无"续跑耗尽 → failure"分支）。缺省 segmentThreshold=0.8
 * 同步断言（80% 提前压缩）。
 */
test("CB-12 缺省配置：maxRollovers=Infinity 永不耗尽 + segmentThreshold=0.8", () => {
  const state = new ContextEpochState(1000);
  // 缺省值显式断言（回归基准：2026-10-20 前 maxRollovers=3）
  assert.equal(state.config.maxRollovers, Infinity, "缺省 maxRollovers 应为 Infinity（Token 预算终止已移除）");
  assert.equal(state.config.segmentThreshold, 0.8, "缺省压缩阈值应为 0.8（80% 提前压缩）");

  // 连续多次折叠均不判耗尽（原 3 次后即耗尽）
  for (let i = 1; i <= 5; i++) {
    assert.equal(state.isRolloverExhausted(), false, `第 ${i} 次折叠前不应判耗尽（压缩可无限续跑）`);
    assert.ok((state.rollover(1000 + i * 100, i + 1) ?? 0) >= 500, "每次折叠都应返回有效段额度（不低于名义×0.5 下限）");
  }
  assert.equal(state.isRolloverExhausted(), false, "5 次折叠后仍不判耗尽");
  assert.ok(state.rollover(2000, 20) !== null, "折叠永不返回 null（Infinity 上界）");

  // 80% 压缩口径：首段额度 1000，段增量 800 触发、799 不触发
  const fresh = new ContextEpochState(1000);
  assert.equal(fresh.isSegmentExceeded(799), false, "段增量 799 < 80% 线不触发压缩");
  assert.equal(fresh.isSegmentExceeded(801), true, "段增量 801 > 80% 线触发压缩");
});

/** CB-08 EpochState 绝对上限：累计 > 名义×2.5 判超（防失控硬上界） */
test("CB-08 EpochState：绝对上限 = 名义 × totalMultiplier", () => {
  const state = new ContextEpochState(1000);
  assert.equal(state.totalCeiling, 2500, "绝对上限 = ceil(1000×2.5)");
  assert.equal(state.isTotalCeilingExceeded(2500), false, "恰好等于上限不算超");
  assert.equal(state.isTotalCeilingExceeded(2501), true, "超出上限即判超");
  // 自定义倍数生效
  const custom = new ContextEpochState(1000, { totalMultiplier: 2 });
  assert.equal(custom.totalCeiling, 2000, "自定义 totalMultiplier 应生效");
});

// ==========================================================================
// CB-09：settings.compactStrategy 解析
// ==========================================================================

/** settings 解析所需模型默认值（与 settings-permission-mode.test.ts 保持一致） */
const SETTINGS_DEFAULTS = { model: "default-model", baseURL: "https://default.example.com" } as const;

/** CB-09 缺省 llm-summary / 显式 deterministic 可读 / 非法值回落默认 / 项目级优先 */
test("CB-09 compactStrategy 解析：缺省默认、显式生效、非法回落、项目优先", () => {
  // 缺省 → llm-summary（存量行为零回归）
  assert.equal(resolveSettings(undefined, SETTINGS_DEFAULTS, {}).compactStrategy, "llm-summary");
  // 显式 deterministic → 可读
  assert.equal(
    resolveSettings({ compactStrategy: "deterministic" }, SETTINGS_DEFAULTS, {}).compactStrategy,
    "deterministic"
  );
  // 显式 llm-summary → 原样保留
  assert.equal(
    resolveSettings({ compactStrategy: "llm-summary" }, SETTINGS_DEFAULTS, {}).compactStrategy,
    "llm-summary"
  );
  // 非法值 → 回落 llm-summary（fail-open，配置错误不阻断会话）
  assert.equal(
    resolveSettings({ compactStrategy: "evil" as never }, SETTINGS_DEFAULTS, {}).compactStrategy,
    "llm-summary",
    "非法字符串应回落默认"
  );
  assert.equal(
    resolveSettings({ compactStrategy: 123 as never }, SETTINGS_DEFAULTS, {}).compactStrategy,
    "llm-summary",
    "非法数字应回落默认"
  );
  // 合并优先级：项目级覆盖用户级（与 autoCompactWindow 等既有配置一致）
  assert.equal(
    resolveSettingsSources(
      { compactStrategy: "deterministic" },
      { compactStrategy: "llm-summary" },
      SETTINGS_DEFAULTS,
      {}
    ).compactStrategy,
    "llm-summary",
    "项目级应覆盖用户级"
  );
  assert.equal(
    resolveSettingsSources(
      { compactStrategy: "llm-summary" },
      { compactStrategy: "deterministic" },
      SETTINGS_DEFAULTS,
      {}
    ).compactStrategy,
    "deterministic",
    "项目级显式配置应生效"
  );
});

// ==========================================================================
// 集成验证：session.ts compactSession deterministic 分支（设计文档 §4 集成清单）
// ==========================================================================

/** 集成测试环境（fetch/HOME/console.warn 全局隔离，afterEach 清理临时目录） */
const env = createSessionTestEnv();

/**
 * 读取 compact.log 全部事件（JSONL 逐行解析，解析失败直接抛错 = 断言行合法）
 *
 * @param home 测试家目录（env.setHomeDir 注入的临时目录）
 * @returns 解析后的事件数组；文件不存在时为空数组
 */
function readCompactLog(home: string): Array<Record<string, any>> {
  const logPath = path.join(home, ".deepcodex", "logs", "compact.log");
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

/**
 * 构造 deterministic 策略的 SessionManager（无凭据——createLLMClient 恒返回 null）
 *
 * 关键缝合点：
 * - createLLMClient 记录是否被调用（验证规则 1：deterministic 分支前置于凭据判空，
 *   压缩全程不触碰 LLM client）；
 * - getResolvedSettings 注入 compactStrategy: "deterministic"（规则分支开关）。
 *
 * @param workspace 项目根目录
 * @param home 引擎数据家目录
 * @returns SessionManager 实例 + LLM client 调用记录
 */
function createDeterministicManager(
  workspace: string,
  home: string
): {
  manager: SessionManager;
  llmClientCallCount: { value: number };
} {
  env.setHomeDir(home);
  // 静默 fetch：防 createSession 过程中任何外呼（测试无网络依赖）
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const llmClientCallCount = { value: 0 };
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    // 缝合点：deterministic 分支不应调用 createLLMClient（无凭据也能压缩）
    createLLMClient: () => {
      llmClientCallCount.value += 1;
      return null;
    },
    getResolvedSettings: () => ({
      model: "test-model",
      autoCompactWindow: 131_072,
      compactStrategy: "deterministic" as const,
    }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
  // 测试不走完整主对话循环，绕过 activateSession 的凭据/网络前置
  (manager as any).activateSession = async () => {};
  return { manager, llmClientCallCount };
}

test("集成-DET-01 无凭据 deterministic 压缩落盘：分支前置 + 打点 + activeTokens 重估 + 原文保护", async () => {
  const workspace = createTempDir(env, "cb-det-01-workspace-");
  const home = createTempDir(env, "cb-det-01-home-");
  const { manager, llmClientCallCount } = createDeterministicManager(workspace, home);

  const sessionId = await manager.createSession({ text: "初始任务" });
  // createSession 的技能匹配路径（session.ts L3200）也会调用 createLLMClient，
  // 此处重置计数器，只观察 compactSession 期间的调用（验证规则 1 分支前置）
  llmClientCallCount.value = 0;
  // createSession 自带初始消息（system/user），记录基线条数供"条数不变"断言
  const baseMessageCount = manager.listSessionMessages(sessionId).length;
  const append = (message: SessionMessage): void => (manager as any).appendSessionMessage(sessionId, message);

  // 会话构造：user(锚点) + assistant(tool_calls) + 3×大 tool(20000 字符) + assistant(末条锚点)
  // 总量 60K+ < toolResultsBudgetChars(100K) → 仅触发第 0 级截断，断言口径最干净
  const bigToolContent = (i: number): string => `集成-tool-${i}-` + "x".repeat(20_000);
  append(msg("user-anchor", "user", "请处理这批数据"));
  append(assistantWithToolCalls("asst-call-1", ["call-1", "call-2", "call-3"]));
  append(toolMsg("tool-1", "call-1", bigToolContent(1)));
  append(toolMsg("tool-2", "call-2", bigToolContent(2)));
  append(toolMsg("tool-3", "call-3", bigToolContent(3)));
  append(msg("asst-final", "assistant", "全部处理完成"));

  // 记录压缩前 activeTokens（手动抬高，验证规则 3 重估后回落）
  const PRESET_TOKENS = 999_999;
  (manager as any).updateSessionEntry(sessionId, (entry: any) => ({ ...entry, activeTokens: PRESET_TOKENS }));

  await manager.compactSession(sessionId);

  // —— 规则 1：全程未触碰 LLM client（分支前置于凭据判空，无凭据也能压缩）——
  assert.equal(llmClientCallCount.value, 0, "deterministic 分支不应调用 createLLMClient");

  // —— 规则 2：user/assistant 原文逐字节不变，仅 tool 被截断 ——
  const messages = manager.listSessionMessages(sessionId);
  assert.equal(messages.find((m) => m.id === "user-anchor")!.content, "请处理这批数据", "user 原文应不变");
  assert.equal(messages.find((m) => m.id === "asst-final")!.content, "全部处理完成", "末条 assistant 原文应不变");
  // tool_call 协议字段（messageParams）原样保留
  const asstCall = messages.find((m) => m.id === "asst-call-1")!;
  assert.deepEqual(
    (asstCall.messageParams as any).tool_calls.map((c: any) => c.id),
    ["call-1", "call-2", "call-3"],
    "assistant tool_calls 应原样保留"
  );
  for (let i = 1; i <= 3; i += 1) {
    const tool = messages.find((m) => m.id === `tool-${i}`)!;
    assert.equal(
      (tool.messageParams as any) && (tool.messageParams as any).tool_call_id,
      `call-${i}`,
      "tool_call_id 应保留"
    );
    const original = bigToolContent(i);
    assert.equal(
      tool.content,
      `${original.slice(0, 4000)}\n…（已截断，原共 ${original.length} 字符）`,
      `tool-${i} 应按第 0 级精确截断`
    );
  }
  // 落盘条数与消息 id / compacted 标记保持原值（saveSessionMessages 全量覆盖写语义）
  assert.equal(messages.length, baseMessageCount + 6, "落盘条数应不变（基线 + 追加 6 条）");
  assert.ok(
    messages.every((m) => m.compacted === false),
    "deterministic 压缩不应改动 compacted 标记"
  );

  // —— 规则 3：activeTokens 按落盘后消息重估（防阈值每轮重复命中）——
  const savedMessages = manager.listSessionMessages(sessionId);
  const expectedTokens = Math.round(
    savedMessages.reduce((sum, m) => sum + (typeof m.content === "string" ? estimateStreamTokens(m.content) : 0), 0)
  );
  const entry = manager.getSession(sessionId)!;
  assert.equal(entry.activeTokens, expectedTokens, "activeTokens 应按落盘后消息字符重估");
  assert.ok(entry.activeTokens < PRESET_TOKENS, "重估后 activeTokens 应显著回落（不再每轮重复触发）");

  // —— 规则 4：打点单源 ——
  const logLines = readCompactLog(home);
  const start = logLines.find((l) => l.type === "compact_start");
  const done = logLines.find((l) => l.type === "compact_done");
  assert.ok(start && done, "应记录 compact_start 与 compact_done");
  assert.equal(start.strategy, "deterministic", "compact_start 应携带 strategy");
  assert.equal(done.strategy, "deterministic", "compact_done 应携带 strategy");
  assert.equal(typeof done.charsBefore, "number", "compact_done 应记录 charsBefore");
  assert.equal(typeof done.charsAfter, "number", "compact_done 应记录 charsAfter");
  assert.ok(done.charsBefore > done.charsAfter, `压缩应有收益（${done.charsBefore} → ${done.charsAfter}）`);
  assert.equal(done.messageCount, baseMessageCount + 6, "compact_done.messageCount 应为落盘消息总数");
  // 无凭据场景不应出现 llm-summary 特有事件
  assert.equal(
    logLines.some((l) => l.type === "summary_start"),
    false,
    "deterministic 不应发起摘要请求打点"
  );
  assert.equal(
    logLines.some((l) => l.reason === "no-llm-client"),
    false,
    "deterministic 分支不应走 no-llm-client 跳过"
  );

  // —— converter 协议配对：落盘消息经 openai converter 转换后 assistant/tool 配对合法 ——
  const converted = manager.buildOpenAIMessages(manager.listSessionMessages(sessionId), false, "test-model") as Array<{
    role: string;
    tool_calls?: Array<{ id: string }>;
    tool_call_id?: string;
  }>;
  const assistantToolCallIds = new Set(
    converted.filter((m) => m.role === "assistant").flatMap((m) => (m.tool_calls ?? []).map((c) => c.id))
  );
  const toolMessages = converted.filter((m) => m.role === "tool");
  assert.equal(toolMessages.length, 3, "转换后应保留 3 条 tool 消息");
  for (const tool of toolMessages) {
    assert.ok(tool.tool_call_id, "每条 tool 消息应携带 tool_call_id");
    assert.ok(
      assistantToolCallIds.has(tool.tool_call_id!),
      `tool_call_id=${tool.tool_call_id} 应能在 assistant.tool_calls 中找到配对`
    );
  }
});

test("集成-DET-02 压缩幂等：重复 compactSession 头部前缀不缩水、user/assistant 仍不变", async () => {
  const workspace = createTempDir(env, "cb-det-02-workspace-");
  const home = createTempDir(env, "cb-det-02-home-");
  const { manager } = createDeterministicManager(workspace, home);

  const sessionId = await manager.createSession({ text: "幂等验证任务" });
  const append = (message: SessionMessage): void => (manager as any).appendSessionMessage(sessionId, message);
  const bigTool = "w".repeat(20_000);
  append(assistantWithToolCalls("asst-1", ["call-1"]));
  append(toolMsg("tool-1", "call-1", bigTool));
  append(msg("asst-final", "assistant", "完成"));

  await manager.compactSession(sessionId);
  const afterFirst = manager.listSessionMessages(sessionId);
  const toolAfterFirst = afterFirst.find((m) => m.id === "tool-1")!.content!;

  // 第二次压缩（模拟阈值再次命中后的重复触发）
  await manager.compactSession(sessionId);
  const afterSecond = manager.listSessionMessages(sessionId);
  const toolAfterSecond = afterSecond.find((m) => m.id === "tool-1")!.content!;

  // 已截断 tool 的头部 4000 字符永不进一步丢失（重复压缩只更新尾注元数据）
  assert.ok(toolAfterSecond.startsWith(bigTool.slice(0, 4000)), "第二次压缩后头部 4000 字符应完整保留");
  assert.ok(toolAfterSecond.includes("已截断"), "第二次压缩后仍应保持截断标记");
  // user/assistant 在重复压缩后依旧逐字节不变
  assert.equal(afterSecond.find((m) => m.id === "asst-final")!.content, "完成", "assistant 原文在重复压缩后应不变");
  // 条数与协议配对稳定
  assert.equal(afterSecond.length, afterFirst.length, "重复压缩不应改变消息条数");
  // activeTokens 与落盘内容重估口径一致（第二次压缩后仍为精确重估值，无漂移）
  const expectedTokens = Math.round(
    afterSecond.reduce((sum, m) => sum + (typeof m.content === "string" ? estimateStreamTokens(m.content) : 0), 0)
  );
  assert.equal(manager.getSession(sessionId)!.activeTokens, expectedTokens, "重复压缩后 activeTokens 仍与落盘内容一致");
});
