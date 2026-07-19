/**
 * 模板注册表（EAG-P2 批次 9 S1 基础层）
 *
 * 本模块对应 EAG-P2 批次 9 设计 §4.2.6 模板注册表：
 * 统一管理 13 种 TypeScript 模板的检索与变量校验。
 *
 * 设计依据：
 * - §4.2.2 关键技术决策：模板变量用 zod schema 校验防 LLM 生成非法结构
 * - §4.2.6 模板注册表：TemplateRegistry 协议与 DEFAULT_TEMPLATE_REGISTRY 实现
 * - D-12 决策：模板字符串通过 .ejs.ts 文件以 const 字符串形式内嵌导出，
 *   避免 Node ESM 读取 .ejs 文件的路径问题
 *
 * 不可变优先原则：
 * - DEFAULT_TEMPLATE_REGISTRY 使用 Object.freeze 冻结
 * - 模板字符串常量使用 as const 断言
 * - Schema 映射使用 Object.freeze 冻结
 *
 * @module eag/coding/templates
 */

import { z } from "zod";
import type { GeneratedFileKind, TemplateRegistry, TemplateVariableSchema } from "../types";

// ============================================================================
// 1. 13 种 EJS 模板字符串导入
// ============================================================================

import { AGGREGATE_TEMPLATE } from "./typescript/aggregate.ejs";
import { VALUE_OBJECT_TEMPLATE } from "./typescript/value-object.ejs";
import { DOMAIN_EVENT_TEMPLATE } from "./typescript/domain-event.ejs";
import { DOMAIN_SERVICE_TEMPLATE } from "./typescript/domain-service.ejs";
import { REPOSITORY_PORT_TEMPLATE } from "./typescript/repository-port.ejs";
import { REPOSITORY_IMPL_TEMPLATE } from "./typescript/repository-impl.ejs";
import { APPLICATION_SERVICE_TEMPLATE } from "./typescript/application-service.ejs";
import { DTO_TEMPLATE } from "./typescript/dto.ejs";
import { REST_CONTROLLER_TEMPLATE } from "./typescript/rest-controller.ejs";
import { SAGA_ORCHESTRATOR_TEMPLATE } from "./typescript/saga-orchestrator.ejs";
import { EVENT_HANDLER_TEMPLATE } from "./typescript/event-handler.ejs";
import { TEST_SPEC_TEMPLATE } from "./typescript/test-spec.ejs";
import { MODULE_INDEX_TEMPLATE } from "./typescript/module-index.ejs";

// ============================================================================
// 2. 通用 zod schema 子模块（字段定义复用）
// ============================================================================

/**
 * 通用模块元数据 schema（所有 kind 共享）
 *
 * 5 个字段所有模板都需要：
 * - moduleName：模块名
 * - modulePath：模块路径
 * - responsibility：模块职责描述
 * - requirementId：关联需求 ID（F-NNN 格式）
 * - taskId：关联任务卡 ID（T-NNN 格式）
 */
const moduleMetaSchema = z.object({
  /** 模块名（如 "OrderAggregate"） */
  moduleName: z.string().min(1),
  /** 模块路径（如 "domain/order/OrderAggregate"） */
  modulePath: z.string().min(1),
  /** 模块职责描述（一句话） */
  responsibility: z.string().min(1),
  /** 关联需求 ID（F-NNN 格式） */
  requirementId: z.string().regex(/^F-\d{3}$/),
  /** 关联任务卡 ID（T-NNN 格式） */
  taskId: z.string().regex(/^T-\d{3}$/),
});

/**
 * 字段定义 schema（用于 aggregate / value-object / domain-event / dto）
 *
 * 描述单个字段：名称、类型、说明、校验规则。
 */
const fieldSchema = z.object({
  /** 字段名（小驼峰，如 "orderId"） */
  name: z.string().min(1),
  /** 字段类型（TypeScript 类型，如 "string" / "number" / "UserId"） */
  type: z.string().min(1),
  /** 字段描述（中文，用于 JSDoc） */
  description: z.string().min(1),
  /** 校验规则（仅 DTO 使用，如 "@IsString() @IsNotEmpty()"） */
  validationRule: z.string().optional(),
});

/**
 * 业务方法定义 schema（用于 aggregate）
 */
const businessMethodSchema = z.object({
  /** 方法名（小驼峰，如 "cancel"） */
  name: z.string().min(1),
  /** 方法描述（中文） */
  description: z.string().min(1),
  /** 命令类型（如 "OrderCancelCommand"） */
  commandType: z.string().min(1),
});

/**
 * 依赖定义 schema（用于 domain-service / application-service / event-handler）
 */
const dependencySchema = z.object({
  /** 依赖参数名（小驼峰，如 "orderRepository"） */
  name: z.string().min(1),
  /** 依赖类型（如 "OrderRepository"） */
  type: z.string().min(1),
  /** 导入路径（如 "../domain/order/OrderRepository"） */
  importPath: z.string().min(1),
});

/**
 * 服务方法定义 schema（用于 domain-service）
 */
const serviceMethodSchema = z.object({
  /** 方法名 */
  name: z.string().min(1),
  /** 方法描述 */
  description: z.string().min(1),
  /** 输入类型 */
  inputType: z.string().min(1),
  /** 输出类型 */
  outputType: z.string().min(1),
});

/**
 * 查询方法定义 schema（用于 repository-port）
 */
const queryMethodSchema = z.object({
  /** 方法名 */
  name: z.string().min(1),
  /** 方法描述 */
  description: z.string().min(1),
  /** 输入类型 */
  inputType: z.string().min(1),
  /** 输出类型 */
  outputType: z.string().min(1),
});

/**
 * 用例方法定义 schema（用于 application-service）
 */
const useCaseSchema = z.object({
  /** 用例方法名 */
  name: z.string().min(1),
  /** 用例描述 */
  description: z.string().min(1),
  /** 输入 DTO 类型 */
  inputDto: z.string().min(1),
  /** 输出 DTO 类型 */
  outputDto: z.string().min(1),
});

/**
 * 端点定义 schema（用于 rest-controller）
 */
const endpointSchema = z.object({
  /** HTTP 方法 */
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  /** 端点路径（如 "/:id"） */
  path: z.string().min(1),
  /** 端点方法名 */
  name: z.string().min(1),
  /** 端点描述 */
  description: z.string().min(1),
  /** 输入 DTO 类型 */
  inputDto: z.string().min(1),
  /** 输出 DTO 类型 */
  outputDto: z.string().min(1),
  /** 是否幂等 */
  idempotent: z.boolean(),
});

/**
 * Saga 步骤定义 schema（用于 saga-orchestrator）
 */
const sagaStepSchema = z.object({
  /** 步骤名 */
  name: z.string().min(1),
  /** 步骤描述 */
  description: z.string().min(1),
  /** 执行动作 */
  action: z.string().min(1),
  /** 补偿动作 */
  compensation: z.string().min(1),
});

/**
 * 测试用例定义 schema（用于 test-spec）
 */
const testCaseSchema = z.object({
  /** 测试用例名 */
  name: z.string().min(1),
  /** 测试用例描述 */
  description: z.string().min(1),
  /** Given 条件 */
  given: z.string().min(1),
  /** When 操作 */
  when: z.string().min(1),
  /** Then 预期 */
  then: z.string().min(1),
});

/**
 * 模块导出定义 schema（用于 module-index）
 */
const exportSchema = z.object({
  /** 导出符号名 */
  symbol: z.string().min(1),
  /** 导出路径 */
  path: z.string().min(1),
  /** 导出类型 */
  type: z.enum(["class", "interface", "type", "function", "constant"]),
});

// ============================================================================
// 3. 13 种 kind 的 zod schema 定义
// ============================================================================

/**
 * aggregate 模板变量 schema
 *
 * 变量：模块元数据 + 聚合根类名 + 领域事件文件名 + 字段列表 + 业务方法列表
 */
const aggregateVariableSchema = moduleMetaSchema.extend({
  /** 聚合根类名（如 "OrderAggregate"） */
  aggregateName: z.string().min(1),
  /** 领域事件文件名（如 "OrderCreated"） */
  domainEventFileName: z.string().min(1),
  /** 字段列表（至少 1 个字段） */
  fields: z.array(fieldSchema).min(1),
  /** 业务方法列表（可为空） */
  businessMethods: z.array(businessMethodSchema),
});

/**
 * value-object 模板变量 schema
 *
 * 变量：模块元数据 + 值对象类名 + 字段列表
 */
const valueObjectVariableSchema = moduleMetaSchema.extend({
  /** 值对象类名（如 "Money" / "Address"） */
  valueObjectName: z.string().min(1),
  /** 字段列表（至少 1 个字段） */
  fields: z.array(fieldSchema).min(1),
});

/**
 * domain-event 模板变量 schema
 *
 * 变量：模块元数据 + 事件名 + 聚合根类名 + 载荷字段列表
 */
const domainEventVariableSchema = moduleMetaSchema.extend({
  /** 事件类名（如 "OrderCreated"） */
  eventName: z.string().min(1),
  /** 发布该事件的聚合根类名 */
  aggregateName: z.string().min(1),
  /** 事件载荷字段列表 */
  fields: z.array(fieldSchema),
});

/**
 * domain-service 模板变量 schema
 *
 * 变量：模块元数据 + 服务类名 + 依赖列表 + 方法列表
 */
const domainServiceVariableSchema = moduleMetaSchema.extend({
  /** 服务类名 */
  serviceClassName: z.string().min(1),
  /** 依赖列表 */
  dependencies: z.array(dependencySchema),
  /** 服务方法列表 */
  methods: z.array(serviceMethodSchema),
});

/**
 * repository-port 模板变量 schema
 *
 * 变量：模块元数据 + 聚合根类名 + 聚合根导入路径 + ID 类型 + 查询方法列表
 */
const repositoryPortVariableSchema = moduleMetaSchema.extend({
  /** 聚合根类名 */
  aggregateName: z.string().min(1),
  /** 聚合根导入路径 */
  aggregateImportPath: z.string().min(1),
  /** 聚合根 ID 类型 */
  idType: z.string().min(1),
  /** 查询方法列表 */
  queryMethods: z.array(queryMethodSchema),
});

/**
 * repository-impl 模板变量 schema
 *
 * 变量：模块元数据 + 聚合根类名 + 聚合根导入路径 + 仓储接口导入路径 +
 *       ID 类型 + ORM 类型 + ORM 实体名 + ORM 实体导入路径
 */
const repositoryImplVariableSchema = moduleMetaSchema.extend({
  /** 聚合根类名 */
  aggregateName: z.string().min(1),
  /** 聚合根导入路径 */
  aggregateImportPath: z.string().min(1),
  /** 仓储接口导入路径 */
  portImportPath: z.string().min(1),
  /** 聚合根 ID 类型 */
  idType: z.string().min(1),
  /** ORM 类型（如 "TypeORM" / "Prisma"） */
  ormType: z.string().min(1),
  /** ORM 实体名 */
  ormEntityName: z.string().min(1),
  /** ORM 实体导入路径 */
  ormEntityImportPath: z.string().min(1),
});

/**
 * application-service 模板变量 schema
 *
 * 变量：模块元数据 + 服务类名 + 依赖列表 + 用例方法列表
 */
const applicationServiceVariableSchema = moduleMetaSchema.extend({
  /** 应用服务类名 */
  serviceClassName: z.string().min(1),
  /** 依赖列表 */
  dependencies: z.array(dependencySchema),
  /** 用例方法列表 */
  useCases: z.array(useCaseSchema),
});

/**
 * dto 模板变量 schema
 *
 * 变量：模块元数据 + DTO 类名 + DTO 类型 + 字段列表
 */
const dtoVariableSchema = moduleMetaSchema.extend({
  /** DTO 类名 */
  dtoName: z.string().min(1),
  /** DTO 类型（input 或 output） */
  dtoType: z.enum(["input", "output"]),
  /** 字段列表 */
  fields: z.array(fieldSchema).min(1),
});

/**
 * rest-controller 模板变量 schema
 *
 * 变量：模块元数据 + 控制器类名 + 路由基路径 + 应用服务类名 + 应用服务导入路径 + 端点列表
 */
const restControllerVariableSchema = moduleMetaSchema.extend({
  /** 控制器类名 */
  controllerName: z.string().min(1),
  /** 路由基路径（如 "/api/v1/orders"） */
  basePath: z.string().min(1),
  /** 依赖的应用服务类名 */
  applicationServiceName: z.string().min(1),
  /** 应用服务导入路径 */
  applicationServiceImportPath: z.string().min(1),
  /** 端点列表 */
  endpoints: z.array(endpointSchema).min(1),
});

/**
 * saga-orchestrator 模板变量 schema
 *
 * 变量：模块元数据 + Saga 类名 + 状态列表 + 步骤列表
 */
const sagaOrchestratorVariableSchema = moduleMetaSchema.extend({
  /** Saga 类名 */
  sagaName: z.string().min(1),
  /** Saga 状态列表（至少 2 个：STARTED + COMPLETED/FAILED） */
  sagaStates: z.array(z.string().min(1)).min(2),
  /** 步骤列表 */
  steps: z.array(sagaStepSchema),
});

/**
 * event-handler 模板变量 schema
 *
 * 变量：模块元数据 + 处理器类名 + 事件名 + 事件导入路径 + 依赖列表
 */
const eventHandlerVariableSchema = moduleMetaSchema.extend({
  /** 处理器类名 */
  handlerClassName: z.string().min(1),
  /** 处理的事件名 */
  eventName: z.string().min(1),
  /** 事件导入路径 */
  eventImportPath: z.string().min(1),
  /** 依赖列表 */
  dependencies: z.array(dependencySchema),
});

/**
 * test-spec 模板变量 schema
 *
 * 变量：模块元数据 + 被测类名 + 被测类导入路径 + 测试用例列表
 */
const testSpecVariableSchema = moduleMetaSchema.extend({
  /** 被测类名 */
  targetClassName: z.string().min(1),
  /** 被测类导入路径 */
  targetImportPath: z.string().min(1),
  /** 测试用例列表 */
  testCases: z.array(testCaseSchema),
});

/**
 * module-index 模板变量 schema
 *
 * 变量：模块元数据 + 导出列表
 */
const moduleIndexVariableSchema = moduleMetaSchema.extend({
  /** 导出列表 */
  exports: z.array(exportSchema).min(1),
});

// ============================================================================
// 4. ZodSchemaAdapter：将 zod schema 适配为 TemplateVariableSchema 协议
// ============================================================================

/**
 * ZodSchemaAdapter：将 zod schema 适配为 TemplateVariableSchema 协议
 *
 * 设计目的：
 * - types.ts 中 TemplateVariableSchema 协议不直接依赖 zod（保持 types.ts 零运行时依赖）
 * - 本模块（templates/index.ts）已知 zod 依赖，通过 adapter 桥接
 *
 * 工作机制：
 * - validate(variables) 调用 zod schema.safeParse(variables)
 * - 成功时返回 { success: true, data: parsed }
 * - 失败时返回 { success: false, errors: [...] }
 */
class ZodSchemaAdapter implements TemplateVariableSchema {
  /**
   * @param schema zod schema 实例
   */
  constructor(private readonly schema: z.ZodType) {}

  /**
   * 校验模板变量
   *
   * @param variables 待校验的模板变量对象
   * @returns 校验结果（success=true 时 data 为合法对象；success=false 时 errors 为错误列表）
   */
  validate(variables: Readonly<Record<string, unknown>>): {
    readonly success: boolean;
    readonly data?: Readonly<Record<string, unknown>>;
    readonly errors?: ReadonlyArray<string>;
  } {
    const result = this.schema.safeParse(variables);
    if (result.success) {
      return {
        success: true,
        data: result.data as Readonly<Record<string, unknown>>,
      };
    }
    // 收集所有错误信息（含字段路径）
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    });
    return {
      success: false,
      errors: Object.freeze(errors),
    };
  }
}

// ============================================================================
// 5. 模板与 schema 注册表（kind → { template, schema }）
// ============================================================================

/**
 * 模板条目：单个 kind 的模板字符串 + 变量 schema
 */
interface TemplateEntry {
  /** EJS 模板字符串（含 <%- %> 变量与 <%_ _%> 占位） */
  readonly template: string;
  /** 模板变量 schema（封装为 TemplateVariableSchema 协议） */
  readonly schema: TemplateVariableSchema;
}

/**
 * 13 种 kind 的模板注册映射（kind → TemplateEntry）
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）。
 * 注册顺序对齐 GENERATED_FILE_KINDS。
 */
const TEMPLATE_ENTRIES: Readonly<Record<GeneratedFileKind, TemplateEntry>> = Object.freeze({
  aggregate: Object.freeze({
    template: AGGREGATE_TEMPLATE,
    schema: new ZodSchemaAdapter(aggregateVariableSchema),
  }),
  "value-object": Object.freeze({
    template: VALUE_OBJECT_TEMPLATE,
    schema: new ZodSchemaAdapter(valueObjectVariableSchema),
  }),
  "domain-event": Object.freeze({
    template: DOMAIN_EVENT_TEMPLATE,
    schema: new ZodSchemaAdapter(domainEventVariableSchema),
  }),
  "domain-service": Object.freeze({
    template: DOMAIN_SERVICE_TEMPLATE,
    schema: new ZodSchemaAdapter(domainServiceVariableSchema),
  }),
  "repository-port": Object.freeze({
    template: REPOSITORY_PORT_TEMPLATE,
    schema: new ZodSchemaAdapter(repositoryPortVariableSchema),
  }),
  "repository-impl": Object.freeze({
    template: REPOSITORY_IMPL_TEMPLATE,
    schema: new ZodSchemaAdapter(repositoryImplVariableSchema),
  }),
  "application-service": Object.freeze({
    template: APPLICATION_SERVICE_TEMPLATE,
    schema: new ZodSchemaAdapter(applicationServiceVariableSchema),
  }),
  dto: Object.freeze({
    template: DTO_TEMPLATE,
    schema: new ZodSchemaAdapter(dtoVariableSchema),
  }),
  "rest-controller": Object.freeze({
    template: REST_CONTROLLER_TEMPLATE,
    schema: new ZodSchemaAdapter(restControllerVariableSchema),
  }),
  "saga-orchestrator": Object.freeze({
    template: SAGA_ORCHESTRATOR_TEMPLATE,
    schema: new ZodSchemaAdapter(sagaOrchestratorVariableSchema),
  }),
  "event-handler": Object.freeze({
    template: EVENT_HANDLER_TEMPLATE,
    schema: new ZodSchemaAdapter(eventHandlerVariableSchema),
  }),
  "test-spec": Object.freeze({
    template: TEST_SPEC_TEMPLATE,
    schema: new ZodSchemaAdapter(testSpecVariableSchema),
  }),
  "module-index": Object.freeze({
    template: MODULE_INDEX_TEMPLATE,
    schema: new ZodSchemaAdapter(moduleIndexVariableSchema),
  }),
});

// ============================================================================
// 6. DEFAULT_TEMPLATE_REGISTRY：默认模板注册表实现
// ============================================================================

/**
 * 默认模板注册表（TemplateRegistry 协议实现）
 *
 * 对应 EAG-P2 批次 9 设计 §4.2.6 DEFAULT_TEMPLATE_REGISTRY：
 * 从内嵌的 .ejs.ts 字符串常量中返回模板内容，列出所有已注册的 kind（13 种），
 * 返回对应 kind 的 zod schema（封装为 TemplateVariableSchema 协议）。
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）。
 *
 * 用法：
 * ```typescript
 * const template = DEFAULT_TEMPLATE_REGISTRY.getTemplate("aggregate");
 * const schema = DEFAULT_TEMPLATE_REGISTRY.getVariableSchema("aggregate");
 * const kinds = DEFAULT_TEMPLATE_REGISTRY.listKinds();
 * ```
 */
export const DEFAULT_TEMPLATE_REGISTRY: Readonly<TemplateRegistry> = Object.freeze({
  /**
   * 按 kind 获取模板字符串
   *
   * @param kind 模板类型（13 种之一）
   * @returns EJS 模板字符串
   * @throws {Error} kind 未注册时抛出
   */
  getTemplate(kind: GeneratedFileKind): string {
    const entry = TEMPLATE_ENTRIES[kind];
    if (!entry) {
      throw new Error(`模板未注册：kind=${kind}（请检查 GeneratedFileKind 合法值）`);
    }
    return entry.template;
  },

  /**
   * 列出所有已注册的 kind
   *
   * @returns 已注册的 kind 列表（13 种，使用 Object.freeze 冻结）
   */
  listKinds(): ReadonlyArray<GeneratedFileKind> {
    return Object.keys(TEMPLATE_ENTRIES) as unknown as ReadonlyArray<GeneratedFileKind>;
  },

  /**
   * 获取模板变量 schema
   *
   * @param kind 模板类型
   * @returns 模板变量 zod schema（封装为 TemplateVariableSchema 协议）
   * @throws {Error} kind 未注册时抛出
   */
  getVariableSchema(kind: GeneratedFileKind): TemplateVariableSchema {
    const entry = TEMPLATE_ENTRIES[kind];
    if (!entry) {
      throw new Error(`Schema 未注册：kind=${kind}（请检查 GeneratedFileKind 合法值）`);
    }
    return entry.schema;
  },
});

// ============================================================================
// 7. 便捷函数：getTemplate
// ============================================================================

/**
 * 按 kind 获取模板字符串（便捷函数，委托给 DEFAULT_TEMPLATE_REGISTRY）
 *
 * 对应 EAG-P2 批次 9 设计 §4.2.6 getTemplate(kind) 函数：
 * 调用方无需直接访问 DEFAULT_TEMPLATE_REGISTRY 即可获取模板字符串。
 *
 * @param kind 模板类型（13 种之一）
 * @returns EJS 模板字符串（含 <%- %> 变量与 <%_ _%> 占位）
 * @throws {Error} kind 未注册时抛出
 *
 * @example
 * ```typescript
 * import { getTemplate } from "./templates";
 * const aggregateTemplate = getTemplate("aggregate");
 * const rendered = ejs.render(aggregateTemplate, variables);
 * ```
 */
export function getTemplate(kind: GeneratedFileKind): string {
  return DEFAULT_TEMPLATE_REGISTRY.getTemplate(kind);
}

// ============================================================================
// 8. 重新导出（便于从 templates/index 统一导入）
// ============================================================================

/**
 * 重新导出 13 个 EJS 模板字符串常量
 *
 * 调用方如需直接访问模板字符串（绕过 TemplateRegistry），可从此处导入。
 * 但推荐通过 DEFAULT_TEMPLATE_REGISTRY.getTemplate() 或 getTemplate() 访问，
 * 以保持调用方式一致性。
 */
export {
  AGGREGATE_TEMPLATE,
  VALUE_OBJECT_TEMPLATE,
  DOMAIN_EVENT_TEMPLATE,
  DOMAIN_SERVICE_TEMPLATE,
  REPOSITORY_PORT_TEMPLATE,
  REPOSITORY_IMPL_TEMPLATE,
  APPLICATION_SERVICE_TEMPLATE,
  DTO_TEMPLATE,
  REST_CONTROLLER_TEMPLATE,
  SAGA_ORCHESTRATOR_TEMPLATE,
  EVENT_HANDLER_TEMPLATE,
  TEST_SPEC_TEMPLATE,
  MODULE_INDEX_TEMPLATE,
};

/**
 * 重新导出 TemplateRegistry 与 TemplateVariableSchema 协议
 *
 * 调用方可从 templates/index 统一导入协议类型，避免散落引用。
 */
export type { TemplateRegistry, TemplateVariableSchema } from "../types";
