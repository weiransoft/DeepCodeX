/**
 * 路径牢笼单元测试（src/jail.ts）。
 *
 * 全部用例使用 mkdtemp 真实文件系统与真实符号链接（symlink），
 * 覆盖：白名单内放行、`..` 越界拒绝、symlink 逃逸拒绝、symlink 指向牢笼内放行、
 * 白名单外绝对路径拒绝、不存在目标（最近存在祖先回退）、buildJailRoots 跳过失效根、
 * 空白名单一律拒绝。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildJailRoots, JailViolationError, resolveInJail } from "../src/jail";

let rootA: string;
let rootB: string;
let rootAReal: string;

before(async () => {
  const base = mkdtempSync(path.join(tmpdir(), "deepcode-web-jail-"));
  rootA = path.join(base, "root-a");
  rootB = path.join(base, "root-b");
  // recursive 创建：root-a 尚不存在，需要连父目录一并建立
  mkdirSync(path.join(rootA, "sub"), { recursive: true });
  mkdirSync(rootB, { recursive: true });
  writeFileSync(path.join(rootA, "sub", "file.txt"), "hello", "utf8");
  rootAReal = await realpath(rootA);
});

after(() => {
  // 清理整棵临时基目录（含符号链接）
  rmSync(path.dirname(rootA), { recursive: true, force: true });
});

test("jail：白名单根本身与根内路径应放行并返回 realpath", async () => {
  const roots = await buildJailRoots([rootA]);
  assert.deepEqual(roots, [rootAReal]);

  const rootSelf = await resolveInJail(roots, rootA);
  assert.equal(rootSelf, rootAReal, "目标即根时返回 realpath");

  const inner = await resolveInJail(roots, path.join(rootA, "sub", "file.txt"));
  assert.equal(inner, path.join(rootAReal, "sub", "file.txt"));
});

test("jail：`..` 越界路径应拒绝（JailViolationError）", async () => {
  const roots = await buildJailRoots([rootA]);
  // 归一后逃出 rootA 的兄弟目录
  await assert.rejects(() => resolveInJail(roots, path.join(rootA, "..", "root-b")), JailViolationError);
  await assert.rejects(() => resolveInJail(roots, path.join(rootA, "..", "..", "etc")), JailViolationError);
});

test("jail：symlink 指向白名单外应拒绝（CWE-22 核心防护）", async () => {
  const roots = await buildJailRoots([rootA]);
  // rootA/link-out → rootB（白名单外）
  symlinkSync(rootB, path.join(rootA, "link-out"));
  await assert.rejects(() => resolveInJail(roots, path.join(rootA, "link-out")), JailViolationError);
  // 再深一层：rootA/link-out/file.txt → rootB/file.txt
  writeFileSync(path.join(rootB, "secret.txt"), "x", "utf8");
  symlinkSync(rootB, path.join(rootA, "link-out-2"));
  await assert.rejects(() => resolveInJail(roots, path.join(rootA, "link-out-2", "secret.txt")), JailViolationError);
});

test("jail：symlink 指向牢笼内部应放行（realpath 落在根内）", async () => {
  const roots = await buildJailRoots([rootA]);
  // rootA/link-in → rootA/sub（内部链接，合法）
  symlinkSync(path.join(rootA, "sub"), path.join(rootA, "link-in"));
  const resolved = await resolveInJail(roots, path.join(rootA, "link-in", "file.txt"));
  assert.equal(resolved, path.join(rootAReal, "sub", "file.txt"), "应消解为真实路径");
});

test("jail：白名单外绝对路径应拒绝；空白名单一律拒绝", async () => {
  const roots = await buildJailRoots([rootA]);
  await assert.rejects(() => resolveInJail(roots, "/etc/passwd"), JailViolationError);
  await assert.rejects(() => resolveInJail(roots, rootB), JailViolationError);

  // 空牢笼：任何目标都拒绝
  await assert.rejects(() => resolveInJail([], rootA), JailViolationError);
});

test("jail：目标不存在时回退最近存在祖先判界（上传到未建子目录场景）", async () => {
  const roots = await buildJailRoots([rootA]);
  // 牢笼内的不存在目标：祖先 rootA 存在 → 放行，返回 拼接路径
  const missingInside = await resolveInJail(roots, path.join(rootA, "not-yet-dir", "a.txt"));
  assert.equal(missingInside, path.join(rootAReal, "not-yet-dir", "a.txt"));

  // 经由 .. 逃出后的不存在目标：最近存在祖先在白名单外 → 拒绝
  await assert.rejects(
    () => resolveInJail(roots, path.join(rootA, "..", "outside-missing", "a.txt")),
    JailViolationError
  );
});

test("jail：buildJailRoots 应跳过不存在的根（失效根不阻断其他根）", async () => {
  const roots = await buildJailRoots([path.join(rootA, "does-not-exist"), rootA, rootB]);
  assert.deepEqual(roots, [rootAReal, await realpath(rootB)], "仅保留 realpath 成功的根");
});

test("jail：多根白名单任一匹配即放行", async () => {
  const roots = await buildJailRoots([rootA, rootB]);
  const resolved = await resolveInJail(roots, path.join(rootB, "secret.txt"));
  assert.equal(resolved, await realpath(path.join(rootB, "secret.txt")));
});
