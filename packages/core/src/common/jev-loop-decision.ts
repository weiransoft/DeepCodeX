/**
 * JevLoopDecision —— 循环决策服务（单一收敛点，架构师审查 P2-6）
 *
 * 三条链路（普通会话主循环 / EAG-P5 执行器 / 闲聊陪伴模式）共享：
 * 1. 健康状态机：healthy ⇄ degraded（连续失败 N 次降级；恢复探测 single-flight，
 *    架构师审查 P2-7——并发期间只发一次探测请求，其余等待共享结果）；
 * 2. 判定上下文摘要构建：**强制脱敏**（P1-4）——工具参数不进摘要，工具结果仅保留
 *    成败与签名 hash，用户/助手正文经 redactDigestText 脱敏后截断；
 * 3. 统一判定问题集（方案 §4.2）：continue_loop（choice）+ is_empty_turn（choice），
 *    P5 追加 progress（score）；陪伴模式切换 criteria 文案；
 * 4. turnSeq 序号标签（P0-2）：预取结果携带发起时的轮次序号，join 侧按序号匹配，
 *    不匹配即丢弃，防止跨轮误用；发起点即挂 .catch，杜绝 unhandledRejection。
 *
 * 判定映射（方案 §4.2，语义与既有 LoopGuardAction 对齐）在 TurnGuard.evaluateJevDecision
 * （loop-guard.ts）与 P5 执行器内完成——本服务只产出原始 answers，不掺杂动作语义。
 *
 * @module common/jev-loop-decision
 */

import {
  JevDecisionClient,
  loadJevClientConfigFromEnv,
  type JevAnswer,
  type JevDecisionResult,
  type JevDigestMessage,
  type JevQuestion,
} from "./jev-client";

// ============================================================================
// 脱敏（架构师审查 P1-4：摘要强制脱敏，防凭据泄漏到远程网关）
// ============================================================================

/**
 * 摘要脱敏模式（与凭据文件黑名单同源思路，独立副本避免 common → 业务层反向依赖；
 * 两处模式需同步维护）
 */
const DIGEST_SECRET_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  // OpenAI 风格密钥与 JWT
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // Bearer / Authorization 头
  /\b(Bearer|Basic)\s+[A-Za-z0-9._+/=-]{8,}/gi,
  // 常见密钥赋值形态（key/token/secret/password/pw 后跟冒号或等号）
  /\b(api[_-]?key|access[_-]?token|secret|token|password|passwd|pw|credential)\b\s*[:=]\s*\S+/gi,
  // PEM 私钥块
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // AWS / 阿里云 AK 形态
  /\b(AKIA|LTAI)[A-Z0-9]{12,}\b/g,
]);

/** 单条摘要文本最大长度（超出截断，控制请求体与网关上下文开销） */
const DIGEST_TEXT_MAX_CHARS = 200;

/**
 * 摘要文本脱敏 + 截断
 *
 * @param text 原始文本（用户正文 / 助手正文 / 工具结果摘要）
 * @returns 脱敏后的安全文本（命中密钥处替换为 [REDACTED]）
 */
export function redactDigestText(text: string): string {
  let result = text;
  for (const pattern of DIGEST_SECRET_PATTERNS) {
    // 每次替换后重新赋值；正则均带 g 标志，无需手动复位 lastIndex
    result = result.replace(pattern, "[REDACTED]");
  }
  if (result.length > DIGEST_TEXT_MAX_CHARS) {
    result = `${result.slice(0, DIGEST_TEXT_MAX_CHARS)}…`;
  }
  return result;
}

// ============================================================================
// 摘要构建输入
// ============================================================================

/**
 * 单轮观测数据（由调用方从会话/执行器状态提取，本服务不做消息遍历）
 */
export interface JevTurnObservation {
  /** 轮次内可见正文（未脱敏原文，进入摘要前统一脱敏） */
  readonly visibleText: string;
  /** 本轮是否有工具调用 */
  readonly hadToolCalls: boolean;
  /** 本轮成功/失败的工具调用数 */
  readonly toolSucceededCount: number;
  readonly toolFailedCount: number;
  /** 本轮工具调用「名称+签名 hash」列表（不含参数原文、不含结果原文） */
  readonly toolCallDigests: readonly string[];
}

/**
 * 摘要构建输入：最近 K 轮观测 + 观测状态串原料
 */
export interface JevDigestInput {
  /** 会话模式（companion=闲聊陪伴 / task=任务执行），影响 criteria 文案 */
  readonly mode: "companion" | "task";
  /** 已完成轮次计数（观测口径） */
  readonly turnsCompleted: number;
  /** 最近几轮观测（时间正序，最多取最近 6 轮） */
  readonly recentTurns: readonly JevTurnObservation[];
  /** 用户最新指令（脱敏后进入摘要首位，让 jev 知道任务目标） */
  readonly latestUserText?: string;
}

// ============================================================================
// 健康状态与决策结果类型
// ============================================================================

/** 健康状态：healthy=正常主判 / degraded=降级到 heuristic 兜底 */
export type JevHealth = "healthy" | "degraded";

/**
 * 带轮次序号的预取决策（P0-2：防跨轮误用）
 */
export interface JevTurnDecision {
  /** 发起预取时的轮次序号（调用方每轮递增，join 时必须匹配） */
  readonly turnSeq: number;
  /** jev 原始决策结果（成功含 answers，失败含错误分类） */
  readonly result: JevDecisionResult;
}

// ============================================================================
// 服务
// ============================================================================

/** 连续失败多少次判定为 degraded（默认 3：与网关间歇 500 的容错经验值对齐） */
const DEGRADE_AFTER_CONSECUTIVE_FAILURES = 3;

/**
 * 循环决策服务（三条链路共享的单实例）
 */
export class JevLoopDecision {
  private readonly client: JevDecisionClient;
  /** 当前健康状态 */
  private health: JevHealth;
  /** 连续失败计数（达到阈值即降级；成功即清零） */
  private consecutiveFailures: number;
  /** 恢复探测 single-flight：degraded 期间共享同一个探测 Promise（P2-7） */
  private inflightProbe: Promise<JevDecisionResult> | null = null;

  constructor(client: JevDecisionClient) {
    this.client = client;
    this.health = "healthy";
    this.consecutiveFailures = 0;
  }

  /**
   * 从环境变量创建服务实例（测试与特殊部署用构造注入替代）
   *
   * @returns 未配置密钥时返回 null（调用方据此判定 jev 完全禁用）
   */
  static fromEnv(): JevLoopDecision | null {
    const config = loadJevClientConfigFromEnv();
    if (!config.enabled) {
      return null;
    }
    return new JevLoopDecision(new JevDecisionClient(config));
  }

  /** 是否启用（客户端层判定：未配置密钥即 false） */
  get enabled(): boolean {
    return this.client.enabled;
  }

  /** 当前健康状态快照（观测用） */
  getHealth(): JevHealth {
    return this.health;
  }

  /**
   * 构建判定上下文摘要（脱敏在内部完成，调用方传原文）
   *
   * 摘要结构：
   * 1. 首条 user 消息：任务目标（最新用户指令脱敏截断）；
   * 2. 后续消息：每轮一条 assistant 摘要（可见正文脱敏截断 + 工具成败计数 +
   *    工具签名 hash 列表）。**工具参数原文与结果原文一律不进摘要**（P1-4）。
   *
   * @param input 摘要构建输入
   * @returns 直接可发给网关的 messages（role 全部折叠为 user，jev 无对话语义需求）
   */
  buildDigestMessages(input: JevDigestInput): JevDigestMessage[] {
    const messages: JevDigestMessage[] = [];
    if (input.latestUserText != null && input.latestUserText.length > 0) {
      messages.push({
        role: "user",
        content: `任务目标：${redactDigestText(input.latestUserText)}`,
      });
    }
    // 只取最近 6 轮（控制上下文，更早的轮次对「是否空转」判定贡献递减）
    const recent = input.recentTurns.slice(-6);
    for (const turn of recent) {
      const parts: string[] = [];
      const visible = redactDigestText(turn.visibleText);
      if (visible.length > 0) {
        parts.push(`可见正文：${visible}`);
      }
      if (turn.hadToolCalls) {
        parts.push(`工具调用：成功${turn.toolSucceededCount}次/失败${turn.toolFailedCount}次`);
        if (turn.toolCallDigests.length > 0) {
          // 签名 hash 已是脱敏形态（调用方提供），直接拼入
          parts.push(`调用签名：${turn.toolCallDigests.slice(0, 4).join(", ")}`);
        }
      }
      if (parts.length === 0) {
        parts.push("本轮无可见正文且无工具调用");
      }
      messages.push({ role: "assistant", content: parts.join("；") });
    }
    return messages;
  }

  /**
   * 构建会话状态串（state 字段：轮次计数 + 模式标签 + 空转观测计数）
   *
   * 2026-11-10 校准计划 A3/B1 合入（docs/dev/jev-loop-decision-calibration-plan-20261110.md）：
   * 真机 80 样本实验显示，baseline 状态串下 jev 对真实空转窗口全判 continue
   * （一致率 50%）；注入 `consecutive_empty`（末尾连续空转轮数，与
   * TurnGuard.consecutiveEmptyTurns 同口径）与 `recent_empty`（窗口内空转总数）
   * 后一致率升至 100% 且 progress 零误杀——判定信号与守护计数器对齐。
   *
   * @param input 摘要构建输入（recentTurns 用于空转计数；脱敏已在摘要层完成，
   *              计数是数值不携带任何文本）
   */
  buildState(input: Pick<JevDigestInput, "mode" | "turnsCompleted" | "recentTurns">): string {
    // 空转口径与 TurnGuard.recordTurn 一致：无可见正文 且 无工具成功
    const isEmpty = (turn: JevTurnObservation): boolean =>
      turn.visibleText.trim().length === 0 && turn.toolSucceededCount === 0;
    const recent = input.recentTurns.slice(-6);
    // 末尾连续空转轮数（从最后一轮向前数，遇非空轮停止）
    let consecutiveEmpty = 0;
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      if (isEmpty(recent[i])) consecutiveEmpty += 1;
      else break;
    }
    const recentEmpty = recent.filter(isEmpty).length;
    return `mode=${input.mode}; turns=${input.turnsCompleted}; health=${this.health}; consecutive_empty=${consecutiveEmpty}; recent_empty=${recentEmpty}`;
  }

  /**
   * 发起循环判定请求（continue_loop + is_empty_turn 两问）
   *
   * 不抛异常：网络/契约失败封装为 ok:false 结果并计入健康状态机。
   *
   * @param input 摘要构建输入
   * @param turnSeq 当前轮次序号（调用方维护并递增）
   * @returns 带序号的决策结果（调用方 join 时校验 turnSeq）
   */
  async decideLoop(input: JevDigestInput, turnSeq: number): Promise<JevTurnDecision> {
    const questions: Record<string, JevQuestion> = {
      continue_loop:
        input.mode === "companion"
          ? {
              type: "choice",
              instructions: "闲聊陪伴场景：判断当前对话循环是否应继续",
              criteria: {
                continue: "对话仍在自然推进（有新话题、有回应价值）",
                stop: "对话陷入重复/无意义循环，应暂停并询问用户",
              },
            }
          : {
              type: "choice",
              instructions: "判断当前任务执行循环是否应继续",
              criteria: {
                continue: "循环仍有进展或合理的尝试空间",
                stop: "循环空转（重复尝试、无产出），应暂停",
              },
            },
      is_empty_turn: {
        type: "choice",
        instructions: "判断最近一轮是否为空循环（无可见回复且无有效工具产出）",
        criteria: { yes: "本轮是空循环", no: "本轮有实质内容或工具产出" },
      },
    };
    const result = await this.request("decision", {
      messages: this.buildDigestMessages(input),
      state: this.buildState(input),
      questions,
    });
    return { turnSeq, result };
  }

  /**
   * 发起 P5 执行器判定请求（continue_loop + progress 两问）
   *
   * @param input 摘要构建输入（mode 固定 task）
   * @param turnSeq 当前轮次序号
   */
  async decideProgress(input: JevDigestInput, turnSeq: number): Promise<JevTurnDecision> {
    const questions: Record<string, JevQuestion> = {
      continue_loop: {
        type: "choice",
        instructions: "判断自主编码任务的工具循环是否应继续",
        criteria: {
          continue: "仍有进展或合理的尝试空间",
          stop: "重复无产出尝试，应终止本轮任务执行",
        },
      },
      progress: {
        type: "score",
        instructions: "评估最近一轮任务进展程度",
        criteria: ["无进展", "部分进展", "显著进展"],
      },
    };
    const result = await this.request("decision", {
      messages: this.buildDigestMessages(input),
      state: this.buildState(input),
      questions,
    });
    return { turnSeq, result };
  }

  /**
   * 直接透传一次决策（P2-6：/v1/systemone 同构验证入口）
   *
   * 供真机验证脚本与上层做契约级调用；同样计入健康状态机。
   */
  async decideRaw(
    endpoint: "decision" | "systemone",
    request: { messages: readonly JevDigestMessage[]; state: string; questions: Readonly<Record<string, JevQuestion>> }
  ): Promise<JevDecisionResult> {
    return this.request(endpoint, request);
  }

  // ------------------------------------------------------------------
  // 内部：健康状态机 + single-flight 恢复探测
  // ------------------------------------------------------------------

  /**
   * 统一请求入口（健康状态机挂载点）
   *
   * - healthy：直接请求；成功→清零失败计数；失败→累计，达阈值降级；
   * - degraded：发起**恢复探测**（single-flight：并发期间共享同一探测 Promise，
   *   P2-7）；探测成功→恢复 healthy 并放行本次结果；探测失败→返回失败结果
   *   （不产生额外请求风暴）。
   */
  private async request(
    endpoint: "decision" | "systemone",
    request: { messages: readonly JevDigestMessage[]; state: string; questions: Readonly<Record<string, JevQuestion>> }
  ): Promise<JevDecisionResult> {
    if (this.health === "degraded") {
      // degraded：只允许 single-flight 探测请求，其余调用共享探测结果
      if (this.inflightProbe == null) {
        this.inflightProbe = this.client.decide(endpoint, request).finally(() => {
          // 探测完成后清空句柄，下一轮 degraded 调用可发起新探测
          this.inflightProbe = null;
        });
      }
      const probeResult = await this.inflightProbe;
      if (probeResult.ok) {
        // 探测成功：恢复 healthy（失败计数清零），本次结果放行
        this.health = "healthy";
        this.consecutiveFailures = 0;
      }
      return probeResult;
    }

    // healthy：正常请求
    const result = await this.client.decide(endpoint, request);
    if (result.ok) {
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= DEGRADE_AFTER_CONSECUTIVE_FAILURES) {
        this.health = "degraded";
      }
    }
    return result;
  }
}

// ============================================================================
// 空轮 nudge（校准计划阶段 C：空轮「事后暂停咨询」升级为「事前自愈重试」）
// ============================================================================

/**
 * 空轮 nudge 提示文案（注入为 user 消息后立即发起下一轮 LLM 请求）。
 *
 * 前缀 `[jev-nudge]` 是契约的一部分：
 * 1. session 主循环据此把 nudge 消息排除出 jev 摘要（NG5：防止 nudge
 *    被 `getLatestUserTextForJev` 误当任务目标、摘要自反催化）；
 * 2. 测试据此断言注入发生。
 */
export const NUDGE_MESSAGE =
  "[jev-nudge] 上一轮没有可见回复也没有有效的工具产出。请直接给出对用户可见的回复，或执行有效工具推进任务；若任务已完成，请明确说明完成状态。";

/** nudge 触发的默认最低置信度（校准计划阶段 B 结论：维持 0.5 工作点） */
export const NUDGE_MIN_CONFIDENCE = 0.5;

/**
 * 判定 jev answers 是否构成「空轮自愈 nudge」触发条件：
 * is_empty_turn 判 yes 且置信度达阈值。
 *
 * NG7 由调用方配合完成：本函数只看 jev 结论；调用方还须本地复核
 * （最近一轮观测确实为空）才注入，防 jev 误判驱动。
 *
 * @param answers jev 决策 answers（invalid 时安全返回 false）
 * @param minConfidence 最低置信度（默认 0.5）
 */
export function isJevEmptyTurnVerdict(
  answers: Readonly<Record<string, JevAnswer>> | null | undefined,
  minConfidence: number = NUDGE_MIN_CONFIDENCE
): boolean {
  const emptyAnswer = answers != null ? readChoiceAnswer(answers, "is_empty_turn") : undefined;
  if (emptyAnswer == null) return false;
  return emptyAnswer.choice === "yes" && emptyAnswer.confidence >= minConfidence;
}

// ============================================================================
// 答案读取工具（供 TurnGuard / P5 执行器消费 answers）
// ============================================================================

/**
 * 从 answers 中读取 choice 答案（key 不存在或类型不符返回 undefined）
 */
export function readChoiceAnswer(
  answers: Readonly<Record<string, JevAnswer>>,
  key: string
): JevChoiceAnswerLike | undefined {
  const answer = answers[key];
  if (answer != null && answer.type === "choice") {
    return answer;
  }
  return undefined;
}

/**
 * 从 answers 中读取 score 答案（key 不存在或类型不符返回 undefined）
 */
export function readScoreAnswer(
  answers: Readonly<Record<string, JevAnswer>>,
  key: string
): JevScoreAnswerLike | undefined {
  const answer = answers[key];
  if (answer != null && answer.type === "score") {
    return answer;
  }
  return undefined;
}

/** choice 答案消费形态（避免上层直接依赖 jev-client 内部联合类型的顺序） */
export interface JevChoiceAnswerLike {
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

/** score 答案消费形态 */
export interface JevScoreAnswerLike {
  readonly score: number;
  readonly confidence: number;
  readonly legend: Readonly<Record<string, string>>;
}
