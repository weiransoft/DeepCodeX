/**
 * EAG-P3 批次 11 S3：EagCommandParser 单元测试 —— 基础与边界（拆分自 eag-cli-command-parser.test.ts）
 *
 * 测试范围（对齐 EAG-P3 批次 11 §5 S3 改进方案 D-S3-1 ~ D-S3-8）：
 * - A. EagCommandParser 实例化与无状态特性
 * - B. EAG_COMMAND_STRINGS 常量与冻结语义
 * - C. parse() 统一入口（非字符串 / 图片附件 / 技能匹配 / 7 命令分发 / unknown 兜底）
 * - J. 不可变优先原则（readonly payload / frozen 常量 / 无实例字段）
 * - K. 边界情况测试
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：直接 new EagCommandParser()，不通过 SessionManager 注入
 * - 所有 fixture 使用 Object.freeze 冻结（对齐不可变优先 §5.12.4 G-A6d）
 * - 中文注释
 *
 * 设计依据：
 * - EAG-P3 批次 11 设计文档 §5 S3 改进方案（决策清单 D-S3-1 ~ D-S3-8）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先）
 * - eag/cli/eag-command-parser.ts（EagCommandParser 类与 EAG_COMMAND_STRINGS 常量）
 *
 * @module tests/eag-cli-parser-basics
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EagCommandParser, EAG_COMMAND_STRINGS } from "../eag/cli/eag-command-parser";
import type { DesignLoopInput } from "../eag/design/design-models";
import { createMinimalDesignLoopInput } from "./fixtures/eag-command-fixtures";

// ============================================================================
// A. EagCommandParser 实例化与无状态特性测试
// ============================================================================

test("A1. EagCommandParser 实例化成功", () => {
  // 验证：EagCommandParser 可正常实例化（无构造参数，无外部依赖）
  const parser = new EagCommandParser();
  assert.ok(parser instanceof EagCommandParser, "应为 EagCommandParser 实例");
  // 验证 parse 与 parseEagXxxCommand 方法存在（7 个 EAG 命令 + parse）
  assert.equal(typeof parser.parse, "function", "parse 方法应存在");
  assert.equal(typeof parser.parseEagBuildCommand, "function", "parseEagBuildCommand 方法应存在");
  assert.equal(typeof parser.parseEagDesignCommand, "function", "parseEagDesignCommand 方法应存在");
  assert.equal(typeof parser.parseEagTestCommand, "function", "parseEagTestCommand 方法应存在");
  assert.equal(typeof parser.parseEagRunCommand, "function", "parseEagRunCommand 方法应存在");
  assert.equal(typeof parser.parseEagResumeCommand, "function", "parseEagResumeCommand 方法应存在");
  assert.equal(typeof parser.parseEagStatusCommand, "function", "parseEagStatusCommand 方法应存在");
  assert.equal(typeof parser.parseEagDeployCommand, "function", "parseEagDeployCommand 方法应存在");
});

test("A2. EagCommandParser 无状态（多次 parse 互不影响）", () => {
  // 验证：EagCommandParser 类无状态，连续多次 parse 不同输入互不影响
  // 此设计保证 parser 可作为单例被 SessionManager 复用（D-S3-4）
  const parser = new EagCommandParser();

  // 第一次解析 /eag-build
  const r1 = parser.parse({ text: "/eag-build" });
  assert.equal(r1.kind, "eag-build");

  // 第二次解析 /eag-design（不应受第一次影响）
  const r2 = parser.parse({ text: "/eag-design" });
  assert.equal(r2.kind, "eag-design");

  // 第三次解析非命令文本
  const r3 = parser.parse({ text: "请帮我实现一个订单系统" });
  assert.equal(r3.kind, "unknown");

  // 第四次解析 /eag-build（不应受中间解析影响）
  const r4 = parser.parse({ text: "/eag-build" });
  assert.equal(r4.kind, "eag-build");
});

// ============================================================================
// B. EAG_COMMAND_STRINGS 常量与冻结语义测试
// ============================================================================

test("B3. EAG_COMMAND_STRINGS 包含 18 个 EAG 命令字符串", () => {
  // 验证：EAG_COMMAND_STRINGS 常量包含 18 个 EAG 命令字符串（D-S3-6）
  // 注：EAG-P4 批次 13 Phase 7 新增 /eag-deploy 命令，命令总数从 6 扩展至 7
  // 注：EAG-P5 Phase 5.4 新增 /eag-autonomous 命令（无人值守 4 阶段循环），命令总数从 7 扩展至 8
  // 注：EAG-P5 Phase 5.5 新增 /eag-autonomous-status 与 /eag-autonomous-stop 命令
  //     （无人值守状态查询 + 中止/回滚），命令总数从 8 扩展至 10
  // 注：Loop-Graph 融合方案 Phase 5 新增 /eag-graph 命令（图编排入口），命令总数从 10 扩展至 11
  // 注：ADR-DI-001 §7.4.1 新增 7 个动态指令注入与后台子 Agent 命令
  //     （/inject /bg /tasks /fg /cancel /pause /resume），命令总数从 11 扩展至 18
  assert.equal(EAG_COMMAND_STRINGS.EAG_BUILD, "/eag-build");
  assert.equal(EAG_COMMAND_STRINGS.EAG_DESIGN, "/eag-design");
  assert.equal(EAG_COMMAND_STRINGS.EAG_TEST, "/eag-test");
  assert.equal(EAG_COMMAND_STRINGS.EAG_RUN, "/eag-run");
  assert.equal(EAG_COMMAND_STRINGS.EAG_RESUME, "/eag-resume");
  assert.equal(EAG_COMMAND_STRINGS.EAG_STATUS, "/eag-status");
  assert.equal(EAG_COMMAND_STRINGS.EAG_DEPLOY, "/eag-deploy");
  assert.equal(EAG_COMMAND_STRINGS.EAG_AUTONOMOUS, "/eag-autonomous");
  assert.equal(EAG_COMMAND_STRINGS.EAG_AUTONOMOUS_STATUS, "/eag-autonomous-status");
  assert.equal(EAG_COMMAND_STRINGS.EAG_AUTONOMOUS_STOP, "/eag-autonomous-stop");
  assert.equal(EAG_COMMAND_STRINGS.EAG_GRAPH, "/eag-graph");
  // ADR-DI-001 §7.4.1 新增 7 个动态指令注入与后台子 Agent 命令字符串
  assert.equal(EAG_COMMAND_STRINGS.INJECT, "/inject");
  assert.equal(EAG_COMMAND_STRINGS.BG, "/bg");
  assert.equal(EAG_COMMAND_STRINGS.TASKS, "/tasks");
  assert.equal(EAG_COMMAND_STRINGS.FG, "/fg");
  assert.equal(EAG_COMMAND_STRINGS.CANCEL, "/cancel");
  assert.equal(EAG_COMMAND_STRINGS.PAUSE, "/pause");
  assert.equal(EAG_COMMAND_STRINGS.RESUME, "/resume");
  // 验证总字段数（防止未来误新增）
  assert.equal(Object.keys(EAG_COMMAND_STRINGS).length, 18, "应有 18 个 EAG 命令字符串");
});

test("B4. EAG_COMMAND_STRINGS 被 Object.freeze 冻结（不可变优先 §5.12.4 G-A6d）", () => {
  // 验证：EAG_COMMAND_STRINGS 顶层对象被 Object.freeze 冻结
  // 在 strict 模式下，对冻结对象的属性赋值会抛 TypeError
  assert.ok(Object.isFrozen(EAG_COMMAND_STRINGS), "EAG_COMMAND_STRINGS 应被冻结");

  // 验证：尝试修改属性应抛 TypeError（strict 模式下）
  assert.throws(
    () => {
      (EAG_COMMAND_STRINGS as any).EAG_BUILD = "/eag-changed";
    },
    TypeError,
    "修改冻结对象属性应抛 TypeError"
  );

  // 验证：尝试新增属性应抛 TypeError
  assert.throws(
    () => {
      (EAG_COMMAND_STRINGS as any).EAG_NEW = "/eag-new";
    },
    TypeError,
    "新增冻结对象属性应抛 TypeError"
  );

  // 验证：原值未变
  assert.equal(EAG_COMMAND_STRINGS.EAG_BUILD, "/eag-build", "冻结后原值应保持不变");
});

// ============================================================================
// C. parse() 统一入口测试（D-S3-1 / D-S3-3）
// ============================================================================

test("C5. parse() 对 text 为非字符串时返回 unknown", () => {
  // 验证 parse() 步骤 1：text 必须为字符串
  // 非字符串时返回 { kind: "unknown", payload: null }，不抛异常
  const parser = new EagCommandParser();
  assert.equal(parser.parse({ text: undefined }).kind, "unknown");
  assert.equal(parser.parse({ text: null as any }).kind, "unknown");
  assert.equal(parser.parse({ text: 123 as any }).kind, "unknown");
  assert.equal(parser.parse({ text: {} as any }).kind, "unknown");
  assert.equal(parser.parse({ text: [] as any }).kind, "unknown");
  // 无 text 字段
  assert.equal(parser.parse({}).kind, "unknown");
});

test("C6. parse() 对含图片附件的输入返回 unknown（避免误触发）", () => {
  // 验证 parse() 步骤 2：含图片附件时不识别为命令（避免误判）
  // 即使 text 严格匹配命令字符串，也返回 unknown
  const parser = new EagCommandParser();
  const imageUrls = [
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ];
  assert.equal(parser.parse({ text: "/eag-build", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-design", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-test", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-run", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-resume", imageUrls }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-status", imageUrls }).kind, "unknown");
});

test("C7. parse() 对含技能匹配的输入返回 unknown（避免误触发）", () => {
  // 验证 parse() 步骤 2：含技能匹配时不识别为命令（避免误判）
  // 即使 text 严格匹配命令字符串，也返回 unknown
  const parser = new EagCommandParser();
  const skills = [{ name: "test-skill", path: "/", description: "测试技能" }];
  assert.equal(parser.parse({ text: "/eag-build", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-design", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-test", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-run", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-resume", skills }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-status", skills }).kind, "unknown");
});

test("C8. parse() 对严格匹配 6 个命令字符串时返回对应 kind", () => {
  // 验证 parse() 步骤 3：text trim 后严格匹配 6 个命令字符串，返回对应 kind
  const parser = new EagCommandParser();
  // 不带 trim 的精确匹配
  assert.equal(parser.parse({ text: "/eag-build" }).kind, "eag-build");
  assert.equal(parser.parse({ text: "/eag-design" }).kind, "eag-design");
  assert.equal(parser.parse({ text: "/eag-test" }).kind, "eag-test");
  assert.equal(parser.parse({ text: "/eag-run" }).kind, "eag-run");
  assert.equal(parser.parse({ text: "/eag-resume" }).kind, "eag-resume");
  assert.equal(parser.parse({ text: "/eag-status" }).kind, "eag-status");
  // 带 trim 的精确匹配（前后空格被 trim 后匹配）
  assert.equal(parser.parse({ text: "  /eag-build  " }).kind, "eag-build");
  assert.equal(parser.parse({ text: "  /eag-design  " }).kind, "eag-design");
  assert.equal(parser.parse({ text: "  /eag-test  " }).kind, "eag-test");
  assert.equal(parser.parse({ text: "  /eag-run  " }).kind, "eag-run");
  assert.equal(parser.parse({ text: "  /eag-resume  " }).kind, "eag-resume");
  assert.equal(parser.parse({ text: "  /eag-status  " }).kind, "eag-status");
});

test("C9. parse() 对不匹配任何命令的文本返回 unknown", () => {
  // 验证 parse() 步骤 3 default 分支：未匹配任何 EAG 命令 → unknown
  const parser = new EagCommandParser();
  // 普通对话文本
  assert.equal(parser.parse({ text: "请帮我实现一个订单系统" }).kind, "unknown");
  assert.equal(parser.parse({ text: "今天天气不错" }).kind, "unknown");
  // 带参数的命令（严格匹配命令无参数，参数通过 messageParams 注入 D-S3-7）
  assert.equal(parser.parse({ text: "/eag-build --force" }).kind, "unknown");
  // 例外（S3.2 前缀匹配，2026-08-19）：/eag-design 改为前缀匹配以支持 CLI 内联参数，
  // 带参数文本识别为 eag-design 命令；非 --key=value 形式的裸参数无法解析出
  // DesignLoopInput → payload 为 null（fail-closed 由 session 层提示用户补充参数）
  const designWithBareArg = parser.parse({ text: "/eag-design order" });
  assert.equal(designWithBareArg.kind, "eag-design");
  assert.equal(designWithBareArg.payload, null);
  assert.equal(parser.parse({ text: "/eag-test all" }).kind, "unknown");
  // 包含命令字符串但非严格匹配
  assert.equal(parser.parse({ text: "请帮我执行 /eag-build" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag-build/" }).kind, "unknown");
  // 相似但非命令的字符串
  assert.equal(parser.parse({ text: "/eag-buil" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/eag" }).kind, "unknown");
  assert.equal(parser.parse({ text: "eag-build" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/EAG-BUILD" }).kind, "unknown");
  // 其他系统命令
  assert.equal(parser.parse({ text: "/continue" }).kind, "unknown");
  assert.equal(parser.parse({ text: "/plan" }).kind, "unknown");
});

// ============================================================================
// J. 不可变优先原则测试（§5.12.4 G-A6d）
// ============================================================================

test("J36. EagCommand 返回对象的 kind 与 payload 字段不可重新赋值（readonly）", () => {
  // 验证：EagCommand 类型联合的 kind 与 payload 字段为 readonly
  // 通过 Object.freeze 冻结返回对象，保证不可变性
  const parser = new EagCommandParser();

  // /eag-build 命令返回的对象（payload 为 null 时也应被冻结）
  const cmd1 = parser.parse({ text: "/eag-build" });
  assert.ok(Object.isFrozen(cmd1), "parse 返回的对象应被冻结");
  // 尝试修改 kind 应抛 TypeError
  assert.throws(
    () => {
      (cmd1 as any).kind = "eag-design";
    },
    TypeError,
    "修改冻结对象的 kind 字段应抛 TypeError"
  );
  // 尝试修改 payload 应抛 TypeError
  assert.throws(
    () => {
      (cmd1 as any).payload = { projectRoot: "/changed" };
    },
    TypeError,
    "修改冻结对象的 payload 字段应抛 TypeError"
  );

  // unknown 命令返回的对象
  const cmd2 = parser.parse({ text: "非命令文本" });
  assert.ok(Object.isFrozen(cmd2), "unknown 返回的对象应被冻结");

  // payload 非空的对象（payload 由调用方提供，不应被 parser 冻结）
  // 注：payload 对象本身的冻结责任在调用方（fixture 已 Object.freeze）
  const validInput = createMinimalDesignLoopInput();
  const cmd3 = parser.parse({
    text: "/eag-design",
    messageParams: { designLoopInput: validInput },
  });
  // 顶层 EagCommand 应被冻结
  assert.ok(Object.isFrozen(cmd3), "顶层 EagCommand 应被冻结");
});

test("J37. EAG_COMMAND_STRINGS 不可变（frozen 属性验证）", () => {
  // 验证：EAG_COMMAND_STRINGS 常量被 Object.freeze 冻结
  // 注：与 B4 互补，B4 验证运行期抛 TypeError，J37 验证 isFrozen 标记
  assert.ok(Object.isFrozen(EAG_COMMAND_STRINGS), "EAG_COMMAND_STRINGS 应被 Object.isFrozen 标记");
  // 二级属性（字符串字面量）天然不可变，无需进一步冻结
  assert.equal(typeof EAG_COMMAND_STRINGS.EAG_BUILD, "string", "EAG_BUILD 应为字符串");
});

test("J38. EagCommandParser 类无实例字段（无状态验证）", () => {
  // 验证：EagCommandParser 类无实例字段（D-S3-4 无状态原则）
  // 通过 Object.keys 检查实例上无可枚举字段
  const parser = new EagCommandParser();
  const instanceKeys = Object.keys(parser);
  // 方法不在 Object.keys 中（方法是原型属性，非实例属性）
  assert.equal(instanceKeys.length, 0, `EagCommandParser 实例应无字段（无状态），实际为：${instanceKeys.join(", ")}`);

  // 验证：方法通过原型链访问，非实例属性
  assert.equal(Object.prototype.hasOwnProperty.call(parser, "parse"), false, "parse 应为原型方法，非实例属性");
  assert.equal(
    Object.prototype.hasOwnProperty.call(parser, "parseEagBuildCommand"),
    false,
    "parseEagBuildCommand 应为原型方法，非实例属性"
  );
});

// ============================================================================
// K. 边界情况测试
// ============================================================================

test("K39. parse() 对 messageParams 为各种类型时正常处理（不抛异常）", () => {
  // 验证 parse() 对 messageParams 字段不同类型的健壮性
  // messageParams 为 UserPromptContent 的可选字段，类型为 Record<string, unknown> | null
  const parser = new EagCommandParser();

  // messageParams 为 undefined（默认）
  assert.doesNotThrow(() => parser.parse({ text: "/eag-build" }));
  // messageParams 为 null
  assert.doesNotThrow(() => parser.parse({ text: "/eag-build", messageParams: null }));
  // messageParams 为空对象
  assert.doesNotThrow(() => parser.parse({ text: "/eag-build", messageParams: {} }));
  // messageParams 为非对象（数字）—— UserPromptContent 类型应阻止此调用，但 parser 应健壮
  // 注意：此处通过 as any 绕过类型检查，验证运行期健壮性
  assert.doesNotThrow(() => parser.parse({ text: "/eag-build", messageParams: 123 as any }));
  // messageParams 为非对象（字符串）
  assert.doesNotThrow(() => parser.parse({ text: "/eag-build", messageParams: "invalid" as any }));
  // messageParams 为数组
  assert.doesNotThrow(() => parser.parse({ text: "/eag-build", messageParams: [] as any }));

  // 验证：messageParams 为非对象时 payload 为 null（不抛异常）
  assert.equal(parser.parse({ text: "/eag-build", messageParams: 123 as any }).payload, null);
  assert.equal(parser.parse({ text: "/eag-build", messageParams: "invalid" as any }).payload, null);
});

test("K40. parse() 多种无效 messageParams.codingLoopRequest 时返回 null payload", () => {
  // 验证：extractCodingLoopRequest 对 messageParams.codingLoopRequest 各种无效值的健壮处理
  const parser = new EagCommandParser();

  // codingLoopRequest 为 null
  assert.equal(parser.parse({ text: "/eag-build", messageParams: { codingLoopRequest: null } }).payload, null);
  // codingLoopRequest 为 undefined
  assert.equal(parser.parse({ text: "/eag-build", messageParams: { codingLoopRequest: undefined } }).payload, null);
  // codingLoopRequest 为字符串
  assert.equal(parser.parse({ text: "/eag-build", messageParams: { codingLoopRequest: "string" } }).payload, null);
  // codingLoopRequest 为数字
  assert.equal(parser.parse({ text: "/eag-build", messageParams: { codingLoopRequest: 123 } }).payload, null);
  // codingLoopRequest 为数组
  assert.equal(parser.parse({ text: "/eag-build", messageParams: { codingLoopRequest: [] } }).payload, null);
  // codingLoopRequest 为空对象
  assert.equal(parser.parse({ text: "/eag-build", messageParams: { codingLoopRequest: {} } }).payload, null);
});

test("K41. parse() 在不同 UserPromptContent 可选字段组合下正常工作", () => {
  // 验证 parse() 对 UserPromptContent 其他可选字段的存在不影响命令识别
  // UserPromptContent 含 permissions / alwaysAllows / planMode 等字段，这些字段不应影响 EAG 命令识别
  const parser = new EagCommandParser();

  // 含 permissions 字段
  const cmd1 = parser.parse({
    text: "/eag-build",
    permissions: [{ tool: "Bash", permission: "allow" }] as any,
  });
  assert.equal(cmd1.kind, "eag-build");

  // 含 alwaysAllows 字段
  const cmd2 = parser.parse({
    text: "/eag-design",
    alwaysAllows: [{ tool: "Read", path: "/tmp" }] as any,
  });
  assert.equal(cmd2.kind, "eag-design");

  // 含 planMode 字段
  const cmd3 = parser.parse({
    text: "/eag-test",
    planMode: true,
  });
  assert.equal(cmd3.kind, "eag-test");

  // 含所有可选字段（除 imageUrls / skills 外，这些字段不影响命令识别）
  const cmd4 = parser.parse({
    text: "/eag-run",
    permissions: [{ tool: "Bash", permission: "allow" }] as any,
    alwaysAllows: [{ tool: "Read", path: "/tmp" }] as any,
    planMode: false,
    messageParams: {},
  });
  assert.equal(cmd4.kind, "eag-run");
});
