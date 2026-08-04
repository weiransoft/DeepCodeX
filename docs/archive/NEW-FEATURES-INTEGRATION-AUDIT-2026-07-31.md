# 新特性集成审查报告与修复设计（2026-07-31）

> 审查基准：`docs/new-features.md`（A–P 全部特性域）
> 审查对象：`packages/core` + `packages/cli` 当前工作树
> 审查方式：多角色团队（架构师 / 产品经理 / 测试专家 / 独立开发者）逐域对照代码证据检视
> 文档约定：所有结论均附代码证据（文件 + 行号），禁止凭印象下结论

---

## 1. 审查范围与方法

逐域核对 new-features.md 中声明的每个特性在代码中的**实现存在性**与**生产集成完整性**：

- **实现存在性**：引擎/模块/命令处理器是否真实实现（非 mock/占位）
- **生产集成完整性**：CLI 生产装配路径（`App.tsx` → `SessionManager`）是否真正接线，用户是否真实可用
- 区分「引擎实现完成」与「生产可用」两个层次——仅测试可达不算生产可用

## 2. 特性实现矩阵（逐域结论）

| 域 | 特性 | 实现 | 生产集成 | 证据 |
|----|------|------|---------|------|
| A | Team 多角色协作（5 角色 + 30 领域专家 + 8 阶段） | ✅ | ✅ | `slash-commands.ts` L146-189 注册 6 命令；`domain-experts/*.ts` 30 专家 `enabledByDefault`；`team-cmd.ts` consensus/full-lifecycle |
| B | Autonomous 自主编排（/eag-autonomous 三命令） | ✅ 引擎完整 | ❌ **未接线** | `session.ts` L532/777 声明 `autonomousOrchestrator` 可选注入；**全仓仅测试注入（`eag-p5-*.test.ts`），`App.tsx` L403 主 SessionManager 未注入** |
| C | EAG 企业级应用生成（6 基础命令 + P5 + CodeMap + 范式锁定） | ✅ | ✅ | `session.ts` L1880+ `EagCommandParser` 统一分发；命令经裸文本前缀识别路由 |
| D | Loop-Graph 融合（/eag-graph） | ✅ 引擎完整 | ❌ **未接线** | `session.ts` L548/784 声明 `graphLoopOrchestratorOptions`；**全仓无生产注入；且无生产级 `LoopHandoffAdapter` 实现（仅测试 fixture）** |
| E | V2 上下文记忆与 Diff/Approval | ✅ | ✅ | `App.tsx` L348-349 `createDualLayerContextHook` 注入 `contextHook` |
| F | 动态中断与后台任务（ADR-DI-001，7 命令） | ✅ | ✅ | `slash-commands.ts` L226-276 注册；`App.tsx` L353-415 装配 InterruptQueue/TaskRegistry/BackgroundTaskRunner |
| G | AskUserQuestion 自动衔接 | ✅ | ✅ | core/CLI 双层白名单同构（`ask-user-question-handler.ts` L52-66 / `ask-user-question.ts` L129-143） |
| H | Builtin Skills（4 bundled + 3 默认 + 4 文档 + 可视化） | ✅ | ✅ | `templates/skills/bundled/` 20 技能（含 docx/pdf/pptx/xlsx 真实脚本）；`templates/skills/*.md` 3 默认技能注入 prompt（`prompt.test.ts` L121-123）；`visualization/renderer.ts` + `widget-tool.ts` 存在 |
| I | 日志与可观测性（轮转 10MB×3 / 错误类型 / 中断日志） | ✅ | ✅ | `common/log-rotation.ts` 实现 stat+rename 轮转，三 logger 共用 |
| J | 多模型 Provider（Anthropic/OpenAI/Qwen3 + reasoning 提取） | ✅ | ✅ | 此前会话已验证 |
| K | Plan Mode | ✅ | ✅ | `App.tsx` L312 planMode 状态；`prompt.ts` L249 `getPlanModePrompt`；完成后自动退出（L939） |
| L | 新增斜杠命令汇总 | 部分 | ⚠️ | `/team consensus` ✅（`team-cmd.ts` L305+）；**4 个 EAG 命令未注册 `BUILTIN_SLASH_COMMANDS`** |
| M | 配置文件一览 | ✅ | ✅ | `team/autonomous/config-loader.ts` `loadAutonomousConfig` 双层加载 |
| N | 测试基线 | ✅ | — | P5 E2E 52 用例等测试文件存在 |

## 3. 确认差距清单（共识后）

### GAP-1（P0，域 B）：/eag-autonomous 三命令生产不可用

- **现象**：`AutonomousOrchestrator` 引擎、三命令 Handler、52 个 E2E 用例全部就绪，但 CLI 主 `SessionManager`（`App.tsx` L403）从未注入 `autonomousOrchestrator`。
- **后果**：用户在真实 CLI 输入 `/eag-autonomous` → `session.ts` L3813 fail-closed 报「AutonomousOrchestrator 未注入」。new-features.md §B.3「三命令完整链路」对用户不成立。
- **根因（架构师）**：`@vegamo/deepcode-core` 的 `package.json` exports 仅暴露根入口，而根 `index.ts` **未 re-export P5 装配所需的任何符号**（`createAutonomousOrchestrator` / `P5RunStateStore` / `P5NotesMemory` / `P5SmartConfirmation` / `createDefaultBlockerGuardChain` / `createP5LoopExecutorFromHandlers` / 4 个 P5 StageHandler），CLI 物理上无法装配。这些符号在 `eag/p5/index.ts` 均已导出，缺的只是根 re-export。

### GAP-2（P0，域 D）：/eag-graph 生产不可用

- **现象**：`graphLoopOrchestratorOptions` 同样从未注入；且图引擎 loop 节点必需的 `LoopHandoffAdapter` 协议（`graph-loop-protocols.ts` L140）**全仓无生产实现**，仅测试 fixture（`eag-graph-node-executor.test.ts` L188 固定行为适配器）。
- **后果**：`/eag-graph` → `session.ts` L4314 fail-closed。即使注入 options，loop 节点也无真实执行回调。
- **缓解因素**：图装配其余组件均有生产实现——`NodeExecutorImpl` / `EdgeResolverImpl` / `GraphSchedulerImpl` / `GraphGuardImpl` / `createPredicateRegistry` / `GoalDispatcher`（`team/plugins/goal-dispatcher.ts` L320）均已从根 `index.ts` 导出（L1005-1024）。

### GAP-3（P1，域 L）：4 个 EAG 命令未注册 CLI 命令表

- **现象**：`/eag-autonomous` `/eag-autonomous-status` `/eag-autonomous-stop` `/eag-graph` 不在 `BUILTIN_SLASH_COMMANDS`，CLI 源码中零引用（grep 无匹配）。
- **后果**：无 Tab 补全、`/help` 不展示、`parseSlashCommandKind`（`App.tsx` L2066）查不到 → 无法经 suggestedCommand 等路径自动衔接。命令执行本身依赖裸文本透传至 `session.ts` 前缀解析（C 域 6 命令同款历史模式），功能可达但可发现性缺失。
- **共识**：与 GAP-1/2 修复同批处理——注册命令表 + 接线编排器后，命令才真正「可用且可见」。

### 次要发现（记录，不本轮修复）

- S-1：`ask-user-question` 白名单含 `eag-build` 等 5 个前瞻命令名，但未含 `eag-autonomous-status`（只读查询）。**安全共识（架构师 + 产品经理）**：无人值守启动/熔断命令不应被 LLM 自动触发，维持拒绝；`eag-autonomous-status` 只读可放行——列入后续小改，不与本轮 P0 耦合。
- S-2：后台任务 SessionManager（`App.tsx` L371）同样不注入编排器——与主实例同批修复即可覆盖。

## 4. 多角色辩论与共识

**产品经理**：B/D 两域是 new-features.md 的旗舰特性（§B.3 三命令链路、§D.2 命令用法写入用户文档），生产不可用 = 文档失实，必须 P0 修复。

**架构师**：修复必须遵守既有架构约束——
1. `session.ts` 的可选注入 + fail-closed 设计是有意的向后兼容契约（L520/L536 注释明确），**禁止**改为强制依赖或默认构造（避免每次命令重复构造，L3767）；
2. 依赖方向 `eag/graph/ → eag/p5/` 仅类型导入，CLI 装配层（`packages/cli`）是天然的最外层装配点，符合分层；
3. `LoopHandoffAdapter` 的生产实现必须做**真实事**：executor 委托 `GoalDispatcher`（复用 team 插件体系），evaluator 真实执行节点测试命令（child_process），禁止返回固定 passed。

**测试专家**：修复验收必须包含——根导出符号可用性、CLI 装配模块单测（真实构造编排器全链路）、既有 P5/graph 测试零回归、typecheck 通过。

**独立开发者**：遵循 Karpathy Simplicity First——装配模块只做「构造 + 注入」，不新增抽象层；日志回调复用现有 debug log 通道。

**共识结论**：三个 GAP 同批修复，方案如下（FIX-1/2/3）。

## 5. 修复方案设计

### FIX-1（GAP-1）：打通 P5 装配链路

1. **根导出补齐**（`packages/core/src/index.ts`）：re-export P5 装配最小符号集——
   值：`createAutonomousOrchestrator` `createP5LoopExecutorFromHandlers` `P5PlanStageHandler` `P5DevStageHandler` `P5VerifyStageHandler` `P5FixStageHandler` `P5RunStateStore` `P5NotesMemory` `P5SmartConfirmation` `createDefaultBlockerGuardChain`
   类型：`AutonomousOrchestrator`（类值导出）`AutonomousOrchestratorOptions`
2. **CLI 装配模块**（新建 `packages/cli/src/ui/core/eag-orchestrator-assembly.ts`）：
   - `buildAutonomousOrchestrator(logger?)`：按 §B 默认配置真实构造（4 默认 StageHandler + 默认护栏链 + 三态确认器）
   - 失败安全：任一组件构造异常 → 返回 `undefined` 并记录日志（维持 session.ts 未注入降级契约，CLI 不崩溃）
3. **注入**：`App.tsx` 主 SessionManager 与后台 bgManager 均注入 `autonomousOrchestrator`。

### FIX-2（GAP-2）：打通图编排装配链路

1. **CLI 生产级 LoopHandoffAdapter**（同装配模块内 `CliLoopHandoffAdapter implements LoopHandoffAdapter`）：
   - `createLoopExecutor`：返回真实回调——将 loop 节点任务经 `GoalDispatcher` 派发执行，feedback（上轮修复建议）拼入任务输入；返回含 `success`/`output` 等约定字段的 `GeneratorResult`
   - `createLoopEvaluator`：返回真实回调——节点配置了测试命令时在 `projectRoot` 经 `child_process` 真实执行，exit code 0 → `passed=true`；非零 → `passed=false` + stderr 尾部入 `findings` + severity `blocker`；未配置测试命令时执行输入契约非空校验（`success===true` 且 output 非空），不永远 passed
   - 执行超时保护（默认 600s，对齐 P5 默认 testTimeoutSec）
2. `buildGraphLoopOrchestratorOptions(projectRoot, logger?)`：装配 `NodeExecutorImpl`（GoalDispatcher + CliLoopHandoffAdapter）+ `EdgeResolverImpl` + `GraphSchedulerImpl`（`createRetrySuppressionConfig` 保守静态值）+ `GraphGuardImpl` + `createPredicateRegistry` + `projectRoot`；失败安全同上。
3. 注入主/后台 SessionManager 的 `graphLoopOrchestratorOptions`。

### FIX-3（GAP-3）：注册 4 个 EAG 命令

1. `slash-commands.ts`：`SlashCommandKind` 增加 `"eag-autonomous" | "eag-autonomous-status" | "eag-autonomous-stop" | "eag-graph"`，`BUILTIN_SLASH_COMMANDS` 增加 4 条（含 args/description）。
2. `App.tsx` `parseSlashCommandKind`：4 个 kind 原样映射（`PromptSubmission.command` 联合类型需同步扩展），使命令选择路径与裸文本路径行为一致。
3. 命令执行仍走 `session.ts` 既有 `EagCommandParser` 分发（不重复实现）。

## 6. 验收标准

- A1：`node -e` 验证根包可导入全部新增导出符号
- A2：CLI 装配模块单测——真实构造 `AutonomousOrchestrator` 与 `GraphLoopOrchestratorOptions` 成功；组件构造异常时降级返回 undefined
- A3：`CliLoopHandoffAdapter` 单测——evaluator 真实执行 shell 命令（exit 0/非 0 两路径），executor 经 GoalDispatcher 真实派发
- A4：`/help` 输出含 4 个 EAG 命令；`filterSlashCommands("/eag")` 命中 4 条
- A5：`packages/core` + `packages/cli` typecheck 通过；既有 P5/graph/session 测试零回归
- A6：文档（本文件 §2 矩阵）对照代码逐项复核，B/D/L 三域状态翻转为 ✅
