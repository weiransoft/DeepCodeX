/**
 * Team 子命令 - CLI 薄壳（L0-1，2026-11-02）
 *
 * ## 改造前后
 *
 * 改造前：本文件是 team 命令的**唯一执行体**，直接调用 core 的 team 能力并
 * `process.stdout.write` 输出。这带来两个后果：
 *   1. Web 宿主没有任何执行体 → 用户在 Web 敲 `/team` 被当普通文本投给模型，静默降级
 *   2. TUI 下必须靠拦截 `process.stdout.write` 才能避免破坏 Ink 渲染（见 App.tsx 的历史补丁）
 *
 * 改造后：执行体迁移到 `@vegamo/deepcode-core` 的 `runTeamCommand()`（纯函数，
 * 返回 `{exitCode, stdout, stderr, data}`），CLI 与 Web 共用。本文件只做两件事：
 *   - 把 core 的文本输出原样写到终端（保持 `deepcode team ...` 子命令的输出逐字节不变）
 *   - 类型 re-export（`TeamCommandArgs` / `TeamSubcommand` 的唯一权威定义已移到 core）
 *
 * 输出格式、退出码语义、fail-fast / consensus 行为全部保持不变，既有 4 套
 * CLI team 测试（`team-cmd-*.test.ts`）无需修改。
 *
 * @module cli/team/team-cmd
 */

import { runTeamCommand, formatTeamHelp as coreFormatTeamHelp } from "@vegamo/deepcode-core";
import type { TeamCommandArgs } from "@vegamo/deepcode-core";
import { writeStdout } from "../utils/stdio-helpers";
import { createCliTeamRunner, hasModelCredentials, type CliTeamRunner } from "./team-runner";

// 类型的唯一权威定义在 core/commands/types.ts；此处 re-export 保持 CLI 既有导入路径可用
export type { TeamSubcommand, TeamCommandArgs } from "@vegamo/deepcode-core";

/** 需要工具轮次的子命令（其余子命令纯本地计算，起一套会话运行时只会白耗启动时间） */
const TOOL_CAPABLE_SUBCOMMANDS: ReadonlySet<string> = new Set(["dispatch", "auto"]);

/**
 * 判断本次调用是否应当装配工具执行器
 *
 * 三条排除条件都是刻意的：
 * - `injectedClient`：调用方（含 4 套 CLI 测试）已接管模型通道，语义是「统计调用次数、
 *   断言输出」，此时插一个真实会话会把断言打乱——保持单轮行为不变；
 * - `dryRun`：只打印计划，不执行；
 * - 不相关的子命令：list / match / autonomous / full-lifecycle 自带执行体。
 *
 * @param args 命令参数
 * @returns 是否装配
 */
function shouldUseToolRunner(args: TeamCommandArgs): boolean {
  if (!TOOL_CAPABLE_SUBCOMMANDS.has(args.subcommand)) return false;
  if (args.injectedClient !== undefined) return false;
  if (args.dryRun === true) return false;
  return true;
}

/**
 * 执行 team 命令（CLI 入口）
 *
 * 独立子命令的 `dispatch` / `auto` 会装配真实会话运行时以获得工具轮次
 * （L1-1 收尾）；装配失败时降级为单轮咨询并在 stderr 明示，绝不让命令失败。
 *
 * @param args 已解析的子命令参数（由 `parse-team-args` 或 `parseTeamCommandLine` 产出）
 * @returns 退出码：0 成功 / 1 执行失败 / 2 参数错误 / 4 运行时异常
 */
export async function executeTeamCommand(args: TeamCommandArgs): Promise<number> {
  const projectRoot = args.projectRoot ?? process.cwd();
  let handle: CliTeamRunner | null = null;

  if (shouldUseToolRunner(args) && hasModelCredentials(projectRoot)) {
    try {
      handle = await createCliTeamRunner(projectRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `⚠ 未能装配工具执行器，本次为单轮咨询（不读写文件、不执行命令）：${message}\n` +
          `  需要真实改动请在会话内使用 /team ${args.subcommand}\n`
      );
    }
  }

  try {
    const result = await runTeamCommand(args, handle !== null ? { runner: handle.runner } : undefined);
    // 用 raw write 而非 writeStdoutLine：缓冲内每行已自带换行，
    // 再补一个会产生双换行，破坏 golden 输出断言
    if (result.stdout) {
      writeStdout(result.stdout);
    }
    if (result.stderr) {
      // stderr 用 console.error 保持「错误走 stderr」的语义（stdio-helpers 未导出 writeStderr）
      process.stderr.write(result.stderr);
    }
    return result.exitCode;
  } finally {
    handle?.dispose();
  }
}

/** 格式化 help 文本（实现已在 core，CLI 仅透出） */
export const formatTeamHelp = coreFormatTeamHelp;

/**
 * 供 TUI 直接调用的执行体（不写终端）
 *
 * `handleTeamSlashCommand` 需要输出文本自行渲染成 Ink 消息，因此不能走
 * `executeTeamCommand`（它会写 process.stdout）。这里把 core 的执行体透出，
 * 让 TUI 拿结构化结果——历史上 TUI 劫持 `process.stdout.write` 的补丁因此可以整体删除。
 */
export { runTeamCommand };

// 保留类型导入以避免 unused import 错误（供外部 reference）
export type { RoleDefinition, MatchResult } from "@vegamo/deepcode-core";
