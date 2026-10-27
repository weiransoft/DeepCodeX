/**
 * SedimentationSuggester —— Skill/Agent 沉淀建议器（T02，架构 §3）
 *
 * 职责：按触发时机（宿主按 sedimentation.everyNTurns 节流 + flushSedimentation 兜底，
 * 架构 §8 待明确 #1 的决策）分析最近对话轮次，产出沉淀草稿建议（含指纹）。
 *
 * 行为约定：
 * - 失败安全：LLM 不可用/调用失败/输出非法 → 空数组 + 结构化日志，绝不抛出；
 * - 会话内去重：per-session 维护「已建议 + 已拒绝」指纹集合，重复模式不再建议（P0 验收③）；
 * - 草稿校验：kind/name(kebab)/description/content 白名单校验，agent 必须有 role；
 * - 隐私：日志只记指纹与名称，禁止打印对话原文与 PII（架构 §7 共享知识 #3）。
 *
 * @module eag/dynamic/sedimentation-suggester
 */

import * as crypto from "node:crypto";
import type { LLMClient, LLMRequest } from "../../providers/llm-provider";
import type { SessionMessage } from "../../session";
import type { SedimentLogFn } from "../../common/sediment-logger";
import type { SedimentationDraft } from "../../agents/sedimentation-writer";
import {
  buildSedimentationPrompt,
  SEDIMENTATION_MAX_TURNS,
  type RawSedimentationOutput,
  type SedimentationPromptMessage,
} from "./prompts/sedimentation-prompt";

/** 单轮内容截断上限（与 prompt 模板保持一致，避免重复大对象） */
const MAX_TURN_CHARS = 4000;

/** 沉淀建议 LLM 最大输出 token */
const DEFAULT_MAX_SUGGESTION_TOKENS = 4096;

/** 沉淀建议（架构 §3 签名级约定） */
export type SedimentationSuggestion = {
  /** 建议实例 id */
  id: string;
  /** sha256(name+description+content) —— 会话内去重键 */
  fingerprint: string;
  /** 沉淀草稿（白名单字段） */
  draft: SedimentationDraft;
  /** 给用户看的建议理由（中文） */
  rationale: string;
};

/** SedimentationSuggester 依赖上下文（架构 §3 构造签名） */
export interface SedimentationSuggesterDeps {
  /** LLM 客户端工厂（复用既有 createLLMClient；null = 静默降级） */
  createLLMClient: () => Promise<LLMClient | null>;
  /** 可选：结构化日志函数（缺省 console.warn 兜底） */
  log?: SedimentLogFn;
  /** 可选：LLM 最大输出 token（默认 4096） */
  maxSuggestionTokens?: number;
}

/**
 * 计算草稿指纹（sha256(name+description+content)，十六进制）。
 *
 * 导出目的：宿主（CLI/Web）confirm/dismiss 回执需要同一指纹口径。
 *
 * @param draft 沉淀草稿
 */
export function computeSedimentationFingerprint(draft: SedimentationDraft): string {
  return crypto
    .createHash("sha256")
    .update(`${draft.name}::${draft.description}::${draft.content}`, "utf8")
    .digest("hex");
}

/**
 * SedimentationSuggester —— 沉淀建议器
 */
export class SedimentationSuggester {
  private readonly deps: SedimentationSuggesterDeps;
  private readonly log: SedimentLogFn;
  /** per-session 已建议/已拒绝指纹集合（会话内去重） */
  private readonly fingerprintsBySession = new Map<string, Set<string>>();

  constructor(deps: SedimentationSuggesterDeps) {
    if (typeof deps.createLLMClient !== "function") {
      throw new Error("SedimentationSuggester: createLLMClient 必须为函数");
    }
    this.deps = deps;
    this.log =
      deps.log ??
      ((event) => {
        const message = typeof event.message === "string" ? event.message : JSON.stringify(event);
        console.warn(`[sedimentation-suggester] ${message}`);
      });
  }

  /**
   * 分析最近对话轮次产出建议（0~n 条）。
   *
   * 失败安全：任何异常 → 空数组 + 日志。内部维护 per-session 已建议/已拒绝
   * 指纹集合，重复模式不再建议（P0 验收③）。
   *
   * @param sessionId 会话 ID
   * @param transcript 会话消息（仅取 user/assistant 文本轮次）
   */
  async analyze(sessionId: string, transcript: SessionMessage[]): Promise<SedimentationSuggestion[]> {
    try {
      if (!sessionId || !Array.isArray(transcript) || transcript.length === 0) {
        return [];
      }
      const turns = this.toTurns(transcript);
      if (turns.length === 0) {
        return [];
      }

      const llmClient = await this.deps.createLLMClient();
      if (!llmClient) {
        // 静默降级：LLM 不可用时不产生建议
        this.log({ event: "sediment-analyze-skip", sessionId, message: "LLM 客户端不可用，跳过沉淀分析" });
        return [];
      }

      const promptMessages = buildSedimentationPrompt({ turns });
      const response = await llmClient.createMessage({
        // prompt 消息仅含 role/content，provider 运行时只读取这两个字段（与 EagDynamicSuggester 同款兼容处理）
        messages: promptMessages as unknown as LLMRequest["messages"],
        maxTokens: this.deps.maxSuggestionTokens ?? DEFAULT_MAX_SUGGESTION_TOKENS,
        temperature: 0.2,
      } as LLMRequest);

      const raw = typeof response.content === "string" ? response.content.trim() : "";
      const candidates = this.extractSuggestions(raw);
      const seen = this.getSessionFingerprints(sessionId);
      const suggestions: SedimentationSuggestion[] = [];
      for (const candidate of candidates) {
        const draft = this.normalizeDraft(candidate);
        if (!draft) {
          this.log({
            event: "sediment-suggestion-invalid",
            sessionId,
            name: typeof candidate?.name === "string" ? candidate.name : "",
            message: "沉淀建议草稿非法（缺 description / name 非 kebab-case / agent 缺 role），已丢弃",
          });
          continue;
        }
        const fingerprint = computeSedimentationFingerprint(draft);
        // 会话内去重：已建议/已拒绝的指纹不再重复建议
        if (seen.has(fingerprint)) {
          continue;
        }
        seen.add(fingerprint);
        suggestions.push({
          id: crypto.randomUUID(),
          fingerprint,
          draft,
          rationale:
            typeof candidate.rationale === "string" && candidate.rationale.trim()
              ? candidate.rationale.trim()
              : "该模式在对话中反复出现，建议沉淀为可复用资产",
        });
      }
      this.log({
        event: "sediment-analyze-ok",
        sessionId,
        count: suggestions.length,
        message: `沉淀分析完成：产出 ${suggestions.length} 条建议`,
      });
      return suggestions;
    } catch (error) {
      // 失败安全：任何异常降级为空数组
      const message = error instanceof Error ? error.message : String(error);
      this.log({
        event: "sediment-analyze-degrade",
        sessionId,
        message: `沉淀分析失败（已降级为空建议）：${message}`,
      });
      return [];
    }
  }

  /**
   * 用户处置回执（拒绝后记录指纹，本会话不再建议同一条目）。
   *
   * @param sessionId 会话 ID
   * @param fingerprint 草稿指纹
   */
  dismiss(sessionId: string, fingerprint: string): void {
    if (!sessionId || !fingerprint) {
      return;
    }
    this.getSessionFingerprints(sessionId).add(fingerprint);
    this.log({
      event: "sediment-dismiss",
      sessionId,
      fingerprint,
      message: "沉淀建议已被用户忽略，本会话不再建议同一条目",
    });
  }

  /**
   * 提取会话指纹集合（懒创建）。
   */
  private getSessionFingerprints(sessionId: string): Set<string> {
    let fingerprints = this.fingerprintsBySession.get(sessionId);
    if (!fingerprints) {
      fingerprints = new Set<string>();
      this.fingerprintsBySession.set(sessionId, fingerprints);
    }
    return fingerprints;
  }

  /**
   * 从会话消息提取分析轮次（仅 user/assistant 文本，截断 + 限量）。
   */
  private toTurns(transcript: SessionMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
    const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const message of transcript) {
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      if (typeof message.content !== "string" || !message.content.trim()) {
        continue;
      }
      turns.push({
        role: message.role,
        content: message.content.slice(0, MAX_TURN_CHARS),
      });
      if (turns.length >= SEDIMENTATION_MAX_TURNS) {
        break;
      }
    }
    return turns;
  }

  /**
   * 从 LLM 输出提取建议数组（兼容 markdown 代码块包裹；输出非法返回空数组）。
   */
  private extractSuggestions(raw: string): Array<{
    kind?: string;
    name?: string;
    description?: string;
    role?: string;
    content?: string;
    rationale?: string;
  }> {
    if (!raw) {
      return [];
    }
    // 兼容 ```json ... ``` / ``` ... ``` 包裹
    const codeBlockMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(raw.trim());
    const jsonText = codeBlockMatch ? codeBlockMatch[1].trim() : raw.trim();
    let parsed: RawSedimentationOutput;
    try {
      parsed = JSON.parse(jsonText) as RawSedimentationOutput;
    } catch {
      this.log({ event: "sediment-suggestion-parse-fail", message: "沉淀分析 LLM 输出不是合法 JSON" });
      return [];
    }
    if (!parsed || !Array.isArray(parsed.suggestions)) {
      return [];
    }
    return parsed.suggestions.filter((candidate) => candidate && typeof candidate === "object");
  }

  /**
   * 草稿规范化校验（白名单字段 + kebab-case + agent 必须有 role）。
   *
   * 非法返回 undefined（由调用方丢弃并记日志）。
   */
  private normalizeDraft(candidate: {
    kind?: string;
    name?: string;
    description?: string;
    role?: string;
    content?: string;
  }): SedimentationDraft | undefined {
    const kind = candidate.kind === "agent" ? "agent" : candidate.kind === "skill" ? "skill" : undefined;
    if (!kind) {
      return undefined;
    }
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const description = typeof candidate.description === "string" ? candidate.description.trim() : "";
    const content = typeof candidate.content === "string" && candidate.content.trim() ? candidate.content : "";
    if (!name || !description || !content) {
      return undefined;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      return undefined;
    }
    if (kind === "agent") {
      const role = typeof candidate.role === "string" ? candidate.role.trim() : "";
      if (!role) {
        return undefined;
      }
      return { kind, name, description, role, content };
    }
    return { kind, name, description, content };
  }
}

// 类型再导出：prompt 消息形态供宿主/测试复用
export type { SedimentationPromptMessage };
