/**
 * Interruption Recovery（V3 完整版）
 *
 * 来源：multi-agent-team skill scripts/dynamic_workflow/interruption_recovery.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 核心职责：
 *   1. 检测中断信号（SIGINT / SIGTERM / 进程退出）
 *   2. 保存运行时状态（checkpoint）
 *   3. 重启时恢复 + 续跑
 *
 * 设计约束：
 *   - 🔴 持久化复用：状态写入 .deepcodex/runs/<runId>/checkpoint.json
 *   - 🔴 安全：保存前 fsync 落盘
 *   - 🔴 原子写入：tmp + rename 模式
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// 类型定义
// ============================================================================

/** 恢复策略 */
export type RecoveryStrategy = "restart" | "skip" | "fail" | "manual";

/** 检查点 */
export interface Checkpoint {
  run_id: string;
  pattern_id: string | null;
  task_id: string | null;
  iteration_index: number;
  state_snapshot: Record<string, unknown>;
  pending_actions: string[];
  created_at: number;
  updated_at: number;
  schema_version: number;
}

/** 恢复状态 */
export interface RecoveryState {
  run_id: string;
  has_checkpoint: boolean;
  checkpoint: Checkpoint | null;
  recovery_strategy: RecoveryStrategy;
  reason: string;
}

export function defaultRecoveryState(): RecoveryState {
  return {
    run_id: "",
    has_checkpoint: false,
    checkpoint: null,
    recovery_strategy: "manual",
    reason: "no checkpoint found",
  };
}

// ============================================================================
// 异常
// ============================================================================

export class InterruptionRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterruptionRecoveryError";
  }
}

export class CheckpointCorruptedError extends InterruptionRecoveryError {
  constructor(runDir: string) {
    super(`checkpoint 已损坏：${runDir}`);
    this.name = "CheckpointCorruptedError";
  }
}

// ============================================================================
// InterruptionRecovery
// ============================================================================

const SCHEMA_VERSION = 1;
const CHECKPOINT_FILENAME = "checkpoint.json";
const BACKUP_FILENAME = "checkpoint.json.bak";

export class InterruptionRecovery {
  private readonly runBaseDir: string;
  private readonly log: (level: string, message: string) => void;
  private installed: boolean = false;
  private signalHandlers: Map<string, NodeJS.SignalsListener> = new Map();
  private beforeExitHandler: (() => void) | null = null;
  private saveCallback: ((runId: string) => Checkpoint | null) | null = null;

  constructor(args: { runsDir: string; log?: (level: string, message: string) => void }) {
    this.runBaseDir = path.resolve(args.runsDir);
    this.log =
      args.log ??
      ((l, m) => {
        if (l === "warn" || l === "error") console.warn(`[interruption_recovery] ${m}`);
      });
  }

  /** 注册 save 回调（用于 beforeExit 时获取最新状态） */
  registerSaveCallback(cb: (runId: string) => Checkpoint | null): void {
    this.saveCallback = cb;
  }

  /** 启动监听（SIGINT/SIGTERM/beforeExit） */
  install(): void {
    if (this.installed) return;
    this.installed = true;

    const handler = (signal: NodeJS.Signals) => {
      this.log("info", `收到信号 ${signal}，尝试保存 checkpoint`);
      this.saveAll();
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
    this.signalHandlers.set("SIGINT", handler);
    this.signalHandlers.set("SIGTERM", handler);

    this.beforeExitHandler = () => {
      this.saveAll();
    };
    process.on("beforeExit", this.beforeExitHandler);
  }

  /** 卸载监听 */
  uninstall(): void {
    if (!this.installed) return;
    for (const [signal, handler] of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers.clear();
    if (this.beforeExitHandler !== null) {
      process.removeListener("beforeExit", this.beforeExitHandler);
      this.beforeExitHandler = null;
    }
    this.installed = false;
  }

  /** 保存所有 runId 的 checkpoint */
  private saveAll(): void {
    if (this.saveCallback === null) return;
    try {
      const cp = this.saveCallback("");
      if (cp !== null) {
        this.persist(cp);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log("error", `保存 checkpoint 失败: ${msg}`);
    }
  }

  /** 获取 run 目录 */
  getRunDir(runId: string): string {
    return path.join(this.runBaseDir, runId);
  }

  /** 原子保存 checkpoint */
  persist(cp: Checkpoint): void {
    const runDir = this.getRunDir(cp.run_id);
    if (!fs.existsSync(runDir)) {
      fs.mkdirSync(runDir, { recursive: true });
    }
    cp.updated_at = Date.now();
    cp.schema_version = SCHEMA_VERSION;

    // 备份现有
    const main = path.join(runDir, CHECKPOINT_FILENAME);
    const backup = path.join(runDir, BACKUP_FILENAME);
    if (fs.existsSync(main)) {
      try {
        fs.copyFileSync(main, backup);
      } catch {
        // 备份失败不致命
      }
    }

    // 写 tmp + rename
    const tmp = `${main}.tmp`;
    const fd = fs.openSync(tmp, "w");
    try {
      const json = JSON.stringify(cp, null, 2);
      fs.writeSync(fd, json, 0, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, main);
  }

  /** 加载 checkpoint（缺失返回 null） */
  load(runId: string): Checkpoint | null {
    const runDir = this.getRunDir(runId);
    const main = path.join(runDir, CHECKPOINT_FILENAME);
    const backup = path.join(runDir, BACKUP_FILENAME);
    for (const candidate of [main, backup]) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const raw = fs.readFileSync(candidate, "utf-8");
        const data = JSON.parse(raw) as Checkpoint;
        if (data.schema_version !== SCHEMA_VERSION) continue;
        return data;
      } catch {
        continue;
      }
    }
    return null;
  }

  /** 尝试恢复（缺失或损坏时返回默认状态） */
  tryRecover(args: { runId: string }): RecoveryState {
    const cp = this.load(args.runId);
    if (cp === null) {
      return {
        run_id: args.runId,
        has_checkpoint: false,
        checkpoint: null,
        recovery_strategy: "manual",
        reason: "no checkpoint found",
      };
    }
    return {
      run_id: args.runId,
      has_checkpoint: true,
      checkpoint: cp,
      recovery_strategy: "restart",
      reason: "checkpoint loaded successfully",
    };
  }

  /** 列出所有可恢复的 runId */
  listRecoverableRuns(): string[] {
    if (!fs.existsSync(this.runBaseDir)) return [];
    let entries: string[];
    try {
      entries = fs.readdirSync(this.runBaseDir);
    } catch {
      return [];
    }
    return entries.filter((e) => {
      const runDir = path.join(this.runBaseDir, e);
      if (!fs.statSync(runDir).isDirectory()) return false;
      return fs.existsSync(path.join(runDir, CHECKPOINT_FILENAME));
    });
  }

  /** 删除 checkpoint */
  clear(runId: string): void {
    const runDir = this.getRunDir(runId);
    for (const filename of [CHECKPOINT_FILENAME, BACKUP_FILENAME]) {
      const p = path.join(runDir, filename);
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          // 静默
        }
      }
    }
  }
}

/** 创建默认恢复器 */
export function createDefaultRecovery(args: {
  runsDir: string;
  log?: (level: string, message: string) => void;
}): InterruptionRecovery {
  return new InterruptionRecovery(args);
}
