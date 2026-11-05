/**
 * T-025 回归测试：LLM 规划器调用 eag 指令的三类 Bug
 * 1. 不执行：命令名别名/前缀写法未命中分发表，指令被忽略
 * 2. 不压缩上下文：eag compact 参数解析失败（长选项被当作 positional）导致拒绝执行
 * 3. 不切换新上下文：eag context new / eag new 未注册别名，规划器写法落空
 *
 * 本测试锁定：解析器对规划器常见写法的兼容性 + compact/new 命令端到端生效。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseEagArgs } from "../packages/core/src/eag/cli/eag-args.ts";
import { runCompact } from "../packages/core/src/eag/cli/eag-compact-command.ts";
import { runNew } from "../packages/core/src/eag/cli/eag-new-command.ts";

// 以模块位置解析仓库根（tests/ 的上一级），不依赖进程 cwd
import { fileURLToPath } from "node:url";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eag-ctx-"));
}

test("eag 命令别名解析：compact / new / context new 均可被规划器写法命中", () => {
  const a = parseEagArgs(["compact", "--instructions", "focus on tests"]);
  assert.equal(a.command, "compact");

  const b = parseEagArgs(["new"]);
  assert.equal(b.command, "new");

  const c = parseEagArgs(["context", "new"]);
  assert.equal(c.command, "context");
  assert.equal(c.positional[0], "new");
});

test("eag compact：长选项不会被误判为 positional，参数完整保留", () => {
  const a = parseEagArgs(["compact", "--instructions", "keep API changes", "--dry-run"]);
  assert.equal(a.flags["dry-run"], true);
  assert.equal(a.flags["instructions"], "keep API changes");
  assert.deepEqual(a.positional, ["compact"]);
});

test("eag compact 端到端：上下文被压缩并写回状态文件", async () => {
  const ws = mkWorkspace();
  try {
    const ctxDir = path.join(ws, ".eag");
    fs.mkdirSync(ctxDir, { recursive: true });
    const ctxFile = path.join(ctxDir, "context.json");
    const longText = "line\n".repeat(500);
    fs.writeFileSync(
      ctxFile,
      JSON.stringify({
        history: [
          { role: "user", content: longText },
          { role: "assistant", content: longText },
        ],
      })
    );

    const res = await runCompact({ cwd: ws, instructions: "keep decisions only" });
    assert.equal(res.ok, true, `compact failed: ${res.error ?? ""}`);

    const after = JSON.parse(fs.readFileSync(ctxFile, "utf8"));
    const beforeLen = longText.length * 2;
    const afterLen = JSON.stringify(after).length;
    assert.ok(afterLen < beforeLen, `context not compacted: ${afterLen} >= ${beforeLen}`);
    assert.ok(after.compressed === true || after.compacted === true, "compact flag not set");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("eag new 端到端：切换到新上下文，旧上下文被归档", async () => {
  const ws = mkWorkspace();
  try {
    const ctxDir = path.join(ws, ".eag");
    fs.mkdirSync(ctxDir, { recursive: true });
    const ctxFile = path.join(ctxDir, "context.json");
    fs.writeFileSync(ctxFile, JSON.stringify({ history: [{ role: "user", content: "old session" }] }));

    const res = await runNew({ cwd: ws });
    assert.equal(res.ok, true, `new failed: ${res.error ?? ""}`);

    const after = JSON.parse(fs.readFileSync(ctxFile, "utf8"));
    assert.equal(after.history?.length ?? 0, 0, "history not reset");

    const archive = fs.readdirSync(ctxDir).filter((f) => /archive|history|backup/.test(f));
    assert.ok(archive.length > 0, "no archive of previous context");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
