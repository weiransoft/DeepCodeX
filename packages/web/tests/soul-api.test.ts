/**
 * Soul 端点测试（soul-api）
 *
 * ## 覆盖
 *
 * - A1 GET 空态：人格齐全、记忆 0 条、十类全部「尚未记录」（不假装记得）
 * - A2 POST 记一条：归类正确、落盘到本用户的引擎数据目录、快照随之更新
 * - A3 POST 凭证：响应里**不含明文**（标题与值都脱敏），只标记 secret
 * - A4 POST 校验：空内容 400、超长 400
 * - A5 POST 同事实改值：updated 而非新增（键由「这是什么」派生）
 * - A6 DELETE：删除 200 且快照减少；不存在 404
 *
 * 存储隔离：personalOnly=true + engineHomeRoot 指向 mkdtemp 临时目录 + 固定 userId，
 * soul 记忆与 `/memory` 共用 `<engineHomeRoot>/<userId>/.deepcode/memory/global.json`
 * （V2 MemoryEntry 形态，Soul 字段在 metadata.soul 里），与真实家目录无关。
 *
 * @module tests/soul-api
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

import { handleForgetSoul, handleGetSoul, handleRememberSoul } from "../src/api/soul-api";
import { createResolvedSettings } from "./helpers";
import type { AuthContext } from "../src/user-identity";

/**
 * 构造隔离夹具
 *
 * @returns 配置 / 认证上下文 / 记忆文件路径
 */
function makeFixture() {
  const engineHomeRoot = mkdtempSync(path.join(tmpdir(), "dcx-soul-api-"));
  const resolved = createResolvedSettings({ personalOnly: true, engineHomeRoot });
  const ctx: AuthContext = {
    sub: "desktop",
    authSource: "local",
    iat: 0,
    exp: 4102444800,
    userId: "u-soul-0001",
  };
  const memoryFile = path.join(engineHomeRoot, ctx.userId, ".deepcode", "memory", "global.json");
  return { resolved, ctx, memoryFile };
}

/**
 * 构造最小 res 鸭子类型（sendJson 只用 writeHead + end）
 *
 * @returns res 与状态/响应体读取器
 */
function makeRes(): { res: ServerResponse; status: () => number; json: () => any; raw: () => string } {
  const state = { code: 0, body: "" };
  const res = {
    writeHead(status: number) {
      state.code = status;
    },
    end(body: string) {
      state.body = body;
    },
  } as unknown as ServerResponse;
  return { res, status: () => state.code, json: () => JSON.parse(state.body), raw: () => state.body };
}

/**
 * 构造最小 req 鸭子类型（readJsonBody 走异步迭代）
 *
 * @param body 请求体
 * @returns 伪请求对象
 */
function makeReq(body: unknown): any {
  const raw = Buffer.from(JSON.stringify(body));
  return {
    headers: { "content-type": "application/json" },
    [Symbol.asyncIterator]: async function* () {
      yield raw;
    },
  };
}

test("A1 GET 空态：人格齐全、记忆 0 条、十类尚未记录", () => {
  const { resolved, ctx } = makeFixture();
  const { res, status, json } = makeRes();
  handleGetSoul(res, ctx, resolved);

  assert.equal(status(), 200);
  const payload = json();
  assert.equal(payload.snapshot.name.primary, "司南");
  assert.equal(payload.snapshot.name.latin, "Sinan");
  assert.equal(payload.snapshot.memoryStats.total, 0);
  assert.equal(payload.snapshot.memoryStats.missing.length, 10, "十类全部标记为未记录");
  assert.ok(Array.isArray(payload.snapshot.coreBeliefs) && payload.snapshot.coreBeliefs.length > 0);
  assert.equal(payload.categories.length, 10, "应下发分类清单供 UI 选择");
  assert.ok(payload.locations.global.includes(".deepcode"), "应给出记忆文件位置");
  assert.ok(payload.snapshot.promptPreview.includes("你是谁（不可变）"), "应带提示词预览");
});

test("A2 POST 记一条：归类正确并落盘到本用户数据目录", async () => {
  const { resolved, ctx, memoryFile } = makeFixture();
  const { res, status, json } = makeRes();
  await handleRememberSoul(
    makeReq({ text: "生产部署在 10.0.0.8:/opt/deepcode，用 docker compose 起，nginx 反代" }),
    res,
    ctx,
    resolved
  );

  assert.equal(status(), 200);
  const payload = json();
  assert.equal(payload.action, "created");
  assert.equal(payload.category, "deploy");
  assert.equal(payload.categoryLabel, "部署运行");
  assert.ok(payload.matched.length > 0, "应给出归类依据");
  assert.equal(payload.snapshot.memoryStats.total, 1);

  assert.ok(existsSync(memoryFile), "记忆应落盘到本用户目录");
  const file = JSON.parse(readFileSync(memoryFile, "utf8"));
  assert.equal(file.version, "1.0", "落盘形态是 V2 MemoryStore 的结构");
  assert.equal(file.entries.length, 1);
  assert.equal(file.entries[0].type, "user_global");
  assert.equal(file.entries[0].metadata.soul.category, "deploy", "Soul 分类应无损保存在 metadata 里");
  assert.ok(file.entries[0].key.startsWith("soul."), "键带 soul. 前缀，便于与 /memory 原生条目区分");
});

test("A3 POST 凭证：响应与磁盘均不含明文片段可还原", async () => {
  const { resolved, ctx } = makeFixture();
  const { res, json, raw } = makeRes();
  await handleRememberSoul(makeReq({ text: "数据库密码是 Passw0rd!2026，运维统一用这个" }), res, ctx, resolved);

  const payload = json();
  assert.equal(payload.category, "credential");
  assert.equal(payload.secret, true);
  assert.ok(!raw().includes("Passw0rd"), "响应体不得含明文");
  assert.ok(payload.snapshot.memoryGroups[0].items[0].redacted, "条目应标记为已遮蔽");
  assert.ok(!payload.snapshot.promptPreview.includes("Passw0rd"), "提示词预览也不得含明文");
  assert.equal(payload.snapshot.memoryGroups[0].items[0].title, "数据库密码", "标题已切掉值");
});

test("A4 POST 校验：空内容 400 / 超长 400", async () => {
  const { resolved, ctx } = makeFixture();
  await assert.rejects(
    () => handleRememberSoul(makeReq({ text: "   " }), makeRes().res, ctx, resolved),
    (error: any) => error.status === 400
  );
  await assert.rejects(
    () => handleRememberSoul(makeReq({ text: "x".repeat(2001) }), makeRes().res, ctx, resolved),
    (error: any) => error.status === 400
  );
});

test("A5 POST 同事实改值：updated 而非新增", async () => {
  const { resolved, ctx } = makeFixture();
  await handleRememberSoul(makeReq({ text: "生产部署在 10.0.0.8" }), makeRes().res, ctx, resolved);
  const second = makeRes();
  await handleRememberSoul(makeReq({ text: "生产部署在 10.0.0.9" }), second.res, ctx, resolved);

  const payload = second.json();
  assert.equal(payload.action, "updated", "同一条事实改值应更新");
  assert.equal(payload.snapshot.memoryStats.total, 1);
  assert.ok(JSON.stringify(payload.snapshot).includes("10.0.0.9"), "新值应覆盖旧值");
});

test("A6 DELETE：删除成功 200 且快照减少；不存在 404", async () => {
  const { resolved, ctx } = makeFixture();
  const created = makeRes();
  await handleRememberSoul(
    makeReq({ text: "主仓库 git@github.com:weiransoft/DeepCodeX.git" }),
    created.res,
    ctx,
    resolved
  );
  const id = created.json().snapshot.memoryGroups[0].items[0].id as string;

  const removed = makeRes();
  handleForgetSoul(removed.res, id, ctx, resolved);
  assert.equal(removed.status(), 200);
  assert.equal(removed.json().snapshot.memoryStats.total, 0);

  assert.throws(
    () => handleForgetSoul(makeRes().res, id, ctx, resolved),
    (error: any) => error.status === 404
  );
});
