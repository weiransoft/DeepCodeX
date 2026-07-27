import React from "react";
import { render } from "ink";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { setShellIfWindows, getProjectCode } from "@vegamo/deepcode-core";
import { checkForNpmUpdate, promptForPendingUpdate } from "./common/update-check";
import { AppContainer } from "./ui";
import { parseArguments } from "./cli-args";
import { writeStderrLine, writeStdoutLine } from "./utils/stdio-helpers";
import { getPackageJson } from "./utils/package";
import { CLI_VERSION } from "./generated/git-commit";

void main();

async function main(): Promise<void> {
  const packageInfo = await getPackageJson();
  const parsed = await parseArguments();

  // --version and --help are handled by yargs internally (prints output as side effect)
  // but with .exitProcess(false) we need to exit manually.
  if (parsed.version || parsed.help) {
    process.exit(0);
  }

  // team 子命令路由：多角色协同 CLI 模式（非 TUI 模式）
  if (parsed.team) {
    // 延迟导入避免启动开销
    const { executeTeamCommand, formatTeamHelp } = await import("./team/team-cmd.js");
    if (parsed.team === "help") {
      process.stdout.write(formatTeamHelp());
      process.exit(0);
    }
    // 构造命令参数
    const subcommand = parsed.team;
    const opts = parsed.teamOptions;
    const goalRaw = (opts["goal"] ?? opts["project"]) as string | undefined;
    const keywordsRaw = opts["keywords"] as string | undefined;
    const keywords = keywordsRaw
      ? keywordsRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined;
    const exitCode = await executeTeamCommand({
      subcommand: subcommand as "list" | "match" | "dispatch" | "autonomous" | "full-lifecycle",
      role: opts["role"] as "architect" | "solo-coder" | "test-expert" | "ui-designer" | "product-manager" | undefined,
      task: opts["task"] as string | undefined,
      // v2.1.1 E2E：透传 --task-file 选项（从文件读取任务描述，避免 shell 转义问题）
      taskFile: opts["task-file"] as string | undefined,
      goal: goalRaw,
      keywords,
      maxIterations: typeof opts["max-iterations"] === "number" ? (opts["max-iterations"] as number) : undefined,
      forceRole: opts["force-role"] === true,
      consensus: opts["consensus"] === true,
      failFast: opts["fail-fast"] === false ? false : true,
      projectRoot: (opts["project-root"] as string | undefined) ?? process.cwd(),
      // v2.1 P5：透传 full-lifecycle 八阶段循环相关参数
      // 这些参数在 team-cmd.ts 的 executeFullLifecycleCommand 中使用
      useLoop: opts["use-loop"] === true,
      prdPath: opts["prd-path"] as string | undefined,
      architecturePath: opts["architecture-path"] as string | undefined,
      testPlanPath: opts["test-plan-path"] as string | undefined,
      testCommand: opts["test-command"] as string | undefined,
      // v2.1.1 E2E：透传 --resume-run 选项（autonomous 模式断点续跑）
      // team-cmd.ts 的 executeAutonomousCommand 会读取此字段查找最近一次可恢复的 run
      resumeRun: opts["resume-run"] === true,
    });
    process.exit(exitCode);
  }

  // rules 子命令路由：RLIS 规则管理 CLI 模式（非 TUI 模式）
  if (parsed.rules) {
    const { executeRulesCommand, formatRulesHelp } = await import("./rules/rules-cmd.js");
    if (parsed.rules === "help") {
      process.stdout.write(formatRulesHelp());
      process.exit(0);
    }
    const opts = parsed.rulesOptions;
    // severity 参数：yargs choices 接受小写形式（blocker/major/warning），
    // 新 RLIS API 要求大写形式（BLOCKER/MAJOR/WARNING），此处做转换
    const severityRaw = opts["severity"] as "blocker" | "major" | "warning" | undefined;
    const severity =
      severityRaw !== undefined ? (severityRaw.toUpperCase() as "BLOCKER" | "MAJOR" | "WARNING") : undefined;
    const exitCode = (
      await executeRulesCommand({
        subcommand: parsed.rules as "list" | "add" | "remove" | "show" | "path",
        content: opts["content"] as string | undefined,
        ruleId: opts["rule-id"] as string | undefined,
        severity,
        layer: opts["layer"] as "user" | "project" | undefined,
        projectRoot: (opts["project-root"] as string | undefined) ?? process.cwd(),
      })
    ).exitCode;
    process.exit(exitCode);
  }

  // quality-check 子命令路由：质量门禁 CLI 模式（非 TUI 模式）
  // 用法：deepcode quality-check <subcommand> [target] [options]
  // 复用 packages/cli/src/quality/quality-cmd.ts 中 executeQualityCommand 函数
  // printToTerminal=true 时直接输出到 stdout/stderr，退出码通过 process.exit 传递
  if (parsed.qualityCheck) {
    const { executeQualityCommand, parseQualityArgs, formatQualityHelp } = await import("./quality/quality-cmd.js");
    if (parsed.qualityCheck === "help") {
      process.stdout.write(formatQualityHelp());
      process.exit(0);
    }
    const opts = parsed.qualityCheckOptions;
    // 构造 tokens 数组，复用 parseQualityArgs 解析逻辑（与 TUI 模式保持一致）
    // tokens 结构：[subcommand, target?, --opt, val, ...]
    const tokens: string[] = [parsed.qualityCheck];
    if (parsed.qualityCheckPositional) {
      tokens.push(parsed.qualityCheckPositional);
    }
    for (const [key, value] of Object.entries(opts)) {
      if (value === undefined || value === null) continue;
      // boolean 选项只 push key（如 --quiet）
      if (typeof value === "boolean") {
        if (value) tokens.push(`--${key}`);
      } else if (Array.isArray(value)) {
        // 数组选项：逗号分隔转字符串（如 --skip-dirs a,b,c）
        tokens.push(`--${key}`, value.join(","));
      } else {
        // string / number 选项：push key + value
        tokens.push(`--${key}`, String(value));
      }
    }
    // parseQualityArgs 接受 tokens 数组与默认 projectRoot
    const args = parseQualityArgs(tokens, (opts["project-root"] as string | undefined) ?? process.cwd());
    // CLI 模式：printToTerminal=true，直接输出到 stdout/stderr
    const result = await executeQualityCommand(args, undefined, true);
    process.exit(result.exitCode);
  }

  // review 子命令路由：代码审查 CLI 模式（非 TUI 模式）
  // 用法：deepcode review <subcommand> [options]
  // 复用 packages/cli/src/review/review-cmd.ts 中 executeReviewCommand 函数
  // printToTerminal=true 时直接输出到 stdout/stderr，退出码通过 process.exit 传递
  if (parsed.review) {
    const { executeReviewCommand, parseReviewArgs, ReviewArgsError, formatReviewHelp } =
      await import("./review/review-cmd.js");
    if (parsed.review === "help") {
      process.stdout.write(formatReviewHelp());
      process.exit(0);
    }
    const opts = parsed.reviewOptions;
    // 构造 tokens 数组，复用 parseReviewArgs 解析逻辑（与 TUI 模式保持一致）
    // tokens 结构：[subcommand, --opt, val, ...]
    const tokens: string[] = [parsed.review];
    for (const [key, value] of Object.entries(opts)) {
      if (value === undefined || value === null) continue;
      // boolean 选项只 push key（如 --quiet）
      if (typeof value === "boolean") {
        if (value) tokens.push(`--${key}`);
      } else {
        // string / number 选项：push key + value
        tokens.push(`--${key}`, String(value));
      }
    }
    // parseReviewArgs 接受 tokens 数组（已去除 "review" 子命令前缀的 yargs positional）
    // 注意：tokens[0] 仍是 review 子命令名（typecheck/lint/format/full），
    //       parseReviewArgs 期望第一个 token 是子命令（或 --option）
    // 修复（2026-07-27）：之前错误使用 tokens.slice(1) 导致子命令被丢弃、永远回退到默认 full
    let args;
    try {
      args = parseReviewArgs(tokens, (opts["project-root"] as string | undefined) ?? process.cwd());
    } catch (error) {
      if (error instanceof ReviewArgsError) {
        process.stderr.write(`✖ 参数错误：${error.message}\n`);
        process.exit(2);
      }
      throw error;
    }
    // CLI 模式：printToTerminal=true，直接输出到 stdout/stderr
    const result = await executeReviewCommand(args, undefined, true);
    process.exit(result.exitCode);
  }

  // Configure Windows shell AFTER --version/--help handling.
  // On Windows without Git Bash, setShellIfWindows() throws and calls process.exit(1).
  // If called before argument parsing, --help and --version would fail on those machines.
  configureWindowsShell();

  let initialPrompt = parsed.prompt;
  let resumeSessionId = parsed.resume;
  const projectRoot = process.cwd();

  if (!process.stdin.isTTY) {
    writeStderrLine("deepcode requires an interactive terminal (TTY). Re-run from a real terminal session.\n");
    process.exit(1);
  }

  // Validate --resume <sessionId> before entering TUI
  if (typeof resumeSessionId === "string") {
    const projectCode = getProjectCode(projectRoot);
    const indexPath = join(homedir(), ".deepcode", "projects", projectCode, "sessions-index.json");
    try {
      const index = JSON.parse(readFileSync(indexPath, "utf-8"));
      const found =
        Array.isArray(index?.entries) && index.entries.some((e: { id: string }) => e.id === resumeSessionId);
      if (!found) {
        writeStderrLine(`No saved session found with ID "${resumeSessionId}".\n`);
        process.exit(1);
      }
    } catch {
      writeStderrLine(`No saved session found with ID "${resumeSessionId}".\n`);
      process.exit(1);
    }
  }

  const updatePromptResult = await promptForPendingUpdate(packageInfo);
  if (updatePromptResult.installed) {
    process.exit(0);
  }

  const restartRef: { current: (() => void) | null } = { current: null };

  function startApp(): void {
    let restarting = false;
    const appInitialPrompt = initialPrompt;
    initialPrompt = undefined;
    const appResumeSessionId = resumeSessionId;
    resumeSessionId = undefined;
    const inkInstance = render(
      <AppContainer
        projectRoot={projectRoot}
        version={packageInfo?.version ?? CLI_VERSION}
        initialPrompt={appInitialPrompt}
        resumeSessionId={appResumeSessionId}
        onRestart={() => restartRef.current?.()}
      />,
      { exitOnCtrlC: false }
    );

    restartRef.current = () => {
      restarting = true;
      writeStdoutLine("\u001B[2J\u001B[3J\u001B[H");
      inkInstance.unmount();
      startApp();
    };

    inkInstance.waitUntilExit().then(() => {
      if (!restarting) {
        restartRef.current = null;
        process.exit(0);
      }
    });
  }

  void checkForNpmUpdate(packageInfo);

  startApp();
}

/**
 * Configure shell environment for Windows.
 * Sets NoDefaultCurrentDirectoryInExePath and resolves Git Bash path.
 * Must be called after --version/--help handling to avoid blocking those
 * commands on Windows machines without Git Bash installed.
 */
function configureWindowsShell(): void {
  process.env.NoDefaultCurrentDirectoryInExePath = "1";
  try {
    setShellIfWindows();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderrLine(`deepcode: ${message}\n`);
    process.exit(1);
  }
}
