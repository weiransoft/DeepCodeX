/**
 * EDM 信号检测器实现
 *
 * 本模块实现 `EdmSignalDetector` 类，提供 EAG 方案 §5.7.2 信号检测机制的真实逻辑
 * （禁止 mock/simulated/placeholder）。
 *
 * 检测职责：
 * - 扫描 DESIGN Loop 的 Discovery 阶段收集的需求文本（自然语言）
 * - 按行匹配各 EDM 域的 signalKeywords
 * - 命中关键词的域加入 detectedDomains
 * - evidence 记录命中的关键词与原文片段（信号词周围的文本）
 * - suggestedDomains 默认等于 detectedDomains（架构师可在人工检查点裁剪）
 *
 * 设计依据：
 * - EAG 方案 §5.7.2 EDM 纳入机制
 * - §5.7.1 各域 signalKeywords 列表
 *
 * 实现要点：
 * - 按行扫描需求文本（避免跨行匹配导致证据片段过长）
 * - 证据片段提取：截取信号词前后各 20 字符的上下文（行内截取，不跨行）
 * - 大小写敏感匹配（中文信号词不涉及大小写；英文信号词如 "SoD" 大小写敏感）
 * - 多域命中支持：同一段需求文本可同时命中多个域（如"用户权限"同时命中用户域与功能权限域）
 *
 * @module eag/edm/edm-detector
 */

import type { EdmDomainDefinition, EdmDomainId, EdmDetectionResult } from "./types";
import { USER_DOMAIN } from "./edm-domains/user-domain";
import { ORG_DOMAIN } from "./edm-domains/org-domain";
import { ROLE_DOMAIN } from "./edm-domains/role-domain";
import { PERMISSION_DOMAIN } from "./edm-domains/permission-domain";
import { DATA_SCOPE_DOMAIN } from "./edm-domains/data-scope-domain";

// ============================================================================
// 全部 EDM 域定义（默认检测范围）
// ============================================================================

/**
 * 全部 5 个 EDM 域定义（默认检测范围）
 *
 * 使用 Object.freeze 冻结，作为 EdmSignalDetector 的默认 domains 参数。
 * 顺序与 EDM_DOMAIN_IDS 一致：user → org → role → permission → data-scope。
 */
export const EDM_ALL_DOMAINS: ReadonlyArray<EdmDomainDefinition> = Object.freeze([
  USER_DOMAIN,
  ORG_DOMAIN,
  ROLE_DOMAIN,
  PERMISSION_DOMAIN,
  DATA_SCOPE_DOMAIN,
]);

// ============================================================================
// 证据片段提取常量
// ============================================================================

/**
 * 证据片段上下文半径（信号词前后各截取的字符数）
 *
 * 设为 20 字符：足够展示信号词所在语境，又不会过长导致证据片段难以阅读。
 * 如信号词"登录"在"用户登录系统后可查看订单列表"中，证据片段为
 * "用户登录系统后可查看订单"（前后各 20 字符）。
 */
const EVIDENCE_CONTEXT_RADIUS = 20;

// ============================================================================
// EdmSignalDetector 类实现
// ============================================================================

/**
 * EDM 信号检测器
 *
 * 扫描需求文本，检测命中的 EDM 域，产出 EdmDetectionResult。
 *
 * 使用方式：
 * ```ts
 * const detector = new EdmSignalDetector();
 * const result = detector.detect("用户登录后可查看部门下的订单");
 * // result.detectedDomains: ["user", "org"]
 * // result.evidence.user: ["用户登录后可查看部门下的订单"]
 * // result.evidence.org: ["用户登录后可查看部门下的订单"]
 * ```
 *
 * 设计原则：
 * - 构造期注入 domains 列表，支持测试时替换为子集（如仅检测用户域）
 * - detect() 是纯函数（无副作用，相同输入产出相同输出）
 * - 证据片段提取为私有方法，外部不可直接调用
 */
export class EdmSignalDetector {
  /**
   * 构造函数
   *
   * @param domains 检测范围（默认 EDM_ALL_DOMAINS，即全部 5 个域）
   */
  constructor(private readonly domains: ReadonlyArray<EdmDomainDefinition> = EDM_ALL_DOMAINS) {
    // 存储为不可变引用，detect() 时遍历此列表
    // 注意：domains 字段已在构造参数中声明为 private readonly，TypeScript 保证类内不可重新赋值
  }

  /**
   * 扫描需求文本，返回检测到的 EDM 域
   *
   * 算法：
   * 1. 按行分割需求文本（\n 分割，兼容 \r\n）
   * 2. 遍历每个域的 signalKeywords
   * 3. 对每个关键词，遍历每行文本检查是否包含该关键词
   * 4. 命中则记录域 ID 与证据片段
   * 5. 去重后产出 detectedDomains 与 evidence
   * 6. suggestedDomains 默认等于 detectedDomains
   *
   * @param rawRequirement 原始需求文本（自然语言，可多行）
   * @returns 检测结果（含检测到的域、证据、建议纳入的域）
   */
  detect(rawRequirement: string): EdmDetectionResult {
    // 1. 按行分割需求文本
    // 兼容 \r\n 与 \n：先用 \r\n 分割再合并，再用 \n 分割
    // trimEnd() 去除行尾空白，避免证据片段末尾多余的空格
    const lines: string[] = rawRequirement
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // 2. 初始化检测结果累积器
    // detectedSet: 命中的域 ID 集合（去重）
    // evidenceMap: 域 ID → 证据片段列表
    const detectedSet = new Set<EdmDomainId>();
    const evidenceMap = new Map<EdmDomainId, string[]>();

    // 3. 遍历每个域的信号词，匹配需求文本
    for (const domain of this.domains) {
      const domainId = domain.id;
      const keywords = domain.signalKeywords;

      for (const keyword of keywords) {
        // 对每个关键词，遍历每行文本检查是否包含
        for (const line of lines) {
          // 使用 String.prototype.includes 做子串匹配
          // 大小写敏感：中文信号词不涉及大小写；英文信号词如 "SoD" 必须大小写敏感
          if (line.includes(keyword)) {
            // 命中：记录域 ID 与证据片段
            detectedSet.add(domainId);

            // 提取证据片段（信号词周围的文本）
            const evidence = this.extractEvidence(line, keyword);

            // 累积到 evidenceMap（同一域同一关键词多次命中需记录多次）
            if (!evidenceMap.has(domainId)) {
              evidenceMap.set(domainId, []);
            }
            const evidenceList = evidenceMap.get(domainId)!;
            // 避免重复记录完全相同的证据片段（同一行同一关键词只记录一次）
            if (!evidenceList.includes(evidence)) {
              evidenceList.push(evidence);
            }
          }
        }
      }
    }

    // 4. 构建最终检测结果
    // detectedDomains: 按 EDM_DOMAIN_IDS 顺序排序，确保输出稳定
    // suggestedDomains: 默认等于 detectedDomains（架构师可裁剪）
    const detectedDomains: EdmDomainId[] = Array.from(detectedSet).sort((a, b) => {
      // 按 EDM_DOMAIN_IDS 顺序排序，确保输出稳定可测
      const orderMap: Record<EdmDomainId, number> = {
        user: 0,
        org: 1,
        role: 2,
        permission: 3,
        "data-scope": 4,
      };
      return orderMap[a] - orderMap[b];
    });

    // 构建证据记录：对所有 5 个域初始化空数组，避免访问 undefined
    const evidence: Record<EdmDomainId, ReadonlyArray<string>> = {
      user: evidenceMap.get("user") ?? [],
      org: evidenceMap.get("org") ?? [],
      role: evidenceMap.get("role") ?? [],
      permission: evidenceMap.get("permission") ?? [],
      "data-scope": evidenceMap.get("data-scope") ?? [],
    };

    // 5. 返回检测结果（suggestedDomains 默认等于 detectedDomains）
    return {
      detectedDomains: Object.freeze([...detectedDomains]),
      evidence: Object.freeze(evidence),
      suggestedDomains: Object.freeze([...detectedDomains]),
    };
  }

  /**
   * 提取证据片段（信号词周围的文本片段）
   *
   * 算法：
   * - 在给定行内查找信号词的所有出现位置（同一行可能多次出现）
   * - 对每次出现，截取信号词前后各 EVIDENCE_CONTEXT_RADIUS 字符的上下文
   * - 截取时注意边界（行首/行尾不越界）
   * - 多次出现则拼接为多个证据片段，用 " | " 分隔
   *
   * @param line 单行需求文本（已 trim）
   * @param keyword 信号词
   * @returns 证据片段（如 "用户登录系统后可查看订单"）
   */
  private extractEvidence(line: string, keyword: string): string {
    // 查找信号词在行内的所有出现位置
    const indices: number[] = [];
    let searchFrom = 0;
    while (searchFrom <= line.length - keyword.length) {
      const idx = line.indexOf(keyword, searchFrom);
      if (idx === -1) break;
      indices.push(idx);
      searchFrom = idx + keyword.length;
    }

    // 无匹配（理论上不应发生，调用方已确认 includes 命中）
    if (indices.length === 0) {
      return line;
    }

    // 对每个出现位置截取上下文片段
    const snippets: string[] = [];
    for (const idx of indices) {
      // 计算截取范围（边界保护）
      const start = Math.max(0, idx - EVIDENCE_CONTEXT_RADIUS);
      const end = Math.min(line.length, idx + keyword.length + EVIDENCE_CONTEXT_RADIUS);

      // 截取片段，并添加省略号标识（如行首/行尾被截断则加 "..."）
      const prefix = start > 0 ? "..." : "";
      const suffix = end < line.length ? "..." : "";
      const snippet = prefix + line.slice(start, end) + suffix;
      snippets.push(snippet);
    }

    // 多次出现则拼接，用 " | " 分隔
    return snippets.join(" | ");
  }
}
