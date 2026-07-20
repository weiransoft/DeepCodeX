/**
 * DeepCodeX 多角色团队 - 错误类型定义
 *
 * 来源：multi-agent-team skill scripts/dispatcher/errors.py
 * 严格遵循 user rules：禁止 mock/占位/简化；所有错误必须真实表达失败模式
 * Karpathy 原则：Surgical Changes - 错误类层级精简，只保留必要差异化
 *
 * 设计：
 *   - 所有错误继承自 TeamError 顶层基类（便于 catch 兜底）
 *   - 每个错误携带 code 字段（机器可读）和 message（人类可读）
 *   - cause 字段保留原始异常链（debug 关键证据）
 */

import { z } from "zod";

// ============================================================================
// 第一部分：错误代码常量（机器可读枚举）
// ============================================================================

/**
 * 错误代码集合
 *
 * 用途：用于日志聚合 / 监控告警 / 国际化文案索引
 * 约束：新增 code 必须同步更新本枚举 + 对应 i18n 文案
 */
export const ErrorCode = {
  // Drop-in 加载相关
  DROP_IN_FILE_NOT_FOUND: "DROP_IN_FILE_NOT_FOUND",
  DROP_IN_SPEC_FAILED: "DROP_IN_SPEC_FAILED",
  DROP_IN_EXEC_FAILED: "DROP_IN_EXEC_FAILED",
  DROP_IN_NO_PLUGIN: "DROP_IN_NO_PLUGIN",
  DROP_IN_DUPLICATE_NAME: "DROP_IN_DUPLICATE_NAME",
  DROP_IN_CONSTRUCT_FAILED: "DROP_IN_CONSTRUCT_FAILED",
  DROP_IN_PATH_ABSOLUTE: "DROP_IN_PATH_ABSOLUTE",
  DROP_IN_PATH_OUTSIDE_ROOT: "DROP_IN_PATH_OUTSIDE_ROOT",
  DROP_IN_PATH_NOT_DIR: "DROP_IN_PATH_NOT_DIR",
  DROP_IN_PATH_CREATE_FAILED: "DROP_IN_PATH_CREATE_FAILED",
  // 插件契约相关
  PLUGIN_NAME_INVALID: "PLUGIN_NAME_INVALID",
  PLUGIN_PRIORITY_DUPLICATE: "PLUGIN_PRIORITY_DUPLICATE",
  PLUGIN_MUTEX_SELF: "PLUGIN_MUTEX_SELF",
  PLUGIN_MUTEX_UNKNOWN: "PLUGIN_MUTEX_UNKNOWN",
  PLUGIN_MUTEX_ASYMMETRIC: "PLUGIN_MUTEX_ASYMMETRIC",
  PLUGIN_NOT_REGISTERED: "PLUGIN_NOT_REGISTERED",
  PLUGIN_ALREADY_REGISTERED: "PLUGIN_ALREADY_REGISTERED",
  // Dispatcher 相关
  DISPATCHER_CIRCULAR_DEPENDENCY: "DISPATCHER_CIRCULAR_DEPENDENCY",
  DISPATCHER_MISSING_DEPENDENCY: "DISPATCHER_MISSING_DEPENDENCY",
  DISPATCHER_BATCH_TIMEOUT: "DISPATCHER_BATCH_TIMEOUT",
  DISPATCHER_CANCELLED: "DISPATCHER_CANCELLED",
  // Reload 相关
  RELOAD_GUARD_BUSY: "RELOAD_GUARD_BUSY",
  RELOAD_PARTIAL_FAILURE: "RELOAD_PARTIAL_FAILURE",
  RELOAD_ROLLBACK_FAILED: "RELOAD_ROLLBACK_FAILED",
  // 角色匹配相关
  ROLE_MATCH_NO_RESULT: "ROLE_MATCH_NO_RESULT",
  ROLE_MATCH_INVALID: "ROLE_MATCH_INVALID",
  // 配置相关
  CONFIG_INVALID: "CONFIG_INVALID",
  CONFIG_FILE_NOT_FOUND: "CONFIG_FILE_NOT_FOUND",
  // v1.1 新增：领域专家相关
  DOMAIN_EXPERT_ALREADY_REGISTERED: "DOMAIN_EXPERT_ALREADY_REGISTERED",
  DOMAIN_EXPERT_ROLE_ID_COLLISION: "DOMAIN_EXPERT_ROLE_ID_COLLISION",
  DOMAIN_EXPERT_CATEGORY_UNKNOWN: "DOMAIN_EXPERT_CATEGORY_UNKNOWN",
  DOMAIN_EXPERT_NOT_FOUND: "DOMAIN_EXPERT_NOT_FOUND",
  // v1.1 Phase 5 新增：领域专家 review 插件调用相关
  EXPERT_INVOCATION_FAILED: "EXPERT_INVOCATION_FAILED",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ============================================================================
// 第二部分：错误 schema（zod 校验）
// ============================================================================

/**
 * 错误信息 schema（用于序列化到日志/事件）
 */
export const ErrorInfo = z.object({
  code: z.string(),
  message: z.string(),
  cause: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string().datetime(),
  stack: z.string().optional(),
});
export type ErrorInfo = z.infer<typeof ErrorInfo>;

// ============================================================================
// 第三部分：错误基类
// ============================================================================

/**
 * Team 模块顶层错误基类
 *
 * 用途：所有 team 模块相关错误的统一捕获点
 */
export class TeamError extends Error {
  /** 机器可读错误码 */
  readonly code: ErrorCode;
  /** 结构化上下文（用于日志聚合） */
  readonly context: Record<string, unknown>;
  /** 触发时间（ISO 8601） */
  readonly timestamp: string;
  /** 原始错误（保留堆栈） */
  readonly cause?: Error;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      cause?: Error;
      context?: Record<string, unknown>;
    }
  ) {
    super(message);
    this.name = "TeamError";
    this.code = code;
    this.context = options?.context ?? {};
    this.timestamp = new Date().toISOString();
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
    if (typeof (Error as unknown as { captureStackTrace?: unknown }).captureStackTrace === "function") {
      // ctor 类型用 unknown（替代 eslint 禁用的 Function 类型），V8 captureStackTrace 运行时接受任意构造函数
      (Error as unknown as { captureStackTrace: (target: object, ctor: unknown) => void }).captureStackTrace(
        this,
        this.constructor
      );
    }
  }

  toInfo(): ErrorInfo {
    return {
      code: this.code,
      message: this.message,
      cause: this.cause?.message,
      context: this.context,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }

  toJSON(): string {
    return JSON.stringify(this.toInfo());
  }
}

// ============================================================================
// 第四部分：Drop-in 加载相关错误
// ============================================================================

export class DropInFileNotFoundError extends TeamError {
  constructor(path: string, cause?: Error) {
    super(ErrorCode.DROP_IN_FILE_NOT_FOUND, `文件不存在：${path}`, {
      cause,
      context: { path },
    });
    this.name = "DropInFileNotFoundError";
  }
}

export class DropInSpecFailedError extends TeamError {
  constructor(path: string, reason: string, cause?: Error) {
    super(ErrorCode.DROP_IN_SPEC_FAILED, `spec 构造失败：${path}（${reason}）`, {
      cause,
      context: { path, reason },
    });
    this.name = "DropInSpecFailedError";
  }
}

export class DropInExecFailedError extends TeamError {
  constructor(path: string, execError: Error) {
    super(ErrorCode.DROP_IN_EXEC_FAILED, `exec_module 失败：${path}（${execError.name}: ${execError.message}）`, {
      cause: execError,
      context: { path, execErrorName: execError.name },
    });
    this.name = "DropInExecFailedError";
  }
}

export class DropInNoPluginError extends TeamError {
  constructor(path: string) {
    super(ErrorCode.DROP_IN_NO_PLUGIN, `${path} 未定义任何 GoalCommandPlugin 子类`, {
      context: { path },
    });
    this.name = "DropInNoPluginError";
  }
}

export class DropInDuplicateNameError extends TeamError {
  constructor(path: string, duplicates: ReadonlyArray<string>) {
    super(ErrorCode.DROP_IN_DUPLICATE_NAME, `${path} 包含重复 plugin name：${duplicates.join(", ")}`, {
      context: { path, duplicates },
    });
    this.name = "DropInDuplicateNameError";
  }
}

export class DropInConstructFailedError extends TeamError {
  constructor(path: string, className: string, reason: string, cause?: Error) {
    super(ErrorCode.DROP_IN_CONSTRUCT_FAILED, `plugin ${className} 构造失败：${reason}`, {
      cause,
      context: { path, className, reason },
    });
    this.name = "DropInConstructFailedError";
  }
}

export class DropInPathAbsoluteError extends TeamError {
  constructor(path: string) {
    super(ErrorCode.DROP_IN_PATH_ABSOLUTE, `drop-in 目录必须为相对路径，绝对路径被拒绝：${path}`, {
      context: { path },
    });
    this.name = "DropInPathAbsoluteError";
  }
}

export class DropInPathOutsideRootError extends TeamError {
  constructor(absolutePath: string, projectRoot: string) {
    super(ErrorCode.DROP_IN_PATH_OUTSIDE_ROOT, `drop-in 目录必须在 project_root 内：${absolutePath} ∉ ${projectRoot}`, {
      context: { absolutePath, projectRoot },
    });
    this.name = "DropInPathOutsideRootError";
  }
}

export class DropInPathNotDirError extends TeamError {
  constructor(absolutePath: string) {
    super(ErrorCode.DROP_IN_PATH_NOT_DIR, `drop-in 路径不是目录：${absolutePath}`, {
      context: { absolutePath },
    });
    this.name = "DropInPathNotDirError";
  }
}

export class DropInPathCreateFailedError extends TeamError {
  constructor(absolutePath: string, reason: string, cause?: Error) {
    super(ErrorCode.DROP_IN_PATH_CREATE_FAILED, `无法创建 drop-in 目录：${absolutePath}（${reason}）`, {
      cause,
      context: { absolutePath, reason },
    });
    this.name = "DropInPathCreateFailedError";
  }
}

export class DropInPathError extends TeamError {
  constructor(message: string, code: ErrorCode, context: Record<string, unknown>) {
    super(code, message, { context });
    this.name = "DropInPathError";
  }
}

// ============================================================================
// 第五部分：插件契约错误
// ============================================================================

export class PluginNameInvalidError extends TeamError {
  constructor(name: string, reason: string) {
    super(ErrorCode.PLUGIN_NAME_INVALID, `plugin name 不合法：${name}（${reason}）`, { context: { name, reason } });
    this.name = "PluginNameInvalidError";
  }
}

export class PluginPriorityDuplicateError extends TeamError {
  constructor(priority: number, existingName: string, newName: string) {
    super(ErrorCode.PLUGIN_PRIORITY_DUPLICATE, `plugin priority 重复：${priority}（${existingName} vs ${newName}）`, {
      context: { priority, existingName, newName },
    });
    this.name = "PluginPriorityDuplicateError";
  }
}

export class PluginMutexSelfError extends TeamError {
  constructor(name: string) {
    super(ErrorCode.PLUGIN_MUTEX_SELF, `plugin ${name} 的 mutex_with 包含自己（自指）`, { context: { name } });
    this.name = "PluginMutexSelfError";
  }
}

export class PluginMutexUnknownError extends TeamError {
  constructor(name: string, unknownTarget: string, available: ReadonlyArray<string>) {
    super(ErrorCode.PLUGIN_MUTEX_UNKNOWN, `plugin ${name} 的 mutex_with 引用未知 plugin：${unknownTarget}`, {
      context: { name, unknownTarget, available },
    });
    this.name = "PluginMutexUnknownError";
  }
}

export class PluginMutexAsymmetricError extends TeamError {
  constructor(nameA: string, nameB: string) {
    super(
      ErrorCode.PLUGIN_MUTEX_ASYMMETRIC,
      `plugin mutex 关系不对称：${nameA} 引用 ${nameB}，但 ${nameB} 未引用 ${nameA}`,
      { context: { nameA, nameB } }
    );
    this.name = "PluginMutexAsymmetricError";
  }
}

export class PluginNotRegisteredError extends TeamError {
  constructor(name: string) {
    super(ErrorCode.PLUGIN_NOT_REGISTERED, `plugin 未注册：${name}`, { context: { name } });
    this.name = "PluginNotRegisteredError";
  }
}

export class PluginAlreadyRegisteredError extends TeamError {
  constructor(name: string) {
    super(ErrorCode.PLUGIN_ALREADY_REGISTERED, `plugin 已注册：${name}（hot_reload 需先 unregister）`, {
      context: { name },
    });
    this.name = "PluginAlreadyRegisteredError";
  }
}

// ============================================================================
// 第六部分：Dispatcher 错误
// ============================================================================

export class DispatcherCircularDependencyError extends TeamError {
  constructor(cycle: ReadonlyArray<string>) {
    super(ErrorCode.DISPATCHER_CIRCULAR_DEPENDENCY, `检测到循环依赖：${cycle.join(" → ")}`, { context: { cycle } });
    this.name = "DispatcherCircularDependencyError";
  }
}

export class DispatcherMissingDependencyError extends TeamError {
  constructor(goalId: string, missingDep: string) {
    super(ErrorCode.DISPATCHER_MISSING_DEPENDENCY, `goal ${goalId} 依赖不存在的 goal ${missingDep}`, {
      context: { goalId, missingDep },
    });
    this.name = "DispatcherMissingDependencyError";
  }
}

export class DispatcherBatchTimeoutError extends TeamError {
  constructor(batchId: string, timeoutMs: number) {
    super(ErrorCode.DISPATCHER_BATCH_TIMEOUT, `batch ${batchId} 超时（${timeoutMs}ms）`, {
      context: { batchId, timeoutMs },
    });
    this.name = "DispatcherBatchTimeoutError";
  }
}

export class DispatcherCancelledError extends TeamError {
  constructor(batchId: string) {
    super(ErrorCode.DISPATCHER_CANCELLED, `batch ${batchId} 已被取消`, {
      context: { batchId },
    });
    this.name = "DispatcherCancelledError";
  }
}

// ============================================================================
// 第七部分：Reload 错误
// ============================================================================

export class ReloadGuardBusyError extends TeamError {
  constructor(operation: string, holder: string) {
    super(ErrorCode.RELOAD_GUARD_BUSY, `ReloadGuard 忙：${operation} 等待中（当前持有者：${holder}）`, {
      context: { operation, holder },
    });
    this.name = "ReloadGuardBusyError";
  }
}

export class ReloadPartialFailureError extends TeamError {
  constructor(file: string, succeeded: number, failed: number, failures: ReadonlyArray<string>) {
    super(
      ErrorCode.RELOAD_PARTIAL_FAILURE,
      `reload ${file} 部分失败：${succeeded} 成功，${failed} 失败（${failures.join(", ")}）`,
      { context: { file, succeeded, failed, failures } }
    );
    this.name = "ReloadPartialFailureError";
  }
}

export class ReloadRollbackFailedError extends TeamError {
  constructor(file: string, lostPlugins: ReadonlyArray<string>) {
    super(
      ErrorCode.RELOAD_ROLLBACK_FAILED,
      `reload ${file} 回滚失败，永久丢失 ${lostPlugins.length} 个 plugin：${lostPlugins.join(", ")}`,
      { context: { file, lostPlugins } }
    );
    this.name = "ReloadRollbackFailedError";
  }
}

// ============================================================================
// 第八部分：角色匹配错误
// ============================================================================

export class RoleMatchNoResultError extends TeamError {
  constructor(taskTitle: string, candidates: number) {
    super(ErrorCode.ROLE_MATCH_NO_RESULT, `未匹配到任何角色：${taskTitle}（候选 ${candidates} 个）`, {
      context: { taskTitle, candidates },
    });
    this.name = "RoleMatchNoResultError";
  }
}

export class RoleMatchInvalidError extends TeamError {
  constructor(reason: string) {
    super(ErrorCode.ROLE_MATCH_INVALID, `角色匹配结果非法：${reason}`, { context: { reason } });
    this.name = "RoleMatchInvalidError";
  }
}

// ============================================================================
// 第九部分：配置错误
// ============================================================================

export class ConfigInvalidError extends TeamError {
  constructor(field: string, reason: string, value?: unknown) {
    super(ErrorCode.CONFIG_INVALID, `配置非法：${field} = ${JSON.stringify(value)}（${reason}）`, {
      context: { field, reason, value },
    });
    this.name = "ConfigInvalidError";
  }
}

export class ConfigFileNotFoundError extends TeamError {
  constructor(path: string) {
    super(ErrorCode.CONFIG_FILE_NOT_FOUND, `配置文件不存在：${path}`, { context: { path } });
    this.name = "ConfigFileNotFoundError";
  }
}

// ============================================================================
// 第十部分：领域专家错误（v1.1 新增）
//
// 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.2 P1-7 命名冲突检测增强
// 错误类继承 TeamError（与项目惯例一致），同时保留设计文档要求的字段
// ============================================================================

/**
 * 领域专家已注册错误
 *
 * 触发场景：DomainExpertRegistry.register 时 expertId 已存在
 * 设计文档 §3.2 P1-7：register() 三道校验中的"自身重复"校验
 */
export class DomainExpertAlreadyRegisteredError extends TeamError {
  /** 已注册的专家 ID */
  readonly expertId: string;
  constructor(expertId: string) {
    super(ErrorCode.DOMAIN_EXPERT_ALREADY_REGISTERED, `领域专家已注册：${expertId}`, {
      context: { expertId },
    });
    this.name = "DomainExpertAlreadyRegisteredError";
    this.expertId = expertId;
  }
}

/**
 * 领域专家与角色 ID 命名冲突错误
 *
 * 触发场景：DomainExpertRegistry.register 时 expertId 去 domain- 前缀后与 RoleId 冲突
 * 设计文档 §3.2 P1-7：register() 三道校验中的"跨系统冲突"校验
 *
 * 示例：expertId="domain-architect" 去 domain- 前缀后为 "architect"，与 RoleId="architect" 冲突
 */
export class DomainExpertRoleIdCollisionError extends TeamError {
  /** 触发冲突的专家 ID */
  readonly expertId: string;
  /** 被冲突的角色 ID */
  readonly collisionRoleId: string;
  constructor(expertId: string, collisionRoleId: string) {
    super(
      ErrorCode.DOMAIN_EXPERT_ROLE_ID_COLLISION,
      `领域专家 ID "${expertId}" 与角色 ID "${collisionRoleId}" 命名冲突（去 domain- 前缀后相同）`,
      { context: { expertId, collisionRoleId } }
    );
    this.name = "DomainExpertRoleIdCollisionError";
    this.expertId = expertId;
    this.collisionRoleId = collisionRoleId;
  }
}

/**
 * 未知领域专家类别错误
 *
 * 触发场景：DomainExpertRegistry.ensureLoaded 接收到未知 category
 * 设计文档 §4.3 loadByCategoryInternal：未在 moduleMap 中的类别
 */
export class DomainExpertCategoryUnknownError extends TeamError {
  /** 未知类别名称 */
  readonly category: string;
  constructor(category: string) {
    super(ErrorCode.DOMAIN_EXPERT_CATEGORY_UNKNOWN, `未知的领域专家类别：${category}`, {
      context: { category },
    });
    this.name = "DomainExpertCategoryUnknownError";
    this.category = category;
  }
}

/**
 * 领域专家未找到错误
 *
 * 触发场景：DomainExpertRegistry.unregister/getExpert 操作不存在的 expertId
 * 注：getExpert 返回 undefined 而不抛错；unregister 返回 false 而不抛错
 *     此错误类用于 registerAll 等批量操作中的内部失败场景
 */
export class DomainExpertNotFoundError extends TeamError {
  /** 未找到的专家 ID */
  readonly expertId: string;
  constructor(expertId: string) {
    super(ErrorCode.DOMAIN_EXPERT_NOT_FOUND, `领域专家未找到：${expertId}`, {
      context: { expertId },
    });
    this.name = "DomainExpertNotFoundError";
    this.expertId = expertId;
  }
}

// ============================================================================
// 第十一部分：领域专家 review 插件错误（v1.1 Phase 5 新增）
//
// 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.4.3 DomainExpertReviewPlugin
// 触发场景：invokeExpertLLM 调用 LLM 失败（超时 / 网络错误 / 响应解析失败）
// 异常处理：由 execute() 的 Promise.allSettled 捕获，单个专家失败不影响其他专家
// ============================================================================

/**
 * 领域专家调用失败错误
 *
 * 触发场景（invokeExpertLLM 内部）：
 *   1. LLM 客户端不可用（无 API Key）
 *   2. LLM 调用超时（超过 expertTimeoutMs）
 *   3. LLM 响应解析失败（非 JSON / schema 校验不通过）
 *   4. LLM 返回空内容
 *
 * 设计：继承 TeamError，携带 expertId / phase / reason 三个字段
 *       便于 dispatcher 在 Promise.allSettled rejection 中聚合错误信息
 */
export class ExpertInvocationError extends TeamError {
  /** 触发失败的专家 ID */
  readonly expertId: string;
  /** 触发阶段（timeout / network / parse / empty / no-client） */
  readonly phase: string;
  constructor(expertId: string, phase: string, reason: string, cause?: Error) {
    super(ErrorCode.EXPERT_INVOCATION_FAILED, `领域专家调用失败：${expertId}（阶段：${phase}，原因：${reason}）`, {
      cause,
      context: { expertId, phase, reason },
    });
    this.name = "ExpertInvocationError";
    this.expertId = expertId;
    this.phase = phase;
  }
}
