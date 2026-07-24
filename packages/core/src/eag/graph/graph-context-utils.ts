/**
 * 图上下文工具函数统一模块（TOP-4 上下文拼接工具函数统一化）
 *
 * 本模块将分散在 graph-context-helpers.ts 和 graph-loop-orchestrator.ts 中的
 * 上下文工具函数抽取到统一位置，供图编排、经验上送、双层上下文管理等模块复用。
 *
 * 包含函数：
 * - deepFreeze：递归冻结对象/数组/Map（不可变优先原则）
 * - deepClone：深拷贝对象（基于 structuredClone）
 * - mergeBranchGlobalState：合并分支全局状态到主全局状态（entry 级合并 + 白名单保护）
 * - getGraphGlobalContext：安全获取 GraphGlobalContext 视图
 * - redactSensitiveFields：脱敏敏感字段（key/token/secret/password/credential）
 *
 * 设计约束：
 * - 本模块只依赖 graph-loop-models.ts 的类型（type-only），不引入运行期循环依赖
 * - 函数实现直接从现有代码迁移，不修改行为
 * - 所有函数均为纯工具函数，无副作用（redactSensitiveFields 按约定原地修改入参）
 *
 * @module eag/graph/graph-context-utils
 */

import type {
  /** 图运行上下文 */
  GraphRunContext,
  /** 图级全局上下文（Layer 0） */
  GraphGlobalContext,
} from "./graph-loop-models";

// ============================================================================
// 常量
// ============================================================================

/**
 * 敏感字段名匹配正则（v3.1-H1）
 *
 * 用于 finalGlobalState 快照脱敏：匹配 key/token/secret/password/credential 等敏感字段名，
 * 将其值替换为 [REDACTED]，避免敏感信息泄漏到图运行报告中。
 *
 * 匹配规则：大小写不敏感，包含上述任一关键词即视为敏感字段。
 */
const SENSITIVE_KEY_PATTERN = /key|token|secret|password|credential/i;

/**
 * 经验汇总池滑动窗口上限（分支合并时保留最近 50 条经验）
 */
const MAX_COLLECTED_EXPERIENCES = 50;

/**
 * 动向广播板滑动窗口上限（分支合并时保留最近 20 条通知）
 */
const MAX_BULLETIN_ENTRIES = 20;

/**
 * 分支合并时允许写入主 state 的标量字段白名单
 *
 * v4-M3 修复：仅合并已知标量字段，禁止将分支临时字段污染到主 state。
 * 溯源字段（projectGoal/globalConstraints/projectRoot/runId/graphId/createdAt）
 * 在图启动时注入，全程不变，不在白名单中，因此不会被覆盖。
 */
const ALLOWED_SCALAR_KEYS = new Set(["lastUpdatedAt"]);

// ============================================================================
// deepFreeze：递归冻结对象/数组/Map
// ============================================================================

/**
 * 深度冻结对象（递归冻结嵌套结构和数组）
 *
 * Object.freeze 是浅冻结，对嵌套对象和数组内部元素无效。
 * 此函数递归冻结所有层级的对象和数组，确保不可变优先原则。
 *
 * 使用场景：
 * - DefaultNodeExperienceUploader 写入 GraphExperienceEntry / BulletinEntry / NodeSummary 前冻结
 * - initializeGraphGlobalContext 写入 GraphGlobalContext 后冻结溯源字段
 * - snapshotGlobalState 生成最终报告前递归冻结
 *
 * @param obj 待冻结对象
 * @returns 冻结后的对象（同引用，已冻结）
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  // 基本类型和 null/undefined 直接返回（无需冻结）
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  // 冻结当前对象
  Object.freeze(obj);

  // 递归冻结所有属性值
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      // 数组：递归冻结每个元素，然后冻结数组本身
      for (const item of value) {
        deepFreeze(item);
      }
      Object.freeze(value);
    } else if (typeof value === "object" && value !== null) {
      // 嵌套对象：递归冻结
      deepFreeze(value);
    }
  }

  return obj as Readonly<T>;
}

// ============================================================================
// deepClone：深拷贝对象
// ============================================================================

/**
 * 深拷贝对象（基于 structuredClone）
 *
 * Node 17+ 原生支持 structuredClone，可克隆 Map/Set/Array/Object 等结构化数据。
 * 用于 fork 并行分支执行前创建 globalState 的独立副本，避免分支间状态污染。
 *
 * 降级语义：
 * - 若 structuredClone 不可用（极旧环境），抛出错误（项目目标 Node 18+，不考虑回退）
 * - 若入参含不可克隆对象（如函数），structuredClone 会抛出错误，由调用方处理
 *
 * @param obj 待拷贝对象
 * @returns 深拷贝后的新对象
 */
export function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

// ============================================================================
// getGraphGlobalContext：安全获取 GraphGlobalContext 视图
// ============================================================================

/**
 * 类型守卫工具函数：从 GraphRunContext.globalState 安全读取 GraphGlobalContext
 *
 * 设计意图（对齐 §13.4.1 多角色评审共识 B-5）：
 * - 不修改 globalState 类型（保持 Record<string, unknown> 不变）
 * - 仅提供类型安全访问入口，调用方通过此函数获取视图后可直接访问字段
 * - 若 globalState 未初始化图级字段，返回空对象（所有字段为 undefined）
 *
 * 使用示例：
 * ```typescript
 * const globalCtx = getGraphGlobalContext(context);
 * if (globalCtx.projectGoal) {
 *   // 注入到任务上下文
 * }
 * ```
 *
 * @param ctx 图运行上下文
 * @returns GraphGlobalContext 视图（若 globalState 未初始化图级字段，返回空对象）
 */
export function getGraphGlobalContext(ctx: GraphRunContext): GraphGlobalContext {
  return ctx.globalState as unknown as GraphGlobalContext;
}

/**
 * 判断 GraphGlobalContext 是否已初始化（用于降级路径检测）
 *
 * 设计意图（对齐 §13.4.1）：
 * - 通过检测 projectGoal 字段是否存在判断是否已初始化
 * - 用于节点执行前的降级判断：未初始化时降级为直接执行模式
 *
 * @param ctx 图运行上下文
 * @returns true 表示 globalState 中已存在 projectGoal 字段（已初始化）
 */
export function isGraphGlobalContextInitialized(ctx: GraphRunContext): boolean {
  return ctx.globalState?.projectGoal !== undefined;
}

// ============================================================================
// redactSensitiveFields：脱敏敏感字段
// ============================================================================

/**
 * 脱敏对象中的敏感字段
 *
 * 对传入对象的所有 key 进行正则匹配，若 key 包含 key/token/secret/password/credential
 * 等敏感词（大小写不敏感），则将其值替换为 "[REDACTED]"。
 *
 * 使用场景：
 * - snapshotGlobalState 生成最终 globalState 快照前，对 sharedArtifacts 脱敏
 * - 防止 API key、token、密码等敏感信息泄漏到图运行报告
 *
 * 注意：此函数按约定原地修改入参对象，不返回新对象。
 *
 * @param obj 待脱敏的对象（将被原地修改）
 */
export function redactSensitiveFields(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      obj[key] = "[REDACTED]";
    }
  }
}

// ============================================================================
// mergeBranchGlobalState：合并分支全局状态到主全局状态
// ============================================================================

/**
 * 合并分支 globalState 到主 globalState（§13.9.2 entry 级合并）
 *
 * 设计意图（对齐多角色评审共识 B-4 + v3 修复 + v4-M3 白名单）：
 * - 替代原 Object.assign 浅覆盖逻辑，避免 Map/Array 字段被整体覆盖
 * - 对 GraphGlobalContext 的集合字段做 entry 级合并，确保分支经验不丢失
 * - 其他标量字段仅合并白名单允许的字段，防止分支临时字段污染主 state
 *
 * 合并策略：
 * - nodeSummaries (Map): entry 级合并（branchMap 的每个 entry set 到 mainMap）
 * - collectedExperiences (Array): 追加合并 + experienceId 防御性去重 + 滑动窗口截断（保留最近 50 条）
 * - bulletinBoard (Array): 追加合并 + 滑动窗口截断（保留最近 20 条）
 * - sharedArtifacts (Object): 字段级合并（Object.assign 语义，后写入者获胜）
 * - 标量字段：仅合并白名单中的字段（默认只有 lastUpdatedAt）
 * - 更新 lastUpdatedAt 时间戳
 *
 * @param mainState 主 globalState（将被修改，写入合并结果）
 * @param branchState 分支 globalState（读取，不修改）
 * @param options 可选配置：allowedScalarKeys 覆盖默认标量字段白名单
 */
export function mergeBranchGlobalState(
  mainState: Record<string, unknown>,
  branchState: Readonly<Record<string, unknown>>,
  options?: Readonly<{ allowedScalarKeys?: ReadonlySet<string> }>
): void {
  // 类型断言为 GraphGlobalContext 视图（依赖 graph-loop-models 的类型定义）
  // 注意：此处不导入 GraphGlobalContext 类型，避免与 graph-loop-models 形成循环依赖
  // 通过结构化类型断言访问字段，运行期由 Object.assign 语义保证字段存在性
  const mainCtx = mainState as {
    nodeSummaries?: Map<string, unknown>;
    collectedExperiences?: unknown[];
    bulletinBoard?: unknown[];
    sharedArtifacts?: Record<string, unknown>;
    lastUpdatedAt?: string;
  };
  const branchCtx = branchState as {
    nodeSummaries?: Map<string, unknown>;
    collectedExperiences?: unknown[];
    bulletinBoard?: unknown[];
    sharedArtifacts?: Record<string, unknown>;
  };

  // 1. nodeSummaries: Map entry 级合并
  // branchMap 的每个 entry set 到 mainMap，避免整体覆盖丢失分支节点摘要
  if (branchCtx.nodeSummaries && mainCtx.nodeSummaries) {
    for (const [k, v] of branchCtx.nodeSummaries) {
      mainCtx.nodeSummaries.set(k, v);
    }
  } else if (branchCtx.nodeSummaries) {
    // main 未初始化但 branch 有数据：直接复制 branch 的 Map
    mainCtx.nodeSummaries = new Map(branchCtx.nodeSummaries);
  }

  // 2. collectedExperiences: 数组追加 + experienceId 防御性去重 + 滑动窗口截断（保留最近 50 条）
  // 对齐 §13.6.2 架构师 M-2 共识 + v3.1-M5 防御性去重
  if (branchCtx.collectedExperiences && mainCtx.collectedExperiences) {
    // 按 experienceId 防御性去重：排除主 state 已存在的经验
    const existingIds = new Set(
      mainCtx.collectedExperiences.map((e: unknown) => (e as { experienceId?: string })?.experienceId)
    );
    const dedupedBranchExperiences = branchCtx.collectedExperiences.filter(
      (e: unknown) => !existingIds.has((e as { experienceId?: string })?.experienceId)
    );
    mainCtx.collectedExperiences.push(...dedupedBranchExperiences);
    if (mainCtx.collectedExperiences.length > MAX_COLLECTED_EXPERIENCES) {
      mainCtx.collectedExperiences = mainCtx.collectedExperiences.slice(-MAX_COLLECTED_EXPERIENCES);
    }
  } else if (branchCtx.collectedExperiences) {
    // main 未初始化但 branch 有数据：直接复制 branch 的数组
    mainCtx.collectedExperiences = [...branchCtx.collectedExperiences];
  }

  // 3. bulletinBoard: 数组追加 + 滑动窗口截断（保留最近 20 条）
  // 对齐 §13.7.1 动向广播板 FIFO 滑动窗口
  if (branchCtx.bulletinBoard && mainCtx.bulletinBoard) {
    mainCtx.bulletinBoard.push(...branchCtx.bulletinBoard);
    if (mainCtx.bulletinBoard.length > MAX_BULLETIN_ENTRIES) {
      mainCtx.bulletinBoard = mainCtx.bulletinBoard.slice(-MAX_BULLETIN_ENTRIES);
    }
  } else if (branchCtx.bulletinBoard) {
    // main 未初始化但 branch 有数据：直接复制 branch 的数组
    mainCtx.bulletinBoard = [...branchCtx.bulletinBoard];
  }

  // 4. sharedArtifacts: 字段级合并（Object.assign 语义，后写入者获胜）
  // 共享产物允许覆盖（分支产出的新版本应覆盖旧版本）
  if (branchCtx.sharedArtifacts) {
    mainCtx.sharedArtifacts = {
      ...(mainCtx.sharedArtifacts ?? {}),
      ...branchCtx.sharedArtifacts,
    };
  }

  // 5. 其他标量字段：仅合并白名单允许的字段（v4-M3 白名单机制）
  // 默认白名单只有 lastUpdatedAt；调用方可通过 options.allowedScalarKeys 扩展
  const allowedScalarKeys = options?.allowedScalarKeys ?? ALLOWED_SCALAR_KEYS;
  for (const [k, v] of Object.entries(branchState)) {
    if (allowedScalarKeys.has(k)) {
      mainState[k] = v;
    }
  }

  // 6. 通用数组 / Map 字段 entry 级合并
  // 对 branchState 中除已特殊处理的 GraphGlobalContext 字段外，所有数组和 Map 类型字段做合并，
  // 支持用户自定义集合字段（如 items / tags）在 fork 分支间自动聚合。
  const specialKeys = new Set([
    "nodeSummaries",
    "collectedExperiences",
    "bulletinBoard",
    "sharedArtifacts",
    "lastUpdatedAt",
  ]);
  for (const [k, v] of Object.entries(branchState)) {
    if (specialKeys.has(k)) {
      continue;
    }
    if (v instanceof Map) {
      const mainMap = mainState[k] as Map<unknown, unknown> | undefined;
      if (mainMap instanceof Map) {
        for (const [mk, mv] of v.entries()) {
          mainMap.set(mk, mv);
        }
      } else {
        mainState[k] = new Map(v);
      }
    } else if (Array.isArray(v)) {
      const mainArr = mainState[k] as unknown[] | undefined;
      if (Array.isArray(mainArr)) {
        mainArr.push(...v);
      } else {
        mainState[k] = [...v];
      }
    }
  }

  // 7. 更新 lastUpdatedAt 时间戳（标记本次合并完成时间）
  mainCtx.lastUpdatedAt = new Date().toISOString();
}
