/**
 * 既有契约保护判定器（Existing Contract Guard）—— EAG 方案 §6.2
 *
 * 本模块实现 EAG 方案 §6.2 棕地专属评估规则的 `ExistingContractGuard` 类。
 * 负责三类契约保护判定与技术债报告生成。
 *
 * 三类契约保护判定（§6.2）：
 * 1. **API 契约保护**：检查不破坏现有 API 契约（如修改公开方法签名）
 * 2. **文件修改纪律**：检查不改动未标注「修改」的文件
 * 3. **范式漂移检查**：检查新代码与存量范式不一致（仅记录为技术债而非打回）
 *
 * 棕地专属评估规则（§6.2）：
 * - 既有代码范式不一致时（如老系统是贫血模型），生成的新代码遵循目标范式，
 *   但**不强制重构存量**——评估器仅对当轮产出文件执行红线判定，
 *   存量违例记录为技术债报告而非打回。
 *
 * 设计依据：
 * - EAG 方案 §6.2 棕地专属评估规则
 * - EAG 方案 §6.2 增量 diff + 影响面报告
 *
 * @module eag/discovery/existing-contract-guard
 */

import type { ContractViolation, ExistingModelSnapshot, IncrementalChange, TechDebtReport } from "./types.js";

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 范式名称（字面量联合类型）
 *
 * 用于 checkParadigmDrift 的范式对比。
 * 对齐 EAG §5.1.1 范式库（与 eak/types.ts 的 ParadigmId 一致）。
 */
type ParadigmName = "ddd-layered" | "clean-architecture" | "cqrs-es" | "microservice" | "anemic" | "unknown";

// ============================================================================
// ExistingContractGuard 类
// ============================================================================

/**
 * 既有契约保护判定器
 *
 * 提供三类契约保护判定与技术债报告生成。
 *
 * 用法：
 * ```typescript
 * const guard = new ExistingContractGuard();
 *
 * // 1. API 契约保护
 * const apiViolations = guard.checkApiContract(
 *   [{ apiName: "OrderService.cancel", signature: "cancel(orderId: string): void" }],
 *   [{ apiName: "OrderService.cancel", signature: "cancel(orderId: string, reason: string): void" }]
 * );
 * // → 违反：API 签名不匹配
 *
 * // 2. 文件修改纪律
 * const fileViolations = guard.checkFileModification(
 *   [{ filePath: "src/order/OrderService.ts", changeType: "modify" }],
 *   ["src/order/OrderService.ts"]  // 仅允许修改此文件
 * );
 *
 * // 3. 范式漂移检查
 * const paradigmViolations = guard.checkParadigmDrift("ddd-layered", "anemic");
 * // → paradigm-drift 违反（仅记录为技术债，不打回）
 *
 * // 4. 技术债报告
 * const report = guard.generateTechDebtReport(snapshot, changes);
 * ```
 */
export class ExistingContractGuard {
  // ========================================================================
  // 公共 API：契约保护判定
  // ========================================================================

  /**
   * 检查 API 契约保护
   *
   * 判定规则：
   * - modifiedApis 中的每个 API 必须在 existingApiContracts 中存在（不能新增未声明的 API）
   * - 同名 API 的签名必须与既有契约一致（不能修改公开方法签名）
   * - 返回类型必须兼容（不能缩小返回类型范围）
   *
   * @param modifiedApis 修改后的 API 列表（CODING Loop 产出）
   * @param existingApiContracts 既有 API 契约列表
   * @returns 违反列表（空列表表示通过）
   */
  checkApiContract(
    modifiedApis: ReadonlyArray<{
      readonly apiName: string;
      readonly signature: string;
    }>,
    existingApiContracts: ReadonlyArray<{
      readonly apiName: string;
      readonly signature: string;
    }>
  ): ContractViolation[] {
    const violations: ContractViolation[] = [];
    // 构建既有 API 契约的索引（按 apiName）
    const existingMap = new Map<string, { apiName: string; signature: string }>();
    for (const contract of existingApiContracts) {
      existingMap.set(contract.apiName, contract);
    }
    // 检查每个修改后的 API
    for (const modified of modifiedApis) {
      const existing = existingMap.get(modified.apiName);
      if (!existing) {
        // 既有契约中不存在该 API —— 视为新增 API，不视为违反
        // （新增 API 不破坏现有契约，是允许的）
        continue;
      }
      // 比对签名
      if (modified.signature !== existing.signature) {
        violations.push({
          type: "api-contract",
          message:
            `API "${modified.apiName}" 签名不匹配：既有契约 "${existing.signature}"，` +
            `修改后 "${modified.signature}"。修改公开方法签名会破坏现有调用方。`,
          location: modified.apiName,
        });
      }
    }
    return violations;
  }

  /**
   * 检查文件修改纪律
   *
   * 判定规则（§6.2）：
   * - CODING Loop 仅对变更集生成代码
   * - 评估器除红线外增加既有契约保护判定（不改动未标注「修改」的文件）
   * - modify 类型的变更项对应的文件可修改
   * - add 类型的变更项对应的文件可新增（不影响文件修改纪律）
   * - unchanged 类型的变更项对应的文件不应修改
   *
   * @param changes 增量变更列表（含 modify/unchanged 标注）
   * @param allowedModifiedFiles 允许修改的文件路径列表（即 modify 变更项对应的文件）
   * @returns 违反列表（空列表表示通过）
   */
  checkFileModification(
    changes: ReadonlyArray<IncrementalChange>,
    allowedModifiedFiles: ReadonlyArray<string>
  ): ContractViolation[] {
    const violations: ContractViolation[] = [];
    // 构建允许修改的文件路径集合
    const allowedSet = new Set(allowedModifiedFiles);
    // 检查每个变更项
    for (const change of changes) {
      // 仅检查 modify/unchanged 类型的变更项（add 类型为新增文件，不涉及修改纪律）
      if (change.changeType === "add") {
        continue;
      }
      // change.filePath 必填（modify/unchanged 时）
      if (!change.filePath) {
        // 文件路径缺失，跳过检查（不应发生，但防御性处理）
        continue;
      }
      // modify 类型：filePath 必须在 allowedModifiedFiles 中
      if (change.changeType === "modify") {
        if (!allowedSet.has(change.filePath)) {
          violations.push({
            type: "file-modification",
            message: `文件 "${change.filePath}" 被修改，但未在允许修改的文件清单中。` + `仅 modify 标注的文件可修改。`,
            location: change.filePath,
          });
        }
      }
      // unchanged 类型：filePath 不应在 allowedModifiedFiles 中（即不应被修改）
      if (change.changeType === "unchanged") {
        if (allowedSet.has(change.filePath)) {
          violations.push({
            type: "file-modification",
            message:
              `文件 "${change.filePath}" 标注为 unchanged（不动），` +
              `但出现在允许修改的文件清单中。unchanged 文件不应被修改。`,
            location: change.filePath,
          });
        }
      }
    }
    return violations;
  }

  /**
   * 检查范式漂移
   *
   * 判定规则（§6.2 棕地专属评估规则）：
   * - 当新代码范式与存量范式不一致时，记录为 paradigm-drift 违反
   * - paradigm-drift 仅记录为技术债而非打回（不强制重构存量）
   * - 新代码遵循目标范式，存量违例记录为技术债报告
   *
   * @param newCodeParadigm 新代码范式
   * @param existingCodeParadigm 既有代码范式
   * @returns 违反列表（范式不一致时返回单条 paradigm-drift 违反；一致时返回空列表）
   */
  checkParadigmDrift(newCodeParadigm: string, existingCodeParadigm: string): ContractViolation[] {
    // 范式一致 → 无违反
    if (newCodeParadigm === existingCodeParadigm) {
      return [];
    }
    // 范式不一致 → paradigm-drift 违反（仅记录为技术债）
    return [
      {
        type: "paradigm-drift",
        message:
          `新代码范式 "${newCodeParadigm}" 与既有代码范式 "${existingCodeParadigm}" 不一致。` +
          `新代码遵循目标范式，存量违例记录为技术债（不强制重构存量）。`,
        location: `新代码: ${newCodeParadigm}; 既有代码: ${existingCodeParadigm}`,
      },
    ];
  }

  // ========================================================================
  // 公共 API：技术债报告生成
  // ========================================================================

  /**
   * 生成技术债报告
   *
   * 对应 EAG 方案 §6.2 棕地专属评估规则：
   * 「存量违例记录为技术债报告而非打回」。
   *
   * 生成逻辑：
   * 1. 收集既有模型中的违例（如既有代码使用贫血模型、缺少聚合边界等）
   * 2. 收集变更项中的 paradigm-drift 违反（由 checkParadigmDrift 产出的）
   * 3. 生成建议（如「建议在后续迭代中重构 OrderService 为充血模型」）
   *
   * @param snapshot 既有模型快照
   * @param changes 增量变更列表
   * @returns 技术债报告
   */
  generateTechDebtReport(snapshot: ExistingModelSnapshot, changes: ReadonlyArray<IncrementalChange>): TechDebtReport {
    const violations: Array<{
      rule: string;
      location: string;
      description: string;
    }> = [];

    // 检查 1：既有文件中是否存在范式违例（启发式判定）
    // 启发式规则：既有文件中包含 "Service" 后缀且无 "Aggregate" 后缀的，可能是贫血模型
    const hasServiceFile = snapshot.existingFiles.some((f) => /Service\.(ts|java|py|go)$/.test(f));
    const hasAggregateFile = snapshot.existingFiles.some((f) => /Aggregate\.(ts|java|py|go)$/.test(f));
    if (hasServiceFile && !hasAggregateFile) {
      violations.push({
        rule: "anemic-model-detection",
        location: snapshot.existingFiles.filter((f) => /Service\./.test(f)).join(", "),
        description:
          "既有代码库使用 Service 后缀但无 Aggregate 后缀，可能为贫血模型。" +
          "建议在后续迭代中重构为充血模型（DDD 范式）。",
      });
    }

    // 检查 2：变更项中是否存在 paradigm-drift 类型的违反
    for (const change of changes) {
      // 启发式：如果 changeType=modify 但 reason 提及「范式不一致」，记录为技术债
      if (change.changeType === "modify" && change.reason.includes("范式")) {
        violations.push({
          rule: "paradigm-drift-in-modify",
          location: change.filePath ?? change.name,
          description: `变更项 "${change.name}" 的修改理由提及范式不一致：${change.reason}`,
        });
      }
    }

    // 检查 3：既有模型中是否缺少值对象（可能存在原始类型偏执 anti-pattern）
    if (snapshot.valueObjects.length === 0 && snapshot.aggregates.length > 0) {
      violations.push({
        rule: "primitive-obsession",
        location: "valueObjects（空）",
        description:
          "既有模型有聚合但无值对象，可能存在原始类型偏执（Primitive Obsession）。" +
          "建议在后续迭代中提取值对象（如 Money、OrderId 等）。",
      });
    }

    // 生成建议
    const recommendation = this.generateRecommendation(violations);

    return Object.freeze({
      violations: Object.freeze(violations),
      recommendation,
    });
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /**
   * 根据违例列表生成建议
   *
   * @param violations 违例列表
   * @returns 建议文本
   */
  private generateRecommendation(
    violations: ReadonlyArray<{
      rule: string;
      location: string;
      description: string;
    }>
  ): string {
    if (violations.length === 0) {
      return "未检测到技术债，既有代码库与目标范式一致。";
    }
    const ruleNames = violations.map((v) => v.rule).join("、");
    return `检测到 ${violations.length} 项技术债（${ruleNames}）。` + `建议在后续迭代中逐步重构存量代码，本轮不打回。`;
  }
}

// ============================================================================
// 模块导出
// ============================================================================

export type { ParadigmName };
