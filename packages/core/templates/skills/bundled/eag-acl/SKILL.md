---
name: eag-acl
description: EAG 防腐层 Skill 包——防腐层模式、外部模型翻译、隔离腐化。Use when 在外部系统集成场景下唤起，辅助独立开发者实现 ACL 模式，隔离外部系统模型对内部领域模型的腐化，适用于全部 4 个范式（DDD 分层/Clean Architecture/CQRS-ES/微服务）。
triggers:
  - 防腐层
  - ACL
  - anti-corruption layer
  - 外部系统集成
  - 模型翻译
  - 适配器
  - 翻译器
  - 隔离腐化
---

# EAG 防腐层（ACL）Skill 包

本 Skill 包是 EAG（企业应用生成）体系外部系统集成场景下的辅助材料，
为独立开发者角色提供防腐层（Anti-Corruption Layer）模式的实现指引。

## 适用范围

- **唤起阶段**：CODING Loop（外部系统集成场景）
- **适用范式**：全部 4 个范式（ddd-layered / clean-architecture / cqrs-es / microservice）
- **唤起条件**：识别到外部系统调用（如调用第三方 API、遗留系统接口、SaaS 服务）时唤起

## 核心概念

### 防腐层（ACL）定义

防腐层是 DDD 战术模式之一，作用：
- **隔离外部模型**：将外部系统的数据模型翻译为内部领域模型，避免外部模型污染内部
- **封装协议差异**：屏蔽外部 API 的协议（HTTP/gRPC/SOAP）、错误模型、版本差异
- **保护领域纯净**：内部领域层只与 ACL 交互，不直接耦合外部系统

### 为何需要 ACL

无 ACL 时的常见腐化场景：
1. **外部模型字段直入领域层**：`LegacyOrderDTO` 直接作为领域实体字段，外部字段变更波及领域层
2. **外部错误模型泄漏**：外部系统的 `LegacyError` 在领域层抛出，错误处理逻辑散乱
3. **协议耦合**：领域层直接 `import` 第三方 SDK，协议升级需修改领域层
4. **测试困难**：领域层依赖外部系统，单元测试需要 mock 大量外部依赖

## 核心方法

### 方法 1：ACL 三件套——适配器 + 翻译器 + 门面

ACL 由三个核心组件构成：

**1. 适配器（Adapter）**：封装外部 API 调用，处理协议、认证、错误转换
```typescript
// 适配器：封装外部 API 调用细节
export class LegacyOrderAdapter {
  constructor(private readonly httpClient: HttpClient) {}

  async fetchOrder(orderId: string): Promise<LegacyOrderDTO> {
    // 协议处理（HTTP）、认证、错误转换
    try {
      const response = await this.httpClient.get(`/api/legacy/orders/${orderId}`);
      return response.data as LegacyOrderDTO;
    } catch (error) {
      // 将外部错误转换为内部错误模型
      if (error.status === 404) throw new OrderNotFoundError(orderId);
      throw new ExternalSystemError('LegacyOrder', error.message);
    }
  }
}
```

**2. 翻译器（Translator）**：将外部模型翻译为内部领域模型
```typescript
// 翻译器：外部 DTO → 内部领域模型
export class OrderTranslator {
  toDomain(dto: LegacyOrderDTO): OrderAggregate {
    // 字段映射 + 业务规则适配
    return OrderAggregate.reconstitute(
      new OrderId(dto.ord_id),          // 外部字段 ord_id → 内部 orderId
      new CustomerId(dto.cust_no),      // 外部字段 cust_no → 内部 customerId
      dto.line_items.map(item => new OrderLineEntity(
        new ProductId(item.prod_code),
        item.qty,
        MoneyVO.from(item.unit_price, dto.currency)
      )),
      this.mapLegacyStatus(dto.status), // 状态枚举翻译
      MoneyVO.from(dto.total_amt, dto.currency)
    );
  }

  private mapLegacyStatus(legacyStatus: string): OrderStatus {
    // 外部状态码翻译为内部状态枚举
    const statusMap: Record<string, OrderStatus> = {
      'A': OrderStatus.CREATED,    // Active → Created
      'P': OrderStatus.PAID,      // Paid → Paid
      'S': OrderStatus.SHIPPED,    // Shipped → Shipped
      'C': OrderStatus.CANCELLED,  // Cancelled → Cancelled
    };
    const status = statusMap[legacyStatus];
    if (!status) throw new InvalidLegacyStatusError(legacyStatus);
    return status;
  }
}
```

**3. 门面（Facade）**：对外提供领域语义的接口，内部组合适配器 + 翻译器
```typescript
// 门面：对外暴露领域语义接口，隐藏适配器 + 翻译器实现
export class OrderAclFacade {
  constructor(
    private readonly adapter: LegacyOrderAdapter,
    private readonly translator: OrderTranslator
  ) {}

  // 对外提供领域语义方法（不暴露 LegacyOrderDTO）
  async findOrder(orderId: OrderId): Promise<OrderAggregate | null> {
    try {
      const dto = await this.adapter.fetchOrder(orderId.value);
      return this.translator.toDomain(dto);
    } catch (error) {
      if (error instanceof OrderNotFoundError) return null;
      throw error;  // 其他错误向上抛
    }
  }
}
```

### 方法 2：外部模型翻译规则

翻译器（Translator）的设计规则：

**规则 1：字段映射集中管理**
- 翻译逻辑集中在 Translator 类，不散落在领域层
- 外部字段名变更时仅修改 Translator

**规则 2：类型转换显式化**
- 外部字符串日期 → 内部 Date 对象
- 外部金额字符串 → 内部 MoneyVO（含币种）
- 外部状态码 → 内部枚举

**规则 3：业务规则适配**
- 外部状态码可能与内部枚举不完全对应，需做映射表
- 缺失字段提供默认值或抛错（不静默忽略）

**规则 4：双向翻译**
- 入站翻译：外部 → 内部（fetchOrder）
- 出站翻译：内部 → 外部（saveOrder）—— 若需写回外部系统

### 方法 3：ACL 在分层架构中的位置

ACL 应位于基础设施层（DDD 分层）或适配器层（Clean Architecture）：

```
DDD 分层架构：
├── interfaces/        ← 接口层
├── application/       ← 应用层（调用 ACL 门面）
├── domain/            ← 领域层（仅与 ACL 门面接口交互，不接触 LegacyOrderDTO）
└── infrastructure/
    ├── acl/           ← 防腐层（Adapter + Translator + Facade）
    │   ├── adapter/
    │   ├── translator/
    │   └── facade/
    └── persistence/   ← 持久化实现
```

**依赖规则**：
- application → domain（应用层依赖领域层）
- application → infrastructure.acl.facade（应用层依赖 ACL 门面接口）
- infrastructure.acl → 外部系统 SDK（ACL 封装外部依赖）
- domain 不得直接依赖 infrastructure.acl（避免外部模型污染）

## 输出契约

ACL 实现产出：
- 适配器类（封装外部 API 调用 + 错误转换）
- 翻译器类（外部模型 ↔ 内部领域模型转换）
- 门面类（对外领域语义接口）
- 外部模型 DTO（仅在 ACL 内部使用，不外泄到领域层）

## 与 EAG 红线的关系

- E4 依赖方向：ACL 位于基础设施层，不污染领域层（DEP-DOM-01）
- E5 输入校验：ACL 翻译器对外部数据做字段映射 + 类型转换，相当于输入校验
- E8 API 契约：ACL 门面定义内部领域语义的接口契约

## 反模式警告

- **领域层直接 import 外部 SDK**：未通过 ACL 隔离，领域层被外部绑架
- **外部 DTO 泄漏到领域层**：LegacyOrderDTO 作为领域实体字段，外部字段变更波及领域层
- **翻译器散落各处**：翻译逻辑散落在多个 Service，无集中管理
- **静默忽略字段缺失**：翻译器遇到缺失字段时不报错，导致数据丢失
- **ACL 包含业务逻辑**：ACL 应仅做翻译，业务逻辑应在领域层
