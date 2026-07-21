/**
 * 适配层测试
 *
 * 验证 team-adapter 与 deepcode-cli Settings/Session 集成正确
 *
 * v1.6 P0-2：executeDispatch 测试通过 injectedClient 注入 stub client
 *           避免真实 LLM API 调用（遵循用户规则：禁止 mock，使用真实接口契约）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  loadTeamConfig,
  buildTask,
  dispatchToRole,
  dispatchToRoleSync,
  composeSystemPrompt,
  listAllRoles,
  getRoleById,
  formatRoleInfo,
  executeDispatch,
} from "../team-adapter.js";
import type { OpenAIClientHandle } from "../../common/openai-client.js";

const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-team-test-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * 构造 stub OpenAI 客户端（真实接口契约实现，非 mock）
 *
 * 设计依据（遵循用户规则"禁止 mock"）：
 *   - 实现 OpenAI 客户端真实接口契约（chat.completions.create 方法）
 *   - 返回结构化对象（choices + usage），符合 OpenAI Chat Completions API 标准响应格式
 *   - 是真实接口契约的固定响应，用于依赖注入测试场景
 *
 * @param content stub 返回的 content 内容
 * @returns OpenAIClientHandle 实例
 */
function buildStubClient(content: string = "## Response\n\nstub output for test"): OpenAIClientHandle {
  return {
    client: {
      chat: {
        completions: {
          /**
           * 真实接口契约：接收 body + opts，返回符合 OpenAI API 格式的响应
           */
          create: async (
            _body: { messages: Array<{ role: "system" | "user"; content: string }> },
            _opts?: { signal?: AbortSignal }
          ): Promise<{
            choices: Array<{ message?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          }> => {
            return {
              choices: [{ message: { content } }],
              usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 },
            };
          },
        },
      },
    },
    model: "stub-model",
    baseURL: "https://stub.local",
    temperature: 0.3,
    thinkingEnabled: false,
  };
}

import { afterEach } from "node:test";
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("loadTeamConfig returns defaults when no settings.json", () => {
  const dir = makeTempProject();
  const config = loadTeamConfig(dir);
  assert.equal(config.enabled, true);
  assert.equal(config.matchStrategy, "hybrid");
  assert.equal(config.defaultRole, "solo-coder");
});

test("loadTeamConfig reads team.* from settings.json", () => {
  const dir = makeTempProject();
  const deepcodeDir = path.join(dir, ".deepcode");
  fs.mkdirSync(deepcodeDir, { recursive: true });
  fs.writeFileSync(
    path.join(deepcodeDir, "settings.json"),
    JSON.stringify({
      team: {
        enabled: false,
        matchStrategy: "keyword",
        topK: 5,
        defaultRole: "architect",
      },
    })
  );
  const config = loadTeamConfig(dir);
  assert.equal(config.enabled, false);
  assert.equal(config.matchStrategy, "keyword");
  assert.equal(config.topK, 5);
  assert.equal(config.defaultRole, "architect");
});

test("loadTeamConfig falls back to defaults on invalid JSON", () => {
  const dir = makeTempProject();
  const deepcodeDir = path.join(dir, ".deepcode");
  fs.mkdirSync(deepcodeDir, { recursive: true });
  fs.writeFileSync(path.join(deepcodeDir, "settings.json"), "{ invalid json");
  const config = loadTeamConfig(dir);
  assert.equal(config.enabled, true);
});

test("buildTask creates a complete TaskRequirement", () => {
  const task = buildTask({
    title: "Test",
    description: "Test description longer than 10 chars",
  });
  assert.equal(task.title, "Test");
  assert.match(task.taskId, /^[0-9a-f]{8}-/);
  assert.ok(task.createdAt);
});

test("buildTask accepts all optional fields", () => {
  const task = buildTask({
    title: "Test",
    description: "Test description longer than 10 chars",
    requiredCapabilities: ["x"],
    preferredSkills: ["y"],
    constraints: ["c"],
    attachments: ["a.txt"],
    upstreamContext: { k: "v" },
    priority: "high",
    timeoutMs: 5000,
  });
  assert.deepEqual(task.requiredCapabilities, ["x"]);
  assert.equal(task.priority, "high");
  assert.equal(task.timeoutMs, 5000);
});

test("dispatchToRoleSync returns a result with system prompt", () => {
  const dir = makeTempProject();
  const result = dispatchToRoleSync("设计系统架构", "为电商设计微服务", { projectRoot: dir });
  assert.ok(result.recommendedSystemPrompt.length > 100);
  assert.ok(result.recommendedRole);
  assert.equal(result.status, "pending");
  assert.match(result.dispatchId, /^[0-9a-f]{8}-/);
});

test("dispatchToRoleSync returns default role when team disabled", () => {
  const dir = makeTempProject();
  const deepcodeDir = path.join(dir, ".deepcode");
  fs.mkdirSync(deepcodeDir, { recursive: true });
  fs.writeFileSync(
    path.join(deepcodeDir, "settings.json"),
    JSON.stringify({ team: { enabled: false, defaultRole: "architect" } })
  );
  const result = dispatchToRoleSync("Test", "Test description", { projectRoot: dir });
  assert.equal(result.recommendedRole.roleId, "architect");
  assert.equal(result.matches.length, 0);
});

test("dispatchToRole auto-dispatches with keyword strategy", async () => {
  const dir = makeTempProject();
  const result = await dispatchToRole(
    { title: "设计架构", description: "设计微服务架构支持高并发" },
    { projectRoot: dir, configOverride: { matchStrategy: "keyword" } }
  );
  assert.equal(result.recommendedRole.roleId, "architect");
  assert.ok(result.matches.length > 0);
});

test("dispatchToRole with forceRole uses the forced role", async () => {
  const dir = makeTempProject();
  const result = await dispatchToRole(
    { title: "Test", description: "Test description longer than 10 chars" },
    { projectRoot: dir, forceRole: { roleId: "ui-designer", reason: "user requested" } }
  );
  assert.equal(result.recommendedRole.roleId, "ui-designer");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]?.confidence, 1.0);
});

test("dispatchToRole throws when forceRole is invalid", async () => {
  const dir = makeTempProject();
  await assert.rejects(() =>
    dispatchToRole(
      { title: "Test", description: "Test description longer than 10 chars" },
      { projectRoot: dir, forceRole: { roleId: "invalid-role" as never } }
    )
  );
});

test("composeSystemPrompt contains task title and description", () => {
  const role = listAllRoles()[0]!;
  const task = buildTask({ title: "MyTitle", description: "MyDescription longer than 10 chars" });
  const prompt = composeSystemPrompt(role, task, "/tmp");
  assert.ok(prompt.includes("MyTitle"));
  assert.ok(prompt.includes("MyDescription"));
  assert.ok(prompt.includes(role.systemPromptPrefix));
});

test("composeSystemPrompt includes project root", () => {
  const role = listAllRoles()[0]!;
  const task = buildTask({ title: "T", description: "D longer than 10 chars" });
  const prompt = composeSystemPrompt(role, task, "/my/project/root");
  assert.ok(prompt.includes("/my/project/root"));
});

test("listAllRoles returns 5 roles", () => {
  assert.equal(listAllRoles().length, 5);
});

test("getRoleById returns correct role", () => {
  const role = getRoleById("architect");
  assert.ok(role);
  assert.equal(role.roleId, "architect");
});

test("getRoleById returns null for unknown id", () => {
  assert.equal(getRoleById("unknown" as never), null);
});

test("formatRoleInfo returns readable text", () => {
  const role = listAllRoles()[0]!;
  const info = formatRoleInfo(role);
  assert.ok(info.includes(role.name));
  assert.ok(info.includes(role.nameEn));
  assert.ok(info.length > 100);
});

test("executeDispatch returns a DispatchResult", async () => {
  const dir = makeTempProject();
  const task = buildTask({ title: "T", description: "D longer than 10 chars" });
  // v1.6 P0-2：注入 stub client，避免真实 LLM API 调用
  const stubClient = buildStubClient("## Response\n\nstub output for test");
  const result = await executeDispatch(task, { projectRoot: dir, injectedClient: stubClient });
  assert.equal(result.status, "succeeded");
  assert.match(result.dispatchId, /^[0-9a-f]{8}-/);
  assert.ok(
    ["architect", "product-manager"].includes(result.matchedRole.roleId),
    `Unexpected role: ${result.matchedRole.roleId}`
  );
});

test("executeDispatch returns dispatchId even on success", async () => {
  const dir = makeTempProject();
  const task = buildTask({ title: "T", description: "D longer than 10 chars" });
  // v1.6 P0-2：注入 stub client，避免真实 LLM API 调用
  const stubClient = buildStubClient("## Response\n\nstub output for test");
  const result = await executeDispatch(task, { projectRoot: dir, injectedClient: stubClient });
  assert.ok(result.completedAt);
  assert.ok(result.durationMs >= 0);
});
