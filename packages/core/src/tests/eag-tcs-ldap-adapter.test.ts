/**
 * EAG-P2 批次 7 单元测试：TCS LDAP 接入适配器（ldap-adapter.ts）
 *
 * 测试范围：
 * - L1. 默认配置常量校验（DEFAULT_SYNC_BATCH_SIZE / DEFAULT_FULL_SYNC_INTERVAL_SECONDS 等）
 * - L2. createLdapSynchronizer 工厂函数返回 LdapSyncPort 实例
 * - L3. LdapSynchronizer.fullSync 全量同步——首次同步全部 LDAP 用户/组织
 * - L4. LdapSynchronizer.fullSync 幂等保护——重复同步不产生重复账号（TCS-LDAP-02 红线）
 * - L5. LdapSynchronizer.fullSync 删除已不存在的用户镜像（LDAP 中删除则本地镜像同步删除）
 * - L6. LdapSynchronizer.incrementalSync 缓存命中——不查询 LDAP（TCS-LDAP-01 红线）
 * - L7. LdapSynchronizer.incrementalSync 缓存未命中——查询 LDAP 并写入本地镜像
 * - L8. LdapSynchronizer.incrementalSync LDAP 用户不存在——返回空结果并缓存
 * - L9. LdapSynchronizer.authenticate 本地镜像命中且密码正确——认证成功
 * - L10. LdapSynchronizer.authenticate 本地镜像状态非 active——认证失败
 * - L11. LdapSynchronizer.authenticate 密码错误——认证失败
 * - L12. LdapSynchronizer.authenticate 本地无镜像——触发增量同步后再校验
 * - L13. LdapSynchronizer.getSyncState 返回同步状态
 * - L14. LdapSynchronizer.getDegradationStrategy 返回降级策略
 * - L15. LDAP 不可用时降级（连续失败超过阈值触发降级）
 * - L16. LDAP 不可用时 fullSync 走降级路径返回错误结果
 * - L17. LDAP 不可用时 incrementalSync 使用本地镜像降级
 * - L18. isDegraded / getConsecutiveFailures 监控方法
 * - L19. cleanupExpiredIncrementalCache 清理过期缓存
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实 InMemoryLdapClient（实现 LdapClient 接口）
 * - 禁止使用 mock 框架，使用真实 InMemoryUserMirrorStore（实现 UserMirrorStore 接口）
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - EAG 方案 §5.8.4 LDAP / SSO 接入规范
 * - eag/tcs/ldap-adapter.ts 源文件（被测对象）
 *
 * @module core/tests/eag-tcs-ldap-adapter
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SYNC_BATCH_SIZE,
  DEFAULT_FULL_SYNC_INTERVAL_SECONDS,
  DEFAULT_INCREMENTAL_CACHE_TTL_SECONDS,
  DEFAULT_DEGRADATION_STRATEGY,
  DEFAULT_LDAP_FAILURE_THRESHOLD,
  LdapSynchronizer,
  createLdapSynchronizer,
  type LdapClient,
  type UserMirrorStore,
  type LdapSyncPort,
} from "../eag/tcs/ldap-adapter";
import type { LdapConfig, LdapUserEntry, LdapOrgEntry } from "../eag/tcs/types";

// ============================================================================
// 辅助：InMemoryLdapClient（真实实现 LdapClient 接口，非 mock）
// ============================================================================

/**
 * 内存 LDAP 客户端（真实实现 LdapClient 接口）
 *
 * 使用 Map 真实存储用户/组织数据，并支持：
 * - testConnection（按 available 标志返回 true/false）
 * - searchUsersByUsername（按 username 精确匹配）
 * - searchAllUsers（按 offset+limit 分页返回）
 * - searchAllOrgs（返回全部组织）
 * - validateCredentials（按预设的 username→password 映射校验）
 *
 * 这是真实的 LDAP 服务端实现，不是 mock——它真实地存储数据并执行查询/校验逻辑。
 */
class InMemoryLdapClient implements LdapClient {
  /** 用户存储（entryUUID → LdapUserEntry） */
  private readonly users = new Map<string, LdapUserEntry>();
  /** 组织存储（dn → LdapOrgEntry） */
  private readonly orgs = new Map<string, LdapOrgEntry>();
  /** 凭证存储（username → password，用于 validateCredentials 校验） */
  private readonly credentials = new Map<string, string>();
  /** 连接是否可用（可手动设置为 false 模拟 LDAP 不可用） */
  private available = true;
  /** testConnection 抛出异常开关（模拟网络异常） */
  private throwOnTestConnection = false;

  /** 测试辅助：设置 LDAP 连接是否可用 */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  /** 测试辅助：设置 testConnection 是否抛出异常 */
  setThrowOnTestConnection(throwOnTest: boolean): void {
    this.throwOnTestConnection = throwOnTest;
  }

  /** 测试辅助：添加用户到 LDAP */
  addUser(user: LdapUserEntry, password: string = "password123"): void {
    this.users.set(user.entryUUID, user);
    this.credentials.set(user.username, password);
  }

  /** 测试辅助：添加组织到 LDAP */
  addOrg(org: LdapOrgEntry): void {
    this.orgs.set(org.dn, org);
  }

  /** 测试辅助：从 LDAP 删除用户 */
  removeUser(entryUUID: string): void {
    const user = this.users.get(entryUUID);
    if (user) {
      this.users.delete(entryUUID);
      this.credentials.delete(user.username);
    }
  }

  /** 测试辅助：更新 LDAP 中用户信息（返回新副本） */
  updateUser(entryUUID: string, updates: Partial<LdapUserEntry>): LdapUserEntry | null {
    const existing = this.users.get(entryUUID);
    if (!existing) {
      return null;
    }
    const updated: LdapUserEntry = {
      entryUUID: existing.entryUUID,
      dn: updates.dn ?? existing.dn,
      username: updates.username ?? existing.username,
      displayName: updates.displayName ?? existing.displayName,
      email: updates.email ?? existing.email,
      orgDns: updates.orgDns ?? existing.orgDns,
      status: updates.status ?? existing.status,
      lastModifiedAt: updates.lastModifiedAt ?? existing.lastModifiedAt,
    };
    this.users.set(entryUUID, updated);
    return updated;
  }

  /** 测试辅助：清空所有数据 */
  clear(): void {
    this.users.clear();
    this.orgs.clear();
    this.credentials.clear();
    this.available = true;
    this.throwOnTestConnection = false;
  }

  async testConnection(): Promise<boolean> {
    if (this.throwOnTestConnection) {
      throw new Error("LDAP 连接异常（模拟网络错误）");
    }
    return this.available;
  }

  async searchUsersByUsername(username: string): Promise<ReadonlyArray<LdapUserEntry>> {
    if (!this.available) {
      throw new Error("LDAP 不可用，无法查询用户");
    }
    const results: LdapUserEntry[] = [];
    for (const user of this.users.values()) {
      if (user.username === username) {
        results.push(user);
      }
    }
    // 按 lastModifiedAt 降序排序（取最新一条）
    results.sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));
    return Object.freeze(results);
  }

  async searchAllUsers(offset: number, limit: number): Promise<ReadonlyArray<LdapUserEntry>> {
    if (!this.available) {
      throw new Error("LDAP 不可用，无法查询用户");
    }
    const all = Array.from(this.users.values());
    // 按 entryUUID 排序保证分页稳定性
    all.sort((a, b) => a.entryUUID.localeCompare(b.entryUUID));
    const page = all.slice(offset, offset + limit);
    return Object.freeze(page);
  }

  async searchAllOrgs(): Promise<ReadonlyArray<LdapOrgEntry>> {
    if (!this.available) {
      throw new Error("LDAP 不可用，无法查询组织");
    }
    return Object.freeze(Array.from(this.orgs.values()));
  }

  async validateCredentials(username: string, password: string): Promise<boolean> {
    if (!this.available) {
      throw new Error("LDAP 不可用，无法校验凭证");
    }
    const expected = this.credentials.get(username);
    if (expected === undefined) {
      return false;
    }
    return expected === password;
  }
}

// ============================================================================
// 辅助：InMemoryUserMirrorStore（真实实现 UserMirrorStore 接口，非 mock）
// ============================================================================

/**
 * 内存用户镜像存储（真实实现 UserMirrorStore 接口）
 *
 * 使用 Map 真实存储本地镜像，并支持：
 * - upsertUserByEntryUUID（幂等写入：存在则按实质变更判定 updated/skipped，不存在则 created）
 * - upsertOrgByDn（幂等写入组织）
 * - deleteUserByEntryUUID（删除本地镜像）
 * - getUserByUsername（按用户名查询本地镜像）
 * - getSyncedEntryUUIDs（返回当前已同步 entryUUID 集合）
 * - getSyncedOrgDns（返回当前已同步 DN 集合）
 *
 * 这是真实的本地镜像存储实现，不是 mock——它真实地存储数据并执行幂等校验逻辑。
 */
class InMemoryUserMirrorStore implements UserMirrorStore {
  /** 用户镜像（entryUUID → LdapUserEntry） */
  private readonly userByEntryUUID = new Map<string, LdapUserEntry>();
  /** 用户名索引（username → entryUUID） */
  private readonly entryUUIDByUsername = new Map<string, string>();
  /** 组织镜像（dn → LdapOrgEntry） */
  private readonly orgByDn = new Map<string, LdapOrgEntry>();

  /**
   * 按 entryUUID 幂等写入用户镜像
   *
   * 幂等保护逻辑（对齐 TCS-LDAP-02 红线）：
   * - entryUUID 不存在 → 创建（created）
   * - entryUUID 存在且实质性变更 → 更新（updated）
   * - entryUUID 存在且无实质性变更 → 跳过（skipped）
   *
   * 实质变更字段：displayName / email / status / orgDns / lastModifiedAt
   */
  async upsertUserByEntryUUID(user: LdapUserEntry): Promise<"created" | "updated" | "skipped"> {
    const existing = this.userByEntryUUID.get(user.entryUUID);
    if (existing === undefined) {
      // 新建
      this.userByEntryUUID.set(user.entryUUID, user);
      this.entryUUIDByUsername.set(user.username, user.entryUUID);
      return "created";
    }
    // 检查实质性变更
    if (hasMaterialChange(existing, user)) {
      // 用户名变更时清理旧索引
      if (existing.username !== user.username) {
        this.entryUUIDByUsername.delete(existing.username);
        this.entryUUIDByUsername.set(user.username, user.entryUUID);
      }
      this.userByEntryUUID.set(user.entryUUID, user);
      return "updated";
    }
    return "skipped";
  }

  /** 按 DN 幂等写入组织镜像 */
  async upsertOrgByDn(org: LdapOrgEntry): Promise<"created" | "updated" | "skipped"> {
    const existing = this.orgByDn.get(org.dn);
    if (existing === undefined) {
      this.orgByDn.set(org.dn, org);
      return "created";
    }
    if (
      existing.orgUnitCode !== org.orgUnitCode ||
      existing.name !== org.name ||
      existing.parentDn !== org.parentDn ||
      existing.type !== org.type
    ) {
      this.orgByDn.set(org.dn, org);
      return "updated";
    }
    return "skipped";
  }

  /** 按 entryUUID 删除用户镜像 */
  async deleteUserByEntryUUID(entryUUID: string): Promise<void> {
    const existing = this.userByEntryUUID.get(entryUUID);
    if (existing) {
      this.entryUUIDByUsername.delete(existing.username);
    }
    this.userByEntryUUID.delete(entryUUID);
  }

  /** 按用户名查询本地镜像 */
  async getUserByUsername(username: string): Promise<LdapUserEntry | null> {
    const entryUUID = this.entryUUIDByUsername.get(username);
    if (entryUUID === undefined) {
      return null;
    }
    return this.userByEntryUUID.get(entryUUID) ?? null;
  }

  /** 获取当前已同步的 entryUUID 集合 */
  async getSyncedEntryUUIDs(): Promise<ReadonlySet<string>> {
    return new Set(this.userByEntryUUID.keys());
  }

  /** 获取当前已同步的组织 DN 集合 */
  async getSyncedOrgDns(): Promise<ReadonlySet<string>> {
    return new Set(this.orgByDn.keys());
  }

  /** 测试辅助：获取本地镜像用户总数 */
  getUserCount(): number {
    return this.userByEntryUUID.size;
  }

  /** 测试辅助：获取本地镜像组织总数 */
  getOrgCount(): number {
    return this.orgByDn.size;
  }

  /** 测试辅助：清空所有镜像 */
  clear(): void {
    this.userByEntryUUID.clear();
    this.entryUUIDByUsername.clear();
    this.orgByDn.clear();
  }
}

/**
 * 判定用户信息是否发生实质性变更（与 ldap-adapter.ts 中的私有函数同逻辑）
 *
 * 实质变更字段：displayName / email / status / orgDns / lastModifiedAt
 *
 * @param existing 现有镜像
 * @param incoming LDAP 拉取的最新信息
 * @returns true 表示有变更需要更新，false 表示无变更可跳过
 */
function hasMaterialChange(existing: LdapUserEntry, incoming: LdapUserEntry): boolean {
  if (existing.displayName !== incoming.displayName) return true;
  if (existing.email !== incoming.email) return true;
  if (existing.status !== incoming.status) return true;
  if (existing.lastModifiedAt !== incoming.lastModifiedAt) return true;
  if (existing.orgDns.length !== incoming.orgDns.length) return true;
  for (let i = 0; i < existing.orgDns.length; i++) {
    if (existing.orgDns[i] !== incoming.orgDns[i]) return true;
  }
  return false;
}

// ============================================================================
// 辅助：构造测试数据
// ============================================================================

/**
 * 构造测试用 LdapConfig
 */
function makeLdapConfig(overrides: Partial<LdapConfig> = {}): LdapConfig {
  return {
    url: "ldap://ldap.example.com:389",
    bindDn: "cn=admin,dc=example,dc=com",
    bindPassword: "admin-password",
    userSearchBase: "ou=users,dc=example,dc=com",
    userSearchFilter: "(uid={0})",
    orgSearchBase: "ou=orgs,dc=example,dc=com",
    orgSearchFilter: "(objectClass=organizationalUnit)",
    syncBatchSize: 100,
    fullSyncIntervalSeconds: 3600,
    incrementalCacheTtlSeconds: 300,
    degradationStrategy: "reject-new",
    ...overrides,
  };
}

/**
 * 构造测试用 LDAP 用户实体
 */
function makeLdapUser(overrides: Partial<LdapUserEntry> = {}): LdapUserEntry {
  return {
    entryUUID: "uuid-0001",
    dn: "uid=alice,ou=users,dc=example,dc=com",
    username: "alice",
    displayName: "Alice Wang",
    email: "alice@example.com",
    orgDns: ["ou=engineering,dc=example,dc=com"],
    status: "active",
    lastModifiedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * 构造测试用 LDAP 组织实体
 */
function makeLdapOrg(overrides: Partial<LdapOrgEntry> = {}): LdapOrgEntry {
  return {
    dn: "ou=engineering,dc=example,dc=com",
    orgUnitCode: "ENG",
    name: "Engineering",
    parentDn: "",
    type: "department",
    ...overrides,
  };
}

// ============================================================================
// L1. 默认配置常量校验
// ============================================================================

test("L1a. DEFAULT_SYNC_BATCH_SIZE 默认同步批大小为 500", () => {
  assert.equal(DEFAULT_SYNC_BATCH_SIZE, 500);
});

test("L1b. DEFAULT_FULL_SYNC_INTERVAL_SECONDS 默认全量同步间隔为 3600 秒", () => {
  assert.equal(DEFAULT_FULL_SYNC_INTERVAL_SECONDS, 3600);
});

test("L1c. DEFAULT_INCREMENTAL_CACHE_TTL_SECONDS 默认增量缓存 TTL 为 300 秒", () => {
  assert.equal(DEFAULT_INCREMENTAL_CACHE_TTL_SECONDS, 300);
});

test("L1d. DEFAULT_DEGRADATION_STRATEGY 默认降级策略为 reject-new", () => {
  assert.equal(DEFAULT_DEGRADATION_STRATEGY, "reject-new");
});

test("L1e. DEFAULT_LDAP_FAILURE_THRESHOLD 默认失败阈值为 3 次", () => {
  assert.equal(DEFAULT_LDAP_FAILURE_THRESHOLD, 3);
});

// ============================================================================
// L2. createLdapSynchronizer 工厂函数
// ============================================================================

test("L2. createLdapSynchronizer 返回 LdapSynchronizer 实例并实现 LdapSyncPort 接口", () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);
  assert.ok(syncPort instanceof LdapSynchronizer, "createLdapSynchronizer 应返回 LdapSynchronizer 实例");
  // LdapSyncPort 接口方法存在
  assert.equal(typeof syncPort.fullSync, "function");
  assert.equal(typeof syncPort.incrementalSync, "function");
  assert.equal(typeof syncPort.authenticate, "function");
  assert.equal(typeof syncPort.getSyncState, "function");
  assert.equal(typeof syncPort.getDegradationStrategy, "function");
});

// ============================================================================
// L3. fullSync 全量同步——首次同步全部 LDAP 用户/组织
// ============================================================================

test("L3. LdapSynchronizer.fullSync 首次同步全部 LDAP 用户/组织", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  // 准备 LDAP 数据
  ldapClient.addUser(
    makeLdapUser({
      entryUUID: "uuid-001",
      username: "alice",
      displayName: "Alice",
    })
  );
  ldapClient.addUser(
    makeLdapUser({
      entryUUID: "uuid-002",
      username: "bob",
      displayName: "Bob",
    })
  );
  ldapClient.addOrg(makeLdapOrg({ dn: "ou=eng,dc=example,dc=com", name: "Engineering" }));
  ldapClient.addOrg(
    makeLdapOrg({
      dn: "ou=hr,dc=example,dc=com",
      orgUnitCode: "HR",
      name: "HR",
    })
  );

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  const result = await syncPort.fullSync();
  assert.equal(result.mode, "full");
  assert.equal(result.usersSynced, 2, "应同步 2 个用户");
  assert.equal(result.orgsSynced, 2, "应同步 2 个组织");
  assert.equal(result.usersCreated, 2, "应新建 2 个用户");
  assert.equal(result.usersUpdated, 0, "无更新");
  assert.equal(result.usersSkipped, 0, "无跳过");
  assert.equal(result.errorCount, 0, "无错误");
  // 本地镜像应有 2 个用户与 2 个组织
  assert.equal(mirrorStore.getUserCount(), 2);
  assert.equal(mirrorStore.getOrgCount(), 2);
});

// ============================================================================
// L4. fullSync 幂等保护——重复同步不产生重复账号（TCS-LDAP-02 红线）
// ============================================================================

test("L4. LdapSynchronizer.fullSync 幂等保护——重复同步跳过未变更用户（TCS-LDAP-02）", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  ldapClient.addUser(
    makeLdapUser({
      entryUUID: "uuid-001",
      username: "alice",
      displayName: "Alice",
    })
  );

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  // 第一次同步——创建
  const result1 = await syncPort.fullSync();
  assert.equal(result1.usersCreated, 1);
  assert.equal(result1.usersSynced, 1);
  assert.equal(mirrorStore.getUserCount(), 1);

  // 第二次同步——无变更，应跳过（幂等保护命中）
  const result2 = await syncPort.fullSync();
  assert.equal(result2.usersCreated, 0, "第二次同步无新建");
  assert.equal(result2.usersUpdated, 0, "第二次同步无更新");
  assert.equal(result2.usersSkipped, 1, "第二次同步应跳过 1 个用户");
  assert.equal(result2.usersSynced, 0, "第二次同步 usersSynced 应为 0");
  assert.equal(mirrorStore.getUserCount(), 1, "本地镜像仍为 1 个用户（无重复账号）");
});

test("L4b. LdapSynchronizer.fullSync 用户信息变更——第二次同步应更新", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  ldapClient.addUser(
    makeLdapUser({
      entryUUID: "uuid-001",
      username: "alice",
      displayName: "Alice",
      lastModifiedAt: "2026-01-01T00:00:00.000Z",
    })
  );

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  // 第一次同步
  await syncPort.fullSync();
  assert.equal(mirrorStore.getUserCount(), 1);

  // 更新 LDAP 中用户信息（displayName + lastModifiedAt 变更）
  ldapClient.updateUser("uuid-001", {
    displayName: "Alice Updated",
    lastModifiedAt: "2026-01-02T00:00:00.000Z",
  });

  // 第二次同步——应更新
  const result2 = await syncPort.fullSync();
  assert.equal(result2.usersCreated, 0);
  assert.equal(result2.usersUpdated, 1, "第二次同步应更新 1 个用户");
  assert.equal(result2.usersSkipped, 0);
  assert.equal(mirrorStore.getUserCount(), 1);

  // 验证镜像已更新
  const mirror = await mirrorStore.getUserByUsername("alice");
  assert.notEqual(mirror, null);
  assert.equal(mirror!.displayName, "Alice Updated");
});

// ============================================================================
// L5. fullSync 删除已不存在的用户镜像（LDAP 中删除则本地镜像同步删除）
// ============================================================================

test("L5. LdapSynchronizer.fullSync 删除 LDAP 中已不存在的用户镜像", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  ldapClient.addUser(
    makeLdapUser({
      entryUUID: "uuid-001",
      username: "alice",
    })
  );
  ldapClient.addUser(
    makeLdapUser({
      entryUUID: "uuid-002",
      username: "bob",
    })
  );

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  // 第一次同步——2 个用户
  await syncPort.fullSync();
  assert.equal(mirrorStore.getUserCount(), 2);

  // 从 LDAP 删除 bob
  ldapClient.removeUser("uuid-002");

  // 第二次同步——应删除本地镜像中的 bob
  const result2 = await syncPort.fullSync();
  // alice 第二次同步无实质变更被跳过，usersSynced 仅统计 created/updated，不包含 skipped
  assert.equal(result2.usersSynced, 0, "alice 被跳过，usersSynced 应为 0");
  assert.equal(result2.usersSkipped, 1, "alice 无变更跳过");
  assert.equal(result2.usersCreated, 0);
  assert.equal(result2.usersUpdated, 0);
  assert.equal(mirrorStore.getUserCount(), 1, "本地镜像应只剩 1 个用户");
  // bob 镜像应已被删除
  const bobMirror = await mirrorStore.getUserByUsername("bob");
  assert.equal(bobMirror, null, "bob 的本地镜像应被删除");
});

// ============================================================================
// L6. incrementalSync 缓存命中——不查询 LDAP（TCS-LDAP-01 红线）
// ============================================================================

test("L6. LdapSynchronizer.incrementalSync 缓存命中不查询 LDAP（TCS-LDAP-01）", async () => {
  const config = makeLdapConfig({ incrementalCacheTtlSeconds: 60 });
  const ldapClient = new InMemoryLdapClient();
  ldapClient.addUser(
    makeLdapUser({
      entryUUID: "uuid-001",
      username: "alice",
    })
  );

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  // 第一次增量同步——缓存未命中，应查询 LDAP
  const result1 = await syncPort.incrementalSync("alice");
  assert.equal(result1.mode, "incremental");
  assert.equal(result1.usersSynced, 1, "首次增量应同步 1 个用户");
  assert.equal(result1.usersCreated, 1, "首次增量应新建");
  assert.equal(mirrorStore.getUserCount(), 1);

  // 第二次增量同步——缓存命中，应跳过（不查询 LDAP）
  const result2 = await syncPort.incrementalSync("alice");
  assert.equal(result2.mode, "incremental");
  assert.equal(result2.usersSkipped, 1, "缓存命中应跳过 1 个用户");
  assert.equal(result2.usersSynced, 0, "缓存命中不应同步");
  assert.equal(result2.usersCreated, 0);
  assert.equal(result2.usersUpdated, 0);
  assert.equal(result2.errorCount, 0);
});

// ============================================================================
// L7. incrementalSync 缓存未命中——查询 LDAP 并写入本地镜像
// ============================================================================

test("L7. LdapSynchronizer.incrementalSync 缓存未命中查询 LDAP 并写入本地镜像", async () => {
  const config = makeLdapConfig({ incrementalCacheTtlSeconds: 0 }); // TTL=0 立即过期
  const ldapClient = new InMemoryLdapClient();
  ldapClient.addUser(
    makeLdapUser({
      entryUUID: "uuid-001",
      username: "alice",
      displayName: "Alice",
    })
  );

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  // 第一次增量——写入本地镜像
  await syncPort.incrementalSync("alice");
  assert.equal(mirrorStore.getUserCount(), 1);

  // LDAP 中用户信息变更
  ldapClient.updateUser("uuid-001", {
    displayName: "Alice Updated",
    lastModifiedAt: "2026-01-02T00:00:00.000Z",
  });

  // 第二次增量——TTL=0 必然缓存过期，应查询 LDAP 并更新
  const result2 = await syncPort.incrementalSync("alice");
  assert.equal(result2.mode, "incremental");
  assert.equal(result2.usersUpdated, 1, "应更新 1 个用户");
  assert.equal(result2.usersSynced, 1);

  // 本地镜像应已更新
  const mirror = await mirrorStore.getUserByUsername("alice");
  assert.notEqual(mirror, null);
  assert.equal(mirror!.displayName, "Alice Updated");
});

// ============================================================================
// L8. incrementalSync LDAP 用户不存在——返回空结果并缓存
// ============================================================================

test("L8. LdapSynchronizer.incrementalSync LDAP 用户不存在返回空结果", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  // 不添加任何用户——查询 nonexistent 应返回空

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  const result = await syncPort.incrementalSync("nonexistent-user");
  assert.equal(result.mode, "incremental");
  assert.equal(result.usersSynced, 0);
  assert.equal(result.usersCreated, 0);
  assert.equal(result.usersUpdated, 0);
  assert.equal(result.usersSkipped, 0);
  assert.equal(result.errorCount, 0, "无错误（LDAP 中无此用户是正常情况）");
  assert.equal(mirrorStore.getUserCount(), 0, "本地镜像不应有用户");
});

// ============================================================================
// L9. authenticate 本地镜像命中且密码正确——认证成功
// ============================================================================

test("L9. LdapSynchronizer.authenticate 本地镜像命中且密码正确——认证成功", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  ldapClient.addUser(
    makeLdapUser({
      entryUUID: "uuid-001",
      username: "alice",
      status: "active",
    }),
    "correct-password"
  );

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  // 先全量同步——本地镜像有 alice
  await syncPort.fullSync();

  // 认证——密码正确应成功
  const result = await syncPort.authenticate("alice", "correct-password");
  assert.equal(result, true, "密码正确应认证成功");
});

// ============================================================================
// L10. authenticate 本地镜像状态非 active——认证失败
// ============================================================================

test("L10. LdapSynchronizer.authenticate 本地镜像状态非 active——认证失败", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  ldapClient.addUser(
    makeLdapUser({
      entryUUID: "uuid-001",
      username: "alice",
      status: "disabled", // 用户已禁用
    }),
    "correct-password"
  );

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  // 先全量同步
  await syncPort.fullSync();

  // 认证——禁用用户应失败
  const result = await syncPort.authenticate("alice", "correct-password");
  assert.equal(result, false, "禁用用户应认证失败");
});

// ============================================================================
// L11. authenticate 密码错误——认证失败
// ============================================================================

test("L11. LdapSynchronizer.authenticate 密码错误——认证失败", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  ldapClient.addUser(
    makeLdapUser({
      entryUUID: "uuid-001",
      username: "alice",
      status: "active",
    }),
    "correct-password"
  );

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  // 先全量同步
  await syncPort.fullSync();

  // 认证——密码错误应失败
  const result = await syncPort.authenticate("alice", "wrong-password");
  assert.equal(result, false, "密码错误应认证失败");
});

// ============================================================================
// L12. authenticate 本地无镜像——触发增量同步后再校验
// ============================================================================

test("L12. LdapSynchronizer.authenticate 本地无镜像触发增量同步后再校验", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  ldapClient.addUser(
    makeLdapUser({
      entryUUID: "uuid-001",
      username: "alice",
      status: "active",
    }),
    "correct-password"
  );

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  // 本地无镜像——直接认证应触发增量同步
  assert.equal(mirrorStore.getUserCount(), 0);
  const result = await syncPort.authenticate("alice", "correct-password");
  assert.equal(result, true, "增量同步后密码正确应认证成功");
  assert.equal(mirrorStore.getUserCount(), 1, "增量同步应写入本地镜像");
});

test("L12b. LdapSynchronizer.authenticate LDAP 中无此用户——认证失败", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  // LDAP 中不添加任何用户

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  const result = await syncPort.authenticate("nonexistent", "any-password");
  assert.equal(result, false, "LDAP 中无此用户应认证失败");
});

// ============================================================================
// L13. getSyncState 返回同步状态
// ============================================================================

test("L13a. LdapSynchronizer.getSyncState 初始状态为 null", () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  const state = syncPort.getSyncState();
  assert.equal(state.lastFullSyncAt, null, "初始 lastFullSyncAt 应为 null");
  assert.equal(state.lastIncrementalSyncAt, null, "初始 lastIncrementalSyncAt 应为 null");
  assert.equal(state.lastSyncResult, null, "初始 lastSyncResult 应为 null");
});

test("L13b. LdapSynchronizer.getSyncState fullSync 后更新状态", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  ldapClient.addUser(makeLdapUser());
  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  await syncPort.fullSync();
  const state = syncPort.getSyncState();
  assert.notEqual(state.lastFullSyncAt, null, "fullSync 后 lastFullSyncAt 应有值");
  assert.notEqual(state.lastSyncResult, null, "fullSync 后 lastSyncResult 应有值");
  assert.equal(state.lastSyncResult!.mode, "full");
});

test("L13c. LdapSynchronizer.getSyncState incrementalSync 后更新状态", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  ldapClient.addUser(makeLdapUser());
  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  await syncPort.incrementalSync("alice");
  const state = syncPort.getSyncState();
  assert.notEqual(state.lastIncrementalSyncAt, null, "incrementalSync 后 lastIncrementalSyncAt 应有值");
  assert.notEqual(state.lastSyncResult, null);
  assert.equal(state.lastSyncResult!.mode, "incremental");
});

// ============================================================================
// L14. getDegradationStrategy 返回降级策略
// ============================================================================

test("L14a. LdapSynchronizer.getDegradationStrategy 默认返回 reject-new", () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);
  assert.equal(syncPort.getDegradationStrategy(), "reject-new");
});

test("L14b. LdapSynchronizer.getDegradationStrategy 自定义策略 readonly", () => {
  const config = makeLdapConfig({ degradationStrategy: "readonly" });
  const ldapClient = new InMemoryLdapClient();
  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);
  assert.equal(syncPort.getDegradationStrategy(), "readonly");
});

test("L14c. LdapSynchronizer.getDegradationStrategy 自定义策略 emergency-admin", () => {
  const config = makeLdapConfig({ degradationStrategy: "emergency-admin" });
  const ldapClient = new InMemoryLdapClient();
  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);
  assert.equal(syncPort.getDegradationStrategy(), "emergency-admin");
});

// ============================================================================
// L15. LDAP 不可用时降级（连续失败超过阈值触发降级）
// ============================================================================

test("L15. LDAP 连续失败超过阈值触发降级", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  ldapClient.setAvailable(false); // LDAP 不可用

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);
  const synchronizer = syncPort as LdapSynchronizer;

  // 连续失败 3 次（默认阈值）应触发降级
  // 第一次失败
  await syncPort.fullSync();
  assert.equal(synchronizer.isDegraded(), false, "第 1 次失败不应立即降级");
  assert.equal(synchronizer.getConsecutiveFailures(), 1);

  // 第二次失败
  await syncPort.fullSync();
  assert.equal(synchronizer.isDegraded(), false, "第 2 次失败不应立即降级");
  assert.equal(synchronizer.getConsecutiveFailures(), 2);

  // 第三次失败——达到阈值，触发降级
  await syncPort.fullSync();
  assert.equal(synchronizer.getConsecutiveFailures(), 3);
  assert.equal(synchronizer.isDegraded(), true, "第 3 次失败应触发降级");
});

// ============================================================================
// L16. LDAP 不可用时 fullSync 走降级路径返回错误结果
// ============================================================================

test("L16. LdapSynchronizer.fullSync LDAP 不可用时返回错误结果", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  ldapClient.setAvailable(false); // LDAP 不可用

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  const result = await syncPort.fullSync();
  assert.equal(result.mode, "full");
  assert.equal(result.usersSynced, 0, "LDAP 不可用时应同步 0 个用户");
  assert.equal(result.orgsSynced, 0);
  assert.equal(result.usersCreated, 0);
  assert.equal(result.errorCount, 1, "应有 1 个错误");
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0]!.message.includes("LDAP 不可用"), "错误信息应包含'LDAP 不可用'");
});

// ============================================================================
// L17. LDAP 不可用时 incrementalSync 使用本地镜像降级
// ============================================================================

test("L17a. LdapSynchronizer.incrementalSync LDAP 不可用但本地有镜像——降级使用本地镜像", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  ldapClient.addUser(makeLdapUser({ entryUUID: "uuid-001", username: "alice" }));

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  // 先全量同步——本地有镜像
  await syncPort.fullSync();
  assert.equal(mirrorStore.getUserCount(), 1);

  // 切换到不可用状态
  ldapClient.setAvailable(false);

  // 增量同步——应降级使用本地镜像
  const result = await syncPort.incrementalSync("alice");
  assert.equal(result.mode, "incremental");
  assert.equal(result.usersSkipped, 1, "降级使用本地镜像应跳过");
  assert.equal(result.errorCount, 1, "应有 1 个错误（降级告警）");
  assert.ok(result.errors[0]!.message.includes("LDAP 不可用"), "错误信息应包含'LDAP 不可用'");
});

test("L17b. LdapSynchronizer.incrementalSync LDAP 不可用且本地无镜像——返回错误", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  ldapClient.setAvailable(false); // LDAP 不可用

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);

  const result = await syncPort.incrementalSync("nonexistent");
  assert.equal(result.mode, "incremental");
  assert.equal(result.usersSynced, 0);
  assert.equal(result.usersSkipped, 0);
  assert.equal(result.errorCount, 1);
  assert.ok(result.errors[0]!.message.includes("LDAP 不可用"), "错误信息应包含'LDAP 不可用'");
});

// ============================================================================
// L18. isDegraded / getConsecutiveFailures 监控方法
// ============================================================================

test("L18a. LdapSynchronizer.isDegraded 初始为 false", () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);
  const synchronizer = syncPort as LdapSynchronizer;
  assert.equal(synchronizer.isDegraded(), false);
  assert.equal(synchronizer.getConsecutiveFailures(), 0);
});

test("L18b. LdapSynchronizer LDAP 恢复后重置失败计数与降级状态", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);
  const synchronizer = syncPort as LdapSynchronizer;

  // 模拟 LDAP 不可用
  ldapClient.setAvailable(false);
  await syncPort.fullSync();
  await syncPort.fullSync();
  await syncPort.fullSync();
  assert.equal(synchronizer.isDegraded(), true);
  assert.equal(synchronizer.getConsecutiveFailures(), 3);

  // LDAP 恢复
  ldapClient.setAvailable(true);
  ldapClient.addUser(makeLdapUser());
  const result = await syncPort.fullSync();
  assert.equal(result.errorCount, 0, "LDAP 恢复后应成功同步");
  assert.equal(synchronizer.isDegraded(), false, "LDAP 恢复后应取消降级");
  assert.equal(synchronizer.getConsecutiveFailures(), 0, "LDAP 恢复后应重置失败计数");
});

test("L18c. LdapSynchronizer testConnection 抛异常视为不可用", async () => {
  const config = makeLdapConfig();
  const ldapClient = new InMemoryLdapClient();
  ldapClient.setThrowOnTestConnection(true); // testConnection 抛异常

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);
  const synchronizer = syncPort as LdapSynchronizer;

  const result = await syncPort.fullSync();
  assert.equal(result.errorCount, 1, "testConnection 异常应视为不可用");
  assert.equal(synchronizer.getConsecutiveFailures(), 1);
});

// ============================================================================
// L19. cleanupExpiredIncrementalCache 清理过期缓存
// ============================================================================

test("L19a. LdapSynchronizer.cleanupExpiredIncrementalCache 清理过期缓存条目", async () => {
  const config = makeLdapConfig({ incrementalCacheTtlSeconds: 1 }); // 1 秒过期
  const ldapClient = new InMemoryLdapClient();
  ldapClient.addUser(makeLdapUser({ entryUUID: "uuid-001", username: "alice" }));

  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);
  const synchronizer = syncPort as LdapSynchronizer;

  // 第一次增量同步——写入缓存
  await syncPort.incrementalSync("alice");

  // 等待缓存过期
  await new Promise((resolve) => setTimeout(resolve, 1100));

  // 清理过期缓存
  const removedCount = synchronizer.cleanupExpiredIncrementalCache();
  assert.ok(removedCount >= 1, "应清理至少 1 个过期缓存条目");
});

test("L19b. LdapSynchronizer.cleanupExpiredIncrementalCache 无过期缓存返回 0", () => {
  const config = makeLdapConfig({ incrementalCacheTtlSeconds: 300 });
  const ldapClient = new InMemoryLdapClient();
  const mirrorStore = new InMemoryUserMirrorStore();
  const syncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);
  const synchronizer = syncPort as LdapSynchronizer;

  const removedCount = synchronizer.cleanupExpiredIncrementalCache();
  assert.equal(removedCount, 0, "无缓存时应返回 0");
});
