import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function run(command, args, label) {
  process.stdout.write(`\n[${label}] ${command} ${args.join(" ")}\n`);
  // 跨平台兼容 + 安全加固：Windows 上 npm 是 .cmd shim，必须 shell:true 才能直接 spawn；
  // 非 Windows 平台保持无 shell 调用（command 与 args 均为内部硬编码值，避免不必要的 shell 注入面）。
  const result = spawnSync(command, args, { stdio: "inherit", cwd: root, shell: process.platform === "win32" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("=========================================");
console.log("  Deep Code CLI — Build");
console.log("=========================================");

run("npm", ["run", "build", "--workspace=@vegamo/deepcode-core"], "1/3");
run("node", ["scripts/rewrite-esm-imports.js"], "2/3");
run("npm", ["run", "bundle"], "3/3");

console.log("\n✅  Build complete.\n\n");
