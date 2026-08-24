import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vscodeRoot = join(root, "packages", "vscode-ide-companion");
const target = getVscodeTarget();
const result = spawnSync("vsce", ["package", "--no-dependencies", "--target", target], {
  cwd: vscodeRoot,
  stdio: "inherit",
  shell: true,
});

process.exit(result.status ?? 1);

function getVscodeTarget() {
  const targets = {
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    "linux-arm64": "linux-arm64",
    "linux-x64": "linux-x64",
    "win32-arm64": "win32-arm64",
    "win32-x64": "win32-x64",
  };
  const key = `${process.platform}-${process.arch}`;
  const target = targets[key];
  if (!target) {
    throw new Error(`Unsupported VSCode packaging target: ${key}`);
  }
  return target;
}
