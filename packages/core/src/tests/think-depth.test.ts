/**
 * 按回合思考深度调度：规则、护栏、滞回、降级与效率指标
 *
 * 全部为纯函数断言，不触网、不读模型。这里同时充当「场景化调度规则」的
 * 可执行规格：改动词表/阈值导致场景漂移时，golden 语料会先亮红灯。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { thinkingControlForModel } from "../common/openai-thinking";
import { detectSoulModeFromPrompt, renderModeSection, DEFAULT_COMPANION_CONFIG } from "../super-agent/soul/modes";
import {
  CLEAR_LIGHT_CONFIDENCE,
  DOWNGRADE_CONFIRM_TURNS,
  EFFORT_LADDER,
  analyzeTurn,
  initialThinkingDepthState,
  resolveThinkingDepth,
  summarizeThinkingDepthEfficiency,
  type ThinkingControl,
  type ThinkingDepthBaseline,
  type ThinkingDepthInput,
  type ThinkingDepthPlan,
  type ThinkingDepthState,
  type TurnScene,
} from "../think-depth";

const BASE: ThinkingDepthBaseline = {
  thinkingEnabled: true,
  reasoningEffort: "max",
  thinkingBudgetTokens: 4096,
};

function input(partial: Partial<ThinkingDepthInput> = {}): ThinkingDepthInput {
  return {
    text: "",
    mode: "work",
    contextChars: 3_000,
    contextMessages: 8,
    latencySensitive: false,
    iteration: 0,
    hasAttachments: false,
    isStructuredTurn: false,
    control: "effort",
    enabled: true,
    ...partial,
  };
}

function decide(
  text: string,
  partial: Partial<ThinkingDepthInput> = {},
  state: ThinkingDepthState = initialThinkingDepthState(),
  baseline: ThinkingDepthBaseline = BASE
): { plan: ThinkingDepthPlan; state: ThinkingDepthState } {
  return resolveThinkingDepth(input({ text, ...partial }), baseline, state);
}

// ---------------------------------------------------------------------------
// 1. 场景化调度规则（golden 语料）
// ---------------------------------------------------------------------------

const GOLDEN: ReadonlyArray<{
  name: string;
  text: string;
  mode: "work" | "companion";
  scene: TurnScene;
  level: ThinkingDepthPlan["level"];
}> = [
  { name: "极短应答", text: "嗯", mode: "work", scene: "small_talk", level: "off" },
  { name: "寒暄", text: "今天天气不错", mode: "work", scene: "small_talk", level: "off" },
  { name: "感谢", text: "谢谢啦", mode: "work", scene: "small_talk", level: "off" },
  { name: "情感倾诉", text: "今天有点累", mode: "work", scene: "emotional", level: "light" },
  {
    name: "陪伴闲聊",
    text: "连着改三版还被推翻，真的顶不住了",
    mode: "companion",
    scene: "companion_chat",
    level: "light",
  },
  { name: "任务回合", text: "帮我把 session.ts 里这个报错修一下", mode: "work", scene: "task", level: "full" },
  {
    name: "陪伴模式内的任务回合",
    text: "帮我把 session.ts 里这个报错修一下",
    mode: "companion",
    scene: "companion_task",
    level: "balanced",
  },
  {
    name: "复杂任务",
    text: "帮我看一下 packages/core/src/session.ts 里 activateSession 的 thinking 参数传递，为什么会被覆盖？顺便给个回归测试",
    mode: "work",
    scene: "complex_task",
    level: "full",
  },
  {
    name: "陪伴模式内的复杂任务",
    text: "帮我看一下 packages/core/src/session.ts 里 activateSession 的 thinking 参数传递，为什么会被覆盖？顺便给个回归测试",
    mode: "companion",
    scene: "complex_task",
    level: "full",
  },
  { name: "危机", text: "我不想活了", mode: "companion", scene: "crisis", level: "balanced" },
];

test("T1 golden 语料：场景与档位逐条符合规格", () => {
  for (const item of GOLDEN) {
    const { plan } = decide(item.text, { mode: item.mode });
    assert.equal(plan.scene, item.scene, `${item.name}：场景`);
    assert.equal(plan.level, item.level, `${item.name}：档位`);
  }
});

test("T2 混合意图「情绪 + 任务」按任务处理，不把事办错", () => {
  const { plan } = decide("我好累，帮我把这个报错看一下", { mode: "companion" });
  assert.ok(["companion_task", "task", "complex_task"].includes(plan.scene));
  assert.notEqual(plan.level, "off");
});

test("T3 「天气/气氛」不因单字「气」被误判成情感回合", () => {
  const signals = analyzeTurn("今天天气不错，气氛挺好");
  assert.equal(signals.emotionHits.length, 0);
  assert.equal(decide("今天天气不错，气氛挺好").plan.scene, "small_talk");
});

// ---------------------------------------------------------------------------
// 2. 铁律：永不超过用户配置的档位
// ---------------------------------------------------------------------------

test("T4 任意场景都不超过基线 effort（结构上保证任务准确率）", () => {
  const texts = [
    "嗯",
    "重构认证模块，先拆出 token 校验，再补测试，最后更新文档",
    "我不想活了",
    "那个呢",
    "帮我看一下这个 bug",
  ];
  for (const effort of EFFORT_LADDER) {
    for (const text of texts) {
      const { plan } = decide(text, {}, initialThinkingDepthState(), {
        ...BASE,
        reasoningEffort: effort,
      });
      assert.ok(
        EFFORT_LADDER.indexOf(plan.reasoningEffort) <= EFFORT_LADDER.indexOf(effort),
        `${text} @ ${effort} → ${plan.reasoningEffort} 越过了基线`
      );
    }
  }
});

test("T5 任务回合在默认基线下与静态配置逐字段一致", () => {
  const { plan } = decide("帮我修一下这个报错");
  assert.equal(plan.level, "full");
  assert.equal(plan.reasoningEffort, "max");
  assert.equal(plan.thinkingEnabled, true);
  assert.equal(plan.thinkingBudgetTokens, 4096);
});

test("T6 基线关闭 thinking 时，调度器永远不会把它打开", () => {
  const baseline: ThinkingDepthBaseline = { thinkingEnabled: false, reasoningEffort: "low" };
  for (const text of ["嗯", "帮我修一下这个报错", "我不想活了"]) {
    const { plan } = decide(text, {}, initialThinkingDepthState(), baseline);
    assert.equal(plan.thinkingEnabled, false, text);
  }
});

// ---------------------------------------------------------------------------
// 3. 护栏：工具续跑 / 结构化回合 / 危机 / 长上下文
// ---------------------------------------------------------------------------

test("T7 工具续跑与结构化回合强制吃满基线", () => {
  for (const partial of [{ iteration: 1 }, { isStructuredTurn: true }]) {
    const { plan } = decide("继续", partial);
    assert.equal(plan.scene, "tool_continuation");
    assert.equal(plan.level, "full");
  }
});

test("T8 危机回合不允许彻底关闭思考（哪怕上一轮是闲聊）", () => {
  let state = decide("嗯").state;
  const crisis = decide("我不想活了", { mode: "companion" }, state);
  state = crisis.state;
  assert.equal(crisis.plan.scene, "crisis");
  assert.equal(crisis.plan.thinkingEnabled, true);
  assert.notEqual(crisis.plan.level, "off");
  assert.notEqual(crisis.plan.level, "light");
});

test("T9 重上下文 + 短指代句不擅自降档", () => {
  const { plan } = decide("那个呢", { contextChars: 40_000 });
  assert.equal(plan.scene, "ambiguous");
  assert.notEqual(plan.level, "off");
});

test("T10 语音/时效压力只加速轻场景，不削减任务思考", () => {
  const chitchat = decide("嗯", { latencySensitive: true });
  assert.equal(chitchat.plan.level, "off");
  const task = decide("帮我修一下 session.ts 里的报错", { latencySensitive: true });
  assert.equal(task.plan.level, "full");
  assert.ok(task.plan.reasons.some((r) => r.includes("准确率优先")));
});

// ---------------------------------------------------------------------------
// 4. 平滑与回退
// ---------------------------------------------------------------------------

test("T11 边界场景降档需要连续确认，且每轮最多一档", () => {
  let state = initialThinkingDepthState();
  const first = resolveThinkingDepth(input({ text: "那个呢" }), BASE, state);
  state = first.state;
  assert.equal(first.plan.level, "full");
  assert.equal(first.plan.smoothed, true);
  assert.equal(state.pendingCount, 1);
  assert.ok(state.pendingCount < DOWNGRADE_CONFIRM_TURNS);

  const second = resolveThinkingDepth(input({ text: "这个呢" }), BASE, state);
  state = second.state;
  assert.equal(second.plan.level, "balanced");
  assert.equal(second.plan.smoothed, false);
  assert.equal(state.pendingCount, 0);
});

test("T12 升档即时：从 off 切到复杂任务立刻回弹基线", () => {
  const light = decide("嗯");
  const task = decide("帮我重构 packages/core/src/session.ts，先拆调度再补测试最后跑门禁", {}, light.state);
  assert.equal(light.plan.level, "off");
  assert.equal(task.plan.level, "full");
  assert.equal(task.plan.smoothed, false);
  assert.equal(task.plan.reasoningEffort, "max");
});

test("T13 高置信轻场景立即降档，不等确认", () => {
  const { plan } = decide("嗯");
  assert.equal(plan.level, "off");
  assert.equal(plan.smoothed, false);
  assert.ok(plan.confidence >= CLEAR_LIGHT_CONFIDENCE);
});

test("T14 一键回退：enabled=false 完全等价于静态基线", () => {
  const { plan } = decide("嗯", { enabled: false });
  assert.equal(plan.level, "full");
  assert.equal(plan.reasoningEffort, "max");
  assert.equal(plan.thinkingEnabled, true);
  assert.equal(plan.fallback, true);
  assert.equal(plan.effective, false);
});

test("T15 脏输入不抛错，一律收敛到基线", () => {
  const dirty = {
    ...input({ text: "嗯" }),
    contextChars: Number.NaN,
    iteration: Number.POSITIVE_INFINITY,
    mode: "unknown" as unknown as ThinkingDepthInput["mode"],
  };
  const { plan } = resolveThinkingDepth(dirty, BASE, initialThinkingDepthState());
  assert.equal(plan.fallback, true);
  assert.equal(plan.level, "full");
  assert.equal(plan.mode, "work");
});

test("T16 状态对象可缺省/损坏时自动重建", () => {
  const broken = { lastLevel: "bogus", pendingCount: -3 } as unknown as ThinkingDepthState;
  const { plan, state } = resolveThinkingDepth(input({ text: "嗯" }), BASE, broken);
  assert.equal(plan.level, "off");
  assert.equal(state.lastLevel, "off");
  assert.equal(state.pendingCount, 0);
});

// ---------------------------------------------------------------------------
// 5. 模型能力：诚实降级
// ---------------------------------------------------------------------------

test("T17 control=none 的通用模型不假装有加速", () => {
  const light = decide("嗯", { control: "none" });
  assert.equal(light.plan.effective, true, "off 仍会跳过历史 reasoning 回放");
  const balanced = decide("那个呢", { control: "none" });
  assert.equal(balanced.plan.control, "none");
  assert.equal(balanced.plan.effective, false);
  const task = decide("帮我修一下报错", { control: "none" });
  assert.equal(task.plan.effective, false);
});

test("T18 Claude budget 按档位缩放且不低于 API 下限", () => {
  const off = decide("嗯", { control: "budget" });
  assert.equal(off.plan.thinkingEnabled, false);
  const light = decide("今天有点累", { control: "budget" });
  assert.equal(light.plan.thinkingBudgetTokens, 1229);
  const full = decide("帮我修一下报错", { control: "budget" });
  assert.equal(full.plan.thinkingBudgetTokens, 4096);
  const tiny = decide("今天有点累", { control: "budget" }, initialThinkingDepthState(), {
    ...BASE,
    thinkingBudgetTokens: 200,
  });
  assert.ok((tiny.plan.thinkingBudgetTokens ?? 0) >= 1024);
});

test("T19 旧 Qwen3 只有开关：light 与 off 的区别落在 thinkingEnabled", () => {
  const off = decide("嗯", { control: "binary" });
  const light = decide("今天有点累", { control: "binary" });
  assert.equal(off.plan.control, "binary");
  assert.equal(off.plan.thinkingEnabled, false);
  assert.equal(light.plan.thinkingEnabled, true);
});

test("T20 thinkingControlForModel 与请求体分支同源", () => {
  assert.equal(thinkingControlForModel("qwen3.8-32b"), "effort");
  assert.equal(thinkingControlForModel("deepseek-v4-pro"), "effort");
  assert.equal(thinkingControlForModel("qwen3-32b"), "binary");
  assert.equal(thinkingControlForModel("gpt-4o"), "none");
});

// ---------------------------------------------------------------------------
// 6. Soul 模式识别与可观测性
// ---------------------------------------------------------------------------

test("T21 从实际注入的提示词反查模式，而不是读磁盘最新配置", () => {
  const companionPrompt = renderModeSection("companion", DEFAULT_COMPANION_CONFIG);
  assert.equal(detectSoulModeFromPrompt(companionPrompt), "companion");
  assert.equal(detectSoulModeFromPrompt(renderModeSection("work", DEFAULT_COMPANION_CONFIG)), "work");
  assert.equal(detectSoulModeFromPrompt(null), "work");
});

test("T22 决策可 JSON 序列化（能安全进 SSE 遥测）", () => {
  const { plan } = decide("嗯");
  const roundTrip = JSON.parse(JSON.stringify(plan)) as ThinkingDepthPlan;
  assert.equal(roundTrip.scene, plan.scene);
  assert.equal(roundTrip.level, plan.level);
  assert.deepEqual(roundTrip.reasons, plan.reasons);
  assert.equal(typeof roundTrip.control, "string");
});

test("T23 决策理由可解释且非空", () => {
  for (const item of GOLDEN) {
    const { plan } = decide(item.text, { mode: item.mode });
    assert.ok(plan.reasons.length > 0, item.name);
  }
});

// ---------------------------------------------------------------------------
// 7. 效率指标聚合
// ---------------------------------------------------------------------------

test("T24 效率汇总按档位分组；缺实测值时留空不填 0", () => {
  const report = summarizeThinkingDepthEfficiency([
    { level: "full", scene: "task", llmTtftMs: 900, e2eMs: 2100 },
    { level: "full", scene: "task", llmTtftMs: 1100, e2eMs: 2300 },
    { level: "off", scene: "small_talk", llmTtftMs: 300, e2eMs: 1200 },
    { level: "off", scene: "small_talk", llmTtftMs: 400 },
    { level: "light", scene: "companion_chat" },
    { level: "full", scene: "task", fallback: true },
  ]);
  assert.equal(report.total, 6);
  assert.equal(report.byLevel.full?.count, 3);
  assert.equal(report.byLevel.full?.ttftP50Ms, 900);
  assert.equal(report.byLevel.off?.ttftP50Ms, 300);
  assert.equal(report.byLevel.light?.ttftP50Ms, undefined);
  assert.equal(report.ttftSavingP50Ms, 600);
  assert.equal(report.fallbackRatio, 0.167);
  assert.equal(report.byScene.task, 3);
});

test("T25 没有 full 或轻档实测值时，收益留 undefined（不伪造通过）", () => {
  const report = summarizeThinkingDepthEfficiency([{ level: "full" }, { level: "off" }]);
  assert.equal(report.ttftSavingP50Ms, undefined);
  assert.equal(report.byLevel.full?.ttftP50Ms, undefined);
});

test("T26 空/脏样本不抛错", () => {
  const empty = summarizeThinkingDepthEfficiency([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.downgradedRatio, 0);
  const dirty = summarizeThinkingDepthEfficiency([
    { level: "off", llmTtftMs: -1 },
    { level: "off", llmTtftMs: Number.NaN },
    { level: "bogus" as unknown as ThinkingDepthPlan["level"] },
  ]);
  assert.equal(dirty.total, 2);
  assert.equal(dirty.byLevel.off?.ttftP50Ms, undefined);
});

test("T27 四档 level 常量与 control 类型覆盖完整", () => {
  const controls: ThinkingControl[] = ["effort", "binary", "budget", "none"];
  for (const control of controls) {
    const { plan } = decide("嗯", { control });
    assert.equal(plan.control, control);
  }
});
