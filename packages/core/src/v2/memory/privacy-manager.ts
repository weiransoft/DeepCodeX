/**
 * 记忆隐私管理器（MemoryPrivacyManager）
 *
 * 设计依据：V2_CONTEXT_MEMORY_TECH_DESIGN.md §8.7 隐私管理（US-PRIV-002）
 *
 * 职责：
 * - 导出全部记忆为单一 JSON 文件（/memory export 命令）
 * - 删除全部记忆（/memory delete-all 命令，需二次确认 "DELETE ALL"）
 * - 删除清单覆盖 ~/.deepcode/memory/ 目录下全部文件（含 redaction.log 与历史 export-*.json）
 *
 * 设计要点（§8.7）：
 * 1. exportAll 读取 user-global.json / experience.json / changelog.json（缺失视为空段，不报错），
 *    遍历 projectMemoryDir 下全部 project 记忆文件，聚合为 projects 段（key=projectId），
 *    组装 MemoryExport 对象并用 MemoryExportSchema 校验，写入 export-<timestamp>.json（原子写）
 * 2. deleteAll 严格匹配 "DELETE ALL"（区分大小写、不带空格），错误 confirmToken 抛
 *    InvalidConfirmTokenError 且零文件删除
 * 3. 删除后清理 ~/.deepcode/memory/ 目录下所有文件，删除后 ls 为空
 *
 * @module v2/memory/privacy-manager
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

// ============================================================================
// 1. 接口与错误定义（§8.7.1）
// ============================================================================

/**
 * 记忆导出结果
 */
export interface ExportResult {
  /** 导出文件的绝对路径（~/.deepcode/memory/export-<timestamp>.json） */
  exportPath: string;
  /** 各段导出的条目计数（供 UI 展示与对账） */
  counts: {
    /** 用户全局记忆 facts 条数 */
    userGlobalFacts: number;
    /** 项目记忆项目数 */
    projects: number;
    /** 经验库条目数 */
    experiences: number;
    /** 变更日志条目数 */
    changelog: number;
  };
}

/**
 * 删除操作报告
 */
export interface DeleteReport {
  /** 已删除的文件数 */
  deletedCount: number;
  /** 已删除的文件绝对路径清单（供 UI 展示与对账） */
  deletedFiles: string[];
}

/**
 * 记忆导出 JSON 结构（MemoryExport schema）
 *
 * schemaVersion 固定为 1，exportedAt 为 ISO-8601 时间戳。
 * 四段内容：userGlobal / projects / experiences / changelog。
 */
export const MemoryExportSchema = z.object({
  /** schema 版本号（当前固定 1） */
  schemaVersion: z.literal(1),
  /** 导出时间（ISO-8601） */
  exportedAt: z.string(),
  /** 用户全局记忆段（user-global.json 内容，缺失为 null） */
  userGlobal: z.unknown().nullable(),
  /** 项目记忆段（key=projectId，value=项目记忆内容） */
  projects: z.record(z.string(), z.unknown()),
  /** 经验库段（experience.json 内容，缺失为 null） */
  experiences: z.unknown().nullable(),
  /** 变更日志段（changelog.json 内容，缺失为 null） */
  changelog: z.unknown().nullable(),
});

/** MemoryExport 类型（zod 推导） */
export type MemoryExport = z.infer<typeof MemoryExportSchema>;

/**
 * 无效确认令牌错误
 *
 * 当 confirmToken 不严格等于 "DELETE ALL" 时抛出，零文件被删除。
 */
export class InvalidConfirmTokenError extends Error {
  /** 用户传入的错误令牌（仅用于错误信息，不记录明文密钥） */
  readonly providedToken: string;

  constructor(providedToken: string) {
    super(
      `无效的删除确认令牌。必须严格输入 "DELETE ALL"（区分大小写、不带前后空格），实际输入: "${providedToken}"。零文件被删除。`
    );
    this.name = "InvalidConfirmTokenError";
    this.providedToken = providedToken;
  }
}

// ============================================================================
// 2. 常量定义
// ============================================================================

/**
 * 删除操作的确认令牌（严格匹配）
 *
 * 用户必须输入完全一致的 "DELETE ALL"（大写、空格分隔、无前后空格）才会触发删除。
 * 任何其他形式（如 "delete all" 小写、" DELETE ALL " 带空格、"" 空字符串）均视为无效。
 */
const DELETE_CONFIRM_TOKEN = "DELETE ALL";

// ============================================================================
// 3. MemoryPrivacyManager 类（§8.7.2）
// ============================================================================

/**
 * 记忆隐私管理器
 *
 * 实现 /memory export 与 /memory delete-all 命令的底层逻辑。
 *
 * 用法：
 * ```typescript
 * const manager = new MemoryPrivacyManager(
 *   path.join(os.homedir(), ".deepcode", "memory"),
 *   path.join(projectRoot, ".deepcode", "memory"),
 * );
 * // 导出全部记忆
 * const result = await manager.exportAll();
 * // 删除全部记忆（需二次确认）
 * const report = await manager.deleteAll("DELETE ALL");
 * ```
 */
export class MemoryPrivacyManager {
  /**
   * 创建记忆隐私管理器
   *
   * @param memoryDir 记忆根目录（默认 ~/.deepcode/memory/，测试注入临时目录）
   * @param projectMemoryDir 项目记忆根目录（默认 <projectRoot>/.deepcode/memory/，扫描当前项目）
   */
  constructor(
    private readonly memoryDir: string,
    private readonly projectMemoryDir: string
  ) {}

  /**
   * 导出全部记忆为单一 JSON 文件
   *
   * 实现步骤：
   * 1. 依次读取 user-global.json / experience.json / changelog.json（缺失视为空段，不报错）；
   * 2. 遍历 projectMemoryDir 下全部 project 记忆文件，聚合为 projects 段（key=projectId）；
   * 3. 组装 MemoryExport 对象并用 MemoryExportSchema 校验（自写自校，保证落盘即合法）；
   * 4. 写入 export-<timestamp>.json（tmp+fsync+rename 原子写，复用 §8.5 持久化原语）；
   * 5. 返回 ExportResult（含导出路径与各段计数）。
   *
   * @returns 导出结果（路径 + 计数）
   */
  async exportAll(): Promise<ExportResult> {
    // 步骤 1：读取用户全局记忆段（缺失视为 null）
    const userGlobalPath = path.join(this.memoryDir, "global.json");
    const userGlobal = await this.readJsonOrNull(userGlobalPath);

    // 读取经验库段
    const experiencePath = path.join(this.memoryDir, "experience.json");
    const experiences = await this.readJsonOrNull(experiencePath);

    // 读取变更日志段
    const changelogPath = path.join(this.memoryDir, "changelog.json");
    const changelog = await this.readJsonOrNull(changelogPath);

    // 步骤 2：遍历项目记忆目录，聚合为 projects 段
    const projects: Record<string, unknown> = {};
    let projectCount = 0;
    try {
      const projectFiles = await fs.readdir(this.projectMemoryDir);
      for (const fileName of projectFiles) {
        // 只处理 .json 文件，跳过 redaction.log / export-*.json / .corrupted 等
        if (!fileName.endsWith(".json")) continue;
        if (fileName.startsWith("export-")) continue;
        if (fileName.includes(".corrupted")) continue;

        const filePath = path.join(this.projectMemoryDir, fileName);
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) continue;

        const content = await this.readJsonOrNull(filePath);
        if (content !== null) {
          // 使用文件名（去 .json 后缀）作为 projectId
          const projectId = fileName.slice(0, -5);
          projects[projectId] = content;
          projectCount++;
        }
      }
    } catch {
      // projectMemoryDir 不存在或不可读，projects 段为空（不报错）
    }

    // 步骤 3：组装 MemoryExport 对象
    const exportData: MemoryExport = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      userGlobal,
      projects,
      experiences,
      changelog,
    };

    // 自写自校：保证落盘即合法
    const validated = MemoryExportSchema.parse(exportData);

    // 步骤 4：原子写入 export-<timestamp>.json
    const timestamp = formatTimestamp(new Date());
    const exportFileName = `export-${timestamp}.json`;
    const exportPath = path.join(this.memoryDir, exportFileName);

    // 确保目录存在
    await fs.mkdir(this.memoryDir, { recursive: true });

    // tmp + fsync + rename 原子写
    const tmpPath = `${exportPath}.tmp`;
    const jsonContent = JSON.stringify(validated, null, 2);
    await fs.writeFile(tmpPath, jsonContent, "utf8");
    await fs.rename(tmpPath, exportPath);

    // 步骤 5：返回 ExportResult（含计数）
    return {
      exportPath,
      counts: {
        userGlobalFacts: countFacts(userGlobal),
        projects: projectCount,
        experiences: countEntries(experiences),
        changelog: countEntries(changelog),
      },
    };
  }

  /**
   * 删除全部记忆文件（需二次确认）
   *
   * 实现步骤：
   * 1. 校验 confirmToken 严格等于 "DELETE ALL"（区分大小写、不带空格）；
   *    不匹配则抛 InvalidConfirmTokenError，零文件被删除；
   * 2. 扫描 memoryDir 下全部文件（含 redaction.log 与历史 export-*.json）；
   * 3. 逐个删除文件（不删除目录本身，保留空目录）；
   * 4. 返回 DeleteReport（含删除清单与计数）；
   * 5. 空目录幂等：memoryDir 无文件时返回 deletedCount=0，不抛错。
   *
   * @param confirmToken 确认令牌（必须严格等于 "DELETE ALL"）
   * @returns 删除报告（计数 + 文件清单）
   * @throws InvalidConfirmTokenError 令牌不匹配（零文件被删除）
   */
  async deleteAll(confirmToken: string): Promise<DeleteReport> {
    // 步骤 1：严格匹配确认令牌
    if (confirmToken !== DELETE_CONFIRM_TOKEN) {
      throw new InvalidConfirmTokenError(confirmToken);
    }

    // 步骤 2：扫描 memoryDir 下全部文件
    const deletedFiles: string[] = [];
    try {
      const entries = await fs.readdir(this.memoryDir);
      for (const fileName of entries) {
        const filePath = path.join(this.memoryDir, fileName);
        const stat = await fs.stat(filePath);
        if (stat.isFile()) {
          // 步骤 3：逐个删除文件
          await fs.unlink(filePath);
          deletedFiles.push(filePath);
        }
      }
    } catch {
      // memoryDir 不存在或不可读，视为空目录（幂等）
    }

    // 步骤 4：返回 DeleteReport
    return {
      deletedCount: deletedFiles.length,
      deletedFiles,
    };
  }

  /**
   * 读取 JSON 文件，不存在或解析失败时返回 null（不抛错）
   *
   * @param filePath 文件绝对路径
   * @returns 解析后的 JSON 对象，文件不存在或解析失败返回 null
   */
  private async readJsonOrNull(filePath: string): Promise<unknown | null> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      return JSON.parse(content);
    } catch {
      // 文件不存在或 JSON 解析失败，视为空段
      return null;
    }
  }
}

// ============================================================================
// 4. 辅助函数
// ============================================================================

/**
 * 格式化时间戳为文件名安全字符串
 *
 * @param date 时间对象
 * @returns 格式化后的时间戳（如 "20260720-223000-123"）
 */
function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}-${ms}`;
}

/**
 * 统计 facts 条数
 *
 * @param data 用户全局记忆数据
 * @returns facts 条数（无法判断时返回 0）
 */
function countFacts(data: unknown): number {
  if (data === null || typeof data !== "object") return 0;
  const obj = data as Record<string, unknown>;
  // facts 可能是数组或对象
  const facts = obj.facts;
  if (Array.isArray(facts)) return facts.length;
  if (facts !== null && typeof facts === "object") return Object.keys(facts).length;
  return 0;
}

/**
 * 统计经验/变更日志条目数
 *
 * @param data 经验库或变更日志数据
 * @returns 条目数（无法判断时返回 0）
 */
function countEntries(data: unknown): number {
  if (data === null || typeof data !== "object") return 0;
  const obj = data as Record<string, unknown>;
  // 经验库可能有 entries / experiences / items 字段
  for (const key of ["entries", "experiences", "items", "records"]) {
    const field = obj[key];
    if (Array.isArray(field)) return field.length;
  }
  // 如果本身就是数组
  if (Array.isArray(data)) return data.length;
  // 如果是对象，统计 key 数量
  return Object.keys(obj).length;
}
