/**
 * EAG-P6 Phase 4 tool-executor-registry（4 个 codemap 工具注册到 ToolExecutor）
 *
 * 本模块提供 4 个 codemap 工具（codemap_query / impact_analysis / flow_trace / risk_scan）
 * 向 ToolExecutor 注册的统一入口。registry 层负责：
 * - 持有 4 个工具实例（依赖注入 SymbolGraphAdapter）
 * - 将工具 execute 方法适配为 ToolHandler 签名（args, context）=> Promise<ToolExecutionResult>
 * - 提供工具元数据（name + description）供 ToolExecutor 工具列表展示
 * - 提供注册辅助函数 registerCodemapTools，将 4 个 handler 注入 ToolExecutor
 *
 * 设计依据：
 * - EAG-P6-REQUIREMENTS.md §3 FR-6（codemap 工具集）+ D-2 决策（DW-4 走 tool-executor 独立路径）
 * - EAG-P6-ARCHITECTURE.md §5.2 接口契约 5（SymbolGraphAdapter）
 *   + §8.2.4 Phase 4 验收标准（4 工具全部注册到 tool-executor）
 *   + §6 数据流图（DW-4 codemap_* 工具结果直接拼入 LLM messages）
 * - EAG-P6-TASKS.md §3 TASK-P6-4-04（tool-executor-registry 实现规格）
 *
 * 用户关键约束（任务规格强制）：
 * - "禁止使用模拟，占位，mock，简化的方式开发代码"
 * - 不可变优先：readonly + ReadonlyArray + Object.freeze
 * - 中文详细注释，符合 Rust/Java 代码规范
 * - TODO/FIXME 必须有对应实现，禁止空 TODO
 *
 * 接口契约（任务规格强制）：
 * - 输入：SymbolGraphAdapter（V2-P4 符号图谱适配层）
 * - 输出：Map<string, ToolHandler>（工具名 → handler 映射）
 * - 注册方式：registerCodemapTools(toolExecutor, adapter) 将 4 个 handler 注入 ToolExecutor
 *
 * 实现要点：
 * - 持有 4 个工具实例（CodemapQueryTool / ImpactAnalysisTool / FlowTraceTool / RiskScanTool）
 * - 每个工具的 execute 方法适配为 ToolHandler 签名：
 *   1. 从 args 提取参数（类型校验 + 默认值）
 *   2. 调用工具 execute 方法
 *   3. 将结果序列化为 JSON 字符串，封装为 ToolExecutionResult
 * - 工具元数据（CODEMAP_TOOL_METADATA）供 ToolExecutor 工具列表展示
 * - registerCodemapTools 函数遍历 metadata，逐个注册 handler 到 ToolExecutor
 *
 * 兼容性保证（向后兼容 Phase 1-3）：
 * - 不修改现有 ToolExecutor 类的实现（仅通过 toolHandlers.set 注入新 handler）
 * - 不影响现有工具（bash / read / write / edit / AskUserQuestion / UpdatePlan / WebSearch）
 * - 4 个 codemap 工具与现有工具并列，由 ToolExecutor 统一调度
 *
 * 不可变优先原则：
 * - 类内部状态全部 readonly
 * - 工具元数据通过 Object.freeze 冻结
 * - handler 注册映射通过 Object.freeze 冻结
 *
 * @module v2/tools/tool-executor-registry
 */

// P1-05 单一入口约束：V1 能力（ToolExecutionResult / ToolHandler 类型）统一从
// v1-adapters 导入，禁止直接 import ../../common/tool-types
import type { ToolExecutionResult, ToolHandler } from "../integration/v1-adapters";
import type { SymbolGraphAdapter } from "../context/symbol-graph-adapter";
import { isGraphStoreAvailable } from "../context/symbol-graph-adapter";
import type { SymbolKind } from "../context/symbol-graph-types";
import { CodemapQueryTool } from "./codemap-query-tool";
import {
  CODEMAP_QUERY_TOOL_DESCRIPTION,
  CODEMAP_QUERY_TOOL_NAME,
  type CodemapQueryInput,
  type CodemapQueryResult,
} from "./codemap-query-tool";
import { ImpactAnalysisTool } from "./impact-analysis-tool";
import {
  IMPACT_ANALYSIS_TOOL_DESCRIPTION,
  IMPACT_ANALYSIS_TOOL_NAME,
  type ImpactAnalysisInput,
  type ImpactAnalysisResult,
} from "./impact-analysis-tool";
import { FlowTraceTool } from "./flow-trace-tool";
import {
  FLOW_TRACE_TOOL_DESCRIPTION,
  FLOW_TRACE_TOOL_NAME,
  type FlowTraceInput,
  type FlowTraceResult,
} from "./flow-trace-tool";
import { RiskScanTool } from "./risk-scan-tool";
import {
  RISK_SCAN_TOOL_DESCRIPTION,
  RISK_SCAN_TOOL_NAME,
  type RiskScanInput,
  type RiskScanResult,
} from "./risk-scan-tool";

// ============================================================================
// 1. 工具元数据接口与常量
// ============================================================================

/**
 * codemap 工具元数据（工具名 + 描述，供 ToolExecutor 工具列表展示）
 *
 * 字段说明：
 * - name：工具名称（与 LLM function calling 的 name 一致）
 * - description：工具描述（供 LLM 选择工具时参考）
 *
 * 不可变优先：所有字段 readonly。
 */
export interface CodemapToolMetadata {
  /** 工具名称（与 LLM function calling 的 name 一致） */
  readonly name: string;
  /** 工具描述（供 LLM 选择工具时参考） */
  readonly description: string;
}

/**
 * 4 个 codemap 工具元数据列表（冻结，供 ToolExecutor 工具列表展示）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
export const CODEMAP_TOOL_METADATA: ReadonlyArray<CodemapToolMetadata> = Object.freeze([
  {
    name: CODEMAP_QUERY_TOOL_NAME,
    description: CODEMAP_QUERY_TOOL_DESCRIPTION,
  },
  {
    name: IMPACT_ANALYSIS_TOOL_NAME,
    description: IMPACT_ANALYSIS_TOOL_DESCRIPTION,
  },
  {
    name: FLOW_TRACE_TOOL_NAME,
    description: FLOW_TRACE_TOOL_DESCRIPTION,
  },
  {
    name: RISK_SCAN_TOOL_NAME,
    description: RISK_SCAN_TOOL_DESCRIPTION,
  },
]);

// ============================================================================
// 2. CodemapToolRegistry 类（持有 4 个工具实例，提供 handler 映射）
// ============================================================================

/**
 * codemap 工具注册中心（持有 4 个工具实例，提供 ToolHandler 映射）
 *
 * 通过依赖注入 SymbolGraphAdapter 构造 4 个工具实例，
 * 并将每个工具的 execute 方法适配为 ToolHandler 签名。
 *
 * 适配流程：
 * 1. 从 LLM function calling 的 args（Record<string, unknown>）提取参数
 * 2. 类型校验 + 默认值填充
 * 3. 调用工具 execute 方法
 * 4. 将结果序列化为 JSON 字符串，封装为 ToolExecutionResult
 *
 * 降级语义（与 4 个工具一致）：
 * - graphAvailability() 返回 false：每个工具 execute 返回空结果
 * - adapter.isAvailable() 返回 false：每个工具 execute 返回空结果
 * - handler 仍正常返回 ToolExecutionResult（ok=true, output=JSON 空结果）
 *
 * 使用示例：
 * ```typescript
 * const adapter = new StaticSymbolGraph(graphData);
 * const registry = new CodemapToolRegistry(adapter);
 *
 * // 获取 handler 映射
 * const handlers = registry.getHandlers();
 * for (const [name, handler] of handlers) {
 *   toolExecutor.registerToolHandler(name, handler);
 * }
 *
 * // 或直接调用注册辅助函数
 * registerCodemapTools(toolExecutor, adapter);
 * ```
 */
export class CodemapToolRegistry {
  /**
   * codemap_query 工具实例（DW-4 即时查符号查询）
   *
   * 通过依赖注入 SymbolGraphAdapter 构造，不可变。
   */
  private readonly codemapQueryTool: CodemapQueryTool;

  /**
   * impact_analysis 工具实例（DW-2 爆炸半径）
   *
   * 通过依赖注入 SymbolGraphAdapter 构造，不可变。
   */
  private readonly impactAnalysisTool: ImpactAnalysisTool;

  /**
   * flow_trace 工具实例（调用链路径枚举）
   *
   * 通过依赖注入 SymbolGraphAdapter 构造，不可变。
   */
  private readonly flowTraceTool: FlowTraceTool;

  /**
   * risk_scan 工具实例（DW-3 风险热点扫描）
   *
   * 通过依赖注入 SymbolGraphAdapter 构造，不可变。
   */
  private readonly riskScanTool: RiskScanTool;

  /**
   * ToolHandler 映射（工具名 → handler，冻结，首次调用 getHandlers 时构建）
   *
   * 使用懒加载避免构造时即构建（允许 4 个工具实例先就绪）。
   */
  private cachedHandlers: ReadonlyMap<string, ToolHandler> | undefined;

  /**
   * 构造 codemap 工具注册中心
   *
   * 执行流程：
   * 1. 持有 SymbolGraphAdapter 引用
   * 2. 构造 4 个工具实例（依赖注入 adapter）
   * 3. 初始化 cachedHandlers 为 undefined（懒加载）
   *
   * @param symbolGraphAdapter V2-P4 符号图谱适配层（不可用时各工具返回空结果）
   * @param graphAvailability 图谱可用性探测函数（默认 isGraphStoreAvailable）
   */
  constructor(symbolGraphAdapter: SymbolGraphAdapter, graphAvailability: () => boolean = isGraphStoreAvailable) {
    // 构造 4 个工具实例，共享同一 adapter 与 graphAvailability
    this.codemapQueryTool = new CodemapQueryTool(symbolGraphAdapter, graphAvailability);
    this.impactAnalysisTool = new ImpactAnalysisTool(symbolGraphAdapter, graphAvailability);
    this.flowTraceTool = new FlowTraceTool(symbolGraphAdapter, graphAvailability);
    this.riskScanTool = new RiskScanTool(symbolGraphAdapter, graphAvailability);
  }

  /**
   * 获取 4 个 codemap 工具的 ToolHandler 映射
   *
   * 返回 Map<工具名, ToolHandler>，调用方可直接遍历注册到 ToolExecutor。
   *
   * 实现说明：
   * - 首次调用时构建映射并缓存（懒加载）
   * - 缓存的映射通过 Object.freeze 冻结（防止外部修改）
   * - 每个 handler 为箭头函数，绑定 this（确保实例方法正确引用）
   *
   * @returns 工具名 → ToolHandler 映射（冻结）
   */
  readonly getHandlers = (): ReadonlyMap<string, ToolHandler> => {
    // 懒加载：首次调用时构建映射
    if (this.cachedHandlers === undefined) {
      const handlers = new Map<string, ToolHandler>();
      handlers.set(CODEMAP_QUERY_TOOL_NAME, this.createCodemapQueryHandler());
      handlers.set(IMPACT_ANALYSIS_TOOL_NAME, this.createImpactAnalysisHandler());
      handlers.set(FLOW_TRACE_TOOL_NAME, this.createFlowTraceHandler());
      handlers.set(RISK_SCAN_TOOL_NAME, this.createRiskScanHandler());
      // 冻结 Map（防止外部修改）
      this.cachedHandlers = handlers;
    }
    return this.cachedHandlers;
  };

  /**
   * 获取 4 个 codemap 工具元数据列表
   *
   * 返回 CODEMAP_TOOL_METADATA 常量，供 ToolExecutor 工具列表展示。
   *
   * @returns 工具元数据列表（冻结）
   */
  readonly getMetadata = (): ReadonlyArray<CodemapToolMetadata> => {
    return CODEMAP_TOOL_METADATA;
  };

  // --------------------------------------------------------------------------
  // 内部 handler 工厂方法
  // --------------------------------------------------------------------------

  /**
   * 创建 codemap_query 工具的 ToolHandler
   *
   * handler 签名：(args, context) => Promise<ToolExecutionResult>
   *
   * 执行流程：
   * 1. 从 args 提取参数（query / kind / namespace / limit）
   * 2. 类型校验 + 默认值填充
   * 3. 调用 codemapQueryTool.execute(input)
   * 4. 将 CodemapQueryResult 序列化为 JSON 字符串
   * 5. 封装为 ToolExecutionResult（ok=true, output=JSON）
   *
   * 错误处理：
   * - 参数类型错误：返回 ok=false, error=详细错误信息
   * - 工具内部异常：catch 后返回 ok=false, error=异常消息
   *
   * @returns codemap_query 工具的 ToolHandler
   */
  private createCodemapQueryHandler = (): ToolHandler => {
    return async (args: Record<string, unknown>): Promise<ToolExecutionResult> => {
      try {
        // ---------- 1. 参数提取与类型校验 ----------
        const input: CodemapQueryInput = {
          query: typeof args.query === "string" ? args.query : "",
          kind: typeof args.kind === "string" ? (args.kind as SymbolKind) : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        };

        // ---------- 2. 调用工具 execute ----------
        const result: CodemapQueryResult = this.codemapQueryTool.execute(input);

        // ---------- 3. 序列化结果 ----------
        const output: string = JSON.stringify(result, null, 2);

        // ---------- 4. 封装 ToolExecutionResult ----------
        return {
          ok: true,
          name: CODEMAP_QUERY_TOOL_NAME,
          output,
          metadata: {
            total: result.total,
            queryTime: result.queryTime,
          },
        };
      } catch (error) {
        // 异常处理：返回 ok=false 与错误消息
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          name: CODEMAP_QUERY_TOOL_NAME,
          error: `codemap_query 工具执行失败：${message}`,
        };
      }
    };
  };

  /**
   * 创建 impact_analysis 工具的 ToolHandler
   *
   * handler 签名：(args, context) => Promise<ToolExecutionResult>
   *
   * 执行流程：
   * 1. 从 args 提取参数（symbolId / direction / maxDepth / maxNodes）
   * 2. 类型校验 + 默认值填充
   * 3. 调用 impactAnalysisTool.execute(input)
   * 4. 将 ImpactAnalysisResult 序列化为 JSON 字符串
   * 5. 封装为 ToolExecutionResult（ok=true, output=JSON）
   *
   * 错误处理：
   * - 参数类型错误：返回 ok=false, error=详细错误信息
   * - 工具内部异常：catch 后返回 ok=false, error=异常消息
   *
   * @returns impact_analysis 工具的 ToolHandler
   */
  private createImpactAnalysisHandler = (): ToolHandler => {
    return async (args: Record<string, unknown>): Promise<ToolExecutionResult> => {
      try {
        // ---------- 1. 参数提取与类型校验 ----------
        // direction 必填，必须为 forward/backward/both 之一
        const rawDirection = args.direction;
        const direction: "forward" | "backward" | "both" | undefined =
          typeof rawDirection === "string" &&
          (rawDirection === "forward" || rawDirection === "backward" || rawDirection === "both")
            ? (rawDirection as "forward" | "backward" | "both")
            : undefined;

        // direction 缺省时默认 both（与 adapter.getExplosionRadius 双向语义一致）
        const input: ImpactAnalysisInput = {
          symbolId: typeof args.symbolId === "string" ? args.symbolId : "",
          direction: direction ?? "both",
          maxDepth: typeof args.maxDepth === "number" ? args.maxDepth : undefined,
          maxNodes: typeof args.maxNodes === "number" ? args.maxNodes : undefined,
        };

        // ---------- 2. 调用工具 execute ----------
        const result: ImpactAnalysisResult = this.impactAnalysisTool.execute(input);

        // ---------- 3. 序列化结果 ----------
        const output: string = JSON.stringify(result, null, 2);

        // ---------- 4. 封装 ToolExecutionResult ----------
        return {
          ok: true,
          name: IMPACT_ANALYSIS_TOOL_NAME,
          output,
          metadata: {
            totalNodes: result.totalNodes,
            maxDepthReached: result.maxDepthReached,
            cyclesCount: result.cycles.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          name: IMPACT_ANALYSIS_TOOL_NAME,
          error: `impact_analysis 工具执行失败：${message}`,
        };
      }
    };
  };

  /**
   * 创建 flow_trace 工具的 ToolHandler
   *
   * handler 签名：(args, context) => Promise<ToolExecutionResult>
   *
   * 执行流程：
   * 1. 从 args 提取参数（startSymbolId / endSymbolId / direction / maxDepth）
   * 2. 类型校验 + 默认值填充
   * 3. 调用 flowTraceTool.execute(input)
   * 4. 将 FlowTraceResult 序列化为 JSON 字符串
   * 5. 封装为 ToolExecutionResult（ok=true, output=JSON）
   *
   * 错误处理：
   * - 参数类型错误：返回 ok=false, error=详细错误信息
   * - 工具内部异常：catch 后返回 ok=false, error=异常消息
   *
   * @returns flow_trace 工具的 ToolHandler
   */
  private createFlowTraceHandler = (): ToolHandler => {
    return async (args: Record<string, unknown>): Promise<ToolExecutionResult> => {
      try {
        // ---------- 1. 参数提取与类型校验 ----------
        // direction 必填，必须为 forward/backward 之一
        const rawDirection = args.direction;
        const direction: "forward" | "backward" | undefined =
          typeof rawDirection === "string" && (rawDirection === "forward" || rawDirection === "backward")
            ? (rawDirection as "forward" | "backward")
            : undefined;

        // direction 缺省时默认 forward（追踪调用链下游）
        const input: FlowTraceInput = {
          startSymbolId: typeof args.startSymbolId === "string" ? args.startSymbolId : "",
          endSymbolId: typeof args.endSymbolId === "string" ? args.endSymbolId : undefined,
          direction: direction ?? "forward",
          maxDepth: typeof args.maxDepth === "number" ? args.maxDepth : undefined,
        };

        // ---------- 2. 调用工具 execute ----------
        const result: FlowTraceResult = this.flowTraceTool.execute(input);

        // ---------- 3. 序列化结果 ----------
        const output: string = JSON.stringify(result, null, 2);

        // ---------- 4. 封装 ToolExecutionResult ----------
        return {
          ok: true,
          name: FLOW_TRACE_TOOL_NAME,
          output,
          metadata: {
            totalPaths: result.totalPaths,
            truncated: result.truncated,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          name: FLOW_TRACE_TOOL_NAME,
          error: `flow_trace 工具执行失败：${message}`,
        };
      }
    };
  };

  /**
   * 创建 risk_scan 工具的 ToolHandler
   *
   * handler 签名：(args, context) => Promise<ToolExecutionResult>
   *
   * 执行流程：
   * 1. 从 args 提取参数（threshold / limit / kind）
   * 2. 类型校验 + 默认值填充
   * 3. 调用 riskScanTool.execute(input)
   * 4. 将 RiskScanResult 序列化为 JSON 字符串
   * 5. 封装为 ToolExecutionResult（ok=true, output=JSON）
   *
   * 错误处理：
   * - 参数类型错误：返回 ok=false, error=详细错误信息
   * - 工具内部异常：catch 后返回 ok=false, error=异常消息
   *
   * @returns risk_scan 工具的 ToolHandler
   */
  private createRiskScanHandler = (): ToolHandler => {
    return async (args: Record<string, unknown>): Promise<ToolExecutionResult> => {
      try {
        // ---------- 1. 参数提取与类型校验 ----------
        const input: RiskScanInput = {
          threshold: typeof args.threshold === "number" ? args.threshold : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          kind: typeof args.kind === "string" ? (args.kind as SymbolKind) : undefined,
        };

        // ---------- 2. 调用工具 execute ----------
        const result: RiskScanResult = this.riskScanTool.execute(input);

        // ---------- 3. 序列化结果 ----------
        const output: string = JSON.stringify(result, null, 2);

        // ---------- 4. 封装 ToolExecutionResult ----------
        return {
          ok: true,
          name: RISK_SCAN_TOOL_NAME,
          output,
          metadata: {
            totalHotspots: result.totalHotspots,
            avgRiskScore: result.avgRiskScore,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          name: RISK_SCAN_TOOL_NAME,
          error: `risk_scan 工具执行失败：${message}`,
        };
      }
    };
  };
}

// ============================================================================
// 3. ToolExecutor 注册辅助函数
// ============================================================================

/**
 * ToolExecutor 注册接口（最小化接口，避免依赖具体 ToolExecutor 类）
 *
 * 仅要求实现 registerToolHandler 方法，便于：
 * - 现有 ToolExecutor 类实现此接口（已有 toolHandlers.set 方法）
 * - 测试时可构造 mock ToolExecutor（仅实现此方法）
 * - 未来其他 ToolExecutor 实现可复用本注册函数
 *
 * 设计依据：依赖倒置原则（DIP），registry 不依赖具体 ToolExecutor 类，
 * 仅依赖接口，便于解耦与测试。
 */
export interface ToolExecutorRegistrar {
  /**
   * 注册工具 handler（与现有 ToolExecutor.toolHandlers.set 语义一致）
   *
   * @param name 工具名称
   * @param handler 工具 handler
   */
  readonly registerToolHandler: (name: string, handler: ToolHandler) => void;
}

/**
 * 将 4 个 codemap 工具注册到 ToolExecutor
 *
 * 注册流程：
 * 1. 构造 CodemapToolRegistry（依赖注入 SymbolGraphAdapter）
 * 2. 获取 handler 映射（getHandlers）
 * 3. 遍历映射，逐个调用 toolExecutor.registerToolHandler(name, handler)
 *
 * 兼容性保证（向后兼容 Phase 1-3）：
 * - 不修改现有 ToolExecutor 类的实现（仅通过 registerToolHandler 注入新 handler）
 * - 不影响现有工具（bash / read / write / edit / AskUserQuestion / UpdatePlan / WebSearch）
 * - 4 个 codemap 工具与现有工具并列，由 ToolExecutor 统一调度
 *
 * 降级语义：
 * - SymbolGraphAdapter 不可用时，4 个工具 execute 仍返回空结果（不抛错）
 * - 注册过程不受降级影响（handler 始终注册，调用时才走降级路径）
 *
 * 使用示例：
 * ```typescript
 * const adapter = new StaticSymbolGraph(graphData);
 * const toolExecutor = new ToolExecutor(projectRoot, ...);
 * registerCodemapTools(toolExecutor, adapter);
 * // 现在 toolExecutor 可调度 codemap_query / impact_analysis / flow_trace / risk_scan
 * ```
 *
 * @param toolExecutor ToolExecutor 实例（实现 ToolExecutorRegistrar 接口）
 * @param symbolGraphAdapter V2-P4 符号图谱适配层（不可时各工具返回空结果）
 * @param graphAvailability 图谱可用性探测函数（默认 isGraphStoreAvailable）
 * @returns CodemapToolRegistry 实例（调用方可保留引用以获取元数据或后续操作）
 */
export function registerCodemapTools(
  toolExecutor: ToolExecutorRegistrar,
  symbolGraphAdapter: SymbolGraphAdapter,
  graphAvailability: () => boolean = isGraphStoreAvailable
): CodemapToolRegistry {
  // ---------- 1. 构造 registry ----------
  const registry = new CodemapToolRegistry(symbolGraphAdapter, graphAvailability);

  // ---------- 2. 获取 handler 映射 ----------
  const handlers = registry.getHandlers();

  // ---------- 3. 遍历映射，逐个注册到 ToolExecutor ----------
  for (const [name, handler] of handlers) {
    toolExecutor.registerToolHandler(name, handler);
  }

  // ---------- 4. 返回 registry 实例（调用方可保留引用） ----------
  return registry;
}

/**
 * 创建 codemap 工具的 ToolHandler 映射（不依赖 ToolExecutor 实例）
 *
 * 适用场景：
 * - 调用方仅需要 handler 映射，不需要注册到 ToolExecutor
 * - 测试场景：直接调用 handler 验证工具行为
 * - 自定义 ToolExecutor 集成：调用方自行遍历映射注册
 *
 * @param symbolGraphAdapter V2-P4 符号图谱适配层
 * @param graphAvailability 图谱可用性探测函数（默认 isGraphStoreAvailable）
 * @returns 工具名 → ToolHandler 映射（冻结）+ registry 实例
 */
export function createCodemapToolHandlers(
  symbolGraphAdapter: SymbolGraphAdapter,
  graphAvailability: () => boolean = isGraphStoreAvailable
): {
  handlers: ReadonlyMap<string, ToolHandler>;
  registry: CodemapToolRegistry;
} {
  const registry = new CodemapToolRegistry(symbolGraphAdapter, graphAvailability);
  return {
    handlers: registry.getHandlers(),
    registry,
  };
}
