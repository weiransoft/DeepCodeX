/**
 * Soul 记忆存储适配层 —— 把 V2 `MemoryStore` 包成 `SoulMemoryStore`
 *
 * ## 为什么单独一层
 *
 * 映射（`MemoryEntry` ↔ `SoulMemory`）是纯函数，放在内核
 * `soul/unified-memory.ts`；这里只负责**读写与迁移**，因此需要 `node:fs`
 * 与 `v2/MemoryStore`。`soul/` 属内核目录，按 `eslint.config.mjs` 的门禁
 * 不得直接触碰这两者——所以 I/O 落在本文件（与 `soul-io.ts` 并列，
 * 同属适配层，不受内核门禁约束）。
 *
 * ## 写为什么只覆盖「Soul 切片」
 *
 * V2 文件里既有 Soul 条目，也有其它模块写的条目（`/memory add`、7 维度、
 * `facts`、`experience`）。直接整文件覆盖会把这些数据抹掉，所以写入前
 * 先读出全部条目，剔除 Soul 切片后原样拼回——V2 原生条目的内容与顺序都不动。
 *
 * ## 「忘掉」为什么要特别处理 `facts`
 *
 * `facts` 是**一条**条目装着最多 100 条事实的 JSON。展开后每条事实有自己
 * 的 id，但 V2 的 `delete(id)` 只认条目 id，不认 JSON 里的 id。
 * 不在这里回写 JSON 摘掉单条，「忘掉」就只是把界面上的字删了，刷新又回来。
 *
 * @module super-agent/soul-memory-store
 */

import * as fs from "node:fs";
// 纯类型导入：本文件只调用传入的 MemoryStore 实例，不构造它——
// 构造在 `soul-io.ts`，这样 v2 的依赖树不会被拉进本模块的链接期
import type { MemoryStore } from "../v2/memory/memory-store.js";
import { emptyMemoryFile, normalizeMemoryFile } from "./soul/recall.js";
import {
  isSoulEntry,
  memoryEntryToSoul,
  parseFacts,
  soulEntryToMemoryEntry,
  typeForScope,
} from "./soul/unified-memory.js";
import type { SoulMemory, SoulMemoryFile, SoulMemoryStore } from "./soul/types.js";

/**
 * 基于 V2 `MemoryStore` 的 Soul 记忆存储
 *
 * 读：V2 文件里的全部条目（本类型）映射成 Soul 记忆；
 * 写：只覆盖「Soul 切片」——V2 原生条目原样保留，位置不变。
 */
export class UnifiedSoulStore implements SoulMemoryStore {
  /** V2 存储（每次读写都走文件，内部无缓存） */
  private readonly store: MemoryStore;
  /** 作用域 */
  private readonly scope: SoulMemoryFile["scope"];

  /**
   * @param store V2 存储
   * @param scope 作用域
   */
  constructor(store: MemoryStore, scope: SoulMemoryFile["scope"]) {
    this.store = store;
    this.scope = scope;
  }

  /**
   * 读取（V2 条目只读映射，Soul 条目无损还原）
   *
   * @returns 记忆文件
   */
  load(): SoulMemoryFile {
    const type = typeForScope(this.scope);
    let entries: SoulMemory[] = [];
    try {
      const listed = this.store.list(type);
      entries = listed.entries.flatMap((entry) => memoryEntryToSoul(entry));
    } catch {
      // 读失败按空处理：记忆是增强项，不该让对话与页面挂掉
      return emptyMemoryFile(this.scope);
    }
    return { version: 1, scope: this.scope, entries, lastUpdated: new Date().toISOString() };
  }

  /**
   * 写入（只替换 Soul 切片）
   *
   * @param file 记忆文件
   */
  save(file: SoulMemoryFile): void {
    const type = typeForScope(this.scope);
    const existing = this.store.list(type).entries;
    // V2 原生条目原样保留：它们是别的模块的数据，Soul 无权覆盖
    const preserved = existing.filter((entry) => !isSoulEntry(entry));
    // V2 来源的条目（origin=v2）不写回：写回会把只读事实降级成 Soul 条目
    const owned = file.entries
      .filter((entry) => entry.origin !== "v2")
      .map((entry) => soulEntryToMemoryEntry(entry, type));
    this.store.replace(type, [...preserved, ...owned]);
  }

  /**
   * 删除条目
   *
   * 两类 id 都要认：
   * - 普通 V2 条目的 id → `MemoryStore.delete`；
   * - `facts` 里单条事实的 id（展开后才有的 id）→ 必须回到那条 JSON 里摘掉，
   *   否则「忘掉」只是把界面上的字删了，刷新又回来。
   *
   * @param ids 条目 id
   */
  remove(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const type = typeForScope(this.scope);
    const targets = new Set(ids);
    const existing = this.store.list(type).entries;

    let factsChanged = false;
    const next = existing.map((entry) => {
      if (entry.key !== "facts") return entry;
      const parsed = parseFacts(entry.value);
      if (parsed === null) return entry;
      const kept = parsed.filter((fact) => !(typeof fact.id === "string" && targets.has(fact.id)));
      if (kept.length === parsed.length) return entry;
      factsChanged = true;
      for (const fact of parsed) {
        if (typeof fact.id === "string" && targets.has(fact.id)) targets.delete(fact.id);
      }
      return { ...entry, value: JSON.stringify(kept), updatedAt: new Date().toISOString() };
    });

    if (factsChanged) this.store.replace(type, next);
    // 剩下的 id 交给 V2 自己的删除（它会跨文件找）
    for (const id of targets) this.store.delete(id);
  }

  /**
   * 文件位置（CLI / Web 展示用）
   *
   * @returns 路径；无项目上下文（project 作用域）时为 null
   */
  location(): string | null {
    return this.store.location(typeForScope(this.scope));
  }
}

/**
 * 旧版 Soul 记忆迁移报告
 */
export interface SoulMigrationReport {
  /** 迁移的条目数 */
  readonly migrated: number;
  /** 被处理过的旧文件（已改名为 `.migrated-<时间戳>`） */
  readonly archived: readonly string[];
  /** 解析失败的旧文件（保留原样，不删） */
  readonly failed: readonly string[];
}

/**
 * 迁移旧版 `soul/memory.json` 到统一存储
 *
 * 只在旧文件存在时动作；成功后把旧文件改名归档（不删——万一迁移逻辑有 bug，
 * 用户的数据还在）。重名条目以现有条目为准，旧条目只补空缺。
 *
 * @param stores 作用域化存储（global 必填，project 可选）
 * @param legacyPaths 作用域 → 旧文件路径
 * @returns 迁移报告
 */
export function migrateLegacySoulMemory(
  stores: readonly { readonly scope: SoulMemoryFile["scope"]; readonly store: SoulMemoryStore }[],
  legacyPaths: readonly { readonly scope: SoulMemoryFile["scope"]; readonly path: string }[]
): SoulMigrationReport {
  let migrated = 0;
  const archived: string[] = [];
  const failed: string[] = [];

  for (const legacy of legacyPaths) {
    if (!fs.existsSync(legacy.path)) continue;
    const target = stores.find((item) => item.scope === legacy.scope);
    if (target === undefined) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(legacy.path, "utf8"));
    } catch {
      failed.push(legacy.path);
      continue;
    }

    const normalized = normalizeMemoryFile(parsed, legacy.scope).file;
    const current = target.store.load();
    const seen = new Set(current.entries.map((entry) => `${entry.category}::${entry.key}`));
    const additions: SoulMemory[] = [];
    for (const entry of normalized.entries) {
      const composite = `${entry.category}::${entry.key}`;
      if (seen.has(composite)) continue;
      seen.add(composite);
      additions.push(entry);
    }

    if (additions.length > 0) {
      try {
        target.store.save({
          version: 1,
          scope: legacy.scope,
          entries: [...current.entries, ...additions],
          lastUpdated: new Date().toISOString(),
        });
        migrated += additions.length;
      } catch {
        failed.push(legacy.path);
        continue;
      }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      fs.renameSync(legacy.path, `${legacy.path}.migrated-${stamp}`);
      archived.push(legacy.path);
    } catch {
      failed.push(legacy.path);
    }
  }

  return { migrated, archived, failed };
}
