/**
 * RollbackPlanChecker —— 回滚预案检查器（EAG-P4 批次 14 Phase 4 TASK-14-4-2，FR-13，K-1 决策）
 *
 * 核心职责：
 * - 校验回滚预案文件存在性 + 5 个必需章节齐全（K-1 决策）
 * - 校验 2 项：
 *   1. 回滚预案文件存在于指定路径（<projectRoot>/deploy/rollback-plan-<runId>.md，fs.readFile 真实读取）
 *   2. 文件内容含 5 个必需章节（正则解析 ## 目标版本号 / ## 回滚命令 / ## 资源清单 / ## 创建时间戳 / ## runId）
 *
 * 真实调用（对齐 NFR-3 测试不使用 mock）：
 * - fs.existsSync / fs.readFileSync：真实读取文件系统
 * - 正则表达式解析 Markdown 章节：不依赖外部 markdown parser，零新增依赖
 *
 * 不可变优先（§5.12.4 G-A6d）：
 * - check() 返回的 RollbackPlanCheckResult 对象通过 Object.freeze 深冻结
 * - failures 数组通过 Object.freeze 冻结
 * - RollbackPlanCheckerImpl 实例本身通过 Object.freeze 冻结
 *
 * 错误处理（不抛异常，错误内化）：
 * - 文件不存在时返回 exists=false + valid=false + failures=["文件不存在：<path>"]
 * - 文件存在但章节缺失时返回 exists=true + valid=false + failures 含缺失章节列表
 * - 文件读取失败时返回 exists=true + valid=false + failures=["文件读取失败：<error>"]
 *
 * 文件路径约定（K-1 决策，与 rollback-manager.ts 中 generateRollbackPlan 对齐）：
 * - 文件路径：<projectRoot>/deploy/rollback-plan-<runId>.md
 * - 文件格式：Markdown（5 个固定章节，与 ROLLBACK_PLAN_SECTIONS 对齐）
 * - 文件 schema：
 *   # 回滚预案
 *
 *   ## 目标版本号
 *   <version>
 *
 *   ## 回滚命令
 *   ```bash
 *   kubectl rollout undo deployment/<name> -n <ns> --to-revision=<N>
 *   ```
 *
 *   ## 资源清单
 *   - deployment/<name>
 *   - service/<name>
 *
 *   ## 创建时间戳
 *   <ISO 8601>
 *
 *   ## runId
 *   <runId>
 *
 * 禁用模式说明（向后兼容）：
 * - RollbackPlanCheckerImpl 自身不处理禁用模式
 * - 禁用模式由 Phase 5 的 GateG8CheckerImpl 处理（context.rollbackPlanExists=true 时跳过真实校验）
 *
 * M-14-2 修复说明（路径优先级）：
 * - RollbackPlanCheckerImpl 自身不处理路径优先级（snapshot.rollbackPlanFilePath vs DevOpsContext）
 * - 路径优先级由 Phase 5 的 GateG8CheckerImpl 处理（注入 context.projectRoot + context.runId 给 RollbackPlanChecker）
 *
 * 设计依据：
 * - EAG-P4 批次 14 任务清单 TASK-14-4-2 验收标准
 * - types.ts 中 RollbackPlanChecker / RollbackPlanCheckContext / RollbackPlanCheckResult 接口定义
 * - 架构师审查 §4.3.2 FR-13 回滚预案检查器
 * - K-1 决策：回滚预案 5 个固定章节
 * - ROLLBACK_PLAN_SECTIONS 常量（types.ts）
 *
 * 文件位置：packages/core/src/eag/devops/rollback-plan-checker.ts
 *
 * @module eag/devops/rollback-plan-checker
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { RollbackPlanChecker, RollbackPlanCheckContext, RollbackPlanCheckResult } from "./types";
import { ROLLBACK_PLAN_SECTIONS } from "./types";

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 回滚预案文件存放目录名（与 rollback-manager.ts 中 generateRollbackPlan 对齐）
 *
 * 取值理由：
 * - 与 K8sRollbackManager / HelmRollbackManager 中 generateRollbackPlan 方法生成的路径保持一致
 * - 文件路径：<projectRoot>/deploy/rollback-plan-<runId>.md
 */
const ROLLBACK_PLAN_DIR = "deploy";

/**
 * 回滚预案文件名前缀（与 rollback-manager.ts 中 generateRollbackPlan 对齐）
 *
 * 取值理由：
 * - 与 K8sRollbackManager / HelmRollbackManager 中 generateRollbackPlan 方法生成的文件名保持一致
 * - 文件名：rollback-plan-<runId>.md
 */
const ROLLBACK_PLAN_FILE_PREFIX = "rollback-plan-";

/**
 * 回滚预案文件扩展名（Markdown 格式）
 *
 * 取值理由：
 * - 与 K8sRollbackManager / HelmRollbackManager 中 generateRollbackPlan 方法生成的扩展名保持一致
 * - 文件格式：Markdown（含 5 个固定章节，与 ROLLBACK_PLAN_SECTIONS 对齐）
 */
const ROLLBACK_PLAN_FILE_EXT = ".md";

// ============================================================================
// RollbackPlanCheckerImpl 类
// ============================================================================

/**
 * RollbackPlanChecker 实现类（FR-13，K-1 决策）
 *
 * 校验 2 项回滚预案就绪条件：
 * 1. 文件存在（exists）：
 *    - 文件路径：<projectRoot>/deploy/rollback-plan-<runId>.md
 *    - 通过 fs.existsSync 真实校验文件存在性
 *    - 文件不存在时返回 exists=false（不抛错）
 *
 * 2. 章节齐全（valid）：
 *    - 通过 fs.readFileSync 读取文件内容
 *    - 正则解析 5 个必需章节（ROLLBACK_PLAN_SECTIONS）：
 *      ## 目标版本号 / ## 回滚命令 / ## 资源清单 / ## 创建时间戳 / ## runId
 *    - 任一章节缺失时返回 valid=false + failures 含缺失章节名
 *
 * 真实调用（对齐 NFR-3 测试不使用 mock）：
 * - fs.existsSync / fs.readFileSync：真实读取文件系统
 * - 正则表达式：不依赖外部 markdown parser，零新增依赖
 *
 * 不可变优先：
 * - check() 返回的 RollbackPlanCheckResult 对象通过 Object.freeze 深冻结
 * - failures 数组通过 Object.freeze 冻结
 * - RollbackPlanCheckerImpl 实例本身通过 Object.freeze 冻结
 *
 * 使用方式：
 *   const checker = new RollbackPlanCheckerImpl();
 *   const result = await checker.check({
 *     projectRoot: "/path/to/project",
 *     runId: "run-001",
 *   });
 *   if (!result.exists) {
 *     // 回滚预案文件不存在，提示用户先生成
 *   } else if (!result.valid) {
 *     // 回滚预案文件存在但章节缺失，提示用户补全
 *     console.error(result.failures);
 *   }
 */
export class RollbackPlanCheckerImpl implements RollbackPlanChecker {
  /**
   * 构造函数
   *
   * RollbackPlanCheckerImpl 无需配置参数，构造函数无参
   *
   * 不可变优先：实例本身冻结，防止运行时篡改内部状态
   */
  constructor() {
    // 不可变优先：实例本身冻结
    Object.freeze(this);
  }

  /**
   * 执行回滚预案检查
   *
   * 检查顺序（短路求值，文件不存在时跳过章节校验）：
   * 1. 拼接文件路径：<projectRoot>/deploy/rollback-plan-<runId>.md
   * 2. 校验文件存在性（fs.existsSync）
   * 3. 若文件不存在：返回 exists=false + valid=false
   * 4. 若文件存在：读取文件内容 + 正则解析 5 个章节
   * 5. 任一章节缺失：返回 valid=false + failures 含缺失章节名
   * 6. 全部章节齐全：返回 valid=true
   *
   * 短路求值理由：
   * - 文件不存在时无法读取内容，章节校验必然失败，无意义执行
   * - 文件存在时一次性收集全部缺失章节，便于用户批量修复
   *
   * @param context 检查上下文（含 projectRoot + runId）
   * @returns RollbackPlanCheckResult，含 exists / valid / filePath / failures
   */
  public async check(context: RollbackPlanCheckContext): Promise<RollbackPlanCheckResult> {
    // ---------- 步骤 1: 拼接文件路径 ----------
    const filePath = this.buildFilePath(context.projectRoot, context.runId);

    // ---------- 步骤 2: 校验文件存在性 ----------
    if (!fs.existsSync(filePath)) {
      // 文件不存在：返回 exists=false + valid=false（不抛错）
      return Object.freeze({
        exists: false,
        valid: false,
        filePath,
        failures: Object.freeze([`回滚预案文件不存在：${filePath}`]) as ReadonlyArray<string>,
      }) as RollbackPlanCheckResult;
    }

    // ---------- 步骤 3: 读取文件内容 ----------
    let fileContent: string;
    try {
      fileContent = fs.readFileSync(filePath, { encoding: "utf8" });
    } catch (err) {
      // 文件读取失败：返回 exists=true + valid=false（文件存在但无法读取）
      return Object.freeze({
        exists: true,
        valid: false,
        filePath,
        failures: Object.freeze([`回滚预案文件读取失败：${(err as Error).message}`]) as ReadonlyArray<string>,
      }) as RollbackPlanCheckResult;
    }

    // ---------- 步骤 4: 正则解析 5 个必需章节 ----------
    const failures: string[] = [];
    for (const section of ROLLBACK_PLAN_SECTIONS) {
      // 构造正则：匹配 Markdown 二级标题 ## <section>
      // 正则说明：
      // - ^## 匹配行首的 ## 二级标题前缀
      // - \s+ 匹配 1 个或多个空白字符（标题与文字之间）
      // - 转义 section 中的正则特殊字符（如 runId 不含特殊字符，但保持通用性）
      const escapedSection = escapeRegExp(section);
      const sectionRegex = new RegExp(`^##\\s+${escapedSection}\\s*$`, "m");

      if (!sectionRegex.test(fileContent)) {
        // 章节缺失：加入 failures 列表
        failures.push(`章节缺失：## ${section}`);
      }
    }

    // ---------- 步骤 5: 汇总结果 ----------
    if (failures.length > 0) {
      // 存在缺失章节：返回 valid=false
      return Object.freeze({
        exists: true,
        valid: false,
        filePath,
        failures: Object.freeze(failures) as ReadonlyArray<string>,
      }) as RollbackPlanCheckResult;
    }

    // ---------- 步骤 6: 全部章节齐全 ----------
    return Object.freeze({
      exists: true,
      valid: true,
      filePath,
      failures: Object.freeze([]) as ReadonlyArray<string>,
    }) as RollbackPlanCheckResult;
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  /**
   * 拼接回滚预案文件路径
   *
   * 文件路径约定（K-1 决策，与 rollback-manager.ts 中 generateRollbackPlan 对齐）：
   * - 文件路径：<projectRoot>/deploy/rollback-plan-<runId>.md
   * - 目录名：deploy（ROLLBACK_PLAN_DIR 常量）
   * - 文件名：rollback-plan-<runId>.md（ROLLBACK_PLAN_FILE_PREFIX + runId + ROLLBACK_PLAN_FILE_EXT）
   *
   * 路径拼接使用 path.join 确保跨平台兼容（macOS / Linux / Windows）
   *
   * @param projectRoot 项目根目录
   * @param runId 运行 ID（用于拼接文件名）
   * @returns 完整的回滚预案文件路径
   */
  private buildFilePath(projectRoot: string, runId: string): string {
    // 拼接目录路径：<projectRoot>/deploy
    const deployDir = path.join(projectRoot, ROLLBACK_PLAN_DIR);
    // 拼接文件名：rollback-plan-<runId>.md
    const fileName = `${ROLLBACK_PLAN_FILE_PREFIX}${runId}${ROLLBACK_PLAN_FILE_EXT}`;
    // 返回完整路径：<projectRoot>/deploy/rollback-plan-<runId>.md
    return path.join(deployDir, fileName);
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 转义字符串中的正则特殊字符
 *
 * 用于将章节名安全地嵌入正则表达式，避免章节名中的特殊字符（如 . / * / ?）被解释为正则元字符
 *
 * 转义的特殊字符：. * + ? ^ $ { } ( ) | [ ] / \ -
 *
 * @param str 原始字符串
 * @returns 转义后的字符串（可安全嵌入正则）
 */
function escapeRegExp(str: string): string {
  // 使用 replace + 正则替换所有特殊字符为转义形式
  // 正则说明：[.*+?^${}()|[\]\\-] 匹配任意一个特殊字符，替换为 \ + 原字符
  return str.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}
