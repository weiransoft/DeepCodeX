/**
 * CLI argument parsing helpers.
 * Uses yargs for robust argument parsing and validation.
 */

import type { Argv } from "yargs";
import Yargs from "yargs";
import { getCliVersion } from "./utils/version";
import { writeStderrLine } from "./utils/stdio-helpers";
import { hideBin } from "yargs/helpers";
import { ROLE_REGISTRY } from "@vegamo/deepcode-core";

// UUID v4 regex pattern for validation
const SESSION_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates if a string is a valid session ID format.
 */
export function isValidSessionId(value: string): boolean {
  return SESSION_ID_REGEX.test(value);
}

export interface ParsedCliArgs {
  /** Prompt text from -p / --prompt */
  prompt: string | undefined;
  /**
   * Resume session identifier:
   *   - `undefined` — --resume was not used
   *   - `true`       — --resume was used without a session ID (show picker)
   *   - `string`     — --resume <sessionId> was used
   */
  resume: string | true | undefined;
  /** True when --version / -v was passed */
  version: boolean;
  /** True when --help / -h was passed */
  help: boolean;
  /**
   * Team subcommand arguments.
   * - `undefined` — no team subcommand was invoked
   * - `string`    — a team subcommand name (e.g. "list", "match", "dispatch")
   */
  team: string | undefined;
  /** Team subcommand options (key-value pairs) */
  teamOptions: Record<string, string | boolean | number | string[] | undefined>;
  /**
   * Rules subcommand arguments.
   * - `undefined` — no rules subcommand was invoked
   * - `string`    — a rules subcommand name (e.g. "list", "add", "remove", "show", "path")
   */
  rules: string | undefined;
  /** Rules subcommand options (key-value pairs) */
  rulesOptions: Record<string, string | boolean | number | string[] | undefined>;
  /**
   * Quality-check 子命令参数。
   * - `undefined` — 未调用 quality-check 子命令
   * - `string`    — quality-check 子命令名（codemap / uiux / visual / all / help）
   */
  qualityCheck: string | undefined;
  /** Quality-check 子命令选项（key-value 对） */
  qualityCheckOptions: Record<string, string | boolean | number | string[] | undefined>;
  /**
   * Quality-check 子命令的位置参数（如 codemap 的 targetPath）
   * yargs 18 中位置参数会出现在 parsed._ 中，这里单独提取以便清晰传递
   */
  qualityCheckPositional: string | undefined;
}

const QUALITY_CHECK_SUBCOMMANDS = ["codemap", "uiux", "visual", "all", "help"] as const;

const EPILOG = [
  "Configuration:",
  "  ~/.deepcode/settings.json    User-level API key, model, base URL",
  "  ./.deepcode/settings.json    Project-level settings",
  "  ./.deepcode/skills/*/SKILL.md Project-level native skills",
  "  ./.agents/skills/*/SKILL.md   Project-level interoperable skills",
  "  ~/.deepcode/skills/*/SKILL.md User-level native skills",
  "  ~/.agents/skills/*/SKILL.md   User-level interoperable skills",
  "",
  "Inside the TUI:",
  "  enter            Send the prompt",
  "  shift+enter      Insert a newline",
  "  shift+tab        Cycle Plan Mode for the next submitted prompt",
  "  home/end         Move within the current line",
  "  alt+left/right   Move by word",
  "  ctrl+w           Delete the previous word",
  "  ctrl+v           Paste an image from the clipboard",
  "  ctrl+x           Clear pasted images",
  "  esc              Interrupt the current model turn",
  "  /                Open the skills/commands menu",
  "  /skills          List available skills",
  "  /model           Select model, thinking mode and effort control",
  "  /plan            Switch the input to Plan Mode",
  "  /new             Start a fresh conversation",
  "  /init            Initialize an AGENTS.md file with instructions for LLM",
  "  /resume          Pick a previous conversation to continue",
  "  /continue        Continue the active conversation, or resume one if empty",
  "  /undo            Restore code and/or conversation to a previous point",
  "  /mcp             Show MCP server status and available tools",
  "  /raw             Toggle display mode for viewing or collapsing reasoning content",
  "  /rules           RLIS rule management (list/add/remove/show/path)",
  "  /quality-check   Quality gate: code map / UI-UX audit / visual regression",
  "  /exit            Quit",
  "  ctrl+d twice     Quit",
].join("\n");

async function configureYargs(argv?: string[]) {
  const rawArgv = argv ?? hideBin(process.argv);
  const yargsInstance = Yargs(rawArgv)
    .locale("en")
    .scriptName("deepcode")
    .usage(
      "Usage: $0 [options] [command]\n\nDeep Code - Launch an interactive CLI, use -p/--prompt for non-interactive mode"
    )
    .command("$0 [query..]", "Launch Deep Code CLI", (yargsInstance: Argv) =>
      yargsInstance
        .option("prompt", {
          alias: "p",
          type: "string",
          describe: "Submit a prompt on launch",
        })
        .option("resume", {
          alias: "r",
          type: "string",
          describe: "Resume a specific session by its ID. Use without an ID to show session picker.",
        })
        .check((argv: { [x: string]: unknown }) => {
          const query = argv["query"] as string | string[] | undefined;
          const hasPositionalQuery = Array.isArray(query) ? query.length > 0 : !!query;

          if (argv["prompt"] && hasPositionalQuery) {
            return "Cannot use both a positional prompt and the --prompt (-p) flag together";
          }
          // bare --resume conflicts with --prompt
          if (argv["resume"] === "" && argv["prompt"]) {
            return "Cannot use --resume without a session ID together with --prompt.\nUse --resume <sessionId> -p <prompt> to resume a session and send a prompt.";
          }
          // validate --resume <sessionId> format if provided
          if (argv["resume"] && argv["resume"] !== "" && !isValidSessionId(argv["resume"] as string)) {
            return `Invalid session ID: "${argv["resume"]}". Must be a valid UUID (e.g., "123e4567-e89b-12d3-a456-426614174000").`;
          }
          // empty prompt is meaningless
          if (argv["prompt"] === "") {
            return "--prompt / -p requires a non-empty value.";
          }
          return true;
        })
    )
    .command(
      "team <subcommand>",
      "Multi-role team dispatch (list / match / dispatch / autonomous / full-lifecycle / help)",
      (y: Argv) =>
        y
          .positional("subcommand", {
            type: "string",
            // v1.6 P0-2 修正（TC-TEAM-12）：加入 "help" 选项，支持 `team help` 显示帮助
            // cli.tsx 中 parsed.team === "help" 时调用 formatTeamHelp() 并 exit(0)
            choices: ["list", "match", "dispatch", "autonomous", "full-lifecycle", "help"] as const,
            describe: "Team subcommand",
          })
          .option("role", {
            type: "string",
            describe: `Target role id. Available: ${ROLE_REGISTRY.map((r) => r.roleId).join(", ")}`,
          })
          .option("task", { type: "string", describe: "Task description" })
          // v2.1.1 E2E：新增 --task-file 选项，从文件读取任务描述
          // 用途：当 task 描述包含 shell 特殊字符（<, >, ?, |, &, $, `, ", ' 等）或
          //       内容超长（如嵌入完整 PRD/ARCHITECTURE 文档）时，避免命令行参数转义问题
          // 优先级：--task-file 优先于 --task（同时指定时 --task-file 生效）
          .option("task-file", {
            type: "string",
            describe: "Path to a file containing the task description (overrides --task; avoids shell escaping issues)",
          })
          .option("goal", { type: "string", describe: "Goal / project name (autonomous / full-lifecycle)" })
          .option("project", { type: "string", describe: "Project name (full-lifecycle alias)" })
          .option("keywords", { type: "string", describe: "Comma-separated keywords for role matching" })
          .option("max-iterations", { type: "number", describe: "Max iterations (autonomous, default 5)" })
          .option("force-role", { type: "boolean", describe: "Disable auto role matching" })
          .option("consensus", { type: "boolean", describe: "Enable 5-role consensus review" })
          .option("fail-fast", { type: "boolean", describe: "Abort on first failure (default true)" })
          .option("project-root", { type: "string", describe: "Project root directory" })
          // v1.6 P0-1.3：autonomous 子命令断点续跑开关
          // 用法：deepcode team autonomous --resume-run
          // 作用：查找最近一次可恢复的 run 并续跑，而不是创建新 run
          .option("resume-run", {
            type: "boolean",
            describe: "Resume the latest resumable autonomous run (autonomous subcommand only)",
            default: false,
          })
          // v2.1 P5：full-lifecycle 八阶段循环相关选项
          // --use-loop：启用 WorkflowLoopController（审查失败时精准回退到 development/test_verification）
          .option("use-loop", {
            type: "boolean",
            describe: "Enable WorkflowLoopController for 8-stage full-lifecycle (rollback on review failure)",
            default: false,
          })
          // --prd-path：PRD 文档路径（阶段 8 文档对照代码审查输入）
          .option("prd-path", {
            type: "string",
            describe: "PRD document path (stage 8 doc-code review input)",
          })
          // --architecture-path：架构设计文档路径（阶段 8 文档对照代码审查输入）
          .option("architecture-path", {
            type: "string",
            describe: "Architecture document path (stage 8 doc-code review input)",
          })
          // --test-plan-path：测试计划文档路径（阶段 8 文档对照代码审查输入）
          .option("test-plan-path", {
            type: "string",
            describe: "Test plan document path (stage 8 doc-code review input)",
          })
          // --test-command：测试命令（阶段 7 测试验证 + 阶段 8 D3 检查使用，如 "npm test"）
          .option("test-command", {
            type: "string",
            describe: 'Test command for stage 7 verification and stage 8 D3 check (e.g. "npm test")',
          })
          .check((argv: { [x: string]: unknown }) => {
            const role = argv["role"];
            if (typeof role === "string" && role.length > 0) {
              const known = ROLE_REGISTRY.some((r) => r.roleId === role);
              if (!known) {
                return `Unknown role id: "${role}". Available: ${ROLE_REGISTRY.map((r) => r.roleId).join(", ")}`;
              }
            }
            return true;
          })
    )
    .command("rules <subcommand>", "RLIS rule management (list / add / remove / show / path)", (y: Argv) =>
      y
        .positional("subcommand", {
          type: "string",
          choices: ["list", "add", "remove", "show", "path"] as const,
          describe: "Rules subcommand",
        })
        .option("content", {
          type: "string",
          describe: "Rule content (add subcommand)",
        })
        .option("rule-id", {
          type: "string",
          describe: "Rule ID (remove / show subcommand)",
        })
        .option("severity", {
          type: "string",
          choices: ["blocker", "major", "warning"] as const,
          describe: "Rule severity (add subcommand, default major)",
        })
        .option("layer", {
          type: "string",
          choices: ["user", "project"] as const,
          describe: "Storage layer (add subcommand, default user)",
        })
        .option("project-root", {
          type: "string",
          describe: "Project root directory",
        })
        .check((argv: { [x: string]: unknown }) => {
          const sub = argv["subcommand"];
          // add 子命令需要 content
          if (sub === "add") {
            const content = argv["content"];
            if (typeof content !== "string" || content.trim() === "") {
              return "rules add 子命令需要 --content <规则内容> 参数";
            }
          }
          // remove / show 子命令需要 rule-id
          if (sub === "remove" || sub === "show") {
            const ruleId = argv["rule-id"];
            if (typeof ruleId !== "string" || ruleId.trim() === "") {
              return `rules ${sub} 子命令需要 --rule-id <规则ID> 参数`;
            }
          }
          return true;
        })
    )
    // quality-check 子命令：质量门禁 CLI 模式（非 TUI 模式）
    // 用法：deepcode quality-check <subcommand> [targetPath] [options]
    // 子命令：codemap / uiux / visual / all / help
    // 选项与 packages/cli/src/quality/quality-cmd.ts 中 parseQualityArgs 完全对齐
    .command(
      "quality-check <subcommand> [target]",
      "Quality gate: code map / UI-UX audit / visual regression (codemap|uiux|visual|all|help)",
      (y: Argv) =>
        y
          .positional("subcommand", {
            type: "string",
            choices: QUALITY_CHECK_SUBCOMMANDS,
            describe: "Quality-check subcommand",
          })
          .positional("target", {
            type: "string",
            describe: "Target path (codemap subcommand optional positional)",
          })
          // codemap 通用选项
          .option("scope", { type: "string", describe: "Scope directory (codemap)" })
          .option("skip-dirs", {
            type: "string",
            describe: "Comma-separated directories to skip (codemap)",
          })
          .option("max-files", { type: "number", describe: "Max files to scan (codemap)" })
          .option("max-lines", {
            type: "number",
            describe: "Max lines per file (codemap, default 2000)",
          })
          // uiux 子命令选项
          .option("dom-file", { type: "string", describe: "DOM audit JSON file (uiux)" })
          .option("contrast-file", { type: "string", describe: "Contrast samples JSON file (uiux)" })
          // visual 子命令选项
          .option("baseline", { type: "string", describe: "Baseline image dir (visual)" })
          .option("current", { type: "string", describe: "Current screenshot path (visual)" })
          .option("test-id", { type: "string", describe: "Test ID (visual)" })
          .option("step", { type: "string", describe: "Step name (visual)" })
          .option("pixel-threshold", {
            type: "number",
            describe: "Pixel diff threshold (visual, default 0.01)",
          })
          .option("ssim-threshold", {
            type: "number",
            describe: "SSIM threshold (visual, default 0.95)",
          })
          .option("dom-signals-file", {
            type: "string",
            describe: "DOM signals JSON file (visual)",
          })
          // 通用选项
          .option("output", { type: "string", describe: "Output file path" })
          .option("format", {
            type: "string",
            choices: ["text", "json", "markdown"] as const,
            describe: "Output format (codemap default markdown, others default text)",
          })
          .option("threshold", { type: "string", describe: "Pass threshold" })
          .option("project-root", { type: "string", describe: "Project root directory" })
          .option("quiet", {
            type: "boolean",
            describe: "Quiet mode (no stdout)",
            default: false,
          })
    )
    .example("deepcode", "Launch the interactive TUI in the current directory")
    .example("deepcode -p <prompt>", "Launch with a pre-filled prompt")
    .example("deepcode -r, --resume [sessionId]", "Resume a session or show session picker")
    .epilog(EPILOG)
    .strict()
    .demandCommand(0, 0)
    .wrap(Math.min(process.stdout.columns || 80, 120));
  yargsInstance
    .version(await getCliVersion())
    .alias("v", "version")
    .help()
    .alias("h", "help");
  yargsInstance.wrap(yargsInstance.terminalWidth());
  return yargsInstance;
}

/**
 * Parse CLI arguments with validation.
 *
 * On validation failure the `.fail()` handler prints the error, shows help,
 * and calls `process.exit(1)`, so this function always either returns a
 * valid `ParsedCliArgs` or terminates the process.
 */
export async function parseArguments(argv?: string[]): Promise<ParsedCliArgs> {
  const y = (await configureYargs(argv)).exitProcess(false).fail((msg, _err, yargs) => {
    writeStderrLine(msg || _err?.message || "Unknown error");
    yargs.showHelp();
    process.exit(1);
  });

  const parsed = y.parseSync() as Record<string, unknown>;

  // v1.6 P0-2 修正（TC-TEAM-12）：yargs 18 内置 help 机制会拦截 "help" 关键字，
  // 导致 `team help` / `rules help` 时 yargs 自动输出 help 信息并清空 parsed._。
  // 此处从原始 argv 中检测 "help" 作为第二个 positional，手动设置 team/rules = "help"。
  // 原因：yargs 18 的 help 机制把 "help" 当成特殊命令，不传递给 .command() 的 positional
  // quality-check 同样适用此机制，支持 `deepcode quality-check help` 显示帮助
  const rawArgv = argv ?? process.argv.slice(2);
  const helpAsSecondPositional =
    rawArgv.length >= 2 && rawArgv[0] === "team" && rawArgv[1] === "help"
      ? "team"
      : rawArgv.length >= 2 && rawArgv[0] === "rules" && rawArgv[1] === "help"
        ? "rules"
        : rawArgv.length >= 2 && rawArgv[0] === "quality-check" && rawArgv[1] === "help"
          ? "quality-check"
          : undefined;

  const resumeRaw = parsed.resume as string | undefined;
  let resume: ParsedCliArgs["resume"];
  if (resumeRaw === undefined) {
    resume = undefined;
  } else if (resumeRaw === "") {
    resume = true;
  } else {
    resume = resumeRaw;
  }

  // 提取 team 子命令及其选项
  // v1.6 修正（P0-1.3 + yargs 18 bug 修复）：
  // yargs 18 中 `.command("team <subcommand>")` 定义的命令，
  //   - 命令名（"team"）出现在 `parsed._[0]`（positional 列表）
  //   - 子命令名（positional 参数）出现在 `parsed["subcommand"]`
  //   - `parsed["team"]` / `parsed["rules"]` 始终返回 undefined（yargs 17 旧行为已变更）
  // 为了向后兼容旧版 yargs，保留 `parsed["team"]` 作为 fallback。
  const positionalArgs: ReadonlyArray<unknown> = Array.isArray(parsed._) ? parsed._ : [];
  const teamInvoked = positionalArgs[0] === "team" || helpAsSecondPositional === "team";
  const rulesInvoked = positionalArgs[0] === "rules" || helpAsSecondPositional === "rules";
  // quality-check 命令检测：positional[0] === "quality-check" 或通过 help fallback
  const qualityCheckInvoked = positionalArgs[0] === "quality-check" || helpAsSecondPositional === "quality-check";
  // v1.6 P0-2 修正（TC-TEAM-12）：yargs 18 把 "help" 当成内置 help 命令，
  // 导致 `parsed["subcommand"]` 不被设置。此时从 `helpAsSecondPositional` 提取 "help"。
  // 原因：yargs 18 的内置 help 机制会拦截 "help" 关键字，不将其作为 positional 传递
  const teamRaw =
    (teamInvoked ? (parsed["subcommand"] as string | undefined) : undefined) ??
    (helpAsSecondPositional === "team" ? "help" : undefined) ??
    (parsed["team"] as string | undefined);
  const rulesRaw =
    (rulesInvoked ? (parsed["subcommand"] as string | undefined) : undefined) ??
    (helpAsSecondPositional === "rules" ? "help" : undefined) ??
    (parsed["rules"] as string | undefined);
  // quality-check 子命令提取：与 team/rules 同样的三段式 fallback
  const qualityCheckRaw =
    (qualityCheckInvoked ? (parsed["subcommand"] as string | undefined) : undefined) ??
    (helpAsSecondPositional === "quality-check" ? "help" : undefined) ??
    (parsed["quality-check"] as string | undefined);
  // quality-check 的第二个位置参数 target（codemap 子命令可选）
  // yargs 18 中 positional "target" 会出现在 parsed["target"]
  const qualityCheckTarget = qualityCheckInvoked ? (parsed["target"] as string | undefined) : undefined;
  const teamOptions: Record<string, string | boolean | number | string[] | undefined> = {};
  if (teamRaw) {
    // v2.1 P5：新增 use-loop / prd-path / architecture-path / test-plan-path / test-command
    // 这 5 个选项专用于 full-lifecycle 子命令，需在此处提取以传递给 executeTeamCommand
    const optionKeys = [
      "role",
      "task",
      "task-file", // v2.1.1 E2E：从文件读取任务描述
      "goal",
      "project",
      "keywords",
      "max-iterations",
      "force-role",
      "consensus",
      "fail-fast",
      "project-root",
      "resume-run",
      // v2.1 P5：八阶段循环相关选项
      "use-loop",
      "prd-path",
      "architecture-path",
      "test-plan-path",
      "test-command",
    ];
    for (const key of optionKeys) {
      const v = parsed[key];
      if (v !== undefined) {
        teamOptions[key] = v as string | boolean | number | string[];
      }
    }
  }

  // 提取 rules 子命令及其选项
  // v1.6 P0-2 修正（TC-TEAM-12）：rulesRaw 已在上方提取（含 help fallback），此处直接使用
  const rulesOptions: Record<string, string | boolean | number | string[] | undefined> = {};
  if (rulesRaw) {
    const optionKeys = ["content", "rule-id", "severity", "layer", "project-root"];
    for (const key of optionKeys) {
      const v = parsed[key];
      if (v !== undefined) {
        rulesOptions[key] = v as string | boolean | number | string[];
      }
    }
  }

  // 提取 quality-check 子命令的选项
  // 选项清单与 packages/cli/src/quality/quality-cmd.ts 中 parseQualityArgs 完全对齐
  const qualityCheckOptions: Record<string, string | boolean | number | string[] | undefined> = {};
  if (qualityCheckRaw) {
    const optionKeys = [
      "scope",
      "skip-dirs",
      "max-files",
      "max-lines",
      "dom-file",
      "contrast-file",
      "baseline",
      "current",
      "test-id",
      "step",
      "pixel-threshold",
      "ssim-threshold",
      "dom-signals-file",
      "output",
      "format",
      "threshold",
      "project-root",
      "quiet",
    ];
    for (const key of optionKeys) {
      const v = parsed[key];
      if (v !== undefined) {
        qualityCheckOptions[key] = v as string | boolean | number | string[];
      }
    }
  }

  return {
    prompt: parsed.prompt as string | undefined,
    resume,
    version: parsed.version === true,
    help: parsed.help === true,
    team: teamRaw,
    teamOptions,
    rules: rulesRaw,
    rulesOptions,
    qualityCheck: qualityCheckRaw,
    qualityCheckOptions,
    qualityCheckPositional: qualityCheckTarget,
  };
}
