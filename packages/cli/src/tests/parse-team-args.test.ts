/**
 * parse-team-args.test.ts - TUI /team 命令参数解析纯函数单元测试（S2）
 *
 * 测试目标（对照 docs/optimization-plan-20260819.md §3.2 TUI 入口修正）：
 *   - parseTeamArgs 从 App.tsx 抽取后行为等价（除 failFast 语义修正项外）
 *   - failFast 三态归一：未指定 → true（默认）；--fail-fast → true；--no-fail-fast → false
 *     （旧实现仅在 === true 时置位，TUI 无法表达 false，属本次修复的核心验证点）
 *   - 各参数默认值与类型转换（keywords 数组化 / maxIterations 数字化 / kebab→camel）
 *
 * 测试场景：
 *   - TPA-001: 空输入 → subcommand 默认 "list"、failFast 默认 true
 *   - TPA-002: 5 个合法子命令位置参数逐一解析
 *   - TPA-003: 未知子命令保留原值（交给 executeTeamCommand 的 exhaustiveness check）
 *   - TPA-004: --fail-fast → failFast = true
 *   - TPA-005: --no-fail-fast → failFast = false（S2 核心修正）
 *   - TPA-006: 值参数解析（--task / --goal / --role / --task-file / --project-root / --test-command）
 *   - TPA-007: --keywords 逗号分隔转数组（trim + 空段过滤）
 *   - TPA-008: --max-iterations 合法数字转换与非法值删除
 *   - TPA-009: kebab→camel 转换（--force-role / --resume-run / --use-loop / --prd-path /
 *              --architecture-path / --test-plan-path）
 *   - TPA-010: 典型参数组合完整解析（与 App.tsx 原行为等价的回归快照）
 *   - TPA-011: failFast 显式 true ≡ 未指定（解析层等价性）
 *
 * 测试约定（遵循用户规则）：
 *   - 使用 node:test + node:assert/strict；纯函数测试，无需临时目录与输出拦截
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTeamArgs } from "../ui/core/parse-team-args.js";

// ============================================================================
// TPA-001: 空输入 → subcommand 默认 "list"、failFast 默认 true
// ============================================================================

test("TPA-001: 空输入 → subcommand 默认 list，failFast 默认 true", () => {
  const args = parseTeamArgs([]);

  assert.equal(args.subcommand, "list", `subcommand 应默认 "list"，实际: ${args.subcommand}`);
  // S2 修正：未指定 fail-fast 时默认 true（与 CLI 入口 cli.tsx 的默认语义一致）
  assert.equal(args.failFast, true, `failFast 应默认 true，实际: ${args.failFast}`);
  // 其余字段不应被填充（避免 undefined 字段污染）
  assert.equal(args.task, undefined, "task 不应被填充");
  assert.equal(args.goal, undefined, "goal 不应被填充");
  assert.equal(args.keywords, undefined, "keywords 不应被填充");
  assert.equal(args.consensus, undefined, "consensus 不应被填充");
});

// ============================================================================
// TPA-002: 5 个合法子命令位置参数逐一解析
// ============================================================================

test("TPA-002: 5 个合法子命令位置参数逐一解析", () => {
  for (const sub of ["list", "match", "dispatch", "autonomous", "full-lifecycle"] as const) {
    const args = parseTeamArgs([sub]);
    assert.equal(args.subcommand, sub, `子命令 "${sub}" 应被正确解析`);
  }
});

// ============================================================================
// TPA-003: 未知子命令自动降级为 autonomous --task 自由文本（2026-09-16 架构改进）
// 旧行为：未知子命令保留原值交给 executeTeamCommand 的 default 分支报错
// 新行为：自动降级为 autonomous，把所有自由文本拼成 task 描述传入
// 根因日志铁证：用户输入 "/team 1）读取报告与关联业务数据；2）建立字段映射..."
// 时，"1）读取报告..." 被当成非法子命令名直接报错，导致建议→执行死循环
// ============================================================================

test("TPA-003: 未知子命令自动降级为 autonomous + task", () => {
  // 简单场景：单个非法 token
  const args = parseTeamArgs(["unknown-cmd"]);
  assert.equal(args.subcommand, "autonomous", `未知子命令应降级为 "autonomous"，实际: ${args.subcommand}`);
  assert.equal(args.task, "unknown-cmd", `原始自由文本应拼入 task，实际: ${args.task}`);
});

test("TPA-003b: 真实用户场景——/team 后接自然语言目标描述自动降级", () => {
  // 用户实际报错场景："/team 1）读取报告与关联业务数据；2）建立字段映射..."
  const args = parseTeamArgs([
    "1）读取报告与关联业务数据；2）建立字段映射",
    "3）执行数据对齐校验；4）梳理表间/模块间数据关系",
  ]);
  assert.equal(args.subcommand, "autonomous", `应降级为 "autonomous"，实际: ${args.subcommand}`);
  // 所有 tokens（包括非法首 token）拼成 task
  assert.ok(args.task?.includes("1）读取报告"), `task 应包含原始自由文本，实际: ${args.task}`);
  assert.ok(args.task?.includes("梳理表间/模块间数据关系"), `task 应包含所有 tokens，实际: ${args.task}`);
  // 未填充其他字段（降级时全部消费，不再参与 --key value 解析）
  assert.equal(args.goal, undefined, `降级路径不应填充 goal`);
});

test("TPA-003c: /team 直接跟自由文本且无合法子命令——不消费后续 --key value（降级优先）", () => {
  // 降级触发时，所有 tokens 一次性拼成 task，不再参与后续 --key value 解析
  const args = parseTeamArgs(["做一个同步脚本", "--max-iterations", "5", "--fail-fast"]);
  assert.equal(args.subcommand, "autonomous", `应降级为 "autonomous"，实际: ${args.subcommand}`);
  // 降级路径把所有 tokens 都拼进 task（包括 "--max-iterations 5 --fail-fast"）
  assert.ok(args.task?.includes("做一个同步脚本"), `task 应包含自由文本前缀`);
  // 但由于 tokens 被清空，--key value 参数不会被后续解析循环处理
  assert.equal(args.maxIterations, undefined, `降级路径下 --max-iterations 不被解析`);
});

test("TPA-003d: 合法子命令 + 可选自由文本描述——正常走 --task 解析（不触发降级）", () => {
  // 合法子命令开头的情况，自由文本应通过 --task 传入，不走降级路径
  const args = parseTeamArgs(["autonomous", "--task", "做一个同步脚本"]);
  assert.equal(args.subcommand, "autonomous", `合法子命令应正常识别`);
  assert.equal(args.task, "做一个同步脚本", `--task 参数应正确解析`);
  // 空 tokens（全部消费），failFast 默认 true
  assert.equal(args.failFast, true);
});

// ============================================================================
// TPA-004: --fail-fast → failFast = true
// ============================================================================

test("TPA-004: --fail-fast → failFast = true", () => {
  const args = parseTeamArgs(["dispatch", "--task", "测试任务", "--fail-fast"]);
  assert.equal(args.failFast, true, `--fail-fast 应解析为 true，实际: ${args.failFast}`);
  // 顺带验证值参数解析不受布尔参数影响
  assert.equal(args.task, "测试任务", `--task 值应正确解析，实际: ${args.task}`);
});

// ============================================================================
// TPA-005: --no-fail-fast → failFast = false（S2 核心修正）
// ============================================================================

test("TPA-005: --no-fail-fast → failFast = false（S2 核心修正）", () => {
  const args = parseTeamArgs(["dispatch", "--task", "测试任务", "--no-fail-fast"]);
  // 旧实现（raw.failFast === true 才置位）下 --no-fail-fast 被静默忽略，
  // failFast 保持 undefined → 消费端 !== false 判定为 true，无法关闭快速失败
  assert.equal(args.failFast, false, `--no-fail-fast 应解析为 false，实际: ${args.failFast}`);
});

// ============================================================================
// TPA-006: 值参数解析
// ============================================================================

test("TPA-006: 值参数解析（task / goal / role / taskFile / projectRoot / testCommand）", () => {
  const args = parseTeamArgs([
    "dispatch",
    "--task",
    "设计用户认证模块",
    "--goal",
    "实现登录功能",
    "--role",
    "architect",
    "--task-file",
    "./task.txt",
    "--project-root",
    "/tmp/demo",
    "--test-command",
    "npm test",
  ]);

  assert.equal(args.task, "设计用户认证模块", `--task 解析错误，实际: ${args.task}`);
  assert.equal(args.goal, "实现登录功能", `--goal 解析错误，实际: ${args.goal}`);
  assert.equal(args.role, "architect", `--role 解析错误，实际: ${args.role}`);
  assert.equal(args.taskFile, "./task.txt", `--task-file 解析错误，实际: ${args.taskFile}`);
  assert.equal(args.projectRoot, "/tmp/demo", `--project-root 解析错误，实际: ${args.projectRoot}`);
  assert.equal(args.testCommand, "npm test", `--test-command 解析错误，实际: ${args.testCommand}`);
});

// ============================================================================
// TPA-007: --keywords 逗号分隔转数组（trim + 空段过滤）
// ============================================================================

test("TPA-007: --keywords 逗号分隔转数组（trim + 空段过滤）", () => {
  const args = parseTeamArgs(["match", "--keywords", "微服务, 架构 , ,API"]);
  assert.deepEqual(args.keywords, ["微服务", "架构", "API"], `--keywords 数组化错误，实际: ${args.keywords}`);
});

// ============================================================================
// TPA-008: --max-iterations 合法数字转换与非法值删除
// ============================================================================

test("TPA-008: --max-iterations 数字转换（合法保留 / 非法删除）", () => {
  // 合法数字：字符串 "5" → 数字 5
  const ok = parseTeamArgs(["autonomous", "--max-iterations", "5"]);
  assert.equal(ok.maxIterations, 5, `合法 "5" 应转换为数字 5，实际: ${ok.maxIterations}`);

  // 非法数字：无法 parseInt 的值应被删除（不填充字段）
  const bad = parseTeamArgs(["autonomous", "--max-iterations", "abc"]);
  assert.equal(bad.maxIterations, undefined, `非法 "abc" 应被删除，实际: ${bad.maxIterations}`);
});

// ============================================================================
// TPA-009: kebab→camel 转换（布尔与值参数）
// ============================================================================

test("TPA-009: kebab→camel 转换（forceRole / resumeRun / useLoop / prdPath / architecturePath / testPlanPath）", () => {
  const args = parseTeamArgs([
    "full-lifecycle",
    "--force-role",
    "--resume-run",
    "--use-loop",
    "--prd-path",
    "docs/prd.md",
    "--architecture-path",
    "docs/arch.md",
    "--test-plan-path",
    "docs/plan.md",
  ]);

  assert.equal(args.forceRole, true, `--force-role 应转换 forceRole=true，实际: ${args.forceRole}`);
  assert.equal(args.resumeRun, true, `--resume-run 应转换 resumeRun=true，实际: ${args.resumeRun}`);
  assert.equal(args.useLoop, true, `--use-loop 应转换 useLoop=true，实际: ${args.useLoop}`);
  assert.equal(args.prdPath, "docs/prd.md", `--prd-path 应转换 prdPath，实际: ${args.prdPath}`);
  assert.equal(
    args.architecturePath,
    "docs/arch.md",
    `--architecture-path 应转换 architecturePath，实际: ${args.architecturePath}`
  );
  assert.equal(args.testPlanPath, "docs/plan.md", `--test-plan-path 应转换 testPlanPath，实际: ${args.testPlanPath}`);
});

// ============================================================================
// TPA-010: 典型参数组合完整解析（与 App.tsx 原行为等价的回归快照）
// ============================================================================

test("TPA-010: 典型参数组合完整解析（App.tsx 原行为等价回归）", () => {
  const args = parseTeamArgs([
    "full-lifecycle",
    "--goal",
    "电商网站",
    "--consensus",
    "--fail-fast",
    "--max-iterations",
    "3",
    "--use-loop",
    "--prd-path",
    "docs/prd.md",
    "--test-command",
    "npm test",
  ]);

  // 除 failFast（恒为 boolean，S2 修正项）外，全部字段与 App.tsx 原实现等价
  assert.equal(args.subcommand, "full-lifecycle");
  assert.equal(args.goal, "电商网站");
  assert.equal(args.consensus, true);
  assert.equal(args.failFast, true);
  assert.equal(args.maxIterations, 3);
  assert.equal(args.useLoop, true);
  assert.equal(args.prdPath, "docs/prd.md");
  assert.equal(args.testCommand, "npm test");
  // 未提供的字段不应被填充
  assert.equal(args.role, undefined);
  assert.equal(args.task, undefined);
  assert.equal(args.taskFile, undefined);
  assert.equal(args.keywords, undefined);
  assert.equal(args.forceRole, undefined);
  assert.equal(args.projectRoot, undefined);
  assert.equal(args.resumeRun, undefined);
  assert.equal(args.architecturePath, undefined);
  assert.equal(args.testPlanPath, undefined);
});

// ============================================================================
// TPA-011: failFast 显式 true ≡ 未指定（解析层等价性）
// ============================================================================

test("TPA-011: failFast 显式 --fail-fast 与未指定解析结果等价", () => {
  const explicit = parseTeamArgs(["dispatch", "--task", "t", "--fail-fast"]);
  const implicit = parseTeamArgs(["dispatch", "--task", "t"]);

  // 显式 true 与默认（未指定）在解析层归一为同一值 true
  assert.equal(explicit.failFast, true, `显式 --fail-fast 应为 true，实际: ${explicit.failFast}`);
  assert.equal(implicit.failFast, true, `未指定应默认 true，实际: ${implicit.failFast}`);
  assert.equal(explicit.failFast, implicit.failFast, "显式与默认的 failFast 应等价");
});
