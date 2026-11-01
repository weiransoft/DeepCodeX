/**
 * 审计端点测试（audit-api，P6）：
 *
 * 覆盖：
 * - GET /api/eag/audit：空态（无规则无台账）返回 200 + 三章节报告
 * - 有规则证据时规则表随规则文件变化（添加规则后 evidenceState=present、计数 0）
 * - 台账条目聚合（预置台账文件后回读）
 * - 报告过 validateAuditReport（渲染器自检）
 * - 只读性：响应后规则文件与台账文件内容不变（record-only 无写副作用）
 *
 * 存储隔离：personalOnly=true + engineHomeRoot 指向 mkdtemp 临时目录，与真实家目录隔离。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ServerResponse } from "node:http";

import { addGlobalRule, validateAuditReport } from "@vegamo/deepcode-core";

import { handleGetAudit } from "../src/api/audit-api";
import { createResolvedSettings } from "./helpers";
import type { AuthContext } from "../src/user-identity";

/** 每个用例独立的临时引擎数据根 + 固定 userId */
function makeFixture() {
  const engineHomeRoot = mkdtempSync(path.join(tmpdir(), "dcx-audit-test-"));
  const resolved = createResolvedSettings({ personalOnly: true, engineHomeRoot });
  const ctx: AuthContext = {
    sub: "desktop",
    authSource: "local",
    iat: 0,
    exp: 4102444800,
    userId: "u-test-0001",
  };
  const homeRoot = path.join(engineHomeRoot, ctx.userId);
  return { resolved, ctx, homeRoot };
}

/** 构造最小 res 鸭子类型（与 rules-api.test 同构） */
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
  return { res, status: () => state.code, json: () => JSON.parse(state.body) };
}

test("空态：GET /api/eag/audit 返回 200、空规则空台账、三章节报告过校验", async () => {
  const { resolved, ctx } = makeFixture();
  const { res, status, json } = makeRes();
  await handleGetAudit(res, resolved, ctx);
  assert.equal(status(), 200);
  const body = json();
  assert.deepEqual(body.rules, []);
  assert.deepEqual(body.ledger, []);
  assert.equal(typeof body.report, "string");
  assert.equal(body.valid, true);
  assert.ok(validateAuditReport(body.report));
});

test("有规则证据：添加规则后规则表含该规则（present / 计数 0）", async () => {
  const { resolved, ctx, homeRoot } = makeFixture();
  addGlobalRule(homeRoot, { content: "提交信息使用中文" });
  const { res, status, json } = makeRes();
  await handleGetAudit(res, resolved, ctx);
  assert.equal(status(), 200);
  const body = json();
  assert.equal(body.rules.length, 1);
  assert.equal(body.rules[0].evidenceState, "present");
  assert.equal(body.rules[0].usageCount, 0);
  assert.equal(body.rules[0].violationCount, 0);
  // 报告含规则行
  assert.ok(body.report.includes(body.rules[0].ruleId));
});

test("台账聚合：预置台账文件后响应含条目，报告含干预记录", async () => {
  const { resolved, ctx, homeRoot } = makeFixture();
  const ledgerFile = path.join(homeRoot, ".deepcodeX", "eag", "intervention-ledger.json");
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  writeFileSync(
    ledgerFile,
    JSON.stringify([
      {
        findingId: "F-TEST-1",
        appliedAt: "2026-10-30T10:00:00.000Z",
        owner: "user",
        expectedEffect: "构建轮次减半",
        verification: { verifiedAt: "2026-11-01T08:00:00.000Z", state: "outcome-supported" },
      },
    ]),
    "utf8"
  );
  const { res, status, json } = makeRes();
  await handleGetAudit(res, resolved, ctx);
  assert.equal(status(), 200);
  const body = json();
  assert.equal(body.ledger.length, 1);
  assert.equal(body.ledger[0].findingId, "F-TEST-1");
  // Outcome-supported 追溯行渲染
  assert.ok(body.report.includes("追溯：verification=outcome-supported"));
  assert.ok(body.report.includes("findingId F-TEST-1"));
});

test("只读性：请求前后规则文件与台账文件内容逐字节不变", async () => {
  const { resolved, ctx, homeRoot } = makeFixture();
  addGlobalRule(homeRoot, { content: "先写测试再实现" });
  const ledgerFile = path.join(homeRoot, ".deepcodeX", "eag", "intervention-ledger.json");
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  writeFileSync(ledgerFile, JSON.stringify([]), "utf8");
  const rulesFile = path.join(homeRoot, ".deepcodeX", "rules", "global-rules.json");
  const rulesBefore = readFileSync(rulesFile, "utf8");
  const ledgerBefore = readFileSync(ledgerFile, "utf8");

  const { res } = makeRes();
  await handleGetAudit(res, resolved, ctx);

  assert.equal(readFileSync(rulesFile, "utf8"), rulesBefore);
  assert.equal(readFileSync(ledgerFile, "utf8"), ledgerBefore);
  assert.ok(existsSync(rulesFile));
});
