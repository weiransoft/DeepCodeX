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
