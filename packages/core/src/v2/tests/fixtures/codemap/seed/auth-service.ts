/**
 * CodeMap 性能基准测试种子文件 - 认证服务
 *
 * 形成 auth-service → user-service 依赖
 */

import type { User } from "./user-service";
import type { UserService } from "./user-service";
import { Logger } from "./logger";

export class AuthService {
  private logger: Logger = new Logger();
  private tokens: Map<string, string> = new Map(); // token → userId

  constructor(private userService: UserService) {}

  async login(email: string, password: string): Promise<string | null> {
    const users = this.userService.listUsers();
    const user = users.find((u) => u.email === email);
    if (!user) {
      this.logger.warn("Login failed: user not found", { email });
      return null;
    }

    // 简化：实际应使用 bcrypt/hash 验证
    if (password.length < 6) {
      this.logger.warn("Login failed: invalid password", { email });
      return null;
    }

    const token = this.generateToken(user);
    this.tokens.set(token, user.id);
    this.logger.info("Login successful", { userId: user.id });
    return token;
  }

  logout(token: string): boolean {
    const userId = this.tokens.get(token);
    if (userId) {
      this.tokens.delete(token);
      this.logger.info("Logout successful", { userId });
      return true;
    }
    return false;
  }

  verifyToken(token: string): User | null {
    const userId = this.tokens.get(token);
    if (!userId) return null;
    return this.userService.getUser(userId) ?? null;
  }

  private generateToken(user: User): string {
    return `token-${user.id}-${Date.now()}`;
  }
}
