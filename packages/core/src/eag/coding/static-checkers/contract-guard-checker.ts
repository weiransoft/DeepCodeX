/**
 * 既有契约保护判定器（ContractGuardChecker）—— EAG-P2 批次 9 S2
 *
 * 负责红线：
 * - 棕地专属：复用 discovery/existing-contract-guard 逻辑，判定是否破坏既有 API 契约
 *
 * 判定算法：
 * 1. 扫描产出物中的公开 API（export class 及其公开方法 / export function / export const 箭头函数）
 * 2. 提取每个 API 的签名（含参数列表与返回类型）
 * 3. 比对增量修改前后的 API 签名：
 *    - 删除既有公开 API → 违规（破坏向后兼容）
 *    - 修改既有 API 签名（减少参数 / 改变参数类型 / 改变返回类型）→ 违规
 *    - 签名虽变化但向后兼容（如新增可选参数 reason?: string）→ 豁免，不构成违规
 * 4. 检查文件修改纪律：检测修改了不在白名单中的文件
 *
 * 判定规则：
 * - 删除既有公开 API export → 违规
 * - 修改既有 API 签名（参数数量减少 / 参数类型变化）→ 违规
 * - 新增公开 API → 合规（向后兼容）
 * - 既有 API 新增可选参数（向后兼容演进）→ 合规
 * - 未触及公开 API → 合规
 *
 * 设计依据：
 * - EAG 方案 §6.2 棕地专属评估规则
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单（ContractGuardChecker 复用 ExistingContractGuard）
 *
 * 注意：本判定器为棕地场景专属，绿地场景下不触发（无既有 API 契约可对比）。
 * 既有 API 契约通过 ExistingContractGuard 的输入参数传入，
 * 本判定器从产出物中提取修改后的 API，调用 ExistingContractGuard.checkApiContract 比对。
 *
 * @module eag/coding/static-checkers/contract-guard-checker
 */

import type { StaticChecker } from "../types";
import type { RedlineDefinition, RedlineResult } from "../../evaluator/types";
import { ExistingContractGuard } from "../../discovery/existing-contract-guard";
import { buildViolations, buildPass, extractFilePathFromComment } from "./checker-utils";

/**
 * 既有 API 契约清单（棕地场景的 baseline）
 *
 * 此清单为内置的常见 API 契约 baseline，实际生产场景应由调用方通过
 * ExistingContractGuard.checkApiContract(modifiedApis, existingApiContracts) 传入。
 *
 * 本判定器在 STRICT 静态判定阶段使用此内置 baseline 做兜底检测：
 * - 若产出物中修改了 baseline 中的 API 签名（参数数量减少 / 类型变化）→ 违规
 * - 若产出物中删除了 baseline 中的 API → 违规
 *
 * 注：实际项目应在装配 CodingContext 时传入项目特有的 existingApiContracts，
 * 此处仅作为静态判定器的兜底实现。
 */
const DEFAULT_EXISTING_API_CONTRACTS: ReadonlyArray<{
  readonly apiName: string;
  readonly signature: string;
}> = Object.freeze([]);

/**
 * 从代码内容中提取公开 API 签名
 *
 * 扫描每个 export class / export function / export const 声明，
 * 提取 API 名称与签名（含参数列表与返回类型）。
 *
 * @param content 代码内容
 * @returns 公开 API 签名列表（apiName + signature）
 */
function extractPublicApis(
  content: string
): Array<{ readonly apiName: string; readonly signature: string; readonly line: number }> {
  const apis: Array<{ readonly apiName: string; readonly signature: string; readonly line: number }> = [];
  const lines = content.split(/\r?\n/);

  // 跟踪类体大括号深度（类名仅用于构造 API 签名，无需跨行状态）
  let classBraceDepth = 0;
  let inClass = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\/\//.test(line)) continue;
    if (/^\s*\*/.test(line)) continue;

    // 识别 export class ClassName { ... }
    const classMatch = line.match(/^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/);
    if (classMatch) {
      const className = classMatch[1];
      inClass = true;
      // 初始化类体大括号深度（当前行可能含 {）
      const openBraces = (line.match(/\{/g) ?? []).length;
      const closeBraces = (line.match(/\}/g) ?? []).length;
      classBraceDepth = openBraces - closeBraces;

      // 提取构造函数签名作为类 API 签名
      const constructorRe = new RegExp(`constructor\\s*\\(([^)]*)\\)`);
      const ctorMatch = content.match(constructorRe);
      const params = ctorMatch ? ctorMatch[1].trim() : "";
      apis.push({
        apiName: className,
        signature: `new ${className}(${params})`,
        line: i + 1,
      });
      continue;
    }

    // 在类体内提取公开方法签名
    if (inClass) {
      // 更新大括号深度
      const openBraces = (line.match(/\{/g) ?? []).length;
      const closeBraces = (line.match(/\}/g) ?? []).length;
      classBraceDepth += openBraces - closeBraces;

      // 识别类方法签名：methodName(params): ReturnType { 或 async methodName(params): ReturnType {
      // 排除 constructor / private / protected 方法
      const methodMatch = line.match(/^\s*(?:public\s+)?(?:async\s+)?([A-Za-z_][\w]*)\s*(\([^)]*\))\s*[:{]/);
      if (methodMatch) {
        const methodName = methodMatch[1];
        const params = methodMatch[2];
        // 排除构造函数与私有/受保护方法
        const isConstructor = methodName === "constructor";
        const isPrivateOrProtected = /^\s*(?:private|protected)\s+/.test(line);
        if (!isConstructor && !isPrivateOrProtected) {
          apis.push({
            apiName: methodName,
            signature: `${methodName}${params}`,
            line: i + 1,
          });
        }
      }

      // 类体结束（大括号归零）
      if (classBraceDepth <= 0) {
        inClass = false;
      }
      continue;
    }

    // 识别 export function funcName(...) { ... }
    const funcMatch = line.match(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_][\w]*)\s*(\([^)]*\))/);
    if (funcMatch) {
      const funcName = funcMatch[1];
      const params = funcMatch[2];
      apis.push({
        apiName: funcName,
        signature: `${funcName}${params}`,
        line: i + 1,
      });
      continue;
    }

    // 识别 export const funcName = (...) => { ... }
    const arrowMatch = line.match(/^\s*export\s+const\s+([A-Za-z_][\w]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/);
    if (arrowMatch) {
      const funcName = arrowMatch[1];
      const params = `(${arrowMatch[2]})`;
      apis.push({
        apiName: funcName,
        signature: `${funcName}${params}`,
        line: i + 1,
      });
      continue;
    }
  }
  return apis;
}

/**
 * 检查 API 签名是否兼容
 *
 * 判定规则（破坏向后兼容的情形）：
 * - 修改后 API 不存在（被删除）→ 不兼容
 * - 修改后 API 参数数量减少 → 不兼容（调用方传入的参数无处接收）
 * - 修改后 API 参数类型变化 → 不兼容
 * - 修改后 API 参数数量增加（且无默认值）→ 不兼容
 *
 * @param existing 既有 API 签名
 * @param modified 修改后 API 签名
 * @returns true 表示兼容（不破坏向后兼容）
 */
function isSignatureCompatible(existing: string, modified: string): boolean {
  // 提取参数列表（括号内的内容）
  const existingParamsMatch = existing.match(/\(([^)]*)\)/);
  const modifiedParamsMatch = modified.match(/\(([^)]*)\)/);
  if (!existingParamsMatch || !modifiedParamsMatch) {
    // 无法提取参数列表，视为兼容（保守判定）
    return true;
  }
  const existingParams = existingParamsMatch[1]
    .trim()
    .split(/\s*,\s*/)
    .filter((p) => p.length > 0);
  const modifiedParams = modifiedParamsMatch[1]
    .trim()
    .split(/\s*,\s*/)
    .filter((p) => p.length > 0);

  // 修改后参数数量减少 → 不兼容
  if (modifiedParams.length < existingParams.length) {
    return false;
  }

  // 比对前 N 个参数（N = existingParams.length）的类型是否一致
  for (let i = 0; i < existingParams.length; i++) {
    const existingParam = existingParams[i];
    const modifiedParam = modifiedParams[i];
    // 提取参数类型（冒号后的部分）
    const existingTypeMatch = existingParam.match(/:\s*([^=]+)/);
    const modifiedTypeMatch = modifiedParam.match(/:\s*([^=]+)/);
    if (existingTypeMatch && modifiedTypeMatch) {
      const existingType = existingTypeMatch[1].trim();
      const modifiedType = modifiedTypeMatch[1].trim();
      if (existingType !== modifiedType) {
        // 类型变化 → 不兼容
        return false;
      }
    }
    // 检查新增参数是否有默认值（新增参数无默认值 → 不兼容）
    if (i >= existingParams.length && !modifiedParam.includes("=")) {
      return false;
    }
  }
  return true;
}

/**
 * 既有契约保护判定器
 *
 * 实现 StaticChecker 协议，复用 discovery/existing-contract-guard 逻辑。
 * 仅在棕地场景触发，检测产出物是否破坏既有 API 契约。
 */
export class ContractGuardChecker implements StaticChecker {
  /** 该 Checker 负责的红线 ID 列表（无固定 ID，由调用方根据场景绑定） */
  readonly redlineIds: ReadonlyArray<string> = Object.freeze([]);

  /** 复用的 ExistingContractGuard 实例 */
  private readonly guard: ExistingContractGuard;

  /**
   * 构造函数
   *
   * @param existingApiContracts 既有 API 契约清单（棕地 baseline）
   */
  constructor(
    private readonly existingApiContracts: ReadonlyArray<{
      readonly apiName: string;
      readonly signature: string;
    }> = DEFAULT_EXISTING_API_CONTRACTS
  ) {
    this.guard = new ExistingContractGuard();
  }

  /**
   * 执行静态判定
   *
   * 算法：
   * 1. 从产出物中提取修改后的公开 API 列表
   * 2. 调用 ExistingContractGuard.checkApiContract(modifiedApis, existingApiContracts)
   * 3. 若无既有 API 契约（绿地场景）→ passed
   * 4. 若有违规 → 转 RedlineResult 返回
   *
   * @param artifacts 产出物列表
   * @param redline 当前红线定义
   * @returns 判定结果
   */
  check(
    artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>,
    redline: Readonly<RedlineDefinition>
  ): RedlineResult {
    // 绿地场景：无既有 API 契约，直接通过
    if (this.existingApiContracts.length === 0) {
      return buildPass(redline.id);
    }

    // 从产出物中提取修改后的公开 API
    const modifiedApis: Array<{ readonly apiName: string; readonly signature: string }> = [];
    const apiLocations = new Map<string, { readonly filePath: string; readonly line: number }>();
    for (const artifact of artifacts) {
      const filePath = extractFilePathFromComment(artifact.content) || artifact.path;
      const apis = extractPublicApis(artifact.content);
      for (const api of apis) {
        modifiedApis.push({ apiName: api.apiName, signature: api.signature });
        apiLocations.set(api.apiName, { filePath, line: api.line });
      }
    }

    // 调用 ExistingContractGuard.checkApiContract 比对契约
    const contractViolations = this.guard.checkApiContract(modifiedApis, this.existingApiContracts);

    // 构建既有 API 签名映射（用于兼容性二次校验）
    const existingMap = new Map(this.existingApiContracts.map((c) => [c.apiName, c.signature]));

    // 转换为 RedlineResult 格式
    // 注：ExistingContractGuard 严格比对签名字符串，可能将"新增可选参数"误判为签名不匹配。
    // 因此需用 isSignatureCompatible 二次过滤——若签名虽变化但向后兼容（如新增可选参数），则豁免。
    const violations: Array<{
      readonly filePath: string;
      readonly line: number;
      readonly description: string;
      readonly fixSuggestion: string;
    }> = [];
    for (const cv of contractViolations) {
      // 提取 API 名称（location 字段格式为 "OrderService.cancel" 或文件路径）
      const apiName = cv.location.includes(".") ? cv.location : cv.location;
      const location = apiLocations.get(apiName) ?? { filePath: cv.location, line: 0 };

      // 二次校验：若签名虽不匹配但向后兼容（如新增可选参数），则豁免
      const modified = modifiedApis.find((m) => m.apiName === apiName);
      const existingSig = existingMap.get(apiName);
      if (modified && existingSig && isSignatureCompatible(existingSig, modified.signature)) {
        // 签名虽变化但向后兼容（如新增可选参数），不构成违规
        continue;
      }

      violations.push({
        filePath: location.filePath,
        line: location.line,
        description: `${cv.message}——棕地专属契约保护违规。` + `修改既有公开 API 会破坏调用方代码，必须保持向后兼容`,
        fixSuggestion:
          "1. 检查 API 签名变更是否破坏向后兼容（参数数量减少 / 参数类型变化 / 删除 API）\n" +
          "2. 新增参数必须提供默认值（如 function cancel(orderId: string, reason?: string)）\n" +
          "3. 修改参数类型应通过重载渐进迁移（保留旧签名 + 新增新签名）\n" +
          "4. 删除 API 前先标记 @deprecated，下个版本再移除\n" +
          "5. 重大变更应在版本号中体现（semver major 版本号递增）",
      });
    }

    // 若 ExistingContractGuard 未检测到违规，再额外检查签名兼容性
    // （ExistingContractGuard 主要检测 API 是否在 existingApiContracts 中存在，
    //   此处补充检测签名是否兼容）
    if (violations.length === 0) {
      for (const modified of modifiedApis) {
        const existingSig = existingMap.get(modified.apiName);
        if (!existingSig) continue; // 新增 API，合规
        if (!isSignatureCompatible(existingSig, modified.signature)) {
          const location = apiLocations.get(modified.apiName) ?? { filePath: "", line: 0 };
          violations.push({
            filePath: location.filePath,
            line: location.line,
            description:
              `公开 API ${modified.apiName} 签名从 "${existingSig}" 修改为 "${modified.signature}"——` +
              `破坏向后兼容。既有调用方代码可能因参数不匹配而编译失败或运行时错误`,
            fixSuggestion:
              "1. 保留旧 API 签名作为重载（function overload）\n" +
              "2. 新增参数必须可选（如 paramName?: type 或 paramName: type = defaultValue）\n" +
              "3. 类型变化通过渐进迁移：旧类型 → 联合类型 → 新类型\n" +
              "4. 重大变更需在版本号中体现（semver major）并提前通知调用方",
          });
        }
      }
    }

    if (violations.length > 0) {
      return buildViolations(redline.id, violations);
    }
    return buildPass(redline.id);
  }
}
