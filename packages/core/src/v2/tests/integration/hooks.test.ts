/**
 * V2 钩子集成测试
 *
 * 测试覆盖：
 * - HK-01: onAfterToolExecution 钩子增强 edit 工具的 diff preview
 * - HK-02: onBeforeToolExecution 钩子拒绝黑名单命令（F-07 安全修复）
 * - HK-03: onBeforeToolExecution 钩子放行白名单命令
 * - HK-04: V2 未启用时（无钩子）行为不变（向后兼容）
 * - HK-05: onBeforeToolExecution 返回 ask_user 时设置 awaitUserResponse
 * - HK-06: 单次 edit 的 diff 增强只执行 1 次（P1-04 验收：计数测试）
 *
 * 所有测试使用真实文件系统和真实 ApprovalGate，无 mock。
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolExecutor } from "../../../tools/executor";
import { createEditHandlerAfterExecutionHook } from "../../integration/edit-handler-hook";
import { createApprovalBeforeExecutionHook } from "../../integration/approval-hook";
import { ApprovalGate } from "../../approval/approval-gate";

// 测试 fixture：每个测试用例独立的临时目录
let tempDir: string;

// 测试计数器，用于生成独立的 session ID（避免 fileState 跨测试污染）
let testCounter = 0;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-v2-hooks-"));
  testCounter += 1;
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * 生成独立的 session ID
 * 避免不同测试用例之间的 fileState/snippet 残留干扰
 */
function uniqueSessionId(prefix = "test"): string {
  return `${prefix}-session-${testCounter}`;
}

test("HK-01: onAfterToolExecution 钩子增强 edit 工具的 diff preview", async () => {
  // 准备测试文件：包含将被替换的 "old line" 文本
  const filePath = path.join(tempDir, "test.txt");
  fs.writeFileSync(filePath, "hello\nold line\nworld\n", "utf8");

  // 步骤 1：先读取文件获取 snippet
  // edit 工具要求先调用 read 创建 fileState 和 snippet
  const sessionId = uniqueSessionId("hk01");
  const executor = new ToolExecutor(tempDir);
  const readResult = await executor.executeToolCalls(sessionId, [
    {
      id: "read-1",
      type: "function",
      function: { name: "read", arguments: JSON.stringify({ file_path: filePath }) },
    },
  ]);

  // 验证 read 成功并获取 snippet.id
  // 注意：read-handler 返回的 metadata 结构为 { snippet: { id, filePath, ... } }
  assert.equal(readResult[0].result.ok, true);
  const snippetMeta = readResult[0].result.metadata?.["snippet"] as { id?: string } | undefined;
  const snippetId = snippetMeta?.id;
  assert.ok(snippetId, "read 应返回 snippet.id");

  // 步骤 2：使用 onAfterToolExecution 钩子执行 edit
  // 钩子会在 edit 成功后用 enhanceDiffPreview 增强 diff 预览
  const executorWithHook = new ToolExecutor(tempDir);
  const editResult = await executorWithHook.executeToolCalls(
    sessionId,
    [
      {
        id: "edit-1",
        type: "function",
        function: {
          name: "edit",
          arguments: JSON.stringify({
            file_path: filePath,
            snippet_id: snippetId,
            old_string: "old line",
            new_string: "new line",
          }),
        },
      },
    ],
    {
      onAfterToolExecution: createEditHandlerAfterExecutionHook({ colorEnabled: false, contextLines: 3 }),
    }
  );

  // 验证 edit 成功
  assert.equal(editResult[0].result.ok, true);

  // 验证增强 diff 预览：metadata 中应包含 diff_preview、diff_stats、diff_hunks
  const metadata = editResult[0].result.metadata;
  assert.ok(metadata?.["diff_preview"], "diff_preview 应存在（被钩子替换）");
  assert.ok(metadata?.["diff_stats"], "diff_stats 应存在（钩子新增）");
  assert.ok(metadata?.["diff_hunks"], "diff_hunks 应存在（钩子新增）");

  // 验证 diff 统计：1 行新增 + 1 行删除
  // "old line" 被替换为 "new line"，Myers diff 识别为 1 删 1 增
  const stats = metadata["diff_stats"] as { additions: number; deletions: number };
  assert.equal(stats.additions, 1, "应有 1 行新增");
  assert.equal(stats.deletions, 1, "应有 1 行删除");

  // 验证 diff 内容包含替换前后的文本
  const diffPreview = metadata["diff_preview"] as string;
  assert.ok(diffPreview.includes("-old line"), "diff 应包含删除的 old line");
  assert.ok(diffPreview.includes("+new line"), "diff 应包含新增的 new line");
});

test("HK-02: onBeforeToolExecution 钩子拒绝黑名单命令（F-07 安全修复）", async () => {
  // 测试场景：YOLO+Auto 模式 + rm -rf /（黑名单命令）
  // 期望：黑名单优先于所有审批模式判断，返回 deny
  const executor = new ToolExecutor(tempDir);
  const gate = new ApprovalGate();

  const result = await executor.executeToolCalls(
    uniqueSessionId("hk02"),
    [
      {
        id: "bash-1",
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: "rm -rf /" }),
        },
      },
    ],
    {
      onBeforeToolExecution: createApprovalBeforeExecutionHook(gate, "yolo", "auto"),
    }
  );

  // 验证：即使 YOLO+Auto，黑名单命令也被拒绝
  assert.equal(result[0].result.ok, false);
  // error 信息应包含"拒绝"或"denied"
  assert.match(result[0].result.error ?? "", /拒绝|denied/i);
});

test("HK-03: onBeforeToolExecution 钩子放行白名单命令", async () => {
  // 测试场景：Agent+Suggest 模式 + ls -la（白名单命令）
  // 期望：白名单命令自动批准，bash 工具正常执行
  const executor = new ToolExecutor(tempDir);
  const gate = new ApprovalGate();

  const result = await executor.executeToolCalls(
    uniqueSessionId("hk03"),
    [
      {
        id: "bash-2",
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: "ls -la" }),
        },
      },
    ],
    {
      onBeforeToolExecution: createApprovalBeforeExecutionHook(gate, "agent", "suggest"),
    }
  );

  // 验证：白名单命令被批准并执行成功
  assert.equal(result[0].result.ok, true);
});

test("HK-04: V2 未启用时（无钩子）行为不变（向后兼容）", async () => {
  // 测试场景：未传入任何 V2 钩子，executor 应按原流程执行
  // 期望：read 工具成功，metadata 中不包含 V2 扩展字段
  const filePath = path.join(tempDir, "test.txt");
  fs.writeFileSync(filePath, "hello\n", "utf8");

  const executor = new ToolExecutor(tempDir);
  const result = await executor.executeToolCalls(uniqueSessionId("hk04"), [
    {
      id: "read-1",
      type: "function",
      function: { name: "read", arguments: JSON.stringify({ file_path: filePath }) },
    },
  ]);

  // 验证：无钩子时正常执行
  assert.equal(result[0].result.ok, true);
  // 验证：无 V2 扩展字段（diff_stats、diff_hunks 仅由 onAfterToolExecution 钩子添加）
  assert.equal(result[0].result.metadata?.["diff_stats"], undefined);
  assert.equal(result[0].result.metadata?.["diff_hunks"], undefined);
  // 验证：未设置 awaitUserResponse（仅 onBeforeToolExecution 返回 ask_user 时设置）
  assert.equal(result[0].result.awaitUserResponse, undefined);
});

test("HK-05: onBeforeToolExecution 返回 ask_user 时设置 awaitUserResponse", async () => {
  // 测试场景：Agent+Suggest 模式 + npm install express（中等风险命令）
  // 期望：风险评分落在 caution 区间（31-90），返回 ask_user
  const executor = new ToolExecutor(tempDir);
  const gate = new ApprovalGate();

  const result = await executor.executeToolCalls(
    uniqueSessionId("hk05"),
    [
      {
        id: "bash-3",
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: "npm install express" }),
        },
      },
    ],
    {
      onBeforeToolExecution: createApprovalBeforeExecutionHook(gate, "agent", "suggest"),
    }
  );

  // 验证：中等风险命令触发 ask_user，executor 设置 awaitUserResponse 标志
  assert.equal(result[0].result.ok, false);
  assert.equal(result[0].result.awaitUserResponse, true);
});

test("HK-06: 单次 edit 的 diff 增强只执行 1 次（P1-04 验收：计数测试）", async () => {
  // 测试场景：同时注入 V2 工具级钩子（onAfterToolExecution）与
  // V1 文件级钩子（onAfterFileMutation），验证 diff 增强不会被重复触发。
  // P1-04 职责划分：edit 的 diff 增强仅由 onAfterToolExecution 在
  // ToolExecutor 层执行 1 次，文件级钩子只做检查点记录、不做 diff 处理。
  const filePath = path.join(tempDir, "test-hk06.txt");
  fs.writeFileSync(filePath, "alpha\nbeta\ngamma\n", "utf8");

  // 步骤 1：读取文件获取 snippet
  const sessionId = uniqueSessionId("hk06");
  const executor = new ToolExecutor(tempDir);
  const readResult = await executor.executeToolCalls(sessionId, [
    {
      id: "read-1",
      type: "function",
      function: { name: "read", arguments: JSON.stringify({ file_path: filePath }) },
    },
  ]);
  assert.equal(readResult[0].result.ok, true);
  const snippetMeta = readResult[0].result.metadata?.["snippet"] as { id?: string } | undefined;
  const snippetId = snippetMeta?.id;
  assert.ok(snippetId, "read 应返回 snippet.id");

  // 步骤 2：构造带计数器的钩子集合
  // diffEnhanceCount 记录 onAfterToolExecution（diff 增强）触发次数
  // fileMutationCount 记录 onAfterFileMutation（文件级检查点）触发次数
  let diffEnhanceCount = 0;
  let fileMutationCount = 0;
  const baseHook = createEditHandlerAfterExecutionHook({ colorEnabled: false, contextLines: 3 });

  const editResult = await executor.executeToolCalls(
    sessionId,
    [
      {
        id: "edit-1",
        type: "function",
        function: {
          name: "edit",
          arguments: JSON.stringify({
            file_path: filePath,
            snippet_id: snippetId,
            old_string: "beta",
            new_string: "BETA",
          }),
        },
      },
    ],
    {
      // V2 工具级钩子：包装一层计数器，统计 diff 增强实际执行次数
      onAfterToolExecution: (result, context) => {
        diffEnhanceCount += 1;
        return baseHook(result, context);
      },
      // V1 文件级钩子：只计数（对应 session.ts 检查点记录），不做 diff 处理
      onAfterFileMutation: () => {
        fileMutationCount += 1;
      },
    }
  );

  // 验证 edit 成功且 diff 增强生效
  assert.equal(editResult[0].result.ok, true);
  assert.ok(editResult[0].result.metadata?.["diff_stats"], "diff 增强应已生效");

  // P1-04 核心验收：单次 edit 的 diff 增强只执行 1 次
  assert.equal(diffEnhanceCount, 1, "onAfterToolExecution 必须恰好触发 1 次（ToolExecutor 层唯一触发点）");
  // 文件级钩子允许触发（检查点记录），但它不产出 diff 字段——
  // diff_stats/diff_hunks 仅由 onAfterToolExecution 写入，两者职责无重叠
  assert.ok(fileMutationCount >= 1, "onAfterFileMutation 应被触发（检查点记录职责）");
});
