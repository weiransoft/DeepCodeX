# 多角色团队审查共识报告（2026-07-29）

> **审查对象**：[docs/new-features.md](new-features.md) A-J 全部新特性 vs 代码实现
> **审查方式**：6 角色并行审查（架构师/安全专家/产品经理/独立开发者/测试专家/UI-UX 设计师）+ 主持人交叉复核
> **证据标准**：所有结论基于真实代码行与真实命令运行输出；每条标注置信度
> **日期**：2026-07-29
> **状态**：✅ 共识达成，进入修复阶段

---

## 一、审查方法与辩论裁决

### 1.1 六角色分工

| 角色 | 审查范围 | 报告质量 |
|------|---------|---------|
| 架构师 | A 多角色协作 / D Loop-Graph / E V2 上下文架构集成 | ⚠️ 多为推断，4 项 CRITICAL 经复核全部驳回 |
| 安全专家 | B 护栏 / D 谓词 RCE / F 中断 / G 白名单 / 日志脱敏 | ⚠️ 部分可靠，密钥脱敏发现成立 |
| 产品经理 | A-J 全部特性完成度逐项核对 | ⚠️ 证据链无效（全部指向同一行号），多项"部分实现"复核后确认为已实现 |
| 独立开发者 | team-adapter / loop-controller / interrupts 代码质量 | ✅ 发现 1 项真实 bug，1 项误报 |
| 测试专家 | 测试覆盖矩阵 + 真实运行全部套件 | ✅ 全部基于真实运行输出，质量最高 |
| UI-UX 设计师 | TUI / 帮助文本 / 错误提示 / 命令 discoverability | ✅ 基于真实构建与命令运行，质量高 |

### 1.2 辩论裁决记录

**裁决 1：架构师 4 项 CRITICAL 全部驳回（误报）**

| 指控 | 复核证据 | 裁决 |
|------|---------|------|
| 节点内 Loop 缺失 | [graph-loop-orchestrator.ts](../packages/core/src/eag/graph/graph-loop-orchestrator.ts) L495-497 累加 `loopReport`；[node-loop-kernel.ts](../packages/core/src/eag/graph/node-loop-kernel.ts) 真实存在并有测试覆盖 | ❌ 驳回 |
| 谓词 RCE 未消除 | [predicate-registry.ts](../packages/core/src/eag/graph/predicate-registry.ts) 全文件无 `eval`/`new Function`；谓词为注册函数引用 | ❌ 驳回 |
| 图级护栏未实现 | [graph-loop-protocols.ts](../packages/core/src/eag/graph/graph-loop-protocols.ts) L170-172/L205-207 明确实现图级超时/token 预算/深度上限；orchestrator L342/L462 执行前后护栏拦截 | ❌ 驳回 |
| 三层配置合并未找到 | [graph-builder.ts](../packages/core/src/eag/graph/graph-builder.ts) L248/L327 `Object.freeze({...DEFAULT_WORK_GRAPH_CONFIG, ...data.config})` 实现 DEFAULT<JSON 合并，CLI 参数由命令入口覆盖 | ❌ 驳回 |

**裁决 2：独立开发者 interrupt-queue `isMutating` 锁死指控驳回**
[interrupt-queue.ts](../packages/core/src/interrupts/interrupt-queue.ts) L113-145 使用 `try { ... } finally { this.isMutating = false; }`，finally 保证恢复。误报。

**裁决 3：`--consensus` 死参数 —— 实现而非移除**
- 测试专家立场：`--consensus` 在 cli-args.ts L194 定义、App.tsx L1954 赋值、team-cmd.ts L94 声明、L925 帮助声称"启用 5 角色联合评审"，但全库 grep **无任何消费点**；TA-06 E2E 仅断言 exitCode=0 恒真通过 → 伪覆盖。
- 辩论：Karpathy YAGNI 建议移除；但 new-features.md A 域明确声称"共识评审"，user rules 禁止逃避式删除。
- **共识：实现真实共识评审**。dispatch 时 `consensus=true` 并行派发 5 核心角色评审同一任务，聚合评审意见输出。复用现有 `executeDispatch` 机制。

**裁决 4：`/memory` 死命令 —— 实现而非移除**
- UX 立场：[slash-commands.ts](../packages/cli/src/ui/core/slash-commands.ts) L182-188 注册 `/memory`（list/delete/review/export），但 PromptInput.tsx `handleSlashSelection` 与 App.tsx `handlePrompt` 均无处理分支 → 用户选择后静默无响应。
- 实现基础：V2 已有 [privacy-manager.ts](../packages/core/src/v2/memory/privacy-manager.ts)（export/deleteAll）与 memory-store，接线成本低。
- **共识：实现 list/review/delete/export 四子命令**，接线到 V2 记忆体系。

**裁决 5：PM 报告的"部分实现"大面积不成立**
PM 报告所有条目证据均指向 team-cmd.ts 同一行号区间，证据链无效。抽查复核：30 领域专家（`EXPECTED_TOTAL_EXPERTS = 30` + 8 文件懒加载 + 定义测试验证）、V2 双层上下文（38 个测试文件 655 用例支撑）均**已真实实现**。

---

## 二、共识问题清单（按优先级）

### P0 — 真实 bug 与测试门禁（3 项，全部 [已验证]）

| # | 问题 | 证据 | 修复方案 |
|---|------|------|---------|
| FIX-01 | `BackgroundTask.fromSnapshot` 漏恢复 `_startedAt`，崩溃恢复后 startedAt 被重置为恢复时刻；测试 TC-BT-009 红灯已复现（差 1ms） | [background-task.ts](../packages/core/src/interrupts/background-task.ts) L774-781：恢复 `_state/_updatedAt/_completedAt/_result/_error/_stats` 但无 `_startedAt` | 补 `task._startedAt = snapshot.startedAt;`，确认字段声明；TC-BT-009 自动转绿 |
| FIX-02 | V2 测试套件（38 文件/655 用例）是孤儿：`npm test` 与 CI 均不执行，E 域零门禁；且 core test 脚本 `A && B && C` 短路，core 失败时 team/providers 不执行 | [core/package.json](../packages/core/package.json) L28 | test 脚本接入 `src/v2/tests/run-v2-tests.mjs`；改容错执行（各套件独立跑，汇总退出码） |
| FIX-03 | 三个 `run-tests.mjs` 不透传 CLI 参数（`--test-reporter` 等被静默忽略） | `spawnSync(process.execPath, ["--import","tsx","--test",...testFiles])` 无 `process.argv.slice(2)` | runner 追加透传 |

### P1 — 文档声称但代码未实现（5 项）

| # | 问题 | 证据 | 修复方案 |
|---|------|------|---------|
| FIX-04 | `--consensus` 死参数：声明/解析/帮助齐全但无消费点；TA-06 恒真断言伪覆盖 | cli-args.ts L194 / App.tsx L1954 / team-cmd.ts L94,L925 | dispatch 分支：`consensus=true` 时并行派发 5 核心角色评审任务，聚合评审意见（共识点/分歧点/最终建议）输出；TA-06 改断言共识产物结构 |
| FIX-05 | `/memory` 死命令：菜单注册但无处理分支，用户选择后静默无响应 | slash-commands.ts L182-188；PromptInput.tsx 无 `memory` 分支；App.tsx 无 `memory` 分支 | 实现 `/memory list/review/delete/export` 四子命令，接线 V2 PrivacyManager/memory-store（`~/.deepcode/memory/`） |
| FIX-06 | `--help` EPILOG 硬编码 15 命令，缺 11+ 已注册命令（/team、角色快捷命令、/memory、/inject、/bg、/tasks、/fg、/cancel、/pause、/rules、/quality-check、/review）；TUI 内无 `/help` 命令 | [cli-args.ts](../packages/cli/src/cli-args.ts) L85-120；slash-commands.ts `BUILTIN_SLASH_COMMANDS` 24 项无 help | EPILOG 改为从 `BUILTIN_SLASH_COMMANDS` 单一数据源生成；新增 `/help` 内置命令渲染同源清单 |
| FIX-07 | `team help` 示例二进制名错误：`deepcodex` vs 实际 `deepcode`，用户复制示例 command not found | [team-cmd.ts](../packages/cli/src/team/team-cmd.ts) L907/L939-950 vs cli-args.ts L126 `.scriptName("deepcode")` | formatTeamHelp 全部改为 `deepcode` |
| FIX-08 | debug-logger 无密钥脱敏：`params`/`request` 对象完整落盘 `~/.deepcode/logs/debug.log`，若含 apiKey/Authorization/sk-* 模式将泄露密钥 | [debug-logger.ts](../packages/core/src/common/debug-logger.ts) `toSerializable` 仅处理 bigint/Error/循环引用 | `toSerializable` walk 中增加密钥模式脱敏（api_key/apiKey/authorization/token 字段名 + sk-*/Bearer * 值模式 → `***REDACTED***`） |

### P2 — 体验与效率（6 项）

| # | 问题 | 证据 | 修复方案 |
|---|------|------|---------|
| FIX-09 | TF-007 单测 899.2s（占 CLI 套件 99.9%），且 `exitCode` 捕获后从未断言 | team-cmd-task-file.test.ts L467-478 | 断言 exitCode；为 full-lifecycle 提供测试用间隔/迭代注入参数，压缩到秒级 |
| FIX-10 | `team dispatch` 缺参报错退出码为 1（应为 2），与 quality/review 语义不一致，且无用法示例 | 实测 `team dispatch` EXIT=1；quality-cmd.ts L848-853 明确 2=参数错误 | team 参数错误统一退出码 2 + 附 `用法:` 示例 |
| FIX-11 | 错误双重前缀：`Error: ✖ 恢复任务失败：…` | [App.tsx](../packages/cli/src/ui/views/App.tsx) L1258-1261 渲染层硬编码 `Error: {errorLine}`，写入处已自带 `✖ ` | 统一约定 errorLine 不带前缀，渲染层只加一次图标 |
| FIX-12 | 后台 stdout 超 1MB 静默丢弃，无截断提示 | App.tsx L248-256 `MAX_STDOUT_BUFFER` 超限直接 return | 截断时追加 `... [输出超 1MB 已截断]` 标记行 |
| FIX-13 | README-zh_CN.md 命令表缺 /rules、/memory、/quality-check、/review 及 5 个角色快捷命令 | README L106-126 vs BUILTIN_SLASH_COMMANDS | README 命令表与注册表对齐 + 增退出码约定小节 |
| FIX-14 | `backoffSleep` 不响应外部 abort：退避期间（最长 60s）RunState.markAborted 无法立即生效 | [loop-controller.ts](../packages/core/src/team/autonomous/loop-controller.ts) L578-592 | 退避拆分为 1s 粒度循环检查 `runState.state.status`，abort 时立即返回 |

### P3 — 打磨（5 项）

| # | 问题 | 修复方案 |
|---|------|---------|
| FIX-15 | `team help` 双份输出（yargs 英文 Options + 中文自定义段落） | 抑制 yargs 默认 help 输出，仅保留中文帮助 |
| FIX-16 | 加载文案英文（"Thinking..."）+ tokens 无千分位 | 中文文案 + 千分位格式化 |
| FIX-17 | quality 报告严重度纯文本无颜色语义 | HIGH 红 / MEDIUM 黄 / LOW 灰 |
| FIX-18 | team help 无退出码说明段（review/quality 均有） | 补 0/1/2/4 语义 |
| FIX-19 | 状态栏信息单薄（仅 status/tokens/fail） | 补模型名 + token 占比显示 |

---

## 三、明确不修的项（共识）

| 项 | 理由 |
|----|------|
| PM 报告的 E/C/B 域"部分实现"指控 | 复核后确认已真实实现（V2 38 测试文件、EAG-P5 52 E2E、护栏链完整），文档与代码一致 |
| 架构师 CRITICAL 1-4 | 误报，见裁决 1 |
| interrupt-queue isMutating | 误报，见裁决 2 |
| stub-client.ts 命名争议 | 依赖注入是生产代码一等扩展点，行为确定性实现接口契约，属合法 test double；保留现状 |
| team-cmd.ts L748 "占位通过" | 文档化设计决策：用户未配置测试命令时跳过阶段 7 是真实流程控制，非 mock |

---

## 四、验收标准

1. `cd packages/core && npm test` 全绿（含 V2 套件接入），TC-BT-009 转绿
2. `cd packages/cli && npm test` 全绿且套件耗时 < 300s（TF-007 压缩后）
3. `deepcode --help` 输出与 `BUILTIN_SLASH_COMMANDS` 完全一致
4. `deepcode team help` 示例二进制名为 `deepcode`，含退出码段
5. `deepcode team dispatch --task "x" --consensus` 输出真实 5 角色评审聚合结果
6. TUI `/memory list` 返回真实记忆文件清单；`/help` 渲染命令清单
7. debug.log 中含密钥模式字段输出为 `***REDACTED***`
8. TA-06 断言共识产物结构（非恒真断言）
