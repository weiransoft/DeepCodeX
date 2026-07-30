// ============================================================================
// P2 回归测试：验证 packages/core/dist 产物可被 tsx/Node ESM 正确加载。
//
// 背景：core 包使用 tsc + moduleResolution:bundler 编译，源码中的目录导入
// （如 ./eag/long-horizon）在 dist 中保留为无扩展名路径。当 tsx 从 dist 解析时
// 会自动追加 .js，导致路径指向目录而非 index.js，抛出 ERR_MODULE_NOT_FOUND。
// 修复方式是将所有相对目录导入显式写为 ./foo/index，使编译产物为 ./foo/index.js。
//
// 本测试直接加载编译后的 dist/index.js，覆盖核心 barrel 入口，确保运行时解析
// 不会因为目录导入而失败。
// ============================================================================
import assert from "node:assert";
import { describe, it } from "node:test";

describe("core dist ESM import regression (P2)", () => {
  it("应能直接加载 dist/index.js 并导出 SessionManager", async () => {
    const mod = await import("../../dist/index.js");
    assert.ok(mod.SessionManager, "SessionManager 应从 dist/index.js 导出");
    assert.strictEqual(typeof mod.SessionManager, "function", "SessionManager 应为构造函数/类");
  });

  it("应能加载 dist/session.js 并导出 SessionManager", async () => {
    const mod = await import("../../dist/session.js");
    assert.ok(mod.SessionManager, "SessionManager 应从 dist/session.js 导出");
    assert.strictEqual(typeof mod.SessionManager, "function", "SessionManager 应为构造函数/类");
  });

  it("应能加载 dist/eag/long-horizon/index.js 并导出 EagRunHandler", async () => {
    const mod = await import("../../dist/eag/long-horizon/index.js");
    assert.ok(mod.EagRunHandler, "EagRunHandler 应从 long-horizon barrel 导出");
    assert.strictEqual(typeof mod.EagRunHandler, "function", "EagRunHandler 应为构造函数/类");
  });
});
