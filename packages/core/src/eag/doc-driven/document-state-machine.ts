/**
 * 文档状态机实现（EAG-P1 批次 5）
 *
 * 本模块实现 `DocumentStateMachine` 类，提供 EAG 方案 §5.10.1 文档即门禁的真实状态机逻辑。
 *
 * 核心职责：
 * - 状态转换（draft → reviewing → approved/rejected）
 * - 转换合法性判定（canTransition）
 * - 文档已批准判定（isApproved，作为门禁条件）
 * - 工作流校验（spec 未批准时 CODING Loop 不得启动，SEED-10 落地）
 *
 * 状态机定义（draft 为初始态，approved/rejected 为终态）：
 *
 *   ┌───────┐         ┌────────────┐         ┌──────────┐
 *   │ draft │ ──────▶ │ reviewing  │ ──────▶ │ approved │ (终态)
 *   └───────┘         └─────┬──────┘         └──────────┘
 *                           │
 *                           ▼
 *                     ┌──────────┐
 *                     │ rejected │ (可回到 reviewing)
 *                     └──────────┘
 *
 * 设计依据：
 * - EAG 方案 §5.10.1 文档即门禁（文档状态机作为 Loop 流转条件）
 * - SEED-10 规则（需求文档先行——spec 未批准时 CODING Loop 不得启动）
 *
 * 不可变优先：
 * - 状态转换不修改原对象，返回新的冻结对象
 * - 状态转换表使用 Object.freeze 冻结
 *
 * @module eag/doc-driven/document-state-machine
 */

import type { DocumentState, DocumentType, EagDocument, WorkflowValidationResult } from "./types";
import { DOCUMENT_PATHS } from "./types";

// ============================================================================
// 状态转换表（表驱动设计）
// ============================================================================

/**
 * 状态转换表（表驱动设计，定义合法的状态转换关系）
 *
 * 键为起始状态，值为该状态可转换到的目标状态列表。
 * 未在表中列出的转换视为非法（canTransition 返回 false）。
 *
 * 转换规则（对齐 §5.10.1 文档状态机）：
 * - draft → reviewing（提交评审）
 * - reviewing → approved（评审通过）
 * - reviewing → rejected（评审驳回）
 * - rejected → reviewing（修改后重新提交）
 * - approved 为终态，不允许再转换
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
const STATE_TRANSITIONS: Readonly<Record<DocumentState, ReadonlyArray<DocumentState>>> = Object.freeze({
  draft: Object.freeze(["reviewing"] as const),
  reviewing: Object.freeze(["approved", "rejected"] as const),
  approved: Object.freeze([] as const),
  rejected: Object.freeze(["reviewing"] as const),
});

/**
 * CODING Loop 启动门禁所需的已批准文档类型列表
 *
 * 对应 EAG 方案 §5.10.1 文档即门禁——以下文档必须为 approved 状态才能启动 CODING Loop：
 * - constitution：项目宪法（DESIGN Loop 首轮产出，CODING Loop 前置条件）
 * - spec：功能需求规格（DESIGN Loop 产出，SEED-10"需求文档先行"的流程落地）
 *
 * plan 与 tasks 在 CODING Loop 首轮产出，启动 CODING Loop 时不要求已批准。
 *
 * 使用 Object.freeze 冻结。
 */
const CODING_LOOP_REQUIRED_APPROVALS: ReadonlyArray<DocumentType> = Object.freeze(["constitution", "spec"]);

// ============================================================================
// 异常类型
// ============================================================================

/**
 * 文档状态机错误（非法状态转换时抛出）
 *
 * 当 transition 被调用且转换非法时抛出，包含起始状态、目标状态与原因。
 */
export class DocumentStateMachineError extends Error {
  /**
   * @param fromState 起始状态
   * @param toState 目标状态
   * @param reason 非法原因
   */
  constructor(
    public readonly fromState: DocumentState,
    public readonly toState: DocumentState,
    public readonly reason: string
  ) {
    super(`文档状态转换非法：${fromState} → ${toState}，${reason}`);
    this.name = "DocumentStateMachineError";
  }
}

// ============================================================================
// DocumentStateMachine 类
// ============================================================================

/**
 * 文档状态机（实现 §5.10.1 文档即门禁逻辑）
 *
 * 提供真实状态机逻辑（禁止 mock）：
 * - transition：执行状态转换，返回新的冻结 EagDocument
 * - canTransition：判定状态转换合法性
 * - isApproved：判定文档是否已批准（门禁条件）
 * - validateWorkflow：校验文档工作流（SEED-10 落地）
 *
 * 使用方式：
 * ```typescript
 * const sm = new DocumentStateMachine();
 * const draft = createDocument("spec", "# spec");
 * const reviewing = sm.transition(draft, "reviewing");
 * const approved = sm.transition(reviewing, "approved");
 * const result = sm.validateWorkflow([constitution, spec]);
 * if (!result.canStartCoding) {
 *   throw new Error(result.reason);
 * }
 * ```
 */
export class DocumentStateMachine {
  /**
   * 判定状态转换合法性
   *
   * 基于 STATE_TRANSITIONS 表查询起始状态可转换到的目标状态列表，
   * 若目标状态在列表中则合法，否则非法。
   *
   * @param from 起始状态
   * @param to 目标状态
   * @returns true=合法，false=非法
   */
  canTransition(from: DocumentState, to: DocumentState): boolean {
    // 查表：起始状态可转换到的目标状态列表
    const allowedTargets = STATE_TRANSITIONS[from];
    return allowedTargets.includes(to);
  }

  /**
   * 执行状态转换，返回新的冻结 EagDocument
   *
   * 不修改原对象（不可变优先），返回新的 EagDocument：
   * - state 字段更新为目标状态
   * - version 字段递增（每次状态转换 +1，作为版本审计依据）
   * - updatedAt 字段更新为当前时间（ISO 8601 字符串）
   * - 其他字段保持不变（type/path/content/createdAt）
   *
   * 非法转换抛出 DocumentStateMachineError。
   *
   * @param doc 原始文档（不会被修改）
   * @param toState 目标状态
   * @returns 新的冻结 EagDocument（state/version/updatedAt 已更新）
   * @throws {DocumentStateMachineError} 状态转换非法时抛出
   */
  transition(doc: EagDocument, toState: DocumentState): EagDocument {
    // 校验转换合法性
    if (!this.canTransition(doc.state, toState)) {
      throw new DocumentStateMachineError(
        doc.state,
        toState,
        `状态 ${doc.state} 不允许转换到 ${toState}（合法目标：[${STATE_TRANSITIONS[doc.state].join(", ")}]）`
      );
    }

    // 构建新文档对象（不可变优先：不修改原对象）
    const newDoc: EagDocument = {
      type: doc.type,
      path: doc.path,
      state: toState,
      content: doc.content,
      version: doc.version + 1,
      createdAt: doc.createdAt,
      updatedAt: new Date().toISOString(),
    };

    // 冻结并返回（防止运行期被 LLM 自改）
    return Object.freeze(newDoc);
  }

  /**
   * 判定文档是否已批准（门禁条件）
   *
   * 用于 Loop 调度器判定是否可以流转到下游 Loop：
   * - approved 状态返回 true
   * - 其他状态（draft/reviewing/rejected）返回 false
   *
   * @param doc 待判定的文档
   * @returns true=已批准，false=未批准
   */
  isApproved(doc: EagDocument): boolean {
    return doc.state === "approved";
  }

  /**
   * 校验文档工作流（SEED-10 落地——文档即门禁）
   *
   * 对应 EAG 方案 §5.10.1 文档即门禁：
   * CODING Loop 启动前必须校验 constitution 与 spec 已批准。
   * spec 未批准时 CODING Loop 不得启动（SEED-10"需求文档先行"的流程落地）。
   *
   * 判定逻辑：
   * 1. 从入参 docs 中按 type 索引查找 constitution 与 spec
   * 2. 若文档缺失或状态不为 approved，加入 missingApprovals 列表
   * 3. canStartCoding = (missingApprovals 为空)
   * 4. 生成人类可读的判定理由
   *
   * @param docs 当前所有文档列表
   * @returns 工作流校验结果（canStartCoding/missingApprovals/reason）
   */
  validateWorkflow(docs: ReadonlyArray<EagDocument>): WorkflowValidationResult {
    // 按 type 索引文档，便于 O(1) 查找
    const docByType = new Map<DocumentType, EagDocument>();
    for (const doc of docs) {
      docByType.set(doc.type, doc);
    }

    // 检查 CODING Loop 启动所需的门禁文档是否已批准
    const missingApprovals: DocumentType[] = [];
    for (const requiredType of CODING_LOOP_REQUIRED_APPROVALS) {
      const doc = docByType.get(requiredType);
      if (!doc) {
        // 文档缺失
        missingApprovals.push(requiredType);
      } else if (!this.isApproved(doc)) {
        // 文档存在但未批准
        missingApprovals.push(requiredType);
      }
    }

    // 构建判定结果
    const canStartCoding = missingApprovals.length === 0;
    const reason = canStartCoding
      ? "文档工作流校验通过：constitution 与 spec 均已批准，CODING Loop 可启动。"
      : `文档工作流校验失败：[${missingApprovals.join(", ")}] 未批准，` +
        `CODING Loop 不得启动（SEED-10 需求文档先行——spec 未批准时禁止启动 CODING Loop）。`;

    return Object.freeze({
      canStartCoding,
      missingApprovals: Object.freeze(missingApprovals),
      reason,
    });
  }
}

// ============================================================================
// 工厂函数：创建初始文档
// ============================================================================

/**
 * 创建初始文档（draft 状态，version=1）
 *
 * 工厂函数模式：调用方提供文档类型与内容，工厂函数完成 path 解析、
 * 初始状态设置、版本号初始化、时间戳生成，并 Object.freeze 冻结。
 *
 * 路径解析：优先使用入参 documentPaths（测试时可注入），缺省时使用
 * 顶层 import 的 DOCUMENT_PATHS 常量（types.ts 不依赖本模块，无循环依赖）。
 *
 * @param type 文档类型
 * @param content 文档内容（Markdown 字符串）
 * @param documentPaths 文档路径映射（可选，默认使用 DOCUMENT_PATHS 常量）
 * @returns 冻结的初始 EagDocument（state=draft, version=1）
 */
export function createInitialDocument(
  type: DocumentType,
  content: string,
  documentPaths: Readonly<Record<DocumentType, string>> = DOCUMENT_PATHS
): EagDocument {
  const now = new Date().toISOString();
  return Object.freeze({
    type,
    path: documentPaths[type],
    state: "draft",
    content,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}
