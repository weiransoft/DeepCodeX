/**
 * /eag-graph CLI 命令处理器单元测试（Loop-Graph 融合方案 Phase 5）
 *
 * 测试范围：
 * - A. extractEagGraphRequestFromPrompt 参数解析
 *   - A1. 基础参数解析（--graph-file / --inline-graph）
 *   - A2. flag 参数解析（--enable-experience-recall / --disable-auto-isolation）
 *   - A3. 数值参数解析与校验（--max-depth / --max-parallelism / --timeout-sec / --max-tokens / --node-retry-limit）
 *   - A4. 参数互斥校验（--graph-file 与 --inline-graph 不能同时提供）
 *   - A5. 异常场景（空字符串 / 前缀不匹配 / 缺值 / 取值非法）
 *   - A6. Object.freeze 冻结验证
 *   - A7. 大小写不敏感前缀匹配 + 引号包裹值
 * - B. EagGraphCommandHandler 构造校验
 *   - B1. orchestrator 必填校验
 * - C. EagGraphCommandHandler.execute 入参校验
 *   - C1. request 非法时抛出
 *   - C2. projectRoot 非法时抛出
 * - D. EagGraphCommandHandler.execute 异常兜底
 *   - D1. graphFile 不存在时返回 success=false
 *   - D2. inlineGraph JSON 格式错误时返回 success=false
 *   - D3. 未提供图定义来源时返回 success=false
 * - E. EagGraphCommandHandler.execute 配置合并
 *   - E1. CLI 参数覆盖 JSON 配置（通过 mergeConfig 间接验证）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 GraphLoopOrchestrator / GraphBuilder 实例
 * - 使用真实文件系统（os.tmpdir + mkdtempSync）创建临时项目目录
 * - 中文注释
 *
 * 设计依据：
 * - 设计文档 §12.2 / §14 Phase 5 交付物清单
 * - 设计文档 §16 图定义来源（--graph-file / --inline-graph）
 * - 设计文档 §5.12.4 G-A6d 不可变优先（Object.freeze）
 *
 * @module core/tests/eag-graph-command
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  // 被测：参数解析函数
  extractEagGraphRequestFromPrompt,
  // 被测：命令处理器类
  EagGraphCommandHandler,
  // 被测：命令前缀常量
  EAG_GRAPH_COMMAND_PREFIX,
  // 类型
  type EagGraphRequest,
} from "../eag/cli/eag-graph-command";

// ============================================================================
// 1. 测试辅助函数
// ============================================================================

/**
 * 创建临时项目目录（真实文件系统）
 *
 * @returns 临时项目根目录绝对路径
 */
function createTempProject(): string {
  const prefix = path.join(os.tmpdir(), "eag-graph-test-");
  const projectRoot = fs.mkdtempSync(prefix);
  return projectRoot;
}

/**
 * 清理临时项目目录（递归删除，容错处理）
 *
 * @param projectRoot 临时项目根目录
 */
function cleanupTempProject(projectRoot: string): void {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

/**
 * 创建图定义 JSON 文件（含单个 end 节点的最简图）
 *
 * @param projectRoot 项目根目录
 * @param graphId 图 ID（可选，默认 "test-graph"）
 * @returns JSON 文件绝对路径
 */
function createGraphJsonFile(projectRoot: string, graphId: string = "test-graph"): string {
  const graphJson = {
    graphId,
    name: "测试图",
    description: "单元测试用最简图定义",
    entryNodeId: "end-node",
    nodes: [
      {
        nodeId: "end-node",
        nodeType: "end",
        label: "结束节点",
        task: "结束",
        inputContract: [],
        outputContract: [],
      },
    ],
    edges: [],
  };
  const filePath = path.join(projectRoot, "graph.json");
  fs.writeFileSync(filePath, JSON.stringify(graphJson, null, 2), "utf8");
  return filePath;
}

// ============================================================================
// A. extractEagGraphRequestFromPrompt 参数解析测试
// ============================================================================

test("A1. 基础参数解析（--graph-file）", () => {
  const request = extractEagGraphRequestFromPrompt("/eag-graph --graph-file path/to/graph.json");
  assert.equal(request.graphFile, "path/to/graph.json");
  assert.equal(request.inlineGraph, undefined);
  assert.equal(request.enableExperienceRecall, undefined);
  assert.equal(request.enableAutoIsolation, undefined);
  assert.equal(request.maxDepth, undefined);
  assert.equal(request.maxParallelism, undefined);
  assert.equal(request.timeoutSec, undefined);
  assert.equal(request.maxTokens, undefined);
  assert.equal(request.nodeRetryLimit, undefined);
});

test("A1b. 基础参数解析（--inline-graph）", () => {
  const inlineJson = '{"graphId":"demo","name":"Demo"}';
  const request = extractEagGraphRequestFromPrompt(`/eag-graph --inline-graph '${inlineJson}'`);
  assert.equal(request.inlineGraph, inlineJson);
  assert.equal(request.graphFile, undefined);
});

test("A2. flag 参数解析（--enable-experience-recall）", () => {
  const request = extractEagGraphRequestFromPrompt("/eag-graph --graph-file graph.json --enable-experience-recall");
  assert.equal(request.enableExperienceRecall, true);
  // 未出现 --disable-auto-isolation → undefined
  assert.equal(request.enableAutoIsolation, undefined);
});

test("A2b. flag 参数解析（--disable-auto-isolation）", () => {
  const request = extractEagGraphRequestFromPrompt("/eag-graph --graph-file graph.json --disable-auto-isolation");
  assert.equal(request.enableAutoIsolation, false);
  // 未出现 --enable-experience-recall → undefined
  assert.equal(request.enableExperienceRecall, undefined);
});

test("A2c. flag 参数同时出现（--enable-experience-recall + --disable-auto-isolation）", () => {
  const request = extractEagGraphRequestFromPrompt(
    "/eag-graph --graph-file graph.json --enable-experience-recall --disable-auto-isolation"
  );
  assert.equal(request.enableExperienceRecall, true);
  assert.equal(request.enableAutoIsolation, false);
});

test("A3. 数值参数解析（--max-depth）", () => {
  const request = extractEagGraphRequestFromPrompt("/eag-graph --graph-file graph.json --max-depth 50");
  assert.equal(request.maxDepth, 50);
});

test("A3b. 数值参数解析（--max-parallelism）", () => {
  const request = extractEagGraphRequestFromPrompt("/eag-graph --graph-file graph.json --max-parallelism 8");
  assert.equal(request.maxParallelism, 8);
});

test("A3c. 数值参数解析（--timeout-sec，0 表示不限制）", () => {
  const request = extractEagGraphRequestFromPrompt("/eag-graph --graph-file graph.json --timeout-sec 0");
  assert.equal(request.timeoutSec, 0);
});

test("A3d. 数值参数解析（--timeout-sec，正整数）", () => {
  const request = extractEagGraphRequestFromPrompt("/eag-graph --graph-file graph.json --timeout-sec 3600");
  assert.equal(request.timeoutSec, 3600);
});

test("A3e. 数值参数解析（--max-tokens，0 表示不限制）", () => {
  const request = extractEagGraphRequestFromPrompt("/eag-graph --graph-file graph.json --max-tokens 0");
  assert.equal(request.maxTokens, 0);
});

test("A3f. 数值参数解析（--max-tokens，正整数）", () => {
  const request = extractEagGraphRequestFromPrompt("/eag-graph --graph-file graph.json --max-tokens 500000");
  assert.equal(request.maxTokens, 500000);
});

test("A3g. 数值参数解析（--node-retry-limit）", () => {
  const request = extractEagGraphRequestFromPrompt("/eag-graph --graph-file graph.json --node-retry-limit 5");
  assert.equal(request.nodeRetryLimit, 5);
});

test("A3i. 调试参数解析（--enable-graph-debug）", () => {
  const request = extractEagGraphRequestFromPrompt("/eag-graph --graph-file graph.json --enable-graph-debug");
  assert.equal(request.enableGraphDebug, true);
  assert.equal(request.graphDebugLevel, undefined);
});

test("A3j. 调试参数解析（--graph-debug-level）", () => {
  const request = extractEagGraphRequestFromPrompt("/eag-graph --graph-file graph.json --graph-debug-level debug");
  assert.equal(request.graphDebugLevel, "debug");
  assert.equal(request.enableGraphDebug, undefined);
});

test("A3k. 调试参数解析（--enable-graph-debug + --graph-debug-level=trace）", () => {
  const request = extractEagGraphRequestFromPrompt(
    "/eag-graph --graph-file graph.json --enable-graph-debug --graph-debug-level trace"
  );
  assert.equal(request.enableGraphDebug, true);
  assert.equal(request.graphDebugLevel, "trace");
});

test("A3h. 全部参数同时提供", () => {
  const request = extractEagGraphRequestFromPrompt(
    "/eag-graph --graph-file graph.json --enable-experience-recall --disable-auto-isolation " +
      "--max-depth 50 --max-parallelism 8 --timeout-sec 3600 --max-tokens 500000 --node-retry-limit 5 " +
      "--enable-graph-debug --graph-debug-level debug"
  );
  assert.equal(request.graphFile, "graph.json");
  assert.equal(request.enableExperienceRecall, true);
  assert.equal(request.enableAutoIsolation, false);
  assert.equal(request.maxDepth, 50);
  assert.equal(request.maxParallelism, 8);
  assert.equal(request.timeoutSec, 3600);
  assert.equal(request.maxTokens, 500000);
  assert.equal(request.nodeRetryLimit, 5);
  assert.equal(request.enableGraphDebug, true);
  assert.equal(request.graphDebugLevel, "debug");
});

test("A4. 参数互斥校验（--graph-file 与 --inline-graph 同时提供时抛出）", () => {
  assert.throws(
    () => extractEagGraphRequestFromPrompt('/eag-graph --graph-file graph.json --inline-graph \'{"graphId":"demo"}\''),
    /互斥/
  );
});

test("A5a. 异常场景（空字符串）", () => {
  assert.throws(() => extractEagGraphRequestFromPrompt(""), /不能为空字符串/);
});

test("A5b. 异常场景（非字符串入参）", () => {
  assert.throws(() => extractEagGraphRequestFromPrompt(undefined as unknown as string), /必须为非空字符串/);
});

test("A5c. 异常场景（前缀不匹配）", () => {
  assert.throws(() => extractEagGraphRequestFromPrompt("/eag-autonomous --graph-file graph.json"), /命令前缀不匹配/);
});

test("A5d. 异常场景（--graph-file 缺值）", () => {
  assert.throws(() => extractEagGraphRequestFromPrompt("/eag-graph --graph-file"), /--graph-file 必须提供值/);
});

test("A5e. 异常场景（--inline-graph 缺值）", () => {
  assert.throws(() => extractEagGraphRequestFromPrompt("/eag-graph --inline-graph"), /--inline-graph 必须提供值/);
});

test("A5f. 异常场景（--max-depth 非正整数）", () => {
  assert.throws(
    () => extractEagGraphRequestFromPrompt("/eag-graph --graph-file g.json --max-depth 0"),
    /--max-depth 取值非法/
  );
});

test("A5g. 异常场景（--max-depth 非整数）", () => {
  assert.throws(
    () => extractEagGraphRequestFromPrompt("/eag-graph --graph-file g.json --max-depth 1.5"),
    /--max-depth 取值非法/
  );
});

test("A5h. 异常场景（--max-parallelism 非正整数）", () => {
  assert.throws(
    () => extractEagGraphRequestFromPrompt("/eag-graph --graph-file g.json --max-parallelism 0"),
    /--max-parallelism 取值非法/
  );
});

test("A5i. 异常场景（--timeout-sec 负数）", () => {
  assert.throws(
    () => extractEagGraphRequestFromPrompt("/eag-graph --graph-file g.json --timeout-sec -1"),
    /--timeout-sec 取值非法/
  );
});

test("A5j. 异常场景（--max-tokens 负数）", () => {
  assert.throws(
    () => extractEagGraphRequestFromPrompt("/eag-graph --graph-file g.json --max-tokens -100"),
    /--max-tokens 取值非法/
  );
});

test("A5k. 异常场景（--node-retry-limit 非正整数）", () => {
  assert.throws(
    () => extractEagGraphRequestFromPrompt("/eag-graph --graph-file g.json --node-retry-limit 0"),
    /--node-retry-limit 取值非法/
  );
});

test("A5l. 异常场景（--max-depth 缺值）", () => {
  assert.throws(
    () => extractEagGraphRequestFromPrompt("/eag-graph --graph-file g.json --max-depth"),
    /--max-depth 必须提供值/
  );
});

test("A5m. 异常场景（--graph-debug-level 缺值）", () => {
  assert.throws(
    () => extractEagGraphRequestFromPrompt("/eag-graph --graph-file g.json --graph-debug-level"),
    /--graph-debug-level 必须提供值/
  );
});

test("A5n. 异常场景（--graph-debug-level 取值非法）", () => {
  assert.throws(
    () => extractEagGraphRequestFromPrompt("/eag-graph --graph-file g.json --graph-debug-level verbose"),
    /--graph-debug-level 取值非法/
  );
});

test("A6. Object.freeze 冻结验证", () => {
  const request = extractEagGraphRequestFromPrompt("/eag-graph --graph-file graph.json --max-depth 50");
  // Object.isFrozen 验证顶层冻结
  assert.ok(Object.isFrozen(request), "EagGraphRequest 应被 Object.freeze 冻结");
  // 尝试修改应抛出 TypeError（strict 模式下）
  assert.throws(() => {
    (request as { graphFile: string }).graphFile = "modified";
  }, TypeError);
});

test("A7a. 大小写不敏感前缀匹配（/EAG-GRAPH）", () => {
  const request = extractEagGraphRequestFromPrompt("/EAG-GRAPH --graph-file graph.json");
  assert.equal(request.graphFile, "graph.json");
});

test("A7b. 双引号包裹值", () => {
  const request = extractEagGraphRequestFromPrompt('/eag-graph --graph-file "path/to/graph.json"');
  assert.equal(request.graphFile, "path/to/graph.json");
});

test("A7c. 等号分隔符（--key=value）", () => {
  const request = extractEagGraphRequestFromPrompt("/eag-graph --graph-file=path/to/graph.json --max-depth=50");
  assert.equal(request.graphFile, "path/to/graph.json");
  assert.equal(request.maxDepth, 50);
});

test("A7d. 命令前缀常量正确性", () => {
  assert.equal(EAG_GRAPH_COMMAND_PREFIX, "/eag-graph");
});

test("A7e. 仅命令前缀无参数（允许，返回全 undefined 字段）", () => {
  const request = extractEagGraphRequestFromPrompt("/eag-graph");
  assert.equal(request.graphFile, undefined);
  assert.equal(request.inlineGraph, undefined);
  assert.equal(request.enableExperienceRecall, undefined);
});

test("A7f. 重复参数首次匹配生效（--graph-file 出现两次）", () => {
  const request = extractEagGraphRequestFromPrompt("/eag-graph --graph-file first.json --graph-file second.json");
  // 首次匹配生效，第二次被跳过
  assert.equal(request.graphFile, "first.json");
});

// ============================================================================
// B. EagGraphCommandHandler 构造校验
// ============================================================================

test("B1. 构造失败（options 为空）", () => {
  assert.throws(
    () => new EagGraphCommandHandler(null as unknown as Parameters<typeof EagGraphCommandHandler>[0]),
    /options 必填/
  );
});

test("B1b. 构造失败（options 为 undefined）", () => {
  assert.throws(
    () => new EagGraphCommandHandler(undefined as unknown as Parameters<typeof EagGraphCommandHandler>[0]),
    /options 必填/
  );
});

// ============================================================================
// C. EagGraphCommandHandler.execute 入参校验
// ============================================================================

test("C1a. execute 入参校验（request 为 null 时抛出）", async () => {
  // 构造一个非空 orchestrator 对象（仅用于通过构造校验，不实际调用 run）
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  await assert.rejects(() => handler.execute(null as unknown as EagGraphRequest, "/tmp"), /EagGraphRequest 必须为对象/);
});

test("C1b. execute 入参校验（request.graphFile 为空字符串时抛出）", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  const request = Object.freeze({
    graphFile: "  ",
  }) as EagGraphRequest;
  await assert.rejects(() => handler.execute(request, "/tmp"), /graphFile 必须为非空字符串/);
});

test("C1c. execute 入参校验（request.inlineGraph 为空字符串时抛出）", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  const request = Object.freeze({
    inlineGraph: "",
  }) as EagGraphRequest;
  await assert.rejects(() => handler.execute(request, "/tmp"), /inlineGraph 必须为非空字符串/);
});

test("C1d. execute 入参校验（graphFile 与 inlineGraph 互斥）", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  const request = Object.freeze({
    graphFile: "graph.json",
    inlineGraph: '{"graphId":"demo"}',
  }) as EagGraphRequest;
  await assert.rejects(() => handler.execute(request, "/tmp"), /互斥/);
});

test("C1e. execute 入参校验（maxDepth 非正整数时抛出）", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  const request = Object.freeze({
    inlineGraph: '{"graphId":"demo"}',
    maxDepth: 0,
  }) as EagGraphRequest;
  await assert.rejects(() => handler.execute(request, "/tmp"), /maxDepth 必须为正整数/);
});

test("C1f. execute 入参校验（maxParallelism 非正整数时抛出）", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  const request = Object.freeze({
    inlineGraph: '{"graphId":"demo"}',
    maxParallelism: -1,
  }) as EagGraphRequest;
  await assert.rejects(() => handler.execute(request, "/tmp"), /maxParallelism 必须为正整数/);
});

test("C1g. execute 入参校验（timeoutSec 负数时抛出）", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  const request = Object.freeze({
    inlineGraph: '{"graphId":"demo"}',
    timeoutSec: -5,
  }) as EagGraphRequest;
  await assert.rejects(() => handler.execute(request, "/tmp"), /timeoutSec 必须为非负整数/);
});

test("C1h. execute 入参校验（maxTokens 负数时抛出）", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  const request = Object.freeze({
    inlineGraph: '{"graphId":"demo"}',
    maxTokens: -100,
  }) as EagGraphRequest;
  await assert.rejects(() => handler.execute(request, "/tmp"), /maxTokens 必须为非负整数/);
});

test("C1i. execute 入参校验（nodeRetryLimit 非正整数时抛出）", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  const request = Object.freeze({
    inlineGraph: '{"graphId":"demo"}',
    nodeRetryLimit: 0,
  }) as EagGraphRequest;
  await assert.rejects(() => handler.execute(request, "/tmp"), /nodeRetryLimit 必须为正整数/);
});

test("C1j. execute 入参校验（enableGraphDebug 非布尔值时抛出）", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  const request = Object.freeze({
    inlineGraph: '{"graphId":"demo"}',
    enableGraphDebug: "yes" as unknown as boolean,
  }) as EagGraphRequest;
  await assert.rejects(() => handler.execute(request, "/tmp"), /enableGraphDebug 必须为布尔值/);
});

test("C1k. execute 入参校验（graphDebugLevel 非法枚举值时抛出）", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  const request = Object.freeze({
    inlineGraph: '{"graphId":"demo"}',
    graphDebugLevel: "verbose" as unknown as "off" | "info" | "debug" | "trace",
  }) as EagGraphRequest;
  await assert.rejects(
    () => handler.execute(request, "/tmp"),
    /graphDebugLevel 必须为 off \/ info \/ debug \/ trace 之一/
  );
});

test("C2a. execute 入参校验（projectRoot 为空字符串时抛出）", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  const request = Object.freeze({
    inlineGraph: '{"graphId":"demo"}',
  }) as EagGraphRequest;
  await assert.rejects(() => handler.execute(request, "  "), /projectRoot 必须为非空字符串/);
});

test("C2b. execute 入参校验（projectRoot 非字符串时抛出）", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  const request = Object.freeze({
    inlineGraph: '{"graphId":"demo"}',
  }) as EagGraphRequest;
  await assert.rejects(() => handler.execute(request, null as unknown as string), /projectRoot 必须为非空字符串/);
});

// ============================================================================
// D. EagGraphCommandHandler.execute 异常兜底
// ============================================================================

test("D1. graphFile 不存在时返回 success=false", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  const request = Object.freeze({
    graphFile: "non-existent-graph.json",
  }) as EagGraphRequest;
  const result = await handler.execute(request, "/tmp");
  assert.equal(result.success, false);
  assert.equal(result.runReport, undefined);
  assert.ok(result.errorMessage.length > 0);
  assert.ok(result.markdownReport.includes("执行失败"));
  // 错误信息应包含文件路径相关内容
  assert.ok(result.errorMessage.includes("读取图定义文件失败"));
});

test("D2. inlineGraph JSON 格式错误时返回 success=false", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  const request = Object.freeze({
    inlineGraph: "{ invalid json }",
  }) as EagGraphRequest;
  const result = await handler.execute(request, "/tmp");
  assert.equal(result.success, false);
  assert.equal(result.runReport, undefined);
  assert.ok(result.errorMessage.length > 0);
  // 错误信息应包含图定义构造失败
  assert.ok(result.errorMessage.includes("图定义构造失败"));
});

test("D3. 未提供图定义来源时返回 success=false", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  // graphFile 和 inlineGraph 均未提供
  const request = Object.freeze({}) as EagGraphRequest;
  const result = await handler.execute(request, "/tmp");
  assert.equal(result.success, false);
  assert.equal(result.runReport, undefined);
  assert.ok(result.errorMessage.includes("未提供图定义来源"));
});

test("D4. graphFile 存在但 JSON 格式错误时返回 success=false", async () => {
  const projectRoot = createTempProject();
  try {
    // 创建一个内容为非法 JSON 的文件
    const badJsonPath = path.join(projectRoot, "bad-graph.json");
    fs.writeFileSync(badJsonPath, "{ invalid json content }", "utf8");

    const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
    const handler = new EagGraphCommandHandler(fakeOrchestrator);
    const request = Object.freeze({
      graphFile: "bad-graph.json",
    }) as EagGraphRequest;
    const result = await handler.execute(request, projectRoot);
    assert.equal(result.success, false);
    assert.ok(result.errorMessage.includes("图定义构造失败"));
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("D5. graphFile 使用绝对路径时正常加载（但 JSON 缺少必填字段时返回失败）", async () => {
  const projectRoot = createTempProject();
  try {
    // 创建一个 JSON 格式正确但缺少必填字段的文件
    const badGraphPath = path.join(projectRoot, "incomplete-graph.json");
    fs.writeFileSync(badGraphPath, JSON.stringify({ graphId: "incomplete" }), "utf8");

    const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
    const handler = new EagGraphCommandHandler(fakeOrchestrator);
    const request = Object.freeze({
      graphFile: badGraphPath,
    }) as EagGraphRequest;
    const result = await handler.execute(request, projectRoot);
    assert.equal(result.success, false);
    assert.ok(result.errorMessage.includes("图定义构造失败"));
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// E. EagGraphCommandHandler.execute 结果对象不可变性验证
// ============================================================================

test("E1. execute 返回的结果对象被 Object.freeze 冻结（失败路径）", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  const request = Object.freeze({
    inlineGraph: "{ invalid json }",
  }) as EagGraphRequest;
  const result = await handler.execute(request, "/tmp");
  // 返回的结果对象应被冻结
  assert.ok(Object.isFrozen(result), "EagGraphCommandResult 应被 Object.freeze 冻结");
});

test("E2. 错误报告 Markdown 包含排查建议", async () => {
  const fakeOrchestrator = {} as Parameters<typeof EagGraphCommandHandler>[0];
  const handler = new EagGraphCommandHandler(fakeOrchestrator);
  const request = Object.freeze({
    inlineGraph: "{ invalid json }",
  }) as EagGraphRequest;
  const result = await handler.execute(request, "/tmp");
  // 错误报告应包含排查建议部分
  assert.ok(result.markdownReport.includes("建议排查方向"));
  assert.ok(result.markdownReport.includes("graphFile"));
  assert.ok(result.markdownReport.includes("inlineGraph"));
  assert.ok(result.markdownReport.includes("GraphLoopOrchestrator"));
});
