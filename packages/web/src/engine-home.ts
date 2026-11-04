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
 * ## 第二根：技能 / 智能体资产根（2026-11-04）
 *
 * 技能与智能体是**用户资产**（CLI 与桌面同一份），会话 / 记忆 / 日志是**引擎运行
 * 数据**（团队服务器下必须 per-user 隔离）。两者隔离粒度不同，因此由
 * `skillsHomeForUser()` 独立解析：未显式配置时跟随本模块的 per-user 根，
 * 显式配置（`web.skillsHomeDir` / `DEEPCODE_WEB_SKILLS_HOME_DIR`）时直读直写
 * 该路径，**不追加 userId 段**。
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

/** 本函数需要的配置项（引擎数据根 + 技能资产根） */
export type SkillsHomeSettings = EngineHomeSettings & {
  /** 显式配置的用户级技能 / 智能体资产根；null/undefined = 未配置 */
  skillsHomeRoot?: string | null;
};

/**
 * 计算某个用户的**技能 / 智能体资产根**（与引擎数据根解耦，2026-11-04）。
 *
 * ## 为什么必须与 `engineHomeForUser` 分开
 *
 * 两类数据的隔离粒度本就不同：
 * - **会话 / 记忆 / 日志**：引擎运行数据。团队服务器上必须 per-user 隔离，
 *   否则用户互相看到对方的对话与记忆（多用户串号）。
 * - **技能 / 智能体**：用户资产。桌面壳与 CLI 是**同一个物理用户**，
 *   技能理应互通（用户装在 CLI 里的技能，桌面版应当看得见）。
 *
 * 此前两端被绑死（个人模式下技能根 = `<engineHomeRoot>/<userId>/`），于是桌面版
 * 扫描的是空的隔离目录，而技能实际落在 `~/.deepcode/skills`（CLI 位置）——
 * 表现就是「桌面版技能 / 智能体一个都看不到」，且新建的智能体写进去也扫不到。
 *
 * 语义：
 * - `skillsHomeRoot` 显式配置（非空）→ 该路径即技能根，**不追加 userId 段**
 *   （本机单用户部署 / 桌面壳）；
 * - 未配置 → 回退 `engineHomeForUser`（团队服务器 per-user 隔离，行为不变）。
 *
 * @param settings 归一后的 Web 配置
 * @param userId 认证上下文里的用户 ID
 * @returns 技能资产根绝对路径
 */
export function skillsHomeForUser(settings: SkillsHomeSettings, userId: string): string {
  const root = settings.skillsHomeRoot;
  if (typeof root === "string" && root !== "") {
    return root;
  }
  return engineHomeForUser(settings, userId);
}
