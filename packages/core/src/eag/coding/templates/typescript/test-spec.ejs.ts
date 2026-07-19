/**
 * 单测骨架 EJS 模板（EAG-P2 批次 9 S1 基础层）
 *
 * 对应 EAG-P2 批次 9 设计 §4.2 templates/typescript/test-spec.ejs。
 * 单测骨架特征：Given-When-Then 结构 / 断言模板 / 覆盖正向与边界用例 / 真实实现而非 mock。
 *
 * 模板变量：
 * - moduleName：模块名
 * - modulePath：模块路径
 * - responsibility：模块职责描述
 * - requirementId：关联需求 ID
 * - taskId：关联任务卡 ID
 * - targetClassName：被测类名（如 "OrderAggregate"）
 * - targetImportPath：被测类导入路径
 * - testCases：测试用例列表 [{
 *     name: "should_create_order_with_valid_command",
 *     description: "应当通过有效命令创建订单",
 *     given: "有效命令 OrderCreateCommand",
 *     when: "调用 OrderAggregate.create(command)",
 *     then: "返回聚合根实例与 OrderCreated 事件"
 *   }]
 *
 * 占位标记：
 * - TODO(phase-b): 实现测试用例断言
 *
 * @module eag/coding/templates/typescript/test-spec
 */

/**
 * 单测骨架 EJS 模板字符串
 *
 * 渲染时由 SkeletonGenerator 调用 ejs.render(TEST_SPEC_TEMPLATE, variables) 输出骨架代码。
 */
export const TEST_SPEC_TEMPLATE = `/**
 * <%- targetClassName %> 单元测试
 *
 * 模块职责：<%- responsibility %>
 *
 * 关联需求：<%- requirementId %>
 * 关联任务：<%- taskId %>
 *
 * @module <%- modulePath %>
 */

import { describe, it, expect, beforeEach } from "vitest";
import { <%- targetClassName %> } from "<%- targetImportPath %>";

/**
 * <%- targetClassName %> 单元测试套件
 *
 * 测试覆盖维度：
 * - 正向用例：验证正常业务流程
 * - 边界用例：验证边界条件与异常输入
 * - 不变式用例：验证聚合根不变式约束
 * - 幂等性用例：验证幂等键参数（对齐 E2 红线）
 *
 * 测试禁令（对齐用户规则 + §8.4）：
 * - 禁止 mock 被测对象（使用真实实现）
 * - 禁止 mock 仓储（使用 InMemoryRepository 真实实现）
 * - 禁止 mock LLM（使用 InMemoryLLMClient 真实实现）
 */
describe("<%- targetClassName %>", () => {
  // ============================ 测试夹具 ============================

  beforeEach(() => {
    // 测试夹具初始化（由 Phase B 实现）
  });

  // ============================ 测试用例 ============================

<%_ for (const testCase of testCases) { _%>
  /**
   * <%- testCase.description %>
   *
   * Given：<%- testCase.given %>
   * When：<%- testCase.when %>
   * Then：<%- testCase.then %>
   *
   * // TODO(phase-b): 实现测试用例断言
   */
  it("<%- testCase.name %>", () => {
    // Given：<%- testCase.given %>
    // TODO(phase-b): 准备测试夹具

    // When：<%- testCase.when %>
    // TODO(phase-b): 调用被测方法

    // Then：<%- testCase.then %>
    // TODO(phase-b): 断言预期结果
    expect(true).toBe(true); // 占位断言，Phase B 必须替换为真实断言
  });

<%_ } _%>

  // ============================ 不变式测试 ============================

  /**
   * 验证聚合根不变式约束
   *
   * 不变式约束（由 Phase B 实现）：
   * - 字段非空校验
   * - 业务规则一致性
   * - 跨字段不变式
   *
   * // TODO(phase-b): 实现不变式测试用例断言
   */
  it("should_maintain_invariants_after_business_operations", () => {
    // TODO(phase-b): 验证业务操作后聚合根不变式仍然保持
    expect(true).toBe(true); // 占位断言
  });
});
`;
