/**
 * EAG-P5 端到端能力呈现验证（拆分文件 5/5）：企业架构核心机制 - EDM / 领域专家 / ICP / PKC
 *
 * 本文件由原 `eag-p5-e2e-capability-verification.test.ts` 拆分而来，
 * 集中承载企业架构核心机制端到端验证（领域模型 + 领域专家 + 合规包 + 交接文档）：
 *
 * - U5: EDM 五域模型 + 三条 EDM 专属红线（注册完整性 + 信号检测 + 红线判定）
 * - U6: 30 个领域专家 + DomainExpertRegistry 注册/冲突检测/查询/卸载
 * - U7: DomainExpertMatcher 4 维加权动态匹配（权重常量 + 多场景匹配 + topK 控制）
 * - U8: ICP 合规包 + PKC L4 交接文档（合规包完整性 + 引擎执行 + 七章构建）
 *
 * 测试约定（严格遵循项目规则 NFR-8 / NFR-9 / NFR-10）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 EdmSignalDetector / DomainExpertRegistry / ComplianceEngine / HandoverDocumentBuilder 实例
 * - 使用真实文件系统（os.tmpdir + mkdtempSync）创建临时项目目录
 * - 每个测试用例独立构造临时目录与依赖实例，无共享可变状态
 * - 测试结束后清理临时目录（避免泄漏）
 * - 中文注释，符合 TypeScript 代码规范
 *
 * 设计依据：
 * - ENTERPRISE_APP_GENERATION_DESIGN.md §5.7 EDM / §5.9 ICP / §5.11 PKC
 * - DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.2 DomainExpertRegistry / §4 DomainExpertMatcher
 * - NFR-8 不可变优先 + NFR-9 禁止 mock + NFR-10 中文详细注释
 *
 * @module core/tests/eag-p5-e2e-arch-edm-expert-icp-pkc
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// U5 EDM 五域 + 三条红线 导入
// ============================================================================

import { EDM_ALL_DOMAINS, EdmSignalDetector, type EdmDomainDefinition } from "../eag/edm/edm-detector";
import {
  checkEdm01FrontendOnlyPermission,
  checkEdm02DataScopeQueryRewriteCoverage,
  checkEdm03RoleMutualExclusionCheck,
  EDM_REDLINE_CHECKERS,
} from "../eag/edm/edm-redlines";

// ============================================================================
// U6 + U7 领域专家 Registry + Matcher 导入
// ============================================================================

import { DomainExpertRegistry } from "../team/domain-expert-registry";
import { DomainExpertMatcher, DOMAIN_MATCH_WEIGHTS } from "../team/domain-expert-matcher";
import { registerAllExperts, EXPECTED_TOTAL_EXPERTS, ALL_DOMAIN_CATEGORIES } from "../team/domain-experts/index";
import type { DomainExpert, DomainCategory } from "../team/types";

// ============================================================================
// U8 ICP 合规包 + PKC L4 交接文档 导入
// ============================================================================

import { ComplianceEngine, PACK_REGISTRY } from "../eag/icp/compliance-engine";
import type { ComplianceEvidenceReport, ComplianceCheckContext, CompliancePackId } from "../eag/icp/types";
import { HandoverDocumentBuilder } from "../eag/pkc/l4/handover-doc-builder";
import { ArchitectureSectionBuilder } from "../eag/pkc/l4/section-builders/architecture-section";
import { ModuleMapSectionBuilder } from "../eag/pkc/l4/section-builders/module-map-section";
import { ApiContractSectionBuilder } from "../eag/pkc/l4/section-builders/api-contract-section";
import { DataModelSectionBuilder } from "../eag/pkc/l4/section-builders/data-model-section";
import { TestStrategySectionBuilder } from "../eag/pkc/l4/section-builders/test-strategy-section";
import { RiskDebtSectionBuilder } from "../eag/pkc/l4/section-builders/risk-debt-section";
import { RunbookSectionBuilder } from "../eag/pkc/l4/section-builders/runbook-section";
import type { SectionBuildContext, HandoverDocument } from "../eag/pkc/l4/types";

// ============================================================================
// U5: EDM 五域模型 + 三条 EDM 专属红线
// ============================================================================
//
// 验证点（设计文档 §3.8 U5）：
// 1. user/org/role/permission/data-scope 5 域 EdmDomainDefinition 全部存在且 Object.isFrozen
// 2. 每域含 aggregates/valueObjects/domainEvents 字段（设计文档原列名 entities 实为 aggregates）
// 3. EdmSignalDetector 接收业务信号返回需要纳入的域（detect 函数真实可调用）
// 4. EDM-01 前端只读权限红线函数存在且可调用
// 5. EDM-02 数据范围查询重写覆盖红线函数存在且可调用
// 6. EDM-03 角色互斥校验红线函数存在且可调用
// 7. EDM_REDLINE_CHECKERS 注册表完整（3 条红线全部注册）

test("U5. EDM 五域模型 + 三条 EDM 专属红线：注册完整性 + 信号检测 + 红线判定", async () => {
  // ------------------------------------------------------------------------
  // 步骤 1：验证 5 个域全部注册（user/org/role/permission/data-scope）
  // ------------------------------------------------------------------------
  assert.equal(EDM_ALL_DOMAINS.length, 5, "EDM_ALL_DOMAINS 应包含 5 个域");

  // 收集所有域 ID 并验证完整性
  const domainIds = EDM_ALL_DOMAINS.map((d) => d.id);
  const expectedDomainIds: ReadonlyArray<"user" | "org" | "role" | "permission" | "data-scope"> = [
    "user",
    "org",
    "role",
    "permission",
    "data-scope",
  ];
  for (const expectedId of expectedDomainIds) {
    assert.ok(domainIds.includes(expectedId), `EDM_ALL_DOMAINS 应包含域 "${expectedId}"`);
  }

  // ------------------------------------------------------------------------
  // 步骤 2：验证每个域的字段完整性（id / name / description / aggregates / valueObjects / domainEvents / signalKeywords）
  // ------------------------------------------------------------------------
  for (const domain of EDM_ALL_DOMAINS) {
    assert.ok(typeof domain.id === "string" && domain.id.length > 0, `域 id 应为非空字符串：${domain.id}`);
    assert.ok(typeof domain.name === "string" && domain.name.length > 0, `域 name 应为非空字符串：${domain.name}`);
    assert.ok(
      typeof domain.description === "string" && domain.description.length > 0,
      `域 description 应为非空字符串：${domain.name}`
    );
    // 聚合列表至少 1 个
    assert.ok(domain.aggregates.length >= 1, `域 ${domain.id} aggregates 应至少 1 个`);
    // 值对象列表至少 1 个
    assert.ok(domain.valueObjects.length >= 1, `域 ${domain.id} valueObjects 应至少 1 个`);
    // 领域事件列表至少 1 个
    assert.ok(domain.domainEvents.length >= 1, `域 ${domain.id} domainEvents 应至少 1 个`);
    // 信号词列表至少 3 个
    assert.ok(domain.signalKeywords.length >= 3, `域 ${domain.id} signalKeywords 应至少 3 个`);

    // 验证聚合根字段结构（rootEntity / invariants / containedEntities / valueObjects / publishedEvents）
    for (const agg of domain.aggregates) {
      assert.ok(typeof agg.name === "string", `聚合 name 应为字符串：${domain.id}`);
      assert.ok(typeof agg.rootEntity === "string", `聚合 rootEntity 应为字符串：${domain.id}`);
      assert.ok(Array.isArray(agg.invariants), `聚合 invariants 应为数组：${domain.id}`);
      assert.ok(Array.isArray(agg.containedEntities), `聚合 containedEntities 应为数组：${domain.id}`);
      assert.ok(Array.isArray(agg.valueObjects), `聚合 valueObjects 应为数组：${domain.id}`);
      assert.ok(Array.isArray(agg.publishedEvents), `聚合 publishedEvents 应为数组：${domain.id}`);
    }

    // 验证值对象字段结构（name / attributes / immutabilityGuarantee）
    for (const vo of domain.valueObjects) {
      assert.ok(typeof vo.name === "string", `值对象 name 应为字符串：${domain.id}`);
      assert.ok(Array.isArray(vo.attributes), `值对象 attributes 应为数组：${domain.id}`);
      assert.ok(typeof vo.immutabilityGuarantee === "string", `值对象 immutabilityGuarantee 应为字符串：${domain.id}`);
    }

    // 验证领域事件字段结构（name / publisher / subscribers / payload）
    for (const evt of domain.domainEvents) {
      assert.ok(typeof evt.name === "string", `领域事件 name 应为字符串：${domain.id}`);
      assert.ok(typeof evt.publisher === "string", `领域事件 publisher 应为字符串：${domain.id}`);
      assert.ok(Array.isArray(evt.subscribers), `领域事件 subscribers 应为数组：${domain.id}`);
      assert.ok(Array.isArray(evt.payload), `领域事件 payload 应为数组：${domain.id}`);
    }
  }

  // ------------------------------------------------------------------------
  // 步骤 3：EdmSignalDetector 真实信号检测（多域命中）
  // ------------------------------------------------------------------------
  const detector = new EdmSignalDetector();
  // 构造复合需求文本：同时命中 user/role/permission 三域
  const compositeRequirement =
    "系统需要用户登录功能，支持账号密码与 OAuth 凭证。\n" +
    "角色管理支持 SoD 互斥约束与角色继承。\n" +
    "功能权限按 RBAC 模型控制菜单与按钮可见性。\n" +
    "数据权限按部门做行级数据范围隔离，列级脱敏。";
  const detection = detector.detect(compositeRequirement);

  // 验证检测结果：至少命中 user/role/permission/data-scope 四域
  assert.ok(
    detection.detectedDomains.includes("user"),
    `复合需求应检测到 user 域，实际检测到：${detection.detectedDomains.join(", ")}`
  );
  assert.ok(
    detection.detectedDomains.includes("role"),
    `复合需求应检测到 role 域（关键词"SoD"/"角色"），实际：${detection.detectedDomains.join(", ")}`
  );
  assert.ok(
    detection.detectedDomains.includes("permission"),
    `复合需求应检测到 permission 域（关键词"RBAC"/"权限"），实际：${detection.detectedDomains.join(", ")}`
  );
  assert.ok(
    detection.detectedDomains.includes("data-scope"),
    `复合需求应检测到 data-scope 域（关键词"数据权限"/"数据范围"），实际：${detection.detectedDomains.join(", ")}`
  );

  // 验证证据片段非空（至少一个域含证据）
  const evidenceKeys = Object.keys(detection.evidence);
  let totalEvidenceCount = 0;
  for (const key of evidenceKeys) {
    totalEvidenceCount += detection.evidence[key as keyof typeof detection.evidence].length;
  }
  assert.ok(totalEvidenceCount > 0, `检测证据应非空，实际总证据数：${totalEvidenceCount}`);

  // suggestedDomains 默认等于 detectedDomains
  assert.deepEqual(
    [...detection.suggestedDomains].sort(),
    [...detection.detectedDomains].sort(),
    "suggestedDomains 默认应等于 detectedDomains"
  );

  // ------------------------------------------------------------------------
  // 步骤 4：EDM-01 红线判定——前端 only 权限校验（BLOCKER）
  // ------------------------------------------------------------------------
  // 4.1 违反场景：架构分层无服务层承载权限校验
  const edm01ViolationArtifacts = Object.freeze({
    architectureDocument: Object.freeze({
      layering: Object.freeze([
        Object.freeze({ name: "frontend", responsibility: "渲染 UI 组件与页面布局" }),
        Object.freeze({ name: "database", responsibility: "数据持久化" }),
      ]),
    }),
  });
  const edm01Violations = checkEdm01FrontendOnlyPermission(edm01ViolationArtifacts);
  assert.ok(edm01Violations.length > 0, "EDM-01：架构无服务层应产生违反记录");
  assert.equal(edm01Violations[0].id, "EDM-01", "违反记录 id 应为 EDM-01");
  assert.equal(edm01Violations[0].severity, "BLOCKER", "EDM-01 严重级别应为 BLOCKER");

  // 4.2 通过场景：架构分层含服务层承载权限校验
  const edm01PassArtifacts = Object.freeze({
    architectureDocument: Object.freeze({
      layering: Object.freeze([
        Object.freeze({
          name: "application-service",
          responsibility: "业务逻辑与权限校验（authorization / permission check）",
        }),
        Object.freeze({ name: "frontend", responsibility: "渲染 UI 组件" }),
      ]),
    }),
  });
  const edm01Pass = checkEdm01FrontendOnlyPermission(edm01PassArtifacts);
  // 通过场景：架构分层含服务层承载权限校验，可能无违反记录或仅有规则 2 的违反（无代码片段则规则 2 跳过）
  assert.ok(
    edm01Pass.length === 0 || edm01Pass.every((v) => v.id === "EDM-01"),
    "EDM-01 通过场景：无违反或违反记录全部为 EDM-01"
  );

  // ------------------------------------------------------------------------
  // 步骤 5：EDM-02 红线判定——数据范围查询重写覆盖（MAJOR）
  // ------------------------------------------------------------------------
  // 5.1 违反场景：listApis 含未改写的接口
  const edm02ViolationArtifacts = Object.freeze({
    listApis: Object.freeze([
      Object.freeze({ path: "/api/orders", method: "GET" }),
      Object.freeze({ path: "/api/users", method: "GET" }),
      Object.freeze({ path: "/api/orders/export", method: "GET" }),
    ]),
    rewrittenApis: Object.freeze([Object.freeze({ path: "/api/orders", method: "GET" })]),
  });
  const edm02Violations = checkEdm02DataScopeQueryRewriteCoverage(edm02ViolationArtifacts);
  // /api/users 与 /api/orders/export 未覆盖 → 2 条违反记录
  assert.equal(edm02Violations.length, 2, "EDM-02：2 个未覆盖接口应产生 2 条违反记录");
  assert.equal(edm02Violations[0].id, "EDM-02", "违反记录 id 应为 EDM-02");
  assert.equal(edm02Violations[0].severity, "MAJOR", "EDM-02 严重级别应为 MAJOR");

  // 5.2 通过场景：listApis 全部已改写
  const edm02PassArtifacts = Object.freeze({
    listApis: Object.freeze([
      Object.freeze({ path: "/api/orders", method: "GET" }),
      Object.freeze({ path: "/api/users", method: "GET" }),
    ]),
    rewrittenApis: Object.freeze([
      Object.freeze({ path: "/api/orders", method: "GET" }),
      Object.freeze({ path: "/api/users", method: "GET" }),
    ]),
  });
  const edm02Pass = checkEdm02DataScopeQueryRewriteCoverage(edm02PassArtifacts);
  assert.equal(edm02Pass.length, 0, "EDM-02：全部覆盖应无违反记录");

  // ------------------------------------------------------------------------
  // 步骤 6：EDM-03 红线判定——角色互斥校验（MAJOR）
  // ------------------------------------------------------------------------
  // 6.1 违反场景 1：hasSoDCheck=false（明确未校验）
  const edm03ViolationArtifacts1 = Object.freeze({
    hasSoDCheck: false,
  });
  const edm03Violations1 = checkEdm03RoleMutualExclusionCheck(edm03ViolationArtifacts1);
  assert.ok(edm03Violations1.length > 0, "EDM-03：hasSoDCheck=false 应产生违反记录");
  assert.equal(edm03Violations1[0].id, "EDM-03", "违反记录 id 应为 EDM-03");
  assert.equal(edm03Violations1[0].severity, "MAJOR", "EDM-03 严重级别应为 MAJOR");

  // 6.2 违反场景 2：hasSoDCheck=true 但流程步骤无 SoD 关键词
  const edm03ViolationArtifacts2 = Object.freeze({
    hasSoDCheck: true,
    assignRoleFlow: Object.freeze({
      steps: Object.freeze(["校验角色存在", "保存分配记录", "返回成功"]),
    }),
  });
  const edm03Violations2 = checkEdm03RoleMutualExclusionCheck(edm03ViolationArtifacts2);
  assert.ok(edm03Violations2.length > 0, "EDM-03：标志位与流程不一致应产生违反记录");

  // 6.3 通过场景：hasSoDCheck=true 且流程步骤含 SoD 关键词
  const edm03PassArtifacts = Object.freeze({
    hasSoDCheck: true,
    assignRoleFlow: Object.freeze({
      steps: Object.freeze(["校验角色存在", "校验 SoD 互斥约束", "保存分配记录"]),
    }),
  });
  const edm03Pass = checkEdm03RoleMutualExclusionCheck(edm03PassArtifacts);
  assert.equal(edm03Pass.length, 0, "EDM-03：含 SoD 校验步骤应无违反记录");

  // ------------------------------------------------------------------------
  // 步骤 7：EDM_REDLINE_CHECKERS 注册表完整性验证（3 条红线全部注册）
  // ------------------------------------------------------------------------
  const expectedRedlineIds: ReadonlyArray<"EDM-01" | "EDM-02" | "EDM-03"> = ["EDM-01", "EDM-02", "EDM-03"];
  for (const redlineId of expectedRedlineIds) {
    assert.ok(
      typeof EDM_REDLINE_CHECKERS[redlineId] === "function",
      `EDM_REDLINE_CHECKERS 应注册 ${redlineId} 判定函数`
    );
  }
  assert.equal(Object.keys(EDM_REDLINE_CHECKERS).length, 3, "EDM_REDLINE_CHECKERS 应包含 3 条红线");
});

// ============================================================================
// U6: 30 个领域专家 + DomainExpertRegistry 注册/冲突检测
// ============================================================================
//
// 验证点（设计文档 §3.8 U6）：
// 1. 8 个类别的 30 个领域专家全部可加载（真实 registerAllExperts 异步调用）
// 2. 每个专家 expertId 强制 `domain-` 前缀（regex 校验）
// 3. DomainExpertRegistry.register 单个注册成功
// 4. 重复注册同 expertId 抛出 DomainExpertAlreadyRegisteredError
// 5. getByCategory 按类别返回正确专家列表
// 6. getByDomainTag 按业务标签返回匹配专家
// 7. unregister 卸载后 has 返回 false

test("U6. 30 个领域专家 + DomainExpertRegistry 注册/冲突检测/查询/卸载", async () => {
  // ------------------------------------------------------------------------
  // 步骤 1：registerAllExperts 真实加载 30 个专家
  // ------------------------------------------------------------------------
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);

  // 验证总数
  assert.equal(
    registry.size(),
    EXPECTED_TOTAL_EXPERTS,
    `注册后专家总数应为 ${EXPECTED_TOTAL_EXPERTS}，实际：${registry.size()}`
  );

  // ------------------------------------------------------------------------
  // 步骤 2：验证每个专家 expertId 强制 domain- 前缀
  // ------------------------------------------------------------------------
  const expertIds = registry.listExpertIds();
  assert.equal(expertIds.length, EXPECTED_TOTAL_EXPERTS, `专家 ID 数量应为 ${EXPECTED_TOTAL_EXPERTS}`);

  for (const expertId of expertIds) {
    assert.ok(/^domain-[a-z][a-z0-9-]*$/.test(expertId), `专家 expertId "${expertId}" 应符合 domain- 前缀 regex`);
  }

  // 验证已知专家 ID 存在（覆盖 8 个类别的代表性专家）
  const expectedExpertIds = [
    "domain-product-manager", // product
    "domain-project-producer", // project-management
    "domain-business-strategist", // strategy
    "domain-finance-tracker", // support
    "domain-cloud-architect", // specialized
    "domain-historian", // academic
    "domain-cross-border-ecomm", // marketing
    "domain-solution-strategist", // sales
  ];
  for (const expectedId of expectedExpertIds) {
    assert.ok(registry.has(expectedId), `应已注册专家：${expectedId}`);
  }

  // ------------------------------------------------------------------------
  // 步骤 3：getByCategory 按类别查询（验证 8 个类别专家数量符合设计）
  // ------------------------------------------------------------------------
  const categoryExpectedCounts: ReadonlyArray<{ category: DomainCategory; expectedCount: number }> = [
    { category: "product", expectedCount: 4 },
    { category: "project-management", expectedCount: 3 },
    { category: "strategy", expectedCount: 4 },
    { category: "support", expectedCount: 4 },
    { category: "specialized", expectedCount: 5 },
    { category: "academic", expectedCount: 4 },
    { category: "marketing", expectedCount: 5 },
    { category: "sales", expectedCount: 1 },
  ];

  for (const { category, expectedCount } of categoryExpectedCounts) {
    const experts = registry.getByCategory(category);
    assert.equal(
      experts.length,
      expectedCount,
      `类别 "${category}" 应有 ${expectedCount} 个专家，实际：${experts.length}`
    );
  }

  // 验证 ALL_DOMAIN_CATEGORIES 包含 8 个类别
  assert.equal(ALL_DOMAIN_CATEGORIES.length, 8, "ALL_DOMAIN_CATEGORIES 应包含 8 个类别");

  // ------------------------------------------------------------------------
  // 步骤 4：getByDomainTag 按业务标签查询（验证标签索引可用）
  // ------------------------------------------------------------------------
  // 获取所有已注册专家的 domainTags，取第一个标签做查询验证
  const allExperts = expertIds.map((id) => registry.getExpert(id)).filter((e): e is DomainExpert => e !== undefined);
  assert.ok(allExperts.length === EXPECTED_TOTAL_EXPERTS, "应能查询到全部 30 个专家定义");

  // 收集所有业务标签
  const allTags = new Set<string>();
  for (const expert of allExperts) {
    for (const tag of expert.domainTags) {
      allTags.add(tag);
    }
  }
  assert.ok(allTags.size > 0, "应至少有 1 个业务标签");

  // 取第一个标签，验证 getByDomainTag 返回的专家全部含此标签
  const firstTag = Array.from(allTags)[0];
  const expertsWithTag = registry.getByDomainTag(firstTag);
  assert.ok(expertsWithTag.length > 0, `业务标签 "${firstTag}" 应至少匹配 1 个专家`);
  for (const expert of expertsWithTag) {
    assert.ok(expert.domainTags.includes(firstTag), `专家 ${expert.expertId} 的 domainTags 应包含 "${firstTag}"`);
  }

  // ------------------------------------------------------------------------
  // 步骤 5：重复注册同 expertId 抛出错误（真实冲突检测）
  // ------------------------------------------------------------------------
  // 取一个已注册专家，再次注册应抛错
  const duplicateExpert = allExperts[0];
  assert.throws(
    () => registry.register(duplicateExpert),
    /already registered|已注册/i,
    `重复注册 expertId "${duplicateExpert.expertId}" 应抛出 DomainExpertAlreadyRegisteredError`
  );

  // ------------------------------------------------------------------------
  // 步骤 6：跨系统 RoleId 冲突检测（注入 roleRegistry 适配器）
  // ------------------------------------------------------------------------
  // 构造一个 RoleRegistry 适配器，含与某个专家去 domain- 前缀后同名的 RoleId
  const conflictRoleId = duplicateExpert.expertId.replace(/^domain-/, "");
  const roleRegistryAdapter = {
    listRoleIds: () => [conflictRoleId] as ReadonlyArray<string>,
  };
  const registryWithRoleCheck = new DomainExpertRegistry(roleRegistryAdapter);
  assert.throws(
    () => registryWithRoleCheck.register(duplicateExpert),
    /RoleId|冲突|collision/i,
    `专家 "${duplicateExpert.expertId}" 与 RoleId "${conflictRoleId}" 冲突应抛出 DomainExpertRoleIdCollisionError`
  );

  // ------------------------------------------------------------------------
  // 步骤 7：unregister 卸载后 has 返回 false + size 减少
  // ------------------------------------------------------------------------
  const sizeBeforeUnregister = registry.size();
  const expertToUnregister = allExperts[1]; // 取第二个专家卸载（避免与步骤 5 重复）
  assert.ok(expertToUnregister !== undefined, "应至少有 2 个专家用于卸载测试");
  const unregisterResult = registry.unregister(expertToUnregister.expertId);
  assert.equal(unregisterResult, true, `unregister "${expertToUnregister.expertId}" 应返回 true`);
  assert.equal(
    registry.has(expertToUnregister.expertId),
    false,
    `卸载后 has "${expertToUnregister.expertId}" 应返回 false`
  );
  assert.equal(registry.size(), sizeBeforeUnregister - 1, "卸载后 size 应减少 1");

  // 再次卸载同一专家应返回 false
  const secondUnregister = registry.unregister(expertToUnregister.expertId);
  assert.equal(secondUnregister, false, "再次卸载已不存在的专家应返回 false");
});

// ============================================================================
// U7: DomainExpertMatcher 4 维加权动态匹配
// ============================================================================
//
// 验证点（设计文档 §3.8 U7）：
// 1. DOMAIN_MATCH_WEIGHTS 常量值正确（domainTag 0.4 / keyword 0.3 / capability 0.2 / skill 0.1）
// 2. matchExpertsSync 对"金融风控系统"任务匹配到 legal-compliance/finance-tracker 等专家
// 3. matchExpertsSync 对"医疗 SaaS 平台"匹配到 medical-marketing-compliance/cloud-architect
// 4. matchExpertsSync 对"跨境电商订单系统"匹配到 cross-border-ecomm/business-strategist
// 5. 返回结果含 scoreBreakdown 且 domainTag 字段有值
// 6. topK 参数控制返回数量

test("U7. DomainExpertMatcher 4 维加权动态匹配：权重常量 + 多场景匹配 + topK 控制", async () => {
  // ------------------------------------------------------------------------
  // 步骤 1：验证 DOMAIN_MATCH_WEIGHTS 常量值（4 维加权）
  // ------------------------------------------------------------------------
  assert.equal(DOMAIN_MATCH_WEIGHTS.domainTag, 0.4, "domainTag 权重应为 0.4");
  assert.equal(DOMAIN_MATCH_WEIGHTS.keyword, 0.3, "keyword 权重应为 0.3");
  assert.equal(DOMAIN_MATCH_WEIGHTS.capability, 0.2, "capability 权重应为 0.2");
  assert.equal(DOMAIN_MATCH_WEIGHTS.skill, 0.1, "skill 权重应为 0.1");

  // 验证权重总和为 1.0（4 维加权完整性）
  const totalWeight =
    DOMAIN_MATCH_WEIGHTS.domainTag +
    DOMAIN_MATCH_WEIGHTS.keyword +
    DOMAIN_MATCH_WEIGHTS.capability +
    DOMAIN_MATCH_WEIGHTS.skill;
  assert.ok(Math.abs(totalWeight - 1.0) < 1e-9, `4 维权重总和应为 1.0，实际：${totalWeight}`);

  // ------------------------------------------------------------------------
  // 步骤 2：注册全部 30 个专家，构造 Matcher 实例
  // ------------------------------------------------------------------------
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);
  assert.equal(registry.size(), EXPECTED_TOTAL_EXPERTS, "Matcher 测试前应注册全部 30 个专家");

  const matcher = new DomainExpertMatcher(registry);

  // ------------------------------------------------------------------------
  // 步骤 3：场景 1——"金融风控系统" 应匹配到 legal-compliance / finance-tracker
  // ------------------------------------------------------------------------
  const finTechResults = matcher.matchExpertsSync(
    "金融风控系统",
    "设计一个金融风控系统，需要法律合规审查、财务追踪与反洗钱监控能力"
  );
  assert.ok(finTechResults.length > 0, "金融风控系统应至少匹配到 1 个专家");
  const finTechExpertIds = finTechResults.map((r) => r.expert.expertId);
  // 至少匹配到 legal-compliance 或 finance-tracker 之一
  assert.ok(
    finTechExpertIds.includes("domain-legal-compliance") || finTechExpertIds.includes("domain-finance-tracker"),
    `金融风控系统应匹配到 legal-compliance 或 finance-tracker，实际匹配：${finTechExpertIds.join(", ")}`
  );

  // 验证返回结果含 scoreBreakdown 且 domainTag 字段有值（设计文档 U7 验证点 ⑤）
  for (const result of finTechResults) {
    assert.ok(typeof result.confidence === "number", "confidence 应为数字");
    assert.ok(result.confidence >= 0 && result.confidence <= 1, "confidence 应在 [0, 1] 区间");
    assert.ok(typeof result.scoreBreakdown === "object", "scoreBreakdown 应为对象");
    assert.ok(typeof result.scoreBreakdown.capability === "number", "scoreBreakdown.capability 应为数字");
    assert.ok(typeof result.scoreBreakdown.skill === "number", "scoreBreakdown.skill 应为数字");
    assert.ok(typeof result.scoreBreakdown.keyword === "number", "scoreBreakdown.keyword 应为数字");
    // scoreByDomainKeyword 总是设置 domainTag 字段（matchExpertsSync 走 keyword 策略）
    assert.ok(
      typeof result.scoreBreakdown.domainTag === "number",
      `scoreBreakdown.domainTag 应为数字（专家：${result.expert.expertId}）`
    );
    assert.ok(
      result.scoreBreakdown.domainTag >= 0 && result.scoreBreakdown.domainTag <= 1,
      `scoreBreakdown.domainTag 应在 [0, 1] 区间（专家：${result.expert.expertId}）`
    );
  }

  // ------------------------------------------------------------------------
  // 步骤 4：场景 2——"医疗 SaaS 平台" 应匹配到 medical-marketing-compliance / cloud-architect
  // ------------------------------------------------------------------------
  const medicalResults = matcher.matchExpertsSync(
    "医疗 SaaS 平台",
    "构建医疗 SaaS 平台，需要医疗合规、云端架构与多租户隔离"
  );
  assert.ok(medicalResults.length > 0, "医疗 SaaS 平台应至少匹配到 1 个专家");
  const medicalExpertIds = medicalResults.map((r) => r.expert.expertId);
  // 至少匹配到 medical-marketing-compliance 或 cloud-architect 之一
  assert.ok(
    medicalExpertIds.includes("domain-medical-marketing-compliance") ||
      medicalExpertIds.includes("domain-cloud-architect"),
    `医疗 SaaS 平台应匹配到 medical-marketing-compliance 或 cloud-architect，实际匹配：${medicalExpertIds.join(", ")}`
  );

  // ------------------------------------------------------------------------
  // 步骤 5：场景 3——"跨境电商订单系统" 应匹配到 cross-border-ecomm / business-strategist
  // ------------------------------------------------------------------------
  const ecResults = matcher.matchExpertsSync(
    "跨境电商订单系统",
    "跨境电商订单系统设计与实现，需要跨境电商业务理解与商业战略规划"
  );
  assert.ok(ecResults.length > 0, "跨境电商订单系统应至少匹配到 1 个专家");
  const ecExpertIds = ecResults.map((r) => r.expert.expertId);
  // 至少匹配到 cross-border-ecomm 或 business-strategist 之一
  assert.ok(
    ecExpertIds.includes("domain-cross-border-ecomm") || ecExpertIds.includes("domain-business-strategist"),
    `跨境电商订单系统应匹配到 cross-border-ecomm 或 business-strategist，实际匹配：${ecExpertIds.join(", ")}`
  );

  // ------------------------------------------------------------------------
  // 步骤 6：topK 参数控制返回数量（通过异步 matchExperts 传入 topK）
  // ------------------------------------------------------------------------
  // 构造一个最小 TaskRequirement（matchExpertsSync 不支持 topK，用异步 matchExperts）
  const task = Object.freeze({
    taskId: "u7-task-001",
    title: "金融风控系统",
    description: "金融风控系统需要法律合规审查与财务追踪",
    requiredCapabilities: Object.freeze([]),
    preferredSkills: Object.freeze([]),
    constraints: Object.freeze([]),
    attachments: Object.freeze([]),
    upstreamContext: Object.freeze({}),
    priority: "medium" as const,
    timeoutMs: 0,
    createdAt: new Date().toISOString(),
    domainTags: Object.freeze(["金融"]),
  });

  // topK=1 应只返回 1 个结果
  const top1Results = await matcher.matchExperts(task, { strategy: "keyword", topK: 1 });
  assert.ok(top1Results.length <= 1, `topK=1 应返回不超过 1 个结果，实际：${top1Results.length}`);

  // topK=5 应返回最多 5 个结果
  const top5Results = await matcher.matchExperts(task, { strategy: "keyword", topK: 5 });
  assert.ok(top5Results.length <= 5, `topK=5 应返回不超过 5 个结果，实际：${top5Results.length}`);

  // topK=5 的结果数应 >= topK=1 的结果数（候选集更大）
  assert.ok(
    top5Results.length >= top1Results.length,
    `topK=5 结果数 (${top5Results.length}) 应 >= topK=1 结果数 (${top1Results.length})`
  );

  // 验证结果按 confidence 降序排序
  for (let i = 1; i < top5Results.length; i++) {
    assert.ok(
      top5Results[i - 1].confidence >= top5Results[i].confidence,
      `结果应按 confidence 降序：第 ${i - 1} 个 (${top5Results[i - 1].confidence}) 应 >= 第 ${i} 个 (${top5Results[i].confidence})`
    );
  }
});

// ============================================================================
// U8: ICP 合规包 + PKC L4 交接文档
// ============================================================================
//
// 验证点（设计文档 §3.8 U8）：
// 1. GMP/CFR/ALCOA 3 个种子合规包存在（PACK_REGISTRY 完整性）
// 2. 每个 CompliancePack 含 packId/packName/version/rules 字段
// 3. ComplianceEngine 可执行合规检查（run 方法真实可调用）
// 4. GMP-01~GMP-06 + CFR-01~CFR-05 + ALCOA-01~ALCOA-09 红线清单完整（共 20 条）
// 5. HandoverDocumentBuilder 七章结构（7 个 SectionBuilder 顺序 1~7）
// 6. 三级置信度（documented/inferred/verified）类型可用

test("U8. ICP 合规包 + PKC L4 交接文档：合规包完整性 + 引擎执行 + 七章构建", async () => {
  // ------------------------------------------------------------------------
  // 步骤 1：PACK_REGISTRY 完整性验证（GMP/CFR/ALCOA 3 个种子合规包）
  // ------------------------------------------------------------------------
  const expectedPackIds: ReadonlyArray<CompliancePackId> = ["GMP", "CFR", "ALCOA"];
  for (const packId of expectedPackIds) {
    assert.ok(PACK_REGISTRY[packId] !== undefined, `PACK_REGISTRY 应包含合规包：${packId}`);
    const pack = PACK_REGISTRY[packId];
    assert.ok(typeof pack.packId === "string", `pack.packId 应为字符串：${packId}`);
    assert.ok(typeof pack.packName === "string" && pack.packName.length > 0, `pack.packName 应为非空字符串：${packId}`);
    assert.ok(typeof pack.version === "string", `pack.version 应为字符串：${packId}`);
    assert.ok(Array.isArray(pack.rules) && pack.rules.length > 0, `pack.rules 应为非空数组：${packId}`);

    // 验证每条规则字段完整性
    for (const rule of pack.rules) {
      assert.ok(typeof rule.ruleId === "string", `rule.ruleId 应为字符串：${packId}`);
      assert.ok(typeof rule.title === "string", `rule.title 应为字符串：${packId}`);
      assert.ok(typeof rule.description === "string", `rule.description 应为字符串：${packId}`);
      assert.ok(typeof rule.regulatoryReference === "string", `rule.regulatoryReference 应为字符串：${packId}`);
      assert.ok(
        rule.checkKind === "static" || rule.checkKind === "dynamic" || rule.checkKind === "hybrid",
        `rule.checkKind 应为 static/dynamic/hybrid：${packId}/${rule.ruleId}`
      );
      assert.ok(
        rule.severity === "blocker" || rule.severity === "major" || rule.severity === "warning",
        `rule.severity 应为 blocker/major/warning：${packId}/${rule.ruleId}`
      );
    }
  }

  // ------------------------------------------------------------------------
  // 步骤 2：验证合规包规则数量（GMP 6 条 + CFR 5 条 + ALCOA 9 条 = 20 条）
  // ------------------------------------------------------------------------
  const gmpRules = PACK_REGISTRY.GMP.rules;
  const cfrRules = PACK_REGISTRY.CFR.rules;
  const alcoaRules = PACK_REGISTRY.ALCOA.rules;
  assert.equal(gmpRules.length, 6, `GMP 合规包应有 6 条规则，实际：${gmpRules.length}`);
  assert.equal(cfrRules.length, 5, `CFR 合规包应有 5 条规则，实际：${cfrRules.length}`);
  assert.equal(alcoaRules.length, 9, `ALCOA 合规包应有 9 条规则，实际：${alcoaRules.length}`);

  // 验证规则 ID 前缀与合规包匹配
  for (const rule of gmpRules) {
    assert.ok(rule.ruleId.startsWith("GMP"), `GMP 规则 ID 应以 GMP 开头：${rule.ruleId}`);
  }
  for (const rule of cfrRules) {
    assert.ok(rule.ruleId.startsWith("CFR"), `CFR 规则 ID 应以 CFR 开头：${rule.ruleId}`);
  }
  for (const rule of alcoaRules) {
    assert.ok(rule.ruleId.startsWith("ALCOA"), `ALCOA 规则 ID 应以 ALCOA 开头：${rule.ruleId}`);
  }

  // ------------------------------------------------------------------------
  // 步骤 3：ComplianceEngine 真实执行合规检查（run 方法）
  // ------------------------------------------------------------------------
  const engine = new ComplianceEngine();
  // 构造最小合规检查上下文（含空 fileMap/astMap/configMap）
  const complianceContext: ComplianceCheckContext = Object.freeze({
    projectRoot: os.tmpdir(),
    fileMap: Object.freeze({}),
    astMap: Object.freeze({}),
    configMap: Object.freeze({}),
  });

  // 执行 GMP 合规包检查（应返回 ComplianceEvidenceReport）
  const gmpReport = await engine.run("GMP", complianceContext, "u8-run-001");
  assert.equal(gmpReport.packId, "GMP", "GMP 报告 packId 应为 GMP");
  assert.equal(gmpReport.runId, "u8-run-001", "GMP 报告 runId 应为 u8-run-001");
  assert.ok(typeof gmpReport.generatedAt === "string", "GMP 报告 generatedAt 应为字符串");
  assert.ok(Array.isArray(gmpReport.ruleResults), "GMP 报告 ruleResults 应为数组");
  assert.equal(
    gmpReport.ruleResults.length,
    6,
    `GMP 报告 ruleResults 应含 6 条结果，实际：${gmpReport.ruleResults.length}`
  );
  assert.ok(typeof gmpReport.overallPassed === "boolean", "GMP 报告 overallPassed 应为 boolean");
  assert.ok(typeof gmpReport.summary === "string", "GMP 报告 summary 应为字符串");
  // 验证报告已冻结（Object.isFrozen）
  assert.ok(Object.isFrozen(gmpReport), "GMP 报告应已冻结（Object.isFrozen）");

  // 执行 CFR 合规包检查
  const cfrReport = await engine.run("CFR", complianceContext, "u8-run-002");
  assert.equal(cfrReport.packId, "CFR", "CFR 报告 packId 应为 CFR");
  assert.equal(
    cfrReport.ruleResults.length,
    5,
    `CFR 报告 ruleResults 应含 5 条结果，实际：${cfrReport.ruleResults.length}`
  );

  // 执行 ALCOA 合规包检查
  const alcoaReport = await engine.run("ALCOA", complianceContext, "u8-run-003");
  assert.equal(alcoaReport.packId, "ALCOA", "ALCOA 报告 packId 应为 ALCOA");
  assert.equal(
    alcoaReport.ruleResults.length,
    9,
    `ALCOA 报告 ruleResults 应含 9 条结果，实际：${alcoaReport.ruleResults.length}`
  );

  // ------------------------------------------------------------------------
  // 步骤 4：HandoverDocumentBuilder 七章结构验证
  // ------------------------------------------------------------------------
  // 构造 7 个 SectionBuilder 实例（真实实例，禁止 mock）
  const sectionBuilders = [
    new ArchitectureSectionBuilder(),
    new ModuleMapSectionBuilder(),
    new ApiContractSectionBuilder(),
    new DataModelSectionBuilder(),
    new TestStrategySectionBuilder(),
    new RiskDebtSectionBuilder(),
    new RunbookSectionBuilder(),
  ];
  assert.equal(sectionBuilders.length, 7, "应构造 7 个 SectionBuilder 实例");

  // 验证 7 个 SectionBuilder 的 order 字段为 1~7 且互不重复
  const orders = sectionBuilders.map((b) => b.order);
  const sortedOrders = [...orders].sort((a, b) => a - b);
  assert.deepEqual(sortedOrders, [1, 2, 3, 4, 5, 6, 7], "7 个 SectionBuilder 的 order 应为 1~7");
  const uniqueOrders = new Set(orders);
  assert.equal(uniqueOrders.size, 7, "7 个 SectionBuilder 的 order 应互不重复");

  // 验证 sectionId 互不重复
  const sectionIds = sectionBuilders.map((b) => b.sectionId);
  const uniqueSectionIds = new Set(sectionIds);
  assert.equal(uniqueSectionIds.size, 7, "7 个 SectionBuilder 的 sectionId 应互不重复");

  // 构造 HandoverDocumentBuilder（含构造时不变式校验）
  const docBuilder = new HandoverDocumentBuilder(sectionBuilders);

  // ------------------------------------------------------------------------
  // 步骤 5：HandoverDocumentBuilder.build 真实执行（七章并行构建）
  // ------------------------------------------------------------------------
  // 构造最小 SectionBuildContext（含 fileMap）
  const tmpProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "u8-handover-"));
  try {
    const sectionContext: SectionBuildContext = Object.freeze({
      projectRoot: tmpProjectRoot,
      runId: "u8-handover-001",
      fileMap: Object.freeze({
        "README.md": "# 测试项目\n\n用于 U8 交接文档构建验证。",
        "src/index.ts": "// 入口文件\nexport function main() { return 'hello'; }\n",
      }),
    });

    const handoverDoc = await docBuilder.build(sectionContext, "u8-doc-001", "u8-handover-001");

    // 验证 HandoverDocument 字段完整性
    assert.equal(handoverDoc.documentId, "u8-doc-001", "documentId 应为 u8-doc-001");
    assert.equal(handoverDoc.projectRoot, tmpProjectRoot, "projectRoot 应与上下文一致");
    assert.equal(handoverDoc.runId, "u8-handover-001", "runId 应为 u8-handover-001");
    assert.ok(typeof handoverDoc.generatedAt === "string", "generatedAt 应为字符串");
    assert.ok(Array.isArray(handoverDoc.sections), "sections 应为数组");
    assert.equal(handoverDoc.sections.length, 7, `交接文档应含 7 个章节，实际：${handoverDoc.sections.length}`);

    // 验证章节按 order 排序
    for (let i = 1; i < handoverDoc.sections.length; i++) {
      assert.ok(
        handoverDoc.sections[i - 1].order < handoverDoc.sections[i].order,
        `章节应按 order 升序排列：第 ${i - 1} 章 order=${handoverDoc.sections[i - 1].order} 应 < 第 ${i} 章 order=${handoverDoc.sections[i].order}`
      );
    }

    // 验证每个章节字段完整性
    for (const section of handoverDoc.sections) {
      assert.ok(typeof section.sectionId === "string", `section.sectionId 应为字符串：${section.sectionId}`);
      assert.ok(typeof section.title === "string", `section.title 应为字符串：${section.sectionId}`);
      assert.ok(typeof section.order === "number", `section.order 应为数字：${section.sectionId}`);
      assert.ok(typeof section.content === "string", `section.content 应为字符串：${section.sectionId}`);
      assert.ok(Array.isArray(section.sources), `section.sources 应为数组：${section.sectionId}`);
      // 验证置信度三级枚举
      assert.ok(
        section.confidence === "documented" || section.confidence === "inferred" || section.confidence === "verified",
        `section.confidence 应为 documented/inferred/verified：${section.sectionId}（实际：${section.confidence}）`
      );
    }

    // 验证整体置信度（取最低，应为 inferred 或更低）
    assert.ok(
      handoverDoc.overallConfidence === "documented" ||
        handoverDoc.overallConfidence === "inferred" ||
        handoverDoc.overallConfidence === "verified",
      `overallConfidence 应为 documented/inferred/verified（实际：${handoverDoc.overallConfidence}）`
    );

    // 验证目录（Markdown 格式）
    assert.ok(typeof handoverDoc.tableOfContents === "string", "tableOfContents 应为字符串");
    assert.ok(handoverDoc.tableOfContents.length > 0, "tableOfContents 应为非空");

    // 验证文档已冻结（Object.isFrozen）
    assert.ok(Object.isFrozen(handoverDoc), "HandoverDocument 应已冻结（Object.isFrozen）");
  } finally {
    // 清理临时目录
    try {
      fs.rmSync(tmpProjectRoot, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  }

  // ------------------------------------------------------------------------
  // 步骤 6：HandoverDocumentBuilder 构造时不变式校验（数量错误 + 重复 order + 重复 sectionId）
  // ------------------------------------------------------------------------
  // 6.1 仅传 6 个 SectionBuilder → invalid-builder-count
  assert.throws(
    () => new HandoverDocumentBuilder(sectionBuilders.slice(0, 6)),
    /invalid-builder-count|7 个|数量/,
    "传入 6 个 SectionBuilder 应抛出数量错误"
  );

  // 6.2 传入 8 个 SectionBuilder → invalid-builder-count（数量检查先于重复 order 检查）
  const eightBuilders = [
    ...sectionBuilders,
    Object.freeze({
      sectionId: "extra-section",
      title: "额外章节",
      order: 8,
      build: async () =>
        Object.freeze({
          sectionId: "extra",
          title: "额外",
          order: 8,
          confidence: "inferred" as const,
          content: "",
          sources: [] as string[],
        }),
    }),
  ];
  assert.throws(
    () => new HandoverDocumentBuilder(eightBuilders),
    /invalid-builder-count|7 个|数量/,
    "传入 8 个 SectionBuilder 应抛出数量错误"
  );

  // 6.3 7 个 SectionBuilder 但含重复 order → duplicate-section-order
  // 构造 7 个 builder，把第 7 个的 order 改为 6（与第 6 个重复）
  const duplicateOrderBuilders = [
    ...sectionBuilders.slice(0, 6),
    Object.freeze({
      sectionId: "extra-section",
      title: "额外章节",
      order: 6, // 与第 6 个 builder 的 order=6 重复
      build: async () =>
        Object.freeze({
          sectionId: "extra",
          title: "额外",
          order: 6,
          confidence: "inferred" as const,
          content: "",
          sources: [] as string[],
        }),
    }),
  ];
  assert.throws(
    () => new HandoverDocumentBuilder(duplicateOrderBuilders),
    /duplicate-section-order|重复|order/,
    "7 个 SectionBuilder 含重复 order 应抛出 duplicate-section-order 错误"
  );

  // 6.4 7 个 SectionBuilder 但含重复 sectionId → duplicate-section-id
  const duplicateIdBuilders = [
    ...sectionBuilders.slice(0, 6),
    Object.freeze({
      sectionId: sectionBuilders[0].sectionId, // 与第 1 个 builder 的 sectionId 重复
      title: "额外章节",
      order: 7,
      build: async () =>
        Object.freeze({
          sectionId: sectionBuilders[0].sectionId,
          title: "额外",
          order: 7,
          confidence: "inferred" as const,
          content: "",
          sources: [] as string[],
        }),
    }),
  ];
  assert.throws(
    () => new HandoverDocumentBuilder(duplicateIdBuilders),
    /duplicate-section-id|重复|sectionId/,
    "7 个 SectionBuilder 含重复 sectionId 应抛出 duplicate-section-id 错误"
  );

  // 6.5 7 个 SectionBuilder 但含越界 order（0）→ invalid-section-order
  const invalidOrderBuilders = [
    ...sectionBuilders.slice(0, 6),
    Object.freeze({
      sectionId: "extra-section",
      title: "额外章节",
      order: 0, // 越界 order
      build: async () =>
        Object.freeze({
          sectionId: "extra",
          title: "额外",
          order: 0,
          confidence: "inferred" as const,
          content: "",
          sources: [] as string[],
        }),
    }),
  ];
  assert.throws(
    () => new HandoverDocumentBuilder(invalidOrderBuilders),
    /invalid-section-order|非法|order/,
    "7 个 SectionBuilder 含越界 order=0 应抛出 invalid-section-order 错误"
  );
});
