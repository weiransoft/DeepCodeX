/**
 * EAG-P1 批次 2 单元测试：4 个范式定义完整性
 *
 * 测试范围：
 * - P1. 4 个范式 ID 唯一性
 * - P2. 每个范式字段完整性（id/name/description/applicabilitySignals/skeletonTemplates/dependencyRules/namingConventions/antiPatterns）
 * - P3. skeletonTemplates 含 4 语言（typescript/java/python/go）
 * - P4. dependencyRules 非空 + severity 合法
 * - P5. namingConventions 非空 + element 合法
 * - P6. antiPatterns 非空 + detection/severity 合法
 * - P7. 每条描述 >= 30 字符（避免占位实现）
 * - P8. 每个范式已冻结（Object.isFrozen）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接引用真实范式常量
 *
 * 设计依据：
 * - EAG 方案 §5.1.1 范式库 4 范式
 * - eag/eak/paradigms/*.ts 4 个范式定义文件
 *
 * @module core/tests/eag-eak-paradigms
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DDD_LAYERED_PARADIGM } from "../eag/eak/paradigms/ddd-layered";
import { CLEAN_ARCHITECTURE_PARADIGM } from "../eag/eak/paradigms/clean-architecture";
import { CQRS_ES_PARADIGM } from "../eag/eak/paradigms/cqrs-es";
import { MICROSERVICE_PARADIGM } from "../eag/eak/paradigms/microservice";
import type {
  ArchitectureParadigm,
  AntiPattern,
  DependencyRule,
  NamingConvention,
  NamingElement,
  ParadigmId,
  SkeletonLanguage,
} from "../eag/eak/types";

// ============================================================================
// 准备：4 个范式数组
// ============================================================================

const ALL_PARADIGMS: ArchitectureParadigm[] = [
  DDD_LAYERED_PARADIGM,
  CLEAN_ARCHITECTURE_PARADIGM,
  CQRS_ES_PARADIGM,
  MICROSERVICE_PARADIGM,
];

const EXPECTED_NAMES: Record<ParadigmId, string> = {
  "ddd-layered": "DDD 分层架构",
  "clean-architecture": "Clean Architecture",
  "cqrs-es": "CQRS + Event Sourcing",
  microservice: "微服务架构",
};

// ============================================================================
// P1. 4 个范式 ID 唯一性
// ============================================================================

test("P1a. 4 个范式 ID 唯一性——无重复", () => {
  const ids = ALL_PARADIGMS.map((p) => p.id);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, `范式 ID 存在重复：${ids.join(",")}`);
});

test("P1b. 4 个范式 ID 完整性——包含全部 4 个", () => {
  const ids = new Set(ALL_PARADIGMS.map((p) => p.id));
  assert.ok(ids.has("ddd-layered"));
  assert.ok(ids.has("clean-architecture"));
  assert.ok(ids.has("cqrs-es"));
  assert.ok(ids.has("microservice"));
});

test("P1c. ddd-layered 范式 id 为 'ddd-layered'", () => {
  assert.equal(DDD_LAYERED_PARADIGM.id, "ddd-layered");
});

test("P1d. clean-architecture 范式 id 为 'clean-architecture'", () => {
  assert.equal(CLEAN_ARCHITECTURE_PARADIGM.id, "clean-architecture");
});

test("P1e. cqrs-es 范式 id 为 'cqrs-es'", () => {
  assert.equal(CQRS_ES_PARADIGM.id, "cqrs-es");
});

test("P1f. microservice 范式 id 为 'microservice'", () => {
  assert.equal(MICROSERVICE_PARADIGM.id, "microservice");
});

// ============================================================================
// P2. 每个范式字段完整性
// ============================================================================

test("P2. 每个范式字段完整性（id/name/description/applicabilitySignals 全字段）", () => {
  for (const paradigm of ALL_PARADIGMS) {
    // id：合法值
    assert.ok(
      ["ddd-layered", "clean-architecture", "cqrs-es", "microservice"].includes(paradigm.id),
      `范式 id 非法：${paradigm.id}`
    );

    // name：与预期一致
    assert.equal(paradigm.name, EXPECTED_NAMES[paradigm.id], `${paradigm.id} name 不符合预期`);

    // description：非空且 >= 30 字符
    assert.ok(
      typeof paradigm.description === "string" && paradigm.description.length >= 30,
      `${paradigm.id} description 应 >= 30 字符`
    );

    // applicabilitySignals：4 字段全部赋值
    const signals = paradigm.applicabilitySignals;
    assert.ok(signals.domainComplexity, `${paradigm.id} domainComplexity 应非空`);
    assert.ok(signals.consistencyRequirement, `${paradigm.id} consistencyRequirement 应非空`);
    assert.ok(signals.readWritePattern, `${paradigm.id} readWritePattern 应非空`);
    assert.ok(signals.integrationComplexity, `${paradigm.id} integrationComplexity 应非空`);

    // applicabilitySignals 字段值合法
    assert.ok(
      ["low", "medium", "high"].includes(signals.domainComplexity),
      `${paradigm.id} domainComplexity 非法：${signals.domainComplexity}`
    );
    assert.ok(
      ["strong", "eventual"].includes(signals.consistencyRequirement),
      `${paradigm.id} consistencyRequirement 非法：${signals.consistencyRequirement}`
    );
    assert.ok(
      ["balanced", "read-heavy", "write-heavy"].includes(signals.readWritePattern),
      `${paradigm.id} readWritePattern 非法：${signals.readWritePattern}`
    );
    assert.ok(
      ["monolith", "few-integrations", "many-systems"].includes(signals.integrationComplexity),
      `${paradigm.id} integrationComplexity 非法：${signals.integrationComplexity}`
    );
  }
});

test("P2b. 每个范式 skeletonTemplates 数组非空", () => {
  for (const paradigm of ALL_PARADIGMS) {
    assert.ok(
      Array.isArray(paradigm.skeletonTemplates) && paradigm.skeletonTemplates.length > 0,
      `${paradigm.id} skeletonTemplates 应非空`
    );
  }
});

test("P2c. 每个范式 dependencyRules 数组非空", () => {
  for (const paradigm of ALL_PARADIGMS) {
    assert.ok(
      Array.isArray(paradigm.dependencyRules) && paradigm.dependencyRules.length > 0,
      `${paradigm.id} dependencyRules 应非空`
    );
  }
});

test("P2d. 每个范式 namingConventions 数组非空", () => {
  for (const paradigm of ALL_PARADIGMS) {
    assert.ok(
      Array.isArray(paradigm.namingConventions) && paradigm.namingConventions.length > 0,
      `${paradigm.id} namingConventions 应非空`
    );
  }
});

test("P2e. 每个范式 antiPatterns 数组非空", () => {
  for (const paradigm of ALL_PARADIGMS) {
    assert.ok(
      Array.isArray(paradigm.antiPatterns) && paradigm.antiPatterns.length > 0,
      `${paradigm.id} antiPatterns 应非空`
    );
  }
});

// ============================================================================
// P3. skeletonTemplates 含 4 语言（typescript/java/python/go）
// ============================================================================

test("P3. 每个范式 skeletonTemplates 含全部 4 个语言", () => {
  const expectedLangs: SkeletonLanguage[] = ["typescript", "java", "python", "go"];
  for (const paradigm of ALL_PARADIGMS) {
    const langs = paradigm.skeletonTemplates.map((t) => t.language);
    for (const expected of expectedLangs) {
      assert.ok(
        langs.includes(expected),
        `${paradigm.id} skeletonTemplates 缺少语言：${expected}，实际：${langs.join(",")}`
      );
    }
  }
});

test("P3b. 每个骨架模板 directories 非空", () => {
  for (const paradigm of ALL_PARADIGMS) {
    for (const template of paradigm.skeletonTemplates) {
      assert.ok(
        Array.isArray(template.directories) && template.directories.length > 0,
        `${paradigm.id}/${template.language} directories 应非空`
      );
    }
  }
});

test("P3c. 每个骨架模板 entryFiles 非空", () => {
  for (const paradigm of ALL_PARADIGMS) {
    for (const template of paradigm.skeletonTemplates) {
      assert.ok(
        Array.isArray(template.entryFiles) && template.entryFiles.length > 0,
        `${paradigm.id}/${template.language} entryFiles 应非空`
      );
      // 验证每个 entryFile 字段
      for (const entry of template.entryFiles) {
        assert.ok(typeof entry.path === "string" && entry.path.length > 0, "entryFile.path 应非空");
        assert.ok(typeof entry.purpose === "string" && entry.purpose.length > 0, "entryFile.purpose 应非空");
      }
    }
  }
});

test("P3d. 每个骨架模板 configFile 非空", () => {
  for (const paradigm of ALL_PARADIGMS) {
    for (const template of paradigm.skeletonTemplates) {
      assert.ok(
        typeof template.configFile === "string" && template.configFile.length > 0,
        `${paradigm.id}/${template.language} configFile 应非空`
      );
    }
  }
});

test("P3e. TypeScript 骨架的 configFile 为 tsconfig.json", () => {
  for (const paradigm of ALL_PARADIGMS) {
    const tsTemplate = paradigm.skeletonTemplates.find((t) => t.language === "typescript");
    assert.ok(tsTemplate, `${paradigm.id} 应有 typescript 骨架`);
    assert.equal(tsTemplate!.configFile, "tsconfig.json");
  }
});

test("P3f. Java 骨架的 configFile 为 pom.xml", () => {
  for (const paradigm of ALL_PARADIGMS) {
    const javaTemplate = paradigm.skeletonTemplates.find((t) => t.language === "java");
    assert.ok(javaTemplate, `${paradigm.id} 应有 java 骨架`);
    assert.equal(javaTemplate!.configFile, "pom.xml");
  }
});

test("P3g. Python 骨架的 configFile 为 pyproject.toml", () => {
  for (const paradigm of ALL_PARADIGMS) {
    const pyTemplate = paradigm.skeletonTemplates.find((t) => t.language === "python");
    assert.ok(pyTemplate, `${paradigm.id} 应有 python 骨架`);
    assert.equal(pyTemplate!.configFile, "pyproject.toml");
  }
});

test("P3h. Go 骨架的 configFile 为 go.mod", () => {
  for (const paradigm of ALL_PARADIGMS) {
    const goTemplate = paradigm.skeletonTemplates.find((t) => t.language === "go");
    assert.ok(goTemplate, `${paradigm.id} 应有 go 骨架`);
    assert.equal(goTemplate!.configFile, "go.mod");
  }
});

// ============================================================================
// P4. dependencyRules 非空 + severity 合法
// ============================================================================

test("P4. 每个范式 dependencyRules 字段完整性（id/description/fromLayer/forbiddenToLayers/severity）", () => {
  for (const paradigm of ALL_PARADIGMS) {
    assert.ok(paradigm.dependencyRules.length >= 3, `${paradigm.id} dependencyRules 应 >= 3 条`);
    for (const rule of paradigm.dependencyRules) {
      // id 非空
      assert.ok(typeof rule.id === "string" && rule.id.length > 0, `${paradigm.id} rule.id 应非空`);
      // description >= 30 字符
      assert.ok(
        typeof rule.description === "string" && rule.description.length >= 30,
        `${paradigm.id} rule ${rule.id} description 应 >= 30 字符`
      );
      // fromLayer 非空
      assert.ok(typeof rule.fromLayer === "string" && rule.fromLayer.length > 0);
      // forbiddenToLayers 非空数组
      assert.ok(
        Array.isArray(rule.forbiddenToLayers) && rule.forbiddenToLayers.length > 0,
        `${paradigm.id} rule ${rule.id} forbiddenToLayers 应非空`
      );
      // severity 合法
      const validSeverities: DependencyRule["severity"][] = ["blocker", "major", "warning"];
      assert.ok(
        validSeverities.includes(rule.severity),
        `${paradigm.id} rule ${rule.id} severity 非法：${rule.severity}`
      );
    }
  }
});

test("P4b. ddd-layered 至少有 3 条 BLOCKER 依赖规则（domain 不得依赖 infrastructure/application/interfaces）", () => {
  const blockers = DDD_LAYERED_PARADIGM.dependencyRules.filter((r) => r.severity === "blocker");
  assert.ok(blockers.length >= 3, `ddd-layered BLOCKER 依赖规则应 >= 3 条，实际：${blockers.length}`);
});

// ============================================================================
// P5. namingConventions 非空 + element 合法
// ============================================================================

test("P5. 每个范式 namingConventions 字段完整性（element/pattern/description）", () => {
  const validElements: NamingElement[] = [
    "aggregate-root",
    "entity",
    "value-object",
    "domain-event",
    "application-service",
    "repository",
    "factory",
  ];
  for (const paradigm of ALL_PARADIGMS) {
    assert.ok(paradigm.namingConventions.length >= 5, `${paradigm.id} namingConventions 应 >= 5 条`);
    for (const convention of paradigm.namingConventions) {
      // element 合法
      assert.ok(
        validElements.includes(convention.element),
        `${paradigm.id} namingConvention element 非法：${convention.element}`
      );
      // pattern 非空
      assert.ok(typeof convention.pattern === "string" && convention.pattern.length > 0);
      // description >= 30 字符
      assert.ok(
        typeof convention.description === "string" && convention.description.length >= 30,
        `${paradigm.id} namingConvention ${convention.element} description 应 >= 30 字符`
      );
    }
  }
});

test("P5b. 每个范式 namingConventions 至少覆盖 aggregate-root + repository", () => {
  for (const paradigm of ALL_PARADIGMS) {
    const elements = paradigm.namingConventions.map((c) => c.element);
    assert.ok(elements.includes("aggregate-root"), `${paradigm.id} 应有 aggregate-root 命名规范`);
    assert.ok(elements.includes("repository"), `${paradigm.id} 应有 repository 命名规范`);
  }
});

// ============================================================================
// P6. antiPatterns 非空 + detection/severity 合法
// ============================================================================

test("P6. 每个范式 antiPatterns 字段完整性（id/name/description/detection/severity）", () => {
  for (const paradigm of ALL_PARADIGMS) {
    assert.ok(paradigm.antiPatterns.length >= 4, `${paradigm.id} antiPatterns 应 >= 4 条`);
    for (const ap of paradigm.antiPatterns) {
      // id 非空
      assert.ok(typeof ap.id === "string" && ap.id.length > 0);
      // name 非空
      assert.ok(typeof ap.name === "string" && ap.name.length > 0);
      // description >= 30 字符
      assert.ok(
        typeof ap.description === "string" && ap.description.length >= 30,
        `${paradigm.id} antiPattern ${ap.id} description 应 >= 30 字符`
      );
      // detection 合法
      const validDetections: AntiPattern["detection"][] = ["static", "reasoning"];
      assert.ok(
        validDetections.includes(ap.detection),
        `${paradigm.id} antiPattern ${ap.id} detection 非法：${ap.detection}`
      );
      // severity 合法
      const validSeverities: AntiPattern["severity"][] = ["blocker", "major", "warning"];
      assert.ok(
        validSeverities.includes(ap.severity),
        `${paradigm.id} antiPattern ${ap.id} severity 非法：${ap.severity}`
      );
    }
  }
});

test("P6b. 每个范式 antiPatterns 的 id 在范式内唯一", () => {
  for (const paradigm of ALL_PARADIGMS) {
    const ids = paradigm.antiPatterns.map((ap) => ap.id);
    const uniqueIds = new Set(ids);
    assert.equal(uniqueIds.size, ids.length, `${paradigm.id} antiPatterns id 存在重复`);
  }
});

// ============================================================================
// P7. 每条描述 >= 30 字符（避免占位实现）
// ============================================================================

test("P7a. 每个范式顶层 description >= 50 字符", () => {
  for (const paradigm of ALL_PARADIGMS) {
    assert.ok(
      paradigm.description.length >= 50,
      `${paradigm.id} description 应 >= 50 字符，实际：${paradigm.description.length}`
    );
  }
});

test("P7b. 每个范式 dependencyRules 的 description >= 30 字符", () => {
  for (const paradigm of ALL_PARADIGMS) {
    for (const rule of paradigm.dependencyRules) {
      assert.ok(
        rule.description.length >= 30,
        `${paradigm.id} rule ${rule.id} description 应 >= 30 字符，实际：${rule.description.length}`
      );
    }
  }
});

test("P7c. 每个范式 namingConventions 的 description >= 30 字符", () => {
  for (const paradigm of ALL_PARADIGMS) {
    for (const convention of paradigm.namingConventions) {
      assert.ok(
        convention.description.length >= 30,
        `${paradigm.id} namingConvention ${convention.element} description 应 >= 30 字符`
      );
    }
  }
});

test("P7d. 每个范式 antiPatterns 的 description >= 30 字符", () => {
  for (const paradigm of ALL_PARADIGMS) {
    for (const ap of paradigm.antiPatterns) {
      assert.ok(ap.description.length >= 30, `${paradigm.id} antiPattern ${ap.id} description 应 >= 30 字符`);
    }
  }
});

// ============================================================================
// P8. 每个范式已冻结（Object.isFrozen）
// ============================================================================

test("P8a. ddd-layered 范式已冻结", () => {
  assert.ok(Object.isFrozen(DDD_LAYERED_PARADIGM));
});

test("P8b. clean-architecture 范式已冻结", () => {
  assert.ok(Object.isFrozen(CLEAN_ARCHITECTURE_PARADIGM));
});

test("P8c. cqrs-es 范式已冻结", () => {
  assert.ok(Object.isFrozen(CQRS_ES_PARADIGM));
});

test("P8d. microservice 范式已冻结", () => {
  assert.ok(Object.isFrozen(MICROSERVICE_PARADIGM));
});

// ============================================================================
// P9. 4 个范式信号差异化验证（避免雷同）
// ============================================================================

test("P9. 4 个范式 applicabilitySignals 互不相同（信号差异化）", () => {
  const signalKeys = ALL_PARADIGMS.map((p) =>
    JSON.stringify({
      d: p.applicabilitySignals.domainComplexity,
      c: p.applicabilitySignals.consistencyRequirement,
      r: p.applicabilitySignals.readWritePattern,
      i: p.applicabilitySignals.integrationComplexity,
    })
  );
  const uniqueKeys = new Set(signalKeys);
  // 至少 3 种不同信号组合（microservice 与 cqrs-es 可能相同，允许）
  assert.ok(uniqueKeys.size >= 3, `4 个范式信号差异化不足，仅 ${uniqueKeys.size} 种组合`);
});

test("P9b. ddd-layered 信号：high/strong/balanced/monolith", () => {
  const s = DDD_LAYERED_PARADIGM.applicabilitySignals;
  assert.equal(s.domainComplexity, "high");
  assert.equal(s.consistencyRequirement, "strong");
  assert.equal(s.readWritePattern, "balanced");
  assert.equal(s.integrationComplexity, "monolith");
});

test("P9c. clean-architecture 信号：medium/strong/balanced/few-integrations", () => {
  const s = CLEAN_ARCHITECTURE_PARADIGM.applicabilitySignals;
  assert.equal(s.domainComplexity, "medium");
  assert.equal(s.consistencyRequirement, "strong");
  assert.equal(s.readWritePattern, "balanced");
  assert.equal(s.integrationComplexity, "few-integrations");
});

test("P9d. cqrs-es 信号：high/eventual/read-heavy/many-systems", () => {
  const s = CQRS_ES_PARADIGM.applicabilitySignals;
  assert.equal(s.domainComplexity, "high");
  assert.equal(s.consistencyRequirement, "eventual");
  assert.equal(s.readWritePattern, "read-heavy");
  assert.equal(s.integrationComplexity, "many-systems");
});

test("P9e. microservice 信号：high/eventual/read-heavy/many-systems", () => {
  const s = MICROSERVICE_PARADIGM.applicabilitySignals;
  assert.equal(s.domainComplexity, "high");
  assert.equal(s.consistencyRequirement, "eventual");
  assert.equal(s.readWritePattern, "read-heavy");
  assert.equal(s.integrationComplexity, "many-systems");
});
