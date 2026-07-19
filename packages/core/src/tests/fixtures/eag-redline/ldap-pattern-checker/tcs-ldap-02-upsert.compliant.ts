/**
 * Fixture: TCS-LDAP-02 LDAP 同步任务幂等（合规样例）
 *
 * @fixtureId ldap-pattern-checker/tcs-ldap-02-upsert.compliant
 * @checker LdapPatternChecker
 * @redlineIds TCS-LDAP-02
 * @kind compliant
 * @expectVerdict passed
 * @description LDAP 同步文件中 mirrorStore.upsertUserByEntryUUID()——幂等合规，符合 TCS-LDAP-02 红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/infrastructure/ldap/LdapSynchronizer.ts",
    content: `// src/infrastructure/ldap/LdapSynchronizer.ts
import { LdapClient } from "./LdapClient";
import { MirrorStore } from "../persistence/MirrorStore";

/**
 * LDAP 同步器——合规点：使用 upsertUserByEntryUUID 幂等保护
 *
 * LdapSynchronizer 是允许直接调用 LdapClient 的唯一位置（TCS-LDAP-01 豁免），
 * 业务代码不得直连 LDAP，统一由本类走本地镜像/增量缓存。
 */
export class LdapSynchronizer {
  constructor(
    private readonly ldapClient: LdapClient,
    private readonly mirrorStore: MirrorStore
  ) {}

  /**
   * 全量同步 LDAP 用户——合规点：使用 upsertUserByEntryUUID 幂等写入
   */
  async fullSync(): Promise<void> {
    // 从 LDAP 查询所有用户
    const ldapUsers = await this.ldapClient.searchAllUsers();
    // 合规点：使用 mirrorStore.upsertUserByEntryUUID() 幂等写入，存在则更新，不存在则创建
    for (const ldapUser of ldapUsers) {
      await this.mirrorStore.upsertUserByEntryUUID(ldapUser.entryUUID, ldapUser);
    }
  }
}

interface LdapUser {
  entryUUID: string;
  uid: string;
  username: string;
  email: string;
}
`,
  },
]);
