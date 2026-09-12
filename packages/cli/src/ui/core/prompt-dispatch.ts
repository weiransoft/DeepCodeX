/**
 * 任务执行中指令分发判定与排队队列（F10，2026-09-12）
 *
 * 背景：CLI 在 LLM 回合执行中（busy 状态）接收用户新指令时，App.tsx handleSubmit
 * 按三层分流：立即控制命令直接执行 / 紧急干预插队并中断当前回合 / 普通指令排队延后。
 * 此前该分流逻辑内嵌在 App.tsx 中且无单测，排队消息也不绑定会话，存在 5 个缺口
 * （详见 docs/dev/queued-dispatch-gaps-fix.md G1-G5）。
 *
 * 本模块把"判断延后还是立即执行"的纯文本判定逻辑与排队队列数据结构抽出，
 * 不依赖 React / Ink / SessionManager，可独立单元测试（修复 G1）：
 *
 * 1. isImmediateControlCommand：控制类命令白名单判定（不占 LLM 回合，可立即执行）；
 * 2. isUrgentIntervention：紧急干预判定（G5 收紧为三级匹配，消除"要不要继续"
 *    "别人写的""停用缓存"类误伤）；
 * 3. PendingPromptQueue：会话绑定的排队队列（G2 修复基础），带容量上限（G5）。
 *
 * 设计约束：
 * - 纯函数 / 纯数据结构，无副作用、无 IO；
 * - 判定只做文本匹配，不做 LLM 调用（与 F9-v2 确定性通道同思路：分流必须确定性）；
 * - 队列仅内存对象，不持久化（崩溃恢复由会话持久化体系负责，指令级状态不维护——YAGNI）。
 *
 * @module ui/core/prompt-dispatch
 */

import type { PromptSubmission } from "../views/PromptInput";

// ============================================================================
// 1. 立即执行的控制类命令（修复 G1：从 App.tsx 抽出，可单测）
// ============================================================================

/**
 * 控制类命令白名单：这些命令不占用 LLM 回合，任务执行中也可直接执行。
 *
 * - exit / new / resume / undo / mcp / rules / team：会话控制与视图类命令；
 * - inject / bg / tasks / fg / cancel / pause：任务管理与动态注入类命令
 *   （ADR-DI-001 注入体系 + 后台任务体系）。
 *
 * 注意：continue 不在集合内——空会话时 /continue 打开会话列表、非空会话时
 * 触发 LLM 回合，两种语义都需要会话状态（isCurrentSessionEmpty）参与判断，
 * 由 App.tsx handleSubmit 调用方单独处理。
 */
export const IMMEDIATE_CONTROL_COMMANDS = new Set<string>([
  "exit",
  "new",
  "resume",
  "undo",
  "mcp",
  "rules",
  "team",
  "inject",
  "bg",
  "tasks",
  "fg",
  "cancel",
  "pause",
]);

/**
 * 判断提交是否属于"控制类命令"（任务执行中可立即执行，不占用 LLM 回合）。
 *
 * 纯函数版本：不接收 SessionManager，continue 一律返回 false（其空会话特例
 * 由调用方结合 isCurrentSessionEmpty 判断，见 App.tsx handleSubmit）。
 * 参数类型放宽为 command/text 可选的对象（调用方直接传 PromptSubmission 变量）。
 *
 * @param submission 用户提交（只需 command 字段）
 * @returns true 表示控制类命令，可立即执行
 */
export function isImmediateControlCommand(submission: { command?: string; text?: string }): boolean {
  const cmd = submission.command;
  if (!cmd) {
    return false;
  }
  return IMMEDIATE_CONTROL_COMMANDS.has(cmd);
}

// ============================================================================
// 2. 紧急干预判定（修复 G5：三级匹配收紧误伤面）
// ============================================================================

/**
 * 强停止类英文词（任意位置，\b 词边界防子串误伤，如 "stopped" 不误命中 "stop"）。
 * 大小写不敏感由调用方 toLowerCase 保证。
 */
const URGENT_ENGLISH_STOP_PATTERN = /\b(?:stop|cancel|abort|halt|quit|enough)\b/;

/**
 * 强停止类中文短语：必须出现在句首或标点/空白之后（子句起始锚定），
 * 前面可带一个可选礼貌前导词（请/麻烦/帮我/给我）。
 *
 * 锚定的目的（G5 误伤反例）：
 * - "要不要继续"中的"不要"位于句中（前有"要"），不匹配 → 不误打断；
 * - "这个别人写的"中的"别"位于句中（前有"个"），不匹配；
 * - "等下，别跑了"中的"别"位于逗号后（子句起始）→ 正确命中。
 *
 * 别(?!人)：排除"别人"这个高频复合词（"请别人看看"是求助而非停止）。
 */
const URGENT_CHINESE_STOP_PATTERN =
  /(?:^|[，。！!？?\s])(?:请|麻烦|帮我|给我)?\s*(?:别(?!人)|不要|停止|停下|取消|放弃|终止|够了)/;

/**
 * 纠正/重试类弱词前缀（必须位于消息开头，^ 锚定）。
 *
 * 设计依据：用户纠正"当前正在运行的回合"时，输入总是直接指陈
 * （"错了，应该用 B 方案""修改一下刚才那段"）；而排队的**新任务**描述
 * 即使包含这些词也极少以它们开头（"顺便重新看一下配置"中"重新"不在开头）。
 * 原实现任意位置子串匹配，"改天再 check""应该没问题"均被误伤——收紧为开头锚定。
 */
const URGENT_CORRECTION_PREFIX_PATTERN =
  /^(?:错了|不对|不正确|有误|改一下|修改|修正|纠正|重新|重来|重试|应该|不是|要用|改为|换成|反思)/;

/**
 * 纠正/重试类英文前缀（^ 锚定 + \b 词边界，大小写不敏感由调用方保证）。
 */
const URGENT_ENGLISH_CORRECTION_PREFIX_PATTERN =
  /^(?:wrong|incorrect|mistake|fix|retry|redo|rewind|rethink|check|think again)\b/;

/**
 * 紧急优先类显式词（任意位置即可）：
 * 这些词本身就是用户对优先级的显式声明（"这事 asap""优先处理"），
 * 在任务执行中说"优先"意味着要打断当前顺序，误伤面可接受。
 */
const URGENT_PRIORITY_PATTERN = /\b(?:urgent|immediate|asap)\b|马上|立即|立刻|优先/;

/**
 * 判断提交是否属于对当前正在运行的 LLM 回合的"紧急干预"。
 *
 * 命中时应：插入队头 + 中断当前回合（让该消息立即重新驱动对话）。
 *
 * 三级匹配（G5 收紧后的语义）：
 * 1. 强停止类（停止/取消/放弃等）：子句起始锚定，中英文混合；
 * 2. 纠正/重试类（错了/修改/重新等）：必须位于消息开头；
 * 3. 紧急优先类（urgent/立即/优先等）：任意位置的显式声明词。
 *
 * @param submission 用户提交（command 或 text）
 * @returns true 表示紧急干预，应插队并中断当前回合
 */
export function isUrgentIntervention(submission: { command?: string; text?: string }): boolean {
  // /inject 是动态注入体系的显式入口（ADR-DI-001），恒视为紧急干预
  if (submission.command === "inject") {
    return true;
  }
  const text = submission.text?.trim().toLowerCase() ?? "";
  if (!text) {
    return false;
  }
  // 整条输入恰为"停"（单字急停，最常用的手动打断方式）
  if (text === "停") {
    return true;
  }
  return (
    URGENT_ENGLISH_STOP_PATTERN.test(text) ||
    URGENT_CHINESE_STOP_PATTERN.test(text) ||
    URGENT_CORRECTION_PREFIX_PATTERN.test(text) ||
    URGENT_ENGLISH_CORRECTION_PREFIX_PATTERN.test(text) ||
    URGENT_PRIORITY_PATTERN.test(text)
  );
}

// ============================================================================
// 3. 排队队列（修复 G2：会话绑定；修复 G5：容量上限）
// ============================================================================

/**
 * 排队队列容量上限。
 *
 * 防止用户（或异常脚本）狂输导致无限堆积；32 与 core 端 InterruptQueue 的 64
 * 保持同数量级但更保守——CLI 队列消费需要逐个跑完整 LLM 回合，堆积无意义。
 */
export const MAX_PENDING_QUEUE_SIZE = 32 as const;

/**
 * 排队条目：提交 + 入队时绑定的会话 ID。
 *
 * 会话绑定（G2 修复核心）：入队时记录当时的活跃会话，消费时只把消息发回
 * 同一会话；用户中途切换会话后，旧会话的排队消息不会泄漏到新会话。
 */
export interface QueuedPromptEntry {
  /**
   * 入队时的活跃会话 ID（入队时无活跃会话则为空字符串）。
   *
   * 匹配语义：消费端（App.tsx finally）以"当前活跃会话 ID"为键 dequeue，
   * 正常回合中活跃会话必然存在，"" 条目不会命中；唯一的理论边界是
   * 消费时也无活跃会话（"" == "" 匹配），但该场景在 App.tsx 中不可达——
   * resetToWelcome 置空会话前已 discardAll 清空队列。
   */
  readonly sessionId: string;
  /** 用户提交内容 */
  readonly submission: PromptSubmission;
}

/**
 * 会话绑定的待执行提示队列（FIFO，内存态）。
 *
 * 与 core 端 InterruptQueue 的职责区分：
 * - InterruptQueue：任务执行**中**注入方向调整指令（合成为 system 消息）；
 * - PendingPromptQueue：任务执行**期间**排队的完整用户新指令（回合结束后
 *   作为独立 LLM 回合依次执行）。
 *
 * 线程模型：Node.js 单线程事件循环 + React ref 持有，无需锁。
 */
export class PendingPromptQueue {
  /** 队列容量上限（构造可覆盖，测试用） */
  private readonly maxSize: number;
  /** 内部存储（FIFO：队尾 push，队头出队） */
  private readonly entries: QueuedPromptEntry[] = [];

  /**
   * @param maxSize 容量上限，默认 MAX_PENDING_QUEUE_SIZE
   */
  constructor(maxSize: number = MAX_PENDING_QUEUE_SIZE) {
    this.maxSize = maxSize;
  }

  /** 当前排队条数（含所有会话） */
  get size(): number {
    return this.entries.length;
  }

  /**
   * 入队一条提交。
   *
   * @param sessionId 入队时的活跃会话 ID
   * @param submission 用户提交
   * @param options.urgent true 时插到队头（紧急干预优先执行），默认队尾
   * @returns true 入队成功；false 队列已满（容量上限，调用方应提示用户）
   */
  enqueue(sessionId: string, submission: PromptSubmission, options?: { urgent?: boolean }): boolean {
    if (this.entries.length >= this.maxSize) {
      return false;
    }
    const entry: QueuedPromptEntry = { sessionId, submission };
    if (options?.urgent) {
      this.entries.unshift(entry);
    } else {
      this.entries.push(entry);
    }
    return true;
  }

  /**
   * 取出下一条属于指定会话的排队提交。
   *
   * 从队头开始扫描：其他会话的条目视为陈旧（用户已切换会话）直接丢弃，
   * 返回第一条匹配条目；全部扫描完仍无匹配返回 null。
   * 丢弃陈旧条目是 G2 修复的一部分——切走的会话排队消息不该复活。
   *
   * @param sessionId 当前活跃会话 ID
   * @returns 匹配的排队条目；无匹配（含队列空）返回 null
   */
  dequeue(sessionId: string): QueuedPromptEntry | null {
    // 从队头扫描：非匹配条目即陈旧（用户已切换会话），边扫描边丢弃
    const i = 0;
    while (i < this.entries.length) {
      const entry = this.entries[i];
      if (entry.sessionId === sessionId) {
        this.entries.splice(i, 1);
        return entry;
      }
      // 陈旧条目：丢弃后不递增 i（后续条目前移到当前位置）
      this.entries.splice(i, 1);
    }
    return null;
  }

  /**
   * 丢弃全部排队条目。
   *
   * 使用场景：ESC 中断（用户要求"全部停下"，G3 修复）、LLM 出错后用户
   * 显式放弃、会话销毁。
   *
   * @returns 丢弃条数
   */
  discardAll(): number {
    const count = this.entries.length;
    this.entries.splice(0);
    return count;
  }

  /**
   * 丢弃所有不属于指定会话的条目（保留该会话的排队消息）。
   *
   * 使用场景：切换会话（handleSelectSession，G2 修复）——旧会话的排队
   * 消息被丢弃，新会话自己的排队消息（理论上不存在，防御性保留）不受影响。
   *
   * @param sessionId 要保留的会话 ID
   * @returns 丢弃条数
   */
  discardExcept(sessionId: string): number {
    let count = 0;
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      if (this.entries[i].sessionId !== sessionId) {
        this.entries.splice(i, 1);
        count += 1;
      }
    }
    return count;
  }
}
