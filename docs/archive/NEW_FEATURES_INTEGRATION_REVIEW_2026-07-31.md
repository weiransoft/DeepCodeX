# DeepCodeX new-features.md 集成审查报告

> 审查日期：2026-07-31  
> 审查目标：[docs/new-features.md](../new-features.md) 全部特性在 `/Users/wangwei/Documents/VG/DeepCodeX-cli` 的实现与集成情况  
> 审查方法：多角色团队代码走读 + TypeScript 编译 + 单元/集成测试 + CLI 端到端装配冒烟 + 阶段 8 文档对照代码审查  

## 审查结论

| 维度 | 结果 | 说明 |
|------|------|------|
| D1 功能完成度 | 通过 | 文档列出的 13 个能力域（A-M）均能在代码中找到对应实现；本次修复补齐了 CLI 生产路径缺失的 `/eag-autonomous`、`/eag-autonomous-status`、`/eag-autonomous-stop`、`/eag-graph` 命令入口 |
| D2 集成完整性 | 通过 | 命令注册 → PromptInput 补全 → SessionManager 分发 → 编排器装配 → core 导出 形成完整链路；失败安全降级路径存在 |
| D3 测试正确性 | 通过 | 4 个 workspace typecheck 全绿；CLI 573 用例通过 569（4 跳过，0 失败）；新增安全测试 6/6 通过；core team/providers 套件全绿；主套件 5471/5488 通过（0 失败）；v2 套件 659/659 通过 |
| D4 验收标准满足 | 通过 | `/eag-autonomous` 三命令与 `/eag-graph` 已在真实 CLI `--help` 输出中可见；编排器装配冒烟测试通过；V2 hook 调用顺序已修复；flaky 测试已稳定化；未注入时命令 fail-closed |
| D5 TODO/FIXME 清零 | 通过 | 本次新增/修改代码中无 TODO/FIXME/XXX 注释残留 |
| D6 文档意图遵从 | 通过 | 命令签名、能力描述、集成方式与 [docs/new-features.md](../new-features.md) 一致；V2 上下文刷新位置与 §9.1 调用契约一致 |

**阶段 8 审查判定：通过。**  
当前已无与本次改动相关的失败用例；剩余 17 个跳过用例为预有条件跳过。

---

## 一、本次审查发现的缺口与修复

### GAP-1：CLI 未注册 4 个 EAG 命令

- **位置**：`packages/cli/src/ui/core/slash-commands.ts`
- **问题**：`SlashCommandKind` 与 `BUILTIN_SLASH_COMMANDS` 缺少 `/eag-autonomous`、`/eag-autonomous-status`、`/eag-autonomous-stop`、`/eag-graph`
- **修复**：新增类型与注册条目；命令说明、参数、分组与 new-features.md L 章一致
- **验证**：`slash-commands.test.ts` 与 `memory-wiring.test.ts` 已同步更新断言；CLI `--help` 已可见全部命令

### GAP-2：CLI 未注入 EAG 编排器

- **位置**：`packages/cli/src/ui/views/App.tsx`
- **问题**：`SessionManager` 构造时 `autonomousOrchestrator` 与 `graphLoopOrchestratorOptions` 为 `undefined`，导致 `/eag-*` 命令触发 fail-closed
- **修复**：
  - 新建 `packages/cli/src/ui/core/eag-orchestrator-assembly.ts`
  - `buildAutonomousOrchestrator()` 真实构造 `EagP5.createAutonomousOrchestrator`
  - `buildGraphLoopOrchestratorOptions()` 真实构造 `NodeExecutorImpl / EdgeResolverImpl / GraphSchedulerImpl / GraphGuardImpl / PredicateRegistry`，并注册全部 6 个生产插件
  - `App.tsx` 装配并注入到 `SessionManager`
- **失败安全**：任一组件构造异常返回 `undefined`，`session.ts` 维持 fail-closed 降级

### GAP-3：core 未导出编排器类型/类

- **位置**：`packages/core/src/index.ts`
- **问题**：CLI 编译失败，因为 `AutonomousOrchestrator`、`GraphLoopOrchestratorOptions`、`GoalDispatcher`、`PluginRegistry` 等未从 `@vegamo/deepcode-core` 导出
- **修复**：在 `core/src/index.ts` 补充必要 re-export；type-only import 避免运行时开销

### GAP-4：V2 上下文钩子未覆盖新会话

- **位置**：`packages/core/src/session.ts`
- **问题**：`handleUserPrompt` 仅在 `this.activeSessionId` 存在时才调用 `refreshContextAsync`，而创建新会话时 `activeSessionId` 为 `null`，导致 `preBuildContext` 在首条 system message 中无法命中缓存；T1/T2/T4 测试失败
- **修复**：
  - 保留 `activeSessionId` 存在时的 turn 入口刷新（覆盖 `replySession` 场景）
  - 在 `createSession` 生成 `sessionId` 后、`buildSystemMessage` 之前补充一次 `refreshContextAsync(sessionId)` 调用
  - 所有刷新点均 catch 异常并 swallow，保证零回归
- **验证**：`session-v2-context-hook.test.ts` 4/4 通过；主套件 V2 hook 相关失败清零

### GAP-5：EAG Graph fan-out 性能基准 flaky

- **位置**：`packages/core/src/tests/eag-graph-perf-benchmark.test.ts`
- **问题**：P2 测试单次测量并行/串行延迟比，并发套件下因事件循环噪音导致比率失真（曾出现 123%），主套件失败
- **修复**：改为采样 3 次取中位数；预热与正式执行分离；保留 60% CI 宽松上限
- **验证**：单独运行 10/10 通过；完整主套件 0 失败

### GAP-6：CodeMapFileWatcher 测试并发 flaky

- **位置**：`packages/core/src/v2/tests/codemap/file-watcher.test.ts`
- **问题**：FW-01/FW-06 使用固定 `waitForDebounce`，并发负载下 fs.watch 事件可能延迟到达，导致断言失败
- **修复**：新增 `waitForEvents` 轮询辅助函数；对 FW-01/FW-06 改为轮询等待目标事件，最大 2 秒容错窗口
- **验证**：完整 v2 套件 659/659 通过

---

## 二、文档对照检查项（按能力域）

| 能力域 | 文档要求 | 实现位置 | 检查结果 |
|--------|---------|---------|---------|
| A. 多角色协作 | `/team` 子命令、5 核心角色、30 领域专家 | `packages/core/src/team/`、`packages/cli/src/team/team-cmd.ts` | 已注册 |
| B. 自主编排 | Ralph 4 阶段循环、BLOCKER 护栏 | `packages/core/src/eag/p5/` | 完整 |
| C. EAG 企业级应用生成 | `/eag-autonomous` 三命令、RunState、NotesMemory | `packages/core/src/eag/p5/`、`packages/core/src/session.ts` | 之前引擎完整但 CLI 入口未接线，已修复 |
| D. Loop-Graph 融合 | `/eag-graph`、DAG 节点、PredicateRegistry | `packages/core/src/eag/graph/` | 之前引擎完整但 CLI 入口未接线，已修复 |
| E. V2 上下文记忆 | DualLayerContextHook、refreshContextAsync | `packages/core/src/v2/integration/session-hook.ts`、session.ts | 已修复：新会话与回复会话均能在 buildSystemMessage 前完成上下文刷新 |
| F. 动态中断与后台任务 | `/inject`、`/bg`、`/tasks` 等 | `packages/core/src/interrupts/`、CLI slash-commands | 已注册并注入 |
| G. AskUserQuestion 自动衔接 | `suggestedCommand`、三层白名单 | `packages/core/src/tools/ask-user-question-handler.ts` | 实现存在 |
| H. Builtin Skills 增强 | docx/pdf/pptx/xlsx、widget、renderer | `packages/core/src/visualization/`、bundled skills | 实现存在 |
| I. 日志与可观测性 | 10MB + 3 备份轮转、error 类型保留、interrupt 日志 | `packages/core/src/common/log-rotation.ts`、`interrupt-logger.ts` | 实现存在 |
| J. 多模型 Provider | Anthropic/OpenAI/Qwen3、`reasoning` 独立提取 | `packages/core/src/providers/` | 实现存在 |
| K. Plan Mode | `/plan` 命令 | `SlashCommandKind`、session.ts | 已注册 |
| L. 新增斜杠命令 | 见 new-features.md L 章清单 | `packages/cli/src/ui/core/slash-commands.ts` | 已补齐 4 个 EAG 命令 |
| M. 配置文件 | `.deepcode/settings.json`、`.deepcodex/autonomous.yml` 等 | settings、EAG CLI parser | 实现存在 |

---

## 三、测试验证结果

### 1. TypeScript 编译

```text
npm run typecheck
# 4 个 workspace 全部通过
```

### 2. 测试套件

| 套件 | 用例数 | 通过 | 失败 | 跳过 | 备注 |
|------|-------|------|------|------|------|
| `packages/cli` | 573 | 569 | 0 | 4 | 全绿 |
| `packages/core/src/tests` | 5488 | 5471 | 0 | 17 | 全绿（P2 已改为 3 次采样取中位数） |
| `packages/core/src/team/tests` | 926 | 926 | 0 | 0 | 全绿 |
| `packages/core/src/providers/tests` | 9 | 9 | 0 | 0 | 全绿 |
| `packages/core/src/v2/tests` | 659 | 659 | 0 | 0 | 全绿（FW-01/FW-06 已改为轮询等待） |
| `session-v2-context-hook.test.ts` | 4 | 4 | 0 | 0 | 修复后全绿 |
| `session-skill-matching-safety.test.ts`（新增） | 6 | 6 | 0 | 0 | 全绿 |

### 3. CLI 端到端装配冒烟

```text
autonomousOrchestrator: ASSEMBLED
graphLoopOrchestratorOptions: ASSEMBLED
  nodeExecutor: NodeExecutorImpl | edgeResolver: EdgeResolverImpl | scheduler: GraphSchedulerImpl
  guard: GraphGuardImpl | predicates: OK
```

### 4. CLI `--help` 命令清单验证

输出包含：

- `/eag-autonomous`
- `/eag-autonomous-status`
- `/eag-autonomous-stop`
- `/eag-graph`

---

## 四、环境修复记录（与代码改动无关，但影响测试结果）

1. **sharp 版本不匹配**  
   `node_modules/sharp` 为 0.35.3，但 `@img/sharp-darwin-arm64` 为 0.33.5、`@img/sharp-libvips-darwin-arm64` 为 1.0.4，导致 `sharp.format()` 初始化抛错。已手工对齐到 lockfile 声明版本（0.35.3 / 1.3.2），并补装缺失的 `@img/colour@1.1.0`。

2. **gray-matter 嵌套 js-yaml 版本错误**  
   `gray-matter` 依赖 `js-yaml@^3.13.1`，但嵌套目录被错误安装为 4.1.1（4.x 移除了 `safeLoad`），导致 frontmatter 解析失败、skill description 为空。已还原为 lockfile 声明的 3.14.2。

---

## 五、变更文件清单

### 修改文件

1. `packages/cli/src/ui/core/slash-commands.ts`
2. `packages/cli/src/ui/views/App.tsx`
3. `packages/cli/src/ui/views/PromptInput.tsx`
4. `packages/core/src/index.ts`
5. `packages/core/src/session.ts`
6. `packages/cli/src/tests/slash-commands.test.ts`
7. `packages/cli/src/tests/memory-wiring.test.ts`
8. `packages/core/src/tests/eag-graph-perf-benchmark.test.ts`
9. `packages/core/src/v2/tests/codemap/file-watcher.test.ts`

### 新增文件

1. `packages/cli/src/ui/core/eag-orchestrator-assembly.ts`
2. `packages/core/src/tests/session-skill-matching-safety.test.ts`

---

## 六、建议后续动作

1. 提交本次改动（含新增文件与测试断言更新）。
2. 在 CI 中固定 `sharp` 与 `js-yaml` 依赖版本校验，避免 node_modules 与 lockfile 漂移。
3. 继续按能力域 A-M 逐项进行性能与安全深度审查（如多 Provider 路由、权限边界、MCP 工具注入等）。
