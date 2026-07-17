/**
 * Arity Dictionary 命令安全分类器（F-APPR-04）
 *
 * 基于命令前缀 + arity（位置词数）双重匹配，对 Shell 命令进行结构化分类。
 * 参考 DeepSeek-TUI crates/tui/src/command_safety.rs 的 Arity Dictionary 机制。
 *
 * 核心防注入原理：
 * 传统纯前缀匹配存在"git status 白名单误匹配 git push"的风险
 * （两者均以 "git " 开头）。Arity Dictionary 通过"前缀 + arity 双重约束"
 * 解决此问题：
 *   - "git status" 条目的 prefix="git status", arity=2
 *   - 命令 "git push" 的前两个词是 "git push" ≠ "git status"
 *   - 即使误配 prefix="git", arity=1，"git push" arity=2 也不匹配 arity=1
 *
 * 与 CommandSafety 的职责分工：
 * - CommandSafety：黑名单/白名单匹配 + 风险评分（0-100），服务于 ApprovalGate 决策
 * - CommandSafetyClassifier：结构化命令分类（safe/caution/dangerous）+ arity 防注入
 * 两者互补：CommandSafetyClassifier 提供"这条命令是什么"的结构化判断，
 * CommandSafety 提供"这条命令有多危险"的量化评估。
 *
 * V2-P0b 范围（§11.1）：精简至 20 条最常用命令。
 *
 * 设计依据：
 * - V2 技术方案 §4.2.2 CommandSafety（Arity Dictionary）
 * - V2 PRD §US-APPR-004：Arity Dictionary 命令安全
 * - V2 测试方案 §2.2 AG-08/AG-09：Arity 字典匹配测试
 *
 * @module v2/approval/arity-classifier
 */

/**
 * Arity 字典条目：描述一个已知命令前缀的安全属性
 *
 * 每条目由"命令前缀 + 词数 + 安全等级"三元组定义。
 * 匹配时，命令的前 N 个词（N=arity）必须与 prefix 完全一致（区分大小写），
 * 且后续字符为非词字符或字符串结尾（词边界），才算命中。
 */
export interface ArityEntry {
  /** 命令前缀（如 "git status"、"rm -rf"），由空格分隔的词组成 */
  prefix: string;
  /** 基础命令的词数（如 "git status" arity=2，"rm -rf" arity=2） */
  arity: number;
  /** 安全等级：safe（安全）/ caution（谨慎）/ dangerous（危险） */
  safety: "safe" | "caution" | "dangerous";
}

/**
 * 命令分类结果：CommandSafetyClassifier.classify 的输出
 *
 * 包含解析后的前缀、匹配的 arity、安全等级，
 * 以及是否在白名单/黑名单中的标志（从 ArityEntry 的 safety 推导）。
 */
export interface CommandClassification {
  /** 解析后的命令前缀（匹配到的字典条目的 prefix，未匹配则为命令首词） */
  resolvedPrefix: string;
  /** 匹配的 arity（命中字典条目的词数，未命中则为命令总词数） */
  arity: number;
  /** 安全等级（命中字典条目的 safety，未命中则为 "caution" 保守评估） */
  safety: "safe" | "caution" | "dangerous";
  /** 原始命令（归一化后） */
  rawCommand: string;
  /** 是否在白名单（safety === "safe" 的字典条目） */
  isWhitelisted: boolean;
  /** 是否在黑名单（safety === "dangerous" 的字典条目） */
  isBlacklisted: boolean;
}

/**
 * V2-P0b 预定义 Arity 字典（20 条最常用命令）
 *
 * 按 §11.1 "F-APPR-04：Arity Dictionary（精简至 20 条最常用）" 范围定义。
 * 涵盖 Git 操作、文件查看、构建测试、包管理、系统命令五大类。
 *
 * 安全等级划分原则：
 * - safe：只读、无副作用操作（ls、cat、git status、npm test）
 * - caution：有副作用但可控（git add、git commit、npm install、mv）
 * - dangerous：不可逆或高风险操作（rm -rf、git push --force、sudo）
 *
 * 注意：此字典独立于 CommandSafety 的 BUILTIN_BLACKLIST/BUILTIN_WHITELIST，
 * 两者数据不重复维护——Arity 字典专注于"结构化分类"，
 * CommandSafety 专注于"黑白名单匹配 + 风险评分"。
 */
export const DEFAULT_ARITY_DICTIONARY: readonly ArityEntry[] = [
  // === Git 只读命令（safe） ===
  { prefix: "git status", arity: 2, safety: "safe" },
  { prefix: "git log", arity: 2, safety: "safe" },
  { prefix: "git diff", arity: 2, safety: "safe" },
  { prefix: "git branch", arity: 2, safety: "safe" },
  // === Git 写命令（caution / dangerous） ===
  { prefix: "git add", arity: 2, safety: "caution" },
  { prefix: "git commit", arity: 2, safety: "caution" },
  { prefix: "git checkout", arity: 2, safety: "caution" },
  { prefix: "git push", arity: 2, safety: "dangerous" },
  { prefix: "git push --force", arity: 3, safety: "dangerous" },
  { prefix: "git reset --hard", arity: 3, safety: "dangerous" },
  // === 文件查看命令（safe） ===
  { prefix: "ls", arity: 1, safety: "safe" },
  { prefix: "cat", arity: 1, safety: "safe" },
  { prefix: "head", arity: 1, safety: "safe" },
  { prefix: "tail", arity: 1, safety: "safe" },
  // === 构建测试命令（safe） ===
  { prefix: "npm test", arity: 2, safety: "safe" },
  { prefix: "npm run", arity: 2, safety: "safe" },
  // === 包管理命令（caution） ===
  { prefix: "npm install", arity: 2, safety: "caution" },
  // === 危险命令（dangerous） ===
  { prefix: "rm", arity: 1, safety: "dangerous" },
  { prefix: "rm -rf", arity: 2, safety: "dangerous" },
  { prefix: "sudo", arity: 1, safety: "dangerous" },
];

/**
 * Arity Dictionary 命令安全分类器
 *
 * 使用预定义（或自定义）的 Arity 字典对 Shell 命令进行结构化分类。
 * 通过"前缀 + arity 双重匹配"防止命令注入和白名单误匹配。
 *
 * 用法：
 * ```typescript
 * const classifier = new CommandSafetyClassifier();
 * const result = classifier.classify("git status");
 * // → { resolvedPrefix: "git status", arity: 2, safety: "safe", isWhitelisted: true, isBlacklisted: false, ... }
 *
 * const result2 = classifier.classify("git push");
 * // → { resolvedPrefix: "git push", arity: 2, safety: "dangerous", isWhitelisted: false, isBlacklisted: true, ... }
 *
 * // US-APPR-004 核心验收：git push 不匹配 git status 规则
 * assert.ok(!result2.resolvedPrefix.startsWith("git status"));
 * ```
 */
export class CommandSafetyClassifier {
  /**
   * Arity 字典条目列表（按 specificity 降序预排序：prefix 词数多的优先匹配）
   *
   * 预排序在构造函数中一次性完成，避免 classify() 每次调用时重复排序。
   */
  private readonly sortedDictionary: readonly ArityEntry[];

  /**
   * 构造命令安全分类器
   *
   * 在构造时对字典按 prefix 词数降序预排序，确保 classify() 匹配时
   * 更具体的长前缀（如 "git push --force" arity=3）优先于短前缀
   *（如 "git push" arity=2）被匹配。预排序避免每次 classify 调用重复排序。
   *
   * @param customDictionary 自定义 Arity 字典（未提供时使用 DEFAULT_ARITY_DICTIONARY）
   */
  constructor(customDictionary?: ArityEntry[]) {
    const dict = customDictionary ?? DEFAULT_ARITY_DICTIONARY;
    // 预排序：按 prefix 词数降序（更具体的长前缀优先匹配）
    this.sortedDictionary = [...dict].sort((a, b) => b.prefix.split(" ").length - a.prefix.split(" ").length);
  }

  /**
   * 对命令进行结构化分类
   *
   * 匹配流程：
   * 1. 归一化命令（trim + 折叠多余空白）
   * 2. 将命令按空格拆分为词数组
   * 3. 遍历预排序字典条目（按 prefix 词数降序，优先匹配更具体的前缀）：
   *    a. 取命令前 N 个词（N = entry.arity）
   *    b. 拼接后与 entry.prefix 比较（区分大小写）
   *    c. 若一致，且第 N+1 个词位置为词边界（非词字符或结尾），则命中
   * 4. 命中时返回条目的 safety 等级；未命中时返回保守 "caution"
   *
   * @param command 原始命令字符串
   * @returns 命令分类结果
   */
  classify(command: string): CommandClassification {
    const normalized = this.normalizeCommand(command);
    const words = normalized === "" ? [] : normalized.split(" ");

    // 使用构造函数中预排序的字典（避免每次调用重复排序）
    for (const entry of this.sortedDictionary) {
      if (this.matchEntry(words, entry)) {
        return {
          resolvedPrefix: entry.prefix,
          arity: entry.arity,
          safety: entry.safety,
          rawCommand: normalized,
          isWhitelisted: entry.safety === "safe",
          isBlacklisted: entry.safety === "dangerous",
        };
      }
    }

    // 未命中任何字典条目：保守评估为 caution
    // 不归为 safe（避免未知命令被自动批准），也不归为 dangerous（避免过度阻断）
    return {
      resolvedPrefix: words.length > 0 ? words[0] : "",
      arity: words.length,
      safety: "caution",
      rawCommand: normalized,
      isWhitelisted: false,
      isBlacklisted: false,
    };
  }

  /**
   * 检查命令是否安全（safety === "safe"）
   *
   * 用于 ApprovalMode=suggest 时的快速判断：
   * 安全命令可自动批准，无需询问用户。
   *
   * @param command 原始命令字符串
   * @returns 安全返回 true，否则 false
   */
  isSafe(command: string): boolean {
    return this.classify(command).safety === "safe";
  }

  /**
   * 检查命令是否破坏性（safety === "dangerous"）
   *
   * 用于防御性检查：破坏性命令在任何模式下都应谨慎处理。
   *
   * @param command 原始命令字符串
   * @returns 破坏性返回 true，否则 false
   */
  isDestructive(command: string): boolean {
    return this.classify(command).safety === "dangerous";
  }

  /**
   * 判断命令词数组是否匹配某个 Arity 字典条目
   *
   * 匹配规则（prefix + arity 双重约束）：
   * 1. 命令的词数 >= entry.arity（命令至少要有 arity 个词）
   * 2. 命令前 entry.arity 个词拼接后 === entry.prefix（精确匹配）
   * 3. 若命令词数 > entry.arity，第 entry.arity 个词（0-based）之后
   *    必须是参数（即 prefix 已完整，后续为命令参数）
   *
   * 防注入示例：
   * - entry={prefix:"git status", arity:2}, command="git push"
   *   → words[0..1]=["git","push"] → join="git push" ≠ "git status" → 不匹配 ✓
   * - entry={prefix:"git status", arity:2}, command="git status"
   *   → words[0..1]=["git","status"] → join="git status" === "git status" → 匹配 ✓
   * - entry={prefix:"git status", arity:2}, command="git status --short"
   *   → words[0..1]=["git","status"] → join="git status" === "git status"
   *   → words.length=3 > arity=2，后续 "--short" 为参数 → 匹配 ✓
   *
   * @param words 命令拆分后的词数组
   * @param entry Arity 字典条目
   * @returns 是否匹配
   */
  private matchEntry(words: string[], entry: ArityEntry): boolean {
    // 命令词数不足，无法匹配
    if (words.length < entry.arity) {
      return false;
    }

    // 取命令前 arity 个词，拼接后与 entry.prefix 精确比较（区分大小写）
    const commandPrefix = words.slice(0, entry.arity).join(" ");
    if (commandPrefix !== entry.prefix) {
      return false;
    }

    // 若命令词数恰好等于 arity，说明命令只有前缀无参数，匹配成功
    if (words.length === entry.arity) {
      return true;
    }

    // 命令词数 > arity：后续词为参数，匹配成功
    // （prefix 已完整匹配，参数不影响分类——如 "git status --short" 仍归类为 "git status"）
    return true;
  }

  /**
   * 归一化命令：去除首尾空白，折叠多余空白为单个空格
   *
   * 确保 "git   status" 和 "git status" 被同等对待，
   * 避免因空白差异导致 arity 计算错误（多余空白会产生空词）。
   *
   * @param command 原始命令字符串
   * @returns 归一化后的命令
   */
  private normalizeCommand(command: string): string {
    return command.trim().replace(/\s+/g, " ");
  }
}
