/**
 * ToolRouter：工具调用路由器（审批决策 + side-git 快照集成）
 *
 * 设计依据：
 * - V2_CONTEXT_MEMORY_TECH_DESIGN.md §4.3 ToolRouter 类定义（v2.4 修订版）
 * - V2_CONTEXT_MEMORY_TECH_DESIGN.md §4.4.3 集成流程（ToolRouter.route 改造，
 *   含 P1-07 降级模式处理）
 *
 * 核心职责：
 * 1. 调用 ApprovalGate.decide() 获取三态审批决策；
 * 2. deny 决策抛出 ApprovalDeniedError（携带完整 ApprovalResult 供 UI 渲染）；
 * 3. ask_user 决策通过注入的 askUser 回调请求用户确认，拒绝则抛 ApprovalDeniedError；
 * 4. snapshotRequired 为 true 时（auto 模式破坏性操作），执行 §4.4.3 集成流程：
 *    轻量完整性检查 → 损坏则完整检查确认 → rebuild() 自动重建 → 创建 pre-turn 快照；
 *    降级模式（degraded_mode）下跳过快照直接放行，不阻断工具执行。
 *
 * 与 executor 钩子的关系：
 * - 本类为异步路由（内部 await SideGitRecovery + SideGitManager），
 *   要求 onBeforeToolExecution 钩子签名为 async（P0-05 修复已落地）；
 * - CLI 接线时由集成层将 route() 适配为钩子三态返回（approve/deny/ask_user）。
 */

import type { ApprovalGate } from "./approval-gate.js";
import { ApprovalDeniedError } from "./approval-denied-error.js";
import type { ApprovalContext, ApprovalResult } from "./types.js";
import type { SideGitManager } from "./side-git.js";
import { generateTurnId } from "./side-git.js";
import type { SideGitRecovery } from "./side-git-recovery.js";

/**
 * 用户确认回调（ask_user 决策的 UI 通道）
 *
 * 由集成层注入（如 CLI 交互提示、IDE 弹窗），返回用户是否批准执行。
 * 未注入时 ask_user 决策按保守策略视为拒绝（安全默认：无确认通道不放行）。
 *
 * @param ctx 审批上下文（工具信息 + 模式）
 * @param result 审批结果（含决策原因与风险评估，供 UI 展示）
 * @returns 用户批准返回 true，拒绝返回 false
 */
export type AskUserCallback = (ctx: ApprovalContext, result: ApprovalResult) => Promise<boolean>;

/**
 * 工具调用路由器
 *
 * 调用契约（§4.3）：
 * - route() 返回 true 表示放行（快照已按需创建）；
 * - route() 抛出 ApprovalDeniedError 表示拒绝（deny 决策或用户拒绝），
 *   错误携带完整 ApprovalResult（decision/riskAssessment/snapshotRequired）。
 *
 * 快照不阻断工具执行（§4.4.3 P1-07 修复）：
 * - rebuild() 内部失败不抛出（catch 后进入 degradedMode，5 分钟退避）；
 * - 降级模式下 verifyIntegrityLightweight 直接返回 failures=["degraded_mode"]，
 *   route() 检测到后跳过 createSnapshot，直接返回 true 放行工具执行。
 */
export class ToolRouter {
  constructor(
    /** 审批门控（§4.2），封装三态决策逻辑 */
    private readonly approvalGate: ApprovalGate,
    /** side-git 管理器（§4.2.3），负责 turn 级快照创建 */
    private readonly sideGit: SideGitManager,
    /** side-git 损坏恢复器（§4.4），轻量检查失败时自动重建 */
    private readonly sideGitRecovery: SideGitRecovery,
    /** 用户确认回调（可选，ask_user 决策的 UI 通道；未注入时 ask_user 保守拒绝） */
    private readonly askUserCallback?: AskUserCallback
  ) {}

  /**
   * 路由工具调用
   *
   * @param ctx 审批上下文（工具信息 + 应用/审批模式 + 可选 taskId）
   * @returns true 表示放行执行
   * @throws ApprovalDeniedError deny 决策或用户拒绝时抛出（携带完整 result）
   *
   * 执行流程（§4.3 + §4.4.3）：
   * 1. approvalGate.decide(ctx) 获取决策；
   * 2. deny → throw ApprovalDeniedError(result.reason, result)；
   * 3. ask_user → await askUserCallback(ctx, result)，拒绝 → throw ApprovalDeniedError("User denied", result)；
   * 4. snapshotRequired → §4.4.3 快照集成流程：
   *    a. report = verifyIntegrityLightweight()（毫秒级，不击穿 500ms 预算）；
   *    b. 不健康且非 degraded_mode → verifyIntegrityFull() 确认损坏面 → rebuild()；
   *       rebuild 失败进入 degradedMode（不抛出），再查 lightweight 确认；
   *    c. 不健康且含 degraded_mode → 跳过 createSnapshot，直接放行；
   *    d. 健康或 rebuild 成功 → createSnapshot(generateTurnId(), "pre_turn", ctx.taskId ?? "default-task")；
   * 5. return true。
   */
  async route(ctx: ApprovalContext): Promise<boolean> {
    // 步骤 1：审批决策（decide() 为同步纯函数，无外部依赖）
    const result = this.approvalGate.decide(ctx);

    // 步骤 2：deny 决策（黑名单/高风险/plan 模式限制），抛出携带完整 result 的错误
    if (result.decision === "deny") {
      throw new ApprovalDeniedError(result.reason, result);
    }

    // 步骤 3：ask_user 决策，通过注入回调请求用户确认
    if (result.decision === "ask_user") {
      // 未注入确认通道时保守拒绝（安全默认）
      const userApproved = this.askUserCallback ? await this.askUserCallback(ctx, result) : false;
      if (!userApproved) {
        throw new ApprovalDeniedError("User denied", result);
      }
    }

    // 步骤 4：破坏性操作需创建 pre-turn 快照（§4.4.3 集成流程）
    if (result.snapshotRequired) {
      await this.ensureSnapshot(ctx);
    }

    // 步骤 5：放行
    return true;
  }

  /**
   * 快照集成流程（§4.4.3，P1-07 降级模式处理）
   *
   * 轻量检查 → 损坏则完整检查确认 → rebuild 自动重建 → 创建 pre-turn 快照；
   * 降级模式下跳过快照直接放行，不阻断工具执行。
   *
   * @param ctx 审批上下文（taskId 用于快照关联，缺省回退 "default-task"）
   */
  private async ensureSnapshot(ctx: ApprovalContext): Promise<void> {
    // a. 轻量完整性检查（每次快照前执行，毫秒级）
    const report = await this.sideGitRecovery.verifyIntegrityLightweight();

    let skipSnapshot = false;

    if (!report.healthy) {
      if (report.failures.includes("degraded_mode")) {
        // c. 降级模式（rebuild 曾失败，5 分钟退避期内）：跳过快照直接放行
        skipSnapshot = true;
      } else {
        // b. 完整检查确认损坏面（含对象库 fsck），确认后自动重建
        const full = await this.sideGitRecovery.verifyIntegrityFull();
        if (!full.healthy) {
          // rebuild 内部失败不抛出（catch 后进入 degradedMode），此处 await 正常返回
          await this.sideGitRecovery.rebuild();
          // rebuild 失败已降级：再查 lightweight 确认（ degraded_mode 则跳过快照）
          const after = await this.sideGitRecovery.verifyIntegrityLightweight();
          if (!after.healthy && after.failures.includes("degraded_mode")) {
            skipSnapshot = true;
          }
        }
      }
    }

    // d. 健康或 rebuild 成功：创建 pre-turn 快照
    if (!skipSnapshot) {
      await this.sideGit.createSnapshot(generateTurnId(), "pre_turn", ctx.taskId ?? "default-task");
    }
  }
}
