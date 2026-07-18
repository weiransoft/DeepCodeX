/**
 * EAG-P1 批次 4 单元测试：部署蓝图（Deployment Blueprints）
 *
 * 测试范围：
 * - T1. DEPLOYMENT_BLUEPRINTS 常量已冻结
 * - T2. 3 套蓝图完整性（spa-monolith / bff-microservice / cloud-native-microservice）
 * - T3. 蓝图 1：前后端分离单体（spa-monolith）内容正确性
 * - T4. 蓝图 2：BFF 微服务（bff-microservice）内容正确性
 * - T5. 蓝图 3：云原生微服务（cloud-native-microservice）内容正确性
 * - T6. getDeploymentBlueprintById 查询函数正确性
 * - T7. selectDeploymentBlueprint 信号匹配选择正确性
 *   - T7a. 云原生信号全部命中 → 选 cloud-native-microservice
 *   - T7b. BFF 信号全部命中 → 选 bff-microservice
 *   - T7c. 无信号命中 → 默认选 spa-monolith
 *   - T7d. 优先级：云原生 > BFF > 单体
 *   - T7e. 部分信号命中不触发对应蓝图
 * - T8. 蓝图字段非空校验（topology / applicabilitySignals / components）
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实 DEPLOYMENT_BLUEPRINTS 常量
 * - 严格对齐 §5.6.2 表格内容
 *
 * @module core/tests/eag-etsb-deployment-blueprints
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEPLOYMENT_BLUEPRINTS,
  getDeploymentBlueprintById,
  selectDeploymentBlueprint,
} from "../eag/etsb/deployment-blueprints";
import type { DeploymentBlueprintId } from "../eag/etsb/types";

// ============================================================================
// T1. DEPLOYMENT_BLUEPRINTS 常量已冻结
// ============================================================================

test("T1a. DEPLOYMENT_BLUEPRINTS 数组已冻结", () => {
  assert.ok(Object.isFrozen(DEPLOYMENT_BLUEPRINTS));
});

test("T1b. 每个蓝图对象已冻结", () => {
  for (const bp of DEPLOYMENT_BLUEPRINTS) {
    assert.ok(Object.isFrozen(bp), `蓝图 ${bp.id} 应被冻结`);
  }
});

// ============================================================================
// T2. 3 套蓝图完整性
// ============================================================================

test("T2a. DEPLOYMENT_BLUEPRINTS 长度 = 3", () => {
  assert.equal(DEPLOYMENT_BLUEPRINTS.length, 3);
});

test("T2b. DEPLOYMENT_BLUEPRINTS 包含全部 3 个蓝图 ID", () => {
  const ids = DEPLOYMENT_BLUEPRINTS.map((bp) => bp.id);
  const expected: DeploymentBlueprintId[] = ["spa-monolith", "bff-microservice", "cloud-native-microservice"];
  assert.deepEqual(ids, expected);
});

// ============================================================================
// T3. 蓝图 1：前后端分离单体（spa-monolith）内容正确性
// ============================================================================

test("T3a. spa-monolith 蓝图 ID 与名称正确", () => {
  const bp = DEPLOYMENT_BLUEPRINTS[0];
  assert.equal(bp.id, "spa-monolith");
  assert.equal(bp.name, "前后端分离单体");
});

test("T3b. spa-monolith 拓扑包含 SPA + 单后端 + 单库 + Redis", () => {
  const bp = DEPLOYMENT_BLUEPRINTS[0];
  assert.ok(bp.topology.includes("SPA"));
  assert.ok(bp.topology.includes("单后端"));
  assert.ok(bp.topology.includes("单库"));
  assert.ok(bp.topology.includes("Redis"));
});

test("T3c. spa-monolith 适用信号包含中小团队/业务边界未稳/快速交付", () => {
  const bp = DEPLOYMENT_BLUEPRINTS[0];
  assert.ok(bp.applicabilitySignals.length >= 3);
  // 至少包含关键信号
  const signalsText = bp.applicabilitySignals.join("；");
  assert.ok(signalsText.includes("中小团队"));
  assert.ok(signalsText.includes("业务边界"));
  assert.ok(signalsText.includes("快速交付"));
});

test("T3d. spa-monolith 组件清单包含 SPA 前端 + 单体后端 + 单数据库 + Redis", () => {
  const bp = DEPLOYMENT_BLUEPRINTS[0];
  assert.ok(bp.components.length >= 4);
  const componentsText = bp.components.join("；");
  assert.ok(componentsText.includes("SPA"));
  assert.ok(componentsText.includes("单体后端"));
  assert.ok(componentsText.includes("数据库"));
  assert.ok(componentsText.includes("Redis"));
});

// ============================================================================
// T4. 蓝图 2：BFF 微服务（bff-microservice）内容正确性
// ============================================================================

test("T4a. bff-microservice 蓝图 ID 与名称正确", () => {
  const bp = DEPLOYMENT_BLUEPRINTS[1];
  assert.equal(bp.id, "bff-microservice");
  assert.equal(bp.name, "BFF 微服务");
});

test("T4b. bff-microservice 拓扑包含 BFF 层 + 领域服务 + 消息队列", () => {
  const bp = DEPLOYMENT_BLUEPRINTS[1];
  assert.ok(bp.topology.includes("BFF"));
  assert.ok(bp.topology.includes("领域服务"));
  assert.ok(bp.topology.includes("消息队列"));
});

test("T4c. bff-microservice 适用信号包含多端/领域边界清晰/团队分组", () => {
  const bp = DEPLOYMENT_BLUEPRINTS[1];
  const signalsText = bp.applicabilitySignals.join("；");
  assert.ok(signalsText.includes("多端"));
  assert.ok(signalsText.includes("领域边界"));
  assert.ok(signalsText.includes("团队"));
});

test("T4d. bff-microservice 组件清单包含 BFF 层 + 领域微服务 + 消息队列", () => {
  const bp = DEPLOYMENT_BLUEPRINTS[1];
  const componentsText = bp.components.join("；");
  assert.ok(componentsText.includes("BFF"));
  assert.ok(componentsText.includes("领域微服务"));
  assert.ok(componentsText.includes("消息队列"));
});

// ============================================================================
// T5. 蓝图 3：云原生微服务（cloud-native-microservice）内容正确性
// ============================================================================

test("T5a. cloud-native-microservice 蓝图 ID 与名称正确", () => {
  const bp = DEPLOYMENT_BLUEPRINTS[2];
  assert.equal(bp.id, "cloud-native-microservice");
  assert.equal(bp.name, "云原生微服务");
});

test("T5b. cloud-native-microservice 拓扑包含 API Gateway + 服务发现 + 配置中心 + 链路追踪", () => {
  const bp = DEPLOYMENT_BLUEPRINTS[2];
  assert.ok(bp.topology.includes("API Gateway"));
  assert.ok(bp.topology.includes("服务发现"));
  assert.ok(bp.topology.includes("配置中心"));
  assert.ok(bp.topology.includes("链路追踪"));
});

test("T5c. cloud-native-microservice 适用信号包含多系统集成/独立扩缩容/DevOps 成熟", () => {
  const bp = DEPLOYMENT_BLUEPRINTS[2];
  const signalsText = bp.applicabilitySignals.join("；");
  assert.ok(signalsText.includes("多系统集成"));
  assert.ok(signalsText.includes("扩缩容"));
  assert.ok(signalsText.includes("DevOps"));
});

test("T5d. cloud-native-microservice 组件清单包含 API 网关 + 服务发现 + 配置中心 + 链路追踪 + K8s", () => {
  const bp = DEPLOYMENT_BLUEPRINTS[2];
  const componentsText = bp.components.join("；");
  assert.ok(componentsText.includes("API 网关"));
  assert.ok(componentsText.includes("服务发现"));
  assert.ok(componentsText.includes("配置中心"));
  assert.ok(componentsText.includes("链路追踪"));
  assert.ok(componentsText.includes("Kubernetes") || componentsText.includes("K8s"));
});

// ============================================================================
// T6. getDeploymentBlueprintById 查询函数正确性
// ============================================================================

test("T6a. getDeploymentBlueprintById 按 ID 查询返回正确蓝图", () => {
  const bp = getDeploymentBlueprintById("spa-monolith");
  assert.ok(bp !== null);
  assert.equal(bp!.id, "spa-monolith");
});

test("T6b. getDeploymentBlueprintById 查询 3 个蓝图 ID 都返回非 null", () => {
  const ids: DeploymentBlueprintId[] = ["spa-monolith", "bff-microservice", "cloud-native-microservice"];
  for (const id of ids) {
    const bp = getDeploymentBlueprintById(id);
    assert.ok(bp !== null, `蓝图 ${id} 应能查询到`);
    assert.equal(bp!.id, id);
  }
});

test("T6c. getDeploymentBlueprintById 返回的蓝图字段完整", () => {
  const bp = getDeploymentBlueprintById("cloud-native-microservice");
  assert.ok(bp !== null);
  assert.ok(bp!.name.length > 0);
  assert.ok(bp!.topology.length > 0);
  assert.ok(bp!.applicabilitySignals.length > 0);
  assert.ok(bp!.components.length > 0);
});

// ============================================================================
// T7. selectDeploymentBlueprint 信号匹配选择正确性
// ============================================================================

test("T7a. 云原生信号全部命中 → 选 cloud-native-microservice", () => {
  const bp = selectDeploymentBlueprint({
    multiSystemIntegration: true,
    independentScaling: true,
    devOpsMature: true,
  });
  assert.equal(bp.id, "cloud-native-microservice");
});

test("T7b. BFF 信号全部命中（云原生信号未全命中）→ 选 bff-microservice", () => {
  const bp = selectDeploymentBlueprint({
    multiEnd: true,
    domainBoundaryClear: true,
    teamGrouped: true,
  });
  assert.equal(bp.id, "bff-microservice");
});

test("T7c. 无信号命中 → 默认选 spa-monolith", () => {
  const bp = selectDeploymentBlueprint({});
  assert.equal(bp.id, "spa-monolith");
});

test("T7d. 全部信号为 false → 选 spa-monolith", () => {
  const bp = selectDeploymentBlueprint({
    multiEnd: false,
    domainBoundaryClear: false,
    teamGrouped: false,
    multiSystemIntegration: false,
    independentScaling: false,
    devOpsMature: false,
  });
  assert.equal(bp.id, "spa-monolith");
});

test("T7e. 优先级：云原生信号 + BFF 信号同时全部命中 → 选 cloud-native（优先级最高）", () => {
  const bp = selectDeploymentBlueprint({
    multiEnd: true,
    domainBoundaryClear: true,
    teamGrouped: true,
    multiSystemIntegration: true,
    independentScaling: true,
    devOpsMature: true,
  });
  assert.equal(bp.id, "cloud-native-microservice");
});

test("T7f. 云原生信号部分命中（缺 devOpsMature）→ 不选云原生，检查是否选 BFF 或单体", () => {
  const bp = selectDeploymentBlueprint({
    multiSystemIntegration: true,
    independentScaling: true,
    devOpsMature: false, // 缺此信号，云原生不命中
  });
  // 云原生需 3 信号全命中，缺一不可；BFF 信号也未命中 → 应选单体
  assert.equal(bp.id, "spa-monolith");
});

test("T7g. BFF 信号部分命中（缺 teamGrouped）→ 不选 BFF，选单体", () => {
  const bp = selectDeploymentBlueprint({
    multiEnd: true,
    domainBoundaryClear: true,
    teamGrouped: false, // 缺此信号，BFF 不命中
  });
  assert.equal(bp.id, "spa-monolith");
});

test("T7h. 仅 multiEnd 信号命中 → 选单体（BFF 需 3 信号全命中）", () => {
  const bp = selectDeploymentBlueprint({
    multiEnd: true,
  });
  assert.equal(bp.id, "spa-monolith");
});

test("T7i. 仅 multiSystemIntegration + devOpsMature 命中（缺 independentScaling）→ 选单体", () => {
  const bp = selectDeploymentBlueprint({
    multiSystemIntegration: true,
    independentScaling: false,
    devOpsMature: true,
  });
  assert.equal(bp.id, "spa-monolith");
});

test("T7j. selectDeploymentBlueprint 永远返回非 null（兜底单体）", () => {
  // 测试多种信号组合都应返回非 null
  const signalsList = [
    {},
    { multiEnd: true },
    { multiSystemIntegration: true },
    { multiEnd: true, domainBoundaryClear: true, teamGrouped: true },
    { multiSystemIntegration: true, independentScaling: true, devOpsMature: true },
  ];
  for (const signals of signalsList) {
    const bp = selectDeploymentBlueprint(signals);
    assert.ok(bp !== null, "selectDeploymentBlueprint 应永远返回非 null");
    assert.ok(bp.id.length > 0);
  }
});

// ============================================================================
// T8. 蓝图字段非空校验
// ============================================================================

test("T8a. 所有蓝图的 topology 字段非空", () => {
  for (const bp of DEPLOYMENT_BLUEPRINTS) {
    assert.ok(bp.topology.length > 0, `蓝图 ${bp.id} 的 topology 不能为空`);
  }
});

test("T8b. 所有蓝图的 applicabilitySignals 至少 3 个信号", () => {
  for (const bp of DEPLOYMENT_BLUEPRINTS) {
    assert.ok(
      bp.applicabilitySignals.length >= 3,
      `蓝图 ${bp.id} 应至少 3 个适用信号，实际 ${bp.applicabilitySignals.length}`
    );
  }
});

test("T8c. 所有蓝图的 components 至少 4 个组件", () => {
  for (const bp of DEPLOYMENT_BLUEPRINTS) {
    assert.ok(bp.components.length >= 4, `蓝图 ${bp.id} 应至少 4 个组件，实际 ${bp.components.length}`);
  }
});

test("T8d. 蓝图组件复杂度递增（单体 < BFF < 云原生）", () => {
  const monolithCount = DEPLOYMENT_BLUEPRINTS[0].components.length;
  const bffCount = DEPLOYMENT_BLUEPRINTS[1].components.length;
  const cloudNativeCount = DEPLOYMENT_BLUEPRINTS[2].components.length;
  // 云原生应比 BFF 组件多，BFF 应比单体组件多（或相等）
  assert.ok(cloudNativeCount >= bffCount, `云原生（${cloudNativeCount}）应不少于 BFF（${bffCount}）组件数`);
  assert.ok(bffCount >= monolithCount, `BFF（${bffCount}）应不少于单体（${monolithCount}）组件数`);
});
