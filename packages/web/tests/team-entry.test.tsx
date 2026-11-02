/**
 * `/team` 团队模式输出条目单测（2026-11-02 接线审查 D3）。
 *
 * ## 背景
 *
 * 引擎把 `/team` 的每条产出都落成 `role: "system"` 的可见消息：
 * - 进度行带 `【team】` 前缀（阶段推进 plan → dev → verify）；
 * - **最终结果不带前缀**（`result.stdout` 的多行报告）。
 *
 * 此前 Web 把这些消息一律当助手气泡渲染，用户看不出「团队模式在跑什么、跑到
 * 哪一步」——动态组队在界面上等于不存在。修法是引擎在 meta 打 `teamCommand`
 * 标记，前端按 phase 渲染专用卡片。靠文本前缀识别不可行：最关键的结果消息
 * 恰恰没有前缀。
 *
 * 覆盖三层（无 mock）：
 * 1. chat-model：`parseTeamCommandMeta` 的识别与拒绝、`stripTeamPrefix`；
 * 2. 渲染层：progress 紧凑成行、result 用等宽 pre 保留缩进、error 标红；
 * 3. 输入补全：`buildSlashCandidates` 的前缀优先、裸 `/team` 兜底、Markdown 剥除。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseTeamCommandMeta, stripTeamPrefix, type ChatEntry } from "../web/src/chat-model";
import { buildSlashCandidates } from "../web/src/components/Composer";
import { ChatPane } from "../web/src/components/ChatPane";
import type { CapabilityCommand } from "../web/src/api";

/** ChatPane 必填回调的测试桩（只验证渲染，不触发交互） */
function chatPaneProps(entries: ChatEntry[]): React.ComponentProps<typeof ChatPane> {
  return {
    chatTitle: "测试会话",
    entries,
    streaming: false,
    onOpenFileDrawer: () => {},
    onDecide: () => {},
    onStop: () => {},
    submittingPermIds: new Set<string>(),
  };
}

// ---------- 1. 识别 ----------

test("parseTeamCommandMeta：识别三种 phase", () => {
  assert.deepEqual(parseTeamCommandMeta({ teamCommand: { subcommand: "dispatch", phase: "progress" } }), {
    subcommand: "dispatch",
    phase: "progress",
  });
  assert.deepEqual(parseTeamCommandMeta({ teamCommand: { subcommand: "dispatch", phase: "result" } }), {
    subcommand: "dispatch",
    phase: "result",
  });
  assert.deepEqual(parseTeamCommandMeta({ teamCommand: { subcommand: "list", phase: "error" } }), {
    subcommand: "list",
    phase: "error",
  });
});

test("parseTeamCommandMeta：非 /team 消息一律返回 null（不误吞正常 system 消息）", () => {
  assert.equal(parseTeamCommandMeta(undefined), null);
  assert.equal(parseTeamCommandMeta(null), null);
  assert.equal(parseTeamCommandMeta({}), null);
  // 其他 meta 通道不得被误判
  assert.equal(parseTeamCommandMeta({ steeringInject: true }), null);
  assert.equal(parseTeamCommandMeta({ skill: { kind: "agent", name: "x" } }), null);
  // 结构非法
  assert.equal(parseTeamCommandMeta({ teamCommand: "dispatch" }), null);
  // subcommand 非字符串：可识别，但回落为 team（不丢消息）
  assert.equal(parseTeamCommandMeta({ teamCommand: { subcommand: 42, phase: "progress" } })?.subcommand, "team");
  assert.equal(parseTeamCommandMeta({ teamCommand: { subcommand: "dispatch", phase: "done" } }), null);
});

test("parseTeamCommandMeta：subcommand 缺失时回落 team（不丢消息）", () => {
  const info = parseTeamCommandMeta({ teamCommand: { phase: "result" } });
  assert.equal(info?.subcommand, "team");
  assert.equal(info?.phase, "result");
});

test("stripTeamPrefix：只剥进度行前缀，结果正文原样保留", () => {
  assert.equal(stripTeamPrefix("【team】[1/3] 匹配角色"), "[1/3] 匹配角色");
  assert.equal(stripTeamPrefix("【team】✖ 执行异常：boom"), "✖ 执行异常：boom");
  // 结果消息本来无前缀：内容不得被改动（含内部出现的同名字样）
  const report = "角色：后端专家\n说明：【team】前缀只出现在进度行";
  assert.equal(stripTeamPrefix(report), report);
});

// ---------- 2. 渲染 ----------

test("渲染：进度行紧凑展示，标出团队模式与子命令", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      ChatPane,
      chatPaneProps([{ kind: "team", id: "t1", subcommand: "dispatch", phase: "progress", text: "[1/3] 匹配角色" }])
    )
  );
  assert.match(html, /团队模式/);
  assert.match(html, /\/team dispatch/);
  assert.match(html, /team-entry-progress/);
  assert.match(html, /\[1\/3\] 匹配角色/);
});

test("渲染：结果报告用等宽 pre 保留缩进", () => {
  const report = ["可用角色（8）", "  内置：coder / planner", "  业务：domain-finance"].join("\n");
  const html = renderToStaticMarkup(
    React.createElement(
      ChatPane,
      chatPaneProps([{ kind: "team", id: "t2", subcommand: "list", phase: "result", text: report }])
    )
  );
  assert.match(html, /<pre class="team-entry-body">/);
  // 多行与缩进必须原样进 pre（不能在渲染层被压平）
  assert.match(html, /内置：coder \/ planner/);
  assert.match(html, /业务：domain-finance/);
  assert.doesNotMatch(html, /team-entry-progress/, "结果卡不应走进度行样式");
});

test("渲染：异常单独标红（error 修饰类）", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      ChatPane,
      chatPaneProps([{ kind: "team", id: "t3", subcommand: "auto", phase: "error", text: "✖ 执行异常：模型不可用" }])
    )
  );
  assert.match(html, /team-entry-error/);
  assert.match(html, /✖ 执行异常：模型不可用/);
});

// ---------- 3. 输入补全 ----------

const COMMANDS: CapabilityCommand[] = [
  { name: "/team list", description: "列出所有可用角色（**按类别分组**）。" },
  { name: "/team match", description: "根据关键词匹配角色。", args: ["--keywords <kw1,kw2>"] },
  { name: "/team dispatch", description: "分派任务并**真实执行**。", args: ["--task <任务描述>"] },
];

test("buildSlashCandidates：空查询给出全部命令并补裸 /team 帮助入口", () => {
  const items = buildSlashCandidates(COMMANDS, "/");
  assert.equal(items[0]?.name, "/team", "裸 /team 排在最前（帮助入口）");
  assert.equal(items.length, 4);
  // 起始匹配全部命中
  assert.deepEqual(
    items.slice(1).map((item) => item.name),
    ["/team list", "/team match", "/team dispatch"]
  );
});

test("buildSlashCandidates：前缀匹配优先于包含匹配", () => {
  const items = buildSlashCandidates(
    [
      { name: "/team auto", description: "自动拆解" },
      { name: "/team dispatch", description: "派单" },
    ],
    "/team d"
  );
  // 只有 dispatch 以 "/team d" 开头；auto 不含该子串 → 不出现
  assert.deepEqual(
    items.map((item) => item.name),
    ["/team dispatch"]
  );
});

test("buildSlashCandidates：补全面板不暴露 Markdown 强调标记", () => {
  const items = buildSlashCandidates(COMMANDS, "/team dispatch");
  const dispatch = items.find((item) => item.name === "/team dispatch");
  assert.ok(dispatch);
  assert.equal(dispatch.description, "分派任务并真实执行。");
  assert.doesNotMatch(dispatch.description, /\*\*/);
});

test("buildSlashCandidates：无匹配时返回空数组（面板显示空态而不是崩溃）", () => {
  assert.deepEqual(buildSlashCandidates(COMMANDS, "/zzz"), []);
  assert.deepEqual(buildSlashCandidates([], "/team"), [
    { name: "/team", description: "团队模式命令总览（等价 /team help）" },
  ]);
});
