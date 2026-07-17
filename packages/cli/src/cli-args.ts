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
      "Multi-role team dispatch (list / match / dispatch / autonomous / full-lifecycle)",
      (y: Argv) =>
        y
          .positional("subcommand", {
            type: "string",
            choices: ["list", "match", "dispatch", "autonomous", "full-lifecycle"] as const,
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
  const teamRaw = parsed["team"] as string | undefined;
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
    ];
    for (const key of optionKeys) {
      const v = parsed[key];
      if (v !== undefined) {
        teamOptions[key] = v as string | boolean | number | string[];
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
  };
}
