/**
 * tasks.md 生成器实现（EAG-P2 批次 8）
 *
 * 本模块实现 `TasksGenerator` 类，提供 EAG 方案 §5.10.2 任务分解规范中 tasks.md
 * 的真实生成逻辑。
 *
 * 核心职责：
 * - 接收 TasksGenerationInput（plan.md 内容 + 任务 DAG + 验收标准映射）
 * - 输出符合 Markdown 格式的 tasks.md 字符串
 * - 含每个任务卡：ID / 标题 / [REQ-F-xxx] 溯源 / 验收标准 / 依赖
 *
 * §5.10.2 tasks.md 设计要求：
 * - 产出 Loop：CODING Loop 首轮
 * - 内容：任务分解 DAG（含拓扑序 + 任务卡 + 验收标准 + 依赖关系）
 * - 粒度：单任务 ≤ 1 个文件簇（聚合/模块）
 * - 任务卡含 [REQ-F-xxx] 需求溯源标记
 *
 * 设计依据：
 * - EAG 方案 §5.10.2 任务分解规范
 * - EAG 方案 §5.12.2 进度可视化（tasks.md 实时回写状态）
 *
 * 不可变优先：
 * - 类方法为纯函数，无副作用
 * - 输入与输出均为不可变数据
 *
 * @module eag/doc-driven/tasks-generator
 */

import type { TaskCard, TaskCardStatus, TaskDag, TaskNode, TasksGenerationInput } from "./types";
import { TASK_CARD_STATUSES } from "./types";

// ============================================================================
// 异常类型
// ============================================================================

/**
 * tasks.md 生成器错误（输入非法时抛出）
 *
 * 包含错误字段与详细信息，便于调用方定位问题。
 */
export class TasksGeneratorError extends Error {
  /**
   * @param field 非法字段名
   * @param reason 非法原因
   */
  constructor(
    public readonly field: string,
    public readonly reason: string
  ) {
    super(`tasks.md 生成器错误：字段 ${field} 非法——${reason}`);
    this.name = "TasksGeneratorError";
  }
}

// ============================================================================
// 任务卡状态中文名映射
// ============================================================================

/**
 * 任务卡状态中文名映射（用于任务卡状态展示）
 *
 * 使用 Object.freeze 冻结。
 */
const TASK_CARD_STATUS_CHINESE: Readonly<Record<TaskCardStatus, string>> = Object.freeze({
  pending: "待办",
  "in-progress": "进行中",
  completed: "完成",
  blocked: "阻塞",
});

// ============================================================================
// TasksGenerator 类
// ============================================================================

/**
 * tasks.md 生成器（实现 §5.10.2 任务分解规范中 tasks.md 的生成）
 *
 * 提供真实生成逻辑（禁止 mock）：
 * - generate：接收 TasksGenerationInput，输出符合 Markdown 格式的 tasks.md 字符串
 *
 * 输出文档结构：
 * 1. 文档头部（标题 + 元信息）
 * 2. 章节概览（任务总数 + 拓扑序概览 + 依赖关系图）
 * 3. 任务卡列表（按拓扑序排列）
 *    - 每个任务卡含：ID / 标题 / [REQ-F-xxx] 溯源 / 验收标准 / 依赖 / 状态
 *
 * 文档头部附加 EAG 元信息（生成时间、版本号、文档路径），便于版本审计。
 *
 * 使用方式：
 * ```typescript
 * const generator = new TasksGenerator();
 * const tasksMd = generator.generate(input);
 * ```
 */
export class TasksGenerator {
  /**
   * 生成 tasks.md 字符串
   *
   * 执行流程：
   * 1. 校验入参（planContent/taskDag/acceptanceCriteriaMap 字段合法性）
   * 2. 将 TaskNode 转换为 TaskCard（含验收标准 + 默认状态 pending）
   * 3. 按拓扑序排序任务卡
   * 4. 渲染文档头部
   * 5. 渲染章节概览（任务总数 + 拓扑序）
   * 6. 渲染任务卡列表（按拓扑序）
   * 7. 拼接全部章节返回完整 Markdown 字符串
   *
   * @param input tasks.md 生成器输入
   * @returns tasks.md 字符串（Markdown 格式）
   * @throws {TasksGeneratorError} 任一字段非法时抛出
   */
  generate(input: TasksGenerationInput): string {
    // 校验入参
    this.validateInput(input);

    // 将 TaskNode 转换为 TaskCard（含验收标准 + 默认状态 pending）
    const taskCards = this.convertToTaskCards(input.taskDag, input.acceptanceCriteriaMap);

    // 渲染各章节
    const header = this.renderHeader();
    const overview = this.renderOverview(input.taskDag, taskCards);
    const taskList = this.renderTaskList(taskCards);

    // 拼接全部章节
    return [header, overview, taskList].join("\n\n").trim() + "\n";
  }

  // ============================ 私有辅助方法 ============================

  /**
   * 校验 TasksGenerationInput 字段合法性
   *
   * @param input 待校验输入
   * @throws {TasksGeneratorError} 任一字段非法时抛出
   */
  private validateInput(input: TasksGenerationInput): void {
    if (typeof input.planContent !== "string" || input.planContent.trim().length === 0) {
      throw new TasksGeneratorError("planContent", "必须为非空字符串");
    }
    if (!input.taskDag || typeof input.taskDag !== "object") {
      throw new TasksGeneratorError("taskDag", "必须为 TaskDag 对象");
    }
    if (!Array.isArray(input.taskDag.nodes)) {
      throw new TasksGeneratorError("taskDag.nodes", "必须为数组");
    }
    if (!Array.isArray(input.taskDag.topologicalOrder)) {
      throw new TasksGeneratorError("taskDag.topologicalOrder", "必须为数组");
    }
    if (input.acceptanceCriteriaMap === null || typeof input.acceptanceCriteriaMap !== "object") {
      throw new TasksGeneratorError("acceptanceCriteriaMap", "必须为对象");
    }
    // 校验每个 TaskNode 的字段
    for (const [idx, node] of input.taskDag.nodes.entries()) {
      if (typeof node.id !== "string" || node.id.trim().length === 0) {
        throw new TasksGeneratorError(`taskDag.nodes[${idx}].id`, "必须为非空字符串");
      }
      if (typeof node.title !== "string" || node.title.trim().length === 0) {
        throw new TasksGeneratorError(`taskDag.nodes[${idx}].title`, "必须为非空字符串");
      }
      if (typeof node.requirementId !== "string" || node.requirementId.trim().length === 0) {
        throw new TasksGeneratorError(
          `taskDag.nodes[${idx}].requirementId`,
          "必须为非空字符串（[REQ-F-xxx] 溯源标记）"
        );
      }
      if (!Array.isArray(node.dependencies)) {
        throw new TasksGeneratorError(`taskDag.nodes[${idx}].dependencies`, "必须为数组");
      }
    }
  }

  /**
   * 将 TaskNode 列表转换为 TaskCard 列表（按拓扑序）
   *
   * 转换规则：
   * - 沿用 TaskNode 的 id/title/requirementId/dependencies
   * - 验收标准取自 acceptanceCriteriaMap（缺失时使用 TaskNode.acceptanceCommand 兜底）
   * - 默认状态为 pending（待办）
   *
   * @param taskDag 任务 DAG
   * @param acceptanceCriteriaMap 任务 ID → 验收标准列表映射
   * @returns 任务卡列表（按拓扑序）
   */
  private convertToTaskCards(
    taskDag: Readonly<TaskDag>,
    acceptanceCriteriaMap: Readonly<Record<string, ReadonlyArray<string>>>
  ): TaskCard[] {
    // 构建 id → TaskNode 映射
    const nodeMap = new Map<string, TaskNode>();
    for (const node of taskDag.nodes) {
      nodeMap.set(node.id, node);
    }

    // 按拓扑序生成 TaskCard
    const taskCards: TaskCard[] = [];
    for (const [idx, taskId] of taskDag.topologicalOrder.entries()) {
      const node = nodeMap.get(taskId);
      if (!node) {
        // 拓扑序中的任务 ID 不在 nodes 中（数据不一致）：
        // 不静默跳过，直接抛错暴露数据不一致问题，便于调用方定位 TaskDag 生成逻辑缺陷。
        // 对齐 §5.10.2 任务 DAG 不变性约束——topologicalOrder 必须是 nodes.id 的有效拓扑序。
        throw new TasksGeneratorError(
          `taskDag.topologicalOrder[${idx}]`,
          `在 nodes 中找不到对应任务（topologicalOrder 与 nodes 数据不一致），taskId="${taskId}"`
        );
      }
      // 取验收标准：优先使用 acceptanceCriteriaMap，缺失则使用 acceptanceCommand 兜底
      const criteria = acceptanceCriteriaMap[taskId] ?? [node.acceptanceCommand];
      const taskCard: TaskCard = Object.freeze({
        id: node.id,
        title: node.title,
        requirementId: node.requirementId,
        dependencies: Object.freeze([...node.dependencies]),
        acceptanceCriteria: Object.freeze([...criteria]),
        status: "pending",
        // 透传 TaskNode.declaredSymbols 至 TaskCard（对齐 G-3 门禁数据源契约）
        // 旧数据可能不含此字段，使用空数组兜底（Object.freeze 冻结保持不可变）
        declaredSymbols: Object.freeze([...(node.declaredSymbols ?? [])]),
      });
      taskCards.push(taskCard);
    }
    return taskCards;
  }

  /**
   * 渲染文档头部（标题 + 元信息）
   *
   * @returns 头部 Markdown 字符串
   */
  private renderHeader(): string {
    const lines: string[] = [
      "# 任务分解（tasks.md）",
      "",
      "<!-- EAG 文档驱动开发 Loop 自动生成（§5.10.2 任务分解规范） -->",
      "<!-- 文档状态机：draft → reviewing → approved（G-1 门禁强制校验） -->",
      `<!-- 生成时间：${new Date().toISOString()} -->`,
      `<!-- 文档路径：docs/eag/tasks.md -->`,
      "",
    ];
    return lines.join("\n");
  }

  /**
   * 渲染章节概览（任务总数 + 拓扑序 + 依赖关系）
   *
   * @param taskDag 任务 DAG
   * @param taskCards 任务卡列表
   * @returns 概览 Markdown 字符串
   */
  private renderOverview(taskDag: Readonly<TaskDag>, taskCards: ReadonlyArray<TaskCard>): string {
    const lines: string[] = ["## 1. 章节概览", ""];

    // 任务总数
    lines.push(`- **任务总数**：${taskCards.length}`);
    lines.push(`- **拓扑序**：${taskDag.topologicalOrder.join(" → ")}`);

    // 状态统计（生成期全部为 pending，但保留统计逻辑以支持后续状态回写）
    const statusCount: Record<TaskCardStatus, number> = {
      pending: 0,
      "in-progress": 0,
      completed: 0,
      blocked: 0,
    };
    for (const card of taskCards) {
      statusCount[card.status]++;
    }
    lines.push("- **状态统计**：");
    for (const status of TASK_CARD_STATUSES) {
      const chinese = TASK_CARD_STATUS_CHINESE[status];
      lines.push(`  - ${chinese}：${statusCount[status]}`);
    }
    lines.push("");

    // 依赖关系图（Mermaid 流程图）
    if (taskDag.nodes.length > 0) {
      lines.push("### 1.1 任务依赖关系图", "");
      lines.push("```mermaid", "flowchart TD");
      // 节点
      for (const node of taskDag.nodes) {
        // Mermaid 节点 ID 不能含连字符以外的特殊字符，使用简化 ID
        const mermaidId = this.toMermaidNodeId(node.id);
        lines.push(`    ${mermaidId}["${node.id}: ${node.title}"]`);
      }
      // 边
      for (const node of taskDag.nodes) {
        const fromId = this.toMermaidNodeId(node.id);
        for (const dep of node.dependencies) {
          const toId = this.toMermaidNodeId(dep);
          lines.push(`    ${toId} --> ${fromId}`);
        }
      }
      lines.push("```", "");
    }

    return lines.join("\n");
  }

  /**
   * 渲染任务卡列表（按拓扑序）
   *
   * @param taskCards 任务卡列表
   * @returns 任务卡列表 Markdown 字符串
   */
  private renderTaskList(taskCards: ReadonlyArray<TaskCard>): string {
    const lines: string[] = ["## 2. 任务卡列表（按拓扑序）", ""];

    if (taskCards.length === 0) {
      lines.push("> 无任务卡。", "");
      return lines.join("\n");
    }

    // 使用索引循环避免 O(N²) 复杂度（原 taskCards.indexOf(card) 每次都需线性扫描）
    for (const [idx, card] of taskCards.entries()) {
      const statusChinese = TASK_CARD_STATUS_CHINESE[card.status] ?? card.status;
      lines.push(`### 2.${idx + 1} ${card.id}：${card.title}`, "");
      lines.push(`- **任务 ID**：\`${card.id}\``);
      lines.push(`- **需求溯源**：[REQ-${card.requirementId}]`);
      lines.push(`- **状态**：${statusChinese}（${card.status}）`);
      if (card.dependencies.length > 0) {
        lines.push(`- **依赖任务**：${card.dependencies.map((d) => `\`${d}\``).join("、")}`);
      } else {
        lines.push("- **依赖任务**：无");
      }
      if (card.acceptanceCriteria.length > 0) {
        lines.push("- **验收标准**：");
        for (const criteria of card.acceptanceCriteria) {
          lines.push(`  - \`${criteria}\``);
        }
      } else {
        lines.push("- **验收标准**：无");
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * 将任务 ID 转换为 Mermaid 节点 ID
   *
   * Mermaid 节点 ID 仅允许字母数字与下划线，需将连字符替换为下划线。
   *
   * @param taskId 任务 ID（如 "T-001"）
   * @returns Mermaid 节点 ID（如 "T_001"）
   */
  private toMermaidNodeId(taskId: string): string {
    return taskId.replace(/[^A-Za-z0-9_]/g, "_");
  }
}
