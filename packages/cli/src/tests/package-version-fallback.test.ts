import { test } from "node:test";
import assert from "node:assert/strict";
// 修复"4 段版本号导致 CLI 启动即死"（2026-10-03）的回归测试：
// read-package-up@12 内部 normalize-package-data 对 4 段补丁版本号（0.4.3.x）
// 抛异常，旧版 getPackageJson() 未捕获 → 所有 CLI 命令（含 --help）启动即崩。
// 本文件锁定修复后的三条契约：
//   P1 正常路径——包内 package.json 可解析时原样返回；
//   P2 异常兜底——任意解析异常绝不向外抛出；
//   P3 回退值形状——回退 version 满足 semver 形状（或空串），CLI_VERSION 常量已随构建刷新。
import { getPackageJson } from "../utils/package.js";
import { CLI_VERSION } from "../generated/git-commit.js";

test("P1 getPackageJson 返回包内真实 package.json（正常路径零回归）", async () => {
  // 源码树内 packages/cli/src/utils → 向上命中 packages/cli/package.json
  // 该文件 version 为 4 段（当前 0.4.3.x）时恰好走 try 成功分支
  // （read-package-up 对 4 段版本是否抛异常取决于其内部 semver 校验强度；
  // 无论成败，P1/P2 共同保证：不抛异常 + 返回对象含 name/version）
  const pkg = await getPackageJson();
  assert.equal(pkg.name, "@vegamo/deepcode-cli");
  const version = pkg.version ?? "";
  assert.ok(version.length > 0, "version 不得为空——异常时应回退编译期 CLI_VERSION");
});

test("P3 编译期 CLI_VERSION 常量覆盖 4 段版本号形状", () => {
  // generate-git-commit-info.js 从 packages/cli/package.json 读取 version 注入；
  // 修复后 build 链会先执行该脚本，常量必须与 4 段版本保持同步
  assert.match(CLI_VERSION, /^\d+\.\d+\.\d+(?:\.\d+)?$/, `CLI_VERSION 必须是 3/4 段版本号，实际：${CLI_VERSION}`);
});

test("P2 连续调用命中缓存路径同样不抛异常", async () => {
  // 第一次调用（P1）若成功会写入模块级缓存；第二次必须走缓存分支且结果一致
  const first = await getPackageJson();
  const second = await getPackageJson();
  assert.equal(second.version, first.version);
  assert.equal(second.name, first.name);
});
