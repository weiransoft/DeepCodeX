/**
 * EAG-P6 Phase 3 五段式 prompt 组装器（FiveStagePromptAssembler）
 *
 * 本模块将任务上下文 + 角色定制 + CodeMap 动态窗口 + 历史经验 + 输出要求
 * 组装为五段式 prompt，按 Token 预算分配（10% / 15% / 50% / 15% / 10%）截断
 * 各段内容，最终输出完整 prompt 字符串供 LLM 调用使用。
 *
 * 设计依据：
 * - EAG-P6-REQUIREMENTS.md §2 US-1（AC-1.1~AC-1.5：五段式 prompt + Token 预算分配）
 * - EAG-P6-ARCHITECTURE.md §5.2 接口契约 1（FiveStagePromptAssembler）
 *   + §4 模块清单（五段式结构 + Token 预算分配）
 * - EAG-P6-TASKS.md §3 TASK-P6-3-01（FiveStagePromptAssembler）
 * - EAG-P6-TEST-CASES.md TC-PROMPT-001~030（30 测试用例）
 *
 * 五段式结构（用户任务描述定义，与架构文档的 KARPATHY_PREAMBLE/ROLE_IDENTITY/... 不同）：
 *   段 1：SystemConstraint       （10%）— 系统约束：Karpathy 4 原则 + Ponytail 16 红线
 *   段 2：TaskContext            （15%）— 任务上下文：标题 + 描述 + 焦点符号
 *   段 3：CodeMapSnippet         （50%）— 代码地图片段：来自 DynamicWindowResult
 *   段 4：HistoricalExperience   （15%）— 历史经验：来自 phaseKnowledgeSlice.historicalExperience
 *   段 5：OutputRequirement      （10%）— 输出要求：来自 phaseKnowledgeSlice.outputFormat
 *
 * Token 预算分配（D-2 决策）：
 *   - SystemConstraint       : 10%（Karpathy 4 原则 + Ponytail 16 红线，约 400 tokens）
 *   - TaskContext            : 15%（任务标题 + 描述 + 焦点符号，约 600 tokens）
 *   - CodeMapSnippet         : 50%（CodeMap 片段，约 2000 tokens，对齐 Token 经济学）
 *   - HistoricalExperience   : 15%（角色历史经验，约 600 tokens）
 *   - OutputRequirement      : 10%（输出格式约束，约 400 tokens）
 *
 * 默认总 Token 预算：4000（与 multi-agent-team skill Token 经济学一致：
 * "单角色 prompt ≤ 4000 tokens"）
 *
 * 截断策略（按段独立截断，保证段内不溢出）：
 *   - 字符数 ≈ token 数 * 4（CHARS_PER_TOKEN = 4，与 Phase 2 一致）
 *   - 段内字符数超出预算时，截断并追加 "...[truncated]" 标记
 *   - 段内字符数不足预算时，不补齐（保留实际内容）
 *
 * 不可变优先原则（对齐 NFR-8）：
 * - 所有公开接口 readonly + ReadonlyArray + Object.freeze
 * - 输出 FiveStagePromptResult 已 Object.freeze
 *
 * @module v2/prompt/five-stage-prompt-assembler
 */

// 导入类型与常量
import type { CodeMapSnippet, DynamicWindowResult } from "../context/dynamic-window-types.js";
import { CHARS_PER_TOKEN } from "../context/dynamic-window-types.js";
import type { TaskContext } from "./role-signal-detector.js";
import type { RolePromptCustomization } from "./role-prompt-customizer.js";

// ============================================================================
// 1. 常量定义
// ============================================================================

/**
 * 默认总 Token 预算（与 multi-agent-team skill Token 经济学一致）
 *
 * 来源：multi-agent-team skill AC-2.5 "单角色 prompt ≤ 4000 tokens"
 *
 * 使用 Object.freeze 冻结。
 */
export const DEFAULT_TOTAL_TOKEN_BUDGET: number = Object.freeze(4000) as number;

/**
 * 五段式 Token 预算分配比例（D-2 决策）
 *
 * - SYSTEM_CONSTRAINT_RATIO     : 0.10（段 1 系统约束 10%）
 * - TASK_CONTEXT_RATIO          : 0.15（段 2 任务上下文 15%）
 * - CODEMAP_SNIPPET_RATIO       : 0.50（段 3 代码地图片段 50%）
 * - HISTORICAL_EXPERIENCE_RATIO : 0.15（段 4 历史经验 15%）
 * - OUTPUT_REQUIREMENT_RATIO    : 0.10（段 5 输出要求 10%）
 *
 * 五者之和 = 1.0，保证总预算分配不溢出。
 *
 * 使用 Object.freeze 冻结。
 */
export const FIVE_STAGE_RATIOS = Object.freeze({
  /** 段 1 系统约束（10%） */
  SYSTEM_CONSTRAINT: 0.1,
  /** 段 2 任务上下文（15%） */
  TASK_CONTEXT: 0.15,
  /** 段 3 代码地图片段（50%） */
  CODEMAP_SNIPPET: 0.5,
  /** 段 4 历史经验（15%） */
  HISTORICAL_EXPERIENCE: 0.15,
  /** 段 5 输出要求（10%） */
  OUTPUT_REQUIREMENT: 0.1,
} as const);

/**
 * 截断标记（段内字符数超出预算时追加）
 */
const TRUNCATED_MARKER = "...[truncated]";

// ============================================================================
// 2. 类型定义
// ============================================================================

/**
 * 五段式 prompt 组装输入（FiveStagePromptInput）
 *
 * 字段说明：
 * - taskContext        ：任务上下文（来自 RoleSignalDetector 的输入）
 * - roleCustomization  ：角色 prompt 定制结果（来自 RolePromptCustomizer）
 * - dynamicWindow      ：动态窗口结果（来自 DynamicWindowManager，可选）
 * - totalTokenBudget   ：总 Token 预算（可选，默认 4000）
 *
 * 不可变优先：所有字段 readonly。
 */
export interface FiveStagePromptInput {
  /** 任务上下文（标题 + 描述 + 焦点符号等） */
  readonly taskContext: TaskContext;
  /** 角色 prompt 定制结果（主角色 + 协作角色 + phaseKnowledgeSlice） */
  readonly roleCustomization: RolePromptCustomization;
  /** 动态窗口结果（CodeMap 片段，可选，无则段 3 为空） */
  readonly dynamicWindow?: DynamicWindowResult;
  /** 总 Token 预算（可选，默认 4000） */
  readonly totalTokenBudget?: number;
}

/**
 * Token 预算分配明细（TokenBudgetBreakdown）
 *
 * 描述五段的 Token 预算与实际使用情况。
 *
 * 字段说明：
 * - total                ：总 Token 预算
 * - systemConstraint     ：段 1 预算（10%）+ 实际使用
 * - taskContext          ：段 2 预算（15%）+ 实际使用
 * - codeMapSnippet       ：段 3 预算（50%）+ 实际使用
 * - historicalExperience : 段 4 预算（15%）+ 实际使用
 * - outputRequirement    ：段 5 预算（10%）+ 实际使用
 *
 * 不可变优先：所有字段 readonly，构建后 Object.freeze。
 */
export interface TokenBudgetBreakdown {
  /** 总 Token 预算 */
  readonly total: number;
  /** 段 1 系统约束预算（10%） */
  readonly systemConstraintBudget: number;
  /** 段 1 实际使用 Token 数 */
  readonly systemConstraintUsed: number;
  /** 段 2 任务上下文预算（15%） */
  readonly taskContextBudget: number;
  /** 段 2 实际使用 Token 数 */
  readonly taskContextUsed: number;
  /** 段 3 代码地图片段预算（50%） */
  readonly codeMapSnippetBudget: number;
  /** 段 3 实际使用 Token 数 */
  readonly codeMapSnippetUsed: number;
  /** 段 4 历史经验预算（15%） */
  readonly historicalExperienceBudget: number;
  /** 段 4 实际使用 Token 数 */
  readonly historicalExperienceUsed: number;
  /** 段 5 输出要求预算（10%） */
  readonly outputRequirementBudget: number;
  /** 段 5 实际使用 Token 数 */
  readonly outputRequirementUsed: number;
}

/**
 * 五段式 prompt 组装结果（FiveStagePromptResult）
 *
 * 字段说明：
 * - systemConstraint       ：段 1 系统约束文本
 * - taskContextText        ：段 2 任务上下文文本
 * - codeMapSnippetText     ：段 3 代码地图片段文本
 * - historicalExperienceText：段 4 历史经验文本
 * - outputRequirement      ：段 5 输出要求文本
 * - fullPrompt             ：五段拼接的完整 prompt
 * - tokenBudget            ：Token 预算分配明细
 *
 * 不可变优先：所有字段 readonly，构建后 Object.freeze。
 */
export interface FiveStagePromptResult {
  /** 段 1 系统约束（Karpathy 4 原则 + Ponytail 16 红线） */
  readonly systemConstraint: string;
  /** 段 2 任务上下文（标题 + 描述 + 焦点符号） */
  readonly taskContextText: string;
  /** 段 3 代码地图片段（来自 DynamicWindowResult） */
  readonly codeMapSnippetText: string;
  /** 段 4 历史经验（来自 phaseKnowledgeSlice.historicalExperience） */
  readonly historicalExperienceText: string;
  /** 段 5 输出要求（来自 phaseKnowledgeSlice.outputFormat） */
  readonly outputRequirement: string;
  /** 五段拼接的完整 prompt */
  readonly fullPrompt: string;
  /** Token 预算分配明细 */
  readonly tokenBudget: TokenBudgetBreakdown;
}

// ============================================================================
// 3. 工具函数
// ============================================================================

/**
 * 按 Token 预算截断文本
 *
 * 算法：
 * - 估算 token 数：chars / CHARS_PER_TOKEN
 * - 若 token 数 ≤ budget，返回原文
 * - 若 token 数 > budget，截断到 budget * CHARS_PER_TOKEN 字符，并追加 TRUNCATED_MARKER
 *
 * @param text 原始文本
 * @param tokenBudget Token 预算
 * @returns { text, usedTokens } 截断后的文本与实际使用 Token 数
 */
function truncateByTokenBudget(
  text: string,
  tokenBudget: number
): { readonly text: string; readonly usedTokens: number } {
  const maxChars = Math.floor(tokenBudget * CHARS_PER_TOKEN);
  if (text.length <= maxChars) {
    return {
      text,
      usedTokens: Math.ceil(text.length / CHARS_PER_TOKEN),
    };
  }
  // 截断并追加标记
  const truncatedText = text.slice(0, Math.max(0, maxChars - TRUNCATED_MARKER.length)) + TRUNCATED_MARKER;
  return {
    text: truncatedText,
    usedTokens: Math.ceil(truncatedText.length / CHARS_PER_TOKEN),
  };
}

/**
 * 估算文本的 Token 数
 *
 * 算法：Math.ceil(chars / CHARS_PER_TOKEN)
 *
 * @param text 文本
 * @returns Token 数估算值
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ============================================================================
// 4. 五段构建函数
// ============================================================================

/**
 * 构建段 1：系统约束（SystemConstraint）
 *
 * 内容：Karpathy 4 原则 + Ponytail 16 红线（来自 roleCustomization.karpathyPreamble）
 *
 * @param roleCustomization 角色 prompt 定制结果
 * @param tokenBudget 段 1 Token 预算
 * @returns { text, usedTokens } 段 1 文本与实际使用 Token 数
 */
function buildSystemConstraint(
  roleCustomization: RolePromptCustomization,
  tokenBudget: number
): { readonly text: string; readonly usedTokens: number } {
  return truncateByTokenBudget(roleCustomization.karpathyPreamble, tokenBudget);
}

/**
 * 构建段 2：任务上下文（TaskContext）
 *
 * 内容：
 * - 任务标题
 * - 任务描述
 * - 焦点符号（如有）
 * - 影响根符号（如有）
 * - 主角色 + 协作角色身份说明（来自 roleCustomization.roleIdentityPrompt）
 *
 * @param taskContext 任务上下文
 * @param roleCustomization 角色 prompt 定制结果
 * @param tokenBudget 段 2 Token 预算
 * @returns { text, usedTokens } 段 2 文本与实际使用 Token 数
 */
function buildTaskContext(
  taskContext: TaskContext,
  roleCustomization: RolePromptCustomization,
  tokenBudget: number
): { readonly text: string; readonly usedTokens: number } {
  const lines: string[] = [];
  lines.push("# 任务上下文");
  lines.push("");
  lines.push(`## 任务标题\n${taskContext.title}`);
  lines.push("");
  lines.push(`## 任务描述\n${taskContext.description}`);

  // 焦点符号（如有）
  if (taskContext.focusPoints !== undefined && taskContext.focusPoints.length > 0) {
    lines.push("");
    lines.push(`## 焦点符号\n${taskContext.focusPoints.map((f) => `- ${f}`).join("\n")}`);
  }

  // 影响根符号（如有）
  if (taskContext.impactRoots !== undefined && taskContext.impactRoots.length > 0) {
    lines.push("");
    lines.push(`## 影响根符号\n${taskContext.impactRoots.map((r) => `- ${r}`).join("\n")}`);
  }

  // 角色身份说明（来自 roleCustomization）
  lines.push("");
  lines.push(roleCustomization.roleIdentityPrompt);

  const fullText = lines.join("\n");
  return truncateByTokenBudget(fullText, tokenBudget);
}

/**
 * 格式化单个 CodeMapSnippet 为可读字符串
 *
 * 格式：
 * ```
 * 【type】name (kind) @ filePath:startLine-endLine
 *   签名：signature
 *   摘要：summary
 *   重要性：importance | BFS 距离：distance | 置信度：confidence
 * ```
 *
 * @param snippet CodeMapSnippet
 * @returns 格式化后的字符串
 */
function formatCodeMapSnippet(snippet: CodeMapSnippet): string {
  const lines: string[] = [];
  lines.push(
    `【${snippet.type}】${snippet.name} (${snippet.kind}) @ ${snippet.filePath}:${snippet.startLine}-${snippet.endLine}`
  );
  if (snippet.signature !== undefined && snippet.signature.length > 0) {
    lines.push(`  签名：${snippet.signature}`);
  }
  if (snippet.summary !== undefined && snippet.summary.length > 0) {
    lines.push(`  摘要：${snippet.summary}`);
  }
  lines.push(
    `  重要性：${snippet.importance.toFixed(3)} | BFS 距离：${snippet.distance} | 置信度：${snippet.confidence}`
  );
  return lines.join("\n");
}

/**
 * 构建段 3：代码地图片段（CodeMapSnippet）
 *
 * 内容：
 * - 来自 dynamicWindow.snippets 的 CodeMap 片段列表
 * - 每个片段格式化为可读字符串
 * - 若 dynamicWindow 为空或 snippets 为空，段 3 为占位提示
 *
 * @param dynamicWindow 动态窗口结果（可选）
 * @param tokenBudget 段 3 Token 预算
 * @returns { text, usedTokens } 段 3 文本与实际使用 Token 数
 */
function buildCodeMapSnippet(
  dynamicWindow: DynamicWindowResult | undefined,
  tokenBudget: number
): { readonly text: string; readonly usedTokens: number } {
  // ---------- 边界处理：dynamicWindow 为空或 snippets 为空 ----------
  if (dynamicWindow === undefined || dynamicWindow.snippets === undefined || dynamicWindow.snippets.length === 0) {
    const emptyText = "# 代码地图片段\n\n（无可用 CodeMap 片段，可能因图谱未启用或焦点符号为空）";
    return {
      text: emptyText,
      usedTokens: estimateTokens(emptyText),
    };
  }

  // ---------- 构建段 3 文本 ----------
  const lines: string[] = [];
  lines.push("# 代码地图片段");
  lines.push("");
  lines.push(
    `来源：${dynamicWindow.source} | 片段数：${dynamicWindow.snippets.length} | 累计 Token：${dynamicWindow.totalTokens} | 丢弃低相关：${dynamicWindow.droppedLowRelevance}`
  );
  lines.push("");

  // ---------- 逐片段格式化，按 Token 预算截断 ----------
  const maxChars = Math.floor(tokenBudget * CHARS_PER_TOKEN);
  let currentChars = 0;
  let usedTokens = 0;
  let truncated = false;

  for (let i = 0; i < dynamicWindow.snippets.length; i++) {
    const snippet = dynamicWindow.snippets[i];
    if (snippet === undefined) continue;
    const snippetText = formatCodeMapSnippet(snippet);
    const snippetChars = snippetText.length + 1; // +1 for newline

    // 检查是否超出预算
    if (currentChars + snippetChars > maxChars - TRUNCATED_MARKER.length) {
      truncated = true;
      break;
    }

    lines.push(`## 片段 ${i + 1}`);
    lines.push(snippetText);
    lines.push("");
    currentChars += snippetChars;
    usedTokens += Math.ceil(snippetChars / CHARS_PER_TOKEN);
  }

  if (truncated) {
    lines.push(TRUNCATED_MARKER);
    usedTokens = Math.ceil((currentChars + TRUNCATED_MARKER.length) / CHARS_PER_TOKEN);
  }

  const fullText = lines.join("\n");
  return {
    text: fullText,
    usedTokens: Math.min(usedTokens, tokenBudget),
  };
}

/**
 * 构建段 4：历史经验（HistoricalExperience）
 *
 * 内容：
 * - 主角色 phaseKnowledgeSlice.historicalExperience
 * - 协作角色 phaseKnowledgeSlice.historicalExperience（如有）
 * - 角色身份补充说明（来自 roleCustomization.phaseKnowledgePrompt 的关键检查项与常见陷阱）
 *
 * @param roleCustomization 角色 prompt 定制结果
 * @param tokenBudget 段 4 Token 预算
 * @returns { text, usedTokens } 段 4 文本与实际使用 Token 数
 */
function buildHistoricalExperience(
  roleCustomization: RolePromptCustomization,
  tokenBudget: number
): { readonly text: string; readonly usedTokens: number } {
  const lines: string[] = [];
  lines.push("# 历史经验");

  // 主角色历史经验
  lines.push("");
  lines.push(`## 主角色（${roleCustomization.primaryRole}）历史经验`);
  lines.push(roleCustomization.primarySlice.historicalExperience);

  // 主角色常见陷阱（来自 phaseKnowledgeSlice.commonPitfalls）
  lines.push("");
  lines.push("### 常见陷阱");
  for (const pitfall of roleCustomization.primarySlice.commonPitfalls) {
    lines.push(`- ${pitfall}`);
  }

  // 协作角色历史经验（如有）
  if (roleCustomization.collaboratorSlices.length > 0) {
    lines.push("");
    lines.push("## 协作角色历史经验");
    for (let i = 0; i < roleCustomization.collaboratorSlices.length; i++) {
      const slice = roleCustomization.collaboratorSlices[i];
      if (slice === undefined) continue;
      lines.push("");
      lines.push(`### 协作角色 ${i + 1}（${slice.role}）历史经验`);
      lines.push(slice.historicalExperience);
      lines.push("");
      lines.push("常见陷阱：");
      for (const pitfall of slice.commonPitfalls) {
        lines.push(`- ${pitfall}`);
      }
    }
  }

  const fullText = lines.join("\n");
  return truncateByTokenBudget(fullText, tokenBudget);
}

/**
 * 构建段 5：输出要求（OutputRequirement）
 *
 * 内容：
 * - 主角色 phaseKnowledgeSlice.outputFormat
 * - 协作角色 phaseKnowledgeSlice.outputFormat（如有）
 * - 主角色关键检查项（来自 phaseKnowledgeSlice.keyChecks，作为验收标准）
 *
 * @param roleCustomization 角色 prompt 定制结果
 * @param tokenBudget 段 5 Token 预算
 * @returns { text, usedTokens } 段 5 文本与实际使用 Token 数
 */
function buildOutputRequirement(
  roleCustomization: RolePromptCustomization,
  tokenBudget: number
): { readonly text: string; readonly usedTokens: number } {
  const lines: string[] = [];
  lines.push("# 输出要求");

  // 主角色输出格式
  lines.push("");
  lines.push(`## 主角色（${roleCustomization.primaryRole}）输出格式`);
  lines.push(roleCustomization.primarySlice.outputFormat);

  // 主角色关键检查项（作为验收标准）
  lines.push("");
  lines.push("## 验收标准（关键检查项）");
  for (const check of roleCustomization.primarySlice.keyChecks) {
    lines.push(`- ${check}`);
  }

  // 协作角色输出格式（如有）
  if (roleCustomization.collaboratorSlices.length > 0) {
    lines.push("");
    lines.push("## 协作角色输出格式");
    for (let i = 0; i < roleCustomization.collaboratorSlices.length; i++) {
      const slice = roleCustomization.collaboratorSlices[i];
      if (slice === undefined) continue;
      lines.push("");
      lines.push(`### 协作角色 ${i + 1}（${slice.role}）输出格式`);
      lines.push(slice.outputFormat);
    }
  }

  const fullText = lines.join("\n");
  return truncateByTokenBudget(fullText, tokenBudget);
}

// ============================================================================
// 5. 主类 FiveStagePromptAssembler
// ============================================================================

/**
 * 五段式 prompt 组装器
 *
 * 主入口：assemble(input) → FiveStagePromptResult
 *
 * 工作流程：
 * 1. 计算五段 Token 预算（按 10% / 15% / 50% / 15% / 10% 分配）
 * 2. 构建段 1：SystemConstraint（Karpathy 4 原则 + Ponytail 16 红线）
 * 3. 构建段 2：TaskContext（任务标题 + 描述 + 焦点符号 + 角色身份）
 * 4. 构建段 3：CodeMapSnippet（来自 DynamicWindowResult）
 * 5. 构建段 4：HistoricalExperience（来自 phaseKnowledgeSlice）
 * 6. 构建段 5：OutputRequirement（来自 phaseKnowledgeSlice.outputFormat）
 * 7. 拼接五段为完整 prompt
 * 8. 返回 FiveStagePromptResult（已冻结）
 *
 * 不可变优先：
 * - 输出 FiveStagePromptResult 已 Object.freeze
 */
export class FiveStagePromptAssembler {
  /**
   * 组装五段式 prompt
   *
   * @param input 五段式 prompt 组装输入
   * @returns FiveStagePromptResult（已冻结）
   */
  assemble(input: FiveStagePromptInput): FiveStagePromptResult {
    // ---------- 1. 计算总 Token 预算 ----------
    const totalBudget =
      input.totalTokenBudget !== undefined && input.totalTokenBudget > 0
        ? input.totalTokenBudget
        : DEFAULT_TOTAL_TOKEN_BUDGET;

    // ---------- 2. 计算五段 Token 预算 ----------
    const systemConstraintBudget = Math.floor(totalBudget * FIVE_STAGE_RATIOS.SYSTEM_CONSTRAINT);
    const taskContextBudget = Math.floor(totalBudget * FIVE_STAGE_RATIOS.TASK_CONTEXT);
    const codeMapSnippetBudget = Math.floor(totalBudget * FIVE_STAGE_RATIOS.CODEMAP_SNIPPET);
    const historicalExperienceBudget = Math.floor(totalBudget * FIVE_STAGE_RATIOS.HISTORICAL_EXPERIENCE);
    const outputRequirementBudget = Math.floor(totalBudget * FIVE_STAGE_RATIOS.OUTPUT_REQUIREMENT);

    // ---------- 3. 构建五段 ----------
    const stage1 = buildSystemConstraint(input.roleCustomization, systemConstraintBudget);
    const stage2 = buildTaskContext(input.taskContext, input.roleCustomization, taskContextBudget);
    const stage3 = buildCodeMapSnippet(input.dynamicWindow, codeMapSnippetBudget);
    const stage4 = buildHistoricalExperience(input.roleCustomization, historicalExperienceBudget);
    const stage5 = buildOutputRequirement(input.roleCustomization, outputRequirementBudget);

    // ---------- 4. 拼接完整 prompt ----------
    const fullPrompt = [
      "=== 段 1：系统约束（SystemConstraint）===",
      stage1.text,
      "",
      "=== 段 2：任务上下文（TaskContext）===",
      stage2.text,
      "",
      "=== 段 3：代码地图片段（CodeMapSnippet）===",
      stage3.text,
      "",
      "=== 段 4：历史经验（HistoricalExperience）===",
      stage4.text,
      "",
      "=== 段 5：输出要求（OutputRequirement）===",
      stage5.text,
    ].join("\n");

    // ---------- 5. 构建 Token 预算明细 ----------
    const tokenBudget: TokenBudgetBreakdown = Object.freeze({
      total: totalBudget,
      systemConstraintBudget,
      systemConstraintUsed: stage1.usedTokens,
      taskContextBudget,
      taskContextUsed: stage2.usedTokens,
      codeMapSnippetBudget,
      codeMapSnippetUsed: stage3.usedTokens,
      historicalExperienceBudget,
      historicalExperienceUsed: stage4.usedTokens,
      outputRequirementBudget,
      outputRequirementUsed: stage5.usedTokens,
    });

    // ---------- 6. 返回 FiveStagePromptResult（已冻结） ----------
    return Object.freeze({
      systemConstraint: stage1.text,
      taskContextText: stage2.text,
      codeMapSnippetText: stage3.text,
      historicalExperienceText: stage4.text,
      outputRequirement: stage5.text,
      fullPrompt,
      tokenBudget,
    });
  }
}

// ============================================================================
// 6. 顶层便捷函数
// ============================================================================

/**
 * 顶层便捷函数：组装五段式 prompt
 *
 * 创建 FiveStagePromptAssembler 实例并执行 assemble()。
 *
 * @param input 五段式 prompt 组装输入
 * @returns FiveStagePromptResult（已冻结）
 */
export function assembleFiveStagePrompt(input: FiveStagePromptInput): FiveStagePromptResult {
  const assembler = new FiveStagePromptAssembler();
  return assembler.assemble(input);
}
