/**
 * REST 控制器 EJS 模板（EAG-P2 批次 9 S1 基础层）
 *
 * 对应 EAG-P2 批次 9 设计 §4.2 templates/typescript/rest-controller.ejs。
 * REST 控制器特征：HTTP 路由 / 异常映射 / 幂等键参数 / 输入校验 / 响应封装。
 *
 * 模板变量：
 * - moduleName：模块名
 * - modulePath：模块路径
 * - responsibility：模块职责描述
 * - requirementId：关联需求 ID
 * - taskId：关联任务卡 ID
 * - controllerName：控制器类名（如 "OrderController"）
 * - basePath：路由基路径（如 "/api/v1/orders"）
 * - applicationServiceName：依赖的应用服务类名
 * - applicationServiceImportPath：应用服务导入路径
 * - endpoints：端点列表 [{
 *     method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
 *     path: "/:id",
 *     name: "getById",
 *     description: "...",
 *     inputDto: "GetOrderInputDto",
 *     outputDto: "OrderOutputDto",
 *     idempotent: true | false
 *   }]
 *
 * 占位标记：
 * - TODO(phase-b): 应用路由装饰器（如 @Controller / @Get / @Post）
 * - TODO(phase-b): 实现端点处理逻辑（调用应用服务）
 * - TODO(phase-b): 实现幂等键校验（对齐 E2 红线）
 *
 * @module eag/coding/templates/typescript/rest-controller
 */

/**
 * REST 控制器 EJS 模板字符串
 *
 * 渲染时由 SkeletonGenerator 调用 ejs.render(REST_CONTROLLER_TEMPLATE, variables) 输出骨架代码。
 */
export const REST_CONTROLLER_TEMPLATE = `/**
 * <%- controllerName %> REST 控制器
 *
 * 模块职责：<%- responsibility %>
 *
 * 关联需求：<%- requirementId %>
 * 关联任务：<%- taskId %>
 *
 * @module <%- modulePath %>
 */

import type { <%- applicationServiceName %> } from "<%- applicationServiceImportPath %>";

/**
 * <%- controllerName %> REST 控制器
 *
 * <%- responsibility %>
 *
 * 设计原则：
 * - HTTP 路由：负责 HTTP 请求路由与参数提取
 * - 异常映射：将领域异常映射为 HTTP 状态码（如 400/404/409/500）
 * - 幂等性：写操作必须接收幂等键参数（对齐 E2 红线）
 * - 输入校验：调用 DTO 校验（对齐 E5 红线）
 * - 响应封装：统一响应格式（{ code, message, data }）
 * - 无业务逻辑：业务逻辑由应用服务负责
 *
 * // TODO(phase-b): 应用路由装饰器（如 @Controller / @Get / @Post）
 */
export class <%- controllerName %> {
  // ============================ 依赖注入 ============================

  /** 应用服务依赖 */
  private readonly applicationService: <%- applicationServiceName %>;

  // ============================ 构造函数 ============================

  /**
   * 构造 <%- controllerName %> 实例
   *
   * @param applicationService 应用服务依赖
   */
  constructor(applicationService: <%- applicationServiceName %>) {
    this.applicationService = applicationService;
  }

  // ============================ HTTP 端点 ============================

<%_ for (const endpoint of endpoints) { _%>
  /**
   * <%- endpoint.description %>
   *
   * HTTP：<%- endpoint.method %> <%- basePath %><%- endpoint.path %>
   *
   * 设计要点：
<%_ if (endpoint.idempotent) { _%>
   * - 幂等性：通过 Idempotency-Key 头部保证幂等（对齐 E2 红线）
<%_ } _%>
   * - 输入校验：DTO 校验失败返回 400
   * - 异常映射：领域异常映射为对应 HTTP 状态码
   * - 响应封装：统一响应格式
   *
   * // TODO(phase-b): 实现端点处理逻辑（调用应用服务）
   *
   * @param input 输入 DTO
   * @returns 输出 DTO
   */
  async <%- endpoint.name %>(input: <%- endpoint.inputDto %>): Promise<<%- endpoint.outputDto %>> {
    throw new Error("TODO(phase-b): 实现 <%- controllerName %>.<%- endpoint.name %> 端点处理逻辑");
  }

<%_ } _%>

  // ============================ 幂等键校验 ============================

  /**
   * 校验幂等键（对齐 E2 红线）
   *
   * 实现职责：
   * 1. 从请求头提取 Idempotency-Key
   * 2. 校验格式（UUID v4 或自定义格式）
   * 3. 检查幂等键是否已使用（查询幂等表）
   * 4. 若已使用则返回上次结果，否则记录并继续处理
   *
   * // TODO(phase-b): 实现幂等键校验（对齐 E2 红线）
   *
   * @param idempotencyKey 幂等键
   * @returns 是否首次请求
   */
  private async validateIdempotencyKey(idempotencyKey: string): Promise<boolean> {
    throw new Error("TODO(phase-b): 实现 <%- controllerName %>.validateIdempotencyKey 幂等键校验");
  }
}
`;
