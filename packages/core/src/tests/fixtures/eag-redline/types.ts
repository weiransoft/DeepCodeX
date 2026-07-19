/**
 * redline-fixtures 样例库类型定义（EAG-P2 批次 9 测试基础设施）
 *
 * 本模块定义 redline-fixtures 样例库的核心类型：
 * - FixtureKind：样例类型（violation / compliant）
 * - ExpectVerdict：预期判定结果（violated / passed）
 * - FixtureManifestEntry：单个样例的 manifest 元数据
 * - CheckerManifestEntry：按 Checker 分组的 manifest 元数据
 * - FixtureManifest：完整 manifest 结构（含 13 个 Checker + 38 个样例）
 * - LoadedFixture：加载后的样例（manifest 元数据 + 代码 artifacts 合并）
 *
 * 设计依据：
 * - EAG-P2 批次 9 redline-fixtures 设计 §1.4 types.ts 类型定义
 * - StaticChecker 协议（eag/coding/types.ts StaticChecker）
 * - 不可变优先原则：全部字段 readonly，数组使用 ReadonlyArray
 *
 * 关键约束：
 * - 与 manifest.json 结构 1:1 对齐（通过 FIXTURE_MANIFEST 类型断言）
 * - 提供 13 个 Checker × violation/compliant 成对样例的类型支撑
 * - 支持参数化测试按 Checker / 红线 / kind 过滤查询
 *
 * @module core/tests/fixtures/eag-redline/types
 */

// ============================================================================
// 1. 字面量联合类型
// ============================================================================

/**
 * 样例类型（字面量联合类型）
 *
 * - violation：违规样例（预期触发对应 Checker 的判定逻辑，断言 status="violated"）
 * - compliant：合规样例（预期通过对应 Checker 的判定，断言 status="passed"，不触发误报）
 */
export type FixtureKind = "violation" | "compliant";

/**
 * 预期判定结果（字面量联合类型）
 *
 * - violated：预期 Checker.check() 返回 status="violated"（对应 violation 样例）
 * - passed：预期 Checker.check() 返回 status="passed"（对应 compliant 样例）
 */
export type ExpectVerdict = "violated" | "passed";

// ============================================================================
// 2. manifest 元数据类型
// ============================================================================

/**
 * 单个样例的 manifest 元数据
 *
 * 对应 manifest.json 中 checkers[].fixtures[] 的单个元素结构。
 * 描述一个 violation 或 compliant 样例的完整元数据，供参数化测试路由断言使用。
 *
 * 字段语义：
 * - fixtureId：样例唯一 ID（格式 `{checker-kebab}/{name}.{kind}`，全局唯一）
 * - kind：样例类型（violation / compliant）
 * - targetRedlineId：该样例针对的红线 ID（多红线 Checker 的样例需指定具体红线，如 "TCS-CACHE-01"）
 * - expectVerdict：预期判定结果（violated / passed）
 * - description：样例场景描述（中文，说明触发或规避的判定逻辑）
 * - modulePath：样例模块相对路径（如 "./saga-detector/e1-cross-aggregate-write.violation"，用于静态 import）
 * - expectedViolationCount：预期违规数量（violation 样例 ≥1，compliant 样例 =0）
 * - expectedViolationPatterns：预期违规描述关键词列表（用于断言违规信息语义正确性）
 */
export interface FixtureManifestEntry {
  /** 样例唯一 ID（格式 `{checker-kebab}/{name}.{kind}`，如 "saga-detector/e1-cross-aggregate-write.violation"） */
  readonly fixtureId: string;
  /** 样例类型（violation 违规样例 / compliant 合规样例） */
  readonly kind: FixtureKind;
  /** 该样例针对的红线 ID（如 "E1" / "TCS-CACHE-01" / "BROWNFIELD-CONTRACT"） */
  readonly targetRedlineId: string;
  /** 预期判定结果（violated / passed） */
  readonly expectVerdict: ExpectVerdict;
  /** 样例场景描述（中文，说明触发或规避的判定逻辑） */
  readonly description: string;
  /** 样例模块相对路径（用于静态 import 或文档追溯） */
  readonly modulePath: string;
  /** 预期违规数量（violation 样例 ≥1，compliant 样例 =0） */
  readonly expectedViolationCount: number;
  /** 预期违规描述关键词列表（参数化测试断言违规信息语义正确性） */
  readonly expectedViolationPatterns: ReadonlyArray<string>;
}

/**
 * 按 Checker 分组的 manifest 元数据
 *
 * 对应 manifest.json 中 checkers[] 的单个元素结构。
 * 描述一个 Checker 负责的全部样例（含其 redlineIds 与 fixtures 列表）。
 *
 * 字段语义：
 * - checkerName：Checker 标识（与目录名一致，kebab-case，如 "saga-detector"）
 * - checkerClass：Checker 类名（PascalCase，如 "SagaDetector"，用于从 static-checkers/index.ts 映射实例）
 * - redlineIds：该 Checker 负责的红线 ID 列表（如 ["E1"] / ["E4", "TCS-OSS-01"]）
 * - fixtures：该 Checker 的样例列表（每红线 1 对 violation + compliant）
 */
export interface CheckerManifestEntry {
  /** Checker 标识（与目录名一致，kebab-case，如 "saga-detector"） */
  readonly checkerName: string;
  /** Checker 类名（PascalCase，如 "SagaDetector"） */
  readonly checkerClass: string;
  /** 该 Checker 负责的红线 ID 列表 */
  readonly redlineIds: ReadonlyArray<string>;
  /** 该 Checker 的样例列表（violation / compliant 成对） */
  readonly fixtures: ReadonlyArray<FixtureManifestEntry>;
}

/**
 * 完整 manifest 结构
 *
 * 对应 manifest.json 的顶层结构。
 * 描述 redline-fixtures 样例库的完整元数据（38 个样例 + 13 个 Checker 分组）。
 *
 * 字段语义：
 * - version：清单版本号（语义化版本，如 "1.0.0"）
 * - description：清单描述（中文，说明样例库用途与覆盖范围）
 * - generatedAt：清单生成日期（ISO 格式，如 "2026-07-19"）
 * - totalFixtures：样例总数（用于完整性校验，对齐 38）
 * - checkers：按 Checker 分组的样例清单（13 个 Checker）
 */
export interface FixtureManifest {
  /** 清单版本号（语义化版本） */
  readonly version: string;
  /** 清单描述（中文） */
  readonly description: string;
  /** 清单生成日期（ISO 格式 YYYY-MM-DD） */
  readonly generatedAt: string;
  /** 样例总数（用于完整性校验） */
  readonly totalFixtures: number;
  /** 按 Checker 分组的样例清单（13 个 Checker） */
  readonly checkers: ReadonlyArray<CheckerManifestEntry>;
}

// ============================================================================
// 3. 加载后样例类型
// ============================================================================

/**
 * 代码产出物（StaticChecker.check() 入参元素类型）
 *
 * 对应 eag/coding/types.ts StaticChecker.check 的 artifacts 参数元素：
 * - path：文件相对路径（如 "src/domain/order/OrderAggregate.ts"）
 * - content：文件完整内容（真实可解析的 TypeScript 代码，首行为 `// path` 注释）
 *
 * 注：此类型与 StaticChecker.check 入参 1:1 对齐，便于 loadAllFixtures() 直接传入。
 */
export interface FixtureArtifact {
  /** 文件相对路径（如 "src/domain/order/OrderAggregate.ts"） */
  readonly path: string;
  /** 文件完整内容（真实可解析的 TypeScript 代码） */
  readonly content: string;
}

/**
 * 加载后的样例（manifest 元数据 + 代码 artifacts 合并）
 *
 * loadAllFixtures() 的返回元素类型：
 * - meta：manifest 元数据（fixtureId / kind / targetRedlineId / 预期判定等）
 * - checkerClass：所属 Checker 类名（用于路由到 DEFAULT_STATIC_CHECKERS 实例）
 * - artifacts：代码产出物列表（StaticChecker.check() 的实际入参）
 * - brownfieldBaseline：棕地专属 baseline（仅 ContractGuardChecker 样例使用，
 *   对应 BROWNFIELD_BASELINE 命名导出的内容）
 *
 * 不可变优先：全部字段 readonly，artifacts 数组只读。
 */
export interface LoadedFixture {
  /** manifest 元数据 */
  readonly meta: FixtureManifestEntry;
  /** 所属 Checker 类名（如 "SagaDetector"） */
  readonly checkerClass: string;
  /** 代码产出物列表（StaticChecker.check() 的实际入参） */
  readonly artifacts: ReadonlyArray<FixtureArtifact>;
  /**
   * 棕地专属 baseline（仅 ContractGuardChecker 样例使用）
   *
   * 对应样例模块中的 `export const BROWNFIELD_BASELINE` 命名导出内容。
   * 参数化测试的 resolveChecker() 用此注入 createContractGuardChecker(baseline)。
   * 非 ContractGuardChecker 样例此字段为 undefined。
   */
  readonly brownfieldBaseline?: ReadonlyArray<{
    readonly apiName: string;
    readonly signature: string;
  }>;
}
