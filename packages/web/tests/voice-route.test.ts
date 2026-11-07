/**
 * 形象/声音配置与语音端点的路由集成测试（真实 HTTP）
 *
 * 单测验证处理器，这里验证**接线**与**跨层契约**：
 *
 * - 配置端点是合并补丁语义（只改头像不能把语音配置清空）
 * - token 永不下发，只回 `hasToken`
 * - 坏 endpoint 在写入口就被规范化掉（否则后端代理成了协议转发器）
 * - sidecar 不在时语音端点回 503 且带可执行提示（不是 500）
 * - 头像静态资源真的能被服务出来（构建产物 + 路由 + MIME 三处都得对）
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startWebServer, type RunningWebServer } from "../src/server";
import { isVoiceCapablePlatform } from "@vegamo/deepcode-core";
import { createResolvedSettings, extractAuthCookie, fetchJson, sha256Hex } from "./helpers";

let server: RunningWebServer;
let tmpRoot: string;
let engineHomeRoot: string;
let cookie: string;

before(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-voice-"));
  engineHomeRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-voice-home-"));
  const settings = createResolvedSettings({
    allowRoots: [tmpRoot],
    personalOnly: true,
    engineHomeRoot,
    auth: {
      jwtSecret: "voice-route-test-secret",
      sessionTtlSeconds: 3600,
      localUsers: [{ username: "admin", passwordHash: sha256Hex("admin-pass-123"), displayName: "管理员" }],
    },
  });
  server = await startWebServer(settings);
  const login = await fetchJson(server.port, "POST", "/api/auth/login", {
    username: "admin",
    password: "admin-pass-123",
  });
  const authCookie = extractAuthCookie(login.headers);
  assert.ok(authCookie, "测试前置：登录应下发 Cookie");
  cookie = authCookie;
});

after(async () => {
  await server.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(engineHomeRoot, { recursive: true, force: true });
});

test("F1 未登录读配置 → 401", async () => {
  const { status } = await fetchJson(server.port, "GET", "/api/soul/config");
  assert.equal(status, 401, "头像与音色是个人资产，不能裸奔");
});

test("F2 首次读配置返回默认值：默认兔狲 + 语音默认值跟随平台 + 御姐预设", async () => {
  const { status, body } = await fetchJson(server.port, "GET", "/api/soul/config", undefined, cookie);
  assert.equal(status, 200);
  assert.equal(body.avatar.kind, "default", "默认必须是兔狲头像");
  // 默认值跟平台走：有本机 MLX 语音模型的平台默认开，其余默认关。
  // 断言用注入的同一份判断，避免测试依赖"跑测试的机器是 Mac 还是 Windows"。
  assert.equal(
    body.voice.enabled,
    isVoiceCapablePlatform(),
    "语音默认值必须跟随平台（没有本地语音模型的平台不能默认开）"
  );
  assert.equal(body.voice.engine, "qwen3-voicedesign", "默认引擎必须是实测能跑通的那个");
  assert.ok(typeof body.voice.voice === "string" && body.voice.voice.length > 0, "音色描述不能为空");
  assert.equal(body.voice.wakeEnabled, false, "唤醒是隐私选择，任何平台都默认关");
  assert.ok(typeof body.voice.wakeWord === "string" && body.voice.wakeWord.length > 0, "唤醒词必须有默认值");
  assert.ok(
    Array.isArray(body.presets) && body.presets.some((p: { id: string }) => p.id === "yujie"),
    "御姐预设必须下发"
  );
  assert.ok(typeof body.filePath === "string" && body.filePath.endsWith("config.json"), "配置文件位置必须可见");
});

test("F3 token 永不下发，只回 hasToken 布尔", async () => {
  const { body } = await fetchJson(server.port, "GET", "/api/soul/config", undefined, cookie);
  assert.equal(body.voice.token, undefined, "响应体里不得出现 token 字段");
  assert.equal(typeof body.voice.hasToken, "boolean", "以布尔形式告知是否已生成");
  assert.equal(body.voice.hasToken, true, "首次读取应自动生成 token 供 sidecar 比对");
});

test("F4 只改头像不影响语音配置（合并补丁语义）", async () => {
  // 先把语音打开并改语速
  const first = await fetchJson(
    server.port,
    "PUT",
    "/api/soul/config",
    { voice: { enabled: true, speed: 1.4, voice: "低沉女声" } },
    cookie
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.voice.enabled, true);
  assert.equal(first.body.voice.speed, 1.4);

  // 再只改头像
  const avatarDataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const second = await fetchJson(
    server.port,
    "PUT",
    "/api/soul/config",
    { avatar: { kind: "custom", dataUrl: avatarDataUrl } },
    cookie
  );
  assert.equal(second.status, 200);
  assert.equal(second.body.avatar.kind, "custom", "头像应更新");
  assert.equal(second.body.voice.enabled, true, "改头像不能把语音开关清掉");
  assert.equal(second.body.voice.speed, 1.4, "语速不能被冲回默认");
  assert.equal(second.body.voice.voice, "低沉女声");
});

test("F4b 只改语音的一个字段不冲掉同区块其它字段（字段级合并）", async () => {
  // 前置：设一组与默认值都不相同的语音配置，重置了才看得出来
  const base = await fetchJson(
    server.port,
    "PUT",
    "/api/soul/config",
    { voice: { enabled: true, engine: "kokoro", speed: 1.3, speakReplies: false, voice: "低沉女声" } },
    cookie
  );
  assert.equal(base.status, 200);
  assert.equal(base.body.voice.engine, "kokoro");

  // 只改朗读开关：曾经会把 engine 冲回 qwen3-voicedesign、speed 冲回 1
  const only = await fetchJson(server.port, "PUT", "/api/soul/config", { voice: { speakReplies: true } }, cookie);
  assert.equal(only.body.voice.speakReplies, true, "朗读开关应更新");
  assert.equal(only.body.voice.engine, "kokoro", "引擎不能被冲回默认");
  assert.equal(only.body.voice.speed, 1.3, "语速不能被冲回默认");
  assert.equal(only.body.voice.enabled, true, "语音开关不能被顺手翻掉");
  assert.equal(only.body.voice.voice, "低沉女声", "音色描述不能被冲掉");

  // 只切引擎：曾经会把 enabled 从 true 翻成 false
  const eng = await fetchJson(
    server.port,
    "PUT",
    "/api/soul/config",
    { voice: { engine: "qwen3-voicedesign" } },
    cookie
  );
  assert.equal(eng.body.voice.engine, "qwen3-voicedesign");
  assert.equal(eng.body.voice.enabled, true, "切引擎不能把语音关掉");
  assert.equal(eng.body.voice.speed, 1.3, "切引擎不能改语速");
});

test("F5 非法 endpoint 与非法头像在写入口被规范化", async () => {
  const { status, body } = await fetchJson(
    server.port,
    "PUT",
    "/api/soul/config",
    {
      voice: { endpoint: "https://evil.example.com" },
      avatar: { kind: "custom", dataUrl: "javascript:alert(1)" },
    },
    cookie
  );
  assert.equal(status, 200, "坏输入不该让保存失败（页面会因此改不了任何配置）");
  assert.equal(body.voice.endpoint, "http://127.0.0.1:8791", "非 http 协议必须回落默认");
  assert.equal(body.avatar.kind, "default", "非法头像回落兔狲");
});

test("F6 语音状态在 sidecar 不可达时仍返回 200 + 可执行提示", async () => {
  // 指向必然拒绝连接的端口，而不是假设「测试机上没跑 sidecar」：
  // 开发者本地开着 sidecar 时，原写法会假红——而这条测的是**不可达时的降级**，
  // 前提必须自己造出来（与 F9 同一手法）。
  await fetchJson(server.port, "PUT", "/api/soul/config", { voice: { endpoint: "http://127.0.0.1:1" } }, cookie);
  const { status, body } = await fetchJson(server.port, "GET", "/api/voice/status", undefined, cookie);
  assert.equal(status, 200, "状态查询本身是成功的，未就绪写在字段里");
  assert.equal(body.reachable, false, "测试环境没有 sidecar");
  assert.equal(body.asr.ready, false);
  assert.equal(body.tts.ready, false);
  assert.ok(typeof body.hint === "string" && body.hint.includes("setup.sh"), "提示里要给出能照着跑的命令");
  assert.ok(typeof body.configPath === "string" && body.configPath.length > 0);
});

test("F7 TTS 空文本 → 400（不是 503，先把参数问题说清楚）", async () => {
  const { status } = await fetchJson(server.port, "POST", "/api/voice/tts", { text: "   " }, cookie);
  assert.equal(status, 400);
});

test("F8 TTS 超长文本 → 400（单次合成只接受一句/一段）", async () => {
  const { status } = await fetchJson(server.port, "POST", "/api/voice/tts", { text: "啊".repeat(2001) }, cookie);
  assert.equal(status, 400);
});

test("F9 sidecar 不可达时 TTS → 503 且说明是依赖缺失", async () => {
  // 指向必然拒绝连接的端口，模拟「sidecar 没起」
  await fetchJson(server.port, "PUT", "/api/soul/config", { voice: { endpoint: "http://127.0.0.1:1" } }, cookie);
  const { status, body } = await fetchJson(server.port, "POST", "/api/voice/tts", { text: "你好" }, cookie);
  assert.equal(status, 503, "依赖没装是 503，不是 500——两者用户的反应完全不同");
  assert.ok(typeof body?.error === "string" && body.error.includes("语音服务不可用"));
  assert.ok(body.error.includes("setup.sh"), "错误信息必须带可执行命令");
});

test("F10 ASR 空音频 → 400", async () => {
  // 走原生 fetch 发原始字节（端点收的是二进制，不是 JSON）
  const response = await fetch(`http://127.0.0.1:${server.port}/api/voice/asr`, {
    method: "POST",
    headers: { "content-type": "audio/wav", cookie },
    body: new Uint8Array(0),
  });
  assert.equal(response.status, 400);
});

test("F11 默认头像静态资源可访问且 MIME 正确", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/manul-avatar.png`);
  assert.equal(response.status, 200, "构建产物里必须有 manul-avatar.png");
  assert.equal(response.headers.get("content-type"), "image/png");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.byteLength > 1000, "图片不能是空壳");
  // PNG magic：89 50 4E 47
  assert.equal(bytes[0], 0x89);
  assert.equal(bytes[1], 0x50);
  assert.equal(bytes[2], 0x4e);
  assert.equal(bytes[3], 0x47);
});

test("F12 客户端 abort 流式 TTS 后，网关立即断开上游（回归：sidecar 持锁排队、越聊越迟钝）", async () => {
  let resolveUpstreamClosed!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => {
    resolveUpstreamClosed = resolve;
  });
  /** 假 sidecar：响应头立刻回来，正文永远不结束，模拟合成进行中 */
  const sidecar = createServer((req, res) => {
    if (req.url !== "/tts/stream") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
    // 持续吐小块，确保网关已进入逐块转发循环（而不是还卡在等响应头）
    const feed = setInterval(() => {
      if (!res.destroyed) res.write(Buffer.from([0, 0, 0, 4, 0, 0, 0, 0]));
    }, 30);
    res.on("close", () => {
      clearInterval(feed);
      resolveUpstreamClosed();
    });
  });
  await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", resolve));
  const address = sidecar.address();
  const sidecarPort = typeof address === "object" && address !== null ? address.port : 0;
  assert.ok(sidecarPort > 0, "测试前置：假 sidecar 必须监听成功");

  try {
    // F9 把 endpoint 改成了 127.0.0.1:1，这里重新指向假 sidecar
    const put = await fetchJson(
      server.port,
      "PUT",
      "/api/soul/config",
      { voice: { endpoint: `http://127.0.0.1:${sidecarPort}` } },
      cookie
    );
    assert.equal(put.status, 200);

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.port}/api/voice/tts/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "测试流式取消" }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200, "流式响应头应立刻返回");
    const reader = response.body?.getReader();
    const first = await reader?.read();
    assert.equal(first?.done, false, "应至少收到一块，确认网关正在转发");
    controller.abort();

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        upstreamClosed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("客户端断开后 3s 内上游仍未释放")), 3000);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  } finally {
    sidecar.closeAllConnections();
    await new Promise<void>((resolve) => sidecar.close(() => resolve()));
  }
});
