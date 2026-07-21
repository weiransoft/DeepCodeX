/**
 * CodeMap 性能基准测试种子文件（fixtures/codemap/seed/）
 *
 * 用途：
 *   - 提供 10 个手工编写的稳定 TS 文件，作为性能基准测试的"种子"
 *   - cm-12-large-bench.mjs 基于这些种子文件复制扩展为 1000/5000/10000 文件规模
 *   - 种子文件包含类、函数、依赖关系、循环依赖等典型结构
 *
 * 设计原则：
 *   - 种子文件结构稳定（不随时间变化），保证基准测试可重现
 *   - 涵盖 CodeMapGenerator 的主要分析路径（类识别/函数识别/依赖解析/循环检测）
 *   - 文件之间有真实的 import 关系（非随机生成），避免解析失败
 */

export class UserService {
  private users: Map<string, User> = new Map();

  addUser(user: User): void {
    this.users.set(user.id, user);
  }

  getUser(id: string): User | undefined {
    return this.users.get(id);
  }

  listUsers(): User[] {
    return Array.from(this.users.values());
  }
}

export interface User {
  id: string;
  name: string;
  email: string;
}
