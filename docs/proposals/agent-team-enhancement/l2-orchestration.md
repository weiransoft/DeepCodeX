# L2：自动多角色拆解（设计定稿）

- 版本：v1
- 日期：2026-11-02
- 前置：`proposal-final.md`（v2 定稿，A 路线已全部落地）
- 决策依据：用户拍板 **P1 选项 B**——本期即交付「一任务自动拆解 → 多角色并行 → 结果聚合」

---

## 一、为什么这一期做（推翻 N6）

`proposal-final.md` 的 N6 写着「本期不做自动多角色拆解」，理由是「需任务 DAG 拆解 + 聚合 + 冲突消解，是独立大工程（约 +12 人日）」。用户选择 B，等于接受了这个成本。

A 路线交付后，缺的那块很清楚：`/team dispatch` 是**一次派单给一个角色**，`/team autonomous` 是**一个角色跑多个阶段**。两者都没有「一个目标 → 多个角色分工 → 汇总」这条链路。用户说的「群组」，指的就是这条链路。

**A 路线留下的地基刚好够用**，这是现在能做的关键：

| 地基 | 来源 | L2 怎么用 |
| --- | --- | --- |
| `executeDispatch(task, opts)` | 既有 | 每个子任务的执行单元，一行调用 |
| `runner` 注入（工具轮次） | L1-1 | 子任务能真实改代码，不是只吐文本 |
| `candidates` 候选集 | L0-2 | 拆解出的 `roleHint` 能命中业务专家 |
| `DispatchEventLog` | L1-3 | 编排级事件流，append-only、崩溃可查 |
| `runEphemeral` 临时会话 | L1-1 | 并行子任务互不污染会话 |

没有 A 路线，L2 需要先把这几件事重做一遍。

---

## 二、四阶段模型

```
goal
 │
 ├─ 阶段 1 拆解    1 次 LLM → JSON → 严格校验 ──失败──▶ 降级：单任务 dispatch（A 路线行为）
 │
 ├─ 阶段 2 分层    Kahn 拓扑分层 + 文件冲突下移（纯函数，无 I/O）
 │
 ├─ 阶段 3 执行    逐层推进；层内并发（上限 maxParallel）；依赖失败 → 后继 skipped
 │
 └─ 阶段 4 聚合    1 次 LLM 汇总 ──失败──▶ 降级：本地拼装报告（编排仍算成功）
```

### 2.1 拆解产物协议

```jsonc
{
  "rationale": "为什么这样拆",
  "subtasks": [
    {
      "id": "t1",                      // 短标识，唯一
      "title": "设计导出接口",
      "description": "完整任务描述（直接喂给 dispatch）",
      "roleHint": "architect",         // 可选，不存在时自动降级为匹配
      "dependsOn": [],                 // 前置子任务 id
      "files": ["src/export.ts"],      // 声明会改的文件，用于冲突消解
      "acceptance": "接口签名与调用方对齐"  // 可选，完成判据
    }
  ]
}
```

**为什么用 JSON 而不是 tool call**：`team/` 层没有 tool 定义通道，走 `chat.completions` 的纯文本路径最轻；容错靠「提取第一个 `{...}` 块」而不是靠 function calling 的强约束。

### 2.2 校验清单（`validatePlan`）

拆解结果来自 LLM，**一律视为不可信输入**：

| 校验 | 不通过的后果 |
| --- | --- |
| `subtasks` 数量 1 ≤ n ≤ `maxSubtasks` | 拒绝 → 降级 |
| `id` 唯一、匹配 `^[A-Za-z][A-Za-z0-9_-]{0,23}$` | 拒绝 |
| `dependsOn` 只引用存在的 id，且无自依赖 | 拒绝 |
| 无环（Kahn 消不掉所有节点即有环） | 拒绝 |
| `description` 非空、≤ 4000 字符 | 拒绝对应子任务（不整单失败） |
| `files` 必须是**项目内相对路径**：拒绝绝对路径、`..`、盘符 | 丢弃该路径（保留子任务） |

`files` 的路径校验是安全项：拆解被诱导写入 `/etc/passwd` 时，不能让它进入冲突检测与后续报告。

### 2.3 分层与文件冲突消解

Kahn 分层得到 `layers: string[][]`，同层并行。

**冲突定义**：同层两个子任务的 `files` 集合有交集（规范化后比较）。

**处理**：保留层内第一个，其余**下移到下一层**（若已是最后一层则新建一层）。不做拒绝、不做合并。

**为什么不用 git worktree 隔离**（`team/workflows/worktree-manager.ts` 已有实现）：

1. runner 的 cwd 是 `projectRoot`，worktree 会让所有路径漂移，需要给每个子任务注入不同的 cwd —— 而 `DispatchRunnerContext` 目前只有一个 `projectRoot`；
2. 合并阶段要处理真实冲突（同文件不同 hunk），这是另一套工程，且自动合并出错比串行慢更危险；
3. 串行只损失时间，不损失正确性。**诚实串行 > 聪明合并**。

### 2.4 预算

| 项 | 默认 | 作用 |
| --- | --- | --- |
| `maxSubtasks` | 6 | 拆解上限，防 LLM 无限展开 |
| `maxParallel` | 2 | 层内并发上限 |
| `maxToolRounds` | 8 | 单子任务工具轮次（透传 `DispatchOptions`） |
| `totalToolRounds` | 32 | **全局**工具轮次预算，扣完后续子任务 `skipped` |

`totalToolRounds` 是必须的：6 子任务 × 8 轮 = 48 轮，一次误触发的成本不可接受。

### 2.5 降级路径（每一层都不许挂掉整个编排）

| 失败点 | 降级为 | 用户看到 |
| --- | --- | --- |
| 拆解 LLM 不可用 / JSON 非法 / 校验失败 | 单任务 dispatch（用 goal 原文） | 报告首行注明「拆解失败，已降级为单角色派单」 |
| 单个子任务失败 | 标记 failed，依赖它的后继 skipped | 报告列出失败子任务与跳过的后继 |
| 聚合 LLM 失败 | 本地拼装（子任务标题 + 状态 + 输出摘录） | 报告结构不变，只是不够"总结" |
| 事件日志写入失败 | 静默跳过日志 | 无感知（审计设施不拖垮业务） |

---

## 三、模块落位

```
core/src/team/orchestrator/
  types.ts        类型 + 预算 schema
  plan-graph.ts   validatePlan / topologicalLayers / serializeFileConflicts（纯函数）
  llm-once.ts     单次 chat completion（拆解与聚合共用）
  decompose.ts    拼 prompt → 调用 → 解析 → 校验
  execute.ts      分层执行 + 并发 + 预算扣减
  aggregate.ts    汇总 prompt → 调用 → 降级拼装
  index.ts        orchestrate() 主流程 + 事件 + 进度
```

依赖方向：`orchestrator → { team-adapter, dispatch-event-log, team/types, common/openai-client }`，不 import `commands/`、`session/`、`agents/`。命令层（`commands/team-command.ts`）调用 `orchestrate()`。

**为什么不把拆解塞进 `executeDispatch`**：`executeDispatch` 的语义是「一个任务派给一个角色」，让它认识「多个子任务」会把 1490 行的适配器变成编排器，违反单一职责，且会把 A 路线的全部回归面拖进 L2。

### 3.1 `llm-once.ts` 为什么不复用 `executeDispatch` 里的 `callLlmOnce`

后者是 `executeDispatch` 的**闭包内函数**，依赖外层的 `handle`、`thinkingOptions`、`requestId`、`debugLogEnabled` 与 `eventLog`。导出它需要改动 `executeDispatch` 的调用栈，风险面覆盖 A 路线全部已验收行为。

因此独立实现一个精简版（约 60 行）：只做「messages → content」+ 超时 + `reasoning_content` 兜底。**不实现**续写、token 统计、debug 日志——拆解与聚合的输出都很短（< 2000 token），不需要续写。

---

## 四、事件日志扩展

新增事件类型（沿用同一 JSONL 格式与目录约定）：

```
orchestrate/plan            拆解产物（子任务数、层数、降级与否）
orchestrate/subtask-start   子任务开始（id / roleId / layer）
orchestrate/subtask-end     子任务结束（status / 轮次 / 工具调用数）
orchestrate/aggregate       聚合阶段（是否走了 LLM / 是否降级）
orchestrate/end             编排终态
```

**必须修的一处**：`DispatchEventLog.open()` 用 `last.type !== "dispatch/end"` 判崩溃。编排日志末条是 `orchestrate/end`，会被误判为崩溃并追加一条假终态。构造函数新增 `endType` 参数（默认 `"dispatch/end"`，编排传 `"orchestrate/end"`）。

---

## 五、命令入口

```
/team auto --goal "给项目加一个 CSV 导出功能"
           [--max-subtasks 6] [--max-parallel 2]
           [--dry-run] [--no-aggregate]
```

| flag | 作用 |
| --- | --- |
| `--dry-run` | 只跑到阶段 2：展示拆解结果与分层计划，**不执行、不调用 runner、不改文件** |
| `--no-aggregate` | 跳过聚合法 LLM 调用，直接本地拼装（省一次调用） |

`--dry-run` 是 L2 的验收工具：能单独检验「拆得对不对」，不烧工具轮次、不动工作区。

---

## 六、验收

| # | 断言 | 类型 |
| --- | --- | --- |
| O1 | 拆解解析：裸 JSON / fenced JSON / 前后有解释文字，三种都能提取；无 JSON → 返回错误而非抛异常 | 单测 |
| O2 | 校验：环、未知 dependsOn、重复 id、超上限、绝对路径 files —— 分别被拒或丢弃 | 单测 |
| O3 | 分层：菱形依赖 → `[[t1],[t2,t3],[t4]]` | 单测 |
| O4 | 冲突：同层两个子任务都声明 `a.ts` → 后者下移到下一层，且原因可读 | 单测 |
| O5 | 执行：依赖失败 → 后继 `skipped`，无依赖的兄弟正常完成 | 单测 |
| O6 | 预算：`totalToolRounds` 扣完 → 剩余子任务 `skipped`，不超发 | 单测 |
| O7 | 聚合降级：LLM 抛错 → 报告仍生成，`aggregated: false` | 单测 |
| O8 | `--dry-run`：不调用 runner、不产生 dispatch 事件、不写文件 | 单测 |
| O9 | 端到端（stub client + stub runner）：2 子任务 → 结果含每子任务状态、聚合文本、runId | 单测 |
| O10 | 用户可见：Web / CLI 敲 `/team auto --goal ... --dry-run` 看到「拆解 → 分层」计划 | 手工 |

---

## 七、明确不做

| # | 不做 | 理由 |
| --- | --- | --- |
| 1 | 动态重规划（执行中根据结果改 DAG） | 需要「执行中重拆」+ 已执行子任务的回滚语义，是另一个大工程 |
| 2 | 子任务之间传结构化上下文（t2 读 t1 的产出文件） | 当前靠共享工作区 + 依赖顺序保证；结构化传参需要产出契约，留 L3 |
| 3 | 自动合并冲突（同文件并行改动） | 见 §2.3，串行替代 |
| 4 | 跨子任务的 token 预算动态分配 | 固定配额，够用且可预测 |
| 5 | 子任务级人工审批中断 | 复用 runner 的既有审批；编排层不做二次审批 |
