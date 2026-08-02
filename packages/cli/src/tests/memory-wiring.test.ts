/**
 * memory-wiring.test.ts - /memory 命令接线集成测试（FIX-05）
 *
 * 测试目标：
 *   验证 TUI `/memory` 命令所接线的 V2 记忆体系路径真实可用：
 *   App.tsx handleMemorySlashCommand → handleMemoryCommand(store, privacyManager)
 *
 *   覆盖子命令：
 *   - list      列出全部记忆（含空态提示）
 *   - delete    删除指定 ID 记忆
 *   - review    审查最近记忆
 *   - export    导出 JSON
 *   - delete-all DELETE ALL  物理删除全部记忆文件（二次确认令牌）
 *
 * 测试约定（遵循用户规则）：
 *   - 使用 node:test + node:assert/strict
 *   - 禁止 mock：使用真实 MemoryStore / MemoryPrivacyManager + 真实临时文件系统
 *   - 隔离 HOME / USERPROFILE 到临时目录，避免读写真实用户记忆目录
 *   - 每个测试用例独立临时 projectRoot
 *
 * 同时包含 FIX-06 的 EPILOG 集成验证：
 *   - TC-HELP-001: `deepcode --help` 输出包含由 BUILTIN_SLASH_COMMANDS 生成的全部命令
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { MemoryStore, MemoryPrivacyManager, handleMemoryCommand } from "@vegamo/deepcode-core";

// ESM 模式下无 __dirname，通过 import.meta.url 计算当前测试文件所在目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 隔离 HOME / USERPROFILE 到临时目录
 *
 * MemoryStore 内部使用 os.homedir() 定位 ~/.deepcode/memory/，
 * 测试必须重定向 HOME，避免读写真实用户记忆目录。
 *
 * @returns { home, restore } home 为临时 HOME 目录，restore 恢复原环境变量
 */
function isolateHome(): { home: string; restore: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-mem-home-"));
  const backupHome = process.env.HOME;
  const backupUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    home,
    restore: () => {
      if (backupHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = backupHome;
      }
      if (backupUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = backupUserProfile;
      }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * 创建临时项目目录（项目级记忆根）
 *
 * @param prefix 目录名前缀
 * @returns 临时目录绝对路径
 */
function makeTempProject(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `deepcode-mem-proj-${prefix}-`));
}

/**
 * 构造与 App.tsx handleMemorySlashCommand 完全一致的接线对象
 *
 * 目录布局（与 MemoryStore / MemoryPrivacyManager 内部约定一致）：
 *   全局记忆目录：<HOME>/.deepcode/memory/
 *   项目记忆目录：<projectRoot>/.deepcode/memory/
 *
 * @param projectRoot 项目根目录
 * @returns { store, privacyManager }
 */
function buildWiredInstances(projectRoot: string): {
  store: MemoryStore;
  privacyManager: MemoryPrivacyManager;
} {
  const globalMemoryDir = path.join(os.homedir(), ".deepcode", "memory");
  const projectMemoryDir = path.join(projectRoot, ".deepcode", "memory");
  return {
    store: new MemoryStore(projectRoot),
    privacyManager: new MemoryPrivacyManager(globalMemoryDir, projectMemoryDir),
  };
}

// ============================================================================
// TC-MEM-001: /memory list 空态 → 返回"暂无记忆"提示
// ============================================================================

test("TC-MEM-001: /memory list 空态返回暂无记忆提示", async () => {
  const { restore } = isolateHome();
  const projectRoot = makeTempProject("tc001");
  try {
    const { store, privacyManager } = buildWiredInstances(projectRoot);
    const result = await handleMemoryCommand("list", store, privacyManager);
    assert.equal(result.success, true, `list 应成功，实际 output: ${result.output}`);
    assert.ok(result.output.includes("暂无记忆"), `空态应提示 "暂无记忆"，实际: ${result.output}`);
  } finally {
    restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-MEM-002: 写入记忆后 /memory list 返回真实条目
// ============================================================================

test("TC-MEM-002: 写入记忆后 list 返回真实条目", async () => {
  const { restore } = isolateHome();
  const projectRoot = makeTempProject("tc002");
  try {
    const { store, privacyManager } = buildWiredInstances(projectRoot);
    // 通过 store 真实写入一条用户全局记忆（add 为 MemoryStore 公开 API）
    store.add({
      type: "user_global",
      key: "preferred_language",
      value: "中文",
      confidence: 1.0,
      source: "user_explicit",
    });

    const result = await handleMemoryCommand("list", store, privacyManager);
    assert.equal(result.success, true);
    assert.ok(result.output.includes("preferred_language"), `list 应包含记忆 key，实际: ${result.output}`);
    assert.ok(result.output.includes("中文"), `list 应包含记忆 value，实际: ${result.output}`);
    assert.ok(result.output.includes("user_global"), `list 应包含记忆类型，实际: ${result.output}`);

    // 类型过滤：project 类型应返回空态
    const filtered = await handleMemoryCommand("list project", store, privacyManager);
    assert.equal(filtered.success, true);
    assert.ok(filtered.output.includes("暂无"), `project 类型应为空态，实际: ${filtered.output}`);
  } finally {
    restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-MEM-003: /memory delete <id> 删除真实条目
// ============================================================================

test("TC-MEM-003: delete 子命令删除真实条目", async () => {
  const { restore } = isolateHome();
  const projectRoot = makeTempProject("tc003");
  try {
    const { store, privacyManager } = buildWiredInstances(projectRoot);
    const entry = store.add({
      type: "user_global",
      key: "to_delete",
      value: "待删除值",
      confidence: 1.0,
      source: "user_explicit",
    });

    const result = await handleMemoryCommand(`delete ${entry.id}`, store, privacyManager);
    assert.equal(result.success, true, `delete 应成功，实际: ${result.output}`);
    assert.ok(result.output.includes("删除成功"), `应提示删除成功，实际: ${result.output}`);

    // 删除后 list 应为空态
    const after = await handleMemoryCommand("list", store, privacyManager);
    assert.ok(after.output.includes("暂无记忆"), `删除后应为空态，实际: ${after.output}`);

    // 删除不存在的 ID 应失败
    const missing = await handleMemoryCommand(`delete ${entry.id}`, store, privacyManager);
    assert.equal(missing.success, false, `删除不存在 ID 应失败，实际: ${missing.output}`);
  } finally {
    restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-MEM-004: /memory review 返回最近条目 + /memory export 返回合法 JSON
// ============================================================================

test("TC-MEM-004: review 返回最近条目，export 返回合法 JSON", async () => {
  const { restore } = isolateHome();
  const projectRoot = makeTempProject("tc004");
  try {
    const { store, privacyManager } = buildWiredInstances(projectRoot);
    store.add({
      type: "user_global",
      key: "review_key",
      value: "审查值",
      confidence: 0.9,
      source: "user_explicit",
    });

    const review = await handleMemoryCommand("review", store, privacyManager);
    assert.equal(review.success, true);
    assert.ok(review.output.includes("review_key"), `review 应包含记忆 key，实际: ${review.output}`);

    const exported = await handleMemoryCommand("export", store, privacyManager);
    assert.equal(exported.success, true);
    // export 输出应为合法 JSON 且包含写入的 key
    const parsed = JSON.parse(exported.output) as { entries?: Array<{ key: string }> };
    assert.ok(Array.isArray(parsed.entries), `export 应含 entries 数组，实际: ${exported.output}`);
    assert.ok(
      parsed.entries!.some((e) => e.key === "review_key"),
      `export 应包含写入的 key，实际: ${exported.output}`
    );
  } finally {
    restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-MEM-005: /memory delete-all 二次确认流程（真实物理删除）
// ============================================================================

test("TC-MEM-005: delete-all 需二次确认令牌，确认后物理删除记忆文件", async () => {
  const { home, restore } = isolateHome();
  const projectRoot = makeTempProject("tc005");
  try {
    const { store, privacyManager } = buildWiredInstances(projectRoot);
    store.add({
      type: "user_global",
      key: "wipe_key",
      value: "待清空",
      confidence: 1.0,
      source: "user_explicit",
    });

    // 确认全局记忆文件已真实落盘
    const globalMemoryPath = path.join(home, ".deepcode", "memory", "global.json");
    assert.ok(fs.existsSync(globalMemoryPath), "add 后全局记忆文件应已落盘");

    // 分支 1：无确认令牌 → 拒绝删除并提示
    const noToken = await handleMemoryCommand("delete-all", store, privacyManager);
    assert.equal(noToken.success, false, `无令牌应拒绝，实际: ${noToken.output}`);
    assert.ok(noToken.output.includes("DELETE ALL"), `应提示二次确认令牌，实际: ${noToken.output}`);
    assert.ok(fs.existsSync(globalMemoryPath), "无令牌时文件不得被删除");

    // 分支 2：错误令牌 → 拒绝删除
    const wrongToken = await handleMemoryCommand("delete-all delete all", store, privacyManager);
    assert.equal(wrongToken.success, false, `错误令牌应拒绝，实际: ${wrongToken.output}`);
    assert.ok(fs.existsSync(globalMemoryPath), "错误令牌时文件不得被删除");

    // 分支 3：正确令牌 "DELETE ALL" → 物理删除
    const confirmed = await handleMemoryCommand("delete-all DELETE ALL", store, privacyManager);
    assert.equal(confirmed.success, true, `正确令牌应成功，实际: ${confirmed.output}`);
    assert.ok(confirmed.output.includes("已删除全部记忆文件"), `应提示删除完成，实际: ${confirmed.output}`);
    assert.ok(!fs.existsSync(globalMemoryPath), "确认后全局记忆文件应被物理删除");
  } finally {
    restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-HELP-001: `deepcode --help` EPILOG 包含全部注册命令（FIX-06 集成验证）
// ============================================================================

test("TC-HELP-001: deepcode --help 输出包含由注册表生成的全部命令", () => {
  // 通过真实进程调用 CLI --help，验证 EPILOG 与 BUILTIN_SLASH_COMMANDS 单一数据源集成
  // （formatBuiltinCommandList 的行为级单测见 slash-commands.test.ts）
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.tsx", "--help"], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf-8",
    timeout: 60_000,
  });

  assert.equal(result.status, 0, `--help 应退出 0，stderr: ${result.stderr}`);
  const output = result.stdout;

  // FIX-06 审查发现的 EPILOG 缺失命令，必须全部出现在 --help 输出中
  for (const required of [
    "/help",
    "/team",
    "/architect",
    "/pm",
    "/coder",
    "/tester",
    "/ui",
    "/memory",
    "/rules",
    "/quality-check",
    "/review",
    "/inject",
    "/bg",
    "/tasks",
    "/fg",
    "/cancel",
    "/pause",
    // EAG P5 编排命令（2026-07-31 FIX-3 集成验证）
    "/eag-autonomous",
    "/eag-autonomous-status",
    "/eag-autonomous-stop",
    "/eag-graph",
  ]) {
    assert.ok(output.includes(required), `--help 输出应包含 ${required}`);
  }
});
