/**
 * 临时会话（dispatch 执行载体）与主会话的状态隔离测试
 *
 * 背景（2026-11-02 接线审查）：
 * `runEphemeral` 借用 SessionManager 的真实主循环跑一次角色任务，跑完即弃。
 * 但 `createSession` 内部会无条件写 `this.activeSessionId = sessionId`，
 * 于是临时会话会把「用户当前在聊的会话」这个实例级指针改成自己；
 * 而 `runEphemeral` 的 finally 又把它从会话索引里删掉 —— 留下**指向已删除会话
 * 的悬空 activeSessionId**。
 *
 * 后果（不是理论推演，是链路推导）：
 * - Web：`session-pool` 每轮收尾执行 `chat.sessionId = getActiveSessionId()`，
 *   chat 随即绑定到已删除的会话；下一轮 `getSession()` 取不到 → 新建会话，
 *   用户体感为「用过 /team 之后聊天失忆」。
 * - CLI：`getActiveSessionId()` 同样返回失效 id，下一轮另起会话。
 * - L2 并行：同层多个子任务并发建临时会话，互相覆写，最终值不可预期。
 *
 * 测试约定：node:test + 真实 SessionManager + 桩 LLM 客户端（不引入 mock 框架）。
 *
 * @module core/tests/session-ephemeral-isolation
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../session";
import {
  createSessionTestEnv,
  createTempDir,
  createChatResponse,
  createSkillMatchingResponse,
} from "./fixtures/session-test-env";

// 每个测试文件持有独立 env，避免跨文件全局状态污染
const env = createSessionTestEnv();

afterEach(() => {
  env.cleanup();
});

/**
 * 构造带桩 LLM 客户端的 SessionManager
 *
 * 技能匹配请求（response_format=json_object）返回空技能列表，其余请求返回
 * 一条普通 assistant 回复 —— 覆盖 handleUserPrompt 与 runEphemeral 两条链路。
 */
function createManager(projectRoot: string): SessionManager {
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          if (request?.response_format?.type === "json_object") {
            return createSkillMatchingResponse([]);
          }
          return createChatResponse("assistant reply", { prompt_tokens: 10, completion_tokens: 5 });
        },
      },
    },
  };

  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

/** 跑一次临时会话（模拟 dispatch 注入的 runner） */
async function runOneEphemeral(manager: SessionManager, projectRoot: string): Promise<void> {
  await manager.runEphemeral({
    roleId: "coder",
    roleName: "Coder",
    systemPrompt: "You are the coder role.",
    task: "做一个最小改动",
    projectRoot,
    maxToolRounds: 1,
    requireApproval: true,
  });
}

test("E1: runEphemeral 结束后 activeSessionId 仍指向主会话", async () => {
  const projectRoot = createTempDir(env, "deepcode-ephemeral-");
  const manager = createManager(projectRoot);

  await manager.handleUserPrompt({ text: "第一轮", images: [] });
  const mainSessionId = manager.getActiveSessionId();
  assert.ok(mainSessionId, "主会话应已建立");

  await runOneEphemeral(manager, projectRoot);

  assert.equal(
    manager.getActiveSessionId(),
    mainSessionId,
    "临时会话不得覆盖 activeSessionId（否则留下指向已删除会话的悬空值）"
  );
});

test("E2: 临时会话不进入会话列表（跑完即弃）", async () => {
  const projectRoot = createTempDir(env, "deepcode-ephemeral-");
  const manager = createManager(projectRoot);

  await manager.handleUserPrompt({ text: "第一轮", images: [] });
  await runOneEphemeral(manager, projectRoot);

  const sessions = manager.listSessions();
  assert.equal(sessions.length, 1, `会话列表应只有主会话，实际: ${sessions.length}`);
  assert.equal(sessions[0]?.id, manager.getActiveSessionId());
});

test("E3: 临时会话之后，下一轮普通消息仍复用同一主会话（上下文不断裂）", async () => {
  const projectRoot = createTempDir(env, "deepcode-ephemeral-");
  const manager = createManager(projectRoot);

  await manager.handleUserPrompt({ text: "第一轮", images: [] });
  const mainSessionId = manager.getActiveSessionId();

  await runOneEphemeral(manager, projectRoot);
  await manager.handleUserPrompt({ text: "第二轮", images: [] });

  assert.equal(manager.getActiveSessionId(), mainSessionId, "第二轮的会话被打断说明临时会话污染了 activeSessionId");

  // 两轮用户消息应落在同一会话里
  const messages = manager.listSessionMessages(mainSessionId!);
  const userTexts = messages.filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(userTexts, ["第一轮", "第二轮"]);
});

test("E4: 连续两次临时会话互不影响 activeSessionId", async () => {
  const projectRoot = createTempDir(env, "deepcode-ephemeral-");
  const manager = createManager(projectRoot);

  await manager.handleUserPrompt({ text: "第一轮", images: [] });
  const mainSessionId = manager.getActiveSessionId();

  await runOneEphemeral(manager, projectRoot);
  await runOneEphemeral(manager, projectRoot);

  assert.equal(manager.getActiveSessionId(), mainSessionId);
  assert.equal(manager.listSessions().length, 1);
});

test("E5: 运行中的临时会话不出现在会话列表（ephemeral 标记必须能跨序列化保留）", async () => {
  const projectRoot = createTempDir(env, "deepcode-ephemeral-");
  const manager = createManager(projectRoot);

  await manager.handleUserPrompt({ text: "第一轮", images: [] });
  const mainSessionId = manager.getActiveSessionId();

  // 直接建一个临时会话（不经 runEphemeral，故会话仍在索引里未被清理）
  const ephemeralId = await manager.createSession({ text: "临时任务" }, undefined, {
    ephemeral: true,
    roleSystemPrompt: "You are the coder role.",
  });
  assert.notEqual(ephemeralId, mainSessionId);

  // 修复前 normalizeSessionEntry 会丢掉 ephemeral 字段，导致过滤失效（返回 2 条）
  const sessions = manager.listSessions();
  assert.equal(sessions.length, 1, `临时会话不得进入列表，实际 ${sessions.length} 条`);
  assert.equal(sessions[0]?.id, mainSessionId);
  // 且 getSession 必须仍能读到该标记（自动拒绝分流依赖它）
  assert.equal(manager.getSession(ephemeralId)?.ephemeral, true);
});
