/**
 * 部署蓝图（Deployment Blueprints）注册表 + 信号匹配选择
 *
 * 本模块是 EAG 方案 §5.6.2 部署蓝图的运行期访问入口：
 * - 维护 3 套部署蓝图（前后端分离单体 / BFF 微服务 / 云原生微服务）
 * - 每套蓝图描述拓扑结构、适用信号与组件清单
 * - 提供按 ID 查询 + 按信号匹配选择的 API
 *
 * 设计依据：
 * - EAG 方案 §5.6.2 部署蓝图（三套拓扑模板）
 * - 蓝图内容严格对齐 §5.6.2 表格
 *
 * 信号匹配算法（selectDeploymentBlueprint）：
 * - 输入 6 个布尔信号（multiEnd / domainBoundaryClear / teamGrouped /
 *   multiSystemIntegration / independentScaling / devOpsMature）
 * - 云原生微服务蓝图：multiSystemIntegration + independentScaling + devOpsMature 三信号全部命中
 * - BFF 微服务蓝图：multiEnd + domainBoundaryClear + teamGrouped 三信号全部命中
 * - 前后端分离单体蓝图：默认兜底（不满足上述条件的场景）
 * - 优先级：云原生 > BFF > 单体（更复杂的蓝图需要更多信号支持）
 *
 * 不可变保证：
 * - DEPLOYMENT_BLUEPRINTS 使用 Object.freeze 深度冻结
 * - 蓝图注册表初始化后不可修改，对齐 §5.12.4 G-A6d 配置冻结原则
 *
 * @module eag/etsb/deployment-blueprints
 */

import type { DeploymentBlueprint, DeploymentBlueprintId } from "./types";

// ============================================================================
// 3 套部署蓝图定义（严格对齐 §5.6.2 表格）
// ============================================================================

/**
 * 蓝图 1：前后端分离单体（spa-monolith）
 *
 * 对齐 §5.6.2 表格：
 * - 拓扑：SPA + 单后端 + 单库 + Redis
 * - 适用信号：中小团队、业务边界未稳、快速交付
 * - 组件：SPA 前端 + 单体后端 + 单数据库 + Redis 缓存
 *
 * 适用场景：
 * - 中小团队（< 10 人开发）
 * - 业务边界尚未稳定，需要快速迭代
 * - 快速交付优先于架构扩展性
 * - 单服务器或简单集群即可承载
 */
const SPA_MONOLITH_BLUEPRINT: DeploymentBlueprint = Object.freeze({
  id: "spa-monolith",
  name: "前后端分离单体",
  topology: "SPA + 单后端 + 单库 + Redis",
  applicabilitySignals: Object.freeze([
    "中小团队（< 10 人开发）",
    "业务边界未稳，需要快速迭代",
    "快速交付优先于架构扩展性",
    "单服务器或简单集群即可承载",
  ]),
  components: Object.freeze([
    "SPA 前端（React/Vue + Ant Design/Element Plus）",
    "单体后端（NestJS/Spring Boot/FastAPI/Gin 任选）",
    "单数据库（PostgreSQL/MySQL）",
    "Redis 缓存",
    "Nginx 反向代理",
  ]),
});

/**
 * 蓝图 2：BFF 微服务（bff-microservice）
 *
 * 对齐 §5.6.2 表格：
 * - 拓扑：SPA → BFF 层 → 2~5 个领域服务 + 消息队列
 * - 适用信号：多端（Web/移动）、领域边界清晰、团队分组
 * - 组件：SPA + BFF 层 + 2~5 领域服务 + 消息队列 + 共享数据库或每服务独立库
 *
 * 适用场景：
 * - 多端支持（Web + 移动端 + 小程序）
 * - 领域边界已清晰划分
 * - 团队按领域分组开发
 * - 中等并发量（< 5000 QPS）
 */
const BFF_MICROSERVICE_BLUEPRINT: DeploymentBlueprint = Object.freeze({
  id: "bff-microservice",
  name: "BFF 微服务",
  topology: "SPA → BFF 层 → 2~5 个领域服务 + 消息队列",
  applicabilitySignals: Object.freeze([
    "多端支持（Web + 移动端 + 小程序）",
    "领域边界已清晰划分",
    "团队按领域分组开发",
    "中等并发量（< 5000 QPS）",
  ]),
  components: Object.freeze([
    "SPA 前端（多端共享 BFF 接口）",
    "BFF 层（Backend For Frontend，聚合下游服务）",
    "2~5 个领域微服务（按限界上下文划分）",
    "消息队列（RocketMQ/Kafka，服务间异步解耦）",
    "每服务独立数据库（或共享数据库 + Schema 隔离）",
    "Redis 缓存（共享或每服务独立）",
    "API 网关（可选，限流/鉴权）",
  ]),
});

/**
 * 蓝图 3：云原生微服务（cloud-native-microservice）
 *
 * 对齐 §5.6.2 表格：
 * - 拓扑：API Gateway + N 服务 + 服务发现 + 配置中心 + 链路追踪
 * - 适用信号：多系统集成、独立扩缩容诉求、DevOps 成熟
 * - 组件：API 网关 + N 个微服务 + 服务发现 + 配置中心 + 链路追踪 + 容器编排
 *
 * 适用场景：
 * - 多系统集成（与上下游/第三方系统对接）
 * - 各服务独立扩缩容诉求（不同负载特征）
 * - DevOps 成熟（CI/CD + 监控告警 + 日志聚合）
 * - 高并发量（> 5000 QPS）
 * - 多团队（> 20 人）协同开发
 */
const CLOUD_NATIVE_MICROSERVICE_BLUEPRINT: DeploymentBlueprint = Object.freeze({
  id: "cloud-native-microservice",
  name: "云原生微服务",
  topology: "API Gateway + N 服务 + 服务发现 + 配置中心 + 链路追踪",
  applicabilitySignals: Object.freeze([
    "多系统集成（与上下游/第三方系统对接）",
    "各服务独立扩缩容诉求",
    "DevOps 成熟（CI/CD + 监控告警 + 日志聚合）",
    "高并发量（> 5000 QPS）",
    "多团队（> 20 人）协同开发",
  ]),
  components: Object.freeze([
    "API 网关（Kong/APISIX，统一入口 + 限流 + 鉴权）",
    "N 个微服务（按业务域划分，独立部署）",
    "服务发现（Nacos/Consul/Eureka，服务注册与发现）",
    "配置中心（Nacos/Apollo，统一配置管理）",
    "链路追踪（Jaeger/SkyWalking，分布式调用链追踪）",
    "容器编排（Kubernetes，自动扩缩容与故障自愈）",
    "消息队列（Kafka/RocketMQ，事件驱动架构）",
    "每服务独立数据库（PostgreSQL/MySQL/MongoDB 按需）",
    "监控告警（Prometheus + Grafana）",
    "日志聚合（ELK/Loki，集中式日志查询）",
  ]),
});

// ============================================================================
// 蓝图注册表
// ============================================================================

/**
 * 部署蓝图注册表（3 套蓝图）
 *
 * 顺序对齐 §5.6.2 表格行序：
 * 1. spa-monolith（前后端分离单体）
 * 2. bff-microservice（BFF 微服务）
 * 3. cloud-native-microservice（云原生微服务）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
export const DEPLOYMENT_BLUEPRINTS: ReadonlyArray<DeploymentBlueprint> = Object.freeze([
  SPA_MONOLITH_BLUEPRINT,
  BFF_MICROSERVICE_BLUEPRINT,
  CLOUD_NATIVE_MICROSERVICE_BLUEPRINT,
]);

// ============================================================================
// 查询 API
// ============================================================================

/**
 * 按蓝图 ID 查询部署蓝图
 *
 * @param id 蓝图 ID（3 套蓝图之一）
 * @returns 蓝图定义；未找到返回 null
 */
export function getDeploymentBlueprintById(id: DeploymentBlueprintId): DeploymentBlueprint | null {
  for (const blueprint of DEPLOYMENT_BLUEPRINTS) {
    if (blueprint.id === id) {
      return blueprint;
    }
  }
  return null;
}

/**
 * 部署蓝图选择信号（6 个布尔维度）
 *
 * 对齐 §5.6.2 三套蓝图的适用信号：
 * - multiEnd：多端支持（Web + 移动端 + 小程序）
 * - domainBoundaryClear：领域边界已清晰划分
 * - teamGrouped：团队按领域分组开发
 * - multiSystemIntegration：多系统集成（与上下游/第三方对接）
 * - independentScaling：各服务独立扩缩容诉求
 * - devOpsMature：DevOps 成熟（CI/CD + 监控告警 + 日志聚合）
 *
 * 所有信号可选（缺省为 false），selectDeploymentBlueprint 按信号匹配度选择蓝图。
 */
export interface DeploymentBlueprintSignals {
  /** 多端支持（Web + 移动端 + 小程序） */
  readonly multiEnd?: boolean;
  /** 领域边界已清晰划分 */
  readonly domainBoundaryClear?: boolean;
  /** 团队按领域分组开发 */
  readonly teamGrouped?: boolean;
  /** 多系统集成（与上下游/第三方对接） */
  readonly multiSystemIntegration?: boolean;
  /** 各服务独立扩缩容诉求 */
  readonly independentScaling?: boolean;
  /** DevOps 成熟（CI/CD + 监控告警 + 日志聚合） */
  readonly devOpsMature?: boolean;
}

/**
 * 按信号匹配选择部署蓝图
 *
 * 匹配算法（优先级从高到低）：
 * 1. **云原生微服务蓝图**：multiSystemIntegration + independentScaling + devOpsMature
 *    三信号全部为 true 时选中（适用多系统集成 + 独立扩缩容 + DevOps 成熟场景）
 * 2. **BFF 微服务蓝图**：multiEnd + domainBoundaryClear + teamGrouped
 *    三信号全部为 true 时选中（适用多端 + 领域边界清晰 + 团队分组场景）
 * 3. **前后端分离单体蓝图**：默认兜底（不满足上述条件的场景，中小团队快速交付）
 *
 * 优先级说明：
 * - 云原生蓝图优先级最高——满足其信号的场景必然也满足 BFF/单体的部分信号，
 *   但云原生是最复杂的方案，需要更多信号支持才应选用
 * - BFF 蓝图次之——满足多端 + 领域清晰 + 团队分组但未达云原生门槛的场景
 * - 单体蓝图默认兜底——避免无信号匹配时返回 null 影响流程
 *
 * @param signals 部署蓝图选择信号（6 个布尔维度，缺省为 false）
 * @returns 匹配的部署蓝图（永远返回非 null，最差情况返回单体蓝图）
 */
export function selectDeploymentBlueprint(signals: DeploymentBlueprintSignals): DeploymentBlueprint {
  // 提取信号值（缺省为 false）
  const multiSystemIntegration = signals.multiSystemIntegration ?? false;
  const independentScaling = signals.independentScaling ?? false;
  const devOpsMature = signals.devOpsMature ?? false;
  const multiEnd = signals.multiEnd ?? false;
  const domainBoundaryClear = signals.domainBoundaryClear ?? false;
  const teamGrouped = signals.teamGrouped ?? false;

  // 优先级 1：云原生微服务蓝图
  // 三信号全部命中才选用（最复杂方案，需要最强信号支持）
  if (multiSystemIntegration && independentScaling && devOpsMature) {
    return CLOUD_NATIVE_MICROSERVICE_BLUEPRINT;
  }

  // 优先级 2：BFF 微服务蓝图
  // 三信号全部命中才选用（多端 + 领域清晰 + 团队分组）
  if (multiEnd && domainBoundaryClear && teamGrouped) {
    return BFF_MICROSERVICE_BLUEPRINT;
  }

  // 优先级 3：前后端分离单体蓝图（默认兜底）
  // 不满足上述条件的场景，返回最简单的单体方案
  return SPA_MONOLITH_BLUEPRINT;
}
