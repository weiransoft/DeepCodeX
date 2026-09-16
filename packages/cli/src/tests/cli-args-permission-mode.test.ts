/**
 * 三态权限模式（manual / auto / bypass）—— CLI 参数解析测试
 *
 * 对应设计文档 docs/dev/permission-modes.md §7.2 用例 PM-I08：
 * - `--permission-mode bypass` 等合法值正确解析并透传到 ParsedCliArgs.permissionMode
 * - 未传 flag 时 permissionMode 为 undefined（权限模式由 settings.json 决定）
 * - 非法值（如 "evil"）被 yargs choices 校验拒绝：进程以非零码退出并输出错误
 *
 * 非法值路径经由 parseArguments 内部的 process.exit(1)，无法在进程内断言，
 * 按项目既有惯例（quality-cli-e2e.test.ts / memory-wiring.test.ts）用 spawnSync 子进程验证。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "path";
import { fileURLToPath } from "node:url";
import { parseArguments, PERMISSION_MODE_CHOICES } from "../cli-args";
import type { PermissionMode } from "@vegamo/deepcode-core";

// cli-args.ts 所在目录（子进程 spawn 的工作目录与脚本路径基准）
const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("PERMISSION_MODE_CHOICES mirrors the core PermissionMode union", () => {
  // 单一数据源：choices 与 core 类型保持一致，防止漂移
  assert.deepEqual([...PERMISSION_MODE_CHOICES], ["manual", "auto", "bypass"]);
});

test("parseArguments resolves --permission-mode with valid values (PM-I08)", async () => {
  for (const mode of PERMISSION_MODE_CHOICES) {
    const parsed = await parseArguments(["--permission-mode", mode]);
    assert.equal(parsed.permissionMode, mode satisfies PermissionMode);
  }
});

test("parseArguments resolves the -h style alias-free short usage without permission mode", async () => {
  const parsed = await parseArguments([]);
  // 未传 flag：permissionMode 为 undefined，由 settings.json 的 permissions.mode 决定
  assert.equal(parsed.permissionMode, undefined);
});

test("parseArguments keeps permission mode alongside other flags (PM-I08)", async () => {
  const parsed = await parseArguments(["--permission-mode", "manual", "-p", "hello world"]);
  assert.equal(parsed.permissionMode, "manual");
  assert.equal(parsed.prompt, "hello world");
});

test("parseArguments rejects invalid permission mode values via yargs choices (PM-I08)", () => {
  // 非法值走 yargs fail 处理器：stderr 输出错误 + process.exit(1)，须用子进程验证
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.tsx", "--permission-mode", "evil", "-p", "hi"],
    {
      cwd: cliDir,
      encoding: "utf8",
      timeout: 60_000,
    }
  );
  assert.equal(result.status, 1);
  const output = `${result.stderr ?? ""}${result.stdout ?? ""}`;
  assert.match(output, /permission-mode/i);
});
