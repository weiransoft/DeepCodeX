/**
 * /eag-design 命令参数解析单元测试（EAG-P1 S3.2 接线批次）
 *
 * 测试范围（eag-design-command.ts + eag-command-parser.ts 集成）：
 * - extractDesignLoopInputFromPrompt：
 *   * 必填 --requirement 解析（裸值 / 双引号 / 单引号 / = 分隔）
 *   * 可选 --paradigm 解析（4 个合法范式 ID → ParadigmLockConfig 构造）
 *   * 失败路径：缺失必填参数 / 范式 ID 非法 / 未知参数 / 空字符串 / 前缀不匹配
 *   * 不可变优先：返回对象冻结（Object.isFrozen）
 * - EagCommandParser.parse 集成（S3.2-3 前缀匹配接线）：
 *   * CLI 内联参数 `/eag-design --requirement ... --paradigm ...` → kind=eag-design + payload
 *   * messageParams.designLoopInput 优先级高于 CLI 内联参数
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock：直接调用真实解析函数断言真实输出
 *
 * @module tests/eag-design-command
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDesignLoopInputFromPrompt } from "../eag/cli/eag-design-command";
import { EagCommandParser } from "../eag/cli/eag-command-parser";
import type { DesignLoopInput } from "../eag/design/design-models";

// ============================================================================
// extractDesignLoopInputFromPrompt：成功路径
// ============================================================================

test("S1. 裸值 --requirement 解析为 DesignLoopInput（无范式锁定）", () => {
  const input = extractDesignLoopInputFromPrompt("/eag-design --requirement 实现订单管理模块");
  assert.equal(input.rawRequirement, "实现订单管理模块");
  assert.equal(input.paradigmLock, undefined, "未提供 --paradigm 时不应有范式锁定");
});

test("S2. 双引号包裹的 --requirement 保留内部空格", () => {
  const input = extractDesignLoopInputFromPrompt(
    '/eag-design --requirement "作为订单管理员，我希望创建订单，以便跟踪订单状态"'
  );
  assert.equal(input.rawRequirement, "作为订单管理员，我希望创建订单，以便跟踪订单状态");
});

test("S3. 单引号包裹的 --requirement 正常解析", () => {
  const input = extractDesignLoopInputFromPrompt("/eag-design --requirement '实现库存扣减'");
  assert.equal(input.rawRequirement, "实现库存扣减");
});

test("S4. 等号分隔形式 --requirement=value 正常解析", () => {
  const input = extractDesignLoopInputFromPrompt("/eag-design --requirement=实现支付功能");
  assert.equal(input.rawRequirement, "实现支付功能");
});

test("S5. --paradigm 合法值构造范式锁定（locked=true + 命令行锁定原因）", () => {
  // 4 个合法范式 ID 全量验证
  for (const paradigmId of ["ddd-layered", "clean-architecture", "cqrs-es", "microservice"] as const) {
    const input = extractDesignLoopInputFromPrompt(`/eag-design --requirement "实现订单模块" --paradigm ${paradigmId}`);
    assert.ok(input.paradigmLock, `${paradigmId}：应构造 paradigmLock`);
    assert.equal(input.paradigmLock?.locked, true, `${paradigmId}：locked 应为 true`);
    assert.equal(input.paradigmLock?.paradigmId, paradigmId, `${paradigmId}：paradigmId 应一致`);
    assert.ok(
      typeof input.paradigmLock?.reason === "string" && input.paradigmLock.reason.includes("命令行"),
      `${paradigmId}：锁定原因应说明来源为命令行`
    );
  }
});

test("S6. 大小写不敏感的命令前缀（/EAG-DESIGN）正常解析", () => {
  const input = extractDesignLoopInputFromPrompt("/EAG-DESIGN --requirement 实现订单管理模块");
  assert.equal(input.rawRequirement, "实现订单管理模块");
});

test("S7. 返回的 DesignLoopInput 与 paradigmLock 均为冻结对象（不可变优先）", () => {
  const input = extractDesignLoopInputFromPrompt('/eag-design --requirement "实现订单模块" --paradigm cqrs-es');
  assert.ok(Object.isFrozen(input), "DesignLoopInput 应冻结");
  assert.ok(Object.isFrozen(input.paradigmLock), "paradigmLock 应冻结");
});

// ============================================================================
// extractDesignLoopInputFromPrompt：失败路径（fail-closed）
// ============================================================================

test("F1. 缺少必填参数 --requirement 时抛错（裸命令）", () => {
  assert.throws(() => extractDesignLoopInputFromPrompt("/eag-design"), /--requirement/);
});

test("F2. 仅提供 --paradigm 而缺失 --requirement 时抛错", () => {
  assert.throws(() => extractDesignLoopInputFromPrompt("/eag-design --paradigm cqrs-es"), /--requirement/);
});

test("F3. --requirement 为空值（flag 形式）时抛错", () => {
  assert.throws(() => extractDesignLoopInputFromPrompt("/eag-design --requirement"), /非空值/);
});

test("F4. --paradigm 值非法时抛错（含全部合法值提示）", () => {
  assert.throws(
    () => extractDesignLoopInputFromPrompt('/eag-design --requirement "x" --paradigm layered'),
    /ddd-layered \/ clean-architecture \/ cqrs-es \/ microservice/
  );
});

test("F5. 未知参数抛错（防拼写错误静默失效）", () => {
  assert.throws(
    () => extractDesignLoopInputFromPrompt('/eag-design --requirement "x" --requirment "y"'),
    /未知参数 --requirment/
  );
});

test("F6. 命令前缀不匹配时抛错", () => {
  assert.throws(() => extractDesignLoopInputFromPrompt("/eag-build --requirement x"), /前缀不匹配/);
});

test("F7. 空字符串与非字符串输入抛错", () => {
  assert.throws(() => extractDesignLoopInputFromPrompt("   "), /不能为空/);
  assert.throws(() => extractDesignLoopInputFromPrompt(undefined as unknown as string), /非空字符串/);
});

// ============================================================================
// EagCommandParser 集成（S3.2-3 前缀匹配接线）
// ============================================================================

test("P1. parser 对 CLI 内联参数命令返回 eag-design kind 与完整 payload", () => {
  const parser = new EagCommandParser();
  const result = parser.parse({
    text: '/eag-design --requirement "作为订单管理员，我希望创建订单，以便跟踪订单状态" --paradigm cqrs-es',
  });

  assert.equal(result.kind, "eag-design");
  assert.ok(result.payload, "内联参数路径应产出 payload");
  const payload = result.payload as DesignLoopInput;
  assert.equal(payload.rawRequirement, "作为订单管理员，我希望创建订单，以便跟踪订单状态");
  assert.equal(payload.paradigmLock?.paradigmId, "cqrs-es");
  assert.equal(payload.paradigmLock?.locked, true);
});

test("P2. parser 裸 /eag-design（无参数）payload 为 null（交由 messageParams 或提示用户）", () => {
  const parser = new EagCommandParser();
  const result = parser.parse({ text: "/eag-design" });
  assert.equal(result.kind, "eag-design");
  assert.equal(result.payload, null);
});

test("P3. parser messageParams.designLoopInput 优先于 CLI 内联参数", () => {
  const parser = new EagCommandParser();
  const paramsInput: DesignLoopInput = Object.freeze({ rawRequirement: "来自 messageParams 的需求" });

  const result = parser.parse({
    text: '/eag-design --requirement "来自命令行的需求"',
    messageParams: { designLoopInput: paramsInput },
  });

  assert.equal(result.kind, "eag-design");
  const payload = result.payload as DesignLoopInput;
  assert.equal(payload.rawRequirement, "来自 messageParams 的需求", "messageParams 注入优先");
});

test("P4. parser 对非法内联参数（--paradigm 非法）payload 降级为 null（不中断解析）", () => {
  const parser = new EagCommandParser();
  const result = parser.parse({
    text: '/eag-design --requirement "x" --paradigm nonexistent',
  });

  // 解析失败被 extractDesignLoopInput 捕获后返回 null（fail-closed 由 session 层提示用户）
  assert.equal(result.kind, "eag-design");
  assert.equal(result.payload, null);
});
