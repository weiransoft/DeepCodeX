/**
 * 全局规则端点测试（rules-api）：
 *
 * 覆盖：
 * - GET /api/rules：空列表 / 创建后回读
 * - POST /api/rules：成功 201 + 落盘文件格式（USER-xxx / source=user-explicit）、
 *   空内容 400、非法 severity 归一为 MAJOR（宽容输入）
 * - DELETE /api/rules/:id：存在删除 200 + 文件移除、不存在 404
 * - core 助手：formatGlobalRulesPrompt 空列表 → null；addGlobalRule ID 递增
 *
 * 存储隔离：经 resolved.personalOnly=true + engineHomeRoot 指向 mkdtemp 临时目录 +
 * 固定 ctx.userId——规则文件落临时目录内，与真实 ~/.deepcodeX 完全隔离。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ServerResponse } from "node:http";

import { formatGlobalRulesPrompt, globalRulesFilePath, readGlobalRulesFile } from "@vegamo/deepcode-core";

import { handleCreateRule, handleDeleteRule, handleListRules } from "../src/api/rules-api";
import { createResolvedSettings } from "./helpers";
import type { AuthContext } from "../src/user-identity";

/** 每个用例独立的临时引擎数据根 + 固定 userId */
function makeFixture() {
  const engineHomeRoot = mkdtempSync(path.join(tmpdir(), "dcx-rules-test-"));
  const resolved = createResolvedSettings({ personalOnly: true, engineHomeRoot });
  const ctx: AuthContext = {
    sub: "desktop",
    authSource: "local",
    iat: 0,
    exp: 4102444800,
    userId: "u-test-0001",
  };
  const homeRoot = path.join(engineHomeRoot, ctx.userId);
  const rulesFile = path.join(homeRoot, ".deepcodeX", "rules", "global-rules.json");
  return { resolved, ctx, rulesFile, homeRoot };
}

/** 构造最小 res 鸭子类型（sendJson 仅使用 writeHead + end，与 agents-api.test 同构） */
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

/** 最小 req 假体（readJsonBody 兼容 async iterator 形态，与 agents-api.test 同构） */
function makeReq(body: unknown): any {
  const raw = Buffer.from(JSON.stringify(body));
  return {
    headers: { "content-type": "application/json" },
    [Symbol.asyncIterator]: async function* () {
      yield raw;
    },
  };
}

test("空规则列表：GET 返回空数组", async () => {
  const { resolved, ctx } = makeFixture();
  const { res, status, json } = makeRes();
  await handleListRules(res, resolved, ctx);
  assert.equal(status(), 200);
  assert.deepEqual(json().rules, []);
});

test("POST 创建成功：201 + 落盘 USER-001 / source=user-explicit / severity 归一", async () => {
  const { resolved, ctx, rulesFile, homeRoot } = makeFixture();
  const { res, status, json } = makeRes();
  await handleCreateRule(makeReq({ content: "  始终使用中文回复  ", severity: "INVALID" }), res, resolved, ctx);
  assert.equal(status(), 201);
  const rule = json().rule as { id: string; content: string; source: string; severity: string };
  assert.equal(rule.id, "USER-001");
  assert.equal(rule.content, "始终使用中文回复"); // 服务端 trim
  assert.equal(rule.source, "user-explicit");
  assert.equal(rule.severity, "MAJOR"); // 非法 severity 宽容归一

  // 落盘文件格式：UserRule JSON 数组（与 CLI /rules 同一文件，可被直接读取）
  assert.ok(existsSync(rulesFile), "规则文件应已落盘");
  const fromFile = readGlobalRulesFile(homeRoot);
  assert.equal(fromFile.length, 1);
  assert.equal(fromFile[0].id, "USER-001");
  assert.equal(JSON.parse(readFileSync(rulesFile, "utf8"))[0].category, "code-truth");
});

test("POST 空内容：400；GET 回读列表含已添加规则", async () => {
  const { resolved, ctx } = makeFixture();
  const { res: resEmpty, status: sEmpty } = makeRes();
  await handleCreateRule(makeReq({ content: "   " }), resEmpty, resolved, ctx);
  assert.equal(sEmpty(), 400);

  const { res: resOk, status: sOk } = makeRes();
  await handleCreateRule(makeReq({ content: "禁止使用 var 声明变量", severity: "BLOCKER" }), resOk, resolved, ctx);
  assert.equal(sOk(), 201);

  const { res: resList, json: jsonList } = makeRes();
  await handleListRules(resList, resolved, ctx);
  const rules = jsonList().rules as Array<{ id: string; severity: string }>;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].severity, "BLOCKER");
});

test("连续添加 ID 递增：USER-001 → USER-002", async () => {
  const { resolved, ctx } = makeFixture();
  const { res: res1 } = makeRes();
  await handleCreateRule(makeReq({ content: "规则一" }), res1, resolved, ctx);
  const { res: res2, json: json2 } = makeRes();
  await handleCreateRule(makeReq({ content: "规则二" }), res2, resolved, ctx);
  assert.equal((json2().rule as { id: string }).id, "USER-002");
});

test("DELETE：存在删除 200 + 文件移除；不存在 404", async () => {
  const { resolved, ctx, homeRoot } = makeFixture();
  const { res: resAdd, json: jsonAdd } = makeRes();
  await handleCreateRule(makeReq({ content: "待删除规则" }), resAdd, resolved, ctx);
  const id = (jsonAdd().rule as { id: string }).id;

  const { res: resDel, status: sDel } = makeRes();
  await handleDeleteRule(resDel, id, resolved, ctx);
  assert.equal(sDel(), 200);
  assert.ok(!readGlobalRulesFile(homeRoot).some((r) => r.id === id));

  const { res: resMiss, status: sMiss } = makeRes();
  await handleDeleteRule(resMiss, id, resolved, ctx);
  assert.equal(sMiss(), 404);
});

test("formatGlobalRulesPrompt：空列表 null；非空输出含级别标注与内容", () => {
  assert.equal(formatGlobalRulesPrompt([]), null);
  const prompt = formatGlobalRulesPrompt([
    {
      id: "USER-001",
      category: "code-truth",
      severity: "BLOCKER",
      content: "禁止使用 var",
      source: "user-explicit",
      confirmedBy: "auto",
      usageCount: 0,
      violationCount: 0,
      createdAt: "2026-10-31T00:00:00.000Z",
    },
  ]);
  assert.ok(prompt !== null);
  assert.ok(prompt.includes("# 全局规则"));
  assert.ok(prompt.includes("[BLOCKER] 禁止使用 var"));
});

test("globalRulesFilePath：homeRoot 拼接 .deepcodeX/rules/global-rules.json", () => {
  assert.equal(globalRulesFilePath("/home/u1"), path.join("/home/u1", ".deepcodeX", "rules", "global-rules.json"));
});
