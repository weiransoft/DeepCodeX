#!/usr/bin/env node
/**
 * 桌面 IPC 契约校验（DeepCode Desktop / Tauri v2）。
 *
 * 背景（2026-11-01 "Command config_save not allowed by ACL" 事故）：
 * 主窗口从本地 boot.html 导航到 `http://127.0.0.1:<port>` 后 origin 变为 remote，
 * 而 Tauri 2 对 **remote origin 调用应用自有命令一律要求显式 ACL 授权**。
 * 此前 `invoke_handler` 已注册的命令与 `permissions/app-ipc.toml` 的白名单
 * 靠人工同步，一旦漏项，运行时才报 not allowed by ACL——本地开发（local origin
 * 默认放行）完全测不出来，只能在打包后由用户撞上。
 *
 * 本脚本把这份"人工同步"变成构建期硬约束，校验三方一致性：
 *   1. `ipc.rs` 中 #[tauri::command] 定义集
 *   2. `lib.rs` 中 invoke_handler 注册集
 *   3. `permissions/app-ipc.toml` 的 commands.allow 授权集
 *   4. 前端（web 源码 + boot.html）实际 invoke 的调用集
 *
 * 硬性规则：
 *   - 注册集 **必须等于** 授权集（多一个 = 运行期 ACL 拒绝；少一个 = 幽灵授权）
 *   - 定义集 **必须等于** 注册集（防拼错/漏注册）
 *   - 调用集 − 注册集 必须落在 PENDING_M2 显式声明内（悬空调用不许静默存在）
 *
 * 用法：node scripts/check-desktop-ipc-contract.mjs [--json]
 * 退出码：0 通过；1 契约破坏。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const PATHS = {
  libRs: "desktop/src-tauri/src/lib.rs",
  ipcRs: "desktop/src-tauri/src/ipc.rs",
  aclToml: "desktop/src-tauri/permissions/app-ipc.toml",
  webSrc: "packages/web/web/src",
  staticDir: "desktop/static",
};

/**
 * 前端已调用、但壳尚未注册的命令。
 *
 * 这是**白名单式声明**：新增悬空调用必须在此登记（含原因与文档），
 * 否则校验失败。反过来，某项一旦在壳侧实现（进入注册集），本表若仍保留
 * 也会被提示清理——防止清单腐化成"永远待办"。
 */
const PENDING_COMMANDS = {
  ssh_list_targets: {
    reason: "M2 SSH 远程连接子系统未实现：desktop/src-tauri/src/ssh/ 整个目录不存在",
    doc: "docs/desktop/DESKTOP-ARCH.md §3.3（SshManager 状态机）",
  },
  ssh_import_config: {
    reason: "同上：~/.ssh/config 解析器（sshconfig.rs）未实现",
    doc: "docs/desktop/DESKTOP-ARCH.md §3.1（关键 IPC 命令面）",
  },
  ssh_connect: {
    reason: "同上：探测(probe)/部署(deploy)/隧道(tunnel) 三阶段未实现",
    doc: "docs/desktop/DESKTOP-ARCH.md §3.3",
  },
  ssh_disconnect: {
    reason: "同上：连接生命周期状态机未实现",
    doc: "docs/desktop/DESKTOP-ARCH.md §3.3",
  },
};

const errors = [];
const warnings = [];
const notes = [];

function read(relPath) {
  return readFileSync(join(ROOT, relPath), "utf8");
}

function walk(dir, exts) {
  const out = [];
  const stack = [join(ROOT, dir)];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", "build", "__snapshots__"].includes(entry.name)) continue;
        stack.push(full);
      } else if (exts.some((e) => entry.name.endsWith(e))) {
        out.push(full);
      }
    }
  }
  return out;
}

/** 从 lib.rs 的 tauri::generate_handler![...] 提取注册命令名 */
function parseRegistered(libSrc) {
  const block = /generate_handler!\s*\[([\s\S]*?)\]/.exec(libSrc);
  if (!block) {
    errors.push(
      `无法在 ${PATHS.libRs} 中解析 tauri::generate_handler![...]——` +
        "若注册方式有变，请同步更新本校验脚本（否则 ACL 一致性失去保障）"
    );
    return new Set();
  }
  const names = new Set();
  for (const rawLine of block[1].split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("//")) continue;
    const name = line.replace(/,$/, "").trim().split("::").pop();
    if (/^[A-Za-z_]\w*$/.test(name)) names.add(name);
  }
  return names;
}

/** 从 ipc.rs 提取所有 #[tauri::command] 标注的函数名（跳过被注释掉的） */
function parseCommandFns(ipcSrc) {
  const names = new Set();
  const re = /#\[tauri::command\]/g;
  let hit;
  while ((hit = re.exec(ipcSrc)) !== null) {
    const lineStart = ipcSrc.lastIndexOf("\n", hit.index) + 1;
    if (ipcSrc.slice(lineStart, hit.index).includes("//")) continue;
    const fn = /\bfn\s+([A-Za-z_]\w*)/.exec(ipcSrc.slice(hit.index));
    if (fn) names.add(fn[1]);
  }
  return names;
}

/** 从 ACL TOML 提取 commands.allow 数组 */
function parseAcl(tomlSrc) {
  const block = /commands\.allow\s*=\s*\[([\s\S]*?)\]/.exec(tomlSrc);
  if (!block) {
    errors.push(`无法在 ${PATHS.aclToml} 中解析 commands.allow——ACL 白名单缺失将导致全部命令被拒`);
    return new Set();
  }
  const names = new Set();
  for (const hit of block[1].matchAll(/"([A-Za-z_]\w*)"/g)) names.add(hit[1]);
  return names;
}

/** 收集前端调用点：{ cmd -> [文件:行] } */
function parseCallSites() {
  const sites = new Map();
  const add = (cmd, where) => {
    if (!sites.has(cmd)) sites.set(cmd, []);
    sites.get(cmd).push(where);
  };

  // web 前端：bridge.invoke<T>("cmd", ...) —— 允许跨行与泛型参数
  const invokeRe = /\.invoke\s*(?:<[^<>]*>)?\s*\(\s*["'`]([A-Za-z_]\w*)["'`]/g;
  for (const file of walk(PATHS.webSrc, [".ts", ".tsx"])) {
    const src = readFileSync(file, "utf8");
    for (const hit of src.matchAll(invokeRe)) {
      const line = src.slice(0, hit.index).split("\n").length;
      add(hit[1], `${file.slice(ROOT.length)}:${line}`);
    }
  }

  // boot.html 等静态页：rawInvoke("cmd", ...)
  const rawRe = /rawInvoke\s*\(\s*["']([A-Za-z_]\w*)["']/g;
  for (const file of walk(PATHS.staticDir, [".html"])) {
    const src = readFileSync(file, "utf8");
    for (const hit of src.matchAll(rawRe)) {
      const line = src.slice(0, hit.index).split("\n").length;
      add(hit[1], `${file.slice(ROOT.length)}:${line}`);
    }
  }

  return sites;
}

function diff(a, b) {
  return [...a].filter((x) => !b.has(x)).sort();
}

function main() {
  const defined = parseCommandFns(read(PATHS.ipcRs));
  const registered = parseRegistered(read(PATHS.libRs));
  const acl = parseAcl(read(PATHS.aclToml));
  const callSites = parseCallSites();
  const called = new Set(callSites.keys());

  // ── 规则 1：注册集必须等于授权集（ACL 事故的直接护栏） ──
  const aclMissing = diff(registered, acl);
  if (aclMissing.length > 0) {
    errors.push(
      `以下命令已在 invoke_handler 注册，但 ${PATHS.aclToml} 未授权：\n` +
        aclMissing.map((c) => `      - ${c}`).join("\n") +
        "\n      → 引擎页（remote origin）调用会报 `Command <name> not allowed by ACL`。" +
        `请把它们加入 commands.allow。`
    );
  }
  const aclGhost = diff(acl, registered);
  if (aclGhost.length > 0) {
    warnings.push(
      `以下命令在 ACL 中授权，但 invoke_handler 并未注册：${aclGhost.join(", ")}` +
        "\n      → 属幽灵授权，建议移除以保持最小权限面。"
    );
  }

  // ── 规则 2：ipc.rs 定义集必须等于注册集 ──
  const unregistered = diff(defined, registered);
  if (unregistered.length > 0) {
    errors.push(
      `以下 #[tauri::command] 已定义但未注册到 invoke_handler：${unregistered.join(", ")}` +
        "\n      → 前端调用会得到 `Command <name> not found`。"
    );
  }
  const undefinedFns = diff(registered, defined);
  if (undefinedFns.length > 0) {
    errors.push(`invoke_handler 引用了 ipc.rs 中不存在的命令（函数名拼写错误？）：${undefinedFns.join(", ")}`);
  }

  // ── 规则 3：悬空调用必须显式声明 ──
  const dangling = diff(called, registered);
  const undeclared = dangling.filter((c) => !(c in PENDING_COMMANDS));
  if (undeclared.length > 0) {
    errors.push(
      `前端调用了既未注册、也未在 PENDING_COMMANDS 声明的命令：${undeclared.join(", ")}` +
        "\n      → 要么在壳侧实现并注册 + 授权，要么在 scripts/check-desktop-ipc-contract.mjs" +
        "\n        的 PENDING_COMMANDS 中登记（附原因与文档引用）。"
    );
  }

  const declaredDangling = dangling.filter((c) => c in PENDING_COMMANDS);
  const stale = Object.keys(PENDING_COMMANDS).filter((c) => !dangling.includes(c));
  if (stale.length > 0) {
    warnings.push(
      `PENDING_COMMANDS 中以下项已不再悬空（可能已实现或前端已移除调用）：${stale.join(", ")}` +
        "\n      → 请清理该声明，避免待办清单腐化。"
    );
  }

  // 注册但无人调用（可能遗漏前端接线）
  const neverCalled = diff(registered, called);
  if (neverCalled.length > 0) {
    notes.push(`以下命令已注册但未在任何前端调用点出现：${neverCalled.join(", ")}`);
  }

  // ── 输出 ──
  const line = "═".repeat(62);
  console.log(line);
  console.log("DeepCode 桌面 IPC 契约校验");
  console.log(line);
  console.log(`[Rust] ipc.rs 定义            ${String(defined.size).padStart(3)} 个`);
  console.log(`[Rust] invoke_handler 注册    ${String(registered.size).padStart(3)} 个`);
  console.log(`[ACL ] commands.allow 授权     ${String(acl.size).padStart(3)} 个`);
  console.log(`[前端] invoke 调用点           ${String(called.size).padStart(3)} 个`);
  console.log(line);

  if (registered.size > 0 && aclMissing.length === 0 && aclGhost.length === 0) {
    console.log(`✔ 注册集 == ACL 授权集（${registered.size} 个），remote origin 不会因授权缺失被拒`);
  }
  if (unregistered.length === 0 && undefinedFns.length === 0 && defined.size > 0) {
    console.log("✔ ipc.rs 定义 == invoke_handler 注册");
  }
  if (declaredDangling.length > 0) {
    console.log(`⚠ ${declaredDangling.length} 个前端调用属已声明的待实现项：`);
    for (const cmd of declaredDangling) {
      console.log(`    - ${cmd}：${PENDING_COMMANDS[cmd].reason}`);
      console.log(`      ${callSites.get(cmd).join(", ")}  ·  ${PENDING_COMMANDS[cmd].doc}`);
    }
  }

  for (const w of warnings) console.log(`⚠ 警告：${w}`);
  for (const n of notes) console.log(`ℹ 提示：${n}`);

  if (errors.length > 0) {
    console.log(line);
    for (const e of errors) console.error(`✘ ${e}`);
    console.error(line);
    console.error(`契约校验失败：${errors.length} 项错误。`);
    process.exit(1);
  }

  console.log(line);
  console.log("契约校验通过。");
}

main();
