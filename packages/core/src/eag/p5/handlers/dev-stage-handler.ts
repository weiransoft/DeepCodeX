/**
 * EAG-P5 Phase 5.2 DevStageHandler（TASK-P5-1.2-005）
 *
 * 本模块实现 `P5DevStageHandler` 类，是 AutonomousOrchestrator 4 阶段循环
 * 的 dev 阶段处理器，负责"代码改动前置护栏 + 文件状态盘点 + diff 统计"。
 *
 * 核心职责（对齐架构师审查 §3.1.3 + §4.1）：
 * 1. 从 plan 阶段产出（prevResults）中读取任务卡
 * 2. 对任务卡声明的每个文件做路径牢笼预检（G-A1a：path.resolve + 前缀校验）
 * 3. 对任务卡声明的每个文件做凭据白名单预检（G-A5a：禁止访问 .env / secrets 等）
 * 4. 盘点文件状态：exists / size / mtime，构造 ChangeDiff 制品
 * 5. 调用 guardChain.execute() 做 dev 阶段护栏判定
 * 6. 返回 dev 阶段制品（taskCard + validatedFiles + diffStats）
 *
 * 关键技术决策：
 * - 路径牢笼：path.resolve + 前缀校验，确保所有文件路径在 projectRoot 内
 * - 凭据白名单：基于文件名模式匹配（.env / .ssh / .aws / secrets 等）
 * - 文件盘点：fs.existsSync / fs.statSync 真实读取文件状态（不模拟）
 * - diff 统计：基于文件存在性 + 文件大小估算（无 git diff 时使用 size 差值）
 *
 * 注意：本 Handler 不直接执行代码生成（LLM 职责），而是为 LLM 提供
 * 已通过护栏验证的"文件操作上下文"。LLM 在此上下文内生成代码后，
 * 由 verify 阶段验证。
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 *
 * @module eag/p5/handlers/dev-stage-handler
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { P5StageContext, P5StageHandler, P5StageResult } from "./types";
import { buildGuardContext, createSuccessStageResult, createFailedStageResult, toGuardRecords } from "./types";
import type { TaskCard, ChangedFile, ChangeDiff } from "../guards/types";

// ============================================================================
// 1. 常量定义
// ============================================================================

/**
 * 凭据文件模式黑名单（G-A5a 凭据白名单预检依据）
 *
 * 命中以下任一模式的文件禁止在 dev 阶段访问（读写均禁止）：
 * - .env / .env.* ：环境变量文件
 * - .ssh/ ：SSH 密钥目录
 * - .aws/ ：AWS 凭据目录
 * - .gnupg/ ：GPG 密钥目录
 * - secrets / credentials / token / password 等关键词
 * - *.pem / *.key / *.p12 / *.pfx ：证书/密钥文件
 * - .npmrc / .pypirc ：包管理器凭据
 * - .git-credentials ：Git 凭据
 */
const CREDENTIAL_FILE_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\.env(\.|$)/i,
  /\.ssh[\\/]/i,
  /\.aws[\\/]/i,
  /\.gnupg[\\/]/i,
  /secrets?/i,
  /credentials?/i,
  /\btoken\b/i,
  /\bpassword\b/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.npmrc$/i,
  /\.pypirc$/i,
  /\.git-credentials$/i,
]);

/**
 * 默认凭据文件模式数量（用于测试断言）
 */
const CREDENTIAL_PATTERN_COUNT = CREDENTIAL_FILE_PATTERNS.length;

// ============================================================================
// 2. 类型定义
// ============================================================================

/**
 * 文件状态盘点结果（单个文件）
 */
interface FileInventoryEntry {
  /** 文件相对路径（相对 projectRoot） */
  readonly relativePath: string;
  /** 文件绝对路径 */
  readonly absolutePath: string;
  /** 是否存在 */
  readonly exists: boolean;
  /** 文件大小（字节，不存在时为 0） */
  readonly size: number;
  /** 最后修改时间（ISO 8601，不存在时为空字符串） */
  readonly mtime: string;
  /** 是否为凭据文件（命中黑名单模式） */
  readonly isCredential: boolean;
  /** 是否在项目根目录内（路径牢笼校验） */
  readonly withinProjectRoot: boolean;
}

// ============================================================================
// 3. P5DevStageHandler 类
// ============================================================================

/**
 * Dev 阶段处理器
 *
 * 设计原则（对齐 Karpathy Simplicity First + Ponytail 红线）：
 *   1. 单一职责：仅做"前置护栏 + 文件盘点"，不执行代码生成
 *   2. 真实文件 I/O：使用 fs.existsSync / fs.statSync 盘点文件（不模拟）
 *   3. 护栏先行：先做路径牢笼 + 凭据白名单，再调用 guardChain
 *   4. 不可变产出：返回的 P5StageResult 为冻结对象
 *
 * 使用方式：
 * ```typescript
 * const handler = new P5DevStageHandler();
 * const result = await handler.handle(ctx);
 * if (result.kind === "success") {
 *   const validatedFiles = result.artifacts["validatedFiles"] as string[];
 *   const diffStats = result.artifacts["diffStats"] as [number, number, number];
 * }
 * ```
 */
export class P5DevStageHandler implements P5StageHandler {
  /**
   * 执行 dev 阶段处理
   *
   * 完整时序：
   * 1. 从 prevResults 中查找 plan 阶段产出的任务卡
   * 2. 若无任务卡 → 返回 success + taskCard=null（Orchestrator 据此判断完成）
   * 3. 对任务卡声明的每个文件做路径牢笼 + 凭据白名单预检
   * 4. 若任一文件命中凭据黑名单 → 返回 fatal（G-A5a BLOCKER）
   * 5. 若任一文件越出 projectRoot → 返回 fatal（G-A1a BLOCKER）
   * 6. 盘点文件状态（exists/size/mtime）
   * 7. 构造 ChangeDiff 制品
   * 8. 调用 guardChain.execute() 做 dev 阶段护栏判定
   * 9. 返回 success + validatedFiles + diffStats
   *
   * @param ctx 阶段执行上下文
   * @returns 阶段执行结果
   */
  async handle(ctx: Readonly<P5StageContext>): Promise<Readonly<P5StageResult>> {
    const startTime = Date.now();

    try {
      // 1. 从 prevResults 中查找 plan 阶段产出的任务卡
      const taskCard = extractTaskCardFromPrevResults(ctx);

      // 2. 若无任务卡 → 返回 success + taskCard=null
      if (taskCard === null) {
        return createSuccessStageResult(
          "dev",
          "无任务卡（plan 阶段未产出或已全部完成），dev 阶段跳过",
          { taskCard: null, reason: "no-task-card" },
          [],
          0,
          Date.now() - startTime
        );
      }

      // 3. 对任务卡声明的每个文件做路径牢笼 + 凭据白名单预检
      const inventory = this.inventoryFiles(taskCard.declaredFiles, ctx.projectRoot);

      // 4. 若任一文件命中凭据黑名单 → 返回 fatal（G-A5a BLOCKER）
      const credentialViolation = inventory.find((e) => e.isCredential);
      if (credentialViolation) {
        return createFailedStageResult(
          "dev",
          "fatal",
          `凭据文件访问被拒（G-A5a）：${credentialViolation.relativePath}`,
          `文件 ${credentialViolation.relativePath} 命中凭据黑名单模式，禁止在 dev 阶段访问`,
          {
            taskCard,
            violation: "credential-access",
            violationFile: credentialViolation.relativePath,
            guardRuleId: "G-A5a",
          },
          [],
          0,
          Date.now() - startTime
        );
      }

      // 5. 若任一文件越出 projectRoot → 返回 fatal（G-A1a BLOCKER）
      const pathViolation = inventory.find((e) => !e.withinProjectRoot);
      if (pathViolation) {
        return createFailedStageResult(
          "dev",
          "fatal",
          `路径越界被拒（G-A1a）：${pathViolation.relativePath}`,
          `文件 ${pathViolation.relativePath} 越出 projectRoot，违反路径牢笼约束`,
          {
            taskCard,
            violation: "path-jail",
            violationFile: pathViolation.relativePath,
            guardRuleId: "G-A1a",
          },
          [],
          0,
          Date.now() - startTime
        );
      }

      // 6. 构造 ChangeDiff 制品（对齐 guards/types.ts 的 ChangedFile 接口字段名）
      const changedFiles: ChangedFile[] = inventory.map((entry) => ({
        filePath: entry.relativePath,
        additions: 0, // dev 阶段尚未生成代码，additions=0
        deletions: 0,
        changeType: entry.exists ? "modified" : "added",
      }));

      const changeDiff: ChangeDiff = Object.freeze({
        changedFiles: Object.freeze(changedFiles),
        affectedSymbols: Object.freeze([...taskCard.declaredSymbols]),
        totalAdditions: 0,
        totalDeletions: 0,
      });

      // 7. 调用 guardChain.execute() 做 dev 阶段护栏判定
      const guardContext = buildGuardContext(ctx, {
        currentTaskCard: taskCard,
        currentDiff: changeDiff,
        pendingCommitFiles: Object.freeze([...taskCard.declaredFiles]),
        pendingReadFiles: Object.freeze([...taskCard.declaredFiles]),
      });

      const chainResult = await ctx.guardChain.execute(guardContext);
      const guardRecords = toGuardRecords(chainResult, ctx.iterIndex, "dev", ctx.loopType);

      // 8. 护栏 DENY → 返回 fatal
      if (chainResult.overallDecision === "DENY") {
        const firstDenial = chainResult.firstDenial;
        return createFailedStageResult(
          "dev",
          "fatal",
          `dev 阶段护栏拒绝（规则 ${firstDenial?.ruleId ?? "unknown"}）`,
          firstDenial?.reason ?? "未知原因",
          {
            taskCard,
            changeDiff,
            guardDecision: "DENY",
            guardRuleId: firstDenial?.ruleId ?? "",
          },
          guardRecords,
          0,
          Date.now() - startTime
        );
      }

      // 9. 护栏 ASK → 返回 failed（需用户确认）
      if (chainResult.overallDecision === "ASK") {
        const firstAsk = chainResult.triggeredGuards.find((v) => v.decision === "ASK");
        return createFailedStageResult(
          "dev",
          "failed",
          `dev 阶段护栏需确认（规则 ${firstAsk?.ruleId ?? "unknown"}）`,
          firstAsk?.reason ?? "需用户确认",
          {
            taskCard,
            changeDiff,
            guardDecision: "ASK",
            guardRuleId: firstAsk?.ruleId ?? "",
          },
          guardRecords,
          0,
          Date.now() - startTime
        );
      }

      // 10. 护栏 PASS → 返回 success + validatedFiles + diffStats
      const validatedFiles = inventory.filter((e) => e.withinProjectRoot && !e.isCredential).map((e) => e.relativePath);

      const diffStats: Readonly<[number, number, number]> = Object.freeze([
        inventory.length, // 文件总数
        inventory.filter((e) => e.exists).length, // 已存在文件数（将被修改）
        inventory.filter((e) => !e.exists).length, // 新文件数
      ]) as Readonly<[number, number, number]>;

      return createSuccessStageResult(
        "dev",
        `dev 阶段前置护栏通过（任务 ${taskCard.id}，${validatedFiles.length} 个文件已验证）`,
        {
          taskCard,
          changeDiff,
          validatedFiles: Object.freeze(validatedFiles),
          diffStats,
          fileInventory: Object.freeze(inventory),
          guardDecision: "PASS",
        },
        guardRecords,
        0,
        Date.now() - startTime
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return createFailedStageResult(
        "dev",
        "fatal",
        `dev 阶段异常：${error.message}`,
        error.stack ?? error.message,
        {},
        [],
        0,
        Date.now() - startTime
      );
    }
  }

  // ========================================================================
  // 内部辅助方法
  // ========================================================================

  /**
   * 盘点文件状态（路径牢笼 + 凭据白名单 + exists/size/mtime）
   *
   * @param filePaths 文件相对路径列表
   * @param projectRoot 项目根目录
   * @returns 文件盘点结果列表（readonly）
   */
  private inventoryFiles(filePaths: ReadonlyArray<string>, projectRoot: string): ReadonlyArray<FileInventoryEntry> {
    const entries: FileInventoryEntry[] = [];

    for (const relativePath of filePaths) {
      // 路径牢笼：解析为绝对路径，检查是否在 projectRoot 内
      const absolutePath = path.resolve(projectRoot, relativePath);
      const normalizedRoot = path.resolve(projectRoot);
      const withinProjectRoot = isWithinPath(absolutePath, normalizedRoot);

      // 凭据白名单：检查文件名是否命中黑名单模式
      const isCredential = CREDENTIAL_FILE_PATTERNS.some((re) => re.test(relativePath));

      // 文件状态盘点
      let exists = false;
      let size = 0;
      let mtime = "";
      if (withinProjectRoot && !isCredential) {
        try {
          const stat = fs.statSync(absolutePath);
          exists = true;
          size = stat.size;
          mtime = stat.mtime.toISOString();
        } catch {
          // 文件不存在或无法访问
          exists = false;
        }
      }

      entries.push({
        relativePath,
        absolutePath,
        exists,
        size,
        mtime,
        isCredential,
        withinProjectRoot,
      });
    }

    return Object.freeze(entries);
  }

  /**
   * 获取凭据文件模式数量（用于测试断言与可观测性）
   *
   * @returns 凭据黑名单正则数量
   */
  getCredentialPatternCount(): number {
    return CREDENTIAL_PATTERN_COUNT;
  }
}

// ============================================================================
// 4. 辅助函数
// ============================================================================

/**
 * 检查路径是否在指定根目录内（路径牢笼核心算法）
 *
 * 算法：
 * 1. 把两个路径都 path.resolve 为绝对路径
 * 2. 比较目标路径是否以根路径 + 分隔符开头（或完全相等）
 *
 * @param targetPath 待检查的目标路径
 * @param rootPath 根路径
 * @returns true=在根目录内；false=越界
 */
export function isWithinPath(targetPath: string, rootPath: string): boolean {
  const normalizedTarget = path.resolve(targetPath);
  const normalizedRoot = path.resolve(rootPath);

  // 完全相等
  if (normalizedTarget === normalizedRoot) {
    return true;
  }

  // 以根路径 + 分隔符开头（确保不会出现 /foo/bar 与 /foo/barbaz 误判）
  const rootWithSep = normalizedRoot + path.sep;
  return normalizedTarget.startsWith(rootWithSep);
}

/**
 * 从 prevResults 中提取 plan 阶段产出的任务卡
 *
 * 查找规则：从 prevResults 末尾向前查找第一个 stage === "plan" 且 kind === "success" 的结果。
 *
 * @param ctx 阶段执行上下文
 * @returns 任务卡（若无则返回 null）
 */
export function extractTaskCardFromPrevResults(ctx: Readonly<P5StageContext>): TaskCard | null {
  // 从后向前查找 plan 阶段的成功结果
  for (let i = ctx.prevResults.length - 1; i >= 0; i--) {
    const result = ctx.prevResults[i]!;
    if (result.stage === "plan" && result.kind === "success") {
      const taskCard = result.artifacts["taskCard"];
      if (taskCard && typeof taskCard === "object") {
        return taskCard as TaskCard;
      }
    }
  }
  return null;
}

// ============================================================================
// 5. 工厂函数
// ============================================================================

/**
 * 工厂函数：创建默认 P5DevStageHandler 实例
 *
 * @returns P5DevStageHandler 实例
 */
export function createDevStageHandler(): P5DevStageHandler {
  return new P5DevStageHandler();
}
