import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMMEDIATE_CONTROL_COMMANDS,
  MAX_PENDING_QUEUE_SIZE,
  isImmediateControlCommand,
  isUrgentIntervention,
  PendingPromptQueue,
} from "../ui";

// F10（2026-09-12）：任务执行中指令分发判定 + 会话绑定排队队列的单元测试
// 需求与设计：docs/dev/queued-dispatch-gaps-fix.md（G1-G5）

// ============================================================================
// G1：控制类命令白名单判定（从 App.tsx 抽出的纯函数）
// ============================================================================

test("isImmediateControlCommand accepts all whitelisted control commands", () => {
  // 13 个白名单命令逐个判定：任务执行中不占 LLM 回合，可立即执行
  for (const command of IMMEDIATE_CONTROL_COMMANDS) {
    assert.ok(isImmediateControlCommand({ command }), `${command} 应为立即执行控制命令`);
  }
  assert.equal(IMMEDIATE_CONTROL_COMMANDS.size, 13);
});

test("isImmediateControlCommand rejects continue, LLM commands and plain text", () => {
  // continue 的空会话特例由 App.tsx 调用方处理，纯函数版本一律返回 false
  assert.equal(isImmediateControlCommand({ command: "continue" }), false);
  // 可能触发 LLM 回合的命令不是控制类
  assert.equal(isImmediateControlCommand({ command: "init" }), false);
  assert.equal(isImmediateControlCommand({ command: "review" }), false);
  // 普通文本 / 无 command / undefined
  assert.equal(isImmediateControlCommand({ text: "帮我看下代码" }), false);
  assert.equal(isImmediateControlCommand({}), false);
  assert.equal(isImmediateControlCommand({ command: undefined }), false);
});

// ============================================================================
// G5：紧急干预判定三级匹配（收紧误伤面）
// ============================================================================

test("isUrgentIntervention matches strong stop words anywhere with word boundary", () => {
  // 英文强停止词：任意位置 + \b 词边界（大小写不敏感）
  assert.ok(isUrgentIntervention({ text: "stop" }));
  assert.ok(isUrgentIntervention({ text: "please STOP now" }));
  assert.ok(isUrgentIntervention({ text: "这个方案不对，cancel 掉" }));
  // 中文强停止词：句首 / 标点后子句起始 / 礼貌前导词
  assert.ok(isUrgentIntervention({ text: "取消当前任务" }));
  assert.ok(isUrgentIntervention({ text: "等下，别跑了" }));
  assert.ok(isUrgentIntervention({ text: "请取消" }));
  assert.ok(isUrgentIntervention({ text: "停止" }));
  assert.ok(isUrgentIntervention({ text: "不要继续了" }));
  // 整条输入恰为"停"（单字急停）
  assert.ok(isUrgentIntervention({ text: "停" }));
});

test("isUrgentIntervention matches correction words only at message start", () => {
  // 纠正/重试类弱词：必须位于消息开头（用户直接指陈当前运行的错误）
  assert.ok(isUrgentIntervention({ text: "错了，应该用 B 方案" }));
  assert.ok(isUrgentIntervention({ text: "修改一下刚才那段" }));
  assert.ok(isUrgentIntervention({ text: "重新来" }));
  assert.ok(isUrgentIntervention({ text: "Retry with the other config" }));
  assert.ok(isUrgentIntervention({ text: "check again" }));
});

test("isUrgentIntervention matches explicit priority words anywhere", () => {
  // 紧急优先类显式词：任意位置（本身就是优先级声明）
  assert.ok(isUrgentIntervention({ text: "这件事 urgent，先处理" }));
  assert.ok(isUrgentIntervention({ text: "稍后再说，这个优先" }));
  assert.ok(isUrgentIntervention({ text: "马上停下来" }));
});

test("isUrgentIntervention rejects daily-chat false positives (G5 core)", () => {
  // 误伤反例（原任意位置子串匹配全部误命中，收紧后必须全部不命中）：
  assert.equal(isUrgentIntervention({ text: "要不要继续" }), false); // "不要"位于句中
  assert.equal(isUrgentIntervention({ text: "这个别人写的代码有问题" }), false); // "别"位于句中
  assert.equal(isUrgentIntervention({ text: "请别人看看这段" }), false); // 别(?!人) 排除复合词
  assert.equal(isUrgentIntervention({ text: "停用缓存功能" }), false); // "停"非独立急停词
  assert.equal(isUrgentIntervention({ text: "顺便重新看一下配置" }), false); // "重新"不在开头
  assert.equal(isUrgentIntervention({ text: "待会 check 一下结果" }), false); // "check"不在开头
  assert.equal(isUrgentIntervention({ text: "stopped task cleanup" }), false); // \b 防子串
  assert.equal(isUrgentIntervention({ text: "帮我看看登录模块" }), false); // 普通排队指令
  assert.equal(isUrgentIntervention({ text: "" }), false); // 空文本
  assert.equal(isUrgentIntervention({}), false);
});

test("isUrgentIntervention treats /inject command as always urgent", () => {
  // /inject 是动态注入体系（ADR-DI-001）的显式入口，恒为紧急干预
  assert.ok(isUrgentIntervention({ command: "inject", text: "/inject 加上错误处理" }));
});

// ============================================================================
// G2/G5：PendingPromptQueue（会话绑定 + 容量上限 + FIFO/插队/丢弃）
// ============================================================================

/** 构造最小可用的 PromptSubmission（队列测试只需 text/imageUrls 字段） */
function makeSubmission(text: string): { text: string; imageUrls: string[] } {
  return { text, imageUrls: [] };
}

test("PendingPromptQueue enqueues FIFO and urgent entries jump to head", () => {
  const queue = new PendingPromptQueue();
  // 普通：先进先出
  assert.equal(queue.enqueue("s1", makeSubmission("第一条")), true);
  assert.equal(queue.enqueue("s1", makeSubmission("第二条")), true);
  // 紧急：插队头
  assert.equal(queue.enqueue("s1", makeSubmission("紧急"), { urgent: true }), true);
  assert.equal(queue.size, 3);
  const first = queue.dequeue("s1");
  assert.equal(first?.submission.text, "紧急");
  const second = queue.dequeue("s1");
  assert.equal(second?.submission.text, "第一条");
  const third = queue.dequeue("s1");
  assert.equal(third?.submission.text, "第二条");
  assert.equal(queue.dequeue("s1"), null); // 队列空
});

test("PendingPromptQueue skips and discards stale entries from other sessions (G2)", () => {
  const queue = new PendingPromptQueue();
  // 会话 A 排队两条
  queue.enqueue("session-A", makeSubmission("A1"));
  queue.enqueue("session-A", makeSubmission("A2"));
  // 会话 B 排队一条（B 当前活跃）
  queue.enqueue("session-B", makeSubmission("B1"));
  // 消费 B：应跳过并丢弃 A 的两条陈旧条目，返回 B1
  const entry = queue.dequeue("session-B");
  assert.equal(entry?.submission.text, "B1");
  assert.equal(entry?.sessionId, "session-B");
  // A 的条目已被丢弃（不会泄漏到 B），队列清空
  assert.equal(queue.size, 0);
  assert.equal(queue.dequeue("session-B"), null);
});

test("PendingPromptQueue discardExcept keeps only matching session entries (G2)", () => {
  const queue = new PendingPromptQueue();
  queue.enqueue("session-A", makeSubmission("A1"));
  queue.enqueue("session-B", makeSubmission("B1"));
  queue.enqueue("session-A", makeSubmission("A2"));
  // 切换到 A：丢弃 B 的 1 条，保留 A 的 2 条
  assert.equal(queue.discardExcept("session-A"), 1);
  assert.equal(queue.size, 2);
  assert.equal(queue.dequeue("session-A")?.submission.text, "A1");
  assert.equal(queue.dequeue("session-A")?.submission.text, "A2");
});

test("PendingPromptQueue discardAll clears everything and returns count (G3)", () => {
  const queue = new PendingPromptQueue();
  queue.enqueue("s1", makeSubmission("x"));
  queue.enqueue("s1", makeSubmission("y"));
  // ESC 中断语义：全部停下，丢弃全部排队消息并反馈条数
  assert.equal(queue.discardAll(), 2);
  assert.equal(queue.size, 0);
  assert.equal(queue.discardAll(), 0); // 空队列再丢弃不报错
});

test("PendingPromptQueue enforces capacity limit (G5)", () => {
  const queue = new PendingPromptQueue(3); // 小容量便于测试
  assert.equal(queue.enqueue("s1", makeSubmission("1")), true);
  assert.equal(queue.enqueue("s1", makeSubmission("2")), true);
  assert.equal(queue.enqueue("s1", makeSubmission("3")), true);
  // 超容量：拒绝入队（调用方降级为状态栏提示）
  assert.equal(queue.enqueue("s1", makeSubmission("4")), false);
  assert.equal(queue.size, 3);
  // 紧急插队同样受容量约束
  assert.equal(queue.enqueue("s1", makeSubmission("紧急"), { urgent: true }), false);
  // 消费一条后可再次入队
  queue.dequeue("s1");
  assert.equal(queue.enqueue("s1", makeSubmission("4")), true);
});

test("MAX_PENDING_QUEUE_SIZE default matches design doc (32)", () => {
  assert.equal(MAX_PENDING_QUEUE_SIZE, 32);
});
