/**
 * Soul ↔ V2 记忆统一存储测试
 *
 * ## 覆盖
 *
 * - U1 V2 条目被 Soul 读到（标记 origin=v2，分类可解释）
 * - U2 `facts` JSON 展开成独立记忆（不是一坨 JSON）
 * - U3 Soul 写入落到 V2 文件，`/memory list` 同源可见；重复加载不翻倍
 * - U4 覆盖写保留 V2 原生条目（不吞并）
 * - U5 忘掉一条 V2 fact：真的从 JSON 里删掉，刷新不复活
 * - U6 旧版 `soul/memory.json` 迁移：导入 + 归档 + 幂等
 * - U7 项目条目与全局条目互不串味
 * - U8 凭证类从 V2 键名推断，渲染时遮蔽
 *
 * @module tests/super-agent-soul-unified-memory
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MemoryStore } from "../v2/memory/memory-store.js";
import { createSoulEngine, legacySoulMemoryPath, soulMemoryPath } from "../super-agent/soul-io.js";
import { renderSoulPrompt } from "../super-agent/soul/render.js";

/**
 * 造一个隔离的 home + project 目录
 *
 * @returns 根路径与两个子目录
 */
function makeRoots(): { root: string; home: string; project: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dcx-soul-unify-"));
  const home = path.join(root, "home");
  const project = path.join(root, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return { root, home, project };
}

/**
 * 写入一条 V2 facts（结构与 UserGlobalMemoryManager 一致）
 *
 * @param store V2 存储
 * @param facts 事实数组
 */
function addFacts(store: MemoryStore, facts: readonly { id: string; content: string; confidence: number }[]): void {
  store.add({
    type: "user_global",
    key: "facts",
    value: JSON.stringify(
      facts.map((fact) => ({
        id: fact.id,
        content: fact.content,
        confidence: fact.confidence,
        source: "chat",
        createdAt: "2026-11-01T00:00:00.000Z",
        lastAccessedAt: "2026-11-02T00:00:00.000Z",
        accessCount: 2,
      }))
    ),
    confidence: 0.8,
    source: "auto_extracted",
  });
}

// ============================================================================
// U1–U2 读：V2 → Soul
// ============================================================================

test("U1 V2 条目被 Soul 读到，标记 origin=v2 且分类可解释", () => {
  const { home, project } = makeRoots();
  const store = new MemoryStore(project, home);
  store.add({
    type: "user_global",
    key: "preferred_language",
    value: "TypeScript",
    confidence: 0.9,
    source: "user_explicit",
  });
  store.add({
    type: "project",
    key: "build_command",
    value: "npm run build",
    confidence: 0.85,
    source: "user_explicit",
  });

  const { soul } = createSoulEngine({ projectRoot: project, homeRoot: home });
  const global = soul.memories.find((memory) => memory.value === "TypeScript");
  const local = soul.memories.find((memory) => memory.value === "npm run build");

  assert.ok(global, "V2 全局条目应被读到");
  assert.equal(global.origin, "v2");
  assert.equal(global.key, "v2.user_global.preferred_language");
  assert.equal(local?.category, "command", "build_command 应归到常用命令");
  assert.equal(local?.origin, "v2");
});

test("U2 facts JSON 展开成独立记忆，不再是一坨 JSON", () => {
  const { home, project } = makeRoots();
  const store = new MemoryStore(project, home);
  addFacts(store, [
    { id: "f1", content: "生产环境部署在 47.100.1.2 的 docker 里", confidence: 0.8 },
    { id: "f2", content: "用户喜欢先看结论再看细节", confidence: 0.7 },
  ]);

  const { soul } = createSoulEngine({ projectRoot: project, homeRoot: home });
  const values = soul.memories.map((memory) => memory.value);
  assert.ok(values.includes("生产环境部署在 47.100.1.2 的 docker 里"));
  assert.ok(values.includes("用户喜欢先看结论再看细节"));
  assert.ok(
    soul.memories.every((memory) => !memory.value.startsWith("[")),
    "不应出现原始 JSON 文本"
  );

  const deploy = soul.memories.find((memory) => memory.id === "f1");
  assert.equal(deploy?.category, "deploy");
  assert.equal(deploy?.strength, 0.8, "事实置信度应映射成强度");
  assert.equal(deploy?.activationCount, 2);
});

// ============================================================================
// U3–U4 写：Soul → V2
// ============================================================================

test("U3 Soul 写入落 V2 文件，/memory 可见且重复加载不翻倍", () => {
  const { home, project } = makeRoots();
  const store = new MemoryStore(project, home);

  const { engine } = createSoulEngine({ projectRoot: project, homeRoot: home });
  engine.remember({ text: "主仓库用 pnpm，提交信息走 conventional commits" });

  const listed = store.list();
  const soulEntries = listed.entries.filter((entry) => entry.key.startsWith("soul."));
  assert.equal(soulEntries.length, 1, "Soul 条目应写入 V2 文件");
  assert.equal(soulEntries[0]!.type, "project", "有项目上下文时写项目作用域");
  assert.ok(soulEntries[0]!.tags?.includes("soul"));

  const reloaded = createSoulEngine({ projectRoot: project, homeRoot: home }).soul;
  assert.equal(reloaded.memories.filter((memory) => memory.origin !== "v2").length, 1, "二次加载不应翻倍");
  assert.equal(reloaded.memories[0]!.category, "convention", "分类应无损还原");
});

test("U4 覆盖写保留 V2 原生条目", () => {
  const { home, project } = makeRoots();
  const store = new MemoryStore(project, home);
  store.add({
    type: "user_global",
    key: "deploy_host",
    value: "10.0.0.8",
    confidence: 0.9,
    source: "user_explicit",
  });
  addFacts(store, [{ id: "f1", content: "发布走 GitHub Actions", confidence: 0.8 }]);

  const { engine } = createSoulEngine({ projectRoot: project, homeRoot: home });
  engine.remember({ text: "喜欢先看结论" });

  const keys = store.list().entries.map((entry) => entry.key);
  assert.ok(keys.includes("deploy_host"), "V2 原生条目不能被吞掉");
  assert.ok(keys.includes("facts"), "facts 结构必须原样保留");
  assert.ok(keys.some((key) => key.startsWith("soul.")));
});

// ============================================================================
// U5 删：忘掉一条 V2 fact
// ============================================================================

test("U5 忘掉一条 V2 fact：JSON 里真的少一条，刷新不复活", () => {
  const { home, project } = makeRoots();
  const store = new MemoryStore(project, home);
  addFacts(store, [
    { id: "f1", content: "部署在 47.100.1.2", confidence: 0.8 },
    { id: "f2", content: "喜欢先看结论", confidence: 0.7 },
  ]);

  const { engine, soul } = createSoulEngine({ projectRoot: project, homeRoot: home });
  const target = soul.memories.find((memory) => memory.id === "f1");
  assert.ok(target);
  assert.equal(engine.forget(target.id), true);

  const factsEntry = store.list().entries.find((entry) => entry.key === "facts");
  assert.ok(factsEntry);
  const remaining = JSON.parse(factsEntry.value) as { id: string }[];
  assert.deepEqual(
    remaining.map((fact) => fact.id),
    ["f2"]
  );

  const reloaded = createSoulEngine({ projectRoot: project, homeRoot: home }).soul;
  assert.ok(!reloaded.memories.some((memory) => memory.value.includes("47.100.1.2")), "刷新后不应复活");
});

// ============================================================================
// U6 迁移
// ============================================================================

test("U6 旧 soul/memory.json 迁移：导入 + 归档 + 幂等", () => {
  const { home, project } = makeRoots();
  const legacyPath = legacySoulMemoryPath("global", undefined, home);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(
    legacyPath,
    JSON.stringify({
      version: 1,
      scope: "global",
      lastUpdated: "2026-10-01T00:00:00.000Z",
      entries: [
        {
          id: "legacy-1",
          category: "deploy",
          key: "deploy.prod",
          title: "生产部署",
          value: "部署在 k8s 集群",
          sensitivity: "normal",
          strength: 0.9,
          activationCount: 0,
          source: "user_explicit",
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    }),
    "utf8"
  );

  const first = createSoulEngine({ projectRoot: project, homeRoot: home });
  assert.ok(
    first.soul.memories.some((memory) => memory.value === "部署在 k8s 集群"),
    "旧条目应进入统一存储"
  );
  assert.equal(fs.existsSync(legacyPath), false, "旧文件应改名归档");
  const archived = fs.readdirSync(path.dirname(legacyPath)).filter((name) => name.includes(".migrated-"));
  assert.equal(archived.length, 1);

  // 幂等：再建引擎不会重复导入（同一 category+key 去重）
  const second = createSoulEngine({ projectRoot: project, homeRoot: home });
  assert.equal(
    second.soul.memories.filter((memory) => memory.value === "部署在 k8s 集群").length,
    1,
    "重复创建引擎不应产生副本"
  );
  assert.equal(soulMemoryPath("global", undefined, home), path.join(home, ".deepcode", "memory", "global.json"));
});

// ============================================================================
// U7–U8 作用域与脱敏
// ============================================================================

test("U7 项目条目与全局条目互不串味", () => {
  const { home, project } = makeRoots();
  const store = new MemoryStore(project, home);
  store.add({ type: "user_global", key: "tone", value: "直接一点", confidence: 0.7, source: "user_explicit" });
  store.add({ type: "project", key: "port", value: "8190", confidence: 0.8, source: "user_explicit" });

  const globalOnly = createSoulEngine({ homeRoot: home }).soul;
  assert.ok(globalOnly.memories.some((memory) => memory.value === "直接一点"));
  assert.ok(!globalOnly.memories.some((memory) => memory.value === "8190"), "无项目上下文时不该看到项目记忆");
});

test("U8 V2 凭证条目推断为 secret，提示词只给占位", () => {
  const { home, project } = makeRoots();
  const store = new MemoryStore(project, home);
  store.add({
    type: "user_global",
    key: "db_password",
    value: "prod-Passw0rd-2026",
    confidence: 0.9,
    source: "user_explicit",
  });

  const { soul } = createSoulEngine({ projectRoot: project, homeRoot: home });
  const secret = soul.memories.find((memory) => memory.key.includes("db_password"));
  assert.equal(secret?.sensitivity, "secret");

  const prompt = renderSoulPrompt(soul);
  assert.ok(prompt.includes("已记录"), "凭证应渲染成「已记录」占位");
  assert.ok(!prompt.includes("prod-Passw0rd-2026"), "凭证明文不得进提示词");
});
