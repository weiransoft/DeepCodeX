/**
 * Phase A 骨架生成器（EAG-P2 批次 9 S3 核心组件层）
 *
 * 本模块实现 `SkeletonGenerator` 类，对应 EAG-P2 批次 9 设计 §4.2 Phase A 骨架生成器：
 * 基于 plan.md + tasks.md + 任务卡，使用 EJS 模板渲染可编译的 TypeScript 骨架代码，
 * 每个骨架含明确的 `TODO(phase-b):` 占位供 Phase B LLM 填充。
 *
 * 核心职责：
 * 1. 解析 taskCard.fileCluster + plan.md 中对应的 ModuleSplit
 * 2. 根据 ModuleSplit.responsibility 与 InterfaceContract 判定需要哪些模板
 * 3. 从 taskCard + InterfaceContract + techStack 装配模板变量
 * 4. 用 zod schema 校验模板变量（从 templateRegistry.getVariableSchema 获取）
 * 5. 对每个模板调用 ejs.render(templateString, variables) 渲染骨架
 * 6. 扫描渲染结果中的 TODO(phase-b) 占位，生成 FillPlaceholder 列表
 * 7. 返回 SkeletonGenerationResult（含 files + templateVariables + fillPlaceholders + durationMs）
 *
 * 设计依据：
 * - EAG-P2 批次 9 设计 §4.2 Phase A 骨架生成器
 * - §4.2.2 关键技术决策（EJS 5.x + zod schema + 源码内嵌模板）
 * - §4.2.5 占位扫描算法（正则匹配 TODO(phase-b) + @param + 方法签名）
 * - §4.2.6 模板注册表协议（TemplateRegistry）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有方法入参与返回值使用 readonly + ReadonlyArray
 * - 顶层配置使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * 文件写入策略（§4.2.2）：
 * - 生成器只产字符串，不触碰文件系统（Orchestrator 统一写盘）
 * - 单一职责 + 可测试性 + 不破坏 worktree 隔离
 *
 * @module eag/coding/skeleton-generator
 */

import ejs from "ejs";
import type {
  FillPlaceholder,
  FillPlaceholderKind,
  GeneratedFile,
  GeneratedFileKind,
  SkeletonGenerationRequest,
  SkeletonGenerationResult,
  TemplateRegistry,
} from "./types";
import { DEFAULT_TEMPLATE_REGISTRY } from "./templates";
import type { InterfaceContract, ModuleSplit, TaskNode } from "../doc-driven/types";

// ============================================================================
// 常量与配置
// ============================================================================

/**
 * 占位扫描正则（对齐 EAG-P2 批次 9 设计 §4.2.5）
 *
 * 匹配模式：
 * - `// TODO(phase-b): <description>` 占位标记
 * - 后跟 0 个或多个 JSDoc 行（包括 `* @param` / `* @returns` / 空行 / 普通描述行 / JSDoc 结束行）
 * - 后跟可选的前导空格
 * - 后跟方法签名（可选 `static` 修饰符 + 方法名 + 左括号）
 *
 * 捕获组：
 * - 分组 1：占位描述（TODO(phase-b): 后的内容）
 * - 分组 2：方法名（用于生成 expectedSignature）
 *
 * 关键修正（v2）：
 * - 原 `\s*(@param.*?\n)*?` 只能匹配纯 `@param` 行，无法匹配 JSDoc 风格的 `   * @param ...` 行
 *   （因 `*` 不属于 `\s` 字符类），导致 JSDoc 注释的占位无法被扫描到。
 * - 新正则使用 `(?:\s*\*.*\n)*?` 兼容 JSDoc 注释块（`*` 前缀的行），并允许中间穿插空行与描述行。
 * - 在 JSDoc 块结束后添加 `\s*` 用于吃掉方法签名前的缩进空格（如 `  static create(...)` 的前导空格），
 *   否则非贪婪 `*?` 匹配完 JSDoc 行后无法跨过前导空格到达 `static` 关键字。
 *
 * 匹配范围限制：
 * - 当前仅匹配 method-body 类型占位（含方法签名 `(` 的场景）。
 * - class-body 类型占位（如 `export class X {`）由 Phase A 单独处理，不在此正则范围内。
 *
 * 全局标志 `g`：用于 exec 循环扫描全部占位。
 */
const PLACEHOLDER_PATTERN = /\/\/\s*TODO\(phase-b\):\s*(.+?)\s*\n(?:\s*\*.*\n)*?\s*(?:static\s+)?(\w+)\s*\(/g;

/**
 * 默认输出目录（相对 projectRoot）
 *
 * 对齐 §4.1.2 SkeletonGenerationRequest.outputDir 默认值 "src/"。
 */
const DEFAULT_OUTPUT_DIR = "src/" as const;

/**
 * 模块路径分隔符（用于从 moduleName 推导 modulePath）
 *
 * 对齐 §4.2.4 模板示例中的 modulePath 格式 "domain/order/OrderAggregate"。
 */
const MODULE_PATH_SEPARATOR = "/" as const;

// ============================================================================
// 异常类型
// ============================================================================

/**
 * 骨架生成器错误
 *
 * 当模板变量非法、模板渲染失败、ModuleSplit 解析失败等场景抛出。
 */
export class SkeletonGeneratorError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-request：请求字段非法
   *   - module-split-not-found：plan.md 中找不到对应的 ModuleSplit
   *   - template-not-registered：所需 kind 未在 TemplateRegistry 中注册
   *   - variable-validation-failed：模板变量 zod schema 校验失败
   *   - template-render-failed：EJS 渲染失败
   * @param detail 错误详情
   */
  constructor(
    public readonly kind:
      | "invalid-request"
      | "module-split-not-found"
      | "template-not-registered"
      | "variable-validation-failed"
      | "template-render-failed",
    public readonly detail: string
  ) {
    super(`骨架生成器错误 [${kind}]：${detail}`);
    this.name = "SkeletonGeneratorError";
  }
}

// ============================================================================
// PlanParser：plan.md 解析器（静态方法）
// ============================================================================

/**
 * plan.md 解析器
 *
 * 提供 `parseModuleSplit` 静态方法，从 plan.md 内容中提取指定模块的 ModuleSplit 与
 * 关联的 InterfaceContract 列表。
 *
 * 解析依据：复用 doc-driven/plan-generator.ts 的输出格式（§5.10.1 三文档契约）：
 * - 章节 2：模块切分（按 moduleName 组织）
 * - 章节 3：接口契约（按 interfaceName 组织，含 type 字段）
 *
 * 解析算法：
 * 1. 按 `## 2. 模块切分` 与 `## 3. 接口契约` 切分章节
 * 2. 在章节 2 中按 `### <moduleName>` 提取每个模块的责任与关键文件
 * 3. 在章节 3 中按接口名前缀匹配模块名提取相关接口契约
 *
 * 不可变优先：所有方法返回 ReadonlyArray / readonly 字段。
 */
export class PlanParser {
  /**
   * 从 plan.md 内容中解析全部 ModuleSplit 列表
   *
   * 算法：
   * 1. 定位 `## 2. 模块切分` 章节（到下一个 `## ` 之前）
   * 2. 按 `### ` 切分模块子段
   * 3. 每个子段首行作为 moduleName
   * 4. 解析 `- 模块职责：xxx` 提取 responsibility
   * 5. 解析 `- 依赖模块：a, b` 提取 dependsOn
   * 6. 解析 `- 关键文件：` 后的列表项提取 keyFiles
   *
   * @param planContent plan.md 内容字符串
   * @returns ModuleSplit 列表（解析失败时返回空数组）
   */
  static parseModuleSplits(planContent: string): ReadonlyArray<ModuleSplit> {
    // 定位章节 2：模块切分
    const sectionStart = planContent.indexOf("## 2. 模块切分");
    if (sectionStart < 0) return [];
    // 截取到下一个 ## 章节（避免吞入接口契约章节）
    const rest = planContent.slice(sectionStart);
    const nextSectionMatch = rest.slice(1).match(/\n## /);
    // 显式校验 index 字段非 undefined（RegExpMatchArray.index 在 strict 模式下可能为 undefined）
    const nextIndex = nextSectionMatch?.index;
    const sectionEnd = nextIndex !== undefined ? sectionStart + 1 + nextIndex : planContent.length;
    const sectionContent = planContent.slice(sectionStart, sectionEnd);

    // 按 ### 切分模块子段
    const moduleSegments = sectionContent.split(/^### /m).slice(1);
    const splits: ModuleSplit[] = [];

    for (const segment of moduleSegments) {
      const lines = segment.split(/\r?\n/);
      // 首行为 moduleName（去除空白与可能的列表标记）
      const moduleName = lines[0].trim().replace(/^[-*]\s+/, "");
      if (!moduleName) continue;

      let responsibility = "";
      const dependsOn: string[] = [];
      const keyFiles: string[] = [];

      // 逐行解析模块字段
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        // 模块职责
        const respMatch = line.match(/^- 模块职责[：:]\s*(.+)$/);
        if (respMatch) {
          responsibility = respMatch[1].trim();
          continue;
        }
        // 依赖模块（逗号分隔）
        const depMatch = line.match(/^- 依赖模块[：:]\s*(.+)$/);
        if (depMatch) {
          const deps = depMatch[1]
            .split(/[，,]/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && s !== "无");
          dependsOn.push(...deps);
          continue;
        }
        // 关键文件（列表项或单行）
        const keyFileMatch = line.match(/^- 关键文件[：:]\s*(.*)$/);
        if (keyFileMatch) {
          const inlineList = keyFileMatch[1].trim();
          if (inlineList) {
            // 单行形式：- 关键文件：a.ts, b.ts
            for (const f of inlineList.split(/[，,]/)) {
              const trimmed = f.trim();
              if (trimmed) keyFiles.push(trimmed);
            }
          }
          // 多行形式：后续 - path 项
          for (let j = i + 1; j < lines.length; j++) {
            const subLine = lines[j].trim();
            const subMatch = subLine.match(/^-\s+(.+)$/);
            if (!subMatch) break;
            keyFiles.push(subMatch[1].trim());
          }
          continue;
        }
      }

      splits.push(
        Object.freeze({
          moduleName,
          responsibility: responsibility || `${moduleName} 模块`,
          dependsOn: Object.freeze(dependsOn),
          keyFiles: Object.freeze(keyFiles),
        }) as ModuleSplit
      );
    }

    return Object.freeze(splits);
  }

  /**
   * 从 plan.md 内容中解析指定模块的 ModuleSplit
   *
   * @param planContent plan.md 内容字符串
   * @param moduleName 模块名（如 "OrderAggregate"）
   * @returns 匹配的 ModuleSplit；未找到时返回 null
   */
  static parseModuleSplit(planContent: string, moduleName: string): ModuleSplit | null {
    const splits = PlanParser.parseModuleSplits(planContent);
    return splits.find((s) => s.moduleName === moduleName) ?? null;
  }

  /**
   * 从 plan.md 内容中解析全部 InterfaceContract 列表
   *
   * 算法：
   * 1. 定位 `## 3. 接口契约` 章节
   * 2. 按 `### ` 切分接口子段
   * 3. 每个子段首行作为 interfaceName
   * 4. 解析 `- 类型：xxx` 提取 type
   * 5. 解析 `- 签名：xxx` 提取 signature
   * 6. 解析 `- 描述：xxx` 提取 description
   * 7. 解析 `- 错误码：xxx` 提取 errorCodes
   *
   * @param planContent plan.md 内容字符串
   * @returns InterfaceContract 列表（解析失败时返回空数组）
   */
  static parseInterfaceContracts(planContent: string): ReadonlyArray<InterfaceContract> {
    // 定位章节 3：接口契约
    const sectionStart = planContent.indexOf("## 3. 接口契约");
    if (sectionStart < 0) return [];
    const rest = planContent.slice(sectionStart);
    const nextSectionMatch = rest.slice(1).match(/\n## /);
    // 显式校验 index 字段非 undefined（RegExpMatchArray.index 在 strict 模式下可能为 undefined）
    const nextIndex = nextSectionMatch?.index;
    const sectionEnd = nextIndex !== undefined ? sectionStart + 1 + nextIndex : planContent.length;
    const sectionContent = planContent.slice(sectionStart, sectionEnd);

    // 按 ### 切分接口子段
    const interfaceSegments = sectionContent.split(/^### /m).slice(1);
    const contracts: InterfaceContract[] = [];

    for (const segment of interfaceSegments) {
      const lines = segment.split(/\r?\n/);
      const interfaceName = lines[0].trim().replace(/^[-*]\s+/, "");
      if (!interfaceName) continue;

      let type: InterfaceContract["type"] = "service-method";
      let signature = "";
      let description = "";
      const errorCodes: string[] = [];
      let requestSchema: string | undefined;
      let responseSchema: string | undefined;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        const typeMatch = line.match(/^- 类型[：:]\s*(.+)$/);
        if (typeMatch) {
          const t = typeMatch[1].trim();
          if (t === "REST API" || t === "rest-api") type = "rest-api";
          else if (t === "服务方法" || t === "service-method") type = "service-method";
          else if (t === "事件处理器" || t === "event-handler") type = "event-handler";
          else if (t === "定时任务" || t === "job") type = "job";
          continue;
        }
        const sigMatch = line.match(/^- 签名[：:]\s*(.+)$/);
        if (sigMatch) {
          signature = sigMatch[1].trim();
          continue;
        }
        const descMatch = line.match(/^- 描述[：:]\s*(.+)$/);
        if (descMatch) {
          description = descMatch[1].trim();
          continue;
        }
        const errMatch = line.match(/^- 错误码[：:]\s*(.+)$/);
        if (errMatch) {
          for (const e of errMatch[1].split(/[，,]/)) {
            const trimmed = e.trim();
            if (trimmed) errorCodes.push(trimmed);
          }
          continue;
        }
        const reqMatch = line.match(/^- 请求\s*Schema[：:]\s*(.+)$/);
        if (reqMatch) {
          requestSchema = reqMatch[1].trim();
          continue;
        }
        const respMatch = line.match(/^- 响应\s*Schema[：:]\s*(.+)$/);
        if (respMatch) {
          responseSchema = respMatch[1].trim();
          continue;
        }
      }

      contracts.push(
        Object.freeze({
          interfaceName,
          type,
          signature: signature || `${interfaceName}()`,
          description: description || `${interfaceName} 接口`,
          errorCodes: Object.freeze(errorCodes),
          requestSchema,
          responseSchema,
        }) as InterfaceContract
      );
    }

    return Object.freeze(contracts);
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从任务卡 ID 在 taskDag.nodes 中查找对应的 TaskNode
 *
 * TaskCard 不直接含 fileCluster 字段，需通过 taskCard.id 在 taskDag 中查找对应的
 * TaskNode，再从 TaskNode.fileCluster 获取文件簇名。
 *
 * @param request 骨架生成请求
 * @returns 匹配的 TaskNode；未找到时返回 null
 */
function findTaskNode(request: Readonly<SkeletonGenerationRequest>): TaskNode | null {
  const taskCardId = request.taskCard.id;
  for (const node of request.taskDag.nodes) {
    if (node.id === taskCardId) {
      return node;
    }
  }
  return null;
}

/**
 * 根据 ModuleSplit.responsibility 与 keyFiles 判定需要渲染的模板 kind 列表
 *
 * 启发式判定规则（对齐 §4.2.3 算法第 2 步）：
 * - responsibility 含 "聚合根" 或 keyFiles 含 Aggregate.ts → aggregate
 * - responsibility 含 "值对象" 或 keyFiles 含 Value.ts / Money.ts → value-object
 * - responsibility 含 "领域事件" 或 keyFiles 含 Event.ts → domain-event
 * - responsibility 含 "领域服务" 或 keyFiles 含 DomainService.ts → domain-service
 * - responsibility 含 "仓储" 或 keyFiles 含 Repository.ts → repository-port + repository-impl
 * - responsibility 含 "应用服务" 或 keyFiles 含 ApplicationService.ts → application-service
 * - responsibility 含 "DTO" 或 keyFiles 含 DTO.ts / Dto.ts → dto
 * - responsibility 含 "Controller" / "REST" 或 keyFiles 含 Controller.ts → rest-controller
 * - responsibility 含 "Saga" 或 keyFiles 含 Saga.ts → saga-orchestrator
 * - responsibility 含 "事件处理器" / "Handler" 或 keyFiles 含 Handler.ts → event-handler
 * - responsibility 含 "测试" 或 keyFiles 含 .test.ts / .spec.ts → test-spec
 * - 默认 → module-index（仅当无其他匹配时）
 *
 * @param moduleSplit 模块切分条目
 * @returns 需要渲染的模板 kind 列表（去重后，至少含 module-index）
 */
function determineRequiredKinds(moduleSplit: Readonly<ModuleSplit>): ReadonlyArray<GeneratedFileKind> {
  const kinds = new Set<GeneratedFileKind>();
  const resp = moduleSplit.responsibility.toLowerCase();
  const files = moduleSplit.keyFiles.map((f) => f.toLowerCase());

  // 聚合根
  if (resp.includes("聚合") || files.some((f) => f.includes("aggregate"))) {
    kinds.add("aggregate");
    kinds.add("domain-event"); // 聚合根通常配领域事件
  }
  // 值对象
  if (
    resp.includes("值对象") ||
    resp.includes("value") ||
    files.some((f) => f.includes("value") || f.includes("money"))
  ) {
    kinds.add("value-object");
  }
  // 领域事件
  if (resp.includes("事件") || resp.includes("event") || files.some((f) => f.includes("event"))) {
    kinds.add("domain-event");
  }
  // 领域服务
  if (resp.includes("领域服务") || resp.includes("domain service") || files.some((f) => f.includes("domainservice"))) {
    kinds.add("domain-service");
  }
  // 仓储
  if (resp.includes("仓储") || resp.includes("repository") || files.some((f) => f.includes("repository"))) {
    kinds.add("repository-port");
    kinds.add("repository-impl");
  }
  // 应用服务
  if (
    resp.includes("应用服务") ||
    resp.includes("application") ||
    files.some((f) => f.includes("applicationservice"))
  ) {
    kinds.add("application-service");
  }
  // DTO
  if (resp.includes("dto") || files.some((f) => f.includes("dto"))) {
    kinds.add("dto");
  }
  // REST Controller
  if (resp.includes("controller") || resp.includes("rest") || files.some((f) => f.includes("controller"))) {
    kinds.add("rest-controller");
  }
  // Saga
  if (resp.includes("saga") || files.some((f) => f.includes("saga"))) {
    kinds.add("saga-orchestrator");
  }
  // 事件处理器
  if (resp.includes("handler") || resp.includes("处理器") || files.some((f) => f.includes("handler"))) {
    kinds.add("event-handler");
  }
  // 测试
  if (
    resp.includes("测试") ||
    resp.includes("test") ||
    files.some((f) => f.endsWith(".test.ts") || f.endsWith(".spec.ts"))
  ) {
    kinds.add("test-spec");
  }

  // 默认：若没有任何匹配，生成 module-index
  if (kinds.size === 0) {
    kinds.add("module-index");
  }

  return Object.freeze(Array.from(kinds)) as ReadonlyArray<GeneratedFileKind>;
}

/**
 * 根据模板 kind 装配模板变量
 *
 * 装配规则（对齐 §4.2.3 算法第 3 步）：
 * - 通用变量：moduleName / modulePath / responsibility / requirementId / taskId
 * - 按 kind 派生专属变量（aggregateName / fields / businessMethods / ...）
 *
 * 字段推导策略：
 * - 类名：取 moduleName 去除路径分隔符后的最后一段
 * - 字段列表：从 keyFiles 与 responsibility 推导（首版提供最小可编译字段集）
 * - 业务方法：从 responsibility 关键词提取（如 "创建" / "取消" / "支付"）
 *
 * @param kind 模板类型
 * @param request 骨架生成请求
 * @param moduleSplit 模块切分条目
 * @returns 模板变量对象
 */
function assembleTemplateVariables(
  kind: GeneratedFileKind,
  request: Readonly<SkeletonGenerationRequest>,
  moduleSplit: Readonly<ModuleSplit>
): Record<string, unknown> {
  const taskCard = request.taskCard;
  const moduleName = moduleSplit.moduleName;
  // modulePath：以 src/ 为根的相对路径，使用 moduleName 简化
  const modulePath = `${request.outputDir || DEFAULT_OUTPUT_DIR}${moduleName}`;
  // responsibility / requirementId / taskId（5 个通用变量）
  const responsibility = moduleSplit.responsibility;
  const requirementId = taskCard.requirementId;
  const taskId = taskCard.id;

  // 类名：取 moduleName 末段（去除路径分隔符）
  const className = moduleName.includes(MODULE_PATH_SEPARATOR)
    ? (moduleName.split(MODULE_PATH_SEPARATOR).pop() ?? moduleName)
    : moduleName;

  // 通用字段集合（每个模板都需要的 5 个通用变量）
  const commonVars: Record<string, unknown> = {
    moduleName,
    modulePath,
    responsibility,
    requirementId,
    taskId,
  };

  // 按 kind 装配专属变量
  switch (kind) {
    case "aggregate": {
      // 聚合根：aggregateName + domainEventFileName + fields + businessMethods
      const aggregateName = className;
      const domainEventFileName = `${className}Created`;
      // 默认字段：从 keyFiles 推导不可行时提供最小字段集
      const fields = [
        { name: "id", type: "string", description: `${className} 唯一标识` },
        { name: "createdAt", type: "Date", description: "创建时间" },
      ];
      // 默认业务方法：从 responsibility 提取动词（启发式）
      const businessMethods = extractBusinessMethods(responsibility, className);
      return { ...commonVars, aggregateName, domainEventFileName, fields, businessMethods };
    }
    case "value-object": {
      const valueObjectName = className;
      const fields = [{ name: "value", type: "string", description: `${className} 值` }];
      return { ...commonVars, valueObjectName, fields };
    }
    case "domain-event": {
      const eventName = `${className}Created`;
      const aggregateName = className;
      const fields = [
        { name: "aggregateId", type: "string", description: "聚合根 ID" },
        { name: "occurredAt", type: "Date", description: "事件发生时间" },
      ];
      return { ...commonVars, eventName, aggregateName, fields };
    }
    case "domain-service": {
      const serviceClassName = `${className}Service`;
      const dependencies = [
        { name: "repository", type: `${className}Repository`, importPath: `./${className}Repository` },
      ];
      const methods = [
        {
          name: "execute",
          description: `执行 ${className} 业务操作`,
          inputType: `${className}Command`,
          outputType: `${className}Result`,
        },
      ];
      return { ...commonVars, serviceClassName, dependencies, methods };
    }
    case "repository-port": {
      const aggregateName = className;
      const aggregateImportPath = `./${className}`;
      const idType = "string";
      const queryMethods = [
        {
          name: "findById",
          description: `按 ID 查询 ${className}`,
          inputType: idType,
          outputType: `${className} | null`,
        },
      ];
      return { ...commonVars, aggregateName, aggregateImportPath, idType, queryMethods };
    }
    case "repository-impl": {
      const aggregateName = className;
      const aggregateImportPath = `./${className}`;
      const portImportPath = `./${className}Repository`;
      const idType = "string";
      const ormType =
        request.techStack.find((t) => t.toLowerCase().includes("typeorm") || t.toLowerCase().includes("prisma")) ??
        "TypeORM";
      const ormEntityName = `${className}Entity`;
      const ormEntityImportPath = `./${className}Entity`;
      return {
        ...commonVars,
        aggregateName,
        aggregateImportPath,
        portImportPath,
        idType,
        ormType,
        ormEntityName,
        ormEntityImportPath,
      };
    }
    case "application-service": {
      const serviceClassName = `${className}ApplicationService`;
      const dependencies = [
        { name: "domainService", type: `${className}Service`, importPath: `./${className}Service` },
      ];
      const useCases = [
        {
          name: "handle",
          description: `处理 ${className} 用例`,
          inputDto: `${className}InputDto`,
          outputDto: `${className}OutputDto`,
        },
      ];
      return { ...commonVars, serviceClassName, dependencies, useCases };
    }
    case "dto": {
      const dtoName = `${className}Dto`;
      const fields = [
        { name: "id", type: "string", description: `${className} ID`, validationRule: "@IsString() @IsNotEmpty()" },
      ];
      return { ...commonVars, dtoName, dtoType: "input" as const, fields };
    }
    case "rest-controller": {
      const controllerName = `${className}Controller`;
      const basePath = `/api/v1/${className.toLowerCase()}`;
      const applicationServiceName = `${className}ApplicationService`;
      const applicationServiceImportPath = `./${className}ApplicationService`;
      const endpoints = [
        {
          method: "POST" as const,
          path: "/",
          name: "create",
          description: `创建 ${className}`,
          inputDto: `${className}InputDto`,
          outputDto: `${className}OutputDto`,
          idempotent: true,
        },
      ];
      return {
        ...commonVars,
        controllerName,
        basePath,
        applicationServiceName,
        applicationServiceImportPath,
        endpoints,
      };
    }
    case "saga-orchestrator": {
      const sagaName = `${className}Saga`;
      const sagaStates = ["STARTED", "COMPLETED", "FAILED"];
      const steps = [
        {
          name: "execute",
          description: `执行 ${className} Saga 主流程`,
          action: "executeAction",
          compensation: "compensateAction",
        },
      ];
      return { ...commonVars, sagaName, sagaStates, steps };
    }
    case "event-handler": {
      const handlerClassName = `${className}EventHandler`;
      const eventName = `${className}Created`;
      const eventImportPath = `./${className}Created`;
      const dependencies = [{ name: "service", type: `${className}Service`, importPath: `./${className}Service` }];
      return { ...commonVars, handlerClassName, eventName, eventImportPath, dependencies };
    }
    case "test-spec": {
      const targetClassName = className;
      const targetImportPath = `./${className}`;
      const testCases = [
        {
          name: "shouldWork",
          description: `${className} 基础用例`,
          given: `${className} 实例已创建`,
          when: "调用业务方法",
          then: "应返回预期结果",
        },
      ];
      return { ...commonVars, targetClassName, targetImportPath, testCases };
    }
    case "module-index": {
      const exports = [{ symbol: className, path: `./${className}`, type: "class" as const }];
      return { ...commonVars, exports };
    }
    default: {
      // 理论上不会到达（GeneratedFileKind 已穷尽）
      return { ...commonVars };
    }
  }
}

/**
 * 从 responsibility 提取业务方法列表
 *
 * 启发式提取（对齐 §4.2.3 算法第 3 步）：
 * - 关键词 "创建" → create 方法
 * - 关键词 "更新" → update 方法
 * - 关键词 "取消" → cancel 方法
 * - 关键词 "删除" → delete 方法
 * - 关键词 "支付" → pay 方法
 * - 关键词 "查询" → query 方法
 * - 默认（无匹配）→ 返回空数组（schema 允许空业务方法列表）
 *
 * @param responsibility 模块职责描述
 * @param className 类名（用于生成 commandType）
 * @returns 业务方法列表
 */
function extractBusinessMethods(
  responsibility: string,
  className: string
): Array<{ name: string; description: string; commandType: string }> {
  const methods: Array<{ name: string; description: string; commandType: string }> = [];
  const lowerResp = responsibility.toLowerCase();

  const keywordMap: Array<{ keyword: string; name: string; desc: string }> = [
    { keyword: "创建", name: "create", desc: `创建 ${className}` },
    { keyword: "更新", name: "update", desc: `更新 ${className}` },
    { keyword: "取消", name: "cancel", desc: `取消 ${className}` },
    { keyword: "删除", name: "delete", desc: `删除 ${className}` },
    { keyword: "支付", name: "pay", desc: `支付 ${className}` },
    { keyword: "查询", name: "query", desc: `查询 ${className}` },
    { keyword: "create", name: "create", desc: `创建 ${className}` },
    { keyword: "update", name: "update", desc: `更新 ${className}` },
    { keyword: "cancel", name: "cancel", desc: `取消 ${className}` },
  ];

  const seen = new Set<string>();
  for (const item of keywordMap) {
    if (lowerResp.includes(item.keyword) && !seen.has(item.name)) {
      methods.push({
        name: item.name,
        description: item.desc,
        commandType: `${className}${item.name.charAt(0).toUpperCase() + item.name.slice(1)}Command`,
      });
      seen.add(item.name);
    }
  }

  return methods;
}

/**
 * 扫描渲染后的骨架代码中的 TODO(phase-b) 占位
 *
 * 算法（对齐 §4.2.5）：
 * 1. 使用 PLACEHOLDER_PATTERN 正则全局匹配
 * 2. 每个匹配项生成一个 FillPlaceholder
 * 3. 占位 ID 格式 "PH-NNN"，按顺序分配（001, 002, ...）
 * 4. 行号通过计算匹配位置在内容中的行数得来（1-based）
 * 5. kind 推断：含 @param → method-body；否则 → class-body
 * 6. expectedSignature 从匹配位置向后查找方法签名行
 *
 * @param content 渲染后的骨架代码
 * @param filePath 文件相对路径
 * @param startId 起始占位 ID 序号（用于多文件连续编号）
 * @returns FillPlaceholder 列表与下一个起始 ID
 */
function scanPlaceholders(
  content: string,
  filePath: string,
  startId: number
): { placeholders: FillPlaceholder[]; nextId: number } {
  const placeholders: FillPlaceholder[] = [];
  let currentId = startId;
  // 重置正则 lastIndex（全局正则在多次调用间可能残留状态）
  const pattern = new RegExp(PLACEHOLDER_PATTERN.source, "g");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const description = match[1].trim();
    // 注意：PLACEHOLDER_PATTERN 已修正为 2 个捕获组（description + methodName）
    // 原 match[3] 对应的 @param 分组已合并到 JSDoc 行匹配中
    const methodName = match[2];
    const matchStart = match.index;

    // 计算 1-based 行号
    let line = 1;
    for (let i = 0; i < matchStart && i < content.length; i++) {
      if (content[i] === "\n") line++;
    }

    // 推断 kind：含 @param 注释 → method-body；否则 → class-body
    const fullMatch = match[0];
    const kind: FillPlaceholderKind = fullMatch.includes("@param") ? "method-body" : "class-body";

    // 推断 expectedSignature：从匹配位置向后查找含 methodName 的签名行
    let expectedSignature: string | undefined;
    const afterMatch = content.slice(matchStart);
    const sigLineMatch = afterMatch.match(new RegExp(`(?:static\\s+)?${methodName}\\s*\\([^)]*\\)[^;]*`));
    if (sigLineMatch) {
      expectedSignature = sigLineMatch[0]
        .split(/\r?\n/)
        .map((l) => l.trim())
        .join(" ")
        .replace(/\s+/g, " ");
    }

    placeholders.push(
      Object.freeze({
        id: `PH-${String(currentId).padStart(3, "0")}`,
        filePath,
        line,
        kind,
        description,
        expectedSignature,
      }) as FillPlaceholder
    );
    currentId++;
  }

  return { placeholders, nextId: currentId };
}

// ============================================================================
// SkeletonGenerator 类
// ============================================================================

/**
 * Phase A 骨架生成器
 *
 * 对应 EAG-P2 批次 9 设计 §4.2 SkeletonGenerator：
 * 基于 plan.md + tasks.md + 任务卡，使用 EJS 模板渲染可编译的 TypeScript 骨架代码。
 *
 * 使用方式：
 * ```typescript
 * const generator = new SkeletonGenerator();
 * const result = generator.generate(request);
 * // result.files 含每个模板渲染后的骨架代码
 * // result.fillPlaceholders 含 Phase B 待填充的占位列表
 * // result.durationMs 含生成耗时
 * ```
 *
 * 不可变优先：
 * - 构造时注入的 TemplateRegistry 使用 Readonly 包裹
 * - generate() 返回的 SkeletonGenerationResult 通过 Object.freeze 冻结
 * - 所有内部辅助函数返回 ReadonlyArray / readonly 字段
 */
export class SkeletonGenerator {
  /**
   * 模板注册表（按 kind 索引模板字符串与 zod schema）
   *
   * 缺省为 DEFAULT_TEMPLATE_REGISTRY（13 种内置模板）。
   * 测试场景可注入自定义注册表以验证扩展模板。
   */
  private readonly templateRegistry: Readonly<TemplateRegistry>;

  /**
   * 日志回调（可选，用于输出调试信息）
   *
   * 当 logger 为 undefined 时静默执行；当传入回调时按需输出诊断信息。
   */
  private readonly logger?: (message: string, level?: "info" | "warn" | "error") => void;

  /**
   * 初始化骨架生成器
   *
   * @param templateRegistry 模板注册表（默认使用内置 DEFAULT_TEMPLATE_REGISTRY）
   * @param logger 日志回调（可选）
   */
  constructor(
    templateRegistry: Readonly<TemplateRegistry> = DEFAULT_TEMPLATE_REGISTRY,
    logger?: (message: string, level?: "info" | "warn" | "error") => void
  ) {
    this.templateRegistry = templateRegistry;
    this.logger = logger;
  }

  /**
   * 生成骨架代码（Phase A）
   *
   * 算法（对齐 §4.2.3）：
   * 1. 校验请求字段合法性
   * 2. 从 taskDag.nodes 中按 taskCard.id 查找 TaskNode，获取 fileCluster
   * 3. 从 planContent 解析 ModuleSplit（匹配 fileCluster）
   * 4. 根据 ModuleSplit.responsibility + keyFiles 判定需要哪些模板 kind
   * 5. 对每个 kind：
   *    a. 装配模板变量（通用变量 + kind 专属变量）
   *    b. 用 zod schema 校验模板变量
   *    c. 调用 ejs.render(templateString, variables) 渲染骨架
   *    d. 扫描渲染结果中的 TODO(phase-b) 占位
   * 6. 汇总所有 files + fillPlaceholders + templateVariables
   * 7. 返回冻结的 SkeletonGenerationResult
   *
   * @param request 骨架生成请求
   * @returns 骨架生成产出（含 files + templateVariables + fillPlaceholders + durationMs）
   * @throws {SkeletonGeneratorError} 请求非法 / ModuleSplit 未找到 / 模板变量校验失败 / 渲染失败
   */
  generate(request: Readonly<SkeletonGenerationRequest>): SkeletonGenerationResult {
    const startTime = Date.now();
    this.logger?.("SkeletonGenerator.generate 启动", "info");

    // 步骤 1：校验请求字段
    this.validateRequest(request);

    // 步骤 2：从 taskDag.nodes 查找 TaskNode 获取 fileCluster
    const taskNode = findTaskNode(request);
    if (!taskNode) {
      throw new SkeletonGeneratorError(
        "invalid-request",
        `taskDag.nodes 中未找到 taskCard.id="${request.taskCard.id}" 对应的 TaskNode`
      );
    }
    const fileCluster = taskNode.fileCluster;
    if (!fileCluster || fileCluster.trim().length === 0) {
      throw new SkeletonGeneratorError(
        "invalid-request",
        `TaskNode.fileCluster 为空（taskCard.id="${request.taskCard.id}"）`
      );
    }

    // 步骤 3：从 planContent 解析 ModuleSplit
    const moduleSplit = PlanParser.parseModuleSplit(request.planContent, fileCluster);
    if (!moduleSplit) {
      throw new SkeletonGeneratorError(
        "module-split-not-found",
        `plan.md 中未找到 moduleName="${fileCluster}" 的 ModuleSplit`
      );
    }

    // 步骤 4：判定需要的模板 kind 列表
    const requiredKinds = determineRequiredKinds(moduleSplit);
    this.logger?.(`需要渲染的模板 kind：${requiredKinds.join(", ")}`, "info");

    // 校验所有 kind 已在 TemplateRegistry 注册
    const registeredKinds = new Set(this.templateRegistry.listKinds());
    for (const kind of requiredKinds) {
      if (!registeredKinds.has(kind)) {
        throw new SkeletonGeneratorError(
          "template-not-registered",
          `模板 kind="${kind}" 未在 TemplateRegistry 中注册（已注册：${Array.from(registeredKinds).join(", ")}）`
        );
      }
    }

    // 步骤 5：对每个 kind 装配变量 + 校验 + 渲染 + 扫描占位
    const files: GeneratedFile[] = [];
    const allPlaceholders: FillPlaceholder[] = [];
    const templateVariablesSnapshot: Record<string, unknown> = {};
    let placeholderId = 1;

    for (const kind of requiredKinds) {
      // 5a. 装配模板变量
      const variables = assembleTemplateVariables(kind, request, moduleSplit);
      templateVariablesSnapshot[kind] = Object.freeze({ ...variables });

      // 5b. 用 zod schema 校验模板变量
      const schema = this.templateRegistry.getVariableSchema(kind);
      const validationResult = schema.validate(variables);
      if (!validationResult.success) {
        const errors = validationResult.errors ?? ["未知校验错误"];
        throw new SkeletonGeneratorError(
          "variable-validation-failed",
          `kind="${kind}" 模板变量校验失败：${errors.join("; ")}`
        );
      }

      // 5c. 调用 ejs.render 渲染骨架
      const templateString = this.templateRegistry.getTemplate(kind);
      let renderedContent: string;
      try {
        renderedContent = ejs.render(templateString, variables, {
          // 关闭严格模式：允许变量未定义时输出空字符串（避免 EJS 抛错）
          strict: false,
          // 不输出调试信息
          debug: false,
          // 不缓存编译后的模板（每次渲染独立）
          cache: false,
        });
      } catch (e) {
        throw new SkeletonGeneratorError(
          "template-render-failed",
          `kind="${kind}" EJS 渲染失败：${e instanceof Error ? e.message : String(e)}`
        );
      }

      // 5d. 计算文件相对路径（outputDir + modulePath + kind 后缀）
      const className = moduleSplit.moduleName.includes(MODULE_PATH_SEPARATOR)
        ? (moduleSplit.moduleName.split(MODULE_PATH_SEPARATOR).pop() ?? moduleSplit.moduleName)
        : moduleSplit.moduleName;
      const relativePath = computeFilePath(request.outputDir, moduleSplit.moduleName, kind, className);

      // 5e. 扫描渲染结果中的 TODO(phase-b) 占位
      const { placeholders, nextId } = scanPlaceholders(renderedContent, relativePath, placeholderId);
      allPlaceholders.push(...placeholders);
      placeholderId = nextId;

      // 5f. 收集文件
      files.push(
        Object.freeze({
          relativePath,
          content: renderedContent,
          kind,
          taskId: request.taskCard.id,
          requirementId: request.taskCard.requirementId,
        }) as GeneratedFile
      );
    }

    // 步骤 6：构建 SkeletonGenerationResult
    const durationMs = Date.now() - startTime;
    this.logger?.(`SkeletonGenerator.generate 完成，耗时 ${durationMs}ms，生成 ${files.length} 个文件`, "info");

    return Object.freeze({
      files: Object.freeze(files) as ReadonlyArray<GeneratedFile>,
      templateVariables: Object.freeze(templateVariablesSnapshot) as Readonly<Record<string, unknown>>,
      fillPlaceholders: Object.freeze(allPlaceholders) as ReadonlyArray<FillPlaceholder>,
      durationMs,
    }) as SkeletonGenerationResult;
  }

  // ========================================================================
  // 私有辅助方法
  // ========================================================================

  /**
   * 校验 SkeletonGenerationRequest 字段合法性
   *
   * 校验规则：
   * - planContent / tasksContent 必须为非空字符串
   * - taskDag 必须含 nodes 数组
   * - taskCard 必须含非空 id / requirementId
   * - techStack 必须为数组
   * - projectRoot / outputDir 必须为非空字符串
   *
   * @param request 待校验请求
   * @throws {SkeletonGeneratorError} 任一字段非法时抛出
   */
  private validateRequest(request: Readonly<SkeletonGenerationRequest>): void {
    if (typeof request.planContent !== "string" || request.planContent.trim().length === 0) {
      throw new SkeletonGeneratorError("invalid-request", "planContent 必须为非空字符串");
    }
    if (typeof request.tasksContent !== "string" || request.tasksContent.trim().length === 0) {
      throw new SkeletonGeneratorError("invalid-request", "tasksContent 必须为非空字符串");
    }
    if (!request.taskDag || !Array.isArray(request.taskDag.nodes)) {
      throw new SkeletonGeneratorError("invalid-request", "taskDag 必须含 nodes 数组");
    }
    if (!request.taskCard || typeof request.taskCard.id !== "string" || request.taskCard.id.trim().length === 0) {
      throw new SkeletonGeneratorError("invalid-request", "taskCard.id 必须为非空字符串");
    }
    if (typeof request.taskCard.requirementId !== "string" || request.taskCard.requirementId.trim().length === 0) {
      throw new SkeletonGeneratorError("invalid-request", "taskCard.requirementId 必须为非空字符串");
    }
    if (!Array.isArray(request.techStack)) {
      throw new SkeletonGeneratorError("invalid-request", "techStack 必须为数组");
    }
    if (typeof request.projectRoot !== "string" || request.projectRoot.trim().length === 0) {
      throw new SkeletonGeneratorError("invalid-request", "projectRoot 必须为非空字符串");
    }
    if (typeof request.outputDir !== "string" || request.outputDir.trim().length === 0) {
      throw new SkeletonGeneratorError("invalid-request", "outputDir 必须为非空字符串");
    }
  }
}

// ============================================================================
// 辅助函数：计算生成文件的相对路径
// ============================================================================

/**
 * 计算生成文件的相对路径
 *
 * 路径规则（对齐 §4.1.2 GeneratedFile.relativePath）：
 * - outputDir + modulePath + 文件名
 * - 文件名按 kind 后缀生成（如 Aggregate.ts / Repository.ts / Controller.ts）
 *
 * 范例：
 * - kind="aggregate", outputDir="src/", moduleName="OrderAggregate" → "src/OrderAggregate.ts"
 * - kind="repository-port", outputDir="src/", moduleName="OrderAggregate" → "src/OrderRepository.ts"
 * - kind="rest-controller", outputDir="src/", moduleName="OrderAggregate" → "src/OrderController.ts"
 *
 * @param outputDir 输出目录（如 "src/"）
 * @param moduleName 模块名（如 "OrderAggregate"）
 * @param kind 模板类型
 * @param className 类名（moduleName 末段）
 * @returns 文件相对路径
 */
function computeFilePath(outputDir: string, moduleName: string, kind: GeneratedFileKind, className: string): string {
  // 规范化 outputDir：确保以 / 结尾
  const normalizedDir = outputDir.endsWith(MODULE_PATH_SEPARATOR) ? outputDir : `${outputDir}${MODULE_PATH_SEPARATOR}`;

  // 按 kind 派生文件名后缀
  const fileNameMap: Record<GeneratedFileKind, string> = {
    aggregate: `${className}.ts`,
    "value-object": `${className}.ts`,
    "domain-event": `${className}Created.ts`,
    "domain-service": `${className}Service.ts`,
    "repository-port": `${className}Repository.ts`,
    "repository-impl": `${className}RepositoryImpl.ts`,
    "application-service": `${className}ApplicationService.ts`,
    dto: `${className}Dto.ts`,
    "rest-controller": `${className}Controller.ts`,
    "saga-orchestrator": `${className}Saga.ts`,
    "event-handler": `${className}EventHandler.ts`,
    "test-spec": `${className}.test.ts`,
    "module-index": `index.ts`,
  };

  return `${normalizedDir}${fileNameMap[kind]}`;
}
