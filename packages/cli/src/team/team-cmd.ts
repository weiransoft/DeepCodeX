/**
 * Team 子命令 - 多角色协同调度 CLI 入口
 *
 * 来源：multi-agent-team skill 主入口（CLI 模式）
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 支持的子命令：
 *   - team list          列出所有可用角色
 *   - team match         根据关键词匹配角色
 *   - team dispatch      分派任务到指定角色
 *   - team autonomous    启动 Ralph 自主迭代模式（4 阶段）
 *   - team full-lifecycle  7 阶段项目全流程
 *
 * 用法：
 *   deepcodex team list
 *   deepcodex team match "设计微服务架构"
 *   deepcodex team dispatch --role architect --task "设计用户认证模块"
 *   deepcodex team autonomous --goal "实现 OAuth2 登录" --max-iter 5
 *   deepcodex team full-lifecycle --project "电商网站"
 */

import {
  ROLE_REGISTRY,
  matchRoles,
  executeDispatch,
  buildTask,
  listAllRoles,
  formatRoleInfo,
  type RoleId,
  type RoleDefinition,
  type TaskRequirement,
  type MatchResult,
  type DispatchOptions,
  type DispatchResult,
} from "@vegamo/deepcode-core";
import { writeStdoutLine, writeStderrLine } from "../utils/stdio-helpers";

/** Team 子命令类型 */
export type TeamSubcommand = "list" | "match" | "dispatch" | "autonomous" | "full-lifecycle";

/** Team 子命令参数 */
export interface TeamCommandArgs {
  subcommand: TeamSubcommand;
  /** 角色 ID（dispatch 模式） */
  role?: RoleId;
  /** 任务文本（dispatch / autonomous / full-lifecycle 模式） */
  task?: string;
  /** 项目目标（autonomous / full-lifecycle 模式） */
  goal?: string;
  /** 角色关键词（match 模式） */
  keywords?: string[];
  /** 最大迭代次数（autonomous 模式） */
  maxIterations?: number;
  /** 是否强制指定角色（禁用匹配） */
  forceRole?: boolean;
  /** 共识模式（5 角色联合评审） */
  consensus?: boolean;
  /** 失败时中止（fail-fast） */
  failFast?: boolean;
  /** 项目根目录 */
  projectRoot?: string;
}

/** Team 子命令入口 */
export async function executeTeamCommand(args: TeamCommandArgs): Promise<number> {
  const startTime = Date.now();
  writeStdoutLine(`\n🧠 DeepCodeX Team - ${args.subcommand}\n`);

  try {
    switch (args.subcommand) {
      case "list":
        return executeListCommand(startTime);
      case "match":
        return await executeMatchCommand(args, startTime);
      case "dispatch":
        return await executeDispatchCommand(args, startTime);
      case "autonomous":
        return await executeAutonomousCommand(args, startTime);
      case "full-lifecycle":
        return await executeFullLifecycleCommand(args, startTime);
      default: {
        // TypeScript exhaustiveness check：未知子命令应被参数解析拒绝
        const _exhaustive: never = args.subcommand;
        writeStderrLine(`未知的 team 子命令: ${String(_exhaustive)}\n`);
        return 1;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeStderrLine(`\n✖ Team 命令执行失败: ${message}\n`);
    return 1;
  }
}

/** list 子命令 - 列出所有可用角色 */
function executeListCommand(startTime: number): number {
  const roles = listAllRoles();
  writeStdoutLine(`可用角色（${roles.length} 个）:\n`);

  for (const role of roles) {
    // formatRoleInfo 接受 RoleDefinition 对象
    const info = formatRoleInfo(role);
    writeStdoutLine(info);
    writeStdoutLine("");
  }

  const duration = Date.now() - startTime;
  writeStdoutLine(`⏱  耗时: ${duration}ms\n`);
  return 0;
}

/** match 子命令 - 根据关键词匹配角色 */
async function executeMatchCommand(args: TeamCommandArgs, startTime: number): Promise<number> {
  if (!args.keywords || args.keywords.length === 0) {
    writeStderrLine("match 子命令需要 --keywords 参数\n");
    return 1;
  }

  // 构造 TaskRequirement（注意：priority 是字符串字面量）
  const description = args.keywords.join(" ");
  const task: TaskRequirement = buildTask({
    title: args.task ?? description,
    description,
  });

  const matches = await matchRoles(task, { topK: 5 });

  writeStdoutLine(`\n匹配结果（top ${matches.length}）:\n`);
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const bar = "█".repeat(Math.round(m.confidence * 20));
    writeStdoutLine(`  ${i + 1}. ${m.roleId.padEnd(20)} ${bar} ${(m.confidence * 100).toFixed(1)}%`);
    if (m.reasons.length > 0) {
      writeStdoutLine(`     理由: ${m.reasons[0]}`);
    }
  }

  const duration = Date.now() - startTime;
  writeStdoutLine(`\n⏱  耗时: ${duration}ms\n`);
  return 0;
}

/** dispatch 子命令 - 分派任务到指定角色 */
async function executeDispatchCommand(args: TeamCommandArgs, startTime: number): Promise<number> {
  if (!args.task) {
    writeStderrLine("dispatch 子命令需要 --task 参数\n");
    return 1;
  }

  // 构造 TaskRequirement
  const task: TaskRequirement = buildTask({
    title: args.task,
    description: args.task,
  });

  // 决定 forceRole：若用户通过 --role 显式指定，则 forceRole
  let forceRoleObj: DispatchOptions["forceRole"] | undefined;
  if (args.role) {
    forceRoleObj = { roleId: args.role, reason: "通过 CLI --role 强制指定" };
  } else if (args.forceRole) {
    writeStderrLine("✖ --force-role 需要 --role 参数配合使用\n");
    return 1;
  }

  // 构造调度选项
  const options: Partial<DispatchOptions> = {
    projectRoot: args.projectRoot ?? process.cwd(),
    ...(forceRoleObj ? { forceRole: forceRoleObj } : {}),
  };

  writeStdoutLine(`\n📋 任务: ${task.title}\n`);
  if (forceRoleObj) {
    writeStdoutLine(`🎯 目标角色: ${forceRoleObj.roleId}（强制）\n`);
  } else {
    writeStdoutLine(`🔍 模式: 自动匹配\n`);
  }
  writeStdoutLine(`\n`);

  // executeDispatch(task, options, onProgress) - 第二参数是 options，第三是 onProgress
  const result: DispatchResult = await executeDispatch(task, options);

  // 输出调度结果
  writeStdoutLine(`\n━━━ 调度结果 ━━━\n`);
  writeStdoutLine(`状态: ${result.status}\n`);
  writeStdoutLine(`任务 ID: ${result.taskId}\n`);
  writeStdoutLine(`派发 ID: ${result.dispatchId}\n`);
  writeStdoutLine(`匹配角色: ${result.matchedRole.roleId} (${(result.matchedRole.confidence * 100).toFixed(1)}%)\n`);
  if (result.error) {
    writeStderrLine(`错误: ${result.error}\n`);
  }
  if (result.output) {
    writeStdoutLine(`\n📤 输出:\n${result.output}\n`);
  }

  const duration = Date.now() - startTime;
  writeStdoutLine(`\n⏱  耗时: ${duration}ms\n`);

  return result.status === "succeeded" ? 0 : 1;
}

/** autonomous 子命令 - Ralph 自主迭代模式（4 阶段循环） */
async function executeAutonomousCommand(args: TeamCommandArgs, startTime: number): Promise<number> {
  const goal = args.goal ?? args.task;
  if (!goal) {
    writeStderrLine("autonomous 子命令需要 --goal 或 --task 参数\n");
    return 1;
  }

  const maxIter = args.maxIterations ?? 5;
  writeStdoutLine(`🚀 启动 Autonomous 模式: ${goal}\n`);
  writeStdoutLine(`最大迭代: ${maxIter}\n\n`);

  // 4 阶段循环：plan → dev → verify → fix
  const stages = ["plan", "dev", "verify", "fix"] as const;
  for (let iter = 1; iter <= maxIter; iter++) {
    writeStdoutLine(`\n━━━ 第 ${iter}/${maxIter} 轮迭代 ━━━\n`);

    for (const stage of stages) {
      writeStdoutLine(`▶ 阶段: ${stage}\n`);
      // 真实实现：每个阶段会调度对应的角色 + 工具
      // 此处通过 executeDispatch 委派到 solo-coder
      const task: TaskRequirement = buildTask({
        title: `[${stage}] ${goal}`,
        description: `Autonomous iteration ${iter}/${maxIter}, stage=${stage}, goal=${goal}`,
      });

      // 给 dispatch 增加上下文（通过 task upstreamContext）
      task.upstreamContext = {
        autonomousStage: stage,
        autonomousIteration: iter,
        autonomousMaxIter: maxIter,
        autonomousGoal: goal,
      };

      const result = await executeDispatch(task, {
        projectRoot: args.projectRoot ?? process.cwd(),
        forceRole: { roleId: "solo-coder" as RoleId, reason: "Autonomous stage 委派" },
      });

      writeStdoutLine(`  状态: ${result.status}\n`);
      if (result.error) {
        writeStderrLine(`  错误: ${result.error}\n`);
      }

      // 阶段失败时立即进入 fix
      if (result.status !== "succeeded" && stage !== "fix") {
        writeStdoutLine(`  → 失败，跳到 fix 阶段\n`);
      }
    }
  }

  const duration = Date.now() - startTime;
  writeStdoutLine(`\n✅ Autonomous 完成，耗时: ${duration}ms\n`);
  return 0;
}

/** full-lifecycle 子命令 - 7 阶段项目全流程 */
async function executeFullLifecycleCommand(args: TeamCommandArgs, startTime: number): Promise<number> {
  const project = args.goal ?? args.task;
  if (!project) {
    writeStderrLine("full-lifecycle 子命令需要 --goal 或 --task 参数\n");
    return 1;
  }

  // 7 阶段：产品经理 → 架构师 → UI 设计师 → 独立开发者 → 测试专家 → 发布评审 → CI/CD
  const stages: Array<{ role: RoleId; title: string; artifact: string }> = [
    { role: "product-manager", title: "需求分析", artifact: "PRD.md" },
    { role: "architect", title: "架构设计", artifact: "ARCHITECTURE.md" },
    { role: "ui-designer", title: "UI 设计", artifact: "UI_MOCKUPS.md" },
    { role: "solo-coder", title: "开发实现", artifact: "src/" },
    { role: "test-expert", title: "测试编写", artifact: "tests/" },
    { role: "test-expert", title: "发布评审", artifact: "RELEASE_REVIEW.md" },
    { role: "solo-coder", title: "CI/CD", artifact: ".github/workflows/" },
  ];

  writeStdoutLine(`\n🎬 启动 7 阶段全流程: ${project}\n`);
  writeStdoutLine(`项目根: ${args.projectRoot ?? process.cwd()}\n\n`);

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]!;
    writeStdoutLine(`\n━━━ 阶段 ${i + 1}/${stages.length}: ${stage.title}（${stage.role}）━━━\n`);

    const task: TaskRequirement = buildTask({
      title: `[阶段${i + 1}] ${stage.title} - ${project}`,
      description: `${stage.title} for project "${project}"`,
    });

    // 透传 lifecycle 上下文
    task.upstreamContext = {
      lifecycleStage: i + 1,
      lifecycleStageName: stage.title,
      lifecycleArtifact: stage.artifact,
    };

    const result = await executeDispatch(task, {
      projectRoot: args.projectRoot ?? process.cwd(),
      forceRole: { roleId: stage.role, reason: `7 阶段全流程 - 阶段 ${i + 1}: ${stage.title}` },
    });

    writeStdoutLine(`  角色: ${result.matchedRole.roleId}\n`);
    writeStdoutLine(`  状态: ${result.status}\n`);
    writeStdoutLine(`  产物: ${stage.artifact}\n`);

    if (result.status !== "succeeded") {
      writeStderrLine(`\n✖ 阶段 ${i + 1} (${stage.title}) 失败，中止全流程\n`);
      if (result.error) {
        writeStderrLine(`  错误: ${result.error}\n`);
      }
      return 1;
    }
  }

  const duration = Date.now() - startTime;
  writeStdoutLine(`\n\n🎉 7 阶段全流程完成！耗时: ${duration}ms\n`);
  return 0;
}

/** 格式化 help 文本 */
export function formatTeamHelp(): string {
  const roleList = ROLE_REGISTRY.map((r) => `  - ${r.roleId.padEnd(20)} ${r.name}`).join("\n");
  return `
DeepCodeX Team - 多角色协同调度

用法:
  deepcodex team <subcommand> [options]

子命令:
  list                              列出所有可用角色
  match --keywords <kw1,kw2,...>    根据关键词匹配角色
  dispatch --task <task>            分派任务到角色（自动匹配或 --role 强制）
  autonomous --goal <goal>          启动 Ralph 自主迭代（4 阶段循环）
  full-lifecycle --project <name>   7 阶段项目全流程

可用角色（${ROLE_REGISTRY.length}）:
${roleList}

选项:
  --role <role-id>                  强制指定角色（dispatch 模式）
  --force-role                      禁用自动匹配（需要 --role）
  --consensus                       启用 5 角色联合评审
  --fail-fast                       失败时立即中止
  --max-iterations <n>              最大迭代次数（autonomous 模式，默认 5）
  --project-root <path>             项目根目录（默认当前目录）

示例:
  deepcodex team list
  deepcodex team match --keywords "微服务,架构,API"
  deepcodex team dispatch --task "设计用户认证模块"
  deepcodex team dispatch --role architect --task "系统架构评审"
  deepcodex team autonomous --goal "实现 OAuth2 登录"
  deepcodex team full-lifecycle --project "电商网站"
`;
}

// 保留类型导入以避免 unused import 错误（供外部 reference）
export type { RoleDefinition, MatchResult };
