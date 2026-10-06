/**
 * 用户会话注册表（docs/dev/web-isolation.md §3.4）。
 *
 * 职责：为每个 Web 登录用户维护私有会话注册表（磁盘历史归属），
 * 替代跨用户共享的 sessions-index.json 扫描（后者无归属者信息）。
 *
 * 存储布局：~/.deepcode/web/chats/<userId>.json
 *
 * 容错策略（与 core sessions-index.json 同取向）：
 * - 文件缺失 / JSON 损坏 → 返回空列表（历史扫描尽力而为，不阻断列表）；
 * - 写入采用 tmp + rename 原子替换，防半写损坏。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { SessionStatus } from "@vegamo/deepcode-core";

/** 注册表内单条会话记录 */
export type RegisteredChat = {
  /** Web 会话 id（SessionPool 分配的 UUID，跨进程重启保持） */
  chatId: string;
  /** 底层引擎会话 id（首个消息前为 null；恢复与归属校验的键之一） */
  sessionId: string | null;
  /** 会话所属项目根目录 */
  projectRoot: string;
  /** 标题摘要（引擎 SessionEntry.summary 回写） */
  title: string | null;
  /** 引擎状态快照 */
  status: SessionStatus;
  createTime: string;
  updateTime: string;
};

/** 注册表文件结构（version 供未来迁移） */
type RegistryFile = {
  version: 1;
  chats: RegisteredChat[];
};

/**
 * 计算指定用户的注册表文件绝对路径。
 *
 * @param userId 用户隔离标识（userIdFromUsername 产物，hex 安全）
 * @param baseDir 可选注册表根目录覆写（生产缺省 ~/.deepcode/web/chats；测试注入临时目录，
 *                避免污染真实用户目录——依赖注入缝合点，非 mock）
 * @returns 注册表文件路径
 */
function registryPath(userId: string, baseDir?: string): string {
  const root = baseDir ?? path.join(homedir(), ".deepcode", "web", "chats");
  return path.join(root, `${userId}.json`);
}

/**
 * 读取指定用户的全部注册会话（docs/dev/web-isolation.md §3.4）。
 *
 * 文件缺失或 JSON 损坏时返回空数组（容错，不抛错）；
 * 条目缺关键字段的脏数据被逐条过滤，不拖垮整表。
 *
 * @param userId 用户隔离标识
 * @param baseDir 可选注册表根目录覆写（测试注入点）
 * @returns 注册会话列表（按 updateTime 降序）
 */
export function loadUserChats(userId: string, baseDir?: string): RegisteredChat[] {
  const filePath = registryPath(userId, baseDir);
  if (!existsSync(filePath)) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    // 损坏容错：视为空表（下次 upsert 会整体重写修复）
    return [];
  }
  const chats = (parsed as { chats?: unknown } | null)?.chats;
  if (!Array.isArray(chats)) {
    return [];
  }
  // 逐条校验关键字段：脏条目丢弃，不阻断其余记录
  return chats
    .filter(
      (item): item is RegisteredChat =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as RegisteredChat).chatId === "string" &&
        typeof (item as RegisteredChat).projectRoot === "string" &&
        typeof (item as RegisteredChat).createTime === "string"
    )
    .sort((a, b) => (a.updateTime < b.updateTime ? 1 : a.updateTime > b.updateTime ? -1 : 0));
}

/**
 * 向用户注册表 upsert 一条会话记录（docs/dev/web-isolation.md §3.4）。
 *
 * 按 chatId 匹配：已存在则整体替换，否则追加。写入为原子替换
 * （tmp 文件 + rename），进程崩溃不会留下半写文件。
 *
 * 【sessionId 级去重（2026-10-07 新增）】当新条目 sessionId 非空时，
 * 同表内 sessionId 相同但 chatId 不同的旧条目会被**原子过滤掉**。
 * 原因：remount（createChat with sessionId）每次生成新 chatId 并 upsert，
 * 但底层 sessionId 相同 → 旧 chatId 的同 sessionId 条目变成脏数据（用户
 * 侧栏不会看到重复条目，因为 listChats 按 sessionId 做了 Map 去重，
 * 但磁盘注册表多了冗余记录）。remount 场景下新 chatId 条目是"最新入口"，
 * 旧 chatId 条目不再被任何前端引用——清理后注册表保持每 sessionId 一条。
 *
 * 原子性：读旧表 → 过滤 → 写新表在一次调用内完成，并发 remount 不会丢数据
 * （最后一次 rename 是原子替换，两个并发 upsert 对同一 sessionId 各自过滤后
 * 写入，最终保留的是 updateTime 最新的那条）。
 *
 * @param userId 用户隔离标识
 * @param entry 待登记的会话记录
 * @param baseDir 可选注册表根目录覆写（测试注入点）
 */
export function upsertUserChat(userId: string, entry: RegisteredChat, baseDir?: string): void {
  const filePath = registryPath(userId, baseDir);
  const dir = path.dirname(filePath);
  // 目录就绪（幂等）；创建失败交给下方 writeFileSync 自然报错
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // 已存在等场景忽略
  }

  // 读取现有表（损坏视为空，随后整体重写即修复）
  const existing = loadUserChats(userId, baseDir);

  // —— sessionId 级去重：新条目 sessionId 非空时，过滤掉同 sessionId 但 chatId 不同的旧条目 ——
  // null/undefined 的 sessionId（新建 chat 尚未绑定引擎会话）不触发清理，
  // 否则会把同 sessionId 的活跃 remount 条目也误删（entry 本身可能就是新 remount 条目）
  let cleaned: RegisteredChat[];
  if (entry.sessionId !== null && entry.sessionId !== undefined) {
    cleaned = existing.filter(
      (item) =>
        // 保留本次 upsert 目标（chatId 相同的条目无论 sessionId 是否变化都保留，后续会被整体替换）
        item.chatId === entry.chatId ||
        // 或 sessionId 不同（非本次去重目标）
        item.sessionId !== entry.sessionId
    );
  } else {
    cleaned = existing;
  }

  // 按 chatId 匹配更新/追加（在已过滤的 cleaned 数组上操作）
  const index = cleaned.findIndex((item) => item.chatId === entry.chatId);
  if (index >= 0) {
    cleaned[index] = entry;
  } else {
    cleaned.push(entry);
  }

  const file: RegistryFile = { version: 1, chats: cleaned };
  // tmp 名必须每次唯一：同进程多个轮次并发回写（如两个会话几乎同时 done）时，
  // 仅含 pid 的 tmp 名会发生「A rename 走 tmp → B rename ENOENT」冲突导致丢回写；
  // 追加随机后缀使每次 upsert 的 tmp 互不相干（rename 在同目录下仍为原子替换）
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(file, null, 2), "utf8");
  renameSync(tmpPath, filePath);
}

/**
 * 在用户注册表中按底层 sessionId 查找会话（恢复归属校验用）。
 *
 * @param userId 用户隔离标识
 * @param sessionId 底层引擎会话 id
 * @param baseDir 可选注册表根目录覆写（测试注入点，语义同 loadUserChats）
 * @returns 命中的注册记录；未命中返回 undefined
 */
export function findChatBySessionId(userId: string, sessionId: string, baseDir?: string): RegisteredChat | undefined {
  return loadUserChats(userId, baseDir).find((item) => item.sessionId === sessionId);
}
