/**
 * Autonomous 模块聚合导出
 *
 * 来源：multi-agent-team skill scripts/autonomous/ 9 个组件
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 9 个组件：
 *   1. config-loader      - 配置加载（用户级 + 项目级）
 *   2. run-state          - 运行状态持久化与断点续跑
 *   3. notes-memory       - 跨轮 notes.md 记忆
 *   4. loop-controller    - Ralph 4 阶段主循环
 *   5. git-driver         - Git 操作封装（commit/rollback/restore）
 *   6. sleep-guard        - 跨平台防休眠（caffeinate / systemd-inhibit）
 *   7. smart-confirmation - 智能确认跳过（白名单 + 风险评分 + 黑名单）
 *   8. auto-skill-loader  - 自动 skill 加载（manifest 扫描 + 关键词过滤）
 *   9. dispatcher-adapter - Dispatcher 适配层（调用 facade._dispatch_through_v3）
 */

// 配置加载
export {
  defaultAutonomousConfig,
  userConfigPath,
  projectConfigPath,
  parseSimpleYaml,
  loadAutonomousConfig,
} from "./config-loader.js";
export type { AutonomousConfig } from "./config-loader.js";

// 运行状态
export { RunState, listRuns, findLatestResumableRun } from "./run-state.js";
export type { RunStateSchema, ResumeContext } from "./run-state.js";

// Notes 记忆
export { NotesMemory } from "./notes-memory.js";
export type { NotesSection } from "./notes-memory.js";

// Loop 控制器
export { RalphLoopController, defaultLoopConfig, defaultIterationResult, generateRunId } from "./loop-controller.js";
export type {
  StageKind,
  IterationKind,
  LoopConfig,
  IterationContext,
  IterationResult,
  StageResult,
  StageHandler,
  RunStateLike,
  GitDriverLike,
  SleepGuardLike,
  LogCallback,
} from "./loop-controller.js";

// Git 操作
export { GitDriver, defaultGitOpResult, defaultDiffStats } from "./git-driver.js";
export type { GitOpResult, DiffStats } from "./git-driver.js";

// Sleep 防护
export { SleepGuard } from "./sleep-guard.js";
export type { SleepGuardMode, SleepGuardBackend, SleepGuardHandle, SleepGuardLogCallback } from "./sleep-guard.js";

// 智能确认
export { SmartConfirmation, scoreToLevel } from "./smart-confirmation.js";
export type { RiskLevel, ConfirmationDecision, ConfirmationResult } from "./smart-confirmation.js";

// 自动 skill 加载
export { AutoSkillLoader, defaultSkillManifest } from "./auto-skill-loader.js";
export type { SkillManifest } from "./auto-skill-loader.js";

// Dispatcher 适配层
export { DispatcherAdapter, defaultAdapterInvokeResult, defaultTaskArgs } from "./dispatcher-adapter.js";
export type {
  AdapterInvokeKind,
  AdapterInvokeResult,
  DispatcherTaskArgs,
  FacadeLike,
  AdapterLogCallback,
} from "./dispatcher-adapter.js";
