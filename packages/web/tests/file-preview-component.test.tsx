/**
 * 文件预览功能测试（docs/dev/web-file-preview.md P1~P3）。
 *
 * 两层互补覆盖：
 * 1. isPreviewable 纯函数矩阵（预览入口判定：图片豁免 / 文本白名单 / 大小上限）；
 * 2. 个人区集成场景——真实 Web 服务器（personalOnly 模式）+ 真实磁盘文件 +
 *    真实 HTTP：preview 端点载荷逐字校验 → FilePreview 组件同源数据渲染
 *    （Markdown 走 A2UI 管线断言、代码走行号渲染断言、图片走 download 直链、
 *    二进制走 415 错误引导、truncated 截断提示数据可达）。
 *
 * 测试纪律（用户硬性规则）：无 mock 框架——LLM 用 helpers 真实受控实现；
 * 目录为 mkdtemp 真实磁盘；渲染用 react-dom/server 真实 SSR。
 * 组件的浏览器端异步加载分支（fetchPreview → setState → A2UI/pre 渲染）
 * 由构建期类型检查 + 本文件的数据层/解析层断言共同覆盖（项目 SSR 测试惯例，
 * 不引入 jsdom/happy-dom 新依赖）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// tsconfig 环境准备必须**先于** ../web/src 模块图求值：node ESM 会先求值
// 全部静态 import，而测试进程默认 cwd=packages/web，tsx 发现不到
// tests/tsconfig.json（jsx: react-jsx），会把被导入的 a2ui/renderer.tsx
// JSX 按经典转换编译成 React.createElement → 运行时 ReferenceError。
// 动态 import 保证加载顺序；run-tests.mjs 已注入 TSX_TSCONFIG_PATH 双保险。
await import("./setup-tsx-tsconfig.mjs");
const { parseMarkdownToA2ui } = await import("../web/src/a2ui/parser");
const { A2uiSurface } = await import("../web/src/a2ui/renderer");
import type { LLMStreamEvent } from "@vegamo/deepcode-core";
import { startWebServer, type RunningWebServer } from "../src/server";
import { userIdFromUsername } from "../src/user-identity";
import {
  createControlledOpenAIClientHandle,
  createResolvedSettings,
  extractAuthCookie,
  fetchJson,
  ScriptedLLMClient,
  sha256Hex,
} from "./helpers";

/** 预览入口判定（运行期解绑定：与渲染管线同一模块图，受 tsconfig 加载顺序约束） */
const { isPreviewable } = await import("../web/src/components/FilePreview");

// ============================================================================
// 第一层：isPreviewable 判定矩阵（纯函数，无 IO）
// ============================================================================

test("isPreviewable：图片扩展名一律可预览（不受文本上限约束）", () => {
  // 图片经 download 直链 <img> 渲染，不经 preview 端点，故不受 maxPreviewBytes 约束
  assert.equal(isPreviewable("photo.PNG", 999 * 1024 * 1024, 4096), true, "大写扩展名必须大小写不敏感");
  assert.equal(isPreviewable("diagram.svg", 10, 4096), true);
  assert.equal(isPreviewable("anim.gif", 10, 4096), true);
  assert.equal(isPreviewable("shot.webp", 10, 4096), true);
});

test("isPreviewable：文本白名单内且 ≤ 上限可预览；超限不可预览", () => {
  assert.equal(isPreviewable("README.md", 100, 4096), true);
  assert.equal(isPreviewable("notes.gitignore", 10, 4096), true, "点前缀配置文件必须在白名单内");
  assert.equal(isPreviewable("server.ts", 4096, 4096), true, "恰好等于上限必须可预览");
  assert.equal(isPreviewable("huge.log", 4097, 4096), false, "超过 1 字节即不提供预览入口");
  assert.equal(isPreviewable("notes.txt", 10, 4096), true);
  assert.equal(isPreviewable("config.yaml", 10, 4096), true);
});

test("isPreviewable：白名单外扩展名与无扩展名文件不可预览", () => {
  assert.equal(isPreviewable("archive.zip", 10, 4096), false);
  assert.equal(isPreviewable("model.onnx", 10, 4096), false);
  assert.equal(isPreviewable("data.parquet", 10, 4096), false);
  assert.equal(isPreviewable("Dockerfile", 10, 4096), false, "无扩展名文件不提供预览入口");
});

test("isPreviewable：maxPreviewBytes=0（配置未知）时文本宽松放行", () => {
  assert.equal(isPreviewable("any.ts", 100 * 1024 * 1024, 0), true);
});

// ============================================================================
// 第二层：个人区集成场景（真实服务器 + 真实磁盘 + 真实 HTTP + 真实 SSR）
// 服务器与夹具在各用例内独立构造（对齐 workspace-isolation T12 惯例）：
// 单用户 userId 跨用例复用，共享服务器会让个人牢笼缓存/个人区夹具相互污染。
// ============================================================================

/** 个人模式测试服务器的构造与清理句柄 */
interface Fixture {
  server: RunningWebServer;
  cookie: string;
  /** 用户 admin 的个人工作区根（realpath 归一，与 createChat 服务端拼接一致） */
  personalRoot: string;
  tmpRoot: string;
  registryDir: string;
}

/** 起一台 personalOnly 服务器并完成登录 + 个人区目录就绪 */
async function startPersonalFixture(previewLimit: number): Promise<Fixture> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-fp-int-"));
  const registryDir = mkdtempSync(path.join(tmpdir(), "deepcode-web-fp-reg-"));
  const settings = createResolvedSettings({
    allowRoots: [path.join(tmpRoot, "allow")],
    uploadDir: path.join(tmpRoot, "uploads"),
    personalOnly: true,
    engineHomeRoot: path.join(tmpRoot, "engine-home"),
    maxPreviewBytes: previewLimit,
    auth: {
      jwtSecret: "file-preview-integration-secret",
      sessionTtlSeconds: 3600,
      localUsers: [{ username: "admin", passwordHash: sha256Hex("pass-preview") }],
    },
  });
  const client = new ScriptedLLMClient(
    [
      { type: "text_delta", text: "ok" },
      { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
    ] satisfies LLMStreamEvent[],
    0
  );
  const server = await startWebServer(settings, {
    createLLMClient: () => client,
    createOpenAIClient: () => createControlledOpenAIClientHandle(),
    registryBaseDir: registryDir,
  });
  const login = await fetchJson(server.port, "POST", "/api/auth/login", {
    username: "admin",
    password: "pass-preview",
  });
  assert.equal(login.status, 200, "登录前置条件失败");
  const cookie = extractAuthCookie(login.headers)!;
  // 个人区目录在 createChat 时才由服务端尽力创建；测试直接写文件，先行 mkdir
  mkdirSync(path.join(tmpRoot, "uploads", userIdFromUsername("admin")), { recursive: true });
  // 与前端 FileDrawer 打开「我的文件」完全一致：以服务端列表载荷回传的归一
  // 路径作为后续所有文件请求的基准路径（Mac 临时目录 /var → /private/var
  // 符号链接形态差异由服务端统一归一，测试绝不自行猜测路径形态）
  const list = await fetchJson(server.port, "GET", "/api/files?scope=personal", undefined, cookie);
  assert.equal(list.status, 200, `个人区列表前置条件失败：${JSON.stringify(list.body)}`);
  const personalRoot: string = list.body.path;
  return { server, cookie, personalRoot, tmpRoot, registryDir };
}

/** 关闭并清理测试服务器夹具 */
async function stopFixture(fx: Fixture): Promise<void> {
  await fx.server.close();
  rmSync(fx.tmpRoot, { recursive: true, force: true });
  rmSync(fx.registryDir, { recursive: true, force: true });
}

/**
 * 个人区文件的 preview 请求（scope=personal）。
 * URL 用服务端响应载荷回传的真实路径（与 workspace-isolation WS-T6/T7 惯例一致）。
 */
function previewUrl(target: string): string {
  return `/api/files/preview?scope=personal&path=${encodeURIComponent(target)}`;
}

/** 个人区文件的 download 直链（同样使用载荷回传路径） */
function downloadUrl(target: string): string {
  return `/api/files/download?scope=personal&path=${encodeURIComponent(target)}`;
}

/** 个人区目录列表请求（返回服务端归一路径 + 条目，磁盘 → 服务端路径的桥） */
async function listPersonal(fx: Fixture, dir: string): Promise<{ path: string; names: string[] }> {
  const res = await fetchJson(
    fx.server.port,
    "GET",
    `/api/files?scope=personal&path=${encodeURIComponent(dir)}`,
    undefined,
    fx.cookie
  );
  assert.equal(res.status, 200, `个人区列目录前置条件失败：${JSON.stringify(res.body)}`);
  return { path: res.body.path, names: (res.body.entries as Array<{ name: string }>).map((e) => e.name) };
}

test("FP-INT-01：个人区 Markdown 文件 → preview 200 → A2UI 管线渲染标题/代码卡片", async () => {
  const fx = await startPersonalFixture(4096);
  try {
    const md =
      "# 部署说明\n\n先执行安装，再构建。\n\n```bash\nnpm run build\n```\n\n| 步骤 | 命令 |\n| --- | --- |\n| 安装 | npm i |\n";
    const mdPath = path.join(fx.personalRoot, "DEPLOY.md");
    writeFileSync(mdPath, md, "utf8");

    // ① preview 端点：磁盘内容 → JSON 载荷逐字一致
    const res = await fetchJson(fx.server.port, "GET", previewUrl(mdPath), undefined, fx.cookie);
    assert.equal(res.status, 200, `preview 必须 200（得到 ${res.status}：${JSON.stringify(res.body)}）`);
    assert.equal(res.body.text, md, "端点返回文本必须与磁盘逐字一致");
    assert.equal(res.body.name, "DEPLOY.md");
    assert.equal(res.body.truncated, false);
    assert.equal(res.body.size, Buffer.byteLength(md));

    // ② A2UI 管线（与对话消息/FilePreview 同一解析器）：标题/段落/代码/表格全渲染
    const messages = parseMarkdownToA2ui(res.body.text, "file-preview-1");
    const surfaceHtml = renderToString(
      createElement(A2uiSurface, { messages, className: "a2ui-surface file-preview-markdown" })
    );
    assert.ok(surfaceHtml.includes("部署说明"), "Markdown 标题必须渲染进 A2UI surface");
    assert.ok(surfaceHtml.includes("npm run build"), "围栏代码块内容必须渲染");
    assert.ok(surfaceHtml.includes("先执行安装，再构建。"), "段落文本必须渲染");
    assert.ok(surfaceHtml.includes("安装"), "表格单元格文本必须渲染");
  } finally {
    await stopFixture(fx);
  }
});

test("FP-INT-02：个人区代码文件 → preview 200 且 XSS 文本经 React/JSON 安全承载", async () => {
  const fx = await startPersonalFixture(4096);
  try {
    const code = 'const payload = "<img src=x onerror=alert(1)>";\nconsole.log(payload);\n// 中文注释 ✓\n';
    const codePath = path.join(fx.personalRoot, "sample.ts");
    writeFileSync(codePath, code, "utf8");

    const res = await fetchJson(fx.server.port, "GET", previewUrl(codePath), undefined, fx.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.text, code, "代码原文必须逐字可达（不做任何转义改写）");
    assert.equal(res.body.truncated, false);

    // 组件行号渲染的行拆分语义（与 FilePreview.codeLines 同一算法）：
    // 尾部换行不产生空尾行，行数 = 实际行数
    const text: string = res.body.text;
    const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
    assert.equal(lines.length, 3, "行号渲染行数必须与文件实际行数一致");
    assert.ok(lines[0].includes("<img"), "行内容为原始文本（React SSR 渲染时自动转义）");
    assert.ok(lines[2].includes("中文注释 ✓"), "UTF-8 多字节内容不得损坏");
  } finally {
    await stopFixture(fx);
  }
});

test("FP-INT-03：个人区图片文件 → download 直链可用（组件 <img> 分支数据源）", async () => {
  const fx = await startPersonalFixture(4096);
  try {
    // 1x1 PNG 真实字节
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    const pngPath = path.join(fx.personalRoot, "pic.png");
    writeFileSync(pngPath, png);

    const response = await fetch(
      `http://127.0.0.1:${fx.server.port}/api/files/download?scope=personal&path=${encodeURIComponent(pngPath)}`,
      { headers: { cookie: fx.cookie } }
    );
    // 断言前完整消费响应体：失败时也必须读完，否则 keep-alive 悬挂会拖慢 close
    const got = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, "download 直链必须 200（组件 <img src> 的数据源）");
    assert.match(String(response.headers.get("content-disposition") ?? ""), /attachment/, "必须附件语义");
    assert.equal(got.length, png.length, "直链字节必须与磁盘一致");
    // PNG 魔数校验（内容即图片数据本身）
    assert.equal(got.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "字节必须是合法 PNG 头");
  } finally {
    await stopFixture(fx);
  }
});

test("FP-INT-04：个人区二进制文件 → preview 415 携带可读原因（组件错误引导分支）", async () => {
  const fx = await startPersonalFixture(4096);
  try {
    const binPath = path.join(fx.personalRoot, "blob.bin");
    writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]), null);

    const res = await fetchJson(fx.server.port, "GET", previewUrl(binPath), undefined, fx.cookie);
    assert.equal(res.status, 415, "NUL 二进制必须 415");
    assert.match(String(res.body.error), /无法预览|二进制|不支持/, "415 必须携带可读原因供组件展示");
  } finally {
    await stopFixture(fx);
  }
});

test("FP-INT-05：超过 maxPreviewBytes → preview 413 引导下载（上限语义）", async () => {
  const fx = await startPersonalFixture(4096);
  try {
    // 后端契约（files-api.ts）：size > maxPreviewBytes → 413 引导下载；
    // 前端 isPreviewable 同上限预判（超限文件不提供预览入口），两侧语义一致。
    const big = "x".repeat(5000);
    const bigPath = path.join(fx.personalRoot, "big.txt");
    writeFileSync(bigPath, big, "utf8");

    const res = await fetchJson(fx.server.port, "GET", previewUrl(bigPath), undefined, fx.cookie);
    assert.equal(res.status, 413, "超限文件必须 413 引导下载");
    assert.match(String(res.body.error), /预览上限/, "413 必须携带可读上限说明");

    // 前端判定与端点上限一致：等大小可预览、超 1 字节不可预览（见纯函数矩阵）
    assert.equal(isPreviewable("big.txt", 5000, 4096), false);
    assert.equal(isPreviewable("big.txt", 4096, 4096), true);
  } finally {
    await stopFixture(fx);
  }
});

test("FP-INT-06：个人区 .deepcode 引擎区文件 preview 一律 403（隔离边界不旁路）", async () => {
  const fx = await startPersonalFixture(4096);
  try {
    const engineDir = path.join(fx.personalRoot, ".deepcode");
    mkdirSync(engineDir, { recursive: true });
    const secretFile = path.join(engineDir, "settings.json");
    writeFileSync(secretFile, '{"env":{"API_KEY":"sk-preview-secret"}}', "utf8");

    const res = await fetchJson(fx.server.port, "GET", previewUrl(secretFile), undefined, fx.cookie);
    assert.equal(res.status, 403, "引擎区文件预览必须 403");
    assert.ok(!JSON.stringify(res.body).includes("sk-preview-secret"), "错误响应绝不得泄露文件内容");
  } finally {
    await stopFixture(fx);
  }
});

test("FP-INT-07：会话创建后个人区文件可预览（端到端：会话 → 文件 → 预览闭环）", async () => {
  const fx = await startPersonalFixture(4096);
  try {
    // 真实创建个人区会话（会话工作区 = uploadDir/<userId>），验证
    // 「新会话 → 个人区文件 → 预览」全链路对同一用户可用
    const create = await fetchJson(fx.server.port, "POST", "/api/chats", {}, fx.cookie);
    assert.equal(create.status, 200, `会话创建前置条件失败：${JSON.stringify(create.body)}`);

    const report = "# 会话报告\n\n一切正常。\n";
    const reportPath = path.join(fx.personalRoot, "report.md");
    writeFileSync(reportPath, report, "utf8");

    const res = await fetchJson(fx.server.port, "GET", previewUrl(reportPath), undefined, fx.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.text, report);
    const surfaceHtml = renderToString(
      createElement(A2uiSurface, {
        messages: parseMarkdownToA2ui(res.body.text, "file-preview-report"),
        className: "a2ui-surface",
      })
    );
    assert.ok(surfaceHtml.includes("会话报告"), "会话产物 Markdown 必须可渲染");
  } finally {
    await stopFixture(fx);
  }
});
