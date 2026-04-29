import React from "react";
import { render } from "ink";
import { App } from "./ui/App";
import { checkForNpmUpdate, promptForPendingUpdate, type PackageInfo } from "./updateCheck";

const args = process.argv.slice(2);
const packageInfo = readPackageInfo();

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(`${packageInfo.version || "unknown"}\n`);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "deepcode - Deep Code CLI",
      "",
      "Usage:",
      "  deepcode               Launch the interactive TUI in the current directory",
      "  deepcode --version     Print the version",
      "  deepcode --help        Show this help",
      "",
      "Configuration:",
      "  ~/.deepcode/settings.json   API key, model, base URL",
      "  ~/.agents/skills/*/SKILL.md  User-level skills",
      "  ./.deepcode/skills/*/SKILL.md Project-level skills",
      "",
      "Inside the TUI:",
      "  Enter            Send the prompt",
      "  Shift+Enter      Insert a newline",
      "  Ctrl+V           Paste an image from the clipboard",
      "  Esc              Interrupt the current model turn",
      "  /                Open the skills/commands menu",
      "  /new             Start a fresh conversation",
      "  /resume          Pick a previous conversation to continue",
      "  /exit            Quit",
      "  Ctrl+D twice     Quit"
    ].join("\n") + "\n"
  );
  process.exit(0);
}

const projectRoot = process.cwd();

if (!process.stdin.isTTY) {
  process.stderr.write(
    "deepcode requires an interactive terminal (TTY). " +
      "Re-run from a real terminal session.\n"
  );
  process.exit(1);
}

void main();

async function main(): Promise<void> {
  const updatePromptResult = await promptForPendingUpdate(packageInfo);

  const inkInstance = render(<App projectRoot={projectRoot} />, {
    exitOnCtrlC: false
  });

  if (!updatePromptResult.installed) {
    void checkForNpmUpdate(packageInfo);
  }

  inkInstance.waitUntilExit().then(() => {
    process.exit(0);
  });
}

function readPackageInfo(): PackageInfo {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../package.json") as { name?: unknown; version?: unknown };
    return {
      name: typeof pkg.name === "string" ? pkg.name : "@vegamo/deepcode-cli",
      version: typeof pkg.version === "string" ? pkg.version : ""
    };
  } catch {
    return { name: "@vegamo/deepcode-cli", version: "" };
  }
}
