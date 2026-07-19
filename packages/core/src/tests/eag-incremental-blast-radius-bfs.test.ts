/**
 * EAG-P3 批次 11 单元测试：BlastRadiusBfs（§8.5）
 *
 * 本测试文件校验 BlastRadiusBfs 类的 BFS 算法正确性。
 *
 * 测试策略（遵循用户规则 P-5"禁止 mock"）：
 * - 直接构造真实依赖图邻接表（Record<string, ReadonlyArray<string>>）
 * - 真实调用 bfs() 方法
 * - 真实校验返回的 BlastRadiusNode 列表
 *
 * 测试范围：
 * - T1. 单源单跳（source → affected）→ 返回 source + affected 节点
 * - T2. 单源多跳（source → affected → test）→ test 节点 depth=2，parentPaths 含中间节点
 * - T3. 多源 BFS（两个 source 同时入队）
 * - T4. 测试节点不出队继续遍历（test 节点的依赖不被遍历）
 * - T5. 循环依赖（A → B → A）→ visited 集合避免死循环
 * - T6. MAX_DEPTH=5 限制（深度 6 的节点不再遍历）
 * - T7. 空源文件列表 → 返回空数组
 * - T8. 空依赖图 → 仅返回 source 节点
 * - T9. 源文件不在依赖图中 → 仅返回 source 节点
 * - T10. 返回的节点列表已冻结
 * - T11. 每个节点对象本身也冻结
 * - T12. parentPaths 数组冻结
 * - T13. 重复的 source 文件 → visited 去重，仅入队一次
 * - T14. BFS 最短路径优先（同一节点被多条路径到达时，记录最短 depth）
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 直接构造真实依赖图邻接表
 * - 禁止 mock
 *
 * @module core/tests/eag-incremental-blast-radius-bfs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BlastRadiusBfs } from "../eag/testing/incremental/blast-radius-bfs";
import type { BlastRadiusNode } from "../eag/testing/incremental/types";

// ============================================================================
// T1. 单源单跳（source → affected）→ 返回 source + affected 节点
// ============================================================================

test("T1. 单源单跳（source → affected）→ 返回 source + affected 节点", () => {
  const bfs = new BlastRadiusBfs();
  const sourceFiles: ReadonlyArray<string> = ["src/services/PaymentService.ts"];
  // 依赖图：PaymentService 依赖 PaymentController（非测试文件）
  const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
    "src/services/PaymentService.ts": ["src/controllers/PaymentController.ts"],
  };

  const nodes = bfs.bfs(sourceFiles, dependencyGraph);

  // 应返回 2 个节点：1 个 source + 1 个 affected
  assert.equal(nodes.length, 2);

  // 第 1 个节点：source（depth=0）
  const sourceNode = nodes[0];
  assert.equal(sourceNode.type, "source");
  assert.equal(sourceNode.filePath, "src/services/PaymentService.ts");
  assert.equal(sourceNode.depth, 0);
  assert.equal(sourceNode.parentPaths.length, 0);

  // 第 2 个节点：affected（depth=1，parentPaths 含 source）
  const affectedNode = nodes[1];
  assert.equal(affectedNode.type, "affected");
  assert.equal(affectedNode.filePath, "src/controllers/PaymentController.ts");
  assert.equal(affectedNode.depth, 1);
  assert.equal(affectedNode.parentPaths.length, 1);
  assert.equal(affectedNode.parentPaths[0], "src/services/PaymentService.ts");
});

// ============================================================================
// T2. 单源多跳（source → affected → test）→ test 节点 depth=2
// ============================================================================

test("T2. 单源多跳（source → affected → test）→ test 节点 depth=2，parentPaths 含中间节点", () => {
  const bfs = new BlastRadiusBfs();
  const sourceFiles: ReadonlyArray<string> = ["src/services/PaymentService.ts"];
  // 依赖图：PaymentService → PaymentController → 测试文件
  const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
    "src/services/PaymentService.ts": ["src/controllers/PaymentController.ts"],
    "src/controllers/PaymentController.ts": ["tests/contract/payment.contract.test.ts"],
  };

  const nodes = bfs.bfs(sourceFiles, dependencyGraph);

  // 应返回 3 个节点：source + affected + test
  assert.equal(nodes.length, 3);

  // 验证 test 节点
  const testNode = nodes.find((n) => n.type === "test");
  assert.ok(testNode, "应找到 test 节点");
  assert.equal(testNode!.filePath, "tests/contract/payment.contract.test.ts");
  assert.equal(testNode!.depth, 2);
  // parentPaths 应含 source + 中间 affected 节点
  assert.equal(testNode!.parentPaths.length, 2);
  assert.equal(testNode!.parentPaths[0], "src/services/PaymentService.ts");
  assert.equal(testNode!.parentPaths[1], "src/controllers/PaymentController.ts");
});

// ============================================================================
// T3. 多源 BFS（两个 source 同时入队）
// ============================================================================

test("T3. 多源 BFS（两个 source 同时入队）", () => {
  const bfs = new BlastRadiusBfs();
  const sourceFiles: ReadonlyArray<string> = ["src/services/PaymentService.ts", "src/services/OrderService.ts"];
  const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
    "src/services/PaymentService.ts": ["tests/contract/payment.contract.test.ts"],
    "src/services/OrderService.ts": ["tests/contract/order.contract.test.ts"],
  };

  const nodes = bfs.bfs(sourceFiles, dependencyGraph);

  // 应返回 4 个节点：2 个 source + 2 个 test
  assert.equal(nodes.length, 4);

  // 验证两个 source 节点 depth=0
  const sourceNodes = nodes.filter((n) => n.type === "source");
  assert.equal(sourceNodes.length, 2);
  for (const sn of sourceNodes) {
    assert.equal(sn.depth, 0);
  }

  // 验证两个 test 节点 depth=1
  const testNodes = nodes.filter((n) => n.type === "test");
  assert.equal(testNodes.length, 2);
  for (const tn of testNodes) {
    assert.equal(tn.depth, 1);
  }
});

// ============================================================================
// T4. 测试节点不出队继续遍历（test 节点的依赖不被遍历）
// ============================================================================

test("T4. 测试节点不出队继续遍历（test 节点的依赖不被遍历）", () => {
  const bfs = new BlastRadiusBfs();
  const sourceFiles: ReadonlyArray<string> = ["src/services/PaymentService.ts"];
  // 依赖图：source → test → 另一个文件（不应被遍历到）
  // 如果 test 节点出队，"src/should-not-visit.ts" 会被加入 nodes
  // 期望：test 节点不出队，"src/should-not-visit.ts" 不在结果中
  const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
    "src/services/PaymentService.ts": ["tests/contract/payment.contract.test.ts"],
    "tests/contract/payment.contract.test.ts": ["src/should-not-visit.ts"],
  };

  const nodes = bfs.bfs(sourceFiles, dependencyGraph);

  // 应返回 2 个节点：source + test（test 不出队，"src/should-not-visit.ts" 不应被访问）
  assert.equal(nodes.length, 2);

  // 验证 "src/should-not-visit.ts" 不在结果中
  const shouldNotVisit = nodes.find((n) => n.filePath === "src/should-not-visit.ts");
  assert.equal(shouldNotVisit, undefined);
});

// ============================================================================
// T5. 循环依赖（A → B → A）→ visited 集合避免死循环
// ============================================================================

test("T5. 循环依赖（A → B → A）→ visited 集合避免死循环", () => {
  const bfs = new BlastRadiusBfs();
  const sourceFiles: ReadonlyArray<string> = ["src/A.ts"];
  // 依赖图：A → B → A（循环）
  // 期望：visited 集合避免重复访问，不死循环
  const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
    "src/A.ts": ["src/B.ts"],
    "src/B.ts": ["src/A.ts"],
  };

  const nodes = bfs.bfs(sourceFiles, dependencyGraph);

  // 应返回 2 个节点：A（source）+ B（affected）
  // B 的依赖 A 已在 visited 中，不会重复访问
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].filePath, "src/A.ts");
  assert.equal(nodes[1].filePath, "src/B.ts");
});

// ============================================================================
// T6. MAX_DEPTH=5 限制（深度 6 的节点不再遍历）
// ============================================================================

test("T6. MAX_DEPTH=5 限制（深度 6 的节点不再遍历）", () => {
  const bfs = new BlastRadiusBfs();
  const sourceFiles: ReadonlyArray<string> = ["src/level0.ts"];
  // 依赖图：构造 6 层链路 level0 → level1 → ... → level6
  // 期望：depth=0~5 的节点都被遍历（共 6 个），depth=6 的节点不被遍历
  const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
    "src/level0.ts": ["src/level1.ts"],
    "src/level1.ts": ["src/level2.ts"],
    "src/level2.ts": ["src/level3.ts"],
    "src/level3.ts": ["src/level4.ts"],
    "src/level4.ts": ["src/level5.ts"],
    "src/level5.ts": ["src/level6.ts"], // depth=6，不应被遍历
    "src/level6.ts": ["src/level7.ts"], // depth=7，更不应被遍历
  };

  const nodes = bfs.bfs(sourceFiles, dependencyGraph);

  // 应返回 6 个节点：level0（depth=0）~ level5（depth=5）
  // level6（depth=6）不应出现，因为 level5 出队时 depth=5 >= MAX_DEPTH=5，不再遍历其依赖
  assert.equal(nodes.length, 6);

  // 验证最后一个节点是 level5（depth=5）
  const lastNode = nodes[nodes.length - 1];
  assert.equal(lastNode.filePath, "src/level5.ts");
  assert.equal(lastNode.depth, 5);

  // 验证 level6 不在结果中
  const level6Node = nodes.find((n) => n.filePath === "src/level6.ts");
  assert.equal(level6Node, undefined);
});

// ============================================================================
// T7. 空源文件列表 → 返回空数组
// ============================================================================

test("T7. 空源文件列表 → 返回空数组", () => {
  const bfs = new BlastRadiusBfs();
  const sourceFiles: ReadonlyArray<string> = [];
  const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
    "src/A.ts": ["src/B.ts"],
  };

  const nodes = bfs.bfs(sourceFiles, dependencyGraph);

  assert.equal(Array.isArray(nodes), true);
  assert.equal(nodes.length, 0);
});

// ============================================================================
// T8. 空依赖图 → 仅返回 source 节点
// ============================================================================

test("T8. 空依赖图 → 仅返回 source 节点", () => {
  const bfs = new BlastRadiusBfs();
  const sourceFiles: ReadonlyArray<string> = ["src/A.ts"];
  const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {};

  const nodes = bfs.bfs(sourceFiles, dependencyGraph);

  // 应返回 1 个 source 节点
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, "source");
  assert.equal(nodes[0].filePath, "src/A.ts");
  assert.equal(nodes[0].depth, 0);
});

// ============================================================================
// T9. 源文件不在依赖图中 → 仅返回 source 节点
// ============================================================================

test("T9. 源文件不在依赖图中 → 仅返回 source 节点", () => {
  const bfs = new BlastRadiusBfs();
  const sourceFiles: ReadonlyArray<string> = ["src/orphan.ts"];
  // 依赖图不含 src/orphan.ts 的出边
  const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
    "src/other.ts": ["src/B.ts"],
  };

  const nodes = bfs.bfs(sourceFiles, dependencyGraph);

  // 应返回 1 个 source 节点（orphan 不在依赖图中，无后续依赖）
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, "source");
  assert.equal(nodes[0].filePath, "src/orphan.ts");
});

// ============================================================================
// T10. 返回的节点列表已冻结
// ============================================================================

test("T10. 返回的节点列表已冻结", () => {
  const bfs = new BlastRadiusBfs();
  const sourceFiles: ReadonlyArray<string> = ["src/A.ts"];
  const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
    "src/A.ts": ["src/B.ts"],
  };

  const nodes = bfs.bfs(sourceFiles, dependencyGraph);

  assert.equal(Object.isFrozen(nodes), true);
});

// ============================================================================
// T11. 每个节点对象本身也冻结
// ============================================================================

test("T11. 每个节点对象本身也冻结", () => {
  const bfs = new BlastRadiusBfs();
  const sourceFiles: ReadonlyArray<string> = ["src/A.ts"];
  const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
    "src/A.ts": ["src/B.ts", "tests/foo.test.ts"],
  };

  const nodes = bfs.bfs(sourceFiles, dependencyGraph);

  for (const node of nodes) {
    assert.equal(Object.isFrozen(node), true, `节点应冻结：${node.filePath}`);
  }
});

// ============================================================================
// T12. parentPaths 数组冻结
// ============================================================================

test("T12. parentPaths 数组冻结", () => {
  const bfs = new BlastRadiusBfs();
  const sourceFiles: ReadonlyArray<string> = ["src/A.ts"];
  const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
    "src/A.ts": ["src/B.ts"],
    "src/B.ts": ["src/C.ts"],
  };

  const nodes = bfs.bfs(sourceFiles, dependencyGraph);

  for (const node of nodes) {
    assert.equal(Object.isFrozen(node.parentPaths), true, `parentPaths 应冻结：${node.filePath}`);
  }
});

// ============================================================================
// T13. 重复的 source 文件 → visited 去重，仅入队一次
// ============================================================================

test("T13. 重复的 source 文件 → visited 去重，仅入队一次", () => {
  const bfs = new BlastRadiusBfs();
  // 同一文件出现两次
  const sourceFiles: ReadonlyArray<string> = ["src/A.ts", "src/A.ts"];
  const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
    "src/A.ts": ["src/B.ts"],
  };

  const nodes = bfs.bfs(sourceFiles, dependencyGraph);

  // 应返回 2 个节点：A（source，仅入队一次）+ B（affected）
  // 重复的 A 会被 visited 集合去重
  assert.equal(nodes.length, 2);
  const sourceNodes = nodes.filter((n) => n.type === "source");
  assert.equal(sourceNodes.length, 1);
});

// ============================================================================
// T14. BFS 最短路径优先（同一节点被多条路径到达时，记录最短 depth）
// ============================================================================

test("T14. BFS 最短路径优先（同一节点被多条路径到达时，记录最短 depth）", () => {
  const bfs = new BlastRadiusBfs();
  // 双源 BFS：A → C，B → C
  // C 的最短路径是 1（从 A 或 B 出发都是 1 跳）
  const sourceFiles: ReadonlyArray<string> = ["src/A.ts", "src/B.ts"];
  const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
    "src/A.ts": ["src/C.ts"],
    "src/B.ts": ["src/C.ts"],
  };

  const nodes = bfs.bfs(sourceFiles, dependencyGraph);

  // 应返回 3 个节点：A（source）+ B（source）+ C（affected，depth=1）
  // C 只入队一次（visited 去重），depth=1（最短路径）
  assert.equal(nodes.length, 3);
  const cNode = nodes.find((n) => n.filePath === "src/C.ts");
  assert.ok(cNode, "应找到 C 节点");
  assert.equal(cNode!.depth, 1);
});
