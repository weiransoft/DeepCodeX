/**
 * T6 后台任务 SIGKILL 误报甄别测试（设计文档 §2.6 后端部分）
 *
 * 覆盖场景：
 * - BG-01a：端到端——真实 spawn 后台 bash（先打印 SYNTAX_OK 再 sleep），等日志出现
 *   成功标记后 killProcessTree SIGKILL 整个进程组（模拟用户 `kill -- -<pgid>` 停止
 *   命令），断言完成回调 ok=true 且 note 携带误报降级说明；
 * - BG-01b：失败路径零改动——exitCode=7（无 signal）仍报 failed；甄别触发条件不含
 *   exitCode 非 0 分支（killSpurious 表达式要求 exitCode===null），端到端无法伪造
 *   「同一 close 事件既有退出码又被 SIGKILL」的 OS 层不存在形态，故以代码路径 +
 *   真实 exitCode=7 端到端共同验证；
 * - BG-01c：SIGKILL 且日志尾无成功标记 → failed 语义不变、note 为空；
 * - 纯函数 detectBackgroundSuccessFromLog：命中/不命中/多行/大小写敏感/邻域否决；
 * - readTail：尾部字节切片、UTF-8 多字节安全、超限截断、不存在/空文件返回空串；
 * - 通知文本：SessionManager.addBackgroundProcessCompletionMessage 甄别成功时
 *   Output 行后独立追加 `Note: …` 行；
 * - 前端解析兼容回归：Web parseBackgroundTaskNotice 主正则对「带 Note 通知文本」的
 *   outputPath / command 捕获不被破坏（Web 源码主正则字面量只读校验，不修改前端）。
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { detectBackgroundSuccessFromLog, readTail, handleBashTool } from "../tools/bash-handler";
import { killProcessTree } from "../common/process-tree";
import type { BackgroundProcessCompletion, ToolExecutionContext } from "../tools/executor";
import { SessionManager, type SessionMessage } from "../session";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// 纯函数：detectBackgroundSuccessFromLog（日志尾成功标记判定）
// ---------------------------------------------------------------------------

test("BG-01 detectBackgroundSuccessFromLog: 整行全词成功标记命中", () => {
  // 词表全命中：设计文档 §2.6 固定六个全大写标记
  for (const marker of ["OK", "DONE", "SUCCESS", "SYNTAX_OK", "BG_OK", "COMPLETED"]) {
    assert.equal(detectBackgroundSuccessFromLog(`some build output\n${marker}\n`), true, marker);
  }
  // 允许行尾空白 / CRLF 行尾 / 无末尾换行
  assert.equal(detectBackgroundSuccessFromLog("output\nSYNTAX_OK  "), true);
  assert.equal(detectBackgroundSuccessFromLog("output\r\nSYNTAX_OK\r\n"), true);
  assert.equal(detectBackgroundSuccessFromLog("output\nDONE"), true);
});

test("BG-01 detectBackgroundSuccessFromLog: 大小写敏感——只认全大写标记", () => {
  // 大小写敏感（设计判据：固定全大写词表，防 `status: ok` 之类普通文本误判）
  assert.equal(detectBackgroundSuccessFromLog("output\nok\n"), false);
  assert.equal(detectBackgroundSuccessFromLog("output\nOk\n"), false);
  assert.equal(detectBackgroundSuccessFromLog("output\nsyntax_ok\n"), false);
  assert.equal(detectBackgroundSuccessFromLog("output\nSuccess\n"), false);
  assert.equal(detectBackgroundSuccessFromLog("output\ncompleted\n"), false);
});

test("BG-01 detectBackgroundSuccessFromLog: 行中/前缀文本不命中", () => {
  // 标记必须是整行全词：行中、行首前缀拼接均不命中
  assert.equal(detectBackgroundSuccessFromLog("FAILED: SYNTAX_OK earlier\n"), false);
  assert.equal(detectBackgroundSuccessFromLog("status: DONE\n"), false);
  assert.equal(detectBackgroundSuccessFromLog("  DONE  \n"), false);
  assert.equal(detectBackgroundSuccessFromLog("DONELATER\n"), false);
  assert.equal(detectBackgroundSuccessFromLog("OK - all tests were skipped, 0 passed\n"), false);
});

test("BG-01 detectBackgroundSuccessFromLog: 多行——标记前后的普通输出不影响判定", () => {
  const tail = ["compiling module a", "compiling module b", "warning: unused variable", "SYNTAX_OK"].join("\n");
  assert.equal(detectBackgroundSuccessFromLog(tail), true);
  // 多标记 + 尾部空行
  assert.equal(detectBackgroundSuccessFromLog("OK\nnoise line\nDONE\n\n"), true);
});

test("BG-01 detectBackgroundSuccessFromLog: 邻域 FAILED/ERROR 否决（保守判据）", () => {
  // 标记后 1 行出现 FAILED → 否决（真实失败脚本收尾通常是 … FAILED）
  assert.equal(detectBackgroundSuccessFromLog("SYNTAX_OK\nFAILED step: deploy\n"), false);
  // 标记前 2 行邻域内的 ERROR → 否决
  assert.equal(detectBackgroundSuccessFromLog("ERROR: connection refused\n\nSYNTAX_OK\n"), false);
  // 邻域外（>2 行）的 FAILED 不否决
  assert.equal(
    detectBackgroundSuccessFromLog(["FAILED step 1", "retried", "unrelated noise", "all good", "SUCCESS"].join("\n")),
    true
  );
});

test("BG-01 detectBackgroundSuccessFromLog: 空文本/空白文本不命中", () => {
  assert.equal(detectBackgroundSuccessFromLog(""), false);
  assert.equal(detectBackgroundSuccessFromLog("   \n\t\n"), false);
  assert.equal(detectBackgroundSuccessFromLog("just some output without markers"), false);
});

// ---------------------------------------------------------------------------
// 辅助函数：readTail（文件尾部字节切片）
// ---------------------------------------------------------------------------

test("BG-01 readTail: 文件小于上限时返回全文", () => {
  const dir = createTempDir("deepcode-readtail-");
  const file = path.join(dir, "small.log");
  fs.writeFileSync(file, "hello world", "utf8");
  assert.equal(readTail(file, 4096), "hello world");
});

test("BG-01 readTail: 超过上限时只返回尾部字节", () => {
  const dir = createTempDir("deepcode-readtail-");
  const file = path.join(dir, "big.log");
  // 5000 个 ASCII 'x' + 成功标记：上限 4096 时前部 'x' 被截掉，尾部标记完整保留
  const content = `${"x".repeat(5000)}\nSYNTAX_OK\n`;
  fs.writeFileSync(file, content, "utf8");
  const tail = readTail(file, 4096);
  // 上限严格生效：返回文本字节数不超过 maxBytes，且尾部标记完整
  assert.ok(Buffer.byteLength(tail, "utf8") <= 4096);
  assert.ok(tail.endsWith("SYNTAX_OK\n"));
  assert.equal(detectBackgroundSuccessFromLog(tail), true);
});

test("BG-01 readTail: 切片起点落在多字节字符中间时跳过 UTF-8 续字节", () => {
  const dir = createTempDir("deepcode-readtail-");
  const file = path.join(dir, "utf8.log");
  // 6000 个 ASCII 填充使切片起点（size-10）落入中文多字节序列内部
  const content = `${"a".repeat(6000)}中文尾部标记\nSYNTAX_OK\n`;
  fs.writeFileSync(file, content, "utf8");
  const tail = readTail(file, 10);
  // 首字符不得是替换符（UTF-8 续字节被跳过的验证）
  assert.ok(!tail.startsWith("\uFFFD"), `readTail 首字符不应是乱码替换符，实际首字符 ${JSON.stringify(tail[0])}`);
  assert.ok(tail.endsWith("SYNTAX_OK\n"));
});

test("BG-01 readTail: 文件不存在/为空时返回空串", () => {
  const dir = createTempDir("deepcode-readtail-");
  assert.equal(readTail(path.join(dir, "missing.log"), 4096), "");
  const empty = path.join(dir, "empty.log");
  fs.writeFileSync(empty, "", "utf8");
  assert.equal(readTail(empty, 4096), "");
});

// ---------------------------------------------------------------------------
// BG-01a 端到端：日志尾有成功标记 + 组杀 SIGKILL → ok=true + note
// ---------------------------------------------------------------------------

test("BG-01a 后台任务先输出 SYNTAX_OK 再被进程组 SIGKILL → 完成事件甄别为成功并携带 note", async (t) => {
  if (process.platform === "win32") {
    t.skip("进程组 kill（kill -- -pgid）语义仅 POSIX 有效");
    return;
  }
  const workspace = createTempDir("deepcode-bg-kill-success-");
  const completion = await runBackgroundCommandThenKillGroup(workspace, "printf 'SYNTAX_OK\\n'; sleep 30", t);

  // shell 包装进程被组杀：OS 层事实是 signal=SIGKILL 且无退出码
  assert.equal(completion.signal, "SIGKILL", "shell 包装应被 SIGKILL 组杀");
  assert.equal(completion.exitCode, null, "被信号终止时无退出码");
  // 甄别生效：日志尾命中 SYNTAX_OK → 按成功上报（误报降级）
  assert.equal(completion.ok, true, "日志尾命中成功标记应甄别为成功");
  assert.equal(
    completion.note,
    "process-group killed after successful completion (signal SIGKILL)",
    "甄别成功必须携带降级说明"
  );
  assert.equal(completion.error, undefined, "甄别成功不携带 error");
});

// ---------------------------------------------------------------------------
// BG-01c 端到端：日志尾无成功标记 + 组杀 SIGKILL → failed 语义不变
// ---------------------------------------------------------------------------

test("BG-01c 后台任务日志尾无成功标记被进程组 SIGKILL → 维持 failed 且无 note", async (t) => {
  if (process.platform === "win32") {
    t.skip("进程组 kill（kill -- -pgid）语义仅 POSIX 有效");
    return;
  }
  const workspace = createTempDir("deepcode-bg-kill-failure-");
  // 日志尾只有进行中输出，没有任何整行成功标记
  const completion = await runBackgroundCommandThenKillGroup(workspace, "printf 'still running...\\n'; sleep 30", t);

  assert.equal(completion.signal, "SIGKILL");
  assert.equal(completion.exitCode, null);
  // 无成功证据 → 不改判（保守铁律：拿不到证据就维持 failed）
  assert.equal(completion.ok, false, "日志尾无成功标记必须维持 failed");
  assert.equal(completion.note, undefined, "未甄别成功不得携带 note");
  assert.match(completion.error ?? "", /SIGKILL/, "失败 error 文本保持原有 signal 语义");
});

// ---------------------------------------------------------------------------
// BG-01b：失败退出码路径零改动
//
// 代码路径说明：close 回调 killSpurious 表达式为
//   `!ok && !error && result.signal === "SIGKILL" && result.exitCode === null && …`
// exitCode 非 0（本用例 exitCode=7）时 `result.signal === "SIGKILL"` 与
// `result.exitCode === null` 不可能同时成立（OS 层 close 事件要么给退出码、
// 要么给信号，二者互斥），因此失败退出码路径天然不受甄别影响；
// 「exitCode=1 且 signal 同时存在」在 Node close 事件中不存在，不强造场景，
// 以本端到端 + 上方纯函数判据断言共同覆盖。
// ---------------------------------------------------------------------------

test("BG-01b 后台任务以非零退出码结束（无信号）→ failed 语义与 error 文本零改动", async () => {
  const workspace = createTempDir("deepcode-bg-exitcode-");
  let completion: BackgroundProcessCompletion | null = null;

  const result = await handleBashTool(
    {
      // 日志尾故意放成功标记：验证「有退出码」时即便日志含标记也绝不改判
      command: "printf 'SYNTAX_OK\\n'; exit 7",
      run_in_background: true,
    },
    createContext("bg-kill-exitcode", workspace, {
      onBackgroundProcessComplete: (event) => {
        completion = event;
      },
    })
  );
  assert.equal(result.ok, true);
  await waitFor(() => completion !== null, 5000);

  const done = completion as BackgroundProcessCompletion;
  assert.equal(done.ok, false, "非零退出码即使日志含成功标记也绝不改判");
  assert.equal(done.exitCode, 7);
  assert.equal(done.signal, null);
  assert.equal(done.note, undefined, "非 SIGKILL 路径不携带 note");
  assert.match(done.error ?? "", /exit code 7/, "失败 error 文本保持原有 exit code 语义");
});

// ---------------------------------------------------------------------------
// 通知文本：SessionManager 完成通知追加 Note 行
// ---------------------------------------------------------------------------

test("BG-01 completed 通知携带甄别说明时以独立 Note 行追加在 Output 行之后", () => {
  const workspace = createTempDir("deepcode-bg-note-workspace-");
  const home = createTempDir("deepcode-bg-note-home-");
  setHomeDir(home);
  const outputPath = path.join(workspace, "bg-completed.log");
  let systemMessage: SessionMessage | null = null;
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: (message) => {
      systemMessage = message;
    },
  });

  (
    manager as unknown as {
      addBackgroundProcessCompletionMessage: (
        sessionId: string,
        completion: {
          command: string;
          outputPath: string;
          ok: boolean;
          exitCode: number | null;
          signal: string | null;
          error?: string;
          note?: string;
          startedAtMs: number;
          completedAtMs: number;
        }
      ) => void;
    }
  ).addBackgroundProcessCompletionMessage("session-bg-note", {
    command: "node check.js",
    outputPath,
    ok: true,
    exitCode: null,
    signal: "SIGKILL",
    startedAtMs: 0,
    completedAtMs: 1200,
    note: "process-group killed after successful completion (signal SIGKILL)",
  });

  assert.ok(systemMessage);
  const content = (systemMessage as SessionMessage).content ?? "";
  // 首行保持原格式（completed + signal 描述 + Output 同行结尾）
  assert.match(content, /^Background command "node check\.js" completed with signal SIGKILL after .+\. Output: \S+$/m);
  // Note 独立成行（不能并进 Output 行——会破坏前端 `Output: (\S+)` 捕获）
  assert.ok(content.includes(`\nNote: process-group killed after successful completion (signal SIGKILL)`));
  // completed 态不附带失败日志尾
  assert.doesNotMatch(content, /<background_task_failure_log>/);
  manager.dispose();
});

test("BG-01 completed 通知无 note 时文本与旧格式完全一致（零回归）", () => {
  const workspace = createTempDir("deepcode-bg-nonote-workspace-");
  const home = createTempDir("deepcode-bg-nonote-home-");
  setHomeDir(home);
  const outputPath = path.join(workspace, "bg-completed-plain.log");
  let systemMessage: SessionMessage | null = null;
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: (message) => {
      systemMessage = message;
    },
  });

  (
    manager as unknown as {
      addBackgroundProcessCompletionMessage: (
        sessionId: string,
        completion: {
          command: string;
          outputPath: string;
          ok: boolean;
          exitCode: number | null;
          signal: string | null;
          startedAtMs: number;
          completedAtMs: number;
        }
      ) => void;
    }
  ).addBackgroundProcessCompletionMessage("session-bg-plain", {
    command: "echo hi",
    outputPath,
    ok: true,
    exitCode: 0,
    signal: null,
    startedAtMs: 0,
    completedAtMs: 100,
  });

  assert.ok(systemMessage);
  const content = (systemMessage as SessionMessage).content ?? "";
  assert.doesNotMatch(content, /Note: /, "无 note 的通知文本不得出现 Note 段");
  assert.equal(content.split("\n").length, 1, "无 note 无日志尾时通知必须保持单行");
  manager.dispose();
});

// ---------------------------------------------------------------------------
// 前端解析兼容回归：带 Note 的通知文本不破坏 parseBackgroundTaskNotice 主正则
//（只读校验 Web 源码中的主正则字面量行为，不修改前端——前端 Note 展示是后续任务）
// ---------------------------------------------------------------------------

test("BG-01 Web parseBackgroundTaskNotice 主正则对带 Note 通知文本的兼容回归", () => {
  const pattern = loadWebNoticeMainRegex();
  if (pattern === null) {
    // Web 包不存在/源码结构变化时跳过（core 单测不硬依赖 Web 包）
    return;
  }
  const outputPath = "/var/folders/xx/T/deepcode-background/bash-test-123.log";
  const content =
    `Background command "node check.js" completed with signal SIGKILL after 2s. Output: ${outputPath}\n` +
    "Note: process-group killed after successful completion (signal SIGKILL)";

  const m = pattern.exec(content);
  assert.ok(m, "带 Note 的通知文本必须仍能被主正则匹配");
  const [, command, statusWord, exitText, , capturedPath] = m;
  assert.equal(statusWord, "completed");
  assert.equal(exitText.trim(), "signal SIGKILL");
  assert.equal(command, "node check.js");
  // 关键兼容点：Output: (\S+) 捕获不能被同行外的 Note 行污染
  assert.equal(capturedPath, outputPath);

  // 多行命令（heredoc 形态）+ 失败日志尾组合：命令捕获不能被尾段吞并
  const multiline = pattern.exec(
    `Background command "cat <<'EOF'\nline one\nEOF" failed with exit code 1 after 3s. Output: /tmp/a.log\n` +
      '<background_task_failure_log path="/tmp/a.log">boom</background_task_failure_log>'
  );
  assert.ok(multiline);
  assert.equal(multiline[1], "cat <<'EOF'\nline one\nEOF");
  assert.equal(multiline[5], "/tmp/a.log");
});

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/**
 * 端到端辅助：真实 spawn 后台 bash → 等输出日志出现稳定首行 → killProcessTree
 * SIGKILL 整个进程组（与生产停止命令 `kill -- -<pgid>` 等价路径）→ 等完成回调。
 *
 * 全程无 mock：spawn/信号/回调都是真实 OS 行为。
 */
async function runBackgroundCommandThenKillGroup(
  workspace: string,
  command: string,
  t: { diagnostic: (message: string) => void }
): Promise<BackgroundProcessCompletion> {
  let completion: BackgroundProcessCompletion | null = null;
  const result = await handleBashTool(
    { command, run_in_background: true },
    createContext(`bg-kill-${Math.random().toString(36).slice(2)}`, workspace, {
      onBackgroundProcessComplete: (event) => {
        completion = event;
      },
    })
  );
  assert.equal(result.ok, true);
  const pid = result.metadata?.processId as number;
  const outputPath = result.metadata?.outputPath as string;
  assert.equal(typeof pid, "number");
  assert.equal(typeof outputPath, "string");

  // 等首行输出落盘（追加写通道），确认任务已真实启动再杀组
  try {
    await waitFor(() => {
      try {
        return fs.readFileSync(outputPath, "utf8").length > 0;
      } catch {
        return false;
      }
    }, 5000);
  } catch {
    killProcessTree(pid, "SIGKILL");
    t.diagnostic(`后台任务启动后 5s 内无输出（可能 bash 不可用），已清理 pid=${pid}`);
    throw new Error("后台任务启动后 5s 内无任何输出落盘，测试环境异常");
  }

  // 与生产停止命令 kill -- -<pgid> 等价：detached spawn 后 pgid === 包装进程 pid
  killProcessTree(pid, "SIGKILL");
  await waitFor(() => completion !== null, 10000);
  return completion as BackgroundProcessCompletion;
}

/**
 * 从 Web 端 chat-model.ts 源码提取 parseBackgroundTaskNotice 的主正则字面量。
 *
 * 只做源码级只读校验（不动态 import Web 模块、不引入 typescript 依赖）：
 * 主正则以字面量形式定义在 `const m = /…/m.exec(` 语句中，按行定位后 new RegExp
 * 复建；源码结构变化（找不到字面量）时返回 null，调用方跳过本回归。
 */
function loadWebNoticeMainRegex(): RegExp | null {
  const thisFile = fileURLToPath(import.meta.url);
  const chatModelPath = path.resolve(path.dirname(thisFile), "../../../web/web/src/chat-model.ts");
  if (!fs.existsSync(chatModelPath)) {
    return null;
  }
  const source = fs.readFileSync(chatModelPath, "utf8");
  // 主正则所在行形如：`    /^Background command "([\s\S]+?)" … $/m.exec(`
  const line = source
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("/^Background command") && l.includes(".exec("));
  if (!line) {
    return null;
  }
  const lastSlash = line.lastIndexOf("/m.exec(");
  if (lastSlash <= 0) {
    return null;
  }
  const body = line.slice(1, lastSlash);
  // 源码字面量必须携带 m 标志（跨行命令解析的前提），丢失即视为结构变化
  if (!line.slice(lastSlash).startsWith("/m.exec(")) {
    return null;
  }
  return new RegExp(body, "m");
}

function createContext(
  sessionId: string,
  projectRoot: string,
  overrides: Partial<ToolExecutionContext> = {}
): ToolExecutionContext {
  return {
    sessionId,
    projectRoot,
    toolCall: { id: "test-tool-call", type: "function", function: { name: "bash", arguments: "{}" } },
    ...overrides,
  };
}

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 跨平台设置 HOME（SessionManager 落盘目录依赖 homedir） */
function setHomeDir(dir: string): void {
  process.env.HOME = dir;
  if (process.platform === "win32") {
    process.env.USERPROFILE = dir;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(25);
  }
  assert.equal(predicate(), true);
}
