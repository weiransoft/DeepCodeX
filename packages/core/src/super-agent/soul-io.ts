/**
 * Soul 文件存储适配层 —— 唯一触碰文件系统的地方
 *
 * ## 位置与形态
 *
 * ```
 * ~/.deepcode/soul/memory.json             全局记忆（跨项目：习惯、常用凭证位置）
 * <projectRoot>/.deepcode/soul/memory.json 项目记忆（项目地址、部署、规范）
 * ```
 *
 * 分开的理由和 V2 记忆一致：项目事实跟着仓库走（可提交、可审查、换人不丢），
 * 个人偏好跟着人走（换项目仍在）。合并成一个文件会出现「把生产密码提交进仓库」
 * 这种事故。
 *
 * ## 为什么文件权限要 0600
 *
 * 这个文件**可能**含凭证原文（用户显式录入时）。默认渲染不把它写进提示词，
 * 但磁盘上仍是明文——把权限收到只有本人可读，是这条链路唯一能做的硬防护。
 *
 * ## 写入为什么是 tmp + fsync + rename
 *
 * 记忆写入发生在对话过程中，随时可能被 Ctrl-C 或进程崩溃打断。
 * 直接覆盖写会出现「半个 JSON」——下次读取整份记忆失效。
 * 先写临时文件、fsync 落盘、再原子 rename，最差情况是丢掉最后一次写入，
 * 而不是丢掉全部记忆。
 *
 * @module super-agent/soul-io
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emptyMemoryFile, normalizeMemoryFile } from "./soul/recall.js";
import { SoulEngine, type ScopedSoulStore } from "./soul/engine.js";
import type { Soul, SoulMemoryFile, SoulMemoryStore } from "./soul/types.js";

/** 全局记忆目录（相对 HOME） */
const GLOBAL_DIR = path.join(".deepcode", "soul");

/** 项目记忆目录（相对项目根） */
const PROJECT_DIR = path.join(".deepcode", "soul");

/** 记忆文件名 */
const MEMORY_FILE = "memory.json";

/** 记忆文件权限（仅本人可读写） */
const FILE_MODE = 0o600;

/** 目录权限 */
const DIR_MODE = 0o700;

/**
 * 解析记忆文件路径
 *
 * @param scope 作用域
 * @param projectRoot 项目根（scope=project 时必填）
 * @returns 绝对路径
 */
export function soulMemoryPath(scope: SoulMemoryFile["scope"], projectRoot?: string, homeRoot?: string): string {
  if (scope === "project") {
    const root = projectRoot ?? process.cwd();
    return path.join(root, PROJECT_DIR, MEMORY_FILE);
  }
  // homeRoot 用于 Web 多用户场景：锚定「本用户的引擎数据目录」而不是进程家目录，
  // 否则所有 Web 用户共用同一份 soul 记忆（串号）。
  return path.join(homeRoot ?? os.homedir(), GLOBAL_DIR, MEMORY_FILE);
}

/**
 * 基于文件的记忆存储
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
 * @param projectRoot 项目根（省略则不含项目存储）
 * @returns 作用域化存储
 */
export function defaultSoulStores(projectRoot?: string, homeRoot?: string): ScopedSoulStore[] {
  const stores: ScopedSoulStore[] = [
    { scope: "global", store: new FileSoulStore(soulMemoryPath("global", undefined, homeRoot), "global") },
  ];
  if (projectRoot !== undefined && projectRoot.length > 0) {
    stores.push({
      scope: "project",
      store: new FileSoulStore(soulMemoryPath("project", projectRoot, homeRoot), "project"),
    });
  }
  return stores;
}

/**
 * 构造并加载 Soul 引擎
 *
 * @param options 选项
 * @returns { engine, soul }
 */
export function createSoulEngine(
  options: {
    readonly projectRoot?: string;
    readonly homeRoot?: string;
    readonly memoryOnly?: boolean;
    readonly clock?: () => number;
  } = {}
): { readonly engine: SoulEngine; readonly soul: Soul } {
  const stores = options.memoryOnly === true ? [] : defaultSoulStores(options.projectRoot, options.homeRoot);
  const engine = new SoulEngine({ stores, clock: options.clock });
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
