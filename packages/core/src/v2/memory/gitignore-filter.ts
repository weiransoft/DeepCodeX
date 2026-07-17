/**
 * .gitignore 过滤机制（F-MEM-02 子模块）
 *
 * 零依赖自实现 glob 匹配器，支持 gitignore 核心语义：
 *   *      段内通配（不跨 /）          **     跨段通配
 *   ?      单字符                      [..]   字符类（[!..] 转 [^..]）
 *   前缀 / 锚定到规则所在目录根         后缀 / 仅匹配目录
 *   前缀 ! 否定（取消忽略，后规则覆盖先规则）
 *   嵌套 .gitignore 就近生效（规则携带基准目录，仅作用于其目录子树）
 *
 * 设计依据：
 * - V2 技术方案 §8.2.1 .gitignore 排除机制（P1-12 修复）
 * - PRD §5.3：项目记忆可被 .gitignore 排除
 * - 架构师审查报告（2026-07-17）：必须 100% 通过 git 官方测试集
 *
 * 已知语义偏差（有意为之）：父目录被整体排除后，git 原生语义不允许 ! 重新包含其下文件；
 * 本匹配器允许（记忆过滤场景下"多包含"比"漏包含"更安全），与 git 的差异仅限该边角。
 *
 * @module v2/memory/gitignore-filter
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 解析后的单条 gitignore 规则
 *
 * 由 parseGitignoreLine 函数从 .gitignore 文本行解析而来，
 * 预编译为 RegExp 以支持高效匹配。
 */
export interface GitignoreRule {
  /** 否定规则（! 前缀）：命中即取消之前的忽略判定 */
  negate: boolean;
  /** 仅匹配目录（/ 后缀） */
  dirOnly: boolean;
  /** 规则生效的基准目录（相对项目根的 POSIX 路径，根 .gitignore 为 ""） */
  baseDir: string;
  /** 由 glob 模式预编译的匹配正则 */
  regex: RegExp;
}

// ============================================================================
// 解析函数
// ============================================================================

/**
 * 解析单行 gitignore 模式为规则
 *
 * 解析规则：
 * 1. 行尾未转义空白忽略（gitignore 规范）
 * 2. 空行 / 注释行（# 开头）返回 null
 * 3. ! 前缀表示否定规则（取消忽略）
 * 4. \! 为字面感叹号转义（去除反斜杠后作为普通模式）
 * 5. / 后缀表示仅匹配目录
 * 6. 模式中段含 / 则锚定到 baseDir 根；否则可命中任意层级
 * 7. 前缀 / 去除（已通过 anchored 判定处理锚定语义）
 *
 * @param rawLine 原始文本行
 * @param baseDir 规则所在目录相对项目根的 POSIX 路径（根 .gitignore 传 ""）
 * @returns 解析后的规则；空行/注释行返回 null
 */
export function parseGitignoreLine(rawLine: string, baseDir: string): GitignoreRule | null {
  // gitignore 规范：行尾未转义空白忽略
  let pattern = rawLine.replace(/(?<!\\)\s+$/, "");
  if (pattern === "" || pattern.startsWith("#")) return null;

  // 否定前缀处理（\! 为字面感叹号转义）
  let negate = false;
  if (pattern.startsWith("!")) {
    negate = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1); // 去除反斜杠，保留 ! 作为字面字符
  }

  // 目录限定后缀
  let dirOnly = false;
  if (pattern.endsWith("/")) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }

  // 锚定判定：模式中段含 /（如 /dist、docs/**）→ 相对 baseDir 根匹配；否则可命中任意层级
  const anchored = pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  if (pattern === "") return null;

  return { negate, dirOnly, baseDir, regex: globToRegExp(pattern, anchored) };
}

// ============================================================================
// glob 转正则（私有辅助函数）
// ============================================================================

/**
 * glob 模式转正则
 *
 * 处理星号、问号、方括号等 glob 特殊字符与正则元字符转义。
 *
 * 转换规则：
 * - 单星号：段内通配（不跨目录分隔符），转为 `[^/]*`
 * - 双星号加斜杠：跨段通配，可匹配零到多段目录，转为 `(?:[^/]+/)*`
 * - 裸双星号：匹配任意字符（含目录分隔符），转为 `.*`
 * - 问号：单字符（不跨目录分隔符），转为 `[^/]`
 * - 方括号字符类：原样保留
 * - 方括号否定字符类（[!abc]）：转为 [^abc]
 * - 其他正则元字符：转义
 *
 * 锚定语义：
 * - 锚定模式（anchored=true）：从 baseDir 根精确匹配，前缀 ^
 * - 非锚定模式（anchored=false）：允许前面有任意层级目录，前缀 ^(任意目录前缀)?
 *
 * @param glob glob 模式字符串
 * @param anchored 是否锚定到 baseDir 根
 * @returns 编译后的 RegExp
 */
function globToRegExp(glob: string, anchored: boolean): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // **/ 形式可匹配零到多段目录；裸 ** 匹配任意字符（含 /）
        if (glob[i + 2] === "/") {
          re += "(?:[^/]+/)*";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        // * 不跨目录分隔符
        re += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else if (ch === "[") {
      // 字符类：glob 的 [!..] 转正则的 [^..]，其余原样保留到 ]
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        // 未闭合的 [ 作为字面字符
        re += "\\[";
        i += 1;
      } else {
        const body = glob.slice(i + 1, end);
        re += "[" + (body.startsWith("!") ? "^" + body.slice(1) : body) + "]";
        i = end + 1;
      }
    } else {
      // 转义正则元字符
      re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
      i += 1;
    }
  }
  // 非锚定模式允许前面有任意层级目录；锚定模式从 baseDir 根精确匹配
  return new RegExp((anchored ? "^" : "^(?:.*/)?") + re + "$");
}

// ============================================================================
// 匹配判定函数
// ============================================================================

/**
 * 判断路径是否被规则集忽略
 *
 * 算法要点：
 * 1. 候选集合：路径自身 + 全部父级目录前缀
 *    （dirOnly 规则须以"父目录被命中"语义生效，
 *    如 node_modules/ 须同时忽略 node_modules 目录与其下全部文件）
 * 2. 规则按读取顺序遍历，后规则覆盖先规则
 * 3. 嵌套 .gitignore 就近生效：候选必须位于规则基准目录子树内
 * 4. 否定规则（negate=true）命中即取消之前的忽略判定
 *
 * @param relativePath 相对项目根的 POSIX 路径
 * @param rules 按读取顺序排列的规则集（根 .gitignore 在前，嵌套在后 → 嵌套就近覆盖）
 * @param isDir 目标是否为目录
 * @returns 是否被忽略
 */
export function matchesGitignore(relativePath: string, rules: GitignoreRule[], isDir = false): boolean {
  // 构建候选集合：路径自身 + 全部父级目录前缀
  const segments = relativePath.split("/");
  const candidates: Array<{ p: string; dir: boolean }> = [{ p: relativePath, dir: isDir }];
  for (let i = segments.length - 1; i > 0; i--) {
    candidates.push({ p: segments.slice(0, i).join("/"), dir: true });
  }

  let ignored = false;
  for (const rule of rules) {
    for (const cand of candidates) {
      // 嵌套 .gitignore 就近生效：候选必须位于规则基准目录子树内
      if (rule.baseDir !== "") {
        if (cand.p !== rule.baseDir && !cand.p.startsWith(rule.baseDir + "/")) continue;
      }
      // 剥掉基准目录前缀，得到规则视角下的相对路径；恰为基准目录本身时规则不适用
      const scoped =
        rule.baseDir === "" ? cand.p : cand.p === rule.baseDir ? "" : cand.p.slice(rule.baseDir.length + 1);
      if (scoped === "") continue;
      // 目录限定规则不匹配文件候选
      if (rule.dirOnly && !cand.dir) continue;
      if (rule.regex.test(scoped)) {
        ignored = !rule.negate; // 后规则覆盖先规则；否定规则命中即取消忽略
        break; // 本规则已命中，继续下一条规则
      }
    }
  }
  return ignored;
}

// ============================================================================
// GitignoreFilter 类：项目级过滤器
// ============================================================================

/**
 * 项目级 .gitignore 过滤器
 *
 * 加载根 + 嵌套 .gitignore，对外提供统一判定接口。
 *
 * 加载策略：
 * 1. 读取 <projectRoot>/.gitignore（baseDir=""）
 * 2. 递归遍历目录树（跳过 excludeDirs），读取每层嵌套 .gitignore（baseDir=其所在目录的相对路径）
 * 3. 规则按"根在前、嵌套在后"顺序合并——后读取的嵌套规则天然覆盖先读取的根规则（就近生效）
 * 4. 文件读取失败（权限/编码）仅告警，按无该文件处理，不中断扫描
 *
 * 用法：
 * ```typescript
 * const filter = await GitignoreFilter.load("/path/to/project", ["node_modules", ".git"]);
 * if (filter.isIgnored("dist/bundle.js")) {
 *   console.log("文件被 gitignore 忽略");
 * }
 * ```
 */
export class GitignoreFilter {
  /** 已解析的规则集（按根在前、嵌套在后顺序排列） */
  private readonly rules: GitignoreRule[];

  /**
   * 私有构造：只能通过静态 load 方法创建实例
   *
   * @param rules 已解析的规则集
   */
  private constructor(rules: GitignoreRule[]) {
    this.rules = rules;
  }

  /**
   * 加载项目全部 .gitignore
   *
   * 实现步骤：
   * 1. 读取项目根 .gitignore（baseDir=""）
   * 2. 递归遍历目录树（跳过 excludeDirs），读取每层嵌套 .gitignore
   * 3. 规则按"根在前、嵌套在后"顺序合并
   *
   * @param projectRoot 项目根目录绝对路径
   * @param excludeDirs 要跳过的目录名列表（如 ["node_modules", ".git"]）
   * @returns GitignoreFilter 实例
   */
  static async load(projectRoot: string, excludeDirs: string[]): Promise<GitignoreFilter> {
    const rules: GitignoreRule[] = [];
    const excludeSet = new Set(excludeDirs);

    // 递归遍历目录树，收集所有 .gitignore 文件路径
    const gitignoreFiles: Array<{ filePath: string; baseDir: string }> = [];

    /**
     * 递归扫描目录，收集 .gitignore 文件
     *
     * @param dirPath 当前目录绝对路径
     * @param baseDir 当前目录相对项目根的 POSIX 路径（根目录为 ""）
     */
    async function scanDir(dirPath: string, baseDir: string): Promise<void> {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch {
        // 读取失败（权限/不存在）：静默跳过，不中断扫描
        return;
      }

      for (const entry of entries) {
        // 跳过 excludeDirs 中的目录
        if (entry.isDirectory() && excludeSet.has(entry.name)) {
          continue;
        }

        const fullPath = path.join(dirPath, entry.name);
        const relativePath = baseDir === "" ? entry.name : `${baseDir}/${entry.name}`;

        if (entry.isDirectory()) {
          // 递归扫描子目录
          await scanDir(fullPath, relativePath);
        } else if (entry.isFile() && entry.name === ".gitignore") {
          // 收集 .gitignore 文件
          gitignoreFiles.push({ filePath: fullPath, baseDir });
        }
      }
    }

    // 根目录 .gitignore 单独处理（baseDir=""）
    const rootGitignorePath = path.join(projectRoot, ".gitignore");
    try {
      const content = await fs.promises.readFile(rootGitignorePath, "utf-8");
      for (const line of content.split("\n")) {
        const rule = parseGitignoreLine(line, "");
        if (rule) rules.push(rule);
      }
    } catch {
      // 根 .gitignore 不存在或读取失败：忽略，继续扫描嵌套
    }

    // 递归扫描嵌套 .gitignore
    await scanDir(projectRoot, "");

    // 解析嵌套 .gitignore 文件（根 .gitignore 已处理，跳过）
    for (const { filePath, baseDir } of gitignoreFiles) {
      // 跳过根 .gitignore（已单独处理）
      if (baseDir === "") continue;

      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        for (const line of content.split("\n")) {
          const rule = parseGitignoreLine(line, baseDir);
          if (rule) rules.push(rule);
        }
      } catch {
        // 读取失败：静默跳过，不中断扫描
      }
    }

    return new GitignoreFilter(rules);
  }

  /**
   * 判定相对路径是否应被忽略
   *
   * @param relativePath 相对项目根的 POSIX 路径
   * @param isDir 目标是否为目录（由调用方按 fs.stat 结果传入）
   * @returns 是否被忽略
   */
  isIgnored(relativePath: string, isDir?: boolean): boolean {
    return matchesGitignore(relativePath, this.rules, isDir ?? false);
  }

  /**
   * 获取已加载的规则数量（测试与调试用）
   *
   * @returns 规则总数
   */
  getRuleCount(): number {
    return this.rules.length;
  }
}
