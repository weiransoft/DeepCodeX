/**
 * K2 业务流程还原器实现（EAG-P2 批次 8）
 *
 * 本模块实现 `BusinessFlowDiscoverer` 类，提供 EAG 方案 §5.11.2 K2 业务流程还原的真实逻辑。
 *
 * 核心职责：
 * - discover(entryPoint)：从指定入口点推导业务流程
 * - 解析 HTTP 路由 + 调用链 + MQ 生产/消费关系
 * - 识别状态机（状态字段 + 迁移条件 + 终态）
 * - 产出 Mermaid 流程图（flowchart TD 格式）+ Mermaid 状态图（stateDiagram-v2 格式）
 *
 * §5.11.2 K2 业务流程还原设计要求：
 * 从 HTTP 路由 + 调用链 + 消息队列生产/消费关系推导业务流程
 * （如"下单→扣库存→发 MQ→支付回调→状态机流转"）
 *
 * 设计依据：
 * - EAG 方案 §5.11.2 K2 业务流程还原
 * - Mermaid 流程图语法（flowchart TD）
 * - Mermaid 状态图语法（stateDiagram-v2）
 *
 * 实现说明：
 * - 不依赖外部 AST 解析库（避免引入依赖），采用基于正则的调用链提取
 * - 多语言支持（TypeScript/JavaScript/Java/Python）
 * - 状态机识别：扫描含 status/state 字段 + 状态常量的类
 * - Mermaid 渲染：基于 steps/branches/asyncBoundaries 生成 flowchart TD
 *
 * 不可变优先：
 * - 公开方法返回冻结对象
 *
 * @module eag/pkc/l3/business-flow-discoverer
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AsyncBoundary,
  FlowBranch,
  FlowResult,
  FlowStep,
  FlowStepType,
  StateMachine,
  StateMachineResult,
  StateTransition,
} from "./l3-types";

// ============================================================================
// 调用链提取规则
// ============================================================================

/**
 * 调用链提取规则（用于发现步骤间的调用关系）
 */
interface CallChainRule {
  /** 正则表达式（捕获组 1=被调用方法名，2=所属对象/类） */
  readonly pattern: RegExp;
  /** 文件扩展名 */
  readonly extensions: ReadonlyArray<string>;
}

/**
 * 多语言调用链提取规则表
 *
 * 覆盖模式：
 * - this.method() / this.service.method()
 * - await service.method()
 * - service.method()
 * - producer.send() / producer.publish()
 * - queue.process() / consumer.subscribe()
 */
const CALL_CHAIN_RULES: ReadonlyArray<CallChainRule> = Object.freeze([
  // TypeScript/JavaScript：this.method() / this.service.method()
  {
    pattern: /\b(?:await\s+)?(?:this\.([a-z_][A-Za-z0-9_]*)\s*\.(?:[a-z_][A-Za-z0-9_]*)\s*\()/g,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  // TypeScript/JavaScript：service.method()（await 可选）
  {
    pattern: /\b(?:await\s+)?([a-z][A-Za-z0-9_]*)\.([a-z_][A-Za-z0-9_]*)\s*\(/g,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  // Java：service.method()
  {
    pattern: /\b([a-z][A-Za-z0-9_]*)\.([a-z_][A-Za-z0-9_]*)\s*\(/g,
    extensions: [".java"],
  },
  // Python：self.method() / service.method()
  {
    pattern: /\b(?:self\.([a-z_][A-Za-z0-9_]*)|([a-z_][A-Za-z0-9_]*)\.([a-z_][A-Za-z0-9_]*))\s*\(/g,
    extensions: [".py"],
  },
]);

// ============================================================================
// 状态机识别规则
// ============================================================================

/**
 * 状态字段命名模式（用于识别状态机的状态字段）
 *
 * 匹配这些字段名视为状态字段：
 * - status / state / order_status / payment_status / workflow_state
 */
const STATE_FIELD_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\b(status|state|order_status|payment_status|workflow_state|orderState|paymentState)\b/gi,
]);

/**
 * 状态值常量模式（用于识别状态值）
 *
 * 匹配模式：
 * - 全大写 + 下划线（如 PENDING / PAID / SHIPPED）
 * - 字符串字面量（如 'pending' / 'paid'）
 */
const STATE_VALUE_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\b([A-Z][A-Z_]{2,}(?:_[A-Z]+)+)\b/g, // SNAKE_CASE 全大写
  /['"]([a-z][a-z_]+)['"]/gi, // 小写字符串字面量
]);

// ============================================================================
// MQ 生产/消费识别规则
// ============================================================================

/**
 * MQ 生产方法识别规则
 */
const MQ_PRODUCER_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\.\s*(?:send|publish|emit|produce|dispatch)\s*\(\s*['"`]?([^'"`\s,)]+)/g,
  /\bQueue\s*::\s*(?:push|dispatch|later)\s*\(\s*['"`]?([^'"`\s,)]+)/g,
]);

/**
 * MQ 消费方法识别规则
 */
const MQ_CONSUMER_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /@(?:RabbitSubscribe|KafkaListener|Processor)\s*\(\s*[^)]*?['"`]([^'"`]+)['"`]/g,
  /\bqueue\.process\s*\(\s*['"`]?([^'"`\s,)]+)/g,
  /\bconsumer\.subscribe\s*\(\s*['"`]?([^'"`\s,)]+)/g,
]);

// ============================================================================
// 异常类型
// ============================================================================

/**
 * 业务流程还原错误（路径不存在或解析失败时抛出）
 */
export class BusinessFlowDiscovererError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-entry：入口点非法
   *   - entry-not-found：入口点未找到
   *   - parse-error：解析失败
   * @param detail 错误详情
   */
  constructor(
    public readonly kind: "invalid-entry" | "entry-not-found" | "parse-error",
    public readonly detail: string
  ) {
    super(`业务流程还原错误 [${kind}]：${detail}`);
    this.name = "BusinessFlowDiscovererError";
  }
}

// ============================================================================
// 内部辅助类型
// ============================================================================

/**
 * 解析中的步骤缓存（symbolName → FlowStep）
 */
interface StepCache {
  readonly step: FlowStep;
  readonly calleeNames: ReadonlyArray<string>;
  readonly mqProducedChannels: ReadonlyArray<string>;
  readonly mqConsumedChannels: ReadonlyArray<string>;
}

// ============================================================================
// BusinessFlowDiscoverer 类
// ============================================================================

/**
 * 业务流程还原器（实现 §5.11.2 K2 业务流程还原）
 *
 * 提供真实还原逻辑（禁止 mock）：
 * - discover：从指定入口点推导业务流程
 *   1. 查找入口点定义文件（按 symbolName 搜索源代码）
 *   2. 提取入口点步骤（HTTP 路由处理器）
 *   3. BFS 遍历调用链，逐步发现服务方法/MQ 生产/消费步骤
 *   4. 识别状态机（扫描含状态字段的类）
 *   5. 生成 Mermaid 流程图 + 状态图
 *
 * 使用方式：
 * ```typescript
 * const discoverer = new BusinessFlowDiscoverer(projectRoot);
 * const flow = await discoverer.discover("OrderController.create");
 * console.log(flow.mermaidFlow); // Mermaid 流程图字符串
 * ```
 */
export class BusinessFlowDiscoverer {
  /** 项目根目录绝对路径 */
  private readonly projectRoot: string;

  /** 最大 BFS 深度（防止无限遍历） */
  private readonly maxDepth: number;

  /** 源代码文件扩展名集合 */
  private readonly sourceExtensions: ReadonlySet<string>;

  /**
   * @param projectRoot 项目根目录绝对路径
   * @param maxDepth BFS 最大深度（默认 5）
   */
  constructor(projectRoot: string, maxDepth: number = 5) {
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new BusinessFlowDiscovererError("invalid-entry", "projectRoot 必须为非空字符串");
    }
    this.projectRoot = projectRoot;
    this.maxDepth = maxDepth;
    this.sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".java", ".py", ".go"]);
  }

  /**
   * 从指定入口点推导业务流程
   *
   * 执行流程：
   * 1. 解析 entryPoint（格式："FilePath:SymbolName" 或 "SymbolName"）
   * 2. 在项目内搜索入口点定义文件
   * 3. BFS 遍历调用链，构建 FlowStep 列表
   * 4. 收集分支与异步边界
   * 5. 识别状态机（扫描含状态字段的类）
   * 6. 渲染 Mermaid 流程图 + 状态图
   *
   * @param entryPoint 入口点（如"OrderController.create"）
   * @returns 业务流程还原结果
   * @throws {BusinessFlowDiscovererError} 入口点非法或未找到时抛出
   */
  async discover(entryPoint: string): Promise<FlowResult> {
    // 入参校验
    if (typeof entryPoint !== "string" || entryPoint.trim().length === 0) {
      throw new BusinessFlowDiscovererError("invalid-entry", "入口点必须为非空字符串");
    }

    // 搜索入口点定义
    const entryStep = await this.findEntryStep(entryPoint);
    if (!entryStep) {
      throw new BusinessFlowDiscovererError("entry-not-found", `入口点 ${entryPoint} 未在项目中找到`);
    }

    // BFS 遍历调用链
    const steps: FlowStep[] = [entryStep];
    const branches: FlowBranch[] = [];
    const asyncBoundaries: AsyncBoundary[] = [];
    const visited = new Set<string>([entryStep.stepId]);
    const queue: Array<{ readonly step: FlowStep; readonly depth: number }> = [{ step: entryStep, depth: 0 }];

    while (queue.length > 0) {
      const { step, depth } = queue.shift()!;
      if (depth >= this.maxDepth) {
        continue;
      }

      // 解析当前步骤的调用链
      const cache = await this.analyzeStep(step);
      if (!cache) {
        continue;
      }

      // 对每个被调用方，创建新步骤并建立分支
      for (const calleeName of cache.calleeNames) {
        const calleeStep = await this.findStepBySymbolName(calleeName, step);
        if (!calleeStep) {
          continue;
        }
        if (visited.has(calleeStep.stepId)) {
          // 已访问：仅建立分支
          branches.push(
            Object.freeze({
              fromStepId: step.stepId,
              toStepId: calleeStep.stepId,
              label: "call",
            })
          );
          continue;
        }
        visited.add(calleeStep.stepId);
        steps.push(calleeStep);
        branches.push(
          Object.freeze({
            fromStepId: step.stepId,
            toStepId: calleeStep.stepId,
            label: "call",
          })
        );
        queue.push({ step: calleeStep, depth: depth + 1 });
      }

      // 处理 MQ 生产/消费（异步边界）
      for (const channel of cache.mqProducedChannels) {
        // 查找消费该通道的步骤
        const consumerStep = await this.findMqConsumerStep(channel, step);
        if (consumerStep && !visited.has(consumerStep.stepId)) {
          visited.add(consumerStep.stepId);
          steps.push(consumerStep);
          asyncBoundaries.push(
            Object.freeze({
              producerStepId: step.stepId,
              consumerStepId: consumerStep.stepId,
              channel,
              channelType: "mq",
            })
          );
          branches.push(
            Object.freeze({
              fromStepId: step.stepId,
              toStepId: consumerStep.stepId,
              label: `async:${channel}`,
            })
          );
          queue.push({ step: consumerStep, depth: depth + 1 });
        }
      }
    }

    // 识别状态机
    const stateMachines = await this.discoverStateMachines();

    // 渲染 Mermaid 流程图
    const mermaidFlow = this.renderMermaidFlow(steps, branches, asyncBoundaries);

    // 渲染状态机 Mermaid 状态图
    const stateMachineResults: StateMachineResult[] = stateMachines.map((sm) =>
      Object.freeze({
        stateMachine: sm,
        mermaidStateDiagram: this.renderMermaidStateDiagram(sm),
      })
    );

    return Object.freeze({
      entryPoint,
      steps: Object.freeze(steps.map((s) => Object.freeze({ ...s }))),
      branches: Object.freeze(branches.map((b) => Object.freeze({ ...b }))),
      asyncBoundaries: Object.freeze(asyncBoundaries.map((a) => Object.freeze({ ...a }))),
      mermaidFlow,
      stateMachines: Object.freeze(stateMachineResults.map((s) => Object.freeze({ ...s }))),
    });
  }

  // ============================ 私有辅助方法 ============================

  /**
   * 搜索入口点定义文件
   *
   * @param entryPoint 入口点符号名（如"OrderController.create"）
   * @returns 入口点步骤（未找到返回 null）
   */
  private async findEntryStep(entryPoint: string): Promise<FlowStep | null> {
    // 解析入口点：支持"FilePath:SymbolName"或"SymbolName"格式
    let filePath: string | undefined;
    let symbolName: string = entryPoint;

    if (entryPoint.includes(":")) {
      const colonIdx = entryPoint.indexOf(":");
      filePath = entryPoint.slice(0, colonIdx);
      symbolName = entryPoint.slice(colonIdx + 1);
    }

    // 若提供文件路径，直接读取该文件查找符号
    if (filePath) {
      return await this.findStepInFile(filePath, symbolName, "http-handler");
    }

    // 否则：在项目内全局搜索符号
    return await this.findStepBySymbolName(symbolName, undefined);
  }

  /**
   * 按符号名搜索步骤
   *
   * @param symbolName 符号名（如"OrderController.create"或"create"）
   * @param fromStep 来源步骤（用于推断文件路径，可选）
   * @returns 步骤（未找到返回 null）
   */
  private async findStepBySymbolName(symbolName: string, fromStep?: FlowStep): Promise<FlowStep | null> {
    // 优先在来源步骤同目录搜索
    if (fromStep) {
      const dir = path.dirname(fromStep.filePath);
      const step = await this.findStepInDirectory(dir, symbolName, "service-method");
      if (step) {
        return step;
      }
    }

    // 全局搜索
    return await this.findStepGlobal(symbolName, "service-method");
  }

  /**
   * 在指定文件中查找符号
   *
   * @param filePath 文件相对路径
   * @param symbolName 符号名
   * @param stepType 步骤类型
   * @returns 步骤（未找到返回 null）
   */
  private async findStepInFile(filePath: string, symbolName: string, stepType: FlowStepType): Promise<FlowStep | null> {
    const absolutePath = path.join(this.projectRoot, filePath);
    try {
      const content = await fs.readFile(absolutePath, "utf-8");
      const line = this.findSymbolLine(content, symbolName);
      if (line < 0) {
        return null;
      }
      return this.createStep(symbolName, filePath, line, stepType, content);
    } catch {
      return null;
    }
  }

  /**
   * 在指定目录中查找符号
   *
   * @param dir 目录相对路径
   * @param symbolName 符号名
   * @param stepType 步骤类型
   * @returns 步骤（未找到返回 null）
   */
  private async findStepInDirectory(dir: string, symbolName: string, stepType: FlowStepType): Promise<FlowStep | null> {
    const absoluteDir = path.join(this.projectRoot, dir);
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!this.sourceExtensions.has(ext)) continue;
      const relPath = path.join(dir, entry.name);
      const step = await this.findStepInFile(relPath, symbolName, stepType);
      if (step) {
        return step;
      }
    }
    return null;
  }

  /**
   * 在整个项目内全局搜索符号
   *
   * @param symbolName 符号名
   * @param stepType 步骤类型
   * @returns 步骤（未找到返回 null）
   */
  private async findStepGlobal(symbolName: string, stepType: FlowStepType): Promise<FlowStep | null> {
    return await this.searchDirectory(this.projectRoot, "", symbolName, stepType, 0, 3);
  }

  /**
   * 递归搜索目录（带深度限制）
   *
   * @param absoluteDir 当前绝对目录
   * @param relativeDir 当前相对目录
   * @param symbolName 符号名
   * @param stepType 步骤类型
   * @param depth 当前深度
   * @param maxDepth 最大深度
   * @returns 步骤（未找到返回 null）
   */
  private async searchDirectory(
    absoluteDir: string,
    relativeDir: string,
    symbolName: string,
    stepType: FlowStepType,
    depth: number,
    maxDepth: number
  ): Promise<FlowStep | null> {
    if (depth > maxDepth) {
      return null;
    }
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      // 跳过 node_modules / .git / dist / build
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "dist", "build", "target", "__pycache__"].includes(entry.name)) {
          continue;
        }
        const subAbs = path.join(absoluteDir, entry.name);
        const subRel = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        const result = await this.searchDirectory(subAbs, subRel, symbolName, stepType, depth + 1, maxDepth);
        if (result) {
          return result;
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!this.sourceExtensions.has(ext)) continue;
        const relPath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        const step = await this.findStepInFile(relPath, symbolName, stepType);
        if (step) {
          return step;
        }
      }
    }
    return null;
  }

  /**
   * 在文件内容中查找符号所在行号
   *
   * @param content 文件内容
   * @param symbolName 符号名（如"OrderController.create"或"create"）
   * @returns 行号（1-based，未找到返回 -1）
   */
  private findSymbolLine(content: string, symbolName: string): number {
    // 解析符号名：支持"ClassName.method"或"method"
    let pattern: RegExp;
    if (symbolName.includes(".")) {
      const [className, methodName] = symbolName.split(".");
      // 匹配 class ClassName { method() { 或 class ClassName extends { method() {
      pattern = new RegExp(`\\bclass\\s+${className}\\b[\\s\\S]*?\\b(?:${methodName})\\s*\\(`, "g");
    } else {
      // 匹配 method() {
      pattern = new RegExp(`\\b(?:function\\s+)?${symbolName}\\s*\\(`, "g");
    }

    const match = pattern.exec(content);
    if (!match) {
      return -1;
    }
    // 计算行号
    let line = 1;
    for (let i = 0; i < match.index && i < content.length; i++) {
      if (content.charCodeAt(i) === 10) {
        line++;
      }
    }
    return line;
  }

  /**
   * 创建步骤
   *
   * @param symbolName 符号名
   * @param filePath 文件路径
   * @param line 行号
   * @param stepType 步骤类型
   * @param content 文件内容
   * @returns 步骤对象
   */
  private createStep(
    symbolName: string,
    filePath: string,
    line: number,
    stepType: FlowStepType,
    content: string
  ): FlowStep {
    // 生成 stepId（filePath:symbolName:line）
    const stepId = `${filePath}:${symbolName}:${line}`;

    // 提取步骤描述（符号上方注释或符号名）
    const description = this.extractStepDescription(content, line, symbolName);

    return Object.freeze({
      stepId,
      name: symbolName,
      type: stepType,
      filePath,
      symbolName,
      startLine: line,
      description,
    });
  }

  /**
   * 提取步骤描述
   *
   * @param content 文件内容
   * @param line 符号行号
   * @param symbolName 符号名
   * @returns 步骤描述
   */
  private extractStepDescription(content: string, line: number, symbolName: string): string {
    const lines = content.split("\n");
    // 从符号行向前查找最近的注释
    for (let i = line - 2; i >= 0 && i >= line - 5; i--) {
      if (i < 0 || i >= lines.length) break;
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) {
        return trimmed.replace(/^(\/\/|\*|#)\s*/, "").slice(0, 100);
      }
    }
    return `${symbolName}（${this.translateStepType("")}）`;
  }

  /**
   * 翻译步骤类型为中文描述
   */
  private translateStepType(stepType: string): string {
    const map: Record<string, string> = {
      "http-handler": "HTTP 处理器",
      "service-method": "服务方法",
      "mq-producer": "MQ 生产者",
      "mq-consumer": "MQ 消费者",
      "scheduled-task": "定时任务",
      "db-write": "数据库写",
      "db-read": "数据库读",
    };
    return map[stepType] ?? "步骤";
  }

  /**
   * 分析单个步骤的调用链
   *
   * @param step 步骤
   * @returns 步骤缓存（含被调用方、MQ 通道）
   */
  private async analyzeStep(step: FlowStep): Promise<StepCache | null> {
    const absolutePath = path.join(this.projectRoot, step.filePath);
    let content: string;
    try {
      content = await fs.readFile(absolutePath, "utf-8");
    } catch {
      return null;
    }

    // 提取步骤方法体（从 startLine 开始到下一个同级方法或文件末尾）
    const methodBody = this.extractMethodBody(content, step.startLine);

    // 提取被调用方
    const calleeNames = this.extractCallees(methodBody, step.filePath);

    // 提取 MQ 生产通道
    const mqProducedChannels = this.extractMqProducedChannels(methodBody);

    // 提取 MQ 消费通道（步骤本身是消费者时）
    const mqConsumedChannels = this.extractMqConsumedChannels(content);

    return Object.freeze({
      step,
      calleeNames: Object.freeze(calleeNames),
      mqProducedChannels: Object.freeze(mqProducedChannels),
      mqConsumedChannels: Object.freeze(mqConsumedChannels),
    });
  }

  /**
   * 提取方法体（从 startLine 到下一个同级方法或文件末尾）
   *
   * @param content 文件内容
   * @param startLine 方法起始行号
   * @returns 方法体字符串
   */
  private extractMethodBody(content: string, startLine: number): string {
    const lines = content.split("\n");
    const startIdx = startLine - 1;
    if (startIdx < 0 || startIdx >= lines.length) {
      return "";
    }

    // 查找方法体的右大括号（简化版：查找下一个同级方法定义或文件末尾）
    let endIdx = lines.length - 1;
    let braceDepth = 0;
    let foundOpen = false;
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === "{") {
          braceDepth++;
          foundOpen = true;
        } else if (ch === "}") {
          braceDepth--;
          if (foundOpen && braceDepth === 0) {
            endIdx = i;
            break;
          }
        }
      }
      if (foundOpen && braceDepth === 0) {
        endIdx = i;
        break;
      }
    }

    return lines.slice(startIdx, endIdx + 1).join("\n");
  }

  /**
   * 从方法体提取被调用方符号名
   *
   * @param methodBody 方法体
   * @param filePath 文件路径
   * @returns 被调用方符号名列表
   */
  private extractCallees(methodBody: string, filePath: string): string[] {
    const callees = new Set<string>();
    const ext = path.extname(filePath).toLowerCase();
    const applicableRules = CALL_CHAIN_RULES.filter((r) => r.extensions.includes(ext));

    for (const rule of applicableRules) {
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(methodBody)) !== null) {
        // 提取被调用方名（取最后一个捕获组）
        const calleeName = match[2] ?? match[1] ?? match[3];
        if (!calleeName) continue;
        // 过滤关键字
        if (["if", "for", "while", "switch", "catch", "return", "console", "require", "import"].includes(calleeName)) {
          continue;
        }
        callees.add(calleeName);
      }
    }

    return [...callees];
  }

  /**
   * 提取 MQ 生产通道
   *
   * @param methodBody 方法体
   * @returns 通道列表
   */
  private extractMqProducedChannels(methodBody: string): string[] {
    const channels = new Set<string>();
    for (const pattern of MQ_PRODUCER_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(methodBody)) !== null) {
        if (match[1]) {
          channels.add(match[1]);
        }
      }
    }
    return [...channels];
  }

  /**
   * 提取 MQ 消费通道
   *
   * @param content 文件内容（注：消费通道识别基于装饰器，需扫描整个文件）
   * @returns 通道列表
   */
  private extractMqConsumedChannels(content: string): string[] {
    const channels = new Set<string>();
    for (const pattern of MQ_CONSUMER_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        if (match[1]) {
          channels.add(match[1]);
        }
      }
    }
    return [...channels];
  }

  /**
   * 查找消费指定 MQ 通道的步骤
   *
   * @param channel MQ 通道名
   * @param producerStep 生产者步骤（用于排除）
   * @returns 消费者步骤（未找到返回 null）
   */
  private async findMqConsumerStep(channel: string, producerStep: FlowStep): Promise<FlowStep | null> {
    // 简化版：在整个项目搜索消费该通道的代码
    return await this.searchMqConsumer(this.projectRoot, "", channel, producerStep, 0, 3);
  }

  /**
   * 递归搜索 MQ 消费者
   *
   * @param absoluteDir 当前绝对目录
   * @param relativeDir 当前相对目录
   * @param channel 通道名
   * @param producerStep 生产者步骤
   * @param depth 当前深度
   * @param maxDepth 最大深度
   * @returns 消费者步骤
   */
  private async searchMqConsumer(
    absoluteDir: string,
    relativeDir: string,
    channel: string,
    producerStep: FlowStep,
    depth: number,
    maxDepth: number
  ): Promise<FlowStep | null> {
    if (depth > maxDepth) {
      return null;
    }
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "dist", "build", "target", "__pycache__"].includes(entry.name)) {
          continue;
        }
        const subAbs = path.join(absoluteDir, entry.name);
        const subRel = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        const result = await this.searchMqConsumer(subAbs, subRel, channel, producerStep, depth + 1, maxDepth);
        if (result) {
          return result;
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!this.sourceExtensions.has(ext)) continue;
        const relPath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        // 排除生产者文件
        if (relPath === producerStep.filePath) continue;
        const absolutePath = path.join(this.projectRoot, relPath);
        try {
          const content = await fs.readFile(absolutePath, "utf-8");
          // 检查是否消费该通道
          for (const pattern of MQ_CONSUMER_PATTERNS) {
            pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(content)) !== null) {
              if (match[1] === channel) {
                // 找到消费者：查找方法符号名
                const symbolLine = this.findConsumerSymbolLine(content, match.index);
                if (symbolLine > 0) {
                  const symbolName = `${channel}.consume`;
                  return this.createStep(symbolName, relPath, symbolLine, "mq-consumer", content);
                }
              }
            }
          }
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  /**
   * 查找消费者符号所在行号
   *
   * @param content 文件内容
   * @param matchIndex 正则匹配索引
   * @returns 行号（1-based）
   */
  private findConsumerSymbolLine(content: string, matchIndex: number): number {
    // 简化版：返回匹配所在行
    let line = 1;
    for (let i = 0; i < matchIndex && i < content.length; i++) {
      if (content.charCodeAt(i) === 10) {
        line++;
      }
    }
    return line;
  }

  /**
   * 发现已有的状态机（扫描项目内含状态字段的类）
   *
   * @returns 状态机列表
   */
  private async discoverStateMachines(): Promise<StateMachine[]> {
    const stateMachines: StateMachine[] = [];
    await this.scanStateMachines(this.projectRoot, "", stateMachines, 0, 3);
    return stateMachines;
  }

  /**
   * 递归扫描状态机
   *
   * @param absoluteDir 当前绝对目录
   * @param relativeDir 当前相对目录
   * @param results 结果收集列表
   * @param depth 当前深度
   * @param maxDepth 最大深度
   */
  private async scanStateMachines(
    absoluteDir: string,
    relativeDir: string,
    results: StateMachine[],
    depth: number,
    maxDepth: number
  ): Promise<void> {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "dist", "build", "target", "__pycache__"].includes(entry.name)) {
          continue;
        }
        const subAbs = path.join(absoluteDir, entry.name);
        const subRel = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        await this.scanStateMachines(subAbs, subRel, results, depth + 1, maxDepth);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!this.sourceExtensions.has(ext)) continue;
        const relPath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        const absolutePath = path.join(this.projectRoot, relPath);
        try {
          const content = await fs.readFile(absolutePath, "utf-8");
          const sm = this.extractStateMachine(content, relPath);
          if (sm) {
            results.push(sm);
          }
        } catch {
          continue;
        }
      }
    }
  }

  /**
   * 从文件内容提取状态机
   *
   * @param content 文件内容
   * @param filePath 文件路径
   * @returns 状态机（未识别返回 null）
   */
  private extractStateMachine(content: string, filePath: string): StateMachine | null {
    // 1. 查找状态字段名
    let stateField: string | null = null;
    for (const pattern of STATE_FIELD_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(content);
      if (match) {
        stateField = match[1];
        break;
      }
    }
    if (!stateField) {
      return null;
    }

    // 2. 提取状态值集合
    const stateSet = new Set<string>();
    for (const pattern of STATE_VALUE_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const value = match[1];
        if (value && value.length >= 3) {
          stateSet.add(value.toLowerCase());
        }
      }
    }

    // 过滤过通用词（如 "true"/"false"/"null"/"default"）
    const commonWords = new Set(["true", "false", "null", "default", "undefined", "string", "number"]);
    const states = [...stateSet].filter((s) => !commonWords.has(s));
    if (states.length < 2) {
      return null;
    }

    // 3. 提取状态迁移（简化版：基于 "status === X" → "status = Y" 模式）
    const transitions: StateTransition[] = [];
    const transitionPattern = new RegExp(
      `${stateField}\\.status\\s*===\\s*['"]?([a-zA-Z_]+)['"]?\\s*\\)?\\s*\\n\\s*${stateField}\\.status\\s*=\\s*['"]?([a-zA-Z_]+)['"]?`,
      "g"
    );
    let tMatch: RegExpExecArray | null;
    while ((tMatch = transitionPattern.exec(content)) !== null) {
      transitions.push(
        Object.freeze({
          from: tMatch[1].toLowerCase(),
          to: tMatch[2].toLowerCase(),
          trigger: "状态迁移",
        })
      );
    }

    // 4. 推断终态（无出度的状态）
    const hasOutgoing = new Set(transitions.map((t) => t.from));
    const terminalStates = states.filter((s) => !hasOutgoing.has(s));

    // 实体名：取文件 basename 去扩展名
    const entityName = path.basename(filePath, path.extname(filePath));

    return Object.freeze({
      entityName,
      stateField,
      states: Object.freeze(states),
      transitions: Object.freeze(transitions.map((t) => Object.freeze({ ...t }))),
      terminalStates: Object.freeze(terminalStates),
    });
  }

  /**
   * 渲染 Mermaid 流程图
   *
   * @param steps 步骤列表
   * @param branches 分支列表
   * @param asyncBoundaries 异步边界列表
   * @returns Mermaid 流程图字符串（flowchart TD 格式）
   */
  private renderMermaidFlow(
    steps: ReadonlyArray<FlowStep>,
    branches: ReadonlyArray<FlowBranch>,
    asyncBoundaries: ReadonlyArray<AsyncBoundary>
  ): string {
    const lines: string[] = ["flowchart TD", ""];

    // 步骤节点
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const nodeId = `S${i + 1}`;
      const label = `${step.symbolName} [${this.translateStepType(step.type)}]`;
      lines.push(`    ${nodeId}["${label.replace(/"/g, "'")}"]`);
    }
    lines.push("");

    // 分支边
    for (const branch of branches) {
      const fromIdx = steps.findIndex((s) => s.stepId === branch.fromStepId);
      const toIdx = steps.findIndex((s) => s.stepId === branch.toStepId);
      if (fromIdx < 0 || toIdx < 0) continue;
      const fromNode = `S${fromIdx + 1}`;
      const toNode = `S${toIdx + 1}`;
      const label = branch.condition ?? branch.label;
      if (label && label !== "call") {
        lines.push(`    ${fromNode} -->|${label}| ${toNode}`);
      } else {
        lines.push(`    ${fromNode} --> ${toNode}`);
      }
    }
    lines.push("");

    // 异步边界标注（用虚线表示）
    for (const boundary of asyncBoundaries) {
      const fromIdx = steps.findIndex((s) => s.stepId === boundary.producerStepId);
      const toIdx = steps.findIndex((s) => s.stepId === boundary.consumerStepId);
      if (fromIdx < 0 || toIdx < 0) continue;
      const fromNode = `S${fromIdx + 1}`;
      const toNode = `S${toIdx + 1}`;
      lines.push(`    ${fromNode} -.->|async: ${boundary.channel}| ${toNode}`);
    }

    return lines.join("\n");
  }

  /**
   * 渲染 Mermaid 状态图
   *
   * @param stateMachine 状态机
   * @returns Mermaid 状态图字符串（stateDiagram-v2 格式）
   */
  private renderMermaidStateDiagram(stateMachine: StateMachine): string {
    const lines: string[] = [
      "stateDiagram-v2",
      `    %% ${stateMachine.entityName} 的状态机（状态字段：${stateMachine.stateField}）`,
      "",
    ];

    // 状态声明（标注终态）
    for (const state of stateMachine.states) {
      if (stateMachine.terminalStates.includes(state)) {
        lines.push(`    state ${state} <<final>>`);
      }
    }
    lines.push("");

    // 初始状态（取第一个非终态作为初始）
    const initialState = stateMachine.states.find((s) => !stateMachine.terminalStates.includes(s));
    if (initialState) {
      lines.push(`    [*] --> ${initialState}`);
    }
    lines.push("");

    // 状态迁移
    for (const transition of stateMachine.transitions) {
      const label = transition.guard ? `${transition.trigger} [${transition.guard}]` : transition.trigger;
      lines.push(`    ${transition.from} --> ${transition.to}: ${label}`);
    }

    // 终态 → [*]
    for (const terminal of stateMachine.terminalStates) {
      lines.push(`    ${terminal} --> [*]`);
    }

    return lines.join("\n");
  }
}
