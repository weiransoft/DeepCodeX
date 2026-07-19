/**
 * Fixture: E3 实体状态变更发布领域事件（合规样例）
 *
 * @fixtureId audit-event-matcher/e3-state-change-with-event.compliant
 * @checker AuditEventMatcher
 * @redlineIds E3
 * @kind compliant
 * @expectVerdict passed
 * @description 实体类 UserAggregate 的 changePassword() 方法修改状态并发布 PasswordChangedEvent——符合 E3 审计红线
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
  private domainEvents: Array<object> = [];

  constructor(username: string, passwordHash: string, email: string) {
    this.username = username;
    this.passwordHash = passwordHash;
    this.email = email;
  }

  /**
   * 修改密码——合规点：修改状态并发布领域事件
   */
  changePassword(newPasswordHash: string): void {
    const oldPasswordHash = this.passwordHash;
    this.passwordHash = newPasswordHash;
    // 合规点：状态变更后发布领域事件
    this.publish(new PasswordChangedEvent(this.username, oldPasswordHash, newPasswordHash));
  }

  /**
   * 修改邮箱——合规点：修改状态并发布领域事件
   */
  updateEmail(newEmail: string): void {
    const oldEmail = this.email;
    this.email = newEmail;
    // 合规点：状态变更后发布领域事件
    this.publish(new EmailChangedEvent(this.username, oldEmail, newEmail));
  }

  private publish(event: object): void {
    this.domainEvents.push(event);
  }

  getUsername(): string {
    return this.username;
  }

  getEmail(): string {
    return this.email;
  }
}

class PasswordChangedEvent {
  constructor(
    public readonly username: string,
    public readonly oldPasswordHash: string,
    public readonly newPasswordHash: string
  ) {}
}

class EmailChangedEvent {
  constructor(
    public readonly username: string,
    public readonly oldEmail: string,
    public readonly newEmail: string
  ) {}
}
`,
  },
]);
