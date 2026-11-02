/**
 * Roundtable 协议层单测（解析 + 降级）
 *
 * 重点不是"正常 JSON 能解析"（那是最容易的），而是**模型不规范时会发生什么**：
 * 围栏 / 裸对象 / 前后夹文字 / 非法立场 / 空响应 / 内容里含括号。
 * 这些分支决定了群聊会不会产出"假共识"。
 *
 * @module team/tests/roundtable-protocol
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject, parseDecision, parseFocus, parseSpeech, parseTaskUpdate } from "../roundtable/protocol.js";

const ALLOWED = new Set(["architect", "solo-coder", "test-expert", "moderator"]);

test("P1. 围栏 JSON：正常解析并保留结构", () => {
  const raw =
    '```json\n{"posture":"support","blocking":false,"keyPoints":["限流按用户维度"],"questions":[],"content":"我同意"}\n```';
  const speech = parseSpeech(raw, "architect", "架构师");
  assert.equal(speech.posture, "support");
  assert.equal(speech.blocking, false);
  assert.deepEqual(speech.keyPoints, ["限流按用户维度"]);
  assert.equal(speech.content, "我同意");
  assert.equal(speech.unparsed, undefined);
});

test("P2. 裸 JSON：前后夹自然语言也能取出对象", () => {
  const raw =
    '我的看法如下：\n{"posture":"object","blocking":true,"keyPoints":["缺测试环境"],"content":"没有环境无法验证"}\n以上。';
  const speech = parseSpeech(raw, "test-expert", "测试专家");
  assert.equal(speech.posture, "object");
  assert.equal(speech.blocking, true);
  assert.equal(speech.content, "没有环境无法验证");
});

test("P3. content 里含右花括号：平衡扫描不会提前截断", () => {
  const raw = '{"posture":"refine","keyPoints":[],"content":"配置形如 {\\"limit\\": 100} 需要确认"}';
  const speech = parseSpeech(raw, "solo-coder", "独立开发者");
  assert.equal(speech.posture, "refine");
  assert.ok(speech.content.includes('{"limit": 100}'), `content 被截断: ${speech.content}`);
});

test("P4. 非法 posture（agree）→ 按 refine 处理并标记 unparsed", () => {
  const raw = '{"posture":"agree","keyPoints":[],"content":"我觉得行"}';
  const speech = parseSpeech(raw, "architect", "架构师");
  assert.equal(speech.posture, "refine", "非法立场不得被当成 support（假共识起点）");
  assert.equal(speech.unparsed, true);
});

test("P5. 完全没有 JSON → refine + unparsed，content 保留原文", () => {
  const raw = "我认为应该先做限流，再考虑缓存。";
  const speech = parseSpeech(raw, "architect", "架构师");
  assert.equal(speech.posture, "refine");
  assert.equal(speech.unparsed, true);
  assert.equal(speech.content, raw);
});

test("P6. blocking 只对 object 生效：support 时填 true 也不认", () => {
  const raw = '{"posture":"support","blocking":true,"content":"同意"}';
  const speech = parseSpeech(raw, "architect", "架构师");
  assert.equal(speech.posture, "support");
  assert.equal(speech.blocking, false, "非 object 立场的 blocking 会造成误判，必须忽略");
});

test("P7. extractJsonObject：三种形态都能取到，纯文本返回 null", () => {
  assert.ok(extractJsonObject('```json\n{"a":1}\n```'));
  assert.ok(extractJsonObject('前缀 {"a":1} 后缀'));
  assert.ok(extractJsonObject('{"a":{"b":2}}'));
  assert.equal(extractJsonObject("没有任何对象"), null);
  assert.equal(extractJsonObject(""), null);
});

test("P8. parseTaskUpdate：缺 restated 视为无效，需要回流的问题自动置 needDiscussion", () => {
  assert.equal(parseTaskUpdate('{"steps":["a"]}'), null);

  const parsed = parseTaskUpdate(
    '{"restated":"我负责实现中间件","steps":["写代码","补用例"],"acceptance":"用例全绿","needDiscussion":false,"question":"限流粒度按 IP 还是用户？"}'
  );
  assert.ok(parsed);
  assert.equal(parsed!.restated, "我负责实现中间件");
  assert.deepEqual(parsed!.steps, ["写代码", "补用例"]);
  assert.equal(parsed!.needDiscussion, true, "写了 question 就应触发回流，哪怕模型忘了置 needDiscussion");
});

test("P9. parseDecision：丢弃不在房间里的角色，且保留合法分工", () => {
  const raw = JSON.stringify({
    summary: "采用双维度限流",
    decisions: ["按用户+IP 双维度", "429 带 Retry-After"],
    openQuestions: ["阈值谁定"],
    assignments: [
      { roleId: "architect", scope: "src/auth/**", deliverable: "规则定义", acceptance: "文档评审通过", dependsOn: [] },
      { roleId: "ghost-role", scope: "x", deliverable: "幻觉出来的活", acceptance: "无", dependsOn: [] },
      {
        roleId: "solo-coder",
        scope: "src/middleware/**",
        deliverable: "中间件",
        acceptance: "用例绿",
        dependsOn: ["architect"],
      },
    ],
  });
  const decision = parseDecision(raw, ALLOWED);
  assert.ok(decision);
  assert.equal(decision!.assignments.length, 2, "幻觉角色必须被丢弃");
  assert.deepEqual(
    decision!.assignments.map((item) => item.roleId),
    ["architect", "solo-coder"]
  );
  assert.deepEqual(decision!.assignments[1]!.dependsOn, ["architect"]);
});

test("P10. parseDecision：自依赖被剔除（否则分层执行会死锁）", () => {
  const raw = JSON.stringify({
    summary: "s",
    decisions: [],
    openQuestions: [],
    assignments: [{ roleId: "architect", scope: "a", deliverable: "d", acceptance: "x", dependsOn: ["architect"] }],
  });
  const decision = parseDecision(raw, ALLOWED);
  assert.deepEqual(decision!.assignments[0]!.dependsOn, []);
});

test("P11. parseFocus：解析失败返回 null 交由调用方兜底", () => {
  assert.equal(parseFocus("我想了想，还是聚焦限流粒度吧"), null);
  const parsed = parseFocus('{"focus":"限流粒度","openQuestions":["按 IP 还是用户"]}');
  assert.equal(parsed!.focus, "限流粒度");
  assert.deepEqual(parsed!.openQuestions, ["按 IP 还是用户"]);
});
