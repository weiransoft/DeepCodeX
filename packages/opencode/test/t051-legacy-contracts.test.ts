import { describe, expect, test } from "bun:test";
import { detectAutonomousMode } from "@oc/core/eag/cli/eag-autonomous-mode";
import { compactMessages, runCompact } from "@oc/core/eag/cli/eag-compact-command";
import { parseGoalCommand, buildGoalDirective, buildCompletionDirective } from "@oc/core/eag/cli/eag-goal-command";
import { validateEagAutonomousConfig, DEFAULT_EAG_AUTONOMOUS } from "@oc/core/eag/cli/eag-autonomous-config";
import { createAgent as coreCreateAgent } from "@oc/core/agent/agent-registry";
import { parsePlanCommand } from "@oc/core/eag/cli/eag-plan-command";

// T-051：锁定既有修复项的行为契约（autonomous / compact / goal / autonomy caps /
// agent 默认提示词 / eag 权限模式 / /plan 解析），防止后续改动造成回归。

describe("T-051 autonomous mode detection", () => {
  test("slash commands, approval keywords and empty input are not autonomous", () => {
    expect(detectAutonomousMode("/compact").autonomous).toBe(false);
    expect(detectAutonomousMode("").autonomous).toBe(false);
    expect(detectAutonomousMode("   ").autonomous).toBe(false);
    expect(detectAutonomousMode("do this for me").autonomous).toBe(false);
    expect(detectAutonomousMode("需要我帮你继续吗？").autonomous).toBe(false);
  });

  test("full-auto intents are detected in English and Chinese", () => {
    expect(detectAutonomousMode("run autonomously").autonomous).toBe(true);
    expect(detectAutonomousMode("fully auto please").autonomous).toBe(true);
    expect(detectAutonomousMode("autonomous mode").autonomous).toBe(true);
    expect(detectAutonomousMode("一直执行直到完成").autonomous).toBe(true);
    expect(detectAutonomousMode("持续自动完成直到成功").autonomous).toBe(true);
    expect(detectAutonomousMode("yolo 跑起来").autonomous).toBe(true);
  });

  test("autonomous implies plan mode; reason is explainable", () => {
    const result = detectAutonomousMode("请持续自动执行直到全部测试通过");
    expect(result.autonomous).toBe(true);
    expect(result.plan).toBe(true);
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("T-051 /compact contract", () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `msg ${i}`,
  }));

  test("keeps most recent N untouched, soft-compacts the rest", () => {
    const { messages, result } = compactMessages(msgs);
    expect(result.compactedCount).toBe(4);
    expect(messages.slice(0, 4).every((m) => m.compacted)).toBe(true);
    expect(messages.slice(4).every((m) => m.compacted === undefined)).toBe(true);
    expect(result.summary).toContain("已压缩 4 条");
  });

  test("input is not mutated (pure function)", () => {
    const copy = structuredClone(msgs);
    compactMessages(msgs);
    expect(msgs).toEqual(copy);
  });

  test("re-running is idempotent for the same boundary; empty history no-ops", async () => {
    const first = await runCompact(msgs);
    expect(first.compactedCount).toBe(4);
    expect((await runCompact([])).compactedCount).toBe(0);
    const r = await runCompact([{ role: "user", content: "only one" }]);
    expect(r.compactedCount).toBe(0);
    expect(r.summary).toContain("无需压缩");
  });

  test("persisted marked indices exclude previously compacted messages", async () => {
    let marked: number[] | undefined;
    const already = [{ role: "user", content: "old", compacted: true }, ...msgs.slice(1)];
    await runCompact(already, {
      store: { markCompacted: (idx) => (marked = idx) },
    });
    expect(marked).toEqual([1, 2, 3]);
  });
});

describe("T-051 goal directive and completion gate", () => {
  test("/goal parses objective and builds injection directive", () => {
    const parsed = parseGoalCommand("/goal 修复剩余失败项并验证通过");
    expect(parsed.matched).toBe(true);
    expect(parsed.objective).toBe("修复剩余失败项并验证通过");
    const directive = buildGoalDirective("ship it");
    expect(directive).toContain("<eag-goal>");
    expect(directive).toContain("ship it");
    expect(directive).toContain("完成前必须实际运行验证");
  });

  test("completion directive blocks stopping until objective is truly done", () => {
    expect(buildCompletionDirective("t")).toContain("<eag-goal-check>");
    expect(buildCompletionDirective("t")).toContain("还不能停止");
  });
});

describe("T-051 autonomy caps still enforced", () => {
  test("defaults match spec (40 turns, 30min, 5 retries)", () => {
    expect(DEFAULT_EAG_AUTONOMOUS.maxTurns).toBe(40);
    expect(DEFAULT_EAG_AUTONOMOUS.maxDurationMinutes).toBe(30);
    expect(DEFAULT_EAG_AUTONOMOUS.maxRetriesPerTask).toBe(5);
  });

  test("clamp and validation keep runaway values bounded", () => {
    const raw = validateEagAutonomousConfig({
      enabled: true,
      maxTurns: 99999,
      maxDurationMinutes: 99999,
      maxRetriesPerTask: 99999,
    });
    expect(raw.maxTurns).toBe(200);
    expect(raw.maxDurationMinutes).toBe(240);
    expect(raw.maxRetriesPerTask).toBe(20);
    const bad = validateEagAutonomousConfig({ maxTurns: 0, maxRetriesPerTask: -1 });
    expect(bad.issues.length).toBe(2);
  });
});

describe("T-051 core agent registry defaults", () => {
  test("explore agent gets read-only prompt by default (regression lock)", () => {
    const agent = coreCreateAgent({ name: "explore", mode: "subagent" });
    expect(agent.prompt.length).toBeGreaterThan(0);
    const custom = coreCreateAgent({ name: "explore", prompt: "custom" });
    expect(custom.prompt).toBe("custom");
  });

  test("eag agent enables auto permission mode (bypass) by default", () => {
    const agent = coreCreateAgent({ name: "eag", mode: "primary" });
    expect(agent.permission).toBeDefined();
    expect(agent.permission?.["*"]).toBe("allow");
  });
});

describe("T-051 /plan parser contract", () => {
  test("markdown plan is extracted with steps", () => {
    const plan = parsePlanCommand("# 计划\n- [ ] 步骤一\n- [ ] 步骤二");
    expect(plan.steps.length).toBe(2);
    expect(plan.steps[0].title).toBe("步骤一");
  });
});
