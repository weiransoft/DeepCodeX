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
}

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
  const rawArgv = argv ?? process.argv.slice(2);
  const helpAsSecondPositional =
    rawArgv.length >= 2 && rawArgv[0] === "team" && rawArgv[1] === "help"
      ? "team"
      : rawArgv.length >= 2 && rawArgv[0] === "rules" && rawArgv[1] === "help"
        ? "rules"
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
  const teamOptions: Record<string, string | boolean | number | string[] | undefined> = {};
  if (teamRaw) {
    const optionKeys = [
      "role",
      "task",
      "goal",
      "project",
      "keywords",
      "max-iterations",
      "force-role",
      "consensus",
      "fail-fast",
      "project-root",
      "resume-run",
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

  return {
    prompt: parsed.prompt as string | undefined,
    resume,
    version: parsed.version === true,
    help: parsed.help === true,
    team: teamRaw,
    teamOptions,
    rules: rulesRaw,
    rulesOptions,
  };
}
