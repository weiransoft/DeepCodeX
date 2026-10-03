/**
 * TTY 冻死防护模块（修复"SSH 断线/终端冻结拖死整个 TUI 后台任务"2026-10-03）。
 *
 * ## 问题机理（P2 上游根因）
 * Ink 渲染器与 stdio-helpers 均直接 `process.stdout.write(...)`。当 SSH 连接劣化、
 * 客户端窗口缩放触发 SIGWINCH 洪泛、或伪终端被销毁时：
 *   1. 终端 pty 写缓冲满 → `stdout.write` 返回 false 且 drain 永不到来；
 *   2. 渲染 tick 持续入队 → 事件循环被背压写占满 → 与 LLM 的网络 IO 一并饿死；
 *   3. 终端销毁后 write 抛 EIO/EPIPE；EPIPE 冒泡终结进程，同步 EIO 冒泡崩溃。
 * 用户端表象：TUI"冻死"，其实后台任务（LLM 请求、工具执行）本应继续。
 *
 * ## 防护策略（对应分析建议三点）
 *   1. 渲染降级：installStdioGuard() 把 stdout/stderr 的 write 包一层——
 *      持续背压（drain 超时）或通道写异常后进入静默模式，渲染路径只消费
 *      不再投递，事件循环立刻恢复服务网络 IO；恢复探测窗口内用零宽字符
 *      探测终端可用性，SSH 恢复则自动复显。
 *   2. EIO/EPIPE 捕获：写路径同步异常吞噬 + 异步回调错误消化为 null +
 *      流级 error 事件吸收，进程不崩。
 *   3. 循环心跳：installLoopHeartbeat() 每轮 agent 循环开始即以 fsync 落盘
 *      心跳行（<sessionFile>.heartbeat，与 sessions jsonl 同目录、不混入
 *      会话文件保证 resume 零污染），卡死/崩溃后可精确定位断点轮次。
 *
 * ## 与既有机制的关系
 * - App.tsx 的 team/rules 命令输出拦截（临时替换 process.stdout.write）：
 *   守卫在安装时记住了"被接管"的引用；宿主恢复原始 write 后若再次调用
 *   installStdioGuard（幂等入口）会自动重新包壳，防护不丢。
 * - 外部替换 write 期间的写入天然绕过守卫（拦截语义正确），不属本模块管控面。
 */

/**
 * 背压 drain 等待超时（毫秒）。
 * 正常终端写入微秒级完成；SSH 卡死时 write 入队后 drain 长时间不到来。
 * 1.5s 足以区分"健康但繁忙"与"通道僵死"，且期间 Ink 至多排队一帧。
 */
const DRAIN_TIMEOUT_MS = 1500;
/** 恢复探测间隔（毫秒）：静默期间每隔该窗口用零宽字符试探终端是否复活 */
const RECOVERY_PROBE_INTERVAL_MS = 10_000;
/** 探测文本为连续零宽空格（不可见、宽度 0，探测成功也不污染界面） */
const RECOVERY_PROBE_TEXT = "\u200B".repeat(32);

/** 守卫视角下的最小写流契约（兼容真实 WriteStream 与测试受控流） */
type GuardableStream = {
  write(chunk: string | Uint8Array, encoding?: unknown, callback?: unknown): boolean;
  readonly destroyed: boolean;
  readonly writableEnded?: boolean;
  readonly writableLength?: number;
  on(event: "error", listener: (err: unknown) => void): unknown;
  once(event: "drain", listener: () => void): unknown;
};

/**
 * 判断错误是否为终端通道类致命错误（值得静默降级）。
 * EPIPE：下游（less/SSH 管道）关闭；EIO：pty 被销毁；EBADF：fd 已关闭。
 * 其余错误（如权限/编码参数错）属调用方 bug，不应触发降级。
 */
function isTtyChannelError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPIPE" || code === "EIO" || code === "EBADF";
}

/** 单条流的守卫状态 */
type GuardState = {
  /** 被包装的原始 write（宿主恢复 write 后据此判断守卫是否仍在链上） */
  readonly originalWrite: GuardableStream["write"];
  /** 当前是否处于静默模式（渲染降级中） */
  silent: boolean;
  /** 恢复探测定时器 */
  recoveryTimer: NodeJS.Timeout | null;
  /** 流级 error 事件是否已挂载（避免重复注册） */
  errorListenerAttached: boolean;
};

const guardStates = new WeakMap<GuardableStream, GuardState>();

/**
 * 兼容执行 write 的回调参数（Node 允许 cb 出现在第 2 或第 3 参位置）。
 * 用微任务投递，避免在同步写路径里重入调用方逻辑。
 */
function scheduleCallback(cb: unknown, err: Error | null): void {
  const fn = typeof cb === "function" ? (cb as (e?: Error | null) => void) : null;
  if (!fn) {
    return;
  }
  queueMicrotask(() => {
    try {
      fn(err);
    } catch {
      // 回调自身异常不影响守卫
    }
  });
}

/** 进入静默模式：停止向卡死通道投递，安排定时恢复探测 */
function enterSilentMode(stream: GuardableStream, state: GuardState): void {
  if (state.silent) {
    return;
  }
  state.silent = true;
  if (state.recoveryTimer) {
    return;
  }
  state.recoveryTimer = setInterval(() => {
    // 流彻底消亡（end/destroy）→ 放弃探测并清理定时器，避免泄漏
    if (stream.destroyed || stream.writableEnded === true) {
      if (state.recoveryTimer) {
        clearInterval(state.recoveryTimer);
        state.recoveryTimer = null;
      }
      return;
    }
    // 探测：零宽字符 + 回调。回调带 error 说明通道仍坏，保持静默；
    // 无 error → 通道复活，退出静默模式恢复渲染。
    try {
      state.originalWrite.call(stream, RECOVERY_PROBE_TEXT, (err?: Error | null) => {
        if (!err) {
          state.silent = false;
          if (state.recoveryTimer) {
            clearInterval(state.recoveryTimer);
            state.recoveryTimer = null;
          }
        }
      });
    } catch {
      // 探测写入同步抛异常（典型 EIO）：维持静默，下个窗口再试
    }
  }, RECOVERY_PROBE_INTERVAL_MS);
  // 定时器不阻止进程退出
  state.recoveryTimer.unref?.();
}

/**
 * 把一条写流的 write 包上"通道异常吞噬 + 静默降级 + 背压看门狗 + 定时复活探测"。
 * 幂等：同一流重复调用时，若当前 write 仍是本守卫产物则直接返回。
 */
function wrapStreamWrites(stream: GuardableStream): void {
  const existing = guardStates.get(stream);
  // 幂等：当前 write 仍是守卫产物时不重复包装；
  // 若宿主（App.tsx 输出拦截）替换过 write 又恢复，守卫已不在链上 → 重装。
  if (existing && stream.write === existing.originalWrite) {
    return;
  }

  const originalWrite = stream.write.bind(stream) as GuardableStream["write"];
  const state: GuardState = {
    originalWrite,
    silent: false,
    recoveryTimer: null,
    errorListenerAttached: false,
  };
  guardStates.set(stream, state);

  // ---- 流级 error 事件吸收（EPIPE 默认行为是抛到 EventEmitter 终结进程） ----
  if (!state.errorListenerAttached) {
    state.errorListenerAttached = true;
    stream.on("error", (err: unknown) => {
      // 仅吸收终端通道类错误；其余错误维持默认语义（无兜底监听器时终结进程）。
      if (isTtyChannelError(err)) {
        enterSilentMode(stream, state);
      }
    });
  }

  const guardedWrite = function guardedWrite(
    this: GuardableStream,
    chunk: string | Uint8Array,
    encoding?: unknown,
    callback?: unknown
  ): boolean {
    // 静默模式：直接"写成功"吞掉。返回 true + 回调 null 双保险——
    // Ink 内部流状态机不卡死、不把错误再抛回渲染循环，事件循环继续服务网络 IO。
    if (state.silent) {
      scheduleCallback(typeof encoding === "function" ? encoding : callback, null);
      return true;
    }
    try {
      // 透传三种重载形态：(chunk, cb) / (chunk, encoding, cb)
      const wrappedCb = (err?: Error | null): void => {
        if (err && isTtyChannelError(err)) {
          // 异步通道错误（如 pty 关闭后排队写失败）：降级静默，对调用方消化为 null
          enterSilentMode(stream, state);
          scheduleCallback(typeof encoding === "function" ? encoding : callback, null);
          return;
        }
        scheduleCallback(typeof encoding === "function" ? encoding : callback, err ?? null);
      };
      let result: boolean;
      if (typeof encoding === "function") {
        result = originalWrite.call(this, chunk, wrappedCb);
      } else {
        result = originalWrite.call(this, chunk, encoding, wrappedCb);
      }
      // 背压看门狗：写返回 false（缓冲满）时挂一次性定时器——
      // DRAIN_TIMEOUT_MS 内未收到 drain 事件即判定通道僵死，进入静默。
      // destroyed 状态豁免：SIGINT 优雅退出会 destroy() 流，那不是"终端卡死"。
      if (!result && !this.destroyed && !state.recoveryTimer) {
        const watchdog = setTimeout(() => {
          // 触发时若通道仍积压（无 drain 且缓冲非空）→ 判定僵死降级
          if (!this.destroyed && (this.writableLength ?? 0) > 0) {
            enterSilentMode(this, state);
          }
        }, DRAIN_TIMEOUT_MS);
        watchdog.unref?.();
        this.once("drain", () => clearTimeout(watchdog));
      }
      // 对调用方恒返回 true：静默/背压细节不外泄，渲染方无需感知
      return true;
    } catch (err) {
      if (isTtyChannelError(err)) {
        // 同步通道异常（典型：pty 销毁后 write 抛 EIO）：吞噬 + 降级
        enterSilentMode(this, state);
        scheduleCallback(typeof encoding === "function" ? encoding : callback, null);
        return true;
      }
      // 非通道错误：维持原语义抛出（调用方 bug 不应被掩盖）
      throw err;
    }
  } as GuardableStream["write"];

  stream.write = guardedWrite;
}

let guardInstalled = false;

/**
 * 安装 TTY 冻死防护（应在进程入口、任何渲染开始之前调用）。
 *
 * 覆盖 process.stdout 与 process.stderr 两条渲染/输出主通道。
 * 对 exec / web 等非 TUI 模式同样安全：管道健康时守卫完全透传，
 * 管道消费端关闭（EPIPE）时从"进程猝死"变为"静默丢弃"，exec 重定向
 * 到慢速消费者（tee/管道）反而更稳。
 *
 * 幂等说明：stdout/stderr 引用通常稳定；若宿主替换过 write 后重新调用
 * 本函数，对仍持有守卫的流为 no-op，对未包装的新流执行安装。
 */
export function installStdioGuard(): void {
  // uncaughtException 兜底只注册一次（重复注册会重复打印/退出）
  if (!guardInstalled) {
    guardInstalled = true;
    // 全局 uncaughtException 兜底：Ink/TtyWriteStream 同步 EIO 抛出若冒泡到
    // 事件循环顶层，进程默认终结——EPIPE/EIO/EBADF 在此吸收；
    // 其余异常维持 Node 默认"打印 + 退出"语义（注册监听器后 Node 不再自动退出）。
    process.on("uncaughtException", (err: unknown) => {
      if (isTtyChannelError(err)) {
        return;
      }
      console.error(err);
      process.exit(1);
    });
  }
  // 流级包装按"当前引用"幂等：宿主替换 write 后重入可对未包装的流自动补装
  wrapStreamWrites(process.stdout as unknown as GuardableStream);
  wrapStreamWrites(process.stderr as unknown as GuardableStream);
}

/**
 * 显式解除两条主通道的静默模式（供测试/宿主主动恢复场景使用）。
 * 正常情况下恢复由守卫的定时零宽探测自动完成，无需手动调用。
 */
export function resetStdioGuardSilence(): void {
  for (const stream of [process.stdout, process.stderr]) {
    const state = guardStates.get(stream as unknown as GuardableStream);
    if (state) {
      state.silent = false;
    }
  }
}

// ============================================================================
// 循环心跳（分析建议 #3）——断点提示解析
// ============================================================================
// 心跳写入端位于 core/session.ts 的 appendSessionMessage（每向会话 jsonl 追加
// 一条消息即以 fsync 落一行心跳）。此处提供配套的只读解析端：进程异常终止后
// 重启 CLI，用断点提示精确回答"卡死发生在第几条消息之后"，指导 resume。

import { readFileSync } from "node:fs";

/**
 * 会话心跳文件解析结果：resume 定位所需的最近断点信息。
 */
export type HeartbeatResumeHint = {
  /** 最后一条心跳对应的消息角色（agent 循环推进到哪类消息后失联） */
  readonly lastRole: string;
  /** 最后一条心跳的 ISO 时间戳 */
  readonly lastTime: string;
  /** 心跳总条数（≈失联前会话已落盘的消息数） */
  readonly totalBeats: number;
};

/**
 * 获取会话心跳文件路径（与 core 写入端的命名契约保持单一事实源：
 * 心跳文件 = 会话 jsonl 路径 + ".heartbeat"）。
 */
export function loopHeartbeatFile(sessionFile: string): string {
  return `${sessionFile}.heartbeat`;
}

/**
 * 解析心跳文件，给出 resume 断点提示：最后一条心跳的角色与时间。
 *
 * 用途：进程异常终止（冻死被杀/OOM/断电）后重启 CLI，通过该函数精确回答
 * "上次卡死发生在第 N 条消息落盘之后"，指导用户从对应断点恢复。
 * 文件缺失/为空/行损坏（半行写入）均按"无心跳"处理，绝不抛异常。
 *
 * @param sessionFile 会话 jsonl 绝对路径
 */
export function readHeartbeatResumeHint(sessionFile: string): HeartbeatResumeHint | null {
  let raw: string;
  try {
    raw = readFileSync(loopHeartbeatFile(sessionFile), "utf8");
  } catch {
    return null;
  }
  let last: { t: string; role: string } | null = null;
  let total = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as { t?: string; kind?: string; role?: string };
      if (parsed.kind === "session_append" && typeof parsed.t === "string") {
        last = { t: parsed.t, role: typeof parsed.role === "string" ? parsed.role : "unknown" };
        total += 1;
      }
    } catch {
      // 半行损坏（写入中途被杀）忽略——心跳是尽力观测，不要求事务完整
    }
  }
  if (!last) {
    return null;
  }
  return { lastRole: last.role, lastTime: last.t, totalBeats: total };
}
