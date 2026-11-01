/**
 * 自定义 Agent 创建端点与 @ 提及解析测试（agents-api）：
 *
 * - POST /api/agents：复用 SedimentationWriter 落盘 ~/.deepcode/skills/<name>/SKILL.md，
 *   临时 HOME 隔离（node --test 每文件独立进程，文件内 test 串行，HOME 改动安全）；
 *   覆盖：成功写盘 + frontmatter（type: agent / role）/ 同名 409 / kebab 400 / 必填 400；
 * - extractMentionedAgents：@token 与已知名单求交的边界（截断/未知/大小写/多命中）。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { handleCreateAgent, handleCreateAgentDraft, parseAgentDraftJson } from "../src/api/agents-api";
import { extractMentionedAgents } from "../src/api/chat-api";
import type { CapabilitySkill } from "../src/api/capability-api";

let homeTmp = "";

before(() => {
  homeTmp = mkdtempSync(path.join(tmpdir(), "deepcode-agents-home-"));
  // os.homedir() 在 POSIX 上每次调用读取 HOME env（libuv uv_os_homedir），
  // SedimentationWriter 的 scope=user 根解析随之落到临时目录
  process.env.HOME = homeTmp;
});

after(() => {
  rmSync(homeTmp, { recursive: true, force: true });
  delete process.env.HOME;
});

/** 构造最小 res 鸭子类型（sendJson 仅使用 writeHead + end） */
function makeRes(): { res: ServerResponse; status: () => number; json: () => any } {
  const state = { code: 0, body: "" };
  const res = {
    writeHead(status: number) {
      state.code = status;
    },
    end(body: string) {
      state.body = body;
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => state.code,
    json: () => JSON.parse(state.body),
  };
}

/** 直接以鸭子 req 传 JSON 体（readJsonBody 兼容异步迭代/事件两种形态？——
 *  readRawBody 用 'data'/'end' 事件，这里以真实 IncomingMessage 形态不可行，
 *  退而直接传 ReadableStream 不可行——改从 handleCreateAgent 的 body 参数无法注入。
 *  实际做法：构造带 push 的最小 req 假体（readRawBody 只依赖 on/error）。 */
function makeReq(body: unknown): any {
  const raw = Buffer.from(JSON.stringify(body));
  const listeners: Record<string, Array<(c?: Buffer) => void>> = {};
  const req = {
    headers: { "content-type": "application/json" },
    on(event: string, cb: (c?: Buffer) => void) {
      (listeners[event] ??= []).push(cb);
      return req;
    },
    // readRawBody 若走 async iterator 兜底亦可
    [Symbol.asyncIterator]: async function* () {
      yield raw;
    },
  };
  // 触发 data/end（readRawBody 的 'data' 监听同步注册后我们再推流）
  queueMicrotask(() => {
    for (const cb of listeners["data"] ?? []) cb(raw);
    for (const cb of listeners["end"] ?? []) cb();
  });
  return req;
}

function skillPath(name: string): string {
  return path.join(homeTmp, ".deepcode", "skills", name, "SKILL.md");
}

test("POST /api/agents 创建成功：落盘用户级扫描根 + frontmatter 含 type/role", async () => {
  const { res, status, json } = makeRes();
  await handleCreateAgent(
    makeReq({
      name: "code-reviewer",
      description: "负责审查代码变更",
      role: "资深代码评审工程师",
      content: "- 逐条给出问题与修复建议",
    }),
    res,
    { userId: "u1", username: "tester" } as any
  );

  assert.equal(status(), 201);
  assert.equal(json().ok, true);
  const file = skillPath("code-reviewer");
  assert.ok(existsSync(file), `应落盘 ${file}`);
  const raw = readFileSync(file, "utf8");
  assert.match(raw, /type: agent/);
  assert.match(raw, /role: 资深代码评审工程师/);
  assert.match(raw, /name: code-reviewer/);
  assert.match(raw, /逐条给出问题与修复建议/);
});

test("POST /api/agents 同名拒写返回 409（duplicate-name）", async () => {
  const { res, status, json } = makeRes();
  await handleCreateAgent(makeReq({ name: "code-reviewer", description: "重复创建", role: "r", content: "" }), res, {
    userId: "u1",
    username: "tester",
  } as any);
  assert.equal(status(), 409);
  assert.equal(json().ok, false);
  assert.equal(json().reason, "duplicate-name");
});

test("POST /api/agents 非 kebab-case 名称返回 400", async () => {
  const { res, status } = makeRes();
  await handleCreateAgent(makeReq({ name: "My Agent", description: "d", role: "r", content: "" }), res, {
    userId: "u1",
    username: "tester",
  } as any);
  assert.equal(status(), 400);
});

test("POST /api/agents 缺 name/description 返回 400", async () => {
  const { res, status } = makeRes();
  await handleCreateAgent(makeReq({ description: "d", role: "r" }), res, {
    userId: "u1",
    username: "tester",
  } as any);
  assert.equal(status(), 400);
});

test("extractMentionedAgents：命中/不截断/未知/大小写/多命中", () => {
  const agents: CapabilitySkill[] = [
    { name: "code-reviewer", description: "", path: "", kind: "agent" },
    { name: "code", description: "", path: "", kind: "agent" },
    { name: "writer", description: "", path: "", kind: "agent" },
  ];
  // 完整命中 + 不截断：@code-reviewer 不应误中 code
  assert.deepEqual(extractMentionedAgents("请 @code-reviewer 审查", agents), ["code-reviewer"]);
  // 短 token 命中
  assert.deepEqual(extractMentionedAgents("请 @code 处理", agents), ["code"]);
  // 未知 token 不命中
  assert.deepEqual(extractMentionedAgents("请 @nobody 处理", agents), []);
  // 大小写不命中（kebab-case 全小写口径）
  assert.deepEqual(extractMentionedAgents("请 @Code-Reviewer 处理", agents), []);
  // 多命中去重
  assert.deepEqual(extractMentionedAgents("@writer 和 @writer、@code 一起", agents), ["writer", "code"]);
  // 无 @ 不命中
  assert.deepEqual(extractMentionedAgents("普通消息", agents), []);
});

test("parseAgentDraftJson：剥离围栏/容错截取/name 归一", () => {
  // 标准 JSON
  assert.deepEqual(parseAgentDraftJson('{"name":"code-reviewer","description":"d","role":"r","content":"c"}'), {
    name: "code-reviewer",
    description: "d",
    role: "r",
    content: "c",
  });
  // markdown 围栏包裹
  assert.deepEqual(parseAgentDraftJson('```json\n{"name":"a1","description":"d","role":"r","content":""}\n```'), {
    name: "a1",
    description: "d",
    role: "r",
    content: "",
  });
  // 前后带说明文字
  assert.deepEqual(
    parseAgentDraftJson('好的，以下是草稿：\n{"name":"x9","description":"d","role":"r","content":"c"}\n完毕'),
    { name: "x9", description: "d", role: "r", content: "c" }
  );
  // name 归一：大写/空格/非法字符 → kebab
  assert.equal(parseAgentDraftJson('{"name":"My Agent!","description":"d","role":"r","content":""}')?.name, "my-agent");
  // 缺字段 → null
  assert.equal(parseAgentDraftJson('{"name":"a","description":"d"}'), null);
  // 非 JSON → null
  assert.equal(parseAgentDraftJson("完全不是 JSON"), null);
  // 空串 → null
  assert.equal(parseAgentDraftJson(""), null);
});

test("POST /api/agents/draft 空 prompt 返回 400", async () => {
  const { res, status, json } = makeRes();
  await handleCreateAgentDraft(makeReq({ prompt: "   " }), res, { userId: "u1", username: "tester" } as any);
  assert.equal(status(), 400);
  assert.equal(json().reason, "invalid-prompt");
});

test("POST /api/agents/draft 无 API Key 时返回 503（llm-not-configured）", async () => {
  // 测试 HOME 为空临时目录（before 钩子已设）：无 settings.json、进程无 DEEPCODE_API_KEY
  // → createOpenAIClient 的 client 为 null → 快速失败 503，不真正发起网络请求
  const { res, status, json } = makeRes();
  await handleCreateAgentDraft(makeReq({ prompt: "代码评审智能体" }), res, {
    userId: "u1",
    username: "tester",
  } as any);
  assert.equal(status(), 503);
  assert.equal(json().reason, "llm-not-configured");
});
