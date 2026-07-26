/**
 * /eag-graph CLI 命令处理器（Loop-Graph 融合方案 Phase 5）
 *
 * 本模块实现 `/eag-graph` 命令的参数解析与执行调度，是 Loop-Graph 融合架构
 * 对接 session.ts 主对话循环的入口。
 *
 * 核心职责（对齐设计文档 §12.2 / §14 Phase 5 + §16 图定义来源）：
 * 1. 参数解析：从命令字符串 `/eag-graph --graph-file path/to/graph.json --max-depth 50`
 *    提取 graph-file / inline-graph / enable-experience-recall / max-depth 等参数
 * 2. 图定义构造：通过 GraphBuilder.fromJson() 从 JSON 文件或内联 JSON 构造 WorkGraph
 * 3. 配置合并：CLI 参数中显式提供的配置字段覆盖 JSON 中的 config
 * 4. 编排调度：委托 GraphLoopOrchestrator.run() 执行图遍历
 * 5. 结果渲染：将 GraphRunReport 格式化为人类可读的 Markdown 报告
 *
 * 与 /eag-autonomous 命令的设计同构（对齐 eag-autonomous-command.ts 模式）：
 * - 命令字符串本身含参数（非严格匹配），参数由独立函数 extractEagGraphRequestFromPrompt 解析
 * - 解析失败的错误信息含参数名与取值范围（便于调用方诊断）
 * - 装配的请求对象通过 Object.freeze 冻结（§5.12.4 G-A6d 不可变优先）
 *
 * 命令格式规范（对齐设计文档 §16.1 图定义来源）：
 * ```
 * /eag-graph --graph-file path/to/graph.json --enable-experience-recall --max-depth 50
 * /eag-graph --inline-graph '{"graphId":"demo","name":"Demo",...}'
 * /eag-graph --graph-file path/to/graph.json --enable-graph-debug --graph-debug-level debug
 * ```
 * 参数说明：
 * - --graph-file（可选）：图定义 JSON 文件路径（与 --inline-graph 互斥）
 * - --inline-graph（可选）：内联图定义 JSON 字符串（与 --graph-file 互斥）
 * - --enable-experience-recall（可选，flag）：启用经验召回（Layer 3）
 * - --disable-auto-isolation（可选，flag）：禁用节点失败自动隔离
 * - --max-depth（可选，默认 100）：最大遍历深度，正整数
 * - --max-parallelism（可选，默认 4）：最大并行度，正整数
 * - --timeout-sec（可选，默认 0）：图级超时秒数，非负整数（0 表示不限制）
 * - --max-tokens（可选，默认 0）：图级 token 预算，非负整数（0 表示不限制）
 * - --node-retry-limit（可选，默认 3）：节点失败重试次数，正整数
 * - --enable-graph-debug（可选，flag）：启用图调试器（TOP-5）
 * - --graph-debug-level（可选，默认 info）：图调试日志级别，可选 off/info/debug/trace
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 顶层配置常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * @module eag/cli/eag-graph-command
 */

import * as fs from "fs";
import * as path from "path";
import type { GraphRunReport, WorkGraph, WorkGraphConfig, GraphDebugLogLevel } from "../graph/graph-loop-models";
import type { GraphLoopOrchestratorOptions } from "../graph/graph-loop-protocols";
import { GraphBuilder } from "../graph/graph-builder";
import { GraphLifecycleManager } from "../graph/graph-lifecycle-manager";
import { createGraphDebugger } from "../graph/graph-debug";

// ============================================================================
// 1. 常量定义（不可变，Object.freeze 冻结）
// ============================================================================

/**
 * /eag-graph 命令前缀字符串
 *
 * 用于检测用户输入是否为 /eag-graph 命令。
 * 使用 Object.freeze 冻结，防止运行期篡改。
 */
export const EAG_GRAPH_COMMAND_PREFIX = "/eag-graph" as const;

/**
 * /eag-graph 命令默认最大遍历深度
 *
 * 对齐 DEFAULT_WORK_GRAPH_CONFIG.maxDepth 默认值（100）。
 * 取值 100：覆盖大多数图编排场景的深度需求。
 */
const EAG_GRAPH_DEFAULT_MAX_DEPTH = 100 as const;

/**
 * /eag-graph 命令默认最大并行度
 *
 * 对齐 DEFAULT_WORK_GRAPH_CONFIG.maxParallelism 默认值（4）。
 * 取值 4：fan-out 默认并发上限（保守值，避免资源争抢）。
 */
const EAG_GRAPH_DEFAULT_MAX_PARALLELISM = 4 as const;

/**
 * /eag-graph 命令默认图级超时（秒）
 *
 * 对齐 DEFAULT_WORK_GRAPH_CONFIG.timeoutSec 默认值（0）。
 * 取值 0：默认不限制超时（由调用方按需配置）。
 */
const EAG_GRAPH_DEFAULT_TIMEOUT_SEC = 0 as const;

/**
 * /eag-graph 命令默认图级 token 预算
 *
 * 对齐 DEFAULT_WORK_GRAPH_CONFIG.maxTokens 默认值（0）。
 * 取值 0：默认不限制 token（由节点级 maxTokens 控制）。
 */
const EAG_GRAPH_DEFAULT_MAX_TOKENS = 0 as const;

/**
 * /eag-graph 命令默认节点失败重试次数
 *
 * 对齐 DEFAULT_WORK_GRAPH_CONFIG.nodeRetryLimit 默认值（3）。
 * 取值 3：单个节点最多重试 3 次（与 §11.4 双层重试抑制配合）。
 */
const EAG_GRAPH_DEFAULT_NODE_RETRY_LIMIT = 3 as const;

// ============================================================================
// 2. 类型定义（不可变优先，所有字段 readonly）
// ============================================================================

/**
 * /eag-graph 命令请求对象（Phase 5）
 *
 * 由 extractEagGraphRequestFromPrompt() 从命令字符串解析后装配，
 * 再由 session.ts 注入到 userPrompt.messageParams.graphRequest。
 *
 * 字段说明（对齐设计文档 §16 图定义来源 + §7.1 WorkGraphConfig）：
 * - graphFile: 图定义 JSON 文件路径（与 inlineGraph 互斥）
 * - inlineGraph: 内联图定义 JSON 字符串（与 graphFile 互斥）
 * - enableExperienceRecall: 是否启用经验召回（undefined 表示使用 JSON 中的配置）
 * - enableAutoIsolation: 是否启用节点失败自动隔离（undefined 表示使用 JSON 中的配置）
 * - maxDepth: 最大遍历深度（undefined 表示使用 JSON 中的配置）
 * - maxParallelism: 最大并行度（undefined 表示使用 JSON 中的配置）
 * - timeoutSec: 图级超时秒数（undefined 表示使用 JSON 中的配置）
 * - maxTokens: 图级 token 预算（undefined 表示使用 JSON 中的配置）
 * - nodeRetryLimit: 节点失败重试次数（undefined 表示使用 JSON 中的配置）
 * - enableGraphDebug: 是否启用图调试器（undefined 表示不启用）
 * - graphDebugLevel: 图调试日志级别（undefined 时若启用调试则默认 info）
 *
 * 配置覆盖策略：
 * - 所有配置字段使用 undefined 表示"未通过 CLI 显式提供"
 * - handler 在构造 WorkGraph 时，仅覆盖非 undefined 的字段
 * - 这样 CLI 参数仅在用户显式提供时覆盖 JSON 配置，避免破坏 JSON 中已有的配置
 *
 * 不可变优先原则（§5.12.4 G-A6d）：
 * - 所有字段为 readonly
 * - 实例由 extractEagGraphRequestFromPrompt() 通过 Object.freeze 冻结后返回
 */
export interface EagGraphRequest {
  /** 图定义 JSON 文件路径（与 inlineGraph 互斥，至少提供一个或通过 messageParams 注入） */
  readonly graphFile?: string;
  /** 内联图定义 JSON 字符串（与 graphFile 互斥） */
  readonly inlineGraph?: string;
  /** 是否启用经验召回（undefined 表示使用 JSON 中的配置） */
  readonly enableExperienceRecall?: boolean;
  /** 是否启用节点失败自动隔离（undefined 表示使用 JSON 中的配置） */
  readonly enableAutoIsolation?: boolean;
  /** 最大遍历深度（undefined 表示使用 JSON 中的配置，默认 100） */
  readonly maxDepth?: number;
  /** 最大并行度（undefined 表示使用 JSON 中的配置，默认 4） */
  readonly maxParallelism?: number;
  /** 图级超时秒数（undefined 表示使用 JSON 中的配置，0 表示不限制） */
  readonly timeoutSec?: number;
  /** 图级 token 预算（undefined 表示使用 JSON 中的配置，0 表示不限制） */
  readonly maxTokens?: number;
  /** 节点失败重试次数（undefined 表示使用 JSON 中的配置，默认 3） */
  readonly nodeRetryLimit?: number;
  /** 是否启用图调试器（undefined 表示不启用，--enable-graph-debug 出现时设为 true） */
  readonly enableGraphDebug?: boolean;
  /** 图调试日志级别（undefined 时若启用调试则默认 info，可选 off/info/debug/trace） */
  readonly graphDebugLevel?: GraphDebugLogLevel;
}

/**
 * /eag-graph 命令执行结果（Phase 5）
 *
 * 由 EagGraphCommandHandler.execute() 返回，包含：
 * - 原始 GraphRunReport（不可变）
 * - 格式化的 Markdown 报告（人类可读）
 * - 执行是否成功（success）
 * - 错误信息（失败时填写）
 *
 * 字段全部 readonly——结果一经产出即不可变。
 */
export interface EagGraphCommandResult {
  /** 执行是否成功（true=orchestrator.run() 未抛异常且 finalStatus 非 failed） */
  readonly success: boolean;
  /** 原始图运行报告（失败时为 undefined） */
  readonly runReport?: Readonly<GraphRunReport>;
  /** 格式化的 Markdown 报告（人类可读，含 finalStatus / 遍历路径 / 节点结果 / 统计） */
  readonly markdownReport: string;
  /** 错误信息（失败时填写，成功时为空字符串） */
  readonly errorMessage: string;
}

// ============================================================================
// 3. 参数解析函数（extractEagGraphRequestFromPrompt）
// ============================================================================

/**
 * 从 /eag-graph 命令字符串解析请求对象（Phase 5）
 *
 * 此函数为**导出的独立函数**（非类方法），供 session.ts 在
 * 构造 userPrompt.messageParams.graphRequest 时调用。
 *
 * 算法（对齐 §5 CLI 命令规范 + 参考 extractEagAutonomousRequestFromPrompt 模式）：
 * 1. 校验 prompt 为非空字符串
 * 2. 移除命令前缀 /eag-graph（大小写不敏感，匹配后裁剪）
 * 3. 用正则解析 --key value 形式参数（支持单引号 / 双引号包裹的值）
 * 4. 校验参数互斥性：--graph-file 与 --inline-graph 不能同时提供
 * 5. 校验可选参数取值范围与类型：
 *    - --max-depth: 正整数
 *    - --max-parallelism: 正整数
 *    - --timeout-sec: 非负整数（0 表示不限制）
 *    - --max-tokens: 非负整数（0 表示不限制）
 *    - --node-retry-limit: 正整数
 *    - --graph-debug-level: 可选 off / info / debug / trace
 * 6. 装配 EagGraphRequest 对象并 Object.freeze 冻结
 * 7. 任一校验失败抛 Error，错误信息含参数名与取值范围
 *
 * 配置覆盖策略说明：
 * - flag 参数（--enable-experience-recall / --disable-auto-isolation / --enable-graph-debug）出现时设为对应布尔值
 * - 未出现的 flag 参数保持 undefined（不覆盖 JSON 配置）
 * - 数值参数出现时解析为 number，未出现时保持 undefined
 * - --graph-debug-level 出现时校验为合法级别字符串，未出现时保持 undefined
 *
 * 不可变优先原则（§5.12.4 G-A6d）：
 * - 返回的 EagGraphRequest 对象通过 Object.freeze 冻结
 *
 * @param prompt /eag-graph 命令字符串（含命令前缀与参数）
 * @returns 冻结的 EagGraphRequest 对象
 * @throws {Error} 当 prompt 非字符串、命令前缀不匹配、参数互斥冲突、取值范围非法时抛出
 */
export function extractEagGraphRequestFromPrompt(prompt: string): EagGraphRequest {
  // 步骤 1：校验 prompt 为非空字符串
  if (typeof prompt !== "string") {
    throw new Error("extractEagGraphRequestFromPrompt: prompt 必须为非空字符串");
  }
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    throw new Error("extractEagGraphRequestFromPrompt: prompt 不能为空字符串");
  }

  // 步骤 2：移除命令前缀 /eag-graph（大小写不敏感）
  // 使用正则匹配前缀（大小写不敏感），后跟空白字符或字符串结尾
  const prefixMatch = /^\/eag-graph(?:\s+|$)/i.exec(trimmed);
  if (!prefixMatch) {
    throw new Error(
      `extractEagGraphRequestFromPrompt: 命令前缀不匹配，期望以 /eag-graph 开头（大小写不敏感），实际为: ${trimmed}`
    );
  }
  // 截取前缀之后的部分作为参数字符串
  const argsPart = trimmed.slice(prefixMatch[0].length).trim();

  // 步骤 3：用正则解析 --key value 形式参数
  // 正则说明（与 extractEagAutonomousRequestFromPrompt 一致）：
  // - --([\w][\w-]*)                              匹配参数名 → 捕获组 1
  // - (?:[=\s]+                                   分隔符（= 或空白，至少一个）
  //   (?:"([^"]*)"                                双引号值 → 捕获组 2
  //   |'([^']*)'                                  单引号值 → 捕获组 3
  //   |(?!--)([^\s"']+)                           裸值（不以 -- 开头）→ 捕获组 4
  //   ))?                                         整个值组可选（支持 flag 形式）
  // - (?=\s|$)                                    前瞻断言：匹配结束位置必须是空白或字符串结尾
  const argPattern = /--([\w][\w-]*)(?:[=\s]+(?:"([^"]*)"|'([^']*)'|(?!--)([^\s"']+)))?(?=\s|$)/g;
  const args: Record<string, string | true> = {};

  // 注意：重复参数首次匹配生效（后续覆盖被跳过）
  let match: RegExpExecArray | null;
  while ((match = argPattern.exec(argsPart)) !== null) {
    const key = match[1];
    // 三种值形式：双引号（match[2]）、单引号（match[3]）、裸值（match[4]）；均未匹配则为 flag（true）
    const value = match[2] ?? match[3] ?? match[4] ?? true;
    // 仅首次匹配生效（重复参数被跳过）
    if (!(key in args)) {
      args[key] = value;
    }
  }

  // 步骤 4：校验参数互斥性：--graph-file 与 --inline-graph 不能同时提供
  const graphFileRaw = args["graph-file"];
  const inlineGraphRaw = args["inline-graph"];
  if (graphFileRaw !== undefined && inlineGraphRaw !== undefined) {
    throw new Error(
      "extractEagGraphRequestFromPrompt: --graph-file 与 --inline-graph 互斥，不能同时提供（请仅指定一种图定义来源）"
    );
  }

  // 解析 --graph-file：非空字符串
  let graphFile: string | undefined;
  if (graphFileRaw !== undefined) {
    if (graphFileRaw === true || String(graphFileRaw).trim().length === 0) {
      throw new Error(
        "extractEagGraphRequestFromPrompt: --graph-file 必须提供值（期望非空文件路径，如 --graph-file path/to/graph.json）"
      );
    }
    graphFile = String(graphFileRaw).trim();
  }

  // 解析 --inline-graph：非空字符串
  let inlineGraph: string | undefined;
  if (inlineGraphRaw !== undefined) {
    if (inlineGraphRaw === true || String(inlineGraphRaw).trim().length === 0) {
      throw new Error("extractEagGraphRequestFromPrompt: --inline-graph 必须提供值（期望非空 JSON 字符串）");
    }
    inlineGraph = String(inlineGraphRaw).trim();
  }

  // 步骤 5：解析 flag 参数（出现即为 true，未出现保持 undefined）

  // --enable-experience-recall: flag，出现时 enableExperienceRecall=true
  const enableExperienceRecall: boolean | undefined = args["enable-experience-recall"] !== undefined ? true : undefined;

  // --disable-auto-isolation: flag，出现时 enableAutoIsolation=false
  const enableAutoIsolation: boolean | undefined = args["disable-auto-isolation"] !== undefined ? false : undefined;

  // --enable-graph-debug: flag，出现时 enableGraphDebug=true
  const enableGraphDebug: boolean | undefined = args["enable-graph-debug"] !== undefined ? true : undefined;

  // 步骤 6：校验可选数值参数并解析

  // --max-depth: 正整数
  const maxDepthRaw = args["max-depth"];
  let maxDepth: number | undefined;
  if (maxDepthRaw !== undefined) {
    if (maxDepthRaw === true) {
      throw new Error("extractEagGraphRequestFromPrompt: --max-depth 必须提供值（期望正整数）");
    }
    maxDepth = Number(maxDepthRaw);
    if (!Number.isInteger(maxDepth) || maxDepth < 1) {
      throw new Error(`extractEagGraphRequestFromPrompt: --max-depth 取值非法（期望正整数，实际为: ${maxDepthRaw}）`);
    }
  }

  // --max-parallelism: 正整数
  const maxParallelismRaw = args["max-parallelism"];
  let maxParallelism: number | undefined;
  if (maxParallelismRaw !== undefined) {
    if (maxParallelismRaw === true) {
      throw new Error("extractEagGraphRequestFromPrompt: --max-parallelism 必须提供值（期望正整数）");
    }
    maxParallelism = Number(maxParallelismRaw);
    if (!Number.isInteger(maxParallelism) || maxParallelism < 1) {
      throw new Error(
        `extractEagGraphRequestFromPrompt: --max-parallelism 取值非法（期望正整数，实际为: ${maxParallelismRaw}）`
      );
    }
  }

  // --timeout-sec: 非负整数（0 表示不限制）
  const timeoutSecRaw = args["timeout-sec"];
  let timeoutSec: number | undefined;
  if (timeoutSecRaw !== undefined) {
    if (timeoutSecRaw === true) {
      throw new Error("extractEagGraphRequestFromPrompt: --timeout-sec 必须提供值（期望非负整数，0 表示不限制）");
    }
    timeoutSec = Number(timeoutSecRaw);
    if (!Number.isInteger(timeoutSec) || timeoutSec < 0) {
      throw new Error(
        `extractEagGraphRequestFromPrompt: --timeout-sec 取值非法（期望非负整数，0 表示不限制，实际为: ${timeoutSecRaw}）`
      );
    }
  }

  // --max-tokens: 非负整数（0 表示不限制）
  const maxTokensRaw = args["max-tokens"];
  let maxTokens: number | undefined;
  if (maxTokensRaw !== undefined) {
    if (maxTokensRaw === true) {
      throw new Error("extractEagGraphRequestFromPrompt: --max-tokens 必须提供值（期望非负整数，0 表示不限制）");
    }
    maxTokens = Number(maxTokensRaw);
    if (!Number.isInteger(maxTokens) || maxTokens < 0) {
      throw new Error(
        `extractEagGraphRequestFromPrompt: --max-tokens 取值非法（期望非负整数，0 表示不限制，实际为: ${maxTokensRaw}）`
      );
    }
  }

  // --node-retry-limit: 正整数
  const nodeRetryLimitRaw = args["node-retry-limit"];
  let nodeRetryLimit: number | undefined;
  if (nodeRetryLimitRaw !== undefined) {
    if (nodeRetryLimitRaw === true) {
      throw new Error("extractEagGraphRequestFromPrompt: --node-retry-limit 必须提供值（期望正整数）");
    }
    nodeRetryLimit = Number(nodeRetryLimitRaw);
    if (!Number.isInteger(nodeRetryLimit) || nodeRetryLimit < 1) {
      throw new Error(
        `extractEagGraphRequestFromPrompt: --node-retry-limit 取值非法（期望正整数，实际为: ${nodeRetryLimitRaw}）`
      );
    }
  }

  // --graph-debug-level: 枚举字符串（off / info / debug / trace）
  const graphDebugLevelRaw = args["graph-debug-level"];
  let graphDebugLevel: GraphDebugLogLevel | undefined;
  if (graphDebugLevelRaw !== undefined) {
    if (graphDebugLevelRaw === true) {
      throw new Error(
        "extractEagGraphRequestFromPrompt: --graph-debug-level 必须提供值（期望 off / info / debug / trace）"
      );
    }
    const levelValue = String(graphDebugLevelRaw).trim();
    if (!isValidGraphDebugLevel(levelValue)) {
      throw new Error(
        `extractEagGraphRequestFromPrompt: --graph-debug-level 取值非法（期望 off / info / debug / trace，实际为: ${graphDebugLevelRaw}）`
      );
    }
    graphDebugLevel = levelValue;
  }

  // 步骤 7：装配 EagGraphRequest 对象并 Object.freeze 冻结
  const request: EagGraphRequest = {
    graphFile,
    inlineGraph,
    enableExperienceRecall,
    enableAutoIsolation,
    maxDepth,
    maxParallelism,
    timeoutSec,
    maxTokens,
    nodeRetryLimit,
    enableGraphDebug,
    graphDebugLevel,
  };
  return Object.freeze(request) as EagGraphRequest;
}

/**
 * 校验字符串是否为合法的图调试日志级别
 *
 * @param value 待校验字符串
 * @returns true 表示 value 是合法的 GraphDebugLogLevel
 */
function isValidGraphDebugLevel(value: string): value is GraphDebugLogLevel {
  return value === "off" || value === "info" || value === "debug" || value === "trace";
}

// ============================================================================
// 4. EagGraphCommandHandler 类
// ============================================================================

/**
 * /eag-graph 命令处理器（Phase 5）
 *
 * 职责：
 * 1. 接收 EagGraphRequest（已由 extractEagGraphRequestFromPrompt 解析）
 * 2. 从 graphFile 或 inlineGraph 构造 WorkGraph（通过 GraphBuilder.fromJson）
 * 3. 合并 CLI 配置参数（覆盖 JSON 中的 config 字段）
 * 4. 委托 GraphLoopOrchestrator.run() 执行图遍历
 * 5. 将 GraphRunReport 格式化为 Markdown 报告
 * 6. 异常兜底：捕获 orchestrator 抛出的异常，返回 success=false 的结果
 *
 * 设计原则（对齐 §5.2 N-M-1 修复 + Karpathy Simplicity First）：
 * - 不在 handler 内部 new GraphLoopOrchestrator（由调用方注入完整装配的实例）
 * - handler 仅负责构造 WorkGraph + 调用 run() + 渲染结果
 * - 不可变优先：所有接口字段 readonly + Object.freeze
 *
 * 使用方式：
 * ```typescript
 * const options = {
 *   nodeExecutor: new NodeExecutorImpl(...),
 *   edgeResolver: new EdgeResolverImpl(),
 *   graphScheduler: new GraphSchedulerImpl(...),
 *   graphGuard: new GraphGuardImpl(),
 *   predicateRegistry: createPredicateRegistry(),
 * };
 * const handler = new EagGraphCommandHandler(options);
 * const request = extractEagGraphRequestFromPrompt(
 *   '/eag-graph --graph-file path/to/graph.json --enable-experience-recall'
 * );
 * const result = await handler.execute(request, "/path/to/project");
 * console.log(result.markdownReport);
 * ```
 */
export class EagGraphCommandHandler {
  /**
   * 编排器构造选项（TOP-1 修订）
   *
   * 由调用方注入完整的依赖配置（nodeExecutor / edgeResolver / graphScheduler /
   * graphGuard / predicateRegistry 等）。handler 不再直接持有 GraphLoopOrchestrator，
   * 而是在 execute() 内部通过 GraphLifecycleManager 统一初始化、启动和管理生命周期。
   */
  private readonly options: Readonly<GraphLoopOrchestratorOptions>;

  /**
   * @param options 已装配完整依赖的 GraphLoopOrchestratorOptions
   * @throws Error options 为空时抛出（fail-closed）
   */
  constructor(options: Readonly<GraphLoopOrchestratorOptions>) {
    if (!options) {
      throw new Error("EagGraphCommandHandler 构造失败：options 必填");
    }
    this.options = options;
  }

  /**
   * 执行 /eag-graph 命令
   *
   * 算法：
   * 1. 校验入参（request + projectRoot 必填）
   * 2. 加载图定义 JSON（从 graphFile 读取文件或使用 inlineGraph）
   * 3. 通过 GraphBuilder.fromJson() 解析 JSON 构造 WorkGraph
   * 4. 合并 CLI 配置参数（覆盖 JSON 中的 config 字段）
   * 5. 通过 GraphLifecycleManager 初始化并执行图遍历（TOP-1）
   * 6. 格式化 GraphRunReport 为 Markdown 报告
   * 7. 异常兜底：捕获异常，返回 success=false 的结果
   *
   * @param request 已解析的 EagGraphRequest
   * @param projectRoot 项目根目录（绝对路径，用于解析 graphFile 相对路径）
   * @returns 命令执行结果（不可变，Object.freeze 冻结）
   */
  async execute(request: Readonly<EagGraphRequest>, projectRoot: string): Promise<Readonly<EagGraphCommandResult>> {
    // 1. 校验入参
    this.validateRequest(request);
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new Error("EagGraphCommandHandler.execute 失败：projectRoot 必须为非空字符串");
    }

    // 2. 加载图定义 JSON 字符串
    let graphJsonString: string;
    try {
      graphJsonString = await this.loadGraphJson(request, projectRoot);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const markdownReport = this.formatErrorReport(request, errorMessage);
      return Object.freeze({
        success: false,
        markdownReport,
        errorMessage,
      });
    }

    // 3. 通过 GraphBuilder.fromJson() 解析 JSON 构造 WorkGraph
    let graph: Readonly<WorkGraph>;
    try {
      const builder = GraphBuilder.fromJson(graphJsonString);

      // 4. 合并 CLI 配置参数（三层优先级：DEFAULT < jsonConfig < request）
      // 先从 JSON 字符串中提取 config 字段，作为合并基础
      // 注意：此处 JSON.parse 仅用于提取 config 字段，不重复校验图结构（GraphBuilder.fromJson 已校验）
      let jsonConfig: Partial<WorkGraphConfig> | undefined;
      try {
        const parsedJson = JSON.parse(graphJsonString) as { config?: Partial<WorkGraphConfig> };
        jsonConfig = parsedJson.config;
      } catch {
        // graphJsonString 已通过 GraphBuilder.fromJson 解析成功，此处 JSON.parse 不应失败
        // 若极端情况下失败（如非标准 JSON 但被 fromJson 容错），忽略 config 提取，使用默认值
        jsonConfig = undefined;
      }

      // 调用 mergeConfig 进行三层合并：DEFAULT_WORK_GRAPH_CONFIG < jsonConfig < request
      const mergedConfig = this.mergeConfig(request, jsonConfig);
      if (mergedConfig !== null) {
        // 仅在 CLI 显式提供配置参数时覆盖（mergedConfig !== null 表示有 CLI 覆盖）
        builder.setConfig(mergedConfig);
      }
      graph = builder.build();
    } catch (err) {
      const errorMessage = `图定义构造失败：${err instanceof Error ? err.message : String(err)}`;
      const markdownReport = this.formatErrorReport(request, errorMessage);
      return Object.freeze({
        success: false,
        markdownReport,
        errorMessage,
      });
    }

    // 5. 根据 CLI 调试参数配置/覆盖 debugger（TOP-5）
    // 如果用户显式提供 --enable-graph-debug 或 --graph-debug-level，
    // 则重新创建 GraphDebuggerProtocol 并覆盖到 options 中传入生命周期管理器。
    // 优先级：--graph-debug-level 显式值 > --enable-graph-debug 默认 info
    const executionOptions = this.resolveExecutionOptions(request);

    // 6. 通过 GraphLifecycleManager 执行图遍历（TOP-1 修订）
    // 原先直接调用 orchestrator.run()，现在统一走生命周期管理器：
    // initialize(graph, options) -> start() -> reset()，确保状态机完整。
    const manager = new GraphLifecycleManager();
    let runReport: GraphRunReport;
    try {
      await manager.initialize(graph, executionOptions);
      runReport = await manager.start();
    } catch (err) {
      // 异常兜底：返回 success=false 的结果
      const errorMessage = err instanceof Error ? err.message : String(err);
      const markdownReport = this.formatErrorReport(request, errorMessage);
      return Object.freeze({
        success: false,
        markdownReport,
        errorMessage,
      });
    } finally {
      // 无论成功或失败，都尝试重置生命周期管理器以释放内部状态
      try {
        await manager.reset();
      } catch {
        // reset 失败不覆盖主流程结果（如 running/stopping 竞态），忽略
      }
    }

    // 6. 格式化 GraphRunReport 为 Markdown 报告
    const markdownReport = this.formatSuccessReport(request, runReport);

    // 7. 返回冻结的结果对象
    // success 判定：finalStatus 为 completed 或 aborted（用户中止也算执行完成）视为成功
    // failed / timeout 视为失败
    const success = runReport.finalStatus === "completed" || runReport.finalStatus === "aborted";
    return Object.freeze({
      success,
      runReport,
      markdownReport,
      errorMessage: success ? "" : `图执行最终状态为 ${runReport.finalStatus}`,
    });
  }

  // ------------------------------------------------------------------------
  // 私有方法
  // ------------------------------------------------------------------------

  /**
   * 校验 EagGraphRequest 入参
   *
   * @param request 命令请求
   * @throws Error 必填字段缺失或非法时抛出
   */
  private validateRequest(request: Readonly<EagGraphRequest>): void {
    if (!request || typeof request !== "object") {
      throw new Error("EagGraphRequest 必须为对象");
    }
    // graphFile 和 inlineGraph 至少需要一个（允许两者都未提供，此时由 messageParams 注入）
    // 但如果提供了，必须是非空字符串
    if (request.graphFile !== undefined) {
      if (typeof request.graphFile !== "string" || request.graphFile.trim().length === 0) {
        throw new Error("EagGraphRequest.graphFile 必须为非空字符串");
      }
    }
    if (request.inlineGraph !== undefined) {
      if (typeof request.inlineGraph !== "string" || request.inlineGraph.trim().length === 0) {
        throw new Error("EagGraphRequest.inlineGraph 必须为非空字符串");
      }
    }
    // 互斥校验
    if (request.graphFile !== undefined && request.inlineGraph !== undefined) {
      throw new Error("EagGraphRequest.graphFile 与 inlineGraph 互斥，不能同时提供");
    }
    // 数值字段类型校验
    if (request.maxDepth !== undefined) {
      if (typeof request.maxDepth !== "number" || !Number.isInteger(request.maxDepth) || request.maxDepth < 1) {
        throw new Error(`EagGraphRequest.maxDepth 必须为正整数，实际值：${request.maxDepth}`);
      }
    }
    if (request.maxParallelism !== undefined) {
      if (
        typeof request.maxParallelism !== "number" ||
        !Number.isInteger(request.maxParallelism) ||
        request.maxParallelism < 1
      ) {
        throw new Error(`EagGraphRequest.maxParallelism 必须为正整数，实际值：${request.maxParallelism}`);
      }
    }
    if (request.timeoutSec !== undefined) {
      if (typeof request.timeoutSec !== "number" || !Number.isInteger(request.timeoutSec) || request.timeoutSec < 0) {
        throw new Error(`EagGraphRequest.timeoutSec 必须为非负整数，实际值：${request.timeoutSec}`);
      }
    }
    if (request.maxTokens !== undefined) {
      if (typeof request.maxTokens !== "number" || !Number.isInteger(request.maxTokens) || request.maxTokens < 0) {
        throw new Error(`EagGraphRequest.maxTokens 必须为非负整数，实际值：${request.maxTokens}`);
      }
    }
    if (request.nodeRetryLimit !== undefined) {
      if (
        typeof request.nodeRetryLimit !== "number" ||
        !Number.isInteger(request.nodeRetryLimit) ||
        request.nodeRetryLimit < 1
      ) {
        throw new Error(`EagGraphRequest.nodeRetryLimit 必须为正整数，实际值：${request.nodeRetryLimit}`);
      }
    }
    if (request.enableGraphDebug !== undefined) {
      if (typeof request.enableGraphDebug !== "boolean") {
        throw new Error(`EagGraphRequest.enableGraphDebug 必须为布尔值，实际值：${request.enableGraphDebug}`);
      }
    }
    if (request.graphDebugLevel !== undefined) {
      if (!isValidGraphDebugLevel(request.graphDebugLevel)) {
        throw new Error(
          `EagGraphRequest.graphDebugLevel 必须为 off / info / debug / trace 之一，实际值：${request.graphDebugLevel}`
        );
      }
    }
  }

  /**
   * 根据 CLI 调试参数解析实际执行用的 GraphLoopOrchestratorOptions
   *
   * 规则（TOP-5）：
   * - 如果 request 未提供任何调试参数，直接返回注入的 this.options（保持向后兼容）
   * - 如果提供了 --enable-graph-debug=true 但未提供 --graph-debug-level，默认使用 info 级别
   * - 如果提供了 --graph-debug-level，以其为准（包括 off 时降级为 NoOpDebugger）
   * - 创建新的 options 对象时，通过展开运算符复制 this.options 并覆盖 debugger 字段
   *
   * 注意：createGraphDebugger 会根据 logLevel 自动选择 NoOpDebugger（off）或
   * DefaultGraphDebugger（info/debug/trace），因此无需在此额外判断。
   *
   * @param request 已校验的 EagGraphRequest
   * @returns 用于 GraphLifecycleManager.initialize 的 options
   */
  private resolveExecutionOptions(request: Readonly<EagGraphRequest>): Readonly<GraphLoopOrchestratorOptions> {
    const hasDebugFlag = request.enableGraphDebug === true;
    const hasDebugLevel = request.graphDebugLevel !== undefined;

    if (!hasDebugFlag && !hasDebugLevel) {
      return this.options;
    }

    const effectiveLevel: GraphDebugLogLevel = hasDebugLevel ? request.graphDebugLevel! : "info";
    const debuggerInstance = createGraphDebugger({ logLevel: effectiveLevel });

    // 复制注入的 options 并覆盖 debugger，保持其他依赖不变
    const mergedOptions: GraphLoopOrchestratorOptions = {
      ...this.options,
      debugger: debuggerInstance,
    };
    return Object.freeze(mergedOptions);
  }

  /**
   * 加载图定义 JSON 字符串
   *
   * 优先级：
   * 1. 如果 request.inlineGraph 提供，直接使用内联 JSON
   * 2. 如果 request.graphFile 提供，读取文件内容
   * 3. 两者都未提供时抛出错误（调用方应在 messageParams 注入时已处理）
   *
   * @param request 命令请求
   * @param projectRoot 项目根目录（用于解析 graphFile 相对路径）
   * @returns 图定义 JSON 字符串
   * @throws Error 当 graphFile 和 inlineGraph 都未提供，或文件读取失败时抛出
   */
  private async loadGraphJson(request: Readonly<EagGraphRequest>, projectRoot: string): Promise<string> {
    // 优先使用内联 JSON
    if (request.inlineGraph !== undefined) {
      return request.inlineGraph;
    }

    // 其次读取文件
    if (request.graphFile !== undefined) {
      // 解析文件路径：相对路径基于 projectRoot 解析，绝对路径直接使用
      const filePath = path.isAbsolute(request.graphFile)
        ? request.graphFile
        : path.resolve(projectRoot, request.graphFile);
      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        return content;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        throw new Error(`读取图定义文件失败（路径: ${filePath}）：${errMsg}`);
      }
    }

    // 两者都未提供
    throw new Error(
      "未提供图定义来源：请通过 --graph-file <路径> 或 --inline-graph <JSON> 指定图定义，或在 messageParams.graphRequest 中注入"
    );
  }

  /**
   * 合并 CLI 配置参数到 WorkGraphConfig
   *
   * 合并策略（三层优先级，确保 JSON 配置不被意外覆盖）：
   * 1. 以 JSON 中的 config 为基础（若 JSON 无 config，使用 DEFAULT_WORK_GRAPH_CONFIG）
   * 2. 仅覆盖 request 中非 undefined 的字段（CLI 显式提供的参数）
   * 3. 如果 request 中所有配置字段都为 undefined，返回 null（表示无需覆盖，使用 JSON 原始配置）
   *
   * 修复说明（对齐注释"仅覆盖非 undefined 的字段"）：
   * - 旧实现以 EAG_GRAPH_DEFAULT_* 常量为基础，导致 JSON 中已有的配置被覆盖为默认值
   * - 新实现以 jsonConfig 为基础，仅覆盖 CLI 参数中非 undefined 的字段
   * - 例如：JSON 配置 maxParallelism=8，CLI 仅提供 --max-depth 50 → maxParallelism 保持 8
   *
   * @param request 命令请求
   * @param jsonConfig JSON 中的 config 字段（部分配置，可能为 undefined）
   * @returns 合并后的 WorkGraphConfig，或 null（表示无需覆盖）
   */
  private mergeConfig(
    request: Readonly<EagGraphRequest>,
    jsonConfig: Readonly<Partial<WorkGraphConfig>> | undefined
  ): Readonly<WorkGraphConfig> | null {
    // 检查是否有任何配置字段被显式提供
    const hasConfigOverride =
      request.enableExperienceRecall !== undefined ||
      request.enableAutoIsolation !== undefined ||
      request.maxDepth !== undefined ||
      request.maxParallelism !== undefined ||
      request.timeoutSec !== undefined ||
      request.maxTokens !== undefined ||
      request.nodeRetryLimit !== undefined;

    if (!hasConfigOverride) {
      // 无需覆盖，使用 JSON 原始配置
      return null;
    }

    // 以 JSON 中的 config 为基础（若 JSON 无 config，使用默认值）
    // 合并优先级：DEFAULT_WORK_GRAPH_CONFIG < jsonConfig < request（CLI 参数）
    const baseConfig: WorkGraphConfig = {
      maxDepth: jsonConfig?.maxDepth ?? EAG_GRAPH_DEFAULT_MAX_DEPTH,
      maxParallelism: jsonConfig?.maxParallelism ?? EAG_GRAPH_DEFAULT_MAX_PARALLELISM,
      maxTokens: jsonConfig?.maxTokens ?? EAG_GRAPH_DEFAULT_MAX_TOKENS,
      timeoutSec: jsonConfig?.timeoutSec ?? EAG_GRAPH_DEFAULT_TIMEOUT_SEC,
      enableExperienceRecall: jsonConfig?.enableExperienceRecall ?? false,
      enableAutoIsolation: jsonConfig?.enableAutoIsolation ?? true,
      nodeRetryLimit: jsonConfig?.nodeRetryLimit ?? EAG_GRAPH_DEFAULT_NODE_RETRY_LIMIT,
    };

    // 仅覆盖 request 中非 undefined 的字段（CLI 显式提供的参数）
    const mergedConfig: WorkGraphConfig = {
      maxDepth: request.maxDepth ?? baseConfig.maxDepth,
      maxParallelism: request.maxParallelism ?? baseConfig.maxParallelism,
      maxTokens: request.maxTokens ?? baseConfig.maxTokens,
      timeoutSec: request.timeoutSec ?? baseConfig.timeoutSec,
      enableExperienceRecall: request.enableExperienceRecall ?? baseConfig.enableExperienceRecall,
      enableAutoIsolation: request.enableAutoIsolation ?? baseConfig.enableAutoIsolation,
      nodeRetryLimit: request.nodeRetryLimit ?? baseConfig.nodeRetryLimit,
    };

    return Object.freeze(mergedConfig);
  }

  /**
   * 格式化成功执行的 Markdown 报告
   *
   * 报告结构（对齐 GraphRunReport 字段）：
   * - 标题：[EAG Graph Loop] 执行结果
   * - 基本信息：runId / graphId / finalStatus / 耗时
   * - 统计信息：遍历路径 / 总迭代次数 / LLM 调用次数 / Token 消耗
   * - 节点执行结果：每个节点的状态、耗时、失败原因
   * - 触发的图级护栏记录
   * - 最终报告
   *
   * @param request 原始命令请求（用于显示图定义来源）
   * @param runResult 图运行结果
   * @returns Markdown 格式报告
   */
  private formatSuccessReport(request: Readonly<EagGraphRequest>, runResult: Readonly<GraphRunReport>): string {
    const lines: string[] = [];
    lines.push("# [EAG Graph Loop] 执行结果");
    lines.push("");
    lines.push("## 基本信息");
    lines.push(`- **图定义来源**：${request.graphFile ?? request.inlineGraph ?? "（messageParams 注入）"}`);
    lines.push(`- **Run ID**：${runResult.runId}`);
    lines.push(`- **Graph ID**：${runResult.graphId}`);
    lines.push(`- **最终状态**：${runResult.finalStatus}`);
    lines.push(`- **总耗时**：${runResult.durationSec} 秒`);
    lines.push("");

    lines.push("## 统计信息");
    lines.push(`- **遍历路径**：${runResult.traversalPath.join(" → ") || "（无）"}`);
    lines.push(`- **总迭代次数**：${runResult.totalIterations}`);
    lines.push(`- **LLM 调用次数**：${runResult.totalLlmCallCount}`);
    lines.push(`- **Token 消耗**：${runResult.totalTokensUsed}`);
    lines.push("");

    // 节点执行结果
    if (runResult.nodeResults.size > 0) {
      lines.push("## 节点执行结果");
      for (const [nodeId, nodeResult] of runResult.nodeResults) {
        lines.push(`### ${nodeId}（${nodeResult.nodeType}）`);
        lines.push(`- **状态**：${nodeResult.status}`);
        lines.push(`- **耗时**：${nodeResult.durationSec} 秒`);
        lines.push(`- **重试次数**：${nodeResult.retryCount}`);
        if (nodeResult.failureReason) {
          lines.push(`- **失败原因**：${nodeResult.failureReason}`);
        }
        if (nodeResult.loopReport) {
          lines.push(
            `- **Loop 报告**：${nodeResult.loopReport.finalStatus}（${nodeResult.loopReport.totalIterations} 轮迭代）`
          );
        }
        lines.push("");
      }
    }

    // 触发的图级护栏记录
    if (runResult.triggeredGuards.length > 0) {
      lines.push("## 触发的图级护栏记录");
      for (const guard of runResult.triggeredGuards) {
        const severity = guard.result?.severity ?? "info";
        const reason = guard.result?.reason ?? "（无详情）";
        const nodeIdPart = guard.nodeId ? `（节点: ${guard.nodeId}）` : "";
        lines.push(`- [${severity}] ${guard.guardName}${nodeIdPart}：${reason}`);
      }
      lines.push("");
    }

    // 最终报告
    lines.push("## 最终报告");
    lines.push(runResult.finalReport || "（无最终报告内容）");

    return lines.join("\n");
  }

  /**
   * 格式化错误执行的 Markdown 报告
   *
   * @param request 原始命令请求
   * @param errorMessage 错误信息
   * @returns Markdown 格式报告
   */
  private formatErrorReport(request: Readonly<EagGraphRequest>, errorMessage: string): string {
    const lines: string[] = [];
    lines.push("# [EAG Graph Loop] 执行失败");
    lines.push("");
    lines.push("## 基本信息");
    lines.push(`- **图定义来源**：${request.graphFile ?? request.inlineGraph ?? "（messageParams 注入）"}`);
    lines.push(`- **错误信息**：${errorMessage}`);
    lines.push("");
    lines.push("## 建议排查方向");
    lines.push("- 检查 graphFile 路径是否存在且可读写（若使用 --graph-file）");
    lines.push("- 检查 inlineGraph JSON 字符串格式是否正确（若使用 --inline-graph）");
    lines.push(
      "- 检查 JSON 图定义是否符合 WorkGraphJson 格式（graphId / name / description / entryNodeId / nodes / edges 必填）"
    );
    lines.push(
      "- 检查 GraphLoopOrchestratorOptions 的 5 个核心依赖是否完整注入（nodeExecutor / edgeResolver / graphScheduler / graphGuard / predicateRegistry），handler 会通过 GraphLifecycleManager 初始化编排器"
    );
    lines.push("- 检查节点间边引用是否有效（edges 的 from/to 必须存在于 nodes 中）");
    lines.push("- 检查 decision 节点的 decisionPredicateId 是否在 PredicateRegistry 中已注册");
    return lines.join("\n");
  }
}
