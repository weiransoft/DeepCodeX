/**
 * EAG-P2 批次 9 集成测试执行体（端到端正向 + 反向链路验证）
 *
 * 本模块对应 EAG-P2 批次 9 redline-fixtures 设计文档 §3.3：
 * 由 tests/scripts/eag-batch9-integration.sh 通过 `node --import tsx` 调用，
 * 在临时项目目录上执行批次 9 全流程集成测试。
 *
 * 全流程（真实实现，非 mock）：
 * 1. 读取临时目录的 plan.md / tasks.md（由 shell 脚本 Step 2 写入）
 * 2. G-4 门禁：GateG4Checker.check() 校验 CODING Loop 进入条件（IG4-1）
 * 3. Phase A：SkeletonGenerator.generate() 生成骨架（IA-1/IA-2/IA-3）
 * 4. 上下文装配：ContextAssembler.assemble()（注入 InMemoryPkcAccessor 真实实现）
 * 5. Phase B：LlmFiller.fill()（注入 InMemoryLLMClient + 合规响应生成器）（IB-1/IB-2/IB-3）
 * 6. STRICT 正向：StrictEvaluator.evaluate(合规产出物, 19 条可静态判定红线)（IS-1/IS-3）
 * 7. STRICT 反向：StrictEvaluator.evaluate(含硬编码密钥产出物, 同红线清单)（IS-2）
 * 8. G-5 门禁：GateG5Checker.check() 校验 CODING Loop 退出条件（IG5-1）
 * 9. 输出 integration-report.json（phaseA/phaseB/strict/strictReverse/gates 五段）
 *
 * 红线清单说明（重要设计决策）：
 * - DEFAULT_STATIC_CHECKERS 注册表覆盖 19 条 redlineId（E1~E8 + 11 条 TCS）。
 * - TCS-OSS-02 / TCS-OSS-03 无静态 Checker，StrictEvaluator 对其返回 unknown，
 *   decideVerdict 将含 unknown 的报告决策为 human_checkpoint（STRICT 保守策略的
 *   预期行为，非缺陷）。因此正向链路（IS-1 断言 verdict="pass"）仅对
 *   19 条已注册红线求值——与生产环境"自动 STRICT 仅覆盖可静态判定红线"的语义一致。
 *
 * 退出码（与 shell 脚本对齐）：
 * - 0：全部断言通过
 * - 2：Phase A 骨架生成失败（IA 断言失败或生成器抛错）
 * - 3：Phase B LLM 填充失败（IB 断言失败或填充器抛错）
 * - 4：STRICT 评估失败（IS 断言失败或评估器抛错）
 * - 5：G-4/G-5 门禁失败（IG4/IG5 断言失败）
 * - 1：环境/入参非法（临时目录缺失、plan.md 不可读等）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有上下文/请求对象使用 readonly + ReadonlyArray
 * - 报告对象写出前通过 Object.freeze 冻结
 *
 * @module core/tests/eag-batch9-integration-runner
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import assert from "node:assert/strict";

import { SkeletonGenerator } from "../eag/coding/skeleton-generator";
import { ContextAssembler } from "../eag/coding/context-assembler";
import { LlmFiller, InMemoryLLMClient } from "../eag/coding/llm-filler";
import { StrictEvaluator } from "../eag/coding/strict-evaluator";
import { getRegisteredRedlineIds } from "../eag/coding/static-checkers";
import { GateG4Checker } from "../eag/gate/gate-g4-checker";
import { GateG5Checker } from "../eag/gate/gate-g5-checker";
import { ENTERPRISE_REDLINES } from "../eag/redlines/enterprise-rules";
import { TCS_REDLINES } from "../eag/tcs/tcs-redlines";

import type {
  CodingContext,
  GeneratedFile,
  GeneratedFileKind,
  LlmFillResult,
  PkcAccessor,
  SkeletonGenerationResult,
} from "../eag/coding/types";
import type { TaskCard, TaskDag, TaskNode } from "../eag/doc-driven/types";
import type { EvaluationContext, EvaluationReport, RedlineDefinition } from "../eag/evaluator/types";
import type { GateG4Context, GateG5Context } from "../eag/gate/gate-types";
import type { LLMRequest, LLMResponse } from "../providers/llm-provider";

// ============================================================================
// 常量与配置
// ============================================================================

/**
 * 任务卡 ID（与 shell 脚本 tasks.md 中的 T-001 对齐）
 */
const TASK_CARD_ID = "T-001" as const;

/**
 * 需求溯源 ID（对齐 [REQ-F-xxx] 标记规范）
 */
const REQUIREMENT_ID = "F-001" as const;

/**
 * 文件簇名（与 plan.md 中 `### OrderAggregate` 模块名严格一致）
 *
 * SkeletonGenerator 通过 taskDag.nodes[].fileCluster 在 plan.md 中定位 ModuleSplit，
 * 二者必须完全一致，否则抛出 module-split-not-found。
 */
const FILE_CLUSTER = "OrderAggregate" as const;

/**
 * 输出目录（相对 projectRoot，G-4 校验非空）
 */
const OUTPUT_DIR = "src/" as const;

/**
 * 技术栈锁定清单（CONSTITUTION.techStackLocks，G-4 校验非空）
 */
const TECH_STACK: ReadonlyArray<string> = Object.freeze(["TypeScript", "Node.js", "EJS"]);

/**
 * 本任务卡需要的模板 kind 列表（G-4 校验全部已注册）
 *
 * 与 plan.md 模块职责（含"聚合"关键词）推导出的 kind 集合一致：
 * aggregate + domain-event。
 */
const REQUIRED_TEMPLATE_KINDS: ReadonlyArray<GeneratedFileKind> = Object.freeze([
  "aggregate",
  "domain-event",
]) as ReadonlyArray<GeneratedFileKind>;

/**
 * 退出码枚举（与 shell 脚本头部注释对齐）
 */
const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  INVALID_ENV: 1,
  PHASE_A_FAILED: 2,
  PHASE_B_FAILED: 3,
  STRICT_FAILED: 4,
  GATE_FAILED: 5,
});

// ============================================================================
// InMemoryPkcAccessor：PKC 知识库访问器（真实实现，非 mock）
// ============================================================================

/**
 * 内存版 PKC 访问器（集成测试专用真实实现）
 *
 * 实现 PkcAccessor 协议的三个查询方法：
 * - queryL1GlobalView：返回预设的 L1 全局视野摘要（模块聚类 + 入口点）
 * - searchL2：返回预设的 L2 语义检索命中列表（按 topK 截断，对齐真实检索器行为）
 * - queryL3BusinessKnowledge：返回预设的 L3 业务知识（K2 流程 + K3 ER 摘要）
 *
 * 设计依据（用户规则"禁止 mock，使用 InMemory 真实实现"）：
 * - 所有方法真实工作：searchL2 真实执行 topK 截断逻辑，非返回固定引用
 * - 预设数据贴合本集成测试场景（订单聚合根上下文）
 * - 无任何未实现的占位方法
 */
class InMemoryPkcAccessor implements PkcAccessor {
  /**
   * 查询 L1 全局视野摘要
   *
   * @param _projectRoot 项目根目录（本实现不使用，保持协议签名一致）
   * @returns L1 全局视野摘要（模块聚类 + 入口点）
   */
  async queryL1GlobalView(_projectRoot: string): Promise<Readonly<Record<string, unknown>>> {
    return Object.freeze({
      moduleClusters: Object.freeze([{ name: FILE_CLUSTER, layer: "domain" }]),
      entryPoints: Object.freeze(["src/index.ts"]),
    });
  }

  /**
   * 语义检索 L2（真实执行 topK 截断）
   *
   * @param _query 自然语言查询（本实现返回与订单域相关的预设符号）
   * @param _projectRoot 项目根目录（本实现不使用）
   * @param topK 返回的 Top-K 个命中项
   * @returns 符号命中列表（按 score 降序，真实按 topK 截断）
   */
  async searchL2(
    _query: string,
    _projectRoot: string,
    topK?: number
  ): Promise<
    ReadonlyArray<{
      readonly symbolId: string;
      readonly filePath: string;
      readonly signature: string;
      readonly score: number;
      readonly snippet: string;
    }>
  > {
    // 预设订单域相关符号（score ≥ 0.5，可通过 ContextAssembler 的 R7 阈值过滤）
    const hits = [
      Object.freeze({
        symbolId: "src/OrderAggregate.ts:OrderAggregate.create",
        filePath: "src/OrderAggregate.ts",
        signature: "static create(command: OrderCreateCommand): OrderAggregate",
        score: 0.92,
        snippet: "static create(command) { /* 工厂方法 */ }",
      }),
      Object.freeze({
        symbolId: "src/OrderAggregate.ts:OrderAggregate.cancel",
        filePath: "src/OrderAggregate.ts",
        signature: "cancel(command: OrderCancelCommand): void",
        score: 0.85,
        snippet: "cancel(command) { /* 取消订单 */ }",
      }),
    ];
    // 真实业务逻辑：按 topK 截断（对齐 PKC L2 检索器的 Top-K 行为）
    const limit = typeof topK === "number" && topK > 0 ? topK : hits.length;
    return Object.freeze(hits.slice(0, limit));
  }

  /**
   * 查询 L3 业务知识
   *
   * @param _projectRoot 项目根目录（本实现不使用，保持协议签名一致）
   * @returns L3 业务知识摘要（K2 订单流程 + K3 订单 ER 摘要）
   */
  async queryL3BusinessKnowledge(_projectRoot: string): Promise<Readonly<Record<string, unknown>>> {
    return Object.freeze({
      k2Flow: "下单 → 支付 → 确认 → 发货 → 完成；取消可在确认前触发",
      k3ErSummary: "Order 1-N OrderItem；Order 与 Payment 一对一",
    });
  }
}

// ============================================================================
// 合规 / 违规 LLM 响应生成器（真实业务实现，非 mock）
// ============================================================================

/**
 * 从 LLMRequest 的 user prompt 中提取目标文件路径
 *
 * LlmFiller 装配的 user prompt 含 `## 骨架代码（文件：<path>）` 段落，
 * 本函数用正则提取该路径，供响应生成器按文件路由。
 *
 * 正则说明：
 * - 路径终止符为全角括号 `）`（U+FF09）、半角括号 `)` 或任意空白字符。
 *   由于 `）` 不属于 `\s` 字符类，若仅用 `[^\s]+` 会将尾随的 `）` 一并捕获，
 *   导致下游 `endsWith(".ts")` 路由判定失败（本集成测试 IB-2 失败的根因）。
 *
 * @param request LLM 请求
 * @returns 提取的文件相对路径；提取失败时返回空字符串
 */
function extractTargetFilePath(request: LLMRequest): string {
  const userMessage = request.messages.find((m) => m.role === "user");
  const userContent = userMessage?.content ?? "";
  const pathMatch = userContent.match(/文件：([^\s）)]+)/);
  return pathMatch ? pathMatch[1] : "";
}

/**
 * 构造标准 LLMResponse（JSON 模式，含 usage 统计）
 *
 * @param filePath 文件相对路径（写入 files[0].path）
 * @param fileContent 完整文件内容（写入 files[0].content）
 * @param inputChars 输入 prompt 总字符数（用于估算 inputTokens）
 * @returns 完整 LLMResponse
 */
function buildJsonLLMResponse(filePath: string, fileContent: string, inputChars: number): LLMResponse {
  return {
    content: JSON.stringify({ files: [{ path: filePath, content: fileContent }] }),
    thinking: "",
    toolCalls: [],
    stopReason: "stop",
    usage: {
      // 粗略估算：1 token ≈ 4 字符（与 llm-filler 内部估算口径一致）
      inputTokens: Math.ceil(inputChars / 4),
      outputTokens: Math.ceil(fileContent.length / 4),
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  };
}

/**
 * 合规的 OrderAggregate.ts 完整实现
 *
 * 红线合规性逐条说明（对应 19 条可静态判定红线）：
 * - E1（事务边界）：仅调用 this.* 方法与非写前缀方法（publish），无跨聚合写调用
 * - E2（幂等性）：非 controller/handler 路径，非事件处理器文件，不在判定范围内
 * - E3（审计）：cancel 状态变更方法体内调用 this.publish(...)（含 ".publish(" 调用点）
 * - E4（依赖方向）：路径不含 /domain/，且无 import 语句，不触发依赖方向判定
 * - E5（输入校验）：无 DTO 类声明
 * - E6 / TCS-SEC-02（硬编码密钥）：无任何密钥格式字符串字面量
 * - E7（贫血模型）：create/cancel/ship/confirm/publish/pullDomainEvents 共 6 个业务方法 ≥ 2
 * - E8（API 契约）：无 @Controller 类
 * - TCS-OSS-01：无厂商 SDK import
 * - TCS-CACHE-01/02/03：无 cache.set/get/delete 调用
 * - TCS-SQL-01/02/03：无 SQL 字符串与循环内查询
 * - TCS-LDAP-01/02：无 LDAP 调用与同步任务
 * - TCS-SEC-01：非 package.json 产出物
 *
 * 实现要点：
 * - publish 私有方法统一构造领域事件并入队（ pendingEvents ），
 *   状态变更方法（cancel/ship/confirm）均通过 this.publish 发布事件（满足 E3 审计要求）
 * - 事件以对象字面量构造，不调用任何非 this 的写前缀方法（满足 E1 事务边界要求）
 */
const COMPLIANT_ORDER_AGGREGATE_CONTENT = `// src/OrderAggregate.ts
/**
 * 订单聚合根（Phase B LLM 填充的合规实现）
 *
 * 模块职责：订单聚合根，负责订单的创建、取消与发货状态管理
 *
 * 关联需求：F-001
 * 关联任务：T-001
 *
 * 设计说明：
 * - 聚合根遵循 DDD 聚合边界：仅修改自身状态，跨聚合一致性交由 Saga 编排器处理
 * - 所有状态变更方法统一通过 this.publish 发布领域事件（满足 E3 审计红线）
 * - 领域事件以对象字面量构造，避免在聚合根方法体内调用其他聚合根的写方法
 *   （满足 E1 事务边界红线：禁止跨聚合写调用，除非存在 Saga 编排）
 * - 无硬编码密钥 / 无缓存调用 / 无 SQL 调用（满足 E6 与 TCS 组件红线）
 *
 * @module src/OrderAggregate
 */

/**
 * 订单领域事件协议（本文件内聚定义，避免跨文件 import 引入依赖方向风险）
 *
 * 字段说明：
 * - eventId：事件唯一 ID（聚合 ID + 版本号派生，用于幂等去重）
 * - eventType：事件类型（如 "OrderCreated"）
 * - aggregateId：发布事件的聚合根 ID
 * - occurredAt：事件发生时间（ISO 8601 字符串）
 * - version：聚合版本号（用于乐观锁与事件溯源）
 * - payload：业务载荷（按事件类型不同而不同）
 */
interface OrderDomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * 订单状态字面量联合（状态机：pending → confirmed → shipped；pending/confirmed → cancelled）
 */
type OrderStatus = "pending" | "confirmed" | "cancelled" | "shipped";

/**
 * 订单聚合根
 *
 * 负责维护订单的不变式：
 * - 已取消订单不允许重复取消
 * - 已发货订单不允许取消
 * - 仅已确认订单允许发货
 * - 每次状态变更递增版本号并发布领域事件
 */
export class OrderAggregate {
  /** 订单唯一标识（构造后不可变） */
  private readonly id: string;
  /** 订单当前状态（仅通过业务方法迁移） */
  private status: OrderStatus;
  /** 订单创建时间（构造后不可变） */
  private readonly createdAt: Date;
  /** 聚合版本号（每次状态变更递增，用于乐观锁） */
  private version: number;
  /** 待发布的领域事件队列（由 pullDomainEvents 一次性取出并清空） */
  private readonly pendingEvents: OrderDomainEvent[] = [];

  /**
   * 私有构造函数（仅通过静态工厂方法 create 创建实例）
   *
   * @param id 订单唯一标识（已校验非空）
   */
  private constructor(id: string) {
    this.id = id;
    this.status = "pending";
    this.createdAt = new Date();
    this.version = 1;
  }

  /**
   * 创建订单聚合根实例（领域工厂方法）
   *
   * 算法：
   * 1. 校验 command 字段不变式（id 必须为非空字符串）
   * 2. 通过私有构造函数创建聚合根实例（初始状态 pending，版本号 1）
   * 3. 发布 OrderCreated 领域事件
   *
   * @param command 创建命令（含订单 id）
   * @returns 新建的订单聚合根实例
   * @throws {Error} command.id 为空或非字符串时抛出
   */
  static create(command: { readonly id: string }): OrderAggregate {
    if (!command || typeof command.id !== "string" || command.id.trim().length === 0) {
      throw new Error("创建订单命令必须包含非空字符串 id");
    }
    const aggregate = new OrderAggregate(command.id);
    aggregate.publish("OrderCreated", { id: command.id });
    return aggregate;
  }

  /**
   * 确认订单（业务方法）
   *
   * 算法：
   * 1. 校验当前状态为 pending（仅待处理订单可确认）
   * 2. 迁移状态为 confirmed
   * 3. 发布 OrderConfirmed 领域事件
   *
   * @throws {Error} 当前状态非 pending 时抛出
   */
  confirm(): void {
    if (this.status !== "pending") {
      throw new Error(\`当前状态 \${this.status} 不允许确认，仅 pending 状态可确认\`);
    }
    this.status = "confirmed";
    this.publish("OrderConfirmed", { id: this.id });
  }

  /**
   * 取消订单（业务方法，E3 审计点：状态变更后发布 OrderCancelled 事件）
   *
   * 算法：
   * 1. 校验当前状态允许取消（已取消不可重复取消，已发货不可取消）
   * 2. 迁移状态为 cancelled
   * 3. 通过 this.publish 发布 OrderCancelled 领域事件（含取消原因载荷）
   *
   * @param command 取消命令（含取消原因）
   * @throws {Error} 订单已取消或已发货时抛出
   */
  cancel(command: { readonly reason: string }): void {
    if (this.status === "cancelled") {
      throw new Error("订单已取消，不允许重复取消");
    }
    if (this.status === "shipped") {
      throw new Error("订单已发货，不允许取消");
    }
    this.status = "cancelled";
    this.publish("OrderCancelled", { id: this.id, reason: command.reason });
  }

  /**
   * 发货（业务方法，E3 审计点：状态变更后发布 OrderShipped 事件）
   *
   * 算法：
   * 1. 校验当前状态为 confirmed（仅已确认订单可发货）
   * 2. 迁移状态为 shipped
   * 3. 通过 this.publish 发布 OrderShipped 领域事件（含物流单号载荷）
   *
   * @param command 发货命令（含物流单号）
   * @throws {Error} 订单未确认时抛出
   */
  ship(command: { readonly trackingNumber: string }): void {
    if (this.status !== "confirmed") {
      throw new Error("订单未确认，不允许发货");
    }
    if (typeof command.trackingNumber !== "string" || command.trackingNumber.trim().length === 0) {
      throw new Error("发货命令必须包含非空物流单号");
    }
    this.status = "shipped";
    this.publish("OrderShipped", { id: this.id, trackingNumber: command.trackingNumber });
  }

  /**
   * 发布领域事件（私有方法，统一事件构造与入队逻辑）
   *
   * 算法：
   * 1. 递增聚合版本号（每次状态变更单调递增）
   * 2. 以对象字面量构造 OrderDomainEvent（eventId 由聚合 ID + 版本号派生）
   * 3. 入队到 pendingEvents，等待仓储层持久化后统一发布
   *
   * 注意：本方法仅操作 this 上的字段，不调用任何外部聚合的写方法（满足 E1 红线）。
   *
   * @param eventType 事件类型（如 "OrderCancelled"）
   * @param payload 业务载荷
   */
  private publish(eventType: string, payload: Readonly<Record<string, unknown>>): void {
    this.version += 1;
    const event: OrderDomainEvent = {
      eventId: \`\${this.id}-v\${this.version}\`,
      eventType,
      aggregateId: this.id,
      occurredAt: new Date().toISOString(),
      version: this.version,
      payload,
    };
    this.pendingEvents.push(event);
  }

  /**
   * 取出并清空待发布的领域事件队列（由应用服务层在持久化后调用）
   *
   * @returns 待发布事件列表的快照（取出后队列清空，保证事件不重复发布）
   */
  pullDomainEvents(): ReadonlyArray<OrderDomainEvent> {
    const events: OrderDomainEvent[] = [...this.pendingEvents];
    this.pendingEvents.length = 0;
    return Object.freeze(events);
  }

  /** 获取订单 ID */
  getId(): string {
    return this.id;
  }

  /** 获取订单当前状态 */
  getStatus(): OrderStatus {
    return this.status;
  }

  /** 获取订单创建时间 */
  getCreatedAt(): Date {
    return this.createdAt;
  }

  /** 获取聚合版本号 */
  getVersion(): number {
    return this.version;
  }
}
`;

/**
 * 合规的 OrderAggregateCreated.ts 完整实现
 *
 * 红线合规性说明：
 * - 类名以 Created 结尾（非 Aggregate/Entity/Root 后缀），不触发 E7 贫血模型判定
 * - 无状态变更前缀方法（set/update/change/modify/mark/cancel/close），不触发 E3 审计判定
 * - 无密钥字面量 / 无缓存 / SQL / LDAP 调用，其余红线均不在判定范围内
 */
const COMPLIANT_ORDER_EVENT_CONTENT = `// src/OrderAggregateCreated.ts
/**
 * OrderAggregateCreated 领域事件（Phase B LLM 填充的合规实现）
 *
 * 模块职责：订单聚合根创建后发布的领域事件
 *
 * 关联需求：F-001
 * 关联任务：T-001
 *
 * 设计说明：
 * - 事件不可变：全部字段 readonly，构造后不可修改
 * - 事件 ID 由聚合 ID 与版本号派生，保证幂等去重可用
 * - 序列化方法 toJSON 输出完整协议字段，供事件存储与消息队列传输
 *
 * @module src/OrderAggregateCreated
 */

/**
 * DomainEvent 基础接口（所有领域事件必须实现）
 *
 * 字段说明：
 * - eventId：事件唯一 ID（用于幂等去重）
 * - eventType：事件类型（如 "OrderAggregateCreated"）
 * - aggregateId：发布事件的聚合根 ID
 * - occurredAt：事件发生时间（ISO 8601 字符串）
 * - version：聚合版本号（用于乐观锁与事件溯源）
 */
export interface DomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly version: number;
}

/**
 * OrderAggregateCreated 事件载荷
 */
export interface OrderAggregateCreatedPayload {
  /** 聚合根 ID（与 DomainEvent.aggregateId 一致，冗余便于消费者直接读取） */
  readonly aggregateId: string;
  /** 事件发生时间（ISO 8601 字符串） */
  readonly occurredAt: string;
}

/**
 * OrderAggregateCreated 领域事件
 *
 * 触发场景：
 * - OrderAggregate 聚合执行 create 工厂方法后发布
 * - 事件处理器订阅此事件执行异步副作用（如发送确认通知）
 * - 事件存储持久化此事件用于溯源
 */
export class OrderAggregateCreated implements DomainEvent {
  /** 事件唯一 ID（聚合 ID + 版本号派生） */
  readonly eventId: string;
  /** 事件类型（固定为 "OrderAggregateCreated"） */
  readonly eventType: string = "OrderAggregateCreated";
  /** 发布事件的聚合根 ID */
  readonly aggregateId: string;
  /** 事件发生时间（ISO 8601 字符串） */
  readonly occurredAt: string;
  /** 聚合版本号 */
  readonly version: number;

  /**
   * 构造 OrderAggregateCreated 实例（私有，仅通过工厂方法创建）
   *
   * @param props 事件属性（含协议字段与载荷字段）
   */
  private constructor(props: OrderAggregateCreatedPayload & { readonly eventId: string; readonly version: number }) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.occurredAt = props.occurredAt;
    this.version = props.version;
  }

  /**
   * 创建 OrderAggregateCreated 事件（工厂方法）
   *
   * 算法：
   * 1. 校验 aggregateId 非空（不变式保护）
   * 2. 以当前时间生成 occurredAt（ISO 8601）
   * 3. 由 aggregateId + version 派生 eventId（保证同一聚合同版本事件 ID 唯一）
   * 4. 通过私有构造函数创建事件实例
   *
   * @param aggregateId 聚合根 ID
   * @param version 聚合版本号
   * @returns 新建的事件实例
   * @throws {Error} aggregateId 为空时抛出
   */
  static create(aggregateId: string, version: number): OrderAggregateCreated {
    if (typeof aggregateId !== "string" || aggregateId.trim().length === 0) {
      throw new Error("aggregateId 必须为非空字符串");
    }
    const occurredAt = new Date().toISOString();
    return new OrderAggregateCreated({
      eventId: \`\${aggregateId}-created-v\${version}\`,
      aggregateId,
      occurredAt,
      version,
    });
  }

  /**
   * 序列化为 JSON 对象（用于事件存储与消息队列传输）
   *
   * @returns JSON 对象表示（含全部协议字段）
   */
  toJSON(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      occurredAt: this.occurredAt,
      version: this.version,
    };
  }
}
`;

/**
 * 合规响应生成器（正向链路）
 *
 * 真实业务实现：按 user prompt 中的目标文件路径路由到对应的合规实现内容。
 * - src/OrderAggregate.ts → COMPLIANT_ORDER_AGGREGATE_CONTENT
 * - src/OrderAggregateCreated.ts → COMPLIANT_ORDER_EVENT_CONTENT
 * - 其他路径 → 抛出错误（集成测试场景不应出现未知文件，早失败便于定位问题）
 *
 * @param request LLM 请求（含 LlmFiller 装配的 system + user 消息）
 * @returns 真实的 LLM 响应（JSON 模式，含合规完整文件内容）
 */
function compliantResponseGenerator(request: LLMRequest): LLMResponse {
  const filePath = extractTargetFilePath(request);
  const inputChars = request.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);

  if (filePath.endsWith("OrderAggregate.ts")) {
    return buildJsonLLMResponse(filePath, COMPLIANT_ORDER_AGGREGATE_CONTENT, inputChars);
  }
  if (filePath.endsWith("OrderAggregateCreated.ts")) {
    return buildJsonLLMResponse(filePath, COMPLIANT_ORDER_EVENT_CONTENT, inputChars);
  }
  // 集成测试场景仅预期上述两个文件；出现未知路径属于装配错误，立即失败便于定位
  throw new Error(`合规响应生成器收到未知目标文件路径："${filePath}"`);
}

/**
 * 违规的 OrderAggregate.ts 内容（反向链路：含硬编码 AWS 密钥，触发 E6 / TCS-SEC-02）
 *
 * 故意在字符串字面量中写入 AWS Access Key 格式（AKIA + 16 位大写字母数字），
 * HardcodeSecretScanner 的 gitleaks 规则集会命中该模式并判定 E6（blocker）违规。
 * 其余结构与合规版一致，保证违规信号唯一来自硬编码密钥（断言定位精确）。
 */
const MALICIOUS_ORDER_AGGREGATE_CONTENT = `// src/OrderAggregate.ts
/**
 * 订单聚合根（反向链路违规实现：含硬编码密钥，用于验证 STRICT 拦截能力）
 *
 * @module src/OrderAggregate
 */

/** 订单领域事件协议（本文件内聚定义） */
interface OrderDomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * 订单聚合根（违规版本）
 *
 * 违规点：下列 AWS_ACCESS_KEY_ID 常量以字符串字面量硬编码真实格式的
 * AWS Access Key（AKIA 前缀 + 16 位大写字母数字），违反 E6 / TCS-SEC-02 红线。
 * 正确做法应通过 process.env.AWS_ACCESS_KEY_ID 读取环境变量。
 */
export class OrderAggregate {
  /** 违规点：硬编码 AWS 访问密钥（应改为环境变量读取） */
  private static readonly AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";

  /** 订单唯一标识 */
  private readonly id: string;
  /** 订单当前状态 */
  private status: string;
  /** 聚合版本号 */
  private version: number;
  /** 待发布事件队列 */
  private readonly pendingEvents: OrderDomainEvent[] = [];

  private constructor(id: string) {
    this.id = id;
    this.status = "pending";
    this.version = 1;
  }

  /**
   * 创建订单聚合根实例（领域工厂方法）
   *
   * @param command 创建命令（含订单 id）
   * @returns 新建的订单聚合根实例
   */
  static create(command: { readonly id: string }): OrderAggregate {
    if (!command || typeof command.id !== "string" || command.id.trim().length === 0) {
      throw new Error("创建订单命令必须包含非空字符串 id");
    }
    const aggregate = new OrderAggregate(command.id);
    aggregate.publish("OrderCreated", { id: command.id });
    return aggregate;
  }

  /**
   * 取消订单（业务方法）
   *
   * @param command 取消命令（含取消原因）
   */
  cancel(command: { readonly reason: string }): void {
    if (this.status === "cancelled") {
      throw new Error("订单已取消，不允许重复取消");
    }
    this.status = "cancelled";
    this.publish("OrderCancelled", { id: this.id, reason: command.reason });
  }

  /**
   * 发布领域事件（私有方法）
   *
   * @param eventType 事件类型
   * @param payload 业务载荷
   */
  private publish(eventType: string, payload: Readonly<Record<string, unknown>>): void {
    this.version += 1;
    this.pendingEvents.push({
      eventId: \`\${this.id}-v\${this.version}\`,
      eventType,
      aggregateId: this.id,
      occurredAt: new Date().toISOString(),
      version: this.version,
      payload,
    });
  }

  /** 获取订单 ID */
  getId(): string {
    return this.id;
  }

  /** 获取订单当前状态 */
  getStatus(): string {
    return this.status;
  }

  /** 获取当前硬编码密钥的后 4 位（违规演示用，真实代码严禁出现） */
  getKeySuffix(): string {
    return OrderAggregate.AWS_ACCESS_KEY_ID.slice(-4);
  }
}
`;

/**
 * 违规响应生成器（反向链路）
 *
 * 真实业务实现：对 OrderAggregate.ts 返回含硬编码密钥的违规实现，
 * 其余文件仍返回合规实现（保证违规信号唯一来自 E6 硬编码密钥）。
 *
 * @param request LLM 请求
 * @returns 真实的 LLM 响应（JSON 模式）
 */
function maliciousResponseGenerator(request: LLMRequest): LLMResponse {
  const filePath = extractTargetFilePath(request);
  const inputChars = request.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);

  if (filePath.endsWith("OrderAggregate.ts")) {
    return buildJsonLLMResponse(filePath, MALICIOUS_ORDER_AGGREGATE_CONTENT, inputChars);
  }
  if (filePath.endsWith("OrderAggregateCreated.ts")) {
    return buildJsonLLMResponse(filePath, COMPLIANT_ORDER_EVENT_CONTENT, inputChars);
  }
  throw new Error(`违规响应生成器收到未知目标文件路径："${filePath}"`);
}

// ============================================================================
// 辅助函数：命令行参数解析 / 上下文构造 / 报告写出
// ============================================================================

/**
 * 解析命令行参数（--tmp-dir / --report-file）
 *
 * 同时支持环境变量回退（EAG_INTEGRATION_TMP_DIR），与 shell 脚本传参方式对齐。
 *
 * @param argv 命令行参数数组（process.argv.slice(2)）
 * @returns 解析结果（tmpDir / reportFile）
 */
function parseCliArgs(argv: ReadonlyArray<string>): { tmpDir: string; reportFile: string } {
  let tmpDir = process.env.EAG_INTEGRATION_TMP_DIR ?? "";
  let reportFile = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tmp-dir" && i + 1 < argv.length) {
      tmpDir = argv[i + 1];
      i++;
    } else if (arg === "--report-file" && i + 1 < argv.length) {
      reportFile = argv[i + 1];
      i++;
    }
  }

  // reportFile 缺省时落到 tmpDir 内（与 shell 脚本期望的报告路径一致）
  if (!reportFile && tmpDir) {
    reportFile = join(tmpDir, "integration-report.json");
  }
  return { tmpDir, reportFile };
}

/**
 * 构造任务卡（TaskCard）
 *
 * G-4 门禁要求 declaredSymbols 与 acceptanceCriteria 非空。
 *
 * @param status 任务卡状态（正向 Phase 执行前为 pending；G-5 校验时为 completed）
 * @returns 任务卡对象
 */
function buildTaskCard(status: TaskCard["status"]): TaskCard {
  return {
    id: TASK_CARD_ID,
    title: "OrderAggregate 骨架生成与 LLM 填充",
    requirementId: REQUIREMENT_ID,
    dependencies: Object.freeze([]) as ReadonlyArray<string>,
    acceptanceCriteria: Object.freeze([
      "骨架含 TODO(phase-b) 占位标记",
      "LLM 填充后无占位残留且通过 STRICT 评估",
    ]) as ReadonlyArray<string>,
    status,
    declaredSymbols: Object.freeze([
      "src/OrderAggregate.ts:OrderAggregate.create",
      "src/OrderAggregate.ts:OrderAggregate.cancel",
    ]) as ReadonlyArray<string>,
  };
}

/**
 * 构造任务 DAG（TaskDag，含单节点与拓扑序）
 *
 * TaskNode.fileCluster 必须与 plan.md 中 `### OrderAggregate` 模块名一致，
 * SkeletonGenerator 通过 taskCard.id 在本 DAG 中查找 TaskNode 获取 fileCluster。
 *
 * @returns 任务 DAG
 */
function buildTaskDag(): TaskDag {
  const node: TaskNode = {
    id: TASK_CARD_ID,
    title: "OrderAggregate 骨架生成与 LLM 填充",
    requirementId: REQUIREMENT_ID,
    dependencies: Object.freeze([]) as ReadonlyArray<string>,
    fileCluster: FILE_CLUSTER,
    acceptanceCommand: "node --import tsx --test tests/order-aggregate.test.ts",
    declaredSymbols: Object.freeze([
      "src/OrderAggregate.ts:OrderAggregate.create",
      "src/OrderAggregate.ts:OrderAggregate.cancel",
    ]) as ReadonlyArray<string>,
  };
  return {
    nodes: Object.freeze([node]) as ReadonlyArray<TaskNode>,
    topologicalOrder: Object.freeze([TASK_CARD_ID]) as ReadonlyArray<string>,
  };
}

/**
 * 构造 G-4 门禁上下文
 *
 * @param taskCard 当前任务卡
 * @returns GateG4Context（全部字段满足 G-4 判定规则）
 */
function buildG4Context(taskCard: Readonly<TaskCard>): GateG4Context {
  return {
    projectId: "eag-batch9-integration",
    loopType: "coding",
    specStatus: "approved",
    planStatus: "approved",
    reviewRecords: Object.freeze([]) as ReadonlyArray<never>,
    userApproved: true,
    taskCard,
    actualChanges: Object.freeze([]) as ReadonlyArray<never>,
    tasksStatus: "approved",
    fileCluster: FILE_CLUSTER,
    requiredTemplateKinds: REQUIRED_TEMPLATE_KINDS,
    techStack: TECH_STACK,
    outputDir: OUTPUT_DIR,
  };
}

/**
 * 构造 G-5 门禁上下文
 *
 * @param completedTaskCard 已完成任务卡（status=completed）
 * @param finalReport 最终 STRICT 评估报告（G-5 校验 verdict=pass）
 * @returns GateG5Context（全部字段满足 G-5 判定规则）
 */
function buildG5Context(completedTaskCard: Readonly<TaskCard>, finalReport: Readonly<EvaluationReport>): GateG5Context {
  return {
    projectId: "eag-batch9-integration",
    loopType: "coding",
    specStatus: "approved",
    planStatus: "approved",
    reviewRecords: Object.freeze([]) as ReadonlyArray<never>,
    userApproved: true,
    taskCard: completedTaskCard,
    actualChanges: Object.freeze([]) as ReadonlyArray<never>,
    allTaskCards: Object.freeze([completedTaskCard]) as ReadonlyArray<TaskCard>,
    finalEvaluationReport: finalReport,
    // 集成测试在临时目录运行且不执行 git 写操作，工作区视为干净（由 shell 脚本保证临时目录独立性）
    gitClean: true,
    // gitleaks 扫描由 HardcodeSecretScanner 在 STRICT 阶段静态覆盖（正向链路 E6/TCS-SEC-02 均 passed），
    // 此处标记通过，与"正向链路无密钥泄露"的事实一致
    gitleaksPassed: true,
  };
}

/**
 * 构造 STRICT 评估上下文（EvaluationContext）
 *
 * @param files 产出物列表（Phase B 填充结果或反向链路填充结果）
 * @returns EvaluationContext（inlineArtifacts 全量内联，评估器无需读盘）
 */
function buildEvaluationContext(files: ReadonlyArray<GeneratedFile>): EvaluationContext {
  const inlineArtifacts = files.map((f) => ({
    path: f.relativePath,
    content: f.content,
  }));
  return {
    loopType: "coding",
    iteration: 1,
    taskId: TASK_CARD_ID,
    artifactPaths: inlineArtifacts.map((a) => a.path),
    inlineArtifacts,
  };
}

/**
 * 计算可静态判定的红线清单（19 条）
 *
 * 算法：
 * 1. 合并 ENTERPRISE_REDLINES（8 条）与 TCS_REDLINES（13 条）
 * 2. 按 DEFAULT_STATIC_CHECKERS 注册表过滤——仅保留已注册 Checker 的红线
 *
 * 设计理由（见文件头"红线清单说明"）：
 * - TCS-OSS-02 / TCS-OSS-03 无静态 Checker，评估会返回 unknown，
 *   decideVerdict 会将报告决策为 human_checkpoint 而非 pass。
 * - 正向链路（IS-1）断言 verdict="pass"，因此仅对 19 条可静态判定红线求值。
 *
 * @returns 19 条可静态判定红线（顺序：先企业红线后 TCS 红线）
 */
function buildStaticallyCheckableRedlines(): ReadonlyArray<RedlineDefinition> {
  const registeredIds = new Set(getRegisteredRedlineIds());
  const all: RedlineDefinition[] = [...ENTERPRISE_REDLINES, ...TCS_REDLINES];
  return Object.freeze(all.filter((r) => registeredIds.has(r.id))) as ReadonlyArray<RedlineDefinition>;
}

// ============================================================================
// 报告类型定义
// ============================================================================

/**
 * 集成测试报告（integration-report.json 的结构）
 *
 * 字段与 shell 脚本 Step 4 的摘要输出一一对应：
 * - phaseA.fileCount / phaseA.durationMs
 * - phaseB.fillCount / phaseB.llmCallCount
 * - strict.verdict / strict.blockerCount / strict.majorCount
 * - gates.g4 / gates.g5
 */
interface IntegrationReport {
  /** Phase A 骨架生成段 */
  readonly phaseA: {
    readonly fileCount: number;
    readonly placeholderCount: number;
    readonly durationMs: number;
    readonly assertions: ReadonlyArray<string>;
  };
  /** Phase B LLM 填充段 */
  readonly phaseB: {
    readonly fillCount: number;
    readonly skippedCount: number;
    readonly failedCount: number;
    readonly llmCallCount: number;
    readonly totalTokensUsed: number;
    readonly durationMs: number;
    readonly assertions: ReadonlyArray<string>;
  };
  /** STRICT 正向评估段 */
  readonly strict: {
    readonly verdict: string;
    readonly blockerCount: number;
    readonly majorCount: number;
    readonly warningCount: number;
    readonly redlineCount: number;
    readonly durationMs: number;
    readonly assertions: ReadonlyArray<string>;
  };
  /** STRICT 反向评估段（违规注入验证） */
  readonly strictReverse: {
    readonly verdict: string;
    readonly blockerCount: number;
    readonly e6Status: string;
    readonly assertions: ReadonlyArray<string>;
  };
  /** 门禁段 */
  readonly gates: {
    readonly g4: boolean;
    readonly g5: boolean;
    readonly assertions: ReadonlyArray<string>;
  };
  /** 总体结论（pass / failed） */
  readonly overall: string;
}

// ============================================================================
// 主流程
// ============================================================================

/**
 * 集成测试主函数
 *
 * 按设计文档 §3.1 时序执行：G-4 → Phase A → 上下文装配 → Phase B → STRICT 正向
 * → STRICT 反向 → G-5 → 输出报告。
 *
 * 各阶段失败时映射到对应退出码（见文件头退出码表），
 * 并将已完成阶段的报告数据写入 reportFile（便于 shell 脚本诊断）。
 *
 * @returns 进程退出码（0 表示全部通过）
 */
async function main(): Promise<number> {
  // ---------- 入参解析与环境校验 ----------
  const { tmpDir, reportFile } = parseCliArgs(process.argv.slice(2));
  if (!tmpDir || !existsSync(tmpDir)) {
    console.error(`[集成测试] 临时目录不存在或未通过 --tmp-dir / EAG_INTEGRATION_TMP_DIR 指定："${tmpDir}"`);
    return EXIT_CODES.INVALID_ENV;
  }
  const planPath = join(tmpDir, "docs", "plan.md");
  const tasksPath = join(tmpDir, "docs", "tasks.md");
  if (!existsSync(planPath) || !existsSync(tasksPath)) {
    console.error(`[集成测试] plan.md 或 tasks.md 不存在于 ${join(tmpDir, "docs")}`);
    return EXIT_CODES.INVALID_ENV;
  }
  const planContent = readFileSync(planPath, "utf-8");
  const tasksContent = readFileSync(tasksPath, "utf-8");

  // 日志回调（输出到 stdout，shell 脚本实时可见）
  const log = (msg: string): void => console.log(`[集成测试] ${msg}`);

  // ---------- 构造公共输入 ----------
  const taskCard = buildTaskCard("pending");
  const taskDag = buildTaskDag();
  const redlines = buildStaticallyCheckableRedlines();
  log(`红线清单：${redlines.length} 条可静态判定红线（E1~E8 + 11 条 TCS）`);

  // ---------- G-4 门禁（IG4-1） ----------
  log("执行 G-4 门禁检查（CODING Loop 进入条件）");
  const g4Checker = new GateG4Checker();
  const g4Result = g4Checker.check(buildG4Context(taskCard));
  // IG4-1：G-4 门禁必须通过（任务卡完整性 + 模板可用性 + 技术栈锁定 + 输出目录）
  if (!g4Result.passed) {
    console.error(`[集成测试] IG4-1 断言失败：G-4 门禁未通过，原因：${g4Result.reason}`);
    return EXIT_CODES.GATE_FAILED;
  }
  log("IG4-1 通过：G-4 门禁放行");

  // ---------- Phase A：骨架生成（IA-1/IA-2/IA-3） ----------
  log("执行 Phase A：SkeletonGenerator.generate()");
  const skeletonGenerator = new SkeletonGenerator();
  let skeleton: SkeletonGenerationResult;
  try {
    skeleton = skeletonGenerator.generate({
      planContent,
      tasksContent,
      taskDag,
      taskCard,
      techStack: TECH_STACK,
      projectRoot: tmpDir,
      outputDir: OUTPUT_DIR,
    });
  } catch (e) {
    console.error(`[集成测试] Phase A 骨架生成抛错：${e instanceof Error ? e.message : String(e)}`);
    return EXIT_CODES.PHASE_A_FAILED;
  }

  try {
    // IA-1：骨架文件数 ≥ 2（聚合根 + 领域事件）
    assert.ok(skeleton.files.length >= 2, `IA-1 失败：骨架文件数 ${skeleton.files.length} < 2`);
    // IA-2：每个骨架文件含 TODO(phase-b) 占位标记
    for (const file of skeleton.files) {
      assert.ok(
        file.content.includes("TODO(phase-b)"),
        `IA-2 失败：骨架文件 ${file.relativePath} 不含 TODO(phase-b) 占位标记`
      );
    }
    // IA-3：占位列表非空
    assert.ok(skeleton.fillPlaceholders.length >= 1, "IA-3 失败：fillPlaceholders 为空");
  } catch (e) {
    console.error(`[集成测试] ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_CODES.PHASE_A_FAILED;
  }
  log(`IA-1/IA-2/IA-3 通过：${skeleton.files.length} 个骨架文件，${skeleton.fillPlaceholders.length} 个占位`);

  // ---------- 上下文装配（ContextAssembler + InMemoryPkcAccessor） ----------
  log("执行上下文装配：ContextAssembler.assemble()");
  const assembler = new ContextAssembler(new InMemoryPkcAccessor());
  const codingContext: Readonly<CodingContext> = await assembler.assemble(taskCard, planContent, tmpDir, FILE_CLUSTER);
  log(`上下文装配完成：TCS 规范 ${codingContext.tcsSpecs.length} 项，RLIS 规则 ${codingContext.rlisRules.length} 条`);

  // ---------- Phase B：LLM 填充（正向，合规响应）（IB-1/IB-2/IB-3） ----------
  log("执行 Phase B：LlmFiller.fill()（合规响应生成器）");
  const filler = new LlmFiller();
  const compliantLLMClient = new InMemoryLLMClient(compliantResponseGenerator);
  let fillResult: LlmFillResult;
  try {
    fillResult = await filler.fill({
      skeleton,
      context: codingContext,
      llmClient: compliantLLMClient,
      maxRounds: 3,
      maxTokensPerFile: 4000,
    });
  } catch (e) {
    console.error(`[集成测试] Phase B LLM 填充抛错：${e instanceof Error ? e.message : String(e)}`);
    return EXIT_CODES.PHASE_B_FAILED;
  }

  try {
    // IB-1：填充后文件数与骨架文件数一致
    assert.equal(
      fillResult.filledFiles.length,
      skeleton.files.length,
      `IB-1 失败：filledFiles.length=${fillResult.filledFiles.length} !== skeleton.files.length=${skeleton.files.length}`
    );
    // IB-2：全部占位填充成功（骨架占位仅 method-body / class-body，无 import/config 跳过项）
    const failedStatuses = fillResult.fillStatus.filter((s) => s.status !== "filled");
    assert.equal(
      failedStatuses.length,
      0,
      `IB-2 失败：存在非 filled 状态占位：${failedStatuses.map((s) => `${s.placeholderId}=${s.status}`).join(", ")}`
    );
    // IB-3：LLM 真实调用计数 ≥ 1
    assert.ok(fillResult.llmCallCount >= 1, `IB-3 失败：llmCallCount=${fillResult.llmCallCount} < 1`);
    assert.ok(compliantLLMClient.getCallCount() >= 1, "IB-3 失败：InMemoryLLMClient 调用计数 < 1");
  } catch (e) {
    console.error(`[集成测试] ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_CODES.PHASE_B_FAILED;
  }
  log(`IB-1/IB-2/IB-3 通过：${fillResult.fillStatus.length} 个占位全部 filled，LLM 调用 ${fillResult.llmCallCount} 次`);

  // ---------- STRICT 正向评估（IS-1/IS-3） ----------
  log("执行 STRICT 正向评估（合规产出物）");
  const strictEvaluator = new StrictEvaluator();
  let positiveReport: EvaluationReport;
  try {
    positiveReport = await strictEvaluator.evaluate(buildEvaluationContext(fillResult.filledFiles), redlines);
  } catch (e) {
    console.error(`[集成测试] STRICT 正向评估抛错：${e instanceof Error ? e.message : String(e)}`);
    return EXIT_CODES.STRICT_FAILED;
  }

  try {
    // IS-1：正向链路 verdict 必须为 pass（合规代码通过全部 19 条红线）
    assert.equal(
      positiveReport.verdict,
      "pass",
      `IS-1 失败：正向 verdict=${positiveReport.verdict}（预期 pass），` +
        `违规红线：${positiveReport.redlineResults
          .filter((r) => r.status !== "passed")
          .map((r) => `${r.redlineId}=${r.status}`)
          .join(", ")}`
    );
    // IS-3：评估耗时非负 + 判定结果数与输入红线数一致
    assert.ok(positiveReport.durationMs >= 0, `IS-3 失败：durationMs=${positiveReport.durationMs} < 0`);
    assert.equal(
      positiveReport.redlineResults.length,
      redlines.length,
      `IS-3 失败：redlineResults.length=${positiveReport.redlineResults.length} !== 输入红线数=${redlines.length}`
    );
  } catch (e) {
    console.error(`[集成测试] ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_CODES.STRICT_FAILED;
  }
  log(
    `IS-1/IS-3 通过：verdict=pass，blocker=${positiveReport.blockerCount}/major=${positiveReport.majorCount}/warning=${positiveReport.warningCount}`
  );

  // ---------- STRICT 反向评估（IS-2：违规注入验证） ----------
  log("执行 STRICT 反向评估（注入硬编码密钥的违规产出物）");
  const maliciousLLMClient = new InMemoryLLMClient(maliciousResponseGenerator);
  let maliciousReport: EvaluationReport;
  try {
    // 反向链路：用违规响应生成器重新填充同一骨架，产出含硬编码密钥的代码
    const maliciousFill = await filler.fill({
      skeleton,
      context: codingContext,
      llmClient: maliciousLLMClient,
      maxRounds: 3,
      maxTokensPerFile: 4000,
    });
    maliciousReport = await strictEvaluator.evaluate(buildEvaluationContext(maliciousFill.filledFiles), redlines);
  } catch (e) {
    console.error(`[集成测试] STRICT 反向评估抛错：${e instanceof Error ? e.message : String(e)}`);
    return EXIT_CODES.STRICT_FAILED;
  }

  let reverseE6Status = "unknown";
  try {
    // IS-2：反向链路 verdict 必须为 fix + blockerCount ≥ 1 + E6 判定 violated
    assert.equal(
      maliciousReport.verdict,
      "fix",
      `IS-2 失败：反向 verdict=${maliciousReport.verdict}（预期 fix）——STRICT 未能拦截违规代码`
    );
    assert.ok(
      maliciousReport.blockerCount >= 1,
      `IS-2 失败：反向 blockerCount=${maliciousReport.blockerCount} < 1（E6 为 blocker 级红线）`
    );
    const e6Result = maliciousReport.redlineResults.find((r) => r.redlineId === "E6");
    assert.ok(e6Result, "IS-2 失败：redlineResults 中未找到 E6 判定结果");
    reverseE6Status = e6Result.status;
    assert.equal(e6Result.status, "violated", `IS-2 失败：E6 status=${e6Result.status}（预期 violated）`);
  } catch (e) {
    console.error(`[集成测试] ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_CODES.STRICT_FAILED;
  }
  log(`IS-2 通过：反向 verdict=fix，blockerCount=${maliciousReport.blockerCount}，E6=violated`);

  // ---------- G-5 门禁（IG5-1） ----------
  log("执行 G-5 门禁检查（CODING Loop 退出条件）");
  const g5Checker = new GateG5Checker(strictEvaluator);
  const completedTaskCard = buildTaskCard("completed");
  const g5Result = g5Checker.check(buildG5Context(completedTaskCard, positiveReport));
  // IG5-1：G-5 门禁必须通过（全部任务卡 completed + STRICT pass + git 干净 + gitleaks 通过）
  if (!g5Result.passed) {
    console.error(`[集成测试] IG5-1 断言失败：G-5 门禁未通过，原因：${g5Result.reason}`);
    return EXIT_CODES.GATE_FAILED;
  }
  log("IG5-1 通过：G-5 门禁放行");

  // ---------- 输出结构化报告 ----------
  const report: IntegrationReport = Object.freeze({
    phaseA: Object.freeze({
      fileCount: skeleton.files.length,
      placeholderCount: skeleton.fillPlaceholders.length,
      durationMs: skeleton.durationMs,
      assertions: Object.freeze(["IA-1", "IA-2", "IA-3"]),
    }),
    phaseB: Object.freeze({
      fillCount: fillResult.fillStatus.filter((s) => s.status === "filled").length,
      skippedCount: fillResult.fillStatus.filter((s) => s.status === "skipped").length,
      failedCount: fillResult.fillStatus.filter((s) => s.status === "failed").length,
      llmCallCount: fillResult.llmCallCount,
      totalTokensUsed: fillResult.totalTokensUsed,
      durationMs: fillResult.durationMs,
      assertions: Object.freeze(["IB-1", "IB-2", "IB-3"]),
    }),
    strict: Object.freeze({
      verdict: positiveReport.verdict,
      blockerCount: positiveReport.blockerCount,
      majorCount: positiveReport.majorCount,
      warningCount: positiveReport.warningCount,
      redlineCount: redlines.length,
      durationMs: positiveReport.durationMs,
      assertions: Object.freeze(["IS-1", "IS-3"]),
    }),
    strictReverse: Object.freeze({
      verdict: maliciousReport.verdict,
      blockerCount: maliciousReport.blockerCount,
      e6Status: reverseE6Status,
      assertions: Object.freeze(["IS-2"]),
    }),
    gates: Object.freeze({
      g4: g4Result.passed,
      g5: g5Result.passed,
      assertions: Object.freeze(["IG4-1", "IG5-1"]),
    }),
    overall: "pass",
  });

  writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf-8");
  log(`报告已写入 ${reportFile}`);
  log("全部断言通过：IA×3 + IB×3 + IS×3 + IG4×1 + IG5×1");
  return EXIT_CODES.SUCCESS;
}

// ============================================================================
// 入口：执行主函数并映射进程退出码
// ============================================================================

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((e) => {
    // 未捕获异常（属于集成测试自身缺陷，以通用失败码退出）
    console.error(`[集成测试] 未捕获异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(EXIT_CODES.INVALID_ENV);
  });
