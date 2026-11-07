/**
 * 思考深度调度（Turn-level Adaptive Thinking Depth）
 *
 * ## 为什么是「下调 / 回弹」而不是「上下自由调」
 *
 * 仓库原本就有一套完整的 thinking 开关与 `reasoningEffort` 五档链路
 * （`common/openai-thinking.ts`、`providers/*`），但它是**全局静态**的：
 * `activateSession()` 在方法开头解构一次，整轮会话所有迭代复用同一组值。
 * 结果是「嗯」「谢谢」这类闲聊也要付满额推理预算，而陪伴模式里忽然出现的
 * 「帮我把这个报错排一下」也没有任何机制把深度还回去。
 *
 * 这里把它改成**按回合**决策，但立一条铁律：
 *
 * > **调度只下调，永不超过用户在设置里配置的档位。**
 *
 * 也就是说 `full` 恒等于用户的基线，所谓「升」是从下调状态**回弹到基线**。
 * 这条约束让「复杂任务保证充分思考」不是一句承诺而是结构上不可能违反：
 * 任务回合永远拿到与调度器上线前完全相同的请求参数。收益全部来自
 * 闲聊 / 情感陪伴回合被省掉的冗余推理，不存在以质量换速度的档位。
 *
 * ## 四个输入维度
 *
 * | 维度 | 来源 | 作用 |
 * |---|---|---|
 * | 用户意图 | 文本关键词 + 结构信号 | 区分闲聊 / 情感 / 任务 / 复杂任务 / 危机 |
 * | 问题复杂度 | 长度、分句、代码块、路径、命令、多步标记 | 决定是否回弹到基线 |
 * | 上下文长度 | 会话消息数与字符数 | 长上下文下短指代句不轻易降级 |
 * | 响应时效 | 语音回合标记、用户显式催促 | 只加速轻场景，任务回合不下调 |
 *
 * ## 平滑与回退
 *
 * - **升档即时**：任务、危机、工具续跑立即回到基线，不让上一轮的轻量状态拖累准确率。
 * - **降档分级**：高置信度的明确闲聊立即降（响应效率优先）；边界模糊的回合
 *   要连续 `DOWNGRADE_CONFIRM_TURNS` 轮确认、且每轮最多降一档，避免在
 *   「闲聊 ↔ 任务」边界来回抖动时语气与详略忽长忽短。
 * - **可回退**：`enabled=false`（环境变量 `DCX_THINK_DEPTH=off`）或任何异常/
 *   脏输入 → 直接回到基线，`fallback=true`、`effective=false`，行为与上线前一致。
 *
 * ## 诚实降级
 *
 * `control` 描述模型**实际**能接受的控制手段：
 * - `effort`：Qwen3.8 / DeepSeek V4，原生 `reasoning_effort`；
 * - `binary`：旧 Qwen3，只有 `enable_thinking` 开关，档位会塌缩成开/关；
 * - `budget`：Claude，`thinking.budget_tokens`；
 * - `none`：通用 OpenAI 兼容模型，请求体没有 thinking 字段。此时调度器**不假装有加速**，
 *   `effective=false`（除了 `off` 档仍会跳过历史 reasoning_content 回放、减少 prefill token）。
 *
 * 本模块是纯函数：无 I/O、无全局时钟（时间由调用方注入）、无 `process.env`，
 * 因此规则、护栏与指标都能脱离模型单测。
 *
 * @module core/think-depth
 */

import type { ReasoningEffort } from "./settings.js";
import type { SoulMode } from "./super-agent/soul/types.js";

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

/** 规则版本（写进遥测，便于 A/B 期间区分不同规则集的样本） */
export const THINK_DEPTH_RULES_VERSION = 1;

/** 五档 effort 由低到高；`ReasoningEffort` 的取值顺序在此固定 */
export const EFFORT_LADDER: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** 四档思考深度（从最轻到基线） */
export type ThinkingDepthLevel = "off" | "light" | "balanced" | "full";

/** 档位顺序，滞回的「每次最多一档」按此表推进 */
export const DEPTH_LEVELS: readonly ThinkingDepthLevel[] = ["off", "light", "balanced", "full"];

/** 本轮场景（陪伴模式内的任务回合有独立标签，便于分场景统计） */
export type TurnScene =
  | "small_talk"
  | "emotional"
  | "companion_chat"
  | "companion_task"
  | "task"
  | "complex_task"
  | "ambiguous"
  | "crisis"
  | "tool_continuation";

/** 模型实际支持的控制手段（决定 honest degradation） */
export type ThinkingControl = "effort" | "binary" | "budget" | "none";

/** 调度器的静态基线（来自 settings 的一次快照） */
export interface ThinkingDepthBaseline {
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  /** Claude extended thinking 的全局预算；非 Claude 传 undefined */
  thinkingBudgetTokens?: number;
}

/** 每轮输入信号 */
export interface ThinkingDepthInput {
  /** 本轮用户原文（未经改写） */
  text: string;
  /** 当前对话模式（由实际注入的 soul 提示词判定） */
  mode: SoulMode;
  /** 会话上下文字符数（估算即可，只用于分桶） */
  contextChars: number;
  /** 会话消息条数 */
  contextMessages: number;
  /** 响应时效压力：语音回合 / 前端显式指定 */
  latencySensitive: boolean;
  /** 主循环迭代序号；>0 表示工具调用后的续跑 */
  iteration: number;
  /** 是否带附件 / 图片 */
  hasAttachments: boolean;
  /** 是否为权限答复、/continue、编排命令等结构化回合 */
  isStructuredTurn: boolean;
  /** 模型控制能力 */
  control: ThinkingControl;
  /** 总开关（environment kill switch / 单回合 fixed 覆盖） */
  enabled: boolean;
}

/** 滞回状态（每个会话一份，跨回合复用） */
export interface ThinkingDepthState {
  lastLevel: ThinkingDepthLevel;
  lastScene: TurnScene;
  /** 待确认的降档目标 */
  pendingLevel: ThinkingDepthLevel | null;
  /** 连续确认轮数 */
  pendingCount: number;
  /** 已决策回合数 */
  turn: number;
}

/** 调度决策（可直接序列化进 SSE 遥测） */
export interface ThinkingDepthPlan {
  version: number;
  scene: TurnScene;
  mode: SoulMode;
  /** 实际生效档位（可能经滞回被按住） */
  level: ThinkingDepthLevel;
  /** 规则原始建议档位 */
  targetLevel: ThinkingDepthLevel;
  /** 本轮请求实际使用的 thinking 开关 */
  thinkingEnabled: boolean;
  /** 本轮请求实际使用的 effort（永不超过基线） */
  reasoningEffort: ReasoningEffort;
  /** Claude 的 budget_tokens（仅 control=budget 时有意义） */
  thinkingBudgetTokens?: number;
  control: ThinkingControl;
  /** 本轮是否真的改变了模型请求参数 */
  effective: boolean;
  /** 是否走了兜底（异常/脏输入/总开关关闭） */
  fallback: boolean;
  /** 滞回是否把档位按住了 */
  smoothed: boolean;
  /** 轻场景置信度（0~1） */
  confidence: number;
  /** 可解释的决策依据 */
  reasons: readonly string[];
}

/** 决策返回（plan + 更新后的状态，均为新对象） */
export interface ThinkingDepthDecision {
  plan: ThinkingDepthPlan;
  state: ThinkingDepthState;
}

// ---------------------------------------------------------------------------
// 关键参数（集中在此，文档与测试引用同一份常量）
// ---------------------------------------------------------------------------

/** 短回合字符上限：超过后不再因「短」而加社交分 */
export const SHORT_TURN_MAX_CHARS = 24;
/** 长文本起点：超过后开始计入复杂度 */
export const LONG_TURN_MIN_CHARS = 80;
/** 复杂文本阈值 */
export const COMPLEX_TURN_MIN_CHARS = 160;
/** 上下文分桶：轻 / 中 / 重 */
export const CONTEXT_LIGHT_MAX_CHARS = 8_000;
export const CONTEXT_MEDIUM_MAX_CHARS = 32_000;
/** 任务意图判定阈值 */
export const TASK_INTENT_THRESHOLD = 0.28;
/** 复杂任务标签阈值（只影响场景标记，任务回合无论哪档都吃满基线） */
export const COMPLEX_TASK_THRESHOLD = 0.42;
/** 闲聊 / 情感意图判定阈值 */
export const LIGHT_INTENT_THRESHOLD = 0.3;
export const EMOTION_INTENT_THRESHOLD = 0.25;
/** 高置信轻场景阈值：达到即可立即降档，不必等确认 */
export const CLEAR_LIGHT_CONFIDENCE = 0.72;
/** 模糊降档需要的连续确认轮数 */
export const DOWNGRADE_CONFIRM_TURNS = 2;
/** 每轮最多下降的档位数 */
export const MAX_DOWNGRADE_STEPS = 1;
/** 语音回合的短句阈值放宽量（ASR 常带语气填充词） */
export const VOICE_SHORT_BONUS_CHARS = 8;
/** Claude 最小 thinking 预算（Anthropic API 硬约束） */
export const MIN_THINKING_BUDGET_TOKENS = 1024;
/** 各档对应的 Claude 预算比例 */
export const BUDGET_RATIO: Readonly<Record<ThinkingDepthLevel, number>> = {
  off: 0,
  light: 0.3,
  balanced: 0.6,
  full: 1,
};

// ---------------------------------------------------------------------------
// 词表
// ---------------------------------------------------------------------------

/** 任务意图词（开发场景高频） */
const TASK_WORDS: readonly string[] = [
  "实现",
  "修复",
  "重构",
  "排查",
  "定位",
  "分析",
  "设计",
  "架构",
  "部署",
  "测试",
  "验证",
  "优化",
  "改造",
  "迁移",
  "评审",
  "审查",
  "对比",
  "评估",
  "方案",
  "步骤",
  "原理",
  "根因",
  "为什么",
  "怎么",
  "如何",
  "能不能",
  "帮我",
  "看下",
  "看一下",
  "检查",
  "报错",
  "异常",
  "日志",
  "配置",
  "接口",
  "数据库",
  "依赖",
  "构建",
  "编译",
  "提交",
  "回滚",
  "性能",
  "函数",
  "类型",
  "变量",
  "文件",
  "代码",
  "脚本",
  "命令",
  "分支",
  "diff",
  "bug",
  "implement",
  "fix",
  "refactor",
  "debug",
  "analyze",
  "design",
  "deploy",
  "test",
  "why",
  "how",
];

/** 社交闲聊词 */
const SOCIAL_WORDS: readonly string[] = [
  "你好",
  "您好",
  "嗨",
  "哈喽",
  "在吗",
  "早",
  "早上好",
  "中午好",
  "晚上好",
  "晚安",
  "谢谢",
  "多谢",
  "辛苦",
  "拜拜",
  "再见",
  "嗯",
  "嗯嗯",
  "好的",
  "好嘞",
  "哈哈",
  "呵呵",
  "今天",
  "昨天",
  "明天",
  "周末",
  "吃饭",
  "下班",
  "上班",
  "天气",
  "睡觉",
  "休息",
  "好久不见",
  "聊会儿",
  "随便聊聊",
  "没事",
  "行吧",
  "对啊",
  "是吗",
  "真的吗",
  "hi",
  "hello",
  "thanks",
  "thank you",
  "ok",
  "lol",
];

/** 情感表达词 */
const EMOTION_WORDS: readonly string[] = [
  // 只收不易误命中的词：单字「气」会命中「天气」「气氛」，单字「烦」会命中
  // 「烦恼」「麻烦」，把它们放进来会把闲聊误判成情绪回合、把任务误判成安慰场景。
  "累",
  "疲惫",
  "难受",
  "难过",
  "委屈",
  "焦虑",
  "烦躁",
  "压力",
  "崩溃",
  "失落",
  "孤独",
  "开心",
  "高兴",
  "激动",
  "生气",
  "好烦",
  "很烦",
  "烦死了",
  "害怕",
  "担心",
  "失眠",
  "想哭",
  "不开心",
  "被骂",
  "被批",
  "分手",
  "吵架",
  "心情",
  "有点丧",
  "撑不住",
  "顶不住",
  "emo",
];

/** 危机信号：命中即禁用降级，且不允许彻底关闭思考 */
const CRISIS_WORDS: readonly string[] = [
  "自杀",
  "自伤",
  "轻生",
  "不想活",
  "活不下去",
  "结束自己的生命",
  "结束生命",
  "割腕",
  "跳楼",
  "伤害别人",
  "伤害他人",
  "同归于尽",
  "想死",
  "求死",
  "遗书",
];

/** 时效催促词（只影响轻场景，不削减任务思考） */
const URGENT_WORDS: readonly string[] = [
  "紧急",
  "立刻",
  "马上",
  "尽快",
  "快点",
  "十万火急",
  "线上挂了",
  "宕机",
  "asap",
  "urgent",
];

/** 多步标记（出现 >=2 个视为多步任务） */
const MULTI_STEP_WORDS: readonly string[] = [
  "先",
  "然后",
  "接着",
  "再",
  "最后",
  "第一步",
  "第二步",
  "第三步",
  "依次",
  "逐步",
  "分三步",
  "同时",
];

// ---------------------------------------------------------------------------
// 信号分析
// ---------------------------------------------------------------------------

/** 文本分析结果（全部为可断言的纯数据） */
export interface TurnSignals {
  chars: number;
  clauses: number;
  questionMarks: number;
  hasCodeFence: boolean;
  hasPathLike: boolean;
  hasCommandLike: boolean;
  hasMultiStep: boolean;
  hasNumberedList: boolean;
  taskHits: readonly string[];
  socialHits: readonly string[];
  emotionHits: readonly string[];
  crisisHits: readonly string[];
  urgentHits: readonly string[];
  taskScore: number;
  socialScore: number;
  emotionScore: number;
  complexity: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function hits(text: string, words: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return words.filter((word) => lower.includes(word.toLowerCase()));
}

/**
 * 从用户原文提取四类信号
 *
 * 纯字符串启发式，不调用 LLM——调度本身不能成为新的延迟来源。
 *
 * @param text 用户原文
 * @returns 信号快照
 */
export function analyzeTurn(text: string): TurnSignals {
  const safe = typeof text === "string" ? text : "";
  const chars = [...safe].length;
  const clauses = safe.split(/[，,；;。！!？?\n]/).filter((part) => part.trim().length > 0).length;
  const questionMarks = (safe.match(/[？?]/g) ?? []).length;
  const hasCodeFence = safe.includes("```") || /\b(?:function|class|interface|import|export)\s+\w+/i.test(safe);
  const hasPathLike =
    /(?:[\w.-]+\/)+[\w.-]+/.test(safe) ||
    /\b[\w-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|json|md|yaml|yml|toml|sql|sh|log|vue|css)\b/i.test(safe);
  const hasCommandLike =
    /\b(?:npm|pnpm|yarn|git|docker|kubectl|python3?|pip3?|curl|bash|make|cargo|node|tsc|pytest)\b/i.test(safe);
  const multiStepHits = hits(safe, MULTI_STEP_WORDS);
  const hasMultiStep = multiStepHits.length >= 2;
  const hasNumberedList = /(?:^|\n)\s*\d+[.、)]\s*\S/.test(safe) || /[一二三四五六]、/.test(safe);

  const taskHits = hits(safe, TASK_WORDS);
  const socialHits = hits(safe, SOCIAL_WORDS);
  const emotionHits = hits(safe, EMOTION_WORDS);
  const crisisHits = hits(safe, CRISIS_WORDS);
  const urgentHits = hits(safe, URGENT_WORDS);

  const structural =
    (hasCodeFence ? 0.3 : 0) +
    (hasPathLike ? 0.2 : 0) +
    (hasCommandLike ? 0.2 : 0) +
    (hasMultiStep ? 0.15 : 0) +
    (hasNumberedList ? 0.1 : 0);
  const lengthBoost = chars > LONG_TURN_MIN_CHARS ? 0.15 : chars > 48 ? 0.06 : 0;
  const taskScore = clamp01(0.18 * Math.min(taskHits.length, 4) + structural + lengthBoost);

  const shortBoost = chars <= SHORT_TURN_MAX_CHARS ? 0.14 : 0;
  const socialScore = clamp01(
    0.24 * Math.min(socialHits.length, 3) + shortBoost + (questionMarks === 0 && !hasPathLike ? 0.06 : 0)
  );
  const emotionScore = clamp01(0.26 * Math.min(emotionHits.length, 3) + (chars <= 60 ? 0.06 : 0));

  const complexity = clamp01(
    0.28 * clamp01(chars / COMPLEX_TURN_MIN_CHARS) +
      0.16 * clamp01(clauses / 6) +
      (hasCodeFence ? 0.18 : 0) +
      (hasPathLike ? 0.12 : 0) +
      (hasCommandLike ? 0.1 : 0) +
      (hasMultiStep ? 0.1 : 0) +
      0.08 * clamp01(questionMarks / 2) +
      0.1 * clamp01(taskHits.length / 4)
  );

  return {
    chars,
    clauses,
    questionMarks,
    hasCodeFence,
    hasPathLike,
    hasCommandLike,
    hasMultiStep,
    hasNumberedList,
    taskHits,
    socialHits,
    emotionHits,
    crisisHits,
    urgentHits,
    taskScore,
    socialScore,
    emotionScore,
    complexity,
  };
}

// ---------------------------------------------------------------------------
// 场景分类与目标档位
// ---------------------------------------------------------------------------

/** 分类中间结果 */
export interface SceneDecision {
  scene: TurnScene;
  targetLevel: ThinkingDepthLevel;
  confidence: number;
  reasons: readonly string[];
}

function lightScenes(scene: TurnScene): boolean {
  return scene === "small_talk" || scene === "emotional" || scene === "companion_chat";
}

/**
 * 场景分类 + 目标档位（不含滞回、不含模型能力降级）
 *
 * 导出以便单测直接断言「场景化调度规则」，不必构造完整 Input。
 *
 * @param signals 文本信号
 * @param mode 对话模式
 * @param input 回合级信号
 * @returns 场景决策
 */
export function classifyTurnScene(
  signals: TurnSignals,
  mode: SoulMode,
  input: Pick<
    ThinkingDepthInput,
    "latencySensitive" | "hasAttachments" | "isStructuredTurn" | "iteration" | "contextChars"
  >
): SceneDecision {
  const reasons: string[] = [];

  // 护栏 1：工具续跑 / 结构化回合。此时用户文本往往是「继续」「允许」，
  // 用文本判成闲聊会直接破坏任务准确率。
  if (input.iteration > 0 || input.isStructuredTurn) {
    return {
      scene: "tool_continuation",
      targetLevel: "full",
      confidence: 1,
      reasons: ["工具续跑或结构化回合：保持基线，避免上下文被轻量档位截断"],
    };
  }

  // 护栏 2：危机。宁可多想一点，也不把安全回合压成快答；且不允许 off。
  if (signals.crisisHits.length > 0) {
    return {
      scene: "crisis",
      targetLevel: "balanced",
      confidence: 1,
      reasons: ["命中危机信号：禁用快速档与彻底关闭思考，安全规则优先"],
    };
  }

  const shortLimit = SHORT_TURN_MAX_CHARS + (input.latencySensitive ? VOICE_SHORT_BONUS_CHARS : 0);
  // 语音 ASR 常带「嗯」「那个」等填充词，短句阈值放宽，避免把闲聊误判成复杂任务
  const voiceShortBias = input.latencySensitive && signals.chars <= shortLimit ? 0.08 : 0;
  const taskScore = clamp01(signals.taskScore - voiceShortBias);
  const socialScore = clamp01(signals.socialScore + voiceShortBias);
  const emotionScore = signals.emotionScore;

  const hasTaskStructure =
    signals.hasCodeFence ||
    signals.hasPathLike ||
    signals.hasCommandLike ||
    signals.hasMultiStep ||
    input.hasAttachments;
  const taskIntent = taskScore >= TASK_INTENT_THRESHOLD || hasTaskStructure || signals.complexity >= 0.55;
  const lightIntent = socialScore >= LIGHT_INTENT_THRESHOLD || emotionScore >= EMOTION_INTENT_THRESHOLD;

  if (input.latencySensitive) reasons.push("语音/时效敏感回合：放宽短句判据");
  if (input.hasAttachments) reasons.push("带附件：按任务回合处理");

  if (taskIntent && lightIntent) {
    // 混合意图（「我好累，帮我把这个报错看一下」）：只要有任何任务结构信号
    // 或任务分不低于社交分，一律按任务走——情绪被接住的前提是事没办错。
    const taskWins = hasTaskStructure || taskScore >= socialScore || signals.complexity >= 0.5;
    if (!taskWins) {
      return {
        scene: "ambiguous",
        targetLevel: "balanced",
        confidence: 0.4,
        reasons: [...reasons, "任务与闲聊信号相当：保守取 balanced"],
      };
    }
    reasons.push("混合意图含任务信号：按任务回合处理，情绪另由陪伴语气承接");
  }

  if (taskIntent) {
    const complex =
      signals.complexity >= COMPLEX_TASK_THRESHOLD || signals.chars >= COMPLEX_TURN_MIN_CHARS || signals.hasCodeFence;
    if (mode === "companion" && !complex) {
      // 陪伴模式里的任务回合：语气仍由 soul 提示词控制（一行提示词都没改），
      // 但思考深度必须还给任务，中等复杂度即可，避免过度推理拖慢对话。
      return {
        scene: "companion_task",
        targetLevel: signals.complexity >= 0.45 ? "full" : "balanced",
        confidence: 0.85,
        reasons: [...reasons, "陪伴模式内的任务回合：语气不变，思考深度回弹"],
      };
    }
    return {
      scene: complex ? "complex_task" : "task",
      targetLevel: "full",
      confidence: 0.9,
      reasons: [...reasons, complex ? "复杂任务：吃满基线思考预算" : "任务回合：吃满基线思考预算"],
    };
  }

  if (lightIntent) {
    const isEmotional = emotionScore >= EMOTION_INTENT_THRESHOLD;
    const scene: TurnScene = mode === "companion" ? "companion_chat" : isEmotional ? "emotional" : "small_talk";
    // 情感陪伴不彻底关闭思考：ESConv 式的「先接住再谈事」需要一次短推演，
    // 直接 off 容易退化成「加油」「抱抱」这类放之四海皆准的空话。
    const level: ThinkingDepthLevel = isEmotional ? "light" : "off";
    const confidence = clamp01(socialScore + emotionScore * 0.5 + (1 - taskScore) * 0.4);
    reasons.push(isEmotional ? "情感陪伴：轻量思考，保住具体回应" : "简单闲聊：关闭冗余推理");
    if (signals.urgentHits.length > 0) reasons.push("用户催促：轻场景进一步倾向快速响应");
    return { scene, targetLevel: level, confidence, reasons };
  }

  // 边界：长上下文下的短指代句（「那个呢」「按刚才说的」）不能被当成闲聊砍掉，
  // 它依赖大量历史才能答对。
  if (input.contextChars > CONTEXT_MEDIUM_MAX_CHARS && signals.chars <= shortLimit) {
    reasons.push("重上下文 + 短指代：保守取 balanced");
    return { scene: "ambiguous", targetLevel: "balanced", confidence: 0.35, reasons };
  }
  reasons.push("信号不足：保守取 balanced，不擅自降档");
  return { scene: "ambiguous", targetLevel: "balanced", confidence: 0.3, reasons };
}

// ---------------------------------------------------------------------------
// 档位 → 请求参数
// ---------------------------------------------------------------------------

function rankOfEffort(effort: ReasoningEffort): number {
  const index = EFFORT_LADDER.indexOf(effort);
  return index < 0 ? EFFORT_LADDER.length - 1 : index;
}

function levelRank(level: ThinkingDepthLevel): number {
  const index = DEPTH_LEVELS.indexOf(level);
  return index < 0 ? DEPTH_LEVELS.length - 1 : index;
}

function rankOfLevel(level: ThinkingDepthLevel, baselineRank: number): number {
  // `EFFORT_LADDER` 下标：low=0 / medium=1 / high=2 / xhigh=3 / max=4。
  // off 与 light 都落在 low，区别在 thinkingEnabled（off 直接关）；
  // balanced 落 medium；full 恒等于用户基线。任何档位都不得越过基线。
  switch (level) {
    case "off":
    case "light":
      return Math.min(0, baselineRank);
    case "balanced":
      return Math.min(1, baselineRank);
    case "full":
      return baselineRank;
  }
}

/** Claude 预算：按比例缩放全局预算，且不低于 API 下限 */
function budgetFor(level: ThinkingDepthLevel, baseline: ThinkingDepthBaseline): number | undefined {
  if (baseline.thinkingBudgetTokens === undefined) return undefined;
  const ratio = BUDGET_RATIO[level];
  if (ratio === 0) return undefined;
  return Math.max(MIN_THINKING_BUDGET_TOKENS, Math.round(baseline.thinkingBudgetTokens * ratio));
}

/**
 * 生成初始滞回状态
 *
 * @returns 起始状态（基线档）
 */
export function initialThinkingDepthState(): ThinkingDepthState {
  return { lastLevel: "full", lastScene: "task", pendingLevel: null, pendingCount: 0, turn: 0 };
}

function sanitizeInput(input: ThinkingDepthInput): ThinkingDepthInput {
  return {
    ...input,
    text: typeof input.text === "string" ? input.text : "",
    contextChars: Number.isFinite(input.contextChars) ? Math.max(0, input.contextChars) : 0,
    contextMessages: Number.isFinite(input.contextMessages) ? Math.max(0, Math.floor(input.contextMessages)) : 0,
    iteration: Number.isFinite(input.iteration) ? Math.max(0, Math.floor(input.iteration)) : 0,
    mode: input.mode === "companion" ? "companion" : "work",
  };
}

/**
 * 决策入口：给定本轮信号、静态基线与上一轮状态，产出本轮请求参数与新状态
 *
 * 纯函数：不修改入参，不读环境变量，不读时钟。任何异常都收敛到基线，
 * 让调用方可以放心放在 LLM 主链路热路径上。
 *
 * @param rawInput 回合信号
 * @param baseline 用户在设置里的静态 thinking 配置
 * @param previousState 上一轮状态（首次传 `initialThinkingDepthState()`）
 * @returns 决策与新状态
 */
export function resolveThinkingDepth(
  rawInput: ThinkingDepthInput,
  baseline: ThinkingDepthBaseline,
  previousState: ThinkingDepthState
): ThinkingDepthDecision {
  const input = sanitizeInput(rawInput);
  const safeBaseline: ThinkingDepthBaseline = {
    thinkingEnabled: baseline.thinkingEnabled === true,
    reasoningEffort: EFFORT_LADDER.includes(baseline.reasoningEffort) ? baseline.reasoningEffort : "max",
    ...(baseline.thinkingBudgetTokens !== undefined
      ? { thinkingBudgetTokens: Math.max(MIN_THINKING_BUDGET_TOKENS, Math.round(baseline.thinkingBudgetTokens)) }
      : {}),
  };
  const state: ThinkingDepthState = {
    lastLevel: DEPTH_LEVELS.includes(previousState?.lastLevel) ? previousState.lastLevel : "full",
    lastScene: previousState?.lastScene ?? "task",
    pendingLevel: previousState?.pendingLevel ?? null,
    pendingCount: Number.isFinite(previousState?.pendingCount) ? Math.max(0, previousState.pendingCount) : 0,
    turn: Number.isFinite(previousState?.turn) ? Math.max(0, previousState.turn) + 1 : 1,
  };

  const buildPlan = (
    scene: TurnScene,
    targetLevel: ThinkingDepthLevel,
    level: ThinkingDepthLevel,
    confidence: number,
    reasons: readonly string[],
    fallback: boolean
  ): ThinkingDepthPlan => {
    const baselineRank = rankOfEffort(safeBaseline.reasoningEffort);
    const rank = rankOfLevel(level, baselineRank);
    const reasoningEffort = EFFORT_LADDER[Math.min(Math.max(rank, 0), EFFORT_LADDER.length - 1)] ?? "max";
    const thinkingEnabled = level === "off" ? false : safeBaseline.thinkingEnabled;
    // off 档即使模型没有原生 thinking 字段，仍会跳过历史 reasoning_content 回放，
    // 这是唯一对通用模型也成立的真实收益；其余档位对 control=none 不假装有加速。
    const effective = fallback
      ? false
      : input.control === "none"
        ? level === "off" && safeBaseline.thinkingEnabled
        : level !== "full" || thinkingEnabled !== safeBaseline.thinkingEnabled;
    return {
      version: THINK_DEPTH_RULES_VERSION,
      scene,
      mode: input.mode,
      level,
      targetLevel,
      thinkingEnabled,
      reasoningEffort,
      ...(budgetFor(level, safeBaseline) !== undefined ? { thinkingBudgetTokens: budgetFor(level, safeBaseline) } : {}),
      control: input.control,
      effective,
      fallback,
      smoothed: level !== targetLevel,
      confidence: Math.round(confidence * 1000) / 1000,
      reasons,
    };
  };

  // 总开关关闭 / 脏输入：完全回到静态基线，行为与调度器上线前一致。
  // 脏输入不靠「夹取后继续猜」：一旦信号不可信，宁可按原配置跑，也不拿错档位冒险。
  const dirty =
    typeof rawInput?.text !== "string" ||
    !Number.isFinite(rawInput?.contextChars) ||
    !Number.isFinite(rawInput?.contextMessages) ||
    !Number.isFinite(rawInput?.iteration) ||
    (rawInput?.mode !== "work" && rawInput?.mode !== "companion") ||
    typeof rawInput?.control !== "string" ||
    !(["effort", "binary", "budget", "none"] as readonly string[]).includes(rawInput.control) ||
    typeof rawInput?.enabled !== "boolean" ||
    typeof rawInput?.latencySensitive !== "boolean" ||
    typeof rawInput?.hasAttachments !== "boolean" ||
    typeof rawInput?.isStructuredTurn !== "boolean";
  if (!input.enabled || dirty) {
    const reason = dirty ? ["脏输入：回落静态基线"] : ["调度总开关关闭：回落静态基线"];
    return {
      plan: buildPlan("task", "full", "full", 1, reason, true),
      state: { ...state, lastLevel: "full", lastScene: "task", pendingLevel: null, pendingCount: 0 },
    };
  }

  try {
    const signals = analyzeTurn(input.text);
    const decision = classifyTurnScene(signals, input.mode, input);
    const reasons = [...decision.reasons];
    const targetRank = levelRank(decision.targetLevel);
    const previousRank = levelRank(state.lastLevel);
    let level = decision.targetLevel;

    if (targetRank > previousRank) {
      // 升档即时：任务 / 危机 / 工具续跑不允许被上一轮的轻量状态拖住
      reasons.push("升档即时：任务与安全优先");
      state.pendingLevel = null;
      state.pendingCount = 0;
    } else if (targetRank === previousRank) {
      state.pendingLevel = null;
      state.pendingCount = 0;
    } else if (
      decision.scene === "ambiguous" ||
      (lightScenes(decision.scene) && decision.confidence < CLEAR_LIGHT_CONFIDENCE)
    ) {
      // 只有边界模糊的回合需要连续确认 + 每轮最多一档：这是防抖的全部代价。
      // 明确的任务 / 危机 / 高置信闲聊都立即执行，否则「升档快、降档拖三轮」
      // 会让场景切换显得迟钝，反而违背提升反应效率的目标。
      if (state.pendingLevel === decision.targetLevel) state.pendingCount += 1;
      else {
        state.pendingLevel = decision.targetLevel;
        state.pendingCount = 1;
      }
      if (state.pendingCount >= DOWNGRADE_CONFIRM_TURNS) {
        level = DEPTH_LEVELS[Math.max(0, previousRank - MAX_DOWNGRADE_STEPS)] ?? "off";
        reasons.push(`连续 ${state.pendingCount} 轮确认降档，本轮最多降 ${MAX_DOWNGRADE_STEPS} 档`);
        state.pendingLevel = null;
        state.pendingCount = 0;
      } else {
        level = state.lastLevel;
        reasons.push(`边界场景待确认（${state.pendingCount}/${DOWNGRADE_CONFIRM_TURNS}）：暂持 ${level}`);
      }
    } else {
      const clearLight = lightScenes(decision.scene);
      reasons.push(
        clearLight
          ? `明确轻场景（置信度 ${decision.confidence.toFixed(2)} ≥ ${CLEAR_LIGHT_CONFIDENCE}）：立即降档`
          : "明确任务/安全场景：立即执行目标档位"
      );
      state.pendingLevel = null;
      state.pendingCount = 0;
    }

    // 时效压力 NEVER 下调任务回合：只作为轻场景的加速器
    if (input.latencySensitive && !lightScenes(decision.scene) && decision.scene !== "ambiguous") {
      reasons.push("时效压力不作用于任务/危机回合：准确率优先");
    }

    const plan = buildPlan(decision.scene, decision.targetLevel, level, decision.confidence, reasons, false);
    state.lastLevel = level;
    state.lastScene = decision.scene;
    return { plan, state };
  } catch {
    // 启发式不该成为会话失败的原因：任何异常都回到基线并标记 fallback
    return {
      plan: buildPlan("task", "full", "full", 1, ["调度异常：回落静态基线"], true),
      state: { ...state, lastLevel: "full", lastScene: "task", pendingLevel: null, pendingCount: 0 },
    };
  }
}

// ---------------------------------------------------------------------------
// 可验证的效率指标（纯聚合，样本来自 SSE 遥测 / 语音延迟采样）
// ---------------------------------------------------------------------------

/** 单样本：一轮的档位与实测延迟 */
export interface ThinkingDepthSample {
  level?: ThinkingDepthLevel;
  scene?: TurnScene;
  llmTtftMs?: number;
  e2eMs?: number;
  fallback?: boolean;
}

/** 分组统计 */
export interface DepthGroupMetrics {
  count: number;
  ttftP50Ms?: number;
  ttftP95Ms?: number;
  e2eP50Ms?: number;
}

/** 汇总结果 */
export interface ThinkingDepthEfficiency {
  /** 总样本数 */
  total: number;
  /** 降档样本占比（0~1） */
  downgradedRatio: number;
  /** 兜底样本占比（0~1） */
  fallbackRatio: number;
  /** 按档位分组的延迟 */
  byLevel: Partial<Record<ThinkingDepthLevel, DepthGroupMetrics>>;
  /** 按场景分组的样本数 */
  byScene: Partial<Record<TurnScene, number>>;
  /** 基线（full）与最轻档（off/light）的 TTFT P50 差，缺失时为 undefined */
  ttftSavingP50Ms?: number;
}

function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function validMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 汇总效率指标
 *
 * 诚实边界：缺 TTFT / E2E 的样本仍计入分档统计，但分位数只基于实测值；
 * 没有任何 full 或轻档实测值时 `ttftSavingP50Ms` 留 `undefined`，绝不填 0 冒充收益。
 *
 * @param samples 采样
 * @returns 汇总
 */
export function summarizeThinkingDepthEfficiency(samples: readonly ThinkingDepthSample[]): ThinkingDepthEfficiency {
  const byLevel: Partial<Record<ThinkingDepthLevel, DepthGroupMetrics>> = {};
  const byScene: Partial<Record<TurnScene, number>> = {};
  const ttft: Partial<Record<ThinkingDepthLevel, number[]>> = {};
  const e2e: Partial<Record<ThinkingDepthLevel, number[]>> = {};
  let downgraded = 0;
  let fallback = 0;

  for (const sample of samples ?? []) {
    const level = sample?.level;
    if (level === undefined || !DEPTH_LEVELS.includes(level)) continue;
    if (sample.scene !== undefined) byScene[sample.scene] = (byScene[sample.scene] ?? 0) + 1;
    if (level !== "full") downgraded += 1;
    if (sample.fallback === true) fallback += 1;
    const group = byLevel[level] ?? { count: 0 };
    group.count += 1;
    byLevel[level] = group;
    const ttftMs = validMs(sample.llmTtftMs);
    if (ttftMs !== undefined) (ttft[level] ??= []).push(ttftMs);
    const e2eMs = validMs(sample.e2eMs);
    if (e2eMs !== undefined) (e2e[level] ??= []).push(e2eMs);
  }

  for (const level of DEPTH_LEVELS) {
    const group = byLevel[level];
    if (!group) continue;
    const ttftP50 = percentile(ttft[level] ?? [], 50);
    const ttftP95 = percentile(ttft[level] ?? [], 95);
    const e2eP50 = percentile(e2e[level] ?? [], 50);
    if (ttftP50 !== undefined) group.ttftP50Ms = Math.round(ttftP50);
    if (ttftP95 !== undefined) group.ttftP95Ms = Math.round(ttftP95);
    if (e2eP50 !== undefined) group.e2eP50Ms = Math.round(e2eP50);
  }

  const total = Object.values(byLevel).reduce((sum, group) => sum + (group?.count ?? 0), 0);
  const fullP50 = byLevel.full?.ttftP50Ms;
  const lightP50 = byLevel.off?.ttftP50Ms ?? byLevel.light?.ttftP50Ms;
  const saving = fullP50 !== undefined && lightP50 !== undefined ? Math.round(fullP50 - lightP50) : undefined;

  return {
    total,
    downgradedRatio: total === 0 ? 0 : Math.round((downgraded / total) * 1000) / 1000,
    fallbackRatio: total === 0 ? 0 : Math.round((fallback / total) * 1000) / 1000,
    byLevel,
    byScene,
    ...(saving !== undefined ? { ttftSavingP50Ms: saving } : {}),
  };
}
