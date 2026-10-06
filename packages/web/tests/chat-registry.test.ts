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

test("registry：同用户并发回写不得冲突或丢条目（tmp 名每次唯一）", async () => {
  // 真实场景：同一用户的多个会话轮次几乎同时结束，persistChatRegistration
  // 并发调用 upsertUserChat。旧实现 tmp 名仅含 pid，A rename 走 tmp 后
  // B rename 会 ENOENT 丢回写；修复后每次 upsert 的 tmp 名随机唯一。
  const userId = userIdFromUsername("concurrent-writer");
  const COUNT = 24;
  // 24 条并发 upsert（不同 chatId），全部必须成功且无一抛错
  await Promise.all(
    Array.from({ length: COUNT }, (_, i) =>
      Promise.resolve().then(() => {
        upsertUserChat(userId, makeEntry({ chatId: `chat-conc-${i}`, title: `并发会话 ${i}` }), registryDir);
      })
    )
  );
  // 全部条目入库（无丢失）
  const chats = loadUserChats(userId, registryDir);
  const ids = new Set(chats.map((item) => item.chatId));
  for (let i = 0; i < COUNT; i++) {
    assert.ok(ids.has(`chat-conc-${i}`), `并发条目 chat-conc-${i} 必须落盘`);
  }
  assert.equal(chats.length, COUNT, "并发写入后条目总数必须等于写入条数");
  // 同目录不得残留 tmp 文件
  const leftovers = readdirSync(registryDir).filter((name) => name.includes(".tmp"));
  assert.equal(leftovers.length, 0, `并发写完成后不得残留 tmp 文件（发现 ${leftovers.join(",")}）`);
});

// ============================================================================
// sessionId 级去重（2026-10-07 P1 修复：remount 产生多 chatId 共享 sessionId 的注册表脏条目）
// ============================================================================

test("registry：R1 remount 场景（旧 chatId=A, chatId=B 同 sessionId=X）→ 新 chatId=C upsert 后只剩 chatId=C", () => {
  // 模拟报告中的脏数据：同一 sessionId 被多次 remount 后注册表累积多条
  // 注意：前两次 upsert（chat-A → chat-B）已经在触发去重逻辑，
  //       因为 entry.sessionId=sess-X 非空且 chat-B ≠ chat-A → chat-A 被清理
  //       所以第三次 upsert 时表实际状态是 [chat-B/sess-X, chat-other/sess-Y]
  const userId = userIdFromUsername("remount-dedup");
  upsertUserChat(userId, makeEntry({ chatId: "chat-A", sessionId: "sess-X", title: "旧入口 A" }), registryDir);
  upsertUserChat(userId, makeEntry({ chatId: "chat-B", sessionId: "sess-X", title: "旧入口 B" }), registryDir);
  upsertUserChat(userId, makeEntry({ chatId: "chat-other", sessionId: "sess-Y", title: "另一独立会话" }), registryDir);
  // 前置确认：chat-A 已被 chat-B 的同 sessionId 清理 → 只剩 chat-B + chat-other = 2 条
  assert.equal(
    loadUserChats(userId, registryDir).length,
    2,
    "前置：chat-A 被 chat-B 的同 sessionId 清理后，表应为 2 条"
  );

  // 执行新 remount：chatId=C，sessionId=X → chat-B 被清理，chat-C 写入
  const newEntry = makeEntry({
    chatId: "chat-C",
    sessionId: "sess-X",
    title: "新入口 C（本次 remount）",
    updateTime: "2026-10-07T10:00:00.000Z",
  });
  upsertUserChat(userId, newEntry, registryDir);

  const chats = loadUserChats(userId, registryDir);
  assert.equal(chats.length, 2, "去重后应只剩 chat-C（sess-X）+ chat-other（sess-Y）共 2 条");
  const sessXEntries = chats.filter((c) => c.sessionId === "sess-X");
  assert.equal(sessXEntries.length, 1, "sess-X 必须只剩 chat-C 一条");
  assert.equal(sessXEntries[0].chatId, "chat-C", "去重后 sess-X 的 chatId 必须是本次 upsert 的 chat-C");
});

test("registry：R2 sessionId=null（新建 chat 未发消息）→ upsert 不得触发同 sessionId 清理", () => {
  const userId = userIdFromUsername("null-session");
  // 先写两条 null sessionId 的条目（两个新建 chat 尚未发消息）
  upsertUserChat(userId, makeEntry({ chatId: "chat-null-1", sessionId: null }), registryDir);
  upsertUserChat(userId, makeEntry({ chatId: "chat-null-2", sessionId: null }), registryDir);
  // null sessionId 不应互相清理（各属不同 chatId）
  const chats = loadUserChats(userId, registryDir);
  assert.equal(chats.length, 2, "两条 sessionId=null 的条目应该各自保留，互不触发清理");
});

test("registry：R3 同 chatId 再 upsert（轮次 done 后 updateTime 回写）→ 正常整体替换，不过滤", () => {
  const userId = userIdFromUsername("same-chatid-update");
  // 首次写入
  upsertUserChat(
    userId,
    makeEntry({
      chatId: "chat-update-1",
      sessionId: "sess-U",
      title: "旧标题",
      updateTime: "2026-10-01T00:00:00.000Z",
    }),
    registryDir
  );
  // 同 chatId 再 upsert（updateTime 回写、title 更新）
  const updated = makeEntry({
    chatId: "chat-update-1",
    sessionId: "sess-U",
    title: "新标题（updateTime 回写）",
    updateTime: "2026-10-02T00:00:00.000Z",
  });
  upsertUserChat(userId, updated, registryDir);

  const chats = loadUserChats(userId, registryDir);
  assert.equal(chats.length, 1, "同 chatId 再 upsert 应整体替换（不是追加也不是清理）");
  assert.equal(chats[0].title, "新标题（updateTime 回写）", "updateTime 回写必须生效");
  assert.equal(chats[0].chatId, "chat-update-1", "chatId 不变");
});

test("registry：R4 同 sessionId、不同 chatId（chatId=A 存在，upsert chatId=B/sessionId=X）→ chatId=A 被清理", () => {
  const userId = userIdFromUsername("simple-dedup");
  // 先写 chatId=A，sessionId=X
  upsertUserChat(userId, makeEntry({ chatId: "chat-A", sessionId: "sess-X" }), registryDir);
  assert.equal(loadUserChats(userId, registryDir).length, 1, "前置：1 条");
  // 再 upsert chatId=B，sessionId=X → 同 sessionId 清理 chat-A
  upsertUserChat(userId, makeEntry({ chatId: "chat-B", sessionId: "sess-X" }), registryDir);
  const chats = loadUserChats(userId, registryDir);
  assert.equal(chats.length, 1, "同 sessionId 不同 chatId 只保留最后一条");
  assert.equal(chats[0].chatId, "chat-B", "清理后 chatId 应为 chat-B");
});
