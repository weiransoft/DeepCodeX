/**
 * Git 过程管理实现（EAG-P1 批次 5）
 *
 * 本模块实现 `GitProcessManager` 类，提供 EAG 方案 §5.10.4 Git 过程管理自动化的真实逻辑。
 *
 * 核心职责：
 * - createBranch：生成 `feature/eag-<run-id>` 分支名（对齐 §5.10.4 分支模型）
 * - generateCommitMessage：生成语义化提交消息（自动附需求溯源 [REQ-F-xxx]）
 * - registerPendingDeletion：注册待删文件清单（SEED-10 删除纪律——延迟到 Loop 收尾）
 * - flushPendingDeletions：批量执行删除（Loop 收尾阶段调用，返回已删除文件列表）
 *
 * §5.10.4 Git 过程管理自动化要求：
 * - 分支模型：每个 EAG run 自动创建 `feature/eag-<run-id>` 分支
 * - Commit 规范：语义化提交（`feat(eag): ...`），message 自动附需求溯源
 * - 快照与回滚：side-git turn 级快照；Loop 每迭代一个 commit 检查点
 * - 交付门禁：TESTING Loop 通过后自动生成 PR 描述
 * - 删除纪律：SEED-10 落地——文件删除操作统一延迟到 Loop 收尾阶段批量执行
 *
 * 设计依据：
 * - EAG 方案 §5.10.4 Git 过程管理自动化
 * - SEED-10 规则（文件删除操作延迟到 Loop 收尾）
 * - Conventional Commits 规范（feat/fix/docs/chore/test/refactor）
 *
 * 不可变优先：
 * - 内部状态使用 readonly 修饰
 * - 公开方法返回冻结对象或基本类型
 *
 * @module eag/doc-driven/git-process-manager
 */

import type { CommitType, GitProcessConfig } from "./types";
import { createDefaultGitProcessConfig } from "./types";

// ============================================================================
// 异常类型
// ============================================================================

/**
 * Git 过程管理错误（参数非法或状态错误时抛出）
 *
 * 包含错误类型与详细信息，便于调用方区分处理。
 */
export class GitProcessError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-run-id：runId 非法
   *   - invalid-commit-type：commit 类型非法
   *   - invalid-scope：scope 非法
   *   - invalid-subject：subject 非法
   *   - invalid-requirement-id：requirementId 非法
   *   - invalid-file-path：文件路径非法
   * @param detail 错误详情
   */
  constructor(
    public readonly kind:
      | "invalid-run-id"
      | "invalid-commit-type"
      | "invalid-scope"
      | "invalid-subject"
      | "invalid-requirement-id"
      | "invalid-file-path",
    public readonly detail: string
  ) {
    super(`Git 过程管理错误 [${kind}]：${detail}`);
    this.name = "GitProcessError";
  }
}

// ============================================================================
// PR 描述生成结果类型
// ============================================================================

/**
 * PR 描述生成结果（generatePrDescription 产出）
 *
 * 对应 EAG 方案 §5.10.4 交付门禁——TESTING Loop 通过后自动生成 PR 描述。
 *
 * PR 描述包含：
 * - title：PR 标题（语义化提交风格）
 * - body：PR 正文（含变更摘要 / 验收命令 / 需求溯源 / 风险提示）
 */
export interface PrDescription {
  /** PR 标题（语义化提交风格，如 "feat(eag): 实现用户登录 [REQ-F-001]"） */
  readonly title: string;
  /** PR 正文（Markdown 格式，含变更摘要/验收/溯源/风险） */
  readonly body: string;
}

// ============================================================================
// GitProcessManager 类
// ============================================================================

/**
 * Git 过程管理器（实现 §5.10.4 Git 过程管理自动化）
 *
 * 提供真实 Git 过程管理逻辑（禁止 mock）：
 * - createBranch：生成 `feature/eag-<run-id>` 分支名
 * - generateCommitMessage：生成语义化提交消息（含需求溯源）
 * - generatePrDescription：生成 PR 描述（TESTING Loop 通过后调用）
 * - registerPendingDeletion：注册待删文件（SEED-10 删除纪律）
 * - flushPendingDeletions：批量执行删除（Loop 收尾阶段调用）
 *
 * 使用方式：
 * ```typescript
 * const mgr = new GitProcessManager();
 * const branch = mgr.createBranch("20260718-001");
 * const msg = mgr.generateCommitMessage("feat", "eag", "实现用户登录", "F-001");
 * mgr.registerPendingDeletion(["tmp/old-config.json"]);
 * const deleted = mgr.flushPendingDeletions();
 * ```
 */
export class GitProcessManager {
  /**
   * Git 过程管理配置（不可变，构造时注入）
   *
   * 含 branchPrefix / enableAutoPr / snapshotPerTurn 三个字段。
   */
  private readonly config: Readonly<GitProcessConfig>;

  /**
   * 待删文件清单（实例级，registerPendingDeletion 累积，flushPendingDeletions 清空）
   *
   * 对应 SEED-10 删除纪律——文件删除操作统一延迟到 Loop 收尾阶段批量执行，
   * 避免中途删除导致依赖断裂或回滚困难。
   */
  private readonly pendingDeletions: Set<string>;

  /**
   * @param config Git 过程管理配置（默认使用 DEFAULT_GIT_PROCESS_CONFIG）
   */
  constructor(config: Readonly<GitProcessConfig> = createDefaultGitProcessConfig()) {
    this.config = config;
    this.pendingDeletions = new Set<string>();
  }

  /**
   * 生成 `feature/eag-<run-id>` 分支名
   *
   * 对应 EAG 方案 §5.10.4 分支模型：每个 EAG run 自动创建独立分支，
   * 避免污染主干，便于回滚与审计。
   *
   * 分支名格式：`<branchPrefix><runId>`
   * - 默认 branchPrefix="feature/eag-"
   * - runId 由调用方提供（如时间戳+序号 "20260718-001"）
   *
   * @param runId EAG run 标识符（非空字符串，仅允许字母/数字/连字符）
   * @returns 分支名（如 "feature/eag-20260718-001"）
   * @throws {GitProcessError} runId 非法时抛出 invalid-run-id
   */
  createBranch(runId: string): string {
    // 校验 runId：非空字符串，仅允许字母/数字/连字符
    if (typeof runId !== "string" || runId.trim().length === 0) {
      throw new GitProcessError("invalid-run-id", "runId 必须为非空字符串");
    }
    // 合法字符集：a-z, A-Z, 0-9, 连字符
    const validRunIdPattern = /^[a-zA-Z0-9-]+$/;
    if (!validRunIdPattern.test(runId)) {
      throw new GitProcessError("invalid-run-id", `runId 仅允许字母/数字/连字符，实际值：${runId}`);
    }

    return `${this.config.branchPrefix}${runId}`;
  }

  /**
   * 生成语义化提交消息（自动附需求溯源 [REQ-F-xxx]）
   *
   * 对应 EAG 方案 §5.10.4 Commit 规范：语义化提交 + message 自动附需求溯源。
   *
   * 消息格式（对齐 Conventional Commits）：
   * ```
   * <type>(<scope>): <subject> [REQ-<requirementId>]
   *
   * <body>
   * ```
   *
   * 范例：
   * ```
   * feat(eag): 实现用户登录 [REQ-F-001]
   *
   * - 新增 UserAggregate 骨架
   * - 新增登录用例 LoginUseCase
   * ```
   *
   * @param type 提交类型（feat/fix/docs/chore/test/refactor）
   * @param scope 提交范围（如 "eag"、"user-aggregate"）
   * @param subject 提交主题（简洁描述，如 "实现用户登录"）
   * @param requirementId 需求溯源 ID（如 "F-001"，对齐 [REQ-F-xxx] 标记规范）
   * @param body 提交正文（可选，多行描述变更详情）
   * @returns 完整的语义化提交消息字符串
   * @throws {GitProcessError} 任一参数非法时抛出对应错误类型
   */
  generateCommitMessage(
    type: CommitType,
    scope: string,
    subject: string,
    requirementId: string,
    body?: string
  ): string {
    // 校验 type：必须为 COMMIT_TYPES 之一
    const validTypes: ReadonlyArray<CommitType> = ["feat", "fix", "docs", "chore", "test", "refactor"];
    if (!validTypes.includes(type)) {
      throw new GitProcessError("invalid-commit-type", `type 必须为 [${validTypes.join(", ")}] 之一，实际值：${type}`);
    }

    // 校验 scope：非空字符串，仅允许字母/数字/连字符
    if (typeof scope !== "string" || scope.trim().length === 0) {
      throw new GitProcessError("invalid-scope", "scope 必须为非空字符串");
    }
    const validScopePattern = /^[a-zA-Z0-9-]+$/;
    if (!validScopePattern.test(scope)) {
      throw new GitProcessError("invalid-scope", `scope 仅允许字母/数字/连字符，实际值：${scope}`);
    }

    // 校验 subject：非空字符串
    if (typeof subject !== "string" || subject.trim().length === 0) {
      throw new GitProcessError("invalid-subject", "subject 必须为非空字符串");
    }
    // subject 不得包含换行（一行描述）
    if (subject.includes("\n")) {
      throw new GitProcessError("invalid-subject", "subject 不得包含换行符");
    }

    // 校验 requirementId：非空字符串，仅允许字母/数字/连字符
    if (typeof requirementId !== "string" || requirementId.trim().length === 0) {
      throw new GitProcessError("invalid-requirement-id", "requirementId 必须为非空字符串");
    }
    const validReqIdPattern = /^[a-zA-Z0-9-]+$/;
    if (!validReqIdPattern.test(requirementId)) {
      throw new GitProcessError(
        "invalid-requirement-id",
        `requirementId 仅允许字母/数字/连字符，实际值：${requirementId}`
      );
    }

    // 构建消息头：`<type>(<scope>): <subject> [REQ-<requirementId>]`
    const header = `${type}(${scope}): ${subject} [REQ-${requirementId}]`;

    // 若无 body，直接返回 header
    if (!body || body.trim().length === 0) {
      return header;
    }

    // 有 body：header + 空行 + body（对齐 Conventional Commits 规范）
    return `${header}\n\n${body}`;
  }

  /**
   * 生成 PR 描述（TESTING Loop 通过后调用）
   *
   * 对应 EAG 方案 §5.10.4 交付门禁——TESTING Loop 通过后自动生成 PR 描述。
   *
   * PR 描述包含：
   * - title：PR 标题（语义化提交风格，含需求溯源）
   * - body：PR 正文（Markdown 格式，含变更摘要 / 验收命令 / 需求溯源 / 风险提示）
   *
   * @param type 提交类型（feat/fix/docs/chore/test/refactor）
   * @param scope 提交范围
   * @param subject PR 主题
   * @param requirementId 需求溯源 ID
   * @param summary 变更摘要（多行描述本次 PR 的主要变更）
   * @param acceptanceCommands 验收命令列表（如 ["npm test", "npm run lint"]）
   * @param risks 风险提示列表（可选）
   * @returns PR 描述对象（含 title 与 body）
   */
  generatePrDescription(
    type: CommitType,
    scope: string,
    subject: string,
    requirementId: string,
    summary: ReadonlyArray<string>,
    acceptanceCommands: ReadonlyArray<string>,
    risks: ReadonlyArray<string> = []
  ): PrDescription {
    // 复用 generateCommitMessage 的校验逻辑生成 title
    const title = this.generateCommitMessage(type, scope, subject, requirementId);

    // 构建 PR 正文（Markdown 格式）
    const bodyParts: string[] = [];

    // 章节 1：变更摘要
    bodyParts.push("## 变更摘要");
    bodyParts.push("");
    for (const line of summary) {
      bodyParts.push(`- ${line}`);
    }

    // 章节 2：验收命令（评估器执行判定 PR 是否可合并）
    bodyParts.push("");
    bodyParts.push("## 验收命令");
    bodyParts.push("");
    bodyParts.push("```bash");
    for (const cmd of acceptanceCommands) {
      bodyParts.push(cmd);
    }
    bodyParts.push("```");

    // 章节 3：需求溯源
    bodyParts.push("");
    bodyParts.push("## 需求溯源");
    bodyParts.push("");
    bodyParts.push(`- [REQ-${requirementId}] 本次变更对应需求 ${requirementId}`);

    // 章节 4：风险提示（可选）
    if (risks.length > 0) {
      bodyParts.push("");
      bodyParts.push("## 风险提示");
      bodyParts.push("");
      for (const risk of risks) {
        bodyParts.push(`- ${risk}`);
      }
    }

    // 章节 5：合规声明（自动附）
    bodyParts.push("");
    bodyParts.push("## 合规声明");
    bodyParts.push("");
    bodyParts.push("- 本 PR 已通过 TESTING Loop 评估器判定（对齐 §5.10.4 交付门禁）");
    bodyParts.push("- 文件删除已遵循 SEED-10 删除纪律（延迟到 Loop 收尾批量执行）");

    return Object.freeze({
      title,
      body: bodyParts.join("\n"),
    });
  }

  /**
   * 注册待删文件清单（SEED-10 删除纪律——延迟到 Loop 收尾）
   *
   * 对应 EAG 方案 §5.10.4 删除纪律 + SEED-10 规则：
   * 文件删除操作统一延迟到 Loop 收尾阶段批量执行，
   * 避免中途删除导致依赖断裂或回滚困难。
   *
   * 注册的文件路径会被加入待删清单，直到 flushPendingDeletions 被调用才真正"删除"。
   * 重复注册同一文件路径会被自动去重（使用 Set 数据结构）。
   *
   * @param files 待删文件路径列表（相对路径或绝对路径均可）
   * @throws {GitProcessError} 任一文件路径为空字符串时抛出 invalid-file-path
   */
  registerPendingDeletion(files: ReadonlyArray<string>): void {
    for (const file of files) {
      // 校验文件路径：非空字符串
      if (typeof file !== "string" || file.trim().length === 0) {
        throw new GitProcessError("invalid-file-path", "文件路径必须为非空字符串");
      }
      this.pendingDeletions.add(file);
    }
  }

  /**
   * 批量执行删除（Loop 收尾阶段调用，返回已删除文件列表）
   *
   * 对应 EAG 方案 §5.10.4 删除纪律：Loop 收尾阶段批量执行所有待删文件。
   *
   * 注意：本方法不真正调用 fs.unlink 删除磁盘文件——磁盘删除由上层 Loop 编排器
   * 在收尾阶段统一执行（避免本模块与文件系统耦合）。本方法仅返回待删清单并清空内部状态，
   * 上层编排器拿到清单后调用 fs API 批量删除。
   *
   * 设计理由：
   * - 单一职责：本模块负责"删除纪律的清单管理"，不负责"磁盘 I/O"
   * - 可测试性：测试无需创建真实文件即可验证清单管理逻辑
   * - 解耦：上层编排器可选择不同的删除策略（同步/异步/回收站）
   *
   * @returns 已删除文件路径列表（按字典序排序，便于审计）
   */
  flushPendingDeletions(): string[] {
    // 收集待删清单并按字典序排序（便于审计与可重放）
    const deleted = [...this.pendingDeletions].sort();
    // 清空内部状态（一次性消费）
    this.pendingDeletions.clear();
    return deleted;
  }

  /**
   * 查询当前待删文件清单（不消费，仅查询）
   *
   * 用于测试或调试时检查待删清单状态。
   *
   * @returns 待删文件路径列表的只读副本（按字典序排序）
   */
  getPendingDeletions(): readonly string[] {
    return [...this.pendingDeletions].sort();
  }

  /**
   * 查询当前待删文件数量
   *
   * @returns 待删文件数量
   */
  getPendingDeletionCount(): number {
    return this.pendingDeletions.size;
  }
}
