/**
 * 业务领域建模器（DomainModeler）—— F-BIZ-02
 *
 * 从 CodeMap + 原始文件推断业务概念、关系、规则，并构建简化版知识图谱。
 *
 * 设计依据：
 * - V2 技术方案 §7.2 DomainModeler 契约
 * - V2_P3_IMPLEMENTATION_PLAN.md §3.1（v1.1 修订）
 * - V2_P3_ARCHITECT_REVIEW.md P0-1/P0-2/P0-3/P2-2 修复
 *
 * 关键设计决策（架构师审查 v1.1 修订）：
 *
 * 1. P0-1 修复：extractConceptsFromCode / extractRelationsFromAPI 签名扩展 projectRoot
 *    读取原始文件提取装饰器（@Entity/@Table）、路由装饰器（@GetMapping）等。
 *    CodeMap 自身的 ClassInfo 不含 decorators 字段，必须读取原始文件。
 *
 * 2. P0-2 修复：extractRulesFromCode 签名扩展 projectRoot
 *    读取原始文件提取 @business-rule 注释、assert、throw 语句。
 *
 * 3. P0-3 修复：modelFromCodeMap 语义重定义为"轻量无 IO 提取"
 *    仅基于 ClassInfo.name 后缀和 FunctionInfo.name 前缀做正则推断。
 *    不读取原始文件、不提取装饰器/注释/SQL。
 *    返回的置信度范围 0.6-0.75，仅供快速预览，不过滤。
 *
 * 4. P2-2 修复：persistToGlobalContext 合并语义
 *    - concepts → conceptLibrary：按 id 去重，已存在的不覆盖（保留首次值）
 *    - concepts → knowledgeGraph.nodes：按 id 去重
 *    - relations → knowledgeGraph.edges：追加（不去重，允许同一关系多次记录）
 *    - rules → ruleLibrary：按 id 去重
 *
 * 5. 复用 GlobalContext 类型：SimpleKnowledgeGraph/GraphNode/GraphEdge/ConceptEntry/RuleEntry
 *    定义在 global-context.ts，本模块直接 import 复用，避免双源真相。
 *
 * 6. service 概念识别（路由推断）：
 *    DM-05/DM-07/DM-07b/DM-08 测试要求"从路由提取 service 概念"。
 *    extractConceptsFromCode 内部调用 extractServiceConceptsFromRoutes，
 *    读取原始文件匹配路由正则（Express/Spring/Go/Python），产出 service 概念。
 *    extractConceptsFromCode 方法名语义为"从代码提取概念"，路由属于代码范畴。
 *
 * @module v2/understanding/domain-modeler
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CodeMapGenerator, CodeMap } from "../codemap/generator";
import type { ClassInfo } from "../codemap/regex-analyzer";
import type {
  GlobalContextManager,
  SimpleKnowledgeGraph,
  GraphNode,
  GraphEdge,
  ConceptEntry,
  RuleEntry,
} from "../context/global-context";

// ============================================================================
// 类型定义（与实施计划 §3.1 对齐）
// ============================================================================

/**
 * ContextSnippet.type 常量（V2-P3 新增）
 *
 * P1-1 修复：ContextSnippet.type 字段是自由 string（非联合类型），
 * 无需修改类型定义，仅需在模块内定义 type 常量供 DualLayerContextManager 引用。
 */
export const CONTEXT_SNIPPET_TYPE = {
  DOMAIN_CONCEPT: "domain_concept",
  DOMAIN_RULE: "domain_rule",
} as const;

/**
 * 业务领域模型
 *
 * 从代码推断的业务概念、关系、规则集合，并构建简化版知识图谱。
 * 持久化到 GlobalContext.domainKnowledge（~/.deepcode/global-context.json）。
 */
export interface DomainModel {
  /** 业务概念列表 */
  concepts: DomainConcept[];
  /** 业务关系列表 */
  relations: DomainRelation[];
  /** 业务规则列表 */
  rules: DomainRule[];
  /** 简化版知识图谱（节点=概念，边=关系） */
  knowledgeGraph: SimpleKnowledgeGraph;
}

/**
 * 业务概念
 *
 * 类型遵循 DDD 分层：entity / value_object / aggregate / service / event。
 * source 字段记录推断来源文件，便于溯源。
 */
export interface DomainConcept {
  /** 概念 ID（基于 name 的 slug） */
  id: string;
  /** 概念名称（PascalCase） */
  name: string;
  /** 概念类型 */
  type: "entity" | "value_object" | "aggregate" | "service" | "event";
  /** 来源文件路径（相对项目根的 POSIX 路径） */
  source: string;
  /** 概念描述（自然语言） */
  description: string;
  /** 概念属性列表（属性名） */
  properties: string[];
  /** 推断置信度（0-1；model() 返回的均 ≥0.75；modelFromCodeMap() 为 0.6-0.75） */
  confidence: number;
}

/**
 * 业务关系
 *
 * source/target 为概念 ID，type 遵循 DDD 关系语义。
 */
export interface DomainRelation {
  /** 源概念 ID */
  source: string;
  /** 目标概念 ID */
  target: string;
  /** 关系类型 */
  type: "has_many" | "has_one" | "belongs_to" | "references" | "triggers";
  /** 推断置信度 */
  confidence: number;
}

/**
 * 业务规则
 *
 * 从注释、断言、验证逻辑中提取的业务规则。
 */
export interface DomainRule {
  /** 规则 ID（基于 rule 文本的 slug） */
  id: string;
  /** 规则文本（自然语言） */
  rule: string;
  /** 来源（文件:行号 或 注释片段） */
  source: string;
  /** 推断置信度 */
  confidence: number;
}

// ============================================================================
// 常量与正则规则
// ============================================================================

/** model() 过滤阈值：置信度 < 0.75 的条目不写入 DomainModel */
const CONFIDENCE_THRESHOLD = 0.75;

/**
 * 类名后缀 → 概念类型映射
 *
 * 用于 extractConceptsFromCode 和 modelFromCodeMap 的类名启发式识别。
 * 顺序敏感：Entity 优先于 Aggregate（避免 AggregateEntity 误匹配 entity）。
 */
const CLASS_NAME_SUFFIX_MAP: ReadonlyArray<{ suffix: string; type: DomainConcept["type"] }> = [
  { suffix: "Entity", type: "entity" },
  { suffix: "Aggregate", type: "aggregate" },
  { suffix: "DTO", type: "value_object" },
  { suffix: "VO", type: "value_object" },
  { suffix: "Props", type: "value_object" },
  { suffix: "Event", type: "event" },
];

/**
 * 函数名前缀 → service 概念识别（modelFromCodeMap 用）
 *
 * createXxx / getXxx / updateXxx / deleteXxx 等典型服务方法命名约定。
 * 前缀匹配大小写不敏感（createXxx / CreateXxx 均可）。
 */
const SERVICE_FUNCTION_PREFIXES = ["create", "get", "find", "list", "update", "delete", "save", "remove"] as const;

/**
 * SQL 文件建表语句识别正则
 *
 * 用于 extractConceptsFromSchema 扫描 *.sql 文件提取建表语句。
 * 支持 IF NOT EXISTS、反引号、双引号包裹的表名。
 */
const SQL_CREATE_TABLE_PATTERN = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi;

/**
 * SQL 外键关系识别正则
 *
 * 用于 extractConceptsFromSchema 提取 FOREIGN KEY ... REFERENCES 关系。
 * 捕获组 1：外键字段名；捕获组 2：被引用表名。
 */
const SQL_FOREIGN_KEY_PATTERN = /FOREIGN\s+KEY\s*\(\s*[`"]?(\w+)[`"]?\s*\)\s*REFERENCES\s+[`"]?(\w+)[`"]?/gi;

/**
 * RESTful 路由识别正则（多语言支持）
 *
 * 用于 extractConceptsFromCode（service 概念）和 extractRelationsFromAPI（has_many 关系）。
 * 每个正则带全局标志，使用前需 reset lastIndex。
 */
interface RoutePatternDef {
  /** 正则（全局标志） */
  pattern: RegExp;
  /** 框架标签（用于描述与置信度区分） */
  framework: "express" | "spring" | "go" | "python";
  /** 该框架路由识别的置信度（Spring 强类型装饰器 > 其他框架） */
  confidence: number;
  /** 路由路径捕获组索引（1 或 2） */
  pathGroup: 1 | 2;
}

const ROUTE_PATTERNS: ReadonlyArray<RoutePatternDef> = [
  // Express：app.get("/api/users") 或 router.post("/api/orders")
  {
    pattern: /\b(?:app|router)\.(?:get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/g,
    framework: "express",
    confidence: 0.8,
    pathGroup: 1,
  },
  // Spring：@GetMapping("/api/users") 或 @RequestMapping("/api/users")
  {
    pattern: /@(?:Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["'`]([^"'`]+)["'`]/g,
    framework: "spring",
    confidence: 0.85,
    pathGroup: 1,
  },
  // Go：http.HandleFunc("/api/users", ...) 或 mux.HandleFunc
  {
    pattern: /\bHandleFunc\s*\(\s*["'`]([^"'`]+)["'`]/g,
    framework: "go",
    confidence: 0.8,
    pathGroup: 1,
  },
  // Python Flask/FastAPI：@app.get("/api/users") 或 @router.post("/api/users")
  {
    pattern: /@(?:app|router|blueprint)\.(?:get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/g,
    framework: "python",
    confidence: 0.8,
    pathGroup: 1,
  },
];

/**
 * 业务规则注释识别正则
 *
 * 用于 extractRulesFromCode 提取 @business-rule 和 @invariant 注释。
 */
interface RuleCommentPatternDef {
  /** 正则（全局标志） */
  pattern: RegExp;
  /** 规则来源标签 */
  source: string;
  /** 捕获组索引（规则文本） */
  textGroup: 1 | 2;
}

const RULE_COMMENT_PATTERNS: ReadonlyArray<RuleCommentPatternDef> = [
  // 行注释：// @business-rule: ... 或 # @business-rule: ...
  {
    pattern: /(?:\/\/|#)\s*@business-rule:\s*(.+)/g,
    source: "comment",
    textGroup: 1,
  },
  // 行注释：// @invariant: ... 或 # @invariant: ...
  {
    pattern: /(?:\/\/|#)\s*@invariant:\s*(.+)/g,
    source: "comment",
    textGroup: 1,
  },
  // 块注释：/* @business-rule: ... */ 或 /** @invariant: ... */
  {
    pattern: /\/\*+\s*@(?:business-rule|invariant):\s*([^*]+?)\s*\*\//g,
    source: "block-comment",
    textGroup: 1,
  },
];

/** assert 语句识别正则（提取断言中的条件作为业务规则） */
const ASSERT_PATTERN = /\bassert\s+([^;,)]+(?:\([^)]*\))?[^;,)]*)/g;

/**
 * throw 语句识别正则（业务验证逻辑）
 *
 * 仅匹配 BusinessError/ValidationError/DomainError 等业务异常，
 * 避免匹配普通的 throw new Error("...")。
 */
const THROW_PATTERN = /\bthrow\s+new\s+(?:Business|Validation|Domain)\w*Error\s*\(\s*["'`]([^"'`]+)["'`]/g;

// ============================================================================
// DomainModeler 类
// ============================================================================

/**
 * 业务领域建模器
 *
 * 使用方式：
 * ```typescript
 * const generator = new CodeMapGenerator({ projectRoot: "/path", ... });
 * const globalManager = new GlobalContextManager();
 * const modeler = new DomainModeler(generator, globalManager);
 * // 完整入口（触发 CodeMap 全量扫描 + 原始文件读取提取装饰器/注释/SQL）
 * const model = await modeler.model("/path/to/project");
 * // 轻量入口（已生成 CodeMap 时复用，仅基于 CodeMap 自带信息，无 IO）
 * const codeMap = await generator.generateFullMap();
 * const lightweightModel = modeler.modelFromCodeMap(codeMap);
 * // 持久化到 GlobalContext.domainKnowledge
 * await modeler.persistToGlobalContext("default", model);
 * ```
 */
export class DomainModeler {
  /**
   * @param codeMapGenerator CodeMap 生成器（构造时已绑定 projectRoot）
   * @param globalManager GlobalContext 管理器（用于持久化 DomainModel）
   */
  constructor(
    private readonly codeMapGenerator: CodeMapGenerator,
    private readonly globalManager: GlobalContextManager
  ) {}

  // ------------------------------------------------------------------------
  // 公开方法
  // ------------------------------------------------------------------------

  /**
   * 构建完整业务领域模型（触发 CodeMap 全量扫描 + 原始文件读取）
   *
   * 实现步骤：
   * 1. projectRoot 一致性断言（与 generator 绑定的一致）
   * 2. 调用 codeMapGenerator.generateFullMap() 生成 CodeMap
   * 3. extractConceptsFromCode(codeMap, projectRoot)：读取原始文件提取装饰器/路由
   * 4. extractConceptsFromSchema(projectRoot)：扫描 *.sql 文件提取建表语句与外键
   * 5. extractRelationsFromAPI(codeMap, projectRoot)：读取原始文件提取嵌套路由
   * 6. extractRulesFromCode(codeMap, projectRoot)：读取原始文件提取注释/断言
   * 7. 合并 concepts（按 id 去重，已存在不覆盖）
   * 8. 过滤置信度 < 0.75 的条目（concepts/relations/rules 三者均过滤）
   * 9. 构建 knowledgeGraph（节点=concepts，边=relations）
   *
   * @param projectRoot 项目根目录（必须与 generator 绑定的一致）
   * @returns 完整业务领域模型（高置信度，0.75-0.95）
   * @throws {Error} 当 projectRoot 与 generator 内部绑定的不一致时
   */
  async model(projectRoot: string): Promise<DomainModel> {
    // 一致性断言：避免双源真相（与 ProjectUnderstandingService 同模式）
    const expected = path.resolve(projectRoot);
    const bound = this.codeMapGenerator.getProjectRoot();
    if (expected !== bound) {
      throw new Error(`DomainModeler.model: projectRoot 不一致（传入 ${expected}，生成器绑定 ${bound}）`);
    }

    // 1. 调用 generateFullMap 生成 CodeMap
    const codeMap = await this.codeMapGenerator.generateFullMap();

    // 2. 多路提取
    const codeConcepts = this.extractConceptsFromCode(codeMap, projectRoot);
    const schemaResult = this.extractConceptsFromSchema(projectRoot);
    const apiRelations = this.extractRelationsFromAPI(codeMap, projectRoot);
    const rules = this.extractRulesFromCode(codeMap, projectRoot);

    // 3. 合并 concepts（按 id 去重，已存在的不覆盖，保留首次值）
    // 顺序敏感：代码提取的概念优先（置信度更精确），SQL 提取的概念仅补充
    const conceptMap = new Map<string, DomainConcept>();
    for (const c of codeConcepts) {
      if (!conceptMap.has(c.id)) conceptMap.set(c.id, c);
    }
    for (const c of schemaResult.concepts) {
      if (!conceptMap.has(c.id)) conceptMap.set(c.id, c);
    }

    // 4. 合并 relations（不去重，全部保留以便持久化时追加到 knowledgeGraph.edges）
    const allRelations = [...apiRelations, ...schemaResult.relations];

    // 5. 过滤置信度 < 0.75 的条目
    const filteredConcepts = this.filterByConfidence([...conceptMap.values()]);
    const filteredRelations = this.filterByConfidence(allRelations);
    const filteredRules = this.filterByConfidence(rules);

    // 6. 构建知识图谱
    const knowledgeGraph = this.buildKnowledgeGraph(filteredConcepts, filteredRelations);

    return {
      concepts: filteredConcepts,
      relations: filteredRelations,
      rules: filteredRules,
      knowledgeGraph,
    };
  }

  /**
   * 从已生成的 CodeMap 构建轻量业务领域模型（无 IO 副作用）
   *
   * v1.1 修订（P0-3 修复）：语义重定义为"轻量无 IO 提取"。
   *
   * 仅基于 CodeMap 自带信息做轻量推断，不读取原始文件，不提取装饰器/注释/SQL：
   * - 从 ClassInfo.name 后缀（XxxEntity / XxxDTO / XxxVO / XxxProps / XxxEvent）提取概念（置信度 0.75）
   * - 从 ClassInfo.type === "interface" 提取值对象（置信度 0.7）
   * - 从 FunctionInfo.name 前缀（createXxx / getXxx / ...）推断 service（置信度 0.6）
   *
   * 不过滤置信度：返回的置信度范围 0.6-0.75，仅供快速预览。
   * 完整高置信度模型请使用 model(projectRoot)。
   *
   * @param codeMap 已生成的 CodeMap
   * @returns 轻量业务领域模型（低置信度，0.6-0.75）
   */
  modelFromCodeMap(codeMap: CodeMap): DomainModel {
    const concepts: DomainConcept[] = [];
    const relations: DomainRelation[] = [];
    const rules: DomainRule[] = [];
    const seenIds = new Set<string>();
    // 从 CodeMap.project.root 获取项目根（用于规范化 source 为相对路径）
    const projectRoot = codeMap.project.root;

    for (const file of codeMap.files) {
      // 规范化 source 路径为相对项目根的 POSIX 路径
      const relPath = this.toRelativePosixPath(projectRoot, file.path);

      // 1. 从类提取概念（interface 类型优先于类名后缀，符合 P0-3 轻量无 IO 设计）
      for (const cls of file.classes) {
        const id = this.conceptNameToId(cls.name);
        if (seenIds.has(id)) continue;

        // 1a. interface 类型识别（基于 ClassInfo.type，无 IO）→ confidence 0.7
        // 设计依据：v1.1 修订 P0-3，interface 类型是 CodeMap 自带信息，轻量模式可直接使用
        // 优先级高于后缀匹配：interface + 后缀（如 OrderProps）时，仍按 interface 0.7 处理
        if (cls.type === "interface") {
          seenIds.add(id);
          concepts.push({
            id,
            name: cls.name,
            type: "value_object",
            source: relPath,
            description: "轻量推断：interface 类型",
            properties: cls.properties,
            confidence: 0.7,
          });
          continue;
        }

        // 1b. 类名后缀匹配（基于 ClassInfo.name，无 IO）→ confidence 0.75
        const suffixMatch = CLASS_NAME_SUFFIX_MAP.find((m) => cls.name.endsWith(m.suffix));
        if (suffixMatch) {
          seenIds.add(id);
          concepts.push({
            id,
            name: cls.name,
            type: suffixMatch.type,
            source: relPath,
            description: `轻量推断：类名后缀 ${suffixMatch.suffix}`,
            properties: cls.properties,
            confidence: 0.75,
          });
        }
      }

      // 2. 从函数名前缀推断 service 概念
      for (const fn of file.functions) {
        const lowerName = fn.name.toLowerCase();
        const prefixMatch = SERVICE_FUNCTION_PREFIXES.find((p) => lowerName.startsWith(p));
        if (!prefixMatch) continue;
        // 从函数名提取概念名（createUser → User）
        const conceptName = fn.name.slice(prefixMatch.length);
        if (!conceptName) continue;
        const id = this.conceptNameToId(conceptName);
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        concepts.push({
          id,
          name: conceptName,
          type: "service",
          source: relPath,
          description: `轻量推断：函数名前缀 ${prefixMatch}`,
          properties: [],
          confidence: 0.6,
        });
      }
    }

    // 轻量模式不提取 relations 和 rules（无 IO 推断不到）
    const knowledgeGraph = this.buildKnowledgeGraph(concepts, relations);

    return {
      concepts,
      relations,
      rules,
      knowledgeGraph,
    };
  }

  /**
   * 持久化 DomainModel 到 GlobalContext.domainKnowledge
   *
   * v1.1 修订（P2-2 修复）：明确合并策略。
   *
   * 合并策略（R-P3-07 缓解措施）：
   * - concepts → conceptLibrary：按 concept.id 去重，已存在的不覆盖（保留首次值）
   * - concepts → knowledgeGraph.nodes：按 node.id 去重
   * - relations → knowledgeGraph.edges：追加（不去重，允许同一关系多次记录）
   * - rules → ruleLibrary：按 rule.id 去重
   *
   * @param userId 用户 ID
   * @param model 业务领域模型
   */
  async persistToGlobalContext(userId: string, model: DomainModel): Promise<void> {
    this.globalManager.update(userId, (ctx) => {
      const dk = ctx.domainKnowledge;

      // 1. concepts → conceptLibrary：按 id 去重，已存在的不覆盖
      const existingConceptIds = new Set(dk.conceptLibrary.map((c) => c.id));
      const newConcepts: ConceptEntry[] = model.concepts
        .filter((c) => !existingConceptIds.has(c.id))
        .map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          relatedConcepts: this.findRelatedConcepts(c.id, model.relations),
        }));
      dk.conceptLibrary.push(...newConcepts);

      // 2. concepts → knowledgeGraph.nodes：按 id 去重
      const existingNodeIds = new Set(dk.knowledgeGraph.nodes.map((n) => n.id));
      const newNodes: GraphNode[] = model.concepts
        .filter((c) => !existingNodeIds.has(c.id))
        .map((c) => this.conceptToGraphNode(c));
      dk.knowledgeGraph.nodes.push(...newNodes);

      // 3. relations → knowledgeGraph.edges：追加（不去重，允许同一关系多次记录）
      const newEdges: GraphEdge[] = model.relations.map((r) => ({
        source: r.source,
        target: r.target,
        relation: r.type,
        weight: r.confidence,
      }));
      dk.knowledgeGraph.edges.push(...newEdges);

      // 4. rules → ruleLibrary：按 id 去重
      const existingRuleIds = new Set(dk.ruleLibrary.map((r) => r.id));
      const newRules: RuleEntry[] = model.rules
        .filter((r) => !existingRuleIds.has(r.id))
        .map((r) => ({
          id: r.id,
          rule: r.rule,
          scope: r.source,
          priority: Math.round(r.confidence * 10),
        }));
      dk.ruleLibrary.push(...newRules);

      return ctx;
    });
  }

  // ------------------------------------------------------------------------
  // 私有方法：概念提取
  // ------------------------------------------------------------------------

  /**
   * 从 CodeMap.files 提取业务概念（实体类/接口/ORM 装饰器/路由）
   *
   * v1.1 修订（P0-1 修复）：签名扩展 projectRoot，读取原始文件提取装饰器。
   *
   * 实现策略：
   * 1. 遍历 CodeMap.files，对每个文件读取原始内容
   * 2. 遍历 classes，基于 ClassInfo.name 后缀和 ClassInfo.type 筛选候选
   *    对候选类在原始内容中查找装饰器（@Entity/@Table/@dataclass）
   * 3. 在原始内容中匹配路由正则，提取 service 概念（DM-05/07/07b/08 测试需求）
   *
   * 置信度策略：
   * - 类名后缀匹配 + 装饰器确认 → confidence = 0.9（高置信度）
   * - 仅类名后缀匹配 → confidence = 0.75（边界置信度，刚好通过过滤）
   * - 仅装饰器匹配 → confidence = 0.85（中高置信度）
   * - interface + 后缀（Props/DTO/VO） → confidence = 0.85（双重匹配）
   * - 路由识别（Express/Go/Python） → confidence = 0.8
   * - 路由识别（Spring） → confidence = 0.85（强类型装饰器）
   *
   * @param codeMap 已生成的 CodeMap（用于筛选候选文件）
   * @param projectRoot 项目根目录（用于读取原始文件）
   * @returns 业务概念列表
   */
  private extractConceptsFromCode(codeMap: CodeMap, projectRoot: string): DomainConcept[] {
    const concepts: DomainConcept[] = [];

    for (const file of codeMap.files) {
      // 跳过解析失败的文件
      if (file.parseStatus !== "ok") continue;

      // 读取原始文件内容（用于提取装饰器和路由）
      const rawContent = this.readFileContent(projectRoot, file.path);
      if (!rawContent) continue;

      // 规范化 source 路径为相对项目根的 POSIX 路径（便于跨机器溯源）
      const relPath = this.toRelativePosixPath(projectRoot, file.path);

      // 1. 从类提取概念
      for (const cls of file.classes) {
        const concept = this.extractConceptFromClass(cls, relPath, rawContent);
        if (concept) concepts.push(concept);
      }

      // 2. 从路由提取 service 概念（DM-05/07/07b/08 测试需求）
      const serviceConcepts = this.extractServiceConceptsFromRoutes(rawContent, relPath);
      concepts.push(...serviceConcepts);
    }

    return concepts;
  }

  /**
   * 从单个 ClassInfo 提取业务概念
   *
   * 根据类名后缀、类类型、装饰器组合判定概念类型与置信度。
   *
   * 置信度矩阵（v1.1 修订 P2-4 修复）：
   * - 类名后缀 + 装饰器 → 0.9（高置信度）
   * - 仅类名后缀（class） → 0.75（边界置信度）
   * - 仅装饰器 → 0.85（中高置信度）
   * - interface + 后缀（Props/DTO/VO） → 0.85（双重匹配）
   * - 仅 interface 无后缀 → 不识别
   *
   * 注意：interface + 后缀的判定优先于"仅后缀"判定，
   * 因为 interface 类型本身已是类型信号，叠加后缀构成双重匹配。
   *
   * @param cls 类信息
   * @param sourcePath 来源文件相对路径（已转为相对项目根的 POSIX 路径）
   * @param rawContent 文件原始内容
   * @returns 业务概念；不通过识别时返回 null
   */
  private extractConceptFromClass(cls: ClassInfo, sourcePath: string, rawContent: string): DomainConcept | null {
    // 1. 类名后缀匹配
    const suffixMatch = CLASS_NAME_SUFFIX_MAP.find((m) => cls.name.endsWith(m.suffix));

    // 2. 装饰器匹配（在原始内容中查找类定义前的装饰器，紧邻无空行）
    const decoratorMatch = this.findDecoratorForClass(cls, rawContent);

    // 3. interface 类型识别
    const isInterface = cls.type === "interface";

    // 4. 计算置信度与概念类型
    let confidence = 0;
    let conceptType: DomainConcept["type"] | null = null;
    let description = "";

    if (suffixMatch && decoratorMatch) {
      // 类名后缀 + 装饰器双重匹配 → 高置信度
      confidence = 0.9;
      conceptType = suffixMatch.type;
      description = `类名后缀 ${suffixMatch.suffix} + 装饰器 ${decoratorMatch.decorator}`;
    } else if (isInterface && suffixMatch) {
      // interface + 后缀双重匹配 → 中高置信度（DM-02 测试需求）
      // 注意：interface 本身已是类型信号，叠加后缀构成双重匹配
      confidence = 0.85;
      conceptType = suffixMatch.type;
      description = `interface + 后缀 ${suffixMatch.suffix}`;
    } else if (suffixMatch) {
      // 仅类名后缀匹配 → 边界置信度
      confidence = 0.75;
      conceptType = suffixMatch.type;
      description = `类名后缀 ${suffixMatch.suffix}`;
    } else if (decoratorMatch) {
      // 仅装饰器匹配 → 中高置信度
      confidence = 0.85;
      conceptType = decoratorMatch.type;
      description = `装饰器 ${decoratorMatch.decorator}`;
    } else if (isInterface) {
      // 仅 interface 无后缀 → 置信度不足，不识别
      return null;
    } else {
      // 无任何匹配
      return null;
    }

    return {
      id: this.conceptNameToId(cls.name),
      name: cls.name,
      type: conceptType,
      source: sourcePath,
      description,
      properties: cls.properties,
      confidence,
    };
  }

  /**
   * 在原始内容中查找类对应的装饰器
   *
   * v1.1 修订（P2-5 修复）：装饰器必须紧邻类定义行，中间允许空行/注释，但不允许其他代码。
   *
   * 算法：从类定义行的上一行开始向前逐行扫描：
   * - 装饰器行（以 @ 开头，去除前导空格） → 记录，继续向前
   * - 空行 → 跳过，继续向前
   * - 注释行（// 或 /* 或 *） → 跳过，继续向前
   * - 装饰器参数延续行（如 @Table( 后续的 name="..."）→ 跳过，继续向前
   * - 其他代码行 → 停止扫描
   *
   * 这样避免将前一个类的装饰器误匹配到下一个类（DM-10 测试需求）。
   *
   * @param cls 类信息
   * @param rawContent 文件原始内容
   * @returns 装饰器信息；无匹配返回 null
   */
  private findDecoratorForClass(
    cls: ClassInfo,
    rawContent: string
  ): { decorator: string; type: DomainConcept["type"] } | null {
    const lines = rawContent.split("\n");
    // cls.startLine 是 1-based，所以 cls.startLine - 1 是类定义行的数组索引
    // 从类定义行的上一行开始向前扫描
    const classDefIdx = cls.startLine - 1;
    const startScanIdx = Math.max(0, classDefIdx - 1);

    let foundEntity = false;
    let foundDataclass = false;

    for (let i = startScanIdx; i >= 0; i--) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();

      // 空行：跳过，继续向前
      if (trimmed === "") continue;

      // 注释行：跳过，继续向前
      if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        continue;
      }

      // 装饰器行：以 @ 开头
      if (trimmed.startsWith("@")) {
        // 检查是否为目标装饰器
        if (/@(Entity|Table)\b/.test(trimmed)) {
          foundEntity = true;
        }
        if (/@dataclass\b/.test(trimmed)) {
          foundDataclass = true;
        }
        // 继续向前查找（可能有多个装饰器叠加）
        continue;
      }

      // 装饰器参数延续行：当前行不以 @ 开头，但前一行是装饰器行
      // 简化判断：包含括号/字符串/标识符但不是代码语句的行
      // 此处保守处理：如果当前行是装饰器的参数（如 name="users"），跳过
      // 通过检查是否在装饰器括号内来判断
      // 简化方案：如果已经找到装饰器，且当前行像参数（含 = 或以 , 结尾或以 ( 开头），跳过
      if ((foundEntity || foundDataclass) && this.looksLikeDecoratorArgument(trimmed)) {
        continue;
      }

      // 其他代码行：停止扫描
      break;
    }

    if (foundEntity) {
      return { decorator: "@Entity/@Table", type: "entity" };
    }
    if (foundDataclass) {
      return { decorator: "@dataclass", type: "value_object" };
    }
    return null;
  }

  /**
   * 判断一行是否像装饰器参数延续
   *
   * 辅助 findDecoratorForClass 判断多行装饰器的参数行（如 @Table(\n  name="users"\n)）。
   *
   * 启发式规则：
   * - 含 = （属性赋值）
   * - 以 , 结尾
   * - 以 ( 开头或以 ) 结尾（括号延续）
   * - 仅含字符串字面量
   *
   * @param trimmed 已去除首尾空白的行
   * @returns 是否像装饰器参数
   */
  private looksLikeDecoratorArgument(trimmed: string): boolean {
    if (trimmed.includes("=")) return true;
    if (trimmed.endsWith(",")) return true;
    if (trimmed.startsWith("(") || trimmed.endsWith(")")) return true;
    // 仅含字符串字面量（如 "users"）
    if (/^["'`][^"'`]*["'`]$/.test(trimmed)) return true;
    return false;
  }

  /**
   * 从原始文件内容中提取 service 概念（基于路由识别）
   *
   * 服务于 DM-05/DM-07/DM-07b/DM-08 测试用例：
   * - DM-05：Express app.get("/api/users") → service "Users"，置信度 0.8
   * - DM-07：Spring @GetMapping("/api/users") → service "Users"，置信度 0.85
   * - DM-07b：Python @app.get("/api/users") → service "Users"，置信度 0.8
   * - DM-08：Go http.HandleFunc("/api/users") → service "Users"，置信度 0.8
   *
   * 实现策略：匹配 ROUTE_PATTERNS 中所有路由正则，从路径段推断 service 概念名。
   * 仅取路径的第一段作为概念名（/api/users → Users），避免重复。
   *
   * 注意（v1.1 修订 P2-6 修复）：
   * service 概念名保留复数形式（users → Users，不做单数化）。
   * 因为路由资源名通常代表集合（RESTful 语义），service 概念名应保持复数。
   * 单数化逻辑仅用于 SQL 表名 → 实体名（tableNameToConceptName）。
   *
   * @param rawContent 文件原始内容
   * @param filePath 文件相对路径（用于 source 字段）
   * @returns service 概念列表
   */
  private extractServiceConceptsFromRoutes(rawContent: string, filePath: string): DomainConcept[] {
    const concepts: DomainConcept[] = [];
    const seenNames = new Set<string>();

    for (const { pattern, framework, confidence, pathGroup } of ROUTE_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(rawContent)) !== null) {
        const routePath = match[pathGroup];
        if (!routePath) continue;

        // 从路径提取顶层资源名：/api/users → Users；/api/orders → Orders
        const segments = routePath.split("/").filter((s) => s.length > 0 && !s.startsWith(":"));
        // 跳过 "api" 前缀，取下一个段作为资源名
        const resourceSegment = segments.find((s) => s.toLowerCase() !== "api");
        if (!resourceSegment) continue;

        // 资源名转 PascalCase 但保留复数形式（users → Users，不单数化为 User）
        const conceptName = this.resourceNameToServiceName(resourceSegment);
        if (!conceptName) continue;

        // 同文件同概念去重
        if (seenNames.has(conceptName)) continue;
        seenNames.add(conceptName);

        concepts.push({
          id: this.conceptNameToId(conceptName),
          name: conceptName,
          type: "service",
          source: filePath,
          description: `路由识别（${framework}）：${routePath}`,
          properties: [],
          confidence,
        });
      }
    }

    return concepts;
  }

  /**
   * 从 SQL 文件提取业务概念（建表语句 + 外键关系）
   *
   * 识别模式（§7.2 识别清单①）：
   * - CREATE TABLE (\w+) → entity，confidence 0.85
   * - FOREIGN KEY (\w+) REFERENCES (\w+) → belongs_to 关系，confidence 0.9
   *
   * 扫描路径：项目根目录 + migrations/ + db/migrate/ + sql/
   *
   * @param projectRoot 项目根目录
   * @returns 概念与关系
   */
  private extractConceptsFromSchema(projectRoot: string): {
    concepts: DomainConcept[];
    relations: DomainRelation[];
  } {
    const concepts: DomainConcept[] = [];
    const relations: DomainRelation[] = [];
    const seenConceptIds = new Set<string>();

    // 1. 收集 SQL 文件路径
    const sqlFiles = this.collectSqlFiles(projectRoot);

    // 2. 逐文件提取
    for (const sqlFile of sqlFiles) {
      const content = this.readFileContent(projectRoot, sqlFile);
      if (!content) continue;

      // 2.1 提取 CREATE TABLE → entity
      SQL_CREATE_TABLE_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = SQL_CREATE_TABLE_PATTERN.exec(content)) !== null) {
        const tableName = match[1];
        if (!tableName) continue;
        const conceptName = this.tableNameToConceptName(tableName);
        const conceptId = this.conceptNameToId(conceptName);
        if (seenConceptIds.has(conceptId)) continue;
        seenConceptIds.add(conceptId);
        concepts.push({
          id: conceptId,
          name: conceptName,
          type: "entity",
          source: sqlFile,
          description: `SQL CREATE TABLE ${tableName}`,
          properties: [],
          confidence: 0.85,
        });
      }

      // 2.2 提取 FOREIGN KEY → belongs_to 关系
      SQL_FOREIGN_KEY_PATTERN.lastIndex = 0;
      while ((match = SQL_FOREIGN_KEY_PATTERN.exec(content)) !== null) {
        const fromTable = this.findTableNameAtPosition(content, match.index);
        const toTable = match[2];
        if (!fromTable || !toTable) continue;
        const sourceId = this.conceptNameToId(this.tableNameToConceptName(fromTable));
        const targetId = this.conceptNameToId(this.tableNameToConceptName(toTable));
        relations.push({
          source: sourceId,
          target: targetId,
          type: "belongs_to",
          confidence: 0.9,
        });
      }
    }

    return { concepts, relations };
  }

  // ------------------------------------------------------------------------
  // 私有方法：关系提取
  // ------------------------------------------------------------------------

  /**
   * 从 CodeMap.files 提取 RESTful 路由关系（has_many 嵌套路由）
   *
   * v1.1 修订（P0-1 修复）：签名扩展 projectRoot，读取原始文件提取路由装饰器。
   *
   * 实现策略：
   * 1. 遍历 CodeMap.files，读取原始内容
   * 2. 正则匹配路由模式（Express/Spring/Go/Python 四种框架）
   * 3. 从嵌套路由路径推断 has_many 关系（DM-06 测试需求）
   *
   * 识别模式（§7.2 识别清单③）：
   * - 嵌套路径：/api/<a>/:<a>Id/<b> → <a> has_many <b>，confidence 0.85
   *
   * 注意：service 概念由 extractConceptsFromCode 内部调用 extractServiceConceptsFromRoutes 负责。
   * 本方法仅负责 has_many 关系识别。
   *
   * @param codeMap 已生成的 CodeMap（用于筛选候选文件）
   * @param projectRoot 项目根目录（用于读取原始文件）
   * @returns 业务关系列表
   */
  private extractRelationsFromAPI(codeMap: CodeMap, projectRoot: string): DomainRelation[] {
    const relations: DomainRelation[] = [];
    const seenPairs = new Set<string>();

    for (const file of codeMap.files) {
      if (file.parseStatus !== "ok") continue;

      const rawContent = this.readFileContent(projectRoot, file.path);
      if (!rawContent) continue;

      for (const { pattern, pathGroup } of ROUTE_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(rawContent)) !== null) {
          const routePath = match[pathGroup];
          if (!routePath) continue;

          // 解析嵌套路径：/api/users/:userId/orders → users has_many orders
          const nested = this.parseNestedRoute(routePath);
          if (!nested) continue;

          const sourceId = this.conceptNameToId(nested.parent);
          const targetId = this.conceptNameToId(nested.child);
          // 去重：同一 (source, target) 对仅记录一次
          const pairKey = `${sourceId}->${targetId}`;
          if (seenPairs.has(pairKey)) continue;
          seenPairs.add(pairKey);

          relations.push({
            source: sourceId,
            target: targetId,
            type: "has_many",
            confidence: 0.85,
          });
        }
      }
    }

    return relations;
  }

  /**
   * 解析嵌套路由路径，提取 has_many 关系的父子资源
   *
   * 嵌套路由格式：/api/<parent>/:<parent>Id/<child>
   * 示例：
   * - /api/users/:userId/orders → { parent: "Users", child: "Orders" }
   * - /api/users/:userId/orders/:orderId/items → { parent: "Users", child: "Orders" }（取前两层）
   * - /api/users → null（无嵌套）
   *
   * @param routePath 路由路径
   * @returns 父子资源名；非嵌套路由返回 null
   */
  private parseNestedRoute(routePath: string): { parent: string; child: string } | null {
    const segments = routePath.split("/").filter((s) => s.length > 0);
    // 跳过 "api" 前缀
    const resourceSegments = segments.filter((s) => s.toLowerCase() !== "api");

    // 寻找模式：resource / :param / resource
    for (let i = 0; i < resourceSegments.length - 2; i++) {
      const seg1 = resourceSegments[i]!;
      const seg2 = resourceSegments[i + 1]!;
      const seg3 = resourceSegments[i + 2]!;
      // seg2 是参数（以 : 开头），seg1 和 seg3 是资源
      if (seg2.startsWith(":") && !seg1.startsWith(":") && !seg3.startsWith(":")) {
        return {
          parent: this.resourceNameToConceptName(seg1),
          child: this.resourceNameToConceptName(seg3),
        };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------------
  // 私有方法：规则提取
  // ------------------------------------------------------------------------

  /**
   * 从注释/断言/验证逻辑提取业务规则
   *
   * v1.1 修订（P0-2 修复）：签名扩展 projectRoot，读取原始文件提取注释/断言。
   *
   * 实现策略：
   * 1. 遍历 CodeMap.files
   * 2. 对每个文件读取原始内容（path.join(projectRoot, fileInfo.path)）
   * 3. 正则提取：
   *    - 行注释 // @business-rule: ... 或 # @business-rule: ...
   *    - 块注释 斜杠星 @invariant: ... 星斜杠
   *    - assert(...) 语句
   *    - throw new BusinessError(...) / throw new ValidationError(...) 验证逻辑
   *
   * @param codeMap 已生成的 CodeMap（用于遍历文件列表）
   * @param projectRoot 项目根目录（用于读取原始文件）
   * @returns 业务规则列表
   */
  private extractRulesFromCode(codeMap: CodeMap, projectRoot: string): DomainRule[] {
    const rules: DomainRule[] = [];

    for (const file of codeMap.files) {
      if (file.parseStatus !== "ok") continue;

      const rawContent = this.readFileContent(projectRoot, file.path);
      if (!rawContent) continue;

      // 规范化 source 路径为相对项目根的 POSIX 路径
      const relPath = this.toRelativePosixPath(projectRoot, file.path);

      // 1. 提取注释中的业务规则（@business-rule / @invariant）
      for (const { pattern, source, textGroup } of RULE_COMMENT_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(rawContent)) !== null) {
          const ruleText = match[textGroup]?.trim();
          if (!ruleText) continue;
          rules.push({
            id: this.ruleTextToId(ruleText),
            rule: ruleText,
            source: `${relPath} (${source})`,
            confidence: 0.85,
          });
        }
      }

      // 2. 提取 assert 语句
      ASSERT_PATTERN.lastIndex = 0;
      let assertMatch: RegExpExecArray | null;
      while ((assertMatch = ASSERT_PATTERN.exec(rawContent)) !== null) {
        const assertText = assertMatch[1]?.trim();
        if (!assertText) continue;
        rules.push({
          id: this.ruleTextToId(`assert ${assertText}`),
          rule: `断言：${assertText}`,
          source: `${relPath} (assert)`,
          confidence: 0.75,
        });
      }

      // 3. 提取 throw new BusinessError/ValidationError/DomainError 语句
      THROW_PATTERN.lastIndex = 0;
      let throwMatch: RegExpExecArray | null;
      while ((throwMatch = THROW_PATTERN.exec(rawContent)) !== null) {
        const errorMsg = throwMatch[1]?.trim();
        if (!errorMsg) continue;
        rules.push({
          id: this.ruleTextToId(`throw ${errorMsg}`),
          rule: `业务异常：${errorMsg}`,
          source: `${relPath} (throw)`,
          confidence: 0.8,
        });
      }
    }

    return rules;
  }

  // ------------------------------------------------------------------------
  // 私有方法：辅助工具
  // ------------------------------------------------------------------------

  /**
   * 概念名称转 slug ID
   *
   * 规则：PascalCase → kebab-case
   * 示例：UserEntity → user-entity；OrderDTO → order-dto
   *
   * @param name 概念名称（PascalCase）
   * @returns slug ID（kebab-case）
   */
  private conceptNameToId(name: string): string {
    return name
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
      .toLowerCase();
  }

  /**
   * 规则文本转 slug ID
   *
   * 规则：保留字母数字与空格，空格转 -，转小写，截断 80 字符
   *
   * @param ruleText 规则文本
   * @returns slug ID
   */
  private ruleTextToId(ruleText: string): string {
    return ruleText
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 80);
  }

  /**
   * 过滤置信度 < 0.75 的条目
   *
   * @param items 待过滤条目列表
   * @returns 过滤后的条目列表
   */
  private filterByConfidence<T extends { confidence: number }>(items: T[]): T[] {
    return items.filter((item) => item.confidence >= CONFIDENCE_THRESHOLD);
  }

  /**
   * 读取文件内容
   *
   * 处理两种路径格式：
   * - 绝对路径（CodeMapGenerator 生成的 FileInfo.path 是绝对路径）：直接使用
   * - 相对路径（手动构造的 CodeMap 测试夹具）：path.join(projectRoot, relativePath)
   *
   * @param projectRoot 项目根目录
   * @param filePath 文件路径（绝对或相对）
   * @returns 文件内容；读取失败返回 null
   */
  private readFileContent(projectRoot: string, filePath: string): string | null {
    try {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
      if (!fs.existsSync(fullPath)) return null;
      return fs.readFileSync(fullPath, "utf-8");
    } catch {
      // 文件读取失败：跳过该文件，不阻塞整体提取
      return null;
    }
  }

  /**
   * 将文件路径转为相对项目根的 POSIX 路径
   *
   * 用于 DomainConcept.source / DomainRule.source 字段规范化。
   * CodeMapGenerator 生成的 FileInfo.path 是绝对路径，需转为相对路径便于溯源与跨机器复用。
   *
   * @param projectRoot 项目根目录
   * @param filePath 文件路径（绝对或相对）
   * @returns 相对项目根的 POSIX 路径
   */
  private toRelativePosixPath(projectRoot: string, filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return path.relative(projectRoot, filePath).split(path.sep).join("/");
    }
    return filePath.split(path.sep).join("/");
  }

  /**
   * SQL 表名转概念名（PascalCase）
   *
   * 规则：
   * - snake_case → PascalCase（user_orders → UserOrders）
   * - 单数化（users → User，orders → Order）
   * - 复数规则：以 s 结尾且长度 > 3 时去除 s（避免 is/as 等短词误处理）
   *
   * @param tableName SQL 表名
   * @returns PascalCase 概念名
   */
  private tableNameToConceptName(tableName: string): string {
    // snake_case → PascalCase
    const pascal = tableName
      .split("_")
      .filter((s) => s.length > 0)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
      .join("");
    // 简单单数化：长度 > 3 且以 s 结尾（非 ss）时去除末尾 s
    if (pascal.length > 3 && pascal.endsWith("s") && !pascal.endsWith("ss")) {
      return pascal.slice(0, -1);
    }
    return pascal;
  }

  /**
   * 资源名转概念名（PascalCase + 单数化）
   *
   * 规则：
   * - kebab-case → PascalCase（user-orders → UserOrders）
   * - 单数化（users → User）
   *
   * 用于 has_many 关系的父子资源名（DM-06 测试期望 user → order 单数形式）。
   *
   * @param resourceName 资源名（URL 段）
   * @returns PascalCase 概念名（单数）
   */
  private resourceNameToConceptName(resourceName: string): string {
    const pascal = resourceName
      .split("-")
      .filter((s) => s.length > 0)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
      .join("");
    // 简单单数化
    if (pascal.length > 3 && pascal.endsWith("s") && !pascal.endsWith("ss")) {
      return pascal.slice(0, -1);
    }
    return pascal;
  }

  /**
   * 资源名转 service 概念名（PascalCase 保留复数）
   *
   * 规则：
   * - kebab-case → PascalCase（user-orders → UserOrders）
   * - 保留复数形式（users → Users，不单数化）
   *
   * v1.1 修订（P2-6 修复）：
   * service 概念名保留复数形式，因为路由资源名通常代表集合（RESTful 语义）。
   * DM-05/07/07b/08 测试期望 service 名为 "Users"（复数）。
   *
   * @param resourceName 资源名（URL 段）
   * @returns PascalCase service 概念名（保留复数）
   */
  private resourceNameToServiceName(resourceName: string): string {
    return resourceName
      .split("-")
      .filter((s) => s.length > 0)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
      .join("");
  }

  /**
   * 在 SQL 内容中查找指定位置所属的 CREATE TABLE 表名
   *
   * 算法：从 position 向前查找最近的 CREATE TABLE 语句，提取表名。
   * 用于 FOREIGN KEY 关系定位所属表。
   *
   * @param content SQL 文件内容
   * @param position FOREIGN KEY 在内容中的位置
   * @returns 表名；未找到返回 null
   */
  private findTableNameAtPosition(content: string, position: number): string | null {
    // 从 position 向前查找最近的 CREATE TABLE
    const before = content.slice(0, position);
    const matches = [...before.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi)];
    if (matches.length === 0) return null;
    const lastMatch = matches[matches.length - 1];
    return lastMatch?.[1] ?? null;
  }

  /**
   * 收集项目中的 SQL 文件路径
   *
   * 扫描路径：
   * - projectRoot 根目录下的 *.sql
   * - migrations/
   * - db/migrate/
   * - sql/
   *
   * @param projectRoot 项目根目录
   * @returns SQL 文件相对路径列表
   */
  private collectSqlFiles(projectRoot: string): string[] {
    const sqlFiles: string[] = [];
    const scanDirs = ["", "migrations", "db/migrate", "db", "sql"];

    for (const dir of scanDirs) {
      const absDir = path.join(projectRoot, dir);
      if (!fs.existsSync(absDir)) continue;
      if (!fs.statSync(absDir).isDirectory()) continue;
      try {
        const entries = fs.readdirSync(absDir);
        for (const entry of entries) {
          const fullPath = path.join(absDir, entry);
          if (!fs.statSync(fullPath).isFile()) continue;
          if (!entry.toLowerCase().endsWith(".sql")) continue;
          // 转为相对项目根的 POSIX 路径
          const relPath = path.relative(projectRoot, fullPath).split(path.sep).join("/");
          sqlFiles.push(relPath);
        }
      } catch {
        // 目录读取失败：跳过该目录
      }
    }

    return sqlFiles;
  }

  /**
   * 构建简化版知识图谱
   *
   * 节点 = concepts，边 = relations。
   * 仅包含存在于 concepts 中的节点（relations 中引用的不存在概念会被过滤）。
   *
   * @param concepts 业务概念列表
   * @param relations 业务关系列表
   * @returns 知识图谱
   */
  private buildKnowledgeGraph(concepts: DomainConcept[], relations: DomainRelation[]): SimpleKnowledgeGraph {
    const conceptIds = new Set(concepts.map((c) => c.id));
    const nodes: GraphNode[] = concepts.map((c) => this.conceptToGraphNode(c));
    const edges: GraphEdge[] = relations
      .filter((r) => conceptIds.has(r.source) && conceptIds.has(r.target))
      .map((r) => ({
        source: r.source,
        target: r.target,
        relation: r.type,
        weight: r.confidence,
      }));
    return { nodes, edges };
  }

  /**
   * DomainConcept 转换为 GraphNode
   *
   * 类型映射：
   * - entity / aggregate → "entity"
   * - value_object / service → "concept"
   * - event → "process"
   *
   * @param concept 业务概念
   * @returns 图节点
   */
  private conceptToGraphNode(concept: DomainConcept): GraphNode {
    let nodeType: GraphNode["type"];
    switch (concept.type) {
      case "entity":
      case "aggregate":
        nodeType = "entity";
        break;
      case "event":
        nodeType = "process";
        break;
      case "value_object":
      case "service":
      default:
        nodeType = "concept";
        break;
    }
    return {
      id: concept.id,
      label: concept.name,
      type: nodeType,
      properties: {
        source: concept.source,
        confidence: concept.confidence,
        conceptType: concept.type,
        description: concept.description,
      },
    };
  }

  /**
   * 查找概念在关系列表中的相关概念 ID
   *
   * 用于 ConceptEntry.relatedConcepts 字段填充。
   * 相关概念 = 该概念作为 source 或 target 出现的关系中的另一方。
   *
   * @param conceptId 概念 ID
   * @param relations 关系列表
   * @returns 相关概念 ID 列表（去重）
   */
  private findRelatedConcepts(conceptId: string, relations: DomainRelation[]): string[] {
    const related = new Set<string>();
    for (const r of relations) {
      if (r.source === conceptId) related.add(r.target);
      if (r.target === conceptId) related.add(r.source);
    }
    return [...related];
  }
}
