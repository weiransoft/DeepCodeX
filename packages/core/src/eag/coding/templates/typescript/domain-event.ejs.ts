/**
 * 领域事件 EJS 模板（EAG-P2 批次 9 S1 基础层）
 *
 * 对应 EAG-P2 批次 9 设计 §4.2 templates/typescript/domain-event.ejs。
 * 领域事件特征：不可变 / 含事件 ID 与时间戳 / 描述领域状态变更 / 用于事件溯源与异步通信。
 *
 * 模板变量：
 * - moduleName：模块名
 * - modulePath：模块路径
 * - responsibility：模块职责描述
 * - requirementId：关联需求 ID
 * - taskId：关联任务卡 ID
 * - eventName：事件类名（如 "OrderCreated" / "UserRegistered"）
 * - aggregateName：发布该事件的聚合根类名
 * - fields：事件载荷字段列表 [{ name, type, description }]
 *
 * 占位标记：
 * - TODO(phase-b): 实现事件工厂方法
 *
 * @module eag/coding/templates/typescript/domain-event
 */

/**
 * 领域事件 EJS 模板字符串
 *
 * 渲染时由 SkeletonGenerator 调用 ejs.render(DOMAIN_EVENT_TEMPLATE, variables) 输出骨架代码。
 */
export const DOMAIN_EVENT_TEMPLATE = `/**
 * <%- eventName %> 领域事件
 *
 * 模块职责：<%- responsibility %>
 *
 * 关联需求：<%- requirementId %>
 * 关联任务：<%- taskId %>
 *
 * @module <%- modulePath %>
 */

/**
 * DomainEvent 基础接口（所有领域事件必须实现）
 *
 * 字段说明：
 * - eventId：事件唯一 ID（UUID v4，用于幂等去重）
 * - eventType：事件类型（如 "OrderCreated"）
 * - aggregateId：发布事件的聚合根 ID
 * - occurredAt：事件发生时间（ISO 8601）
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
 * <%- eventName %> 事件载荷
 */
export interface <%- eventName %>Payload {
<%_ for (const field of fields) { _%>
  /** <%- field.description %> */
  readonly <%- field.name %>: <%- field.type %>;
<%_ } _%>
}

/**
 * <%- eventName %> 领域事件
 *
 * <%- responsibility %>
 *
 * 触发场景：
 * - <%- aggregateName %> 聚合执行业务方法后发布
 * - 事件处理器订阅此事件执行异步副作用
 * - 事件存储持久化此事件用于溯源
 */
export class <%- eventName %> implements DomainEvent {
  // ============================ DomainEvent 协议字段 ============================

  /** 事件唯一 ID（UUID v4） */
  readonly eventId: string;
  /** 事件类型（固定为 "<%- eventName %>"） */
  readonly eventType: string = "<%- eventName %>";
  /** 发布事件的聚合根 ID */
  readonly aggregateId: string;
  /** 事件发生时间（ISO 8601 字符串） */
  readonly occurredAt: string;
  /** 聚合版本号（用于乐观锁与事件溯源） */
  readonly version: number;

  // ============================ 事件载荷字段 ============================

<%_ for (const field of fields) { _%>
  /** <%- field.description %> */
  readonly <%- field.name %>: <%- field.type %>;

<%_ } _%>

  // ============================ 构造函数 ============================

  /**
   * 构造 <%- eventName %> 实例（私有，仅通过工厂方法创建）
   *
   * @param props 事件属性（含协议字段与载荷字段）
   */
  private constructor(props: <%- eventName %>Payload & DomainEvent) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.occurredAt = props.occurredAt;
    this.version = props.version;
<%_ for (const field of fields) { _%>
    this.<%- field.name %> = props.<%- field.name %>;
<%_ } _%>
  }

  // ============================ 工厂方法 ============================

  /**
   * 创建 <%- eventName %> 事件
   *
   * 职责：
   * 1. 生成事件 ID（UUID v4）
   * 2. 记录事件发生时间（当前时间 ISO 8601）
   * 3. 携带聚合根 ID 与版本号
   * 4. 封装业务载荷字段
   *
   * // TODO(phase-b): 实现事件工厂方法
   *
   * @param aggregateId 聚合根 ID
   * @param version 聚合版本号
   * @param payload 事件载荷
   * @returns 新建的事件实例
   */
  static create(
    aggregateId: string,
    version: number,
    payload: <%- eventName %>Payload
  ): <%- eventName %> {
    throw new Error("TODO(phase-b): 实现 <%- eventName %>.create 事件工厂方法");
  }

  // ============================ 序列化 ============================

  /**
   * 序列化为 JSON 对象（用于事件存储与消息队列传输）
   *
   * @returns JSON 对象表示
   */
  toJSON(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      occurredAt: this.occurredAt,
      version: this.version,
<%_ for (const field of fields) { _%>
      <%- field.name %>: this.<%- field.name %>,
<%_ } _%>
    };
  }
}
`;
