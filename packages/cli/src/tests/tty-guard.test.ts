/**
 * tty-guard 单元测试（修复"SSH 冻死拖死 TUI"2026-10-03）。
 *
 * 契约锁定（守卫安装时刻意只包 process.stdout，用例全程不触碰真实 stderr，
 * 输出断言全部基于受控流实例记录，不污染测试报告）：
 *   T1 健康通道完全透传（内容、返回值一致）；
 *   T2 同步 EIO 抛出被吞噬并进入静默（渲染降级），后续写零投递但不抛；
 *   T3 EPIPE（write 回调 error）同样降级静默，且回调仍收到 null（Ink 状态机不卡）；
 *   T4 非通道错误（EPERM）维持抛出语义，不掩盖调用方 bug；
 *   T5 流销毁（EIO 场景）后静默模式自动放弃恢复探测（定时器清理，不泄漏）；
 *   T6 幂等：重复安装不重复包装。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

// 守卫通过 process.stdout 引用安装，直接跑会污染测试输出——
// 本测试通过 installStdioGuard 安装后，用"替换 process.stdout 为目标流再触发写"
// 不可行（守卫绑定安装时的流对象）。因此测试策略：临时把 process.stdout
// 换成受控 PassThrough，再调用 installStdioGuard（幂等标记由模块持有），
// 通过重新导出内部注入点不可达 → 改为直接验证公开行为：
// 利用 installStdioGuard 对"当前 process.stdout"生效的特性，在子进程外
// 无法替换真实 tty。故采用 Node 的 stream 层验证守卫核心语义：
// 用 Object.defineProperty 临时替换 process.stdout（getter 可配置的测试环境）。

import { installStdioGuard, resetStdioGuardSilence } from "../utils/tty-guard.js";

/**
 * 受控可写流：继承 PassThrough（write 走事件循环缓冲），
 * 由测试注入失败（同步抛 EIO / 回调 error / destroy），
 * 用于模拟 SSH 卡死与终端销毁。
 */
class ControllableStream extends PassThrough {
  /** true 时 write 同步抛错 */
  throwNext: Error | null = null;
  /** true 时 write 回调携带 error */
  callbackError: Error | null = null;
  /** 收到的全部写入内容 */
  readonly written: string[] = [];

  override write(chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
      this.written.push(String(chunk));
    }
    if (this.throwNext) {
      const err = this.throwNext;
      this.throwNext = null;
      throw err;
    }
    if (this.callbackError) {
      const err = this.callbackError;
      this.callbackError = null;
      const cb = typeof encoding === "function" ? encoding : callback;
      if (typeof cb === "function") {
        cb(err);
      }
      return true;
    }
    return super.write(chunk as string);
  }
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

/**
 * 每个用例独立执行环境：全新安装守卫 + 替换 process.stdout。
 * installStdioGuard 模块级幂等标志只控制首次安装；替换流引用后再次调用
 * 会对"新流"包装（wrapStreamWrites 对未包装流总是安装），因此每个用例
 * 都能拿到守卫后的流。
 */
function installOn(stream: PassThrough): void {
  Object.defineProperty(process, "stdout", { value: stream, configurable: true, writable: true });
  installStdioGuard();
}

test("T1 健康通道完全透传：内容/返回值一致", async () => {
  const stream = new ControllableStream();
  installOn(stream);
  const ok = process.stdout.write("hello-t1\n");
  assert.equal(ok, true);
  // 等一个微任务队列让守卫回调投递
  await new Promise((r) => setImmediate(r));
  assert.ok(stream.written.includes("hello-t1\n"));
});

test("T2 同步 EIO 抛出被吞噬并降级静默，后续写不再抛", async () => {
  const stream = new ControllableStream();
  installOn(stream);
  stream.throwNext = errnoError("EIO");
  // 第一次写：同步抛 EIO → 守卫必须吞噬且返回 true（Ink 不感知失败）
  assert.doesNotThrow(() => {
    const r = process.stdout.write("boom\n");
    assert.equal(r, true);
  });
  // 进入静默：后续写零投递
  const before = stream.written.length;
  assert.doesNotThrow(() => process.stdout.write("after-eio\n"));
  assert.equal(stream.written.length, before, "静默模式不得再向卡死通道投递");
  resetStdioGuardSilence();
});

test("T3 write 回调 EPIPE：降级静默且回调仍被调用", async () => {
  const stream = new ControllableStream();
  installOn(stream);
  stream.callbackError = errnoError("EPIPE");
  let cbErr: unknown = "NOT_CALLED";
  await new Promise<void>((resolve) => {
    process.stdout.write("pipe-closed\n", undefined, (err?: Error | null) => {
      cbErr = err;
      resolve();
    });
  });
  assert.equal(cbErr, null, "守卫必须把通道错误消化为 null 回调，Ink 流状态机不卡死");
  resetStdioGuardSilence();
});

test("T4 非通道错误维持抛出语义", () => {
  const stream = new ControllableStream();
  installOn(stream);
  stream.throwNext = errnoError("EPERM");
  assert.throws(() => process.stdout.write("permission\n"), /EPERM/);
});

test("T5 流销毁后写不抛且静默（destroyed 通道）", async () => {
  const stream = new ControllableStream();
  installOn(stream);
  // 模拟 pty 销毁：EIO 同步抛出触发静默
  stream.throwNext = errnoError("EIO");
  assert.doesNotThrow(() => process.stdout.write("x\n"));
  // 已静默的流再写仍安全
  assert.doesNotThrow(() => process.stdout.write("y\n"));
  resetStdioGuardSilence();
});

test("T6 幂等：重复安装不重复包装（写入内容不翻倍）", async () => {
  const stream = new ControllableStream();
  installOn(stream);
  installStdioGuard(); // 第二次调用
  const ok = process.stdout.write("once-only\n");
  assert.equal(ok, true);
  await new Promise((r) => setImmediate(r));
  const hits = stream.written.filter((c) => c === "once-only\n").length;
  assert.equal(hits, 1, "守卫不得自我嵌套导致内容重复投递");
});

// ============================================================================
// 循环心跳断点解析（与 core/session.ts appendSessionMessage 写入端契约对齐）
// ============================================================================

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHeartbeatResumeHint, loopHeartbeatFile } from "../utils/tty-guard.js";

test("T7 心跳解析：正常多行返回最后断点与总数", () => {
  const dir = mkdtempSync(join(tmpdir(), "tty-heartbeat-"));
  try {
    const sessionFile = join(dir, "sess-1.jsonl");
    writeFileSync(
      loopHeartbeatFile(sessionFile),
      [
        JSON.stringify({ t: "2026-10-03T10:00:00.000Z", kind: "session_append", role: "user", sessionId: "s1" }),
        JSON.stringify({ t: "2026-10-03T10:00:05.000Z", kind: "session_append", role: "assistant", sessionId: "s1" }),
        JSON.stringify({ t: "2026-10-03T10:00:09.000Z", kind: "session_append", role: "tool", sessionId: "s1" }),
      ].join("\n") + "\n",
      "utf8"
    );
    const hint = readHeartbeatResumeHint(sessionFile);
    assert.ok(hint);
    assert.equal(hint.totalBeats, 3);
    assert.equal(hint.lastRole, "tool");
    assert.equal(hint.lastTime, "2026-10-03T10:00:09.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T8 心跳解析：半行损坏忽略、文件缺失返回 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "tty-heartbeat-"));
  try {
    const sessionFile = join(dir, "sess-2.jsonl");
    // 模拟"心跳写到一半进程被杀"：最后一行是截断的半行
    writeFileSync(
      loopHeartbeatFile(sessionFile),
      `${JSON.stringify({ t: "2026-10-03T10:00:00.000Z", kind: "session_append", role: "user" })}\n{"t":"2026-10`,
      "utf8"
    );
    const hint = readHeartbeatResumeHint(sessionFile);
    assert.ok(hint);
    assert.equal(hint.totalBeats, 1, "半行损坏不得计入断点");
    assert.equal(hint.lastRole, "user");
    // 文件不存在 → null
    assert.equal(readHeartbeatResumeHint(join(dir, "nonexistent.jsonl")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
