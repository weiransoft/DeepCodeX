/**
 * EAG-P3 批次 11 S3：EagCommandParser 单元测试 —— /eag-build 与 /eag-design 命令
 * （拆分自 eag-cli-command-parser.test.ts）
 *
 * 测试范围（对齐 EAG-P3 批次 11 §5 S3 改进方案 D-S3-7）：
 * - D. /eag-build 命令（parseEagBuildCommand + extractCodingLoopRequest）
 * - E. /eag-design 命令（parseEagDesignCommand + extractDesignLoopInput）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：直接 new EagCommandParser()，不通过 SessionManager 注入
 * - 所有 fixture 使用 Object.freeze 冻结（对齐不可变优先 §5.12.4 G-A6d）
 * - 中文注释
 *
 * 设计依据：
 * - EAG-P3 批次 11 设计文档 §5 S3 改进方案（决策清单 D-S3-7）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先）
 * - eag/cli/eag-command-parser.ts（EagCommandParser 类与 EAG_COMMAND_STRINGS 常量）
 *
 * @module tests/eag-cli-parser-build-design
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EagCommandParser } from "../eag/cli/eag-command-parser";
import type { CodingLoopRequest } from "../eag/coding/types";
import type { DesignLoopInput } from "../eag/design/design-models";
import { createMinimalCodingLoopRequest, createMinimalDesignLoopInput } from "./fixtures/eag-command-fixtures";

// ============================================================================
// D. /eag-build 命令测试（parseEagBuildCommand + extractCodingLoopRequest）
// ============================================================================

test("D10. parseEagBuildCommand 对 /eag-build 命令返回 eag-build kind", () => {
  // 验证 parseEagBuildCommand()：对 /eag-build 命令返回 kind=eag-build
  const parser = new EagCommandParser();
  const cmd = parser.parseEagBuildCommand({ text: "/eag-build" });
  assert.equal(cmd.kind, "eag-build");
  // payload 默认为 null（未提供 messageParams）
  assert.equal(cmd.payload, null);
});

test("D11. parseEagBuildCommand 对其他 EAG 命令返回 unknown", () => {
  // 验证 parseEagBuildCommand()：对其他 5 个 EAG 命令返回 unknown
  const parser = new EagCommandParser();
  assert.equal(parser.parseEagBuildCommand({ text: "/eag-design" }).kind, "unknown");
  assert.equal(parser.parseEagBuildCommand({ text: "/eag-test" }).kind, "unknown");
  assert.equal(parser.parseEagBuildCommand({ text: "/eag-run" }).kind, "unknown");
  assert.equal(parser.parseEagBuildCommand({ text: "/eag-resume" }).kind, "unknown");
  assert.equal(parser.parseEagBuildCommand({ text: "/eag-status" }).kind, "unknown");
});

test("D12. parseEagBuildCommand 对非命令文本返回 unknown", () => {
  // 验证 parseEagBuildCommand()：对非命令文本返回 unknown
  const parser = new EagCommandParser();
  assert.equal(parser.parseEagBuildCommand({ text: "请帮我执行 /eag-build" }).kind, "unknown");
  assert.equal(parser.parseEagBuildCommand({ text: "/eag-build arg" }).kind, "unknown");
  assert.equal(parser.parseEagBuildCommand({ text: undefined }).kind, "unknown");
  assert.equal(parser.parseEagBuildCommand({ text: "/continue" }).kind, "unknown");
});

test("D13. parseEagBuildCommand 对 /eag-build 含图片附件返回 unknown", () => {
  // 验证 parseEagBuildCommand()：含图片附件时返回 unknown（避免误判）
  const parser = new EagCommandParser();
  const result = parser.parseEagBuildCommand({
    text: "/eag-build",
    imageUrls: ["data:image/png;base64,iVBORw0KGgo="],
  });
  assert.equal(result.kind, "unknown");
  assert.equal(result.payload, null);
});

test("D14. extractCodingLoopRequest 字段校验逻辑（通过 parse 间接测试）", () => {
  // 验证 extractCodingLoopRequest 字段校验逻辑（D-S3-7）
  // 通过 parse() 间接测试（extractCodingLoopRequest 为 private 方法）
  const parser = new EagCommandParser();

  // 情况 1：messageParams 为 undefined → payload 为 null
  assert.equal(parser.parse({ text: "/eag-build" }).payload, null);
  // 情况 1：messageParams 为 null → payload 为 null
  assert.equal(parser.parse({ text: "/eag-build", messageParams: null }).payload, null);
  // 情况 1：messageParams 为空对象 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-build", messageParams: {} }).payload, null);
  // 情况 2：codingLoopRequest 字段缺失 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-build", messageParams: { other: "value" } }).payload, null);
  // 情况 2：codingLoopRequest 字段非对象 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-build", messageParams: { codingLoopRequest: "not-object" } }).payload, null);
  // 情况 3：codingLoopRequest 缺 projectRoot → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-build",
      messageParams: { codingLoopRequest: { specContent: "spec" } },
    }).payload,
    null
  );
  // 情况 3：codingLoopRequest 缺 maxIterations（非 number）→ payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-build",
      messageParams: {
        codingLoopRequest: {
          projectRoot: "/test",
          specContent: "spec",
          planContent: "plan",
          tasksContent: "tasks",
          taskDag: { nodes: [], topologicalOrder: [] },
          taskCards: [],
          techStack: ["TS"],
          constitutionContent: "constitution",
          llmClient: {},
          pkcAccessor: {},
          loopGuard: {},
          // 缺 maxIterations / maxFixRounds
        },
      },
    }).payload,
    null
  );
  // 情况 4：字段完整 → payload 为 CodingLoopRequest 对象
  const validRequest = createMinimalCodingLoopRequest();
  const parsed = parser.parse({
    text: "/eag-build",
    messageParams: { codingLoopRequest: validRequest },
  });
  assert.ok(parsed.payload, "字段完整时应返回 CodingLoopRequest 对象");
  assert.equal((parsed.payload as CodingLoopRequest).projectRoot, "/test/project");
  assert.equal((parsed.payload as CodingLoopRequest).specContent, validRequest.specContent);
  assert.equal((parsed.payload as CodingLoopRequest).maxIterations, 10);
  assert.equal((parsed.payload as CodingLoopRequest).maxFixRounds, 3);
});

// ============================================================================
// E. /eag-design 命令测试（parseEagDesignCommand + extractDesignLoopInput）
// ============================================================================

test("E15. parseEagDesignCommand 对 /eag-design 命令返回 eag-design kind", () => {
  // 验证 parseEagDesignCommand()：对 /eag-design 命令返回 kind=eag-design
  const parser = new EagCommandParser();
  const cmd = parser.parseEagDesignCommand({ text: "/eag-design" });
  assert.equal(cmd.kind, "eag-design");
  assert.equal(cmd.payload, null);
});

test("E16. parseEagDesignCommand 对其他 EAG 命令返回 unknown", () => {
  // 验证 parseEagDesignCommand()：对其他 5 个 EAG 命令返回 unknown
  const parser = new EagCommandParser();
  assert.equal(parser.parseEagDesignCommand({ text: "/eag-build" }).kind, "unknown");
  assert.equal(parser.parseEagDesignCommand({ text: "/eag-test" }).kind, "unknown");
  assert.equal(parser.parseEagDesignCommand({ text: "/eag-run" }).kind, "unknown");
  assert.equal(parser.parseEagDesignCommand({ text: "/eag-resume" }).kind, "unknown");
  assert.equal(parser.parseEagDesignCommand({ text: "/eag-status" }).kind, "unknown");
});

test("E17. parseEagDesignCommand 对非命令文本返回 unknown（带参数文本前缀匹配为命令）", () => {
  // 验证 parseEagDesignCommand()：对非命令文本返回 unknown
  const parser = new EagCommandParser();
  assert.equal(parser.parseEagDesignCommand({ text: "请帮我执行 /eag-design" }).kind, "unknown");
  assert.equal(parser.parseEagDesignCommand({ text: undefined }).kind, "unknown");
  // S3.2 前缀匹配（2026-08-19 评审必改项 5）：/eag-design 开头的带参数文本
  // 识别为命令（非 --key=value 形式的裸参数 payload 为 null，参数解析由
  // extractDesignLoopInputFromPrompt 处理，详见 eag-design-command.test.ts）
  const withArg = parser.parseEagDesignCommand({ text: "/eag-design arg" });
  assert.equal(withArg.kind, "eag-design");
  assert.equal(withArg.payload, null);
});

test("E18. parseEagDesignCommand 对 /eag-design 含技能匹配返回 unknown", () => {
  // 验证 parseEagDesignCommand()：含技能匹配时返回 unknown（避免误判）
  const parser = new EagCommandParser();
  const result = parser.parseEagDesignCommand({
    text: "/eag-design",
    skills: [{ name: "test-skill", path: "/", description: "测试技能" }],
  });
  assert.equal(result.kind, "unknown");
  assert.equal(result.payload, null);
});

test("E19. extractDesignLoopInput 字段校验逻辑（通过 parse 间接测试）", () => {
  // 验证 extractDesignLoopInput 字段校验逻辑（D-S3-7）
  const parser = new EagCommandParser();

  // 情况 1：messageParams 为 undefined → payload 为 null
  assert.equal(parser.parse({ text: "/eag-design" }).payload, null);
  // 情况 1：messageParams 为 null → payload 为 null
  assert.equal(parser.parse({ text: "/eag-design", messageParams: null }).payload, null);
  // 情况 1：messageParams 为空对象 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-design", messageParams: {} }).payload, null);
  // 情况 2：designLoopInput 字段缺失 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-design", messageParams: { other: "value" } }).payload, null);
  // 情况 2：designLoopInput 字段非对象 → payload 为 null
  assert.equal(parser.parse({ text: "/eag-design", messageParams: { designLoopInput: "not-object" } }).payload, null);
  // 情况 3：designLoopInput.rawRequirement 缺失 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-design",
      messageParams: { designLoopInput: { projectContext: {} } },
    }).payload,
    null
  );
  // 情况 3：designLoopInput.rawRequirement 为空字符串 → payload 为 null
  assert.equal(
    parser.parse({
      text: "/eag-design",
      messageParams: { designLoopInput: { rawRequirement: "   " } },
    }).payload,
    null
  );
  // 情况 4：字段完整 → payload 为 DesignLoopInput 对象
  const validInput = createMinimalDesignLoopInput();
  const parsed = parser.parse({
    text: "/eag-design",
    messageParams: { designLoopInput: validInput },
  });
  assert.ok(parsed.payload, "字段完整时应返回 DesignLoopInput 对象");
  assert.equal((parsed.payload as DesignLoopInput).rawRequirement, validInput.rawRequirement);
});
