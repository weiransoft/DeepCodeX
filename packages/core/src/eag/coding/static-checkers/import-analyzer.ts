/**
 * 依赖方向判定器（ImportAnalyzer）—— EAG-P2 批次 9 S2
 *
 * 负责红线：
 * - E4：依赖方向（domain 不得 import infrastructure/interfaces/application）
 * - TCS-OSS-01：业务代码直连具体厂商 SDK（aws-sdk / ali-oss / minio）
 *
 * 判定算法：
 * 1. E4：扫描每个文件的 import 语句，按文件路径判定所属层级（domain/infrastructure/...），
 *    若 domain 层文件 import infrastructure/interfaces/application 层模块 → 违规
 * 2. TCS-OSS-01：扫描所有业务代码（非 tcs/object-storage 适配器文件）的 import 语句，
 *    若 import aws-sdk / @aws-sdk/* / ali-oss / minio / @google-cloud/storage 等厂商 SDK → 违规
 *
 * 设计依据：
 * - EAG 方案 §5.1.3 企业红线清单 E4
 * - EAG 方案 §5.8.1 对象存储规范 TCS-OSS-01
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单
 *
 * @module eag/coding/static-checkers/import-analyzer
 */

import type { StaticChecker } from "../types";
import type { RedlineDefinition, RedlineResult } from "../../evaluator/types";
import { scanImports, buildViolations, buildPass, extractFilePathFromComment } from "./checker-utils";

/**
 * 禁止业务代码直接 import 的对象存储厂商 SDK 清单（TCS-OSS-01）
 *
 * 来源：§5.8.1 对象存储规范——业务代码应仅依赖 ObjectStoragePort 抽象接口，
 * 由适配器层（S3Adapter / OssAdapter / MinioAdapter）封装具体厂商 SDK。
 */
const FORBIDDEN_OSS_SDKS: ReadonlyArray<string> = Object.freeze([
  "aws-sdk",
  "@aws-sdk/client-s3",
  "@aws-sdk/lib-storage",
  "@aws-sdk/s3-request",
  "ali-oss",
  "minio",
  "@google-cloud/storage",
  "@azure/storage-blob",
  "cos-nodejs-sdk-v5",
  "@upstash/redis",
  "@alibabacloud/oss",
]);

/**
 * DDD 分层目录与禁用依赖规则（E4）
 *
 * 规则：domain 层不得 import 以下层的模块：
 * - infrastructure（基础设施层）
 * - interfaces（接口层）
 * - application（应用层）
 *
 * 假设文件路径包含 "/domain/" 即视为 domain 层文件。
 */
const DOMAIN_LAYER_FORBIDDEN_PREFIXES: ReadonlyArray<string> = Object.freeze([
  "infrastructure",
  "interfaces",
  "application",
  "adapter",
  "controller",
  "repository-impl",
]);

/**
 * 判定文件路径是否属于 domain 层
 *
 * 启发式规则：路径包含 "/domain/" 或 "domain/" 开头视为 domain 层。
 *
 * @param filePath 文件路径
 * @returns true 表示 domain 层文件
 */
function isDomainLayerFile(filePath: string): boolean {
  return /(^|\/)domain\//.test(filePath);
}

/**
 * 判定 import 来源是否属于禁用层
 *
 * 检查 import source 路径中是否包含 infrastructure/interfaces/application 等关键字。
 *
 * @param source import 模块来源路径
 * @returns true 表示属于禁用层
 */
function isForbiddenLayerImport(source: string): boolean {
  // 相对路径形式：../infrastructure/xxx 或 ./infrastructure/xxx
  for (const prefix of DOMAIN_LAYER_FORBIDDEN_PREFIXES) {
    if (source.includes(`/${prefix}/`) || source.includes(`/${prefix}.`)) {
      return true;
    }
  }
  return false;
}

/**
 * 判定文件路径是否为对象存储适配器文件（TCS-OSS-01 豁免）
 *
 * 适配器文件允许 import 厂商 SDK，业务代码不允许。
 * 启发式：路径包含 tcs/object-storage 或 adapters/oss/s3/minio
 *
 * @param filePath 文件路径
 * @returns true 表示适配器文件（豁免）
 */
function isObjectStorageAdapterFile(filePath: string): boolean {
  return (
    /tcs\/object-storage/.test(filePath) ||
    /adapters\/(oss|s3|minio|azure|gcs|cos)/.test(filePath) ||
    /\/(s3|oss|minio)-adapter\./.test(filePath)
  );
}

/**
 * 依赖方向判定器
 *
 * 实现 StaticChecker 协议，负责 E4 与 TCS-OSS-01 两条红线的静态判定。
 */
export class ImportAnalyzer implements StaticChecker {
  /** 该 Checker 负责的红线 ID 列表 */
  readonly redlineIds: ReadonlyArray<string> = Object.freeze(["E4", "TCS-OSS-01"]);

  /**
   * 执行静态判定
   *
   * 算法：
   * 1. 根据 redline.id 路由到对应判定逻辑
   *    - E4：domain 层文件不得 import infrastructure/interfaces/application 层
   *    - TCS-OSS-01：业务代码不得 import 对象存储厂商 SDK
   * 2. 遍历所有 artifacts，扫描 import 语句
   * 3. 收集违规点，构建 RedlineResult
   *
   * @param artifacts 产出物列表（路径 + 内容）
   * @param redline 当前红线定义
   * @returns 判定结果
   */
  check(
    artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>,
    redline: Readonly<RedlineDefinition>
  ): RedlineResult {
    if (redline.id === "E4") {
      return this.checkE4(artifacts);
    }
    if (redline.id === "TCS-OSS-01") {
      return this.checkTcsOss01(artifacts);
    }
    // 非负责红线，返回 unknown（不应被调用）
    return buildPass(redline.id);
  }

  /**
   * E4 判定：domain 层不得 import 外层
   *
   * @param artifacts 产出物列表
   * @returns 判定结果
   */
  private checkE4(artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>): RedlineResult {
    const violations: Array<{
      readonly filePath: string;
      readonly line: number;
      readonly description: string;
      readonly fixSuggestion: string;
    }> = [];

    for (const artifact of artifacts) {
      // 优先使用第一行 // 注释中的路径标记（fixture 风格），否则使用 artifact.path
      const filePath = extractFilePathFromComment(artifact.content) || artifact.path;
      if (!isDomainLayerFile(filePath)) {
        continue;
      }
      const imports = scanImports(artifact.content);
      for (const imp of imports) {
        if (isForbiddenLayerImport(imp.source)) {
          violations.push({
            filePath,
            line: imp.line,
            description: `domain 层文件 import 外层模块 "${imp.source}"——违反 E4 红线：内层不得依赖外层（依赖反转原则）`,
            fixSuggestion:
              `在 domain 层定义 Repository Port 接口，由 infrastructure 层实现该接口；` +
              `application 层通过依赖注入组装接口与实现`,
          });
        }
      }
    }

    return buildViolations("E4", violations);
  }

  /**
   * TCS-OSS-01 判定：业务代码禁止直连对象存储厂商 SDK
   *
   * @param artifacts 产出物列表
   * @returns 判定结果
   */
  private checkTcsOss01(artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>): RedlineResult {
    const violations: Array<{
      readonly filePath: string;
      readonly line: number;
      readonly description: string;
      readonly fixSuggestion: string;
    }> = [];

    for (const artifact of artifacts) {
      const filePath = extractFilePathFromComment(artifact.content) || artifact.path;
      // 适配器文件豁免
      if (isObjectStorageAdapterFile(filePath)) {
        continue;
      }
      const imports = scanImports(artifact.content);
      for (const imp of imports) {
        // 精确匹配或前缀匹配（@aws-sdk/client-s3 形式）
        const isForbidden = FORBIDDEN_OSS_SDKS.some((sdk) => imp.source === sdk || imp.source.startsWith(sdk + "/"));
        if (isForbidden) {
          violations.push({
            filePath,
            line: imp.line,
            description:
              `业务代码直接 import 对象存储厂商 SDK "${imp.source}"——违反 TCS-OSS-01 红线，` +
              `业务代码应仅依赖 ObjectStoragePort 抽象接口，由适配器层封装具体厂商 SDK`,
            fixSuggestion:
              `1. 删除业务代码中的 "${imp.source}" import 语句\n` +
              `2. 改为依赖注入 ObjectStoragePort 接口（构造函数注入）\n` +
              `3. 在 IoC 容器中注册适配器（如 createObjectStorage('s3', config)）\n` +
              `4. 业务代码调用 port.put() / port.get() / port.signedUrl() 等抽象方法`,
          });
        }
      }
    }

    return buildViolations("TCS-OSS-01", violations);
  }
}
