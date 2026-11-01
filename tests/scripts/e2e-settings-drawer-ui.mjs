#!/usr/bin/env node
/**
 * E2E：系统管理抽屉的真实渲染验证（Chrome headless + CDP）。
 *
 * 覆盖 2026-11-01 三项 UI 修复：
 *   1. 「支持图片输入」「思考模式」单选行文字竖排 → 必须横向单行；
 *   2. 新增「思考强度」下拉 → 必须存在、六档齐全、关闭思考时禁用；
 *   3. 添加模型即落盘 → 点「添加模型」后必须立刻触发壳 IPC config_save。
 *
 * 为什么不用 jsdom 单测：竖排是纯 CSS 布局缺陷（`.cfg-field input{width:100%}`
 * 误命中 radio，把标签压成 1 字宽），jsdom 不做布局、也不加载真实 CSS，
 * 断言永远为绿。这里必须真实浏览器 + 真实几何测量。
 *
 * 断言带"阴性对照"：注入旧样式强制复现竖排，检测函数必须能判出问题——
 * 否则说明断言本身没有辨别力（假绿）。
 *
 * 用法：
 *   node tests/scripts/e2e-settings-drawer-ui.mjs            # 含前端构建
 *   node tests/scripts/e2e-settings-drawer-ui.mjs --no-build # 复用既有 dist
 *
 * 退出码：0 = 全部通过；1 = 有用例失败；2 = 环境不可用（无 Chrome 等）
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const WEB_DIST = path.join(REPO_ROOT, "packages/web/web/dist");
const OUT_DIR = path.join(REPO_ROOT, "tests/e2e-output");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HTTP_PORT = 4477;
const CDP_PORT = 9477;

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
  console.log("==> [1/5] 构建前端 bundle（真实源码 → dist）");
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "packages/web/web/build.mjs")], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error("前端构建失败");
    process.exit(2);
  }
} else {
  console.log("==> [1/5] 跳过构建（--no-build）");
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
// 只 mock 后端 REST，不 mock 前端逻辑：页面仍是真实 bundle、真实 CSS、真实 React。
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** 桌面壳 IPC 调用记录（由注入的 bridge 写入，供「即存」断言使用） */
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
  "/api/capabilities": { skills: [], agents: [] },
  "/api/rules": { rules: [] },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const pathname = url.pathname;

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
    // SPA 回退
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
console.log(`==> [2/5] 静态服务已就绪 http://127.0.0.1:${HTTP_PORT}`);

// ---------- 3. 启动 Chrome ----------
const userDataDir = path.join("/tmp", `deepcode-e2e-chrome-${process.pid}`);
await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    // 本环境（CI/沙箱）无法初始化 Chrome 自带沙箱，不加会报
    // "sandbox initialization failed: Operation not permitted" 并让渲染进程崩溃
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
console.log("==> [3/5] Chrome CDP 已连接");

// ---------- 4. 极简 CDP 客户端（直连 page target） ----------
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
function cdp(method, params = {}, sessionId) {
  const id = (msgId += 1);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
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
      window.__E2E_INVOKES__ = [];
      window.__DEEPCODE_DESKTOP__ = {
        isDesktop: true,
        platform: "tauri-v2",
        invoke(cmd, args) {
          window.__E2E_INVOKES__.push({ cmd, args });
          if (cmd === "config_get") {
            return Promise.resolve({ models: [], mcpServers: [], ldap: null, firstLoginDone: true });
          }
          if (cmd === "config_save") {
            return Promise.resolve({ ...args.payload, firstLoginDone: true });
          }
          return Promise.resolve(null);
        },
      };
    `,
});

await cdp("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/` });
await waitFor(`!!document.querySelector('[aria-label="系统管理"]')`, "活动栏渲染");
console.log("==> [4/5] 页面已渲染，开始交互");

// ---------- 5. 交互与断言 ----------
console.log("\n【场景 A】打开「系统管理」→「添加模型」→ 展开高级配置");

// 打开系统管理抽屉
await evaluate(`document.querySelector('[aria-label="系统管理"]').click()`);
await waitFor(`!!document.querySelector('.settings-drawer')`, "设置抽屉打开");
check("系统管理抽屉可打开", true);

// 点「添加模型」（按钮文本含"添加模型"）
const clickedAdd = await evaluate(`
  (() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('添加模型'));
    if (!btn) return false;
    btn.click();
    return true;
  })()
`);
check("存在「添加模型」按钮并可点击", clickedAdd === true);

// 展开「高级配置」（按钮内含箭头 span，按类名定位最稳）
await waitFor(`!!document.querySelector('.cfg-adv-toggle')`, "高级配置按钮出现");
const expandedAlready = await evaluate(
  `document.querySelector('.cfg-adv-toggle')?.getAttribute('aria-expanded') === 'true'`
);
if (!expandedAlready) {
  await evaluate(`document.querySelector('.cfg-adv-toggle').click()`);
}
await waitFor(`document.querySelectorAll('.cfg-check').length >= 6`, "高级配置展开（6 个单选项）");

// 测量函数：对每个 .cfg-check 内的文本节点做 Range 几何测量
const MEASURE = `
  (() => {
    const rows = [];
    document.querySelectorAll('.cfg-check').forEach((el) => {
      const textNode = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
      let rects = [];
      if (textNode) {
        const range = document.createRange();
        range.selectNodeContents(textNode);
        rects = [...range.getClientRects()];
      }
      const box = el.getBoundingClientRect();
      rows.push({
        text: (el.textContent || '').trim(),
        lineCount: rects.length,
        textWidth: rects.length ? Math.max(...rects.map((r) => r.width)) : 0,
        textHeight: rects.length ? Math.max(...rects.map((r) => r.height)) : 0,
        boxWidth: box.width,
        boxHeight: box.height,
      });
    });
    return rows;
  })()
`;

/** 判定"是否横向单行"：文本只占 1 行，且宽度足以容纳每个字符（竖排时每字一行） */
function isHorizontalRow(row) {
  const minWidth = Math.max(12, row.text.length * 9);
  return row.lineCount === 1 && row.textWidth >= minWidth;
}

const rows = await evaluate(MEASURE);
const imgRows = rows.filter((r) => ["跟随模型默认", "支持", "不支持"].includes(r.text));
const thinkRows = rows.filter((r) => ["跟随模型默认配置", "开启", "关闭"].includes(r.text));
// 高级配置区内还有「启用」「设为默认模型」两个复选框，共 8 项
check(
  "编辑卡片复选框/单选项数量正确（启用 + 设为默认 + 图片输入 3 + 思考模式 3 = 8）",
  rows.length === 8,
  `实际 ${rows.length} 项：${rows.map((r) => r.text).join(" / ")}`
);
check("「支持图片输入」三选项齐全", imgRows.length === 3, imgRows.map((r) => r.text).join(" / "));
check("「思考模式」三选项齐全", thinkRows.length === 3, thinkRows.map((r) => r.text).join(" / "));

for (const row of rows) {
  check(
    `选项「${row.text}」文字横向单行`,
    isHorizontalRow(row),
    `行数=${row.lineCount} 文本宽=${row.textWidth.toFixed(1)} 文本高=${row.textHeight.toFixed(1)} 容器宽=${row.boxWidth.toFixed(1)}`
  );
}

console.log("\n【场景 B】阴性对照：注入旧样式强制复现竖排，检测函数必须能识别");

await evaluate(`
  (() => {
    const s = document.createElement('style');
    s.id = 'e2e-regress-old-style';
    s.textContent = '.cfg-field input[type="radio"], .cfg-check input[type="radio"] { width: 100% !important; }' +
                    '.cfg-check { white-space: normal !important; }';
    document.head.appendChild(s);
  })()
`);
await new Promise((r) => setTimeout(r, 300));
const brokenRows = await evaluate(MEASURE);
const brokenDetected = brokenRows.filter((r) => !isHorizontalRow(r)).length;
check(
  "旧样式注入后检测函数判定为竖排/异常（证明断言有辨别力，不是恒绿）",
  brokenDetected >= 1,
  `${brokenDetected}/${brokenRows.length} 项被判异常；首项 ` +
    (brokenRows[0]
      ? `行数=${brokenRows[0].lineCount} 宽=${brokenRows[0].textWidth.toFixed(1)} 高=${brokenRows[0].textHeight.toFixed(1)}`
      : "无")
);
// 还原
await evaluate(`document.getElementById('e2e-regress-old-style')?.remove()`);
await new Promise((r) => setTimeout(r, 200));

console.log("\n【场景 C】「思考强度」下拉：存在性 / 六档 / 关闭思考时禁用");

const effortInfo = await evaluate(`
  (() => {
    const fields = [...document.querySelectorAll('.cfg-field')];
    const field = fields.find(f => f.querySelector('label')?.textContent.trim() === '思考强度');
    if (!field) return null;
    const sel = field.querySelector('select');
    if (!sel) return { hasSelect: false };
    return {
      hasSelect: true,
      values: [...sel.options].map(o => o.value),
      labels: [...sel.options].map(o => o.textContent.trim()),
      value: sel.value,
      disabled: sel.disabled,
      hint: field.querySelector('.cfg-field-hint')?.textContent.trim() ?? '',
    };
  })()
`);
check("存在「思考强度」配置项", effortInfo !== null && effortInfo.hasSelect === true);
if (effortInfo?.hasSelect) {
  const expect = ["default", "low", "medium", "high", "xhigh", "max"];
  check(
    "思考强度档位与 core ReasoningEffort 五档一致（含 default）",
    JSON.stringify(effortInfo.values) === JSON.stringify(expect),
    `实际 ${effortInfo.values.join(",")}`
  );
  check("默认档位为 default（跟随模型/引擎默认）", effortInfo.value === "default");
  check("思考模式未关闭时下拉可用", effortInfo.disabled === false);
}

// 切到「关闭」→ 下拉应禁用且给出说明
await evaluate(`
  (() => {
    const label = [...document.querySelectorAll('.cfg-check')].find(l => (l.textContent || '').trim() === '关闭');
    label.querySelector('input[type="radio"]').click();
  })()
`);
await new Promise((r) => setTimeout(r, 300));
const afterOff = await evaluate(`
  (() => {
    const field = [...document.querySelectorAll('.cfg-field')].find(f => f.querySelector('label')?.textContent.trim() === '思考强度');
    const sel = field?.querySelector('select');
    return { disabled: sel?.disabled ?? null, hint: field?.querySelector('.cfg-field-hint')?.textContent.trim() ?? '' };
  })()
`);
check("思考模式=关闭时「思考强度」下拉禁用", afterOff.disabled === true);
check(
  "关闭时给出「强度不生效」说明（不让用户配了以为生效）",
  afterOff.hint.includes("不生效"),
  afterOff.hint.slice(0, 40)
);

// 切回「开启」→ 恢复可用
await evaluate(`
  (() => {
    const label = [...document.querySelectorAll('.cfg-check')].find(l => (l.textContent || '').trim() === '开启');
    label.querySelector('input[type="radio"]').click();
  })()
`);
await new Promise((r) => setTimeout(r, 300));
const afterOn = await evaluate(`
  (() => {
    const field = [...document.querySelectorAll('.cfg-field')].find(f => f.querySelector('label')?.textContent.trim() === '思考强度');
    return field?.querySelector('select')?.disabled ?? null;
  })()
`);
check("思考模式=开启时下拉恢复可用", afterOn === false);

console.log("\n【场景 D】添加模型即落盘（不依赖再点「保存」）");

// 填模型名并应用（点「应用」）
const applied = await evaluate(`
  (() => {
    const nameInput = document.querySelector('.cfg-field input[type="text"]');
    if (!nameInput) return { ok: false, why: '未找到模型名称输入框' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(nameInput, 'E2E 模型');
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  })()
`);
check("可编辑模型名称", applied.ok === true, applied.why ?? "");

await new Promise((r) => setTimeout(r, 200));
// 编辑器内的确认按钮（.cfg-editor-actions 主按钮，文案「保存」）
const applyClicked = await evaluate(`
  (() => {
    const btn = document.querySelector('.cfg-editor-actions .cfg-btn:not(.cfg-btn-ghost)');
    if (!btn) return null;
    btn.click();
    return btn.textContent.trim() + (btn.disabled ? '(disabled)' : '');
  })()
`);
check("编辑器存在可用的确认按钮", applyClicked !== null && !applyClicked.includes("disabled"), `按钮：${applyClicked}`);

await new Promise((r) => setTimeout(r, 800));
const invokes = await evaluate(`window.__E2E_INVOKES__ || []`);
const saveCalls = invokes.filter((c) => c.cmd === "config_save");
check(
  "点「应用」后立即触发壳保存（config_save），无需再点 footer 保存",
  saveCalls.length >= 1,
  `config_save 调用 ${saveCalls.length} 次；全部调用：${invokes.map((c) => c.cmd).join(" → ")}`
);
if (saveCalls.length >= 1) {
  const payload = saveCalls[saveCalls.length - 1].args?.payload ?? {};
  check(
    "保存载荷包含刚添加的模型",
    Array.isArray(payload.models) && payload.models.some((m) => m.name === "E2E 模型"),
    `models=${JSON.stringify((payload.models || []).map((m) => m.name))}`
  );
}

// 截图存证前先切回编辑态（折叠的高级配置默认展开），让竖排/横排一眼可辨
await evaluate(`
  (() => {
    const edit = [...document.querySelectorAll('.cfg-card-actions button')].find(b => b.textContent.trim() === '编辑');
    if (edit) edit.click();
  })()
`);
await new Promise((r) => setTimeout(r, 500));
// 确保高级配置展开（编辑已含高级字段的模型时默认展开，兜底再点一次）
await evaluate(`
  (() => {
    const t = document.querySelector('.cfg-adv-toggle');
    if (t && t.getAttribute('aria-expanded') !== 'true') t.click();
  })()
`);
await new Promise((r) => setTimeout(r, 300));
// 滚动到「支持图片输入」附近，让两个单选行进入可视区
await evaluate(`
  (() => {
    const field = [...document.querySelectorAll('.cfg-field')]
      .find(f => f.querySelector('label')?.textContent.trim() === '支持图片输入');
    if (field) field.scrollIntoView({ block: 'start' });
  })()
`);
await new Promise((r) => setTimeout(r, 400));

// 截图存证（失败不致命：headless 截图在部分环境会因 GPU/rasterizer 限制崩溃）
await mkdir(OUT_DIR, { recursive: true });
const shotPath = path.join(OUT_DIR, `settings-drawer-${Date.now()}.png`);
try {
  const shot = await cdp("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(shotPath, Buffer.from(shot.data, "base64"));
  console.log(`\n==> [5/5] 截图已保存：${shotPath}`);
} catch (e) {
  console.log(`\n==> [5/5] 截图跳过（本环境 headless 截图不可用：${e.message.slice(0, 60)}）`);
}

// ---------- 收尾 ----------
ws.close();
chrome.kill("SIGKILL");
server.close();
await rm(userDataDir, { recursive: true, force: true }).catch(() => {});

console.log("\n========================================");
if (failures.length === 0) {
  console.log(`✅ 系统管理抽屉 E2E 全部通过（${pass} 项断言）`);
  process.exit(0);
}
console.log(`❌ 失败 ${failures.length} 项 / 通过 ${pass} 项：`);
for (const f of failures) console.log(`   - ${f}`);
process.exit(1);
