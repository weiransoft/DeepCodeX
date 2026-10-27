/**
 * 多工作空间与沉淀 API —— web 侧集成测试（ARCH-20261027 T04）。
 *
 * 双服务器实例分流（与 workspace-isolation.test.ts 同款纪律）：
 * - 主服务器：personalOnly=true + web.workspaces=[team（位于 uploadDir 内）]，
 *   沉淀建议器注入受控 stub（不经 LLM）；
 * - 共享服务器：personalOnly=false + web.workspaces=[proj（位于 allowRoots 内）]，
 *   回归「配置工作空间后新建会话必须命中空间集合」的收紧语义。
 *
 * 用例映射（架构 T04 验收①②③⑤）：
 * - CFG-1~6  web.workspaces 启动期 fail-fast 校验（parseWorkspaces 纯函数矩阵）
 * - RWS-1    resolveWebSettings 端到端解析（workspaces 归一产物 + 非法 fail-fast）
 * - WS-1~5   createChat 工作空间绑定（personal 区/空间/越权 403/未知 id 404）
 * - SH-1~3   共享模式空间集合收紧 + listChats 按空间过滤
 * - SED-1~5  沉淀建议闭环（SSE/拉取 → confirm 落盘 → dismiss 指纹回执）
 *
 * 测试纪律（用户硬性规则）：无 mock 框架——LLM 用 helpers 受控 ScriptedLLMClient；
 * 建议器注入受控 stub（analyze/dismiss 行为受控）；所有目录为 mkdtemp 真实磁盘；
 * 注册表经 registryBaseDir 注入；沉淀落盘用 scope=project（绝不触碰真实 ~/.deepcode）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SedimentationSuggestion, SedimentationSuggester } from "@vegamo/deepcode-core";
import { parseWorkspaces, resolveWebSettings } from "../src/config";
import { startWebServer, type RunningWebServer } from "../src/server";
import { userIdFromUsername } from "../src/user-identity";
import {
  createControlledOpenAIClientHandle,
  createResolvedSettings,
  extractAuthCookie,
  fetchJson,
  makeCtx,
  openSseStream,
  ScriptedLLMClient,
  sha256Hex,
} from "./helpers";

// ============================================================================
// 共享测试夹具：目录、双服务器、双用户 Cookie
// ============================================================================

/** 临时根目录（allowRoot / uploadDir / 工作空间均派生于此） */
let tmpRoot: string;
/** 注册表注入根（隔离真实 ~/.deepcode/web/chats） */
let registryDir: string;
/** 个人模式服务器 uploadDir 与团队空间根 */
let uploadDir: string;
let teamRoot: string;
/** 共享模式服务器的工作空间根（allowRoots 内子目录） */
let projectAlphaRoot: string;

/** 主服务器（个人模式 + team 工作空间 + 受控建议器）与其受控 LLM */
let personalServer: RunningWebServer;
let personalClient: ScriptedLLMClient;
/** 共享服务器（共享模式 + proj 工作空间）与其受控 LLM */
let sharedServer: RunningWebServer;
let sharedClient: ScriptedLLMClient;

/** 用户 A=admin / B=beta 的认证 Cookie 与隔离标识 */
let cookieA: string;
let cookieB: string;
let sharedCookieA: string;
/** 服务端 userId（个人区目录段 = userIdFromUsername 派生串，非用户名原文） */
const userIdA = userIdFromUsername("admin");
const userIdB = userIdFromUsername("beta");

/** 受控沉淀建议（stub 建议器固定产出；draft 为合法 kebab skill 草稿） */
const STUB_SUGGESTION: SedimentationSuggestion = {
  id: "sugg-ws-001",
  fingerprint: "fp-ws-001",
  draft: {
    kind: "skill",
    name: "release-checklist",
    description: "发布前检查清单",
    content: "# 发布检查\n- 跑全量测试\n- 确认版本号",
  },
  rationale: "对话中反复出现发布前检查步骤，可沉淀为可复用技能",
};

/** stub 建议器记录的 dismiss 指纹回执（断言「忽略后同指纹不再建议」回执链路） */
let dismissedFingerprints: string[];

/** 受控沉淀建议器（仅实现 analyze/dismiss，测试关注端点与落盘语义） */
function createStubSuggester(): SedimentationSuggester {
  return {
    analyze: async () => [{ ...STUB_SUGGESTION, draft: { ...STUB_SUGGESTION.draft } }],
    dismiss: (_sessionId: string, fingerprint: string) => {
      dismissedFingerprints.push(fingerprint);
    },
  } as unknown as SedimentationSuggester;
}

before(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-workspaces-"));
  registryDir = mkdtempSync(path.join(tmpdir(), "deepcode-web-workspaces-registry-"));
  uploadDir = path.join(tmpRoot, "uploads");
  // 团队空间：personalOnly 模式下必须是 uploadDir 的子目录（启动期校验规则）
  teamRoot = path.join(uploadDir, "workspaces", "team");
  mkdirSync(teamRoot, { recursive: true });
  // 共享模式工作空间：allowRoots（tmpRoot）内子目录
  projectAlphaRoot = path.join(tmpRoot, "projects", "alpha");
  mkdirSync(projectAlphaRoot, { recursive: true });
  dismissedFingerprints = [];

  // —— 主服务器：personalOnly=true + team 工作空间 + 受控沉淀建议器 ——
  const personalSettings = createResolvedSettings({
    allowRoots: [tmpRoot],
    uploadDir,
    personalOnly: true,
    engineHomeRoot: path.join(tmpRoot, "engine-home"),
    workspaces: [{ id: "team", name: "团队空间", root: teamRoot }],
    auth: {
      jwtSecret: "workspaces-personal-secret",
      sessionTtlSeconds: 3600,
      localUsers: [
        { username: "admin", passwordHash: sha256Hex("pass-a") },
        { username: "beta", passwordHash: sha256Hex("pass-b") },
      ],
    },
  });
  personalClient = new ScriptedLLMClient([
    { type: "text_delta", text: "ok" },
    { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  personalServer = await startWebServer(personalSettings, {
    createLLMClient: () => personalClient,
    createOpenAIClient: () => createControlledOpenAIClientHandle(),
    registryBaseDir: registryDir,
    sedimentationSuggester: createStubSuggester(),
  });

  // —— 共享服务器：personalOnly=false + proj 工作空间（未注入建议器，
  //     沉淀端点对空集合返回 200 空数组，不触发装配）——
  const sharedSettings = createResolvedSettings({
    allowRoots: [tmpRoot],
    uploadDir: path.join(tmpRoot, "uploads-shared"),
    personalOnly: false,
    engineHomeRoot: path.join(tmpRoot, "engine-home"),
    workspaces: [{ id: "proj", name: "项目空间", root: projectAlphaRoot }],
    auth: {
      jwtSecret: "workspaces-shared-secret",
      sessionTtlSeconds: 3600,
      localUsers: [{ username: "admin", passwordHash: sha256Hex("pass-a") }],
    },
  });
  sharedClient = new ScriptedLLMClient([
    { type: "text_delta", text: "ok" },
    { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  sharedServer = await startWebServer(sharedSettings, {
    createLLMClient: () => sharedClient,
    createOpenAIClient: () => createControlledOpenAIClientHandle(),
    registryBaseDir: registryDir,
  });

  // 真实登录取得 Cookie
  const loginA = await fetchJson(personalServer.port, "POST", "/api/auth/login", {
    username: "admin",
    password: "pass-a",
  });
  assert.equal(loginA.status, 200, "用户 A 登录（个人模式）前置条件失败");
  cookieA = extractAuthCookie(loginA.headers)!;
  const loginB = await fetchJson(personalServer.port, "POST", "/api/auth/login", {
    username: "beta",
    password: "pass-b",
  });
  assert.equal(loginB.status, 200, "用户 B 登录（个人模式）前置条件失败");
  cookieB = extractAuthCookie(loginB.headers)!;
  const loginSharedA = await fetchJson(sharedServer.port, "POST", "/api/auth/login", {
    username: "admin",
    password: "pass-a",
  });
  assert.equal(loginSharedA.status, 200, "用户 A 登录（共享模式）前置条件失败");
  sharedCookieA = extractAuthCookie(loginSharedA.headers)!;
});

after(async () => {
  await personalServer.close();
  await sharedServer.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

// ============================================================================
// CFG：web.workspaces 启动期 fail-fast 校验（parseWorkspaces 纯函数矩阵）
// ============================================================================

const CFG_BASE = { personalOnly: true, uploadDir: "/tmp/cfg-uploads", allowRoots: [] as string[] };

test("CFG-01：非数组 / 元素非对象一律抛错", () => {
  assert.throws(() => parseWorkspaces("nope", CFG_BASE), /必须是对象数组/);
  assert.throws(() => parseWorkspaces([null], CFG_BASE), /必须是对象/);
  assert.throws(() => parseWorkspaces(["x"], CFG_BASE), /必须是对象/);
});

test("CFG-02：id 必须唯一且 kebab-case", () => {
  assert.throws(
    () => parseWorkspaces([{ id: "Team", name: "n", root: "/tmp/cfg-uploads/team" }], CFG_BASE),
    /kebab-case/
  );
  assert.throws(
    () =>
      parseWorkspaces(
        [
          { id: "team", name: "n", root: "/tmp/cfg-uploads/a" },
          { id: "team", name: "m", root: "/tmp/cfg-uploads/b" },
        ],
        CFG_BASE
      ),
    /唯一/
  );
});

test("CFG-03：name / root 必须是非空字符串", () => {
  assert.throws(() => parseWorkspaces([{ id: "team", name: "", root: "/tmp/cfg-uploads/t" }], CFG_BASE), /name/);
  assert.throws(() => parseWorkspaces([{ id: "team", name: "n", root: "" }], CFG_BASE), /root/);
  assert.throws(() => parseWorkspaces([{ id: "team", name: "n" }], CFG_BASE), /root/);
});

test("CFG-04：root 不得等于 uploadDir 本身（个人区保护线）", () => {
  assert.throws(() => parseWorkspaces([{ id: "team", name: "n", root: "/tmp/cfg-uploads" }], CFG_BASE), /uploadDir/);
  assert.throws(
    () =>
      parseWorkspaces([{ id: "team", name: "n", root: "/tmp/cfg-uploads" }], {
        personalOnly: false,
        uploadDir: "/tmp/cfg-uploads",
        allowRoots: ["/tmp/cfg-uploads"],
      }),
    /uploadDir/
  );
});

test("CFG-05：personalOnly 模式 root 必须严格位于 uploadDir 内（含 ~ 展开校验）", () => {
  // 同级前缀目录（/tmp/cfg-uploads-other）不得误判为「位于内」
  assert.throws(
    () => parseWorkspaces([{ id: "team", name: "n", root: "/tmp/cfg-uploads-other/team" }], CFG_BASE),
    /必须位于 uploadDir/
  );
  // ~ 展开后落 uploadDir 外同样拒绝（展开语义回归）
  assert.throws(
    () => parseWorkspaces([{ id: "team", name: "n", root: "~/.deepcode/elsewhere" }], CFG_BASE),
    /必须位于 uploadDir/
  );
});

test("CFG-06：personalOnly 模式合法配置通过并归一（尾斜杠/相对段消解）", () => {
  const parsed = parseWorkspaces(
    [{ id: "team", name: "团队空间", root: "/tmp/cfg-uploads/./workspaces/team/" }],
    CFG_BASE
  );
  assert.deepEqual(parsed, [{ id: "team", name: "团队空间", root: path.resolve("/tmp/cfg-uploads/workspaces/team") }]);
});

test("CFG-07：共享模式 root 必须位于某个 allowRoots 内（相等或子目录）", () => {
  const sharedBase = { personalOnly: false, uploadDir: "/tmp/cfg-uploads", allowRoots: ["/data/projects"] };
  // allowRoot 本身合法
  assert.deepEqual(parseWorkspaces([{ id: "root-ws", name: "n", root: "/data/projects" }], sharedBase), [
    { id: "root-ws", name: "n", root: path.resolve("/data/projects") },
  ]);
  // allowRoot 子目录合法
  assert.deepEqual(parseWorkspaces([{ id: "sub-ws", name: "n", root: "/data/projects/alpha" }], sharedBase), [
    { id: "sub-ws", name: "n", root: path.resolve("/data/projects/alpha") },
  ]);
  // allowRoot 之外拒绝（同级前缀目录同样拒绝）
  assert.throws(
    () => parseWorkspaces([{ id: "bad", name: "n", root: "/data/projects-other" }], sharedBase),
    /allowRoots/
  );
  // allowRoots 为空时任何配置都拒绝
  assert.throws(
    () => parseWorkspaces([{ id: "bad", name: "n", root: "/data/projects" }], { ...sharedBase, allowRoots: [] }),
    /allowRoots/
  );
});

// ============================================================================
// RWS：resolveWebSettings 端到端解析（workspaces 归一产物 + 非法 fail-fast）
// ============================================================================

test("RWS-01：resolveWebSettings 归一 web.workspaces 且非法配置启动期抛错", () => {
  const projectDir = mkdtempSync(path.join(tmpdir(), "deepcode-web-workspaces-proj-"));
  const settingsDir = mkdtempSync(path.join(tmpdir(), "deepcode-web-workspaces-settings-"));
  const bootstrapDir = path.join(settingsDir, "bootstrap");
  const userSettingsPath = path.join(settingsDir, "settings.json");
  try {
    // 合法配置：workspaces 归一进产物
    writeFileSync(
      userSettingsPath,
      JSON.stringify({
        web: {
          enabled: true,
          auth: { jwtSecret: "rws-secret" },
          allowRoots: [projectDir],
          uploadDir: path.join(projectDir, "uploads"),
          personalOnly: false,
          workspaces: [{ id: "alpha", name: "项目空间", root: path.join(projectDir, "projects", "alpha") }],
        },
      }),
      "utf8"
    );
    const resolved = resolveWebSettings(projectDir, {}, { bootstrapDir, userSettingsPath });
    assert.equal(resolved.workspaces.length, 1);
    assert.equal(resolved.workspaces[0].id, "alpha");
    assert.equal(resolved.workspaces[0].root, path.resolve(path.join(projectDir, "projects", "alpha")));

    // 非法配置：root 越 allowRoots → 启动期抛错（fail-fast）
    writeFileSync(
      userSettingsPath,
      JSON.stringify({
        web: {
          enabled: true,
          auth: { jwtSecret: "rws-secret" },
          allowRoots: [projectDir],
          uploadDir: path.join(projectDir, "uploads"),
          personalOnly: false,
          workspaces: [{ id: "bad", name: "越界空间", root: "/definitely/outside" }],
        },
      }),
      "utf8"
    );
    assert.throws(() => resolveWebSettings(projectDir, {}, { bootstrapDir, userSettingsPath }), /allowRoots/);
  } finally {
    rmSync(settingsDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ============================================================================
// WS：createChat 工作空间绑定（personalOnly 模式）
// ============================================================================

test("WS-01：GET /api/workspaces 首项恒为本人个人区，其后为配置空间", async () => {
  const list = await fetchJson(personalServer.port, "GET", "/api/workspaces", undefined, cookieA);
  assert.equal(list.status, 200);
  const workspaces = list.body.workspaces as Array<Record<string, unknown>>;
  assert.equal(workspaces.length, 2, `应包含个人区 + team 空间（得到 ${JSON.stringify(workspaces)}）`);
  assert.equal(workspaces[0].id, "personal");
  assert.equal(workspaces[0].kind, "personal");
  assert.equal(workspaces[0].root, path.join(await realpath(uploadDir), userIdA), "个人区根必须按当前用户拼接");
  assert.equal(workspaces[1].id, "team");
  assert.equal(workspaces[1].kind, "workspace");
  assert.equal(workspaces[1].name, "团队空间");
});

test("WS-02：workspaceId 指定落点 → 会话落团队空间（projectRoot 忽略）", async () => {
  const created = await fetchJson(
    personalServer.port,
    "POST",
    "/api/chats",
    { workspaceId: "team", projectRoot: "/definitely/ignored" },
    cookieA
  );
  assert.equal(created.status, 200, `workspaceId 建会话应成功：${JSON.stringify(created.body)}`);
  assert.equal(created.body.projectRoot, await realpath(teamRoot), "会话必须落在团队空间根");
});

test("WS-03：显式 projectRoot 命中空间根（等价写法）应 200", async () => {
  const created = await fetchJson(personalServer.port, "POST", "/api/chats", { projectRoot: teamRoot + "/" }, cookieA);
  assert.equal(created.status, 200, `空间根等价写法应被接受：${JSON.stringify(created.body)}`);
});

test("WS-04：越权矩阵回归——allowRoot 其他目录 / 他人个人区一律 403", async () => {
  const allowRootAttempt = await fetchJson(
    personalServer.port,
    "POST",
    "/api/chats",
    { projectRoot: tmpRoot },
    cookieA
  );
  assert.equal(allowRootAttempt.status, 403, "个人模式下 allowRoots 其他目录仍必须 403");

  const otherPersonal = await fetchJson(
    personalServer.port,
    "POST",
    "/api/chats",
    { projectRoot: path.join(uploadDir, userIdB) },
    cookieA
  );
  assert.equal(otherPersonal.status, 403, "请求他人个人区必须 403");
});

test("WS-05：未知 workspaceId → 404；缺省（无 projectRoot/workspaceId）仍落个人区", async () => {
  const unknown = await fetchJson(personalServer.port, "POST", "/api/chats", { workspaceId: "nope" }, cookieA);
  assert.equal(unknown.status, 404, "未知工作空间 id 必须 404");

  const fallback = await fetchJson(personalServer.port, "POST", "/api/chats", {}, cookieA);
  assert.equal(fallback.status, 200, "缺省落点必须仍是个人区");
  assert.equal(fallback.body.projectRoot, path.join(await realpath(uploadDir), userIdA));
});

// ============================================================================
// SH：共享模式空间集合收紧 + listChats 按空间过滤
// ============================================================================

test("SH-01：共享模式 workspaceId 建会话 → 落 proj 空间", async () => {
  const created = await fetchJson(sharedServer.port, "POST", "/api/chats", { workspaceId: "proj" }, sharedCookieA);
  assert.equal(created.status, 200, `共享模式空间建会话应成功：${JSON.stringify(created.body)}`);
  assert.equal(created.body.projectRoot, await realpath(projectAlphaRoot));
});

test("SH-02：共享模式 allowRoots 内但非工作空间的新建会话必须 403", async () => {
  const rejected = await fetchJson(sharedServer.port, "POST", "/api/chats", { projectRoot: tmpRoot }, sharedCookieA);
  assert.equal(rejected.status, 403, "配置工作空间后，allowRoots 内非空间目录的新建会话必须 403");
  assert.match(rejected.body.error, /工作空间/);
});

test("SH-03：GET /api/chats?workspaceId= 按空间过滤；未知 id → 400", async () => {
  // 每个空间各建一条会话（teamRoot 会话在主服务器；这里共享服务器再建 alpha）
  const inWorkspace = await fetchJson(sharedServer.port, "POST", "/api/chats", { workspaceId: "proj" }, sharedCookieA);
  assert.equal(inWorkspace.status, 200);

  const filtered = await fetchJson(
    sharedServer.port,
    "GET",
    `/api/chats?workspaceId=${encodeURIComponent("proj")}`,
    undefined,
    sharedCookieA
  );
  assert.equal(filtered.status, 200);
  const chats = filtered.body.chats as Array<Record<string, unknown>>;
  assert.ok(chats.length >= 1, "空间过滤后必须至少含 alpha 会话");
  for (const chat of chats) {
    const chatRoot = String(chat.projectRoot);
    assert.ok(
      chatRoot === (await realpath(projectAlphaRoot)) ||
        chatRoot.startsWith((await realpath(projectAlphaRoot)) + path.sep),
      `列表条目必须位于 proj 空间内（得到 ${chatRoot}）`
    );
  }

  const unknown = await fetchJson(sharedServer.port, "GET", "/api/chats?workspaceId=bad", undefined, sharedCookieA);
  assert.equal(unknown.status, 400, "未知 workspaceId 过滤必须 400");
});

// ============================================================================
// SED：沉淀建议闭环（SSE 推送 / 拉取 / confirm 落盘 / dismiss 回执）
// ============================================================================

/** 跑一轮受控消息并等待 done（产出底层 sessionId 的最小轮次） */
async function runOneTurn(server: RunningWebServer, cookie: string, chatId: string): Promise<void> {
  const { collector, controller } = await openSseStream(server.port, chatId, cookie);
  const donePromise = collector.waitFor("done", 15000);
  const send = await fetchJson(server.port, "POST", `/api/chats/${chatId}/messages`, { text: "沉淀探测" }, cookie);
  assert.equal(send.status, 202);
  await donePromise;
  controller.abort();
}

test("SED-01：未分析前 GET suggestions 为空数组（200）", async () => {
  const created = await fetchJson(personalServer.port, "POST", "/api/chats", { workspaceId: "team" }, cookieA);
  assert.equal(created.status, 200);
  const chatId = created.body.chatId as string;
  const list = await fetchJson(
    personalServer.port,
    "GET",
    `/api/sedimentation/suggestions?chatId=${encodeURIComponent(chatId)}`,
    undefined,
    cookieA
  );
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.suggestions, []);
});

test("SED-02：分析产出建议 → SSE 推送 + GET 可拉取；他人会话不可见（404）", async () => {
  const created = await fetchJson(personalServer.port, "POST", "/api/chats", { workspaceId: "team" }, cookieA);
  assert.equal(created.status, 200);
  const chatId = created.body.chatId as string;
  await runOneTurn(personalServer, cookieA, chatId);

  // 订阅 SSE 后触发分析，验证 sedimentation_suggestion 推送
  const { collector, controller } = await openSseStream(personalServer.port, chatId, cookieA);
  const analyzed = await personalServer.pool.runSedimentationAnalysis(chatId, makeCtx("admin"));
  assert.equal(analyzed.length, 1, "受控建议器必须产出 1 条建议");
  const frame = await collector.waitFor("sedimentation_suggestion", 5000);
  assert.equal(frame.data.chatId, chatId);
  assert.equal((frame.data.suggestions as unknown[]).length, 1);
  controller.abort();

  // 拉取端点
  const list = await fetchJson(
    personalServer.port,
    "GET",
    `/api/sedimentation/suggestions?chatId=${encodeURIComponent(chatId)}`,
    undefined,
    cookieA
  );
  assert.equal(list.status, 200);
  const suggestions = list.body.suggestions as Array<Record<string, unknown>>;
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].id, STUB_SUGGESTION.id);

  // 隔离：beta 访问 admin 的会话建议 → 404
  const forbidden = await fetchJson(
    personalServer.port,
    "GET",
    `/api/sedimentation/suggestions?chatId=${encodeURIComponent(chatId)}`,
    undefined,
    cookieB
  );
  assert.equal(forbidden.status, 404, "他人会话的沉淀建议必须不可见");
});

test("SED-03：confirm scope=project 经安全门槛落盘会话空间并移出待处置集合", async () => {
  const created = await fetchJson(personalServer.port, "POST", "/api/chats", { workspaceId: "team" }, cookieA);
  assert.equal(created.status, 200);
  const chatId = created.body.chatId as string;
  await runOneTurn(personalServer, cookieA, chatId);
  await personalServer.pool.runSedimentationAnalysis(chatId, makeCtx("admin"));

  const confirmed = await fetchJson(
    personalServer.port,
    "POST",
    "/api/sedimentation/confirm",
    {
      chatId,
      suggestionId: STUB_SUGGESTION.id,
      scope: "project",
    },
    cookieA
  );
  assert.equal(confirmed.status, 200, `confirm 应 200：${JSON.stringify(confirmed.body)}`);
  assert.equal(confirmed.body.ok, true, `落盘必须成功：${JSON.stringify(confirmed.body)}`);
  assert.ok(String(confirmed.body.path).includes("release-checklist"), "落盘路径必须指向技能目录");

  // SKILL.md 真实落盘（scope=project → <会话 projectRoot>/.deepcode/skills/<name>/）
  const skillFile = path.join(await realpath(teamRoot), ".deepcode", "skills", "release-checklist", "SKILL.md");
  assert.ok(existsSync(skillFile), `SKILL.md 必须落盘（${skillFile}）`);
  const content = readFileSync(skillFile, "utf8");
  assert.match(content, /name: release-checklist/);
  assert.match(content, /发布前检查清单/);

  // 确认后移出待处置集合
  const list = await fetchJson(
    personalServer.port,
    "GET",
    `/api/sedimentation/suggestions?chatId=${encodeURIComponent(chatId)}`,
    undefined,
    cookieA
  );
  assert.deepEqual(list.body.suggestions, []);
});

test("SED-04：dismiss 移出建议并回执指纹（同指纹本会话不再建议）", async () => {
  const created = await fetchJson(personalServer.port, "POST", "/api/chats", { workspaceId: "team" }, cookieA);
  assert.equal(created.status, 200);
  const chatId = created.body.chatId as string;
  await runOneTurn(personalServer, cookieA, chatId);
  await personalServer.pool.runSedimentationAnalysis(chatId, makeCtx("admin"));

  const dismissed = await fetchJson(
    personalServer.port,
    "POST",
    "/api/sedimentation/dismiss",
    {
      chatId,
      suggestionId: STUB_SUGGESTION.id,
    },
    cookieA
  );
  assert.equal(dismissed.status, 204, `dismiss 必须 204（得到 ${dismissed.status}）`);
  assert.ok(dismissedFingerprints.includes(STUB_SUGGESTION.fingerprint), "dismiss 必须向建议器回执指纹");

  const list = await fetchJson(
    personalServer.port,
    "GET",
    `/api/sedimentation/suggestions?chatId=${encodeURIComponent(chatId)}`,
    undefined,
    cookieA
  );
  assert.deepEqual(list.body.suggestions, []);
});

test("SED-05：异常矩阵——未知建议 404 / 缺参 400 / scope 非法 400", async () => {
  const created = await fetchJson(personalServer.port, "POST", "/api/chats", { workspaceId: "team" }, cookieA);
  assert.equal(created.status, 200);
  const chatId = created.body.chatId as string;

  const unknownSuggestion = await fetchJson(
    personalServer.port,
    "POST",
    "/api/sedimentation/confirm",
    {
      chatId,
      suggestionId: "no-such-suggestion",
      scope: "project",
    },
    cookieA
  );
  assert.equal(unknownSuggestion.status, 404, "未知建议 confirm 必须 404");

  const missingArgs = await fetchJson(personalServer.port, "POST", "/api/sedimentation/dismiss", { chatId }, cookieA);
  assert.equal(missingArgs.status, 400, "缺 suggestionId 必须 400");

  const badScope = await fetchJson(
    personalServer.port,
    "POST",
    "/api/sedimentation/confirm",
    {
      chatId,
      suggestionId: STUB_SUGGESTION.id,
      scope: "workspace",
    },
    cookieA
  );
  assert.equal(badScope.status, 400, "scope 非法必须 400");
});
