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
// 共享上下文预算模块（2026-10-12 抽取，docs/dev/context-budget-provider.md）：
// 四级确定性压缩委托 DeterministicContextBudgetProvider；预算续跑（epoch）
// 判限/折算/耗尽门禁委托 ContextEpochState——行为与原内联实现逐字节一致，
// 逻辑单源与原版引擎 compactStrategy=deterministic 分支共享。
import {
  ContextEpochState,
  DeterministicContextBudgetProvider,
  type ContextBudgetProvider,
} from "../../../context-budget";
import type {
  P5DangerousCommandApproval,
  P5PlanIterationInput,
  P5PlanIterationResult,
  P5PlanIterationTask,
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

/**
 * 上下文预算耗尽时的自动"压缩续跑"（epoch rollover）次数上限（软预算修复 2026-10-11）。
 *
 * 真实痛点（run e52437ca342e 及 T-013/14/15/17/18 系列）：单任务轮内预算
 * 检查超限即直接 failure——200K 预算在 qwen3.8-flash（≈10K token/轮）下
 * 只够 12~20 轮，运维/冒烟类任务第一轮必死，任务永远做不完；且此前一旦
 * 熔断，任务卡保持 pending，下次 run 又从零上下文重跑，前功尽弃。
 * 现在超限不再立即失败：把会话折叠为「system + 任务卡 + 确定性进度摘要 +
 * 续跑指令」的全新上下文（等价于交互式 CLI 的 auto-compact，但零额外
 * LLM 调用——摘要由已累积的工具调用轨迹确定性生成，不请求模型总结），
 * 以续跑轮（epoch）继续执行；续跑轮再烧穿自己的额度才诚实 failure。
 *
 * 额度设计（两处协同，缺一不可）：
 * 1. 续跑段额度 = max(名义预算 × EPOCH_BUDGET_RATIO, 实测单轮均耗 ×
 *    EPOCH_MIN_ROUNDS)。若只给"固定半额"，当单轮成本高于半额时续跑段
 *    第一轮即再次超限——续跑形同虚设（写第一版时踩过这个坑，是 E9/E10
 *    用例推演暴露的）。按轮数兜底保证压缩后的新上下文至少能跑
 *    EPOCH_MIN_ROUNDS 轮，才有机会真正推进任务。
 * 2. 全任务绝对上限 = 名义预算 × MAX_TOTAL_BUDGET_MULTIPLIER。无论段额度
 *    如何折算，累计消耗触达该上限一律诚实 failure——这是防失控硬上界，
 *    保证"续跑"永远不会变成无限烧钱。
 *
 * 运行级兜底仍由编排器阶段间检查 + 软预算续期（RUN_TOKEN_SOFT_RENEWAL_RATIO）
 * 负责，与本常量正交。
 *
 * 2026-10-12 起：额度折算比例、最少轮数、折叠次数上界、绝对上限倍数四个
 * 口径迁入共享模块 context-budget.ts（ContextEpochState / DEFAULT_CONTEXT_EPOCH_CONFIG，
 * 缺省值与下述历史值逐值一致），执行器不再持有 epoch 常量副本；
 * 次数上界修复历史（原值 1 → 3）见 DEFAULT_CONTEXT_EPOCH_CONFIG 注释。
 */

/** 压缩续跑摘要的最大保留字符数（超限保头尾、省略中段，防止摘要本身膨胀） */
const CONTEXT_SUMMARY_MAX_CHARS = 8000;

/** 终态摘要最大保留字符数 */
const MAX_SUMMARY_CHARS = 2000;

/** git status 子命令超时（毫秒），超时/非 git 仓库按"无变更"降级，不使任务失败 */
const GIT_STATUS_TIMEOUT_MS = 10000;

/** 无 usage 回包时的字符→token 估算系数（保守 3.5 字符/token） */
const CHARS_PER_TOKEN_ESTIMATE = 3.5;

/**
 * pre-flight 估算门禁相对本段额度的余量系数。
 *
 * 段额度的正常烧穿判定通道在轮顶段超限检查与响应后检查（两者均为真实
 * usage 口径）；pre-flight 估算只是字符数近似（CHARS_PER_TOKEN_ESTIMATE），
 * 对高输入侧请求严重低估。若按 1× 段额度直接判限，估算门禁会抢在真实
 * 烧穿之前触发折叠，把折叠时序从「真实越线处」扭曲到「估算越线处」。
 * 2× 余量层保证：额度真实烧穿 → 由轮顶/响应后检查折叠（正常时序）；
 * 估算规模远超额度（累计+估算 > 2×额度）→ 继续发请求只会空耗 token，
 * 提前零请求折叠换段。两通道折叠形状一致，仅触发口径不同。
 */
const PREFLIGHT_SEGMENT_FACTOR = 2;

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

/**
 * plan 阶段规划器 system 提示词（2026-10-09 F-A1）。
 *
 * 角色约束：规划器不做任何文件/命令操作（请求不带工具定义），只读简报
 * 输出 JSON 决策；决策空间与字段契约在此固定，与 parsePlannerDecision
 * 的解析规则一一对应。
 */
const PLANNER_SYSTEM_PROMPT = [
  "你是自主编码循环（EAG-P5）的任务规划器。你不执行任何工具、不修改任何文件，",
  "只根据给定的运行简报输出一个 JSON 决策对象。",
  "",
  "输出格式（只能是以下四种之一）：",
  '1. 选择一张[可执行]的任务卡交给执行器：{"action":"select","taskId":"T-001","reasoning":"一句话理由"}',
  "2. 重排任务卡集合（只影响 requirement=AUTO 的卡，可置 pending/blocked、可追加新卡）：",
  '   {"action":"replan","tasks":[{"id":"T-001","status":"blocked"},{"title":"新任务","status":"pending","dependencies":[]}],"reasoning":"一句话理由"}',
  '3. 判定应当停止运行：{"action":"stop","reasoning":"一句话理由"}',
  '4. 不干预、交由本地规则：{"action":"none","reasoning":"一句话理由"}',
  "",
  "决策原则：",
  "- 上一轮运行记忆显示某张卡反复失败时，优先换思路：把旧卡 blocked 并追加一张",
  "  分解后的新卡（title 写清具体第一步），而不是机械重跑；",
  "- 剩余预算不足以完成哪怕最简单的一张卡时，输出 stop；",
  "- select 只能选[可执行]标注的卡；没有可执行卡且无法通过 replan 产出可执行卡时输出 stop；",
  "- 卡不可行（环境缺失、目标超出当前能力）时输出 stop 并在 reasoning 说明；",
  "- reasoning 必须是简体中文一句话。",
  "不要输出 JSON 以外的任何文本。",
].join("\n");

/** 规划请求最大输出 token 数（决策 JSON 不需要长篇输出） */
const PLANNER_MAX_TOKENS = 2048;

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
  /** 单任务工具循环最大轮数，默认 DEFAULT_MAX_TOOL_ROUNDS；测试可收窄 */
  readonly maxToolRounds?: number;
  /**
   * 单任务最大 Token 预算（可选，undefined 时执行器不检查，由编排器在迭代间统一检查）。
   *
   * 2026-10-07 新增增量预算守卫：让执行器在 for 循环内每轮都对比累计 tokensUsed
   * 与 perTaskBudget，超限立即 failure。比"单轮 dev/fix 40 轮全跑完才让编排器看到
   * tokensUsed"更诚实——避免单轮烧穿预算 N 倍。
   *
   * 编排器传入策略：perTaskBudget = totalBudget - totalTokensUsedAlreadyConsumed
   * （已用预算从 RunState.totalTokensUsed 取），每迭代剩余预算递减。
   */
  readonly perTaskBudget?: number;
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
  /**
   * 自压缩重放开关（可选，默认 true，2026-10-08）。
   *
   * 语义见类字段 compactReplayEnabled 注释。设为 false 时执行器按原始
   * 全量历史回传——仅供单测在断言"压缩前行为基线"（如 E7 轮数上限、
   * 相同调用熔断的指纹连续性）时显式关闭，生产路径不得关闭。
   */
  readonly compactReplay?: boolean;
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
  /** 单任务 Token 预算（构造时从 options.perTaskBudget 注入；undefined 表示执行器不检查） */
  private readonly perTaskBudget: number | undefined;
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

  /**
   * 上下文预算提供者（四级确定性压缩，2026-10-12 委托化）。
   *
   * 实例无任务级状态（纯函数式压缩），全执行器共享一份；压缩逻辑单源于
   * 共享模块 context-budget.ts，与原版引擎 compactStrategy=deterministic
   * 分支（SessionManager.compactSessionDeterministic）共用同一实现。
   */
  private readonly contextBudget: ContextBudgetProvider = new DeterministicContextBudgetProvider();

  /**
   * 自压缩重放开关（默认 true，仅供单测注入关闭以隔离断言）。
   *
   * 2026-10-08 修复"未终态 run 每轮请求规模不收敛"（run 4923fdc21e5b：
   * 单任务 40 轮 input+output 累计 877,542 tokens，≈ maxTokens=200K 的 4.4 倍，
   * Token 预算第一轮即熔断）：messages 全量回传 + 工具输出逐轮累积 → 每轮
   * 输入规模单调递增（≈O(n²) 总量）。业界（Claude Code auto-compact、
   * OpenAI Agents SDK trimming）共同点是"请求前估算 + 确定性删除/摘要最旧段"。
   * 本执行器是短时任务循环：任务卡（user 起始消息）即完整任务简报，
   * 历史工具输出的价值随轮次衰减——确定性压缩（去重 → tool 截断 → 最老
   * tool 丢弃 → 兜底裁剪）零额外 LLM 请求，比 LLM 摘要更契合无监督预算场景。
   */
  private readonly compactReplayEnabled: boolean;

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
    this.perTaskBudget = options.perTaskBudget;
    this.compactReplayEnabled = options.compactReplay ?? true;
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
  // 3.0 plan 阶段 LLM 动态规划（2026-10-09 F-A1，docs/dev/eag-p5-llm-dynamic-planning.md）
  // ==========================================================================

  /**
   * plan 阶段动态规划（端口可选方法实现）。
   *
   * 与 executeTask 的差异：单次无工具 LLM 调用（规划器不做任何文件/命令操作，
   * 只读简报做决策），无工具循环、无重入标志、无进度事件——一次请求即终态。
   * 任何失败（client 缺失 / abort / 请求异常 / JSON 不合法）都收敛为
   * ok=false + error 说明，绝不伪造决策；调用方（plan-stage-handler）
   * 据 ok=false 回退本地规则选卡。
   */
  async planIteration(input: Readonly<P5PlanIterationInput>): Promise<Readonly<P5PlanIterationResult>> {
    // abort 预检：标志文件已存在时不发请求（与 executeTask 轮顶检查同源）
    if (input.abortFlagPath.length > 0 && this.isAbortRequested(input.abortFlagPath)) {
      return Object.freeze({
        ok: false,
        action: "none" as const,
        reasoning: "",
        tokensUsed: 0,
        error: "aborted：检测到中止标志文件，跳过规划请求",
      });
    }
    // 无凭据 fail-closed：与 executeTask 首轮检查同口径，绝不伪造决策
    const client = this.createLlmClient();
    if (client === null || client === undefined) {
      return Object.freeze({
        ok: false,
        action: "none" as const,
        reasoning: "",
        tokensUsed: 0,
        error: "LLM 客户端不可用：未配置 API 凭据（请检查 settings.json 与环境变量）",
      });
    }

    // 单轮消息序列（system 固定角色 + user 规划简报），无工具定义
    const messages: SessionMessage[] = [
      this.buildSessionMessage("system", PLANNER_SYSTEM_PROMPT, null),
      this.buildSessionMessage("user", this.buildPlannerUserPrompt(input), null),
    ];

    // token 记账变量（与 runLoop 同构：usage 优先，无 usage 按字符估算保底）
    let sawUsage = false;
    let inputTokensTotal = 0;
    let outputTokensTotal = 0;
    let estimatedCharsTotal = 0;

    try {
      const response = await client.createMessage({
        messages,
        // 规划器不暴露任何工具：决策必须是一次纯文本 JSON 回复
        tools: [],
        thinkingEnabled: false,
        maxTokens: PLANNER_MAX_TOKENS,
      });
      // usage 记账（部分网关不回 usage：字符估算保底，口径与 executeTask 一致）
      if (response.usage) {
        sawUsage = true;
        inputTokensTotal += response.usage.inputTokens;
        outputTokensTotal += response.usage.outputTokens;
      } else {
        estimatedCharsTotal += this.lastUserishContentChars(messages) + response.content.length;
      }
      const tokens = this.resolveTokensUsed(sawUsage, inputTokensTotal + outputTokensTotal, estimatedCharsTotal);

      // JSON 提取与校验：剥 markdown 围栏后截取首个 { 到末个 }，解析失败 → ok=false
      const decision = this.parsePlannerDecision(response.content);
      if (decision === null) {
        return Object.freeze({
          ok: false,
          action: "none" as const,
          reasoning: "",
          tokensUsed: tokens.tokens,
          error: `规划输出不是合法 JSON 决策（原始回复前 200 字符：${response.content.slice(0, 200)}）`,
        });
      }
      return Object.freeze({
        ...decision,
        tokensUsed: tokens.tokens,
      });
    } catch (err) {
      // 请求异常（网络/网关/中止）→ ok=false，tokensUsed 诚实记录已消耗部分
      const message = err instanceof Error ? err.message : String(err);
      const tokens = this.resolveTokensUsed(sawUsage, inputTokensTotal + outputTokensTotal, estimatedCharsTotal);
      this.log(`planIteration 规划请求异常：${message}`, "warn");
      return Object.freeze({
        ok: false,
        action: "none" as const,
        reasoning: "",
        tokensUsed: tokens.tokens,
        error: `规划请求异常：${message}`,
      });
    }
  }

  /**
   * 解析规划器输出的 JSON 决策。
   *
   * 容错规则：剥 ```json 围栏 → 截取首个 `{` 到末个 `}` → JSON.parse →
   * 校验 action 枚举与关联字段（select 必须带 taskId；replan 必须带 tasks 数组）。
   * 任何一步失败返回 null（调用方据此判 ok=false 回退本地规则）。
   *
   * @param content 模型原始回复文本
   * @returns 合法决策对象；不合法返回 null
   */
  private parsePlannerDecision(content: string): {
    ok: true;
    action: "select" | "replan" | "stop" | "none";
    taskId?: string;
    tasks?: ReadonlyArray<Readonly<P5PlanIterationTask>>;
    reasoning: string;
  } | null {
    // 剥围栏：```json ... ``` / ``` ... ``` 中的内容优先
    let text = content.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      text = fenceMatch[1]!.trim();
    }
    // 截取 JSON 主体：首个 { 到末个 }（容忍模型在 JSON 前后夹杂说明文字）
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const action = obj["action"];
    if (typeof action !== "string") {
      return null;
    }
    const validActions = ["select", "replan", "stop", "none"] as const;
    if (!validActions.includes(action as (typeof validActions)[number])) {
      return null;
    }
    // includes 校验通过后收窄字面量类型（TS 无法从 includes 推断，此处显式断言）
    const validAction = action as (typeof validActions)[number];
    // reasoning：缺省空串，非字符串时转字符串（宽容处理，决策本身已校验）
    const rawReasoning = obj["reasoning"];
    const reasoning = typeof rawReasoning === "string" ? rawReasoning : String(rawReasoning ?? "");

    if (action === "select") {
      const taskId = obj["taskId"];
      if (typeof taskId !== "string" || taskId.length === 0) {
        // select 决策缺 taskId → 整体不合法
        return null;
      }
      return { ok: true, action: validAction, taskId, reasoning };
    }
    if (validAction === "replan") {
      const rawTasks = obj["tasks"];
      if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
        // replan 决策缺 tasks → 整体不合法
        return null;
      }
      // 逐条宽松校验：id/title 至少其一为字符串才保留（防模型输出垃圾条目）
      const tasks: P5PlanIterationTask[] = [];
      for (const entry of rawTasks) {
        if (entry === null || typeof entry !== "object") {
          continue;
        }
        const t = entry as Record<string, unknown>;
        const id = typeof t["id"] === "string" ? t["id"] : undefined;
        const title = typeof t["title"] === "string" ? t["title"] : undefined;
        if (id === undefined && title === undefined) {
          continue;
        }
        tasks.push({
          id,
          title,
          status: typeof t["status"] === "string" ? t["status"] : undefined,
          dependencies: Array.isArray(t["dependencies"])
            ? t["dependencies"].filter((d): d is string => typeof d === "string")
            : undefined,
        });
      }
      if (tasks.length === 0) {
        return null;
      }
      return { ok: true, action: "replan", tasks, reasoning };
    }
    // stop / none：无需关联字段
    return { ok: true, action: validAction, reasoning };
  }

  /**
   * 构造规划简报（user 消息）。
   *
   * 把目标、卡清单、笔记、前序阶段摘要、跨 run 失败记忆、剩余预算装配为
   * 结构化简报；长文本字段已由调用方截断，此处只做拼接。
   */
  private buildPlannerUserPrompt(input: Readonly<P5PlanIterationInput>): string {
    const sections: string[] = [
      `## 运行简报（第 ${input.iterIndex + 1} 次迭代规划）`,
      `### 用户目标\n${input.objective.length > 0 ? input.objective : "（未提供）"}`,
      `### 任务卡清单（[可执行] = status=pending 且依赖已满足，select 只能选这些卡）\n${
        input.tasksOverview.length > 0 ? input.tasksOverview : "（空）"
      }`,
    ];
    if (input.previousRunContext.length > 0) {
      sections.push(`### 上一轮运行记忆（同项目最近一次终态）\n${input.previousRunContext}`);
    }
    if (input.notesSnapshot.length > 0) {
      sections.push(`### 跨轮笔记\n${input.notesSnapshot}`);
    }
    if (input.prevStageSummaries.length > 0) {
      sections.push(`### 本迭代前序阶段摘要\n${input.prevStageSummaries}`);
    }
    sections.push(`### 剩余 Token 预算\n${String(input.remainingTokenBudget)}`);
    sections.push(
      "### 你的任务\n根据以上信息输出一个 JSON 决策（select/replan/stop/none），" +
        "只输出 JSON，不要输出任何其他文本。"
    );
    return sections.join("\n\n");
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
    // 工具调用总数（2026-10-07 空循环修复）：跨轮累计模型发起的工具调用个数。
    // noop 判据用它而非 changedFiles——changedFiles=0 有两类合法场景：
    // ① 非 git 仓库（git status 失败恒返回 []，无法据此判空转）；
    // ② 纯 bash/只读任务（真实运行测试、读文件本就不产生 git 变更）。
    // "光说不做"的准确语义是模型从未发起任何工具调用。
    let toolCallsTotal = 0;

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

      // 上下文续跑（epoch）状态（软预算修复 2026-10-11；2026-10-12 委托化）：
      // 预算超限不再直接 failure，而是把膨胀的历史折叠成紧凑上下文续跑。
      // 判限、段额度折算、耗尽门禁、绝对上限全部委托共享模块的
      // ContextEpochState（context-budget.ts）——段口径语义（增量 vs 段额度、
      // 续跑段起步不误杀）与折算/上界公式以该状态机为单一事实源；
      // 本循环只负责"问"（isSegmentExceeded / isTotalCeilingExceeded /
      // isRolloverExhausted）与"推进"（rollover）。
      // 检查跳过。effectiveBudgetForRun 在轮顶 effectiveBudget 同款口径下于
      // 循环外定型（每轮 input.perTaskBudget 取值逻辑一致，状态机名义预算恒定）。
      const effectiveBudgetForRun = input.perTaskBudget ?? this.perTaskBudget;
      const epochState = effectiveBudgetForRun !== undefined ? new ContextEpochState(effectiveBudgetForRun) : undefined;

      // ======== 主循环重构（2026-10-14 P0-1：修复"折叠不重置轮数 + 死折叠"根因） ========
      // 原 for (let round = 1; round <= this.maxToolRounds; round += 1) 的结构性问题：
      //   折叠（rollover）成功后 continue → for 自增 round → 若 round==maxToolRounds
      //   则 round+1 直接跳出循环 → 新上下文一次请求都没发，还误报"工具循环达上限"。
      //
      // 改为 while + 双层轮数预算：
      // 1. currentRound（全局硬上限）：1 → this.maxToolRounds，每轮 +1，永不重置；
      //    作用：执行器的绝对轮数天花板，无论怎么折叠都不击穿（防失控）。
      // 2. segmentRoundsUsed（段内已用）：每次 rollover 重置为 0；
      // 3. segmentRoundBudget（本段可消耗的最大轮数）：首段 = maxToolRounds；
      //    每次 rollover 后 = min(剩余全局轮数, 本段额度 / 实测均耗 向上取整)。
      //
      // 折叠守卫（三处折叠点通用）：
      //   若剩余全局轮数（maxToolRounds - currentRound + 1）< 按均耗算出的
      //   本段最少轮数空间（epochState.config.minRoundsPerEpoch），则折叠后
      //   新段一次请求都发不出（死折叠），直接诚实 failure 而不是白烧折叠开销。
      let currentRound = 1;
      let segmentRoundsUsed = 0;
      // 首段段轮数预算 = 全局轮数上限（首段就是"不折叠"的整段）
      let segmentRoundBudget = this.maxToolRounds;
      // 折叠后新段最少需要多少轮才能"跑得起来"（= epochState.config.minRoundsPerEpoch，
      // 无 epochState 时退化为 4），用于死折叠守卫阈值
      const MIN_SEGMENT_ROUNDS = epochState?.config.minRoundsPerEpoch ?? 4;
      // ======== P0-2 终局收尾注入标志（2026-10-14 第二轮修复） ========
      // 原终局收尾注入只在折叠点触发，但折叠后 segmentRoundBudget ≥ MIN_SEGMENT_ROUNDS（4）
      // 所以条件"剩余 ≤3 轮"永远不成立——是个死分支。
      // 正确触发路径：while 循环顶部，当全局硬上限还剩 ≤3 轮时注入一次 system 提示。
      let terminalHintInjected = false;

      while (currentRound <= this.maxToolRounds && segmentRoundsUsed < segmentRoundBudget) {
        // ======== 终局收尾注入（2026-10-14 P0-2 第二轮修复） ========
        // 全局硬上限还剩 ≤3 轮时，向模型注入 system 提示让其停止探索、立即收尾。
        // 把"40 轮无终态"降级为"有终态的部分完成"。一次性注入（terminalHintInjected
        // 标志防重复），在 while 顶部先于 pre-flight 检查执行——让本轮请求就带着
        // 收尾指令发出去。折叠点的注入逻辑作为死分支保留（segmentRoundBudget
        // 重算后理论上可能再次 ≤3，但 while 顶部优先拦截，折叠点逻辑不会被执行）。
        if (!terminalHintInjected && this.maxToolRounds - currentRound + 1 <= 3) {
          const remainingHint = this.maxToolRounds - currentRound + 1;
          messages.push(
            this.buildSessionMessage(
              "system",
              `⚠ 剩余全局硬上限 ${remainingHint} 轮，请立即停止新的探索性工具调用（read/write/edit/bash），` +
                `基于已有进度输出一条不含工具调用的终态总结——说明已完成哪些改动、还有哪些未完成、后续建议方向。`,
              null
            )
          );
          terminalHintInjected = true;
          this.log(`执行器终局收尾注入：全局硬上限剩余 ${remainingHint} 轮，已向模型追加 system 提示让其收尾`, "info");
        }
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

        // 增量 Token 预算检查（2026-10-07 新增；2026-10-08 T-009/T-010 事故修复接线）：
        // 每轮都对比累计 tokensUsed 与 perTaskBudget，超限立即 failure。
        // 这比"40 轮全跑完才让编排器看到 tokensUsed"更诚实——避免单轮
        // dev/fix 烧穿预算 N 倍（架构师指出的根因）。
        // 预算优先级：调用方 input.perTaskBudget（编排器按运行剩余预算
        // maxTokens - totalTokensUsed 逐阶段注入）> 构造期 this.perTaskBudget
        // （单测/旧宿主显式配置）。此前只读构造字段而生产链路从未注入，
        // 检查恒跳过——run 4923fdc21e5b/1c76da8bc0c8 单阶段烧穿预算 4.4×/8.6×
        // 的根因之一。两者均未注入时不做轮内检查，由编排器阶段间检查兜底。
        //
        // 2026-10-09 追加两级防线（修复 run f2358227def5 超烧 15741 tokens）：
        // 旧检查只在"轮顶"比对上一轮累计 usage——跨线那次请求的 input+output
        // 全额计入后要到下一轮顶部才熔断，超烧窗口 = 单次请求 token 量。
        // 现补两级：
        // a) pre-flight 估算检查：请求前按"实际发送消息序列"字符量估算
        //    输入侧 token（复用 CHARS_PER_TOKEN_ESTIMATE 既有系数，不新造口径），
        //    估算值 + 已用量越线 → 不发请求直接 failure（超烧 ≈ 0）；
        // b) 响应后检查：真实 usage 回来且本次仍要继续执行工具时立即比对，
        //    越线 → 不执行工具、直接 failure。终态回复（无工具调用）不拦——
        //    工作已真实完成，越线事实交由编排器阶段间检查诚实收尾。
        // 每轮实际发送的消息序列（自压缩重放）：预检与请求复用同一次压缩结果，
        // 避免同轮重复压缩，也保证预检口径与真实请求完全一致。
        const outgoingMessages = this.compactReplayEnabled ? this.compactMessagesForRequest(messages) : messages;
        const effectiveBudget = effectiveBudgetForRun;
        if (effectiveBudget !== undefined && epochState !== undefined) {
          const currentTokens = this.resolveTokensUsed(
            sawUsage,
            inputTokensTotal + outputTokensTotal,
            estimatedCharsTotal
          ).tokens;
          const segmentBudget = epochState.budget;
          const segmentTokens = currentTokens - epochState.baseline;
          // 全任务绝对上限（防失控硬上界）：优先于段额度判定，保证续跑机制
          // 不会把总消耗放大到不可控（口径见 ContextEpochState.totalCeiling）。
          const totalCeiling = epochState.totalCeiling;
          if (epochState.isTotalCeilingExceeded(currentTokens)) {
            return this.failure(
              `Token 预算超限：累计 ${currentTokens} tokens 已触达单任务绝对上限 ${totalCeiling}` +
                `（名义预算 ${effectiveBudget} × ${epochState.config.totalMultiplier}，` +
                `已自动压缩续跑 ${epochState.epoch} 次仍未完成），执行中止`,
              llmRequests,
              sawUsage,
              inputTokensTotal + outputTokensTotal,
              estimatedCharsTotal
            );
          }
          // a) pre-flight 估算检查（2026-10-09 F 修复；2026-10-12 段口径统一 +
          //    门禁收敛）：估算输入侧规模 + 本段已用量 > **本段额度的估算专用
          //    余量层** → 本段大概率装不下下一次请求，**不空耗请求，直接折叠
          //    续跑换段**（本轮零请求、零新消耗）；续跑已耗尽时才是诚实预检
          //    失败点（零请求 failure，超烧 ≈ 0）。
          //    为什么是「额度 × PREFLIGHT_SEGMENT_FACTOR」而不是「额度」直接
          //    判限：段额度的正常烧穿通道在轮顶段超限检查与响应后检查（真实
          //    usage 口径）；本估算值只是字符数近似（CHARS_PER_TOKEN_ESTIMATE），
          //    真实 usage 恰好低于估算的请求（如短消息网关虚高场景）永远轮不到
          //    本层拦截。余量层保证真实检查先判定：额度真实烧穿 → 轮顶/响应后
          //    折叠（正常时序）；估算规模远超额度 → 说明继续发请求只是空耗
          //    token 且大概率超烧，提前零成本换段。两通道折叠形状完全一致
          //    （同一 buildRolledOverMessages），时序收敛为「真实越线当轮折叠」。
          //    耗尽语义：折叠已无额度可换（isRolloverExhausted）且估算仍装不下
          //    → 诚实 failure（折叠后的紧凑上下文仍装不下 = 任务简报本身超预算，
          //    失败语义成立；错误消息如实标注续跑次数）。直接失败而不空耗请求，
          //    也避免 2026-10-11 软预算修复被架空（预算 < 任务简报规模的任务
          //    折叠换段后依然装不下，耗尽后必须在零请求处收口，不能让折叠通道
          //    无限循环）。
          //    估算必须覆盖**请求全部字符**：system prompt + 消息序列。原实现
          //    只算消息序列不含 system——当任务简报极短而 system 较长时（T-A3
          //    预算 10），紧凑续跑请求被严重低估放行，连续 6 次请求合法通过
          //    直到脚本耗尽，零请求语义丢失。
          //    历史踩坑（2026-10-12 T-A3）：误用 lastUserishContentChars（只
          //    算最后一条 user 消息）低估，门禁永不触发。
          const outgoingCharsTotal = outgoingMessages.reduce(
            (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
            0
          );
          const estimatedRequestTokens = Math.max(
            1,
            Math.ceil((SYSTEM_PROMPT.length + outgoingCharsTotal) / CHARS_PER_TOKEN_ESTIMATE)
          );
          if (segmentTokens + estimatedRequestTokens > segmentBudget * PREFLIGHT_SEGMENT_FACTOR) {
            if (epochState.isRolloverExhausted()) {
              return this.failure(
                `Token 预算预检超限：本次请求估算输入 ≈${estimatedRequestTokens} tokens` +
                  `（system ${SYSTEM_PROMPT.length} + 消息序列 ${outgoingCharsTotal} 字符），` +
                  `本段已用 ${segmentTokens}（本段额度 ${segmentBudget}，累计 ${currentTokens}，` +
                  `名义预算 ${effectiveBudget}），续跑折叠已用尽 ${epochState.epoch} 次仍装不下，` +
                  `不再发送请求，执行中止`,
                llmRequests,
                sawUsage,
                inputTokensTotal + outputTokensTotal,
                estimatedCharsTotal
              );
            }
            // 本段装不下但续跑未耗尽 → 直接折叠续跑换段（本轮零请求；段超限
            // 只在有新增消耗时触发，本段已无额度可消耗，空等一轮只会让 for
            // 循环轮次白白 +1 并白白吞掉一个 maxToolRounds 名额）。折叠后
            // 下一轮以新段额度重新预检。
            //
            // 死折叠守卫（2026-10-14 P0-1）：rollover 调用前先检查剩余全局轮数
            // 是否够新段跑出 MIN_SEGMENT_ROUNDS 次请求。若不够（剩余 < MIN），
            // 折叠后新段 segmentRoundsUsed 从 0 起步但 while 条件
            // currentRound <= maxToolRounds - segmentRoundBudget 立即不成立
            // → 新段一次请求都发不出。直接诚实 failure，避免浪费一次 rollover
            // 配额和折叠开销，也不误导为"工具循环达上限"。
            const remainingGlobalPreflight = this.maxToolRounds - currentRound + 1;
            if (remainingGlobalPreflight < MIN_SEGMENT_ROUNDS) {
              return this.failure(
                `Token 预算预检超限且剩余轮数不足：本段已达规模上限，尝试折叠续跑...` +
                  `但剩余全局轮数 ${remainingGlobalPreflight} 小于新段最低需求 ${MIN_SEGMENT_ROUNDS}，` +
                  `折叠后新上下文一次请求都发不出（死折叠），执行中止。` +
                  `累计 ${currentTokens} tokens，已用 ${currentRound}/${this.maxToolRounds} 轮，` +
                  `本段已用 ${segmentTokens}/${segmentBudget}。`,
                llmRequests,
                sawUsage,
                inputTokensTotal + outputTokensTotal,
                estimatedCharsTotal
              );
            }
            this.log(
              `Token 预算预检（段口径）：本段已用 ${segmentTokens} + 估算输入 ≈${estimatedRequestTokens}` +
                ` > 本段额度 ${segmentBudget}（累计 ${currentTokens}，名义预算 ${effectiveBudget}），` +
                `本段装不下下一次请求且续跑未耗尽，立即折叠续跑`,
              "warn"
            );
            const rolloutSummary = this.buildContextRolloutSummary(messages);
            const carriedRound = currentRound;
            const newSegmentBudget = epochState.rollover(currentTokens, currentRound)!;
            messages.length = 0;
            for (const message of this.buildRolledOverMessages(input, rolloutSummary, epochState.epoch)) {
              messages.push(message);
            }
            // 折叠指纹状态重置与拒绝风暴保留策略同段超限折叠（见下方注释）
            lastCallFingerprint = null;
            identicalCallStreak = 0;
            // ======== 折叠后轮数重置（2026-10-14 P0-1） ========
            // 折叠轮不消耗 segmentRoundsUsed（本轮零请求、零工具），直接重置为 0
            // 让新段从"段内第 1 轮"起步。segmentRoundBudget 按"剩余全局轮数"
            // 与"本段额度/实测均耗向上取整"两者较小值重算，保证新段既能在全局
            // 硬上限内跑完，又能在段额度约束内推进足够轮次。
            segmentRoundsUsed = 0;
            // 均耗 = 当前累计 / max(1, currentRound - roundOffset)（轮顶语义，
            // currentRound 尚未消耗本轮——pre-flight 在请求前，roundOffset=1）
            const preFlightObservedAvg = currentTokens / Math.max(1, currentRound - epochState.config.roundOffset);
            segmentRoundBudget = Math.min(
              remainingGlobalPreflight,
              Math.max(MIN_SEGMENT_ROUNDS, Math.ceil(newSegmentBudget / Math.max(1, preFlightObservedAvg)))
            );
            // 折叠后剩余段轮数 ≤ 3 时，注入终局收尾指令（P0-2：把"硬上限死"
            // 降级为"有终态的部分完成"，见 SYSTEM_TERMINATE_HINT）
            const remainingSegmentRounds = segmentRoundBudget - segmentRoundsUsed;
            if (remainingSegmentRounds <= 3) {
              messages.push(
                this.buildSessionMessage(
                  "system",
                  `剩余 ${remainingSegmentRounds} 轮，请停止新的探索性工具调用，基于已有进度立即输出一条不含工具调用的终态总结——` +
                    `说明已完成哪些改动、还有哪些未完成、建议后续方向。不要继续尝试新的 read/write/edit/bash。`,
                  null
                )
              );
            }
            this.log(
              `单任务上下文压缩续跑（预检触发）：任务 ${input.taskId} 段 ${epochState.epoch} 起步` +
                `（本段烧 ${segmentTokens} / 额度 ${segmentBudget} → 新段额度 ${newSegmentBudget}，` +
                `段轮数预算 ${segmentRoundBudget}/${remainingGlobalPreflight}（全局），` +
                `累计 ${currentTokens} tokens；折叠前 ${carriedRound} 轮轨迹已压缩为摘要 ` +
                `${rolloutSummary.length} 字符）`,
              "warn"
            );
            // 折叠轮不占用 currentRound 名额：手动保持 currentRound 不变，
            // 由 while 循环尾部的 currentRound+=1 仅在"完成一轮 LLM+工具"后执行。
            continue;
          }
          if (epochState.isSegmentExceeded(currentTokens)) {
            // —— 压缩续跑（统一折叠路径，2026-10-12）：额度用尽即折叠历史，
            // 无论续跑是否已耗尽（epochState.isRolloverExhausted()）。
            // 耗尽后折叠失败（零 LLM 请求）的职责在上方 pre-flight 估算门禁：
            // 折叠后紧凑上下文（system+user 两条）的估算规模若仍烧不进新段
            // 额度（典型：名义预算 ≪ 任务简报规模），pre-flight 于下一轮顶部
            // 直接 failure，绝不发请求。这样"耗尽段估算门禁恒真 → 请求永远
            // 发不出去 → rollover 永远不可达"的死锁不存在（门禁只在耗尽段
            // 且折叠已实际发生时生效），E17/E18 软预算续跑语义也保持紧凑
            // 请求照常放行、真实超限才折叠。
            // 折叠本身不耗 LLM 请求、不新增 token 消耗；新段额度按均耗折算
            // 重置，累计仍由 ContextEpochState.totalCeiling 绝对上限兜住，不可失控。
            // 口径说明（2026-10-12）：段超限 = 本段额度烧穿（续跑已无额度），
            // 与"绝对上限"（全任务触达 totalMultiplier×名义硬上界）语义不同——两类
            // 失败消息不得混淆（run 63f1869a17db 排查时即被旧消息误导为绝对
            // 上限失败）。
            // —— 折叠：历史压成「system + 任务卡原文 + 确定性轨迹摘要 + 续跑指令」——
            // 旧历史的价值（探索过程）已被摘要覆盖，其体积才是每轮成本单调上涨的根因；
            // 折叠后每轮输入回到"任务卡 + 摘要 + 最近若干轮"，成本骤降。
            //
            // 死折叠守卫（2026-10-14 P0-1）：与 pre-flight 同口径——rollover 调用前
            // 先检查剩余全局轮数是否够新段跑出 MIN_SEGMENT_ROUNDS 次请求。
            const remainingGlobalSegmentTop = this.maxToolRounds - currentRound + 1;
            if (remainingGlobalSegmentTop < MIN_SEGMENT_ROUNDS) {
              return this.failure(
                `Token 预算超限（段口径）且剩余轮数不足：本段已烧穿额度，尝试折叠续跑...` +
                  `但剩余全局轮数 ${remainingGlobalSegmentTop} 小于新段最低需求 ${MIN_SEGMENT_ROUNDS}，` +
                  `折叠后新上下文一次请求都发不出（死折叠），执行中止。` +
                  `累计 ${currentTokens} tokens，已用 ${currentRound}/${this.maxToolRounds} 轮，` +
                  `本段已用 ${segmentTokens}/${segmentBudget}。`,
                llmRequests,
                sawUsage,
                inputTokensTotal + outputTokensTotal,
                estimatedCharsTotal
              );
            }
            // rollover 耗尽门禁：耗尽时直接 failure（下一轮 while 顶部会再拦一次
            // 但为了诚实失败信息，这里直接收口）
            if (epochState.isRolloverExhausted()) {
              return this.failure(
                `Token 预算超限（段口径）：累计 ${currentTokens} tokens 已烧穿本段额度 ${segmentBudget}，` +
                  `续跑折叠已用尽 ${epochState.epoch} 次，不再折叠，执行中止。`,
                llmRequests,
                sawUsage,
                inputTokensTotal + outputTokensTotal,
                estimatedCharsTotal
              );
            }
            const rolloutSummary = this.buildContextRolloutSummary(messages);
            const carriedRound = currentRound;
            // 状态机先推进（折叠次数 +1、基线=当前累计、段额度按均耗折算），
            // 再折叠消息——新段额度计算与耗尽门禁以 ContextEpochState 为单一事实源。
            const newSegmentBudget = epochState.rollover(currentTokens, currentRound)!;
            messages.length = 0;
            for (const message of this.buildRolledOverMessages(input, rolloutSummary, epochState.epoch)) {
              messages.push(message);
            }
            // 熔断指纹状态重置：新上下文里重复旧调用属于"模型看到摘要后的新决策"，
            // 应重新计数（否则旧段末尾的 1~2 连击会让续跑第一击即触发空转熔断）。
            lastCallFingerprint = null;
            identicalCallStreak = 0;
            // 注意：拒绝风暴计数**故意保留**——守卫不会因折叠上下文而改判，
            // 已烧穿 6 次配额的越权目标在续跑段依然不可达，保留计数防止继续撞墙。
            // ======== 折叠后轮数重置（2026-10-14 P0-1） ========
            // 与 pre-flight 同口径：折叠轮不消耗 segmentRoundsUsed（零请求），
            // 直接重置为 0；segmentRoundBudget 按"剩余全局轮数"与"本段额度/实测均耗"较小值重算。
            segmentRoundsUsed = 0;
            const segmentTopObservedAvg = currentTokens / Math.max(1, currentRound - epochState.config.roundOffset);
            segmentRoundBudget = Math.min(
              remainingGlobalSegmentTop,
              Math.max(MIN_SEGMENT_ROUNDS, Math.ceil(newSegmentBudget / Math.max(1, segmentTopObservedAvg)))
            );
            // 终局收尾注入（P0-2）
            const remainingSegRounds = segmentRoundBudget - segmentRoundsUsed;
            if (remainingSegRounds <= 3) {
              messages.push(
                this.buildSessionMessage(
                  "system",
                  `剩余 ${remainingSegRounds} 轮，请停止新的探索性工具调用，基于已有进度立即输出一条不含工具调用的终态总结——` +
                    `说明已完成哪些改动、还有哪些未完成、建议后续方向。不要继续尝试新的 read/write/edit/bash。`,
                  null
                )
              );
            }
            this.log(
              `单任务上下文压缩续跑（段超限）：任务 ${input.taskId} 段 ${epochState.epoch} 起步` +
                `（本段烧 ${segmentTokens} / 额度 ${segmentBudget} → 新段额度 ${newSegmentBudget}，` +
                `段轮数预算 ${segmentRoundBudget}/${remainingGlobalSegmentTop}（全局），` +
                `累计 ${currentTokens} tokens；折叠前 ${carriedRound} 轮轨迹已压缩为摘要 ${rolloutSummary.length} 字符）`,
              "warn"
            );
            emitProgress(
              "llm_request",
              `上下文已达规模上限，自动压缩后继续执行（第 ${epochState.epoch + 1} 段）`,
              `── 上下文压缩续跑：历史已折叠为 ${rolloutSummary.length} 字符轨迹摘要，` +
                `本段额度 ${newSegmentBudget} tokens，段轮数预算 ${segmentRoundBudget}，从当前进度继续（不重跑已完成步骤）`
            );
            // 本轮不发起请求也不跳过轮次计数：直接进入下一轮，用新上下文重新提问
            continue;
          }
        }

        // 真实非流式 LLM 请求（简单、usage 直接可得、无 skill 预请求缝隙）
        emitProgress(
          "llm_request",
          `第 ${currentRound} 轮：向模型发起请求…`,
          `── 轮次 ${currentRound}/${this.maxToolRounds}：LLM 请求开始`,
          currentRound
        );
        const response = await client.createMessage({
          // 自压缩重放（2026-10-08）：每轮请求前把"将发送的消息序列"压缩到
          // 规模预算内（四级确定性降级：去重→tool 截断→最老 tool 丢弃→兜底裁剪）。
          // 原始 messages 数组只追加不篡改（审计事实源），压缩结果仅用于本次请求。
          // 2026-10-09：压缩结果上移为 outgoingMessages，与 pre-flight 预检共用。
          messages: outgoingMessages,
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
          // 估算口径与 pre-flight 预检对齐：system prompt + 本次实际发送的
          // 消息序列（outgoingMessages）+ 响应文本。原实现只算"最后一条
          // user 系消息"字符量（lastUserishContentChars），对多轮累积上下文
          // 严重低估——无 usage 网关下轮顶段超限与响应后检查的累计值虚低，
          // 预算门禁永不触发、压缩续跑通道变成死代码（T-A3 历史踩坑同源）。
          estimatedCharsTotal +=
            SYSTEM_PROMPT.length +
            outgoingMessages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0) +
            response.content.length;
        }

        // b) 响应后预算检查（2026-10-09 新增；2026-10-12 修正为段额度口径）：
        // 真实 usage 已越线且本次仍要执行工具时立即熔断——把熔断点从"下一轮顶部"
        // 提前到"本响应之后"，不再为已知越线的会话继续执行工具/发起新请求。
        // 终态回复（无工具调用）不拦：任务已真实完成，越线收尾交编排器阶段间检查。
        // 2026-10-12 修正为段额度口径：原实现用名义预算比对全任务累计，续跑段
        // 起步（累计必然已超名义预算）首个带工具调用的响应即被误杀，续跑段一个
        // 工具都执行不了；改为"本段增量 vs 本段额度"，首段语义完全不变
        // （baseline=0、segmentBudget=名义预算），续跑段获得真实额度。
        if (response.toolCalls.length > 0 && effectiveBudget !== undefined && epochState !== undefined) {
          const postResponseTokens = this.resolveTokensUsed(
            sawUsage,
            inputTokensTotal + outputTokensTotal,
            estimatedCharsTotal
          ).tokens;
          const postSegmentTokens = postResponseTokens - epochState.baseline;
          const postSegmentBudget = epochState.budget;
          // 全任务绝对上限（与轮顶检查同口径）：累计触达硬上界一律诚实熔断，
          // 续跑段不得借响应后检查之外的通道继续越界烧钱。
          const postTotalCeiling = epochState.totalCeiling;
          if (epochState.isTotalCeilingExceeded(postResponseTokens)) {
            return this.failure(
              `Token 预算超限（响应后检查）：累计 ${postResponseTokens} tokens 已触达` +
                `单任务绝对上限 ${postTotalCeiling}（名义预算 ${effectiveBudget} ×` +
                ` ${epochState.config.totalMultiplier}，已自动压缩续跑 ${epochState.epoch} 次仍未完成），` +
                `不再执行工具调用，执行中止`,
              llmRequests,
              sawUsage,
              inputTokensTotal + outputTokensTotal,
              estimatedCharsTotal
            );
          }
          if (epochState.isSegmentExceeded(postResponseTokens)) {
            // 本段额度烧穿（与轮顶段检查同语义，2026-10-12 统一折叠路径）：
            // 还有续跑额度 → 立即折叠历史开新段，当前响应继续正常执行工具
            // （token 已真实消耗、工具是该请求语义的一部分，"熔断点前移"拦
            // 的是**越线之后的新请求/新工具**，不是已发生请求的收尾）；续跑
            // 已耗尽 → 熔断语义收口在下一轮轮顶段检查 + pre-flight 估算门禁
            // （耗尽段零请求），此处不拦当前收尾工具，避免与"越线那次请求的
            // 工具照常执行"的既有契约冲突。
            if (!epochState.isRolloverExhausted()) {
              // 死折叠守卫（2026-10-14 P0-1）：响应后折叠的特殊语境——本轮请求
              // 已发生（token 已烧），但工具还没执行。如果剩余全局轮数不够新段
              // 跑 MIN_SEGMENT_ROUNDS 次，折叠后工具执行完 currentRound+=1 立即
              // 撞全局硬上限退出 → 新上下文一次请求没发。直接诚实 failure 说明
              // 死折叠，不让本轮工具白跑后再被误报"工具循环达上限"。
              const remainingGlobalPostResp = this.maxToolRounds - currentRound + 1;
              if (remainingGlobalPostResp < MIN_SEGMENT_ROUNDS) {
                return this.failure(
                  `Token 预算超限（响应后检查）且剩余轮数不足：本段已烧穿额度，尝试折叠续跑...` +
                    `但剩余全局轮数 ${remainingGlobalPostResp} 小于新段最低需求 ${MIN_SEGMENT_ROUNDS}，` +
                    `折叠后新上下文一次请求都发不出（死折叠），执行中止。` +
                    `累计 ${postResponseTokens} tokens，已用 ${currentRound}/${this.maxToolRounds} 轮，` +
                    `本段已用 ${postSegmentTokens}/${postSegmentBudget}。`,
                  llmRequests,
                  sawUsage,
                  inputTokensTotal + outputTokensTotal,
                  estimatedCharsTotal
                );
              }
              const rolloutSummary = this.buildContextRolloutSummary(messages);
              const carriedRound = currentRound;
              // 均耗折算分母口径保持迁移前语义：响应后折叠时本轮请求已发生，
              // 已发生轮数 = currentRound（轮顶折叠时本轮尚未请求，已发生轮数 = currentRound−1，
              // 即缺省 roundOffset=1；本分支显式按 currentRound 口径折算，不引入新口径）
              const observedAvgCostPerRound = postResponseTokens / Math.max(1, currentRound);
              const newSegmentBudget = Math.max(
                Math.max(1, Math.floor(effectiveBudget * epochState.config.budgetRatio)),
                Math.ceil(observedAvgCostPerRound * epochState.config.minRoundsPerEpoch)
              );
              // 折叠次数推进 + 基线重置（段额度用上方按 round 口径折算的值，
              // 与迁移前响应后折叠逐字节一致）
              epochState.rolloverWithBudget(postResponseTokens, newSegmentBudget);
              messages.length = 0;
              for (const message of this.buildRolledOverMessages(input, rolloutSummary, epochState.epoch)) {
                messages.push(message);
              }
              // 折叠指纹状态重置与拒绝风暴保留策略同轮顶折叠（见轮顶注释）
              lastCallFingerprint = null;
              identicalCallStreak = 0;
              // ======== 折叠后轮数重置（2026-10-14 P0-1） ========
              // 响应后折叠的特殊性：本轮请求已发、token 已烧，但工具还没执行。
              // segmentRoundsUsed 在 while 循环尾部会被 +1（本轮工具执行完算一轮），
              // 所以这里只重置，不额外补偿——让 segmentRoundsUsed 从 0 起步，尾部自然
              // 变成 1，while 条件继续成立。segmentRoundBudget 按"剩余全局轮数"
              // 与"本段额度/实测均耗"较小值重算。
              segmentRoundsUsed = 0;
              segmentRoundBudget = Math.min(
                remainingGlobalPostResp,
                Math.max(MIN_SEGMENT_ROUNDS, Math.ceil(epochState.budget / Math.max(1, observedAvgCostPerRound)))
              );
              // 终局收尾注入（P0-2）：segmentRoundsUsed 在这里还没被尾部 +1，
              // 所以 segmentRoundBudget - segmentRoundsUsed 等于"本段剩余轮数 +1"
              // （含本轮），用它来判断是否需要注入
              const remainingSegRounds = segmentRoundBudget - segmentRoundsUsed;
              if (remainingSegRounds <= 3) {
                messages.push(
                  this.buildSessionMessage(
                    "system",
                    `剩余 ${remainingSegRounds} 轮（含本轮工具执行），请停止新的探索性工具调用，基于已有进度立即输出一条不含工具调用的终态总结——` +
                      `说明已完成哪些改动、还有哪些未完成、建议后续方向。不要继续尝试新的 read/write/edit/bash。`,
                    null
                  )
                );
              }
              this.log(
                `单任务上下文压缩续跑（响应后）：任务 ${input.taskId} 段 ${epochState.epoch} 起步` +
                  `（本段烧 ${postSegmentTokens} / 额度 ${postSegmentBudget} → 新段额度 ${epochState.budget}，` +
                  `段轮数预算 ${segmentRoundBudget}/${remainingGlobalPostResp}（全局），` +
                  `累计 ${postResponseTokens} tokens；折叠前 ${carriedRound} 轮轨迹已压缩为摘要 ${rolloutSummary.length} 字符）`,
                "warn"
              );
              emitProgress(
                "llm_request",
                `上下文已达规模上限，自动压缩后继续执行（第 ${epochState.epoch + 1} 段）`,
                `── 上下文压缩续跑：历史已折叠为 ${rolloutSummary.length} 字符轨迹摘要，` +
                  `本段额度 ${epochState.budget} tokens，段轮数预算 ${segmentRoundBudget}，从当前进度继续（不重跑已完成步骤）`
              );
            }
          }
        }

        // 无工具调用 = 模型终态回复：任务执行正常结束
        if (response.toolCalls.length === 0) {
          const changedFiles = this.listGitChangedFiles(input.projectRoot);
          const tokensUsed = this.resolveTokensUsed(
            sawUsage,
            inputTokensTotal + outputTokensTotal,
            estimatedCharsTotal
          );
          // 空转标记（2026-10-07 新增）：判据是"模型全程未发起任何工具调用"——
          // 这才是"光说不做"的准确语义。不用 changedFiles 判据的原因：
          // 非 git 仓库恒检出空数组、纯 bash/只读任务本就零变更，两类合法
          // 场景都会被误标 noop 导致连续空转熔断误杀真实工作。
          // success 仍为 true（循环正常到达终态），但 noop=true 让编排器
          // 把本轮计入 consecutiveNoopIterations 空转熔断。
          const isNoop = llmRequests > 0 && toolCallsTotal === 0;
          emitProgress(
            "task_end",
            `任务完成：${(response.content || "").slice(0, 200)}`,
            `── 轮次 ${currentRound}：模型给出终态回复，任务正常结束\n变更文件：${changedFiles.length > 0 ? changedFiles.join(", ") : "（无）"}${isNoop ? "\n（空转：模型未发起任何工具调用且无文件变更）" : ""}`,
            currentRound
          );
          return Object.freeze({
            success: true,
            summary: (response.content || "").slice(0, MAX_SUMMARY_CHARS),
            tokensUsed: tokensUsed.tokens,
            tokensEstimated: tokensUsed.estimated,
            llmRequests,
            changedFiles: Object.freeze(changedFiles),
            noop: isNoop,
          });
        }

        // 追加 assistant 工具调用消息（OpenAI tool_calls 形态，双 converter 均识别）
        messages.push(this.buildAssistantToolCallMessage(response.toolCalls, response.content));

        // 真实执行工具调用（越权由 onBeforeToolExecution 进程内硬判，deny 结果原样回灌）
        emitProgress(
          "tool_execution",
          `第 ${currentRound} 轮：执行 ${response.toolCalls.map((tc) => tc.name).join("、")}`,
          `── 轮次 ${currentRound}：LLM 返回 ${response.toolCalls.length} 个工具调用：${response.toolCalls
            .map((tc) => `${tc.name}(${this.summarizeToolArgs(tc.argumentsJson)})`)
            .join("；")}`,
          currentRound
        );
        // 跨轮累计工具调用数（noop 判据，见 toolCallsTotal 声明处注释）
        toolCallsTotal += response.toolCalls.length;
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
        emitProgress("tool_execution", "", `工具结果：\n${toolResults.join("\n")}`, currentRound);
        if (stormHitCount >= DENIAL_STORM_LIMIT) {
          const stormError =
            `拒绝风暴：同一目标「${stormTarget}」累计 ${stormHitCount} 次被权限守卫拒绝——` +
            `反复重试同一堵墙不会变通，目标可能超出执行器安全边界` +
            `（路径牢笼 / 凭据守卫 / 高危命令未获人工确认）。请调整任务目标、文件范围，或改用安全替代命令。`;
          emitProgress("task_end", `执行失败：拒绝风暴`, stormError, currentRound);
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
        // 注意：指纹必须基于**原始完整** response.toolCalls 计算，绝不能用压缩后
        // 回传给模型的消息内容——第三级压缩会省略最老 tool 结果，若指纹受其影响，
        // 同一重复调用的指纹会随压缩进度漂移、熔断永远不触发（E7/熔断回归防线）。
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
          emitProgress("task_end", `执行失败：相同调用空转熔断`, identicalError, currentRound);
          return this.failure(
            identicalError,
            llmRequests,
            sawUsage,
            inputTokensTotal + outputTokensTotal,
            estimatedCharsTotal
          );
        }
        // ======== while 循环尾部：全局轮数 +1、段内轮数 +1（2026-10-14 P0-1） ========
        // 原 for 循环由 `round += 1` 自增，while 需手动推进；折叠时 segmentRoundsUsed
        // 已重置为 0，此处 +1 仅在"本轮完成一轮 LLM+工具"后执行。
        currentRound += 1;
        segmentRoundsUsed += 1;
      }

      // while 循环退出（自然结束，无终态回复）：诚实判失败，交回编排器决定 fix/abort。
      // 2026-10-14：区分两种退出根因（原 for 循环无此区分，"工具循环达上限"是唯一文案
      // 但掩盖了"折叠后轮数不够"等真实死因）：
      // - 路径 A：currentRound > maxToolRounds → 全局硬上限撞顶
      // - 路径 B：segmentRoundsUsed >= segmentRoundBudget → 本段段轮数预算耗尽
      //   （可能还有剩余全局轮数但本 segmentRoundBudget 被 rollover 重算后变小）
      // 三种折叠点已在"剩余轮数不够让新段跑 MIN_SEGMENT_ROUNDS 次"时直接诚实 failure，
      // 不会走到这里的段轮数耗尽——所以路径 B 意味着 segmentRoundBudget 确实跑满了
      // （正常折叠续跑路径），而不是死折叠漏网。
      const hitGlobalCeiling = currentRound > this.maxToolRounds;
      const remainingGlobal = this.maxToolRounds - currentRound + 1;
      const roundLimitError = hitGlobalCeiling
        ? `工具循环达全局硬上限（${this.maxToolRounds} 轮）仍未给出终态回复`
        : `段轮数预算耗尽（本段 ${segmentRoundBudget} 轮已用完）仍未给出终态回复，` +
          `剩余全局轮数 ${Math.max(0, remainingGlobal)}（本轮 currentRound=${currentRound}）。` +
          `续跑折叠已全部触发过或全局轮数不足以让新段跑出有效请求。`;
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
    return this.isDeniedToolContent(execution.content);
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

  // ==========================================================================
  // 3.4b 上下文压缩续跑（epoch rollover，软预算修复 2026-10-11）
  // ==========================================================================

  /**
   * 从消息序列确定性提取「已执行工具轨迹」摘要（压缩续跑的折叠素材）。
   *
   * 零 LLM 调用：不请求模型总结历史（总结本身要烧 token 且需要额外一轮），
   * 而是从 assistant 消息的 tool_calls 元数据机械重建"做过什么"清单：
   * - 每个工具调用一行（轮次 / 工具名 / 参数摘要），最近一轮额外带模型自述；
   * - 被权限守卫拒绝的调用标 ✗，让续跑段知道"此路不通"，不再重复撞墙；
   * - 超 CONTEXT_SUMMARY_MAX_CHARS 时保头尾、省略中段（首尾信息价值最高：
   *   开头是初始探索，结尾是中断点）。
   *
   * @param messages 当前完整消息序列（只读，不被篡改）
   * @returns 摘要文本；尚无任何工具调用时返回空串
   */
  private buildContextRolloutSummary(messages: ReadonlyArray<SessionMessage>): string {
    const lines: string[] = [];
    // 轮次口径（2026-10-12 修正）：执行循环轮次 = 消息序列中除首条 system 外的
    // 全部消息数（每条 user/assistant/tool 消息对应循环一步），而非仅 assistant
    // 带 tool_calls 的消息数。此口径喂给 ContextEpochState.rollover 的均耗折算
    // （累计/（轮次-1)）才能真实反映"本段每轮成本"——只数 tool_calls 消息会把
    // 单轮多工具、多轮压缩历史等场景的轮次低估，均耗虚高 → 续跑段额度虚高。
    const round = Math.max(0, messages.length - (messages[0]?.role === "system" ? 1 : 0));
    for (const message of messages) {
      if (message.role === "assistant") {
        const params = message.messageParams as {
          tool_calls?: ReadonlyArray<{ function?: { name?: string; arguments?: string } }>;
        } | null;
        const calls = params?.tool_calls ?? [];
        if (calls.length === 0) {
          continue;
        }
        const names: string[] = [];
        for (const call of calls) {
          const name = call.function?.name ?? "(unknown)";
          names.push(`${name}(${this.summarizeToolArgs(call.function?.arguments ?? "")})`);
        }
        lines.push(`- 轮 ${round}：${names.join("；")}`);
      } else if (message.role === "tool" && typeof message.content === "string") {
        if (this.isDeniedToolContent(message.content)) {
          lines.push(`  ↳ ✗ 被权限守卫拒绝：${message.content.slice(0, 100)}`);
        }
      }
    }
    if (lines.length === 0) {
      return "";
    }
    let summary = lines.join("\n");
    if (summary.length > CONTEXT_SUMMARY_MAX_CHARS) {
      const headLen = Math.floor(CONTEXT_SUMMARY_MAX_CHARS * 0.6);
      const tailLen = Math.floor(CONTEXT_SUMMARY_MAX_CHARS * 0.3);
      const head = summary.slice(0, headLen);
      const tail = summary.slice(-tailLen);
      summary = `${head}\n…（中段 ${summary.length - head.length - tail.length} 字符轨迹已省略）\n${tail}`;
    }
    return summary;
  }

  /**
   * 构造「压缩续跑」的全新上下文消息序列（system + user 两条）。
   *
   * 语义等价于交互式 CLI 的 auto-compact，但摘要是确定性生成的（见
   * buildContextRolloutSummary）。新序列天然满足 compactMessagesForRequest
   * 的协议不变量（无 assistant/tool 孤儿配对），因此续跑段无需特殊压缩分支。
   *
   * @param input 任务执行输入（任务卡原文来源，保证目标与验收标准零丢失）
   * @param rolloutSummary 已执行轨迹摘要
   * @param epoch 续跑段序号（1-based，仅用于文案）
   * @returns 全新消息序列
   */
  private buildRolledOverMessages(
    input: Readonly<P5TaskExecutionInput>,
    rolloutSummary: string,
    epoch: number
  ): SessionMessage[] {
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
    }
    if (input.stage === "fix" && input.feedback) {
      lines.push("", "本任务此前的验证失败反馈（请据此修复，不要重复导致失败的做法）：", input.feedback);
    }
    lines.push(
      "",
      `—— 上下文续跑（第 ${epoch + 1} 段，前 ${epoch} 段已压缩）——`,
      "上一段执行因上下文规模达到预算上限被自动压缩。任务卡原文与验收标准如上，未发生任何变化。",
      "以下是前段已真实执行的轨迹摘要（由工具调用元数据确定性生成，非模型回忆）：",
      ""
    );
    lines.push(rolloutSummary.length > 0 ? rolloutSummary : "-（前段未留下可解析的工具调用轨迹）");
    lines.push(
      "",
      "请从中断处继续完成任务，硬性要求：",
      "1. 不要重复摘要中已经执行过的调用（尤其是标 ✗ 的被拒目标——守卫不会改变判定）；",
      "2. 需要此前读过的文件内容就重新 read（旧工具结果已省略，但可重新获取）；",
      "3. 全部完成后给出一条不含工具调用的终态文本总结。"
    );
    return [
      this.buildSessionMessage("system", SYSTEM_PROMPT, null),
      this.buildSessionMessage("user", lines.join("\n"), null),
    ];
  }

  /**
   * 判断一段 tool 结果内容是否为"权限守卫拒绝"（与 isDeniedToolExecution 同判据，
   * 供摘要构造复用——那里只有内容字符串、没有 ToolCallExecution 对象）。
   */
  private isDeniedToolContent(content: string): boolean {
    return content.includes("审批门控拒绝") || content.includes("denied by approval gate");
  }

  // ==========================================================================
  // 3.5 自压缩重放（2026-10-08 修复"未终态 run 请求规模不收敛"，run 4923fdc21e5b）
  // ==========================================================================

  /**
   * 把"即将发送给模型的消息序列"压缩到规模预算内（纯函数式重放视图）。
   *
   * 背景（分析报告 run 4923fdc21e5b）：messages 全量回传 + 工具输出逐轮累积
   * → 每轮输入单调递增，单任务 40 轮烧掉 877,542 tokens（≈ maxTokens 4.4 倍），
   * Token 预算第一轮即熔断，--max-iterations 完全没用上。
   * 业界对齐（Claude Code auto-compact / OpenAI Agents SDK trimming /
   * LangGraph 长程记忆）：请求前估算 → 确定性删除或摘要最旧段。本执行器是
   * 短时任务循环，任务卡（首条 user 消息）即完整任务简报，历史工具输出价值
   * 随轮次衰减，因此选择**零额外 LLM 调用**的确定性压缩。
   *
   * 关键不变量（绝不破坏 OpenAI/Anthropic tool 协议合法性）：
   * - system 消息永不丢弃；
   * - 首条非 system 消息（任务卡简报）永不丢弃；
   * - 最后一条消息（本轮上下文锚点）永不丢弃；
   * - assistant(tool_calls) 与其全部 tool 配对消息要么整体保留、要么
   *   tool 内容替换为一行占位（配对关系保留），绝不产生孤儿 tool 消息；
   * - 原始数组只读不被篡改（审计事实源），返回新数组仅用于本次请求。
   *
   * 四级确定性降级（逐级应用，达标即停）——具体实现见共享模块
   * context-budget.ts 的 DeterministicContextBudgetProvider（与原版引擎
   * compactStrategy=deterministic 分支单源）：
   * 0. 单条 tool 截断（无条件）：每条 tool 消息截断至 toolOutputMaxChars，
   *    头部保留 + 尾注——任何规模下只有收益，主要膨胀源的直接治理；
   * 1. 相同 tool 结果去重：完全相同的 tool 输出保留最新、旧的替换为
   *    一行引用（重复 read/grep 空转场景收益最大）；
   * 2. 最老 tool 优先丢弃：tool 结果总量超 toolResultsBudgetChars 时，
   *    从最老开始替换为占位，直至达标（最近 4 条 tool 永不丢弃）；
   * 3. 兜底裁剪：总量仍超 requestTotalCharsCeiling 时，从最老可丢弃段
   *    （任务卡之后、保护窗之外的整条消息）继续整条替换为占位。
   *
   * @param messages 当前完整消息序列（只读，不被篡改）
   * @returns 压缩后的请求消息序列（新建数组）
   */
  private compactMessagesForRequest(messages: ReadonlyArray<SessionMessage>): SessionMessage[] {
    // 2026-10-12 委托化：四级压缩逻辑整体迁入共享模块 context-budget.ts
    // （DeterministicContextBudgetProvider），缺省配置与原内联常量逐值一致
    // （4000 / 100_000 / 800_000 / 保护窗 4 / 直通阈值 3 / 去重与短消息阈值 200），
    // 行为零变化。方法名保留供既有单测（E1c/E1d/E1e 私有方法访问）继续验证委托语义。
    return this.contextBudget.compactForRequest(messages);
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
