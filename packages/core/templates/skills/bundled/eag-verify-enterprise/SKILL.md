---
name: eag-verify-enterprise
description: EAG 企业红线自检 Skill 包——企业红线自检清单（评估器辅助材料）。Use when 在各 Loop 的 Verification 阶段唤起，作为评估器的辅助材料提供红线判定指引，适用于全部 4 个范式（DDD 分层/Clean Architecture/CQRS-ES/微服务）。
triggers:
  - 企业红线
  - 红线自检
  - 评估器辅助
  - Verification
  - 评估清单
  - E1 事务边界
  - E4 依赖方向
  - E8 API 契约
---

# EAG 企业红线自检 Skill 包

本 Skill 包是 EAG（企业应用生成）体系各 Loop Verification 阶段的辅助材料，
为评估器角色提供 E1~E8 企业红线的判定指引与自检清单。

## 适用范围

- **唤起阶段**：各 Loop（DESIGN/CODING/TESTING）的 Verification 阶段
- **适用范式**：全部 4 个范式（ddd-layered / clean-architecture / cqrs-es / microservice）
- **唤起条件**：Loop 进入 Verification 阶段时默认唤起

## 红线分级体系

EAG 红线按可判定性分级（EAG 方案 §5.1.3）：

| 级别 | 含义 | 误报风险 | 处理策略 |
|------|------|---------|---------|
| **BLOCKER** | 确定性可判定，不过即打回，不可豁免 | 极低 | 必须修复 |
| **MAJOR** | 半确定——静态扫描可查存在性，语义正确性需推理 | 中 | 默认打回，HUMAN_CHECKPOINT 可人工豁免 |
| **WARNING** | 启发式判定，误报风险高 | 高 | 仅提示不打回 |

## E1~E8 红线自检清单

### E1 事务边界（MAJOR）

**判定规则**：跨聚合写操作必须通过 Saga 模式实现最终一致性，禁止单数据库事务跨聚合提交。

**自检步骤**：
1. 扫描所有写操作（聚合根 A 的方法触发聚合根 B 的写方法）
2. 检查是否存在 Saga 编排器或事件发布 + 事件处理器模式
3. 若跨服务写操作，验证 Saga 补偿动作存在且幂等

**通过条件**：
- 跨聚合写操作通过事件异步完成
- 跨服务写操作通过 Saga 编排
- 补偿动作完整且幂等

**失败示例**：
```typescript
// ❌ 违反 E1：跨聚合直接调用写方法
class OrderAggregate {
  markPaid() {
    this.status = OrderStatus.PAID;
    this.inventoryAggregate.deductItems(this.items);  // 跨聚合直接调用
  }
}

// ✅ 正确：通过事件异步完成跨聚合
class OrderAggregate {
  markPaid() {
    this.status = OrderStatus.PAID;
    this.recordEvent(new OrderPaidEvent(this.id, this.items));  // 发布事件
  }
}
// 事件处理器订阅 OrderPaidEvent，更新库存聚合
```

### E2 幂等性（MAJOR）

**判定规则**：所有写接口（API/事件处理器/消息消费者）必须具备幂等性。

**自检步骤**：
1. 检查 API 层是否有幂等键参数（`Idempotency-Key` / `Client-Request-Id`）
2. 检查应用层入口是否有去重表/Redis SETNX 模式
3. 检查事件处理器是否有事件 ID 去重机制
4. 检查状态机类操作的状态转换是否单调（不可逆）

**通过条件**：
- 写接口有幂等键参数
- 应用层有幂等检查逻辑
- 事件处理器有事件 ID 去重

### E3 审计（MAJOR）

**判定规则**：领域对象状态变更必须发布领域事件。

**自检步骤**：
1. 识别所有实体状态变更点（非构造函数的 setter/状态转换方法）
2. 检查每个变更点是否有对应的领域事件发布
3. 验证事件发布在事务提交后异步执行（避免事务回滚但事件已发）
4. 验证事件包含变更前后快照与操作者信息

**通过条件**：
- 每个状态变更点都有对应事件发布
- 事件在事务提交后发布
- 事件包含审计所需信息

### E4 依赖方向（BLOCKER）

**判定规则**：内层不得 import 外层——领域层（domain）不得依赖基础设施层/接口层/应用层。

**自检步骤**：
1. 提取所有源文件的 import 语句
2. 按目录层级判定依赖方向
3. 验证 domain 目录下的文件不 import infrastructure/application/interfaces
4. 验证 entities（Clean Architecture）不 import use-cases/adapters/frameworks

**通过条件**：
- domain/entities 层零外部依赖（除纯函数工具库）
- 外层依赖内层，无反向依赖
- 无循环依赖

**失败示例**：
```typescript
// ❌ 违反 E4：领域层依赖基础设施层
// src/domain/order/aggregate.ts
import { OrderRepositoryImpl } from '../../infrastructure/persistence/order-repository-impl';
// 依赖反转应改为：domain 定义 Repository 接口，infrastructure 实现

// ✅ 正确：domain 定义接口，infrastructure 实现
// src/domain/repositories/order-repository.ts（接口定义）
export interface OrderRepository {
  findById(id: OrderId): Promise<OrderAggregate | null>;
  save(order: OrderAggregate): Promise<void>;
}

// src/infrastructure/persistence/order-repository-impl.ts（实现）
export class OrderRepositoryImpl implements OrderRepository { /* ... */ }
```

### E5 输入校验（MAJOR）

**判定规则**：应用层入口必须校验输入，领域对象构造即验证。

**自检步骤**：
1. 检查 DTO 是否有校验装饰器（class-validator 的 @IsString/@IsInt 等）
2. 检查应用层入口（Controller/Handler）是否调用 validate() 函数
3. 检查领域对象构造函数/工厂方法是否有不变式断言
4. 检查断言失败时是否抛出 DomainError

**通过条件**：
- DTO 有校验装饰器
- 应用层入口有 validate() 调用
- 领域对象构造函数有断言

### E6 密钥与配置（BLOCKER）

**判定规则**：密钥不得硬编码在代码库中，必须通过环境变量/配置中心外部化。

**自检步骤**：
1. 正则匹配常见密钥模式（`API_KEY=xxx` / `password=xxx` / `begin private key` 等）
2. 扫描敏感字段名（apiKey / secret / password / privateKey）
3. 检查 .env 文件是否在 .gitignore 中
4. 检查 .env.example 是否仅含占位符

**通过条件**：
- 无硬编码密钥
- 密钥通过环境变量或配置中心注入
- .env 文件被 gitignore

### E7 贫血模型禁令（WARNING）

**判定规则**：DDD 范式下，实体不得只有 getter/setter 无业务方法。

**自检步骤**：
1. 统计实体类的方法数（排除 getter/setter）
2. 业务方法密度低于阈值（如 < 2 个业务方法）提示
3. 注意：值对象天然无业务方法，本红线不适用

**通过条件**：
- 实体有业务方法（密度 >= 阈值）
- 业务逻辑内聚在实体而非散落在 Service

### E8 API 契约（BLOCKER）

**判定规则**：对外 API 必须有显式契约——DTO 定义 + 错误模型 + 版本号。

**自检步骤**：
1. 检查是否存在 OpenAPI 文件（openapi.json/openapi.yaml）
2. 检查 API 是否有 swagger 装饰器（@ApiProperty/@Operation）
3. 检查 API 路径是否包含版本号（/api/v1/...）
4. 检查错误模型是否定义（ErrorDTO 含 code/message/details）
5. 检查是否有契约测试（pact.json / Spring Cloud Contract）

**通过条件**：
- API 有 OpenAPI 注解或契约文件
- API 路径包含版本号
- 错误模型已定义
- 契约测试存在

## 范式专项红线

除 E1~E8 通用红线外，各范式有额外依赖规则与反模式需检查：

| 范式 | 额外检查项 |
|------|-----------|
| ddd-layered | DEP-DOM-01/02/03 依赖方向、AP-ANEMIC-01 贫血模型、AP-CROSS-AGG-01 跨聚合引用 |
| clean-architecture | DEP-ENT-01 实体层零依赖、AP-OUTER-INV-01 外层侵入内层、AP-ENT-FRAMEWORK-01 实体依赖框架 |
| cqrs-es | DEP-CMD-Q-01 命令侧不读查询侧、AP-CMD-QUERY-01 命令侧直接查询、AP-NO-IDEMP-01 事件缺失幂等 |
| microservice | DEP-SVC-DB-01 服务不共享数据库、AP-SHARED-DB-01 共享数据库反模式、AP-SAGA-NO-COMP-01 Saga 缺补偿 |

## 评估流程

**STRICT 模式默认流程**（EAG 默认）：
1. 遍历 E1~E8 全部红线
2. 范式专项依赖规则与反模式
3. 任一 BLOCKER 违规 → FIX（不可豁免）
4. 任一 MAJOR 违规 → FIX（可人工豁免）
5. 仅有 WARNING → PASS（提示不打回）
6. 全部通过 → PASS

**人工检查点豁免流程**：
- MAJOR 级违规在 HUMAN_CHECKPOINT 可申请豁免
- 豁免需记录豁免理由 + 评审人 + 豁免日期
- 豁免记录写入审计日志

## 输出契约

Verification 阶段产出 EvaluationReport：
- verdict（pass/fix/human_checkpoint/stop_failure）
- 各红线判定结果（passed/violated/unknown）
- BLOCKER/MAJOR/WARNING 违规数统计
- 修复建议汇总（按优先级排序）
