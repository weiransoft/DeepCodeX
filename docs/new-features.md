# DeepCodeX 新特性总览

> **版本**：v1.3
> **日期**：2026-07-26（v1.0）；2026-08-04（v1.1 文档对照代码一致性核查修订）；2026-09-12（v1.2 新增 Q 章：F9-v2 建议循环确定性执行 + F10 任务中指令分发加固）；2026-09-15（v1.3 新增 Q.6：F9-v2 自主循环空转修复——补全 EAG-P5 LLM 任务执行链路）
> **状态**：✅ 已实施完成（例外：F.4 后台任务持久化、C.4 `.deepcode/eag.yml` 文件加载为已规划未接线，详见对应章节标注）
> **关联文档**（`docs/fusion/` 为本地设计文档，未入库，链接仅本机有效）：
> - 设计蓝图：[docs/fusion/DEEPCODEX_FUSION_PLAN.md](fusion/DEEPCODEX_FUSION_PLAN.md)
> - V2 上下文记忆：[docs/fusion/V2_CONTEXT_MEMORY_PRD.md](fusion/V2_CONTEXT_MEMORY_PRD.md)
> - EAG 使用指南：[docs/eag-autonomous.md](eag-autonomous.md)
> - 历史审查记录（已归档）：[docs/archive/](archive/)
>
> **v1.1 修订说明（2026-08-04）**：经多角色团队对照代码逐项核查，修正了以下与实现不符的内容：
> 命令名 `deepcodex` → `deepcode`；`--max-iter` → `--max-iterations`；`--agent` → `--role`（CLI 无 `--explain`/`--match-strategy` 选项）；
> `/eag-autonomous-status|stop` 参数为位置参数（非 `--run-id`）；EAG-P5 RunState 实际路径为 `.eag/p5/run-state/<runId>.jsonl`；
> `/inject` 实际格式为 `/inject <指令文本>`（无 taskId 参数）；F.4 后台任务持久化尚未接线（Phase 2 规划）；
> `/team consensus` 实为 `team dispatch --consensus` flag。原引用的 `docs/enterprise/*.md` 与两篇 `docs/dev/*.md` 设计文档未入库，
> 已从导航中移除并改指代码路径；历史审查/事故/修复计划文档已归档至 [docs/archive/](archive/)。

---

## 概述

DeepCodeX 在 Deep Code CLI 的基础上完成了**多角色融合**与**企业级应用生成能力（EAG）**两大跃迁，并补充了动态指令注入、AskUserQuestion 自动衔接、V2 上下文记忆、Loop-Graph 融合编排等多项新特性。本文档汇总所有已落地的新特性，按能力域分组介绍。

| 能力域 | 关键能力 | 主要入口 |
|--------|---------|---------|
| A. 多角色协作 | 5 核心角色 + 30 领域专家 + 智能匹配 + 共识评审 | `/team` 子命令 |
| B. 自主编排 | Ralph 4 阶段循环 + Cybernetics 控制论 + 6 大工作流模式 | `/team autonomous` |
| C. EAG 企业级应用生成 | 三 Loop 设计/编码/测试 + 红线评估 + 范式唤起 | `/eag-autonomous` |
| D. Loop-Graph 融合 | DAG 拓扑编排 + 节点内 Loop + 谓词路由 + 图级护栏 | `/eag-graph` |
| E. V2 上下文记忆 | 双层上下文 + 滑动窗口 + Diff 预览 + 双轴审批 + 经验 RAG | 自动启用 |
| F. 动态中断与后台任务 | InterruptQueue + 后台子 Agent + 任务状态机 | `/inject` `/bg` `/tasks` |
| G. AskUserQuestion 自动衔接 | 白名单 + suggestedCommand + 自动命令执行 | 由 LLM 触发 |
| H. Builtin Skills 增强 | 4 bundled + 3 默认 + 4 文档处理 skills | `/skills` |
| I. 日志与可观测性 | 日志轮转 + 错误类型保留 + 中断事件日志 | 自动启用 |
| J. 多模型 Provider | Anthropic 原生 + OpenAI 兼容 + Qwen3 兼容 | `settings.json` |

---

## A. Team 多角色协作

### A.1 5 核心角色

DeepCodeX 内置 5 个软件开发技术执行链路角色，每个角色拥有独立 systemPromptSuffix、独立职责边界、独立测试覆盖：

| 角色 | expertId | 职责 | 触发关键词 |
|------|----------|------|-----------|
| 架构师 | `architect` | 设计系统性、前瞻性、可落地、可验证的架构 | 架构、设计、选型、审查 |
| 产品经理 | `product-manager` | 定义用户价值清晰、需求明确、可验收的产品 | 需求、PRD、用户故事 |
| 独立开发者 | `solo-coder` | 编写完整、高质量、可维护、可测试的代码 | 实现、开发、修复、重构 |
| 测试专家 | `test-expert` | 全面、深入、自动化、可量化的质量保障 | 测试、质量、验收、自动化 |
| UI 设计师 | `ui-designer` | 独特、生产级的 UI 界面，避免 AI "slop" 美学 | UI 设计、界面设计、视觉 |

### A.2 30 个领域专家

为补齐业务领域视角，DeepCodeX 从 woagent `builtin-agent-templates.yml` 中筛选并纳入了 30 个领域专家（强制 `domain-` 前缀）。所有领域专家支持**懒加载**与**动态匹配**，按业务领域自动激活，不会污染默认上下文。

| 类别 | 数量 | 代表专家 |
|------|------|---------|
| product | 4 | product-manager / sprint-prioritizer / trend-researcher / feedback-synthesizer |
| project_management | 3 | project-producer / project-shepherd / jira-workflow-automation |
| support | 4 | legal-compliance / finance-tracker / customer-response / analytics-reporter |
| specialized | 5 | agent-orchestrator / blockchain-security-auditor / medical-marketing-compliance / cloud-architect / data-scientist |
| academic | 4 | anthropologist / geographer / historian / psychologist |
| strategy | 4 | business-strategist / competitive-analyst / innovation-strategist / digital-transformation |
| marketing（选择性纳入） | 5 | growth-hacker / content-creator / seo-specialist / xiaohongshu-operator / cross-border-ecomm |
| sales（选择性纳入） | 1 | solution-strategist |

> 详细纳入清单与匹配权重见代码实现：`packages/core/src/team/domain-experts/`（30 个领域专家定义）与 `packages/core/src/team/domain-expert-matcher.ts`（匹配权重）。

### A.3 智能匹配策略

`role-matcher.ts` 提供三种匹配策略（CLI 通过关键词命中自动选择，宿主 LLM 场景可在提示词层显式指定）：

- **keyword**（默认）：基于关键词命中
- **semantic**：基于 TFIDF/Hashing 本地 embedder 的余弦相似度
- **ai**：宿主 LLM 提示词层智能匹配（脚本层不可用时自动降级到 semantic）

```bash
# 显式指定角色
deepcode team dispatch --task "设计微服务架构" --role architect

# 自动匹配（省略 --role 即按关键词自动匹配）
deepcode team dispatch --task "设计微服务架构"

# 强制关闭自动匹配，直接派单
deepcode team dispatch --task "编写单元测试" --role test-expert --force-role
```

### A.4 八阶段标准工作流

完整项目流程支持 8 阶段循环（含 v2.8 新增阶段 8 文档对照审查）：

```
阶段 1: 需求分析（产品经理）
阶段 2: 架构设计（架构师）
阶段 3: UI 设计（UI 设计师）
阶段 4: 测试设计（测试专家）
阶段 5: 任务分解（独立开发者）
阶段 6: 开发实现（独立开发者）
阶段 7: 测试验证（测试专家）
阶段 8: 文档对照代码审查（多角色）  ★ v2.8 新增
```

阶段 8 审查失败时根据缺口维度精准回退到对应阶段修复，最大迭代次数默认 3 次。

```bash
deepcode team full-lifecycle --goal "启动项目：安全浏览器广告拦截功能"
```

---

## B. Autonomous 自主编排模式

基于 Ralph 风格的 4 阶段循环：**plan → dev → verify → fix**，循环直到完成或达到迭代上限。

### B.1 4 阶段职责

| 阶段 | StageHandler | 核心职责 |
|------|--------------|---------|
| Plan | `PlanStageHandler` | 从 tasks.md 取下一任务卡 + G-A3a 范围锁预检 |
| Dev | `DevStageHandler` | G-A1a 路径牢笼 + G-A5a 凭据白名单 + 文件状态盘点 + ChangeDiff 制品 |
| Verify | `VerifyStageHandler` | 真实测试命令执行 + 测试输出解析（Jest/Mocha/node:test/generic）+ G-A4a 证据强制 |
| Fix | `FixStageHandler` | 失败模式分析（6 类分类）+ 修复建议生成 + G-A3b 清理意图永禁 |

### B.2 6 层 15 条 BLOCKER 安全护栏

无人值守模式下所有命令必须通过 6 个 Guard 链的检查：

| Guard | 编号 | 防护内容 |
|-------|------|---------|
| EnvBoundaryGuard | G-A1a/b/c | 路径牢笼 / 环境变量写保护 / 生产凭据不可达 |
| DangerousCommandGuard | G-A2a/b | 黑名单命令 / 递归删除 |
| ScopeLockGuard | G-A3a/b | 范围锁（越界返回 ASK 转人工）/ 清理意图永禁 |
| FakeCompletionGuard | G-A4a/b | 证据强制 / 伪完成检测 |
| CredentialMisuseGuard | G-A5a/b | 凭据白名单 / commit 前密钥扫描 |
| RuntimeConstraintGuard | G-A6a/b/c/d | 迭代上限 / 超时熔断 / 心跳 MAJOR / 上限冻结 |

### B.3 三命令完整链路

```bash
# 启动无人值守循环（TUI 内）
/eag-autonomous --goal "实现登录功能" --max-iterations 10

# 查询运行状态（位置参数，省略时取最近一次 run）
/eag-autonomous-status <runId>

# 熔断回滚（通过 abort flag 文件实现跨进程 stop）
/eag-autonomous-stop <runId>
```

> Team 模块另提供 CLI 子命令 `deepcode team autonomous --goal "..." --max-iterations 10`（独立于 EAG-P5 引擎）。

### B.4 持久化与跨轮记忆

- **RunState JSONL**（EAG-P5）：`<projectRoot>/.eag/p5/run-state/<runId>.jsonl`，每行一个 JSON 对象，含 `localChecksum` / `cumulativeChecksum` SHA256 校验与文件锁
- **RunState JSON**（Team autonomous CLI）：`./.deepcodex/runs/<runId>/state.json`，与 EAG-P5 为两套独立存储
- **NotesMemory**：`./.deepcodex/notes.md`，跨轮记忆，多个 run 共享
- **断点续跑**：Team autonomous 使用 `--resume-run`（布尔开关，恢复最近一次可恢复 run）；EAG-P5 通过 `/eag-autonomous-status` 查询续跑证据

### B.5 配置文件

项目根目录创建 `./.deepcodex/autonomous.yml`：

```yaml
max_iterations: 10
confirmation: smart        # auto-approve | ask-user | fail-closed
sleep_guard: true
git:
  auto_commit: true
  branch_prefix: "autonomous/"
```

### B.6 Dynamic Workflows 6 大模式

| 任务特征 | 路由模式 | 执行方式 |
|---------|---------|---------|
| 可分解为独立子任务（并行宽 ≥ 2） | fan-out-aggregate | 并行派发 → 聚合结果 |
| 需要质量验证/对抗审查 | adversarial-verify | 生成 → 审查 → 修复循环 |
| 需要多方案竞争 | tournament | 多方案并行 → 最优胜出 |
| 需批量生成后筛选 | generate-filter | 批量生成 → 质量过滤 |
| 任务类型明确且单一 | classifier-dispatch | 分类 → 单角色执行 |
| 成功标准可量化但未达成 | loop-until-done | 迭代直到满足标准 |

### B.7 Cybernetics 三环控制

参考钱学森工程控制论与 ICLR 2026 Profile-Aware Maneuvering 架构：

- **战略层**：感知 → 决策 → 执行 → 反馈完整闭环
- **战术层**：执行前验证 + 异常检测 + AI 增强风险评估
- **执行层**：守护协调器（Guard Coordinator）

---

## C. EAG 企业级应用生成

> 代码实现：`packages/core/src/eag/`（gate / graph / loop / coding / testing / design / p5 等子系统）。使用指南：[docs/eag-autonomous.md](eag-autonomous.md)

### C.1 核心理念

**企业应用生成 = 架构范式知识 × Loop Engineering × 多角色协作**

三个范式转化：

1. **从"提示模型写代码"到"设计循环让模型自我唤起范式"**：用户输入原始业务需求（"我要一个订单管理服务"），范式选择由架构师角色在 DESIGN Loop 中完成
2. **从"人类专家把关"到"独立评估器按企业红线把关"**：Generator 与 Evaluator 严格分离，写代码的模型不给自己打分
3. **从"线性脚本"到"Loop 化三循环递进"**：设计 / 编码 / 测试三 Loop 串联，人只在 HUMAN_CHECKPOINT 介入

### C.2 EAG-P5 无人值守引擎已完成

| 维度 | 数据 |
|------|------|
| 代码路径 | `packages/core/src/eag/p5/` |
| 文件数 | 20 个 TS 文件 |
| 代码行数 | 16159 行 |
| 测试用例 | 52 个 E2E 测试（L-U 组，4346 行测试代码） |

详细组件清单见代码 `packages/core/src/eag/p5/`（设计文档未入库）。

### C.3 EAG-P6 CodeMap 动态窗口

符号级代码图谱（CALLS / INHERITS / IMPLEMENTS / TESTED_BY）+ 动态上下文窗口策略，提升 Token 使用效率。

### C.4 范式锁定（组织规范）

范式锁定机制已实现（`eak/paradigm-registry.ts`：锁定时架构师角色跳过范式信号判定，严格遵循组织规范）。锁定配置通过 `DesignLoopInput.paradigmLock` 传入：

```yaml
paradigm_lock: "ddd"  # ddd | clean-architecture | cqrs | microservice | ...
```

> ⚠️ **未接线（2026-08-04 核查）**：`.deepcode/eag.yml` 文件的读取与 YAML 解析尚未在仓库内实现，配置文件加载责任由调用方在调用前合并（见 `design-models.ts` 注释）。当前仅支持通过 API 传入 `paradigmLock`。

---

## D. Loop-Graph 融合架构

> 代码实现：`packages/core/src/eag/graph/`（graph-builder / graph-loop-orchestrator / predicate-registry / node-loop-kernel 等）；命令解析：`packages/core/src/eag/cli/eag-graph-command.ts`

### D.1 核心能力

将复杂任务建模为 **DAG 拓扑图**，通过节点间的数据契约和条件路由，实现多阶段、多分支、并行编排的自动化执行。

- **6 种节点类型**：loop / task / decision / merge / fork / end，覆盖串行、并行、条件路由等编排场景
- **节点内 Loop 闭环**：`loop` 类型节点内部复用 P5 AutonomousOrchestrator 的 4 阶段循环
- **契约驱动**：节点通过 `inputContract` / `outputContract` 声明数据契约，边通过 `dataMapping` 描述数据流转
- **谓词路由**：所有条件逻辑通过 `PredicateRegistry` 注册的谓词函数实现，**消除 RCE 风险**
- **图级护栏**：深度上限、并行度上限、Token 预算、超时控制、节点失败自动隔离
- **三层配置合并**：`DEFAULT < JSON config < CLI 参数`
- **不可变优先**：所有接口字段 `readonly` + `Object.freeze` 冻结

### D.2 命令用法

```bash
# 从文件加载图定义
/eag-graph --graph-file graphs/standard-delivery-chain.json

# 从文件加载 + 覆盖配置
/eag-graph --graph-file graphs/standard-delivery-chain.json --max-depth 50 --enable-experience-recall

# 内联图定义
/eag-graph --inline-graph '{"graphId":"demo","name":"Demo","entryNodeId":"start","nodes":[...],"edges":[...]}'

# 内联图定义 + 禁用自动隔离
/eag-graph --inline-graph '{"graphId":"demo",...}' --disable-auto-isolation --timeout-sec 3600
```

### D.3 关键参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--graph-file` | — | 图定义 JSON 文件路径（与 `--inline-graph` 互斥） |
| `--inline-graph` | — | 内联图定义 JSON 字符串 |
| `--enable-experience-recall` | `false` | 启用经验召回（Layer 3） |
| `--disable-auto-isolation` | `true` | 禁用节点失败自动隔离 |
| `--max-depth` | `100` | 最大遍历深度 |
| `--max-parallelism` | `4` | 最大并行度 |
| `--timeout-sec` | `0` | 图级超时秒数（0 表示不限制） |
| `--max-tokens` | `0` | 图级 Token 预算 |
| `--node-retry-limit` | `3` | 节点失败重试次数 |

---

## E. V2 上下文记忆与 Diff/Approval

> 完整设计：[docs/fusion/V2_CONTEXT_MEMORY_PRD.md](fusion/V2_CONTEXT_MEMORY_PRD.md)（本地文档未入库）

### E.1 双层上下文

- **GlobalContext**（跨任务）：项目级长期上下文，跨会话保留
- **TaskContext**（单任务）：当前任务的工作上下文，任务结束清理
- **ContextSynchronizer**：双向同步机制

### E.2 任务聚焦滑动窗口

基于 CodeMap 的相关性评分滑动窗口，替代简单的全量压缩。在 DeepSeek V4 1M 上下文窗口下实现精准聚焦。

### E.3 Diff 预览增强

- **彩色 unified diff**：`+` 行绿色 / `-` 行红色 / 上下文行默认色
- **fuzzy matching**：容错匹配
- **PatchSummaryCell**：hunk 摘要
- **multi-hunk 支持**：一个文件多处修改
- **性能**：10KB 文件 diff < 50ms

### E.4 双轴审批门

**AppMode × ApprovalMode 正交设计**：

| Approval \ App | Plan | Agent | YOLO |
|----------------|------|-------|------|
| **Suggest** | 建议后人工确认 | 建议后人工确认 | 直接执行 |
| **Auto** | 自动执行 + 报告 | 自动执行 + 报告 | 直接执行 |
| **Never** | 永不执行 | 永不执行 | 永不执行 |

### E.5 side-git 零污染回滚

使用 `--git-dir` / `--work-tree` 分离的 side-git 仓库，turn 级快照回滚，**不污染主仓库**。

### E.6 业务理解

- **CodeMap**：代码地图（符号级）
- **AST 解析**：项目结构识别（monorepo / 分层架构）
- **业务领域建模**：从代码推断业务领域

### E.7 7 维度动态记忆体系

| 维度 | 范围 | 持久化 |
|------|------|--------|
| 用户全局记忆 | 跨项目 | `~/.deepcodex/memory/user_profile.md` |
| 项目记忆 | 单项目 | `.deepcodex/memory/project_memory.md` |
| 任务临时记忆 | 单任务 | 运行时内存 |
| 经验 RAG | 跨项目 | 向量检索 |
| Topics 摘要 | 单项目 | `.deepcodex/memory/projects/<project>/YYYYMMDD/topics.md` |
| Session 记忆 | 单会话 | `session_memory_<id>.jsonl` |
| 性能画像 | 单项目 | 执行案例记录 + 相似案例检索 |

---

## F. 动态中断与后台任务（ADR-DI-001）

允许用户在任务执行过程中追加指令或启动独立子任务，类似 Claude CLI 的中断能力。

### F.1 InterruptQueue FIFO 指令队列

在 LLM 调用间隙和流式响应中检查并消费指令，合并为 system 消息调整任务方向。

### F.2 任务状态机

11 个状态 + 合法转换表：

```
queued → pending → running ⇄ pausing ⇄ paused
                           ↓
                       retrying → running
                           ↓
            timeout / failed / succeeded / cancelled
                           ↑
                       injecting（动态注入指令）
```

### F.3 命令入口

| 命令 | 用途 |
|------|------|
| `/inject <指令文本>` | 向当前正在执行的任务追加指令（软中断，下一轮 LLM 调用消费） |
| `/bg <prompt>` | 后台启动子 Agent（独立 SessionManager 实例） |
| `/tasks` | 列出所有任务 |
| `/fg <taskId>` | 切换前台关注 |
| `/cancel <taskId>` | 取消指定任务 |
| `/pause` | 暂停当前前台任务 |
| `/resume <taskId>` | 恢复暂停的任务 |

### F.4 持久化与恢复

> ⚠️ **未接线（2026-08-04 核查，Phase 2 规划）**：任务快照序列化（`TaskSnapshot` / `toSnapshot` / `fromSnapshot`）与 `TaskStoreLike` 接口已定义，但仓库内尚无 `TaskStoreLike` 实现类，CLI 装配层创建 `BackgroundTaskRunner` 时未注入 taskStore。当前任务状态仅内存管理，进程崩溃后不会自动转为 `paused`，`.deepcodex/tasks/` 目录不会写入。LLM 工具侧可使用 `inject_message(task_id, message)` 面向指定后台任务注入消息。

### F.5 LLM 工具集成

新增 4 个 LLM 可调用工具：

- `background_task`：启动后台子任务
- `list_tasks`：列出所有任务
- `cancel_task`：取消指定任务
- `inject_message`：向指定任务注入消息

### F.6 中断机制

- **软中断**（注入指令）：通过 InterruptQueue 在 LLM 间隙消费
- **硬中断**（取消任务）：基于 AbortController + 文件标志（`.abort` 文件）跨进程中断

---

## G. AskUserQuestion 自动衔接执行

> 代码实现：`packages/core/src/common/`（核心层 `parseSuggestedCommand` 白名单）与 `packages/cli/src/ui/core/ask-user-question.ts`（CLI 层 `normalizeSuggestedCommand` 二次校验）

### G.1 问题背景

LLM 通过 AskUserQuestion 工具向用户提问后，用户回答仅作为消息发送给 LLM，**无法自动触发后续命令执行**，导致需要用户手动输入 `/team dispatch` 等命令衔接，体验割裂。

### G.2 解决方案

扩展 AskUserQuestion 工具添加可选 `suggestedCommand` 字段，用户回答后自动注入命令执行：

```typescript
{
  "questions": [...],
  "suggestedCommand": {
    "command": "/team dispatch",
    "reason": "用户已确认评审范围，建议自动派单给架构师"
  }
}
```

### G.3 安全保障（三层白名单）

1. **核心层 parseSuggestedCommand**：白名单校验，仅允许 `team / architect / pm / coder / tester / ui / eag-*` 命令
2. **CLI 层 normalizeSuggestedCommand**：与核心层对齐的白名单二次校验
3. **命令必须以 `/` 开头**：防止注入任意 shell 命令

### G.4 并发安全（合并方案）

为避免并发触发 SessionManager 状态机竞态，采用**单次 handlePrompt 调用合并方案**：用户回答 + 自动命令合并为一次提交，避免两次 prompt 并发。

---

## H. Builtin Skills 增强

> 代码实现：`packages/core/src/skill-manager.ts`（扫描与加载）与 `packages/cli/dist/templates/skills/`（bundled skills 模板）

### H.1 新增 bundled skills（4 个）

| Skill | 用途 |
|-------|------|
| `web-dev` | 全栈前端开发（React + Vite + Tailwind + shadcn/ui） |
| `web-artisan` | 高质量 web 工件与营销页面 |
| `code-mode-orchestrator` | 代码模式编排（多模式切换） |
| `browser-automation` | 浏览器自动化测试与抓取 |

### H.2 新增默认 skills（3 个）

默认启用，可通过 `settings.json` 的 `enabledSkills` 关闭：

| Skill | 用途 |
|-------|------|
| `design-aesthetics` | 设计美学约束 |
| `ui-ux-best-practices` | UI/UX 最佳实践 |
| `code-quality-guidelines` | 代码质量准则 |

### H.3 新增文档处理 skills（4 个）

基于真实 Python 脚本（无 mock / 占位 / 简化）：

| Skill | 实现方案 | 主要能力 |
|-------|---------|---------|
| `docx` | python-docx | 创建 / 编辑 / 格式化 Word 文档 |
| `pdf` | pdfplumber + token-based 设计系统 | 创建 / 重格式化 / 表单填写 |
| `pptx` | PptxGenJS + CSV 数据 | 创建 / 编辑 / 抽取文本 |
| `xlsx` | openpyxl + recalc.py | 创建 / 编辑 / 公式重算 / 数据分析 |

### H.4 可视化渲染器与 Widget 工具

- `packages/core/src/visualization/renderer.ts`：可视化渲染器，支持多类型组件渲染
- `packages/core/src/visualization/widget-tool.ts`：LLM 可调用的可视化 widget 工具

---

## I. 日志与可观测性

### I.1 日志轮转

> 代码实现：`packages/core/src/common/log-rotation.ts`

按文件大小（**10MB**）轮转，保留 **3 个备份**，替代历史"读全文 + slice + 重写"的性能反模式。

涉及日志文件：

- `~/.deepcodex/logs/debug.log` + `.1` / `.2` / `.3` 滚动备份
- `~/.deepcodex/logs/error.log` + 滚动备份
- `~/.deepcodex/logs/interrupts.log` + 滚动备份

### I.2 错误类型保留

修复 `llm-error.ts` 中 message fallback 逻辑，确保原始错误类型在日志中正确显示：

```
# 修复前
[ERROR] Request failed: <message>

# 修复后
[ERROR] APIUserAbortError: Request aborted by user
[ERROR] APIError 400: Invalid request payload
```

### I.3 中断事件日志

新增 `interrupt-logger.ts` 模块，记录动态指令注入和后台任务的关键事件到 `interrupts.log`，便于问题排查和行为追踪：

```jsonl
{"ts":"2026-07-26T10:30:00Z","event":"inject","taskId":"t-001","message":"...","source":"user"}
{"ts":"2026-07-26T10:31:00Z","event":"bg_start","taskId":"t-002","kind":"autonomous"}
{"ts":"2026-07-26T10:35:00Z","event":"task_cancel","taskId":"t-002","reason":"user_cancel"}
```

---

## J. 多模型 Provider 支持

### J.1 支持的 Provider

| Provider | 适用模型 | 接入方式 |
|----------|---------|---------|
| OpenAI 兼容（默认） | DeepSeek V4 / Doubao / Qwen / 任意 OpenAI 兼容 | `BASE_URL` + `API_KEY` |
| Anthropic 原生 | Claude 3.5 / 3.7 / Opus / Sonnet | 原生 API + `reasoning` 字段独立提取 |

### J.2 Qwen3 推理模型兼容

`reasoning` 字段独立提取，避免内容放入 SSE 聚合问题；支持多模型框架字段兼容（Qwen3 / DeepSeek-R1 / Claude 3.7）。

### J.3 配置示例

```json
{
  "env": {
    "MODEL": "claude-opus-4",
    "PROVIDER": "anthropic",
    "API_KEY": "sk-ant-..."
  }
}
```

```json
{
  "env": {
    "MODEL": "qwen3-235b-a22b",
    "BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "API_KEY": "sk-..."
  }
}
```

---

## K. Plan Mode 规划模式

通过 `/plan` 命令切换规划模式，LLM 在该模式下仅生成实施计划，不执行实际代码变更。计划确认后退出规划模式进入执行阶段。

详见：[docs/plan-mode.md](plan-mode.md)

---

## L. 新增斜杠命令汇总

| 命令 | 用途 | 模块 |
|------|------|------|
| `/team` | 多角色团队调度（TUI 斜杠命令，自动匹配角色） | Team |
| `/architect` `/pm` `/coder` `/tester` `/ui` | 强制分派到指定角色 | Team |
| `/eag-autonomous` | 启动 EAG 无人值守循环 | EAG-P5 |
| `/eag-autonomous-status` | 查询 EAG 运行状态（位置参数 `<runId>`） | EAG-P5 |
| `/eag-autonomous-stop` | 熔断 EAG 回滚（位置参数 `<runId>`） | EAG-P5 |
| `/eag-graph` | 启动图编排执行 | Loop-Graph |
| `/inject` | 向当前任务追加指令 | 动态中断 |
| `/bg` | 后台启动子 Agent | 后台任务 |
| `/tasks` | 列出所有任务 | 后台任务 |
| `/fg` | 切换前台关注 | 后台任务 |
| `/cancel` | 取消指定任务 | 后台任务 |
| `/pause` | 暂停当前任务 | 后台任务 |
| `/resume` | 恢复暂停的任务 | 后台任务 |
| `/plan` | 进入规划模式 | Plan Mode |
| `/memory` | 记忆管理（list/delete/review/export） | V2 记忆 |
| `/rules` | RLIS 规则管理 | EAG-RLIS |
| `/quality-check` | 质量门禁（codemap/uiux/visual/all） | Quality Gate |
| `/review` | 代码审查（工具验证优先） | Review |
| `/help` | 列出全部内置命令 | 帮助 |

> Team 模块的 CLI 子命令（非斜杠命令）：`deepcode team list / match / dispatch / autonomous / full-lifecycle`；共识评审通过 `deepcode team dispatch --consensus` 启用；八阶段循环通过 `deepcode team full-lifecycle --use-loop` 启用。

---

## M. 配置文件一览

| 路径 | 用途 |
|------|------|
| `~/.deepcode/settings.json` | 用户级主配置（API_KEY / MODEL / 通知 / 权限） |
| `./.deepcode/settings.json` | 项目级配置（优先级高于用户级） |
| `./.deepcodex/autonomous.yml` | Autonomous 自主编排配置 |
| `./.deepcode/eag.yml` | EAG 企业级应用生成配置（含范式锁定） |
| `./.deepcodex/runs/<runId>/state.json` | 单次运行状态 |
| `./.deepcodex/notes.md` | 项目级跨轮记忆 |
| `./.deepcodex/tasks/` | 任务状态持久化目录 |
| `./.deepcodex/memory/` | 7 维度动态记忆体系 |

### .deepcode 与 .deepcodex 命名差异

| 目录 | 用途 |
|------|------|
| `~/.deepcode/` / `./.deepcode/` | Deep Code CLI 主配置目录（settings.json / skills / plugins） |
| `~/.deepcodex/` / `./.deepcodex/` | Team autonomous 专用目录（autonomous.yml / runs / notes / tasks / memory） |

---

## N. 测试基线

| 模块 | 测试数 | 说明 |
|------|--------|------|
| Core 单元测试 | 524+ | 含 V2 上下文记忆、EAG-P5、Domain Expert 等 |
| Team 单元测试 | 195 + 585 回归 | 30 领域专家 + 5 角色 |
| E2E 测试 | 12 个脚本 | team-cmd / v2-modules / arch-mechanisms / domain-expert / EAG 各批次 / e2e-eight-stage-loop |
| EAG-P5 E2E | 52 用例（L-U 组） | Dev / Verify / Fix / BLOCKER / 三命令 / 跨会话续跑 |
| 日志与中断 | 57 用例 | log-rotation / interrupt-logger / error-logger / debug-logger |
| AskUserQuestion | 2 套 | 核心层 + CLI 层白名单与合并方案 |
| 建议循环与指令分发（Q 章） | 62 用例 | prompt-dispatch 13 + session F9-v2 13 + suggestion-fallback 24 + loading-text 12 |

---

## O. 设计原则与约束

### O.1 Karpathy 四大核心原则

| 原则 | 核心要求 |
|------|---------|
| Think Before Coding | 明确假设、问清楚、不隐藏困惑 |
| Simplicity First | 最小代码、无 speculative features、无过度抽象 |
| Surgical Changes | 只改必要的、保持风格一致 |
| Goal-Driven | 定义成功标准、验证检查点 |

### O.2 Ponytail 决策梯（6 步）

1. YAGNI：真的需要吗？
2. 标准库：能用标准库吗？
3. 平台原生：能用平台原生能力吗？
4. 复用：能复用现有代码吗？
5. 一行优先：能一行实现吗？
6. 最小可行：最小可行实现是什么？

### O.3 真实实现承诺

- ❌ 禁止 mock / 占位 / 简化实现
- ✅ 所有 TODO 必须有对应实现
- ✅ 所有 FIXME 必须有对应修改
- ✅ 代码函数和关键逻辑必须有详细中文注释

---

## P. 相关文档导航

### 设计文档（按能力域分组）

> 注：`docs/fusion/` 目录为本地设计文档，未入库（被 .gitignore 排除），表中 fusion 链接仅在本机有效。

| 能力域 | 文档 |
|--------|------|
| 融合方案 | [docs/fusion/DEEPCODEX_FUSION_PLAN.md](fusion/DEEPCODEX_FUSION_PLAN.md) |
| Karpathy 原则 | [docs/fusion/KARPATHY_PRINCIPLES.md](fusion/KARPATHY_PRINCIPLES.md) |
| Ponytail 规则 | [docs/fusion/PONYTAIL_RULES.md](fusion/PONYTAIL_RULES.md) |
| V2 上下文记忆 PRD | [docs/fusion/V2_CONTEXT_MEMORY_PRD.md](fusion/V2_CONTEXT_MEMORY_PRD.md) |
| V2 上下文记忆技术方案 | [docs/fusion/V2_CONTEXT_MEMORY_TECH_DESIGN.md](fusion/V2_CONTEXT_MEMORY_TECH_DESIGN.md) |
| 输出截断设计 | [docs/fusion/V2_OUTPUT_TRUNCATION_DESIGN.md](fusion/V2_OUTPUT_TRUNCATION_DESIGN.md) |
| EAG 企业应用生成 | 设计文档未入库，见代码 `packages/core/src/eag/` |
| Loop-Graph 融合设计 | 设计文档未入库，见代码 `packages/core/src/eag/graph/` |
| 领域专家集成 | 设计文档未入库，见代码 `packages/core/src/team/domain-experts/` |
| Builtin Skills 增强 | 设计文档未入库，见代码 `packages/core/templates/skills/` 与 `packages/core/src/skill-manager.ts` |
| AskUserQuestion 自动衔接 | 设计文档未入库，见代码 `packages/cli/src/ui/core/ask-user-question.ts` |
| 日志修复设计 | 设计文档未入库，见代码 `packages/core/src/common/log-rotation.ts` |
| 历史审查/事故/修复记录（已归档） | [docs/archive/](archive/) |

### 用户文档

| 文档 | 用途 |
|------|------|
| [docs/quickstart.md](quickstart.md) | 快速开始 |
| [docs/configuration.md](configuration.md) | 配置说明 |
| [docs/architecture.md](architecture.md) | 架构总览 |
| [docs/agent-skills.md](agent-skills.md) | Agent Skills 指南 |
| [docs/mcp.md](mcp.md) | MCP 集成 |
| [docs/permission.md](permission.md) | 权限控制 |
| [docs/plan-mode.md](plan-mode.md) | Plan Mode |
| [docs/notify.md](notify.md) | 通知配置 |
| [docs/session-persistence.md](session-persistence.md) | 会话持久化 |
| [docs/statusline.md](statusline.md) | 状态行 |
| [docs/eag-autonomous.md](eag-autonomous.md) | EAG Autonomous 使用指南 |

---

## Q. 建议循环确定性执行与任务中指令分发（F9-v2 / F10）

> 代码实现：`packages/core/src/session.ts`（F9-v2 确定性执行通道）与 `packages/cli/src/ui/core/prompt-dispatch.ts` + `packages/cli/src/ui/core/suggestion-fallback.ts`（F10 分发与客户端兜底）
> 日期：2026-09-12（日志驱动的三缺口修复 + 五缺口分发加固）

### Q.1 问题背景

实测日志暴露两类体验断点：

1. **建议无法触达执行**：LLM 回合收尾给出"建议执行 /eag-autonomous --goal '...'"后，用户回复"执行这个全量覆盖！"被主 LLM 拒绝（"我不能直接替你执行"）；"启动 EAG 自主任务..."被建议器 LLM 误分类为 direct_chat，陷入"仅给出建议，不会自动执行"的循环。
2. **任务执行中指令分发缺口**：排队消息不绑定会话（切换会话后泄漏）、ESC 中断不清空队列（停不干净）、LLM 出错后队列连锁失败、紧急干预判定任意位置子串匹配误伤高频词（"要不要继续""别人写的""停用缓存"）。

### Q.2 F9-v2 确定性执行通道（core/session.ts）

分流不依赖 LLM 的确定性文本匹配（建议器之前执行）：

| 通道 | 触发条件 | 行为 |
|------|---------|------|
| 命令字面量 | 输入含 `/eag-autonomous` 字面量 | 直接进入命令分发 |
| 意图前缀 | "启动/执行 + EAG/自主任务/无人值守"（双层否定词保护："不要启动"不触发；泛化词"自动循环/自动编排"故意不收录防误伤） | 剥离意图前缀构造命令执行 |
| 指代确认 | "执行这个/该 X"式短语 + 上一条展示过的建议快照 | 直接执行该建议（一次性消费语义） |
| F9 自动执行 | refine 澄清 / 显式意图 / 指代确认 三选一 | 建议自动执行 |

建议降级展示时追加「回复"执行这个"即可自动执行」提示，引导用户跳出循环。

### Q.3 客户端兜底增强（cli/suggestion-fallback.ts + App.tsx）

- 兜底正则支持单/双引号中文参数完整捕获（`--goal '从本机 46 导出...'` 不再截断）；
- `AUTO_EXECUTABLE_EAG_COMMANDS` 白名单（仅 `eag-autonomous`，保守收录）+ 纯文本注入通道（与用户手输同路径，一次性守卫防循环）。

### Q.4 F10 任务中指令分发加固（cli/prompt-dispatch.ts）

任务执行中（busy 状态）新指令的四路分发：

| 分流 | 判定 | 动作 |
|------|------|------|
| 控制类命令 | 13 个白名单命令（exit/new/resume/undo/mcp/rules/team/inject/bg/tasks/fg/cancel/pause） | 立即执行，不占 LLM 回合 |
| 紧急干预 | 三级匹配：强停止类子句起始锚定（中英，`别(?!人)` 排除复合词）／纠正重试类开头锚定（"错了/修改/重新..."）／紧急优先类显式词（urgent/立即/优先） | 插队头 + `interruptActiveSession()` 立即打断 |
| 普通指令 | 兜底 | `PendingPromptQueue` 排队（条目绑定会话 ID、容量上限 32、FIFO），回合结束自动连续发送 |

配套语义修复：切换会话 / 回欢迎页丢弃旧会话排队消息；ESC 中断清空队列并提示丢弃条数；LLM 回合出错保留排队消息停止连锁发送（状态栏提示）；队满拒绝入队。

### Q.5 测试基线

| 模块 | 测试数 | 说明 |
|------|--------|------|
| prompt-dispatch | 13 用例 | 白名单 / 三级匹配（含误伤反例）/ 队列（FIFO、插队、容量、跨会话、丢弃） |
| session F9-v2 | 13 用例 | 意图前缀 / 指代确认 / 否定保护 / 一次性消费 |
| suggestion-fallback | 24 用例 | 含引号中文参数捕获与 EAG 白名单 |
| loading-text | 12 用例 | formatTokens 紧凑格式透传修复（存量 3 失败清零） |

### Q.6 F9-v2 自主循环空转修复：补全 EAG-P5 LLM 任务执行链路

> 代码实现：`packages/core/src/eag/p5/`（新增执行器端口与 `LlmTaskExecutor`、plan/dev/fix/verify 四阶段处理器与编排器改造）、`packages/core/src/session.ts`（构造期装配绑定）
> 日期：2026-09-15（方案 A v2）

**问题**：Q.2 的确定性通道打通后，`/eag-autonomous --goal '...'` 已能真实启动自主循环，但循环 **1 轮、0 次 LLM 调用即报 completed**——编排器空转。根因是执行链路最后一公里未接线：`AutonomousOrchestrator` 的 dev/fix 阶段 fail-closed 等待一个由 `bindTaskExecutor()` 注入的任务执行器，而该执行器从未被构造与绑定，执行器槽恒为 `null`，于是"执行任务"被静默跳过、任务被当作已完成。

**修复**（新增能力，非仅补空指针）：

| 环节 | 实现 |
|------|------|
| 执行端口 | `handlers/task-executor-port.ts`：`P5TaskExecutor` 接口 + 输入/结果契约（tokensUsed、llmRequests、changedFiles、失败原因），dev 与 fix 共用 |
| 真实执行器 | `executors/llm-task-executor.ts`：精简 LLM↔工具循环，工具调用走真实 `ToolExecutor`（read/write/edit/UpdatePlan），文件与 git 状态全真实；无凭据首轮 fail-closed 零请求 failed |
| plan 阶段 | objective 无任务文件时合成任务卡并**原子落盘**（`common/atomic-file.ts`），后续迭代真实读取 |
| dev 阶段 | 护栏判定通过后调用执行器真实编码，失败原因透传上游；未绑定执行器显式 failed 而非静默跳过 |
| fix 阶段 | 携带上一轮验证失败反馈（失败分类 / 退出码 / 输出摘要 / 修复方向）再次执行 |
| verify 阶段 | 合成任务且项目无测试目标时诚实 skip（milestone 标记 `unverified`），不伪造通过 |
| 编排器 | 任务轮全绿后在任务文件真实标记 completed；blocked / 无任务卡等终局裁定补齐失败阶段字段使报告渲染阻塞原因；最终报告新增「执行器 LLM 请求数」 |
| 装配 | `session.ts` 构造尾部鸭子检测 `bindTaskExecutor`：存在则构造 `LlmTaskExecutor`（复用 SessionManager 私有的 `createLLMClient()` 与注入的 `getResolvedSettings()`，尊重 CLI 模型覆写）并注入；F9-v2 recording/stub orchestrator 无此方法自然跳过，行为零变化 |

**测试期间连带暴露并修复的 3 处真实缺陷**（均由真实实现用例发现，非静态审查）：

1. `git status --porcelain` 默认把未跟踪目录折叠为 `?? src/`，导致 LLM 新建文件的改动产出检出失真 → 统一加 `--untracked-files=all`；
2. blocked 终局裁定未设置失败阶段，最终报告丢失被阻塞任务 ID → 补齐阶段字段；
3. 验证证据摘要用 `stdout || stderr`，而 npm 命令头在 stdout（永非空）、断言失败详情在 stderr，导致修复轮拿不到失败根因 → 改为非空者合并后截断。

**测试基线**：新增 36 用例（执行器 8 + 编排语义与装配 26 + 端到端集成 2，集成用例含"真实错误实现 → npm 真失败 → 带 stderr 反馈修正 → 全绿"完整闭环）；`eag-p5-*` 全套 **358/358 绿**，`tsc --noEmit` 零错误。桩仅实现 LLMClient 的 HTTP 响应，工具、文件、git、npm、状态机、护栏、编排器、SessionManager 全真实。

**已知遗留**：`cancellation`（abort 竞态 ×2）、DeepSeek 模型清单断言、`isRetryableLlmError`、skills 禁用枚举、多模态能力等 6 项为干净 HEAD 上即存在的失败（经 `git worktree` 对照证实，与本次改动无关），属独立议题。
