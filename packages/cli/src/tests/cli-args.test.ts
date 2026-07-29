import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArguments, isValidSessionId } from "../cli-args";

// ── isValidSessionId ─────────────────────────────────────────────────────────

test("isValidSessionId accepts valid UUID", () => {
  assert.ok(isValidSessionId("0a5cb7a5-c39d-4c39-a11b-05f8b22b8df6"));
});

test("isValidSessionId rejects invalid format", () => {
  assert.ok(!isValidSessionId("not-a-uuid"));
  assert.ok(!isValidSessionId(""));
  assert.ok(!isValidSessionId("abc"));
});

// ── parseArguments: basic parsing ──────────────────────────────────────────────

test("parseArguments returns prompt after -p", async () => {
  const r = await parseArguments(["-p", "hello world"]);
  assert.ok(!("message" in r));
  assert.equal(r.prompt, "hello world");
});

test("parseArguments returns prompt after --prompt", async () => {
  const r = await parseArguments(["--prompt", "hello world"]);
  assert.ok(!("message" in r));
  assert.equal(r.prompt, "hello world");
});

test("parseArguments returns undefined prompt when -p is not present", async () => {
  const r = await parseArguments(["--resume"]);
  assert.ok(!("message" in r));
  assert.equal(r.prompt, undefined);
});

test("parseArguments returns session ID after --resume", async () => {
  const r = await parseArguments(["--resume", "0a5cb7a5-c39d-4c39-a11b-05f8b22b8df6"]);
  assert.ok(!("message" in r));
  assert.equal(r.resume, "0a5cb7a5-c39d-4c39-a11b-05f8b22b8df6");
});

test("parseArguments returns true when --resume has no value", async () => {
  const r = await parseArguments(["--resume"]);
  assert.ok(!("message" in r));
  assert.equal(r.resume, true);
});

test("parseArguments returns undefined resume when not present", async () => {
  const r = await parseArguments(["-p", "test"]);
  assert.ok(!("message" in r));
  assert.equal(r.resume, undefined);
});

test("parseArguments returns defaults for empty args", async () => {
  const r = await parseArguments([]);
  assert.ok(!("message" in r));
  assert.equal(r.prompt, undefined);
  assert.equal(r.resume, undefined);
  assert.equal(r.version, false);
  assert.equal(r.help, false);
});

// ── parseArguments: -r alias ───────────────────────────────────────────────────

test("parseArguments returns session ID after -r", async () => {
  const r = await parseArguments(["-r", "0a5cb7a5-c39d-4c39-a11b-05f8b22b8df6"]);
  assert.ok(!("message" in r));
  assert.equal(r.resume, "0a5cb7a5-c39d-4c39-a11b-05f8b22b8df6");
});

test("parseArguments returns true when -r has no value", async () => {
  const r = await parseArguments(["-r"]);
  assert.ok(!("message" in r));
  assert.equal(r.resume, true);
});

test("parseArguments handles -r <id> combined with -p", async () => {
  const r = await parseArguments(["-r", "0a5cb7a5-c39d-4c39-a11b-05f8b22b8df6", "-p", "hello"]);
  assert.ok(!("message" in r));
  assert.equal(r.resume, "0a5cb7a5-c39d-4c39-a11b-05f8b22b8df6");
  assert.equal(r.prompt, "hello");
});

// ── parseArguments: --version / --help ─────────────────────────────────────────

test("parseArguments detects --version", async () => {
  const r = await parseArguments(["--version"]);
  assert.ok(!("message" in r));
  assert.equal(r.version, true);
  assert.equal(r.help, false);
});

test("parseArguments detects -v", async () => {
  const r = await parseArguments(["-v"]);
  assert.ok(!("message" in r));
  assert.equal(r.version, true);
});

test("parseArguments --help triggers process.exit(0)", async () => {
  await withMockedExit(async (exitSpy) => {
    try {
      await parseArguments(["--help"]);
    } catch {
      /* expected: process.exit throws */
    }
    assert.deepEqual(exitSpy.calls, [0]);
  });
});

test("parseArguments -h triggers process.exit(0)", async () => {
  await withMockedExit(async (exitSpy) => {
    try {
      await parseArguments(["-h"]);
    } catch {
      /* expected: process.exit throws */
    }
    assert.deepEqual(exitSpy.calls, [0]);
  });
});

test("parseArguments version and help are false when not passed", async () => {
  const r = await parseArguments(["-p", "hello"]);
  assert.ok(!("message" in r));
  assert.equal(r.version, false);
  assert.equal(r.help, false);
});

test("parseArguments handles -v combined with -r (both flags set)", async () => {
  const r = await parseArguments(["-v", "-r", "abc"]);
  assert.ok(!("message" in r));
  assert.equal(r.version, true);
  assert.equal(r.resume, "abc");
});

// ── parseArguments: combined usage ─────────────────────────────────────────────

test("parseArguments handles --resume <id> combined with -p", async () => {
  const r = await parseArguments(["--resume", "0a5cb7a5-c39d-4c39-a11b-05f8b22b8df6", "-p", "hello"]);
  assert.ok(!("message" in r));
  assert.equal(r.resume, "0a5cb7a5-c39d-4c39-a11b-05f8b22b8df6");
  assert.equal(r.prompt, "hello");
});

test("parseArguments handles -p before --resume <id>", async () => {
  const r = await parseArguments(["-p", "hello", "--resume", "0a5cb7a5-c39d-4c39-a11b-05f8b22b8df6"]);
  assert.ok(!("message" in r));
  assert.equal(r.resume, "0a5cb7a5-c39d-4c39-a11b-05f8b22b8df6");
  assert.equal(r.prompt, "hello");
});

test("parseArguments --version --help exits 0 via help path", async () => {
  // FIX-15：--help 现在由 parseArguments 手动处理并 exit(0)，
  // 与 --version 同时存在时两者都被解析，但最终走 help 退出路径。
  await withMockedExit(async (exitSpy) => {
    try {
      await parseArguments(["--version", "--help"]);
    } catch {
      /* expected: process.exit throws */
    }
    assert.deepEqual(exitSpy.calls, [0]);
  });
});

// ── FIX-15: team help / rules help 不应触发 yargs 内置 help ─────────────────
// 这些子命令的 help 是 positional 参数，应被解析为对应子命令，
// parsed.help 保持 false，避免与 cli.tsx 自定义中文帮助重复输出。

test("parseArguments team help 解析为 team 子命令 help（非 --help）", async () => {
  const r = await parseArguments(["team", "help"]);
  assert.equal(r.team, "help");
  assert.equal(r.help, false);
});

test("parseArguments rules help 解析为 rules 子命令 help（非 --help）", async () => {
  const r = await parseArguments(["rules", "help"]);
  assert.equal(r.rules, "help");
  assert.equal(r.help, false);
});

test("parseArguments quality-check help 解析为 quality-check 子命令 help（非 --help）", async () => {
  const r = await parseArguments(["quality-check", "help"]);
  assert.equal(r.qualityCheck, "help");
  assert.equal(r.help, false);
});

test("parseArguments review help 解析为 review 子命令 help（非 --help）", async () => {
  const r = await parseArguments(["review", "help"]);
  assert.equal(r.review, "help");
  assert.equal(r.help, false);
});

// ── parseArguments: error cases (mock process.exit) ────────────────────────────
// Command-level and top-level errors both call process.exit(1) via yargs .fail().

function withMockedExit(fn: (exitSpy: { calls: number[] }) => Promise<void>): Promise<void> {
  const original = process.exit;
  const stderrWrite = process.stderr.write;
  // Suppress yargs help/error output during tests
  process.stderr.write = (() => true) as typeof process.stderr.write;
  const exitSpy: { calls: number[] } = { calls: [] };
  process.exit = ((code?: number) => {
    exitSpy.calls.push(code ?? 0);
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
  return fn(exitSpy).finally(() => {
    process.exit = original;
    process.stderr.write = stderrWrite;
  });
}

test("parseArguments exits on unknown flags", async () => {
  await withMockedExit(async (exitSpy) => {
    try {
      await parseArguments(["--unknown-flag"]);
    } catch {
      /* expected */
    }
    assert.ok(exitSpy.calls.length >= 1);
  });
});

test("parseArguments exits on bare -r with -p", async () => {
  await withMockedExit(async (exitSpy) => {
    try {
      await parseArguments(["-r", "-p", "hello"]);
    } catch {
      /* expected */
    }
    assert.ok(exitSpy.calls.length >= 1);
  });
});

test("parseArguments exits on empty -p value", async () => {
  await withMockedExit(async (exitSpy) => {
    try {
      await parseArguments(["-p", ""]);
    } catch {
      /* expected */
    }
    assert.ok(exitSpy.calls.length >= 1);
  });
});

test("parseArguments exits on invalid --resume session ID", async () => {
  await withMockedExit(async (exitSpy) => {
    try {
      await parseArguments(["--resume", "not-a-uuid"]);
    } catch {
      /* expected */
    }
    assert.ok(exitSpy.calls.length >= 1);
  });
});

// ── parseArguments: review 子命令解析（架构师审查 L4 修复，2026-07-27） ────────
// 覆盖 review 命令的参数解析路径，包括子命令提取、默认值、选项解析

test("parseArguments 解析 review typecheck 子命令", async () => {
  const r = await parseArguments(["review", "typecheck"]);
  assert.ok(!("message" in r));
  assert.equal(r.review, "typecheck");
});

test("parseArguments 解析 review lint 子命令", async () => {
  const r = await parseArguments(["review", "lint"]);
  assert.ok(!("message" in r));
  assert.equal(r.review, "lint");
});

test("parseArguments 解析 review format 子命令", async () => {
  const r = await parseArguments(["review", "format"]);
  assert.ok(!("message" in r));
  assert.equal(r.review, "format");
});

test("parseArguments 解析 review full 子命令", async () => {
  const r = await parseArguments(["review", "full"]);
  assert.ok(!("message" in r));
  assert.equal(r.review, "full");
});

test("parseArguments 解析 review help 子命令", async () => {
  const r = await parseArguments(["review", "help"]);
  assert.ok(!("message" in r));
  assert.equal(r.review, "help");
});

test("parseArguments review 无子命令时默认为 full（RV-02 修复）", async () => {
  // 验证 RV-02 修复：review 不带子命令时应默认为 "full" 而非报错
  const r = await parseArguments(["review"]);
  assert.ok(!("message" in r));
  assert.equal(r.review, "full");
});

test("parseArguments review --quiet 选项解析", async () => {
  const r = await parseArguments(["review", "typecheck", "--quiet"]);
  assert.ok(!("message" in r));
  assert.equal(r.review, "typecheck");
  assert.equal(r.reviewOptions.quiet, true);
});

test("parseArguments review --format json 选项解析", async () => {
  const r = await parseArguments(["review", "full", "--format", "json"]);
  assert.ok(!("message" in r));
  assert.equal(r.review, "full");
  assert.equal(r.reviewOptions.format, "json");
});

test("parseArguments review --project-root 选项解析", async () => {
  const r = await parseArguments(["review", "typecheck", "--project-root", "/custom/path"]);
  assert.ok(!("message" in r));
  assert.equal(r.review, "typecheck");
  assert.equal(r.reviewOptions["project-root"], "/custom/path");
});

test("parseArguments review 组合选项 --quiet --format text", async () => {
  const r = await parseArguments(["review", "full", "--quiet", "--format", "text"]);
  assert.ok(!("message" in r));
  assert.equal(r.review, "full");
  assert.equal(r.reviewOptions.quiet, true);
  assert.equal(r.reviewOptions.format, "text");
});

test("parseArguments review 无子命令时带 --quiet 默认 full", async () => {
  // 验证 RV-02 修复：review 不带子命令但带选项时应默认为 "full"
  const r = await parseArguments(["review", "--quiet"]);
  assert.ok(!("message" in r));
  assert.equal(r.review, "full");
  assert.equal(r.reviewOptions.quiet, true);
});

test("parseArguments 未调用 review 时 parsed.review 为 undefined", async () => {
  // 验证非 review 命令不会误设置 review 字段
  const r = await parseArguments(["--version"]);
  assert.ok(!("message" in r));
  assert.equal(r.review, undefined);
});
