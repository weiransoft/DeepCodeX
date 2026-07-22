/**
 * EAG Deploy 模块 barrel 导出（EAG-P4 批次 14 Phase 2 TASK-14-2-4）
 *
 * 本模块统一导出 DEPLOY 子阶段相关的部署策略实现，供外部消费者从单一入口导入。
 *
 * 导出内容：
 * - RollingStrategy（rolling-strategy.ts）：滚动发布策略实现（B-14-1 Blocker 修复）
 * - BlueGreenStrategy（blue-green-strategy.ts）：蓝绿发布策略实现（FR-5）
 * - CanaryStrategy（canary-strategy.ts）：金丝雀发布策略实现（FR-6，K-2 决策）
 *
 * 设计原则：
 * - 三种策略同构：均实现 DeployStrategy 接口，构造函数注入 + execute() 签名 + DeployResult 返回值
 * - 不可变优先：所有策略实例通过 Object.freeze 冻结，execute() 返回值通过 Object.freeze 冻结
 * - 真实 kubectl 调用：通过 child_process.spawn 真实调用 kubectl CLI（禁止 shell:true）
 * - 中文详细注释：所有类与方法必须有中文 JSDoc
 *
 * 调用方使用方式：
 *   import { RollingStrategy, BlueGreenStrategy, CanaryStrategy } from "./eag/deploy";
 *   const rolling = new RollingStrategy({ timeoutMs: 300000 });
 *   const blueGreen = new BlueGreenStrategy({ timeoutMs: 300000, keepBlue: false });
 *   const canary = new CanaryStrategy({ canarySteps: [10, 50, 100] });
 *
 * 设计依据：
 * - EAG-P4 批次 14 架构师审查 §3.1.1 Phase 2 文件清单（rolling / blue-green / canary）
 * - §3.2.1 修改文件清单：deploy/index.ts（如存在，否则创建）新增导出三个策略类
 * - B-14-1 Blocker 修复：RollingStrategy 真实实现
 * - FR-5：BlueGreenStrategy 实现
 * - FR-6 + K-2 决策：CanaryStrategy 实现（kubectl patch 副本数方案）
 *
 * @module eag/deploy
 */

// ============================================================================
// 部署策略导出（Phase 2，3 个策略类）
// ============================================================================

/**
 * RollingStrategy —— 滚动发布策略实现（B-14-1 Blocker 修复）
 *
 * 真实调用 kubectl CLI 流程：
 * 1. kubectl apply -f <manifest.yaml> 应用 IaC 模板
 * 2. kubectl rollout status deployment/<name> -n <ns> --timeout=<timeoutMs>ms 等待 rollout 完成
 * 3. kubectl get deployment,service -n <ns> -o json 解析已部署资源列表
 *
 * 失败处理（错误内化，不抛异常）：
 * - kubectl apply 失败：返回 success=false + errors 含 kubectl 错误信息
 * - kubectl rollout status 超时：返回 success=false + errors 含 "rollout status 超时"
 * - kubectl get 失败：返回 success=true（apply 已成功）但 resources 为空数组 + errors 含警告
 *
 * 不可变优先：
 * - execute() 返回的 DeployResult 通过 Object.freeze 冻结
 * - 构造函数 Object.freeze 冻结实例
 */
export { RollingStrategy } from "./rolling-strategy";

/**
 * BlueGreenStrategy —— 蓝绿发布策略实现（FR-5）
 *
 * 真实调用 kubectl CLI 流程：
 * 1. 部署 Green Deployment（带 version: green label）
 * 2. kubectl rollout status 等待 Green Pod Ready
 * 3. kubectl patch service 切换 selector 到 version: green（流量切换到 Green）
 * 4. kubectl delete deployment <name>-blue 清理旧 Blue（keepBlue=true 时跳过）
 *
 * 失败恢复（R-14-1 缓解 A-1）：
 * - Green Pod 未 Ready：返回 success=false，不切换流量（Blue 继续提供服务）
 * - 流量切换失败：best-effort 回切 Service 到 Blue，返回 success=false
 * - Blue 清理失败：仅记录警告，不影响部署成功状态（best-effort）
 */
export { BlueGreenStrategy } from "./blue-green-strategy";

/**
 * CanaryStrategy —— 金丝雀发布策略实现（FR-6，K-2 决策）
 *
 * 真实调用 kubectl CLI 流程（K-2 决策：kubectl patch 副本数方案）：
 * 1. 部署 Canary Deployment（带 track: canary label，副本数初始为 0）
 * 2. 按流量阶梯循环（canarySteps 数组）：
 *    - 计算 Canary 副本数 = Math.ceil(totalReplicas * step / 100)
 *    - kubectl scale deployment/<name>-canary --replicas=<N>
 *    - kubectl rollout status 等待 Canary Pod Ready
 *    - HTTP GET /healthz 验证健康状态
 *    - 失败时立即返回 success=false（保留 Canary 资源，R-14-1 缓解 A-1）
 * 3. 全部阶梯通过后：kubectl delete deployment <name> 删除 Stable Deployment
 *
 * 构造期校验（K-2 决策）：
 * - canarySteps 数组非空、元素为正整数、0~100 范围、结尾必须为 100
 * - 不满足时抛错（不允许默认值兜底）
 */
export { CanaryStrategy } from "./canary-strategy";
