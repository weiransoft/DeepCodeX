/**
 * Soul 文件存储适配层 —— 唯一触碰文件系统的地方
 *
 * ## 位置与形态（2026-11 统一后）
 *
 * ```
 * ~/.deepcode/memory/global.json          全局记忆（与 V2 /memory 同一份）
 * <projectRoot>/.deepcode/memory/project.json 项目记忆
 * ~/.deepcode/soul/config.json            形象、声音、对话模式
 * ```
 *
 * **不再有** `soul/memory.json`：Soul 记忆与 V2 记忆共用一套文件，
 * 旧文件在首次加载时迁移并改名归档（见 `soul-memory-store.ts`）。
 * 分开的理由和 V2 记忆一致：项目事实跟着仓库走（可审查、换人不丢），
 * 个人偏好跟着人走（换项目仍在）。
 *
 * ## 为什么文件权限要 0600
 *
 * 记忆文件**可能**含凭证原文（用户显式录入时）。默认渲染不把它写进提示词，
 * 但磁盘上仍是明文——把权限收到只有本人可读，是这条链路唯一能做的硬防护。
 * V2 侧写入沿用 `MemoryStore` 自己的原子写，权限由那里的实现负责；
 * 配置文件仍由本模块以 0600 写入。
 *
 * ## 写入为什么是 tmp + fsync + rename
 *
 * 配置写入发生在设置面板保存时，随时可能被打断。先写临时文件、fsync 落盘、
 * 再原子 rename，最差情况是丢掉最后一次写入，而不是留下一份坏 JSON。
 *
 * @module super-agent/soul-io
 */

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "../v2/memory/memory-store.js";
import { emptyMemoryFile, normalizeMemoryFile } from "./soul/recall.js";
import { normalizeSoulConfig } from "./soul/config.js";
import { DEFAULT_COMPANION_CONFIG } from "./soul/modes.js";
import { migrateLegacySoulMemory, UnifiedSoulStore } from "./soul-memory-store.js";
import { SoulEngine, type ScopedSoulStore } from "./soul/engine.js";
import type { Soul, SoulCompanionConfig, SoulConfig, SoulMemoryFile, SoulMemoryStore, SoulMode } from "./soul/types.js";

/** V2 记忆目录（相对 HOME 或项目根） */
const MEMORY_DIR = path.join(".deepcode", "memory");

/** 旧版 Soul 目录（仅用于迁移） */
const LEGACY_SOUL_DIR = path.join(".deepcode", "soul");

/** 旧版记忆文件名 */
const LEGACY_MEMORY_FILE = "memory.json";

/** 配置文件权限（仅本人可读写） */
const FILE_MODE = 0o600;

/** 目录权限 */
const DIR_MODE = 0o700;

/**
 * 解析记忆文件路径（统一后就是 V2 的路径）
 *
 * @param scope 作用域
 * @param projectRoot 项目根（scope=project 时必填）
 * @param homeRoot 用户级引擎数据根（Web 多用户场景必须传）
 * @returns 绝对路径
 */
export function soulMemoryPath(scope: SoulMemoryFile["scope"], projectRoot?: string, homeRoot?: string): string {
  if (scope === "project") {
    const root = projectRoot ?? process.cwd();
    return path.join(root, MEMORY_DIR, "project.json");
  }
  // homeRoot 用于 Web 多用户场景：锚定「本用户的引擎数据目录」而不是进程家目录，
  // 否则所有 Web 用户共用同一份 soul 记忆（串号）。
  return path.join(homeRoot ?? os.homedir(), MEMORY_DIR, "global.json");
}

/**
 * 旧版记忆文件路径（只用于迁移与提示）
 *
 * @param scope 作用域
 * @param projectRoot 项目根
 * @param homeRoot 用户级引擎数据根
 * @returns 绝对路径
 */
export function legacySoulMemoryPath(scope: SoulMemoryFile["scope"], projectRoot?: string, homeRoot?: string): string {
  if (scope === "project") {
    const root = projectRoot ?? process.cwd();
    return path.join(root, LEGACY_SOUL_DIR, LEGACY_MEMORY_FILE);
  }
  return path.join(homeRoot ?? os.homedir(), LEGACY_SOUL_DIR, LEGACY_MEMORY_FILE);
}

/**
 * 通用文件存储（单文件版）
 *
 * 默认路径已换成 `UnifiedSoulStore`（与 V2 同一份文件），本类保留用于
 * 离线导出、自定义路径与测试；语义与之前一致。
 *
 * 失败语义刻意「软」：读失败返回空文件（记忆是增强项），写失败向上抛
 * （由 `SoulEngine.persist` 兜住并忽略——不中断任务）。
 */
export class FileSoulStore implements SoulMemoryStore {
  /** 文件路径 */
  private readonly filePath: string;
  /** 作用域 */
  private readonly scope: SoulMemoryFile["scope"];

  /**
   * 构造
   *
   * @param filePath 文件路径
   * @param scope 作用域
   */
  constructor(filePath: string, scope: SoulMemoryFile["scope"]) {
    this.filePath = filePath;
    this.scope = scope;
  }

  /**
   * 读取记忆文件
   *
   * 三种降级：
   * - 文件不存在 → 空文件（首启）；
   * - JSON 损坏 → 原文件改名为 `.corrupted-<时间戳>` 备份后返回空文件；
   * - 形状非法 → 丢弃非法条目，保留合法部分。
   *
   * @returns 记忆文件
   */
  load(): SoulMemoryFile {
    if (!fs.existsSync(this.filePath)) return emptyMemoryFile(this.scope);
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return emptyMemoryFile(this.scope);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.quarantine();
      return emptyMemoryFile(this.scope);
    }
    return normalizeMemoryFile(parsed, this.scope).file;
  }

  /**
   * 写入记忆文件（原子写）
   *
   * @param file 记忆文件
   */
  save(file: SoulMemoryFile): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: DIR_MODE });
    const payload = `${JSON.stringify(file, null, 2)}\n`;
    const tmpPath = `${this.filePath}.tmp`;
    const handle = fs.openSync(tmpPath, "w", FILE_MODE);
    try {
      fs.writeFileSync(handle, payload, "utf8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tmpPath, this.filePath);
    // rename 之后补一次 chmod：先前的 umask 可能放宽了权限
    try {
      fs.chmodSync(this.filePath, FILE_MODE);
    } catch {
      // 某些文件系统（如挂载的只读卷）不支持 chmod，忽略
    }
  }

  /**
   * 取文件路径（供 CLI 展示）
   *
   * @returns 路径
   */
  location(): string {
    return this.filePath;
  }

  /**
   * 把损坏文件移走备份
   */
  private quarantine(): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      fs.renameSync(this.filePath, `${this.filePath}.corrupted-${stamp}`);
    } catch {
      // 备份失败也要保证后续可写：退化为删除
      try {
        fs.unlinkSync(this.filePath);
      } catch {
        // 彻底失败时不再挣扎——下次 save 会重建
      }
    }
  }
}

/**
 * 构造默认存储集合
 *
 * 顺序固定为 `[global, project]`：`SoulEngine` 按顺序合并，
 * 后者覆盖前者，因此项目记忆天然优先。
 *
 * 两者都落在 V2 的 `MemoryStore` 文件上（`global.json` / `project.json`），
 * 于是 `/memory list` 与人格面板看到的是同一批条目。
 *
 * @param projectRoot 项目根（省略则不含项目存储）
 * @param homeRoot 用户级引擎数据根（Web 多用户）
 * @returns 作用域化存储
 */
export function defaultSoulStores(projectRoot?: string, homeRoot?: string): ScopedSoulStore[] {
  const stores: ScopedSoulStore[] = [
    { scope: "global", store: new UnifiedSoulStore(new MemoryStore(null, homeRoot), "global") },
  ];
  if (projectRoot !== undefined && projectRoot.length > 0) {
    stores.push({
      scope: "project",
      store: new UnifiedSoulStore(new MemoryStore(projectRoot, homeRoot), "project"),
    });
  }
  return stores;
}

/**
 * 迁移旧版 `soul/memory.json`（幂等；无旧文件时零副作用）
 *
 * @param projectRoot 项目根
 * @param homeRoot 用户级引擎数据根
 * @returns 迁移报告
 */
export function migrateSoulMemory(projectRoot?: string, homeRoot?: string): ReturnType<typeof migrateLegacySoulMemory> {
  const stores = defaultSoulStores(projectRoot, homeRoot);
  const legacyPaths: { scope: SoulMemoryFile["scope"]; path: string }[] = [
    { scope: "global", path: legacySoulMemoryPath("global", undefined, homeRoot) },
  ];
  if (projectRoot !== undefined && projectRoot.length > 0) {
    legacyPaths.push({ scope: "project", path: legacySoulMemoryPath("project", projectRoot, homeRoot) });
  }
  return migrateLegacySoulMemory(stores, legacyPaths);
}

/**
 * 读取配置里的对话模式（**不写盘**）
 *
 * 与 `loadSoulConfig` 的区别：这个函数只读。页面渲染、引擎构造都会调用它，
 * 若为了读一个模式顺手把 token 落盘，会给只读路径带来意外的写副作用。
 *
 * @param homeRoot 用户级引擎数据根
 * @returns 模式与陪伴配置（配置缺失或损坏时回落默认）
 */
export function readSoulMode(homeRoot?: string): { readonly mode: SoulMode; readonly companion: SoulCompanionConfig } {
  const filePath = soulConfigPath(homeRoot);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const config = normalizeSoulConfig(parsed);
    return { mode: config.mode, companion: config.companion };
  } catch {
    return { mode: "work", companion: DEFAULT_COMPANION_CONFIG };
  }
}

/**
 * 构造并加载 Soul 引擎
 *
 * 模式从配置读（不传 `mode` 时）——「工作/陪伴」是人的偏好，
 * 不该由每个调用方各自决定；显式传参优先（测试与临时会话用）。
 *
 * @param options 选项
 * @returns { engine, soul }
 */
export function createSoulEngine(
  options: {
    readonly projectRoot?: string;
    readonly homeRoot?: string;
    readonly memoryOnly?: boolean;
    readonly mode?: SoulMode;
    readonly companion?: SoulCompanionConfig;
    readonly clock?: () => number;
  } = {}
): { readonly engine: SoulEngine; readonly soul: Soul } {
  const stores = options.memoryOnly === true ? [] : defaultSoulStores(options.projectRoot, options.homeRoot);
  if (options.memoryOnly !== true) {
    // 旧文件迁移：只在旧文件存在时动作，失败不阻塞（记忆读不到也不该让引擎起不来）
    try {
      migrateSoulMemory(options.projectRoot, options.homeRoot);
    } catch {
      // 迁移失败保持旧文件原样，下次再试
    }
  }
  const preset =
    options.memoryOnly === true
      ? { mode: "work" as SoulMode, companion: DEFAULT_COMPANION_CONFIG }
      : readSoulMode(options.homeRoot);
  const engine = new SoulEngine({
    stores,
    mode: options.mode ?? preset.mode,
    companion: options.companion ?? preset.companion,
    clock: options.clock,
  });
  const soul = engine.load();
  return { engine, soul };
}

/**
 * 记忆文件位置说明（CLI / Web 展示用）
 *
 * @param projectRoot 项目根
 * @returns 各作用域路径
 */
export function soulMemoryLocations(
  projectRoot?: string,
  homeRoot?: string
): {
  readonly global: string;
  readonly project?: string;
} {
  return {
    global: soulMemoryPath("global", undefined, homeRoot),
    project: projectRoot === undefined ? undefined : soulMemoryPath("project", projectRoot, homeRoot),
  };
}

/**
 * 是否允许把凭证明文渲染进提示词
 *
 * 默认**不**。只有显式设置环境变量才打开——这是本机调试/终端自查用的开关，
 * 不是常规运行路径。
 *
 * @returns 是否显示明文
 */
export function soulRevealSecretsFromEnv(): boolean {
  const value = process.env.DEEPCODE_SOUL_REVEAL_SECRETS;
  return value === "1" || value === "true";
}

// ---------------------------------------------------------------------------
// 形象与声音配置（config.json）
// ---------------------------------------------------------------------------

/** 配置文件（`~/.deepcode/soul/config.json`） */
const CONFIG_FILE = "config.json";

/** 配置目录：与记忆目录分开——配置是偏好，记忆是事实，别混在一起 */
const CONFIG_DIR = path.join(".deepcode", "soul");

/**
 * 解析配置文件路径
 *
 * 配置跟着**人**走（不是项目），所以只有全局一份——换仓库不该换头像。
 *
 * @param homeRoot 用户级引擎数据根（Web 多用户场景必须传）
 * @returns 绝对路径
 */
export function soulConfigPath(homeRoot?: string): string {
  return path.join(homeRoot ?? os.homedir(), CONFIG_DIR, CONFIG_FILE);
}

/**
 * 原子写 JSON（与记忆写入同一套：tmp + fsync + rename + chmod 0600）
 *
 * @param filePath 目标路径
 * @param value 待写对象
 */
function writeJsonAtomic(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: DIR_MODE });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const tmpPath = `${filePath}.tmp`;
  const handle = fs.openSync(tmpPath, "w", FILE_MODE);
  try {
    fs.writeFileSync(handle, payload, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, FILE_MODE);
  } catch {
    // 只读卷等环境不支持 chmod，忽略（权限已在 open 时给出）
  }
}

/**
 * 读取形象与声音配置
 *
 * 三种降级，与记忆一致：
 * - 文件不存在 → 默认配置 + 生成 token 并落盘（token 必须稳定，否则每次
 *   调用都要重配 sidecar）；
 * - JSON 损坏 → 改名为 `.corrupted-<时间戳>` 备份后回落默认；
 * - 字段非法 → 逐项下调为默认（`normalizeSoulConfig`）。
 *
 * @param homeRoot 用户级引擎数据根
 * @returns 配置 + 文件位置
 */
export function loadSoulConfig(homeRoot?: string): { readonly config: SoulConfig; readonly filePath: string } {
  const filePath = soulConfigPath(homeRoot);
  let parsed: unknown;
  let needPersist = false;

  if (!fs.existsSync(filePath)) {
    needPersist = true;
  } else {
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      // 损坏：备份后按"首次"处理，不让整页 500
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      try {
        fs.renameSync(filePath, `${filePath}.corrupted-${stamp}`);
      } catch {
        // 备份失败继续走默认值
      }
      needPersist = true;
    }
  }

  const existingToken = readToken(parsed);
  const token = existingToken ?? randomUUID().replace(/-/g, "");
  const config = normalizeSoulConfig(parsed, token);

  // token 缺失（首启 / 手改清空）时必须回写，否则 sidecar 校验无从比对
  if (needPersist || existingToken === null) {
    try {
      writeJsonAtomic(filePath, config);
    } catch {
      // 写失败不阻断读取：本次用内存里的 token，下次再试
    }
  }
  return { config, filePath };
}

/**
 * 从原始 JSON 中取 token（缺失返回 null）
 *
 * @param parsed 已解析的 JSON
 * @returns token 或 null
 */
function readToken(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const voice = (parsed as Record<string, unknown>).voice;
  if (typeof voice !== "object" || voice === null) return null;
  const token = (voice as Record<string, unknown>).token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * 保存形象与声音配置（校验后原子写）
 *
 * token 由调用方给出时以调用方为准；为空则沿用已存在的 token，
 * 避免"改个语速把鉴权也改掉"。
 *
 * @param raw 待保存的原始配置（来自请求体，一律视为不可信）
 * @param homeRoot 用户级引擎数据根
 * @returns 落盘后的合法配置
 */
export function saveSoulConfig(
  raw: unknown,
  homeRoot?: string
): { readonly config: SoulConfig; readonly filePath: string } {
  const filePath = soulConfigPath(homeRoot);
  const current = loadSoulConfig(homeRoot).config;
  const config = normalizeSoulConfig(raw, current.voice.token);
  writeJsonAtomic(filePath, config);
  return { config, filePath };
}
