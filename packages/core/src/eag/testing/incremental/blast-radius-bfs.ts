/**
 * BlastRadiusBfs：爆炸半径 BFS 算法（EAG-P3 批次 11 §8.5）
 *
 * 本模块实现 `BlastRadiusBfs` 类，对应 EAG-P3 批次 11 设计 §8.5：
 * 基于 PKC L2 依赖图，从变更源文件出发做 BFS 遍历，
 * 找到所有受影响的测试文件（匹配 tests 目录下所有 .test.ts 文件）。
 *
 * 核心职责（对齐 §8.5）：
 * 1. 从 sourceFiles（git diff 提取的变更文件）初始化 BFS 队列（depth=0，type=source）
 * 2. 出队一个节点，查询其依赖项（dependencyGraph 中的出边）
 * 3. 若依赖项是测试文件（path 匹配 tests 目录下 .test.ts 后缀）→ 标记为 test 节点，加入结果（不出队）
 * 4. 若依赖项是源文件 → 标记为 affected 节点，加入队列继续 BFS
 * 5. 重复直到队列空或达到最大深度（MAX_DEPTH=5）
 * 6. 返回所有 BlastRadiusNode（含 depth 与 parentPaths 路径回溯）
 *
 * 算法（对齐 §5.10.5 增量测试）：
 * - BFS 遍历确保最短路径优先（受影响文件 depth 最小）
 * - visited 集合避免循环依赖导致死循环
 * - 测试节点不出队继续遍历（避免反向传播到测试的依赖）
 * - MAX_DEPTH=5 平衡爆炸半径与回归覆盖（深度过大导致过多测试，深度过小漏测）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - bfs() 返回的 BlastRadiusNode 列表通过 Object.freeze 冻结
 * - 每个 BlastRadiusNode 对象本身也通过 Object.freeze 冻结
 * - parentPaths 数组同样冻结
 *
 * @module eag/testing/incremental/blast-radius-bfs
 */

import type { BlastRadiusNode, BlastRadiusNodeType } from "./types";
import { TEST_FILE_PATTERN, DEFAULT_MAX_BFS_DEPTH } from "./types";

// ============================================================================
// BlastRadiusBfs 类
// ============================================================================

/**
 * BlastRadiusBfs：爆炸半径 BFS 算法
 *
 * 实现 §8.5 设计——基于依赖图 BFS 计算受影响测试。
 *
 * 使用方式：
 * ```typescript
 * const bfs = new BlastRadiusBfs();
 * const sourceFiles = ["src/services/PaymentService.ts"];
 * const dependencyGraph = {
 *   "src/services/PaymentService.ts": ["src/controllers/PaymentController.ts"],
 *   "src/controllers/PaymentController.ts": ["tests/contract/payment.contract.test.ts"],
 * };
 * const nodes = bfs.bfs(sourceFiles, dependencyGraph);
 * for (const node of nodes) {
 *   console.log(`[${node.type}] depth=${node.depth} ${node.filePath}`);
 * }
 * ```
 *
 * 依赖图格式（邻接表）：
 * - 键：文件路径（相对 projectRoot）
 * - 值：该文件直接依赖的文件路径列表（出边）
 *
 * 示例依赖图（A 依赖 B，B 依赖 C）：
 * ```json
 * {
 *   "src/A.ts": ["src/B.ts"],
 *   "src/B.ts": ["src/C.ts"]
 * }
 * ```
 */
export class BlastRadiusBfs {
  /**
   * 最大 BFS 深度（避免无限遍历）
   *
   * 数值依据（对齐 §8.5）：
   * - 深度 5 覆盖大多数企业项目的"源文件 → 控制器 → 服务 → 仓储 → 测试"链路
   * - 深度过大会导致受影响测试过多（爆炸半径过大），失去增量测试的价值
   * - 深度过小会遗漏间接依赖的测试，导致回归漏测
   *
   * 使用 `as const` 字面量断言。
   */
  private static readonly MAX_DEPTH: number = DEFAULT_MAX_BFS_DEPTH;

  /**
   * 初始化 BlastRadiusBfs
   *
   * BlastRadiusBfs 不依赖外部服务（仅消费调用方传入的依赖图），构造函数无参数。
   */
  constructor() {
    // 无外部依赖注入
  }

  /**
   * 执行 BFS 遍历
   *
   * 算法步骤（对齐 §8.5）：
   * 1. 初始化 BFS 队列，将所有 sourceFiles 加入队列（depth=0，type=source，parentPaths=[]）
   * 2. 同时将 sourceFiles 加入 visited 集合（避免重复访问）
   * 3. BFS 主循环：
   *    a. 出队一个节点 current，加入 nodes 结果列表
   *    b. 若 current.depth >= MAX_DEPTH，跳过依赖遍历（达到深度上限）
   *    c. 查询 current.filePath 在 dependencyGraph 中的依赖项列表
   *    d. 对每个依赖项 dep：
   *       - 若 dep 已在 visited 集合中，跳过（避免循环）
   *       - 将 dep 加入 visited 集合
   *       - 判定 dep 类型：若匹配 TEST_FILE_PATTERN → type=test，否则 type=affected
   *       - 构造 nextNode（depth=current.depth+1，parentPaths=[...current.parentPaths, current.filePath]）
   *       - 若是 test 节点：加入 nodes 结果列表（不出队继续遍历）
   *       - 若是 affected 节点：加入 queue 继续 BFS
   * 4. 返回 Object.freeze 冻结的 nodes 列表
   *
   * 边界处理：
   * - sourceFiles 为空数组 → 返回空数组
   * - dependencyGraph 为空对象 → 仅返回 source 节点
   * - 依赖项不在 dependencyGraph 中 → 该节点出队后无后续依赖遍历
   *
   * @param sourceFiles 变更源文件列表（git diff 提取，相对 projectRoot）
   * @param dependencyGraph PKC L2 依赖图（file → 直接依赖项列表，邻接表）
   * @returns BlastRadiusNode 列表（已冻结，每个对象也冻结）
   */
  public bfs(
    sourceFiles: ReadonlyArray<string>,
    dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>>
  ): ReadonlyArray<BlastRadiusNode> {
    // 结果列表（按 BFS 遍历顺序追加，含 source / affected / test 三种类型）
    const nodes: BlastRadiusNode[] = [];
    // visited 集合（避免循环依赖导致死循环）
    const visited: Set<string> = new Set<string>();
    // BFS 队列（仅含 source 与 affected 节点；test 节点不出队）
    const queue: BlastRadiusNode[] = [];

    // 1. 初始化队列：将所有 sourceFiles 加入队列（depth=0，type=source）
    for (const file of sourceFiles) {
      // 跳过空字符串（防御性处理）
      if (typeof file !== "string" || file.trim().length === 0) {
        continue;
      }
      // 跳过重复的 source 文件（同一文件多次出现在 sourceFiles 中）
      if (visited.has(file)) {
        continue;
      }
      visited.add(file);

      // 构造 source 节点（depth=0，parentPaths 为空数组）
      const sourceNode: BlastRadiusNode = Object.freeze({
        type: "source" as BlastRadiusNodeType,
        filePath: file,
        depth: 0,
        parentPaths: Object.freeze([] as string[]),
      }) as BlastRadiusNode;
      queue.push(sourceNode);
    }

    // 2. BFS 主循环
    while (queue.length > 0) {
      // 出队队首节点（FIFO 保证最短路径优先）
      const current: BlastRadiusNode = queue.shift() as BlastRadiusNode;
      // 加入结果列表（source 与 affected 节点都加入；test 节点在依赖遍历时直接加入）
      nodes.push(current);

      // 达到最大深度则不再遍历该节点的依赖（避免超过 MAX_DEPTH）
      if (current.depth >= BlastRadiusBfs.MAX_DEPTH) {
        continue;
      }

      // 查询 current 的依赖项（dependencyGraph 中的出边）
      // 若 current 不在依赖图中，dependencies 为空数组
      const dependencies: ReadonlyArray<string> = dependencyGraph[current.filePath] ?? [];

      // 遍历每个依赖项
      for (const dep of dependencies) {
        // 跳过空字符串（防御性处理）
        if (typeof dep !== "string" || dep.trim().length === 0) {
          continue;
        }
        // 跳过已访问的节点（避免循环依赖导致死循环）
        if (visited.has(dep)) {
          continue;
        }
        visited.add(dep);

        // 判定 dep 是否为测试文件（路径匹配 tests/.*\.test\.ts$）
        const isTest: boolean = TEST_FILE_PATTERN.test(dep);
        const nodeType: BlastRadiusNodeType = isTest ? "test" : "affected";

        // 构造 nextNode（depth+1，parentPaths 追加 current.filePath）
        const nextNode: BlastRadiusNode = Object.freeze({
          type: nodeType,
          filePath: dep,
          depth: current.depth + 1,
          parentPaths: Object.freeze([...current.parentPaths, current.filePath]),
        }) as BlastRadiusNode;

        if (isTest) {
          // 测试节点不出队继续遍历（避免反向传播到测试的依赖）
          // 直接加入结果列表
          nodes.push(nextNode);
        } else {
          // 受影响节点加入队列继续 BFS（可能还有更深的依赖）
          queue.push(nextNode);
        }
      }
    }

    // 3. 返回冻结的 BlastRadiusNode 列表
    return Object.freeze(nodes);
  }
}
