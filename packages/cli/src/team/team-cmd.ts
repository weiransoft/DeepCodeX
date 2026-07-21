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

import * as path from "node:path";
import {
  ROLE_REGISTRY,
  matchRoles,
  executeDispatch,
  buildTask,
  listAllRoles,
  formatRoleInfo,
  // v1.6 P0-1.5：autonomous 模块完整导入
  RunState,
  findLatestResumableRun,
  RalphLoopController,
  defaultLoopConfig,
  generateRunId,
  createDefaultStageHandlers,
  GitDriver,
  SleepGuard,
  NotesMemory,
  loadAutonomousConfig,
  // v1.6 P0-2：OpenAIClientHandle（注入 stub client 用于测试）
  createOpenAIClient,
  type OpenAIClientHandle,
  // 类型导入
  type RoleId,
  type RoleDefinition,
  type TaskRequirement,
  type MatchResult,
  type DispatchOptions,
  type DispatchResult,
  type LoopConfig,
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
  // v1.6 P0-1.5：autonomous 子命令断点续跑开关
  /**
   * 断点续跑开关（autonomous 子命令专用）
   * - true：查找最近一次可恢复的 run 并续跑
   * - false / undefined：创建新 run
   */
  resumeRun?: boolean;
  // v1.6 P0-2：测试注入用 OpenAI 客户端句柄
  /**
   * 注入的 OpenAI 客户端句柄（测试专用）
   * - 生产环境：undefined，使用 createOpenAIClient() 创建真实 client
   * - 测试环境：注入 stub client，避免真实 API 调用
   */
  injectedClient?: OpenAIClientHandle;
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

  // v1.6 P0-2 修正（TC-TEAM-02）：输出含英文关键字（matchedRole / roleId / confidence），
  // 便于 e2e 测试脚本通过 grep 匹配
  writeStdoutLine(`\n匹配结果（top ${matches.length}）:\n`);
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const bar = "█".repeat(Math.round(m.confidence * 20));
    // 输出格式：roleId + confidence（英文关键字）+ 中文理由
    writeStdoutLine(
      `  ${i + 1}. roleId: ${m.roleId.padEnd(20)} ${bar} confidence: ${(m.confidence * 100).toFixed(1)}%`
    );
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
  // v1.6 P0-2 修正（TC-TEAM-04/05/06）：输出含英文关键字（DispatchResult / matchedRole / taskId / dispatchId / status），
  // 便于 e2e 测试脚本通过 grep 匹配（e2e 期望 output 含这些关键字）
  writeStdoutLine(`\n━━━ 调度结果（DispatchResult）━━━\n`);
  writeStdoutLine(`status: ${result.status}\n`);
  writeStdoutLine(`taskId: ${result.taskId}\n`);
  writeStdoutLine(`dispatchId: ${result.dispatchId}\n`);
  writeStdoutLine(`matchedRole: ${result.matchedRole.roleId} (${(result.matchedRole.confidence * 100).toFixed(1)}%)\n`);
  if (result.error) {
    writeStderrLine(`错误: ${result.error}\n`);
  }
  if (result.output) {
    writeStdoutLine(`\n📤 输出:\n${result.output}\n`);
  }

  const duration = Date.now() - startTime;
  writeStdoutLine(`\n⏱  耗时: ${duration}ms\n`);

  // v1.6 P0-2 修正（TC-TEAM-04/05/06）：skipped 状态返回 0（不阻塞）
  // 原因：skipped 表示因缺少 API Key 等环境原因跳过 LLM 调用，不是代码错误
  //   - succeeded → 0（成功）
  //   - skipped   → 0（环境跳过，非错误）
  //   - failed    → 1（真实失败）
  if (result.status === "succeeded" || result.status === "skipped") {
    return 0;
  }
  return 1;
}

/**
 * autonomous 子命令 - Ralph 自主迭代模式（4 阶段循环）
 *
 * v1.6 P0-1.5：完整重写，对接 RalphLoopController
 *
 * 8 步流程：
 *   Step 1: 确定 projectRoot
 *   Step 2: 检查 API Key（injectedClient 优先，否则 createOpenAIClient）
 *   Step 3: 处理 --resume-run（查找最近一次可恢复的 run）
 *   Step 4: 加载 autonomous 配置
 *   Step 5: 创建 RunState（新建或从断点恢复）
 *   Step 6: 创建 GitDriver / NotesMemory / SleepGuard / StageHandlers
 *   Step 7: 创建 RalphLoopController + 调用 await run()
 *   Step 8: exitCode 映射输出
 *
 * exitCode 语义（与 RalphLoopController.run() 一致）：
 *   0 = 全部成功
 *   1 = 部分失败
 *   2 = Fatal abort（连续失败超限）
 *   3 = 命中 stop_when 条件
 */
async function executeAutonomousCommand(args: TeamCommandArgs, startTime: number): Promise<number> {
  // ==========================================================================
  // Step 1: 确定 projectRoot
  // ==========================================================================
  const projectRoot = args.projectRoot ?? process.cwd();
  writeStdoutLine(`🚀 启动 Ralph Autonomous Loop\n`);
  writeStdoutLine(`项目根目录: ${projectRoot}\n`);

  // ==========================================================================
  // Step 2: 检查 API Key（injectedClient 优先 → createOpenAIClient 兜底）
  // ==========================================================================
  // injectedClient 优先：测试环境通过 stub client 注入，避免真实 API 调用
  // 生产环境：调用 createOpenAIClient()，若 settings.apiKey 为空则 client===null
  let clientHandle: OpenAIClientHandle;
  if (args.injectedClient) {
    clientHandle = args.injectedClient;
    writeStdoutLine(`使用注入的 OpenAI 客户端（测试模式）\n`);
  } else {
    const created = createOpenAIClient(projectRoot);
    if (created.client === null) {
      // API Key 缺失：输出 3 个关键字便于用户定位问题（对齐 AC-002 测试期望）
      //   - "autonomous 模式需要 API Key"：场景描述
      //   - "DEEPCODE_API_KEY"           ：推荐的环境变量名
      //   - "env.API_KEY"                ：settings.json 中的字段路径
      writeStderrLine(
        `✖ autonomous 模式需要 API Key，无法启动 Ralph Autonomous Loop\n` +
          `  请通过以下任一方式配置：\n` +
          `  1. 设置环境变量 DEEPCODE_API_KEY（或 OPENAI_API_KEY）\n` +
          `  2. 在 ~/.deepcode/settings.json 或 ./.deepcode/settings.json 中配置 env.API_KEY 字段\n` +
          `  3. 使用 --injected-client 参数注入客户端（测试用）\n`
      );
      return 1;
    }
    clientHandle = {
      client: created.client,
      model: created.model,
      baseURL: created.baseURL,
      temperature: created.temperature,
      thinkingEnabled: created.thinkingEnabled,
    };
  }
  writeStdoutLine(`模型: ${clientHandle.model}\n`);
  writeStdoutLine(`API Base: ${clientHandle.baseURL}\n`);

  // ==========================================================================
  // Step 3: 处理 --resume-run（断点续跑）
  // ==========================================================================
  // runs 目录：<projectRoot>/.deepcodex/runs/
  // 注意：findLatestResumableRun 返回 RunState | null（不是 string）
  const runsDir = path.join(projectRoot, ".deepcodex", "runs");
  let runState: RunState;
  let objective: string;

  if (args.resumeRun) {
    writeStdoutLine(`\n🔍 查找可恢复的 run...\n`);
    const resumable = findLatestResumableRun(runsDir);
    if (resumable === null) {
      writeStdoutLine(`未找到可恢复的 run，将创建新 run\n`);
      // 回退到创建新 run 的流程
      objective = args.goal ?? args.task ?? "";
      if (!objective) {
        writeStderrLine("autonomous 子命令需要 --goal 或 --task 参数\n");
        return 1;
      }
      const runId = generateRunId();
      const runDir = path.join(runsDir, runId);
      runState = new RunState(runDir, runId, objective);
    } else {
      // resumable 是已加载的 RunState 实例，直接使用
      runState = resumable;
      objective = runState.state.objective;
      writeStdoutLine(`✅ 已恢复运行: runId=${runState.state.runId}, iterIndex=${runState.state.iterIndex}\n`);
    }
  } else {
    // 新建 run
    objective = args.goal ?? args.task ?? "";
    if (!objective) {
      writeStderrLine("autonomous 子命令需要 --goal 或 --task 参数\n");
      return 1;
    }
    const runId = generateRunId();
    const runDir = path.join(runsDir, runId);
    runState = new RunState(runDir, runId, objective);
    writeStdoutLine(`创建新 run: runId=${runId}\n`);
  }

  // 持久化初始 state（确保 runDir 存在 + state.json 写入）
  runState.persist();

  // ==========================================================================
  // Step 4: 加载 autonomous 配置
  // ==========================================================================
  // 优先级：项目级 .deepcodex/autonomous.yml → 用户级 ~/.deepcodex/autonomous.yml → 默认值
  const autonomousConfig = loadAutonomousConfig(projectRoot);
  // 用 args.maxIterations 覆盖配置中的 maxIterations（CLI 优先）
  const baseLoopConfig = defaultLoopConfig();
  const loopConfig: LoopConfig = {
    ...baseLoopConfig,
    maxIterations: args.maxIterations ?? autonomousConfig.maxIterations ?? baseLoopConfig.maxIterations,
    maxTokens: autonomousConfig.maxTokens ?? baseLoopConfig.maxTokens,
    stopWhen: autonomousConfig.stopWhen ?? baseLoopConfig.stopWhen,
    backoffBaseSec: autonomousConfig.backoffBaseSec ?? baseLoopConfig.backoffBaseSec,
    backoffMaxSec: autonomousConfig.backoffMaxSec ?? baseLoopConfig.backoffMaxSec,
    consecutiveFailureAbort: autonomousConfig.consecutiveFailureAbort ?? baseLoopConfig.consecutiveFailureAbort,
    testCommand: autonomousConfig.testCommand ?? baseLoopConfig.testCommand,
    securityAnalyzer: autonomousConfig.securityAnalyzer ?? baseLoopConfig.securityAnalyzer,
  };

  writeStdoutLine(`\n📋 Autonomous 配置:\n`);
  writeStdoutLine(`  最大迭代: ${loopConfig.maxIterations}\n`);
  writeStdoutLine(`  最大 token: ${loopConfig.maxTokens}\n`);
  writeStdoutLine(`  连续失败上限: ${loopConfig.consecutiveFailureAbort}\n`);
  writeStdoutLine(`  目标: ${objective}\n\n`);

  // ==========================================================================
  // Step 5: RunState 已在 Step 3 创建
  // ==========================================================================
  // （无操作，仅注释占位保持 8 步结构完整）

  // ==========================================================================
  // Step 6: 创建 GitDriver / NotesMemory / SleepGuard / StageHandlers
  // ==========================================================================
  // v1.6 P0-1.5 修正：GitDriver 构造函数期望对象参数 { repoRoot, runId, runDir? }，
  // 而非 string。传入 runState.state.runId 和 runState.runDirPath 确保 git 操作
  // 与 run 目录对齐（uncommitted manifest 等中间产物写入正确的 runDir）
  const gitDriver = new GitDriver({
    repoRoot: projectRoot,
    runId: runState.state.runId,
    runDir: runState.runDirPath,
  });
  // NotesMemory 构造函数接收 notes.md 完整路径（不是 runDir）
  // v1.6 P0-1.5 修正（AC-006）：notes.md 是项目级共享文件，位于 <projectRoot>/.deepcodex/notes.md
  // 而非 run 级别（<projectRoot>/.deepcodex/runs/<runId>/notes.md）
  // 原因：notes.md 作为项目长期记忆，跨多个 run 共享，后续 run 可读取前次 run 的笔记
  const notesPath = path.join(projectRoot, ".deepcodex", "notes.md");
  const notesMemory = new NotesMemory(notesPath);
  // SleepGuard：macOS 用 caffeinate，Linux 用 systemd-inhibit，失败不阻塞
  // SleepGuardMode 只有 "on" | "off" 两种值，默认 "on"
  let sleepGuard: SleepGuard | null = null;
  try {
    sleepGuard = new SleepGuard("on");
  } catch (err) {
    writeStderrLine(`⚠️  SleepGuard 初始化失败（不阻塞）: ${err instanceof Error ? err.message : String(err)}\n`);
    sleepGuard = null;
  }

  // StageHandlers：注入 clientHandle，使每个 stage 能调用 LLM
  // createDefaultStageHandlers 接收 { projectRoot, testCommand?, log?, injectedClient? }
  // injectedClient 类型是 InjectedClientHandle（= OpenAIClientHandle 的别名）
  const stageHandlers = createDefaultStageHandlers({
    projectRoot,
    injectedClient: clientHandle,
    testCommand: loopConfig.testCommand,
  });

  // ==========================================================================
  // Step 7: 创建 RalphLoopController + 调用 await run()
  // ==========================================================================
  const controller = new RalphLoopController({
    config: loopConfig,
    projectRoot,
    gitDriver,
    notesMemory,
    runState,
    stageHandlers,
    objective,
    log: (level, message) => {
      const prefix = level === "error" ? "✖" : level === "warn" ? "⚠️ " : level === "debug" ? "🔍" : "ℹ️";
      writeStdoutLine(`  ${prefix} ${message}\n`);
    },
    sleepGuard,
  });

  const exitCode = await controller.run();

  // 持久化最终 state
  runState.persist();

  // ==========================================================================
  // Step 8: exitCode 映射输出
  // ==========================================================================
  const exitCodeMessages: Record<number, string> = {
    0: "✅ Ralph Autonomous Loop 完成",
    1: "⚠️  Ralph Autonomous Loop 部分失败",
    2: "✖ Fatal abort（连续失败超限）",
    3: "🎯 命中 stop_when 条件",
  };
  const message = exitCodeMessages[exitCode] ?? `未知退出码: ${exitCode}`;
  const duration = Date.now() - startTime;
  writeStdoutLine(`\n${message}\n`);
  writeStdoutLine(`  退出码: ${exitCode}\n`);
  writeStdoutLine(`  总迭代: ${runState.state.iterIndex}\n`);
  writeStdoutLine(`  累计 token: ${runState.state.cumulativeTokens}\n`);
  writeStdoutLine(`  已提交 commit: ${runState.state.commitsMade}\n`);
  writeStdoutLine(`  耗时: ${duration}ms\n`);

  return exitCode;
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
