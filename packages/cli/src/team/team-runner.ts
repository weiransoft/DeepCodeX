/**
 * CLI 侧 dispatch 工具执行器（L1-1 收尾，2026-11-02）
 *
 * ## 背景：为什么独立子命令此前没有工具轮次
 *
 * `executeDispatch`（core/team/team-adapter.ts）的「执行」原本只是一次
 * chat completion——它能把「设计建议」写成文本，但**不能读写文件、不能跑命令**。
 * 带工具轮次的路径依赖宿主注入 `DispatchOptions.runner`，而 runner 需要一整套
 * 会话运行时（模型客户端、settings 解析、审批、护栏、token 预算、MCP）。
 *
 * L0/L1 打通时只有会话路径（Web 与 CLI 聊天框的 `/team`）具备这套运行时，
 * 独立子命令 `deepcode team dispatch` 因此停留在单次调用——功能写着、跑着，
 * 但和「派单给角色去干活」的语义差了一截。这个文件补上那块运行时：
 * 复用 `--exec` 模式（`exec-runner.ts`）已验证的 headless 装配方式，
 * 用 `SessionManager.runEphemeral` 承载 dispatch。
 *
 * ## 为什么复用 runEphemeral 而不是另写一套循环
 *
 * `runEphemeral` 就是「一次性、不污染会话列表、强制审批、有轮次预算」的
 * 主对话循环：工具、审批、护栏、token 计量、thinking 通道全都在。自己拼一份
 * 只会有两份不一致的行为，且日后主循环的修复进不来。
 *
 * @module cli/team/team-runner
 */

import {
  SessionManager,
  createOpenAIClientFactory,
  resolveCurrentSettings,
  type DispatchRunner,
} from "@vegamo/deepcode-core";

/** 宿主执行器句柄（用完必须 dispose，否则 MCP 子进程与文件句柄会留在进程里） */
export interface CliTeamRunner {
  /** 注入 `DispatchOptions.runner` 的执行函数 */
  runner: DispatchRunner;
  /** 释放会话运行时（MCP 连接、后台进程、定时器） */
  dispose: () => void;
}

/**
 * 判断当前环境是否配置了模型凭据
 *
 * 没有凭据时不装配执行器：单轮路径对「未配置」有既有的优雅降级（dispatch 返回
 * skipped、consensus 整体 skipped、退出码 0），而会话运行时会在建会话阶段
 * 直接失败，把「没配 key」变成「命令出错」——那是行为退化，不是改进。
 *
 * @param projectRoot 项目根目录（settings 解析基准）
 * @returns 是否具备可用的 API Key
 */
export function hasModelCredentials(projectRoot: string): boolean {
  const settings = resolveCurrentSettings(projectRoot);
  return typeof settings.apiKey === "string" && settings.apiKey.trim() !== "";
}

/**
 * 为独立子命令构造带工具轮次的执行器
 *
 * 装配与 `deepcode --exec` 完全一致（同一套 `createOpenAIClientFactory` /
 * `resolveCurrentSettings` / `nonInteractive`），差别只在于是否把
 * `SessionManager` 暴露为 runner。
 *
 * 失败是**允许**的：调用方在拿不到 runner 时降级为单轮咨询并在 stderr 说明，
 * 而不是让整条命令失败——MCP 起不来等情况下，单轮仍能给出有意义的建议。
 *
 * @param projectRoot 项目根目录（工作区边界与 settings 解析基准）
 * @returns 执行器句柄
 * @throws 会话运行时装配失败（MCP 初始化异常）时抛出
 */
export async function createCliTeamRunner(projectRoot: string): Promise<CliTeamRunner> {
  // settings 解析两次（一次给 MCP 装配、一次留在 getResolvedSettings 闭包里）：
  // resolveCurrentSettings 是纯读磁盘 + 合并默认值，无副作用，避免闭包持有陈旧快照
  const settings = resolveCurrentSettings(projectRoot);
  const manager = new SessionManager({
    projectRoot,
    createOpenAIClient: createOpenAIClientFactory(projectRoot),
    getResolvedSettings: () => resolveCurrentSettings(projectRoot),
    // 非交互宿主：Markdown 由调用方决定怎么渲染，这里只做身份变换
    renderMarkdown: (text) => text,
    nonInteractive: true,
    // dispatch 的输出由 runEphemeral 的返回值承载，不需要旁路消息回调
    onAssistantMessage: () => {},
  });

  await manager.initMcpServers(settings.mcpServers);

  return {
    runner: (context) => manager.runEphemeral(context),
    dispose: () => manager.dispose(),
  };
}
