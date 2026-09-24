/**
 * EAG 编排器 CLI 装配模块 —— T1 下沉后的薄壳转发层（2026-09-24）
 *
 * 设计依据：docs/dev/eag-web-sedimentation-fixes.md §2.1（T1 装配下沉·方案 A）
 *
 * 本模块的三个 build* 工厂、生产级 LoopHandoffAdapter 与全部内部辅助已整体下沉至
 * core 包 `packages/core/src/eag/assembly.ts`（CLI / Web 共享的单一装配源），
 * 装配依赖（GoalDispatcher / 插件 / EagP5 / DESIGN Loop 组件）本就全部位于 core。
 *
 * 本文件保留为 re-export 薄壳的原因（兼容性铁律）：
 * - CLI 既有消费方（App.tsx）与既有测试（tests/eag-design-assembly.test.ts）
 *   经本路径导入，re-export 后 import 路径零修改、行为逐字节不变；
 * - fail-closed 语义（任一组件构造异常 → 返回 undefined）与装配日志文案
 *   均由 core 实现原样保留；
 * - CLI 专属的装配日志载体（~/.deepcodex/logs/eag-assembly.log 文件写入器）
 *   仍留在 CLI 侧（App.tsx createEagAssemblyLogger），经 log 形参注入 core 工厂。
 */

export {
  buildAutonomousOrchestrator,
  buildGraphLoopOrchestratorOptions,
  buildDesignOrchestrator,
  ProductionLoopHandoffAdapter,
} from "@vegamo/deepcode-core";
export type { AssemblyLogCallback, DesignLlmClientFactory } from "@vegamo/deepcode-core";
