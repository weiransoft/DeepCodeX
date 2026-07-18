/**
 * L1 全局视野（Repo Map）构建器实现（EAG-P1 批次 5）
 *
 * 本模块实现 `L1GlobalViewBuilder` 类，提供 EAG 方案 §5.11.1 L1 全局视野层的
 * 真实目录扫描与仓库地图构建逻辑。
 *
 * 核心职责：
 * - build(projectRoot)：递归扫描项目目录，构建 RepositoryMap
 * - shouldIgnore(path)：判定是否忽略目录/文件（node_modules/.git/dist/build 等）
 *
 * §5.11.1 L1 全局视野层设计要求：
 * - 目录树 + 模块职责标注：递归扫描项目目录，识别模块边界与职责
 * - 文件清单：扁平化全部文件，便于后续入口点检测与技术栈指纹提取
 *
 * 设计依据：
 * - EAG 方案 §5.11.1 L1 全局视野层
 * - Node.js fs/promises API（递归扫描目录）
 *
 * 不可变优先：
 * - build 返回冻结的 RepositoryMap
 * - 内部状态使用 readonly 修饰
 *
 * 实现说明：
 * - 不依赖外部 glob/ignore 库，使用 Node.js 内置 fs/promises
 * - 模块职责标注采用启发式规则（基于目录名识别 src/test/docs 等）
 * - 文件行数通过读取文件内容并按换行符切分计算（仅对文本文件）
 *
 * @module eag/pkc/l1-global-view
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { DirectoryNode, FileNode, RepositoryMap } from "./types";
import { DEFAULT_IGNORED_DIRECTORIES, DEFAULT_IGNORED_EXTENSIONS } from "./types";

// ============================================================================
// 模块职责标注规则（启发式识别）
// ============================================================================

/**
 * 模块职责标注规则表（基于目录名启发式识别）
 *
 * 键为目录名（小写），值为模块职责描述。
 * L1GlobalViewBuilder 在构建 DirectoryNode 时查表标注 moduleResponsibility。
 *
 * 覆盖常见目录：
 * - src：源代码
 * - test/tests/__tests__：单元测试
 * - spec/specs：规格测试
 * - docs：文档
 * - config：配置
 * - scripts：脚本
 * - bin：可执行入口
 * - public/static/assets：静态资源
 * - templates/views：模板/视图
 * - domain/application/interfaces/infrastructure：DDD 分层
 * - entities/use-cases/adapters/frameworks：Clean Architecture 分层
 * - command-side/query-side：CQRS 分层
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
const MODULE_RESPONSIBILITY_RULES: Readonly<Record<string, string>> = Object.freeze({
  // 通用目录
  src: "源代码",
  lib: "库代码",
  app: "应用代码",
  test: "单元测试",
  tests: "单元测试",
  __tests__: "单元测试",
  spec: "规格测试",
  specs: "规格测试",
  docs: "文档",
  doc: "文档",
  config: "配置",
  configs: "配置",
  scripts: "脚本",
  bin: "可执行入口",
  public: "静态资源",
  static: "静态资源",
  assets: "静态资源",
  templates: "模板/视图",
  views: "模板/视图",
  pages: "页面",
  components: "组件",
  // DDD 分层目录
  domain: "领域层（DDD）",
  application: "应用层（DDD）",
  interfaces: "接口层（DDD）",
  infrastructure: "基础设施层（DDD）",
  // Clean Architecture 分层目录
  entities: "实体层（Clean Architecture）",
  "use-cases": "用例层（Clean Architecture）",
  use_cases: "用例层（Clean Architecture）",
  usecases: "用例层（Clean Architecture）",
  adapters: "适配器层（Clean Architecture）",
  frameworks: "框架层（Clean Architecture）",
  // CQRS 分层目录
  "command-side": "命令侧（CQRS）",
  "query-side": "查询侧（CQRS）",
  commands: "命令（CQRS）",
  queries: "查询（CQRS）",
  projections: "投影（CQRS-ES）",
  events: "领域事件（CQRS-ES）",
  // 微服务目录
  services: "微服务",
  gateway: "API 网关",
  // 其他常见目录
  models: "数据模型",
  controllers: "控制器",
  services_dir: "服务",
  repositories: "仓储",
  utils: "工具函数",
  helpers: "辅助函数",
  types: "类型定义",
  typescript: "TypeScript 源码",
  javascript: "JavaScript 源码",
  java: "Java 源码",
  python: "Python 源码",
  go: "Go 源码",
});

// ============================================================================
// 异常类型
// ============================================================================

/**
 * L1 全局视野构建错误（路径不存在或扫描失败时抛出）
 */
export class L1GlobalViewError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-path：路径非法
   *   - path-not-found：路径不存在
   *   - scan-error：扫描失败
   * @param detail 错误详情
   */
  constructor(
    public readonly kind: "invalid-path" | "path-not-found" | "scan-error",
    public readonly detail: string
  ) {
    super(`L1 全局视野构建错误 [${kind}]：${detail}`);
    this.name = "L1GlobalViewError";
  }
}

// ============================================================================
// L1GlobalViewBuilder 类
// ============================================================================

/**
 * L1 全局视野构建器（实现 §5.11.1 L1 全局视野层）
 *
 * 提供真实目录扫描逻辑（禁止 mock）：
 * - build(projectRoot)：递归扫描项目目录，构建 RepositoryMap
 *   - 跳过 shouldIgnore 判定为 true 的目录/文件
 *   - 递归构建 DirectoryNode 树（含 moduleResponsibility 标注）
 *   - 扁平化收集 FileNode 列表（含 extension / lines）
 *   - 统计 totalFiles / totalDirectories
 * - shouldIgnore(path)：判定是否忽略目录/文件
 *   - 忽略 DEFAULT_IGNORED_DIRECTORIES 中的目录名
 *   - 忽略 DEFAULT_IGNORED_EXTENSIONS 中的文件扩展名
 *
 * 使用方式：
 * ```typescript
 * const builder = new L1GlobalViewBuilder();
 * const map = await builder.build("/path/to/project");
 * console.log(map.totalFiles, map.totalDirectories);
 * ```
 */
export class L1GlobalViewBuilder {
  /**
   * 忽略的目录名集合（不可变，构造时确定）
   *
   * 默认使用 DEFAULT_IGNORED_DIRECTORIES，调用方可通过构造函数注入自定义列表。
   */
  private readonly ignoredDirectories: ReadonlySet<string>;

  /**
   * 忽略的文件扩展名集合（不可变，构造时确定）
   *
   * 默认使用 DEFAULT_IGNORED_EXTENSIONS，调用方可通过构造函数注入自定义列表。
   */
  private readonly ignoredExtensions: ReadonlySet<string>;

  /**
   * @param ignoredDirectories 忽略的目录名列表（默认使用 DEFAULT_IGNORED_DIRECTORIES）
   * @param ignoredExtensions 忽略的文件扩展名列表（默认使用 DEFAULT_IGNORED_EXTENSIONS）
   */
  constructor(
    ignoredDirectories: ReadonlyArray<string> = DEFAULT_IGNORED_DIRECTORIES,
    ignoredExtensions: ReadonlyArray<string> = DEFAULT_IGNORED_EXTENSIONS
  ) {
    this.ignoredDirectories = new Set(ignoredDirectories);
    this.ignoredExtensions = new Set(ignoredExtensions);
  }

  /**
   * 判定是否忽略指定路径（目录或文件）
   *
   * 判定规则：
   * - 目录：basename 在 ignoredDirectories 集合中 → 忽略
   * - 文件：扩展名在 ignoredExtensions 集合中 → 忽略
   * - 隐藏文件/目录（以 . 开头，但 .git 已在 ignoredDirectories 中）：
   *   除 .git/.vscode 等已显式忽略的外，其他隐藏文件保留（如 .env / .eslintrc）
   *
   * @param filePath 文件/目录路径（相对或绝对均可）
   * @param isDirectory 是否为目录（true=目录，false=文件）
   * @returns true=忽略，false=保留
   */
  shouldIgnore(filePath: string, isDirectory: boolean = false): boolean {
    // 提取 basename（如 "node_modules" / "index.ts"）
    const basename = path.basename(filePath);

    // 目录判定：basename 在 ignoredDirectories 集合中
    if (isDirectory) {
      return this.ignoredDirectories.has(basename);
    }

    // 文件判定：扩展名在 ignoredExtensions 集合中
    const ext = path.extname(filePath).toLowerCase();
    if (ext && this.ignoredExtensions.has(ext)) {
      return true;
    }

    return false;
  }

  /**
   * 递归扫描项目目录，构建 RepositoryMap
   *
   * 执行流程：
   * 1. 校验 projectRoot 存在且为目录
   * 2. 递归扫描 projectRoot，构建 DirectoryNode 树（含 moduleResponsibility 标注）
   * 3. 扁平化收集 FileNode 列表（含 extension / lines）
   * 4. 统计 totalFiles / totalDirectories
   * 5. 冻结并返回 RepositoryMap
   *
   * @param projectRoot 项目根目录绝对路径
   * @returns 冻结的 RepositoryMap
   * @throws {L1GlobalViewError} 路径不存在或扫描失败时抛出
   */
  async build(projectRoot: string): Promise<RepositoryMap> {
    // 校验入参：projectRoot 必须为非空字符串
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new L1GlobalViewError("invalid-path", "projectRoot 必须为非空字符串");
    }

    // 校验路径存在且为目录
    let rootStat;
    try {
      rootStat = await fs.stat(projectRoot);
    } catch (err) {
      throw new L1GlobalViewError("path-not-found", `项目根目录不存在：${projectRoot}（${(err as Error).message}）`);
    }
    if (!rootStat.isDirectory()) {
      throw new L1GlobalViewError("invalid-path", `projectRoot 必须为目录，实际为文件：${projectRoot}`);
    }

    // 解析为绝对路径（便于后续 path.relative 计算）
    const absoluteRoot = path.resolve(projectRoot);

    // 递归扫描根目录
    const directories: DirectoryNode[] = [];
    const files: FileNode[] = [];
    let dirCount = 0;

    // 读取根目录下的条目
    let rootEntries;
    try {
      rootEntries = await fs.readdir(absoluteRoot, { withFileTypes: true });
    } catch (err) {
      throw new L1GlobalViewError("scan-error", `扫描根目录失败：${absoluteRoot}（${(err as Error).message}）`);
    }

    // 按 basename 字典序排序，保证结果稳定可重放
    const sortedEntries = [...rootEntries].sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sortedEntries) {
      const entryPath = path.join(absoluteRoot, entry.name);
      const relativePath = path.relative(absoluteRoot, entryPath);

      if (entry.isDirectory()) {
        // 目录：检查是否忽略
        if (this.shouldIgnore(entry.name, true)) {
          continue;
        }
        // 递归扫描子目录
        const subDir = await this.scanDirectory(entryPath, relativePath, files);
        if (subDir) {
          directories.push(subDir);
          dirCount += 1 + this.countDirectoriesRecursive(subDir);
        }
      } else if (entry.isFile()) {
        // 文件：检查是否忽略
        if (this.shouldIgnore(entry.name, false)) {
          continue;
        }
        // 收集文件节点
        const fileNode = await this.buildFileNode(relativePath, entry.name, entryPath);
        files.push(fileNode);
      }
      // 符号链接与其他类型跳过（避免循环引用与未知错误）
    }

    // 构建并冻结 RepositoryMap
    return Object.freeze({
      rootPath: absoluteRoot,
      directories: Object.freeze(directories.map((d) => this.freezeDirectoryNode(d))),
      files: Object.freeze(files.map((f) => Object.freeze({ ...f }))),
      totalFiles: files.length,
      totalDirectories: dirCount,
    });
  }

  // ============================ 私有辅助方法 ============================

  /**
   * 递归扫描子目录，构建 DirectoryNode 树
   *
   * 同时将子目录下的文件收集到 files 数组（扁平化）。
   *
   * @param absolutePath 子目录绝对路径
   * @param relativePath 子目录相对路径（相对于 rootPath）
   * @param files 文件收集数组（扁平化，所有文件都加入此数组）
   * @returns DirectoryNode（若目录被完全忽略返回 null）
   */
  private async scanDirectory(
    absolutePath: string,
    relativePath: string,
    files: FileNode[]
  ): Promise<DirectoryNode | null> {
    const name = path.basename(absolutePath);

    // 查表标注模块职责
    const moduleResponsibility = MODULE_RESPONSIBILITY_RULES[name.toLowerCase()];

    // 读取子目录条目
    let entries;
    try {
      entries = await fs.readdir(absolutePath, { withFileTypes: true });
    } catch (err) {
      // 扫描失败时记录错误并返回空目录（不抛出，避免单点失败导致整体扫描中断）
      console.warn(`[L1GlobalViewBuilder] 扫描子目录失败：${absolutePath}（${(err as Error).message}）`);
      return {
        path: relativePath,
        name,
        moduleResponsibility,
        children: [],
      };
    }

    // 按 basename 字典序排序
    const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));

    const children: DirectoryNode[] = [];
    for (const entry of sortedEntries) {
      const entryAbsPath = path.join(absolutePath, entry.name);
      // 拼接相对于 rootPath 的路径（使用 / 作为分隔符，保证跨平台一致）
      const entryRelPathFromRoot = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;

      if (entry.isDirectory()) {
        // 子目录：检查是否忽略
        if (this.shouldIgnore(entry.name, true)) {
          continue;
        }
        const subDir = await this.scanDirectory(entryAbsPath, entryRelPathFromRoot, files);
        if (subDir) {
          children.push(subDir);
        }
      } else if (entry.isFile()) {
        // 文件：检查是否忽略
        if (this.shouldIgnore(entry.name, false)) {
          continue;
        }
        const fileNode = await this.buildFileNode(entryRelPathFromRoot, entry.name, entryAbsPath);
        files.push(fileNode);
      }
    }

    return {
      path: relativePath,
      name,
      moduleResponsibility,
      children,
    };
  }

  /**
   * 构建文件节点（含行数计算）
   *
   * 行数计算策略：
   * - 文本文件（.ts/.js/.java/.py/.go/.md/.json/.yml/.yaml/.xml 等）：读取内容按换行符切分
   * - 二进制文件（.png/.jpg 等已忽略）：不计算行数
   * - 读取失败：lines=0（不抛出，避免单点失败导致整体扫描中断）
   *
   * @param relativePath 文件相对路径（相对于 rootPath）
   * @param name 文件名（含扩展名）
   * @param absolutePath 文件绝对路径
   * @returns FileNode
   */
  private async buildFileNode(relativePath: string, name: string, absolutePath: string): Promise<FileNode> {
    const extension = path.extname(name).toLowerCase();

    // 仅对文本文件计算行数（避免读取大二进制文件）
    const textExtensions = new Set([
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".java",
      ".kt",
      ".scala",
      ".py",
      ".go",
      ".rs",
      ".md",
      ".markdown",
      ".json",
      ".jsonc",
      ".yml",
      ".yaml",
      ".xml",
      ".html",
      ".css",
      ".scss",
      ".less",
      ".toml",
      ".ini",
      ".cfg",
      ".conf",
      ".txt",
      ".log",
      ".sh",
      ".bash",
      ".zsh",
      ".sql",
      ".env",
    ]);

    let lines = 0;
    if (textExtensions.has(extension)) {
      try {
        const content = await fs.readFile(absolutePath, "utf-8");
        // 按换行符切分计算行数（空文件为 0 行，有内容则为行数）
        if (content.length === 0) {
          lines = 0;
        } else {
          // 按 \n 切分，末尾若以 \n 结尾则不计最后一行空字符串
          const lineCount = content.split("\n").length;
          lines = content.endsWith("\n") ? lineCount - 1 : lineCount;
          // 保证至少为 1 行（非空文件）
          if (lines === 0) lines = 1;
        }
      } catch {
        // 读取失败：lines 保持为 0
        lines = 0;
      }
    }

    return {
      path: relativePath,
      name,
      extension,
      lines,
    };
  }

  /**
   * 递归冻结 DirectoryNode（深度冻结，含所有子节点）
   *
   * @param node 待冻结的目录节点
   * @returns 冻结后的目录节点
   */
  private freezeDirectoryNode(node: DirectoryNode): DirectoryNode {
    return Object.freeze({
      path: node.path,
      name: node.name,
      moduleResponsibility: node.moduleResponsibility,
      children: Object.freeze(node.children.map((child) => this.freezeDirectoryNode(child))),
    });
  }

  /**
   * 递归统计 DirectoryNode 子目录数量
   *
   * @param node 目录节点
   * @returns 子目录总数（不含自身）
   */
  private countDirectoriesRecursive(node: DirectoryNode): number {
    let count = node.children.length;
    for (const child of node.children) {
      count += this.countDirectoriesRecursive(child);
    }
    return count;
  }
}
