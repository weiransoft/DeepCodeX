/**
 * TCS LDAP 接入红线 fixtures（TCS-LDAP-01 / TCS-LDAP-02）
 *
 * 每条红线 1 个违规样例 + 1 个合规样例（共 4 个 fixture），
 * 用于测试评估器对 LDAP 接入红线的判定准确性。
 *
 * 设计依据：
 * - EAG 方案 §5.8.4 LDAP / SSO 接入规范（双通道同步 + 幂等保护）
 * - eag/tcs/ldap-adapter.ts（LdapSynchronizer + LdapSyncPort + UserMirrorStore）
 * - eag/tcs/tcs-redlines.ts（TCS-LDAP-01/02 红线定义）
 *
 * @module eag/tcs/fixtures/ldap-fixtures
 */

// 引入 deepFreeze 用于递归冻结 fixture 及其嵌套的 expectedViolations 数组。
// Object.freeze 是浅冻结，无法冻结嵌套的 expectedViolations 数组本身——
// F12 测试断言 Object.isFrozen(f.expectedViolations) 必须为 true，
// 因此改用 deepFreeze（types.ts 中已实现）递归冻结所有层级。
import { deepFreeze, type RedlineFixture } from "../types";

// ============================================================================
// TCS-LDAP-01：直连 LDAP 实时查询无缓存
// ============================================================================

/**
 * TCS-LDAP-01 违规样例：登录流程直连 LDAP 实时查询无缓存
 *
 * 场景：业务代码（auth-service.ts）登录认证时直接调用 ldapClient.searchUsersByUsername
 * 与 ldapClient.validateCredentials，未通过 LdapSyncPort 走本地镜像/增量缓存。
 * 高并发登录场景下 LDAP 服务器负载激增，且 LDAP 不可用时所有登录失败。
 */
export const LDAP_01_VIOLATION: RedlineFixture = deepFreeze({
  redlineId: "TCS-LDAP-01",
  kind: "violation",
  description:
    "业务代码（auth-service.ts）登录认证时直接调用 ldapClient.searchUsersByUsername 与 ldapClient.validateCredentials，" +
    "未通过 LdapSyncPort 走本地镜像/增量缓存。高并发登录场景下 LDAP 服务器负载激增，" +
    "且 LDAP 不可用时所有登录失败（无降级能力），违反 §5.8.4 规范。",
  code: [
    "// src/services/auth-service.ts",
    "import type { LdapClient } from '../eag/tcs/ldap-adapter';",
    "",
    "export class AuthService {",
    "  constructor(private readonly ldapClient: LdapClient) {}",
    "",
    "  /** 登录认证（违规：直连 LDAP 实时查询无缓存） */",
    "  async login(username: string, password: string): Promise<LoginResult> {",
    "    // 违规：业务代码直连 LDAP 客户端，未通过 LdapSyncPort 缓存",
    "    const users = await this.ldapClient.searchUsersByUsername(username);",
    "    if (users.length === 0) {",
    "      return { success: false, reason: 'USER_NOT_FOUND' };",
    "    }",
    "    // 违规：直接调用 ldapClient.validateCredentials，未通过本地镜像",
    "    const valid = await this.ldapClient.validateCredentials(username, password);",
    "    if (!valid) {",
    "      return { success: false, reason: 'INVALID_PASSWORD' };",
    "    }",
    "    return { success: true, user: users[0] };",
    "  }",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [
    {
      filePath: "src/services/auth-service.ts",
      line: 10,
      description:
        "业务代码直连 ldapClient.searchUsersByUsername——违反 TCS-LDAP-01 红线，应通过 LdapSyncPort.authenticate 走本地镜像/增量缓存",
    },
    {
      filePath: "src/services/auth-service.ts",
      line: 16,
      description:
        "业务代码直连 ldapClient.validateCredentials——LDAP 客户端应仅由 LdapSynchronizer 内部调用，业务代码通过 LdapSyncPort 接口访问",
    },
  ],
  expectedVerdict: "violated",
});

/**
 * TCS-LDAP-01 合规样例：通过 LdapSyncPort 走本地镜像/增量缓存
 *
 * 场景：业务代码（auth-service.ts）通过 LdapSyncPort.authenticate 走本地镜像/增量缓存，
 * 缓存命中则不查询 LDAP，缓存未命中才查询 LDAP 并更新本地镜像。
 */
export const LDAP_01_COMPLIANT: RedlineFixture = deepFreeze({
  redlineId: "TCS-LDAP-01",
  kind: "compliant",
  description:
    "业务代码（auth-service.ts）通过 LdapSyncPort.authenticate 走本地镜像/增量缓存，" +
    "缓存命中则不查询 LDAP（避免 LDAP 服务器负载），缓存未命中才查询 LDAP 并更新本地镜像，" +
    "符合 §5.8.4 规范。",
  code: [
    "// src/services/auth-service.ts",
    "import type { LdapSyncPort } from '../eag/tcs/ldap-adapter';",
    "",
    "export class AuthService {",
    "  constructor(private readonly ldapSyncPort: LdapSyncPort) {}",
    "",
    "  /** 登录认证（合规：通过 LdapSyncPort 走缓存） */",
    "  async login(username: string, password: string): Promise<LoginResult> {",
    "    // 合规：通过 LdapSyncPort.authenticate 走本地镜像/增量缓存",
    "    const result = await this.ldapSyncPort.authenticate(username, password);",
    "    if (!result.success) {",
    "      return { success: false, reason: result.reason };",
    "    }",
    "    return { success: true, user: result.user };",
    "  }",
    "}",
    "",
    "// IoC 容器装配",
    "// const ldapSyncPort = createLdapSynchronizer(config, ldapClient, mirrorStore);",
    "// const authService = new AuthService(ldapSyncPort);",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [],
  expectedVerdict: "passed",
});

// ============================================================================
// TCS-LDAP-02：同步任务无幂等
// ============================================================================

/**
 * TCS-LDAP-02 违规样例：LDAP 同步任务直接 createUser（无幂等）
 *
 * 场景：业务代码（ldap-sync-task.ts）执行全量同步时直接调用 mirrorStore.createUser，
 * 未按 entryUUID 幂等写入。重复执行同步任务时产生重复账号（同一 LDAP 用户在本地库出现多条记录）。
 */
export const LDAP_02_VIOLATION: RedlineFixture = deepFreeze({
  redlineId: "TCS-LDAP-02",
  kind: "violation",
  description:
    "业务代码（ldap-sync-task.ts）执行 LDAP 全量同步时直接调用 mirrorStore.createUser，" +
    "未按 entryUUID 幂等写入。重复执行同步任务时产生重复账号——" +
    "同一 LDAP 用户在本地库出现多条记录，登录时无法确定使用哪条记录，审计追溯困难。",
  code: [
    "// src/tasks/ldap-sync-task.ts",
    "import type { LdapClient, UserMirrorStore } from '../eag/tcs/ldap-adapter';",
    "",
    "export class LdapSyncTask {",
    "  constructor(",
    "    private readonly ldapClient: LdapClient,",
    "    private readonly mirrorStore: UserMirrorStore,",
    "  ) {}",
    "",
    "  /** 全量同步 LDAP 用户到本地（违规：无幂等保护） */",
    "  async fullSync(): Promise<void> {",
    "    const users = await this.ldapClient.searchAllUsers();",
    "    for (const user of users) {",
    "      // 违规：直接 createUser，未按 entryUUID 幂等写入",
    "      await this.mirrorStore.createUser({",
    "        entryUUID: user.entryUUID,",
    "        username: user.username,",
    "        email: user.email,",
    "        displayName: user.displayName,",
    "      });",
    "    }",
    "  }",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [
    {
      filePath: "src/tasks/ldap-sync-task.ts",
      line: 16,
      description:
        "mirrorStore.createUser 无幂等检查——违反 TCS-LDAP-02 红线，应改用 upsertUserByEntryUUID 按 entryUUID 幂等写入",
    },
  ],
  expectedVerdict: "violated",
});

/**
 * TCS-LDAP-02 合规样例：通过 LdapSyncPort.fullSync 委托幂等同步
 *
 * 场景：业务代码通过 ldapSyncPort.fullSync() 委托 LdapSynchronizer 处理幂等，
 * LdapSynchronizer 内部调用 upsertUserByEntryUUID 按 entryUUID 幂等写入
 * （存在则更新，不存在则创建），全量同步时还检测并删除 LDAP 中已不存在的用户镜像。
 */
export const LDAP_02_COMPLIANT: RedlineFixture = deepFreeze({
  redlineId: "TCS-LDAP-02",
  kind: "compliant",
  description:
    "业务代码通过 ldapSyncPort.fullSync() 委托 LdapSynchronizer 处理幂等同步。" +
    "LdapSynchronizer 内部调用 mirrorStore.upsertUserByEntryUUID 按 entryUUID 幂等写入" +
    "（存在则更新，不存在则创建），全量同步时还检测并删除 LDAP 中已不存在的用户镜像，" +
    "符合 §5.8.4 规范。",
  code: [
    "// src/tasks/ldap-sync-task.ts",
    "import type { LdapSyncPort } from '../eag/tcs/ldap-adapter';",
    "",
    "export class LdapSyncTask {",
    "  constructor(private readonly ldapSyncPort: LdapSyncPort) {}",
    "",
    "  /** 全量同步 LDAP 用户到本地（合规：通过 LdapSyncPort 委托幂等） */",
    "  async fullSync(): Promise<void> {",
    "    // 合规：委托 LdapSynchronizer 处理幂等",
    "    // 内部基于 entryUUID 幂等写入 + 检测删除 LDAP 中已不存在的用户镜像",
    "    const result = await this.ldapSyncPort.fullSync();",
    "    if (result.failedCount > 0) {",
    "      console.warn(`LDAP 同步部分失败：${result.failedCount} 条`);",
    "    }",
    "  }",
    "}",
    "",
    "// UserMirrorStore 实现方必须保证 upsertUserByEntryUUID 的幂等性：",
    "// - 按 entryUUID 查询本地是否已存在",
    "// - 存在则更新（created=false, updated=true）",
    "// - 不存在则创建（created=true, updated=false）",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [],
  expectedVerdict: "passed",
});

// ============================================================================
// LDAP fixtures 聚合导出
// ============================================================================

/**
 * LDAP 接入全部 fixtures（4 个，TCS-LDAP-01/02 各 2 个）
 */
export const LDAP_FIXTURES: ReadonlyArray<RedlineFixture> = Object.freeze([
  LDAP_01_VIOLATION,
  LDAP_01_COMPLIANT,
  LDAP_02_VIOLATION,
  LDAP_02_COMPLIANT,
]);
