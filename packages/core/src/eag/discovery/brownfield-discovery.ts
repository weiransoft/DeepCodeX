/**
 * 棕地 Discovery 流程（Brownfield Discovery）—— EAG 方案 §6.2
 *
 * 本模块实现 EAG 方案 §6.2 棕地场景的 Discovery 增强流程。
 * 推断现有代码库的领域模型，作为 DESIGN Loop 的既有模型基线，
 * 将新需求映射到「新增/修改/不动」三类变更，产出增量设计结果。
 *
 * 执行流（§6.2）：
 * 1. **Discovery 增强**：推断现有代码库的领域模型 → 作为 DESIGN Loop 的既有模型基线
 * 2. **变更分类**：将新需求映射到变更分类（add/modify/unchanged）
 * 3. **增量设计结果**：产出 IncrementalDesignResult（含三类变更 + 既有模型快照）
 * 4. **后续**：交由 DESIGN Loop 在既有模型上做增量设计 → HUMAN_CHECKPOINT
 *
 * 设计依据：
 * - EAG 方案 §6.2 棕地场景执行流
 * - EAG 方案 §6.2 增量设计的三类变更标注
 *
 * @module eag/discovery/brownfield-discovery
 */

import type { ChangeType, ExistingModelSnapshot, IncrementalChange, IncrementalDesignResult } from "./types.js";
import { ChangeClassifier } from "./change-classifier.js";

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 新需求关键词与变更项名称的映射规则表（表驱动设计）
 *
 * 用于从新需求文本中提取变更项名称。
 * 按数组顺序匹配，命中关键词即在变更项名称中加入对应项。
 *
 * 每条规则包含：
 * - keywords：关键词列表（任一命中即提取对应变更项）
 * - name：变更项名称（如 "RefundAggregate"）
 *
 * 实际生产中应使用 LLM 推理提取变更项，本实现保持确定性的关键词匹配。
 * 使用 Object.freeze 冻结。
 */
const REQUIREMENT_KEYWORD_MAPPING: ReadonlyArray<{
  readonly keywords: ReadonlyArray<string>;
  readonly name: string;
}> = Object.freeze([
  // 退款聚合
  {
    keywords: ["退款", "refund", "Refund"],
    name: "RefundAggregate",
  },
  // 订单取消（中文语序可变：取消订单 / 订单取消）
  {
    keywords: ["取消订单", "订单取消", "cancel order", "order cancel"],
    name: "OrderCancelService",
  },
  // 订单聚合（既有，新需求可能涉及修改）
  {
    keywords: ["订单", "order", "Order"],
    name: "OrderAggregate",
  },
  // 支付聚合（既有，新需求可能涉及修改）
  {
    keywords: ["支付", "payment", "Payment"],
    name: "PaymentAggregate",
  },
  // 订单创建事件
  {
    keywords: ["订单创建", "order created", "OrderCreated"],
    name: "OrderCreatedEvent",
  },
  // 支付成功事件
  {
    keywords: ["支付成功", "payment succeeded", "PaymentSucceeded"],
    name: "PaymentSucceededEvent",
  },
  // 退款发起事件
  {
    keywords: ["退款发起", "refund initiated", "RefundInitiated"],
    name: "RefundInitiatedEvent",
  },
  // 退款完成事件
  {
    keywords: ["退款完成", "refund completed", "RefundCompleted"],
    name: "RefundCompletedEvent",
  },
]);

// ============================================================================
// BrownfieldDiscovery 类
// ============================================================================

/**
 * 棕地 Discovery 流程
 *
 * 推断现有代码库的领域模型，将新需求映射到「新增/修改/不动」三类变更。
 *
 * 用法：
 * ```typescript
 * const discovery = new BrownfieldDiscovery();
 *
 * // 既有模型快照（由代码扫描器产出，本类不负责扫描）
 * const snapshot: ExistingModelSnapshot = {
 *   aggregates: ["OrderAggregate", "PaymentAggregate"],
 *   entities: ["OrderItem", "PaymentRecord"],
 *   valueObjects: ["Money", "OrderId"],
 *   domainEvents: ["OrderCreatedEvent", "PaymentSucceededEvent"],
 *   boundedContexts: ["order", "payment"],
 *   existingFiles: ["src/order/OrderAggregate.ts", ...],
 * };
 *
 * // 执行 Discovery
 * const result = discovery.discover(snapshot, "在现有订单服务里增加订单取消与退款能力");
 *
 * // result.addedChanges：[RefundAggregate, OrderCancelService, RefundInitiatedEvent, RefundCompletedEvent]
 * // result.modifiedChanges：[OrderAggregate, PaymentAggregate, OrderCreatedEvent, PaymentSucceededEvent]
 * // result.unchangedChanges：[OrderItem, PaymentRecord, Money, OrderId, order, payment, ...]
 * ```
 *
 * 注意：本类不负责扫描代码库推断领域模型（由 CodeMapGenerator 或 DomainModeler 完成）。
 * 本类仅负责：基于既有模型快照 + 新需求文本，产出增量设计结果。
 */
export class BrownfieldDiscovery {
  /** 变更分类器（用于将新需求映射到 add/modify/unchanged） */
  private readonly classifier: ChangeClassifier;

  /**
   * 构造 BrownfieldDiscovery
   *
   * @param classifier 可选的变更分类器（默认创建新实例，便于测试注入自定义分类器）
   */
  constructor(classifier?: ChangeClassifier) {
    this.classifier = classifier ?? new ChangeClassifier();
  }

  // ========================================================================
  // 公共 API
  // ========================================================================

  /**
   * 扫描既有模型 + 新需求，产出增量设计结果
   *
   * 执行流程：
   * 1. 从新需求文本提取变更项名称（基于关键词映射）
   * 2. 调用 ChangeClassifier.classifyAll 分类变更项
   * 3. 为每个变更项生成 IncrementalChange（含变更理由）
   * 4. 组装为 IncrementalDesignResult 返回
   *
   * @param existingModelSnapshot 既有模型快照
   * @param newRequirement 新需求文本（自然语言）
   * @returns 增量设计结果
   */
  discover(existingModelSnapshot: ExistingModelSnapshot, newRequirement: string): IncrementalDesignResult {
    // 1. 从新需求文本提取变更项名称
    const newNames = this.extractChangeItemNames(newRequirement);

    // 2. 调用 ChangeClassifier.classifyAll 分类变更项
    const classifications = this.classifier.classifyAll(existingModelSnapshot, newNames);

    // 3. 为每个变更项生成 IncrementalChange（含变更理由）
    const addedChanges: IncrementalChange[] = [];
    const modifiedChanges: IncrementalChange[] = [];
    const unchangedChanges: IncrementalChange[] = [];

    for (const { name, changeType } of classifications) {
      const change = this.buildIncrementalChange(name, changeType, existingModelSnapshot);
      if (changeType === "add") {
        addedChanges.push(change);
      } else if (changeType === "modify") {
        modifiedChanges.push(change);
      } else {
        unchangedChanges.push(change);
      }
    }

    // 4. 组装为 IncrementalDesignResult 返回
    return Object.freeze({
      addedChanges: Object.freeze(addedChanges),
      modifiedChanges: Object.freeze(modifiedChanges),
      unchangedChanges: Object.freeze(unchangedChanges),
      existingModelSnapshot,
    });
  }

  /**
   * 将新需求映射到变更分类（add/modify/unchanged）
   *
   * 本方法是 discover() 的子步骤，单独暴露便于测试与复用。
   *
   * @param snapshot 既有模型快照
   * @param newRequirement 新需求文本
   * @returns 分类结果（按 add → modify → unchanged 顺序）
   */
  classifyChanges(
    snapshot: ExistingModelSnapshot,
    newRequirement: string
  ): ReadonlyArray<{ readonly name: string; readonly changeType: ChangeType }> {
    const newNames = this.extractChangeItemNames(newRequirement);
    return this.classifier.classifyAll(snapshot, newNames);
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /**
   * 从新需求文本提取变更项名称
   *
   * 基于 REQUIREMENT_KEYWORD_MAPPING 表驱动匹配。
   * 命中关键词即在结果中加入对应变更项名称。
   *
   * 实际生产中应使用 LLM 推理提取，本实现保持确定性的关键词匹配。
   *
   * @param newRequirement 新需求文本
   * @returns 变更项名称列表（去重）
   */
  private extractChangeItemNames(newRequirement: string): string[] {
    const names = new Set<string>();
    const lowerReq = newRequirement.toLowerCase();
    for (const { keywords, name } of REQUIREMENT_KEYWORD_MAPPING) {
      for (const keyword of keywords) {
        if (lowerReq.includes(keyword.toLowerCase())) {
          names.add(name);
          break; // 命中一个关键词即可，避免重复添加
        }
      }
    }
    return Array.from(names);
  }

  /**
   * 构建单个变更项的 IncrementalChange
   *
   * 根据变更类型生成不同的变更理由：
   * - add：「新需求要求新增 {name}（既有代码库中不存在）」
   * - modify：「新需求要求修改 {name}（既有代码库中存在）」
   * - unchanged：「{name} 在既有代码库中存在，新需求未涉及，保留不动」
   *
   * @param name 变更项名称
   * @param changeType 变更类型
   * @param snapshot 既有模型快照（用于查找文件路径）
   * @returns IncrementalChange 对象
   */
  private buildIncrementalChange(
    name: string,
    changeType: ChangeType,
    snapshot: ExistingModelSnapshot
  ): IncrementalChange {
    // 查找既有项对应的文件路径（modify/unchanged 时）
    const filePath = this.findFilePathByName(name, snapshot);

    let reason: string;
    if (changeType === "add") {
      reason = `新需求要求新增 ${name}（既有代码库中不存在）`;
    } else if (changeType === "modify") {
      reason = `新需求要求修改 ${name}（既有代码库中存在）`;
    } else {
      reason = `${name} 在既有代码库中存在，新需求未涉及，保留不动`;
    }

    return Object.freeze({
      name,
      changeType,
      filePath,
      reason,
    });
  }

  /**
   * 按名称查找既有项对应的文件路径
   *
   * 在 existingFiles 中查找包含 name 的文件路径（不区分大小写）。
   * 用于 modify/unchanged 变更项的 filePath 字段。
   *
   * @param name 变更项名称
   * @param snapshot 既有模型快照
   * @returns 文件路径；未找到时返回 undefined
   */
  private findFilePathByName(name: string, snapshot: ExistingModelSnapshot): string | undefined {
    const lowerName = name.toLowerCase();
    for (const filePath of snapshot.existingFiles) {
      // 文件名包含变更项名称（不区分大小写）
      // 如 "OrderAggregate" 匹配 "src/order/OrderAggregate.ts"
      const fileName = filePath.split("/").pop() ?? filePath;
      if (fileName.toLowerCase().includes(lowerName)) {
        return filePath;
      }
    }
    return undefined;
  }
}

// ============================================================================
// 模块导出
// ============================================================================

export { REQUIREMENT_KEYWORD_MAPPING };
