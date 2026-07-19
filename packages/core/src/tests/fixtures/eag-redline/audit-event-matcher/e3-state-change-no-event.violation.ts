/**
 * Fixture: E3 实体状态变更未发布领域事件（违规样例）
 *
 * @fixtureId audit-event-matcher/e3-state-change-no-event.violation
 * @checker AuditEventMatcher
 * @redlineIds E3
 * @kind violation
 * @expectVerdict violated
 * @description 实体类 UserAggregate 的 changePassword() 方法修改状态但未发布领域事件——违反 E3 审计红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/domain/user/UserAggregate.ts",
    content: `// src/domain/user/UserAggregate.ts
/**
 * 用户聚合根
 */
export class UserAggregate {
  private username: string;
  private passwordHash: string;
  private email: string;

  constructor(username: string, passwordHash: string, email: string) {
    this.username = username;
    this.passwordHash = passwordHash;
    this.email = email;
  }

  /**
   * 修改密码——违规点：修改状态但未发布领域事件
   */
  changePassword(newPasswordHash: string): void {
    this.passwordHash = newPasswordHash;
    // 违规点：状态已变更但方法体内未发布任何领域事件
  }

  /**
   * 修改邮箱——违规点：修改状态但未发布领域事件
   */
  updateEmail(newEmail: string): void {
    this.email = newEmail;
    // 违规点：状态已变更但方法体内未发布任何领域事件
  }

  getUsername(): string {
    return this.username;
  }

  getEmail(): string {
    return this.email;
  }
}
`,
  },
]);
