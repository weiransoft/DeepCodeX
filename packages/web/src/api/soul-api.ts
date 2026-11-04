/**
 * Soul 端点（司南的人格与分类记忆）
 *
 * ## 为什么 Web 需要一个 soul 端点
 *
 * Web 是对外展示「这是谁」的主界面。没有它，界面上只有「DeepCodeX 引擎」这种
 * 机构名——用户不知道在跟谁说话，也不知道对方记不记得上次说过的部署方式。
 * 这个端点把 `super-agent/soul` 的那份人格与记忆原样暴露给前端。
 *
 * ## 三个端点
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | GET | `/api/soul` | 人格摘要 + 按类归组的记忆 + 未记录类别 + 提示词预览 |
 * | POST | `/api/soul/memory` | 记一条（分类可显式给，省略则由文本推断）|
 * | DELETE | `/api/soul/memory/:id` | 忘一条 |
 *
 * ## 脱敏纪律（与 `/api/config` 同口径）
 *
 * 凭证类记忆的值**永不下发**：响应里只有 `redacted: true` 与遮蔽串，
 * 明文只在本机 `super soul --reveal-secrets` 的终端里出现。
 * 这条不能靠前端「小心显示」——一旦下发，浏览器缓存、代理日志、截图都会留痕。
 *
 * ## 存储锚点
 *
 * 记忆写在**本用户的引擎数据目录**（`skillsHomeForUser()`）下的
 * `.deepcode/soul/memory.json`，与 Web 的技能/智能体资产同源，避免多用户串号。
 *
 * @module web/api/soul-api
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  allCategories,
  categoryHints,
  categoryLabel,
  createSoulEngine,
  loadSoulConfig,
  saveSoulConfig,
  soulConfigPath,
  soulMemoryLocations,
  VOICE_PRESETS,
  type MemoryCategory,
  type SoulConfig,
  type SoulSnapshot,
} from "@vegamo/deepcode-core";
import { ApiError, readJsonBody, sendJson } from "../http-utils";
import { skillsHomeForUser, type EngineHomeSettings } from "../engine-home";
import type { AuthContext } from "../user-identity";

/** GET /api/soul 响应体 */
export type SoulResponse = {
  /** 人格与记忆快照（凭证已遮蔽） */
  snapshot: SoulSnapshot;
  /** 记忆文件位置（便于用户直接查看/备份） */
  locations: { global: string; project?: string };
  /** 分类清单（UI 空态引导：这一类该记什么） */
  categories: readonly { id: string; label: string; hint: string }[];
};

/** POST /api/soul/memory 请求体 */
type RememberBody = {
  text?: unknown;
  title?: unknown;
  category?: unknown;
};

/** POST /api/soul/memory 响应体 */
export type RememberSoulResponse = {
  ok: true;
  /** 新增还是覆盖 */
  action: "created" | "updated";
  /** 归类结果 */
  category: MemoryCategory;
  categoryLabel: string;
  /** 归类置信度 0~1 */
  confidence: number;
  /** 命中关键词（解释「为什么归到这一类」） */
  matched: string[];
  /** 是否由默认规则回落 */
  fallback: boolean;
  /** 是否为凭证（值不会下发） */
  secret: boolean;
  /** 刷新后的快照 */
  snapshot: SoulSnapshot;
};

/**
 * 处理 GET /api/soul
 *
 * @param res 响应对象
 * @param ctx 认证上下文（用于解析 per-user 记忆根）
 * @param settings Web 配置（提供 personalOnly / engineHomeRoot / skillsHomeRoot）
 */
export function handleGetSoul(
  res: ServerResponse,
  ctx: AuthContext,
  settings: EngineHomeSettings & { skillsHomeRoot?: string | null }
): void {
  const homeRoot = skillsHomeForUser(settings, ctx.userId);
  const { engine } = createSoulEngine({ homeRoot });
  const snapshot = engine.snapshot();
  const payload: SoulResponse = {
    snapshot,
    locations: soulMemoryLocations(undefined, homeRoot),
    categories: categoryHints(),
  };
  sendJson(res, 200, payload);
}

/**
 * 处理 POST /api/soul/memory
 *
 * 校验：`text` 必须是非空字符串且不超过 2000 字（记忆是事实短句，不是文档）。
 *
 * @param req 请求对象
 * @param res 响应对象
 * @param ctx 认证上下文
 * @param settings Web 配置
 */
export async function handleRememberSoul(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthContext,
  settings: EngineHomeSettings & { skillsHomeRoot?: string | null }
): Promise<void> {
  const body = (await readJsonBody(req)) as RememberBody;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length === 0) throw new ApiError(400, "记忆内容不能为空");
  if (text.length > 2000) throw new ApiError(400, "记忆内容过长（上限 2000 字）");

  const category = parseCategory(body.category);
  const title = typeof body.title === "string" && body.title.trim().length > 0 ? body.title.trim() : undefined;

  const homeRoot = skillsHomeForUser(settings, ctx.userId);
  const { engine } = createSoulEngine({ homeRoot });
  const result = engine.remember({ text, category, title });

  const payload: RememberSoulResponse = {
    ok: true,
    action: result.action,
    category: result.memory.category,
    categoryLabel: categoryLabel(result.memory.category),
    confidence: result.confidence,
    matched: [...result.matched],
    fallback: result.fallback,
    secret: result.secret,
    snapshot: engine.snapshot(),
  };
  sendJson(res, 200, payload);
}

/**
 * 处理 DELETE /api/soul/memory/:id
 *
 * @param res 响应对象
 * @param id 记忆 ID
 * @param ctx 认证上下文
 * @param settings Web 配置
 */
export function handleForgetSoul(
  res: ServerResponse,
  id: string,
  ctx: AuthContext,
  settings: EngineHomeSettings & { skillsHomeRoot?: string | null }
): void {
  if (id.length === 0) throw new ApiError(400, "记忆 ID 不能为空");
  const homeRoot = skillsHomeForUser(settings, ctx.userId);
  const { engine } = createSoulEngine({ homeRoot });
  const removed = engine.forget(id);
  if (!removed) throw new ApiError(404, `记忆不存在：${id}`);
  sendJson(res, 200, { ok: true, snapshot: engine.snapshot() });
}

/**
 * 校验分类参数
 *
 * 未知分类按「未指定」处理（交给分类器推断），不报错——
 * 前端下拉框与后端枚举不同步时不该让用户记不下来。
 *
 * @param raw 原始值
 * @returns 合法分类或 undefined
 */
function parseCategory(raw: unknown): MemoryCategory | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const categories = allCategories();
  return categories.includes(raw as MemoryCategory) ? (raw as MemoryCategory) : undefined;
}

// ---------------------------------------------------------------------------
// 形象与声音配置
// ---------------------------------------------------------------------------

/**
 * 下发给前端的配置视图
 *
 * `token` **不下发**：它是引擎与 sidecar 之间的共享密钥，前端不需要也不应该
 * 拿到它——否则任何拿到页面的人都能直接打 sidecar。只告知"是否已配置"。
 */
export type SoulConfigView = {
  avatar: SoulConfig["avatar"];
  voice: Omit<SoulConfig["voice"], "token"> & { hasToken: boolean };
  /** 配置文件位置（便于用户备份） */
  filePath: string;
  /** 音色预设（避免前端再维护一份） */
  presets: readonly { id: string; label: string; description: string }[];
};

/**
 * 配置 → 视图（剥离 token）
 *
 * @param config 配置
 * @param filePath 配置文件位置
 * @returns 视图
 */
function toConfigView(config: SoulConfig, filePath: string): SoulConfigView {
  const { token, ...voice } = config.voice;
  return {
    avatar: config.avatar,
    voice: { ...voice, hasToken: token.length > 0 },
    filePath,
    presets: VOICE_PRESETS,
  };
}

/**
 * 处理 GET /api/soul/config
 *
 * @param res 响应对象
 * @param ctx 认证上下文
 * @param settings Web 配置
 */
export function handleGetSoulConfig(
  res: ServerResponse,
  ctx: AuthContext,
  settings: EngineHomeSettings & { skillsHomeRoot?: string | null }
): void {
  const homeRoot = skillsHomeForUser(settings, ctx.userId);
  const { config, filePath } = loadSoulConfig(homeRoot);
  sendJson(res, 200, toConfigView(config, filePath));
}

/**
 * 处理 PUT /api/soul/config
 *
 * 请求体是关键子集的合并补丁：只传 `avatar` 就只改头像，`voice` 同理。
 * 不做整体替换，是因为前端两个区块各自保存，整体替换会让"改头像"把
 * 语音配置清空——那是很容易踩的坑。
 *
 * @param req 请求对象
 * @param res 响应对象
 * @param ctx 认证上下文
 * @param settings Web 配置
 */
export async function handlePutSoulConfig(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthContext,
  settings: EngineHomeSettings & { skillsHomeRoot?: string | null }
): Promise<void> {
  const body = (await readJsonBody(req)) as { avatar?: unknown; voice?: unknown };
  const homeRoot = skillsHomeForUser(settings, ctx.userId);
  const current = loadSoulConfig(homeRoot);

  const next: SoulConfig = {
    avatar: body.avatar === undefined ? current.config.avatar : (body.avatar as SoulConfig["avatar"]),
    voice: body.voice === undefined ? current.config.voice : (body.voice as SoulConfig["voice"]),
  };
  const saved = saveSoulConfig(next, homeRoot);
  sendJson(res, 200, toConfigView(saved.config, saved.filePath));
}

/**
 * 读取配置（供语音端点复用，避免重复解析）
 *
 * @param ctx 认证上下文
 * @param settings Web 配置
 * @returns 配置 + 路径
 */
export function readSoulConfig(
  ctx: AuthContext,
  settings: EngineHomeSettings & { skillsHomeRoot?: string | null }
): { readonly config: SoulConfig; readonly filePath: string } {
  const homeRoot = skillsHomeForUser(settings, ctx.userId);
  return loadSoulConfig(homeRoot);
}

/**
 * 配置文件位置（语音端点展示"配置在哪"用）
 *
 * @param settings Web 配置
 * @param userId 用户 ID
 * @returns 路径
 */
export function soulConfigLocation(
  settings: EngineHomeSettings & { skillsHomeRoot?: string | null },
  userId: string
): string {
  return soulConfigPath(skillsHomeForUser(settings, userId));
}
