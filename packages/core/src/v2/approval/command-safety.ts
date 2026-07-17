/**
 * 命令安全检查器（CommandSafety）
 *
 * 负责黑名单/白名单匹配和命令风险评分。
 * 黑名单检查优先于所有其他判断（F-07 安全修复），
 * 即使命令在 auto/yolo 模式下也必须先过黑名单这一关。
 *
 * 设计依据：
 * - V2.1 技术方案 §4.2.3 CommandSafety
 * - V2.1 评审修复 F-07：黑名单检查必须先于 ApprovalMode 判断
 * - V2.3 修复计划 P1-03：黑名单/白名单数据单一事实源（本文件为唯一来源）
 *
 * 匹配策略（三种）：
 * 1. 管道模式（pipe）：形如 "curl | sh" 的模式，允许中间有 URL 等参数，
 *    使用正则匹配。仅对 curl/wget 管道到 sh/bash 的远程脚本执行场景。
 * 2. 路径/设备前缀模式（startsWith）：以 "/" 结尾（如 "rm -rf /"）或
 *    以 "of=/dev/sd" 结尾（如 "dd if=/dev/zero of=/dev/sd"）的模式，
 *    使用纯前缀匹配，因为后续字符是路径/设备名的延续。
 * 3. 词边界模式（word-boundary）：其他所有模式，使用"精确匹配 或
 *    前缀匹配且后续字符为非词字符（空格、/、. 等）"的规则，
 *    避免 "main" 误匹配 "maintenance" 这类假阳性。
 *
 * 单一事实源（V2.3 P1-03 修复）：
 * 本文件是全库命令安全黑白名单数据的唯一存放位置，共导出四份名单：
 * - BUILTIN_BLACKLIST / BUILTIN_WHITELIST：普通字符串模式（plain 格式），
 *   供 V2 CommandSafety 三策略匹配引擎消费；
 * - BUILTIN_BLACKLIST_REGEX / BUILTIN_WHITELIST_REGEX：正则源码模式（regex 格式），
 *   供 V1 SmartConfirmation（team/autonomous/smart-confirmation.ts）正则引擎消费。
 * 两种格式并存的原因：V1 引擎为 IGNORECASE 正则匹配（覆盖面更大，含数据库/
 * 系统命令），V2 引擎为词边界精确匹配（避免 maintenance 被 main 误伤），
 * 两者匹配语义不同，强行统一格式必然改变一侧已钉住的行为（详见技术方案 §9.3
 * 职责分工矩阵）。数据集中一处后，任何名单增删只需修改本文件。
 *
 * 风险评分规则（0-100）：
 * - 白名单命令：5 分（benign）
 * - rm：基础 60 + (-rf +20) + (根目录 / +20 / 家目录 ~ +15 / 绝对路径 +10)
 * - git push：基础 50 + (--force +30) + (origin main/master +10)
 * - npm install / pip install：基础 40（caution，可能安装恶意包）
 * - curl / wget：基础 50（caution，网络访问）
 * - chmod：基础 50 + (777 +20)
 * - mkdir：10 / touch：5 / cd：0
 * - 默认未知命令：30（benign 边界，保守评估）
 */

import type { RiskAssessment, RiskLevel } from "./types";

/**
 * 内置黑名单（plain 格式）：匹配到的命令一律 deny（无论 ApprovalMode）
 *
 * 包含三类危险操作：
 * - 危险删除：rm -rf /、rm -rf ~、sudo rm 等
 * - 磁盘破坏：mkfs、dd 覆写设备
 * - 危险推送：强制推送主分支
 * - 远程脚本执行：curl/wget 管道到 sh/bash
 * - 系统破坏：fork 炸弹、全局权限修改
 *
 * V2.3 P1-03：本名单为全库黑名单数据的单一事实源之一（plain 格式），
 * 供 V2 CommandSafety 三策略匹配引擎消费；V1 正则引擎请使用
 * 下方 BUILTIN_BLACKLIST_REGEX。
 */
export const BUILTIN_BLACKLIST: string[] = [
  // 危险删除命令（路径前缀模式，以 / 结尾）
  "rm -rf /",
  "rm -rf ~",
  "rm -rf $HOME",
  "rm -rf /*",
  // sudo 删除（词边界模式）
  "sudo rm",
  // 磁盘格式化/覆写（mkfs 词边界，dd 设备前缀）
  "mkfs",
  "dd if=/dev/zero of=/dev/sd",
  // fork 炸弹（精确匹配）
  ":(){ :|:& };:",
  // 全局权限修改（路径前缀模式，以 / 结尾）
  "chmod -R 777 /",
  // 强制推送主分支（词边界模式）
  "git push --force origin main",
  "git push --force origin master",
  "git push -f origin main",
  "git push -f origin master",
  // 管道执行远程脚本（管道模式，正则匹配）
  "curl | sh",
  "curl | bash",
  "wget | sh",
  "wget | bash",
];

/**
 * 内置白名单（plain 格式）：匹配到的命令视为低风险（benign），可自动批准
 *
 * 仅包含无副作用的只读命令：列目录、查看文件、git 查询、版本查询等。
 * 白名单匹配使用词边界规则，避免 "ls" 误匹配 "lsxyz" 这类假阳性。
 *
 * V2.3 P1-03：本名单为全库白名单数据的单一事实源之一（plain 格式），
 * 供 V2 CommandSafety 词边界匹配引擎消费；V1 正则引擎请使用
 * 下方 BUILTIN_WHITELIST_REGEX。
 */
export const BUILTIN_WHITELIST: string[] = [
  // 文件/目录查看
  "ls",
  "pwd",
  "cat",
  "echo",
  "grep",
  "find",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  // git 只读查询
  "git status",
  "git log",
  "git diff",
  "git branch",
  // 版本查询
  "node --version",
  "npm --version",
  "python --version",
  // 系统信息查询
  "which",
  "whereis",
  "file",
  "stat",
  "ps",
  "top",
  "df",
  "du",
];

// ============================================================================
// V1 正则格式名单（V2.3 P1-03 单一事实源）
//
// 以下两份名单迁移自 team/autonomous/smart-confirmation.ts（原 DEFAULT_BLACKLIST /
// DEFAULT_WHITELIST），供 V1 SmartConfirmation 的 IGNORECASE 正则引擎消费。
// 与上方 plain 格式名单的关系：
// - plain 格式服务 V2 词边界/前缀/管道三策略引擎，强调防误伤（maintenance 不被 main 命中）；
// - regex 格式服务 V1 正则引擎，覆盖面更大（含数据库破坏、系统控制、反向 shell 等模式），
//   且逐条预编译为 IGNORECASE 正则，匹配语义与 V2 不同。
// 两侧引擎语义已在各自测试中钉住，故按技术方案 §9.3 职责分工矩阵保留两种格式，
// 数据集中本文件一处维护：任何名单增删只需修改本文件，V1/V2 同步生效。
// ============================================================================

/**
 * 内置黑名单（regex 格式，V1 SmartConfirmation 正则引擎专用）
 *
 * 每条为正则源码字符串，由 V1 侧以 `new RegExp(pattern, "i")` 预编译（IGNORECASE）。
 * 注意：
 * - 路径结尾使用 (\s|$) 而非 \b，因为 / 不是 word char；
 * - 覆盖面大于 V2 plain 名单：含数据库破坏、系统控制、反向 shell、危险包管理等
 *   V1 autonomous 模式特有的防护场景。
 */
export const BUILTIN_BLACKLIST_REGEX: ReadonlyArray<string> = [
  // rm -rf 危险路径
  "\\brm\\s+-rf\\s+/\\s",
  "\\brm\\s+-rf\\s+/\\s*$",
  "\\brm\\s+-rf\\s+~",
  "\\brm\\s+-rf\\s+\\*",
  "\\brm\\s+-rf\\s+/etc",
  "\\brm\\s+-rf\\s+/var",
  "\\brm\\s+-rf\\s+/usr",
  "\\brm\\s+-rf\\s+/bin",
  "\\brm\\s+-rf\\s+/sbin",
  "\\brm\\s+-rf\\s+/boot",
  "\\brm\\s+-rf\\s+/lib",
  "\\brm\\s+-rf\\s+/lib64",
  "\\brm\\s+-rf\\s+/opt",
  "\\brm\\s+-rf\\s+/root",
  "\\brm\\s+-rf\\s+/home",
  // git 危险操作
  "\\bgit\\s+push\\s+(--force|-f)\\b",
  "\\bgit\\s+reset\\s+--hard\\s+origin",
  "\\bgit\\s+clean\\s+-fd\\b",
  "\\bgit\\s+clean\\s+-fdx\\b",
  // 磁盘与系统破坏
  "\\bdd\\s+if=",
  "\\bmkfs\\b",
  ">\\s*/dev/sd[a-z]",
  ">\\s*/dev/nvme",
  // 数据库破坏
  "\\bdrop\\s+(database|table|schema|view|index|function|procedure|trigger)\\b",
  "\\btruncate\\s+table\\b",
  "\\btruncate\\s+\\w+\\s*;",
  // 远程脚本执行（curl/wget | bash/sh）
  "\\bcurl\\s+.*\\|\\s*bash\\b",
  "\\bcurl\\s+.*\\|\\s*sh\\b",
  "\\bwget\\s+.*\\|\\s*bash\\b",
  "\\bwget\\s+.*\\|\\s*sh\\b",
  // 权限破坏
  "\\bchmod\\s+-R\\s+777\\s+/",
  "\\bchmod\\s+777\\s+/",
  // fork bomb
  ":\\(\\)\\s*\\{\\s*:\\|:\\s*&\\s*\\}\\s*;\\s*:",
  // sudo + 危险命令
  "\\bsudo\\s+rm\\b",
  "\\bsudo\\s+dd\\b",
  "\\bsudo\\s+mkfs\\b",
  "\\bsudo\\s+chmod\\s+777\\s+/",
  "\\bsudo\\s+chown\\s+-R\\s+",
  "\\bsudo\\s+kill\\b",
  "\\bsudo\\s+killall\\b",
  "\\bsudo\\s+shutdown\\b",
  "\\bsudo\\s+reboot\\b",
  "\\bsudo\\s+halt\\b",
  "\\bsudo\\s+init\\b",
  "\\bsudo\\s+apt\\b",
  "\\bsudo\\s+apt-get\\b",
  "\\bsudo\\s+yum\\b",
  "\\bsudo\\s+dnf\\b",
  "\\bsudo\\s+pip\\b",
  "\\bsudo\\s+npm\\b",
  "\\bsudo\\s+bash\\b",
  "\\bsudo\\s+sh\\b",
  // 杀 init / 关键进程
  "\\bkill\\s+-9\\s+1\\b",
  "\\bkill\\s+-9\\s+0\\b",
  "\\bkill\\s+-\\s*SIGKILL\\s+1\\b",
  "\\bkillall\\s+-9\\s+init\\b",
  "\\bkillall\\s+-9\\s+(init|sshd|systemd|kthreadd)\\b",
  "\\bkillall\\s+-9\\s+python\\b",
  "\\bkillall\\s+-9\\s+node\\b",
  // 强制重装 / 危险包管理
  "\\bpip\\s+install\\s+.*--force-reinstall",
  "\\bpip\\s+install\\s+.*--ignore-installed",
  "\\bnpm\\s+install\\s+-g\\s+.*--force",
  "\\bapt[(-get)?]\\s+install\\s+.*-y\\s+--force-yes",
  // 系统控制
  "\\bshutdown\\b",
  "\\breboot\\b",
  "\\bhalt\\b",
  "\\bpoweroff\\b",
  "\\bsystemctl\\s+(stop|disable|mask)\\s+(ssh|sshd|network|systemd-resolved)\\b",
  // eval 反向 shell
  "\\bbash\\s+-i\\s+>&\\s*/dev/tcp/",
  "\\bnc\\s+-l\\s+-p\\s+",
  "\\bnetcat\\s+-l\\s+-p\\s+",
];

/**
 * 内置白名单（regex 格式，V1 SmartConfirmation 正则引擎专用）
 *
 * 每条为以 ^ 锚定开头的正则源码字符串，由 V1 侧以 `new RegExp(pattern, "i")`
 * 预编译（IGNORECASE）。命中即直接 AUTO + LOW 风险，覆盖测试/lint/构建/只读查询等
 * autonomous 模式下的高频安全命令。
 */
export const BUILTIN_WHITELIST_REGEX: ReadonlyArray<string> = [
  "^python3?\\s+-m\\s+pytest",
  "^python3?\\s+-m\\s+unittest",
  "^pytest\\b",
  "^npm\\s+test\\b",
  "^npm\\s+run\\s+(test|lint|build|check)",
  "^yarn\\s+test\\b",
  "^pnpm\\s+test\\b",
  "^cargo\\s+test\\b",
  "^go\\s+test\\b",
  "^mvn\\s+test\\b",
  "^gradle\\s+test\\b",
  "^ruff\\b",
  "^black\\b",
  "^flake8\\b",
  "^mypy\\b",
  "^eslint\\b",
  "^prettier\\b",
  "^git\\s+status\\b",
  "^git\\s+log\\b",
  "^git\\s+diff\\b",
  "^git\\s+branch\\b",
  "^git\\s+add\\b",
  "^git\\s+commit\\b",
  "^git\\s+fetch\\b",
  "^ls\\b",
  "^cat\\b",
  "^head\\b",
  "^tail\\b",
  "^find\\b",
  "^grep\\b",
  "^rg\\b",
  "^tree\\b",
  "^pwd\\b",
  "^echo\\b",
  "^wc\\b",
];

/**
 * 编译后的黑名单条目：将原始字符串编译为可执行的匹配函数
 *
 * 编译阶段根据模式特征分类，避免在每次 isBlacklisted 调用时重复判断类型。
 */
interface CompiledBlacklistEntry {
  /** 原始模式字符串（用于日志和调试） */
  raw: string;
  /** 匹配函数：输入归一化后的命令，返回是否匹配 */
  match: (normalizedCommand: string) => boolean;
}

/**
 * 命令安全检查器
 *
 * 提供 isBlacklisted / isWhitelisted / assessRisk 三个核心方法，
 * 是 ApprovalGate 决策流程第 1 步（黑名单检查）和第 4c 步（bash 风险分类）的实现基础。
 *
 * 用法：
 * ```typescript
 * const safety = new CommandSafety();
 * if (safety.isBlacklisted("rm -rf /")) { /* 拒绝 *\/ }
 * const assessment = safety.assessRisk("npm install express");
 * ```
 */
export class CommandSafety {
  /** 编译后的黑名单条目列表（内置 + 自定义） */
  private blacklist: CompiledBlacklistEntry[];
  /** 白名单集合（内置 + 自定义，使用词边界匹配） */
  private whitelist: string[];

  /**
   * 构造命令安全检查器
   *
   * @param customBlacklist 自定义黑名单条目（追加到内置黑名单之后）
   * @param customWhitelist 自定义白名单条目（追加到内置白名单之后）
   */
  constructor(customBlacklist: string[] = [], customWhitelist: string[] = []) {
    // 编译所有黑名单条目（内置 + 自定义），转换为匹配函数
    this.blacklist = [
      ...BUILTIN_BLACKLIST.map((raw) => this.compileBlacklistEntry(raw)),
      ...customBlacklist.map((raw) => this.compileBlacklistEntry(raw)),
    ];
    // 合并白名单（内置 + 自定义），保留为字符串数组供词边界匹配
    this.whitelist = [...BUILTIN_WHITELIST, ...customWhitelist];
  }

  /**
   * 检查命令是否在黑名单中（最高优先级，无论 ApprovalMode 都拒绝）
   *
   * 匹配流程：
   * 1. 归一化命令（trim + 折叠多余空白）
   * 2. 遍历编译后的黑名单条目，调用各自的 match 函数
   * 3. 任一匹配即返回 true
   *
   * @param command 原始命令字符串
   * @returns 命中黑名单返回 true，否则 false
   */
  isBlacklisted(command: string): boolean {
    const normalized = this.normalizeCommand(command);
    // 空命令不命中黑名单（空命令的风险由 assessRisk 处理）
    if (normalized === "") {
      return false;
    }
    // 遍历黑名单，任一匹配即拒绝
    for (const entry of this.blacklist) {
      if (entry.match(normalized)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 检查命令是否在白名单中（低风险，可自动批准）
   *
   * 使用词边界匹配：精确相等 或 前缀匹配且后续字符为非词字符。
   * 避免短命令名误匹配长命令（如 "ls" 不应匹配 "lsxyz"）。
   *
   * @param command 原始命令字符串
   * @returns 命中白名单返回 true，否则 false
   */
  isWhitelisted(command: string): boolean {
    const normalized = this.normalizeCommand(command);
    if (normalized === "") {
      return false;
    }
    // 遍历白名单，使用词边界规则匹配
    for (const pattern of this.whitelist) {
      if (this.matchWordBoundary(normalized, pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 计算命令的风险评分（0-100）
   *
   * 评分优先级：
   * 1. 白名单命令 → 5 分（benign，低风险）
   * 2. rm 命令 → 评估删除目标危险性
   * 3. git push → 评估强制推送和主分支
   * 4. npm/pip install → 40 分（caution，可能安装恶意包）
   * 5. curl/wget → 50 分（caution，网络访问）
   * 6. chmod → 评估权限修改范围
   * 7. mkdir/touch/cd → 低风险基础分
   * 8. 默认 → 30 分（benign 边界）
   *
   * @param command 原始命令字符串
   * @returns 风险评估结果（含评分、等级、原因）
   */
  assessRisk(command: string): RiskAssessment {
    const normalized = this.normalizeCommand(command);

    // 空命令：保守评估为默认基础分
    if (normalized === "") {
      return {
        score: 30,
        level: this.getRiskLevel(30),
        reason: "空命令，默认基础分",
      };
    }

    // 白名单命令：低风险，直接返回
    if (this.isWhitelisted(normalized)) {
      return {
        score: 5,
        level: this.getRiskLevel(5),
        reason: "白名单命令，低风险",
      };
    }

    // rm 删除命令：评估 -rf 标志和目标路径危险性
    if (normalized === "rm" || normalized.startsWith("rm ")) {
      return this.assessRmRisk(normalized);
    }

    // git push 推送命令：评估强制推送和主分支
    if (normalized === "git push" || normalized.startsWith("git push ")) {
      return this.assessGitPushRisk(normalized);
    }

    // npm install：可能安装恶意包
    if (
      normalized === "npm install" ||
      normalized.startsWith("npm install ") ||
      normalized === "npm i" ||
      normalized.startsWith("npm i ")
    ) {
      return {
        score: 40,
        level: this.getRiskLevel(40),
        reason: "npm install 可能安装恶意包",
      };
    }

    // pip install：可能安装恶意包
    if (
      normalized === "pip install" ||
      normalized.startsWith("pip install ") ||
      normalized === "pip3 install" ||
      normalized.startsWith("pip3 install ")
    ) {
      return {
        score: 40,
        level: this.getRiskLevel(40),
        reason: "pip install 可能安装恶意包",
      };
    }

    // curl / wget：网络访问
    if (
      normalized === "curl" ||
      normalized.startsWith("curl ") ||
      normalized === "wget" ||
      normalized.startsWith("wget ")
    ) {
      return {
        score: 50,
        level: this.getRiskLevel(50),
        reason: "网络访问命令",
      };
    }

    // chmod 权限修改：评估是否含 777
    if (normalized === "chmod" || normalized.startsWith("chmod ")) {
      return this.assessChmodRisk(normalized);
    }

    // mkdir 创建目录：低风险
    if (normalized === "mkdir" || normalized.startsWith("mkdir ")) {
      return {
        score: 10,
        level: this.getRiskLevel(10),
        reason: "mkdir 创建目录",
      };
    }

    // touch 创建文件：低风险
    if (normalized === "touch" || normalized.startsWith("touch ")) {
      return {
        score: 5,
        level: this.getRiskLevel(5),
        reason: "touch 创建空文件",
      };
    }

    // cd 切换目录：无副作用
    if (normalized === "cd" || normalized.startsWith("cd ")) {
      return {
        score: 0,
        level: this.getRiskLevel(0),
        reason: "cd 切换目录，无副作用",
      };
    }

    // 默认未知命令：基础分 30（benign 边界，保守评估）
    return {
      score: 30,
      level: this.getRiskLevel(30),
      reason: "未知命令，默认基础分",
    };
  }

  /**
   * 编译黑名单条目：根据模式特征生成对应的匹配函数
   *
   * 三种匹配策略：
   * 1. 管道模式（curl/wget | sh/bash）：正则匹配，允许中间有 URL
   * 2. 路径/设备前缀模式（以 / 或 of=/dev/sd 结尾）：纯 startsWith
   * 3. 词边界模式（其他）：精确匹配 或 前缀+非词字符边界
   *
   * @param raw 原始黑名单模式字符串
   * @returns 编译后的匹配条目
   */
  private compileBlacklistEntry(raw: string): CompiledBlacklistEntry {
    // 管道模式：形如 "curl | sh" 或 "wget | bash"
    // 编译为正则，允许 curl/wget 和管道之间有 URL 等参数
    const pipeMatch = raw.match(/^(curl|wget)\s*\|\s*(sh|bash)$/);
    if (pipeMatch) {
      const [, tool, shell] = pipeMatch;
      // 构建正则：^curl\s+.*\|\s*sh(\s|$)
      // \s+.* 允许 curl 后有 URL 参数，\| 匹配管道符，(\s|$) 确保匹配完整 shell 名
      const regex = new RegExp(`^${tool}\\s+.*\\|\\s*${shell}(\\s|$)`);
      return {
        raw,
        match: (cmd: string) => regex.test(cmd),
      };
    }

    // 路径/设备前缀模式：以 "/" 结尾或以 "of=/dev/sd" 结尾
    // 这类模式的后续字符是路径/设备名的延续，使用纯前缀匹配
    if (this.isStartsWithPattern(raw)) {
      return {
        raw,
        match: (cmd: string) => cmd.startsWith(raw),
      };
    }

    // 词边界模式：精确匹配 或 前缀匹配且后续为非词字符
    // 避免 "main" 误匹配 "maintenance"，"sudo rm" 不误匹配 "sudo rmrf"
    return {
      raw,
      match: (cmd: string) => this.matchWordBoundary(cmd, raw),
    };
  }

  /**
   * 判断模式是否应使用纯前缀匹配（startsWith）
   *
   * 适用场景：
   * - 以 "/" 结尾：路径前缀（如 "rm -rf /" 匹配 "rm -rf /tmp"）
   * - 以 "of=/dev/sd" 结尾：设备前缀（如 "dd if=/dev/zero of=/dev/sd" 匹配 "sda"）
   *
   * @param pattern 黑名单模式字符串
   * @returns 是否为前缀匹配模式
   */
  private isStartsWithPattern(pattern: string): boolean {
    // 以 / 结尾：路径前缀（如 rm -rf /、chmod -R 777 /）
    if (pattern.endsWith("/")) {
      return true;
    }
    // dd 设备前缀：以 of=/dev/sd 结尾，匹配 sda/sdb 等设备名
    if (pattern.endsWith("of=/dev/sd")) {
      return true;
    }
    return false;
  }

  /**
   * 词边界匹配：精确相等 或 前缀匹配且后续字符为非词字符
   *
   * 词字符定义为 [a-zA-Z0-9_-]（字母、数字、下划线、连字符）。
   * 连字符视为词的一部分，因为分支名、选项名等标识符常含连字符
   *（如 master-feature、--force），不应被当作分隔符。
   *
   * 后续字符为非词字符（空格、/、.、| 等）或字符串结尾时视为匹配。
   * 这样可避免 "master" 误匹配 "master-feature"（连字符是词延续），
   * 同时允许 "mkfs" 匹配 "mkfs.ext4"（点号是边界）。
   *
   * 示例：
   * - matchWordBoundary("ls -la", "ls") → true（后续是空格，边界）
   * - matchWordBoundary("lsxyz", "ls") → false（后续是词字符 x，非边界）
   * - matchWordBoundary("git status", "git status") → true（精确匹配）
   * - matchWordBoundary("mkfs.ext4", "mkfs") → true（后续是 . 非词字符，边界）
   * - matchWordBoundary("sudo rm -rf /", "sudo rm") → true（后续是空格，边界）
   * - matchWordBoundary("git push --force origin master-feature", "git push --force origin master") → false（后续是 - 词字符，非边界）
   *
   * @param command 归一化后的命令
   * @param pattern 待匹配的模式
   * @returns 是否匹配
   */
  private matchWordBoundary(command: string, pattern: string): boolean {
    // 精确匹配
    if (command === pattern) {
      return true;
    }
    // 前缀匹配 + 词边界检查
    if (command.startsWith(pattern)) {
      const nextChar = command.charAt(pattern.length);
      // 后续字符为空（字符串结尾）或非词字符时匹配
      // 词字符（含连字符）：[a-zA-Z0-9_-]，连字符视为标识符的一部分
      // 非词字符包括空格、/、.、| 等，作为边界分隔符
      return nextChar === "" || !/[a-zA-Z0-9_-]/.test(nextChar);
    }
    return false;
  }

  /**
   * 归一化命令：去除首尾空白，折叠多余空白为单个空格
   *
   * 确保 "rm  -rf  /" 和 "rm -rf /" 被同等对待，
   * 避免因空白差异导致黑名单/白名单漏匹配。
   *
   * @param command 原始命令字符串
   * @returns 归一化后的命令
   */
  private normalizeCommand(command: string): string {
    return command.trim().replace(/\s+/g, " ");
  }

  /**
   * 根据评分获取风险等级
   *
   * 阈值定义（依据 V2.1 技术方案 §4.2.3）：
   * - 0-30：benign（良性，可自动批准）
   * - 31-90：caution（需谨慎，需询问用户；含 71-90 高风险谨慎）
   * - 91-100：destructive（破坏性，拒绝执行）
   *
   * @param score 风险评分（0-100）
   * @returns 风险等级
   */
  private getRiskLevel(score: number): RiskLevel {
    if (score <= 30) {
      return "benign";
    }
    if (score <= 90) {
      return "caution";
    }
    return "destructive";
  }

  /**
   * 评估 rm 命令的风险
   *
   * 评分规则：
   * - 基础分 60
   * - 含 -rf / -fr / (-r 且 -f) 标志：+20（递归强制删除）
   * - 目标路径为根目录 "/"：+20（最高危险）
   * - 目标路径为家目录 "~" 或 "$HOME"：+15
   * - 目标路径含绝对路径（以 "/" 开头）：+10
   *
   * @param command 归一化后的 rm 命令
   * @returns 风险评估结果
   */
  private assessRmRisk(command: string): RiskAssessment {
    let score = 60;
    const reasons: string[] = ["rm 删除命令"];

    // 检测 -rf 标志（支持 -rf、-fr、-r -f 组合）
    const hasRecursiveForce =
      /\s-rf\b/.test(command) || /\s-fr\b/.test(command) || (/\s-r\b/.test(command) && /\s-f\b/.test(command));
    if (hasRecursiveForce) {
      score += 20;
      reasons.push("含 -rf 递归强制删除");
    }

    // 提取路径参数：去除 rm 和所有 - 开头的标志
    const parts = command.split(" ").slice(1);
    const paths = parts.filter((p) => !p.startsWith("-"));
    const pathStr = paths.join(" ");

    // 评估目标路径危险性（按优先级判断，最高危险者生效）
    if (pathStr === "/" || paths.includes("/")) {
      // 删除根目录：最高危险
      score += 20;
      reasons.push("删除根目录 /");
    } else if (pathStr === "~" || pathStr === "$HOME" || paths.includes("~") || paths.includes("$HOME")) {
      // 删除家目录：高危险
      score += 15;
      reasons.push("删除家目录");
    } else if (paths.some((p) => p.startsWith("/"))) {
      // 含绝对路径：中危险
      score += 10;
      reasons.push("含绝对路径");
    }

    // 限制评分上限为 100
    score = Math.min(score, 100);

    return {
      score,
      level: this.getRiskLevel(score),
      reason: reasons.join("，"),
    };
  }

  /**
   * 评估 git push 命令的风险
   *
   * 评分规则：
   * - 基础分 50
   * - 含 --force 或 -f：+30（强制推送，可能覆盖他人提交）
   * - 推送到 origin main/master：+10（主分支，影响团队）
   *
   * @param command 归一化后的 git push 命令
   * @returns 风险评估结果
   */
  private assessGitPushRisk(command: string): RiskAssessment {
    let score = 50;
    const reasons: string[] = ["git push 推送命令"];

    // 检测强制推送标志
    if (command.includes("--force") || command.includes(" -f ")) {
      score += 30;
      reasons.push("含 --force 强制推送");
    }

    // 检测推送到主分支
    if (command.includes("origin main") || command.includes("origin master")) {
      score += 10;
      reasons.push("推送主分支");
    }

    score = Math.min(score, 100);

    return {
      score,
      level: this.getRiskLevel(score),
      reason: reasons.join("，"),
    };
  }

  /**
   * 评估 chmod 命令的风险
   *
   * 评分规则：
   * - 基础分 50
   * - 含 777：+20（全权限，安全隐患）
   *
   * @param command 归一化后的 chmod 命令
   * @returns 风险评估结果
   */
  private assessChmodRisk(command: string): RiskAssessment {
    let score = 50;
    const reasons: string[] = ["chmod 权限修改"];

    // 检测 777 全权限
    if (command.includes("777")) {
      score += 20;
      reasons.push("含 777 全权限");
    }

    score = Math.min(score, 100);

    return {
      score,
      level: this.getRiskLevel(score),
      reason: reasons.join("，"),
    };
  }
}
