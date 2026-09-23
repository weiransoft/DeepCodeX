/**
 * 后台任务完成/失败通知卡片（system 消息 → bgtask 条目）单测。
 *
 * 覆盖三层（无 mock，真实数据形态）：
 * 1. chat-model：parseBackgroundTaskNotice——失败（多行命令 + 信号）/
 *    完成（单行命令 + 退出码）/ 截断日志尾 / 非通知文本拒绝；
 * 2. 渲染层：BgTaskNotice 经 renderToStaticMarkup 输出状态徽标 / 命令原文 /
 *    日志尾（标签不外露）/ 完成态类名；
 * 3. 「思考中」占位气泡：thinkingPending 态渲染萤火虫闪烁、正文到达后消失。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseBackgroundTaskNotice, type ChatEntry } from "../web/src/chat-model";
import { BgTaskNotice, ChatPane } from "../web/src/components/ChatPane";

/** 引擎失败通知的真实文本形态（session.ts addBackgroundProcessCompletionMessage，命令含换行） */
const FAILED_MULTILINE = [
  "Background command \"cd /home/hguser/deploy-plan && sed -e 's|a|b|' scripts/p2b.sh > scripts/p3b.sh",
  'nohup bash scripts/p3b.sh > logs/p3b-import.log 2>&1; echo bg_p3b" failed with signal SIGKILL after 7m 52s. Output: /tmp/deepcode-background/bash-cafd85a6.log',
  '<background_task_failure_log path="/tmp/deepcode-background/bash-cafd85a6.log">',
  "SYNTAX_OK",
  "</background_task_failure_log>",
].join("\n");

test("bgtask：解析失败通知——多行命令 / 信号 / 耗时 / 输出路径 / 日志尾", () => {
  const notice = parseBackgroundTaskNotice(FAILED_MULTILINE);
  assert.ok(notice !== null, "引擎失败通知文本必须解析成功");
  assert.equal(notice.status, "failed");
  assert.equal(notice.exitText, "signal SIGKILL");
  assert.equal(notice.duration, "7m 52s");
  assert.equal(notice.outputPath, "/tmp/deepcode-background/bash-cafd85a6.log");
  assert.ok(notice.command.includes("nohup bash scripts/p3b.sh"), "多行命令必须完整保留");
  assert.equal(notice.logTail, "SYNTAX_OK", "日志尾必须取自 failure_log 标签内");
  assert.equal(notice.logTruncated, undefined, "未截断时不应标记");
});

test("bgtask：解析完成通知——单行命令 / 退出码 / 无日志尾", () => {
  const text =
    'Background command "bash scripts/backup.sh" completed with exit code 0 after 3s. Output: /tmp/deepcode-background/bash-1.log';
  const notice = parseBackgroundTaskNotice(text);
  assert.ok(notice !== null);
  assert.equal(notice.status, "completed");
  assert.equal(notice.exitText, "exit code 0");
  assert.equal(notice.command, "bash scripts/backup.sh");
  assert.equal(notice.logTail, undefined, "完成态无日志尾");
});

test("bgtask：日志尾截断前缀应剥离并标记 logTruncated", () => {
  const text = [
    'Background command "x.sh" failed with unknown status after 1s. Output: /tmp/o.log',
    '<background_task_failure_log path="/tmp/o.log">',
    "(20480 bytes)...",
    "last line",
    "</background_task_failure_log>",
  ].join("\n");
  const notice = parseBackgroundTaskNotice(text);
  assert.ok(notice !== null);
  assert.equal(notice.exitText, "unknown status");
  assert.equal(notice.logTruncated, true);
  assert.equal(notice.logTail, "last line", "截断前缀必须剥离，正文保留");
});

test("bgtask：非通知文本不误判（steering/技能目录等 system 消息）", () => {
  assert.equal(parseBackgroundTaskNotice("请在完成后提交代码"), null);
  assert.equal(parseBackgroundTaskNotice("Background task queue is empty"), null);
});

/** 条目构造（测试便捷） */
function bgEntry(noticeText: string): Extract<ChatEntry, { kind: "bgtask" }> {
  const notice = parseBackgroundTaskNotice(noticeText);
  assert.ok(notice !== null);
  return { kind: "bgtask", id: "bg-1", notice };
}

test("bgtask：失败卡片渲染——徽标/退出说明/命令完整/日志尾不外露标签", () => {
  const html = renderToStaticMarkup(<BgTaskNotice entry={bgEntry(FAILED_MULTILINE)} />);
  assert.ok(html.includes("后台任务失败"), "必须显示失败徽标");
  assert.ok(html.includes("bgtask-badge-failed"), "失败态类名");
  assert.ok(html.includes("signal SIGKILL"), "状态说明可见");
  assert.ok(html.includes("7m 52s"), "耗时可见");
  assert.ok(html.includes("/tmp/deepcode-background/bash-cafd85a6.log"), "输出路径可见");
  assert.ok(html.includes("SYNTAX_OK"), "日志尾内容可见");
  assert.ok(!html.includes("background_task_failure_log"), "引擎日志标签不得外露");
});

test("bgtask：完成卡片渲染——完成徽标与绿色态类名", () => {
  const html = renderToStaticMarkup(
    <BgTaskNotice
      entry={bgEntry(
        'Background command "bash scripts/backup.sh" completed with exit code 0 after 3s. Output: /tmp/o.log'
      )}
    />
  );
  assert.ok(html.includes("后台任务完成"));
  assert.ok(html.includes("bgtask-badge-ok"));
  assert.ok(!html.includes("失败日志尾"), "完成态不渲染日志尾区块");
});

// ---------- 「思考中」占位（萤火虫闪烁） ----------

/** ChatPane 必填回调的测试桩（本组用例只验证占位渲染，不触发交互） */
function chatPaneProps(entries: ChatEntry[]): React.ComponentProps<typeof ChatPane> {
  return {
    chatTitle: "测试会话",
    entries,
    streaming: true,
    onOpenFileDrawer: () => {},
    onDecide: () => {},
    onStop: () => {},
    submittingPermIds: new Set<string>(),
  };
}

test("thinking：占位态渲染萤火虫闪烁与「思考中」文案", () => {
  const html = renderToStaticMarkup(
    <ChatPane
      {...chatPaneProps([
        { kind: "assistant", id: "stream", content: null, preview: null, thinkingPending: true, done: false },
      ])}
    />
  );
  assert.ok(html.includes("thinking-firefly"), "占位态必须渲染萤火虫容器");
  assert.ok(html.includes("思考中"), "占位态必须显示思考中文案");
  assert.ok(html.includes("firefly firefly-2"), "三颗萤火虫错相闪烁");
});

test("thinking：thinking 文本到达后占位让位于可折叠思考过程", () => {
  const html = renderToStaticMarkup(
    <ChatPane
      {...chatPaneProps([
        {
          kind: "assistant",
          id: "stream",
          content: null,
          preview: "",
          thinking: "先梳理任务边界",
          thinkingPending: true,
          done: false,
        },
      ])}
    />
  );
  assert.ok(!html.includes("thinking-firefly"), "thinking 到达后占位必须消失");
  assert.ok(html.includes("思考过程"), "思考过程折叠区块必须上屏");
  assert.ok(html.includes("先梳理任务边界"), "thinking 文本必须可见");
});
