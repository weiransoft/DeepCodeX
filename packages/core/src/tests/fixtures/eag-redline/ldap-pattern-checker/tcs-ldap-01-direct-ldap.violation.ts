/**
 * Fixture: TCS-LDAP-01 业务代码直连 LDAP（违规样例）
 *
 * @fixtureId ldap-pattern-checker/tcs-ldap-01-direct-ldap.violation
 * @checker LdapPatternChecker
 * @redlineIds TCS-LDAP-01
 * @kind violation
 * @expectVerdict violated
 * @description 业务代码（非 Synchronizer）调用 ldapClient.validateCredentials()——违反 TCS-LDAP-01 直连 LDAP 红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/application/auth/AuthService.ts",
    content: `// src/application/auth/AuthService.ts
import { LdapClient } from "../../infrastructure/ldap/LdapClient";

/**
 * 认证服务——违规点：业务代码直连 LDAP 客户端
 */
export class AuthService {
  constructor(private readonly ldapClient: LdapClient) {}

  /**
   * 用户登录——违规点：直接调用 ldapClient.validateCredentials()
   */
  async login(username: string, password: string): Promise<boolean> {
    // 违规点：业务代码直接调用 ldapClient.validateCredentials()，而非通过 LdapSyncPort
    const isValid = await this.ldapClient.validateCredentials(username, password);
    return isValid;
  }

  /**
   * 查询用户——违规点：直接调用 ldapClient.searchUsersByUsername()
   */
  async findUser(username: string): Promise<LdapUser | null> {
    // 违规点：业务代码直接调用 ldapClient.searchUsersByUsername()
    const users = await this.ldapClient.searchUsersByUsername(username);
    return users.length > 0 ? users[0] : null;
  }
}

interface LdapUser {
  uid: string;
  username: string;
  email: string;
}
`,
  },
]);
