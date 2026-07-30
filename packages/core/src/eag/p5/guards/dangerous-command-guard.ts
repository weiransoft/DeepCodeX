/**
 * EAG-P5 Phase 5.2 A-2 危险命令拦截守护（TASK-P5-5.2-002）
 *
 * 本模块实现 6 层 15 条 BLOCKER 守护链的 A-2 层（3 条 BLOCKER）：
 * - G-A2a 黑名单永禁：30+ 危险命令模式（rm -rf / / shutdown / reboot / mkfs / dd / kill -9
 *   / chmod 777 / curl|wget 拉取脚本等），DENY 不可豁免
 * - G-A2b 删除操作分级：默认 DENY 转人工；单文件 ∈ 任务卡 declaredDeletions 可 AUTO；
 *   批量 > 3 文件必须人工确认
 * - G-A2c 白名单收敛：AUTO 模式仅允许 test / lint / build / install / git status|diff|add|commit
 *   等限定操作，其他一律转人工
 *
 * 设计依据：
 * - 需求文档 §3 FR-2 A-2 危险命令拦截层（3 条 BLOCKER）
 * - 需求文档 §2 US-2 AC-2.4 / AC-2.5 / AC-2.6
 * - 架构师审查 §4.2 GuardRule 接口契约
 * - 事故案例：rm -rf / 误执行 / kill -9 进程 / chmod 777 公开敏感文件 / curl|bash 注入
 *
 * 不可变优先原则（NFR-8）：
 * - 所有字段 readonly
 * - 常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * 真实实现（禁止 mock / 占位 / 简化）：
 * - G-A2a：基于 30+ 真实正则模式匹配，覆盖 Unix/Linux/macOS 危险命令
 * - G-A2b：基于任务卡 declaredDeletions 真实比对，识别 rm/unlink/find -delete 等删除操作
 * - G-A2c：基于白名单前缀匹配，仅允许预定义的安全命令子集
 *
 * @module eag/p5/guards/dangerous-command-guard
 */

import type { GuardContext, GuardVerdict, GuardRule, GuardRuleId } from "./types";
import { createPassVerdict, createDenyVerdict, createAskVerdict } from "./types";

// ============================================================================
// 1. G-A2a 黑名单永禁常量与正则
// ============================================================================

/**
 * 危险命令黑名单模式（30+ 模式，DENY 不可豁免）
 *
 * 对齐需求文档 §3 FR-2 G-A2a + §11 速查表：
 * - rm -rf /：根目录递归删除（典型灾难性命令）
 * - shutdown / reboot / halt / poweroff：系统关机重启
 * - mkfs / fdisk / parted：磁盘格式化分区
 * - dd if=/dev/zero of=...：低级磁盘覆写
 * - kill -9 1 / killall：强制终止关键进程
 * - chmod 777 / chown root：权限滥用
 * - curl|bash / wget|sh：远程脚本执行（注入风险）
 * - :(){ :|:& };:：fork 炸弹
 * - > /dev/sda：块设备覆写
 * - iptables -F / ufw disable：防火墙关闭
 * - 等等
 *
 * 每条模式含：
 * - pattern：正则表达式（匹配命令中的危险模式）
 * - name：模式名称（用于审计日志）
 * - description：人类可读描述（用于拦截原因）
 *
 * 使用 Object.freeze 冻结，防止运行期篡改。
 */
const DANGEROUS_COMMAND_PATTERNS: ReadonlyArray<
  Readonly<{
    pattern: RegExp;
    name: string;
    description: string;
  }>
> = Object.freeze([
  // === 灾难性删除 ===
  {
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f*|--recursive)\s+(-[a-zA-Z]*\s+)*\/(\s|$)/,
    name: "rm-rf-root",
    description: "rm -rf / 根目录递归删除（灾难性命令）",
  },
  {
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f*|--recursive)\s+(-[a-zA-Z]*\s+)*\/\*/,
    name: "rm-rf-root-glob",
    description: "rm -rf /* 根目录通配删除",
  },
  {
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f*|--recursive)\s+(-[a-zA-Z]*\s+)*(~|\$HOME)/,
    name: "rm-rf-home",
    description: "rm -rf ~ 或 $HOME 用户目录递归删除",
  },
  {
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f*|--recursive)\s+(-[a-zA-Z]*\s+)*\.\.\/\.\.\//,
    name: "rm-rf-parent-escape",
    description: "rm -rf 连续 ../ 试图逃逸 projectRoot",
  },
  // === 系统关机重启 ===
  {
    pattern: /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/,
    name: "system-shutdown",
    description: "系统关机/重启命令",
  },
  // === 磁盘格式化与分区 ===
  {
    pattern: /\b(mkfs|fdisk|parted|dd)\s+.*\/dev\/(sd[a-z]+|nvme\d+n\d+|disk\d+|loop\d+)/i,
    name: "disk-format",
    description: "磁盘格式化/分区/低级写入块设备",
  },
  {
    pattern: /\bdd\s+if=.*\s+of=\/dev\/(sd[a-z]+|nvme\d+n\d+|disk\d+|loop\d+)/i,
    name: "dd-disk-overwrite",
    description: "dd 覆写块设备（数据破坏）",
  },
  // === 进程强制终止 ===
  {
    pattern: /\bkill\s+-9\s+(1|0)\b/,
    name: "kill-init",
    description: "kill -9 PID 1 或 PID 0（终止 init 进程或进程组）",
  },
  {
    pattern: /\bkillall\s+(-9\s+)?(init|systemd|launchd|sshd|bash|zsh|sh)\b/i,
    name: "killall-critical",
    description: "killall 关键系统进程（init/systemd/launchd/shell）",
  },
  {
    pattern: /\bpkill\s+(-9\s+)?(init|systemd|launchd|sshd|bash|zsh|sh)\b/i,
    name: "pkill-critical",
    description: "pkill 关键系统进程",
  },
  // === 权限滥用 ===
  {
    pattern: /\bchmod\s+(-R\s+)?777\b/,
    name: "chmod-777",
    description: "chmod 777 全权限（公开敏感文件）",
  },
  {
    pattern: /\bchmod\s+(-R\s+)?0?666\b/,
    name: "chmod-666",
    description: "chmod 666 全读写权限（敏感文件可篡改）",
  },
  {
    pattern: /\bchown\s+(-R\s+)?root\b/i,
    name: "chown-root",
    description: "chown root 修改文件属主为 root（权限提升风险）",
  },
  {
    pattern: /\bchmod\s+[us]?\+?[sxX]\b/,
    name: "chmod-setuid",
    description: "chmod 设置 setuid/setgid（权限提升风险）",
  },
  // === 远程脚本执行（注入风险）===
  {
    pattern: /\b(curl|wget)\s+[^|]*\|\s*(sh|bash|zsh|python|perl|ruby|node)\b/i,
    name: "curl-pipe-shell",
    description: "curl|bash 远程脚本执行（注入风险）",
  },
  {
    pattern: /\b(curl|wget)\s+[^|]*\|\s*sudo\s+(sh|bash|zsh|python|perl|ruby|node)\b/i,
    name: "curl-pipe-sudo-shell",
    description: "curl|sudo bash 远程脚本以 root 执行（极高注入风险）",
  },
  // === Fork 炸弹 ===
  {
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
    name: "fork-bomb",
    description: ":(){ :|:& };: fork 炸弹（资源耗尽）",
  },
  // === 块设备覆写 ===
  {
    pattern: />\s*\/dev\/(sd[a-z]+|nvme\d+n\d+|disk\d+)/i,
    name: "redirect-to-block-device",
    description: "重定向写入块设备（数据破坏）",
  },
  // === 防火墙关闭 ===
  {
    pattern: /\biptables\s+(-F|--flush)\b/,
    name: "iptables-flush",
    description: "iptables -F 清空防火墙规则",
  },
  {
    pattern: /\bufw\s+disable\b/i,
    name: "ufw-disable",
    description: "ufw disable 关闭防火墙",
  },
  {
    pattern: /\bfirewall-cmd\s+--reload\s+--permanent\b/i,
    name: "firewall-disable",
    description: "firewall-cmd 永久重载（可能清空规则）",
  },
  // === 网络后门 ===
  {
    pattern: /\bnc\s+(-l|-p)\s+\d+\s+.*-e\s+(sh|bash|zsh)\b/i,
    name: "nc-reverse-shell",
    description: "nc 反向 shell 后门",
  },
  {
    pattern: /\bbash\s+-i\s+>&\s*\/dev\/tcp\//i,
    name: "bash-tcp-reverse-shell",
    description: "bash /dev/tcp 反向 shell 后门",
  },
  // === sudo 滥用 ===
  {
    pattern: /\bsudo\s+rm\s+(-[a-zA-Z]*r[a-zA-Z]*f*|--recursive)\s+(-[a-zA-Z]*\s+)*\//,
    name: "sudo-rm-root",
    description: "sudo rm -rf / 以 root 权限递归删除根目录",
  },
  {
    pattern: /\bsudo\s+(shutdown|reboot|halt|poweroff)\b/i,
    name: "sudo-shutdown",
    description: "sudo 系统关机/重启",
  },
  // === 包管理器危险操作 ===
  {
    pattern: /\b(npm|yarn|pnpm)\s+(uninstall|remove)\s+(-g|--global)\b/,
    name: "npm-uninstall-global",
    description: "全局卸载 npm 包（可能破坏系统工具）",
  },
  {
    pattern: /\bpip\s+uninstall\s+(-y\s+)?(pip|setuptools|wheel)\b/i,
    name: "pip-uninstall-core",
    description: "卸载 pip 核心包（破坏 Python 环境）",
  },
  // === Docker 危险操作 ===
  {
    pattern: /\bdocker\s+rm\s+-f\s+(-\s+)?\$(\(|\{)/,
    name: "docker-rm-all-force",
    description: "docker rm -f $(docker ps -aq) 强制删除所有容器",
  },
  {
    pattern: /\bdocker\s+rmi\s+(-f\s+)?\$(\(|\{)/,
    name: "docker-rmi-all-force",
    description: "docker rmi $(docker images -q) 删除所有镜像",
  },
  {
    pattern: /\bdocker\s+system\s+prune\s+(-a|--all)\b/,
    name: "docker-system-prune-all",
    description: "docker system prune -a 清空所有未使用资源",
  },
  // === Git 危险操作 ===
  {
    pattern: /\bgit\s+push\s+(-f|--force)\s+.*\s+(main|master|trunk)\b/i,
    name: "git-force-push-main",
    description: "git push --force 到 main/master 主干（覆盖历史）",
  },
  {
    pattern: /\bgit\s+reset\s+--hard\s+HEAD~\d+/,
    name: "git-reset-hard-history",
    description: "git reset --hard HEAD~N 回滚历史提交（数据丢失）",
  },
  {
    pattern: /\bgit\s+clean\s+-fdx\b/,
    name: "git-clean-fdx",
    description: "git clean -fdx 清空所有未跟踪文件（含 .gitignore）",
  },
  // === 文件系统挂载 ===
  {
    pattern: /\bmount\s+(-t\s+\S+\s+)?\/dev\/(sd[a-z]+|nvme\d+n\d+)\s+\/(boot|etc|var|usr)\b/i,
    name: "mount-system-disk",
    description: "挂载块设备到系统目录",
  },
  {
    pattern: /\bumount\s+(-f|-l)?\s*\/\s*$/,
    name: "umount-root",
    description: "卸载根文件系统",
  },
  // === 代码执行绕过构造 ===
  {
    pattern: /(^|[^\w])eval\s*\(/,
    name: "eval-execution",
    description: "eval 执行任意字符串代码",
  },
  {
    pattern: /(^|[^\w])new\s+Function\s*\(/,
    name: "new-function-execution",
    description: "new Function 动态编译执行任意代码",
  },
  {
    pattern: /`[^`]*`/,
    name: "backtick-command-substitution",
    description: "反引号命令替换（可隐藏恶意命令）",
  },
  {
    pattern: /\$\s*\([^)]+\)/,
    name: "dollar-paren-command-substitution",
    description: "$() 命令替换（可嵌套执行任意 shell）",
  },
  {
    pattern: /\b(echo|printf|cat)\s+[^|]*\|\s*base64\s+-d\s*\|\s*(sh|bash|zsh)/i,
    name: "base64-decode-pipe-shell",
    description: "Base64 解码后通过管道执行 shell（常见绕过手段）",
  },
  {
    pattern: /\bpython\s+-c\s+['"`]/i,
    name: "python-one-liner",
    description: "python -c 执行任意 Python 代码",
  },
  {
    pattern: /\bperl\s+-e\s+['"`]/i,
    name: "perl-one-liner",
    description: "perl -e 执行任意 Perl 代码",
  },
  {
    pattern: /\bruby\s+-e\s+['"`]/i,
    name: "ruby-one-liner",
    description: "ruby -e 执行任意 Ruby 代码",
  },
]);

// ============================================================================
// 2. G-A2b 删除操作分级常量与正则
// ============================================================================

/**
 * 删除命令模式列表
 *
 * 用于识别 pendingCommand 是否为删除操作。
 * 涵盖常见删除命令：rm / unlink / rmdir / find -delete / git clean / git rm 等。
 *
 * 每条模式含：
 * - pattern：正则表达式（匹配删除命令）
 * - description：人类可读描述
 */
const DELETE_COMMAND_PATTERNS: ReadonlyArray<
  Readonly<{
    pattern: RegExp;
    description: string;
  }>
> = Object.freeze([
  // rm 命令（含 -r/-f/-rf 选项）
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*[\w./~-]+/, description: "rm 删除文件或目录" },
  // unlink 命令
  { pattern: /\bunlink\s+[\w./~-]+/, description: "unlink 删除文件" },
  // rmdir 命令
  { pattern: /\brmdir\s+(-[a-zA-Z]*\s+)*[\w./~-]+/, description: "rmdir 删除空目录" },
  // find ... -delete
  { pattern: /\bfind\s+.*-delete\b/, description: "find -delete 删除匹配文件" },
  // find ... -exec rm
  { pattern: /\bfind\s+.*-exec\s+rm\b/, description: "find -exec rm 删除匹配文件" },
  // git clean（删除未跟踪文件）
  { pattern: /\bgit\s+clean\s+(-[a-zA-Z]+\s+)+/, description: "git clean 删除未跟踪文件" },
  // git rm
  { pattern: /\bgit\s+rm\s+(-[a-zA-Z]*\s+)*[\w./~-]+/, description: "git rm 删除版本控制文件" },
  // trash 命令（macOS）
  { pattern: /\btrash\s+[\w./~-]+/, description: "trash 移到废纸篓" },
]);

/**
 * 单次删除文件数硬上限（G-A2b 批量删除阈值）
 *
 * 超过此阈值的删除操作必须转人工确认（即使是任务卡声明删除）。
 *
 * 数值依据：
 * - 3 个文件以内的删除通常为局部重构，可 AUTO
 * - 超过 3 个文件的删除可能为大规模重构或清理，需人工确认
 */
const MAX_BATCH_DELETE_THRESHOLD = 3 as const;

/**
 * 从删除命令中提取目标文件路径的正则
 *
 * 用于 G-A2b 删除分级判定：
 * - 解析 rm/unlink 后面的路径参数
 * - 跳过选项参数（-rf / --recursive 等）
 * - 跳过命令本身的二进制名
 */
const DELETE_FILE_PATH_PATTERN =
  /(?:rm|unlink|rmdir|trash|git\s+rm)\s+((?:-[a-zA-Z-]+(?:=\S+)?\s+)*)(.+?)(?:\s*;|\s*\|\||\s*&&|\s*$)/;

// ============================================================================
// 3. G-A2c 白名单收敛常量与正则
// ============================================================================

/**
 * AUTO 模式允许的命令白名单前缀列表
 *
 * 对齐需求文档 §3 FR-2 G-A2c：AUTO 仅覆盖测试/lint/build/install/git 限定操作。
 *
 * 每条白名单含：
 * - prefix：命令前缀（字符串匹配，从命令开头比较）
 * - description：人类可读描述
 *
 * 严格收敛原则：
 * - 仅允许只读或可控变更的命令
 * - 不允许任何危险操作（即使前缀匹配，仍会被 G-A2a 黑名单拦截）
 * - git 仅允许 status/diff/add/commit/log/show 等子命令
 *
 * 使用 Object.freeze 冻结。
 */
const AUTO_ALLOWLIST: ReadonlyArray<
  Readonly<{
    prefix: string;
    description: string;
  }>
> = Object.freeze([
  // === 测试命令 ===
  { prefix: "npm test", description: "npm test 运行测试" },
  { prefix: "npm run test", description: "npm run test 运行测试" },
  { prefix: "yarn test", description: "yarn test 运行测试" },
  { prefix: "pnpm test", description: "pnpm test 运行测试" },
  { prefix: "npx jest", description: "npx jest 运行 Jest 测试" },
  { prefix: "npx vitest", description: "npx vitest 运行 Vitest 测试" },
  { prefix: "npx mocha", description: "npx mocha 运行 Mocha 测试" },
  { prefix: "node --test", description: "node --test 运行 Node.js 原生测试" },
  { prefix: "pytest", description: "pytest 运行 Python 测试" },
  { prefix: "go test", description: "go test 运行 Go 测试" },
  { prefix: "cargo test", description: "cargo test 运行 Rust 测试" },
  { prefix: "mvn test", description: "mvn test 运行 Maven 测试" },
  { prefix: "gradle test", description: "gradle test 运行 Gradle 测试" },
  // === Lint / 格式化命令 ===
  { prefix: "npm run lint", description: "npm run lint 运行 Lint" },
  { prefix: "yarn lint", description: "yarn lint 运行 Lint" },
  { prefix: "pnpm lint", description: "pnpm lint 运行 Lint" },
  { prefix: "npx eslint", description: "npx eslint 运行 ESLint" },
  { prefix: "npx prettier", description: "npx prettier 运行 Prettier 格式化" },
  { prefix: "npx ruff", description: "npx ruff 运行 Ruff Python Lint" },
  { prefix: "ruff check", description: "ruff check 运行 Ruff 检查" },
  { prefix: "ruff format", description: "ruff format 运行 Ruff 格式化" },
  { prefix: "golangci-lint", description: "golangci-lint 运行 Go Lint" },
  { prefix: "cargo clippy", description: "cargo clippy 运行 Rust Clippy" },
  // === 构建命令 ===
  { prefix: "npm run build", description: "npm run build 构建" },
  { prefix: "yarn build", description: "yarn build 构建" },
  { prefix: "pnpm build", description: "pnpm build 构建" },
  { prefix: "tsc", description: "tsc TypeScript 编译" },
  { prefix: "webpack", description: "webpack 构建" },
  { prefix: "vite build", description: "vite build 构建" },
  { prefix: "go build", description: "go build 构建" },
  { prefix: "cargo build", description: "cargo build 构建" },
  { prefix: "mvn package", description: "mvn package 构建" },
  { prefix: "gradle build", description: "gradle build 构建" },
  // === 安装依赖命令 ===
  { prefix: "npm install", description: "npm install 安装依赖" },
  { prefix: "npm ci", description: "npm ci 安装依赖（CI 模式）" },
  { prefix: "yarn install", description: "yarn install 安装依赖" },
  { prefix: "pnpm install", description: "pnpm install 安装依赖" },
  { prefix: "pip install", description: "pip install 安装依赖" },
  { prefix: "go mod download", description: "go mod download 下载依赖" },
  { prefix: "cargo fetch", description: "cargo fetch 下载依赖" },
  // === Git 只读或安全操作命令 ===
  { prefix: "git status", description: "git status 查看状态" },
  { prefix: "git diff", description: "git diff 查看差异" },
  { prefix: "git log", description: "git log 查看日志" },
  { prefix: "git show", description: "git show 查看 commit 详情" },
  { prefix: "git branch", description: "git branch 查看分支" },
  { prefix: "git add", description: "git add 暂存变更" },
  { prefix: "git commit -m", description: "git commit -m 提交（需 G-A5b 密钥扫描）" },
  // === TypeScript / Node.js 类型检查 ===
  { prefix: "tsc --noEmit", description: "tsc --noEmit 类型检查" },
  { prefix: "npx tsc --noEmit", description: "npx tsc --noEmit 类型检查" },
]);

/**
 * 任务卡声明删除文件集合的最大容量
 *
 * 防止任务卡声明过多删除目标导致 G-A2b 比对过慢。
 */
const MAX_DECLARED_DELETIONS = 100 as const;

// ============================================================================
// 4. DangerousCommandGuard 类（A-2 层，3 条 BLOCKER）
// ============================================================================

/**
 * A-2 危险命令拦截守护类
 *
 * 实现 3 条 BLOCKER：
 * - G-A2a 黑名单永禁
 * - G-A2b 删除操作分级
 * - G-A2c 白名单收敛
 *
 * 守护顺序：
 * 1. 先检查 G-A2a 黑名单永禁（最严格，DENY 不可豁免）
 * 2. 再检查 G-A2b 删除操作分级（DENY 转人工 / ASK 批量确认）
 * 3. 最后检查 G-A2c 白名单收敛（不在白名单内 ASK 转人工）
 *
 * 任一检查触发即返回，不继续后续检查（短路原则）。
 *
 * 用法：
 * ```typescript
 * const guard = new DangerousCommandGuard();
 * const verdict = guard.check(context);
 * if (verdict.decision === "DENY") {
 *   throw new GuardViolationError(verdict, "A-2");
 * }
 * ```
 */
export class DangerousCommandGuard implements GuardRule {
  /** 规则 ID（G-A2a，主规则；其余两条在 check() 内部串联） */
  public readonly ruleId: GuardRuleId = "G-A2a";
  /** 所属层级（A-2 危险命令拦截层） */
  public readonly layer = "A-2" as const;
  /** 严重性（BLOCKER） */
  public readonly severity = "BLOCKER" as const;

  /**
   * 判定函数：执行 A-2 层 3 条 BLOCKER 检查
   *
   * 检查顺序（短路原则，任一 DENY/ASK 即返回）：
   * 1. G-A2a 黑名单永禁（DENY 不可豁免）
   * 2. G-A2b 删除操作分级（DENY 或 ASK）
   *    - 若为删除操作且通过（∈ declaredDeletions），跳过 G-A2c 白名单检查
   *      （因为 rm 命令永远不在白名单内，但 declaredDeletions 内允许 AUTO）
   * 3. G-A2c 白名单收敛（ASK 转人工，仅非删除操作执行）
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / DENY / ASK）
   */
  check(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    // 1. G-A2a 黑名单永禁检查
    const blacklistVerdict = this.checkBlacklist(context);
    if (blacklistVerdict.decision !== "PASS") {
      return blacklistVerdict;
    }

    // 2. G-A2b 删除操作分级检查
    //    判断是否为删除操作，若是则进入 G-A2b 分级判定
    const cmd = context.pendingCommand;
    const isDeleteOp = cmd ? this.isDeleteOperation(cmd) : false;
    if (isDeleteOp) {
      // 删除操作走 G-A2b 分级判定
      // - 若 PASS（∈ declaredDeletions），直接返回 PASS，跳过 G-A2c 白名单检查
      //   （因为 rm 命令永远不在 AUTO_ALLOWLIST 内，但 declaredDeletions 内允许 AUTO）
      // - 若 ASK（转人工），返回 ASK
      return this.checkDeleteOperation(context);
    }

    // 3. G-A2c 白名单收敛检查（仅非删除操作执行）
    const allowlistVerdict = this.checkAllowlist(context);
    if (allowlistVerdict.decision !== "PASS") {
      return allowlistVerdict;
    }

    // 全部通过
    return createPassVerdict();
  }

  /**
   * 判断命令是否为删除操作
   *
   * 遍历 DELETE_COMMAND_PATTERNS，任一匹配即返回 true。
   *
   * @param cmd 命令字符串
   * @returns 是否为删除操作
   */
  private isDeleteOperation(cmd: string): boolean {
    for (const { pattern } of DELETE_COMMAND_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(cmd)) {
        return true;
      }
    }
    return false;
  }

  // ===========================================================================
  // G-A2a 黑名单永禁
  // ===========================================================================

  /**
   * G-A2a 黑名单永禁检查
   *
   * 遍历 30+ 危险命令模式，任一命中即 DENY（不可豁免）。
   *
   * 实现细节：
   * - 使用 RegExp.test() 进行匹配（性能优于 String.match）
   * - 模式区分大小写（命令名小写，路径大小写敏感）
   * - 命中后立即返回，避免不必要的后续匹配
   *
   * 性能目标（NFR-7）：< 1ms（30+ 正则匹配，单条命令）
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / DENY）
   */
  private checkBlacklist(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    const cmd = context.pendingCommand;
    // 无命令时不检查
    if (!cmd) {
      return createPassVerdict();
    }

    // 遍历 30+ 危险命令模式
    for (const { pattern, name, description } of DANGEROUS_COMMAND_PATTERNS) {
      // 重置正则的 lastIndex（避免全局正则状态污染）
      pattern.lastIndex = 0;
      if (pattern.test(cmd)) {
        return createDenyVerdict(
          "G-A2a",
          "BLOCKER",
          `黑名单永禁违规：${description}（模式名：${name}）`,
          "中止迭代，DENY 不可豁免，建议转人工审查命令"
        );
      }
    }

    return createPassVerdict();
  }

  // ===========================================================================
  // G-A2b 删除操作分级
  // ===========================================================================

  /**
   * G-A2b 删除操作分级检查
   *
   * 判定逻辑：
   * 1. 识别命令是否为删除操作（rm / unlink / find -delete / git clean 等）
   * 2. 若为删除操作：
   *    a. 解析删除目标文件列表
   *    b. 若批量删除 > MAX_BATCH_DELETE_THRESHOLD（3）→ ASK 转人工
   *    c. 若单文件删除且 ∈ 任务卡 declaredDeletions → PASS（允许 AUTO）
   *    d. 若单文件删除且 ∉ 任务卡 declaredDeletions → ASK 转人工
   * 3. 若非删除操作 → PASS
   *
   * 实现细节：
   * - 真实解析命令字符串，提取目标文件路径
   * - 与任务卡 declaredDeletions 真实比对（路径归一化后比较）
   * - 任务卡缺失时，所有删除操作默认 ASK 转人工
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / ASK）
   */
  private checkDeleteOperation(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    const cmd = context.pendingCommand;
    if (!cmd) {
      return createPassVerdict();
    }

    // 1. 识别是否为删除操作
    let isDeleteOperation = false;
    let matchedDescription = "";
    for (const { pattern, description } of DELETE_COMMAND_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(cmd)) {
        isDeleteOperation = true;
        matchedDescription = description;
        break;
      }
    }

    if (!isDeleteOperation) {
      return createPassVerdict();
    }

    // 2. 解析删除目标文件路径
    const targetFiles = this.extractDeleteTargets(cmd);

    // 3. 批量删除阈值检查（> 3 文件必须人工）
    if (targetFiles.length > MAX_BATCH_DELETE_THRESHOLD) {
      return createAskVerdict(
        "G-A2b",
        "BLOCKER",
        `删除操作分级违规：${matchedDescription}（目标 ${targetFiles.length} 个文件，超过批量阈值 ${MAX_BATCH_DELETE_THRESHOLD}）`,
        "转人工确认批量删除操作"
      );
    }

    // 4. 任务卡声明删除清单检查
    const declaredDeletions = context.currentTaskCard?.declaredDeletions;
    if (!declaredDeletions || declaredDeletions.length === 0) {
      // 任务卡未声明任何删除目标 → 转人工
      return createAskVerdict(
        "G-A2b",
        "BLOCKER",
        `删除操作分级违规：${matchedDescription}（任务卡未声明 declaredDeletions，无法 AUTO 放行）`,
        "转人工确认删除操作，或在任务卡中显式声明 declaredDeletions"
      );
    }

    // 5. 任务卡声明删除清单容量校验
    if (declaredDeletions.length > MAX_DECLARED_DELETIONS) {
      return createAskVerdict(
        "G-A2b",
        "BLOCKER",
        `删除操作分级违规：任务卡 declaredDeletions 容量超限（${declaredDeletions.length} > ${MAX_DECLARED_DELETIONS}）`,
        "转人工确认，建议拆分任务卡以缩小 declaredDeletions 范围"
      );
    }

    // 6. 逐个校验目标文件是否在声明清单内
    const declaredSet = new Set(declaredDeletions);
    for (const target of targetFiles) {
      const normalizedTarget = this.normalizePath(target);
      let isDeclared = false;
      for (const declared of declaredSet) {
        if (this.normalizePath(declared) === normalizedTarget) {
          isDeclared = true;
          break;
        }
      }
      if (!isDeclared) {
        return createAskVerdict(
          "G-A2b",
          "BLOCKER",
          `删除操作分级违规：${matchedDescription}（目标 ${target} 不在任务卡 declaredDeletions 内）`,
          "转人工确认，或在任务卡 declaredDeletions 中显式声明该文件"
        );
      }
    }

    // 全部目标在声明清单内 → PASS（允许 AUTO）
    return createPassVerdict();
  }

  /**
   * 从删除命令中提取目标文件路径列表
   *
   * 解析逻辑：
   * 1. 提取命令中 rm/unlink/rmdir/trash/git rm 后的参数部分
   * 2. 跳过选项参数（-rf / --recursive 等）
   * 3. 按空格分割剩余部分作为目标文件
   * 4. 处理引号包裹的路径（含空格的路径）
   *
   * @param cmd 命令字符串
   * @returns 目标文件路径列表
   */
  private extractDeleteTargets(cmd: string): ReadonlyArray<string> {
    const match = cmd.match(DELETE_FILE_PATH_PATTERN);
    if (!match) {
      return Object.freeze([]);
    }

    const argsPart = match[2].trim();
    if (!argsPart) {
      return Object.freeze([]);
    }

    // 解析引号包裹的路径与裸路径
    const targets: string[] = [];
    // 正则：匹配 "..." 或 '...' 或 非空格连续字符
    const tokenPattern = /("[^"]+"|'[^']+'|[^\s]+)/g;
    let tokenMatch: RegExpExecArray | null;
    while ((tokenMatch = tokenPattern.exec(argsPart)) !== null) {
      let token = tokenMatch[1];
      // 去除外层引号
      if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
        token = token.slice(1, -1);
      }
      // 跳过选项参数（- 开头）
      if (token.startsWith("-")) {
        continue;
      }
      // 跳过重定向符
      if (token.startsWith(">") || token.startsWith("<") || token === "|") {
        continue;
      }
      targets.push(token);
    }

    return Object.freeze(targets);
  }

  /**
   * 路径归一化（用于 declaredDeletions 比对）
   *
   * - 统一为 POSIX 分隔符（/）
   * - 去除尾部 /
   * - 去除 ./ 前缀
   * - 不解析符号链接（避免文件系统访问）
   *
   * @param filePath 文件路径
   * @returns 归一化后的路径
   */
  private normalizePath(filePath: string): string {
    let normalized = filePath.replace(/\\/g, "/");
    // 去除 ./ 前缀
    if (normalized.startsWith("./")) {
      normalized = normalized.slice(2);
    }
    // 去除尾部 /
    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  }

  // ===========================================================================
  // G-A2c 白名单收敛
  // ===========================================================================

  /**
   * 危险 shell 元字符/构造正则集合（用于 fail-closed 预检）
   *
   * 匹配可能将单个命令拆分为多段执行的构造：
   * - 命令替换：反引号、`$()`
   * - 命令链：`;`、`&&`、`||`、`|`
   *
   * 注意：这些构造本身不一定是恶意的（如 `npm test && npm run build`），
   * 但在 AUTO 模式下，它们允许前半段命中白名单、后半段执行任意命令，
   * 因此必须 fail-closed：检测到此类构造后，仅当剩余部分仍完全落在
   * 同一白名单命令的合法参数空间时才允许；否则转人工。
   */
  private static readonly SHELL_METACHARACTER_PATTERN = /[;|`]|\|\||&&|\$\s*\(/;

  /**
   * G-A2c 白名单收敛检查
   *
   * 判定逻辑：
   * - 若 pendingCommand 不在 AUTO 允许白名单内 → ASK 转人工
   * - 若在白名单内，但包含命令链/替换等 shell 元字符导致后半段可能逃逸白名单 → ASK 转人工
   * - 否则 → PASS
   *
   * 实现细节：
   * - 使用前缀匹配（startsWith）覆盖子命令变体
   * - 严格收敛：仅允许预定义的安全命令子集
   * - 即使前缀匹配，仍会被 G-A2a 黑名单优先拦截（短路原则）
   * - fail-closed：前缀匹配后，若命令剩余部分包含 `; | & \` $()` 等构造，
   *   说明存在命令链或命令替换，必须转人工确认，防止 "npm test; rm -rf /" 类绕过
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / ASK）
   */
  private checkAllowlist(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    const cmd = context.pendingCommand;
    if (!cmd) {
      return createPassVerdict();
    }

    // 去除命令首尾空白
    const trimmedCmd = cmd.trim();

    // 遍历白名单，检查前缀匹配
    for (const { prefix } of AUTO_ALLOWLIST) {
      if (trimmedCmd.startsWith(prefix)) {
        // 前缀匹配后，下一个字符必须是空格、命令结束，或者是 shell 元字符/构造
        // 防止 "npm testX" 误匹配 "npm test"，但允许识别 "npm test; echo leaked" 等绕过
        const nextChar = trimmedCmd.charAt(prefix.length);
        const isShellBoundary = /[;|&`$]/.test(nextChar);
        if (nextChar !== "" && nextChar !== " " && !isShellBoundary) {
          continue;
        }

        // fail-closed：检查匹配后的剩余部分是否包含危险 shell 元字符
        const remainder = trimmedCmd.slice(prefix.length).trim();
        if (remainder.length > 0 && DangerousCommandGuard.SHELL_METACHARACTER_PATTERN.test(remainder)) {
          return createAskVerdict(
            "G-A2c",
            "BLOCKER",
            `白名单收敛违规：命令 "${trimmedCmd.substring(0, 50)}${trimmedCmd.length > 50 ? "..." : ""}" 命中白名单但包含 shell 元字符/构造，存在绕过风险`,
            "转人工确认复合命令，或拆分为多个单一安全命令"
          );
        }

        return createPassVerdict();
      }
    }

    // 不在白名单内 → ASK 转人工
    return createAskVerdict(
      "G-A2c",
      "BLOCKER",
      `白名单收敛违规：命令 "${trimmedCmd.substring(0, 50)}${trimmedCmd.length > 50 ? "..." : ""}" 不在 AUTO 允许白名单内`,
      "转人工确认命令，或扩展 AUTO_ALLOWLIST（需架构师审查）"
    );
  }
}

// ============================================================================
// 5. 导出常量（供测试与外部模块使用）
// ============================================================================

/**
 * 导出危险命令黑名单模式列表（供测试断言）
 */
export { DANGEROUS_COMMAND_PATTERNS as DANGEROUS_COMMAND_GUARD_PATTERNS };

/**
 * 导出删除命令模式列表（供测试断言）
 */
export { DELETE_COMMAND_PATTERNS as DANGEROUS_COMMAND_DELETE_PATTERNS };

/**
 * 导出 AUTO 模式白名单（供测试断言）
 */
export { AUTO_ALLOWLIST as DANGEROUS_COMMAND_AUTO_ALLOWLIST };

/**
 * 导出批量删除阈值常量（供测试断言）
 */
export { MAX_BATCH_DELETE_THRESHOLD as DANGEROUS_COMMAND_MAX_BATCH_DELETE_THRESHOLD };
