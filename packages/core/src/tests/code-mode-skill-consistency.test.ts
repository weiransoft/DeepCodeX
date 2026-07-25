/**
 * P0-T6：文档对照测试
 *
 * 验证 code-mode-orchestrator skill 中引用的 WorkflowPattern 枚举值、
 * PatternExecutor 类名、selectPatternForTask 函数签名与代码实现一致。
 *
 * 这是 E1 方案的关键守护测试——确保 skill 文档不与代码实现脱节。
 * 每次 team/workflows/ 代码变更都应触发本测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// 导入真实的 WorkflowPattern 枚举定义（types.ts:268-277）
import { WorkflowPattern } from "../team/types";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 读取 code-mode-orchestrator skill 的 SKILL.md 内容
 * @returns SKILL.md 文件内容字符串
 */
function readCodeModeSkillMd(): string {
  const skillPath = path.join(repoRoot, "templates/skills/bundled/code-mode-orchestrator/SKILL.md");
  return fs.readFileSync(skillPath, "utf-8");
}

/**
 * 读取 pattern-composer.ts 源码，用于验证 selectPatternForTask 函数存在
 * @returns pattern-composer.ts 文件内容字符串
 */
function readPatternComposerSource(): string {
  const composerPath = path.join(repoRoot, "src/team/workflows/pattern-composer.ts");
  return fs.readFileSync(composerPath, "utf-8");
}

/**
 * 读取 pattern-executor.ts 源码，用于验证 PatternExecutor 类名存在
 * @returns pattern-executor.ts 文件内容字符串
 */
function readPatternExecutorSource(): string {
  const executorPath = path.join(repoRoot, "src/team/workflows/pattern-executor.ts");
  return fs.readFileSync(executorPath, "utf-8");
}

// ============================================================================
// 测试组 1：WorkflowPattern 枚举值一致性
// ============================================================================

test("P0-T6: skill 中引用的 WorkflowPattern 枚举值与 types.ts 一致", () => {
  const skillContent = readCodeModeSkillMd();

  // 从 types.ts 获取真实的枚举值
  const expectedPatterns = [
    "classifier-dispatch",
    "fan-out-aggregate",
    "adversarial-verify",
    "generate-filter",
    "tournament",
    "loop-until-done",
  ] as const;

  // 验证每个枚举值都在 SKILL.md 中出现
  for (const pattern of expectedPatterns) {
    assert.equal(skillContent.includes(pattern), true, `SKILL.md 缺少 WorkflowPattern 枚举值: ${pattern}`);
  }

  // 验证 SKILL.md 中没有编造不存在的模式
  // （检查反引号包裹的模式名都在真实枚举中）
  const patternMatches = skillContent.match(/`([a-z-]+)`/g) ?? [];
  const codeModePatterns = patternMatches
    .filter((match) =>
      ["dispatch", "aggregate", "verify", "filter", "tournament", "loop", "until", "done"].some((keyword) =>
        match.includes(keyword)
      )
    )
    .map((match) => match.replace(/`/g, ""));

  for (const pattern of codeModePatterns) {
    if (pattern.includes("-") && !pattern.startsWith("fan-out")) {
      assert.equal(
        (expectedPatterns as readonly string[]).includes(pattern) || pattern === "sequential",
        true,
        `SKILL.md 引用了不存在的 WorkflowPattern: ${pattern}`
      );
    }
  }
});

// ============================================================================
// 测试组 2：PatternExecutor 类名一致性
// ============================================================================

test("P0-T6: skill 中引用的 PatternExecutor 类名与 pattern-executor.ts 一致", () => {
  const skillContent = readCodeModeSkillMd();
  const executorSource = readPatternExecutorSource();

  // skill 中引用的执行器类名
  const expectedExecutors = [
    "ClassifierDispatchExecutor",
    "FanOutAggregateExecutor",
    "AdversarialVerifyExecutor",
    "GenerateFilterExecutor",
    "TournamentExecutor",
    "LoopUntilDoneExecutor",
    "SequentialExecutor",
  ];

  // 验证每个执行器类名都在 SKILL.md 中出现
  for (const executor of expectedExecutors) {
    assert.equal(skillContent.includes(executor), true, `SKILL.md 缺少 PatternExecutor 类名: ${executor}`);
  }

  // 验证每个执行器类名都在 pattern-executor.ts 源码中定义
  for (const executor of expectedExecutors) {
    // 检查 class 定义或 export
    const classPattern = new RegExp(`class\\s+${executor}\\b`);
    const exportPattern = new RegExp(`export\\b.*\\b${executor}\\b`);
    assert.equal(
      classPattern.test(executorSource) || exportPattern.test(executorSource),
      true,
      `pattern-executor.ts 缺少 ${executor} 类定义或导出`
    );
  }
});

// ============================================================================
// 测试组 3：selectPatternForTask 函数签名一致性
// ============================================================================

test("P0-T6: skill 中引用的 selectPatternForTask 函数在 pattern-composer.ts 中存在", () => {
  const skillContent = readCodeModeSkillMd();
  const composerSource = readPatternComposerSource();

  // 验证 SKILL.md 引用了 selectPatternForTask
  assert.equal(skillContent.includes("selectPatternForTask"), true, "SKILL.md 应引用 selectPatternForTask 便捷函数");

  // 验证 pattern-composer.ts 中定义了 selectPatternForTask 函数
  // 检查 export function selectPatternForTask 或 export const selectPatternForTask
  const functionPattern = /export\s+(?:async\s+)?function\s+selectPatternForTask\b/;
  const constPattern = /export\s+const\s+selectPatternForTask\b/;
  assert.equal(
    functionPattern.test(composerSource) || constPattern.test(composerSource),
    true,
    "pattern-composer.ts 应导出 selectPatternForTask 函数"
  );
});

test("P0-T6: skill 中引用的 PatternComposer 类在 pattern-composer.ts 中存在", () => {
  const skillContent = readCodeModeSkillMd();
  const composerSource = readPatternComposerSource();

  // 验证 SKILL.md 引用了 PatternComposer 类
  assert.equal(skillContent.includes("PatternComposer"), true, "SKILL.md 应引用 PatternComposer 类");

  // 验证 pattern-composer.ts 中定义了 PatternComposer 类
  const classPattern = /export\s+class\s+PatternComposer\b/;
  assert.equal(classPattern.test(composerSource), true, "pattern-composer.ts 应导出 PatternComposer 类");

  // 验证 PatternComposer 有 select 实例方法
  const selectMethodPattern = /select\s*\(\s*task\s*[:\s]/;
  assert.equal(selectMethodPattern.test(composerSource), true, "PatternComposer 类应有 select 实例方法");
});

// ============================================================================
// 测试组 4：8 个配套组件一致性
// ============================================================================

test("P0-T6: skill 中引用的 8 个配套组件在 workflows/index.ts 中存在", () => {
  const skillContent = readCodeModeSkillMd();
  const indexPath = path.join(repoRoot, "src/team/workflows/index.ts");
  const indexSource = fs.readFileSync(indexPath, "utf-8");

  // skill 中引用的 8 个配套组件（PascalCase 类名 + kebab-case 模块名两种形式）
  const expectedComponents = [
    { pascal: "PatternTierResolver", kebab: "pattern-tier-resolver" },
    { pascal: "ModelRouter", kebab: "model-router" },
    { pascal: "TokenBudgetGuard", kebab: "token-budget-guard" },
    { pascal: "SkillInjector", kebab: "skill-injector" },
    { pascal: "InterruptionRecovery", kebab: "interruption-recovery" },
    { pascal: "SemanticEmbedder", kebab: "semantic-embedder" },
    { pascal: "SubagentSandbox", kebab: "subagent-sandbox" },
    { pascal: "WorktreeManager", kebab: "worktree-manager" },
  ];

  // 验证每个组件在 SKILL.md 中出现（PascalCase 或 kebab-case 任一即可）
  for (const { pascal, kebab } of expectedComponents) {
    assert.equal(
      skillContent.includes(pascal) || skillContent.includes(kebab),
      true,
      `SKILL.md 缺少配套组件引用: ${pascal}（或 ${kebab}）`
    );
  }

  // 验证每个组件在 index.ts 中导出（PascalCase 类名）或对应模块文件存在
  // 注意 1：index.ts 使用多行 export 语法（export { ... } from "..."），
  //         因此正则需要使用 [\s\S]* 跨行匹配，而非默认不匹配换行的 .*
  // 注意 2：部分组件是"模块级组件"——模块文件（kebab-case.ts）存在并提供能力，
  //         但模块内没有与模块同名的 class（如 semantic-embedder.ts 导出
  //         TFIDFEmbedder/HashingEmbedder/SentenceTransformerEmbedder 等多个实现类）。
  //         此类组件验证规则：PascalCase 类导出 OR kebab-case 模块文件存在，任一即可。
  const workflowsDir = path.join(repoRoot, "src/team/workflows");
  for (const { pascal, kebab } of expectedComponents) {
    const exportPattern = new RegExp(`export\\b[\\s\\S]*\\b${pascal}\\b`);
    const moduleFileExists = fs.existsSync(path.join(workflowsDir, `${kebab}.ts`));
    assert.equal(
      exportPattern.test(indexSource) || moduleFileExists,
      true,
      `workflows/index.ts 应导出 ${pascal}，或 workflows/${kebab}.ts 模块文件应存在`
    );
  }
});

// ============================================================================
// 测试组 5：代码引用路径准确性
// ============================================================================

test("P0-T6: skill 中引用的代码路径文件真实存在", () => {
  const skillContent = readCodeModeSkillMd();

  // 提取 SKILL.md 中引用的代码文件路径
  const filePaths = [
    "src/team/types.ts",
    "src/team/workflows/pattern-composer.ts",
    "src/team/workflows/pattern-executor.ts",
    "src/team/workflows/index.ts",
  ];

  for (const filePath of filePaths) {
    const fullPath = path.join(repoRoot, filePath);
    assert.equal(fs.existsSync(fullPath), true, `SKILL.md 引用的代码文件不存在: ${filePath}`);
  }
});

// ============================================================================
// 测试组 6：安全约束引用一致性
// ============================================================================

test("P0-T6: skill 中引用的安全约束与 PatternExecutor 实现一致", () => {
  const skillContent = readCodeModeSkillMd();
  const executorSource = readPatternExecutorSource();

  // skill 中引用的安全约束关键词
  const expectedConstraints = ["maxIterations", "token-budget-guard", "异常隔离", "输入校验"];

  for (const constraint of expectedConstraints) {
    assert.equal(skillContent.includes(constraint), true, `SKILL.md 应引用安全约束: ${constraint}`);
  }

  // 验证 maxIterations 在 pattern-executor.ts 中实现
  assert.equal(executorSource.includes("maxIterations"), true, "pattern-executor.ts 应实现 maxIterations 约束");
});

// ============================================================================
// 测试组 7：PatternExecutorResult 状态值一致性
// ============================================================================

test("P0-T6: skill 中引用的状态值与 PatternExecutorResult 实现一致", () => {
  const skillContent = readCodeModeSkillMd();
  const executorSource = readPatternExecutorSource();

  // skill 中引用的状态值
  const expectedStatuses = ["success", "partial_success", "failure", "rejected", "timeout", "cancelled"];

  for (const status of expectedStatuses) {
    assert.equal(skillContent.includes(status), true, `SKILL.md 应引用 PatternExecutorResult 状态: ${status}`);
    assert.equal(executorSource.includes(status), true, `pattern-executor.ts 应实现状态: ${status}`);
  }
});

// ============================================================================
// 测试组 8：WorkflowPattern 枚举运行时验证
// ============================================================================

test("P0-T6: WorkflowPattern 枚举值运行时验证", () => {
  // 直接验证导入的 WorkflowPattern 枚举包含 6 种模式
  const patterns = [
    WorkflowPattern.enum["classifier-dispatch"],
    WorkflowPattern.enum["fan-out-aggregate"],
    WorkflowPattern.enum["adversarial-verify"],
    WorkflowPattern.enum["generate-filter"],
    WorkflowPattern.enum["tournament"],
    WorkflowPattern.enum["loop-until-done"],
  ];

  // 验证每个枚举值就是字符串本身
  assert.equal(patterns[0], "classifier-dispatch");
  assert.equal(patterns[1], "fan-out-aggregate");
  assert.equal(patterns[2], "adversarial-verify");
  assert.equal(patterns[3], "generate-filter");
  assert.equal(patterns[4], "tournament");
  assert.equal(patterns[5], "loop-until-done");
});
