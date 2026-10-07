/**
 * EAG-P5 LLM 任务执行器（方案 A §3.8，架构师审查 P0-6 选型）
 *
 * 修复前问题：
 * - dev/fix 阶段不调用任何 LLM，只盘点文件/生成建议就返回 success，
 *   AutonomousOrchestrator 因此空转：0 次 LLM 调用、0 秒耗时却报 completed。
 *
 * 选型结论（架构师审查否决"新建子 SessionManager"方案后的替代设计）：
 * - 不创建会话条目、不碰 sessions-index.json、不跑 skill 匹配/compact/建议器，
 *   避免共享索引无锁读改写淘汰主会话、权限挂起信号私有不可达等 6 个 P0 硬伤；
 * - 在本类内实现精简的「LLM ↔ 工具」循环：
 *   固定 system/user 提示词 → 非流式 createMessage → 真实 ToolExecutor 执行
 *   read/write/edit/UpdatePlan → 工具结果回灌 → 直到模型给出无工具调用的终态文本；
 * - 进程内权限硬判（onBeforeToolExecution）：白名单 + 路径牢笼 + 凭据模式，
 *   越权一律 deny 并把失败结果回灌模型——不挂起、不询问、不落盘 settings.json；
 * - 工具循环轮数硬上限（默认 12），模型无法自行放宽；
 * - 每轮轮询 abort 标志文件，命中即中止。
 *
 * 真实性约束（用户硬性规则：禁止 mock/占位/简化）：
 * - LLM 客户端、ToolExecutor、文件系统、git 全部为生产真实实现；
 * - 唯一允许的测试替换点是 createLlmClient 工厂（测试中返回桩 LLMClient 控制 HTTP 响应），
 *   工具执行与文件落盘在测试中仍走真实 ToolExecutor。
 *
 * @module eag/p5/executors/llm-task-executor
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { ToolExecutor } from "../../../tools/executor";
import { getTools } from "../../../prompt";
import { clearSessionState, getSnippet } from "../../../common/state";
import { clearSessionWorkingDir } from "../../../tools/bash-handler";
import type { ToolCallExecution } from "../../../common/tool-types";
import type { LLMClient, LLMToolDefinition, LLMToolCall } from "../../../providers/llm-provider";
import type { SessionMessage } from "../../../session";
import type {
  P5DangerousCommandApproval,
  P5TaskExecutor,
  P5TaskExecutionInput,
  P5TaskExecutionResult,
} from "../handlers/task-executor-port";
import { detectShellCapabilityGap } from "../handlers/plan-stage-handler";

// ============================================================================
// 1. 常量定义（Object.freeze 冻结，运行期不可被模型/外部修改）
// ============================================================================

/**
 * P5 任务执行重入标志的 AsyncLocalStorage。
 *
 * 纵深防御（架构师 P1-1）：任务执行全程在 storage.run(true, ...) 中运行。
 * F9-v2 确定性通道入口（tryDeterministicEagExecution）读取此标志，
 * 若发现自身是被任务执行链路中的 LLM 文本间接触发，则拒绝再次进入自主循环。
 * 当前精简循环不经过 SessionManager，物理上不会触发；该存储用于防止未来接线回归。
 */
export const p5TaskExecutionStorage = new AsyncLocalStorage<boolean>();

/**
 * 允许任务执行器使用的工具白名单。
 *
 * - read：读取项目内文件（同样受路径牢笼与凭据模式约束，防止读密钥后外泄）；
 * - write：整文件创建/覆盖（足以完成新建与改写）；
 * - edit：基于 snippet 的精确替换（依赖先 read 获取 snippet_id，状态按合成 sessionId 隔离）；
 * - UpdatePlan：无副作用的计划更新工具，帮助模型组织步骤；
 * - bash：命令执行（开放给安装/容器/服务/数据库类任务真实执行，用户决策 2026-10-03）。
 *   进程内第二道防线见 DANGEROUS_COMMAND_PATTERNS：破坏性命令不静默放行，
 *   一律挂起等待宿主（CLI 审批提示 / Web 确认框）人工确认——批准才执行，
 *   拒绝/超时/无确认通道（fail-closed）deny 并把原因回灌模型。
 *
 * 明确不开放：
 * - AskUserQuestion：无人值守循环内无通用应答通道（高危 bash 确认走独立的
 *   dangerousCommandApproval 回调，不经过模型工具调用），开放只会造成挂起；
 * - skill / WebSearch / 图片工具 / MCP / codemap：超出"按卡编码"职责面。
 */
const ALLOWED_TOOL_NAMES: ReadonlySet<string> = Object.freeze(
  new Set<string>(["read", "write", "edit", "UpdatePlan", "bash"])
);

/**
 * bash 命令破坏性模式黑名单（高危命令人工确认的触发条件，2026-10-03）。
 *
 * 决策背景：用户明确要求 autonomous 任务直接 bash 执行（安装/容器/服务类任务），
 * 不再 fatal 拒绝；但高危命令（不可逆销毁 / 提权 / 关停主机 / 远程脚本管道）
 * 必须经宿主（CLI 审批提示 / Web 确认框）人工批准才可执行。
 *
 * 语义：命中任一模式 → 挂起等待 dangerousCommandApproval 人工决策；
 * 批准→执行；拒绝/超时/回调异常/无确认通道 → deny 并把原因回灌模型
 * （模型可改用安全替代方案），与主会话的 rm/sudo 审批守卫同源思路。
 */
const DANGEROUS_COMMAND_PATTERNS: ReadonlyArray<Readonly<[RegExp, string]>> = Object.freeze([
  // rm -rf / mkfs / dd 写块设备 / shred：不可逆销毁
  [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\s*\/(\s|$)/i, "rm -rf 根目录"],
  [/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/i, "rm -rf 递归强删"],
  [/\bmkfs(\.|\s)/i, "mkfs 格式化"],
  [/\bdd\s+if=.*of=\/dev\//i, "dd 写块设备"],
  [/\bshred\b/i, "shred 销毁文件"],
  // 全局提权安装（无人值守下污染宿主环境；项目内 npm/pip install 不命中）
  [/\bsudo\s+|-g\s+(npm|pip|pip3)\b|\bpip3?\s+install\b(?![^\n]*(--user|--target|--prefix|-r\s))/i, "全局/提权安装"],
  // 危险 chmod/chown（对 / 或整个 home）
  [/chmod\s+(-[a-zA-Z]+\s+)*(777|666)\s+\/|chown\s+(-[a-zA-Z]+\s+)*\S+\s+\/(\s|$)/i, "chmod/chown 根目录"],
  // 块设备/磁盘工具与内核模块
  [/\b(diskutil|fdisk|gdisk)\s+(erase|partition|dd)/i, "磁盘分区破坏"],
  // 直接关停宿主机（部署类任务常误发 shutdown，无人值守下不可挽回）
  [/\b(shutdown|halt|poweroff|reboot)\b/i, "主机关停/重启"],
  // curl/wget 管道直接执行远程脚本（供应链风险）
  [/\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b/i, "远程脚本管道执行"],
]);

/**
 * 检查 bash 命令是否命中破坏性模式（无人值守 deny 清单）。
 *
 * @param command 待执行命令原文
 * @returns 命中的风险描述；未命中返回 null（放行）
 */
function classifyDangerousCommand(command: string): string | null {
  for (const [pattern, label] of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return label;
    }
  }
  return null;
}

/**
 * 只读放行前缀（修复"查询读取文件被牢笼误拦"2026-10-03）：
 * read 工具为纯只读访问，以下前缀的读取不涉及写入风险，直接放行：
 * - /tmp、/var/tmp：临时目录（pip wheel、构建产物、日志的常规落点）
 * - os.tmpdir()：macOS 上为 /var/folders/...（mkdtemp 的真实落点），
 *   静态 /tmp 前缀覆盖不到，动态并入
 * - /opt：第三方安装包目录（deepcodex-install 等部署布局）
 * - /usr、/proc、/sys：系统库与只读伪文件系统（版本查询、依赖排查）
 * macOS 上 /tmp 实为 /private/tmp 符号链接，path.resolve 后统一为 /tmp 前缀。
 * 注意：/root、/home、/etc 等含用户数据/配置的目录不在只读放行之列，仍需牢笼约束。
 */
const READONLY_ALLOWED_PREFIXES: ReadonlyArray<string> = Object.freeze(
  [
    "/tmp",
    "/var/tmp",
    // macOS darwin 的 os.tmpdir() 是 /var/folders/xx/xxxx/T/，mkdtemp 文件真实落点
    os.tmpdir(),
    "/opt",
    "/usr",
    "/proc",
    "/sys",
  ].filter((prefix) => typeof prefix === "string" && prefix.length > 0)
);

/**
 * 判断路径是否命中只读放行前缀（路径段精确匹配，防 /tmpx 之类前缀误放行）。
 *
 * @param resolvedPath 已 path.resolve 归一化的绝对路径
 * @returns 命中任一放行前缀（或其子树）返回 true
 */
function isReadonlyAllowedPath(resolvedPath: string): boolean {
  return READONLY_ALLOWED_PREFIXES.some((prefix) => resolvedPath === prefix || resolvedPath.startsWith(prefix + "/"));
}

/**
 * 凭据文件模式黑名单（与 dev-stage-handler.ts 的 G-A5a 预检同源，保持独立副本，
 * 避免执行器反向依赖阶段处理器；两处模式需同步维护）。
 *
 * 命中任一模式的文件禁止 read/write/edit：
 * .env 系列、.ssh/.aws/.gnupg 目录、secrets/credentials/token/password 关键词、
 * .pem/.key/.p12/.pfx 证书密钥、.npmrc/.pypirc/.git-credentials 包管理器与 Git 凭据。
 */
const CREDENTIAL_FILE_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\.env(\.|$)/i,
  /\.ssh[\\/]/i,
  /\.aws[\\/]/i,
  /\.gnupg[\\/]/i,
  /secrets?/i,
  /credentials?/i,
  /\btoken\b/i,
  /\bpassword\b/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.npmrc$/i,
  /\.pypirc$/i,
  /\.git-credentials$/i,
]);

/**
 * 凭据模板文件豁免模式（纵深防御前的精确性修正）。
 *
 * .env.example / .env.prod.example / config.example.json / *.template 等
 * 纯模板文件按惯例不含真实凭据（真实值一律不提交入库），且安装引导
 * （cp .env.example .env.prod）依赖任务读取它们。仅当 basename 以
 * example/template/sample（可带 .env. 点段前缀）结尾时豁免；
 * .env / .env.prod 等无后缀真实文件不受影响，继续拦截。
 */
const CREDENTIAL_EXEMPT_PATTERN = /\.(?:example|template|sample)$/i;

/**
 * 判断目标文件是否命中凭据保护（含模板豁免）。
 *
 * 注意：lastIndex 复位是调用方责任（CREDENTIAL_FILE_PATTERNS 含 /g 不带、
 * 但 /i 无状态；本函数内统一不复位，与调用点行为保持一致）。
 *
 * @param relativePath 相对项目根的路径
 * @returns true 表示应拒绝访问
 */
function isCredentialProtected(relativePath: string): boolean {
  // 模板豁免优先：example/template/sample 后缀不视为凭据
  if (CREDENTIAL_EXEMPT_PATTERN.test(relativePath)) {
    return false;
  }
  return CREDENTIAL_FILE_PATTERNS.some((re) => re.test(relativePath));
}

/** 单任务工具循环默认最大轮数（每轮一次真实 LLM 请求 + 一批工具调用）。
 *
 * 【2026-10-07 从 12 提升到 40】：部署类目标（ssh 远程+构建镜像+推送+启动容器+curl
 * 验证+修 AF3 网络）需要几十步工具调用，12 轮结构性不足导致连续 2 轮相同失败后
 * 熔断 abort（docs/dev/eag-task-id-and-web-session-isolation.md §1.3 根因 B）。
 *
 * 提升到 40 轮的三重安全网：
 *  1. 拒绝风暴熔断（6 次/相同调用熔断 3 次）独立于轮数上限生效，空转不会烧完 40 轮
 *  2. 自然终态：绝大多数编码任务 5-12 轮即给出终态回复，40 轮是 ceiling 而非 floor
 *  3. 编排器级 token 预算（DEFAULT_MAX_TOKENS=200K）在 LoopScheduler 中独立闸门拦截
 */
const DEFAULT_MAX_TOOL_ROUNDS = 40;

/**
 * 递归按 key 排序 JSON 值（相同调用空转熔断的指纹规范化用，2026-10-05）。
 *
 * 对象键按键名升序重排（消除同一参数对象的键序差异），数组保序（顺序
 * 有语义，如工具调用序列），标量原样返回。仅处理 JSON 可表达的值形态。
 *
 * @param value 任意 JSON 值
 * @returns 键序规范化的同构值（不修改入参）
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** 单次 LLM 请求最大输出 token 数（执行循环不需要长篇解释） */
const EXECUTION_MAX_TOKENS = 8192;

/** 终态摘要最大保留字符数 */
const MAX_SUMMARY_CHARS = 2000;

/** git status 子命令超时（毫秒），超时/非 git 仓库按"无变更"降级，不使任务失败 */
const GIT_STATUS_TIMEOUT_MS = 10000;

/** 无 usage 回包时的字符→token 估算系数（保守 3.5 字符/token） */
const CHARS_PER_TOKEN_ESTIMATE = 3.5;

/**
 * 任务执行进度事件（供 Web UI 显示 autonomous 模式的执行进展）。
 *
 * 背景（修复 Web UI 分流只显示"思考中…"但不显示执行内容 2026-10-03）：
 * LlmTaskExecutor 走非流式 createMessage，不经过 SessionManager 的流式聚合
 * （emitLlmStreamProgress），因此 onLlmStreamProgress 收不到任何增量，
 * Web 前端的流式气泡永远停在 thinkingPending 萤火虫占位态。
 *
 * 本事件类型让执行器在关键节点（轮次开始/LLM 返回/工具调用/终态）
 * 主动推送结构化进度，由 SessionManager 转成 llm_delta SSE 帧透传前端，
 * 复用现有「思考过程」折叠区渲染执行日志。
 */
export interface P5TaskProgressEvent {
  /** 进度阶段标识 */
  readonly phase: "task_start" | "llm_request" | "tool_execution" | "task_end";
  /** 人类可读的进度文本（累积式，前端直接展示最新值） */
  readonly previewText: string;
  /** 执行日志文本（累积式，含轮次/工具名/结果摘要，前端渲染进「思考过程」折叠区） */
  readonly thinkingText: string;
  /** 当前迭代轮次（1-based，tool_execution 为产生该工具调用的轮次） */
  readonly round?: number;
  /** 本次任务累计真实 LLM 请求次数 */
  readonly llmRequests?: number;
}

/**
 * 任务执行进度回调类型（与 LlmTaskExecutorOptions.onTaskProgress 配对）。
 */
export type P5TaskProgressCallback = (event: Readonly<P5TaskProgressEvent>) => void;

/**
 * 执行器系统提示词。
 *
 * 刻意避免出现"EAG/自主任务/无人值守/自动循环"等 F9 确定性通道触发词（架构师 P1-1），
 * 防止模型回显文本时在重入场景下误触发命令解析。
 *
 * bash 开放（2026-10-03 用户决策）：规则 3 从"禁止执行 shell 命令"改为
 * "bash 真实执行 + 安全边界"——破坏性命令由进程内黑名单 + 人工确认闸门拦截，
 * 提示词如实告知模型可用能力，避免模型因不知道有 bash 而空转。
 */
const SYSTEM_PROMPT = [
  "你是一名在指定项目目录内工作的编码执行代理。你将收到一张明确的任务卡，",
  "必须通过工具调用真实完成任务，而不是仅给出建议或代码片段。",
  "",
  "硬性规则：",
  "1. 文件操作只能限定在任务指定项目目录内；项目目录之外的任何路径一律不要尝试写入。",
  "2. 禁止读取或写入环境变量文件、密钥、证书、凭据（如 .env、.ssh、.aws、secrets、*.pem、*.key）。",
  "3. 你可以用 bash 真实执行命令（安装依赖、docker、启动服务、git、测试命令等）；",
  "   但破坏性命令（rm -rf、sudo、格式化磁盘、关停主机、curl|sh 远程脚本等）会被安全守卫",
  "   拦截并要求人工确认——请优先使用安全替代方案，被拒绝后不要反复重试同一命令。",
  "4. 修改既有文件前先 read 读取内容；新文件用 write 直接创建，内容必须完整可用。",
  "5. 完成全部改动后，用一条不含工具调用的简短文本回复总结：实际创建/修改了哪些文件、",
  "   执行了哪些命令、每个改动的核心内容、如何验证。不要在终态回复中贴大段代码。",
  "6. 如果任务信息不足以安全动手，同样以无工具调用的文本回复说明缺少什么。",
].join("\n");

// ============================================================================
// 2. 构造选项与工厂
// ============================================================================

/** LlmTaskExecutor 构造选项（不可变） */
export interface LlmTaskExecutorOptions {
  /** 项目根目录绝对路径：路径牢笼边界，也是 ToolExecutor 的工作目录 */
  readonly projectRoot: string;
  /**
   * LLM 客户端工厂。
   * SessionManager 绑定时传 `() => this.createLLMClient()`（闭包内可达同类私有方法）；
   * 工厂返回 null 表示未配置凭据，executeTask 必须零请求失败（fail-closed）。
   */
  readonly createLlmClient: () => LLMClient | null;
  /** 模型名（仅用于 getTools 的多模态裁剪等，实际请求模型由 client 自身决定） */
  readonly model?: string;
  /** 可选日志回调（与 AutonomousOrchestrator 日志同构，此处结构化复制避免跨层类型依赖） */
  readonly logger?: (message: string, level?: "info" | "warn" | "error") => void;
  /** 单任务工具循环最大轮数，默认 12；测试可收窄 */
  readonly maxToolRounds?: number;
  /**
   * 任务执行进度回调（可选，默认无操作）。
   *
   * Web UI 接线：SessionManager 构造执行器时注入 `(e) => this.emitLlmStreamProgress(...)`
   * 适配器，把执行进展转成 llm_delta SSE 帧，让前端「思考过程」区实时显示
   * autonomous 模式下的轮次/工具调用/终态摘要（docs/dev/web-thinking-display.md 补充）。
   */
  readonly onTaskProgress?: P5TaskProgressCallback;
  /**
   * bash 高危命令人工确认回调（可选，宿主注入，2026-10-03）。
   *
   * 命中 DANGEROUS_COMMAND_PATTERNS 的 bash 命令经此回调挂起等待人类批准/拒绝
   * （CLI 审批提示 / Web 前端确认框）；未注入时高危命令 fail-closed 直接 deny。
   * 契约（超时/异常一律按拒绝）见 task-executor-port.ts。
   */
  readonly dangerousCommandApproval?: P5DangerousCommandApproval;
}

// ============================================================================
// 3. 执行器实现
// ============================================================================

/**
 * 基于精简 LLM↔工具循环的 P5 任务执行器（生产实现）。
 *
 * 生命周期：由 SessionManager 构造一次，bindTaskExecutor 注入 orchestrator，
 * 多次 run 复用（实例无任务级可变状态，任务级状态全部在 executeTask 调用栈内）。
 */
export class LlmTaskExecutor implements P5TaskExecutor {
  private readonly projectRoot: string;
  private readonly createLlmClient: () => LLMClient | null;
  private readonly model: string | undefined;
  private readonly log: (message: string, level?: "info" | "warn" | "error") => void;
  private readonly maxToolRounds: number;
  /** 任务执行进度回调（默认无操作；Web 接线时推送 llm_delta 进度帧） */
  private readonly onTaskProgress: P5TaskProgressCallback;
  /**
   * bash 高危命令人工确认回调（宿主注入；undefined 表示无宿主确认通道，
   * 高危命令 fail-closed 直接 deny，2026-10-03）。
   */
  private readonly dangerousCommandApproval: P5DangerousCommandApproval | undefined;

  /**
   * 相同调用重复熔断阈值（修复 2026-10-05 自主任务 12 轮 bash 空转事故）：
   * 同一"工具名+参数"规范化指纹连续命中达到此次数，说明模型在重复同一
   * 无效动作空转（无新信息输入），立即终止本轮循环并失败——不再烧完
   * 剩余轮次（每轮一次完整 LLM 请求 + 一次真实命令执行，纯 token 浪费）。
   */
  private static readonly IDENTICAL_CALL_STORM_LIMIT = 3;

  constructor(options: Readonly<LlmTaskExecutorOptions>) {
    this.projectRoot = options.projectRoot;
    this.createLlmClient = options.createLlmClient;
    this.model = options.model;
    this.log = options.logger ?? (() => undefined);
    this.onTaskProgress = options.onTaskProgress ?? (() => undefined);
    this.dangerousCommandApproval = options.dangerousCommandApproval;
    const rounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    if (!Number.isInteger(rounds) || rounds <= 0) {
      throw new Error(`LlmTaskExecutor maxToolRounds 必须为正整数，实际：${String(rounds)}`);
    }
    this.maxToolRounds = rounds;
  }

  /**
   * 执行单张任务卡（端口实现）。
   *
   * 全程包在 p5TaskExecutionStorage 重入标志中；任何异常都收敛为
   * success=false 结果（不向编排器抛出，避免单任务异常击穿循环）。
   */
  async executeTask(input: Readonly<P5TaskExecutionInput>): Promise<Readonly<P5TaskExecutionResult>> {
    return p5TaskExecutionStorage.run(true, () => this.runLoop(input));
  }

  // ==========================================================================
  // 3.1 主循环
  // ==========================================================================

  /**
   * 工具循环主体（executeTask 的重入标志包裹版本）。
   */
  private async runLoop(input: Readonly<P5TaskExecutionInput>): Promise<Readonly<P5TaskExecutionResult>> {
    // 合成 sessionId：仅供 ToolExecutor 的 snippet/文件状态按执行次隔离，
    // 绝不写入 sessions-index.json，执行结束立即 clearSessionState 释放模块级状态。
    const toolSessionId = `p5-${input.runId}-i${input.iterIndex}-${input.stage}`;
    const abortController = new AbortController();

    // 自有 ToolExecutor：不传 openAIClient 与 mcpManager，
    // 构造函数内 registerToolHandlers() 注册全部内置真实文件工具（零 mock）。
    const toolExecutor = new ToolExecutor(this.projectRoot, undefined, undefined, this.createLlmClient);

    // 白名单工具定义（仅向 LLM 暴露这 4 个工具的 schema）
    const toolDefinitions = this.buildAllowedToolDefinitions();

    // 会话消息序列（system + user 起始，随后 assistant/tool 交替追加）
    const messages: SessionMessage[] = [
      this.buildSessionMessage("system", SYSTEM_PROMPT, null),
      this.buildSessionMessage("user", this.buildUserPrompt(input), null),
    ];

    let llmRequests = 0;
    let inputTokensTotal = 0;
    let outputTokensTotal = 0;
    let estimatedCharsTotal = 0;
    let sawUsage = false;

    // 进度文本累积（Web UI「思考过程」区消费，2026-10-03 修复 autonomous 无进展显示）：
    // thinkingLog 累积执行日志（轮次/工具/结果），progressPreview 累积人类可读进展行
    let thinkingLog = "";
    let progressPreview = "";
    /** 推送一次进度事件（内部闭包，捕获累积文本与执行上下文） */
    const emitProgress = (
      phase: P5TaskProgressEvent["phase"],
      previewLine: string,
      thinkingLine: string,
      round?: number
    ): void => {
      if (previewLine) {
        progressPreview = progressPreview ? `${progressPreview}\n${previewLine}` : previewLine;
      }
      if (thinkingLine) {
        thinkingLog = thinkingLog ? `${thinkingLog}\n${thinkingLine}` : thinkingLine;
      }
      this.onTaskProgress({
        phase,
        previewText: progressPreview,
        thinkingText: thinkingLog,
        round,
        llmRequests,
      });
    };

    try {
      // 进入循环前先取一次客户端：无凭据直接 fail-closed，不发起任何请求
      const client = this.createLlmClient();
      if (client === null || client === undefined) {
        return this.failure(
          "LLM 客户端不可用：未配置 API 凭据（请检查 settings.json 与环境变量）",
          llmRequests,
          sawUsage,
          inputTokensTotal + outputTokensTotal,
          estimatedCharsTotal
        );
      }

      emitProgress(
        "task_start",
        `开始执行任务 ${input.taskId}（${input.taskTitle}）`,
        `阶段：${input.stage} | 迭代：${input.iterIndex} | 任务：${input.taskId} ${input.taskTitle}`
      );

      // 能力提示（原 fatal 拒绝已随 bash 开放降级为 info，2026-10-03 用户决策）：
      // 执行器现已开放 bash，安装/远程/容器/服务类任务可直接执行，不再 fatal 终止。
      // 仅在任务文本命中 shell 语义时于「思考过程」区提示一句，帮助使用者了解
      // 后续将真实执行命令（高危命令仍有人工确认闸门兜底）。
      const capabilityGap = detectShellCapabilityGap([input.taskTitle, input.objective, ...input.acceptanceCriteria]);
      if (capabilityGap.requiresShell) {
        emitProgress(
          "task_start",
          `任务涉及命令执行（${capabilityGap.capabilities.join("、")}），将通过 bash 真实执行`,
          `能力提示：任务文本命中 ${capabilityGap.capabilities.join("、")} 语义，执行器将用 bash 真实执行相关命令；高危命令会挂起等待人工确认。`
        );
      }

      // 拒绝风暴 fail-fast（修复"同一错误静默重复烧轮"2026-10-03）：
      // 按"被拒目标指纹"分组计数——同一目标路径/同一被拒工具重复命中即累计；
      // 其他目标的合法调用穿插不清零（此前一次成功调用即整体清零，模型
      // "成功一次→再撞同一堵墙"的循环恰好绕过计数，烧满 12 轮才终止）。
      // 任一指纹达到阈值立即终止并醒目标注重复目标，交回编排器决定 fix/abort。
      const denialCountsByTarget = new Map<string, number>();
      const DENIAL_STORM_LIMIT = 6;

      // 相同调用重复熔断（修复 2026-10-05 自主任务 12 轮 bash 空转事故）：
      // 模型连续输出完全相同的"工具名+规范化参数"调用（无任何新信息输入）
      // 即为空转——上次调用结果已回灌历史，重复执行既无新信息也必无新结果。
      // 与拒绝风暴互补：风暴只计被 deny 的调用，此熔断覆盖 approve 后重复
      // 执行的无效探索（如反复 ls / 反复 git status）。连续计数：出现不同
      // 调用即重置，同一指纹连续命中达阈值立即终止。
      let lastCallFingerprint: string | null = null;
      let identicalCallStreak = 0;

      for (let round = 1; round <= this.maxToolRounds; round += 1) {
        // 每轮顶部双重 abort 检查：标志文件（跨进程 stop）+ AbortSignal（进程内）
        if (this.isAbortRequested(input.abortFlagPath) || abortController.signal.aborted) {
          return this.failure(
            "aborted：任务执行被中止信号中断",
            llmRequests,
            sawUsage,
            inputTokensTotal + outputTokensTotal,
            estimatedCharsTotal
          );
        }

        // 真实非流式 LLM 请求（简单、usage 直接可得、无 skill 预请求缝隙）
        emitProgress(
          "llm_request",
          `第 ${round} 轮：向模型发起请求…`,
          `── 轮次 ${round}/${this.maxToolRounds}：LLM 请求开始`,
          round
        );
        const response = await client.createMessage({
          messages,
          tools: toolDefinitions,
          thinkingEnabled: false,
          maxTokens: EXECUTION_MAX_TOKENS,
          signal: abortController.signal,
        });
        llmRequests += 1;

        // usage 累计（部分网关不回 usage：记录字符数，结束时估算保底）
        if (response.usage) {
          sawUsage = true;
          inputTokensTotal += response.usage.inputTokens;
          outputTokensTotal += response.usage.outputTokens;
        } else {
          estimatedCharsTotal += this.lastUserishContentChars(messages) + response.content.length;
        }

        // 无工具调用 = 模型终态回复：任务执行正常结束
        if (response.toolCalls.length === 0) {
          const changedFiles = this.listGitChangedFiles(input.projectRoot);
          const tokensUsed = this.resolveTokensUsed(
            sawUsage,
            inputTokensTotal + outputTokensTotal,
            estimatedCharsTotal
          );
          emitProgress(
            "task_end",
            `任务完成：${(response.content || "").slice(0, 200)}`,
            `── 轮次 ${round}：模型给出终态回复，任务正常结束\n变更文件：${changedFiles.length > 0 ? changedFiles.join(", ") : "（无）"}`,
            round
          );
          return Object.freeze({
            success: true,
            summary: (response.content || "").slice(0, MAX_SUMMARY_CHARS),
            tokensUsed: tokensUsed.tokens,
            tokensEstimated: tokensUsed.estimated,
            llmRequests,
            changedFiles: Object.freeze(changedFiles),
          });
        }

        // 追加 assistant 工具调用消息（OpenAI tool_calls 形态，双 converter 均识别）
        messages.push(this.buildAssistantToolCallMessage(response.toolCalls, response.content));

        // 真实执行工具调用（越权由 onBeforeToolExecution 进程内硬判，deny 结果原样回灌）
        emitProgress(
          "tool_execution",
          `第 ${round} 轮：执行 ${response.toolCalls.map((tc) => tc.name).join("、")}`,
          `── 轮次 ${round}：LLM 返回 ${response.toolCalls.length} 个工具调用：${response.toolCalls
            .map((tc) => `${tc.name}(${this.summarizeToolArgs(tc.argumentsJson)})`)
            .join("；")}`,
          round
        );
        const executions: ToolCallExecution[] = await toolExecutor.executeToolCalls(
          toolSessionId,
          response.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.argumentsJson },
          })),
          {
            signal: abortController.signal,
            shouldStop: () => this.isAbortRequested(input.abortFlagPath),
            onBeforeToolExecution: (toolName, args) =>
              this.authorizeToolCall(toolName, args, toolSessionId, input, emitProgress),
          }
        );

        // 每个工具结果作为独立 tool 消息（tool_call_id 与调用一一配对）
        const toolResults: string[] = [];
        // 本轮被拒指纹的最大累计计数与对应目标（风暴判定用，跨轮累计不清零）
        let stormHitCount = 0;
        let stormTarget = "";
        for (let i = 0; i < executions.length; i += 1) {
          const execution = executions[i]!;
          messages.push(
            this.buildSessionMessage("tool", execution.content, Object.freeze({ tool_call_id: execution.toolCallId }))
          );
          toolResults.push(
            `${this.isDeniedToolExecution(execution) ? "✗ 拒绝" : "✓"} ${execution.content.slice(0, 120)}`
          );
          // 拒绝风暴计数（按被拒目标指纹分组）：同一目标重复 deny 即累计，
          // 不同目标/成功调用互不干扰——合法穿插调用不再给风暴"续命清零"
          if (this.isDeniedToolExecution(execution)) {
            const toolCall = response.toolCalls[i]!;
            const fingerprint = this.denialFingerprint(toolCall.name, toolCall.argumentsJson);
            const count = (denialCountsByTarget.get(fingerprint) ?? 0) + 1;
            denialCountsByTarget.set(fingerprint, count);
            if (count > stormHitCount) {
              stormHitCount = count;
              stormTarget = fingerprint;
            }
          }
        }
        emitProgress("tool_execution", "", `工具结果：\n${toolResults.join("\n")}`, round);
        if (stormHitCount >= DENIAL_STORM_LIMIT) {
          const stormError =
            `拒绝风暴：同一目标「${stormTarget}」累计 ${stormHitCount} 次被权限守卫拒绝——` +
            `反复重试同一堵墙不会变通，目标可能超出执行器安全边界` +
            `（路径牢笼 / 凭据守卫 / 高危命令未获人工确认）。请调整任务目标、文件范围，或改用安全替代命令。`;
          emitProgress("task_end", `执行失败：拒绝风暴`, stormError, round);
          return this.failure(
            stormError,
            llmRequests,
            sawUsage,
            inputTokensTotal + outputTokensTotal,
            estimatedCharsTotal
          );
        }

        // 相同调用重复熔断判定（本轮全部调用之后统一评估）：把本轮工具序列
        // 拼成一个批量指纹，与上一轮比较。连续相同即模型空转。
        const batchFingerprint = response.toolCalls
          .map((tc) => `${tc.name}:${this.normalizeToolArgsFingerprint(tc.argumentsJson)}`)
          .join("||");
        if (batchFingerprint === lastCallFingerprint) {
          identicalCallStreak += 1;
        } else {
          lastCallFingerprint = batchFingerprint;
          identicalCallStreak = 1;
        }
        if (identicalCallStreak >= LlmTaskExecutor.IDENTICAL_CALL_STORM_LIMIT) {
          const identicalError =
            `相同调用空转熔断：模型连续 ${identicalCallStreak} 轮输出完全相同的工具调用` +
            `「${batchFingerprint.slice(0, 200)}」——重复执行不会带来新信息，` +
            `任务描述大概率缺少可执行信息或与工作目录现状矛盾（如标题声称已完成/目标与项目无关）。` +
            `请检查任务卡内容是否可执行、目标是否与当前项目匹配，或补充缺失上下文后重试。`;
          this.log(identicalError, "warn");
          emitProgress("task_end", `执行失败：相同调用空转熔断`, identicalError, round);
          return this.failure(
            identicalError,
            llmRequests,
            sawUsage,
            inputTokensTotal + outputTokensTotal,
            estimatedCharsTotal
          );
        }
      }

      // 达到轮数上限仍在持续调用工具：诚实判失败，交回编排器决定 fix/abort
      const roundLimitError = `工具循环达上限（${this.maxToolRounds} 轮）仍未给出终态回复`;
      emitProgress("task_end", `执行失败：${roundLimitError}`, roundLimitError);
      return this.failure(
        roundLimitError,
        llmRequests,
        sawUsage,
        inputTokensTotal + outputTokensTotal,
        estimatedCharsTotal
      );
    } catch (error) {
      // AbortError：用户/编排器主动中止
      if (error instanceof Error && error.name === "AbortError") {
        emitProgress("task_end", "执行中止：任务被中止信号中断", "aborted：任务执行被中止信号中断");
        return this.failure(
          "aborted：任务执行被中止信号中断",
          llmRequests,
          sawUsage,
          inputTokensTotal + outputTokensTotal,
          estimatedCharsTotal
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      this.log(`任务执行异常：${message}`, "error");
      emitProgress("task_end", `执行异常：${message}`, `任务执行异常：${message}`);
      return this.failure(
        `任务执行异常：${message}`,
        llmRequests,
        sawUsage,
        inputTokensTotal + outputTokensTotal,
        estimatedCharsTotal
      );
    } finally {
      // 释放合成 sessionId 在 common/state 模块级 Map 中累积的 snippet/文件状态
      clearSessionState(toolSessionId);
      // 同步释放 bash-handler 模块级 sessionWorkingDirs 中该 sessionId 的 cwd 缓存，
      // 防止临时项目目录被清理后残留 stale 路径，导致后续同名 sessionId 的任务 spawn ENOENT。
      clearSessionWorkingDir(toolSessionId);
    }
  }

  /**
   * 判断一次工具执行是否为"权限守卫拒绝"（拒绝风暴计数用，2026-10-03）。
   *
   * deny 回灌的固定文案由 ToolExecutor 审批门控产生
   * （"工具执行被审批门控拒绝（Tool execution denied by approval gate）"），
   * 这里用稳定子串匹配；后续若审批文案调整需同步本匹配式。
   *
   * @param execution 工具执行结果
   * @returns true 表示该次调用被审批门控 deny
   */
  private isDeniedToolExecution(execution: ToolCallExecution): boolean {
    return execution.content.includes("审批门控拒绝") || execution.content.includes("denied by approval gate");
  }

  /**
   * 计算一次工具调用的"被拒目标指纹"（拒绝风暴分组计数用，2026-10-03）。
   *
   * 指纹 = 工具名 + 归一化后的 file_path（绝对路径原样、相对路径去 ./ 前缀），
   * 无 file_path 的调用（edit 走 snippet_id / UpdatePlan 等）退化为原始参数
   * JSON 截断——保证"同一被拒路径/同一错误重复即计"，不同目标各自独立计数。
   *
   * @param toolName 工具名
   * @param argumentsJson 工具参数原始 JSON
   * @returns 分组键（≤140 字符，直接用于失败文案展示）
   */
  private denialFingerprint(toolName: string, argumentsJson: string): string {
    try {
      const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
      const filePath = typeof parsed.file_path === "string" ? parsed.file_path : "";
      if (filePath) {
        // 归一化：绝对路径 resolve 消除 ./ ../ 变体，避免同一路径两种写法绕过分组
        const normalized = path.isAbsolute(filePath)
          ? path.normalize(filePath)
          : path.normalize(filePath).replace(/^\.\//, "");
        return `${toolName}:${normalized}`;
      }
      return `${toolName}:${JSON.stringify(parsed).slice(0, 100)}`;
    } catch {
      return `${toolName}:${argumentsJson.slice(0, 100)}`;
    }
  }

  /**
   * 规范化工具参数 JSON 为稳定指纹（相同调用空转熔断用，2026-10-05）。
   *
   * 与 denialFingerprint 的区别：这里比较的是"两次调用是否完全等价"，
   * 必须覆盖**全部**参数且顺序无关——JSON.parse 后按 key 排序重新序列化，
   * 消除 {"a":1,"b":2} 与 {"b":2,"a":1} 的键序差异；字符串值原样保留
   * （bash 的 command、write 的 content 任一字符不同即视为不同调用）。
   * 解析失败（非法 JSON）退化为 trim 后的原文，宁可少判空转不可误判。
   *
   * @param argumentsJson 工具参数原始 JSON
   * @returns 规范化指纹（键序稳定的 JSON 或截断原文）
   */
  private normalizeToolArgsFingerprint(argumentsJson: string): string {
    try {
      const parsed = JSON.parse(argumentsJson) as unknown;
      return JSON.stringify(sortJsonValue(parsed));
    } catch {
      return argumentsJson.trim().slice(0, 400);
    }
  }

  /**
   * 把工具参数 JSON 压缩成一行人类可读摘要（进度日志用，2026-10-03）。
   *
   * 优先展示 file_path（read/write/edit 最常见的定位参数），
   * 解析失败或无 file_path 时退化为截断的原始 JSON，避免进度日志膨胀。
   *
   * @param argumentsJson 工具参数原始 JSON 字符串
   * @returns 一行摘要（≤80 字符）
   */
  private summarizeToolArgs(argumentsJson: string): string {
    try {
      const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
      const filePath = typeof parsed.file_path === "string" ? parsed.file_path : "";
      if (filePath) {
        // 只显示相对路径最后两段，避免绝对路径过长
        const parts = filePath.split("/").filter(Boolean);
        return parts.length > 2 ? parts.slice(-2).join("/") : filePath;
      }
      return JSON.stringify(parsed).slice(0, 60);
    } catch {
      return argumentsJson.slice(0, 60);
    }
  }

  // ==========================================================================
  // 3.2 权限硬判（白名单 + 路径牢笼 + 凭据模式）
  // ==========================================================================

  /**
   * 工具执行前的进程内审批钩子（不挂起、不询问、不落盘）。
   *
   * @param toolName 工具原名（别名映射前）
   * @param args 已解析的工具参数
   * @param toolSessionId 合成 sessionId（edit 无 file_path 时反查 snippet 归属文件）
   * @returns approve 放行 / deny 拒绝（拒绝结果由 ToolExecutor 回灌模型）
   */
  private async authorizeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    toolSessionId: string,
    input: Readonly<P5TaskExecutionInput>,
    emitProgress: (
      phase: P5TaskProgressEvent["phase"],
      previewLine: string,
      thinkingLine: string,
      round?: number
    ) => void
  ): Promise<"approve" | "deny" | "ask_user"> {
    // 第一层：工具白名单（schema 已只暴露白名单工具，这里防模型/调用方注入其他工具名）
    if (!ALLOWED_TOOL_NAMES.has(toolName)) {
      this.log(`工具被白名单拒绝：${toolName}`, "warn");
      return "deny";
    }

    // UpdatePlan 无文件参数，直接放行
    if (toolName === "UpdatePlan") {
      return "approve";
    }

    // bash 专用通道：命令安全策略 + 高危人工确认（2026-10-03 用户决策：
    // autonomous 任务直接 bash 执行安装/容器/服务类命令，不再 fatal 拒绝；
    // 但命中破坏性模式的高危命令必须经宿主（CLI/Web）人类批准才可执行）。
    if (toolName === "bash") {
      const command = typeof args.command === "string" ? args.command : "";
      if (!command.trim()) {
        this.log("bash 调用缺少 command 参数，拒绝", "warn");
        return "deny";
      }
      const risk = classifyDangerousCommand(command);
      // 常规命令（npm/pip install、docker、curl、git、测试命令等）直接放行
      if (risk === null) {
        return "approve";
      }
      // 高危命令：无确认通道 → fail-closed 拒绝（宁可误拒不可误放）
      const approval = this.dangerousCommandApproval ?? input.dangerousCommandApproval;
      if (approval === undefined) {
        this.log(`高危命令被拒绝（无确认通道）：${risk} → ${command.slice(0, 120)}`, "warn");
        return "deny";
      }
      // 有确认通道：挂起等待人类决策，并把"等待确认"状态透出到 Web「思考过程」区
      emitProgress(
        "tool_execution",
        `等待人工确认高危命令（${risk}）…`,
        `⚠ 高危命令等待确认：${command.slice(0, 300)}（风险：${risk}）`
      );
      let approved = false;
      try {
        approved = await approval({
          command,
          risk,
          taskId: input.taskId,
          taskTitle: input.taskTitle,
          runId: input.runId,
        });
      } catch (approvalError) {
        // 回调异常按拒绝处理（契约：fail-closed），原因入日志便于排查宿主故障
        const message = approvalError instanceof Error ? approvalError.message : String(approvalError);
        this.log(`高危命令确认回调异常，按拒绝处理：${message}`, "warn");
        approved = false;
      }
      emitProgress(
        "tool_execution",
        approved ? "人工确认：批准执行高危命令" : "人工确认：拒绝执行高危命令",
        approved ? `人工已批准高危命令（${risk}），继续执行` : `人工拒绝/超时未确认高危命令（${risk}），该调用被 deny`
      );
      return approved ? "approve" : "deny";
    }

    // 第二层：解析目标文件路径。
    // read/write 必须携带 file_path；edit 允许仅给 snippet_id（先 read 后 edit 的正常流程），
    // 此时从 snippet 状态反查文件路径，确保 edit 目标同样受牢笼约束。
    let targetPath = typeof args.file_path === "string" ? args.file_path : "";
    if (!targetPath && toolName === "edit" && typeof args.snippet_id === "string") {
      targetPath = getSnippet(toolSessionId, args.snippet_id)?.filePath ?? "";
    }
    if (!targetPath) {
      this.log(`${toolName} 缺少可定位的文件路径（file_path 或有效 snippet_id）`, "warn");
      return "deny";
    }

    // 第二层半：只读放行（修复"查询读取文件被牢笼误拦"2026-10-03）：
    // read 工具读取 /tmp、/opt 等只读安全前缀时直接放行——排查日志、读 wheel/安装包
    // 是任务执行的正常查询路径，牢笼的本意是防"写入"越界而非禁一切读取。
    //
    // 但只读放行绝不能架空凭据守卫（2026-10-04 安全加固）：
    // 原代码在只读放行前缀命中后直接 return "approve"，跳过了第四层凭据判定——
    // 当 LLM 试图读取 /tmp/.env 或 /tmp/secrets.key 这种越出牢笼但 basename
    // 命中凭据模式的文件时，会被静默放行（真实安全漏洞）。
    // 修复：在只读放行 approve 之前，同样对 earlyResolved 的 basename 执行
    // isCredentialProtected 检查，确保 /tmp/.env、/var/tmp/credentials 等
    // 越界凭据文件一律被拦截。
    //
    // 牢笼内凭据（单测/沙箱项目位于临时目录下的 .env*）不进入此分支——
    // earlyIsInside=true 时上面的 if 被跳过，继续走第四层凭据判定，不受影响。
    const earlyResolved = path.resolve(this.projectRoot, targetPath);
    const earlyRelative = path.relative(path.resolve(this.projectRoot), earlyResolved);
    const earlyIsInside = earlyRelative === "" || (!earlyRelative.startsWith("..") && !path.isAbsolute(earlyRelative));
    if (toolName === "read" && !earlyIsInside && isReadonlyAllowedPath(earlyResolved)) {
      // 安全加固（2026-10-04）：越出牢笼但命中只读前缀时，仍需对 basename 执行凭据守卫
      // 防止 /tmp/.env、/var/tmp/private.pem 等凭据文件通过只读放行绕过拦截
      if (isCredentialProtected(path.basename(earlyResolved))) {
        this.log(`凭据文件访问被拒绝（只读放行前缀拦截）：${earlyResolved}`, "warn");
        return "deny";
      }
      return "approve";
    }

    // 第三层：路径牢笼（与 dev-stage-handler G-A1a 同构：resolve 后前缀校验）
    const resolvedRoot = path.resolve(this.projectRoot);
    const resolvedTarget = path.resolve(this.projectRoot, targetPath);
    const relativePath = path.relative(resolvedRoot, resolvedTarget);
    const isInside = relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));

    // 第四层：凭据模式（牢笼内外一律拒绝，纵深防御；豁免模板文件）。
    // 必须前置于牢笼判定：macOS 上 /var → /private/var 符号链接布局下，
    // path.relative 对同一秒链根内的两个路径会按 lexical 语义得出 ".." 前缀
    // （如 root=/var/folders/x/T/p 对 target=/var/folders/x/T/p/.env.sensitive
    // 在部分 Node 版本归一化下失配），凭据检查若只覆盖"根内"文件，
    // .env* 会在越界分支被放行——真实事故验证：.env.sensitive 读取 deny 静默失效。
    // 凭据守卫本就对越界路径同样适用，用 basename 判定保证两种形态拦截一致。
    if (isCredentialProtected(path.basename(resolvedTarget))) {
      this.log(`凭据文件访问被拒绝：${relativePath}`, "warn");
      return "deny";
    }

    if (!isInside) {
      this.log(`路径越界被拒绝：${targetPath}（牢笼：${resolvedRoot}）`, "warn");
      return "deny";
    }

    return "approve";
  }

  // ==========================================================================
  // 3.3 消息与提示词构造
  // ==========================================================================

  /**
   * 从 getTools() 全量内置工具中筛选白名单并映射为 provider 无关的 LLMToolDefinition。
   * nonInteractive:true 使 getTools 不注册 AskUserQuestion（无人应答）。
   */
  private buildAllowedToolDefinitions(): LLMToolDefinition[] {
    const allTools = getTools({ model: this.model, nonInteractive: true }, []);
    const allowed: LLMToolDefinition[] = [];
    for (const tool of allTools) {
      const name = tool.function.name;
      if (ALLOWED_TOOL_NAMES.has(name)) {
        allowed.push({
          name,
          description: tool.function.description,
          parameters: tool.function.parameters as Record<string, unknown>,
        });
      }
    }
    return allowed;
  }

  /**
   * 构造 user 提示词：任务背景 + 卡 ID/标题 + 验收标准 + fix 阶段失败反馈。
   */
  private buildUserPrompt(input: Readonly<P5TaskExecutionInput>): string {
    const lines: string[] = [
      `工作目录（绝对路径，所有文件操作的牢笼）：${input.projectRoot}`,
      `任务目标背景：${input.objective}`,
      `任务卡：${input.taskId} ${input.taskTitle}`,
    ];
    if (input.acceptanceCriteria.length > 0) {
      lines.push("验收标准：");
      for (const criterion of input.acceptanceCriteria) {
        lines.push(`- ${criterion}`);
      }
    } else {
      lines.push("验收标准：任务卡未显式列出，请按标题与目标背景做出完整、可用的实现。");
    }
    if (input.stage === "fix") {
      lines.push("", "本任务此前的验证失败反馈（请据此修复，不要重复导致失败的做法）：");
      lines.push(input.feedback ?? "（未提供具体失败反馈，请重新审查实现与测试结果）");
    }
    lines.push("", "现在开始：需要读取文件就调用 read，确认改动方案后用 write/edit 真实落盘，全部完成后给出终态文本。");
    return lines.join("\n");
  }

  /**
   * 构造一条最小合法 SessionMessage（不含持久化语义，仅供 provider 转换请求）。
   */
  private buildSessionMessage(role: SessionMessage["role"], content: string, messageParams: unknown): SessionMessage {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      sessionId: "p5-task-execution",
      role,
      content,
      contentParams: null,
      messageParams,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
    };
  }

  /**
   * 构造带工具调用的 assistant 消息。
   * messageParams.tool_calls 使用 OpenAI 形态：
   * {id,type:"function",function:{name,arguments}}，
   * OpenAIMessageConverter 与 AnthropicMessageConverter 均从此字段提取工具调用。
   */
  private buildAssistantToolCallMessage(toolCalls: ReadonlyArray<LLMToolCall>, text: string): SessionMessage {
    return this.buildSessionMessage(
      "assistant",
      text || "",
      Object.freeze({
        tool_calls: Object.freeze(
          toolCalls.map((tc) =>
            Object.freeze({
              id: tc.id,
              type: "function" as const,
              function: Object.freeze({ name: tc.name, arguments: tc.argumentsJson }),
            })
          )
        ),
      })
    );
  }

  // ==========================================================================
  // 3.4 abort / token / git 辅助
  // ==========================================================================

  /**
   * 检查跨进程 abort 标志文件是否存在。
   * 路径为空（未注入）时跳过文件检查，仅依赖 AbortSignal。
   */
  private isAbortRequested(abortFlagPath: string): boolean {
    if (!abortFlagPath) {
      return false;
    }
    try {
      return fs.existsSync(abortFlagPath);
    } catch {
      // 标志文件探测本身失败（权限等）不阻断执行，下一轮继续探测
      return false;
    }
  }

  /**
   * 结算真实 token 用量。
   * - 网关回了 usage：直接用累计值；
   * - 全程无 usage：按字符数估算保底 ≥1（保证 orchestrator 的 llmCallCount 凭证成立），
   *   并标 tokensEstimated=true（架构师 P1-6：计数与 token 解耦，估算不伪装成真实值）。
   */
  private resolveTokensUsed(
    sawUsage: boolean,
    realTokens: number,
    estimatedChars: number
  ): { tokens: number; estimated: boolean } {
    if (sawUsage && realTokens > 0) {
      return { tokens: realTokens, estimated: false };
    }
    const estimated = Math.max(1, Math.ceil(estimatedChars / CHARS_PER_TOKEN_ESTIMATE));
    return { tokens: estimated, estimated: true };
  }

  /**
   * 估算上一轮对话字符规模（仅在网关不回 usage 时使用）：
   * 取当前消息序列总字符，近似覆盖输入侧规模。
   */
  private lastUserishContentChars(messages: ReadonlyArray<SessionMessage>): number {
    let total = 0;
    for (const message of messages) {
      if (typeof message.content === "string") {
        total += message.content.length;
      }
    }
    return total;
  }

  /**
   * 真实执行 `git status --porcelain` 检出变更文件（相对路径）。
   * 非 git 仓库 / git 不存在 / 超时：返回空数组，不因此判任务失败
   * （变更文件只用于制品与报告，成功与否由 verify 阶段裁定）。
   *
   * 必须带 `--untracked-files=all`：porcelain 默认会把未跟踪【目录】折叠成
   * "?? src/"（目录名 + 斜杠），而 LLM 执行任务最常见的产物正是新建文件，
   * 折叠会导致 changedFiles 只剩目录前缀、dev 阶段 changeDiff 失真。
   * `-uall` 强制展开到每个未跟踪文件（如 "?? src/answer.js"）。
   */
  private listGitChangedFiles(projectRoot: string): string[] {
    try {
      const stdout = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: projectRoot,
        timeout: GIT_STATUS_TIMEOUT_MS,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const files: string[] = [];
      for (const rawLine of stdout.split("\n")) {
        const line = rawLine.trimEnd();
        if (!line) {
          continue;
        }
        // porcelain：前两位为状态码，第 4 列起为路径；重命名形如 "old -> new"
        let filePath = line.slice(3);
        if (filePath.includes(" -> ")) {
          filePath = filePath.split(" -> ")[1] ?? filePath;
        }
        // 含空格/特殊字符的路径可能被引号包裹
        if (filePath.startsWith('"') && filePath.endsWith('"')) {
          filePath = filePath.slice(1, -1);
        }
        if (filePath) {
          files.push(filePath);
        }
      }
      return files;
    } catch {
      return [];
    }
  }

  /**
   * 构造失败结果（不报告变更文件：失败语义下 changedFiles 无消费意义，
   * 残留改动可由下一轮 plan/dev 的真实盘点与 git status 重新检出）。
   *
   * 【2026-10-07 签名扩展】新增 sawUsage / realTokens / estimatedChars 入参。
   * 旧实现硬编码 tokensUsed:0，导致 RunState.totalTokensUsed 与 totalLlmCallCount
   * 在"达到轮数上限熔断"等 failure 路径下恒为 0——编排器用 tokensUsed>0 近似
   * 估算 llmCallCount，failure 路径下 tokensUsed=0 → 该轮 LLM 请求数被跳过累加。
   * 修复：失败路径同样用 resolveTokensUsed 结算（与成功路径同构），
   * 传入 runLoop 闭包内已累计的 sawUsage / input+output / estimatedChars。
   *
   * @param error 失败原因描述
   * @param llmRequests 已完成的 LLM 请求次数（runLoop 闭包累计）
   * @param sawUsage 是否拿到过网关真实 usage
   * @param realTokens 累计真实 tokens（inputTokensTotal + outputTokensTotal）
   * @param estimatedChars 累计估算字符数（无 usage 时的 fallback）
   */
  private failure(
    error: string,
    llmRequests: number,
    sawUsage: boolean,
    realTokens: number,
    estimatedChars: number
  ): Readonly<P5TaskExecutionResult> {
    // 零请求守卫：llmRequests===0 表示 runLoop 循环根本没进（无凭据/abort 预先存在），
    // 没有任何真实 LLM 交互 → tokensUsed 必须是 0。
    // resolveTokensUsed 的 Math.max(1, ...) 保底是为了给有真实请求但缺 usage 的场景
    // 提供估算值，不能错误地给零请求场景也返回 1（会误导编排器 llmCallCount 累加逻辑）。
    const tokens =
      llmRequests === 0
        ? { tokens: 0, estimated: false }
        : this.resolveTokensUsed(sawUsage, realTokens, estimatedChars);
    return Object.freeze({
      success: false,
      summary: "",
      tokensUsed: tokens.tokens,
      tokensEstimated: tokens.estimated,
      llmRequests,
      changedFiles: Object.freeze([]),
      error,
    });
  }
}
