import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const cliDist = join(root, "packages", "cli", "dist", "cli.js");

/**
 * Web 界面 JWT 密钥的本地存放位置。
 *
 * 为什么不在 `settings.json` 里放明文密钥：settings 是会被拷来拷去的配置文件，
 * 而密钥一旦写成配置项，就容易被顺手提交（`.deepcode/settings.json` 虽已 ignore，
 * 但复制到别的机器/别的目录时不受保护）。放家目录下 0600 的文件，只有本人可读，
 * 也不随仓库走。
 */
const WEB_SECRET_FILE = join(homedir(), ".deepcode", "web-jwt-secret");

if (!existsSync(cliDist)) {
  console.error(`Error: ${cliDist} not found. Run 'npm run build' first.`);
  process.exit(1);
}

/**
 * 解析 `deepcode web` 的 JWT 密钥。
 *
 * 只对 `web` 子命令注入——TUI / super 等子命令用不到密钥，
 * 没必要让它出现在这些进程的环境变量里。
 *
 * 优先级：进程环境变量 > 家目录密钥文件。两处都没有时返回 undefined，
 * 交给 CLI 自己 fail-fast（提示信息由 `packages/web/src/config.ts` 统一给出，
 * 避免两处文案不一致）。
 *
 * @param {string[]} args CLI 参数
 * @returns {string | undefined} 密钥（缺失时不返回空串）
 */
function resolveWebSecret(args) {
  if (args[0] !== "web") return undefined;
  const fromEnv = process.env.DEEPCODE_WEB_JWT_SECRET;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  if (!existsSync(WEB_SECRET_FILE)) return undefined;
  try {
    const fromFile = readFileSync(WEB_SECRET_FILE, "utf8").trim();
    return fromFile === "" ? undefined : fromFile;
  } catch {
    return undefined;
  }
}

const args = process.argv.slice(2);
const webSecret = resolveWebSecret(args);
if (args[0] === "web" && webSecret === undefined) {
  console.error(
    `提示：未找到 Web JWT 密钥。请设置环境变量 DEEPCODE_WEB_JWT_SECRET，` + `或写入 ${WEB_SECRET_FILE}（chmod 600）。\n`
  );
}

console.log("Starting Deep Code CLI...\n");

const child = spawn("node", [cliDist, ...args], {
  stdio: "inherit",
  cwd: root,
  env: webSecret === undefined ? process.env : { ...process.env, DEEPCODE_WEB_JWT_SECRET: webSecret },
});

child.on("exit", (code) => process.exit(code ?? 1));
