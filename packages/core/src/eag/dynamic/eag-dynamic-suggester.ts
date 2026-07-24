/**
 * 全局动态编排建议层
 *
 * 本模块实现 EagDynamicSuggester，用于根据用户自然语言目标和当前环境，
 * 给出最合适的命令建议。覆盖 EAG/Team/Rules/slash 全部命令体系。
 * 第一阶段只做建议，不自动执行任何命令。
 *
 * 核心能力：
 * 1. 任务意图识别与粒度评估。
 * 2. 歧义澄清：当存在多个技术路径或需求不清时，返回 ask_clarification。
 * 3. 命令建议：direct_chat / suggest_command / suggest_autonomous / suggest_graph。
 * 4. 失败安全：LLM 输出异常或低置信度时降级为 direct_chat。
 *
 * 设计原则（对齐 2026-07-24-eag-llm-dynamic-orchestration.md v1.4）：
 * - 不自动执行任何命令。
 * - 多阶段任务根据上下文优先推荐 /eag-autonomous 或 /team autonomous。
 * - 可用命令清单由调用方通过 DynamicCommandDescriptor 注入，LLM 只能建议已支持的命令。
 *
 * @module eag/dynamic/eag-dynamic-suggester
 */

import type { LLMClient, LLMRequest } from "../../providers/llm-provider";
import { buildEagSuggestionPrompt } from "./prompts/eag-suggestion-prompt";

// ============================================================================
// 1. 类型定义
// ============================================================================

/**
 * 动态命令所属体系
 *
 * 覆盖 DeepCodeX CLI 内全部命令体系：
 * - eag：EAG 编排命令（/eag-design、/eag-build 等）
 * - team：多角色团队子命令（/team dispatch、/team autonomous 等）
 * - rules：RLIS 规则管理子命令（/rules list、/rules add 等）
 * - slash：TUI slash 命令（/skills、/model、/new 等）
 */
export type DynamicCommandCategory = "eag" | "team" | "rules" | "slash";

/**
 * 统一命令描述符
 *
 * 用于向建议层注入全部可用命令的元数据，LLM 根据 description 理解命令用途，
 * 根据 category + id 唯一标识一条命令，根据 name 生成展示给用户的 commandHint。
 */
export interface DynamicCommandDescriptor {
  /** 命令所属体系 */
  readonly category: DynamicCommandCategory;
  /** 命令唯一标识（如 eag-design、team-autonomous、rules-list、skills） */
  readonly id: string;
  /** 命令展示名称（如 /eag-design、/team autonomous） */
  readonly name: string;
  /** 命令用途说明（会注入 prompt） */
  readonly description: string;
  /** 可选：命令参数示例 */
  readonly args?: ReadonlyArray<string>;
}

/**
 * 支持的 EAG 命令种类
 *
 * 与 EAG_COMMAND_STRINGS 的命令一一对应，去掉前缀 "/eag-"。
 * 保留该类型用于内部 EAG 命令识别和向后兼容；建议层统一使用 DynamicCommandDescriptor。
 */
export type EagCommandKind =
  | "eag-build"
  | "eag-design"
  | "eag-test"
  | "eag-run"
  | "eag-resume"
  | "eag-status"
  | "eag-deploy"
  | "eag-autonomous"
  | "eag-autonomous-status"
  | "eag-autonomous-stop"
  | "eag-graph";

/**
 * 澄清选项
 */
export interface EagClarificationOption {
  /** 展示给用户的选项文本 */
  readonly label: string;
  /** 选项内部标识 */
  readonly value: string;
  /** 选项补充说明 */
  readonly description?: string;
}

/**
 * EAG 智能建议结果
 */
export type EagDynamicSuggestion =
  | { readonly type: "direct_chat"; readonly reasoning: string }
  | {
      readonly type: "suggest_command";
      /** 命令所属体系 */
      readonly commandCategory: DynamicCommandCategory;
      /** 命令唯一标识 */
      readonly commandId: string;
      /** 命令提示字符串（可直接展示给用户） */
      readonly commandHint: string;
      /** 展示给用户的建议文本 */
      readonly messageToUser: string;
      /** 推理说明 */
      readonly reasoning: string;
      /** 可选前置条件 */
      readonly prerequisites?: ReadonlyArray<string>;
    }
  | {
      readonly type: "suggest_autonomous";
      readonly commandHint: string;
      readonly messageToUser: string;
      readonly reasoning: string;
    }
  | {
      readonly type: "suggest_graph";
      readonly commandHint: string;
      readonly messageToUser: string;
      readonly reasoning: string;
      readonly prerequisites?: ReadonlyArray<string>;
    }
  | {
      readonly type: "ask_clarification";
      readonly messageToUser: string;
      readonly reasoning: string;
      readonly question: string;
      readonly options: ReadonlyArray<EagClarificationOption>;
      readonly multiSelect: boolean;
    };

/**
 * 建议层配置选项
 */
export interface EagDynamicSuggesterOptions {
  /** 决策 LLM 调用工厂（必须，与 session.ts createLLMClient 同源） */
  readonly createDecisionLLMClient: () => LLMClient | null;
  /** 是否启用智能建议层（默认 true） */
  readonly enabled?: boolean;
  /** 置信度阈值，低于此值强制降级为 direct_chat（默认 0.6） */
  readonly confidenceThreshold?: number;
  /** 决策 LLM 最大输出 token（默认 2048） */
  readonly maxDecisionTokens?: number;
}

/**
 * 建议上下文
 */
export interface EagDynamicContext {
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly goal: string;
  readonly recentMessages?: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: string }>;
  /** 全部可用命令描述符（EAG/Team/Rules/slash，由 session.ts / CLI 注入） */
  readonly availableCommands: ReadonlyArray<DynamicCommandDescriptor>;
  /** 上一轮澄清问题的用户选择（可选，用于 refine 建议） */
  readonly clarification?: ReadonlyArray<string>;
}

/**
 * LLM 原始决策输出（用于解析校验）
 */
interface RawSuggestionOutput {
  readonly reasoning?: string;
  readonly action?: string;
  /** suggest_command 时建议的命令所属体系 */
  readonly commandCategory?: string;
  /** suggest_command 时建议的命令唯一标识 */
  readonly commandId?: string;
  readonly commandHint?: string;
  readonly messageToUser?: string;
  readonly prerequisites?: ReadonlyArray<string>;
  readonly question?: string;
  readonly options?: ReadonlyArray<Partial<EagClarificationOption>>;
  readonly multiSelect?: boolean;
  readonly confidence?: number;
}

// ============================================================================
// 2. 常量
// ============================================================================

/** 默认置信度阈值 */
const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

/** 默认最大输出 token */
const DEFAULT_MAX_DECISION_TOKENS = 2048;

/** 有效的 action 取值集合 */
const VALID_ACTIONS = new Set([
  "direct_chat",
  "suggest_command",
  "suggest_autonomous",
  "suggest_graph",
  "ask_clarification",
]);

// ============================================================================
// 3. EagDynamicSuggester 类
// ============================================================================

/**
 * 全局动态编排建议层实现
 */
export class EagDynamicSuggester {
  private readonly options: Readonly<Required<EagDynamicSuggesterOptions>>;

  /**
   * 构造函数
   *
   * @param options 建议层配置
   */
  constructor(options: Readonly<EagDynamicSuggesterOptions>) {
    if (typeof options.createDecisionLLMClient !== "function") {
      throw new Error("EagDynamicSuggester: createDecisionLLMClient 必须为函数");
    }
    this.options = Object.freeze({
      createDecisionLLMClient: options.createDecisionLLMClient,
      enabled: options.enabled ?? true,
      confidenceThreshold: options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
      maxDecisionTokens: options.maxDecisionTokens ?? DEFAULT_MAX_DECISION_TOKENS,
    });
  }

  /**
   * 判断建议层是否启用
   *
   * @returns true 表示启用
   */
  isEnabled(): boolean {
    return this.options.enabled;
  }

  /**
   * 根据用户目标和上下文生成建议
   *
   * 算法：
   * 1. 校验上下文合法性。
   * 2. 构建决策 prompt。
   * 3. 调用决策 LLM 获取 JSON 输出。
   * 4. 解析并校验输出格式。
   * 5. 低于置信度阈值时降级为 direct_chat。
   * 6. 构造并返回冻结的 EagDynamicSuggestion。
   *
   * @param context 建议上下文
   * @returns 冻结的 EagDynamicSuggestion
   */
  async suggest(context: Readonly<EagDynamicContext>): Promise<Readonly<EagDynamicSuggestion>> {
    // 步骤 1：上下文校验
    if (!context.goal || typeof context.goal !== "string") {
      return Object.freeze({ type: "direct_chat", reasoning: "目标为空，降级为直接对话" });
    }
    if (!Array.isArray(context.availableCommands) || context.availableCommands.length === 0) {
      return Object.freeze({ type: "direct_chat", reasoning: "无可用命令，降级为直接对话" });
    }

    // 步骤 2：构建 prompt
    const messages = buildEagSuggestionPrompt({
      goal: context.goal,
      recentMessages: context.recentMessages,
      availableCommands: context.availableCommands,
      clarification: context.clarification,
    });

    // 步骤 3：调用 LLM
    const llmClient = this.options.createDecisionLLMClient();
    if (!llmClient) {
      return Object.freeze({ type: "direct_chat", reasoning: "LLMClient 不可用，降级为直接对话" });
    }

    try {
      const response = await llmClient.createMessage({
        // 提示词 messages 仅包含 role/content，而 LLMClient 要求 SessionMessage 形态。
        // 运行时 provider 只读取 role/content，因此通过类型断言兼容；避免反向依赖 session.ts。
        messages: messages as unknown as LLMRequest["messages"],
        maxTokens: this.options.maxDecisionTokens,
        temperature: 0.2,
      } as LLMRequest);

      const rawText = response.content.trim();
      return this.parseAndValidate(rawText, context.availableCommands);
    } catch (error) {
      // 失败安全：任何异常都降级为 direct_chat
      const reason = error instanceof Error ? error.message : String(error);
      return Object.freeze({ type: "direct_chat", reasoning: `LLM 调用失败：${reason}，降级为直接对话` });
    }
  }

  /**
   * 解析并校验 LLM 输出
   *
   * @param rawText LLM 原始文本输出
   * @param availableCommands 当前可用命令描述符清单
   * @returns 冻结的 EagDynamicSuggestion
   */
  private parseAndValidate(
    rawText: string,
    availableCommands: ReadonlyArray<DynamicCommandDescriptor>
  ): Readonly<EagDynamicSuggestion> {
    // 步骤 4：尝试提取 JSON（兼容 markdown 代码块包裹）
    const jsonText = this.extractJson(rawText);
    let raw: RawSuggestionOutput;
    try {
      raw = JSON.parse(jsonText) as RawSuggestionOutput;
    } catch {
      return Object.freeze({ type: "direct_chat", reasoning: "LLM 输出不是合法 JSON，降级为直接对话" });
    }

    if (!raw.action || !VALID_ACTIONS.has(raw.action)) {
      return Object.freeze({ type: "direct_chat", reasoning: "LLM 返回未知 action，降级为直接对话" });
    }

    // 步骤 5：置信度检查
    const confidence = typeof raw.confidence === "number" && !Number.isNaN(raw.confidence) ? raw.confidence : 0;
    if (confidence < this.options.confidenceThreshold) {
      return Object.freeze({
        type: "direct_chat",
        reasoning: `置信度 ${confidence} 低于阈值 ${this.options.confidenceThreshold}，降级为直接对话`,
      });
    }

    // 步骤 6：根据 action 构造建议
    switch (raw.action) {
      case "direct_chat":
        return Object.freeze({ type: "direct_chat", reasoning: raw.reasoning ?? "直接对话" });

      case "suggest_command": {
        const descriptor = this.parseCommandDescriptor(
          raw.commandCategory,
          raw.commandId,
          raw.commandHint,
          availableCommands
        );
        if (!descriptor) {
          return Object.freeze({
            type: "direct_chat",
            reasoning: "LLM 建议的命令不在可用清单中，降级为直接对话",
          });
        }
        return Object.freeze({
          type: "suggest_command",
          commandCategory: descriptor.category,
          commandId: descriptor.id,
          commandHint: raw.commandHint ?? descriptor.name,
          messageToUser: raw.messageToUser ?? `建议运行 ${descriptor.name}`,
          reasoning: raw.reasoning ?? "",
          prerequisites: Array.isArray(raw.prerequisites) ? Object.freeze([...raw.prerequisites]) : undefined,
        });
      }

      case "suggest_autonomous":
        return Object.freeze({
          type: "suggest_autonomous",
          commandHint: raw.commandHint ?? "/eag-autonomous",
          messageToUser:
            raw.messageToUser ??
            "这是一个多阶段任务，建议运行 /eag-autonomous 让系统自动完成 plan → dev → verify → fix 循环。",
          reasoning: raw.reasoning ?? "",
        });

      case "suggest_graph":
        return Object.freeze({
          type: "suggest_graph",
          commandHint: raw.commandHint ?? "/eag-graph",
          messageToUser: raw.messageToUser ?? "建议运行 /eag-graph 并使用已准备好的图定义文件。",
          reasoning: raw.reasoning ?? "",
          prerequisites: Array.isArray(raw.prerequisites) ? Object.freeze([...raw.prerequisites]) : undefined,
        });

      case "ask_clarification": {
        const options = this.parseClarificationOptions(raw.options);
        if (!raw.question || options.length < 2) {
          return Object.freeze({
            type: "direct_chat",
            reasoning: "LLM 返回的澄清选项不完整，降级为直接对话",
          });
        }
        return Object.freeze({
          type: "ask_clarification",
          messageToUser: raw.messageToUser ?? raw.question,
          reasoning: raw.reasoning ?? "需要用户澄清",
          question: raw.question,
          options: Object.freeze(options),
          multiSelect: raw.multiSelect === true,
        });
      }

      default:
        return Object.freeze({ type: "direct_chat", reasoning: "未识别的 action，降级为直接对话" });
    }
  }

  /**
   * 从文本中提取 JSON
   *
   * 兼容：
   * - 纯 JSON 文本
   * - ```json ... ``` 包裹的 JSON
   * - ``` ... ``` 包裹的 JSON
   *
   * @param text 原始文本
   * @returns 提取出的 JSON 字符串
   */
  private extractJson(text: string): string {
    const trimmed = text.trim();
    const codeBlockMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }
    return trimmed;
  }

  /**
   * 解析命令描述符
   *
   * 优先根据 LLM 返回的 commandCategory + commandId 精确匹配；
   * 若未提供，则根据 commandHint 前缀匹配命令 name（支持多 token 命令如 /team autonomous）。
   *
   * @param commandCategory 命令所属体系（可选）
   * @param commandId 命令唯一标识（可选）
   * @param commandHint 命令提示字符串（可选）
   * @param availableCommands 可用命令描述符清单
   * @returns 匹配的 DynamicCommandDescriptor，未匹配则返回 undefined
   */
  private parseCommandDescriptor(
    commandCategory: string | undefined,
    commandId: string | undefined,
    commandHint: string | undefined,
    availableCommands: ReadonlyArray<DynamicCommandDescriptor>
  ): DynamicCommandDescriptor | undefined {
    // 优先精确匹配 category + id
    if (typeof commandCategory === "string" && typeof commandId === "string") {
      const found = availableCommands.find((cmd) => cmd.category === commandCategory && cmd.id === commandId);
      if (found) {
        return found;
      }
    }

    // 降级：按 commandHint 前缀匹配 name（支持 /team autonomous --goal ... 等多 token 命令）
    if (commandHint && typeof commandHint === "string") {
      const normalized = commandHint.trim().toLowerCase();
      // 先匹配最长的 name，避免 /team autonomous 被 /team 截断
      const sorted = [...availableCommands].sort((a, b) => b.name.length - a.name.length);
      return sorted.find((cmd) => normalized.startsWith(cmd.name.toLowerCase()));
    }

    return undefined;
  }

  /**
   * 解析澄清选项
   *
   * 过滤掉缺少 label 或 value 的无效选项。
   *
   * @param options 原始选项数组
   * @returns 冻结的有效选项数组
   */
  private parseClarificationOptions(
    options: ReadonlyArray<Partial<EagClarificationOption>> | undefined
  ): ReadonlyArray<EagClarificationOption> {
    if (!Array.isArray(options)) {
      return Object.freeze([]);
    }
    const valid = options
      .filter((opt): opt is EagClarificationOption => {
        return (
          typeof opt.label === "string" && opt.label.length > 0 && typeof opt.value === "string" && opt.value.length > 0
        );
      })
      .map((opt) => Object.freeze({ label: opt.label, value: opt.value, description: opt.description }));
    return Object.freeze(valid);
  }
}

// ============================================================================
// 4. 工厂函数
// ============================================================================

/**
 * 创建 EagDynamicSuggester 实例
 *
 * @param options 建议层配置
 * @returns 冻结的 EagDynamicSuggester 实例
 */
export function createEagDynamicSuggester(options: Readonly<EagDynamicSuggesterOptions>): EagDynamicSuggester {
  return new EagDynamicSuggester(options);
}
