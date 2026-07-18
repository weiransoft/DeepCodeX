/**
 * EAG-P1 批次 4 单元测试：EDM 信号检测器 + 红线判定器
 *
 * 测试范围：
 * - SD1. 信号检测器：单域命中
 * - SD2. 信号检测器：多域命中
 * - SD3. 信号检测器：无命中
 * - SD4. 信号检测器：证据片段提取
 * - SD5. 信号检测器：自定义域子集构造
 * - SD6. 信号检测器：多行文本扫描
 * - SD7. 信号检测器：suggestedDomains 默认等于 detectedDomains
 * - SD8. EDM_ALL_DOMAINS 常量完整性
 * - RD1. EDM-01：前端-only 权限判定（违反场景）
 * - RD2. EDM-01：服务层含权限校验（通过场景）
 * - RD3. EDM-01：代码片段中前端-only 权限校验
 * - RD4. EDM-02：数据权限查询改写覆盖（全部覆盖 / 部分覆盖 / 未覆盖）
 * - RD5. EDM-02：接口规范化（method 大写、path 尾部斜杠）
 * - RD6. EDM-03：SoD 互斥校验（hasSoDCheck=false 违反）
 * - RD7. EDM-03：hasSoDCheck=true 但流程无 SoD 关键词违反
 * - RD8. EDM-03：hasSoDCheck=true 且流程含 SoD 关键词通过
 * - RD9. EDM_REDLINE_CHECKERS 注册表完整性
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接调用真实 EdmSignalDetector 类与红线判定函数
 *
 * 设计依据：
 * - EAG 方案 §5.7.2 信号检测 + EDM-01/02/03 红线
 * - eag/edm/edm-detector.ts / edm-redlines.ts
 *
 * @module core/tests/eag-edm-detector-redlines
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EdmSignalDetector, EDM_ALL_DOMAINS } from "../eag/edm/edm-detector";
import {
  checkEdm01FrontendOnlyPermission,
  checkEdm02DataScopeQueryRewriteCoverage,
  checkEdm03RoleMutualExclusionCheck,
  EDM_REDLINE_CHECKERS,
} from "../eag/edm/edm-redlines";
import type { EdmDetectionResult, EdmRedlineViolation } from "../eag/edm/types";
import { USER_DOMAIN } from "../eag/edm/edm-domains/user-domain";

// ============================================================================
// SD1. 信号检测器：单域命中
// ============================================================================

test("SD1a. 仅命中用户域——'用户登录系统'仅触发用户域", () => {
  const detector = new EdmSignalDetector();
  const result = detector.detect("用户登录系统");
  assert.equal(result.detectedDomains.length, 1);
  assert.ok(result.detectedDomains.includes("user"));
});

test("SD1b. 仅命中组织域——'部门汇报关系'仅触发组织域", () => {
  const detector = new EdmSignalDetector();
  const result = detector.detect("部门汇报关系");
  assert.equal(result.detectedDomains.length, 1);
  assert.ok(result.detectedDomains.includes("org"));
});

test("SD1c. 仅命中角色域——'角色继承'仅触发角色域", () => {
  const detector = new EdmSignalDetector();
  const result = detector.detect("角色继承");
  assert.equal(result.detectedDomains.length, 1);
  assert.ok(result.detectedDomains.includes("role"));
});

test("SD1d. 仅命中数据权限域——'数据权限行级控制'触发数据权限域", () => {
  const detector = new EdmSignalDetector();
  const result = detector.detect("数据权限行级控制");
  // 注意："数据权限"是数据权限域的信号词；"权限"是功能权限域的信号词
  // 所以这段文本同时命中数据权限域和功能权限域
  assert.ok(result.detectedDomains.includes("data-scope"));
});

// ============================================================================
// SD2. 信号检测器：多域命中
// ============================================================================

test("SD2a. 多域命中——'用户登录后查看部门订单'同时触发用户域与组织域", () => {
  const detector = new EdmSignalDetector();
  const result = detector.detect("用户登录后查看部门订单");
  assert.ok(result.detectedDomains.includes("user"), "应命中用户域");
  assert.ok(result.detectedDomains.includes("org"), "应命中组织域");
  assert.ok(result.detectedDomains.length >= 2);
});

test("SD2b. 多域命中——'角色权限菜单管理'同时触发角色域与功能权限域", () => {
  const detector = new EdmSignalDetector();
  const result = detector.detect("角色权限菜单管理");
  assert.ok(result.detectedDomains.includes("role"), "应命中角色域");
  assert.ok(result.detectedDomains.includes("permission"), "应命中功能权限域");
});

test("SD2c. 全部 5 域命中——'用户登录部门角色权限数据权限'触发全部 5 域", () => {
  const detector = new EdmSignalDetector();
  // 构造包含全部 5 域信号词的文本
  const text = "用户登录部门岗位角色权限菜单数据权限查询改写";
  const result = detector.detect(text);
  assert.ok(result.detectedDomains.includes("user"));
  assert.ok(result.detectedDomains.includes("org"));
  assert.ok(result.detectedDomains.includes("role"));
  assert.ok(result.detectedDomains.includes("permission"));
  assert.ok(result.detectedDomains.includes("data-scope"));
  assert.equal(result.detectedDomains.length, 5);
});

// ============================================================================
// SD3. 信号检测器：无命中
// ============================================================================

test("SD3a. 无命中——'订单管理库存查询'不触发任何域", () => {
  const detector = new EdmSignalDetector();
  const result = detector.detect("订单管理库存查询");
  assert.equal(result.detectedDomains.length, 0);
});

test("SD3b. 无命中——空字符串不触发任何域", () => {
  const detector = new EdmSignalDetector();
  const result = detector.detect("");
  assert.equal(result.detectedDomains.length, 0);
});

// ============================================================================
// SD4. 信号检测器：证据片段提取
// ============================================================================

test("SD4a. 证据片段包含信号词——'用户登录系统'", () => {
  const detector = new EdmSignalDetector();
  const result = detector.detect("用户登录系统");
  // evidence.user 应包含非空证据片段
  assert.ok(result.evidence.user.length > 0);
  // 证据片段应包含信号词"登录"或"用户"
  const evidenceText = result.evidence.user.join("");
  assert.ok(evidenceText.includes("登录") || evidenceText.includes("用户"), "证据片段应包含命中的信号词");
});

test("SD4b. evidence 字段含全部 5 个域的键（即使未命中也为空数组）", () => {
  const detector = new EdmSignalDetector();
  const result = detector.detect("用户登录");
  // 即使仅命中用户域，evidence 也应包含全部 5 个域的键
  assert.ok("user" in result.evidence);
  assert.ok("org" in result.evidence);
  assert.ok("role" in result.evidence);
  assert.ok("permission" in result.evidence);
  assert.ok("data-scope" in result.evidence);
  // 未命中域的 evidence 为空数组
  assert.equal(result.evidence.org.length, 0);
  assert.equal(result.evidence.role.length, 0);
});

test("SD4c. evidence 已冻结（Object.isFrozen）", () => {
  const detector = new EdmSignalDetector();
  const result = detector.detect("用户登录");
  assert.equal(Object.isFrozen(result.evidence), true);
  assert.equal(Object.isFrozen(result.detectedDomains), true);
});

// ============================================================================
// SD5. 信号检测器：自定义域子集构造
// ============================================================================

test("SD5a. 自定义域子集——仅检测用户域时其他域信号词不触发", () => {
  const detector = new EdmSignalDetector([USER_DOMAIN]);
  // 文本含组织域信号词"部门"，但检测范围仅含用户域
  const result = detector.detect("用户登录部门");
  assert.equal(result.detectedDomains.length, 1);
  assert.ok(result.detectedDomains.includes("user"));
  assert.ok(!result.detectedDomains.includes("org"));
});

// ============================================================================
// SD6. 信号检测器：多行文本扫描
// ============================================================================

test("SD6a. 多行文本扫描——跨行命中不同域", () => {
  const detector = new EdmSignalDetector();
  const multiLineText = "用户登录系统\n查看部门订单\n分配角色权限";
  const result = detector.detect(multiLineText);
  // 跨行应命中用户域（"用户登录"）、组织域（"部门"）、角色域（"角色"）
  assert.ok(result.detectedDomains.includes("user"));
  assert.ok(result.detectedDomains.includes("org"));
  assert.ok(result.detectedDomains.includes("role"));
});

test("SD6b. 多行文本扫描——CRLF 换行符兼容", () => {
  const detector = new EdmSignalDetector();
  const crlfText = "用户登录\r\n查看部门\r\n分配角色";
  const result = detector.detect(crlfText);
  assert.ok(result.detectedDomains.includes("user"));
  assert.ok(result.detectedDomains.includes("org"));
  assert.ok(result.detectedDomains.includes("role"));
});

// ============================================================================
// SD7. 信号检测器：suggestedDomains 默认等于 detectedDomains
// ============================================================================

test("SD7a. suggestedDomains 默认等于 detectedDomains", () => {
  const detector = new EdmSignalDetector();
  const result = detector.detect("用户登录部门角色权限数据权限");
  // suggestedDomains 应等于 detectedDomains
  assert.deepEqual([...result.suggestedDomains].sort(), [...result.detectedDomains].sort());
});

test("SD7b. detectedDomains 排序符合规范（user → org → role → permission → data-scope）", () => {
  const detector = new EdmSignalDetector();
  // 故意按相反顺序构造文本，验证输出排序稳定
  const result = detector.detect("数据权限权限角色组织用户");
  assert.deepEqual([...result.detectedDomains], ["user", "org", "role", "permission", "data-scope"]);
});

// ============================================================================
// SD8. EDM_ALL_DOMAINS 常量完整性
// ============================================================================

test("SD8a. EDM_ALL_DOMAINS 含 5 个域", () => {
  assert.equal(EDM_ALL_DOMAINS.length, 5);
});

test("SD8b. EDM_ALL_DOMAINS 已冻结", () => {
  assert.equal(Object.isFrozen(EDM_ALL_DOMAINS), true);
});

test("SD8c. EDM_ALL_DOMAINS 域 ID 唯一", () => {
  const ids = EDM_ALL_DOMAINS.map((d) => d.id);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, 5);
});

// ============================================================================
// RD1. EDM-01：前端-only 权限判定（违反场景）
// ============================================================================

test("RD1a. EDM-01 违反——架构分层无服务层承载权限校验", () => {
  const violations = checkEdm01FrontendOnlyPermission({
    architectureDocument: {
      layering: [
        { name: "presentation", responsibility: "前端 UI 渲染与交互" },
        { name: "controllers", responsibility: "HTTP 请求处理与路由" },
        // 无服务层承载权限校验
      ],
    },
  });
  assert.ok(violations.length > 0, "应检测到 EDM-01 违反");
  assert.equal(violations[0].id, "EDM-01");
  assert.equal(violations[0].severity, "BLOCKER");
});

test("RD1b. EDM-01 违反——服务层存在但职责未提及权限校验", () => {
  const violations = checkEdm01FrontendOnlyPermission({
    architectureDocument: {
      layering: [
        { name: "presentation", responsibility: "前端 UI" },
        { name: "service", responsibility: "业务逻辑处理" },
        // service 层职责未提及权限校验
      ],
    },
  });
  assert.ok(violations.length > 0);
  assert.equal(violations[0].id, "EDM-01");
});

// ============================================================================
// RD2. EDM-01：服务层含权限校验（通过场景）
// ============================================================================

test("RD2a. EDM-01 通过——service 层职责含权限校验", () => {
  const violations = checkEdm01FrontendOnlyPermission({
    architectureDocument: {
      layering: [
        { name: "presentation", responsibility: "前端 UI" },
        { name: "service", responsibility: "业务逻辑处理与权限校验" },
      ],
    },
  });
  assert.equal(violations.length, 0);
});

test("RD2b. EDM-01 通过——application 层职责含 authorization 关键词", () => {
  const violations = checkEdm01FrontendOnlyPermission({
    architectureDocument: {
      layering: [
        { name: "interfaces", responsibility: "HTTP 接口" },
        { name: "application", responsibility: "business logic and authorization" },
      ],
    },
  });
  assert.equal(violations.length, 0);
});

// ============================================================================
// RD3. EDM-01：代码片段中前端-only 权限校验
// ============================================================================

test("RD3a. EDM-01 违反——代码片段仅前端 .vue 含权限校验，后端无", () => {
  const violations = checkEdm01FrontendOnlyPermission({
    architectureDocument: {
      layering: [{ name: "service", responsibility: "业务逻辑与权限校验" }],
    },
    codeSnippets: [
      {
        file: "frontend/src/views/OrderList.vue",
        content: "if (hasPermission('order:view')) { ... }",
      },
      {
        file: "backend/src/controllers/OrderController.ts",
        content: "export function getOrderList() { return repository.findAll(); }",
      },
    ],
  });
  // 应检测到代码层面的前端-only 违反
  assert.ok(violations.length > 0);
  const codeViolation = violations.find((v) => v.location.includes("OrderList.vue"));
  assert.ok(codeViolation, "应检测到前端 .vue 文件的权限校验违反");
});

test("RD3b. EDM-01 通过——代码片段前端与后端均含权限校验", () => {
  const violations = checkEdm01FrontendOnlyPermission({
    architectureDocument: {
      layering: [{ name: "service", responsibility: "业务逻辑与权限校验" }],
    },
    codeSnippets: [
      {
        file: "frontend/src/views/OrderList.vue",
        content: "if (hasPermission('order:view')) { ... }",
      },
      {
        file: "backend/src/services/OrderService.ts",
        content: "permissionService.checkPermission(user, 'order:view'); return repository.findAll();",
      },
    ],
  });
  // 架构层与代码层均通过
  assert.equal(violations.length, 0);
});

// ============================================================================
// RD4. EDM-02：数据权限查询改写覆盖
// ============================================================================

test("RD4a. EDM-02 通过——全部列表接口已覆盖查询改写", () => {
  const violations = checkEdm02DataScopeQueryRewriteCoverage({
    listApis: [
      { path: "/api/orders", method: "GET" },
      { path: "/api/users", method: "GET" },
    ],
    rewrittenApis: [
      { path: "/api/orders", method: "GET" },
      { path: "/api/users", method: "GET" },
    ],
  });
  assert.equal(violations.length, 0);
});

test("RD4b. EDM-02 违反——部分接口未覆盖查询改写", () => {
  const violations = checkEdm02DataScopeQueryRewriteCoverage({
    listApis: [
      { path: "/api/orders", method: "GET" },
      { path: "/api/users", method: "GET" },
      { path: "/api/products", method: "GET" },
    ],
    rewrittenApis: [
      { path: "/api/orders", method: "GET" },
      // /api/users 与 /api/products 未覆盖
    ],
  });
  assert.equal(violations.length, 2);
  // 每条违反均为 MAJOR 级
  for (const v of violations) {
    assert.equal(v.id, "EDM-02");
    assert.equal(v.severity, "MAJOR");
  }
  // 违反位置应包含未覆盖的接口路径
  const locations = violations.map((v) => v.location);
  assert.ok(locations.some((l) => l.includes("/api/users")));
  assert.ok(locations.some((l) => l.includes("/api/products")));
});

test("RD4c. EDM-02 违反——全部接口未覆盖查询改写", () => {
  const violations = checkEdm02DataScopeQueryRewriteCoverage({
    listApis: [
      { path: "/api/orders", method: "GET" },
      { path: "/api/users", method: "GET" },
    ],
    rewrittenApis: [],
  });
  assert.equal(violations.length, 2);
});

test("RD4d. EDM-02 通过——listApis 为空时无违反", () => {
  const violations = checkEdm02DataScopeQueryRewriteCoverage({
    listApis: [],
    rewrittenApis: [],
  });
  assert.equal(violations.length, 0);
});

// ============================================================================
// RD5. EDM-02：接口规范化
// ============================================================================

test("RD5a. EDM-02 接口规范化——method 大小写不敏感", () => {
  // listApis 用小写 'get'，rewrittenApis 用大写 'GET'，应视为同一接口
  const violations = checkEdm02DataScopeQueryRewriteCoverage({
    listApis: [{ path: "/api/orders", method: "get" }],
    rewrittenApis: [{ path: "/api/orders", method: "GET" }],
  });
  assert.equal(violations.length, 0, "method 大小写不敏感，应视为已覆盖");
});

test("RD5b. EDM-02 接口规范化——path 尾部斜杠不敏感", () => {
  // listApis 路径含尾部斜杠，rewrittenApis 无尾部斜杠，应视为同一接口
  const violations = checkEdm02DataScopeQueryRewriteCoverage({
    listApis: [{ path: "/api/orders/", method: "GET" }],
    rewrittenApis: [{ path: "/api/orders", method: "GET" }],
  });
  assert.equal(violations.length, 0, "path 尾部斜杠不敏感，应视为已覆盖");
});

test("RD5c. EDM-02 接口去重——同一接口多次列出只产生一条违反", () => {
  const violations = checkEdm02DataScopeQueryRewriteCoverage({
    listApis: [
      { path: "/api/orders", method: "GET" },
      { path: "/api/orders", method: "GET" },
      { path: "/api/orders", method: "GET" },
    ],
    rewrittenApis: [],
  });
  assert.equal(violations.length, 1, "同一接口多次列出应去重，仅产生一条违反");
});

// ============================================================================
// RD6. EDM-03：SoD 互斥校验（hasSoDCheck=false 违反）
// ============================================================================

test("RD6a. EDM-03 违反——hasSoDCheck=false 明确未校验", () => {
  const violations = checkEdm03RoleMutualExclusionCheck({
    assignRoleFlow: {
      steps: ["校验角色存在", "保存分配记录"],
    },
    hasSoDCheck: false,
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].id, "EDM-03");
  assert.equal(violations[0].severity, "MAJOR");
});

test("RD6b. EDM-03 违反——hasSoDCheck=false 即使流程含 SoD 关键词也违反", () => {
  // hasSoDCheck=false 是明确未启用，即使流程描述含 SoD 关键词也违反
  const violations = checkEdm03RoleMutualExclusionCheck({
    assignRoleFlow: {
      steps: ["校验角色存在", "校验 SoD 互斥", "保存分配记录"],
    },
    hasSoDCheck: false,
  });
  assert.equal(violations.length, 1);
});

// ============================================================================
// RD7. EDM-03：hasSoDCheck=true 但流程无 SoD 关键词违反
// ============================================================================

test("RD7a. EDM-03 违反——hasSoDCheck=true 但流程步骤无 SoD 关键词", () => {
  const violations = checkEdm03RoleMutualExclusionCheck({
    assignRoleFlow: {
      steps: ["校验角色存在", "保存分配记录"],
    },
    hasSoDCheck: true,
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].id, "EDM-03");
  assert.ok(violations[0].message.includes("不一致"));
});

test("RD7b. EDM-03 违反——hasSoDCheck=true 但未提供 assignRoleFlow", () => {
  const violations = checkEdm03RoleMutualExclusionCheck({
    hasSoDCheck: true,
  });
  assert.equal(violations.length, 1);
  assert.ok(violations[0].message.includes("未提供"));
});

// ============================================================================
// RD8. EDM-03：hasSoDCheck=true 且流程含 SoD 关键词通过
// ============================================================================

test("RD8a. EDM-03 通过——hasSoDCheck=true 且流程含 SoD 关键词", () => {
  const violations = checkEdm03RoleMutualExclusionCheck({
    assignRoleFlow: {
      steps: ["校验角色存在", "校验 SoD 互斥约束", "保存分配记录"],
    },
    hasSoDCheck: true,
  });
  assert.equal(violations.length, 0);
});

test("RD8b. EDM-03 通过——流程含'互斥'关键词", () => {
  const violations = checkEdm03RoleMutualExclusionCheck({
    assignRoleFlow: {
      steps: ["校验角色存在", "检查角色互斥", "保存分配记录"],
    },
    hasSoDCheck: true,
  });
  assert.equal(violations.length, 0);
});

test("RD8c. EDM-03 通过——流程含'职责分离'关键词", () => {
  const violations = checkEdm03RoleMutualExclusionCheck({
    assignRoleFlow: {
      steps: ["校验角色存在", "执行职责分离校验", "保存分配记录"],
    },
    hasSoDCheck: true,
  });
  assert.equal(violations.length, 0);
});

// ============================================================================
// RD9. EDM_REDLINE_CHECKERS 注册表完整性
// ============================================================================

test("RD9a. EDM_REDLINE_CHECKERS 含 3 条红线判定器", () => {
  assert.equal(Object.keys(EDM_REDLINE_CHECKERS).length, 3);
  assert.ok("EDM-01" in EDM_REDLINE_CHECKERS);
  assert.ok("EDM-02" in EDM_REDLINE_CHECKERS);
  assert.ok("EDM-03" in EDM_REDLINE_CHECKERS);
});

test("RD9b. EDM_REDLINE_CHECKERS 已冻结", () => {
  assert.equal(Object.isFrozen(EDM_REDLINE_CHECKERS), true);
});

test("RD9c. EDM_REDLINE_CHECKERS 调用 EDM-01 判定器返回正确结果", () => {
  const checker = EDM_REDLINE_CHECKERS["EDM-01"];
  const violations = checker({
    architectureDocument: {
      layering: [{ name: "presentation", responsibility: "前端 UI" }],
    },
  }) as EdmRedlineViolation[];
  assert.ok(violations.length > 0);
  assert.equal(violations[0].id, "EDM-01");
});
