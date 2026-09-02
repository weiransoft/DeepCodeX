import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, label) {
  console.log(`\n[${label}] ${command} ${args.join(" ")}`);
  // 跨平台兼容 + 安全加固：Windows 上 npm 是 .cmd shim，必须 shell:true 才能直接 spawn；
  // 非 Windows 平台保持无 shell 调用（command 与 args 均为内部硬编码值，避免不必要的 shell 注入面）。
  const result = spawnSync(command, args, { stdio: "inherit", cwd: root, shell: process.platform === "win32" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("=========================================");
console.log("  Deep Code — Build VSCode Companion");
console.log("=========================================");

run("npm", ["run", "build", "--workspace=@vegamo/deepcode-core"], "1/4 Build core");
run("node", ["scripts/esbuild-vscode.config.js"], "2/4 Bundle extension");

// Copy templates from core so the extension can read them at runtime via fs
const templatesSrc = join(root, "packages", "core", "templates");
const templatesDest = join(root, "packages", "vscode-ide-companion", "templates");

if (!existsSync(templatesSrc)) {
  console.error(`\n❌  Templates not found at ${templatesSrc}`);
  process.exit(1);
}

rmSync(templatesDest, { recursive: true, force: true });
cpSync(templatesSrc, templatesDest, { recursive: true, dereference: true });
console.log("\n[3/4] Copied templates from core → vscode-ide-companion/templates/");

run("npm", ["run", "package", "--workspace=deepcode-vscode"], "4/4 Package .vsix");

console.log("\n✅  VSCode companion build complete.\n\n");
