/**
 * 拆解计划的纯函数层：解析 → 校验 → 分层 → 冲突消解
 *
 * ## 为什么单独一个文件
 *
 * 这四步是编排里唯一「可以完全确定性地验证」的部分，也是 L2 最容易出错的地方
 * （LLM 会输出环、悬空依赖、重复 id、路径穿越）。把它们做成无 I/O 的纯函数，
 * 就能用单测把每一条拒绝理由钉死，而不必让测试去 mock 网络。
 *
 * 依赖方向：本文件只 import `./types`，不碰 LLM、不碰文件系统。
 *
 * @module team/orchestrator/plan-graph
 */

import * as path from "node:path";
import type { SubtaskNode } from "./types.js";
import {
  MAX_SUBTASK_DESCRIPTION_LENGTH,
  SUBTASK_ID_PATTERN,
  type OrchestrationBudget,
  type OrchestrationPlan,
  type SerializedMove,
} from "./types.js";

// ============================================================================
// 路径规范化与安全检查
// ============================================================================

/**
 * 规范化子任务声明的文件路径；不安全或非项目内相对路径返回 null
 *
 * 规则（任一不满足即丢弃该路径，但**不**使整个子任务失败）：
 * - 必须相对路径（拒绝 `/`、`C:\`、`\\server`）
 * - 不得含 `..` 段（路径穿越）
 * - 统一 `/` 分隔、去掉 `./` 前缀、转小写（macOS/Windows 默认大小写不敏感，
 *   宁可多串行一次，也不要在 `Foo.ts` / `foo.ts` 上撞车）
 */
export function normalizeProjectPath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // 绝对路径 / 盘符 / UNC：一律拒绝（拆解被注入时最危险的一类）
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith("\\\\")) {
    return null;
  }
  const segments = trimmed.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => segment === "..")) return null;
  const cleaned = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  if (cleaned === "") return null;
  return cleaned.toLowerCase();
}

// ============================================================================
// 从 LLM 文本中提取 JSON
// ============================================================================

/**
 * 从模型输出中提取第一个可解析的 JSON 对象
 *
 * 现实约束：拆解 prompt 要求"只输出 JSON"，但模型仍会加前言、用 ```json 围栏、
 * 或在末尾补一句"以上是拆解结果"。因此不能 `JSON.parse(raw)` 了事。
 *
 * 策略：从每个 `{` 起做括号配平扫描（跳过字符串字面量内的括号与转义），
 * 找到第一个配平的片段就尝试解析，成功即返回。失败继续找下一个 `{`。
 * 这样 `fenced` / `前后有解释` / `裸 JSON` 三种形态都能覆盖，
 * 且不会因为解释文字里出现 `{}` 而误判（永远尝试所有起点）。
 */
export function extractJsonObject(raw: string): { ok: true; value: unknown } | { ok: false } {
  if (typeof raw !== "string") return { ok: false };
  const text = raw.trim();
  if (text === "") return { ok: false };

  const candidates: unknown[] = [];
  let start = text.indexOf("{");
  while (start >= 0) {
    const end = findBalancedEnd(text, start);
    if (end > start) {
      try {
        candidates.push(JSON.parse(text.slice(start, end + 1)));
      } catch {
        // 该片段不是合法 JSON，继续找下一个起点
      }
    }
    start = text.indexOf("{", start + 1);
  }

  if (candidates.length === 0) return { ok: false };

  // 优先返回带 subtasks 的对象：模型常先给一个「格式示例」再给真结果，
  // 若按出现顺序取第一个，会拿 `{}` 或示例对象当答案（校验层再拒，用户白等一次调用）。
  const withSubtasks = candidates.find(
    (candidate) => candidate !== null && typeof candidate === "object" && "subtasks" in candidate
  );
  return { ok: true, value: withSubtasks ?? candidates[0] };
}

/**
 * 从 `start` 处的 `{` 起找到配平的 `}` 下标；未配平返回 -1
 *
 * 状态机：`inString` + `escaped` 两个标志位，避免把 `"}"` 当成结构结束。
 */
function findBalancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ============================================================================
// 校验
// ============================================================================

/** 校验结果 */
export type ValidatePlanResult =
  | { ok: true; plan: OrchestrationPlan; warnings: string[] }
  | { ok: false; reason: string };

/**
 * 校验并归一化拆解计划
 *
 * 分级处理：
 * - **整单拒绝**：结构不合法、数量超限、id 非法/重复、悬空依赖、有环
 *   （这些问题会让「按层执行」失去意义，继续跑只会产生不可解释的结果）
 * - **丢弃局部**：不安全/越界的 `files` 条目、空 description 的子任务被剔除
 *   （局部瑕疵不该毁掉整次编排）
 *
 * @param raw    LLM 解析出的原始对象（未经信任）
 * @param budget 预算（用于数量上限）
 */
export function validatePlan(raw: unknown, budget: OrchestrationBudget): ValidatePlanResult {
  const parsed = zPlanShape(raw);
  if (!parsed.ok) return parsed;

  const plan = parsed.plan;
  const warnings: string[] = [];

  if (plan.subtasks.length === 0) {
    return { ok: false, reason: "拆解结果为空（subtasks 长度为 0）" };
  }
  if (plan.subtasks.length > budget.maxSubtasks) {
    return {
      ok: false,
      reason: `子任务数 ${plan.subtasks.length} 超过上限 maxSubtasks=${budget.maxSubtasks}`,
    };
  }

  // id 唯一 + 合法
  const seen = new Set<string>();
  for (const node of plan.subtasks) {
    if (!SUBTASK_ID_PATTERN.test(node.id)) {
      return { ok: false, reason: `子任务 id 非法: "${node.id}"（需匹配 ${SUBTASK_ID_PATTERN}）` };
    }
    if (seen.has(node.id)) {
      return { ok: false, reason: `子任务 id 重复: "${node.id}"` };
    }
    seen.add(node.id);
  }

  // 悬空依赖 + 自依赖
  for (const node of plan.subtasks) {
    for (const dep of node.dependsOn) {
      if (dep === node.id) {
        return { ok: false, reason: `子任务 ${node.id} 依赖了自己` };
      }
      if (!seen.has(dep)) {
        return { ok: false, reason: `子任务 ${node.id} 依赖了不存在的 id: "${dep}"` };
      }
    }
  }

  // 环检测（复用分层算法：分层失败即有环）
  const layers = topologicalLayers(plan.subtasks);
  if (!layers.ok) {
    return { ok: false, reason: `依赖关系存在环: ${layers.cycle.join(" → ")}` };
  }

  // 逐节点归一化：描述截断、files 过滤
  const normalized: SubtaskNode[] = [];
  for (const node of plan.subtasks) {
    let description = node.description.trim();
    if (description === "") {
      warnings.push(`子任务 ${node.id} 的 description 为空，已剔除`);
      continue;
    }
    if (description.length > MAX_SUBTASK_DESCRIPTION_LENGTH) {
      description = description.slice(0, MAX_SUBTASK_DESCRIPTION_LENGTH);
      warnings.push(`子任务 ${node.id} 的 description 超长，已截断至 ${MAX_SUBTASK_DESCRIPTION_LENGTH} 字符`);
    }
    const files: string[] = [];
    for (const raw of node.files) {
      const normalizedPath = normalizeProjectPath(raw);
      if (normalizedPath === null) {
        warnings.push(`子任务 ${node.id} 声明了不安全的文件路径，已忽略: ${raw}`);
        continue;
      }
      if (!files.includes(normalizedPath)) files.push(normalizedPath);
    }
    normalized.push({ ...node, description, files });
  }

  if (normalized.length === 0) {
    return { ok: false, reason: "所有子任务的 description 均为空" };
  }

  // 剔除节点后可能留下悬空依赖：重建闭包，避免后续分层拿到不存在的 id
  const aliveIds = new Set(normalized.map((node) => node.id));
  const repaired = normalized.map((node) => ({
    ...node,
    dependsOn: node.dependsOn.filter((dep) => {
      if (aliveIds.has(dep)) return true;
      warnings.push(`子任务 ${node.id} 的依赖 ${dep} 已被剔除，该依赖被移除`);
      return false;
    }),
  }));

  return { ok: true, plan: { rationale: plan.rationale, subtasks: repaired }, warnings };
}

/** 结构校验（zod）：只保证字段形态，不做语义检查 */
function zPlanShape(raw: unknown): { ok: true; plan: OrchestrationPlan } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, reason: "拆解结果不是对象" };
  }
  const obj = raw as Record<string, unknown>;
  const subtasksRaw = obj["subtasks"];
  if (!Array.isArray(subtasksRaw)) {
    return { ok: false, reason: "拆解结果缺少 subtasks 数组" };
  }

  const subtasks: SubtaskNode[] = [];
  for (let i = 0; i < subtasksRaw.length; i++) {
    const item = subtasksRaw[i];
    if (item === null || typeof item !== "object") {
      return { ok: false, reason: `subtasks[${i}] 不是对象` };
    }
    const node = item as Record<string, unknown>;
    const id = node["id"];
    const title = node["title"];
    const description = node["description"];
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, reason: `subtasks[${i}] 缺少 id` };
    }
    if (typeof title !== "string" || title.trim() === "") {
      return { ok: false, reason: `subtasks[${i}]（id=${id}）缺少 title` };
    }
    if (typeof description !== "string") {
      return { ok: false, reason: `subtasks[${i}]（id=${id}）缺少 description` };
    }

    const dependsOnRaw = node["dependsOn"];
    if (dependsOnRaw !== undefined && !Array.isArray(dependsOnRaw)) {
      return { ok: false, reason: `subtasks[${i}]（id=${id}）的 dependsOn 不是数组` };
    }
    const dependsOn = Array.isArray(dependsOnRaw)
      ? dependsOnRaw.filter((dep): dep is string => typeof dep === "string")
      : [];

    const filesRaw = node["files"];
    if (filesRaw !== undefined && !Array.isArray(filesRaw)) {
      return { ok: false, reason: `subtasks[${i}]（id=${id}）的 files 不是数组` };
    }
    const files = Array.isArray(filesRaw) ? filesRaw.filter((f): f is string => typeof f === "string") : [];

    subtasks.push({
      id: id.trim(),
      title: title.trim(),
      description,
      dependsOn,
      files,
      ...(typeof node["roleHint"] === "string" && node["roleHint"].trim() !== ""
        ? { roleHint: node["roleHint"].trim() }
        : {}),
      ...(typeof node["acceptance"] === "string" && node["acceptance"].trim() !== ""
        ? { acceptance: node["acceptance"].trim() }
        : {}),
    });
  }

  return {
    ok: true,
    plan: {
      rationale: typeof obj["rationale"] === "string" ? obj["rationale"] : "",
      subtasks,
    },
  };
}

// ============================================================================
// 拓扑分层
// ============================================================================

/** 分层结果 */
export type TopologicalLayersResult = { ok: true; layers: string[][] } | { ok: false; cycle: string[] };

/**
 * Kahn 算法按层分组（同层可并行，层间必须串行）
 *
 * 返回 `layers[i]` 内的 id 彼此无依赖，且其全部前置都在 `layers[0..i-1]` 中。
 * 层内保持原数组顺序（稳定），便于报告与断言对比。
 *
 * 检测到环时返回环内残留节点（不是严格的最短环，但足以定位问题）。
 */
export function topologicalLayers(
  nodes: ReadonlyArray<Pick<SubtaskNode, "id" | "dependsOn">>
): TopologicalLayersResult {
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  const order = new Map<string, number>();

  nodes.forEach((node, index) => {
    indegree.set(node.id, 0);
    order.set(node.id, index);
    children.set(node.id, []);
  });

  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!indegree.has(dep)) continue; // 悬空依赖由 validatePlan 负责拒绝，这里跳过以保持容错
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
      children.get(dep)!.push(node.id);
    }
  }

  const layers: string[][] = [];
  let frontier = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  let processed = 0;

  while (frontier.length > 0) {
    layers.push([...frontier]);
    processed += frontier.length;
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of children.get(id) ?? []) {
        const remaining = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, remaining);
        if (remaining === 0) next.push(child);
      }
    }
    // 稳定排序：按原始声明顺序，保证同样输入总是同样输出
    next.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    frontier = next;
  }

  if (processed !== nodes.length) {
    const cycle = nodes.filter((node) => (indegree.get(node.id) ?? 0) > 0).map((node) => node.id);
    return { ok: false, cycle };
  }

  return { ok: true, layers };
}

// ============================================================================
// 文件写冲突消解
// ============================================================================

/**
 * 把同层内声明文件重叠的子任务下移到下一层
 *
 * ## 为什么要做（而不是并行硬跑）
 *
 * 两个角色同时改同一个文件，后写者覆盖先写者，结果看起来"成功"但代码被静默丢失。
 * 这是最难排查的一类故障——没有异常、没有日志、只有"怎么少了一段"。
 *
 * ## 为什么是"下移"而不是"拒绝"
 *
 * 拆解器把两个子任务放在同层，只是因为它的依赖判断认为它们互不相干；
 * 但文件重叠说明它们在**物理上**相干。下移既保留了用户要的全部工作，
 * 又把并发降级为串行——只损失时间。
 *
 * ## 为什么不用 git worktree 隔离
 *
 * 见 `docs/proposals/agent-team-enhancement/l2-orchestration.md` §2.3：
 * runner 的 cwd 固定是 projectRoot，worktree 会让路径全部漂移；
 * 而合并阶段的真实冲突处理是另一套工程，自动合并出错比串行更危险。
 */
export function serializeFileConflicts(
  layers: string[][],
  filesById: ReadonlyMap<string, ReadonlyArray<string>>
): { layers: string[][]; serialized: SerializedMove[] } {
  const serialized: SerializedMove[] = [];
  /** 待处理的层队列（可能因下移而增长） */
  const pending: string[][] = layers.map((layer) => [...layer]);
  const result: string[][] = [];
  /** 安全阀：每次下移都让某个节点层号 +1，最多 n 次；给 2n+4 的余量足以收敛 */
  let guard = layers.reduce((sum, layer) => sum + layer.length, 0) * 2 + 4;

  while (pending.length > 0) {
    const current = pending.shift()!;
    const occupied = new Map<string, string>(); // 文件 → 占用它的子任务 id
    const keep: string[] = [];
    const deferred: string[] = [];

    for (const id of current) {
      const files = filesById.get(id) ?? [];
      let conflict: { file: string; owner: string } | null = null;
      for (const file of files) {
        const owner = occupied.get(file);
        if (owner !== undefined && owner !== id) {
          conflict = { file, owner };
          break;
        }
      }

      if (conflict === null) {
        keep.push(id);
        for (const file of files) occupied.set(file, id);
        continue;
      }

      // 收集本次下移的全部重叠文件（最多 3 个，避免报告过长）
      const overlap = files.filter((file) => occupied.has(file) && occupied.get(file) !== id).slice(0, 3);
      deferred.push(id);
      serialized.push({
        id,
        fromLayer: result.length,
        toLayer: result.length + 1,
        conflictsWith: conflict.owner,
        files: overlap.length > 0 ? overlap : [conflict.file],
      });
    }

    if (keep.length > 0) {
      result.push(keep);
    }

    if (deferred.length > 0) {
      guard -= deferred.length;
      if (guard < 0) {
        // 理论上不可达（每次下移必然消耗余量）；兜底直接串行追加，宁可慢不可死循环
        for (const id of deferred) result.push([id]);
        deferred.length = 0;
      } else if (pending.length === 0) {
        pending.push(deferred);
      } else {
        // 合并进下一层：下移节点的依赖都在更早的层，放到下一层仍然满足
        pending[0] = [...pending[0]!, ...deferred];
      }
    }
  }

  // 修正 toLayer：上面的记录用的是「当时」的层号，最终层级可能再变一次
  const finalLayer = new Map<string, number>();
  result.forEach((layer, index) => {
    for (const id of layer) finalLayer.set(id, index);
  });
  for (const move of serialized) {
    const actual = finalLayer.get(move.id);
    if (actual !== undefined) move.toLayer = actual;
  }

  // 按 id 去重并保留最后一次：一个节点可能连续撞上多个对手（t2 撞 t1 后又被推到
  // 与 t3 同层再撞一次），中间态对用户没有意义。报告的语义是「它最终落到哪一层」。
  const deduped = new Map<string, SerializedMove>();
  for (const move of serialized) deduped.set(move.id, move);

  return { layers: result, serialized: Array.from(deduped.values()) };
}
