/**
 * 真实应用写入矩阵（P2 准入第 2 项）。
 *
 * verify-real-app 只证明「记事本能写」；本脚本把同一套 Observe→Act→Verify 与
 * **副作用校验**推到不同家族的真实应用上，回答两个具体问题：
 *   1. `expectChange` / 磁盘校验这套判据是不是只对记事本有效？
 *   2. 各家族的 UIA 树到底能不能支撑「指名写入」，还是必须视觉兜底？
 *
 * 用例（每个都用**自建临时文件**，且动作前有硬守卫）：
 *   - notepad  → .txt   （经典 Win32 Edit + ValuePattern）
 *   - winword  → .txt   （Office 文档模型，无 ValuePattern，走键盘通道）
 *   - excel    → .csv   （Office 网格，单元格 ValuePattern / 键盘）
 *   - explorer → 目录内重命名（Shell ListView，SelectionItem + F2）
 *   - msedge   → 本地 HTML 里的 textarea（浏览器外壳，只验证输入通道；不驱动「另存为」模态）
 *
 * 安全约束（硬）：
 *  1. 只打开本脚本在临时目录创建的文件/目录，绝不触碰用户文档；
 *  2. 动作前校验窗口标题含本次随机文件名，且（记事本/文本类）编辑区初始内容等于基线；
 *  3. 任一步不通过即放弃该用例并继续下一个，绝不「猜一个窗口继续打」；
 *  4. 结束关闭窗口、按 PID 兜底 kill、删除临时目录；报告不落盘任何窗口标题。
 *
 * 运行：
 *   DEEPCODE_AGENT_UIA_BRIDGE=1 node scripts/verify-multi-app.mjs [--only notepad-txt,excel-csv] [--keep]
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { createWindowsBackend } from "../src/backends/windows.mjs";
import { DesktopAgent } from "../src/agent.mjs";
import { defaultPolicy } from "../src/modules/policy-guard.mjs";
import { assessTree } from "../src/modules/tree-quality.mjs";
import { pickTarget } from "../src/modules/target-pick.mjs";

const execFileAsync = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_OUT = join(HERE, "..", "reports", "p2-multi-app.json");
/** --out 可把单次运行另存（例如单独复跑某一家应用，作为补充证据） */
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : DEFAULT_OUT;
})();

const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf("--only");
  return i >= 0 && argv[i + 1] ? new Set(argv[i + 1].split(",").map((s) => s.trim())) : null;
})();
const KEEP = argv.includes("--keep");
// 真机验证需要「桌面空闲」：操作者一直在用这台机器时，Windows 不允许后台进程抢焦点。
// --wait-idle 秒数表示最多等这么久，等到能拿到前台再开始跑用例。
const WAIT_IDLE_MS = (() => {
  const i = argv.indexOf("--wait-idle");
  const sec = i >= 0 ? Number(argv[i + 1]) : 0;
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
})();
/**
 * `--debug-shots`：在关键阶段留一张截图（写系统临时目录，不进仓库、不进报告正文）。
 * 排查「界面看起来对、实际没生效」这类问题时，截图是唯一能区分「点错了地方」和
 * 「点对了但保存没落盘」的证据。
 */
const DEBUG_SHOTS = argv.includes("--debug-shots");
const SHOT_DIR = DEBUG_SHOTS ? mkdtempSync(join(tmpdir(), "dcx-shots-")) : null;
/** 尝试序号：重试会覆盖同名截图，导致「第 1 次为什么失败」的证据被第 2 次冲掉 */
let ATTEMPT_SEQ = 0;

const OFFICE = "C:\\Program Files\\Microsoft Office\\root\\Office16";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Number(Number(n).toFixed(2));

const flatten = (nodes, out = []) => {
  for (const n of nodes ?? []) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
};

const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const MARK = `DCX-${STAMP}`;

/**
 * 用例定义。
 * `prepare(dir)` 造文件并返回启动参数；`verify` 决定成功证据从哪里来：
 *   disk   —— 读盘（唯一无可争辩的证据）
 *   rename —— 文件系统里出现新名字
 *   uia    —— 只能看界面文本（浏览器外壳：不做「另存为」模态驱动）
 */
function buildCases() {
  const cases = [];
  const mk = (dir, name, content) => {
    const p = join(dir, name);
    writeFileSync(p, content, "utf8");
    return p;
  };

  cases.push({
    id: "notepad-txt",
    family: "classic-win32",
    label: "记事本 / 纯文本",
    exe: "notepad.exe",
    appHint: "notepad",
    prepare: (dir) => {
      const name = `dcx-np-${STAMP}.txt`;
      const baseline = `DCX-BASE-NP-${STAMP}\n`;
      const file = mk(dir, name, baseline);
      return { args: [file], needle: name, file, baseline, marker: `DCX-TYPED-NP-${STAMP}` };
    },
    save: "^s",
    verify: "disk",
    // 编辑面就绪判据：窗口出现 ≠ 能输入（见 runCase 里的 ready 等待）
    readyRoles: ["Edit"],
    // ValuePattern 的 SetValue 是整体替换：基线会被写入内容覆盖，这是预期
    overwriteBaseline: true,
  });

  cases.push({
    id: "word-txt",
    family: "office-word",
    label: "Word / 纯文本",
    exe: join(OFFICE, "WINWORD.EXE"),
    appHint: "winword",
    prepare: (dir) => {
      const name = `dcx-word-${STAMP}.txt`;
      const baseline = `DCX-BASE-WORD-${STAMP}\r\n`;
      const file = mk(dir, name, baseline);
      return { args: [file], needle: name, file, baseline, marker: `DCX-TYPED-WORD-${STAMP}` };
    },
    save: "^s",
    verify: "disk",
    /**
     * Word 正文是自绘文档模型：点进去后光标位置与自动更正弹窗都会吃掉输入。
     * 先用 Ctrl+End 把插入点顶到文末、再 ESC 关掉自动更正提示，键盘输入才稳定。
     */
    preType: ["^{END}", "{ESC}"],
    docText: true,
    readyRoles: ["Document"],
    // 自绘文档模型：SendKeys 会漏字符，走剪贴板粘贴通道
    paste: true,
    /** Word 首次启动可能有引导页/登录提示：允许更久，并记录可见窗口以便定位 */
    waitMs: 40_000,
  });

  cases.push({
    id: "excel-csv",
    family: "office-excel",
    label: "Excel / CSV",
    exe: join(OFFICE, "EXCEL.EXE"),
    appHint: "excel",
    prepare: (dir) => {
      const name = `dcx-xl-${STAMP}.csv`;
      const baseline = `DCX_BASE_XL_${STAMP}\n`;
      const file = mk(dir, name, baseline);
      // Excel 里最稳的落点：A1 单元格。写入内容就是 CSV 第一行。
      return { args: [file], needle: name, file, baseline, marker: `DCX_TYPED_XL_${STAMP}` };
    },
    save: "^s",
    verify: "disk",
    // Excel 单元格没有 ValuePattern，正文同样只能走 TextPattern
    docText: true,
    // 网格（DataGrid）在 = 工作表渲染完成；公式栏的 Edit 出现得更早，不能当就绪信号
    readyRoles: ["DataGrid"],
    readyTimeoutMs: 25_000,
    paste: true,
    /**
     * 点击落点（网格中心）会把选区移到中间某行；Ctrl+Home 把选区拉回 A1，
     * 这样写入的一定是 CSV 第一行，读盘断言才有意义。
     */
    preType: ["^{HOME}"],
    // A1 就是写入目标，粘贴覆盖基线是预期行为
    overwriteBaseline: true,
    waitMs: 45_000,
  });

  cases.push({
    id: "explorer-rename",
    family: "shell",
    label: "资源管理器 / 重命名",
    exe: "explorer.exe",
    appHint: "explorer",
    prepare: (dir) => {
      const name = `dcx-ren-${STAMP}.txt`;
      // F2 重命名只选中主名、保留扩展名：这里只给主名，避免出现 ".txt.txt"
      const renamed = `dcx-ren-${STAMP}-renamed`;
      const file = mk(dir, name, `DCX-BASE-REN-${STAMP}\n`);
      return {
        args: [dir],
        // 资源管理器窗口标题是目录名（临时目录本身就是随机名）
        needle: basename(dir),
        file,
        baseName: name,
        renamed,
        renamedPath: join(dir, `${renamed}.txt`),
        marker: renamed,
        baseline: null,
      };
    },
    rename: true,
    verify: "rename",
    // 列表是异步填充的：List/ListItem 到位才算能选中
    readyRoles: ["List", "ListItem"],
    // 资源管理器列表项要下潜到第 6 层才出现（4 层只到 List 容器）
    maxDepth: 6,
  });

  cases.push({
    id: "edge-html",
    family: "browser-shell",
    label: "Edge / 网页文本框",
    exe: EDGE,
    appHint: "msedge",
    prepare: (dir) => {
      const name = `dcx-edge-${STAMP}.html`;
      const html = `<!doctype html><meta charset="utf-8"><title>DCX-EDGE-${STAMP}</title>
<body style="margin:0;font:16px sans-serif">
<h3>dcx e2e</h3>
<textarea id="t" style="width:640px;height:220px">DCX-BASE-EDGE-${STAMP}</textarea>
</body>`;
      const file = mk(dir, name, html);
      return {
        args: [`--new-window`, `file:///${file.replace(/\\/g, "/")}`],
        needle: `DCX-EDGE-${STAMP}`,
        file,
        baseline: `DCX-BASE-EDGE-${STAMP}`,
        marker: `DCX-TYPED-EDGE-${STAMP}`,
      };
    },
    // 浏览器里不驱动「另存为」模态：成功证据只能来自 UIA 文本
    verify: "uia",
    waitMs: 30_000,
  });

  return cases;
}

async function pidAlive(pid) {
  if (!pid) return false;
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/fo", "csv", "/nh"], {
      encoding: "buffer",
      windowsHide: true,
    });
    const text = new TextDecoder("gbk").decode(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    return text.includes(String(pid));
  } catch {
    return false;
  }
}

/**
 * 不是「文档窗口」的窗口：它们标题里也可能带着我们的文件名（例如
 * 「文件转换 - dcx-wp-xxx.txt」），宽松匹配时会命中，但里面没有任何可编辑面，
 * 拿它当目标只会把动作打空。
 */
const NOT_A_DOC_WINDOW =
  /文件转换|转换文件|安全模式|上次启动失败|无法打开|受保护的视图|File Conversion|Safe Mode|Protected View/i;

async function waitForWindow(backend, spec, appHint, timeoutMs = 20_000, { strict = false } = {}) {
  const t0 = Date.now();
  // 标题不是可靠的身份：Word 会把 "xxx.txt" 显示成 "xxx - Word(产品激活失败)"，
  // Excel 追加 " - Excel"，浏览器加 " - Microsoft Edge"。所以：
  //   1) 先用进程名锁定家族（避免命中别的应用里同名标题）；
  //   2) 再用「含扩展名」或「去扩展名的随机名」匹配 —— 随机名本身足够唯一。
  const noExt = spec.needle.replace(/\.[a-z0-9]{1,5}$/i, "");
  let lastApps = [];
  for (;;) {
    const apps = await backend.listApps();
    lastApps = apps;
    const family = appHint ? apps.filter((a) => a.appId === appHint) : apps;
    // 没有 hwnd 说明这一轮是 tasklist 回落（UIA 枚举空），无法精确定位窗口——
    // 继续等 UIA 枚举恢复，而不是拿着 pid 去猜窗口。
    const ok = (a) => {
      if (appHint && !a.hwnd) return false;
      if (strict && NOT_A_DOC_WINDOW.test(String(a.title ?? ""))) return false;
      return true;
    };
    const full = family.find((a) => String(a.title ?? "").includes(spec.needle) && ok(a));
    if (full) return { app: full, matchedBy: "title-full", elapsedMs: Date.now() - t0, totalWindows: apps.length, enumSource: full.enumSource };
    const noext = family.find((a) => String(a.title ?? "").includes(noExt) && ok(a));
    if (noext) return { app: noext, matchedBy: "title-without-extension", elapsedMs: Date.now() - t0, totalWindows: apps.length, enumSource: noext.enumSource };
    /**
     * 宽松阶段最后的手段：**启动模态的标题里没有文件名**。
     * 「Word 上次启动失败」这种框标题就叫 "Microsoft Word"，靠文件名永远匹配不到，
     * 而它又挡在文件加载前面。所以给一段宽限期后接受「这个应用的任意带 hwnd 的窗口」，
     * 交给 settleDialogs 答掉；真正的文档窗口由随后的 strict 阶段确认。
     */
    if (!strict && Date.now() - t0 > (spec.looseGraceMs ?? 6_000)) {
      const any = family.find((a) => a.hwnd && !NOT_A_DOC_WINDOW.test(String(a.title ?? "")));
      if (any) return { app: any, matchedBy: "app-family-fallback", elapsedMs: Date.now() - t0, totalWindows: apps.length, enumSource: any.enumSource };
    }
    if (Date.now() - t0 > timeoutMs) {
      const err = new Error(`等待窗口超时（${timeoutMs} ms，needle=${spec.needle.length} 字符${strict ? "，strict" : ""}）`);
      err.code = "WINDOW_TIMEOUT";
      // 只记录「哪些应用有可见窗口」与标题长度，不落盘标题内容
      err.visible = apps.map((a) => ({ appId: a.appId, pid: a.pid, titleLength: String(a.title ?? "").length }));
      throw err;
    }
    await sleep(300);
  }
}

/**
 * 模态/引导处理（真机上最容易被忽略的失败源）。
 *
 * 两个真实遇到的坑：
 *  1. **首启引导**：Word 第一次打开时窗口标题已经是文档名，但前面叠着「Microsoft 尊重
 *     你的隐私」；键盘输入全被它吃掉、Ctrl+S 什么也不发生——**界面看起来对了，实际没在
 *     编辑**。这种「静默空转」比直接报错危险得多。
 *  2. **应用内模态**：Word 存 .txt 会弹「是否将文档保存为这种格式?」是(Y)/否(N)。它不在
 *     顶层窗口枚举里（Word 自己画的），只看 `listApps` 会当成「保存成功」，然后读盘才发现
 *     内容没变。
 *
 * 两条都在 UIA 树里有痕：模态是根节点下**另一个 Window**，答案节点带名字（是(Y)/否(N)）。
 * 所以这里按结构判定、按名字点击，只允许点「是/确定/保存/继续/接受/下一步」这类非破坏性
 * 按钮，绝不点「否/取消/不保存/删除/购买」。
 */
/**
 * 名字匹配。
 *
 * 踩过的坑：早期写成 `/^(是|确定|保存|…)\b/i`。JS 的 `\b` 只认 [A-Za-z0-9_]，
 * 而中文字符本身不算 word 字符——于是 `是` 后面紧跟 `(` 时**根本没有词边界**，
 * `^是\b` 对 "是(Y)"、"确定"、"下一步"、"关闭" 全部返回 false，只有 OK/Yes 能过。
 * 结果是兜底逻辑跑了几十轮、一个中文按钮都没点过，报告里只看得到
 * 「Ctrl+S 返回 ok、磁盘没变」这种最难查的静默失败。
 * 改用「后面不能紧跟 ASCII 字母数字」的负向断言，CJK 与 ASCII 都对。
 */
const ANSWER_OK =
  /^(是|是\(Y\)|是（Y）|确定|保存|继续|允许|重试|下一步|接受|同意|完成|关闭|OK|Yes|Save|Continue|Allow|Retry|Next|Accept|Agree|Done)(?![A-Za-z0-9])/i;
/**
 * 「另存为」必须挡掉：Excel 打开 CSV 时顶部常驻一条「可能的数据丢失…」提示条，
 * 上面就有「另存为...」。点它会弹文件对话框，把流程带进「往哪里存」的深坑。
 */
const ANSWER_DANGER =
  /^(否|否\(N\)|否（N）|取消|不保存|另存为|删除|放弃|购买|订阅|No|Cancel|Don'?t save|Save as|Delete|Discard|Buy|Subscribe)/i;
/**
 * 这些老式 Office 对话框的按钮**不是 Button**：实测「Word 上次启动失败/文件转换/
 * 是否保存为纯文本格式」三处按钮的 ControlType 都是 **Pane**（名字是「是(Y)」）。
 * 早期只认 role === "Button"，结果兜底逻辑在真机上从未生效过——保存确认框就那么挂在
 * 屏幕上，而报告里只看到「Ctrl+S 返回 ok、磁盘没变」。
 */
const ANSWERABLE_ROLES = new Set(["Button", "Pane", "Custom", "Text", "Hyperlink", "ListItem"]);

async function settleDialogs(backend, target, maxRounds = 3, { verbose = false } = {}) {
  const handled = [];
  for (let round = 0; round < maxRounds; round += 1) {
    // 快照失败绝不能静默：模态把父窗口置为 disabled 时，对父窗口的 UIA 调用有可能抛，
    // 一吞就等于「兜底逻辑从未运行过」，正是 Word 保存卡死那两个版本的真相。
    let snapshot = null;
    try {
      snapshot = await backend.snapshot({ ...target, maxDepth: 4 });
    } catch (e) {
      if (verbose) console.log(`  [settle] snapshot 失败：${e?.code ?? "ERROR"} ${String(e?.message ?? e).slice(0, 80)}`);
      return { handled, modalPresent: false, error: e?.code ?? "ERROR" };
    }
    const nodes = flatten(snapshot.tree);
    const nameOf = (n) => String(n.name ?? "").trim();
    const area = (n) => (n.rect?.width ?? 0) * (n.rect?.height ?? 0);
    const modal = nodes.find((n) => n.role === "Window" && (n.depth ?? 0) > 0);
    // 「根节点本身就是对话框」：Word/Excel 的模态有时直接顶替主窗口成为我们匹配到的
    // 那个 hwnd（标题就叫 "Microsoft Word"）。判据：节点很少 + 存在 是/确定 这类答案节点。
    const rootIsDialog =
      !modal && nodes.length <= 16 && nodes.some((n) => (n.depth ?? 0) >= 1 && ANSWER_OK.test(nameOf(n)));
    const scoped = modal || rootIsDialog;
    const candidates = nodes.filter((n) => {
      const name = nameOf(n);
      if (!name || ANSWER_DANGER.test(name)) return false;
      if (!ANSWER_OK.test(name)) return false;
      if (!ANSWERABLE_ROLES.has(n.role)) return false;
      // 老式 #32770 对话框的子元素在 UIA 里常常没有有效 BoundingRectangle（0×0），
      // 所以「有面积」只能在**普通窗口**里当硬条件；对话框作用域内交给桥自己选
      // InvokePattern 还是坐标点击。
      if (!scoped && ((n.rect?.width ?? 0) < 6 || (n.rect?.height ?? 0) < 6)) return false;
      // 有模态时只认模态里的答案节点，避免点到主界面同名的「保存」
      if (modal) return (n.depth ?? 0) >= (modal.depth ?? 0);
      // 根即对话框时，答案节点必然是它的直接子节点
      if (rootIsDialog) return (n.depth ?? 0) >= 1;
      // 没有模态：只接受真正的按钮（首启引导的「下一步」）
      return n.role === "Button";
    });
    // 先要有面积的（真按钮），同类里挑面积最小的（按钮本体而不是整块面板）
    candidates.sort((a, b) => {
      const wa = area(a) > 0 ? 1 : 0;
      const wb = area(b) > 0 ? 1 : 0;
      if (wa !== wb) return wb - wa;
      return area(a) - area(b);
    });
    const pick = candidates[0];
    if (!pick) {
      if (verbose) {
        const named = nodes.filter((n) => String(n.name ?? "").trim()).length;
        console.log(
          `  [settle] 无候选：nodes=${nodes.length} 有名字=${named} 模态=${Boolean(modal || rootIsDialog)}`,
        );
      }
      return { handled, modalPresent: Boolean(modal || rootIsDialog) };
    }
    const res = await backend.invokeRef({ snapshotId: snapshot.snapshotId, ref: pick.ref, action: "invoke" });
    const ok = res?.ok === true;
    handled.push({
      kind: modal ? "in-window-modal" : rootIsDialog ? "dialog-root" : "onboarding-button",
      role: pick.role,
      nameLength: String(pick.name ?? "").length,
      via: res?.via ?? null,
      ok,
    });
    if (!ok) {
      // 坐标/InvokePattern 点不动时退回键盘默认键：模态的默认按钮就是「是/确定」
      await backend.sendKey({ ...target, combo: "{ENTER}" }).catch(() => {});
    }
    if (verbose) console.log(`  [settle] 已答 ${pick.role}:${String(pick.name).slice(0, 6)} ok=${ok} via=${res?.via ?? "-"}`);
    await sleep(900);
  }
  return { handled, modalPresent: true };
}

/** 读文档正文（TextPattern）：Office 类应用的「内容真值」，也用于动作前的身份守卫 */
async function readDocText(backend, target) {
  const r = await backend.readText({ ...target, maxLength: 4000 }).catch(() => null);
  return { ok: r?.ok === true, text: String(r?.text ?? ""), via: r?.via ?? null, length: String(r?.text ?? "").length };
}

/**
 * 回答「同 pid 的独立顶层对话框」：先 snapshot 那个窗口，确认里面真有 是/确定 这类按钮
 * 才点，避免对着输入法候选窗乱按回车。
 */
async function answerExternalDialogs(backend, pid, mainHwnd, { verbose = DEBUG_SHOTS, tag = "" } = {}) {
  const apps = await backend.listApps();
  const answered = [];
  const same = apps.filter((x) => x.pid === pid);
  if (verbose && same.length > 1) {
    console.log(`  [dlg${tag}] pid=${pid} 顶层窗口 ${same.length} 个（主体 hwnd=${mainHwnd}）`);
  }
  for (const a of same.filter((x) => x.hwnd !== mainHwnd)) {
    const snap = await backend.snapshot({ appId: a.appId, pid: a.pid, hwnd: a.hwnd, maxDepth: 3 }).catch(() => null);
    if (verbose) {
      console.log(
        `  [dlg${tag}] hwnd=${a.hwnd} appId=${a.appId} titleLen=${String(a.title ?? "").length} ` +
          `snap=${snap ? `${flatten(snap.tree).length} nodes` : "FAILED"}`,
      );
      if (snap) {
        const shown = flatten(snap.tree)
          .filter((n) => String(n.name ?? "").trim())
          .slice(0, 10)
          .map((n) => `${n.role}:${String(n.name).slice(0, 8)}${(n.rect?.width ?? 0) > 0 ? "" : "(0w)"}`);
        console.log(`  [dlg${tag}]   名字样本 ${shown.join(" | ")}`);
      }
    }
    if (!snap) continue;
    const nodes = flatten(snap.tree);
    const btn = nodes.find((n) => {
      const name = String(n.name ?? "").trim();
      return name && ANSWER_OK.test(name) && !ANSWER_DANGER.test(name) && (n.rect?.width ?? 0) > 0;
    });
    if (!btn) continue;
    const res = await backend.invokeRef({ snapshotId: snap.snapshotId, ref: btn.ref, action: "invoke" }).catch(() => null);
    answered.push({ hwnd: a.hwnd, role: btn.role, nameLength: String(btn.name ?? "").length, ok: res?.ok === true, via: res?.via ?? null });
    await sleep(400);
  }
  return answered;
}

/**
 * 「关闭并保存」兜底：Ctrl+S 在某些 Office 会话里会被吃掉（模态/输入法/禁用状态），
 * 但 Alt+F4 触发的「是否保存更改?」是应用自己的必经路径，回答「是」后一定会落盘。
 */
async function saveByClosing(backend, target, file, marker, timeoutMs = 12_000) {
  const answered = [];
  await withForegroundRetry(() => backend.sendKey({ ...target, combo: "%{F4}" })).catch(() => null);
  const t0 = Date.now();
  let onDisk = "";
  while (Date.now() - t0 < timeoutMs) {
    onDisk = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (onDisk.includes(marker)) break;
    const inside = await settleDialogs(backend, target, 1).catch(() => null);
    if (inside?.handled?.length) answered.push(...inside.handled);
    const outside = await answerExternalDialogs(backend, target.pid, target.hwnd, { tag: "-close" });
    if (outside.length) answered.push(...outside);
    await sleep(400);
  }
  onDisk = existsSync(file) ? readFileSync(file, "utf8") : onDisk;
  return { onDisk, answered, waitedMs: Date.now() - t0 };
}

/** 轮询磁盘直到出现标记；每轮顺便把冒出来的模态答掉（保存确认会把写入卡住） */
async function waitForDisk(backend, file, marker, { target, timeoutMs = 15_000, resend = null } = {}) {
  const t0 = Date.now();
  let onDisk = "";
  const answered = [];
  let lastResend = Date.now();
  let resends = 0;
  let rounds = 0;
  while (Date.now() - t0 < timeoutMs) {
    onDisk = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (onDisk.includes(marker)) break;
    rounds += 1;
    // 快捷键偶发被弹窗/输入法吃掉：3.5s 没落盘就重发一次（最多 2 次），
    // 否则只能看着「保存返回 ok、磁盘没变」干等到超时。
    if (resend && resends < 2 && Date.now() - lastResend > 3_500) {
      lastResend = Date.now();
      resends += 1;
      await resend();
    }
    if (target?.pid) {
      const inside = await settleDialogs(backend, target, 1, { verbose: DEBUG_SHOTS && rounds <= 2 }).catch(() => null);
      if (inside?.handled?.length) answered.push(...inside.handled);
      // 诊断只在头两轮打开：每 500ms 打一遍会把输出淹掉
      const outside = await answerExternalDialogs(backend, target.pid, target.hwnd, {
        verbose: DEBUG_SHOTS && rounds <= 2,
        tag: `-r${rounds}`,
      });
      if (outside.length) answered.push(...outside);
    }
    await sleep(500);
  }
  return { onDisk, waitedMs: Date.now() - t0, answered, resends, rounds };
}

/**
 * 前台激活可能被 Windows 拒绝：用户在别的窗口上操作时，系统不允许后台进程抢焦点
 * （这是**保护用户**的正确行为，不是缺陷）。所以对 ACTION_DENIED 做少量重试，
 * 仍失败就如实记录，绝不「换个窗口继续打」。
 */
async function withForegroundRetry(fn, attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    const res = await fn();
    if (res?.ok !== false) return res;
    last = res;
    if (res?.code !== "ACTION_DENIED") return res;
    await sleep(700);
  }
  return last;
}

async function runCase(kase, backend) {
  const t0 = performance.now();
  const dir = mkdtempSync(join(tmpdir(), `dcx-m-${kase.id.slice(0, 6)}-`));
  const row = {
    id: kase.id,
    family: kase.family,
    label: kase.label,
    verdict: "not-run",
    dir: null,
    steps: [],
    guards: {},
    channels: [],
  };
  let spec = null;
  let proc = null;
  let pid = null;
  const seq = (ATTEMPT_SEQ += 1);

  /** 阶段截图（仅 --debug-shots）：返回 {path,width,height,bytes} 便于人眼复核 */
  const shoot = async (label, target) => {
    if (!DEBUG_SHOTS || !target?.hwnd) return null;
    const r = await backend.screenshot({ ...target, reason: label }).catch(() => null);
    if (!r?.base64) return null;
    const p = join(SHOT_DIR, `${kase.id}-a${seq}-${label}.png`);
    writeFileSync(p, Buffer.from(r.base64, "base64"));
    console.log(`  [shot] ${p}  ${r.width}x${r.height} ${Math.round(r.bytes / 1024)}KB`);
    return { label, path: p, width: r.width, height: r.height, bytes: r.bytes };
  };

  const step = async (name, fn) => {
    const s = performance.now();
    try {
      const value = await fn();
      row.steps.push({ name, ok: true, elapsedMs: round(performance.now() - s) });
      return { ok: true, value };
    } catch (e) {
      row.steps.push({
        name,
        ok: false,
        elapsedMs: round(performance.now() - s),
        code: e?.code ?? "ERROR",
        message: String(e?.message ?? e).slice(0, 240),
      });
      return { ok: false, error: e };
    }
  };

  try {
    if (!existsSync(kase.exe) && kase.exe.includes("\\")) {
      row.verdict = "app-not-installed";
      return row;
    }
    spec = kase.prepare(dir);
    row.dir = KEEP ? dir : null;

    proc = spawn(kase.exe, spec.args, { stdio: "ignore", windowsHide: false });
    pid = proc.pid ?? null;

    // 第一阶段（宽松）：先看到「和我们这次文件相关」的窗口。
    // 它可能不是文档窗口，而是启动模态（「文件转换 - xxx.txt」「Word 上次启动失败」）。
    const loose = await waitForWindow(backend, spec, kase.appHint, kase.waitMs ?? 20_000);
    let app = loose.app;
    let found = loose;
    pid = app.pid;
    row.window = {
      appId: app.appId,
      pid: app.pid,
      hwnd: app.hwnd,
      matchedBy: found.matchedBy,
      waitedMs: found.elapsedMs,
      enumSource: app.enumSource,
      totalWindows: found.totalWindows,
    };

    // 受控策略：只授权这一个应用，只给必要的 read/write
    let policy = {
      ...defaultPolicy(),
      enabled: true,
      permissionMode: "auto",
      allowedApps: [{ appId: app.appId, always: true, scopes: ["read", "write"] }],
      deniedApps: [],
    };
    let agent = null;
    let target = { appId: app.appId, pid: app.pid, hwnd: app.hwnd };

    // ── 先答掉启动模态，再做前台探测 ──
    // 顺序很关键：ESC 是「取消」。如果屏幕上正挂着「文件转换 - xxx.txt」，
    // 先发 ESC 等于**取消打开这个文件**，后面所有动作都打在一个空壳上。
    const startup = await settleDialogs(backend, target, 4);
    if (startup.handled.length) row.onboarding = startup.handled;

    // 第二阶段（严格）：答完启动模态后，要求「真正的文档窗口」——标题带我们的文件名，
    // 且不是「文件转换/安全模式/受保护视图」这类壳。Word 会在同一个 hwnd 上换壳，
    // 所以这里同时更新 target。
    const strict = await waitForWindow(backend, spec, kase.appHint, 15_000, { strict: true }).catch(() => null);
    if (strict) {
      app = strict.app;
      found = strict;
      target = { appId: app.appId, pid: app.pid, hwnd: app.hwnd };
      row.window = {
        appId: app.appId,
        pid: app.pid,
        hwnd: app.hwnd,
        matchedBy: strict.matchedBy,
        waitedMs: strict.elapsedMs,
        enumSource: app.enumSource,
        totalWindows: strict.totalWindows,
        afterStartupModal: true,
      };
      policy = {
        ...policy,
        allowedApps: [{ appId: app.appId, always: true, scopes: ["read", "write"] }],
      };
    } else {
      row.window.strictConfirm = "timeout";
    }

    // ── 前置：确认能拿到前台 ──
    // 真机 GUI 自动化的最大不确定源是「人正在用这台机器」：Windows 会拒绝后台进程
    // 抢焦点（这是保护用户的正确行为）。这里先做一次无害的前台探测，拿不到就直接判
    // `environment-busy` 跳过，而不是让后面的动作在半途失败、污染结论。
    agent = new DesktopAgent({ backend, policy, limits: policy });
    const idleDeadline = Date.now() + WAIT_IDLE_MS;
    let preflight = await backend.sendKey({ ...target, combo: "{ESC}" });
    while (preflight?.ok === false && Date.now() < idleDeadline) {
      await sleep(2_000);
      preflight = await backend.sendKey({ ...target, combo: "{ESC}" });
      // 等待期间窗口可能被别的操作关掉，重新取一次目标
      const again = (await backend.listApps()).find((a) => a.hwnd === target.hwnd);
      if (!again) break;
    }
    if (preflight?.ok === false) {
      row.verdict = "environment-busy";
      row.error = { code: preflight.code ?? "ACTION_DENIED", message: "前台被占用（操作者正在使用该机器？），跳过本用例" };
      return row;
    }

    // ── 观察：树质量决定这一家应用该走哪条通道 ──
    // ── 等「能输入」，而不是等「窗口出现」 ──
    // 冷启动时窗口标题几百毫秒就出来了，但编辑面还没准备好：Excel 在这段时间里点击网格
    // 不建立选区、^v 粘贴被丢掉、^s 什么都不做——全套动作都返回 ok，磁盘一个字节没变。
    // 判定方式是「目标角色连续两次快照都在」：既避开闪屏，也避开刚渲染出来的空壳。
    if (kase.readyRoles?.length) {
      const tReady = Date.now();
      let stable = 0;
      while (Date.now() - tReady < (kase.readyTimeoutMs ?? 15_000)) {
        const s = await backend.snapshot({ ...target, maxDepth: kase.maxDepth ?? 4 }).catch(() => null);
        const hit = s
          ? flatten(s.tree).some((n) => kase.readyRoles.includes(n.role) && (n.rect?.width ?? 0) > 4)
          : false;
        stable = hit ? stable + 1 : 0;
        if (stable >= 2) break;
        await sleep(500);
      }
      row.ready = { waitedMs: Date.now() - tReady, ok: stable >= 2, roles: kase.readyRoles };
      if (stable < 2) row.ready.timedOut = true;
    }

    const shot1 = await shoot("1-window", target);
    if (shot1) (row.shots ??= []).push(shot1);

    agent.budget.reset();
    const snap1 = await agent.callTool("desktop_snapshot", { ...target, maxDepth: kase.maxDepth ?? 4 });
    if (snap1?.ok === false) throw Object.assign(new Error(snap1.message ?? "快照失败"), { code: snap1.code });
    const quality = assessTree(snap1.fullTree ?? snap1.tree, { complete: (snap1.nodeCount ?? 0) < 1400 });
    row.tree = {
      quality,
      snapshotId: snap1.snapshotId,
      nodeCount: snap1.nodeCount,
      roles: [...new Set(flatten(snap1.tree).map((n) => n.role))].slice(0, 14),
    };

    const node = pickTarget(snap1.tree);
    if (!node) throw Object.assign(new Error("树里没有可用节点，无法指名操作"), { code: "TREE_NOT_USABLE" });
    row.targetNode = { ref: node.ref, role: node.role, nameLength: String(node.name ?? "").length };

    if (kase.rename) {
      // ── 重命名路径：选中 → F2 → 输入新名 → 回车 → 磁盘校验 ──
      // 列表是异步填充的：窗口标题已经出现时条目可能还没渲染完，必须给一点时间并重试
      // 资源管理器默认隐藏已知扩展名：条目名是 "dcx-ren-xxx"，不带 ".txt"，
      // 只按完整文件名匹配会永远找不到（实测踩到）。
      const baseNoExt = spec.baseName.replace(/\.[a-z0-9]{1,5}$/i, "");
      const findItem = (tree) =>
        flatten(tree).find(
          (n) =>
            ["ListItem", "List", "TreeItem"].includes(n.role) &&
            String(n.name ?? "").includes(baseNoExt)
        );
      let item = findItem(snap1.fullTree ?? snap1.tree);
      for (let attempt = 0; attempt < 3 && !item; attempt += 1) {
        await sleep(900);
        const again = await agent.callTool("desktop_snapshot", { ...target, maxDepth: kase.maxDepth ?? 4 });
        item = findItem(again.fullTree ?? again.tree);
        if (item) row.retriedSnapshot = attempt + 1;
      }
      row.guards.itemNamed = Boolean(item);
      if (!item) {
        // 宁可放弃也不要在「没定位到目标文件」时盲点：资源管理器里点错一个条目，
        // 下一步 F2 就会改到别人的文件上。这类应用必须要求按名字命中。
        throw Object.assign(new Error("树里没有按名字命中目标文件的列表项，拒绝盲点重命名"), { code: "TREE_NOT_USABLE" });
      }
      const clickNode = item;
      agent.budget.reset();
      const click = await step("click_ref", () => agent.callTool("desktop_click", { ...target, snapshotId: snap1.snapshotId, ref: clickNode.ref }));
      if (!click.ok) throw click.error;
      row.channels.push({ action: "click", outcome: click.value?.outcome, via: click.value?.action?.via });

      agent.budget.reset();
      const f2 = await step("key/F2", () =>
        agent.callTool("desktop_key", { ...target, snapshotId: agent.perception.currentSnapshotId(), combo: "{F2}", expectChange: true })
      );
      if (!f2.ok) throw f2.error;
      row.channels.push({ action: "key", combo: "{F2}", outcome: f2.value?.outcome });

      agent.budget.reset();
      const typed = await step("type/new-name", () =>
        agent.callTool("desktop_type", { ...target, value: spec.renamed, expectChange: true })
      );
      if (!typed.ok) throw typed.error;
      row.channels.push({ action: "type", outcome: typed.value?.outcome, via: typed.value?.action?.via });

      agent.budget.reset();
      const enter = await step("key/ENTER", () =>
        agent.callTool("desktop_key", { ...target, snapshotId: agent.perception.currentSnapshotId(), combo: "{ENTER}", expectChange: true })
      );
      if (!enter.ok) throw enter.error;

      const t = Date.now();
      while (Date.now() - t < 4000 && !existsSync(spec.renamedPath)) await sleep(200);
      row.disk = { renamed: existsSync(spec.renamedPath), originalGone: !existsSync(spec.file), waitedMs: Date.now() - t };
      row.verdict = row.disk.renamed ? "write-verified" : "write-not-persisted";
      return row;
    }

    // ── 文本类应用：写入 → 保存 → 读盘 ──
    // 文档模型的更强守卫：直接读正文确认「打开的就是我们那个临时文件」，
    // 比只看标题可靠（Word 标题会去掉扩展名、还带「产品激活失败」这类后缀）
    if (kase.docText && spec.baseline) {
      const doc0 = await readDocText(backend, target);
      row.doc = { before: { ok: doc0.ok, via: doc0.via, length: doc0.length, baselineSeen: doc0.text.includes(spec.baseline.trim()) } };
      if (!doc0.ok) {
        // Excel 的网格没有 Document 元素，TextPattern 读不到整表 —— 这不等于「不是我们的文件」，
        // 只是这家应用不提供正文读取；此时身份由「标题含本次随机文件名」保证。
        row.guards.docBaseline = null;
        row.guards.docTextUnsupported = true;
        kase = { ...kase, docText: false };
      } else if (!row.doc.before.baselineSeen) {
        row.guards.docBaseline = false;
        throw Object.assign(new Error("守卫拦截：文档正文里没有基线文本，可能不是本次创建的文件"), { code: "GUARD_BLOCKED" });
      } else {
        row.guards.docBaseline = true;
      }
    }
    let via = null;
    if (kase.paste) {
      // 文档模型（Word/Excel）：先点进正文，再用剪贴板粘贴。SendKeys 在这类自绘编辑区
      // 会稳定漏字符（实测 13 字符丢 4 个），ValuePattern 又不支持——粘贴是唯一可靠的键盘路径。
      await backend.invokeRef({ snapshotId: snap1.snapshotId, ref: node.ref, action: "click" }).catch(() => null);
      await sleep(250);
      // 光标定标必须发生在**点击之后**：点击会把插入点移到落点，先定标再点击等于白定。
      for (const combo of kase.preType ?? []) {
        await backend.sendKey({ ...target, combo }).catch(() => {});
        await sleep(250);
      }
      const pasted = await withForegroundRetry(() =>
        backend.typeText({ ...target, text: `${MARK} ${spec.marker}`, paste: true })
      );
      via = pasted?.via ?? null;
      row.channels.push({ action: "type", mode: "clipboard-paste", ok: pasted?.ok === true, via });
      if (pasted?.ok !== true) {
        throw Object.assign(new Error(`粘贴通道失败：${pasted?.code ?? pasted?.message ?? "unknown"}`), { code: pasted?.code });
      }
      await sleep(400);
    } else {
    // 非粘贴通道：定标要在写之前（这里是控件级 ValuePattern/键盘输入，落点已由 ref 指定）
    for (const combo of kase.preType ?? []) {
      await backend.sendKey({ ...target, combo }).catch(() => {});
      await sleep(250);
    }
    agent.budget.reset();
    const typeRef = await agent.callTool("desktop_type", {
      ...target,
      snapshotId: snap1.snapshotId,
      ref: node.ref,
      value: `${MARK} ${spec.marker}`,
    });
    if (typeRef?.ok !== false) {
      via = typeRef?.action?.via ?? "value-pattern";
      row.channels.push({ action: "type", mode: "ref", outcome: typeRef?.outcome, via });
    } else {
      row.channels.push({ action: "type", mode: "ref", outcome: typeRef?.code ?? "failed", via: null });
      // 该控件不支持 ValuePattern（Office 文档模型就是这样）：点进正文再用键盘通道
      agent.budget.reset();
      const click = await agent.callTool("desktop_click", {
        ...target,
        snapshotId: agent.perception.currentSnapshotId(),
        ref: node.ref,
      });
      agent.budget.reset();
      const typeKey = await agent.callTool("desktop_type", { ...target, value: `${MARK} ${spec.marker}` });
      if (typeKey?.ok === false) {
        throw Object.assign(new Error(`键盘通道也失败：${typeKey.code} ${typeKey.message ?? ""}`), { code: typeKey.code });
      }
      via = typeKey?.action?.via ?? "keyboard";
      row.channels.push({ action: "type", mode: "keyboard", clickOutcome: click?.outcome, outcome: typeKey?.outcome, via });
    }
    }

    const shot2 = await shoot("2-typed", target);
    if (shot2) (row.shots ??= []).push(shot2);

    if (kase.docText) {
      let doc1 = await readDocText(backend, target);
      if (!doc1.text.includes(spec.marker)) {
        // 自绘文档模型偶尔丢首字符/被自动更正吃掉：再定标一次重打，仍失败就如实记录
        row.retried = true;
        for (const combo of kase.preType ?? []) {
          await backend.sendKey({ ...target, combo }).catch(() => {});
          await sleep(250);
        }
        if (kase.paste) {
          await backend.typeText({ ...target, text: `${MARK} ${spec.marker}`, paste: true });
        } else {
          await agent.callTool("desktop_type", { ...target, value: `${MARK} ${spec.marker}` });
        }
        await sleep(600);
        doc1 = await readDocText(backend, target);
      }
      row.doc = {
        ...(row.doc ?? {}),
        afterType: { via: doc1.via, length: doc1.length, markerSeen: doc1.text.includes(spec.marker) },
      };
    }

    // 保存（幂等：界面不变，成效由读盘自证）
    if (kase.verify !== "uia") {
      agent.budget.reset();
      const save = await agent.callTool("desktop_key", {
        ...target,
        snapshotId: agent.perception.currentSnapshotId(),
        combo: kase.save ?? "^s",
        expectChange: false,
      });
      row.steps.push({ name: "key/save", ok: save?.ok !== false, outcome: save?.outcome ?? save?.code ?? null });
      const shot3 = await shoot("3-saved", target);
      if (shot3) (row.shots ??= []).push(shot3);
    } else {
      await sleep(600); // 浏览器只验证输入是否进入页面
    }

    if (kase.docText) {
      const doc2 = await readDocText(backend, target);
      row.doc = { ...(row.doc ?? {}), afterSave: { length: doc2.length, markerSeen: doc2.text.includes(spec.marker) } };
    }

    if (kase.verify === "disk") {
      // 保存确认（「是否保存为纯文本格式?」）会把落盘卡住：一边等磁盘一边把模态答掉，
      // 否则只会看到「Ctrl+S 返回 ok，但文件没变」这种最难查的静默失败。
      const waited = await waitForDisk(backend, spec.file, spec.marker, {
        target,
        timeoutMs: 15_000,
        resend: async () => {
          // 先回车：若「是否保存为这种格式?」已经弹出来但没被树识别到，默认按钮就是「是」
          await withForegroundRetry(() => backend.sendKey({ ...target, combo: "{ENTER}" })).catch(() => null);
          await withForegroundRetry(() => backend.sendKey({ ...target, combo: kase.save ?? "^s" })).catch(() => null);
          await sleep(300);
          await withForegroundRetry(() => backend.sendKey({ ...target, combo: "{ENTER}" })).catch(() => null);
        },
      });
      if (waited.resends) row.saveResends = waited.resends;
      let onDisk = waited.onDisk;
      if (waited.answered.length) row.saveDialogs = waited.answered;
      if (!onDisk.includes(spec.marker)) {
        // 保存没落盘 → Alt+F4 触发「是否保存更改?」，回答「是」再读盘
        const closed = await saveByClosing(backend, target, spec.file, spec.marker);
        onDisk = closed.onDisk;
        row.saveFallback = { via: "close-and-save", answered: closed.answered, waitedMs: closed.waitedMs };
      }
      row.disk = {
        persisted: onDisk.includes(spec.marker),
        baselinePreserved: spec.baseline ? onDisk.includes(spec.baseline.trim()) : null,
        baselineExpected: !kase.overwriteBaseline,
        length: onDisk.length,
        waitedMs: waited.waitedMs,
      };
      row.verdict = row.disk.persisted ? "write-verified" : "write-not-persisted";
    } else {
      const state = await backend.observeState().catch(() => null);
      const texts = [...(state?.editValues ?? []), ...(state?.texts ?? [])].join("\n");
      row.uia = { markerSeen: texts.includes(spec.marker), sampleLength: texts.length };
      row.verdict = row.uia.markerSeen ? "input-verified-no-persistence" : "input-not-verified";
    }
  } catch (e) {
    row.verdict =
      e?.code === "WINDOW_TIMEOUT"
        ? "window-not-found"
        : e?.code === "TREE_NOT_USABLE"
          ? "tree-not-usable"
          : e?.code === "ACTION_DENIED" && kase.family === "browser-shell"
            ? "policy-blocked-browser"
            : "error";
    row.error = { code: e?.code ?? "ERROR", message: String(e?.message ?? e).slice(0, 300), visible: e?.visible ?? null };
  } finally {
    // 关窗：先 Alt+F4；仍在就按一次回车处理「是否保存」；最后按 PID 兜底
    try {
      if (row.window) {
        await backend
          .sendKey({ appId: row.window.appId, pid: row.window.pid, hwnd: row.window.hwnd, combo: "%{F4}" })
          .catch(() => {});
        await sleep(500);
        const apps = await backend.listApps();
        if (apps.some((a) => a.hwnd === row.window.hwnd)) {
          await backend
            .sendKey({ appId: row.window.appId, pid: row.window.pid, hwnd: row.window.hwnd, combo: "{ENTER}" })
            .catch(() => {});
        }
      }
    } catch {
      /* 关窗失败不改变用例结论 */
    }
    try {
      if (pid && (await pidAlive(pid)) && kase.id !== "explorer-rename") {
        proc?.kill?.();
        if (await pidAlive(pid)) await execFileAsync("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
    await sleep(300);
    try {
      if (!KEEP) rmSync(dir, { recursive: true, force: true });
      row.cleanup = { tempRemoved: !KEEP };
    } catch {
      row.cleanup = { tempRemoved: false };
    }
    row.elapsedMs = round(performance.now() - t0);
    console.log(`[multi] ${row.id}: ${row.verdict} (${row.elapsedMs} ms)`);
  }
  return row;
}

async function main() {
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    session: process.env.SESSIONNAME ?? "unknown",
    privacy: { windowTitlesPersisted: false, note: "只记录标题长度/是否命中随机文件名，不落盘标题内容" },
    cases: [],
  };

  if (process.platform !== "win32" || process.env.DEEPCODE_AGENT_UIA_BRIDGE !== "1") {
    report.summary = { verdict: "skipped", reason: "需要 win32 + DEEPCODE_AGENT_UIA_BRIDGE=1" };
    persist(report);
    console.log(JSON.stringify(report.summary, null, 2));
    return;
  }

  const backend = createWindowsBackend({ bridgeEnabled: true });
  try {
    const caps = await backend.capabilities();
    report.capabilities = { a11yTree: caps.a11yTree.supported, reason: caps.a11yTree.reason };
    if (!caps.a11yTree.supported) {
      report.summary = { verdict: "skipped", reason: caps.a11yTree.reason };
      persist(report);
      console.log(JSON.stringify(report.summary, null, 2));
      return;
    }

    const cases = buildCases().filter((c) => !only || only.has(c.id));
    for (const kase of cases) report.cases.push(await runCase(kase, backend));

    // 有界重试一次：真机失败常常是环境抖动（前台被抢、模态时序），不是能力缺失。
    // 只对「没落盘 / 环境占用 / 异常」重跑，两次结论都留档，不掩盖第一次的失败。
    const RETRYABLE = new Set(["write-not-persisted", "environment-busy", "error"]);
    for (const row of [...report.cases].filter((c) => RETRYABLE.has(c.verdict))) {
      const kase = cases.find((c) => c.id === row.id);
      if (!kase) continue;
      const again = await runCase(kase, backend);
      again.attempts = 2;
      again.firstAttempt = { verdict: row.verdict, error: row.error ?? null, disk: row.disk ?? null };
      const idx = report.cases.findIndex((c) => c.id === row.id);
      const improved = !RETRYABLE.has(again.verdict);
      report.cases[idx] = improved ? again : { ...row, attempts: 2, retry: { verdict: again.verdict, error: again.error ?? null, disk: again.disk ?? null } };
    }

    const verified = report.cases.filter((c) => c.verdict === "write-verified");
    report.summary = {
      verdict:
        verified.length >= Math.min(4, report.cases.length)
          ? "multi-app-write-verified"
          : verified.length > 0
            ? "partial-multi-app"
            : "no-write-verified",
      cases: report.cases.length,
      writeVerified: verified.length,
      environmentBusy: report.cases.filter((c) => c.verdict === "environment-busy").length,
      byFamily: report.cases.reduce((acc, c) => {
        acc[c.family] = c.verdict;
        return acc;
      }, {}),
      channels: report.cases.flatMap((c) => c.channels.map((ch) => `${c.id}:${ch.via ?? ch.outcome}`)),
      treeVerdicts: report.cases.reduce((acc, c) => {
        const k = c.tree?.quality?.verdict ?? "none";
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
      note: "每个用例只用自建临时文件；写入证据以磁盘/文件系统为准，浏览器外壳只验证输入通道",
    };
    persist(report);
    console.log(JSON.stringify(report.summary, null, 2));
    if (report.summary.verdict === "no-write-verified") process.exitCode = 1;
  } finally {
    backend.close();
  }
}

function persist(report) {
  try {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`[multi] report → ${OUT}`);
  } catch (e) {
    console.error(`[multi] 报告写入失败：${e.message}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
