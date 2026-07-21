/**
 * /codemap 命令处理器
 *
 * 处理 /codemap generate、/codemap show、/codemap cycles、/codemap stats、
 * /codemap markdown、/codemap help 等子命令。
 * 该命令在 CLI 层处理，提供代码地图的生成与查询能力。
 *
 * 命令格式：
 *   /codemap                       显示帮助（等价于 /codemap help）
 *   /codemap help                  显示帮助信息
 *   /codemap generate              生成（或刷新）代码地图，显示摘要
 *   /codemap show                  显示已生成 CodeMap 的项目信息与统计
 *   /codemap cycles                显示循环依赖路径链
 *   /codemap stats                 显示统计信息（文件/类/函数/依赖/耗时）
 *   /codemap markdown              输出完整 Markdown 文档（调用 renderCodeMapAsMarkdown）
 *
 * 设计依据：
 * - V2 PRD §US-CM-001：用户可生成与查看代码地图
 * - V2 测试方案 §2.10 CMD-01/CMD-02（/codemap 命令）
 * - 架构师审查报告（2026-07-21）：与 memory-commands 风格一致，定义 CodemapCommandResult
 *
 * @module v2/codemap/codemap-commands
 */

import type { CodeMapGenerator, CodeMap } from "./generator";
import { renderCodeMapAsMarkdown } from "./markdown-renderer";

/**
 * /codemap 命令处理结果
 *
 * 与 MemoryCommandResult 风格一致：
 * - success: 是否处理成功（语法/参数错误、CodeMap 未生成等返回 false）
 * - output: 显示给用户的文本（多行字符串，已格式化）
 * - data: 结构化数据（可选，供调用方进一步处理）
 */
export interface CodemapCommandResult {
  /** 是否处理成功 */
  success: boolean;
  /** 显示给用户的文本（多行字符串） */
  output: string;
  /** 结构化数据（可选） */
  data?: unknown;
}

/**
 * 处理 /codemap 命令
 *
 * 解析子命令并路由到对应的处理函数。
 * 空字符串或 "help" 显示帮助；未知子命令返回失败。
 *
 * 设计要点：
 *   - 异步签名：generate 子命令需调用 CodeMapGenerator.generateFullMap()（异步）
 *   - 状态依赖：show/cycles/stats/markdown 依赖已生成的 CodeMap
 *     首次调用时 CodeMap 未生成，返回提示性失败（success=false）
 *   - 状态缓存：生成后 CodeMap 缓存在闭包中，后续 show/cycles/stats 直接复用
 *
 * @param args 命令参数字符串（如 "generate"、"cycles"、"help"）
 * @param generator CodeMap 生成器实例
 * @param cachedCodeMap 可选的已生成 CodeMap（由调用方缓存，避免重复生成）
 * @returns 命令处理结果的 Promise
 */
export async function handleCodemapCommand(
  args: string,
  generator: CodeMapGenerator,
  cachedCodeMap?: CodeMap
): Promise<CodemapCommandResult> {
  // 参数清洗：去除首尾空白，按空白拆分为 token 数组
  const trimmed = (args ?? "").trim();
  const parts = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  const subcommand = (parts[0] ?? "").toLowerCase();

  switch (subcommand) {
    case "":
      // 无子命令 → 显示帮助
      return handleHelp();
    case "help":
      return handleHelp();
    case "generate":
      return await handleGenerate(generator);
    case "show":
      return handleShow(cachedCodeMap);
    case "cycles":
      return handleCycles(cachedCodeMap);
    case "stats":
      return handleStats(cachedCodeMap);
    case "markdown":
      return handleMarkdown(cachedCodeMap);
    default:
      return {
        success: false,
        output: `未知的 /codemap 子命令: ${subcommand}\n` + `可用子命令: generate, show, cycles, stats, markdown, help`,
      };
  }
}

// ============================================================================
// 子命令处理函数
// ============================================================================

/**
 * /codemap generate - 生成（或刷新）代码地图
 *
 * 调用 CodeMapGenerator.generateFullMap() 真实生成 CodeMap，
 * 返回生成结果的摘要信息（项目名/文件数/类数/函数数/依赖数/循环数/耗时）。
 *
 * @param generator CodeMap 生成器实例
 * @returns 命令处理结果（data 字段为生成的 CodeMap 对象，供调用方缓存）
 */
async function handleGenerate(generator: CodeMapGenerator): Promise<CodemapCommandResult> {
  // 真实生成 CodeMap（调用 generator.generateFullMap）
  const codeMap = await generator.generateFullMap();

  // 组装摘要输出
  const lines: string[] = [];
  lines.push("代码地图已生成：");
  lines.push(`  项目名: ${codeMap.project.name}`);
  lines.push(`  根目录: ${codeMap.project.root}`);
  lines.push(`  架构类型: ${codeMap.project.architecture}`);
  lines.push(`  支持语言: ${codeMap.project.languages.join(", ") || "（未识别）"}`);
  lines.push("");
  lines.push("统计信息：");
  lines.push(`  文件总数: ${codeMap.stats.totalFiles}`);
  lines.push(`  成功解析: ${codeMap.stats.parsedFiles}`);
  lines.push(`  解析失败: ${codeMap.stats.failedFiles}`);
  lines.push(`  类总数: ${codeMap.stats.totalClasses}`);
  lines.push(`  函数总数: ${codeMap.stats.totalFunctions}`);
  lines.push(`  依赖关系总数: ${codeMap.stats.totalDependencies}`);
  lines.push(`  循环依赖数: ${codeMap.stats.cyclesDetected}`);
  lines.push(`  未解析依赖数: ${codeMap.stats.unresolvedDeps}`);
  lines.push(`  生成耗时: ${codeMap.stats.generationTimeMs}ms`);

  return {
    success: true,
    output: lines.join("\n"),
    // data 字段返回完整 CodeMap 对象，供调用方缓存（后续 show/cycles/stats 复用）
    data: codeMap,
  };
}

/**
 * /codemap show - 显示已生成 CodeMap 的项目信息与统计
 *
 * 依赖调用方传入的 cachedCodeMap。若未生成，返回提示性失败。
 *
 * @param cachedCodeMap 可选的已生成 CodeMap
 * @returns 命令处理结果
 */
function handleShow(cachedCodeMap?: CodeMap): CodemapCommandResult {
  if (!cachedCodeMap) {
    return {
      success: false,
      output: "尚未生成代码地图。请先使用 /codemap generate 生成。",
    };
  }

  const lines: string[] = [];
  lines.push("当前代码地图：");
  lines.push(`  生成时间: ${cachedCodeMap.generatedAt}`);
  lines.push(`  项目名: ${cachedCodeMap.project.name}`);
  lines.push(`  根目录: ${cachedCodeMap.project.root}`);
  lines.push(`  架构类型: ${cachedCodeMap.project.architecture}`);
  lines.push(`  支持语言: ${cachedCodeMap.project.languages.join(", ") || "（未识别）"}`);
  lines.push("");
  lines.push("技术栈：");
  lines.push(`  框架: ${cachedCodeMap.project.techStack.frameworks.join(", ") || "（未识别）"}`);
  lines.push(`  构建工具: ${cachedCodeMap.project.techStack.buildTools.join(", ") || "（未识别）"}`);
  lines.push(`  包管理器: ${cachedCodeMap.project.techStack.packageManagers.join(", ") || "（未识别）"}`);
  lines.push(`  测试框架: ${cachedCodeMap.project.techStack.testFrameworks.join(", ") || "（未识别）"}`);
  lines.push(`  Linter: ${cachedCodeMap.project.techStack.linters.join(", ") || "（未识别）"}`);
  lines.push("");
  lines.push("模块数：");
  lines.push(`  共 ${cachedCodeMap.modules.length} 个模块`);
  lines.push("");
  lines.push("文件统计：");
  lines.push(`  总数: ${cachedCodeMap.stats.totalFiles}`);
  lines.push(`  成功: ${cachedCodeMap.stats.parsedFiles}`);
  lines.push(`  失败: ${cachedCodeMap.stats.failedFiles}`);
  lines.push(`  类: ${cachedCodeMap.stats.totalClasses}`);
  lines.push(`  函数: ${cachedCodeMap.stats.totalFunctions}`);

  return {
    success: true,
    output: lines.join("\n"),
    data: cachedCodeMap,
  };
}

/**
 * /codemap cycles - 显示循环依赖路径链
 *
 * @param cachedCodeMap 可选的已生成 CodeMap
 * @returns 命令处理结果
 */
function handleCycles(cachedCodeMap?: CodeMap): CodemapCommandResult {
  if (!cachedCodeMap) {
    return {
      success: false,
      output: "尚未生成代码地图。请先使用 /codemap generate 生成。",
    };
  }

  if (cachedCodeMap.cycles.length === 0) {
    return {
      success: true,
      output: "未检测到循环依赖。",
      data: { cyclesDetected: 0, cycles: [] },
    };
  }

  const lines: string[] = [];
  lines.push(`检测到 ${cachedCodeMap.cycles.length} 条循环依赖：`);
  lines.push("");

  for (let i = 0; i < cachedCodeMap.cycles.length; i++) {
    const cycle = cachedCodeMap.cycles[i]!;
    // 路径链：A → B → C → A（首尾相同，形成闭环）
    const chain = [...cycle, cycle[0]].join(" → ");
    lines.push(`循环 #${i + 1}:`);
    lines.push(`  ${chain}`);
    lines.push("");
  }

  return {
    success: true,
    output: lines.join("\n").trimEnd(),
    data: { cyclesDetected: cachedCodeMap.cycles.length, cycles: cachedCodeMap.cycles },
  };
}

/**
 * /codemap stats - 显示统计信息
 *
 * @param cachedCodeMap 可选的已生成 CodeMap
 * @returns 命令处理结果
 */
function handleStats(cachedCodeMap?: CodeMap): CodemapCommandResult {
  if (!cachedCodeMap) {
    return {
      success: false,
      output: "尚未生成代码地图。请先使用 /codemap generate 生成。",
    };
  }

  const stats = cachedCodeMap.stats;
  const lines: string[] = [];
  lines.push("代码地图统计信息：");
  lines.push("");
  lines.push(`  文件总数: ${stats.totalFiles}`);
  lines.push(`  成功解析: ${stats.parsedFiles}`);
  lines.push(`  解析失败: ${stats.failedFiles}`);
  lines.push(`  类总数: ${stats.totalClasses}`);
  lines.push(`  函数总数: ${stats.totalFunctions}`);
  lines.push(`  依赖关系总数: ${stats.totalDependencies}`);
  lines.push(`  循环依赖数: ${stats.cyclesDetected}`);
  lines.push(`  未解析依赖数: ${stats.unresolvedDeps}`);
  lines.push(`  生成耗时: ${stats.generationTimeMs}ms`);

  return {
    success: true,
    output: lines.join("\n"),
    data: stats,
  };
}

/**
 * /codemap markdown - 输出完整 Markdown 文档
 *
 * 调用 renderCodeMapAsMarkdown(codeMap) 渲染完整 Markdown 文档。
 *
 * @param cachedCodeMap 可选的已生成 CodeMap
 * @returns 命令处理结果（output 字段为 Markdown 字符串）
 */
function handleMarkdown(cachedCodeMap?: CodeMap): CodemapCommandResult {
  if (!cachedCodeMap) {
    return {
      success: false,
      output: "尚未生成代码地图。请先使用 /codemap generate 生成。",
    };
  }

  // 调用 markdown-renderer 渲染完整 Markdown
  const markdown = renderCodeMapAsMarkdown(cachedCodeMap);

  return {
    success: true,
    output: markdown,
    data: { format: "markdown", length: markdown.length },
  };
}

/**
 * /codemap help - 显示帮助
 *
 * @returns 命令处理结果
 */
function handleHelp(): CodemapCommandResult {
  const output = [
    "/codemap - 代码地图命令",
    "",
    "用法:",
    "  /codemap                       显示此帮助",
    "  /codemap help                  显示此帮助",
    "  /codemap generate              生成（或刷新）代码地图，显示摘要",
    "  /codemap show                  显示已生成 CodeMap 的项目信息与统计",
    "  /codemap cycles                显示循环依赖路径链",
    "  /codemap stats                 显示统计信息",
    "  /codemap markdown              输出完整 Markdown 文档",
    "",
    "示例:",
    "  /codemap generate",
    "  /codemap show",
    "  /codemap cycles",
    "  /codemap stats",
    "  /codemap markdown",
  ].join("\n");
  return { success: true, output };
}
