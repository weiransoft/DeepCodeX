/**
 * Fixture: TCS-LDAP-01 业务代码通过 LdapSyncPort（合规样例）
 *
 * @fixtureId ldap-pattern-checker/tcs-ldap-01-sync-port.compliant
 * @checker LdapPatternChecker
 * @redlineIds TCS-LDAP-01
 * @kind compliant
 * @expectVerdict passed
 * @description 业务代码通过 ldapSyncPort.authenticate() 抽象接口——符合 TCS-LDAP-01 红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/application/auth/AuthService.ts",
    content: `// src/application/auth/AuthService.ts
import type { LdapSyncPort } from "../../ports/LdapSyncPort";

/**
 * 认证服务——合规点：通过 LdapSyncPort 抽象接口
 */
export class AuthService {
  constructor(private readonly ldapSyncPort: LdapSyncPort) {}

  /**
   * 用户登录——合规点：通过 ldapSyncPort.authenticate() 抽象接口
   */
  async login(username: string, password: string): Promise<boolean> {
    // 合规点：业务代码通过 ldapSyncPort.authenticate() 抽象接口
    const isValid = await this.ldapSyncPort.authenticate(username, password);
    return isValid;
  }

  /**
   * 查询用户——合规点：通过 ldapSyncPort.findUserByUsername() 抽象接口
   */
  async findUser(username: string): Promise<LdapUser | null> {
    // 合规点：业务代码通过 ldapSyncPort.findUserByUsername() 抽象接口
    return this.ldapSyncPort.findUserByUsername(username);
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
