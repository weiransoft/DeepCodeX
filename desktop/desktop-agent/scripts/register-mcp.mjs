#!/usr/bin/env node
/**
 * 把 desktop-agent sidecar 登记到桌面端 MCP 配置（开发/联调用，opt-in）。
 *
 * 为什么要写两个文件（见 desktop/src-tauri/src/config_persist.rs:350-390）：
 *   - `~/.deepcode/desktop.json` 的 `mcpServers` 是 **UI 数组形态**
 *     [{id,name,command,args,env,enabled}]，配置页读它、保存时全量回写；
 *   - `~/.deepcode/settings.json` 的 `mcpServers` 是 **引擎 Record 形态**
 *     { "<name>": {command,args,env} }，会话启动时由 McpManager 消费。
 * 只改 settings.json 会在用户下一次从配置页保存时被 UI 全量覆盖而丢失；
 * 只改 desktop.json 则要等到下次保存才生效。因此两侧同写，且保持幂等。
 *
 * 默认 **dry-run**：只打印将发生的变化；加 --write 才落盘（落盘前留 .bak）。
 *   npm run register:mcp                 # 预览
 *   npm run register:mcp -- --write      # 登记
 *   npm run register:mcp -- --remove --write
 *   npm run register:mcp -- --home <dir> --write   # 测试/隔离家目录
 *
 * 注意：登记后需重启引擎（配置页保存或 desktop_agent_toggle 后的重启提示），
 * McpManager 才会拉起 sidecar 子进程。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MCP_NAME = "desktop-agent";
export const DEEPCODE_DIR = ".deepcode";

const clone = (v) => JSON.parse(JSON.stringify(v));
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function defaultEntryPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.mjs");
}

export function buildEntries({ entryPath = defaultEntryPath(), command = process.execPath } = {}) {
  const args = [entryPath];
  return {
    settingsEntry: { command, args },
    uiEntry: { id: MCP_NAME, name: MCP_NAME, command, args, env: {}, enabled: true },
  };
}

/** 纯函数：返回新对象，不修改入参 */
export function applyRegistration({ settings = {}, desktop = {}, settingsEntry, uiEntry }) {
  const nextSettings = clone(isPlainObject(settings) ? settings : {});
  const nextDesktop = clone(isPlainObject(desktop) ? desktop : {});

  const servers = isPlainObject(nextSettings.mcpServers) ? { ...nextSettings.mcpServers } : {};
  servers[MCP_NAME] = settingsEntry;
  nextSettings.mcpServers = servers;

  const list = Array.isArray(nextDesktop.mcpServers) ? [...nextDesktop.mcpServers] : [];
  const kept = list.filter((s) => !(s && (s.name === MCP_NAME || s.id === MCP_NAME)));
  kept.push(uiEntry);
  nextDesktop.mcpServers = kept;

  return {
    settings: nextSettings,
    desktop: nextDesktop,
    changed: JSON.stringify(nextSettings) !== JSON.stringify(settings) || JSON.stringify(nextDesktop) !== JSON.stringify(desktop),
  };
}

/** 纯函数：移除登记，保留其他 MCP 服务与其他配置键 */
export function removeRegistration({ settings = {}, desktop = {} }) {
  const nextSettings = clone(isPlainObject(settings) ? settings : {});
  const nextDesktop = clone(isPlainObject(desktop) ? desktop : {});

  if (isPlainObject(nextSettings.mcpServers)) {
    delete nextSettings.mcpServers[MCP_NAME];
  }
  if (Array.isArray(nextDesktop.mcpServers)) {
    nextDesktop.mcpServers = nextDesktop.mcpServers.filter(
      (s) => !(s && (s.name === MCP_NAME || s.id === MCP_NAME))
    );
  }

  return {
    settings: nextSettings,
    desktop: nextDesktop,
    changed: JSON.stringify(nextSettings) !== JSON.stringify(settings) || JSON.stringify(nextDesktop) !== JSON.stringify(desktop),
  };
}

/** 安全读取：文件不存在 / 内容损坏 → 回落空对象，返回警告而不是崩掉 */
export function readConfig(path, fs = { existsSync, readFileSync }) {
  if (!fs.existsSync(path)) return { value: {}, warning: null };
  try {
    const value = JSON.parse(fs.readFileSync(path, "utf8"));
    return { value: isPlainObject(value) ? value : {}, warning: isPlainObject(value) ? null : `${path} 顶层不是对象，已按空对象处理` };
  } catch (e) {
    return { value: {}, warning: `${path} 解析失败（${e.message}），已按空对象处理；原文件保留为 .bak` };
  }
}

export function parseArgs(argv = []) {
  const out = { write: false, remove: false, home: homedir(), entry: defaultEntryPath(), command: process.execPath };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") out.write = true;
    else if (a === "--remove") out.remove = true;
    else if (a === "--home" && argv[i + 1]) out.home = resolve(argv[++i]);
    else if (a === "--entry" && argv[i + 1]) out.entry = resolve(argv[++i]);
    else if (a === "--command" && argv[i + 1]) out.command = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

export function run(argv = process.argv.slice(2), { log = console.log, fs = { existsSync, readFileSync, writeFileSync } } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    log("用法：node scripts/register-mcp.mjs [--write] [--remove] [--home <dir>] [--entry <path>] [--command <cmd>]");
    return { applied: false, changed: false };
  }

  const dir = join(opts.home, DEEPCODE_DIR);
  const settingsPath = join(dir, "settings.json");
  const desktopPath = join(dir, "desktop.json");
  const s = readConfig(settingsPath, fs);
  const d = readConfig(desktopPath, fs);
  for (const w of [s.warning, d.warning]) if (w) log(`[warn] ${w}`);

  const entries = buildEntries({ entryPath: opts.entry, command: opts.command });
  const result = opts.remove
    ? removeRegistration({ settings: s.value, desktop: d.value })
    : applyRegistration({ ...entries, settings: s.value, desktop: d.value });

  log(`[${opts.remove ? "remove" : "register"}] ${MCP_NAME}`);
  log(`  entry    : ${opts.command} ${opts.entry}`);
  log(`  settings : ${settingsPath}`);
  log(`  desktop  : ${desktopPath}`);

  if (!result.changed) {
    log("  状态     : 已是目标状态，无需改动（幂等）");
    return { applied: false, changed: false };
  }

  const before = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
  const writeOne = (p, value, original) => {
    if (original !== null) fs.writeFileSync(`${p}.bak`, original, "utf8");
    fs.writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };

  if (!opts.write) {
    log("  状态     : dry-run（未写入）。确认后追加 --write");
    log(`  settings.mcpServers["${MCP_NAME}"] = ${JSON.stringify(result.settings.mcpServers?.[MCP_NAME] ?? null)}`);
    log(`  desktop.mcpServers 共 ${result.desktop.mcpServers?.length ?? 0} 项`);
    return { applied: false, changed: true };
  }

  writeOne(settingsPath, result.settings, before(settingsPath));
  writeOne(desktopPath, result.desktop, before(desktopPath));
  log("  状态     : 已写入（原文件备份为 *.bak）；重启引擎后生效");
  return { applied: true, changed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (e) {
    console.error(`[register-mcp] ${e.message}`);
    process.exitCode = 1;
  }
}
