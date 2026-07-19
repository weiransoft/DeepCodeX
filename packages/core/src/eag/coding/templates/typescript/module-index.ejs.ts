/**
 * 模块 barrel EJS 模板（EAG-P2 批次 9 S1 基础层）
 *
 * 对应 EAG-P2 批次 9 设计 §4.2 templates/typescript/module-index.ejs。
 * 模块 barrel 特征：统一导出 / 减少耦合 / 显式 public API / 隐藏内部实现。
 *
 * 模板变量：
 * - moduleName：模块名
 * - modulePath：模块路径
 * - responsibility：模块职责描述
 * - requirementId：关联需求 ID
 * - taskId：关联任务卡 ID
 * - exports：导出列表 [{
 *     symbol: "OrderAggregate",
 *     path: "./OrderAggregate",
 *     type: "class" | "interface" | "type" | "function" | "constant"
 *   }]
 *
 * 占位标记：
 * - TODO(phase-b): 按需补充模块导出
 *
 * @module eag/coding/templates/typescript/module-index
 */

/**
 * 模块 barrel EJS 模板字符串
 *
 * 渲染时由 SkeletonGenerator 调用 ejs.render(MODULE_INDEX_TEMPLATE, variables) 输出骨架代码。
 */
export const MODULE_INDEX_TEMPLATE = `/**
 * <%- moduleName %> 模块 barrel
 *
 * 模块职责：<%- responsibility %>
 *
 * 关联需求：<%- requirementId %>
 * 关联任务：<%- taskId %>
 *
 * @module <%- modulePath %>
 */

/**
 * <%- moduleName %> 模块公共 API
 *
 * <%- responsibility %>
 *
 * 模块对外暴露的公共接口，其他模块仅通过本 barrel 导入，
 * 禁止直接引用模块内部文件（依赖倒置 + 减少耦合）。
 *
 * Public API 清单：
<%_ for (const exp of exports) { _%>
 * - <%- exp.symbol %>（<%- exp.type %>）
<%_ } _%>
 *
 * // TODO(phase-b): 按需补充模块导出
 */
<%_ for (const exp of exports) { _%>
export { <%- exp.symbol %> } from "<%- exp.path %>";
<%_ } _%>
`;
