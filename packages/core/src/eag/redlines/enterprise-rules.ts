/**
 * 企业级应用生成红线清单（E1~E8）
 *
 * 实现 EAG 方案 §5.1.3 企业红线清单：
 * 在 Ponytail 16 条红线（输入校验/错误处理/安全/事务边界等）基础上扩展企业级条目，
 * 作为评估器 STRICT 模式的判定清单。
 *
 * 红线按可判定性分级（评审 T-1 共识）：
 * - BLOCKER：确定性可判定，不过即打回，不可豁免
 * - MAJOR：半确定——静态扫描可查存在性但语义正确性需推理，打回但可在 HUMAN_CHECKPOINT 人工豁免
 * - WARNING：启发式判定，误报风险高，仅提示不打回
 *
 * 红线清单（E1~E8，对应方案表格）：
 * | #  | 红线         | 级别    | 判定方式 |
 * |----|--------------|---------|---------|
 * | E1 | 事务边界     | MAJOR   | 静态扫描跨聚合写调用 + Saga 模式存在性 |
 * | E2 | 幂等性       | MAJOR   | API 层幂等键参数/去重表检查 |
 * | E3 | 审计         | MAJOR   | 实体状态变更点 vs 事件发布点比对 |
 * | E4 | 依赖方向     | BLOCKER | import 静态分析（domain 不得依赖 infrastructure） |
 * | E5 | 输入校验     | MAJOR   | DTO 校验装饰器/构造函数断言检查 |
 * | E6 | 密钥与配置   | BLOCKER | 硬编码密钥模式扫描 |
 * | E7 | 贫血模型禁令 | WARNING | 实体方法密度启发式 |
 * | E8 | API 契约     | BLOCKER | OpenAPI/契约测试存在性 |
 *
 * 复用关系：
 * - 复用 EAG-P0 `packages/core/src/eag/evaluator/types.ts` 的 RedlineDefinition 接口
 * - 红线级别使用 P0 已定义的 RedlineSeverity 类型（"blocker" | "major" | "warning"）
 * - 本模块仅定义红线"规则"，不实现"判定逻辑"（判定逻辑由 IndependentEvaluator 实现方提供）
 *
 * @module eag/redlines/enterprise-rules
 */

import type { RedlineDefinition, RedlineSeverity } from "../evaluator/types";

// ============================================================================
// E1~E8 企业红线定义
// ============================================================================

/**
 * 企业红线清单（E1~E8）
 *
 * 8 条红线按方案 §5.1.3 表格定义，使用 ReadonlyArray + Object.freeze 冻结，
 * 防止运行期被修改（评估器判定清单不可被 LLM 自改，对齐 §5.12.4 G-A6d 配置冻结原则）。
 *
 * 字段说明：
 * - id：红线唯一 ID（"E1" ~ "E8"）
 * - name：红线名称（中文，便于审计日志）
 * - description：详细描述（什么场景触发、为什么重要）
 * - severity：级别（BLOCKER/MAJOR/WARNING）
 * - checkMethod：判定方式描述（评估器实现方据此选择判定算法）
 * - checkType：判定方式类型（static 静态可判 / reasoning 推理判定）
 * - fixGuidance：修复建议模板（评估器判定不通过时附带）
 */
export const ENTERPRISE_REDLINES: ReadonlyArray<RedlineDefinition> = Object.freeze([
  // E1: 事务边界
  {
    id: "E1",
    name: "事务边界",
    description:
      "跨聚合写操作必须通过 Saga 模式实现最终一致性，禁止单数据库事务跨聚合提交。" +
      "事务边界即一致性边界——聚合内强一致、聚合间最终一致是 DDD 的核心约束。" +
      "违反将导致部分提交、数据不一致，且难以通过测试发现（需高并发场景才暴露）。",
    severity: "major",
    checkMethod:
      "静态扫描跨聚合写调用（聚合根 A 的方法直接调用聚合根 B 的写方法）+ Saga 模式存在性检查（搜索 Saga/Orchestrator/CompensateAction 类定义）",
    checkType: "static",
    fixGuidance:
      "1. 识别跨聚合写操作的位置（聚合根 A.method() 调用聚合根 B.setX()）\n" +
      "2. 将跨聚合写重构为领域事件发布 + 事件处理器异步更新\n" +
      "3. 如需跨服务事务，引入 Saga 编排器（eag-saga-orchestration skill）\n" +
      "4. 补偿动作必须幂等且可重试",
  },
  // E2: 幂等性
  {
    id: "E2",
    name: "幂等性",
    description:
      "所有写接口（API/事件处理器/消息消费者）必须具备幂等性——" +
      "通过幂等键参数（Client-Request-Id/Idempotency-Key）或天然幂等语义（如基于状态机的状态转换）保证。" +
      "缺少幂等性将导致网络重试/消息重投递时产生重复写入，引发业务故障（重复扣款/重复下单等）。",
    severity: "major",
    checkMethod:
      "API 层幂等键参数检查（搜索 Idempotency-Key/Client-Request-Id 参数声明）+ 去重表/Redis SETNX 模式存在性检查。" +
      "存在性可静态判定，语义正确性（键生成是否唯一/去重表 TTL 是否合理）需推理判定。",
    checkType: "static",
    fixGuidance:
      "1. 为每个写接口添加 Idempotency-Key 请求头参数\n" +
      "2. 在应用层入口处检查幂等键是否已处理（去重表/Redis）\n" +
      "3. 已处理则直接返回缓存结果，未处理则执行业务并记录键\n" +
      "4. 对于状态机类操作，确保状态转换是单调的（A→B 不可逆）",
  },
  // E3: 审计
  {
    id: "E3",
    name: "审计",
    description:
      "领域对象状态变更必须发布领域事件，以便审计系统追踪业务操作轨迹。" +
      "审计事件是事后追溯的依据——缺少事件发布的变更将无法被审计系统捕获，违反合规要求（如金融/医疗行业的监管要求）。",
    severity: "major",
    checkMethod:
      "实体状态变更点（setter/状态转换方法）vs 事件发布点（DomainEvent publish）的比对。" +
      "静态扫描可识别变更点与发布点的数量差异，但语义匹配（每个变更都有对应事件）需推理判定。",
    checkType: "reasoning",
    fixGuidance:
      "1. 识别所有实体状态变更点（非构造函数的 setter/状态转换方法）\n" +
      "2. 为每个变更点添加对应的领域事件发布（如 UserRegistered/UserEmailChanged）\n" +
      "3. 事件应包含变更前后的快照（before/after）与操作者信息\n" +
      "4. 事件发布必须在事务提交后异步执行（避免事务回滚但事件已发）",
  },
  // E4: 依赖方向
  {
    id: "E4",
    name: "依赖方向",
    description:
      "内层不得 import 外层——领域层（domain）不得依赖基础设施层（infrastructure）/接口层（interfaces）/应用层（application）。" +
      "依赖反转是 DDD/Clean Architecture 的核心约束，违反将导致领域层被基础设施绑架，无法独立测试与演进。",
    severity: "blocker",
    checkMethod:
      "import 静态分析——提取源文件的 import 语句，按目录层级判定依赖方向。" +
      "CODING Loop 内增量扫描：仅对当轮产出文件做正则 import 提取，复用 regex-analyzer，不每轮重建 CodeMap。",
    checkType: "static",
    fixGuidance:
      "1. 识别违规 import 语句（domain/*.ts 中 import infrastructure/*）\n" +
      "2. 通过依赖反转修复：在 domain 层定义 Repository 接口，infrastructure 层实现该接口\n" +
      "3. 在应用层通过依赖注入组装接口与实现\n" +
      "4. 配置 lint 规则（如 dependency-cruiser）自动检测违规",
  },
  // E5: 输入校验
  {
    id: "E5",
    name: "输入校验",
    description:
      "应用层入口必须校验输入，领域对象构造即验证（在构造函数/工厂方法中执行不变式断言）。" +
      "未校验的输入将导致脏数据进入领域层，破坏聚合不变式，引发难以追踪的业务故障。",
    severity: "major",
    checkMethod:
      "DTO 校验装饰器检查（搜索 class-validator 的 @IsString/@IsInt 等装饰器）+" +
      "领域对象构造函数断言检查（搜索 invariant/assert/throw 语句）。" +
      "装饰器/断言存在性可静态判定，覆盖完整性需推理判定。",
    checkType: "static",
    fixGuidance:
      "1. 为每个 DTO 添加 class-validator 装饰器（@IsString/@IsInt/@IsEmail 等）\n" +
      "2. 在应用层入口（Controller/Handler）调用 validate() 函数\n" +
      "3. 在领域对象构造函数/工厂方法中添加不变式断言（如 amount > 0）\n" +
      "4. 断言失败抛出 DomainError，由全局异常处理器转换为 4xx 响应",
  },
  // E6: 密钥与配置
  {
    id: "E6",
    name: "密钥与配置",
    description:
      "密钥（API Key/数据库密码/私钥）不得硬编码在代码库中，必须通过环境变量/配置中心/Secret Manager 外部化注入。" +
      "硬编码密钥将导致：1) 代码库泄露即凭据泄露 2) 凭据轮换需重新发布 3) 多环境配置混乱。",
    severity: "blocker",
    checkMethod:
      "硬编码密钥模式扫描——正则匹配常见密钥模式（API_KEY=xxx/password=xxx/begin private key 等）+" +
      "敏感字段名扫描（apiKey/secret/password/privateKey）。" +
      "误报可通过 .env.example 占位符白名单消除。",
    checkType: "static",
    fixGuidance:
      "1. 识别所有硬编码密钥位置（grep -E '(api[_-]?key|password|secret)\\s*[:=]'）\n" +
      "2. 替换为环境变量读取（process.env.API_KEY）\n" +
      "3. 配置中心（Apollo/Nacos/Vault）管理多环境配置\n" +
      "4. 在 .gitignore 中排除 .env 文件，仅提交 .env.example 模板\n" +
      "5. 接入 gitleaks/truffleHog 在 CI 阶段扫描",
  },
  // E7: 贫血模型禁令
  {
    id: "E7",
    name: "贫血模型禁令",
    description:
      "DDD 范式下，实体不得只有 getter/setter 无业务方法——业务逻辑应内聚在实体中，而非散落在 Service 层。" +
      "贫血模型是反模式：将数据与行为分离，导致业务逻辑分散、领域层退化为 DTO 层、测试困难。" +
      "注意：值对象天然无业务方法（仅持有值），本红线仅适用于实体。",
    severity: "warning",
    checkMethod:
      "实体方法密度启发式——统计实体类的方法数（排除 getter/setter），密度低于阈值（如 <2 个业务方法）则提示。" +
      "启发式判定误报风险高（如某些实体确实只持有状态），仅 WARNING 不打回。",
    checkType: "reasoning",
    fixGuidance:
      "1. 识别贫血实体（仅有 getter/setter 的实体类）\n" +
      "2. 将相关业务逻辑从 Service 层迁移到实体方法（如 User.changePassword() 取代 UserService.changePassword()）\n" +
      "3. 不变式断言内聚到实体方法（如 User.changePassword() 中校验新密码强度）\n" +
      "4. 注意：值对象（Value Object）天然无业务方法，本红线不适用",
  },
  // E8: API 契约
  {
    id: "E8",
    name: "API 契约",
    description:
      "对外 API 必须有显式契约——DTO 定义 + 错误模型 + 版本号。契约是前后端/服务间协作的依据，" +
      "缺少契约将导致：1) 调用方不知道接口形状 2) 接口变更无向后兼容保证 3) 无法生成文档与客户端 SDK。",
    severity: "blocker",
    checkMethod:
      "OpenAPI/契约测试存在性检查——搜索 openapi.json/openapi.yaml 文件或 @ApiProperty/swagger 装饰器；" +
      "契约测试存在性检查（pact.json 文件或 pact-creator 测试用例）。" +
      "存在性可静态判定，与代码一致性需推理判定或通过契约测试验证。",
    checkType: "static",
    fixGuidance:
      "1. 为每个对外 API 添加 OpenAPI 注解（@Operation/@ApiResponse 等）\n" +
      "2. 定义请求/响应 DTO，添加 @ApiProperty 描述字段含义\n" +
      "3. 定义错误模型（ErrorDTO 含 code/message/details）\n" +
      "4. 在 API 路径中包含版本号（/api/v1/users）\n" +
      "5. 引入契约测试（Pact/Spring Cloud Contract）验证生产者与消费者一致性",
  },
]);

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 按严重级别过滤红线
 *
 * @param severity 严重级别（blocker / major / warning）
 * @returns 该级别的红线列表（只读）
 */
export function getRedlinesBySeverity(severity: RedlineSeverity): ReadonlyArray<RedlineDefinition> {
  return ENTERPRISE_REDLINES.filter((r) => r.severity === severity);
}

/**
 * 按 ID 查找红线
 *
 * @param id 红线 ID（如 "E1"、"E4"）
 * @returns 红线定义；未找到返回 null
 */
export function getRedlineById(id: string): RedlineDefinition | null {
  return ENTERPRISE_REDLINES.find((r) => r.id === id) ?? null;
}

/**
 * 获取企业红线总数
 *
 * @returns 红线数量（当前为 8）
 */
export function getEnterpriseRedlineCount(): number {
  return ENTERPRISE_REDLINES.length;
}
