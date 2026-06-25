/**
 * CLI argument parsing helpers.
 * Uses yargs for robust argument parsing and validation.
 */

import Yargs from "yargs";

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
}

export interface CliParseError {
  message: string;
}

/**
 * Parse CLI arguments with validation.
 * Returns parsed args on success, or an error object if the arguments are invalid.
 */
export function parseCliArgs(argv: string[]): ParsedCliArgs | CliParseError {
  let validationError: string | null = null;

  const y = Yargs(argv)
    .locale("en")
    .scriptName("deepcode")
    .version(false)
    .help(false)
    .option("version", {
      alias: "v",
      type: "boolean",
      describe: "Print the version",
    })
    .option("help", {
      alias: "h",
      type: "boolean",
      describe: "Show this help",
    })
    .option("resume", {
      alias: "r",
      type: "string",
      describe: "Resume a specific session by its ID. Use without an ID to show session picker.",
    })
    .option("prompt", {
      alias: "p",
      type: "string",
      describe: "Submit a prompt on launch",
    })
    .strict()
    .exitProcess(false)
    .fail((msg) => {
      validationError = msg;
    })
    .check((parsed) => {
      // bare --resume conflicts with --prompt
      if (parsed.resume === "" && parsed.prompt) {
        throw new Error(
          "Cannot use --resume without a session ID together with --prompt.\n" +
            "Use --resume <sessionId> -p <prompt> to resume a session and send a prompt."
        );
      }
      // empty prompt is meaningless
      if (parsed.prompt === "") {
        throw new Error("--prompt / -p requires a non-empty value.");
      }
      return true;
    });

  const parsed = y.parseSync() as Record<string, unknown>;

  if (validationError) {
    return { message: validationError };
  }

  const resumeRaw = parsed.resume as string | undefined;
  let resume: ParsedCliArgs["resume"];
  if (resumeRaw === undefined) {
    resume = undefined;
  } else if (resumeRaw === "") {
    resume = true;
  } else {
    resume = resumeRaw;
  }

  return {
    prompt: parsed.prompt as string | undefined,
    resume,
    version: parsed.version === true,
    help: parsed.help === true,
  };
}
