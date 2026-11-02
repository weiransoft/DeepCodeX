/**
 * 引擎数据家目录解析（2026-11-02 接线审查 D4）
 *
 * ## 为什么需要一个共用函数
 *
 * 「用户级」数据（技能 / 智能体 / 规则 / 记忆 / 日志 / 会话索引）的根目录随部署形态
 * 而变：
 * - CLI 与 Web `personalOnly=false`：进程家目录（`os.homedir()`），与历史行为一致；
 * - Web `personalOnly=true`（桌面默认）：`<engineHomeRoot>/<userId>`，每个用户一份。
 *
 * 这段判断原先在 rules-api、session-pool、audit-api 各写一遍，而 skill 扫描
 * （capability-api / chat-api 的 @agent 激活）**漏写了**，直接用 `os.homedir()`。
 * 后果不是"少个功能"，是两头错：
 * - 用户在 Web 里新建的智能体落在自己的 homeRoot，列表却扫进程家目录 → 看不到；
 * - 所有用户共享进程家目录下的技能与智能体 → 多用户串号。
 *
 * 统一到这里，任何新增的「用户级」数据入口都应调用本函数，而不是自己写三元。
 *
 * @module web/engine-home
 */

import os from "node:os";
import path from "node:path";
import type { ResolvedWebSettings } from "./types";

/** 本函数只需要这两项配置（便于测试与部分调用点复用） */
export type EngineHomeSettings = Pick<ResolvedWebSettings, "personalOnly" | "engineHomeRoot">;

/**
 * 计算某个用户的引擎数据家目录绝对路径。
 *
 * @param settings 归一后的 Web 配置（personalOnly / engineHomeRoot）
 * @param userId 认证上下文里的用户 ID（personalOnly=false 时不参与计算）
 * @returns 绝对路径；personalOnly=false 时为进程家目录
 */
export function engineHomeForUser(settings: EngineHomeSettings, userId: string): string {
  if (settings.personalOnly) {
    return path.join(settings.engineHomeRoot, userId);
  }
  return os.homedir();
}
