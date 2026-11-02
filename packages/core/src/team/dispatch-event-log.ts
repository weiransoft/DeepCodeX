/**
 * dispatch 事件日志（L1-3，2026-11-02）
 *
 * ## 为什么新建而不是复用 RunState（Task 0 评估结论）
 *
 * 评估对象：`autonomous/run-state.ts` 的 `RunState` / `listRuns` / `findLatestResumableRun`。
 *
 * 结论：**不能复用**，理由三条，均为代码事实：
 *
 * 1. **粒度不同**：`RunState` 是「一次 autonomous run 的迭代级快照」——
 *    `state.json` 每次 `persist()` 整文件重写，`history[]` 只有每轮迭代一条记录
 *    （`iterIndex/resultKind/summary/tokens/committed/error`）。dispatch 需要的是
 *    「一次派单内每一次 LLM 调用 / 工具调用」的事件级流水，粒度细一到两级。
 * 2. **写入模型不同**：`RunState.persist()` 是「原子替换 + sha256 校验 + .bak 回滚」，
 *    为「崩溃后能恢复出一个一致状态」服务；事件流要求 **append-only**（历史永不被改写），
 *    与原子替换语义直接冲突——若强行塞进 state.json，每次 append 都要重写全文件，
 *    崩溃点之前的字节也不再可信（无法满足「原事件逐条未变」的审计要求）。
 * 3. **并发模型不同**：`RunState` 一个 run 一个实例，由单进程的 RalphLoopController
 *    独占驱动；dispatch 需要「两次并发 dispatch 各自的 seq 从 1 起、互不交叉」，
 *    这要求 per-runId 独立目录 + 独立计数器，`RunState` 没有该概念。
 *
 * 因此按方案 §6.3 新建本模块，同时**对齐** `RunState` 已验证的两条工程经验：
 * 目录按 runId 隔离（`<root>/<runId>/`）、崩溃后有明确的合成终态（对齐 dsh synthetic closers，
 * 但这里用「追加」而非「截断」，见 `open()`）。
 *
 * ## 落盘约定
 *
 * - 路径：`<projectRoot>/.deepcode/team-runs/<runId>/events.jsonl`
 *   （项目级，与会话数据 `~/.deepcode/` 分离；对齐 CLI `--auto-run-dir` 的项目级约定）
 * - 一行一个 JSON 事件，`seq` 从 1 起单调递增，append-only
 * - 崩溃修复：`open()` 时若末条不是 `dispatch/end`，**追加**一条 `cause: "crashed"` 的
 *   合成终态（不截断、不改写既有行）
 *
 * @module team/dispatch-event-log
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** 事件类型（前 7 类为方案 §6.3 定义；后 5 类为 L2 编排层新增） */
export type DispatchEventType =
  | "dispatch/start"
  | "dispatch/match"
  | "dispatch/expert"
  | "dispatch/llm-call"
  | "dispatch/tool-call"
  | "dispatch/tool-result"
  | "dispatch/end"
  // L2（自动多角色拆解）：一次编排自己的生命周期事件
  | "orchestrate/plan"
  | "orchestrate/subtask-start"
  | "orchestrate/subtask-end"
  | "orchestrate/aggregate"
  | "orchestrate/end";

/** 可作为「流终结」的事件类型 */
export type TerminalEventType = "dispatch/end" | "orchestrate/end";

/** 终态原因 */
export type DispatchEndReason = "completed" | "aborted" | "error" | "max-rounds" | "crashed";

/** 单条事件（落盘结构，字段全部可序列化） */
export interface DispatchEvent {
  /** 单调递增序号（每次 run 从 1 起） */
  seq: number;
  /** 本次派单 ID */
  runId: string;
  /** 事件类型 */
  type: DispatchEventType;
  /** 写入时间（ISO 8601） */
  at: string;
  /** 事件载荷（不同 type 的字段不同，保持 Record 以免 schema 频繁变更） */
  payload: Record<string, unknown>;
}

const EVENTS_FILENAME = "events.jsonl";

/**
 * 生成 runId（时间可排序 + 随机后缀，避免并发碰撞）
 *
 * 与 `autonomous/loop-controller.ts` 的 `generateRunId()` 保持同构风格，
 * 但独立实现：dispatch 的 runId 语义是「一次派单」，与 autonomous 的「一次自主迭代 run」
 * 不是同一实体，共用会产生跨模块的 ID 语义混淆。
 */
export function generateDispatchRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `dispatch-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

/** 解析 JSONL 全文为事件数组（坏行跳过，不抛错——日志读取不能成为新的故障点） */
export function parseDispatchEvents(raw: string): DispatchEvent[] {
  const events: DispatchEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as DispatchEvent;
      if (typeof parsed?.seq === "number" && typeof parsed?.type === "string") {
        events.push(parsed);
      }
    } catch {
      // 半写行（进程在 write 中途被 kill）跳过：后续 append 会补合成终态
      continue;
    }
  }
  return events;
}

/**
 * 事件日志（append-only）
 *
 * 生命周期：`new` → `open()`（崩溃修复）→ 多次 `append()` → `end()`（写终态）。
 * 全程同步写：dispatch 是低频操作，同步写好处的崩溃可见性一致，且避免异步竞态。
 */
export class DispatchEventLog {
  private readonly dir: string;
  private readonly file: string;
  private readonly endType: TerminalEventType;
  private seq = 0;
  private opened = false;

  /**
   * @param runId   本次派单 / 编排的 ID
   * @param dir     落盘目录
   * @param endType 终态事件类型（默认 `dispatch/end`；编排传 `orchestrate/end`）
   *
   * `endType` 是必须的：`open()` 用「末条是否为终态」判崩溃。编排日志末条是
   * `orchestrate/end`，若仍按 `dispatch/end` 比较，每次 open 都会误判为崩溃并
   * 追加一条假终态——日志从此多出一条不存在的失败记录。
   */
  constructor(
    private readonly runId: string,
    dir: string,
    endType: TerminalEventType = "dispatch/end"
  ) {
    this.dir = dir;
    this.file = path.join(dir, EVENTS_FILENAME);
    this.endType = endType;
  }

  /** 默认目录：`<projectRoot>/.deepcode/team-runs/<runId>/` */
  static defaultDir(projectRoot: string, runId: string): string {
    return path.join(projectRoot, ".deepcode", "team-runs", runId);
  }

  /** 事件文件绝对路径（供宿主展示"日志在哪"） */
  get filePath(): string {
    return this.file;
  }

  /** 当前已写入的最大 seq */
  get lastSeq(): number {
    return this.seq;
  }

  /**
   * 打开日志：创建目录、恢复 seq、崩溃修复
   *
   * 幂等：重复调用只在首次生效。
   */
  open(): void {
    if (this.opened) return;
    fs.mkdirSync(this.dir, { recursive: true });

    const existing = this.read();
    if (existing.length > 0) {
      this.seq = existing[existing.length - 1]!.seq;
      const last = existing[existing.length - 1]!;
      if (last.type !== this.endType) {
        // 崩溃修复：追加合成终态（对齐 dsh synthetic closers），绝不截断既有行
        this.append(this.endType, {
          reason: "crashed" satisfies DispatchEndReason,
          cause: "previous-run-not-closed",
          synthetic: true,
          recoveredFromSeq: last.seq,
        });
      }
    }
    this.opened = true;
  }

  /**
   * 追加一条事件
   *
   * @throws 仅在目录不可写时抛出（调用方应 try/catch 并降级为"无日志"，不能让审计设施拖垮业务）
   */
  append(type: DispatchEventType, payload: Record<string, unknown> = {}): DispatchEvent {
    if (!this.opened) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
    const event: DispatchEvent = {
      seq: ++this.seq,
      runId: this.runId,
      type,
      at: new Date().toISOString(),
      payload,
    };
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf-8");
    return event;
  }

  /** 写终态（若已写过终态则跳过，保证只终结一次） */
  end(reason: DispatchEndReason, payload: Record<string, unknown> = {}): DispatchEvent | null {
    const last = this.read().slice(-1)[0];
    if (last?.type === this.endType) return null;
    return this.append(this.endType, { reason, ...payload });
  }

  /** 读取全部事件（用于审计重建 / 测试断言） */
  read(): DispatchEvent[] {
    if (!fs.existsSync(this.file)) return [];
    return parseDispatchEvents(fs.readFileSync(this.file, "utf-8"));
  }
}

/**
 * 从事件流重建一次派单的可读摘要（G5「能查上次为什么选这个角色」）
 *
 * 纯函数：只依赖传入事件数组，便于 CLI / Web 共用与单测。
 */
export function summarizeDispatchEvents(events: ReadonlyArray<DispatchEvent>): {
  runId: string;
  role: string | null;
  confidence: number | null;
  expert: string | null;
  llmCalls: number;
  toolCalls: number;
  endReason: DispatchEndReason | null;
} {
  let role: string | null = null;
  let confidence: number | null = null;
  let expert: string | null = null;
  let llmCalls = 0;
  let toolCalls = 0;
  let endReason: DispatchEndReason | null = null;

  for (const event of events) {
    switch (event.type) {
      case "dispatch/match":
        role = typeof event.payload.roleId === "string" ? event.payload.roleId : role;
        confidence = typeof event.payload.confidence === "number" ? event.payload.confidence : confidence;
        break;
      case "dispatch/expert":
        expert = typeof event.payload.expertId === "string" ? event.payload.expertId : expert;
        break;
      case "dispatch/llm-call":
        llmCalls += 1;
        break;
      // 只统计 tool-result：一次工具调用"发生过"的判据是拿到结果。
      // 若同时统计 tool-call（发起）与 tool-result（完成），同一调用会被数两次；
      // 当前实现只在完成后落一条 tool-result（team-adapter runner 分支）。
      case "dispatch/tool-result":
        toolCalls += 1;
        break;
      case "dispatch/end":
        endReason = (event.payload.reason as DispatchEndReason | undefined) ?? null;
        break;
      default:
        break;
    }
  }

  return {
    runId: events[0]?.runId ?? "",
    role,
    confidence,
    expert,
    llmCalls,
    toolCalls,
    endReason,
  };
}
