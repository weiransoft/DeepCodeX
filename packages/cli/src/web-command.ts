/**
 * `deepcode web` 子命令（docs/dev/web-ui.md §3.2）。
 *
 * 流程：resolveWebSettings(process.cwd(), process.env) → enabled=false 时
 * stderr 提示如何开启并 exit 1；否则 startWebServer（host/port 可被 CLI flag
 * 覆盖），打印访问地址，SIGINT 优雅关闭（disposeAll + server.close）。
 */

import { validateHost, validatePort, resolveWebSettings } from "@vegamo/deepcode-web/config";
import { startWebServer } from "@vegamo/deepcode-web/server";
import { writeStderrLine, writeStdoutLine } from "./utils/stdio-helpers";

/** runWebCommand 选项（来自 CLI flag，可覆盖 settings 配置） */
export interface WebCommandOptions {
  /** --host 覆盖（监听地址） */
  host?: string;
  /** --port 覆盖（监听端口，字符串形式由 yargs 透传） */
  port?: string;
}

/**
 * 运行 `deepcode web` 子命令：启动 Web 对话界面并阻塞至 SIGINT。
 *
 * @param options CLI flag（host/port 覆盖项，均可选）
 * @returns 退出码（0 正常关闭；该函数在 enabled=false 时直接 process.exit(1)）
 */
export async function runWebCommand(options: WebCommandOptions = {}): Promise<number> {
  // 1. 解析配置（settings.json web 节 + env 覆盖 + 默认值归一 + fail-fast 校验）
  let resolved;
  try {
    resolved = resolveWebSettings(process.cwd(), process.env);
  } catch (error) {
    // 配置非法（如 jwtSecret 缺失、port 非法）：stderr 提示后退出码 1
    const message = error instanceof Error ? error.message : String(error);
    writeStderrLine(`deepcode web：配置校验失败：${message}`);
    process.exit(1);
  }

  // 2. enabled=false 时拒绝启动，并给出开启指引
  if (!resolved.enabled) {
    writeStderrLine("deepcode web：Web 界面未启用（web.enabled 默认为 false）。");
    writeStderrLine("开启方式：在 ~/.deepcode/settings.json 或 <project>/.deepcode/settings.json 中加入：");
    writeStderrLine("  {");
    writeStderrLine('    "web": {');
    writeStderrLine('      "enabled": true,');
    writeStderrLine('      "auth": { "jwtSecret": "<你的随机密钥>" },');
    writeStderrLine('      "allowRoots": ["~/projects"]');
    writeStderrLine("    }");
    writeStderrLine("  }");
    writeStderrLine("密钥也可通过环境变量 DEEPCODE_WEB_JWT_SECRET 注入。详见 docs/dev/web-ui.md §3.3。");
    process.exit(1);
  }

  // 3. CLI flag 覆盖（host/port 优先级最高），覆盖值同样经过合法性校验
  if (options.host !== undefined) {
    resolved.host = validateHost(options.host);
  }
  if (options.port !== undefined) {
    const portNumber = Number(options.port);
    if (Number.isNaN(portNumber)) {
      writeStderrLine(`deepcode web：--port 非法（值：${options.port}）：必须是 1-65535 之间的整数`);
      process.exit(1);
    }
    resolved.port = validatePort(portNumber, "cli --port");
  }

  // 4. 启动服务器并打印访问地址
  const running = await startWebServer(resolved);
  writeStdoutLine(`DeepCodeX Web UI: http://${resolved.host}:${running.port}`);
  writeStdoutLine("按 Ctrl+C 退出。");

  // 5. SIGINT 优雅关闭：释放会话池引擎 + 关闭 HTTP 服务后返回
  return await new Promise<number>((resolve) => {
    let closing = false;
    const shutdown = (): void => {
      if (closing) {
        return;
      }
      closing = true;
      void running.close().then(() => resolve(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
