/**
 * Roundtable 编排器集成测试（桩 LLM + 临时项目目录）
 *
 * 用桩而不是 mock 框架：`runRoundtable` 只通过两个通道与外部交互——
 * `callLlmOnce`（单次补全）与 `executeDispatch`（带工具执行），两者都走注入的
 * `OpenAIClientHandle`。因此一个按 prompt 内容路由的桩函数足以覆盖全部分支，
 * 不需要把模块内部拆成可替换的接口。
 *
 * 路由键（按 user prompt 里的固定句式）：
 *   "输出你的 JSON 发言"        → 角色发言
 *   "你是主持人。请只做两件事"  → 议程推进
 *   "讨论已经收敛"              → 决议起草
 *   "请用你自己的话复述"        → 任务再表达
 *   "你是主持人，需要就这个问题" → 疑问回流
 *   "## 会议共识"               → 执行（dispatch 的 user prompt）
 *
 * @module team/tests/roundtable-room
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRoundtable } from "../roundtable/room.js";
import { getRole } from "../role-registry.js";
import type { RoundtableOptions } from "../roundtable/types.js";

/** 造一个临时项目根 */
function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-roundtable-"));
}

/** 从请求体里取出最后一条 user 消息文本（request 是 SDK 结构，测试里按需窄化） */
function readUser(request: unknown): string {
  const messages = (request as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i] as { role?: unknown; content?: unknown } | null;
    if (item?.role === "user" && typeof item.content === "string") return item.content;
  }
  return "";
}

/** 包成 model 响应 */
function reply(content: string): Record<string, unknown> {
  return { choices: [{ message: { content }, finish_reason: "stop" }], usage: { total_tokens: 10 } };
}

/**
 * 构造桩客户端
 *
 * @param script 路由函数：拿到 user prompt 与「该类别第几次调用」，返回内容
 */
function createStubClient(script: (kind: string, user: string, seq: number) => string) {
  const counters = new Map<string, number>();
  const client = {
    chat: {
      completions: {
        create: async (request: unknown) => {
          const user = readUser(request);
          let kind = "other";
          if (user.includes("输出你的 JSON 发言")) kind = "speech";
          else if (user.includes("你是主持人。请只做两件事")) kind = "focus";
          else if (user.includes("讨论已经收敛")) kind = "decision";
          else if (user.includes("请用你自己的话复述")) kind = "task-update";
          else if (user.includes("你是主持人，需要就这个问题")) kind = "amendment";
          else if (user.includes("## 会议共识")) kind = "execute";
          const seq = (counters.get(kind) ?? 0) + 1;
          counters.set(kind, seq);
          return reply(script(kind, user, seq));
        },
      },
    },
  };
  return {
    handle: {
      client,
      model: "stub-model",
      baseURL: "https://stub.local",
      thinkingEnabled: false,
    },
    counters,
  };
}

/** 基础选项（3 个内置角色 + 主持人） */
function baseOptions(projectRoot: string, overrides: Partial<RoundtableOptions> = {}): RoundtableOptions {
  const participants = [getRole("architect"), getRole("solo-coder"), getRole("test-expert")].filter(
    (role): role is NonNullable<typeof role> => role !== undefined
  );
  return {
    projectRoot,
    task: "为登录接口加限流",
    participants,
    moderator: getRole("product-manager")!,
    maxRounds: 2,
    speakTimeoutMs: 5_000,
    ...overrides,
  };
}

/** 一条合法发言 */
function speechJson(posture: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    posture,
    blocking: false,
    keyPoints: [],
    questions: [],
    content: `我的立场是 ${posture}`,
    ...extra,
  });
}

/** 决议起草：两个分工，solo-coder 依赖 architect */
const DECISION_JSON = JSON.stringify({
  summary: "采用用户维度限流，429 返回 Retry-After",
  decisions: ["按用户维度限流", "429 带 Retry-After"],
  openQuestions: [],
  assignments: [
    { roleId: "architect", scope: "docs/**", deliverable: "限流规则文档", acceptance: "评审通过", dependsOn: [] },
    {
      roleId: "solo-coder",
      scope: "src/middleware/**",
      deliverable: "限流中间件",
      acceptance: "用例绿",
      dependsOn: ["architect"],
    },
  ],
});

test("R1. 两轮收敛 → 起草决议 → 分工执行（未注入 runner 时为文本模式）", async () => {
  const projectRoot = tempProject();
  // 第 1 轮全部 refine（有新要点）→ diverging；第 2 轮全部 support → consensus
  const stub = createStubClient((kind, _user, seq) => {
    if (kind === "speech")
      return seq <= 3 ? speechJson("refine", { keyPoints: ["限流粒度不清"] }) : speechJson("support");
    if (kind === "focus") return JSON.stringify({ focus: "聚焦限流粒度", openQuestions: ["按 IP 还是用户"] });
    if (kind === "decision") return DECISION_JSON;
    if (kind === "task-update")
      return JSON.stringify({
        restated: "我按分工完成自己那块",
        steps: ["读共识", "动手"],
        acceptance: "自测通过",
        needDiscussion: false,
        question: "",
      });
    if (kind === "execute") return JSON.stringify({ summary: "已按共识完成", filesTouched: [], questions: [] });
    return "{}";
  });

  const result = await runRoundtable(baseOptions(projectRoot, { injectedClient: stub.handle }));

  assert.equal(result.status, "consensus", `期望 consensus，实际 ${result.status}（note: ${result.note ?? ""}）`);
  assert.equal(result.rounds, 2, "第 1 轮 diverging 后应再开一轮");
  assert.ok(result.decision);
  assert.equal(result.decision!.assignments.length, 2);
  assert.equal(result.executions.length, 2);
  assert.ok(result.executions.every((item) => item.status === "completed"));
  assert.ok(
    result.executions.every((item) => item.mode === "text"),
    "未注入 runner 时必须标为文本模式"
  );
  assert.ok(result.note?.includes("未注入工具执行器"), `note 应诚实说明没有真实改动：${result.note}`);
  assert.equal(result.unparsedSpeeches, 0);
});

test("R2. 阻断性反对持续存在 → unresolved，且不产出决议", async () => {
  const projectRoot = tempProject();
  const stub = createStubClient((kind) => {
    if (kind === "speech") return speechJson("object", { blocking: true, keyPoints: ["没有测试环境无法验证"] });
    if (kind === "focus") return JSON.stringify({ focus: "测试环境", openQuestions: ["用 mock 时钟行不行"] });
    return "{}";
  });

  const result = await runRoundtable(baseOptions(projectRoot, { injectedClient: stub.handle, maxRounds: 2 }));

  assert.equal(result.status, "unresolved");
  assert.equal(result.decision, null, "未达成共识时不得产出决议");
  assert.equal(result.executions.length, 0, "未达成共识时不得执行");
  assert.ok(result.note?.includes("阻断性反对"), `note 应指出卡点：${result.note}`);
  assert.equal(result.rounds, 2);
});

test("R3. 无模型凭据 → skipped（不抛错、不假装执行）", async () => {
  const projectRoot = tempProject();
  const result = await runRoundtable(baseOptions(projectRoot, { injectedClient: { notAHandle: true } }));

  assert.equal(result.status, "skipped");
  assert.equal(result.decision, null);
  assert.ok(result.note?.includes("模型凭据"));
});

test("R4. 全员发言失败 → degraded（覆盖率不足，不能伪装成共识）", async () => {
  const projectRoot = tempProject();
  const stub = createStubClient(() => {
    throw new Error("上游 503");
  });

  const result = await runRoundtable(baseOptions(projectRoot, { injectedClient: stub.handle, maxRounds: 1 }));

  assert.equal(result.status, "degraded");
  assert.equal(result.decision, null);
  assert.ok((result.note ?? "").includes("覆盖率"), `note 应暴露覆盖率问题：${result.note}`);
});

test("R5. 角色在开工前提出疑问 → 触发一次回流并产出版修订", async () => {
  const projectRoot = tempProject();
  const stub = createStubClient((kind, _user, seq) => {
    if (kind === "speech") return speechJson("support");
    if (kind === "decision") return DECISION_JSON;
    if (kind === "task-update") {
      // 第 1 次（architect）没问题，第 2 次（solo-coder）提出问题
      return seq === 1
        ? JSON.stringify({
            restated: "写规则文档",
            steps: ["写"],
            acceptance: "评审",
            needDiscussion: false,
            question: "",
          })
        : JSON.stringify({
            restated: "写中间件",
            steps: ["写"],
            acceptance: "用例绿",
            needDiscussion: true,
            question: "限流计数放内存还是 Redis？",
          });
    }
    if (kind === "amendment")
      return JSON.stringify({ change: "单测用内存计数器，Redis 只在集成测试", affectedRoles: ["solo-coder"] });
    if (kind === "execute") return JSON.stringify({ summary: "完成", filesTouched: [], questions: [] });
    return "{}";
  });

  const result = await runRoundtable(baseOptions(projectRoot, { injectedClient: stub.handle, maxRounds: 1 }));

  assert.equal(result.status, "consensus");
  assert.equal(result.amendments.length, 1, "执行前的疑问应触发一次回流");
  assert.equal(result.escalations, 1);
  assert.deepEqual(result.amendments[0]!.affectedRoles, ["solo-coder"]);
  assert.ok(result.messages.some((m) => m.kind === "amendment"));
});

test("R6. 执行中提出问题 → 回流后重跑受影响角色（不重跑无关角色）", async () => {
  const projectRoot = tempProject();
  const executions: string[] = [];
  const stub = createStubClient((kind, user, _seq) => {
    if (kind === "speech") return speechJson("support");
    if (kind === "decision") return DECISION_JSON;
    if (kind === "task-update")
      return JSON.stringify({
        restated: "按分工执行",
        steps: ["做"],
        acceptance: "自测",
        needDiscussion: false,
        question: "",
      });
    if (kind === "amendment")
      return JSON.stringify({ change: "按内存计数实现，Redis 从范围中移除", affectedRoles: ["solo-coder"] });
    if (kind === "execute") {
      // 从执行描述里取角色名，记录执行次数
      const match = /你的分工[\s\S]{0,80}?范围：([^\n]+)/.exec(user);
      executions.push(match?.[1] ?? "unknown");
      const first = executions.length === 2; // 第 2 次执行（solo-coder，第一层之后的第二层）
      return JSON.stringify({
        summary: "完成",
        filesTouched: [],
        // 第一次执行就抛出问题，触发回流
        questions: first ? ["Redis 依赖不存在，是否改用内存？"] : [],
      });
    }
    return "{}";
  });

  const result = await runRoundtable(baseOptions(projectRoot, { injectedClient: stub.handle, maxRounds: 1 }));

  assert.equal(result.status, "consensus");
  assert.ok(result.amendments.length >= 1, "执行中的问题应触发回流");
  assert.equal(result.escalations, 1, "回流次数受 maxEscalations 限制");
  // 3 次执行 = 第一层(architect) + 第二层(solo-coder) + 重跑(solo-coder)
  assert.equal(executions.length, 3, `期望重跑 1 次，实际执行 ${executions.length} 次`);
});

test("R7. dependsOn 决定执行顺序：被依赖者先跑", async () => {
  const projectRoot = tempProject();
  const order: string[] = [];
  const stub = createStubClient((kind, user, _seq) => {
    if (kind === "speech") return speechJson("support");
    if (kind === "decision") return DECISION_JSON;
    if (kind === "task-update")
      return JSON.stringify({
        restated: "执行",
        steps: ["做"],
        acceptance: "自测",
        needDiscussion: false,
        question: "",
      });
    if (kind === "execute") {
      // 执行描述里带分工范围，用它区分角色
      order.push(user.includes("src/middleware") ? "solo-coder" : "architect");
      return JSON.stringify({ summary: "完成", filesTouched: [], questions: [] });
    }
    return "{}";
  });

  const result = await runRoundtable(baseOptions(projectRoot, { injectedClient: stub.handle, maxRounds: 1 }));

  assert.equal(result.status, "consensus");
  assert.deepEqual(order, ["architect", "solo-coder"], "solo-coder 依赖 architect，不能并行开跑");
});

test("R8. 决议起草失败 → degraded，不执行（没有台账就不派活）", async () => {
  const projectRoot = tempProject();
  const stub = createStubClient((kind) => {
    if (kind === "speech") return speechJson("support");
    if (kind === "decision") return "我觉得大家说得都挺好，按这个来吧。"; // 无 JSON
    return "{}";
  });

  const result = await runRoundtable(baseOptions(projectRoot, { injectedClient: stub.handle, maxRounds: 1 }));

  assert.equal(result.status, "degraded");
  assert.equal(result.decision, null);
  assert.equal(result.executions.length, 0, "没有有效分工时不得执行");
  assert.ok((result.note ?? "").includes("决议起草"), `note 应说明起草失败：${result.note}`);
});
