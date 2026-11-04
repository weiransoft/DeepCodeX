#!/usr/bin/env node
/**
 * E2E：桌面版「技能 / 智能体」能力面板的三态验证（Chrome headless + CDP）。
 *
 * ## 覆盖的用户症状
 *
 * 桌面版「+」菜单 → 技能 / 智能体页签、以及 @ 提及补全面板，长期停在
 * 「正在加载可用能力…」——用户看不到任何技能或智能体。
 *
 * 根因有两层（本脚本分别验证）：
 *
 * 1. **前端状态机**：Composer 的 `ensureCaps` 失败被静默吞掉（`.catch` 只重置 TTL），
 *    `caps` 永远停在 null → 界面把"请求早已失败"渲染成"永远加载中"。
 *    正确行为：**失败必须可区分**——显示失败原因 + 「重试」按钮。
 * 2. **后端数据源**：`/api/capabilities` 返回空清单时，界面应显示
 *    「还没有可用技能」这类**空态**文案，而不是「正在加载…」。
 *    （真实引擎侧的读写根错位由 packages/web/tests/agents-api.test.ts 覆盖。）
 *
 * ## 为什么不用 jsdom 单测
 *
 * 「永久显示加载中」是**状态机 + 文案渲染**的组合缺陷，必须真实 React 渲染 +
 * 真实事件（点击「+」/页签/重试按钮）才能复现。jsdom 不跑真实 bundle，
 * 断言很容易假绿。
 *
 * ## 阴性对照
 *
 * 每个失败态用例都断言「正在加载可用能力…」**不出现**——否则断言无法区分
 * "修好了" 与 "文案换了但仍永久加载中"。
 *
 * 用法：
 *   node tests/scripts/e2e-capability-list-ui.mjs            # 含前端构建
 *   node tests/scripts/e2e-capability-list-ui.mjs --no-build # 复用既有 dist
 *
 * 退出码：0 = 全部通过；1 = 有用例失败；2 = 环境不可用（无 Chrome 等）
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const WEB_DIST = path.join(REPO_ROOT, "packages/web/web/dist");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HTTP_PORT = 4478;
const CDP_PORT = 9478;

// ---------- 用例计数 ----------
let pass = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------- 1. 构建前端 ----------
if (!process.argv.includes("--no-build")) {
  console.log("==> [1/4] 构建前端 bundle（真实源码 → dist）");
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "packages/web/web/build.mjs")], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error("前端构建失败");
    process.exit(2);
  }
} else {
  console.log("==> [1/4] 跳过构建（--no-build）");
}
if (!existsSync(path.join(WEB_DIST, "bundle.js"))) {
  console.error(`找不到 ${WEB_DIST}/bundle.js`);
  process.exit(2);
}
if (!existsSync(CHROME)) {
  console.error(`找不到 Chrome：${CHROME}`);
  process.exit(2);
}

// ---------- 2. 静态服务 + API mock ----------
// 只 mock 后端 REST；页面是真实 bundle、真实 CSS、真实 React。
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** 能力清单 mock 开关：true = 返回 500（失败）；false = 返回正常清单 */
let capabilitiesFailing = true;
/** 能力清单 mock 延迟（毫秒）：用于复现"清单到达晚于面板打开"的时序 */
let capabilitiesDelayMs = 0;

const CAPABILITY_SKILLS = [
  {
    name: "e2e-skill-alpha",
    description: "E2E 技能条目",
    path: "/tmp/e2e/.deepcode/skills/e2e-skill-alpha/SKILL.md",
    kind: "skill",
  },
  {
    name: "e2e-agent-beta",
    description: "E2E 智能体条目",
    path: "/tmp/e2e/.deepcode/skills/e2e-agent-beta/SKILL.md",
    kind: "agent",
    preset: true,
    group: "测试组",
    role: "端到端测试角色",
  },
];

const API_MOCK = {
  "/api/auth/me": { username: "e2e-user", displayName: "E2E", mail: "e2e@example.com", authSource: "local" },
  "/api/config": {
    allowRoots: [],
    maxUploadBytes: 10485760,
    ldapEnabled: false,
    personalOnly: true,
    steeringEnabled: true,
    maxPreviewBytes: 1048576,
    personalRoot: "/tmp/e2e-personal",
    version: "0.0.0-e2e",
  },
  "/api/chats": { chats: [] },
  "/api/workspaces": { workspaces: [] },
  "/api/rules": { rules: [] },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const pathname = url.pathname;

  if (pathname === "/api/capabilities") {
    if (capabilitiesDelayMs > 0) {
      await new Promise((r) => setTimeout(r, capabilitiesDelayMs));
    }
    if (capabilitiesFailing) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "能力扫描失败（E2E 注入）" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        skills: CAPABILITY_SKILLS,
        mcpServers: [],
        defaultAgent: null,
        commands: [{ name: "/team status", description: "查看团队状态" }],
      })
    );
    return;
  }

  if (pathname.startsWith("/api/")) {
    const body = API_MOCK[pathname] ?? {};
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
    return;
  }

  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(WEB_DIST, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    try {
      const buf = await readFile(path.join(WEB_DIST, "index.html"));
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      res.end(buf);
    } catch {
      res.writeHead(404).end("not found");
    }
  }
});

await new Promise((resolve) => server.listen(HTTP_PORT, "127.0.0.1", resolve));
console.log(`==> [2/4] 静态服务已就绪 http://127.0.0.1:${HTTP_PORT}`);

// ---------- 3. 启动 Chrome ----------
const userDataDir = path.join("/tmp", `deepcode-cap-e2e-chrome-${process.pid}`);
await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${CDP_PORT}`,
    `--remote-allow-origins=*`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-extensions",
    "--window-size=1440,900",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: "ignore" }
);

/** 轮询 CDP /json/list 取 page target 的调试地址（直连 page 比 browser+session 更稳） */
async function waitPageTarget() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find((t) => t.type === "page");
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}
const pageWsUrl = await waitPageTarget();
if (!pageWsUrl) {
  console.error("Chrome CDP 未就绪");
  chrome.kill("SIGKILL");
  server.close();
  process.exit(2);
}
console.log("==> [3/4] Chrome CDP 已连接");

// ---------- 4. 极简 CDP 客户端 ----------
const ws = new WebSocket(pageWsUrl);
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
let msgId = 0;
const pending = new Map();
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});
function cdp(method, params = {}) {
  const id = (msgId += 1);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await cdp("Page.enable");
await cdp("Runtime.enable");

/** 在页面求值（返回 JSON 可序列化值） */
async function evaluate(expression) {
  const r = await cdp("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "页面求值异常");
  return r.result.value;
}

/** 轮询等待条件成立 */
async function waitFor(expression, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待超时：${label}`);
}

// 注入桌面壳桥（真实壳用同一份契约：isDesktop + platform + invoke）
await cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `
      window.__DEEPCODE_DESKTOP__ = {
        isDesktop: true,
        platform: "tauri-v2",
        invoke(cmd) {
          if (cmd === "config_get") {
            return Promise.resolve({ models: [], mcpServers: [], ldap: null, firstLoginDone: true });
          }
          return Promise.resolve(null);
        },
      };
    `,
});

/** 读「+」能力菜单面板的当前内容 */
const readMenu = () =>
  evaluate(`(() => ({
    emptyText: document.querySelector(".composer-menu-empty")?.textContent ?? null,
    errorText: document.querySelector(".composer-menu-error-text")?.textContent ?? null,
    hasRetry: !!document.querySelector(".composer-menu-retry"),
    items: Array.from(document.querySelectorAll(".composer-menu-item")).map((b) => b.innerText.split("\\n")[0]),
    // 智能体条目的展示名是中文角色名，技术名在 .composer-menu-id 里——两个都取
    itemText: Array.from(document.querySelectorAll(".composer-menu-item")).map((b) => b.innerText).join("\\n"),
  }))()`);

/** 点「+」并切到指定页签（菜单已打开时不重复点「+」，避免把它关掉） */
async function openCapabilityTab(tabLabel) {
  const menuOpen = await evaluate(`!!document.querySelector(".composer-menu")`);
  if (!menuOpen) {
    await evaluate(`document.querySelector(".composer-plus")?.click()`);
    await new Promise((r) => setTimeout(r, 250));
  }
  const ok = await evaluate(`(() => {
    const t = Array.from(document.querySelectorAll(".composer-menu-tab")).find((b) => b.textContent === ${JSON.stringify(tabLabel)});
    if (!t) return false;
    t.click();
    return true;
  })()`);
  if (!ok) throw new Error(`未找到能力菜单页签：${tabLabel}`);
  await new Promise((r) => setTimeout(r, 600));
}

/** 关闭「+」菜单 */
async function closeMenu() {
  await evaluate(`document.querySelector(".composer-plus")?.click()`);
  await new Promise((r) => setTimeout(r, 200));
}

try {
  // ================= 场景 A：能力端点失败 =================
  console.log("\n==> 场景 A：/api/capabilities 返回 500（模拟能力扫描失败）");
  capabilitiesFailing = true;
  capabilitiesDelayMs = 0;
  await cdp("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/` });
  await waitFor(`!!document.querySelector(".composer-plus")`, "主界面加载", 20000);

  await openCapabilityTab("技能");
  const failMenu = await readMenu();
  check(
    "A1 技能页签在失败时显示失败原因，而非「正在加载可用能力…」",
    typeof failMenu.errorText === "string" && failMenu.errorText.includes("加载失败"),
    `errorText=${failMenu.errorText}`
  );
  check(
    "A2 失败态不出现「正在加载可用能力…」",
    !(failMenu.emptyText ?? "").includes("正在加载可用能力"),
    `emptyText=${failMenu.emptyText}`
  );
  check("A3 失败态提供「重试」按钮", failMenu.hasRetry === true);

  // ================= 场景 B：点「重试」后恢复 =================
  console.log("\n==> 场景 B：恢复能力端点后点「重试」（面板保持打开，不重新进入）");
  capabilitiesFailing = false;
  await evaluate(`document.querySelector(".composer-menu-retry")?.click()`);
  await waitFor(`Array.from(document.querySelectorAll(".composer-menu-item")).length > 0`, "重试后技能条目出现", 15000);
  const afterRetry = await readMenu();
  check(
    "B1 点「重试」后技能条目出现",
    afterRetry.items.includes("e2e-skill-alpha"),
    `items=${afterRetry.items.join(",")}`
  );
  check(
    "B2 重试后不再显示失败文案",
    (afterRetry.errorText ?? "") === "" && !(afterRetry.emptyText ?? "").includes("正在加载"),
    `errorText=${afterRetry.errorText} emptyText=${afterRetry.emptyText}`
  );

  // ================= 场景 C：智能体页签 =================
  console.log("\n==> 场景 C：智能体页签");
  await openCapabilityTab("智能体");
  const agentMenu = await readMenu();
  check(
    "C1 智能体页签列出智能体条目",
    agentMenu.itemText.includes("e2e-agent-beta"),
    `items=${agentMenu.items.join(",")}`
  );
  check(
    "C2 智能体页签不显示「正在加载可用能力…」",
    !(agentMenu.emptyText ?? "").includes("正在加载可用能力"),
    `emptyText=${agentMenu.emptyText}`
  );
  await closeMenu();

  // ================= 场景 D：清单到达晚于面板打开 =================
  // 复现真实时序：用户敲下 @ 就停手，能力清单随后才到。
  // 期望：清单到达后候选**自动补上**（无需用户再敲一个字符）。
  console.log("\n==> 场景 D：清单延迟到达（用户敲完 @ 就停手）");
  capabilitiesDelayMs = 1200;
  await cdp("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/` });
  await waitFor(`!!document.querySelector(".composer-plus")`, "主界面加载", 20000);
  await evaluate(`(() => {
    const ta = document.querySelector(".composer-input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, "@");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await waitFor(
    `document.querySelectorAll(".composer-mention .composer-mention-item").length > 0`,
    "清单到达后 @ 候选自动出现",
    15000
  );
  const lateMention = await evaluate(`(() => ({
    emptyText: document.querySelector(".composer-mention-empty")?.textContent ?? null,
    count: document.querySelectorAll(".composer-mention .composer-mention-item").length,
  }))()`);
  check("D1 清单延迟到达后 @ 候选自动出现（无需再敲字符）", lateMention.count > 0, `count=${lateMention.count}`);
  check(
    "D2 延迟场景不出现「正在加载可用能力…」",
    !(lateMention.emptyText ?? "").includes("正在加载可用能力"),
    `emptyText=${lateMention.emptyText}`
  );
  capabilitiesDelayMs = 0;
} finally {
  chrome.kill("SIGKILL");
  ws.close();
  server.close();
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n=========================================`);
console.log(`  通过 ${pass} / ${pass + failures.length}`);
if (failures.length > 0) {
  console.log("  失败用例：");
  for (const f of failures) console.log(`   - ${f}`);
  console.log("=========================================\n");
  process.exit(1);
}
console.log("=========================================\n");
process.exit(0);
