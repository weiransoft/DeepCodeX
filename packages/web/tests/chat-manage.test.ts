/**
 * 会话管理（删除 / 重命名 / 自动标题 / 注册表移除）单测（docs/dev/web-chat-manage.md）。
 *
 * 注入策略（无 mock 框架，与 session-pool.test.ts 同纪律）：
 * - createLLMClient 缝合点注入 ScriptedLLMClient（真实实现 LLMClient 接口的受控客户端）；
 * - classifyLlmClientFactory 缝合点注入 ScriptedClassifierClient（自动标题生成通道）；
 * - createOpenAIClient 缝合点注入真实结构的受控连接句柄；
 * - personalOnly=true 且 uploadDir/engineHomeRoot 均为 mkdtemp 临时目录：
 *   引擎会话索引/消息全部落临时隔离目录（断言磁盘真删语义，不污染真实 home）；
 * - 注册表经 registryBaseDir 注入临时目录。
 *
 * 覆盖：
 * - R1 删除：池内活跃会话（引擎消息文件 + 注册表条目 + 池移除）、池外历史会话、
 *   归属校验（他人 404）、不存在（404）、生成中拒绝（409）；
 * - R2 自动标题：首轮收敛后 LLM 生成 → 引擎 summary 更新 → chat_title 帧 → 注册表落盘；
 * - R3 重命名：titleOverride 优先（listChats）、引擎 summary 同步、注册表落盘、
 *   空标题 400、用户命名覆盖自动标题；
 * - 注册表 removeUserChat：移除 / 幂等 / 其余条目保留。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LLMStreamEvent } from "@vegamo/deepcode-core";
import { getProjectCode } from "@vegamo/deepcode-core";
import { SessionPool } from "../src/session-pool";
import { SseHub, type SseSink } from "../src/events";
import { buildJailRoots } from "../src/jail";
import { loadUserChats, removeUserChat, upsertUserChat } from "../src/chat-registry";
import {
  createControlledOpenAIClientHandle,
  createResolvedSettings,
  makeCtx,
  ScriptedClassifierClient,
  ScriptedLLMClient,
} from "./helpers";

/** 共享临时目录根（每池在其下建独立子目录，全局 after 统一清理） */
let tmpBase: string;
/** 最近一次 createTestPool 的目录三件套（用例断言数据源；池外用例经 dirsOf 共享） */
let uploadDir = "";
let engineHomeRoot = "";
let registryDir = "";
/** 默认测试用户 */
const ctx = makeCtx("tester");
/** 第二用户（归属校验用） */
const ctxOther = makeCtx("intruder");

/** 全部用例创建的 hub/pool（全局 after 统一释放） */
const createdHubs: SseHub[] = [];
const createdPools: SessionPool[] = [];
/** 全部用例创建的临时目录（全局 after 统一清理） */
const tempDirs: string[] = [];

/** 受控 sink 收集的全部 SSE 帧 */
const frames: Array<{ event: string; data: any }> = [];

/** 构造收集帧的受控 sink（真实 SseSink 实现） */
function createCollectingSink(): SseSink {
  return {
    write: (chunk: string | Uint8Array): boolean => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const eventMatch = /event: (.+)\ndata: (.+)\n\n/.exec(text);
      if (eventMatch) {
        try {
          frames.push({ event: eventMatch[1], data: JSON.parse(eventMatch[2]) });
        } catch {
          frames.push({ event: eventMatch[1], data: eventMatch[2] });
        }
      }
      return true;
    },
    close: () => undefined,
  };
}

/** 统计指定 chatId + 事件名的已收帧数 */
function countFrames(chatId: string, event: string): number {
  return frames.filter((frame) => frame.data?.chatId === chatId && frame.event === event).length;
}

/** 轮询等待条件成立（异步收敛用例） */
async function waitForCondition(predicate: () => boolean, timeoutMs = 15000, description = "条件"): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`等待${description}超时 ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 构造测试池（每个用例独立；personalOnly 模式，落点为该池专属个人区临时目录）。
 *
 * 每池独立 mkdtemp 三件套（uploadDir/engineHomeRoot/registryDir）：用例间
 * 引擎消息文件与注册表互不残留，磁盘真删断言不被历史数据污染。
 *
 * @param script 首轮对话流式事件脚本
 * @param titleContent 自动标题通道（classify 客户端）固定返回文本；空串 = 生成失败降级
 * @param yieldDelayMs 流式事件间延时（409 用例借此维持 turnActive 窗口）
 * @param sharedDirs 可选目录复用（池外删除用例：poolB 与 poolA 共享同一部署目录，
 *        模拟进程重启后仅存注册表的场景）
 */
async function createTestPool(
  script: LLMStreamEvent[],
  titleContent = "",
  yieldDelayMs = 0,
  sharedDirs?: { uploadDir: string; engineHomeRoot: string; registryDir: string }
): Promise<SessionPool> {
  uploadDir = sharedDirs?.uploadDir ?? mkdtempSync(path.join(tmpBase, "up-"));
  engineHomeRoot = sharedDirs?.engineHomeRoot ?? mkdtempSync(path.join(tmpBase, "home-"));
  registryDir = sharedDirs?.registryDir ?? mkdtempSync(path.join(tmpBase, "reg-"));
  if (sharedDirs === undefined) {
    tempDirs.push(uploadDir, engineHomeRoot, registryDir);
  }
  const settings = createResolvedSettings({ personalOnly: true, uploadDir, engineHomeRoot });
  const jailRoots = await buildJailRoots(settings.allowRoots);
  const testHub = new SseHub();
  const testPool = new SessionPool(settings, testHub, jailRoots, {
    createLLMClient: () => new ScriptedLLMClient(script, yieldDelayMs),
    // 自动标题通道（classifyLlmClientFactory 同源回退链）：固定返回 titleContent
    ...(titleContent !== "" ? { classifyLlmClientFactory: () => new ScriptedClassifierClient(titleContent) } : {}),
    createOpenAIClient: () => createControlledOpenAIClientHandle(),
    registryBaseDir: registryDir,
  });
  createdHubs.push(testHub);
  createdPools.push(testPool);
  return testPool;
}

/** 订阅指定 chatId 的事件到共享 frames（订阅最新创建的池的 hub） */
function subscribeFrames(chatId: string): void {
  const testHub = createdHubs[createdHubs.length - 1];
  testHub.addSink(chatId, createCollectingSink());
}

/** 发送一条消息并等待其收敛落盘（注册表条目 status=completed 且 sessionId 非空） */
async function runOneTurn(pool: SessionPool, chatId: string, text: string): Promise<void> {
  pool.sendMessage(chatId, { text }, ctx);
  await waitForCondition(
    () => {
      const chat = loadUserChats(ctx.userId, registryDir).find((item) => item.chatId === chatId);
      return chat !== undefined && chat.sessionId !== null && chat.status === "completed";
    },
    20000,
    "轮次收敛并落盘注册表"
  );
}

/** 取指定 chat 的注册表条目（sessionId / title 断言数据源） */
function registeredChat(chatId: string) {
  return loadUserChats(ctx.userId, registryDir).find((item) => item.chatId === chatId);
}

/** 引擎消息 JSONL 所在目录（personalOnly：engineHomeRoot/<userId>/.deepcode/projects/<code>） */
function engineProjectDir(projectRoot: string): string {
  return path.join(engineHomeRoot, ctx.userId, ".deepcode", "projects", getProjectCode(projectRoot));
}

before(() => {
  tmpBase = mkdtempSync(path.join(tmpdir(), "deepcode-web-manage-"));
});

after(() => {
  for (const hub of createdHubs) {
    hub.closeAll();
  }
  for (const pool of createdPools) {
    try {
      pool.disposeAll();
    } catch {
      // 引擎可能已释放，尽力而为
    }
  }
  createdHubs.length = 0;
  createdPools.length = 0;
  rmSync(tmpBase, { recursive: true, force: true });
});

// ============================================================================
// removeUserChat：注册表条目移除
// ============================================================================

test("registry：removeUserChat 移除指定条目，其余保留，重复移除幂等", () => {
  const base = {
    projectRoot: uploadDir,
    sessionId: null,
    status: "completed" as const,
    createTime: "2026-11-02T00:00:00.000Z",
    updateTime: "2026-11-02T00:00:00.000Z",
  };
  upsertUserChat(ctx.userId, { ...base, chatId: "chat-a", title: "A" }, registryDir);
  upsertUserChat(ctx.userId, { ...base, chatId: "chat-b", title: "B" }, registryDir);

  removeUserChat(ctx.userId, "chat-a", registryDir);
  const remaining = loadUserChats(ctx.userId, registryDir);
  assert.equal(remaining.length, 1, "移除后仅剩 1 条");
  assert.equal(remaining[0].chatId, "chat-b", "保留的是未移除条目");

  // 幂等：移除不存在的条目不抛错
  assert.doesNotThrow(() => removeUserChat(ctx.userId, "chat-a", registryDir));
  assert.equal(loadUserChats(ctx.userId, registryDir).length, 1, "幂等移除后条目数不变");

  // 清理本用例数据（避免污染后续用例断言）
  removeUserChat(ctx.userId, "chat-b", registryDir);
});

// ============================================================================
// R2 自动标题 + R3 重命名
// ============================================================================

test("autoTitle：首轮收敛后 LLM 生成标题 → 引擎 summary / chat_title 帧 / 注册表三路同步", async () => {
  const script: LLMStreamEvent[] = [
    { type: "text_delta", text: "已定位登录页白屏为路由守卫异步时序问题" },
    { type: "message_end", stopReason: "end_turn", usage: null },
  ];
  const pool = await createTestPool(script, "修复登录页白屏问题");
  const { chatId } = await pool.createChat("", ctx);
  subscribeFrames(chatId);
  await runOneTurn(pool, chatId, "登录页打开后一片空白，帮我排查");

  // 自动标题异步生成（15s 超时护栏）：等 chat_title 帧出现
  await waitForCondition(() => countFrames(chatId, "chat_title") > 0, 20000, "自动标题 chat_title 帧");
  const titleFrame = frames.find((f) => f.event === "chat_title")?.data;
  assert.equal(titleFrame?.title, "修复登录页白屏问题", "chat_title 必须携带 LLM 生成的标题");

  const registered = registeredChat(chatId);
  assert.ok(registered?.sessionId, "已收敛会话注册表必有 sessionId");
  assert.equal(registered?.title, "修复登录页白屏问题", "注册表必须落自动标题");

  // listChats 标题为自动标题
  const listed = pool.listChats(ctx).find((c) => c.chatId === chatId);
  assert.equal(listed?.title, "修复登录页白屏问题");

  pool.deleteChat(chatId, ctx);
});

test("renameChat：用户命名覆盖自动标题（titleOverride 优先），引擎 summary 与注册表同步", async () => {
  const script: LLMStreamEvent[] = [
    { type: "text_delta", text: "回复内容" },
    { type: "message_end", stopReason: "end_turn", usage: null },
  ];
  const pool = await createTestPool(script, "自动生成的标题");
  const { chatId } = await pool.createChat("", ctx);
  subscribeFrames(chatId);
  await runOneTurn(pool, chatId, "帮我写一个登录页");

  // 等自动标题生成完成（title 帧计数 = 1），再手动重命名
  await waitForCondition(() => countFrames(chatId, "chat_title") > 0, 20000, "自动标题帧");

  // 首条消息前重命名分支已由同文件其他用例覆盖；此处验证有引擎条目的重命名
  const renamed = pool.renameChat(chatId, ctx, "  用户命名优先  ");
  assert.equal(renamed.title, "用户命名优先", "标题必须 trim");

  // 引擎索引 summary 已同步（经注册表 sessionId 直查池内 manager）
  const sessionId = registeredChat(chatId)?.sessionId;
  assert.ok(sessionId, "重命名时注册表必有 sessionId");
  const internals = pool as unknown as {
    chats: Map<string, { manager: { getSession: (id: string) => { summary: string | null } } }>;
  };
  const manager = internals.chats.get(chatId)?.manager;
  assert.ok(manager, "重命名后池内必须有该会话");
  assert.equal(manager.getSession(sessionId)?.summary, "用户命名优先", "引擎 summary 必须同步用户命名");

  // 注册表条目标题同步
  assert.equal(registeredChat(chatId)?.title, "用户命名优先", "注册表必须落用户命名");

  // listChats 用户命名优先
  const listed = pool.listChats(ctx).find((c) => c.chatId === chatId);
  assert.equal(listed?.title, "用户命名优先", "titleOverride 优先级最高");

  // 空标题 → 400
  assert.throws(
    () => pool.renameChat(chatId, ctx, "   "),
    (error: unknown) => {
      assert.ok((error as { status?: number }).status === 400, "空标题必须 400");
      return true;
    }
  );

  pool.deleteChat(chatId, ctx);
});

test("renameChat：无引擎条目（首条消息前）仅池内 titleOverride，SSE chat_title 帧推送", async () => {
  const pool = await createTestPool([]);
  const { chatId } = await pool.createChat("", ctx);
  subscribeFrames(chatId);

  const renamed = pool.renameChat(chatId, ctx, "我的手动命名");
  assert.equal(renamed.title, "我的手动命名");

  const listed = pool.listChats(ctx).find((c) => c.chatId === chatId);
  assert.equal(listed?.title, "我的手动命名", "listChats 必须取 titleOverride");
  assert.equal(countFrames(chatId, "chat_title"), 1, "重命名必须推送一次 chat_title 帧");

  pool.deleteChat(chatId, ctx);
});

// ============================================================================
// R1 删除
// ============================================================================

test("deleteChat：池内会话真删除（引擎消息文件 + 注册表条目 + 池移除）", async () => {
  const script: LLMStreamEvent[] = [
    { type: "text_delta", text: "回复" },
    { type: "message_end", stopReason: "end_turn", usage: null },
  ];
  const pool = await createTestPool(script);
  const { chatId, projectRoot } = await pool.createChat("", ctx);
  await runOneTurn(pool, chatId, "删除我之前的这段话");

  // 删除前：引擎消息 JSONL 存在（真实落盘）
  const projectDir = engineProjectDir(projectRoot);
  assert.ok(existsSync(projectDir), "删除前项目会话目录必须存在");
  const jsonlBefore = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  assert.ok(jsonlBefore.length > 0, "删除前必须有消息 JSONL");

  pool.deleteChat(chatId, ctx);

  // 池内移除：listChats 不再返回
  assert.equal(
    pool.listChats(ctx).find((c) => c.chatId === chatId),
    undefined,
    "删除后列表不得返回"
  );
  // 注册表条目移除
  assert.equal(registeredChat(chatId), undefined, "删除后注册表不得有条目");
  // 引擎消息文件删除（真删除语义）
  const jsonlAfter = existsSync(projectDir) ? readdirSync(projectDir).filter((f) => f.endsWith(".jsonl")) : [];
  assert.equal(jsonlAfter.length, 0, "删除后消息 JSONL 必须被清理");
});

test("deleteChat：池外历史会话（注册表定位 + 轻量引擎实例删除磁盘记录）", async () => {
  const script: LLMStreamEvent[] = [
    { type: "text_delta", text: "历史回复" },
    { type: "message_end", stopReason: "end_turn", usage: null },
  ];
  const poolA = await createTestPool(script);
  const { chatId, projectRoot } = await poolA.createChat("", ctx);
  await runOneTurn(poolA, chatId, "历史会话的原始消息");

  const projectDir = engineProjectDir(projectRoot);
  assert.ok(
    readdirSync(projectDir).some((f) => f.endsWith(".jsonl")),
    "删除前消息 JSONL 必须存在"
  );

  // 池 B（与 poolA 共享同一部署目录）：池内无该 chat → 走池外注册表定位分支
  //（模拟进程重启后仅存注册表的删除场景）
  const poolB = await createTestPool([], "", 0, { uploadDir, engineHomeRoot, registryDir });
  poolB.deleteChat(chatId, ctx);

  assert.equal(registeredChat(chatId), undefined, "池外删除后注册表条目必须移除");
  // 池 B 合并列表（空池 + 注册表）不得返回
  assert.equal(
    poolB.listChats(ctx).find((c) => c.chatId === chatId),
    undefined,
    "池外删除后合并列表不得返回"
  );
  // 磁盘消息文件真删
  assert.equal(readdirSync(projectDir).filter((f) => f.endsWith(".jsonl")).length, 0, "池外删除后 JSONL 必须清理");
});

test("deleteChat：归属校验（他人 404）与不存在（404）", async () => {
  const pool = await createTestPool([]);
  const { chatId } = await pool.createChat("", ctx);

  // 他人删除 → 404（R5 防枚举）
  assert.throws(
    () => pool.deleteChat(chatId, ctxOther),
    (error: unknown) => {
      assert.ok((error as { status?: number }).status === 404, "他人删除必须 404");
      return true;
    }
  );
  // 删除不存在的会话 → 404
  assert.throws(
    () => pool.deleteChat("nonexistent-chat-id", ctx),
    (error: unknown) => {
      assert.ok((error as { status?: number }).status === 404, "不存在的会话必须 404");
      return true;
    }
  );

  pool.deleteChat(chatId, ctx);
});

test("deleteChat：轮次执行中拒绝（409），收敛后删除成功", async () => {
  // 延时脚本维持 turnActive 窗口
  const script: LLMStreamEvent[] = [
    { type: "text_delta", text: "慢慢回复" },
    { type: "message_end", stopReason: "end_turn", usage: null },
  ];
  const pool = await createTestPool(script, "", 200);
  const { chatId } = await pool.createChat("", ctx);
  pool.sendMessage(chatId, { text: "生成中请勿删除" }, ctx);
  // 等待轮次真正开始（turnActive 置位在 runTurn 入口，异步 microtask 之后）
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.throws(
    () => pool.deleteChat(chatId, ctx),
    (error: unknown) => {
      assert.ok((error as { status?: number }).status === 409, "轮次执行中必须 409");
      return true;
    }
  );

  // 等轮次收敛落盘（不重复发消息，避免排队轮次再次触发 409）
  await waitForCondition(
    () => {
      const chat = registeredChat(chatId);
      return chat !== undefined && chat.sessionId !== null && chat.status === "completed";
    },
    20000,
    "轮次收敛"
  );
  assert.doesNotThrow(() => pool.deleteChat(chatId, ctx), "收敛后删除必须成功");
  assert.equal(registeredChat(chatId), undefined, "删除后注册表必须清空");
});
