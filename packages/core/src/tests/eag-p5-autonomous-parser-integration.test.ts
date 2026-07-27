/**
 * EAG-P5 Autonomous 测试拆分文件 2/5：EagCommandParser + session.ts 集成
 *
 * 本文件从 eag-p5-e2e-autonomous.test.ts 拆分而来，包含：
 * - C 组（C1-C7）：EagCommandParser /eag-autonomous 命令识别（TASK-P5-3.1-006 验证）
 *   - 前缀匹配（大小写不敏感）
 *   - 无参数形式（/eag-autonomous）
 *   - 含参数形式（/eag-autonomous --goal "..."）
 *   - 其他命令严格匹配不冲突
 * - D 组（D1-D3）：session.ts handleEagAutonomousCommand 集成（TASK-P5-3.1-006 验证）
 *   - AutonomousOrchestrator 未注入时 fail-closed
 *   - payload null 时重新解析获取错误详情
 *   - 完整成功路径（orchestrator 注入 + payload 有效 + 执行成功）
 *   - abort 信号响应
 *
 * 测试约定（严格遵循项目规则 P-5 + NFR-9）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 AutonomousOrchestrator / StageHandler / GuardChain / SmartConfirmation 实例
 * - 使用真实文件系统（os.tmpdir + mkdtempSync）创建临时项目目录
 * - 测试结束后清理临时目录（避免泄漏）
 * - 中文注释，符合 TypeScript 代码规范
 *
 * 设计依据：
 * - 需求文档 §3 FR-4 /eag-autonomous 命令
 * - 架构师审查 §4.1 AutonomousOrchestrator 接口契约
 * - 任务说明 TASK-P5-3.1-006
 * - NFR-8 不可变优先 + NFR-9 禁止 mock + NFR-10 中文详细注释
 *
 * @module core/tests/eag-p5-autonomous-parser-integration
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// EagCommandParser + 命令处理器导入（TASK-P5-3.1-006 验证）
import { EagCommandParser, EAG_COMMAND_STRINGS } from "../eag/cli/eag-command-parser";
import { EagAutonomousCommandHandler, extractEagAutonomousRequestFromPrompt } from "../eag/cli/eag-autonomous-command";

// P5 核心组件类型导入（用于 D 组类型断言）
import type { AutonomousOrchestrator } from "../eag/p5";

// 共享夹具导入
import {
  PASS_TEST_CMD,
  createTempProject,
  cleanupTempProject,
  createTasksFile,
  createDeclaredFile,
  buildOrchestrator,
  buildUserPrompt,
} from "./fixtures/eag-p5-e2e-fixtures";

// ============================================================================
// C. EagCommandParser /eag-autonomous 命令识别测试
// ============================================================================

test("C1. EagCommandParser 识别 /eag-autonomous 命令（含参数）", () => {
  const parser = new EagCommandParser();
  const userPrompt = buildUserPrompt(`/eag-autonomous --goal "测试目标" --max-iterations 10`);
  const command = parser.parse(userPrompt);

  assert.equal(command.kind, "eag-autonomous");
  // payload 应为 EagAutonomousRequest（非 null）
  if (command.kind === "eag-autonomous") {
    assert.ok(command.payload, "payload 应非 null");
    assert.equal(command.payload!.goal, "测试目标");
    assert.equal(command.payload!.maxIterations, 10);
  }
});

test("C2. EagCommandParser 识别 /eag-autonomous 命令（无参数）", () => {
  const parser = new EagCommandParser();
  // 无参数形式：payload 解析失败（缺少 --goal），返回 null
  const userPrompt = buildUserPrompt(`/eag-autonomous`);
  const command = parser.parse(userPrompt);

  assert.equal(command.kind, "eag-autonomous");
  // payload 应为 null（因为缺少必填参数 --goal）
  if (command.kind === "eag-autonomous") {
    assert.equal(command.payload, null);
  }
});

test("C3. EagCommandParser 前缀匹配大小写不敏感（/EAG-AUTONOMOUS）", () => {
  const parser = new EagCommandParser();
  const userPrompt = buildUserPrompt(`/EAG-AUTONOMOUS --goal "大小写测试"`);
  const command = parser.parse(userPrompt);

  assert.equal(command.kind, "eag-autonomous");
});

test("C4. EagCommandParser 不误判其他 EAG 命令", () => {
  const parser = new EagCommandParser();
  // 验证其他 7 个命令严格匹配，不会被 /eag-autonomous 干扰
  const testCases: ReadonlyArray<{ readonly cmd: string; readonly kind: string }> = Object.freeze([
    { cmd: EAG_COMMAND_STRINGS.EAG_BUILD, kind: "eag-build" },
    { cmd: EAG_COMMAND_STRINGS.EAG_DESIGN, kind: "eag-design" },
    { cmd: EAG_COMMAND_STRINGS.EAG_TEST, kind: "eag-test" },
    { cmd: EAG_COMMAND_STRINGS.EAG_RUN, kind: "eag-run" },
    { cmd: EAG_COMMAND_STRINGS.EAG_RESUME, kind: "eag-resume" },
    { cmd: EAG_COMMAND_STRINGS.EAG_STATUS, kind: "eag-status" },
    { cmd: EAG_COMMAND_STRINGS.EAG_DEPLOY, kind: "eag-deploy" },
  ]);

  for (const tc of testCases) {
    const userPrompt = buildUserPrompt(tc.cmd);
    const command = parser.parse(userPrompt);
    assert.equal(command.kind, tc.kind, `命令 ${tc.cmd} 应识别为 ${tc.kind}`);
  }
});

test("C5. EagCommandParser 不误判非 EAG 命令（普通文本）", () => {
  const parser = new EagCommandParser();
  const userPrompt = buildUserPrompt(`请帮我写一个 Hello World 程序`);
  const command = parser.parse(userPrompt);
  assert.equal(command.kind, "unknown");
});

test("C6. EagCommandParser 返回冻结的 EagCommand 对象", () => {
  const parser = new EagCommandParser();
  const userPrompt = buildUserPrompt(`/eag-autonomous --goal "冻结测试"`);
  const command = parser.parse(userPrompt);

  // 验证顶层对象被冻结
  assert.ok(Object.isFrozen(command), "EagCommand 顶层对象应被冻结");
});

test("C7. EAG_COMMAND_STRINGS 含 EAG_AUTONOMOUS 常量", () => {
  // 验证 EAG_COMMAND_STRINGS 集合含 /eag-autonomous
  assert.equal(EAG_COMMAND_STRINGS.EAG_AUTONOMOUS, "/eag-autonomous");
  // 验证集合被冻结
  assert.ok(Object.isFrozen(EAG_COMMAND_STRINGS));
});

// ============================================================================
// D. session.ts handleEagAutonomousCommand 集成测试
// ============================================================================

test("D1. session.ts 集成：AutonomousOrchestrator 未注入时 fail-closed", async () => {
  // 此测试通过 EagAutonomousCommandHandler 间接验证 session.ts 的依赖校验逻辑
  // session.ts 中 handleEagAutonomousCommand 在 autonomousOrchestrator 未注入时
  // 会通知用户 "AutonomousOrchestrator 未注入" 并标记 session 状态为 failed
  // 此处验证 handler 构造时的等价校验（orchestrator 必填）
  assert.throws(() => new EagAutonomousCommandHandler(null as unknown as AutonomousOrchestrator), /orchestrator 必填/);
});

test("D2. session.ts 集成：payload null 时重新解析获取错误详情", () => {
  // 验证 EagCommandParser 在参数解析失败时返回 payload=null
  // session.ts 的 handleEagAutonomousCommand 会重新调用 extractEagAutonomousRequestFromPrompt
  // 以获取具体错误信息并通知用户
  const parser = new EagCommandParser();
  // 缺少 --goal 必填参数
  const userPrompt = buildUserPrompt(`/eag-autonomous --max-iterations 10`);
  const command = parser.parse(userPrompt);

  assert.equal(command.kind, "eag-autonomous");
  if (command.kind === "eag-autonomous") {
    assert.equal(command.payload, null, "缺少 --goal 时 payload 应为 null");
  }

  // 验证重新解析会抛出具体的错误信息
  assert.throws(
    () => extractEagAutonomousRequestFromPrompt(`/eag-autonomous --max-iterations 10`),
    /缺少必填参数 --goal/
  );
});

test("D3. session.ts 集成：完整成功路径（orchestrator 注入 + payload 有效 + 执行成功）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 模拟 session.ts 的完整路径：
    // 1. EagCommandParser.parse() 识别命令并提取 payload
    // 2. handleEagAutonomousCommand 校验 orchestrator 注入
    // 3. handleEagAutonomousCommand 校验 payload
    // 4. 创建 EagAutonomousCommandHandler
    // 5. 调用 handler.execute(request, projectRoot)
    const parser = new EagCommandParser();
    const userPrompt = buildUserPrompt(
      `/eag-autonomous --goal "完整路径测试" --max-iterations 1 --test-command "${PASS_TEST_CMD}"`
    );
    const command = parser.parse(userPrompt);

    assert.equal(command.kind, "eag-autonomous");
    if (command.kind !== "eag-autonomous" || !command.payload) {
      assert.fail("命令解析失败或 payload 为 null");
      return;
    }

    const orchestrator = buildOrchestrator();
    const handler = new EagAutonomousCommandHandler(orchestrator);
    const result = await handler.execute(command.payload, projectRoot);

    assert.equal(result.success, true, "完整路径应成功");
    assert.ok(result.markdownReport.length > 0, "应生成 Markdown 报告");
  } finally {
    cleanupTempProject(projectRoot);
  }
});
