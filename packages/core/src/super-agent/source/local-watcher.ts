/**
 * Super Agent 本地文件监听来源（Local Watcher Source）
 *
 * ## 为什么用轮询而不是 fs.watch
 *
 * `fs.watch` 在不同平台行为差异大（macOS 的 FSEvents、Linux 的 inotify、
 * Windows 的 ReadDirectoryChangesW），且对编辑器「原子写」（写临时文件再 rename）
 * 的响应不稳定。**轮询**行为一致、可预测、易测试——
 * 复用既有 `team/hot-reload-watcher.ts` 的轮询模式（不引入新机制）。
 *
 * ## 事件语义
 *
 * - 一次「文件集合的差异」= 一个 Trigger（不是每个文件一个）——避免刷屏。
 * - 同一批差异在轮询窗口内合并，文本里列出变更文件。
 * - 发送者为 `human`（本地开发者）且**默认不寻址**——
 *   是否接单由准入表与 Policy 决定。
 *
 * @module super-agent/source/local-watcher
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { NewTrigger } from "../domain/types.js";
import type { SourceConfig, SourceInstance, SourceKind, TriggerSink } from "./kind.js";

/** Local Watcher 的配置项 */
export interface LocalWatcherConfig {
  /** 监听目录（绝对路径） */
  readonly root: string;
  /** 扫描的扩展名白名单（默认 ["ts","tsx","js","jsx","md","json"]） */
  readonly extensions?: readonly string[];
  /** 忽略的目录名（默认 ["node_modules",".git","dist","build",".deepcodex"]） */
  readonly ignoreDirs?: readonly string[];
  /** 轮询间隔（毫秒，默认 3000） */
  readonly pollIntervalMs?: number;
  /** 是否递归扫描（默认 true） */
  readonly recursive?: boolean;
}

/** Local Watcher kind */
export const localWatcherKind: SourceKind = {
  id: "local-watcher",
  title: "本地文件变更",
  description: "轮询监听工作目录下的文件变化，把变更作为事件投递给 Super Agent。",
  fields: [
    { key: "root", label: "监听目录", description: "要监听的目录（绝对路径）", required: true },
    {
      key: "extensions",
      label: "扩展名白名单",
      description: "逗号分隔，如 ts,tsx,md",
      required: false,
    },
  ],
  create: (options) => new LocalWatcherSource(options.sourceId, options.config, options.sink),
};

/** 默认扩展名白名单 */
const DEFAULT_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "md", "json", "yaml", "yml"];

/** 默认忽略目录 */
const DEFAULT_IGNORE_DIRS = ["node_modules", ".git", "dist", "build", "out", ".deepcodex", "coverage"];

/**
 * LocalWatcherSource —— 轮询式本地文件监听
 */
export class LocalWatcherSource implements SourceInstance {
  /** 实例 ID */
  readonly id: string;
  /** 配置 */
  private readonly config: Required<LocalWatcherConfig>;
  /** 投递回调 */
  private readonly sink: TriggerSink;
  /** 上一次的文件快照 */
  private snapshot = new Map<string, number>();
  /** 定时器 */
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * 构造监听器
   *
   * @param sourceId 实例 ID
   * @param config 配置
   * @param sink 投递回调
   */
  constructor(sourceId: string, config: SourceConfig, sink: TriggerSink) {
    this.id = sourceId;
    this.sink = sink;
    this.config = {
      root: String(config["root"] ?? process.cwd()),
      extensions: (config["extensions"] as readonly string[] | undefined) ?? DEFAULT_EXTENSIONS,
      ignoreDirs: (config["ignoreDirs"] as readonly string[] | undefined) ?? DEFAULT_IGNORE_DIRS,
      pollIntervalMs: Number(config["pollIntervalMs"] ?? 3000),
      recursive: config["recursive"] !== false,
    };
  }

  /** 开始监听 */
  async start(): Promise<void> {
    this.snapshot = this.scan();
    this.timer = setInterval(() => {
      try {
        this.poll();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[super-agent] 本地监听轮询失败: ${message}`);
      }
    }, this.config.pollIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** 停止监听 */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 执行一轮差异检测 */
  private poll(): void {
    const next = this.scan();
    const changed: string[] = [];
    for (const [file, mtime] of next) {
      const previous = this.snapshot.get(file);
      if (previous === undefined || previous !== mtime) {
        changed.push(file);
      }
    }
    for (const file of this.snapshot.keys()) {
      if (!next.has(file)) {
        changed.push(file);
      }
    }
    this.snapshot = next;
    if (changed.length === 0) return;

    const relative = changed.slice(0, 20).map((file) => path.relative(this.config.root, file));
    const suffix = changed.length > 20 ? ` 等 ${changed.length} 个文件` : "";
    const trigger: NewTrigger = {
      sourceId: this.id,
      idempotencyKey: "",
      actor: "local-developer",
      actorKind: "human",
      addressed: false,
      text: `工作目录发生变化：${relative.join("、")}${suffix}`,
      meta: { scope: "file-change", files: relative },
    };
    // 一个「差异批次」= 一个 Thread 键
    this.sink(trigger, [`files:${relative[0] ?? "root"}`]);
  }

  /**
   * 扫描目录，返回文件 → mtime 的映射
   *
   * @returns 快照
   */
  private scan(): Map<string, number> {
    const result = new Map<string, number>();
    const root = path.resolve(this.config.root);
    if (!fs.existsSync(root)) return result;

    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!this.config.recursive) continue;
          if (this.config.ignoreDirs.includes(entry.name)) continue;
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).replace(/^\./, "");
        if (!this.config.extensions.includes(ext)) continue;
        try {
          result.set(full, fs.statSync(full).mtimeMs);
        } catch {
          // 文件在扫描瞬间被删除——跳过即可
        }
      }
    };

    walk(root);
    return result;
  }
}
