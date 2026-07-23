/**
 * 图定义构造器（v2.0 新增，对齐设计文档 §16）
 *
 * 本模块提供 GraphBuilder 类，支持从以下三种来源构造 WorkGraph：
 * 1. 手写 JSON/YAML：人工编写图定义文件，通过 GraphBuilder.fromJson() 解析（适用于固定工作流）
 * 2. LLM 规划：LLM 根据任务描述生成图定义 JSON，通过 GraphBuilder.fromJson() 解析（适用于动态复杂任务）
 * 3. 编程式构造：通过 GraphBuilder API 链式调用构造（适用于集成测试和程序化场景）
 *
 * 设计原则：
 * - 链式 API：addNode / addEdge / setEntryNodeId / setConfig / setGlobalState 均返回 this，支持链式调用
 * - 不可变构建：build() 返回 Object.freeze 冻结的 WorkGraph 实例，运行期不可修改
 * - 基本结构校验：build() 时校验入口存在、节点/边 ID 唯一、边引用有效等基本结构
 *   完整的图结构校验（环路检测、不可达节点、谓词注册）由 GraphGuard.validateGraph() 在运行时执行
 * - JSON 解析容错：fromJson() 解析时对缺省字段使用默认值（如 config 缺省时使用 DEFAULT_WORK_GRAPH_CONFIG）
 *
 * @module eag/graph/graph-builder
 */

import type {
  /** 工作图定义 */
  WorkGraph,
  /** 图级配置 */
  WorkGraphConfig,
  /** 图节点定义 */
  GraphNodeDef,
  /** 图边定义 */
  GraphEdgeDef,
  /** 节点字段契约 */
  NodeFieldContract,
  /** 节点类型 */
  GraphNodeType,
  /** 节点内 Loop 配置 */
  NodeLoopConfig,
} from "./graph-loop-models";
import { DEFAULT_WORK_GRAPH_CONFIG, DEFAULT_NODE_LOOP_CONFIG } from "./graph-loop-models";

// ============================================================================
// JSON 类型定义（用于 fromJson 解析）
// ============================================================================

/**
 * JSON 图定义格式（对齐 §16.3 JSON 示例）
 *
 * 与 WorkGraph 接口的区别：
 * - nodes 为数组（JSON 友好），build 时转换为 Map<string, GraphNodeDef>
 * - config 和 globalState 可选，缺省时使用默认值
 *
 * 字段说明：
 * - graphId / name / description：必填，图元信息
 * - entryNodeId：必填，入口节点 ID（必须存在于 nodes 中）
 * - nodes：必填，节点定义数组（每个节点必须有 nodeId / nodeType / label / task / inputContract / outputContract）
 * - edges：必填，边定义数组（每条边必须有 edgeId / from / to / dataMapping）
 * - config：可选，图级配置（缺省时使用 DEFAULT_WORK_GRAPH_CONFIG）
 * - globalState：可选，图级共享状态初始值（缺省时使用 {}）
 */
export interface WorkGraphJson {
  /** 图唯一标识 */
  readonly graphId: string;
  /** 图名称 */
  readonly name: string;
  /** 图描述 */
  readonly description: string;
  /** 入口节点 ID */
  readonly entryNodeId: string;
  /** 节点定义数组（JSON 友好格式，build 时转换为 Map） */
  readonly nodes: ReadonlyArray<GraphNodeDefJson>;
  /** 边定义数组 */
  readonly edges: ReadonlyArray<GraphEdgeDefJson>;
  /** 图级配置（可选，缺省时使用 DEFAULT_WORK_GRAPH_CONFIG） */
  readonly config?: Partial<WorkGraphConfig>;
  /** 图级共享状态初始值（可选，缺省时使用 {}） */
  readonly globalState?: Readonly<Record<string, unknown>>;
}

/**
 * JSON 节点定义格式
 *
 * 与 GraphNodeDef 的区别：
 * - inputContract / outputContract 为可空数组（缺省时使用 []）
 * - loopConfig 为可选（仅 loop 类型节点需要）
 */
export interface GraphNodeDefJson {
  readonly nodeId: string;
  readonly nodeType: GraphNodeType;
  readonly label: string;
  readonly task: string;
  readonly inputContract?: ReadonlyArray<NodeFieldContract>;
  readonly outputContract?: ReadonlyArray<NodeFieldContract>;
  readonly loopConfig?: Partial<NodeLoopConfig>;
  readonly plugin?: string;
  readonly decisionPredicateId?: string;
  readonly overrides?: Readonly<Record<string, unknown>>;
  readonly description?: string;
}

/**
 * JSON 边定义格式
 *
 * 与 GraphEdgeDef 的区别：
 * - dataMapping 为可空对象（缺省时使用 {}）
 */
export interface GraphEdgeDefJson {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
  readonly dataMapping?: Readonly<Record<string, string>>;
  readonly activationPredicateId?: string;
  readonly description?: string;
}

// ============================================================================
// GraphBuilder 实现类
// ============================================================================

/**
 * 图定义构造器
 *
 * 提供链式 API 和 JSON 解析两种构造方式，build() 时执行基本结构校验并返回冻结的 WorkGraph。
 *
 * 使用示例（链式 API）：
 * ```typescript
 * const graph = GraphBuilder.create()
 *   .addNode({ nodeId: "start", nodeType: "task", label: "开始", task: "开始任务",
 *              inputContract: [], outputContract: [] })
 *   .addNode({ nodeId: "end", nodeType: "end", label: "结束", task: "结束任务",
 *              inputContract: [], outputContract: [] })
 *   .addEdge({ edgeId: "e1", from: "start", to: "end", dataMapping: {} })
 *   .setEntryNodeId("start")
 *   .build();
 * ```
 *
 * 使用示例（JSON 解析）：
 * ```typescript
 * const json = `{
 *   "graphId": "demo", "name": "Demo", "description": "演示图",
 *   "entryNodeId": "start",
 *   "nodes": [...], "edges": [...]
 * }`;
 * const graph = GraphBuilder.fromJson(json).build();
 * ```
 */
export class GraphBuilder {
  /** 图唯一标识（build 时必填） */
  private graphId: string = "";
  /** 图名称（build 时必填） */
  private name: string = "";
  /** 图描述（build 时必填） */
  private description: string = "";
  /** 入口节点 ID（build 时必填，必须存在于 nodes 中） */
  private entryNodeId: string = "";
  /** 节点定义列表（按添加顺序，build 时转换为 Map） */
  private readonly nodesList: GraphNodeDef[] = [];
  /** 边定义列表（按添加顺序） */
  private readonly edgesList: GraphEdgeDef[] = [];
  /** 图级配置（build 时未设置则使用 DEFAULT_WORK_GRAPH_CONFIG） */
  private config: Readonly<WorkGraphConfig> = DEFAULT_WORK_GRAPH_CONFIG;
  /** 图级共享状态初始值（build 时未设置则使用 {}） */
  private globalState: Readonly<Record<string, unknown>> = {};

  /**
   * 私有构造函数（通过静态工厂方法 create / fromJson 创建实例）
   */
  private constructor() {}

  /**
   * 创建空构造器
   *
   * @returns 新的 GraphBuilder 实例
   */
  static create(): GraphBuilder {
    return new GraphBuilder();
  }

  /**
   * 从 JSON 字符串解析图定义
   *
   * JSON 格式对齐 §16.3 示例，字段说明见 WorkGraphJson 接口。
   *
   * @param json JSON 字符串（必须能解析为 WorkGraphJson 对象）
   * @returns 新的 GraphBuilder 实例（已填充 JSON 中的节点、边、配置等）
   * @throws {Error} 当 JSON 格式非法、必填字段缺失、或字段类型不符时抛出
   */
  static fromJson(json: Readonly<string>): GraphBuilder {
    // 1. 解析 JSON 字符串
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      throw new Error(`GraphBuilder.fromJson: JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
    }

    // 2. 类型守卫：检查解析结果是否为非空对象
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `GraphBuilder.fromJson: 解析结果必须是对象，实际类型=${Array.isArray(parsed) ? "array" : typeof parsed}`
      );
    }

    const data = parsed as WorkGraphJson;

    // 3. 校验必填字段
    const requiredFields: ReadonlyArray<keyof WorkGraphJson> = [
      "graphId",
      "name",
      "description",
      "entryNodeId",
      "nodes",
      "edges",
    ];
    for (const field of requiredFields) {
      const value = data[field];
      if (value === undefined || value === null || value === "") {
        throw new Error(`GraphBuilder.fromJson: 必填字段 "${field}" 缺失或为空`);
      }
    }

    // 4. 校验 nodes 和 edges 类型
    if (!Array.isArray(data.nodes)) {
      throw new Error(`GraphBuilder.fromJson: nodes 必须是数组，实际类型=${typeof data.nodes}`);
    }
    if (!Array.isArray(data.edges)) {
      throw new Error(`GraphBuilder.fromJson: edges 必须是数组，实际类型=${typeof data.edges}`);
    }

    // 5. 构造 builder 实例并填充数据
    const builder = new GraphBuilder();
    builder.graphId = data.graphId;
    builder.name = data.name;
    builder.description = data.description;
    builder.entryNodeId = data.entryNodeId;

    // 6. 解析节点（从 JSON 格式转换为 GraphNodeDef）
    for (let i = 0; i < data.nodes.length; i++) {
      const nodeJson = data.nodes[i];
      const node = normalizeNodeJson(nodeJson, i);
      builder.nodesList.push(node);
    }

    // 7. 解析边
    for (let i = 0; i < data.edges.length; i++) {
      const edgeJson = data.edges[i];
      const edge = normalizeEdgeJson(edgeJson, i);
      builder.edgesList.push(edge);
    }

    // 8. 解析可选字段 config（合并默认值）
    if (data.config) {
      builder.config = Object.freeze({ ...DEFAULT_WORK_GRAPH_CONFIG, ...data.config });
    }

    // 9. 解析可选字段 globalState
    if (data.globalState) {
      builder.globalState = Object.freeze({ ...data.globalState });
    }

    return builder;
  }

  /**
   * 设置图元信息（graphId / name / description）
   *
   * @param graphId 图唯一标识
   * @param name 图名称
   * @param description 图描述
   * @returns this（支持链式调用）
   */
  setGraphInfo(graphId: string, name: string, description: string): GraphBuilder {
    this.graphId = graphId;
    this.name = name;
    this.description = description;
    return this;
  }

  /**
   * 添加节点
   *
   * @param node 节点定义（必须含 nodeId / nodeType / label / task / inputContract / outputContract）
   * @returns this（支持链式调用）
   * @throws {Error} 当 nodeId 已存在时抛出（避免重复添加）
   */
  addNode(node: Readonly<GraphNodeDef>): GraphBuilder {
    // 检查节点 ID 唯一性（避免重复添加）
    if (this.nodesList.some((n) => n.nodeId === node.nodeId)) {
      throw new Error(`GraphBuilder.addNode: 节点 ID 已存在，禁止重复添加，nodeId=${node.nodeId}`);
    }
    // 浅拷贝节点定义，避免外部修改影响内部状态
    this.nodesList.push({ ...node });
    return this;
  }

  /**
   * 添加边
   *
   * @param edge 边定义（必须含 edgeId / from / to / dataMapping）
   * @returns this（支持链式调用）
   * @throws {Error} 当 edgeId 已存在时抛出（避免重复添加）
   */
  addEdge(edge: Readonly<GraphEdgeDef>): GraphBuilder {
    // 检查边 ID 唯一性（避免重复添加）
    if (this.edgesList.some((e) => e.edgeId === edge.edgeId)) {
      throw new Error(`GraphBuilder.addEdge: 边 ID 已存在，禁止重复添加，edgeId=${edge.edgeId}`);
    }
    // 浅拷贝边定义，避免外部修改影响内部状态
    this.edgesList.push({ ...edge });
    return this;
  }

  /**
   * 设置入口节点
   *
   * @param nodeId 入口节点 ID（必须在 build() 前通过 addNode 添加）
   * @returns this（支持链式调用）
   */
  setEntryNodeId(nodeId: string): GraphBuilder {
    this.entryNodeId = nodeId;
    return this;
  }

  /**
   * 设置图级配置
   *
   * @param config 图级配置（覆盖默认值）
   * @returns this（支持链式调用）
   */
  setConfig(config: Readonly<WorkGraphConfig>): GraphBuilder {
    // 合并默认值，允许部分覆盖
    this.config = Object.freeze({ ...DEFAULT_WORK_GRAPH_CONFIG, ...config });
    return this;
  }

  /**
   * 设置图级共享状态初始值
   *
   * @param state 图级共享状态初始值
   * @returns this（支持链式调用）
   */
  setGlobalState(state: Readonly<Record<string, unknown>>): GraphBuilder {
    this.globalState = Object.freeze({ ...state });
    return this;
  }

  /**
   * 构建图定义（含基本结构校验）
   *
   * 校验项：
   * - graphId / name / description 非空
   * - entryNodeId 非空且存在于 nodes 中
   * - 所有边的 from/to 引用的节点存在
   * - 节点 ID 唯一（addNode 时已检查，此处再次校验防御外部直接修改）
   * - 边 ID 唯一（addEdge 时已检查，此处再次校验防御外部直接修改）
   *
   * 注意：完整的图结构校验（环路检测、不可达节点、谓词注册）由 GraphGuard.validateGraph() 在运行时执行。
   *
   * @returns 冻结的 WorkGraph 实例
   * @throws {Error} 如果图结构不合法（入口缺失、边引用无效等）
   */
  build(): Readonly<WorkGraph> {
    // 1. 校验图元信息
    if (!this.graphId) {
      throw new Error("GraphBuilder.build: graphId 未设置");
    }
    if (!this.name) {
      throw new Error("GraphBuilder.build: name 未设置");
    }
    if (!this.description) {
      throw new Error("GraphBuilder.build: description 未设置");
    }
    if (!this.entryNodeId) {
      throw new Error("GraphBuilder.build: entryNodeId 未设置");
    }
    if (this.nodesList.length === 0) {
      throw new Error("GraphBuilder.build: nodes 为空，至少需要添加一个节点");
    }

    // 2. 构造节点 Map（按 ID 索引）
    const nodesMap = new Map<string, GraphNodeDef>();
    for (const node of this.nodesList) {
      if (nodesMap.has(node.nodeId)) {
        // 防御性校验：addNode 时已检查，此处再次校验避免外部直接修改 nodesList
        throw new Error(`GraphBuilder.build: 节点 ID 重复，nodeId=${node.nodeId}`);
      }
      // 冻结每个节点定义，防止运行期修改
      nodesMap.set(node.nodeId, Object.freeze({ ...node }));
    }

    // 3. 校验入口节点存在
    if (!nodesMap.has(this.entryNodeId)) {
      throw new Error(
        `GraphBuilder.build: 入口节点不存在，entryNodeId=${this.entryNodeId}，可用节点=[${Array.from(
          nodesMap.keys()
        ).join(", ")}]`
      );
    }

    // 4. 校验边的 from/to 引用有效
    for (const edge of this.edgesList) {
      if (!nodesMap.has(edge.from)) {
        throw new Error(`GraphBuilder.build: 边的 from 引用不存在的节点，edgeId=${edge.edgeId}，from=${edge.from}`);
      }
      if (!nodesMap.has(edge.to)) {
        throw new Error(`GraphBuilder.build: 边的 to 引用不存在的节点，edgeId=${edge.edgeId}，to=${edge.to}`);
      }
    }

    // 5. 校验边 ID 唯一性
    const edgeIds = new Set<string>();
    for (const edge of this.edgesList) {
      if (edgeIds.has(edge.edgeId)) {
        throw new Error(`GraphBuilder.build: 边 ID 重复，edgeId=${edge.edgeId}`);
      }
      edgeIds.add(edge.edgeId);
    }

    // 6. 构造冻结的 WorkGraph 实例
    const graph: WorkGraph = {
      graphId: this.graphId,
      name: this.name,
      description: this.description,
      nodes: nodesMap,
      edges: Object.freeze([...this.edgesList]) as ReadonlyArray<GraphEdgeDef>,
      entryNodeId: this.entryNodeId,
      globalState: this.globalState,
      config: this.config,
    };

    return Object.freeze(graph);
  }
}

// ============================================================================
// JSON 规范化辅助函数
// ============================================================================

/**
 * 规范化 JSON 节点定义为 GraphNodeDef
 *
 * 处理缺省字段：
 * - inputContract / outputContract 缺省时使用 []
 * - loopConfig 部分字段缺省时使用 DEFAULT_NODE_LOOP_CONFIG 对应值
 *
 * @param nodeJson JSON 节点定义
 * @param index 节点在数组中的索引（用于错误提示）
 * @returns 规范化后的 GraphNodeDef
 * @throws {Error} 当必填字段缺失或类型不符时抛出
 */
function normalizeNodeJson(nodeJson: GraphNodeDefJson | undefined, index: number): GraphNodeDef {
  if (!nodeJson || typeof nodeJson !== "object") {
    throw new Error(`GraphBuilder.fromJson: nodes[${index}] 必须是对象，实际值=${String(nodeJson)}`);
  }

  // 校验必填字段
  const requiredFields: ReadonlyArray<keyof GraphNodeDefJson> = ["nodeId", "nodeType", "label", "task"];
  for (const field of requiredFields) {
    const value = nodeJson[field];
    if (value === undefined || value === null || value === "") {
      throw new Error(`GraphBuilder.fromJson: nodes[${index}].${field} 缺失或为空`);
    }
  }

  // 规范化契约数组（缺省时使用空数组）
  const inputContract = nodeJson.inputContract ? [...nodeJson.inputContract] : [];
  const outputContract = nodeJson.outputContract ? [...nodeJson.outputContract] : [];

  // 规范化 loopConfig（缺省字段使用 DEFAULT_NODE_LOOP_CONFIG 对应值）
  let loopConfig: NodeLoopConfig | undefined;
  if (nodeJson.loopConfig) {
    loopConfig = {
      ...DEFAULT_NODE_LOOP_CONFIG,
      ...nodeJson.loopConfig,
      stageOrder: nodeJson.loopConfig.stageOrder
        ? [...nodeJson.loopConfig.stageOrder]
        : [...DEFAULT_NODE_LOOP_CONFIG.stageOrder],
    };
  }

  return {
    nodeId: nodeJson.nodeId,
    nodeType: nodeJson.nodeType,
    label: nodeJson.label,
    task: nodeJson.task,
    inputContract: Object.freeze(inputContract),
    outputContract: Object.freeze(outputContract),
    loopConfig: loopConfig ? Object.freeze(loopConfig) : undefined,
    plugin: nodeJson.plugin,
    decisionPredicateId: nodeJson.decisionPredicateId,
    overrides: nodeJson.overrides ? Object.freeze({ ...nodeJson.overrides }) : undefined,
    description: nodeJson.description,
  };
}

/**
 * 规范化 JSON 边定义为 GraphEdgeDef
 *
 * 处理缺省字段：
 * - dataMapping 缺省时使用 {}
 *
 * @param edgeJson JSON 边定义
 * @param index 边在数组中的索引（用于错误提示）
 * @returns 规范化后的 GraphEdgeDef
 * @throws {Error} 当必填字段缺失或类型不符时抛出
 */
function normalizeEdgeJson(edgeJson: GraphEdgeDefJson | undefined, index: number): GraphEdgeDef {
  if (!edgeJson || typeof edgeJson !== "object") {
    throw new Error(`GraphBuilder.fromJson: edges[${index}] 必须是对象，实际值=${String(edgeJson)}`);
  }

  // 校验必填字段
  const requiredFields: ReadonlyArray<keyof GraphEdgeDefJson> = ["edgeId", "from", "to"];
  for (const field of requiredFields) {
    const value = edgeJson[field];
    if (value === undefined || value === null || value === "") {
      throw new Error(`GraphBuilder.fromJson: edges[${index}].${field} 缺失或为空`);
    }
  }

  // 规范化 dataMapping（缺省时使用空对象）
  const dataMapping = edgeJson.dataMapping ? { ...edgeJson.dataMapping } : {};

  return {
    edgeId: edgeJson.edgeId,
    from: edgeJson.from,
    to: edgeJson.to,
    dataMapping: Object.freeze(dataMapping),
    activationPredicateId: edgeJson.activationPredicateId,
    description: edgeJson.description,
  };
}
