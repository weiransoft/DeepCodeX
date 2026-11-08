/**
 * ContextBudgetProvider 共享上下文压缩接口（2026-10-12，设计文档
 * docs/dev/context-budget-provider.md）
 *
 * 背景：p5 任务执行器（LlmTaskExecutor）与原版 CLI 引擎（SessionManager）
 * 各自演化出两套上下文压缩机制——p5 的四级确定性压缩（请求前自压缩，
 * 零 LLM 请求）与 SessionManager 的 LLM 摘要落盘（compactSession）。本模块
 * 把 p5 的确定性压缩逻辑原样抽取为可复用接口，供两个引擎共享：
 *
 * 1. {@link ContextBudgetProvider}：压缩契约——纯函数、只读输入、零 LLM、
 *    零副作用（不落盘、不改消息条数与协议配对）。
 * 2. {@link DeterministicContextBudgetProvider}：四级确定性压缩实现
 *    （单条 tool 截断 → 去重 → 最老 tool 丢弃 → 兜底裁剪），阈值全部
 *    配置化（{@link ContextBudgetConfig}）。
 * 3. {@link ContextEpochState}：预算续跑（epoch）状态机——判限、段额度
 *    折算、耗尽门禁、绝对上限。零副作用，供执行器循环持有。
 *
 * 迁移语义保真原则（用户规则：禁止简化实现）：所有逻辑从
 * LlmTaskExecutor 原样迁移，行为逐字节一致；测试套件
 * tests/context-budget.test.ts（CB-01~CB-12）与既有 p5 套件双重锁定。
 *
 * @module context-budget
 */

import type { SessionMessage } from "./session";

// ============================================================================
// 1. 配置类型与缺省值
// ============================================================================

/**
 * 四级确定性压缩的阈值配置（全部可由构造参数覆盖，缺省见
 * {@link DEFAULT_CONTEXT_BUDGET_CONFIG}）。
 */
export interface ContextBudgetConfig {
  /** 第 0 级：单条 tool 内容截断上限（字符），头部 + 失败窗口 + 尾部三段保留 */
  toolOutputMaxChars: number;
  /** 第 2 级：tool 结果总量预算（字符），超出后最老 tool 整条丢弃 */
  toolResultsBudgetChars: number;
  /** 第 3 级：请求消息序列总量硬顶（字符），超出后兜底整条裁剪 */
  requestTotalCharsCeiling: number;
  /** 第 2/3 级保护窗：最近 N 条 tool 消息永不整条丢弃 */
  protectedRecentTools: number;
  /** 直通阈值：消息条数 ≤ 该值时原样返回（极短历史无压缩价值） */
  minMessages: number;
  /** 第 1 级去重最小字符数：短于该值的重复 tool 内容不去重 */
  dedupeMinChars: number;
  /** 第 3 级短消息阈值：短于该值的可丢弃消息不裁剪（推理链承载体） */
  shortMessageMinChars: number;
}

/**
 * 缺省配置（与 LlmTaskExecutor 原硬编码常量逐值一致，行为零变化）：
 * - toolOutputMaxChars=4000：单条 tool 输出截断上限
 * - toolResultsBudgetChars=100_000：tool 结果总量预算
 * - requestTotalCharsCeiling=800_000：请求总量硬顶
 * - protectedRecentTools=4：最近 4 条 tool 永不整条丢弃
 * - minMessages=3：≤3 条直通
 * - dedupeMinChars=200 / shortMessageMinChars=200
 */
export const DEFAULT_CONTEXT_BUDGET_CONFIG: ContextBudgetConfig = Object.freeze({
  toolOutputMaxChars: 4000,
  toolResultsBudgetChars: 100_000,
  requestTotalCharsCeiling: 800_000,
  protectedRecentTools: 4,
  minMessages: 3,
  dedupeMinChars: 200,
  shortMessageMinChars: 200,
});

// ----------------------------------------------------------------------------
// 单条 tool 输出截断（第 0 级复用）：head + 失败窗口 + tail
//
// 修复背景（dev 阶段空转）：旧第 0 级是 head-only（slice(0, maxChars)），
// 真实 bash / pytest 的失败详情（stderr、FAILED、AssertionError、not ok、
// exit code、Traceback）几乎总在输出尾部，被整段砍掉，模型只能盲试换命令。
// 本函数改为「头部上下文 + 首个失败窗口 + 尾部统计」三段保留，并保证
// 尾部最后 floor(maxChars*0.45) 字符一定出现、总长度严格 ≤ maxChars。
// 实现独立、零依赖，刻意不 import eag/p5 的 buildTestOutputSummary
// （避免 core 通用模块反向依赖 eag/p5）。
// ----------------------------------------------------------------------------

/** 失败标记：取首个匹配位置定位失败窗口（覆盖主流 runner 与通用 stderr 形态） */
const TOOL_FAILURE_MARKER = /(?:FAILED|FAIL:|AssertionError|Error:|error:|✕|●|not ok |exit code|失败|Traceback)/i;

/** 极小预算阈值：低于此值分段无意义，退化为安全 head 截断（避免负长度碎块） */
const TRUNCATE_SAFE_MIN_CHARS = 200;
/** 失败窗口单侧上下文长度（首个失败标记前后各取约 150 字符） */
const FAILURE_WINDOW_HALF_CHARS = 150;
/** 每段省略标记的预留字符数（含数字），用于保证拼接后总长 ≤ maxChars */
const OMIT_MARKER_RESERVE = 80;

/**
 * 构造省略标记。
 *
 * 刻意保留旧子串「已截断，原共」以兼容既有断言与日志正则（CB-03、
 * E1d/E1e/E1f 等用 includes("已截断") 检查截断标记）。
 */
function buildOmitMarker(totalChars: number, omittedChars: number): string {
  return `\n…（已截断，原共 ${totalChars} 字符，省略 ${omittedChars} 字符，已保留失败窗口/尾部）…\n`;
}

/**
 * 截断单条 tool 输出：头部 + 失败窗口 + 尾部三段保留，总长严格 ≤ maxChars。
 *
 * - null / 非字符串 / 长度 ≤ maxChars：原样返回（类型安全：不对 null 做字符串操作）；
 * - maxChars ≤ 0、NaN / Infinity 或 < 200：退化为安全 head 截断（不抛异常、长度受控）；
 * - 正常预算：尾部最后 floor(maxChars*0.45) 字符**一定完整出现**（修复核心），
 *   头部约 35%，剩余预算给「首个失败标记前后各 150 字符」的失败窗口；
 *   无失败标记时退化为「头部 + 尾部」。所有拼接处标注省略字符数。
 *
 * 纯函数：零 I/O、零副作用、不修改入参。生产调用点（compactForRequest 第 0 级）
 * 仅在 contentChars(content) > maxChars 时进入，此时 content 必为 string。
 *
 * @param content 原始 tool 输出（string | null）
 * @param maxChars 截断上限（字符，含省略标记本身）
 * @returns 截断后的字符串；null 原样透传（调用方按契约只在长 string 分支使用）
 */
export function truncateToolOutput(content: string | null, maxChars: number): string {
  // 透传边界（类型安全）：null / 非字符串 / 短内容不做任何字符串操作。
  if (content === null || typeof content !== "string" || content.length <= maxChars) {
    return content as string;
  }
  const total = content.length;

  // 极小 / 非法预算：安全退化。cap=0（maxChars≤0 或 NaN/Infinity 收敛到 0）返回空串。
  // 2026-11 修订：旧实现 head-only（slice(0, cap - marker)）把尾部 stderr/FAILED
  // 证据整段砍掉，与第 0 级正常预算「head + 失败窗口 + tail」语义不一致。改为紧凑
  // 「头部 + 首个失败窗口 + 尾部」三段保留；标记恒定携带「已截断，原共」子串，
  // 总长严格 ≤ cap，不抛异常。
  if (!Number.isFinite(maxChars) || maxChars < TRUNCATE_SAFE_MIN_CHARS) {
    const cap = Math.max(0, Math.floor(Number.isFinite(maxChars) ? maxChars : 0));
    if (cap === 0) return "";
    const marker = `\n…（已截断，原共 ${total} 字符）…\n`;
    const available = cap - marker.length;
    if (available <= 0) {
      // 预算连标记都放不下：退化为「头部 + 标记前缀」，保证「已截断，原共」可见、长度受控。
      const head = content.slice(0, Math.max(0, cap - marker.length));
      return `${head}${marker}`.slice(0, cap);
    }
    // 尾部优先（真实失败证据多在尾部），头部至少 4 字符保前缀，剩余给失败窗口。
    const tailLen = Math.max(1, Math.floor(available * 0.45));
    const headLen = Math.min(available - tailLen, Math.max(4, Math.floor(available * 0.3)));
    const windowLen = Math.max(0, available - tailLen - headLen);
    const tailStart = total - tailLen;
    const head = content.slice(0, headLen);
    const tail = content.slice(tailStart);
    let window = "";
    const match = TOOL_FAILURE_MARKER.exec(content);
    if (match && windowLen > 0) {
      const center = match.index;
      const ws = Math.max(headLen, center - Math.floor(windowLen / 2));
      const we = Math.min(tailStart, ws + windowLen);
      if (we > ws) {
        window = content.slice(ws, we);
      }
    }
    // 单标记拼接：头部/失败窗口同属前段（极小预算不再插第二段标记），
    // 标记恒定携带「已截断，原共」，尾部永远完整出现。
    const front = `${head}${window}`;
    let result = `${front}${marker}${tail}`;
    if (result.length > cap) {
      // 防御：只从前段末端削减，绝不裁尾部。
      const overflow = result.length - cap;
      result = `${front.slice(0, Math.max(0, front.length - overflow))}${marker}${tail}`;
    }
    return result;
  }

  // 尾部：硬保证完整出现（修复核心）。tailLen 随 maxChars 线性，不随 total 变化。
  const tailLen = Math.floor(maxChars * 0.45);
  const tail = content.slice(total - tailLen);
  const tailStart = total - tailLen;

  // 头部 / 窗口预算：先扣掉尾部与两段省略标记预留，再按 35:20 分配
  // （headLen + windowLen = budgetForHeadAndWindow，故三段 + 两段标记 ≤ maxChars）。
  const budgetForHeadAndWindow = Math.max(0, maxChars - tailLen - 2 * OMIT_MARKER_RESERVE);
  const headLen = Math.floor((budgetForHeadAndWindow * 35) / 55);
  const windowLen = budgetForHeadAndWindow - headLen;
  const head = content.slice(0, headLen);

  // 失败窗口：首个失败标记前后各 150 字符，受 windowLen 约束，插在尾部之前。
  // 窗口起点不早于 head 末尾（避免与头部重复），终点不越过 tail 起点（避免与尾部重复）。
  const match = TOOL_FAILURE_MARKER.exec(content);
  let windowStart = headLen;
  let windowEnd = headLen;
  let window = "";
  if (match && windowLen > 0) {
    const center = match.index;
    windowStart = Math.max(headLen, center - FAILURE_WINDOW_HALF_CHARS);
    const rawEnd = Math.min(total, center + FAILURE_WINDOW_HALF_CHARS);
    windowEnd = Math.min(tailStart, windowStart + windowLen, Math.max(rawEnd, windowStart));
    window = content.slice(windowStart, windowEnd);
  }

  // 省略字符数（两段空缺）
  const omittedHeadToWindow = Math.max(0, windowStart - headLen);
  const omittedWindowToTail = Math.max(0, tailStart - windowEnd);

  let result = head;
  if (window.length > 0) {
    if (omittedHeadToWindow > 0) result += buildOmitMarker(total, omittedHeadToWindow);
    result += window;
    if (omittedWindowToTail > 0) result += buildOmitMarker(total, omittedWindowToTail);
  } else {
    // 无失败标记（或窗口落在头部/尾部区间内）：退化为 头部 + 尾部。
    // 省略数按 head 末尾到 tail 起点的真实空缺计算，不依赖可能被窗口逻辑
    // 改动的 windowEnd（否则窗口落在尾部区间时会误算为 0 而漏加省略标记）。
    const omitted = Math.max(0, tailStart - head.length);
    if (omitted > 0) result += buildOmitMarker(total, omitted);
  }
  result += tail;

  // 防御性兜底：预算已精确预留，正常不触发；万一超长，从头部末端削减，
  // 绝不裁尾部（尾部是本修复要保住的核心证据）。
  if (result.length > maxChars) {
    const overflow = result.length - maxChars;
    const trimmedHead = head.slice(0, Math.max(0, head.length - overflow));
    result = trimmedHead + result.slice(head.length);
  }
  return result;
}

// ============================================================================
// 2. 压缩接口契约
// ============================================================================

/**
 * 上下文压缩提供者接口：把"将要发送给模型的消息序列"压缩到规模预算内。
 *
 * 硬性契约（设计文档 §2.2，调用方与实现方共同遵守）：
 * 1. **只读输入**：入参数组与消息对象均不被修改（冻结输入下运行不抛错）；
 * 2. **新建数组**：返回新数组，元素允许复用原对象引用（直通路径）或浅拷贝
 *    （内容改写路径），绝不改写原消息对象；
 * 3. **条数与协议配对不变**：压缩只做"内容替换为截断/占位"，绝不删除消息
 *    （assistant.tool_calls ↔ tool.tool_call_id 配对保持合法）；
 * 4. **零 LLM、零副作用**：不发请求、不落盘、不写日志；
 * 5. **收敛不动点**：对已压缩结果重复应用，第 2 次起输出逐字节稳定，
 *    已截断内容的头部前缀永不进一步丢失（防落盘后重复压缩缩水）。
 */
export interface ContextBudgetProvider {
  /** 策略名（打点/配置对齐用，如 "deterministic"） */
  readonly name: string;
  /**
   * 压缩请求消息序列。
   *
   * @param messages 当前完整消息序列（只读，不被篡改）
   * @returns 压缩后的请求消息序列（新建数组，条数不变）
   */
  compactForRequest(messages: ReadonlyArray<SessionMessage>): SessionMessage[];
}

// ============================================================================
// 3. 确定性四级压缩实现（从 LlmTaskExecutor.compactMessagesForRequest 原样迁移）
// ============================================================================

/**
 * 确定性四级压缩提供者（缺省策略实现）。
 *
 * 逐级应用、达标即停：
 * - 第 0 级（无条件触发）：单条 tool 内容截断至 toolOutputMaxChars，头部
 *   + 失败窗口 + 尾部三段保留（见 truncateToolOutput）。主要膨胀源的直接
 *   治理，任何规模下只有收益；尾部失败证据不再丢失（dev 空转修复）；
 * - 第 1 级：完全相同的长 tool 输出（原始内容判重，> dedupeMinChars）保留
 *   最新，旧的替换为引用占位（重复 read/grep 空转场景收益最大）；
 * - 第 2 级：tool 结果总量超 toolResultsBudgetChars 时，从最老开始整条替换
 *   为占位直至达标（最近 protectedRecentTools 条 tool 永不丢弃）；
 * - 第 3 级（兜底）：总量仍超 requestTotalCharsCeiling 时，从最老可丢弃整条
 *   消息（任务卡之后、锚点与保护窗之外）继续替换为占位。
 *
 * 锚点保护语义："防丢弃不防截断"——system、首条非 system（任务卡）、末条
 * 消息永不整条丢弃；锚点 tool 仍可被第 0 级截断（架构师审查确认语义）。
 */
export class DeterministicContextBudgetProvider implements ContextBudgetProvider {
  /** 策略名（与 settings.compactStrategy 的 "deterministic" 取值对齐） */
  readonly name = "deterministic";

  /** 生效配置（构造时与缺省合并） */
  private readonly config: ContextBudgetConfig;

  /**
   * 用户红线 #3（可回退开关）：第 1/2/3 级丢弃占位「证据保留」开关。
   *
   * 构造时从环境变量读取一次：缺省开启（修复后行为，占位保留「失败窗口 + 尾部」
   * 真实内容摘要）；设 DEEPCODEX_CONTEXT_DROP_EVIDENCE=0 回退到修复前「仅字符数」
   * 的 droppedNote 占位，供依赖旧占位字节的存量集成平滑迁移。
   * 实例只读字段，compactForRequest 运行期零副作用（不读/改入参、不落盘、不打日志）。
   */
  private readonly dropEvidenceEnabled: boolean;

  /**
   * @param config 阈值覆盖（部分字段即可，未覆盖字段用缺省值）
   */
  constructor(config: Partial<ContextBudgetConfig> = {}) {
    this.config = { ...DEFAULT_CONTEXT_BUDGET_CONFIG, ...config };
    this.dropEvidenceEnabled = process.env.DEEPCODEX_CONTEXT_DROP_EVIDENCE !== "0";
  }

  /**
   * 压缩请求消息序列（契约见 {@link ContextBudgetProvider.compactForRequest}）。
   *
   * @param messages 当前完整消息序列（只读，不被篡改）
   * @returns 压缩后的请求消息序列（新建数组，条数不变）
   */
  compactForRequest(messages: ReadonlyArray<SessionMessage>): SessionMessage[] {
    if (messages.length <= this.config.minMessages) {
      // 极短历史（system+user+1 轮内）无压缩价值，直接原样返回（元素引用直通）
      return [...messages];
    }

    /** 内容字符数（null 安全） */
    const contentChars = (content: string | null): number => (typeof content === "string" ? content.length : 0);
    const totalChars = (items: ReadonlyArray<SessionMessage>): number =>
      items.reduce((sum, m) => sum + contentChars(m.content), 0);

    // 工作副本：浅拷贝每条消息（后续只改 content，不回写原对象）
    const working: SessionMessage[] = messages.map((m) => ({ ...m }));
    // 首条非 system 消息索引（任务卡简报）与最后一条索引：两个锚点永不丢弃
    const firstTaskIndex = working.findIndex((m) => m.role !== "system");
    const lastIndex = working.length - 1;

    // —— 第 0 级（无条件触发）：单条 tool 内容截断至上限（头+失败窗口+尾）——
    // 历史踩坑（2026-10-08 compactMessagesForRequest 纯函数单测暴露）：初版把
    // 本级放在"tool 总量超预算"触发线之后，导致单条大输出场景永不截断——
    // 主要膨胀源没有治理。截断在任何规模下只有收益，因此提升为无条件级别。
    // 2026-11-08 修订：旧实现 head-only 丢掉尾部真实错误（stderr / 断言 /
    // 失败堆栈），dev 阶段模型只能盲试换命令形成多轮空转。改为调用
    // truncateToolOutput 保留「头部 + 失败窗口 + 尾部」，尾部失败证据不再丢失。
    for (let i = 0; i < working.length; i += 1) {
      const message = working[i]!;
      if (message.role === "tool" && contentChars(message.content) > this.config.toolOutputMaxChars) {
        working[i] = {
          ...message,
          content: truncateToolOutput(message.content, this.config.toolOutputMaxChars),
        };
      }
    }

    // 保留占位（丢弃时写入的一行说明，保持消息条数与协议配对不变）
    const droppedNote = (originalChars: number): string =>
      `（上下文压缩：该工具结果共 ${originalChars} 字符已省略以控制请求规模，内容可通过工具重新执行获取）`;

    // 2026-11 修订：第 1/2/3 级把保护窗外旧 tool 结果「整条」替换为占位时，
    // 旧 droppedNote 只有字符数、无任何内容——第 0 级辛苦保留的尾部 stderr/FAILED
    // 证据被一并抹掉。整条替换前用 truncateToolOutput 在独立小预算内抽出
    // 「头部 + 失败窗口 + 尾部」证据摘要，保留在占位里（占位需含真实内容）。
    // 证据总预算取 toolOutputMaxChars 的一小部分：占位远小于原始结果（压缩有效），
    // 又严格 ≤ toolOutputMaxChars（第 0 级不会二次截断占位）。
    const DROPPED_PREFIX = "（上下文压缩：该工具结果";
    const evidenceTotalBudget = Math.max(0, Math.floor(this.config.toolOutputMaxChars * 0.2));
    /** 构造带真实证据的丢弃占位：字符数说明 +「已截断，原共」+ 失败窗口/尾部摘要 */
    const buildDroppedNoteWithEvidence = (rawContent: string | null, suffix: string): string => {
      const originalChars = contentChars(rawContent);
      // 可回退：开关关闭时恢复修复前「仅字符数」占位（含 level-1 重复后缀），逐字节零回归。
      if (!this.dropEvidenceEnabled) {
        return `${droppedNote(originalChars)}${suffix}`;
      }
      // 头部恒定携带「已截断，原共」子串（兼容既有断言），且以 DROPPED_PREFIX 开头
      //（兼容 CB-03 的 startsWith 判定 + 占位重入检测）。
      const header = `${DROPPED_PREFIX}已截断，原共 ${originalChars} 字符，以下保留失败窗口/尾部证据）${suffix}`;
      const evidenceBudget = Math.max(0, evidenceTotalBudget - header.length - 1);
      const evidence =
        typeof rawContent === "string" && evidenceBudget > 0 ? truncateToolOutput(rawContent, evidenceBudget) : "";
      const note = typeof evidence === "string" && evidence.length > 0 ? `${header}\n${evidence}` : header;
      // 严格 ≤ toolOutputMaxChars（正常由 evidenceTotalBudget 推导已满足，防御性兜底）
      return note.length <= this.config.toolOutputMaxChars ? note : note.slice(0, this.config.toolOutputMaxChars);
    };
    /** 已是丢弃占位（防止带证据的长占位被第 2/3 级二次压缩） */
    const isDroppedPlaceholder = (content: string | null): boolean =>
      typeof content === "string" && content.startsWith(DROPPED_PREFIX);

    // 计算保护窗：最近 protectedRecentTools 条 tool 消息受保护，永不整条丢弃
    const lastToolIndices: number[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]!.role === "tool") {
        lastToolIndices.push(i);
        if (lastToolIndices.length >= this.config.protectedRecentTools) {
          break;
        }
      }
    }
    const protectedToolIndices = new Set(lastToolIndices);

    /** 判断索引是否可丢弃（锚点/保护区之外） */
    const isDroppable = (index: number, role: string): boolean => {
      if (index === lastIndex || index === firstTaskIndex) {
        return false;
      }
      if (role === "system") {
        return false;
      }
      if (role === "tool" && protectedToolIndices.has(index)) {
        return false;
      }
      return true;
    };

    // —— 第 1 级：相同 tool 结果去重（保留最新，旧的替换为引用占位）——
    // 2026-10-08 修订（E1f 端到端回归暴露）：初版用**当前**（第 0 级截断后）
    // 内容做键，任何两条 >4K 输出都会被截断成相同前缀而"伪重复"——第 2 轮起
    // 模型就看不到旧结果的真实尾部。改在**原始内容**上判重：第 0 级截断副本
    // 供占位长度计算，原始数组仅用于生成去重键。
    const originalToolContentAt = messages.map((m) => m.content);
    const latestToolContentIndex = new Map<string, number>();
    for (let i = working.length - 1; i >= 0; i -= 1) {
      const message = working[i]!;
      const rawContent = message.role === "tool" ? originalToolContentAt[i] : null;
      if (message.role === "tool" && typeof rawContent === "string" && rawContent.length > this.config.dedupeMinChars) {
        if (latestToolContentIndex.has(rawContent)) {
          if (isDroppable(i, message.role)) {
            working[i] = {
              ...message,
              content: buildDroppedNoteWithEvidence(rawContent, "（与较近一次相同结果重复）"),
            };
          }
        } else {
          latestToolContentIndex.set(rawContent, i);
        }
      }
    }
    if (totalChars(working) <= this.config.toolResultsBudgetChars) {
      return working;
    }

    // —— 第 2 级：最老 tool 优先整体丢弃（替换占位），达标即停——
    for (let i = 0; i < working.length; i += 1) {
      const message = working[i]!;
      if (message.role !== "tool" || !isDroppable(i, message.role)) {
        continue;
      }
      const originalChars = contentChars(message.content);
      if (originalChars <= droppedNote(originalChars).length || isDroppedPlaceholder(message.content)) {
        continue; // 已是占位（含带证据的新占位），无压缩空间
      }
      // 证据取自原始 tool 输出（未经第 0 级截断），失败窗口/尾部更完整、无省略标记干扰。
      working[i] = { ...message, content: buildDroppedNoteWithEvidence(originalToolContentAt[i], "") };
      if (totalChars(working) <= this.config.toolResultsBudgetChars) {
        return working;
      }
    }

    // —— 第 3 级：兜底裁剪——总量仍超硬顶时，最老可丢弃整条消息替换占位——
    if (totalChars(working) <= this.config.requestTotalCharsCeiling) {
      return working;
    }
    for (let i = 0; i < working.length; i += 1) {
      const message = working[i]!;
      if (!isDroppable(i, message.role)) {
        continue;
      }
      const originalChars = contentChars(message.content);
      if (originalChars <= this.config.shortMessageMinChars || isDroppedPlaceholder(message.content)) {
        continue; // 短消息（assistant 决策文本/占位）无裁剪价值且可能承载推理链
      }
      // 仅 tool 消息补「失败窗口/尾部」证据摘要；其它角色的占位文案逐字保持
      // 迁移语义（CB-10 对 assistant 占位逐字节锁定，不得改动）。
      // 开关关闭时全部回退到修复前通用占位（含 tool 消息）。
      working[i] =
        this.dropEvidenceEnabled && message.role === "tool"
          ? { ...message, content: buildDroppedNoteWithEvidence(originalToolContentAt[i], "") }
          : { ...message, content: `（上下文压缩：该 ${message.role} 消息共 ${originalChars} 字符已省略）` };
      if (totalChars(working) <= this.config.requestTotalCharsCeiling) {
        return working;
      }
    }
    return working;
  }
}

// ============================================================================
// 4. 预算续跑（epoch）状态机
// ============================================================================

/**
 * epoch 续跑配置（缺省值与 LlmTaskExecutor 原常量一致）。
 */
export interface ContextEpochConfig {
  /** 最多续跑折叠次数（耗尽后 rollover 返回 null，调用方诚实 failure） */
  maxRollovers: number;
  /** 压缩触发阈值：段增量超过段额度 × 该值即折叠续跑（2026-10-20 起缺省 0.8，提前到 80% 压缩而非 100% 烧穿） */
  segmentThreshold: number;
  /** 续跑段额度折算比例：段额度 ≥ 名义预算 × 该值（防失控下限） */
  budgetRatio: number;
  /** 续跑段最少轮数：段额度 ≥ 实测单轮均耗 × 该值（防续跑形同虚设） */
  minRoundsPerEpoch: number;
  /** 全任务绝对上限倍数：累计 > 名义 × 该值即判失控（防软预算无限续期） */
  totalMultiplier: number;
  /**
   * 均耗折算分母：均耗 = 累计 / max(1, 轮次 − 该值)。
   * 缺省 1 = 轮顶语义（当前轮尚未发起请求，已发生轮数 = 轮次 − 1）；
   * 响应后折叠传 0（本轮请求已发生，已发生轮数 = 轮次）。
   */
  roundOffset: number;
}

/**
 * 缺省 epoch 配置（2026-10-20 需求变更后口径）：
 * - maxRollovers=Infinity：续跑折叠次数不再设限——Token 预算不再终止运行，
 *   压缩可无限续跑，防失控完全交给模型循环/空循环熔断（调用方已无
 *   "续跑耗尽 → failure" 分支，isRolloverExhausted 恒 false 仅保留防御）；
 * - segmentThreshold=0.8：段增量达段额度 80% 即提前折叠压缩
 *   （原 100% 烧穿才折叠，压缩点前移避免单轮巨耗击穿额度）；
 * - budgetRatio=0.5：续跑段额度不低于名义半额；
 * - minRoundsPerEpoch=4：段额度按实测均耗折算时保底 4 轮推进空间；
 * - totalMultiplier=2.5：绝对上限仅保留状态机口径（观测/测试兼容），
 *   调用方已不再据此终止。
 */
export const DEFAULT_CONTEXT_EPOCH_CONFIG: ContextEpochConfig = Object.freeze({
  maxRollovers: Infinity,
  segmentThreshold: 0.8,
  budgetRatio: 0.5,
  minRoundsPerEpoch: 4,
  totalMultiplier: 2.5,
  roundOffset: 1,
});

/**
 * 预算续跑（epoch）状态机——纯状态、零副作用。
 *
 * 职责（从 LlmTaskExecutor 循环内联状态抽出，循环只负责"问"与"推进"）：
 * - 段判限：{@link isSegmentExceeded}（累计 − 段基线 > 段额度）；
 * - 绝对上限判限：{@link isTotalCeilingExceeded}（累计 > 名义 × 倍数）；
 * - 耗尽门禁：{@link isRolloverExhausted}（已折叠次数 ≥ maxRollovers）；
 * - 折叠推进：{@link rollover}（新段基线=当前累计、新段额度按
 *   max(名义×比例, 均耗×最少轮数) 折算；耗尽返回 null）。
 *
 * 关键语义（软预算修复 2026-10-11）：续跑段按"段增量"判限，起步
 * （累计=基线）永不被误杀——首段基线=0、额度=名义预算，行为与修复前一致。
 */
export class ContextEpochState {
  /**
   * epoch 续跑配置（公开只读：调用方读取 budgetRatio / minRoundsPerEpoch
   * 等口径在折叠点做特化折算，如响应后折叠按本轮已发生口径计算段额度）。
   */
  public readonly config: ContextEpochConfig;
  /** 名义预算（任务级预算原值，不随折叠变化） */
  private readonly nominal: number;
  /** 已折叠续跑次数（0 = 首段） */
  private currentEpoch = 0;
  /** 段基线：当前段起点时的累计 token（首段=0） */
  private segmentBaseline = 0;
  /** 当前段额度（首段=名义预算；续跑段由 rollover 折算） */
  private segmentBudget: number;

  /**
   * @param nominalBudget 名义预算（任务级 token 预算，>0）。budget≤0 属调用方
   *   契约违规——0 额度的状态机会让每次 pre-flight 估算都判"折叠不可解"
   *   （2026-10-20 run 68acea2de182/90611ca5db4e 事故：编排器压缩基线
   *   max(0, maxTokens-used) 归零后，dev/fix 执行器拿到名义预算 0 的段额度，
   *   连一次最小请求都发不出，错误信息还伪装成"折叠不可解"），直接抛错暴露
   *   上游缺陷；执行器侧对 ≤0 预算做 fail-soft（跳过段预算检查），不会走到这里。
   * @param config epoch 配置覆盖（未覆盖字段用缺省值）
   */
  constructor(nominalBudget: number, config: Partial<ContextEpochConfig> = {}) {
    if (!Number.isFinite(nominalBudget) || nominalBudget <= 0) {
      throw new RangeError(`ContextEpochState 名义预算必须为正数，收到：${nominalBudget}`);
    }
    this.nominal = nominalBudget;
    this.config = { ...DEFAULT_CONTEXT_EPOCH_CONFIG, ...config };
    this.segmentBudget = nominalBudget;
  }

  /** 已折叠续跑次数（0 = 首段） */
  get epoch(): number {
    return this.currentEpoch;
  }

  /** 当前段额度（首段=名义预算，续跑段=折算值） */
  get budget(): number {
    return this.segmentBudget;
  }

  /** 名义预算（任务级预算原值） */
  get nominalBudget(): number {
    return this.nominal;
  }

  /** 当前段基线（本段起点时的累计 token） */
  get baseline(): number {
    return this.segmentBaseline;
  }

  /** 全任务绝对上限 = ceil(名义预算 × totalMultiplier) */
  get totalCeiling(): number {
    return Math.ceil(this.nominal * this.config.totalMultiplier);
  }

  /**
   * 绝对上限判限：累计 token 是否触达全任务硬上界（防失控）。
   *
   * @param currentTokens 全任务累计 token
   * @returns 累计 > 绝对上限时 true（恰好等于不算超）
   */
  isTotalCeilingExceeded(currentTokens: number): boolean {
    return currentTokens > this.totalCeiling;
  }

  /**
   * 段判限：本段增量是否达到压缩触发线（2026-10-20 起为段额度 ×
   * segmentThreshold=80%，提前压缩而非 100% 烧穿；软预算修复核心口径）。
   *
   * @param currentTokens 全任务累计 token
   * @returns 段增量（累计 − 段基线）> 段额度 × 80% 时 true
   */
  isSegmentExceeded(currentTokens: number): boolean {
    return currentTokens - this.segmentBaseline > this.segmentBudget * this.config.segmentThreshold;
  }

  /**
   * 耗尽门禁：续跑折叠额度是否已用尽（已折叠次数 ≥ maxRollovers）。
   *
   * @returns true = 不应再折叠续跑，调用方应诚实 failure
   */
  isRolloverExhausted(): boolean {
    return this.currentEpoch >= this.config.maxRollovers;
  }

  /**
   * 推进一次续跑折叠：段基线设为当前累计、段额度按均耗折算重置。
   *
   * 段额度 = max(名义 × budgetRatio, 实测单轮均耗 × minRoundsPerEpoch)：
   * 前者防失控下限，后者防"单轮成本 > 半额"时续跑段一轮即死、压缩续跑
   * 形同虚设（均耗 = 累计 / max(1, 轮次 − roundOffset)，是保守上界——
   * 折叠后上下文大幅变小，真实单轮成本只会更低）。
   *
   * @param currentTokens 折叠时点的全任务累计 token（新段基线）
   * @param round 折叠时点的轮次编号（均耗折算分母 = max(1, 轮次 − roundOffset)）
   * @returns 新段额度；续跑已耗尽（{@link isRolloverExhausted}）时返回 null
   */
  rollover(currentTokens: number, round: number): number | null {
    if (this.isRolloverExhausted()) {
      return null;
    }
    const observedAvgCostPerRound = currentTokens / Math.max(1, round - this.config.roundOffset);
    const newSegmentBudget = Math.max(
      Math.max(1, Math.floor(this.nominal * this.config.budgetRatio)),
      Math.ceil(observedAvgCostPerRound * this.config.minRoundsPerEpoch)
    );
    this.currentEpoch += 1;
    this.segmentBaseline = currentTokens;
    this.segmentBudget = newSegmentBudget;
    return newSegmentBudget;
  }

  /**
   * 推进一次续跑折叠（段额度由调用方特化计算后直接注入）。
   *
   * 用于折叠点均耗折算口径与 {@link rollover} 缺省折算不同的场景——
   * 典型为 p5 执行器"响应后折叠"：本轮 LLM 请求已实际发生，均耗分母按
   * 已发生 round 轮（而非轮顶的 round−1 轮）折算。耗尽门禁语义与
   * {@link rollover} 一致。
   *
   * @param currentTokens 折叠时点的全任务累计 token（新段基线）
   * @param newSegmentBudget 调用方折算好的新段额度（须为正数）
   * @returns 注入的新段额度；续跑已耗尽（{@link isRolloverExhausted}）时返回 null
   */
  rolloverWithBudget(currentTokens: number, newSegmentBudget: number): number | null {
    if (this.isRolloverExhausted()) {
      return null;
    }
    this.currentEpoch += 1;
    this.segmentBaseline = currentTokens;
    this.segmentBudget = newSegmentBudget;
    return newSegmentBudget;
  }

  /**
   * 预览下一次折叠将得到的新段额度（不推进状态）。
   *
   * 2026-10-20 新增：Token 预算终止移除后，p5 执行器 pre-flight 门禁需要
   * 判定"折叠是否可解"——任务简报本身超预算时，折叠换段仍装不下，若照常
   * 折叠会形成"装不下 → 折叠 → 仍装不下"的**零消耗无限折叠循环**（不耗
   * token、不耗轮数，任何轮数防线都无法收口）。调用方先用本方法预览新段
   * 额度，与折叠后请求的估算规模比对：装得下才折叠，装不下诚实 failure
   * （旧"续跑耗尽 → failure"语义的等价收口）。折算公式与 {@link rollover}
   * 完全一致（单一事实源），杜绝预览与实际额度漂移。
   *
   * @param currentTokens 折叠时点的全任务累计 token
   * @param round 折叠时点的轮次编号（均耗折算分母 = max(1, 轮次 − roundOffset)）
   * @returns 将得到的新段额度（> 0；缺省 maxRollovers=Infinity 下永不耗尽，
   *          显式 maxRollovers 用尽时返回 null）
   */
  previewRollover(currentTokens: number, round: number): number | null {
    if (this.isRolloverExhausted()) {
      return null;
    }
    const observedAvgCostPerRound = currentTokens / Math.max(1, round - this.config.roundOffset);
    return Math.max(
      Math.max(1, Math.floor(this.nominal * this.config.budgetRatio)),
      Math.ceil(observedAvgCostPerRound * this.config.minRoundsPerEpoch)
    );
  }
}
