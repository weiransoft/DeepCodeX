/**
 * 多用户隔离集成测试（docs/dev/web-isolation.md §5.2，AC1-AC7）。
 *
 * 全链路真实 HTTP：双用户（A=admin、B=beta）经真实登录端点取得 JWT Cookie，
 * 经 REST/SSE 端点交互，跨用户越权矩阵逐项断言。LLM 经 createLLMClient
 * 缝合点注入 ScriptedLLMClient（真实受控实现）；注册表经 registryBaseDir
 * 注入 mkdtemp 临时目录（真实磁盘 IO，不污染真实 home）。
 *
 * 验收标准映射：
 * - AC1/AC2：会话列表与操作隔离（404 防枚举）
 * - AC3：历史归属与恢复校验（注册表落盘断言 + 跨用户 sessionId 恢复 404）
 * - AC4：附件个人区落盘 + personal scope 越权 403
 * - AC5：shared scope 全用户一致
 * - AC6：特殊字符用户名不产生路径注入
 * - AC7：注册表损坏容错（列表不崩溃）
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startWebServer, type RunningWebServer } from "../src/server";
import { userIdFromUsername } from "../src/user-identity";
import {
  buildMultipartBody,
  createControlledOpenAIClientHandle,
  createResolvedSettings,
  extractAuthCookie,
  fetchJson,
  openSseStream,
  ScriptedLLMClient,
  sha256Hex,
} from "./helpers";

let server: RunningWebServer;
let tmpRoot: string;
let registryDir: string;
let cookieA: string;
let cookieB: string;
let client: ScriptedLLMClient;

/** 用户 A（admin）/ B（beta）的隔离标识 */
const userIdA = userIdFromUsername("admin");
const userIdB = userIdFromUsername("beta");

before(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-iso-"));
  registryDir = mkdtempSync(path.join(tmpdir(), "deepcode-web-iso-registry-"));
  const settings = createResolvedSettings({
    allowRoots: [tmpRoot],
    uploadDir: path.join(tmpRoot, "uploads"),
    auth: {
      jwtSecret: "isolation-test-secret",
      sessionTtlSeconds: 3600,
      localUsers: [
        { username: "admin", passwordHash: sha256Hex("pass-a") },
        { username: "beta", passwordHash: sha256Hex("pass-b") },
      ],
    },
  });
  client = new ScriptedLLMClient(
    [
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } },
    ],
    5
  );
  server = await startWebServer(settings, {
    createLLMClient: () => client,
    createOpenAIClient: () => createControlledOpenAIClientHandle(),
    registryBaseDir: registryDir,
  });

  // 真实登录流程：A、B 各自取得认证 Cookie
  const loginA = await fetchJson(server.port, "POST", "/api/auth/login", { username: "admin", password: "pass-a" });
  assert.equal(loginA.status, 200, "用户 A 登录前置条件失败");
  cookieA = extractAuthCookie(loginA.headers)!;
  const loginB = await fetchJson(server.port, "POST", "/api/auth/login", { username: "beta", password: "pass-b" });
  assert.equal(loginB.status, 200, "用户 B 登录前置条件失败");
  cookieB = extractAuthCookie(loginB.headers)!;
});

after(async () => {
  await server.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

/**
 * 用户 A 建会话的快捷方式（可带 sessionId 恢复）。
 *
 * @param cookie 认证 Cookie
 * @param sessionId 可选恢复的底层会话 id
 * @returns chatId
 */
async function createChatAs(cookie: string, sessionId?: string): Promise<string> {
  const created = await fetchJson(
    server.port,
    "POST",
    "/api/chats",
    sessionId !== undefined ? { projectRoot: tmpRoot, sessionId } : { projectRoot: tmpRoot },
    cookie
  );
  assert.equal(created.status, 200, `创建会话失败：${JSON.stringify(created.body)}`);
  return created.body.chatId as string;
}

test("isolation AC1：用户 A 建会话后，B 的列表不得包含该会话", async () => {
  await createChatAs(cookieA);
  const listB = await fetchJson(server.port, "GET", "/api/chats", undefined, cookieB);
  assert.equal(listB.status, 200);
  assert.equal(listB.body.chats.length, 0, `B 的会话列表必须为空（得到 ${JSON.stringify(listB.body.chats)}）`);

  // 对照组：A 自己可见
  const listA = await fetchJson(server.port, "GET", "/api/chats", undefined, cookieA);
  assert.equal(listA.status, 200);
  assert.equal(listA.body.chats.length, 1, "A 自己必须能看到自己的会话");
});

test("isolation AC2：B 对 A 的 chatId 的全部操作必须 404（messages GET/POST、stream、interrupt）", async () => {
  const chatId = await createChatAs(cookieA);

  const getMessages = await fetchJson(server.port, "GET", `/api/chats/${chatId}/messages`, undefined, cookieB);
  assert.equal(getMessages.status, 404, "B 读 A 的历史必须 404");

  const postMessage = await fetchJson(
    server.port,
    "POST",
    `/api/chats/${chatId}/messages`,
    { text: "越权发言" },
    cookieB
  );
  assert.equal(postMessage.status, 404, "B 向 A 的会话发消息必须 404");

  const interrupt = await fetchJson(server.port, "POST", `/api/chats/${chatId}/interrupt`, undefined, cookieB);
  assert.equal(interrupt.status, 404, "B 中断 A 的会话必须 404");

  // SSE 订阅（原始 fetch 检查订阅建立前的归属校验）
  const stream = await fetch(`http://127.0.0.1:${server.port}/api/chats/${chatId}/stream`, {
    headers: { cookie: cookieB },
  });
  assert.equal(stream.status, 404, "B 订阅 A 的会话事件流必须 404");
  await stream.text(); // 消费响应体避免连接悬挂

  // 防枚举（R5）：与「chatId 不存在」的 404 必须同码且同错误形态（文案含 chatId，
  // 逐字必然不同；关键是不区分「无权」与「不存在」两种语义——均为同一错误模板）
  const fakeId = "00000000-0000-4000-8000-000000000000";
  const fakeMessages = await fetchJson(server.port, "GET", `/api/chats/${fakeId}/messages`, undefined, cookieB);
  assert.equal(fakeMessages.status, 404);
  const template = /不存在或已关闭/;
  assert.match(getMessages.body.error, template, "无权访问必须复用「不存在」文案（防枚举）");
  assert.match(fakeMessages.body.error, template, "不存在的 chatId 走同一错误模板");
});

test("isolation AC3：轮次完成必须落盘用户注册表；跨用户 sessionId 恢复 404，归属者可恢复", async () => {
  const chatId = await createChatAs(cookieA);

  // A 发消息（ScriptedLLMClient 受控轮次），等 done 收尾
  const { collector, controller } = await openSseStream(server.port, chatId, cookieA);
  const donePromise = collector.waitFor("done", 15000);
  const send = await fetchJson(server.port, "POST", `/api/chats/${chatId}/messages`, { text: "归属测试" }, cookieA);
  assert.equal(send.status, 202);
  const done = await donePromise;
  controller.abort();
  const sessionId = done.data.sessionId as string;
  assert.ok(sessionId, "done 载荷必须携带底层 sessionId");

  // 注册表真实落盘断言：registryDir/<userIdA>.json 含该 sessionId 与标题
  // （persistChatRegistration 为异步回写，轮询等待落盘完成）
  const registryFile = path.join(registryDir, `${userIdA}.json`);
  let persisted: any = null;
  for (let i = 0; i < 300 && persisted === null; i++) {
    if (existsSync(registryFile)) {
      const parsed = JSON.parse(readFileSync(registryFile, "utf8"));
      const hit = parsed.chats?.find((item: any) => item.sessionId === sessionId);
      if (hit) {
        persisted = hit;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(persisted, "轮次完成后注册表必须落盘归属记录（docs/dev/web-isolation.md §3.3）");
  assert.equal(persisted.chatId, chatId);
  assert.ok(persisted.title === null || typeof persisted.title === "string", "title 为引擎 summary 或 null");

  // AC3 正向：A 自己可恢复
  const restoredA = await fetchJson(server.port, "POST", "/api/chats", { projectRoot: tmpRoot, sessionId }, cookieA);
  assert.equal(restoredA.status, 200, `归属者恢复必须成功：${JSON.stringify(restoredA.body)}`);

  // AC3 反向：B 用 A 的 sessionId 恢复必须 404
  const restoredB = await fetchJson(server.port, "POST", "/api/chats", { projectRoot: tmpRoot, sessionId }, cookieB);
  assert.equal(restoredB.status, 404, "B 用 A 的 sessionId 恢复必须 404");

  // AC1 补充：B 的历史列表不含 A 的注册表条目
  const listB = await fetchJson(server.port, "GET", "/api/chats", undefined, cookieB);
  assert.equal(listB.status, 200);
  const leaked = listB.body.chats.filter((chat: any) => chat.chatId === chatId || chat.sessionId === sessionId);
  assert.equal(leaked.length, 0, "B 的列表（含历史）不得泄露 A 的会话");
});

test("isolation AC4：聊天附件落个人区；B 的 personal 区不含 A 的文件且越权访问 403", async () => {
  // A 经 personal scope 上传一个文件（真实 multipart 落个人区）
  const personalRootA = path.join(tmpRoot, "uploads", userIdA);
  const secretBytes = Buffer.from("A 的私有笔记内容", "utf8");
  const uploadBody = buildMultipartBody("isoUpBOUNDARY", [
    { name: "file", filename: "a-private.txt", contentType: "text/plain", data: secretBytes },
  ]);
  const upload = await fetch(
    `http://127.0.0.1:${server.port}/api/files/upload?path=${encodeURIComponent(personalRootA)}&scope=personal`,
    {
      method: "POST",
      headers: { cookie: cookieA, "content-type": 'multipart/form-data; boundary="isoUpBOUNDARY"' },
      body: new Uint8Array(uploadBody),
    }
  );
  const uploadResultA = await upload.json();
  assert.equal(upload.status, 200, `A 的 personal 上传应成功：${JSON.stringify(uploadResultA)}`);

  // 真实落盘断言：文件在 uploadDir/<userIdA>/ 下（保存名带 UUID 前缀），且不在共享根
  // （savedPath 为 realpath 归一后的绝对路径，macOS /var → /private/var 需消解后比较）
  assert.ok(Array.isArray(uploadResultA.files) && uploadResultA.files.length === 1, "上传响应必须返回保存文件清单");
  const uploadedPath: string = uploadResultA.files[0].savedPath;
  const realPersonalRootA = await realpath(personalRootA);
  assert.ok(uploadedPath.startsWith(realPersonalRootA + path.sep), `附件必须落在 A 的个人区（得到 ${uploadedPath}）`);
  assert.ok(existsSync(uploadedPath), "附件必须真实落盘");
  assert.equal(readdirSync(path.join(tmpRoot, "uploads")).filter((name) => name === "a-private.txt").length, 0);

  // B 的 personal 列表：先让 B 上传自己的文件（触发个人区就绪），再断言互不可见
  const personalRootB = path.join(tmpRoot, "uploads", userIdB);
  const bBody = buildMultipartBody("isoUpBBOUNDARY", [
    { name: "file", filename: "b-file.txt", contentType: "text/plain", data: Buffer.from("B 的文件") },
  ]);
  const uploadB = await fetch(
    `http://127.0.0.1:${server.port}/api/files/upload?path=${encodeURIComponent(personalRootB)}&scope=personal`,
    {
      method: "POST",
      headers: { cookie: cookieB, "content-type": 'multipart/form-data; boundary="isoUpBBOUNDARY"' },
      body: new Uint8Array(bBody),
    }
  );
  assert.equal(uploadB.status, 200, "B 的 personal 上传应成功");

  const listB = await fetchJson(
    server.port,
    "GET",
    `/api/files?path=${encodeURIComponent(personalRootB)}&scope=personal`,
    undefined,
    cookieB
  );
  assert.equal(listB.status, 200);
  const namesB = (listB.body.entries ?? listB.body.files ?? []).map((item: any) => item.name ?? item);
  assert.ok(
    namesB.some((name: string) => name.endsWith("b-file.txt")),
    "B 必须能看到自己的个人文件"
  );
  assert.ok(!namesB.some((name: string) => name.endsWith("a-private.txt")), "B 的个人区不得出现 A 的文件");

  // B 以 personal scope 下载 A 的附件绝对路径 → 个人牢笼越界 403
  const downloadB = await fetch(
    `http://127.0.0.1:${server.port}/api/files/download?path=${encodeURIComponent(uploadedPath)}&scope=personal`,
    { headers: { cookie: cookieB } }
  );
  assert.equal(downloadB.status, 403, "B 越权下载 A 的个人文件必须 403");
  await downloadB.text();

  // 对照组：A 自己经 personal scope 可下载
  const downloadA = await fetch(
    `http://127.0.0.1:${server.port}/api/files/download?path=${encodeURIComponent(uploadedPath)}&scope=personal`,
    { headers: { cookie: cookieA } }
  );
  assert.equal(downloadA.status, 200, "A 本人必须能下载自己的个人文件");
  const downloaded = Buffer.from(await downloadA.arrayBuffer());
  assert.ok(downloaded.equals(secretBytes), "下载字节必须与上传一致");
});

test("isolation AC5：shared scope 浏览行为对所有用户一致", async () => {
  // 在共享区放一个文件
  mkdirSync(path.join(tmpRoot, "shared"), { recursive: true });
  writeFileSync(path.join(tmpRoot, "shared", "common.txt"), "共享资料", "utf8");

  const listA = await fetchJson(
    server.port,
    "GET",
    `/api/files?path=${encodeURIComponent(path.join(tmpRoot, "shared"))}`,
    undefined,
    cookieA
  );
  const listB = await fetchJson(
    server.port,
    "GET",
    `/api/files?path=${encodeURIComponent(path.join(tmpRoot, "shared"))}`,
    undefined,
    cookieB
  );
  assert.equal(listA.status, 200);
  assert.equal(listB.status, 200, "shared scope 对所有用户可用（R4）");
  const namesA = (listA.body.entries ?? listA.body.files ?? []).map((item: any) => item.name ?? item);
  const namesB = (listB.body.entries ?? listB.body.files ?? []).map((item: any) => item.name ?? item);
  assert.deepEqual(namesB, namesA, "A/B 的 shared 浏览结果必须一致");
  assert.ok(namesA.includes("common.txt"), "共享文件双方可见");
});

test("isolation AC6：特殊字符用户名登录后个人目录名为定长 hex（无路径注入）", async () => {
  // 独立服务器实例：注册恶意形态用户名
  const weirdName = "a/b?..\\";
  const weirdServer = await startWebServer(
    createResolvedSettings({
      allowRoots: [tmpRoot],
      uploadDir: path.join(tmpRoot, "uploads-weird"),
      auth: {
        jwtSecret: "weird-name-secret",
        sessionTtlSeconds: 3600,
        localUsers: [{ username: weirdName, passwordHash: sha256Hex("weird-pass") }],
      },
    }),
    { registryBaseDir: registryDir }
  );
  try {
    const login = await fetchJson(weirdServer.port, "POST", "/api/auth/login", {
      username: weirdName,
      password: "weird-pass",
    });
    assert.equal(login.status, 200, "特殊字符用户名应可正常登录");
    const weirdCookie = extractAuthCookie(login.headers)!;

    // 经 personal scope 上传触发个人区创建
    const weirdUserId = userIdFromUsername(weirdName);
    const body = buildMultipartBody("weirdBOUNDARY", [
      { name: "file", filename: "w.txt", contentType: "text/plain", data: Buffer.from("weird") },
    ]);
    const upload = await fetch(
      `http://127.0.0.1:${weirdServer.port}/api/files/upload?path=${encodeURIComponent(
        path.join(tmpRoot, "uploads-weird", weirdUserId)
      )}&scope=personal`,
      {
        method: "POST",
        headers: { cookie: weirdCookie, "content-type": 'multipart/form-data; boundary="weirdBOUNDARY"' },
        body: new Uint8Array(body),
      }
    );
    assert.equal(upload.status, 200, "特殊字符用户的 personal 上传应成功");

    // 真实目录断言：uploadDir 下只存在定长 hex 目录，无注入出的子路径
    const uploadRootEntries = readdirSync(path.join(tmpRoot, "uploads-weird"));
    assert.deepEqual(uploadRootEntries, [weirdUserId], `个人目录必须恰为 userId hex 目录（得到 ${uploadRootEntries}）`);
    assert.match(weirdUserId, /^[0-9a-f]{16}$/);
  } finally {
    await weirdServer.close();
  }
});

test("isolation AC4 强制防护：重叠配置下 shared scope 触达个人区必须 403（架构师审查 P1-1 修复）", async () => {
  // 主服务器即重叠配置（allowRoots=[tmpRoot] 包含 uploadDir=tmpRoot/uploads）。
  // shared scope 请求 uploadDir 下任何路径（含他人/本人个人区与 uploadDir 根）
  // 一律 403，隔离不依赖部署配置；personal scope 不受影响。
  const uploadDirRoot = path.join(tmpRoot, "uploads");

  // shared 浏览 uploadDir 根 → 403
  const listRoot = await fetchJson(
    server.port,
    "GET",
    `/api/files?path=${encodeURIComponent(uploadDirRoot)}`,
    undefined,
    cookieA
  );
  assert.equal(listRoot.status, 403, "shared 浏览 uploadDir 根必须 403");
  assert.match(listRoot.body.error, /服务私有目录/);

  // shared 浏览他人个人区子目录 → 403
  const listOther = await fetchJson(
    server.port,
    "GET",
    `/api/files?path=${encodeURIComponent(path.join(uploadDirRoot, userIdB))}`,
    undefined,
    cookieA
  );
  assert.equal(listOther.status, 403, "shared 浏览他人个人区必须 403");

  // shared 上传到 uploadDir 子路径 → 403
  const uploadBody = buildMultipartBody("protBOUNDARY", [
    { name: "file", filename: "x.txt", contentType: "text/plain", data: Buffer.from("x") },
  ]);
  const uploadShared = await fetch(
    `http://127.0.0.1:${server.port}/api/files/upload?path=${encodeURIComponent(path.join(uploadDirRoot, userIdB))}`,
    {
      method: "POST",
      headers: { cookie: cookieA, "content-type": 'multipart/form-data; boundary="protBOUNDARY"' },
      body: new Uint8Array(uploadBody),
    }
  );
  assert.equal(uploadShared.status, 403, "shared 上传到个人区必须 403");
  await uploadShared.text();

  // shared 下载他人个人区文件 → 403（AC4 已落盘的 A 的附件）
  const personalRootA = await realpath(path.join(uploadDirRoot, userIdA));
  const secretPath = path.join(personalRootA, "a-private.txt");
  const downloadShared = await fetch(
    `http://127.0.0.1:${server.port}/api/files/download?path=${encodeURIComponent(secretPath)}`,
    { headers: { cookie: cookieB } }
  );
  assert.equal(downloadShared.status, 403, "shared 下载他人个人区文件必须 403");
  await downloadShared.text();

  // 对照组：personal scope 不受保护线影响（AC4 中 A 本人下载已验证 200，此处确认 A 仍可浏览）
  const listPersonal = await fetchJson(
    server.port,
    "GET",
    `/api/files?path=${encodeURIComponent(personalRootA)}&scope=personal`,
    undefined,
    cookieA
  );
  assert.equal(listPersonal.status, 200, "personal scope 访问本人个人区不受保护线影响");

  // 对照组：shared 浏览 allowRoots 内的非 uploadDir 路径不受影响（R4）
  const listShared = await fetchJson(
    server.port,
    "GET",
    `/api/files?path=${encodeURIComponent(tmpRoot)}`,
    undefined,
    cookieA
  );
  assert.equal(listShared.status, 200, "shared 浏览 allowRoots 非个人区路径不受影响");
});

test("isolation AC4：files 端点 scope 非法值必须 400", async () => {
  const list = await fetchJson(
    server.port,
    "GET",
    `/api/files?path=${encodeURIComponent(tmpRoot)}&scope=bogus`,
    undefined,
    cookieA
  );
  assert.equal(list.status, 400, "scope 非法值必须 400 拒绝");
  assert.match(list.body.error, /scope 参数非法/);
});

test("isolation AC4 补充：正确配置（uploadDir 不在 allowRoots 内）时 shared scope 无法触达个人区", async () => {
  // 架构师审查 P1-1 反向验证：主服务器的测试配置恰好重叠（allowRoots=[tmpRoot] 包含
  // uploadDir），该配置下 shared 浏览本就可触达 uploadDir（已由启动告警提示）。
  // 本用例验证部署方按约束配置（两者分离）时，shared 牢笼天然拒绝个人区路径。
  // allowRoots 根必须真实存在（buildJailRoots 在启动时跳过不可用根）
  mkdirSync(path.join(tmpRoot, "shared-area"), { recursive: true });
  const safeServer = await startWebServer(
    createResolvedSettings({
      allowRoots: [path.join(tmpRoot, "shared-area")],
      // uploadDir 在 allowRoots 之外（安全配置）
      uploadDir: path.join(tmpRoot, "uploads-safe"),
      auth: {
        jwtSecret: "safe-config-secret",
        sessionTtlSeconds: 3600,
        localUsers: [
          { username: "admin", passwordHash: sha256Hex("pass-a") },
          { username: "beta", passwordHash: sha256Hex("pass-b") },
        ],
      },
    }),
    { registryBaseDir: registryDir }
  );
  try {
    const loginA = await fetchJson(safeServer.port, "POST", "/api/auth/login", {
      username: "admin",
      password: "pass-a",
    });
    const safeCookieA = extractAuthCookie(loginA.headers)!;

    // 先让 A 在个人区真实落一个文件
    mkdirSync(path.join(tmpRoot, "uploads-safe", userIdA), { recursive: true });
    const secretFile = path.join(tmpRoot, "uploads-safe", userIdA, "secret.txt");
    writeFileSync(secretFile, "个人隐私", "utf8");

    // shared scope：浏览 allowRoots 本身成功（R4 不受影响）…
    const sharedList = await fetchJson(
      safeServer.port,
      "GET",
      `/api/files?path=${encodeURIComponent(path.join(tmpRoot, "shared-area"))}`,
      undefined,
      safeCookieA
    );
    assert.equal(sharedList.status, 200, "shared scope 浏览 allowRoots 本身必须可用");

    // …但以 shared scope 访问个人区路径 → 牢笼越界 403（隔离成立）
    const leakList = await fetchJson(
      safeServer.port,
      "GET",
      `/api/files?path=${encodeURIComponent(path.join(tmpRoot, "uploads-safe", userIdA))}`,
      undefined,
      safeCookieA
    );
    assert.equal(leakList.status, 403, "shared scope 不得触达 allowRoots 外的个人区");

    const leakDownload = await fetch(
      `http://127.0.0.1:${safeServer.port}/api/files/download?path=${encodeURIComponent(secretFile)}`,
      { headers: { cookie: safeCookieA } }
    );
    assert.equal(leakDownload.status, 403, "shared scope（默认）下载个人区文件必须 403");
    await leakDownload.text();

    // personal scope 同路径：A 本人可正常访问
    const personalList = await fetchJson(
      safeServer.port,
      "GET",
      `/api/files?path=${encodeURIComponent(path.join(tmpRoot, "uploads-safe", userIdA))}&scope=personal`,
      undefined,
      safeCookieA
    );
    assert.equal(personalList.status, 200, "personal scope 访问本人个人区必须可用");
  } finally {
    await safeServer.close();
  }
});

test("isolation AC7：注册表文件损坏时列表必须 200（容错不崩溃）", async () => {
  // 手工写坏 A 的注册表（真实磁盘损坏形态）
  writeFileSync(path.join(registryDir, `${userIdA}.json`), "{{{corrupted", "utf8");

  const list = await fetchJson(server.port, "GET", "/api/chats", undefined, cookieA);
  assert.equal(list.status, 200, "注册表损坏时列表端点必须容错返回 200");
  assert.ok(Array.isArray(list.body.chats), "响应体必须仍是合法列表结构");
  // 池内活跃会话仍在（活跃不依赖注册表），损坏的只是历史来源
  const listB = await fetchJson(server.port, "GET", "/api/chats", undefined, cookieB);
  assert.equal(listB.status, 200, "其他用户的列表不受影响");
});
