/**
 * 编排纯函数层单测（L2 验收 O1~O4）
 *
 * 覆盖：JSON 提取、路径安全、计划校验、拓扑分层、文件冲突下移。
 * 全部为无 I/O 的确定性断言——这些是编排正确性的最后一道硬保证。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractJsonObject,
  normalizeProjectPath,
  serializeFileConflicts,
  topologicalLayers,
  validatePlan,
} from "../team/orchestrator/plan-graph.js";
import { OrchestrationBudget, type OrchestrationBudget as Budget } from "../team/orchestrator/types.js";

const defaultBudget = (): Budget => OrchestrationBudget.parse({});

// ============================================================================
// O1：JSON 提取
// ============================================================================

test("O1a：裸 JSON 直接解析", () => {
  const result = extractJsonObject('{"subtasks":[{"id":"t1"}]}');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, { subtasks: [{ id: "t1" }] });
  }
});

test("O1b：markdown 围栏 + 前后解释文字都能提取", () => {
  const raw = [
    "好的，我先把任务拆一下：",
    "",
    "```json",
    '{"rationale":"先设计后实现","subtasks":[{"id":"t1","title":"设计"}]}',
    "```",
    "",
    "以上就是拆解结果，请确认。",
  ].join("\n");

  const result = extractJsonObject(raw);
  assert.equal(result.ok, true);
  if (result.ok) {
    const value = result.value as { rationale: string };
    assert.equal(value.rationale, "先设计后实现");
  }
});

test("O1c：字符串字面量内的花括号不破坏配平", () => {
  const result = extractJsonObject('{"note":"这里有 } 和 { 两个符号","ok":true}');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal((result.value as { ok: boolean }).ok, true);
  }
});

test("O1d：无 JSON 时返回 ok:false，不抛异常", () => {
  assert.deepEqual(extractJsonObject("我建议你先想清楚需求"), { ok: false });
  assert.deepEqual(extractJsonObject(""), { ok: false });
  assert.deepEqual(extractJsonObject("{不完整的"), { ok: false });
});

test("O1e：前面有非法片段时能跳到后面合法的 JSON", () => {
  const result = extractJsonObject('先用 {} 占位的示例，真正结果是 {"subtasks":[]}');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual((result.value as { subtasks: unknown[] }).subtasks, []);
  }
});

// ============================================================================
// 路径安全
// ============================================================================

test("路径：相对路径归一化（去 ./、统一分隔符、转小写）", () => {
  assert.equal(normalizeProjectPath("src/Export.ts"), "src/export.ts");
  assert.equal(normalizeProjectPath("./src/a.ts"), "src/a.ts");
  assert.equal(normalizeProjectPath("src\\windows\\b.ts"), "src/windows/b.ts");
  assert.equal(normalizeProjectPath("  src/a.ts  "), "src/a.ts");
});

test("路径：绝对路径 / 盘符 / UNC / 穿越一律拒绝", () => {
  assert.equal(normalizeProjectPath("/etc/passwd"), null);
  assert.equal(normalizeProjectPath("C:\\Windows\\system.ini"), null);
  assert.equal(normalizeProjectPath("\\\\server\\share\\a.ts"), null);
  assert.equal(normalizeProjectPath("../../etc/passwd"), null);
  assert.equal(normalizeProjectPath("src/../../escape.ts"), null);
  assert.equal(normalizeProjectPath(""), null);
  assert.equal(normalizeProjectPath("."), null);
});

// ============================================================================
// O2：计划校验
// ============================================================================

test("O2a：合法计划通过，保留 roleHint / files / acceptance", () => {
  const result = validatePlan(
    {
      rationale: "先接口后实现",
      subtasks: [
        {
          id: "t1",
          title: "设计接口",
          description: "定义导出函数的签名",
          roleHint: "architect",
          dependsOn: [],
          files: ["src/export.ts"],
          acceptance: "签名与调用方一致",
        },
        { id: "t2", title: "实现", description: "按接口实现", dependsOn: ["t1"], files: ["src/export.ts"] },
      ],
    },
    defaultBudget()
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plan.subtasks.length, 2);
    assert.equal(result.plan.subtasks[0]!.roleHint, "architect");
    assert.deepEqual(result.plan.subtasks[1]!.dependsOn, ["t1"]);
  }
});

test("O2b：空 subtasks / 超上限 / 结构非法 → 整单拒绝", () => {
  assert.equal(validatePlan({ subtasks: [] }, defaultBudget()).ok, false);
  assert.equal(validatePlan({ subtasks: "nope" }, defaultBudget()).ok, false);
  assert.equal(validatePlan(null, defaultBudget()).ok, false);

  const many = Array.from({ length: 7 }, (_, i) => ({
    id: `t${i + 1}`,
    title: `任务${i + 1}`,
    description: "描述",
  }));
  const overLimit = validatePlan({ subtasks: many }, OrchestrationBudget.parse({ maxSubtasks: 6 }));
  assert.equal(overLimit.ok, false);
  if (!overLimit.ok) assert.match(overLimit.reason, /maxSubtasks/);
});

test("O2c：id 非法 / 重复 / 悬空依赖 / 自依赖 → 整单拒绝", () => {
  const base = { title: "t", description: "d" };

  const badId = validatePlan({ subtasks: [{ ...base, id: "1-bad" }] }, defaultBudget());
  assert.equal(badId.ok, false);

  const dup = validatePlan(
    {
      subtasks: [
        { ...base, id: "t1" },
        { ...base, id: "t1" },
      ],
    },
    defaultBudget()
  );
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.match(dup.reason, /重复/);

  const dangling = validatePlan({ subtasks: [{ ...base, id: "t1", dependsOn: ["ghost"] }] }, defaultBudget());
  assert.equal(dangling.ok, false);
  if (!dangling.ok) assert.match(dangling.reason, /不存在/);

  const selfDep = validatePlan({ subtasks: [{ ...base, id: "t1", dependsOn: ["t1"] }] }, defaultBudget());
  assert.equal(selfDep.ok, false);
  if (!selfDep.ok) assert.match(selfDep.reason, /自己/);
});

test("O2d：有环 → 整单拒绝，并在 reason 里点名环内节点", () => {
  const result = validatePlan(
    {
      subtasks: [
        { id: "t1", title: "a", description: "d", dependsOn: ["t3"] },
        { id: "t2", title: "b", description: "d", dependsOn: ["t1"] },
        { id: "t3", title: "c", description: "d", dependsOn: ["t2"] },
      ],
    },
    defaultBudget()
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /环/);
    assert.match(result.reason, /t1/);
  }
});

test("O2e：不安全 files 被丢弃，但子任务保留（局部瑕疵不毁整单）", () => {
  const result = validatePlan(
    {
      subtasks: [
        {
          id: "t1",
          title: "导出",
          description: "写文件",
          files: ["src/a.ts", "/etc/passwd", "../../evil.sh", "SRC/../ok/b.ts"],
        },
      ],
    },
    defaultBudget()
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.plan.subtasks[0]!.files, ["src/a.ts"]);
    // 危险路径必须留下可追溯的告警，不能静默
    assert.ok(result.warnings.some((w) => w.includes("/etc/passwd")));
    assert.ok(result.warnings.some((w) => w.includes("../../evil.sh")));
  }
});

test("O2f：空 description 的子任务被剔除，依赖它的节点同步修复", () => {
  const result = validatePlan(
    {
      subtasks: [
        { id: "t1", title: "空", description: "   " },
        { id: "t2", title: "实现", description: "真描述", dependsOn: ["t1"] },
      ],
    },
    defaultBudget()
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.plan.subtasks.map((s) => s.id),
      ["t2"]
    );
    assert.deepEqual(result.plan.subtasks[0]!.dependsOn, []);
    assert.ok(result.warnings.some((w) => w.includes("依赖 t1")));
  }
});

test("O2g：超长 description 被截断到 4000 字符", () => {
  const result = validatePlan(
    { subtasks: [{ id: "t1", title: "长", description: "x".repeat(5000) }] },
    defaultBudget()
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plan.subtasks[0]!.description.length, 4000);
  }
});

// ============================================================================
// O3：拓扑分层
// ============================================================================

test("O3a：菱形依赖 → 三层 [[t1],[t2,t3],[t4]]", () => {
  const result = topologicalLayers([
    { id: "t1", dependsOn: [] },
    { id: "t2", dependsOn: ["t1"] },
    { id: "t3", dependsOn: ["t1"] },
    { id: "t4", dependsOn: ["t2", "t3"] },
  ]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.layers, [["t1"], ["t2", "t3"], ["t4"]]);
  }
});

test("O3b：无依赖 → 单层；链式 → 每层一个", () => {
  const flat = topologicalLayers([
    { id: "a", dependsOn: [] },
    { id: "b", dependsOn: [] },
  ]);
  assert.equal(flat.ok, true);
  if (flat.ok) assert.deepEqual(flat.layers, [["a", "b"]]);

  const chain = topologicalLayers([
    { id: "a", dependsOn: [] },
    { id: "b", dependsOn: ["a"] },
    { id: "c", dependsOn: ["b"] },
  ]);
  assert.equal(chain.ok, true);
  if (chain.ok) assert.deepEqual(chain.layers, [["a"], ["b"], ["c"]]);
});

test("O3c：环 → ok:false 且列出未消解的节点", () => {
  const result = topologicalLayers([
    { id: "a", dependsOn: ["b"] },
    { id: "b", dependsOn: ["a"] },
    { id: "c", dependsOn: [] },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.cycle.sort(), ["a", "b"]);
  }
});

// ============================================================================
// O4：文件冲突下移
// ============================================================================

test("O4a：同层两个子任务声明同一文件 → 后者下移到下一层", () => {
  const filesById = new Map<string, string[]>([
    ["t1", ["src/a.ts"]],
    ["t2", ["src/a.ts"]],
    ["t3", ["src/b.ts"]],
  ]);

  const result = serializeFileConflicts([["t1", "t2", "t3"]], filesById);

  assert.deepEqual(result.layers, [["t1", "t3"], ["t2"]]);
  assert.equal(result.serialized.length, 1);
  assert.equal(result.serialized[0]!.id, "t2");
  assert.equal(result.serialized[0]!.conflictsWith, "t1");
  assert.deepEqual(result.serialized[0]!.files, ["src/a.ts"]);
  assert.equal(result.serialized[0]!.toLayer, 1);
});

test("O4b：无文件重叠时分层完全不变", () => {
  const filesById = new Map<string, string[]>([
    ["t1", ["src/a.ts"]],
    ["t2", ["src/b.ts"]],
  ]);
  const result = serializeFileConflicts([["t1", "t2"]], filesById);
  assert.deepEqual(result.layers, [["t1", "t2"]]);
  assert.equal(result.serialized.length, 0);
});

test("O4c：子任务未声明文件 → 不参与冲突检测，保持并行", () => {
  const filesById = new Map<string, string[]>([
    ["t1", []],
    ["t2", []],
  ]);
  const result = serializeFileConflicts([["t1", "t2"]], filesById);
  assert.deepEqual(result.layers, [["t1", "t2"]]);
  assert.equal(result.serialized.length, 0);
});

test("O4d：三个任务抢同一文件 → 逐个下移，最终串成三层", () => {
  const filesById = new Map<string, string[]>([
    ["t1", ["src/shared.ts"]],
    ["t2", ["src/shared.ts"]],
    ["t3", ["src/shared.ts"]],
  ]);
  const result = serializeFileConflicts([["t1", "t2", "t3"]], filesById);

  assert.deepEqual(result.layers, [["t1"], ["t2"], ["t3"]]);
  assert.equal(result.serialized.length, 2);
  // 每个被下移的节点都能追到「跟谁撞了」
  assert.deepEqual(
    result.serialized.map((move) => move.id),
    ["t2", "t3"]
  );
});

test("O4e：下移节点与原下一层再次冲突 → 继续下移，不死循环", () => {
  const filesById = new Map<string, string[]>([
    ["t1", ["a.ts"]],
    ["t2", ["a.ts"]], // 与 t1 冲突 → 下移
    ["t3", ["a.ts"]], // 原本就在第 2 层
  ]);
  const result = serializeFileConflicts([["t1", "t2"], ["t3"]], filesById);

  assert.deepEqual(result.layers, [["t1"], ["t3"], ["t2"]]);
  assert.equal(result.serialized.length, 1);
  assert.equal(result.serialized[0]!.id, "t2");
  assert.equal(result.serialized[0]!.toLayer, 2);
});

test("O4f：不产生空层", () => {
  const filesById = new Map<string, string[]>([
    ["t1", ["a.ts"]],
    ["t2", ["a.ts"]],
  ]);
  const result = serializeFileConflicts([["t1", "t2"]], filesById);
  assert.equal(
    result.layers.every((layer) => layer.length > 0),
    true,
    "分层结果不应含空层"
  );
});
