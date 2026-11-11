import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vscodeRoot = join(root, "packages", "vscode-ide-companion");

// T-066：与 build-frontend.js / prepare-vscode.js 一致，按当前平台显式解析可执行文件，
// 不再依赖 shell:true 让 shell 隐式解析 vsce，从而消除隐式注入面。
const WINDOWS_CMD_WRAPPERS = new Set(["cmd", "com", "bat"]);

function resolveExecutable(name) {
  const isWin = process.platform === "win32";
  const candidates = isWin ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];
  const dirs = [join(root, "node_modules", ".bin"), ...(process.env.PATH || "").split(delimiter).filter(Boolean)];

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const p = join(dir, candidate);
      if (existsSync(p)) {
        return { cmd: p, useShell: isWin && WINDOWS_CMD_WRAPPERS.has(basename(p).split(".").pop()) };
      }
    }
  }

  process.stderr.write(
    `[package-vscode] WARNING: "${name}" 未在 node_modules/.bin 或 PATH 中找到，将尝试直接执行裸命令名（不启用 shell）。\n`
  );
  return { cmd: name, useShell: false };
}

const vsce = resolveExecutable("vsce");
const result = spawnSync(vsce.cmd, ["package", "--no-dependencies"], {
  cwd: vscodeRoot,
  stdio: "inherit",
  shell: vsce.useShell,
});

if (result.error) {
  process.stderr.write(
    `[package-vscode] vsce 执行失败：${result.error.message}（解析路径: ${vsce.cmd}，工作目录: ${vscodeRoot}）。` +
      "请确认 vsce 已安装（npx --yes @vscode/vsce）。\n"
  );
}

process.exit(result.status ?? 1);
