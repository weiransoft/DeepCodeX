/**
 * Fixture: TCS-LDAP-02 LDAP 同步任务无幂等（违规样例）
 *
 * @fixtureId ldap-pattern-checker/tcs-ldap-02-no-idempotent.violation
 * @checker LdapPatternChecker
 * @redlineIds TCS-LDAP-02
 * @kind violation
 * @expectVerdict violated
 * @description LDAP 同步文件中 mirrorStore.createUser() 且无 upsert 调用——违反 TCS-LDAP-02 同步任务幂等红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/infrastructure/ldap/LdapSyncTask.ts",
    content: `// src/infrastructure/ldap/LdapSyncTask.ts
import { LdapClient } from "./LdapClient";
import { MirrorStore } from "../persistence/MirrorStore";

/**
 * LDAP 同步任务——违规点：使用 createUser 无幂等保护
 */
export class LdapSyncTask {
  constructor(
    private readonly ldapClient: LdapClient,
    private readonly mirrorStore: MirrorStore
  ) {}

  /**
   * 全量同步 LDAP 用户——违规点：使用 createUser 而非 upsertUserByEntryUUID
   */
  async fullSync(): Promise<void> {
    // 从 LDAP 查询所有用户
    const ldapUsers = await this.ldapClient.searchAllUsers();
    // 违规点：使用 mirrorStore.createUser() 无幂等保护，重复执行会创建重复账号
    for (const ldapUser of ldapUsers) {
      await this.mirrorStore.createUser(ldapUser);
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
