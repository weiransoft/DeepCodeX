/**
 * V2 配置四层合并单元测试（CFG-01 ~ CFG-04 + 边界用例）
 *
 * 设计依据：V2_CONTEXT_MEMORY_TECH_DESIGN.md §9.4.1 配置合并规范
 *
 * 测试覆盖：
 * - CFG-01: 内置默认值层（V2Config schema .default 值）
 * - CFG-02: settings.json 用户配置层覆盖默认值
 * - CFG-03: DEEPCODEX_V2_* 环境变量层覆盖用户配置
 * - CFG-04: CLI --v2-* 参数层覆盖环境变量（最高优先级）
 * - CFG-05: 深合并语义（对象递归合并，非整体替换）
 * - CFG-06: 数组整体替换（非拼接）
 * - CFG-07: 未知键 strict 拒绝（userJson 层）
 * - CFG-08: 未知键 strict 拒绝（env 层）
 * - CFG-09: 未知键 strict 拒绝（cliArgs 层）
 * - CFG-10: 类型错误抛 V2ConfigError（含 keyPath 与 sourceLayer）
 * - CFG-11: 非法枚举值抛 V2ConfigError
 * - CFG-12: 三层叠加（默认 + userJson + env + cliArgs 同时生效）
 * - CFG-13: 空配置（全为空对象）返回完整默认值
 * - CFG-14: 高层缺失的 key 保留低层值
 * - CFG-15: 高层显式 undefined 不覆盖低层
 *
 * 所有测试不依赖文件系统（纯函数测试），禁止 mock。
 *
 * @module v2/tests/integration/settings-bridge.test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { buildV2Config, mergeV2Config, V2Config, V2ConfigError } from "../../integration/settings-bridge";

// ============================================================================
// CFG-01 ~ CFG-15 测试用例
// ============================================================================

test("CFG-01: 内置默认值层（V2Config schema .default 值）", () => {
  // 三层全部为空 → 返回完整默认值
  const result = mergeV2Config({}, {}, {});

  // 验证各域默认值
  assert.equal(result.enabled, false, "enabled 默认 false（v2.1 W-09 灰度发布）");
  assert.equal(result.diff.enabled, true, "diff.enabled 默认 true（低风险默认启用）");
  assert.equal(result.diff.colorEnabled, true);
  assert.equal(result.diff.contextLines, 3);
  assert.equal(result.diff.maxDiffLines, 500);
  assert.equal(result.diff.maxFuzz, 2);
  assert.equal(result.approval.enabled, false, "approval.enabled 默认 false（高风险默认关闭）");
  assert.equal(result.approval.approvalMode, "suggest");
  assert.equal(result.approval.appMode, "agent");
  assert.equal(result.sideGit.enabled, true);
  assert.equal(result.sideGit.autoSnapshot, true);
  assert.equal(result.sideGit.maxSnapshots, 100);
  assert.equal(result.context.enabled, false, "context.enabled 默认 false");
  assert.equal(result.context.tokenBudget, 100000);
  assert.equal(result.context.topKFiles, 20);
  assert.equal(result.codemap.autoGenerateOnStartup, true);
  assert.equal(result.codemap.incremental, true);
  assert.deepEqual(result.codemap.excludeDirs, ["node_modules", ".git", "dist", "build"]);
  assert.equal(result.codemap.maxFileSizeKb, 100);
  assert.equal(result.memory.userGlobalEnabled, true);
  assert.equal(result.memory.projectMemoryEnabled, true);
  assert.equal(result.memory.experienceEnabled, true);
  assert.equal(result.memory.maxFacts, 100);
  assert.equal(result.memory.maxExperiences, 1000);
  assert.equal(result.memory.systemPromptInjectionLimit, 2000);
});

test("CFG-02: settings.json 用户配置层覆盖默认值", () => {
  // userJson 覆盖 diff.contextLines（默认 3 → 9）
  const result = mergeV2Config(
    {
      diff: { contextLines: 9 },
    },
    {},
    {}
  );

  assert.equal(result.diff.contextLines, 9, "userJson 应覆盖默认值");
  // userJson 未提供的字段保留默认值
  assert.equal(result.diff.enabled, true, "未覆盖字段保留默认值");
  assert.equal(result.diff.colorEnabled, true);
  assert.equal(result.diff.maxDiffLines, 500);
  assert.equal(result.enabled, false, "其他域保留默认值");
});

test("CFG-03: DEEPCODEX_V2_* 环境变量层覆盖用户配置", () => {
  // userJson 设置 contextLines=9，env 覆盖为 15
  const result = mergeV2Config(
    {
      diff: { contextLines: 9 },
    },
    {
      DEEPCODEX_V2_DIFF__CONTEXT_LINES: "15",
    },
    {}
  );

  assert.equal(result.diff.contextLines, 15, "env 应覆盖 userJson");
  // env 未提供的字段保留 userJson 或默认值
  assert.equal(result.diff.enabled, true, "未覆盖字段保留默认值");
});

test("CFG-04: CLI --v2-* 参数层覆盖环境变量（最高优先级）", () => {
  // 默认 3 → userJson 9 → env 15 → cliArgs 21
  const result = mergeV2Config(
    { diff: { contextLines: 9 } },
    { DEEPCODEX_V2_DIFF__CONTEXT_LINES: "15" },
    { "diff.contextLines": 21 }
  );

  assert.equal(result.diff.contextLines, 21, "cliArgs 应覆盖 env（最高优先级）");
});

test("CFG-05: 深合并语义（对象递归合并，非整体替换）", () => {
  // userJson 只提供 diff.contextLines，未提供 diff.enabled
  // 深合并：diff 对象递归合并，userJson 缺失的 enabled 保留默认 true
  const result = mergeV2Config(
    {
      diff: { contextLines: 9 },
      memory: { maxFacts: 200 },
    },
    {},
    {}
  );

  assert.equal(result.diff.contextLines, 9, "userJson 提供的字段覆盖");
  assert.equal(result.diff.enabled, true, "userJson 缺失的字段保留默认（深合并，非整体替换）");
  assert.equal(result.diff.colorEnabled, true);
  assert.equal(result.diff.maxDiffLines, 500);
  assert.equal(result.memory.maxFacts, 200);
  assert.equal(result.memory.maxExperiences, 1000, "memory 域其他字段保留默认");
});

test("CFG-06: 数组整体替换（非拼接）", () => {
  // codemap.excludeDirs 默认 ["node_modules", ".git", "dist", "build"]
  // userJson 提供新数组 ["vendor"]，应整体替换而非拼接
  const result = mergeV2Config(
    {
      codemap: { excludeDirs: ["vendor"] },
    },
    {},
    {}
  );

  assert.deepEqual(result.codemap.excludeDirs, ["vendor"], "数组整体替换（非拼接），不保留默认数组");
});

test("CFG-07: 未知键 strict 拒绝（userJson 层）", () => {
  // userJson 出现 schema 未声明的 key
  assert.throws(
    () => {
      mergeV2Config(
        {
          nonExistentKey: "value",
        },
        {},
        {}
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof V2ConfigError, "应抛 V2ConfigError");
      assert.match((err as V2ConfigError).message, /未知配置键/);
      assert.equal((err as V2ConfigError).keyPath, "nonExistentKey");
      assert.equal((err as V2ConfigError).sourceLayer, "userJson");
      return true;
    }
  );
});

test("CFG-08: 未知键 strict 拒绝（env 层）", () => {
  // env 出现 schema 未声明的 key
  assert.throws(
    () => {
      mergeV2Config(
        {},
        {
          DEEPCODEX_V2_UNKNOWN_FIELD: "value",
        },
        {}
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof V2ConfigError);
      assert.equal((err as V2ConfigError).sourceLayer, "env");
      // 环境变量名转小驼峰：UNKNOWN_FIELD → unknownField
      assert.equal((err as V2ConfigError).keyPath, "unknownField");
      return true;
    }
  );
});

test("CFG-09: 未知键 strict 拒绝（cliArgs 层）", () => {
  // cliArgs 出现 schema 未声明的 key
  assert.throws(
    () => {
      mergeV2Config(
        {},
        {},
        {
          "nonExistent.nested.key": "value",
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof V2ConfigError);
      assert.equal((err as V2ConfigError).sourceLayer, "cliArgs");
      return true;
    }
  );
});

test("CFG-10: 类型错误抛 V2ConfigError（含 keyPath 与 sourceLayer）", () => {
  // diff.contextLines 应为 number，传入字符串 "not-a-number"
  // zod 的 z.number() 不接受字符串，mergeV2Config 在 safeParse 失败时抛 V2ConfigError
  assert.throws(
    () => {
      mergeV2Config(
        {
          diff: { contextLines: "not-a-number" as unknown as number },
        },
        {},
        {}
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof V2ConfigError, "应抛 V2ConfigError");
      assert.match((err as V2ConfigError).message, /配置类型错误/);
      // keyPath 应包含 diff.contextLines
      assert.match((err as V2ConfigError).keyPath, /contextLines/);
      assert.equal((err as V2ConfigError).sourceLayer, "userJson");
      return true;
    }
  );
});

test("CFG-11: 非法枚举值抛 V2ConfigError", () => {
  // approval.approvalMode 只接受 "suggest" | "auto" | "never"（与 v2/approval/types.ts 对齐）
  assert.throws(
    () => {
      mergeV2Config(
        {
          approval: { approvalMode: "invalid-mode" as unknown as "suggest" },
        },
        {},
        {}
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof V2ConfigError);
      assert.match((err as V2ConfigError).keyPath, /approvalMode/);
      return true;
    }
  );
});

test("CFG-12: 三层叠加（默认 + userJson + env + cliArgs 同时生效）", () => {
  // 各层提供不同的字段，验证合并结果
  const result = mergeV2Config(
    {
      diff: { contextLines: 9 },
      memory: { maxFacts: 200 },
    },
    {
      DEEPCODEX_V2_ENABLED: "true",
      DEEPCODEX_V2_DIFF__MAX_DIFF_LINES: "1000",
    },
    {
      "approval.enabled": true,
      "context.tokenBudget": 200000,
    }
  );

  // 默认层
  assert.equal(result.diff.enabled, true, "默认 diff.enabled 保留");
  // userJson 层
  assert.equal(result.diff.contextLines, 9, "userJson 覆盖");
  assert.equal(result.memory.maxFacts, 200, "userJson 覆盖 memory.maxFacts");
  // env 层
  assert.equal(result.enabled, true, "env 覆盖 enabled");
  assert.equal(result.diff.maxDiffLines, 1000, "env 覆盖 diff.maxDiffLines");
  // cliArgs 层
  assert.equal(result.approval.enabled, true, "cliArgs 覆盖 approval.enabled");
  assert.equal(result.context.tokenBudget, 200000, "cliArgs 覆盖 context.tokenBudget");
  // 未覆盖的字段保留默认
  assert.equal(result.diff.maxFuzz, 2, "未覆盖字段保留默认");
  assert.equal(result.memory.maxExperiences, 1000, "未覆盖字段保留默认");
});

test("CFG-13: 空配置（全为空对象）返回完整默认值", () => {
  const result = mergeV2Config({}, {}, {});
  // 验证返回对象包含全部 7 个域
  assert.ok(result.enabled !== undefined);
  assert.ok(result.diff !== undefined);
  assert.ok(result.approval !== undefined);
  assert.ok(result.sideGit !== undefined);
  assert.ok(result.context !== undefined);
  assert.ok(result.codemap !== undefined);
  assert.ok(result.memory !== undefined);
  // 验证嵌套对象内部字段被完整填充（zod 6 行为：.default({}) 不触发内部字段解析，
  // mergeV2Config 通过显式传入嵌套空对象绕过此限制）
  assert.equal(result.diff.contextLines, 3, "diff.contextLines 应填充默认值 3");
  assert.equal(result.diff.enabled, true);
  assert.equal(result.approval.approvalMode, "suggest");
  assert.equal(result.approval.appMode, "agent");
  assert.equal(result.codemap.excludeDirs.length, 4, "codemap.excludeDirs 应填充默认数组");
  assert.equal(result.memory.maxFacts, 100);
});

test("CFG-14: 高层缺失的 key 保留低层值", () => {
  // userJson 设置 diff.contextLines=9，env 不提供 diff，cliArgs 不提供 diff
  // 结果：diff.contextLines 应保留 userJson 的 9
  const result = mergeV2Config(
    {
      diff: { contextLines: 9, maxDiffLines: 800 },
    },
    {
      DEEPCODEX_V2_DIFF__MAX_FUZZ: "5", // 只覆盖 maxFuzz
    },
    {}
  );

  assert.equal(result.diff.contextLines, 9, "userJson 提供的值保留");
  assert.equal(result.diff.maxDiffLines, 800, "userJson 提供的值保留");
  assert.equal(result.diff.maxFuzz, 5, "env 覆盖 maxFuzz");
  assert.equal(result.diff.enabled, true, "默认值保留");
});

test("CFG-15: 环境变量 JSON 值解析（true/false/数字/JSON 字符串）", () => {
  // env 值应为字符串，但内部尝试 JSON.parse
  const result = mergeV2Config(
    {},
    {
      DEEPCODEX_V2_ENABLED: "true", // JSON.parse("true") → boolean true
      DEEPCODEX_V2_DIFF__CONTEXT_LINES: "7", // JSON.parse("7") → number 7
      DEEPCODEX_V2_MEMORY__MAX_FACTS: "300", // number 300
    },
    {}
  );

  assert.equal(result.enabled, true, "字符串 'true' 应解析为 boolean true");
  assert.equal(result.diff.contextLines, 7, "字符串 '7' 应解析为 number 7");
  assert.equal(result.memory.maxFacts, 300, "字符串 '300' 应解析为 number 300");
});

test("CFG-16: 环境变量非 JSON 字符串值保留原值", () => {
  // 非 JSON 字符串（如路径）应保留为字符串
  const result = mergeV2Config(
    {},
    {
      DEEPCODEX_V2_APPROVAL__ARITY_DICTIONARY_PATH: "/path/to/dict.json",
    },
    {}
  );

  assert.equal(result.approval.arityDictionaryPath, "/path/to/dict.json", "非 JSON 字符串应保留为字符串");
});

test("CFG-17: 嵌套未知键检测（深层未知键）", () => {
  // diff 域是合法 key，但其下的 unknownNestedKey 是未知键
  assert.throws(
    () => {
      mergeV2Config(
        {
          diff: { unknownNestedKey: "value" } as unknown as Record<string, unknown>,
        },
        {},
        {}
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof V2ConfigError);
      assert.match((err as V2ConfigError).keyPath, /diff\.unknownNestedKey/);
      return true;
    }
  );
});

test("CFG-18: V2ConfigError 是 Error 子类", () => {
  const err = new V2ConfigError("test message", "test.path", "testLayer");
  assert.ok(err instanceof Error, "V2ConfigError 应是 Error 子类");
  assert.equal(err.name, "V2ConfigError");
  assert.equal(err.message, "test message");
  assert.equal(err.keyPath, "test.path");
  assert.equal(err.sourceLayer, "testLayer");
});

// ============================================================================
// buildV2Config 集成测试（docs/archive/repair-plan.md §3.1）
// ============================================================================

/**
 * 创建临时项目目录，并在其下生成 .deepcode/settings.json
 *
 * @param v2 v2 配置子树
 * @returns 项目根目录路径
 */
function createTempProjectWithV2(v2: Record<string, unknown>): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "build-v2-config-test-"));
  const deepcodeDir = path.join(projectRoot, ".deepcode");
  fs.mkdirSync(deepcodeDir, { recursive: true });
  fs.writeFileSync(path.join(deepcodeDir, "settings.json"), JSON.stringify({ v2 }, null, 2));
  return projectRoot;
}

/**
 * 清理临时项目目录
 */
function cleanupTempProject(projectRoot: string): void {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

test("BVC-01: 无 settings.json 且无环境变量时返回 V2 默认值", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "build-v2-config-empty-"));
  // 备份并清空相关环境变量，避免开发者本地环境干扰
  const originalEnabled = process.env.DEEPCODEX_V2_ENABLED;
  const originalContextEnabled = process.env.DEEPCODEX_V2_CONTEXT__ENABLED;
  delete process.env.DEEPCODEX_V2_ENABLED;
  delete process.env.DEEPCODEX_V2_CONTEXT__ENABLED;

  try {
    const result = buildV2Config(projectRoot);
    assert.equal(result.enabled, false, "V2 总开关默认关闭");
    assert.equal(result.context.enabled, false, "V2 上下文默认关闭");
    assert.equal(result.diff.enabled, true, "diff 增强默认启用");
    assert.equal(result.codemap.maxFileSizeKb, 100, "codemap 默认值保留");
  } finally {
    cleanupTempProject(projectRoot);
    if (originalEnabled !== undefined) process.env.DEEPCODEX_V2_ENABLED = originalEnabled;
    if (originalContextEnabled !== undefined) process.env.DEEPCODEX_V2_CONTEXT__ENABLED = originalContextEnabled;
  }
});

test("BVC-02: 项目级 settings.json 的 v2 子树覆盖默认值", () => {
  const projectRoot = createTempProjectWithV2({
    context: { enabled: true, tokenBudget: 50000 },
    codemap: { maxFileSizeKb: 200 },
  });

  try {
    const result = buildV2Config(projectRoot);
    assert.equal(result.context.enabled, true, "项目级 settings 启用 V2 上下文");
    assert.equal(result.context.tokenBudget, 50000, "项目级 settings 覆盖 tokenBudget");
    assert.equal(result.codemap.maxFileSizeKb, 200, "项目级 settings 覆盖 codemap.maxFileSizeKb");
    assert.equal(result.enabled, false, "未覆盖字段保留默认");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("BVC-03: DEEPCODEX_V2_* 环境变量覆盖项目级 settings", () => {
  const projectRoot = createTempProjectWithV2({
    context: { enabled: false },
  });

  // 备份环境变量
  const originalEnabled = process.env.DEEPCODEX_V2_ENABLED;
  const originalContextEnabled = process.env.DEEPCODEX_V2_CONTEXT__ENABLED;
  process.env.DEEPCODEX_V2_ENABLED = "true";
  process.env.DEEPCODEX_V2_CONTEXT__ENABLED = "true";

  try {
    const result = buildV2Config(projectRoot);
    assert.equal(result.enabled, true, "环境变量覆盖 V2 总开关");
    assert.equal(result.context.enabled, true, "环境变量覆盖 context.enabled");
  } finally {
    cleanupTempProject(projectRoot);
    if (originalEnabled !== undefined) process.env.DEEPCODEX_V2_ENABLED = originalEnabled;
    else delete process.env.DEEPCODEX_V2_ENABLED;
    if (originalContextEnabled !== undefined) process.env.DEEPCODEX_V2_CONTEXT__ENABLED = originalContextEnabled;
    else delete process.env.DEEPCODEX_V2_CONTEXT__ENABLED;
  }
});

test("BVC-04: 项目级与用户级 v2 子树深度合并（项目级覆盖用户级）", () => {
  // 构造临时 HOME 目录，使 readSettings 读取用户级 settings.json
  const originalHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "build-v2-config-home-"));
  const userDeepcodeDir = path.join(tempHome, ".deepcode");
  fs.mkdirSync(userDeepcodeDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDeepcodeDir, "settings.json"),
    JSON.stringify(
      {
        v2: {
          context: { enabled: false, tokenBudget: 100000, topKFiles: 10 },
          diff: { contextLines: 5 },
        },
      },
      null,
      2
    )
  );
  process.env.HOME = tempHome;

  const projectRoot = createTempProjectWithV2({
    context: { enabled: true, topKFiles: 30 },
  });

  try {
    const result = buildV2Config(projectRoot);
    // 项目级覆盖用户级
    assert.equal(result.context.enabled, true, "项目级覆盖 context.enabled");
    assert.equal(result.context.topKFiles, 30, "项目级覆盖 topKFiles");
    // 用户级保留（项目级未提供）
    assert.equal(result.context.tokenBudget, 100000, "用户级 tokenBudget 保留");
    assert.equal(result.diff.contextLines, 5, "用户级 diff.contextLines 保留");
  } finally {
    cleanupTempProject(projectRoot);
    // 恢复 HOME
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
