/**
 * 用户会话注册表单元测试（src/chat-registry.ts，docs/dev/web-isolation.md §5.1）。
 *
 * 原则（用户硬性规则）：严禁 mock——全部用例经 baseDir 注入 mkdtemp 临时目录，
 * 真实读写磁盘文件（原子写落盘内容、损坏容错、脏条目过滤均为真实 IO 断言）。
 *
 * 覆盖：upsert 新增/更新、按 sessionId 查找（命中/未命中）、文件缺失回空、
 * 损坏 JSON 容错回空、脏条目过滤、updateTime 降序、落盘结构断言。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findChatBySessionId, loadUserChats, upsertUserChat, type RegisteredChat } from "../src/chat-registry";
import { userIdFromUsername } from "../src/user-identity";

/** 注册表根目录注入点（每个用例独立，用后清理） */
let registryDir: string;

before(() => {
  registryDir = path.join(tmpdir(), `deepcode-web-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(registryDir, { recursive: true });
});

after(() => {
  rmSync(registryDir, { recursive: true, force: true });
});

/**
 * 构造一条合法注册记录（字段齐全，测试可按需覆写）。
 *
 * @param overrides 覆盖项
 * @returns 完整 RegisteredChat
 */
function makeEntry(overrides: Partial<RegisteredChat> = {}): RegisteredChat {
  return {
    chatId: overrides.chatId ?? `chat-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: overrides.sessionId ?? null,
    projectRoot: overrides.projectRoot ?? "/tmp/project",
    title: overrides.title ?? "测试会话",
    status: overrides.status ?? "completed",
    createTime: overrides.createTime ?? "2026-01-01T00:00:00.000Z",
    updateTime: overrides.updateTime ?? "2026-01-01T00:00:00.000Z",
  };
}

test("registry：upsert 新增应创建文件并可通过 load 读回", () => {
  const userId = userIdFromUsername("upsert-insert");
  const entry = makeEntry({ chatId: "chat-insert-1" });

  // 前置：文件尚不存在
  assert.ok(!existsSync(path.join(registryDir, `${userId}.json`)), "前置：注册表文件不应存在");

  upsertUserChat(userId, entry, registryDir);

  assert.ok(existsSync(path.join(registryDir, `${userId}.json`)), "upsert 后注册表文件必须存在");
  const chats = loadUserChats(userId, registryDir);
  assert.equal(chats.length, 1, "新增后应恰有一条记录");
  assert.equal(chats[0].chatId, "chat-insert-1");
  assert.equal(chats[0].projectRoot, "/tmp/project");
  assert.equal(chats[0].title, "测试会话");
});

test("registry：upsert 相同 chatId 应整体替换（不产生重复条目）", () => {
  const userId = userIdFromUsername("upsert-update");
  upsertUserChat(userId, makeEntry({ chatId: "chat-dup", title: "旧标题" }), registryDir);
  upsertUserChat(userId, makeEntry({ chatId: "chat-dup", title: "新标题" }), registryDir);

  const chats = loadUserChats(userId, registryDir);
  assert.equal(chats.length, 1, "相同 chatId 的 upsert 必须替换而非追加");
  assert.equal(chats[0].title, "新标题", "重复 upsert 后字段应为新值");
});

test("registry：findChatBySessionId 命中与未命中", () => {
  const userId = userIdFromUsername("find-session");
  upsertUserChat(userId, makeEntry({ chatId: "chat-find", sessionId: "sess-abc-123" }), registryDir);

  const hit = findChatBySessionId(userId, "sess-abc-123", registryDir);
  assert.ok(hit, "已登记的 sessionId 必须命中");
  assert.equal(hit!.chatId, "chat-find");

  const miss = findChatBySessionId(userId, "sess-not-registered", registryDir);
  assert.equal(miss, undefined, "未登记的 sessionId 必须未命中");
});

test("registry：文件缺失时 loadUserChats 容错回空", () => {
  const userId = userIdFromUsername("missing-file");
  assert.ok(!existsSync(path.join(registryDir, `${userId}.json`)));
  assert.deepEqual(loadUserChats(userId, registryDir), [], "文件缺失必须返回空数组而非抛错");
});

test("registry：注册表 JSON 损坏时 loadUserChats 容错回空（AC7）", () => {
  const userId = userIdFromUsername("corrupted");
  // 真实写坏文件（半写/截断的典型形态）
  writeFileSync(path.join(registryDir, `${userId}.json`), '{"version":1,"chats":[{"cha', "utf8");

  assert.deepEqual(loadUserChats(userId, registryDir), [], "损坏 JSON 必须容错为空而非抛错");

  // 容错后 upsert 应整体重写自愈
  upsertUserChat(userId, makeEntry({ chatId: "chat-heal" }), registryDir);
  const healed = loadUserChats(userId, registryDir);
  assert.equal(healed.length, 1, "损坏后 upsert 必须自愈重写");
  assert.equal(healed[0].chatId, "chat-heal");
});

test("registry：脏条目必须被逐条过滤，不拖垮整表", () => {
  const userId = userIdFromUsername("dirty-entries");
  // 手工写含脏条目的注册表：null、缺 chatId、缺 projectRoot、缺 createTime 各一条 + 两条合法
  const raw = {
    version: 1,
    chats: [
      null,
      { sessionId: "no-chat-id", projectRoot: "/p", createTime: "2026-01-01T00:00:00.000Z" },
      { chatId: "no-project-root", createTime: "2026-01-01T00:00:00.000Z" },
      { chatId: "no-create-time", projectRoot: "/p" },
      makeEntry({ chatId: "valid-1", updateTime: "2026-01-03T00:00:00.000Z" }),
      makeEntry({ chatId: "valid-2", updateTime: "2026-01-02T00:00:00.000Z" }),
    ],
  };
  writeFileSync(path.join(registryDir, `${userId}.json`), JSON.stringify(raw), "utf8");

  const chats = loadUserChats(userId, registryDir);
  assert.deepEqual(
    chats.map((item) => item.chatId),
    ["valid-1", "valid-2"],
    "脏条目必须被过滤，仅保留字段齐全的记录"
  );
});

test("registry：loadUserChats 必须按 updateTime 降序返回", () => {
  const userId = userIdFromUsername("sorted");
  upsertUserChat(userId, makeEntry({ chatId: "old", updateTime: "2026-01-01T00:00:00.000Z" }), registryDir);
  upsertUserChat(userId, makeEntry({ chatId: "new", updateTime: "2026-01-05T00:00:00.000Z" }), registryDir);
  upsertUserChat(userId, makeEntry({ chatId: "mid", updateTime: "2026-01-03T00:00:00.000Z" }), registryDir);

  const chats = loadUserChats(userId, registryDir);
  assert.deepEqual(
    chats.map((item) => item.chatId),
    ["new", "mid", "old"],
    "必须按 updateTime 降序（新的在前）"
  );
});

test("registry：落盘内容必须为 version:1 结构（真实文件字节断言）", () => {
  const userId = userIdFromUsername("on-disk-shape");
  const entry = makeEntry({ chatId: "chat-shape", sessionId: "sess-shape" });
  upsertUserChat(userId, entry, registryDir);

  const parsed = JSON.parse(readFileSync(path.join(registryDir, `${userId}.json`), "utf8"));
  assert.equal(parsed.version, 1, "落盘结构必须带 version:1（未来迁移依据）");
  assert.ok(Array.isArray(parsed.chats), "落盘结构必须带 chats 数组");
  assert.equal(parsed.chats.length, 1);
  assert.equal(parsed.chats[0].chatId, "chat-shape");
  assert.equal(parsed.chats[0].sessionId, "sess-shape");
  // 不应残留 tmp 文件（原子写 rename 后 tmp 必须消失）
  const leftovers = readdirSync(registryDir).filter((name) => name.includes(".tmp"));
  assert.equal(leftovers.length, 0, `原子写完成后不得残留 tmp 文件（发现 ${leftovers.join(",")}）`);
});

test("registry：不同用户的注册表相互隔离（各自独立文件）", () => {
  const userA = userIdFromUsername("iso-a");
  const userB = userIdFromUsername("iso-b");
  upsertUserChat(userA, makeEntry({ chatId: "chat-of-a" }), registryDir);
  upsertUserChat(userB, makeEntry({ chatId: "chat-of-b" }), registryDir);

  const chatsA = loadUserChats(userA, registryDir);
  const chatsB = loadUserChats(userB, registryDir);
  assert.deepEqual(
    chatsA.map((item) => item.chatId),
    ["chat-of-a"],
    "A 的注册表只含 A 的会话"
  );
  assert.deepEqual(
    chatsB.map((item) => item.chatId),
    ["chat-of-b"],
    "B 的注册表只含 B 的会话"
  );
});
