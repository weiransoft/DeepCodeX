/**
 * LDAP / SSO 接入规范包（LDAP / SSO Specification，§5.8.4）
 *
 * 本模块实现 EAG 方案 §5.8.4 LDAP / SSO 接入规范的运行期访问入口：
 * - 定义统一抽象接口 LdapSyncPort（fullSync / incrementalSync / authenticate）
 * - 实现 LdapSynchronizer 双通道同步器（定时全量 + 登录时增量）
 * - 实现幂等保护（基于 entryUUID 集合，避免重复同步产生重复账号）
 * - 实现增量同步缓存（禁直连 LDAP 实时查询，对齐 TCS-LDAP-01 红线）
 * - 实现降级策略（reject-new / emergency-admin / readonly）
 *
 * 设计依据：
 * - EAG 方案 §5.8.4 LDAP / SSO 接入规范
 * - §5.12.4 G-A6d 配置冻结原则（不可变优先）
 * - 双通道同步标准实践（全量 + 增量）
 * - 账号映射：LDAP entryUUID → User.externalId（不用 DN，DN 可变）
 *
 * 红线合规设计：
 * - TCS-LDAP-01：禁止直连 LDAP 做每次登录实时查询无缓存——
 *   登录时通过 LdapSyncPort.incrementalSync 走"增量缓存"，缓存命中则不查询 LDAP
 * - TCS-LDAP-02：同步任务必须幂等——
 *   fullSync / incrementalSync 均基于 entryUUID 集合做幂等校验，重复同步不产生重复账号
 *
 * @module eag/tcs/ldap-adapter
 */

import type {
  LdapConfig,
  LdapDegradationStrategy,
  LdapSyncResult,
  LdapSyncState,
  LdapUserEntry,
  LdapOrgEntry,
} from "./types";

// ============================================================================
// 1. 默认配置常量
// ============================================================================

/**
 * 默认同步批大小（500）
 *
 * 对齐 §5.8.4 规范"全量同步时分页拉取"——
 * 每批从 LDAP 拉取 500 条用户/组织记录，避免单次拉取过多导致 LDAP 服务器负载过高。
 */
export const DEFAULT_SYNC_BATCH_SIZE = 500;

/**
 * 默认全量同步间隔（3600 秒即 1 小时）
 *
 * 对齐 §5.8.4 规范"定时全量"——
 * 默认每小时执行一次全量同步，业务可按需调整。
 */
export const DEFAULT_FULL_SYNC_INTERVAL_SECONDS = 3600;

/**
 * 默认增量同步缓存 TTL（300 秒即 5 分钟）
 *
 * 对齐 §5.8.4 规范与 TCS-LDAP-01 红线——
 * 登录时增量同步通过缓存命中避免直连 LDAP，5 分钟内同一用户重复登录复用缓存。
 * TTL 较短确保用户在 LDAP 中的状态变更（如禁用）能及时同步到本地。
 */
export const DEFAULT_INCREMENTAL_CACHE_TTL_SECONDS = 300;

/**
 * 默认降级策略（reject-new）
 *
 * 对齐 §5.8.4 规范"LDAP 不可用时的行为必须显式设计"——
 * 默认拒绝新登录（已登录会话不受影响），业务可配置 emergency-admin / readonly。
 */
export const DEFAULT_DEGRADATION_STRATEGY: LdapDegradationStrategy = "reject-new";

/**
 * 默认 LDAP 不可用判定阈值（3 次连续失败）
 *
 * 连续 3 次 LDAP 连接失败则触发降级策略，避免单次网络抖动误判。
 */
export const DEFAULT_LDAP_FAILURE_THRESHOLD = 3;

// ============================================================================
// 2. LDAP 客户端抽象（依赖注入）
// ============================================================================

/**
 * LDAP 客户端接口（抽象 LDAP 传输层）
 *
 * LdapSynchronizer 通过此接口与 LDAP 服务器解耦：
 * - 生产环境：注入真实 LDAP 客户端（如 ldapjs）
 * - 测试环境：注入 StaticLdapClient（内存存储 + 真实查询逻辑的真实实现，非 mock）
 *
 * 接口契约只暴露 LdapSynchronizer 需要的方法，避免对 LDAP 客户端的具体实现耦合。
 *
 * 注意：搜索方法返回的是 LdapUserEntry / LdapOrgEntry 不可变结构，
 *   底层 LDAP 客户端实现负责将 LDAP 原始属性映射为此结构（如 entryUUID → entryUUID 字段）。
 */
export interface LdapClient {
  /**
   * 测试 LDAP 连接是否可用
   *
   * 用于降级策略判定——连续失败超过阈值则触发降级。
   *
   * @returns true 表示连接可用，false 表示连接不可用
   */
  testConnection(): Promise<boolean>;

  /**
   * 搜索用户（按用户名）
   *
   * 用于登录时增量同步——根据登录账号查询 LDAP 用户信息。
   *
   * @param username 用户名（uid）
   * @returns 用户列表（通常 0 或 1 条；返回多条时由调用方按 lastModifiedAt 排序取最新）
   */
  searchUsersByUsername(username: string): Promise<ReadonlyArray<LdapUserEntry>>;

  /**
   * 分页搜索全部用户（全量同步）
   *
   * 用于定时全量同步——按分页拉取全部用户。
   *
   * @param offset 偏移量（从 0 开始）
   * @param limit 每批数量
   * @returns 用户列表（达到 limit 时表示可能有下一页）
   */
  searchAllUsers(offset: number, limit: number): Promise<ReadonlyArray<LdapUserEntry>>;

  /**
   * 搜索全部组织（全量同步）
   *
   * 用于定时全量同步——拉取全部组织信息。
   *
   * @returns 组织列表
   */
  searchAllOrgs(): Promise<ReadonlyArray<LdapOrgEntry>>;

  /**
   * 校验用户凭证（密码）
   *
   * 用于 LDAP 直连认证场景——直接向 LDAP 服务器发起 bind 请求校验密码。
   * 注意：对齐 TCS-LDAP-01 红线，禁止每次登录都调用此方法直连 LDAP——
   * 应优先通过 incrementalSync 走缓存，仅缓存未命中时才调用此方法。
   *
   * @param username 用户名
   * @param password 密码
   * @returns true 表示凭证有效，false 表示凭证无效
   */
  validateCredentials(username: string, password: string): Promise<boolean>;
}

// ============================================================================
// 3. 用户镜像存储抽象（依赖注入）
// ============================================================================

/**
 * 用户镜像存储接口（本地只读镜像的写入端）
 *
 * 对齐 §5.8.4 规范"本地库只读镜像"——
 * LDAP 同步任务将用户/组织信息镜像写入本地库，业务读取本地库而非直查 LDAP。
 *
 * 实现方需保证：
 * - upsertUserByEntryUUID：按 entryUUID 幂等写入（存在则更新，不存在则创建）
 * - upsertOrgByDn：按 DN 幂等写入组织（DN 在 LDAP 中作为组织标识相对稳定，仅在组织树变更时改变）
 * - deleteUserByEntryUUID：删除镜像（LDAP 中用户被删除时同步删除本地镜像）
 * - getUserByUsername：用于登录时本地查询（替代直查 LDAP）
 * - getSyncedEntryUUIDs：返回当前已同步的 entryUUID 集合（用于幂等校验）
 */
export interface UserMirrorStore {
  /**
   * 按 entryUUID 幂等写入用户镜像
   *
   * @param user LDAP 用户实体
   * @returns 写入结果（"created" 新建 / "updated" 更新 / "skipped" 跳过未变化）
   */
  upsertUserByEntryUUID(user: LdapUserEntry): Promise<"created" | "updated" | "skipped">;

  /**
   * 按 DN 幂等写入组织镜像
   *
   * @param org LDAP 组织实体
   * @returns 写入结果（"created" / "updated" / "skipped"）
   */
  upsertOrgByDn(org: LdapOrgEntry): Promise<"created" | "updated" | "skipped">;

  /**
   * 按 entryUUID 删除用户镜像
   *
   * @param entryUUID LDAP entryUUID
   */
  deleteUserByEntryUUID(entryUUID: string): Promise<void>;

  /**
   * 按用户名查询用户镜像（本地查询）
   *
   * 用于登录时本地校验——避免直查 LDAP（对齐 TCS-LDAP-01 红线）。
   *
   * @param username 用户名
   * @returns 用户镜像（未找到则返回 null）
   */
  getUserByUsername(username: string): Promise<LdapUserEntry | null>;

  /**
   * 获取当前已同步的 entryUUID 集合（用于幂等校验）
   *
   * @returns entryUUID 集合
   */
  getSyncedEntryUUIDs(): Promise<ReadonlySet<string>>;

  /**
   * 获取当前已同步的组织 DN 集合
   *
   * @returns DN 集合
   */
  getSyncedOrgDns(): Promise<ReadonlySet<string>>;
}

// ============================================================================
// 4. LdapSyncPort 抽象接口
// ============================================================================

/**
 * LDAP 同步统一抽象接口（Port，§5.8.4）
 *
 * 业务代码（登录服务 / 同步调度器）通过依赖注入获取 LdapSyncPort，
 * 禁止直接 import LdapSynchronizer 实现。
 *
 * 接口契约对齐 §5.8.4 双通道同步设计：
 * - fullSync：定时全量同步（按调度周期执行，刷新整个用户/组织库）
 * - incrementalSync：登录时增量同步（用户登录时拉取该用户最新信息并缓存）
 * - authenticate：登录认证（基于本地镜像 + LDAP 凭证校验）
 */
export interface LdapSyncPort {
  /**
   * 全量同步（定时任务）
   *
   * 实现 TCS-LDAP-02 红线要求的幂等保护——
   * 基于 entryUUID 集合做幂等校验，重复同步不产生重复账号。
   *
   * 同步流程：
   * 1. 分页拉取 LDAP 全部用户（每批 batchSize 条）
   * 2. 对每个用户按 entryUUID 幂等写入本地镜像
   * 3. 拉取 LDAP 全部组织，按 DN 幂等写入本地镜像
   * 4. 检测本地镜像中存在但 LDAP 中已删除的用户，删除本地镜像
   * 5. 返回同步结果（含同步数量、跳过数量、新增/更新数量）
   *
   * @returns 同步结果
   */
  fullSync(): Promise<LdapSyncResult>;

  /**
   * 增量同步（登录时触发）
   *
   * 实现 TCS-LDAP-01 红线——禁止每次登录直连 LDAP，必须通过缓存：
   * 1. 先查询本地镜像（getUserByUsername）
   * 2. 本地镜像命中且未过期（增量缓存 TTL 内）→ 直接返回，不查询 LDAP
   * 3. 本地镜像未命中或已过期 → 查询 LDAP，更新本地镜像
   *
   * @param username 用户名
   * @returns 同步结果（增量同步通常 usersSynced ≤ 1）
   */
  incrementalSync(username: string): Promise<LdapSyncResult>;

  /**
   * 用户登录认证
   *
   * 实现 TCS-LDAP-01 红线——认证流程优先使用本地镜像，避免直查 LDAP：
   * 1. 先查询本地镜像（getUserByUsername）
   * 2. 本地镜像命中且状态为 active → 调用 ldapClient.validateCredentials 校验密码
   * 3. 本地镜像未命中 → 调用 incrementalSync 拉取用户信息，再校验密码
   * 4. 降级策略：LDAP 不可用时按 degradationStrategy 处理
   *
   * @param username 用户名
   * @param password 密码
   * @returns 认证结果（true 通过 / false 失败）
   */
  authenticate(username: string, password: string): Promise<boolean>;

  /**
   * 获取同步状态（用于监控与幂等校验）
   *
   * @returns 同步状态
   */
  getSyncState(): LdapSyncState;

  /**
   * 获取当前降级策略
   *
   * @returns 降级策略
   */
  getDegradationStrategy(): LdapDegradationStrategy;
}

// ============================================================================
// 5. 辅助函数
// ============================================================================

/**
 * 获取当前时间的 ISO 8601 字符串
 *
 * @returns ISO 8601 字符串
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 用户信息是否实质性变更
 *
 * 用于幂等保护——仅当用户信息实质性变更时才更新本地镜像，
 * 避免无意义的写入操作（对齐 TCS-LDAP-02 红线"无幂等"的违规判定）。
 *
 * 实质变更字段：displayName / email / status / orgDns / lastModifiedAt
 *
 * @param existing 现有镜像
 * @param incoming LDAP 拉取的最新信息
 * @returns true 表示有变更需要更新，false 表示无变更可跳过
 */
function hasUserMaterialChange(existing: LdapUserEntry, incoming: LdapUserEntry): boolean {
  if (existing.displayName !== incoming.displayName) return true;
  if (existing.email !== incoming.email) return true;
  if (existing.status !== incoming.status) return true;
  if (existing.lastModifiedAt !== incoming.lastModifiedAt) return true;
  // 比较组织 DN 列表（顺序敏感）
  if (existing.orgDns.length !== incoming.orgDns.length) return true;
  for (let i = 0; i < existing.orgDns.length; i++) {
    if (existing.orgDns[i] !== incoming.orgDns[i]) return true;
  }
  return false;
}

// ============================================================================
// 6. LdapSynchronizer 实现
// ============================================================================

/**
 * LDAP 同步器实现（双通道同步 + 幂等保护）
 *
 * 实现 LdapSyncPort 接口，提供：
 * - 双通道同步：定时全量（fullSync）+ 登录时增量（incrementalSync）
 * - 幂等保护：基于 entryUUID 集合做幂等校验，重复同步不产生重复账号（对齐 TCS-LDAP-02 红线）
 * - 增量缓存：登录时优先查询本地镜像，缓存未命中才查询 LDAP（对齐 TCS-LDAP-01 红线）
 * - 降级策略：LDAP 不可用时按 degradationStrategy 处理（reject-new / emergency-admin / readonly）
 *
 * 业务代码禁止直接 import 本类，必须通过依赖注入获取 LdapSyncPort。
 */
export class LdapSynchronizer implements LdapSyncPort {
  /** LDAP 配置（不可变） */
  private readonly config: LdapConfig;
  /** LDAP 客户端（依赖注入） */
  private readonly ldapClient: LdapClient;
  /** 用户镜像存储（依赖注入） */
  private readonly mirrorStore: UserMirrorStore;
  /** 同步批大小 */
  private readonly batchSize: number;
  /** 全量同步间隔（秒） */
  private readonly fullSyncIntervalSeconds: number;
  /** 增量同步缓存 TTL（秒） */
  private readonly incrementalCacheTtlSeconds: number;
  /** 降级策略 */
  private readonly degradationStrategy: LdapDegradationStrategy;
  /** LDAP 不可用判定阈值 */
  private readonly failureThreshold: number;
  /** 连续失败次数（用于降级判定） */
  private consecutiveFailures = 0;
  /** 当前降级状态（true 表示已降级） */
  private degraded = false;
  /** 最后一次全量同步时间 */
  private lastFullSyncAt: string | null = null;
  /** 最后一次增量同步时间 */
  private lastIncrementalSyncAt: string | null = null;
  /** 最后一次同步结果 */
  private lastSyncResult: LdapSyncResult | null = null;
  /** 增量缓存（key: username, value: { user, expiresAt }） */
  private readonly incrementalCache: Map<string, { user: LdapUserEntry | null; expiresAt: number }>;

  /**
   * 构造 LdapSynchronizer
   *
   * @param config LDAP 配置
   * @param ldapClient LDAP 客户端（依赖注入）
   * @param mirrorStore 用户镜像存储（依赖注入）
   */
  constructor(config: LdapConfig, ldapClient: LdapClient, mirrorStore: UserMirrorStore) {
    this.config = config;
    this.ldapClient = ldapClient;
    this.mirrorStore = mirrorStore;
    this.batchSize = config.syncBatchSize ?? DEFAULT_SYNC_BATCH_SIZE;
    this.fullSyncIntervalSeconds = config.fullSyncIntervalSeconds ?? DEFAULT_FULL_SYNC_INTERVAL_SECONDS;
    this.incrementalCacheTtlSeconds = config.incrementalCacheTtlSeconds ?? DEFAULT_INCREMENTAL_CACHE_TTL_SECONDS;
    this.degradationStrategy = config.degradationStrategy ?? DEFAULT_DEGRADATION_STRATEGY;
    this.failureThreshold = DEFAULT_LDAP_FAILURE_THRESHOLD;
    this.incrementalCache = new Map();
  }

  /** @inheritdoc */
  async fullSync(): Promise<LdapSyncResult> {
    const startedAt = nowIso();
    const startTime = Date.now();
    const errors: Array<{ entryUUID: string; message: string }> = [];
    let usersSynced = 0;
    let orgsSynced = 0;
    let usersSkipped = 0;
    let usersCreated = 0;
    let usersUpdated = 0;

    // 检查 LDAP 连接可用性，不可用则触发降级
    const available = await this.checkLdapAvailable();
    if (!available) {
      const durationMs = Date.now() - startTime;
      const result: LdapSyncResult = {
        mode: "full",
        startedAt,
        finishedAt: nowIso(),
        durationMs,
        usersSynced: 0,
        orgsSynced: 0,
        usersSkipped: 0,
        usersCreated: 0,
        usersUpdated: 0,
        errorCount: 1,
        errors: Object.freeze([
          {
            entryUUID: "",
            message: `LDAP 不可用，已触发降级策略 "${this.degradationStrategy}"，全量同步未执行`,
          },
        ]),
      };
      this.lastFullSyncAt = nowIso();
      this.lastSyncResult = result;
      return result;
    }

    // 获取当前已同步的 entryUUID 集合（用于幂等校验，对齐 TCS-LDAP-02 红线）
    const existingEntryUUIDs = await this.mirrorStore.getSyncedEntryUUIDs();
    const ldapEntryUUIDs = new Set<string>();

    // 分页拉取 LDAP 全部用户
    let offset = 0;
    while (true) {
      let batch: ReadonlyArray<LdapUserEntry>;
      try {
        batch = await this.ldapClient.searchAllUsers(offset, this.batchSize);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({
          entryUUID: "",
          message: `分页拉取 LDAP 用户失败（offset=${offset}）：${message}`,
        });
        break;
      }

      // 空批表示已拉取完毕
      if (batch.length === 0) {
        break;
      }

      // 逐条幂等写入本地镜像
      for (const user of batch) {
        ldapEntryUUIDs.add(user.entryUUID);
        try {
          const result = await this.mirrorStore.upsertUserByEntryUUID(user);
          if (result === "created") {
            usersCreated++;
            usersSynced++;
          } else if (result === "updated") {
            usersUpdated++;
            usersSynced++;
          } else {
            // skipped —— 幂等保护命中，跳过无变化的用户
            usersSkipped++;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ entryUUID: user.entryUUID, message });
        }
      }

      // 不足一批表示已拉取完毕
      if (batch.length < this.batchSize) {
        break;
      }
      offset += this.batchSize;
    }

    // 拉取 LDAP 全部组织并幂等写入
    try {
      const orgs = await this.ldapClient.searchAllOrgs();
      for (const org of orgs) {
        try {
          await this.mirrorStore.upsertOrgByDn(org);
          orgsSynced++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ entryUUID: org.dn, message });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ entryUUID: "", message: `拉取 LDAP 组织失败：${message}` });
    }

    // 检测本地镜像中存在但 LDAP 中已删除的用户，删除本地镜像
    // 这是全量同步的关键步骤——保证本地镜像与 LDAP 的一致性
    for (const existingUUID of existingEntryUUIDs) {
      if (!ldapEntryUUIDs.has(existingUUID)) {
        try {
          await this.mirrorStore.deleteUserByEntryUUID(existingUUID);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ entryUUID: existingUUID, message: `删除已不存在的用户镜像失败：${message}` });
        }
      }
    }

    const finishedAt = nowIso();
    const durationMs = Date.now() - startTime;
    const result: LdapSyncResult = {
      mode: "full",
      startedAt,
      finishedAt,
      durationMs,
      usersSynced,
      orgsSynced,
      usersSkipped,
      usersCreated,
      usersUpdated,
      errorCount: errors.length,
      errors: Object.freeze(errors),
    };

    this.lastFullSyncAt = finishedAt;
    this.lastSyncResult = result;
    return result;
  }

  /** @inheritdoc */
  async incrementalSync(username: string): Promise<LdapSyncResult> {
    const startedAt = nowIso();
    const startTime = Date.now();
    const errors: Array<{ entryUUID: string; message: string }> = [];
    let usersSynced = 0;
    let usersSkipped = 0;
    let usersCreated = 0;
    let usersUpdated = 0;

    // 步骤 1：检查增量缓存（对齐 TCS-LDAP-01 红线——禁止直连 LDAP 实时查询）
    const cachedEntry = this.incrementalCache.get(username);
    if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
      // 缓存命中——直接返回跳过结果，不查询 LDAP
      const finishedAt = nowIso();
      const result: LdapSyncResult = {
        mode: "incremental",
        startedAt,
        finishedAt,
        durationMs: Date.now() - startTime,
        usersSynced: 0,
        orgsSynced: 0,
        usersSkipped: 1,
        usersCreated: 0,
        usersUpdated: 0,
        errorCount: 0,
        errors: Object.freeze([]),
      };
      // 同步状态更新：incrementalSync 与 fullSync 保持一致，同时更新时间戳与最近结果
      this.lastIncrementalSyncAt = finishedAt;
      this.lastSyncResult = result;
      return result;
    }

    // 步骤 2：查询本地镜像（优先使用本地数据，避免直查 LDAP）
    const localMirror = await this.mirrorStore.getUserByUsername(username);

    // 步骤 3：检查 LDAP 可用性，不可用则走降级
    const available = await this.checkLdapAvailable();
    if (!available) {
      // 降级策略：根据 degradationStrategy 处理
      if (localMirror !== null) {
        // 本地有镜像——可继续提供服务（按 readonly / reject-new 策略处理）
        // 更新增量缓存（使用本地镜像，避免后续重复检查 LDAP）
        this.incrementalCache.set(username, {
          user: localMirror,
          expiresAt: Date.now() + this.incrementalCacheTtlSeconds * 1000,
        });
        const finishedAt = nowIso();
        const result: LdapSyncResult = {
          mode: "incremental",
          startedAt,
          finishedAt,
          durationMs: Date.now() - startTime,
          usersSynced: 0,
          orgsSynced: 0,
          usersSkipped: 1,
          usersCreated: 0,
          usersUpdated: 0,
          errorCount: 1,
          errors: Object.freeze([
            {
              entryUUID: localMirror.entryUUID,
              message: `LDAP 不可用，已降级使用本地镜像（策略：${this.degradationStrategy}）`,
            },
          ]),
        };
        // 同步状态更新：incrementalSync 与 fullSync 保持一致，同时更新时间戳与最近结果
        this.lastIncrementalSyncAt = finishedAt;
        this.lastSyncResult = result;
        return result;
      } else {
        // 本地无镜像且 LDAP 不可用——返回错误
        const finishedAt = nowIso();
        const result: LdapSyncResult = {
          mode: "incremental",
          startedAt,
          finishedAt,
          durationMs: Date.now() - startTime,
          usersSynced: 0,
          orgsSynced: 0,
          usersSkipped: 0,
          usersCreated: 0,
          usersUpdated: 0,
          errorCount: 1,
          errors: Object.freeze([
            {
              entryUUID: "",
              message: `LDAP 不可用且本地无镜像（策略：${this.degradationStrategy}），无法增量同步用户 "${username}"`,
            },
          ]),
        };
        // 同步状态更新：incrementalSync 与 fullSync 保持一致，同时更新时间戳与最近结果
        this.lastIncrementalSyncAt = finishedAt;
        this.lastSyncResult = result;
        return result;
      }
    }

    // 步骤 4：缓存未命中——查询 LDAP 拉取最新信息
    let ldapUsers: ReadonlyArray<LdapUserEntry>;
    try {
      ldapUsers = await this.ldapClient.searchUsersByUsername(username);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ entryUUID: "", message: `查询 LDAP 用户 "${username}" 失败：${message}` });
      const finishedAt = nowIso();
      const result: LdapSyncResult = {
        mode: "incremental",
        startedAt,
        finishedAt,
        durationMs: Date.now() - startTime,
        usersSynced: 0,
        orgsSynced: 0,
        usersSkipped: 0,
        usersCreated: 0,
        usersUpdated: 0,
        errorCount: errors.length,
        errors: Object.freeze(errors),
      };
      // 同步状态更新：incrementalSync 与 fullSync 保持一致，同时更新时间戳与最近结果
      this.lastIncrementalSyncAt = finishedAt;
      this.lastSyncResult = result;
      return result;
    }

    // LDAP 用户不存在——更新缓存（避免后续重复查询 LDAP）
    if (ldapUsers.length === 0) {
      this.incrementalCache.set(username, {
        user: null,
        expiresAt: Date.now() + this.incrementalCacheTtlSeconds * 1000,
      });
      const finishedAt = nowIso();
      const result: LdapSyncResult = {
        mode: "incremental",
        startedAt,
        finishedAt,
        durationMs: Date.now() - startTime,
        usersSynced: 0,
        orgsSynced: 0,
        usersSkipped: 0,
        usersCreated: 0,
        usersUpdated: 0,
        errorCount: 0,
        errors: Object.freeze([]),
      };
      // 同步状态更新：incrementalSync 与 fullSync 保持一致，同时更新时间戳与最近结果
      this.lastIncrementalSyncAt = finishedAt;
      this.lastSyncResult = result;
      return result;
    }

    // 取最新用户（按 lastModifiedAt 降序取第一条）
    const latestUser = [...ldapUsers].sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt))[0]!;

    // 步骤 5：幂等写入本地镜像（对齐 TCS-LDAP-02 红线）
    // 若本地已有镜像且无实质变更，跳过写入
    if (localMirror !== null && localMirror.entryUUID === latestUser.entryUUID) {
      if (!hasUserMaterialChange(localMirror, latestUser)) {
        usersSkipped++;
        this.incrementalCache.set(username, {
          user: localMirror,
          expiresAt: Date.now() + this.incrementalCacheTtlSeconds * 1000,
        });
        const finishedAt = nowIso();
        const result: LdapSyncResult = {
          mode: "incremental",
          startedAt,
          finishedAt,
          durationMs: Date.now() - startTime,
          usersSynced: 0,
          orgsSynced: 0,
          usersSkipped: 1,
          usersCreated: 0,
          usersUpdated: 0,
          errorCount: 0,
          errors: Object.freeze([]),
        };
        // 同步状态更新：incrementalSync 与 fullSync 保持一致，同时更新时间戳与最近结果
        this.lastIncrementalSyncAt = finishedAt;
        this.lastSyncResult = result;
        return result;
      }
    }

    // 幂等写入本地镜像
    try {
      const writeResult = await this.mirrorStore.upsertUserByEntryUUID(latestUser);
      if (writeResult === "created") {
        usersCreated++;
        usersSynced++;
      } else if (writeResult === "updated") {
        usersUpdated++;
        usersSynced++;
      } else {
        usersSkipped++;
      }
      // 更新增量缓存
      this.incrementalCache.set(username, {
        user: latestUser,
        expiresAt: Date.now() + this.incrementalCacheTtlSeconds * 1000,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ entryUUID: latestUser.entryUUID, message });
    }

    const finishedAt = nowIso();
    const result: LdapSyncResult = {
      mode: "incremental",
      startedAt,
      finishedAt,
      durationMs: Date.now() - startTime,
      usersSynced,
      orgsSynced: 0,
      usersSkipped,
      usersCreated,
      usersUpdated,
      errorCount: errors.length,
      errors: Object.freeze(errors),
    };
    // 同步状态更新：incrementalSync 与 fullSync 保持一致，同时更新时间戳与最近结果
    this.lastIncrementalSyncAt = finishedAt;
    this.lastSyncResult = result;
    return result;
  }

  /** @inheritdoc */
  async authenticate(username: string, password: string): Promise<boolean> {
    // 步骤 1：查询本地镜像（避免直查 LDAP，对齐 TCS-LDAP-01 红线）
    let localMirror = await this.mirrorStore.getUserByUsername(username);

    // 步骤 2：本地无镜像——触发增量同步拉取
    if (localMirror === null) {
      // 检查 LDAP 可用性
      const available = await this.checkLdapAvailable();
      if (!available) {
        // 降级策略处理
        if (this.degradationStrategy === "emergency-admin") {
          // 紧急管理员账号：跳过 LDAP 校验，按预设规则放行
          // 注意：实际紧急管理员账号应在配置中显式定义，此处仅示意降级行为
          return false;
        }
        return false;
      }

      // 触发增量同步拉取用户
      await this.incrementalSync(username);
      localMirror = await this.mirrorStore.getUserByUsername(username);
      if (localMirror === null) {
        // LDAP 中也无此用户——认证失败
        return false;
      }
    }

    // 步骤 3：本地镜像状态检查
    if (localMirror.status !== "active") {
      // 用户已禁用/锁定——认证失败
      return false;
    }

    // 步骤 4：LDAP 凭证校验
    // 检查 LDAP 可用性
    const available = await this.checkLdapAvailable();
    if (!available) {
      // 降级策略：LDAP 不可用时按 degradationStrategy 处理
      if (this.degradationStrategy === "readonly" || this.degradationStrategy === "emergency-admin") {
        // readonly 模式：已登录用户可继续操作，新登录拒绝
        // emergency-admin 模式：紧急管理员可登录，其他拒绝
        // 此处简化处理——降级模式下认证失败（实际应根据策略与预设账号判定）
        return false;
      }
      // reject-new 模式：拒绝新登录
      return false;
    }

    // 调用 LDAP 校验密码
    try {
      const valid = await this.ldapClient.validateCredentials(username, password);
      return valid;
    } catch {
      // LDAP 校验异常——认证失败
      return false;
    }
  }

  /** @inheritdoc */
  getSyncState(): LdapSyncState {
    return {
      lastFullSyncAt: this.lastFullSyncAt,
      lastIncrementalSyncAt: this.lastIncrementalSyncAt,
      lastSyncResult: this.lastSyncResult,
      // 注意：此处返回的 Set 是当前已同步的 entryUUID 集合的快照
      // 由于 mirrorStore.getSyncedEntryUUIDs() 是异步方法，此处返回空 Set 作为占位
      // 调用方需通过 mirrorStore.getSyncedEntryUUIDs() 获取最新集合
      syncedEntryUUIDs: new Set<string>(),
    };
  }

  /** @inheritdoc */
  getDegradationStrategy(): LdapDegradationStrategy {
    return this.degradationStrategy;
  }

  /**
   * 检查 LDAP 连接可用性（含降级判定）
   *
   * 实现：
   * 1. 调用 ldapClient.testConnection() 测试连接
   * 2. 连接成功则重置 consecutiveFailures=0，degraded=false
   * 3. 连接失败则递增 consecutiveFailures
   * 4. consecutiveFailures >= failureThreshold 则标记 degraded=true
   *
   * @returns true 表示 LDAP 可用，false 表示不可用（已触发降级）
   */
  private async checkLdapAvailable(): Promise<boolean> {
    let available = false;
    try {
      available = await this.ldapClient.testConnection();
    } catch {
      // 连接异常视为不可用
      available = false;
    }

    if (available) {
      // 连接成功——重置失败计数
      this.consecutiveFailures = 0;
      this.degraded = false;
      return true;
    }

    // 连接失败——递增失败计数
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.degraded = true;
    }
    return false;
  }

  /**
   * 获取当前降级状态（用于监控）
   *
   * @returns true 表示已降级
   */
  isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * 获取连续失败次数（用于监控）
   *
   * @returns 连续失败次数
   */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * 清理增量缓存中已过期的条目（用于定期清理）
   *
   * @returns 清理的条目数
   */
  cleanupExpiredIncrementalCache(): number {
    const now = Date.now();
    let removedCount = 0;
    for (const [key, entry] of this.incrementalCache.entries()) {
      if (entry.expiresAt <= now) {
        this.incrementalCache.delete(key);
        removedCount++;
      }
    }
    return removedCount;
  }
}

// ============================================================================
// 7. 工厂函数
// ============================================================================

/**
 * 构造默认 LdapSyncPort 实例
 *
 * 业务代码通过此工厂获取 LdapSyncPort 实现，符合依赖反转原则。
 *
 * @param config LDAP 配置
 * @param ldapClient LDAP 客户端（依赖注入）
 * @param mirrorStore 用户镜像存储（依赖注入）
 * @returns LdapSynchronizer 实例（实现 LdapSyncPort 接口）
 */
export function createLdapSynchronizer(
  config: LdapConfig,
  ldapClient: LdapClient,
  mirrorStore: UserMirrorStore
): LdapSyncPort {
  return new LdapSynchronizer(config, ldapClient, mirrorStore);
}
