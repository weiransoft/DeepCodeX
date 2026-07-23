/**
 * 边解析器实现（v2.0 实现，对齐设计文档 §8.2）
 *
 * 本模块实现 EdgeResolverProtocol，负责解析边契约，将源节点的输出数据
 * 映射到目标节点的输入数据，并按目标节点的 inputContract 进行字段校验。
 *
 * 解析规则（对齐 §7.3 dataMapping 定义）：
 * - dataMapping 的 key = 目标节点的输入字段名
 * - dataMapping 的 value = 源字段路径，支持以下三种格式：
 *   1. "output.fieldName" 或 "output.field.subfield"：从 sourceOutput 中取对应路径
 *      （"output." 前缀是冗余写法，对齐 §16.3 JSON 示例，实际从 sourceOutput 中取 fieldName）
 *   2. "$state.fieldName"：从 globalState 中取对应路径（图级共享状态）
 *   3. "fieldName" 或 "field.subfield"：直接从 sourceOutput 中取对应路径（简写格式）
 *
 * 校验规则（对齐 §7.2 NodeFieldContract）：
 * - required=true 但无法解析到值且无 defaultValue → 抛出 Error
 * - required=false 且无法解析到值但有 defaultValue → 填充 defaultValue
 * - required=false 且无法解析到值且无 defaultValue → 忽略该字段（不写入输入数据）
 * - 字段类型校验（type !== "any" 时执行 typeof / Array.isArray 检查，不匹配时抛出 Error）
 *
 * 多边合并（merge 场景）：
 * - 当传入多条边时（merge 节点场景），按边顺序依次解析 dataMapping
 * - 后解析的字段覆盖先解析的同名字段（通常 merge 场景每条边映射不同字段，不会冲突）
 *
 * @module eag/graph/graph-edge-resolver
 */

import type {
  /** 图边定义 */
  GraphEdgeDef,
  /** 图节点定义 */
  GraphNodeDef,
  /** 节点字段契约 */
  NodeFieldContract,
} from "./graph-loop-models";
import type { EdgeResolverProtocol } from "./graph-loop-protocols";

// ============================================================================
// 常量
// ============================================================================

/**
 * 全局状态字段路径前缀
 *
 * dataMapping 中以 "$state." 开头的 value 表示从 globalState 中取字段。
 * 示例："$state.userId" → globalState.userId
 */
const GLOBAL_STATE_PREFIX = "$state.";

/**
 * output 字段路径前缀
 *
 * dataMapping 中以 "output." 开头的 value 表示从 sourceOutput 中取字段（对齐 §16.3 JSON 示例）。
 * "output." 前缀是冗余写法，实际从 sourceOutput 中取剩余路径。
 * 示例："output.designDoc" → sourceOutput.designDoc
 */
const OUTPUT_PREFIX = "output.";

// ============================================================================
// EdgeResolverImpl 实现类
// ============================================================================

/**
 * 边解析器实现类
 *
 * 实现 EdgeResolverProtocol，提供 resolve 方法解析边契约并构造目标节点输入数据。
 *
 * 使用示例：
 * ```typescript
 * const resolver = new EdgeResolverImpl();
 *
 * const edges: GraphEdgeDef[] = [{
 *   edgeId: "e1", from: "design", to: "coding",
 *   dataMapping: { "designDoc": "output.designDoc", "apiSpec": "output.apiSpec" }
 * }];
 *
 * const sourceOutput = { designDoc: "设计文档内容", apiSpec: { endpoints: [] } };
 * const targetNode = nodesMap.get("coding")!;
 *
 * const input = resolver.resolve(edges, sourceOutput, targetNode, globalState);
 * // input = { designDoc: "设计文档内容", apiSpec: { endpoints: [] } }
 * ```
 */
export class EdgeResolverImpl implements EdgeResolverProtocol {
  /**
   * 解析边契约，构造目标节点的输入数据
   *
   * @param edges 从源节点到目标节点的所有边（merge 场景为多条，普通场景为单条）
   * @param sourceOutput 源节点的输出数据（GraphNodeResult.output，merge 场景为合并后的输出对象）
   * @param targetNode 目标节点定义（用于读取 inputContract 进行字段校验）
   * @param globalState 图级共享状态（供 dataMapping 引用全局字段，如 "$state.userId"）
   * @returns 目标节点的输入数据（符合 targetNode.inputContract 声明的字段规范）
   * @throws {Error} 当 required 字段无法解析且无 defaultValue 时抛出
   * @throws {Error} 当字段类型校验失败时抛出
   */
  resolve(
    edges: ReadonlyArray<GraphEdgeDef>,
    sourceOutput: Readonly<Record<string, unknown>>,
    targetNode: Readonly<GraphNodeDef>,
    globalState: Readonly<Record<string, unknown>>
  ): Readonly<Record<string, unknown>> {
    // 1. 构造输入数据容器（可变，最终返回前冻结）
    const input: Record<string, unknown> = {};

    // 2. 遍历所有边，按 dataMapping 映射字段
    for (const edge of edges) {
      for (const [targetField, sourcePath] of Object.entries(edge.dataMapping)) {
        // 解析源字段路径，从 sourceOutput 或 globalState 中取值
        const value = this.resolveFieldValue(sourcePath, sourceOutput, globalState);
        if (value !== undefined) {
          input[targetField] = value;
        }
      }
    }

    // 3. 按 inputContract 校验字段（必填性、类型、默认值）
    this.validateAndFillDefaults(input, targetNode.inputContract, targetNode.nodeId);

    // 4. 返回冻结的输入数据（防止节点执行器修改原始数据）
    return Object.freeze(input);
  }

  /**
   * 解析字段路径，从 sourceOutput 或 globalState 中取值
   *
   * 路径格式：
   * - "output.fieldName" 或 "output.field.subfield"：从 sourceOutput 中取（去掉 "output." 前缀）
   * - "$state.fieldName"：从 globalState 中取（去掉 "$state." 前缀）
   * - "fieldName" 或 "field.subfield"：直接从 sourceOutput 中取
   *
   * @param sourcePath 字段路径（dataMapping 的 value）
   * @param sourceOutput 源节点输出数据
   * @param globalState 图级共享状态
   * @returns 字段值（无法解析时返回 undefined）
   */
  private resolveFieldValue(
    sourcePath: string,
    sourceOutput: Readonly<Record<string, unknown>>,
    globalState: Readonly<Record<string, unknown>>
  ): unknown {
    // 1. 处理 "$state." 前缀：从 globalState 中取值
    if (sourcePath.startsWith(GLOBAL_STATE_PREFIX)) {
      const path = sourcePath.slice(GLOBAL_STATE_PREFIX.length);
      return this.getPathValue(path, globalState);
    }

    // 2. 处理 "output." 前缀：从 sourceOutput 中取值（去掉冗余前缀）
    if (sourcePath.startsWith(OUTPUT_PREFIX)) {
      const path = sourcePath.slice(OUTPUT_PREFIX.length);
      return this.getPathValue(path, sourceOutput);
    }

    // 3. 无前缀：直接从 sourceOutput 中取值
    return this.getPathValue(sourcePath, sourceOutput);
  }

  /**
   * 按点号路径从对象中取值
   *
   * 支持多级路径：如 "result.score" → obj.result.score
   *
   * @param path 点号分隔的字段路径（如 "field.subfield"）
   * @param obj 源对象
   * @returns 字段值（路径中任一层级为 null/undefined 或非对象时返回 undefined）
   */
  private getPathValue(path: string, obj: Readonly<Record<string, unknown>>): unknown {
    // 空路径直接返回 undefined
    if (!path) {
      return undefined;
    }

    // 按点号分割路径
    const parts = path.split(".");
    let current: unknown = obj;

    for (const part of parts) {
      // 当前层级为 null 或 undefined → 路径中断，返回 undefined
      if (current === null || current === undefined) {
        return undefined;
      }
      // 当前层级不是对象 → 无法继续取子字段，返回 undefined
      if (typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }
      // 取下一层级
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  /**
   * 按 inputContract 校验字段并填充默认值
   *
   * 校验规则：
   * - required=true 但字段不存在且无 defaultValue → 抛出 Error
   * - required=false 且字段不存在但有 defaultValue → 填充 defaultValue
   * - 字段存在时执行类型校验（type !== "any" 时）
   *
   * @param input 输入数据（可变，校验过程中填充默认值）
   * @param contracts 字段契约列表
   * @param nodeId 目标节点 ID（用于错误提示）
   * @throws {Error} 当 required 字段缺失且无 defaultValue 时抛出
   * @throws {Error} 当字段类型校验失败时抛出
   */
  private validateAndFillDefaults(
    input: Record<string, unknown>,
    contracts: ReadonlyArray<NodeFieldContract>,
    nodeId: string
  ): void {
    for (const contract of contracts) {
      const hasField = Object.prototype.hasOwnProperty.call(input, contract.name);
      const value = input[contract.name];

      // 1. 必填字段缺失处理
      if (!hasField || value === undefined) {
        if (contract.required) {
          // 必填字段缺失且有默认值 → 使用默认值
          if (contract.defaultValue !== undefined) {
            input[contract.name] = contract.defaultValue;
            continue;
          }
          // 必填字段缺失且无默认值 → 抛出错误
          throw new Error(
            `EdgeResolver: 节点 ${nodeId} 的必填输入字段 "${contract.name}" 无法解析（required=true 且无 defaultValue）`
          );
        }
        // 非必填字段缺失：有默认值则填充，否则忽略
        if (contract.defaultValue !== undefined) {
          input[contract.name] = contract.defaultValue;
        }
        continue;
      }

      // 2. 字段存在时执行类型校验（type !== "any" 时）
      if (contract.type !== "any") {
        this.validateFieldType(contract.name, value, contract.type, nodeId);
      }
    }
  }

  /**
   * 校验字段值是否符合契约声明的类型
   *
   * 类型映射：
   * - "string"  → typeof value === "string"
   * - "number"  → typeof value === "number" && !isNaN(value)
   * - "boolean" → typeof value === "boolean"
   * - "object"  → typeof value === "object" && value !== null && !Array.isArray(value)
   * - "array"   → Array.isArray(value)
   * - "any"     → 不校验（任意类型都通过）
   *
   * @param fieldName 字段名
   * @param value 字段值
   * @param expectedType 期望类型
   * @param nodeId 节点 ID（用于错误提示）
   * @throws {Error} 当类型不匹配时抛出
   */
  private validateFieldType(
    fieldName: string,
    value: unknown,
    expectedType: NodeFieldContract["type"],
    nodeId: string
  ): void {
    let typeMatched = false;

    switch (expectedType) {
      case "string":
        typeMatched = typeof value === "string";
        break;
      case "number":
        typeMatched = typeof value === "number" && !Number.isNaN(value);
        break;
      case "boolean":
        typeMatched = typeof value === "boolean";
        break;
      case "object":
        typeMatched = typeof value === "object" && value !== null && !Array.isArray(value);
        break;
      case "array":
        typeMatched = Array.isArray(value);
        break;
      case "any":
        typeMatched = true;
        break;
    }

    if (!typeMatched) {
      const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      throw new Error(
        `EdgeResolver: 节点 ${nodeId} 的输入字段 "${fieldName}" 类型不匹配，期望=${expectedType}，实际=${actualType}`
      );
    }
  }
}

/**
 * 创建边解析器实例（工厂函数）
 *
 * @returns 新的 EdgeResolverProtocol 实例（实现类为 EdgeResolverImpl）
 */
export function createEdgeResolver(): EdgeResolverProtocol {
  return new EdgeResolverImpl();
}
