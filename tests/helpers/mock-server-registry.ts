/**
 * vitest 全局 mock 共享登记表（T-045）
 *
 * 背景：
 * - `vitest.setup.ts` 必须把 `vi.mock(...)` 注册在 import 之前，因此工厂内部
 *   只能引用「已被 hoisted import 求值完成」的变量。
 * - 早期实现把 20+ 个模块工厂内联在 setup 中，可维护性差；后续接入
 *   `@/server/api-handlers/registry` 与 `@/lib/agent-sdk` 两个共享 mock 注册表时，
 *   若在 setup 顶层求值 `Object.entries(registry)` 再喂给工厂，就会与
 *   vitest 的 mock 提升机制打架（工厂在 import 求值前被调用 → 引用未初始化绑定）。
 *
 * 解决方案：
 * - 工厂内部**延迟**调用 `vi.importActual` + `getApiHandlerNames()`，
 *   即在被真正 require 时才求值；此时所有 hoisted import 均已就绪。
 * - 延迟求值的结果缓存在模块级 Promise 中，避免每个测试重复 importActual。
 * - 本 helper 同时提供 api-handlers / agent-sdk 两张注册表的统一入口，
 *   供 vitest.setup.ts 与单元测试复用。
 *
 * @module tests/helpers/mock-server-registry
 */
import { vi } from "vitest";

/** api-handlers 注册表模块 id（barrel） */
export const API_HANDLERS_MODULE = "@/server/api-handlers/registry";

/** agent-sdk 包装层模块 id */
export const AGENT_SDK_MODULE = "@/lib/agent-sdk";

/** 延迟加载缓存：模块 id → 实际模块命名空间 */
const actualCache = new Map<string, Promise<unknown>>();

/**
 * 延迟获取实际模块（首次调用后复用同一 Promise）。
 *
 * 之所以包一层缓存：vi.importActual 在工厂里被多次调用（每个用例每次
 * 重新解析模块时）会带来可观开销，而实际模块本身是无副作用的纯注册表。
 */
export function importActualCached<T = Record<string, unknown>>(moduleId: string): Promise<T> {
  let pending = actualCache.get(moduleId);
  if (!pending) {
    pending = vi.importActual<T>(moduleId);
    actualCache.set(moduleId, pending);
  }
  return pending;
}

/** 清除缓存（仅供测试自身复位使用） */
export function resetActualCache(): void {
  actualCache.clear();
}
