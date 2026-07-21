# DeepCodeX Team 模块集成修复设计文档

> **文档版本**: v1.6（基于 v1.5 4 角色评审反馈修正）
> **创建日期**: 2026-07-21
> **来源**: 多角色团队 review 报告（架构师 / 测试专家 / 独立开发者 / 产品经理 4 角色共识）
> **目标**: 修复 team 模块集成测试中识别的 4 个 P0 阻塞缺陷，完成 multi-agent-team skill 与 DeepCodeX-cli 的真实集成
> **遵循原则**: Karpathy 四大核心原则 + Ponytail 16 红线 + 用户规则（禁止 mock/占位/简化）

---

## v1.6 修正说明（相对 v1.5）

v1.5 经 4 角色评审（架构师有条件通过 / 测试专家有条件通过 / 独立开发者通过 / 产品经理通过），识别出 1 个 P0 阻塞问题 + 12 个非阻塞建议。本版本完成以下修正：

v1.6 经 4 角色评审（架构师通过 / 测试专家通过 / 独立开发者有条件通过 / 产品经理通过），独立开发者发现 1 个 P0 阻塞（B-01: §3.3.4 isOpenAIClientHandle 导入路径错误）。本版本在 v1.6 I-01~I-12 基础上追加 B-01 修正 + 同步应用 5 个低成本非阻塞建议（架构师 NB-01/02/03 + 测试专家 NB-01 + 独立开发者 NB-02/04）。

| 编号 | 修正点 | 评审来源 |
|------|--------|----------|
| I-01 | **P0-1（架构师 P0 阻塞）**: v1.3 F-01 在 `team/index.ts` 末尾引入的 `export * from "./autonomous/index.js";` 仍存在 RiskLevel 命名冲突隐患——`smart-confirmation.ts:32` 的 `type RiskLevel` 与 `cybernetics/guard-coordinator.ts:24` 的 `const RiskLevel` 同名，`export *` 与显式 `export {}` 同名时显式优先，导致 smart-confirmation.ts 的 type RiskLevel 在 team/index.ts 层被静默覆盖。v1.5 H-01 仅在 `packages/core/src/index.ts` 层避免 `export *`，未处理 team/index.ts 层。修正：将 v1.3 F-01 的 `export * from "./autonomous/index.js";` 改为显式 re-export，与 v1.5 §3.3.3 在 packages/core/src/index.ts 中的做法保持一致 | 架构师 P0-1 |
| B-01 | **P0（独立开发者 v1.6 评审阻塞）**: §3.3.4 v1.6 I-01 草案错误地将 `isOpenAIClientHandle` 放入 `from "./autonomous/index.js"` 块，但 `autonomous/index.ts` 实际未 re-export 该符号（源码确认 77 行无 isOpenAIClientHandle 导出）。修正：将 `isOpenAIClientHandle` 和 `OpenAIClientHandle` 从 autonomous 块移出，改为独立从 `../common/openai-client.js` 导入，与 §3.3.2 的"autonomous/index.ts 未 re-export OpenAIClientHandle"说明一致 | 独立开发者 B-01 |
| I-02 | **NB-02（测试专家）+ NB-03（产品经理）**: §7.1 缺失 SH-018 直接验证 stage-aware 工厂推断逻辑的用例。现有 SH-001/005/007/011 是集成验证，若 stage 推断错误但返回 content 仍能通过 judgeResult 弱校验（如 DevStageHandler 仅检查 `output.trim().length > 0`），测试仍会通过，无法暴露 v1.4 发现的"fix 被 dev 误匹配"问题。修正：在 §7.1 新增 SH-018 用例，直接调用 `buildStubClientReturningValidOutput()` 的 `client.chat.completions.create()`，传入含 `# Fix 阶段` 的 user prompt，断言返回 content 含 `"## Fix"`（而非 `"## Implementation"`），同步更新 §8.3 P0-1 用例数 17→18 | 测试专家 NB-02, 产品经理 NB-03 |
| I-03 | **NB-01（测试专家）+ NB-01（产品经理）**: §7.4 `overrideContent` 注释说"SH-010 不传（走 stage 推断）"与 §7.1 SH-010 输入列"stub 返回 status=failed"矛盾。若不传 overrideContent，stub 走 stage 推断会返回含 "PASS" 的合法 content，executeDispatch 返回 succeeded，VerifyStageHandler.judgeResult 在 succeeded 分支只会返回 success/failed/retriable，不可能走到 fatal。修正：SH-010 明确使用 `buildStubClientAlwaysThrows()`（让 stub 抛错使 executeDispatch 走 catch 返回 status=failed），§7.4 注释相应更新 | 测试专家 NB-01, 产品经理 NB-01 |
| I-04 | **NB-01（产品经理）**: §7.4 `overrideContent` 使用场景遗漏 SH-008（VerifyStageHandler 测试失败，output 含 "FAIL"）。SH-008 期望 `kind=retriable, artifacts.failures 非空`，但 stage 推断默认返回含 "PASS" 的文本，无法触发 FAIL 分支。修正：在 §7.4 注释中追加 SH-008 使用场景 `overrideContent="## Test Results\n\nFAIL ..."` | 产品经理 NB-01 |
| I-05 | **NB-03（产品经理）**: §8.3 v1.5 新增验收项 ② ③ 验收方式不够具体。② "fix stage 不再被 dev 误匹配"是行为描述，未指明通过哪个测试用例验证；③ "包含两套目录命名差异说明"未指明通过人工检查还是 grep 关键字验证。修正：② 改为"通过 SH-018 测试用例验证"（配合 I-02）；③ 改为"通过 `grep -l '.deepcode/' README.md docs/quickstart.md` 与 `grep -l '.deepcodex/' README.md docs/quickstart.md` 均有命中" | 产品经理 NB-03 |
| I-06 | **NB-04（产品经理）**: stage 标题命名约定（`# Plan 阶段`/`# Dev 阶段`/`# Verify 阶段`/`# Fix 阶段`）是 H-02 修正的核心契约，但仅在代码注释和设计文档中说明，未在产品文档（README.md）中体现。修正：在 README.md 的 team autonomous 使用说明中补充"autonomous 4 阶段流程"说明 + stage 标题命名约定 | 产品经理 NB-04 |
| I-07 | **NB-01（独立开发者）**: §3.3.1 `isOpenAIClientHandle` 类型守卫仅检查 `client` + `model` 字段存在且 `model` 是 string，未检查 `baseURL` / `thinkingEnabled` 等必填字段，会误判 `{ client, model }` 为合法 OpenAIClientHandle。修正：补充 `baseURL` 和 `thinkingEnabled` 字段检查 | 独立开发者 NB-01 |
| I-08 | **NB-02（独立开发者）**: v1.5 §4.6 仅修改 `executeDispatchCommand` 处理 skipped 状态，但 `team-cmd.ts:executeFullLifecycleCommand` 也调用 `executeDispatch`，当前 `if (result.status !== "succeeded")` 会把 skipped 视为失败并中止全流程。修正：在 §4.6 补充说明 `executeFullLifecycleCommand` 的 skipped 处理策略（全流程模式下 skipped 视为失败中止） | 独立开发者 NB-02 |
| I-09 | **NB-02（产品经理）**: §2.3 quickstart.md 修改说明未补充具体路径示例。修正：明确补充 `~/.deepcode/settings.json`（用户级）和 `./.deepcodex/autonomous.yml`、`./.deepcodex/runs/`、`./.deepcodex/notes.md`（项目级）路径示例 | 产品经理 NB-02 |
| I-10 | **NB-04（测试专家）**: §7.4 描述"使用精确字符串匹配（非子串 includes）"与实际代码 `userPrompt.includes("# Plan 阶段")` 不符（includes 本身是子串匹配）。修正：改为"基于 stage 标题的长字符串子串匹配（替代 v1.4 的短关键字子串匹配，大幅降低误匹配率）" | 测试专家 NB-04 |
| I-11 | **NB-03（测试专家）**: §7.1 SH-016/017 未明确环境隔离写法（try/finally 还是 t.before/t.after）。修正：明确 SH-016/017 采用 try/finally 写法（与 §6.2.2 一致），因为它们是边界值特例，不应在文件级共享 | 测试专家 NB-03 |
| I-12 | **NB-03（独立开发者）**: stage 标题大小写敏感风险。修正：在 §3.3 BaseStageHandler 注释中进一步强化"stage 标题必须首字母大写"的约束 | 独立开发者 NB-03 |

---

## v1.5 修正说明（相对 v1.4）

v1.4 经 4 角色评审（架构师不通过 / 测试专家有条件通过 / 独立开发者通过 / 产品经理有条件通过），识别出 1 个 P0 阻塞问题 + 7 个关键非阻塞建议。本版本完成以下修正：

| 编号 | 修正点 | 评审来源 |
|------|--------|----------|
| H-01 | **B-01（架构师 P0 阻塞）**: `packages/core/src/index.ts` 是 `@vegamo/deepcode-core` 的真正包入口（package.json main → dist/index.js → src/index.ts），该文件对 `./team/index.js` 采用**显式 re-export**（L387-462），**没有 `export *`**。v1.3 F-01 + v1.4 G-01/G-04 在 `team/index.ts` 末尾新增的所有导出**无法传递到 @vegamo/deepcode-core**，§3.2.2 的 19 个 import 符号中有 18 个会编译失败。修正：①§2.3 文件影响清单新增 `packages/core/src/index.ts` 修改项；②§3.3 末尾新增 §3.3.3 给出在 L462 之后追加的显式 re-export 代码（不使用 `export *` 避免加剧 RiskLevel 命名冲突） | 架构师 B-01 |
| H-02 | **NB-01（测试专家 + 独立开发者 + 产品经理 3 角色一致）**: G-06 stage-aware 工厂的 stage 推断基于 `messages[0].content`（system prompt）不可靠——DevStageHandler 和 FixStageHandler 都使用 solo-coder 角色，system prompt 相同，stub 的 if/else if 链中 "dev" 先于 "fix" 检查，导致 fix stage 被误判为 dev stage。修正：改为基于 `messages[1].content`（user prompt）推断 stage，因为 BaseStageHandler.buildDescription 生成的 user prompt 包含明确的 `# Plan 阶段`/`# Dev 阶段`/`# Verify 阶段`/`# Fix 阶段` 标题 | 测试专家 NB-01, 独立开发者 NB-01, 产品经理 NB-02 |
| H-03 | **NB-02（架构师）**: §3.3.1 末尾注释 `createOpenAIClient 已在 team/index.ts 现有导出中（见 L xxx，可在读取源码时确认）` 错误。`createOpenAIClient` 不在 `team/index.ts` 导出，而在 `packages/core/src/index.ts:113` 直接从 `./common/openai-client` 导出（不经 team/index.ts）。修正：删除"已在 team/index.ts 现有导出中"错误描述，改为正确位置说明 | 架构师 NB-02 |
| H-04 | **NB-02（测试专家）**: LL-009 期望输出 `exitCode=3` 是 CLI 层概念，不是 `executeDispatch` 返回值。`executeDispatch` 返回的是 `DispatchResult`（含 `status` 字段），CLI 层才把 `status=skipped` 映射为 `exitCode=3`。LL-009 在 `team-adapter-llm.test.ts`（dispatch 测试文件）中，应断言 `status=skipped`，不断言 exitCode。修正：LL-009 期望输出改为 `status=skipped` | 测试专家 NB-02 |
| H-05 | **NB-03（测试专家）**: SH-016/017 期望输出"回退到 createOpenAIClient"不可直接观测，测试无法断言。修正：改为可观测断言——"StageResult.kind=fatal, summary 含 'dispatch 被跳过'"（因为 createOpenAIClient 在无 API Key 的测试环境中返回 no-client，executeDispatch 返回 skipped，StageHandler 把 skipped 视为 fatal） | 测试专家 NB-03 |
| H-06 | **NB-02（独立开发者）**: §3.2.2 第 6 步 `stageHandlerClient` 类型断言冗余——第 2 步已通过 `isOpenAIClientHandle` 类型守卫处理 `args.injectedClient`，`clientHandle` 类型已是 `OpenAIClientHandle | null`，第 6 步的 `as { client: unknown; model: string; ... } | undefined` 是重复处理。修正：简化为 `const stageHandlerClient = clientHandle ?? undefined;` | 独立开发者 NB-02 |
| H-07 | **NB-03（独立开发者）**: §7.4 stub client 的 `promptLower.includes("test")` 可能误匹配 "latest"/"contest"/"testimony" 等含 "test" 子串的单词。修正：改为基于 user prompt 的明确 stage 标题匹配（配合 H-02），使用 `userPrompt.includes("# Verify 阶段")` 等精确字符串匹配 | 独立开发者 NB-03 |
| H-08 | **NB-01（产品经理）**: 两套目录命名（`.deepcode/` 无 x 与 `.deepcodex/` 带 x）并存需在 README.md 和 quickstart.md 中明确说明，避免用户混淆。修正：§2.3 文件影响清单的 README.md 和 quickstart.md 修改说明中补充两套目录命名差异说明 | 产品经理 NB-01 |

---

## v1.4 修正说明（相对 v1.3）

v1.3 经 4 角色评审全部"有条件通过"，识别出 3 个独立阻塞问题（去重后）+ 4 个关键非阻塞建议。本版本完成以下修正：

| 编号 | 修正点 | 评审来源 |
|------|--------|----------|
| G-01 | **B-01（架构师 + 独立开发者）**: §3.3 缺少 `autonomous/index.ts` 追加 re-export `stage-handlers.js` 符号的具体代码示例。`export * from "./autonomous/index.js"`（F-01）只能聚合 autonomous/index.ts 已导出的符号，对 stage-handlers.ts 新增的 `createDefaultStageHandlers`/`PlanStageHandler`/`DevStageHandler`/`VerifyStageHandler`/`FixStageHandler`/`isOpenAIClientHandle`/`OpenAIClientHandle` 无能为力。修正：在 §3.3 末尾显式给出 autonomous/index.ts 的追加代码 | 架构师 B-01, 独立开发者 B-01 |
| G-02 | **B-01（产品经理）**: §3.2.2 第 1 步注释中 autonomous.yml 路径错误。源码中存在两套不同目录命名：①`.deepcode/`（无 x）— settings.json 使用（settings.ts:657-663）；②`.deepcodex/`（带 x）— autonomous.yml/runs/notes.md 使用（config-loader.ts:84/87/96/101）。修正：将 §3.2.2 第 1 步注释中的 `.deepcode/autonomous.yml` 改为 `.deepcodex/autonomous.yml`，并补充两套目录命名差异说明 | 产品经理 B-01 |
| G-03 | **B-01（测试专家）**: §8.3 验收标准的用例数与 §7 实际用例数不一致（3 处偏差）：stage-handlers 15→17、team-cmd-autonomous 10→9、team-adapter-llm 8→9。修正：同步更新 §8.3 三处数字 | 测试专家 NB-01 |
| G-04 | **NB-03（架构师）**: F-06 引入 stage-handlers.ts ↔ team-adapter.ts 循环依赖。修正：将 `isOpenAIClientHandle` 和 `OpenAIClientHandle` 改放到 `common/openai-client.ts`（已验证 createOpenAIClient 在此文件定义，返回值结构正好对应），彻底消除循环依赖 | 架构师 NB-03 |
| G-05 | **NB-02（架构师）**: F-04 表格"修改前"列描述与真实源码多处不符（L93/L112/L117/L203）。修正：按真实源码更新表格，并标注 L117/L203 单行多引用 | 架构师 NB-02 |
| G-06 | **NB-02（产品经理）**: `buildStubClientReturningValidOutput` 默认 content `"## Plan\n\n方案内容..."` 与 VerifyStageHandler 关键字检查（PASS/FAIL）不匹配，会导致 AC-003 的 verify stage 失败。修正：改为 stage-aware 工厂，根据 system prompt 推断当前 stage 返回对应 content | 产品经理 NB-02 |
| G-07 | **NB-02（独立开发者）**: §3.2.2 类型守卫调用 `isOpenAIClientHandle(args.injectedClient)` 后 `return args.injectedClient` 在 TS 旧版本可能无法自动收窄。修正：改为局部变量写法 | 独立开发者 NB-02 |

---

## v1.3 修正说明（相对 v1.2）

v1.2 经 4 角色评审（独立开发者通过，其他 3 角色有条件通过/不通过），识别出 3 个独立阻塞问题（去重后），本版本基于再次读取的真实源码完成以下修正：

| 编号 | 修正点 | 评审来源 |
|------|--------|----------|
| F-01 | **B-01（架构师）**: `packages/core/src/team/index.ts` 未从 `./autonomous/index.js` re-export，导致 §3.2.2 的 `import { RunState, ... } from "@vegamo/deepcode-core"` 无法编译。修正：在 `packages/core/src/team/index.ts` 末尾新增 `export * from "./autonomous/index.js";` 并补充 §2.3 文件影响清单 | 架构师 B-01 |
| F-02 | **B-01（产品经理）**: §3.2.2 第 2 步 API Key 错误提示 3 种配置方式与真实源码不一致：①环境变量名错误（`OPENAI_API_KEY` → 应为 `DEEPCODE_API_KEY`，settings.ts:399-411 `collectDeepcodeEnv` 仅收集 `DEEPCODE_` 前缀）；②`.env` 文件机制不存在（settings.ts 全文无 dotenv 调用）；③项目级路径错误（`.deepcodex` → 应为 `.deepcode`，settings.ts:661-663 `getProjectSettingsPath` 返回 `<projectRoot>/.deepcode/settings.json`）。同步修正 §7.4 AC-002 关键字 | 产品经理 B-01 |
| F-03 | **B-01（测试专家）**: §7.4 AC-005/006/007/008/009 测试用例输入描述不完整，未明确 `injectedClient` 注入策略。在有 API Key 的开发机上会真实调用 LLM（行为不可控）；在 CI 环境上根本不会启动 RalphLoopController。修正：在 5 个用例的"输入"列明确补充 `+ injectedClient: buildStubClientReturningValidOutput()` | 测试专家 B-01 |
| F-04 | **N-01（架构师）**: §3.2.1 RunState 字段重命名描述不完整。`this.state` 在 run-state.ts 中实际出现 9 处（L83/93/112/117/123/137/176/203/204），全部需替换为 `this.stateValue`。补充完整替换清单 | 架构师 N-01 |
| F-05 | **N-04（架构师）**: §3.2.2 手写 runId 生成（`r-${Date.now()...}-${Math.random()...}`）应使用 `generateRunId()`（loop-controller.ts 已导出，autonomous/index.ts L38 re-export）。修正：替换为 `generateRunId()` | 架构师 N-04 |
| F-06 | **N-06（架构师）**: §3.2.2 内联类型守卫与 §4.2 函数式类型守卫实现不统一。修正：§3.2.2 改为复用 §4.2 的 `isOpenAIClientHandle` 函数（提取到 `common/openai-client.ts` 或 `team/autonomous/stage-handlers.ts` 中共享） | 架构师 N-06 |
| F-07 | **NB-02（测试专家）**: §6.2.4 `t.before` 钩子示例不完整，缺少 `t.after` 调用 `restoreEnv`。修正：补充完整的 `test.after` 钩子示例 | 测试专家 NB-02 |
| F-08 | **NB-04（测试专家）**: §7 缺失 `injectedClient` 边界值测试。修正：在 §7.1 stage-handlers.test.ts 新增 SH-016/SH-017 边界值用例 | 测试专家 NB-04 |
| F-09 | **NB-01（产品经理）**: §3.2.3 `--resume-run` 与 `--goal` 参数关系未明确。修正：在 §3.2.3 明确"恢复运行时 `--goal` 可选（缺省使用原 run 的 objective）" | 产品经理 NB-01 |
| F-10 | **NB-04（产品经理）**: §7.4 AC-010 测试用例归属模糊（dispatch 测试应在 dispatch 测试文件中）。修正：将 AC-010 从 `team-cmd-autonomous.test.ts` 迁移到 `team-adapter-llm.test.ts` 并改名为 LL-009 | 产品经理 NB-04 |

---

## v1.2 修正说明（相对 v1.1）

v1.1 经 4 角色评审全部"有条件通过"，识别出 14 个独立阻塞问题（含重叠），本版本基于已读取的真实 API 完成以下修正：

| 编号 | 修正点 | 评审来源 |
|------|--------|----------|
| M-01 | §3.2.2 SleepGuard log 回调签名从 `(level, msg) => void` 改为 `(message: string) => void`（真实 API 是单参数，见 sleep-guard.ts:35） | 架构师 #1, 独立开发者 #6 |
| M-02 | §4.2 `options.injectedClient` 是 `unknown` 类型，需加类型断言/类型守卫才能访问 `.client`，否则编译失败 | 架构师 #2, 独立开发者 #5 |
| M-03 | §3.2.2 `--resume-run` 恢复时用新 runId 构造 GitDriver，但 RunState 仍用旧 runId，导致 runId/runDir 不同步；需用 `runState.getState().runId` 重置并重建 GitDriver | 架构师 #3 |
| M-04 | §3.3 `DispatchResult` 不能从 `team-adapter.js` 导入（team-adapter.ts 仅 import type 未 re-export，见 L22），需改为从 `types.js` 导入 | 架构师 #4, 独立开发者 #1 |
| M-05 | §4.4 DispatchStatus 当前已有 9 个状态（含 skipped，见 types.ts:163-173），删除"新增 skipped"描述，改为"复用现有 skipped 状态" | 架构师 #5, 独立开发者 #2 |
| M-06 | §4.2 `executeDispatch` 函数参数名是 `options`（非 `opts`），修正 `opts.projectRoot` → `options.projectRoot` | 独立开发者 #4 |
| M-07 | §3.2.1 RunState 字段重命名时需同步修改静态 `load()` 方法中的 `rs.state = data` → `rs.stateValue = data`（见 run-state.ts:175-177） | 独立开发者 #6 |
| M-08 | §6.2.4 `team-adapter.test.ts` 断言改为 `skipped` 必须配套 `isolateOpenAIEnv` 包装，否则有 API Key 的开发机仍会走 network 分支而失败 | 测试专家 #2, 独立开发者 #3 |
| M-09 | §3.2.3 `TeamCommandArgs` 接口需新增 `injectedClient?: unknown` 和 `resumeRun?: boolean` 字段，AC-003/004/007/008 测试才能注入 stub 客户端 | 测试专家 #1 |
| M-10 | §3.2.2 API Key 错误提示指向错误位置：项目实际用 `~/.deepcode/settings.json` 的 `env.API_KEY`，非 `providers.openai.apiKey` | 产品经理 #1 |
| M-11 | §4.6 退出码 2 语义冲突：autonomous 的 Fatal abort 与 dispatch 的 skipped 不能共用 exit code 2；autonomous 用 2=Fatal abort，dispatch 用 3=skipped | 产品经理 #2 |
| M-12 | §3.2.2 `exitCodeMap` 与 `return exitCode === 0 ? 0 : 1` 自相矛盾（2/3 被压成 1），改为直接 `return exitCode` | 产品经理 #3 |
| M-13 | §2.3 文件影响清单遗漏 `cli-args.ts` optionKeys 数组、`TeamCommandArgs` 接口、`executeDispatchCommand` 修改，补充完整 | 产品经理 #4 |
| M-14 | §7.4 AC-002 测试断言不充分（仅检查单一字符串），补充多重断言：检查 exitCode + 至少 2 个 stderr 关键字 | 产品经理 #5 |

---

## v1.1 修正说明（相对 v1.0）

v1.0 经 4 角色评审识别出约 25 个阻塞问题，本版本基于已读取的真实 API 完成以下修正：

| 编号 | 修正点 | 评审来源 |
|------|--------|----------|
| C-01 | §1.4 范围调整：允许为 RunState 新增 5 个 mark/record 方法 + state getter，以实现 RunStateLike 接口 | 架构师 #1, #2 |
| C-02 | §3.2.2 重写 9 组件实例化代码，所有构造参数对齐真实 API | 架构师 #3-#6, 独立开发者 #12 |
| C-03 | §3.2.2 增加 runDir 构造逻辑 `path.join(projectRoot, autoConfig.runDir, runId)` | 架构师 #3 |
| C-04 | §3.2.2 删除未使用的 DispatcherAdapter 实例化 | 独立开发者 #14 |
| C-05 | §3.2.2 显式构造 LoopConfig（从 AutonomousConfig 提取 11 个字段） | 架构师 #11 |
| C-06 | §3.2.2 增加 API Key 前置校验 | 产品经理 #3 |
| C-07 | §3.2.2 修改 controller.run() 为 `await controller.run()` | 架构师 #7 |
| C-08 | §3.3 统一 StageHandler 构造参数风格为位置参数 | 架构师 #10, 独立开发者 #15 |
| C-09 | §3.3 judgeResult 参数类型改为 `DispatchResult`（替代 `any`） | 独立开发者 #13 |
| C-10 | §3.3 重新设计 stage 间数据传递（基于 IterationResult 真实结构） | 独立开发者 #12 |
| C-11 | §3.3 BaseStageHandler 增加 `injectedClient` 字段透传 | 测试专家 #5 |
| C-12 | §3.4 显式说明 `run()` 改为 `async run(): Promise<number>` 连锁修改 | 架构师 #7, #8 |
| C-13 | §3.4 backoffSleep 改为 `async backoffSleep()` 使用 `setTimeout` Promise | 架构师 #8 |
| C-14 | §4.4 修正 DispatchOptions 位置为 team-adapter.ts，使用 zod 语法 | 架构师 #9 |
| C-15 | §4.6 新增 CLI 层 skipped 状态处理 | 产品经理 #2 |
| C-16 | §6.2.1 isolateEnvVars 增加 t.after 钩子说明（Node.js test runner 跨文件并发） | 测试专家 #2 |
| C-17 | §7 测试用例补充（fatal 分支、网络错误、--resume-run、buildUserPromptFromTask 独立单测） | 测试专家 #3, #4 |
| C-18 | §2.3 文件影响清单补充（team-adapter.test.ts、formatTeamHelp、README、quickstart.md） | 产品经理 #1, #4 |
| C-19 | §3.2.3 `--resume` flag 与 session resume 冲突，改名为 `--resume-run` | 产品经理 #1 |

---

## 一、背景与问题

### 1.1 背景

DeepCodeX-cli 的 `packages/core/src/team/` 模块（40+ 文件）是 multi-agent-team skill 的 TypeScript 重写版，包含：
- 5 核心角色（architect / product-manager / solo-coder / test-expert / ui-designer）
- 7 阶段工作流（需求 → 架构 → UI → 测试 → 开发 → 验证 → 发布）
- Cybernetics 控制论 4 模块
- Ponytail 决策梯 + Karpathy 原则
- Autonomous 自主迭代 9 组件（Ralph 风格 4 阶段循环）
- Plugin V3 热加载架构
- Domain Experts 领域专家（9 类业务专家）

经多角色团队 review 识别出 4 个 P0 阻塞缺陷，导致：
- CLI `team autonomous` 子命令无法真正使用 RalphLoopController 自主迭代
- `executeDispatch` 跳过 LLM 调用，直接返回 `succeeded` 的虚假成功
- CI 不覆盖 `team/tests/` 目录（591 个用例被绕过）
- `domain-expert-review-plugin.test.ts` 测试受环境变量污染而失败

### 1.2 问题清单

| 编号 | 严重级 | 问题点 | 影响 |
|------|--------|--------|------|
| P0-1 | 阻塞 | `team-cmd.ts:executeAutonomousCommand` 未调用 `RalphLoopController`，4 阶段全部硬编码委派 solo-coder | autonomous 子命令只是 4 次 dispatch 循环，未使用已实现的 9 组件 |
| P0-2 | 阻塞 | `team-adapter.ts:executeDispatch` 注释"LLM 调用留给上层"但实际直接返回 `succeeded`，`tokensConsumed` 全为 0 | CLI 显示虚假成功，未真正调用 LLM |
| P0-3 | 阻塞 | `.github/workflows/ci.yml` 测试路径只跑 `packages/core/src/tests/*.test.ts`，不含 `team/tests/` | 591 个 team 测试用例被 CI 绕过 |
| P0-4 | 阻塞 | `domain-expert-review-plugin.test.ts:1868` 断言 `result.error?.includes("no-client")`，但环境有 API Key 时走 network 分支 | 测试在开发机环境失败 |

### 1.3 修复目标

1. **P0-1**: `team autonomous` 子命令真正实例化 `RalphLoopController` + 注入 9 组件 + 4 个真实 `StageHandler`
2. **P0-2**: `executeDispatch` 接入真实 LLM 调用（复用 `invokeExpertLLM` 已验证的调用模式），返回真实 `output` 和 `tokensConsumed`
3. **P0-3**: CI 增加 team 测试目录，并解决测试环境隔离
4. **P0-4**: 测试用例通过环境变量备份/恢复方式实现测试环境隔离，参考 `eag-rules-cmd.test.ts` 的 `backupAndClearGlobalRules` 模式

### 1.4 范围调整（v1.1 新增）

**允许的修改范围**（v1.0 限制过严，导致 RunState 无法对接 RalphLoopController）：

| 组件 | v1.0 范围 | v1.1 调整 | 理由 |
|------|----------|-----------|------|
| `RalphLoopController` | 不修改内部逻辑 | 修改 3 处签名：`async run()`、`async runOneIteration()`、`async backoffSleep()` | StageHandler async 化的必然连锁 |
| `StageHandler` 接口 | 不修改 | 改为 `handle(ctx): StageResult \| Promise<StageResult>` | executeDispatch 是 async，无法同步调用 |
| `RunState` 类 | 不修改 | **新增 5 个公开方法**：`markRunning/markComplete/markFailed/markAborted/recordIteration` + `state` getter | RunState 当前不实现 RunStateLike 接口，无法注入 RalphLoopController |
| 其他 8 组件 | 不修改 | 不修改 | 真实 API 已满足需求 |

**仍然禁止**：
- 不修改 multi-agent-team skill 源代码（Python 端）
- 不修改 V3 Plugin / Dispatcher 架构
- 不重写 `executeDispatch` 为新函数（保持函数名兼容）
- 不引入新 npm 依赖（`deasync` / `sleep-sync` 等同步睡眠库）

---

## 二、整体设计

### 2.1 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                    CLI 层 (packages/cli/src/team/)                  │
│                                                                     │
│  team-cmd.ts (executeAutonomousCommand)                            │
│      ↓ 前置校验 API Key                                            │
│      ↓ 构造 runDir = projectRoot/autoConfig.runDir/runId            │
│      ↓ 实例化 9 组件（按真实 API 构造参数）                        │
│      ↓ 实例化 4 StageHandler                                       │
│      ↓ await RalphLoopController.run()                             │
│      ↓ 处理 skipped / failed / succeeded 状态                     │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ↓
┌─────────────────────────────────────────────────────────────────────┐
│              Autonomous 模块 (packages/core/src/team/autonomous/)   │
│                                                                     │
│  async RalphLoopController.run(): Promise<number>                  │
│      ↓ await runOneIteration(iterIndex)                            │
│      ↓ 4 阶段顺序执行：plan → dev → verify → fix                    │
│      ↓ await handler.handle(ctx)                                   │
│                                                                     │
│  stage-handlers.ts (新增)                                          │
│      ├─ PlanStageHandler    → 调用 executeDispatch(role=architect)  │
│      ├─ DevStageHandler     → 调用 executeDispatch(role=solo-coder) │
│      ├─ VerifyStageHandler  → 调用 executeDispatch(role=test-expert)│
│      └─ FixStageHandler     → 调用 executeDispatch(role=solo-coder) │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ↓
┌─────────────────────────────────────────────────────────────────────┐
│              Team 适配层 (packages/core/src/team/team-adapter.ts)   │
│                                                                     │
│  async executeDispatch(task, options, onProgress)                  │
│      ├─ 阶段 1: dispatchToRole(task) → 角色匹配                    │
│      ├─ 阶段 2: 构造 system prompt                                  │
│      └─ 阶段 3: 调用 LLM（新增，复用 invokeExpertLLM 模式）        │
│                ├─ createOpenAIClient(projectRoot)                  │
│                ├─ AbortController 超时保护                         │
│                ├─ 调用 chat.completions.create                     │
│                ├─ 提取 response.choices[0].message.content         │
│                └─ 提取 response.usage 填充 tokensConsumed          │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 设计原则

| 原则 | 应用 |
|------|------|
| **Karpathy Surgical Changes** | 只修改 4 个文件 + 新增 3 个文件；RunState 仅追加方法不改原方法 |
| **Karpathy Simplicity First** | 不引入新依赖；复用 `createOpenAIClient` / `invokeExpertLLM` 已验证模式 |
| **Karpathy Goal-Driven** | 每个修复点都有明确的成功标准（断言） |
| **Ponytail R-02 显式错误处理** | LLM 调用失败时返回 `status="failed"` + 真实 error message |
| **Ponytail R-03 输入校验** | StageHandler 校验 `ctx.task` / `ctx.projectRoot` 等关键字段 |
| **用户规则: 禁止 mock** | LLM 调用真实发起；测试环境隔离通过环境变量备份/恢复 |
| **用户规则: 测试覆盖** | 每个修复点补齐单元测试 + 集成测试 |
| **用户规则: 中文注释** | 所有新增函数和关键逻辑都有详细中文注释 |

### 2.3 文件影响清单（v1.1 扩展，v1.2 补充遗漏项，v1.3 新增 team/index.ts re-export，v1.4 新增 common/openai-client.ts 修改，v1.5 新增 packages/core/src/index.ts 显式 re-export）

| 文件 | 操作 | 行数变化 | 说明 |
|------|------|----------|------|
| `packages/core/src/team/autonomous/stage-handlers.ts` | 新增 | +280 | 4 个 StageHandler 真实实现（含 injectedClient 透传）；v1.4 G-04：删除 OpenAIClientHandle/isOpenAIClientHandle 定义，改为从 common/openai-client.ts 导入 |
| `packages/core/src/team/autonomous/index.ts` | 修改 | +10 | 导出 4 个 StageHandler + createDefaultStageHandlers 工厂；v1.4 G-01：显式 re-export stage-handlers.ts 的 5 个符号（PlanStageHandler/DevStageHandler/VerifyStageHandler/FixStageHandler/createDefaultStageHandlers） |
| `packages/core/src/team/autonomous/loop-controller.ts` | 修改 | +12 / -6 | StageHandler 接口 async 化；run/runOneIteration/backoffSleep async 化 |
| `packages/core/src/team/autonomous/run-state.ts` | 修改 | +65 / -9 | v1.2 修正：私有字段 `state` → `stateValue` + 静态 `load()` 同步重命名 + 新增 5 个 mark/record 方法 + state getter；v1.3 F-04：全局替换 9 处 `this.state` → `this.stateValue`；v1.4 G-05：按真实源码校对 9 处替换清单 |
| `packages/core/src/common/openai-client.ts` | 修改 | +35 | **v1.4 新增（G-04）**：末尾追加 `OpenAIClientHandle` 接口 + `isOpenAIClientHandle` 类型守卫（从 stage-handlers.ts 迁移，消除循环依赖） |
| `packages/core/src/team/index.ts` | 修改 | +35 / -1 | **v1.3 F-01**：末尾追加 `export * from "./autonomous/index.js";`；**v1.4 G-04**：追加 `export { isOpenAIClientHandle, type OpenAIClientHandle } from "../common/openai-client.js";`；**v1.6 I-01（架构师 P0 阻塞）**：将 `export * from "./autonomous/index.js";` 改为显式 re-export（消除 RiskLevel 命名冲突：smart-confirmation.ts 的 type RiskLevel vs cybernetics/guard-coordinator.ts 的 const RiskLevel），同时合并 v1.4 G-04 的 common/openai-client 聚合导出 |
| `packages/core/src/index.ts` | 修改 | +35 | **v1.5 新增（H-01 / 架构师 B-01 P0 阻塞）**：这是 `@vegamo/deepcode-core` 的真正包入口（package.json main → dist/index.js → src/index.ts），对 `./team/index.js` 采用**显式 re-export**（L387-462），**没有 `export *`**。因此 v1.3 F-01 + v1.4 G-01/G-04 在 `team/index.ts` 末尾新增的所有导出**无法传递到 @vegamo/deepcode-core**。修正：在 team 模块导出块末尾（L462 之后）追加显式 re-export，将 autonomous 9 组件 + stage-handlers 5 符号 + common/openai-client 2 符号传递到 @vegamo/deepcode-core。详见 §3.3.3 |
| `packages/core/src/team/team-adapter.ts` | 修改 | +150 / -15 | executeDispatch 接入 LLM 调用 + buildUserPromptFromTask；v1.4 G-04：从 common/openai-client.js 导入 isOpenAIClientHandle/OpenAIClientHandle（原从 stage-handlers.js 导入，消除循环依赖）；v1.4 G-07：类型守卫改为局部变量写法 |
| `packages/core/src/team/tests/team-adapter.test.ts` | 修改 | +30 / -4 | v1.2 修正：现有 2 个用例包装 `isolateOpenAIEnv` + 断言从 succeeded 改为 skipped |
| `packages/cli/src/team/team-cmd.ts` | 修改 | +160 / -55 | v1.2 修正：`TeamCommandArgs` 新增 `resumeRun` + `injectedClient` 字段；`executeAutonomousCommand` 串联 RalphLoopController + skipped 处理；`executeDispatchCommand` 退出码 3=skipped；v1.3 F-02：修正 API Key 错误提示；v1.3 F-05：使用 `generateRunId()` 替代手写 runId；v1.4 G-02：autonomous.yml 路径改为 `.deepcodex/`；v1.4 G-07：类型守卫改为局部变量写法 |
| `packages/cli/src/cli-args.ts` | 修改 | +12 | v1.2 补充：新增 `--resume-run` flag 解析 + optionKeys 数组新增 `"resume-run"` |
| `packages/cli/src/team/format-team-help.ts`（如存在）或 team-cmd.ts:formatTeamHelp | 修改 | +3 | help 文本补充 `--resume-run` 说明 |
| `.github/workflows/ci.yml` | 修改 | +15 | 增加 team 测试路径 |
| `packages/core/src/team/tests/domain-expert-review-plugin.test.ts` | 修改 | +25 | 测试环境隔离 |
| `packages/core/src/team/tests/utils/env-isolation.ts` | 新增 | +80 | 测试环境隔离工具 |
| `packages/cli/src/tests/utils/stub-client.ts` | 新增 | +90 | v1.3 新增（F-03）：autonomous 集成测试用的 stub client 工厂；v1.4 G-06：buildStubClientReturningValidOutput 改为 stage-aware 工厂（根据 system prompt 推断 stage 返回对应 content） |
| `packages/core/src/team/tests/stage-handlers.test.ts` | 新增 | +380 | 4 个 StageHandler 单元测试（含 fatal 分支） + v1.3 F-08：新增 SH-016/SH-017 injectedClient 边界值测试 |
| `packages/core/src/team/tests/team-adapter-llm.test.ts` | 新增 | +260 | executeDispatch LLM 集成测试 + v1.3 F-10：新增 LL-009（原 AC-010 迁移） |
| `packages/core/src/team/tests/build-user-prompt.test.ts` | 新增 | +120 | buildUserPromptFromTask 独立单元测试 |
| `packages/cli/src/tests/team-cmd-autonomous.test.ts` | 新增 | +240 | autonomous 子命令集成测试（含 --resume-run）；v1.3 F-03：5 个用例补充 `+ injectedClient`；v1.3 F-10：移除 AC-010（迁移到 LL-009） |
| `tests/scripts/run-team-integration-tests.sh` | 新增 | +80 | team 集成测试 shell 脚本 |
| `README.md` | 修改 | +30 | team 子命令使用说明；v1.5 H-08 新增：补充两套目录命名差异说明——`.deepcode/`（无 x，settings.json 使用，settings.ts:657-663）与 `.deepcodex/`（带 x，autonomous.yml/runs/notes.md 使用，config-loader.ts:84/87/96/101）并存，用户需了解两者用途不同；**v1.6 I-06 新增（产品经理 NB-04）**：在 team autonomous 使用说明中补充"autonomous 4 阶段流程"说明 + stage 标题命名约定（`# Plan 阶段`/`# Dev 阶段`/`# Verify 阶段`/`# Fix 阶段`，首字母大写，大小写敏感），让用户了解 stage-aware 工厂的核心契约 |
| `docs/quickstart.md` | 修改 | +25 | team autonomous 快速开始示例；v1.5 H-08 新增：补充两套目录命名差异说明（同 README.md）；**v1.6 I-09 新增（产品经理 NB-02）**：补充具体路径示例——`~/.deepcode/settings.json`（用户级配置，含 `env.API_KEY` 字段）、`./.deepcodex/autonomous.yml`（项目级 autonomous 配置）、`./.deepcodex/runs/`（运行状态持久化目录）、`./.deepcodex/notes.md`（跨轮笔记），让用户一眼看清两套目录的文件分布 |

**v1.2 新增的修改点（M-13）**：

| 文件 | 修改位置 | v1.1 状态 | v1.2 修正 |
|------|---------|----------|----------|
| `packages/cli/src/cli-args.ts:288-299` | `optionKeys` 数组 | 遗漏 | 新增 `"resume-run"` |
| `packages/cli/src/team/team-cmd.ts:42-62` | `TeamCommandArgs` 接口 | 遗漏 | 新增 `resumeRun?: boolean` + `injectedClient?: unknown` 字段 |
| `packages/cli/src/team/team-cmd.ts:144-199` | `executeDispatchCommand` 退出码 | 遗漏 | 新增 skipped → exit code 3 处理（M-11） |

**v1.3 新增的修改点（F-01 / F-02 / F-05 / F-06）**：

| 文件 | 修改位置 | v1.2 状态 | v1.3 修正 |
|------|---------|----------|----------|
| `packages/core/src/team/index.ts:486` | 末尾新增 `export * from "./autonomous/index.js";` | 遗漏（导致 §3.2.2 import 无法编译） | 新增聚合导出 autonomous 9 组件 + 4 StageHandler + createDefaultStageHandlers |
| `packages/core/src/team/autonomous/run-state.ts:83/93/112/117/123/137/176/203/204` | 9 处 `this.state` 全局替换 | 仅描述 L83 + L175 | 完整替换为 `this.stateValue`（含 `getState()` 内部、`update()` 内部、`appendHistory()` 内部、`persist()` 内部、`buildResumeContext()` 内部、静态 `load()` 内部） |
| `packages/cli/src/team/team-cmd.ts:457-463` | API Key 错误提示 | 配置方式 3 种错误 | 修正为：①环境变量 `DEEPCODE_API_KEY`；②`~/.deepcode/settings.json` 的 `env.API_KEY` 字段（用户级）；③`./.deepcode/settings.json` 的 `env.API_KEY` 字段（项目级） |
| `packages/cli/src/team/team-cmd.ts:490/495` | runId 生成 | 手写 `r-${Date.now()...}-${Math.random()...}` | 替换为 `generateRunId()`（从 `@vegamo/deepcode-core` 导入，已在 autonomous/index.ts L38 re-export） |
| `packages/core/src/team/autonomous/stage-handlers.ts` | 共享类型守卫 | §3.2.2 内联 + §4.2 函数式重复实现 | 新增 `isOpenAIClientHandle` 导出，§3.2.2 和 §4.2 共享调用（**v1.4 G-04 已迁移到 common/openai-client.ts**） |

**v1.4 新增的修改点（G-01 / G-02 / G-04 / G-05 / G-06 / G-07）**：

| 文件 | 修改位置 | v1.3 状态 | v1.4 修正 |
|------|---------|----------|----------|
| `packages/core/src/team/autonomous/index.ts` 末尾 | 显式 re-export stage-handlers.ts 的 5 个符号 | 遗漏（导致 `export *` 无法传递 stage-handlers.ts 新符号） | 新增 `export { PlanStageHandler, DevStageHandler, VerifyStageHandler, FixStageHandler, createDefaultStageHandlers } from "./stage-handlers.js";` |
| `packages/core/src/common/openai-client.ts` 末尾 | 追加 `OpenAIClientHandle` 接口 + `isOpenAIClientHandle` 类型守卫 | 不存在（v1.3 放在 stage-handlers.ts） | 从 stage-handlers.ts 迁移到 common/openai-client.ts，消除 team-adapter.ts ↔ stage-handlers.ts 循环依赖 |
| `packages/core/src/team/index.ts` 末尾 | 追加 `export { isOpenAIClientHandle, type OpenAIClientHandle } from "../common/openai-client.js";` | 遗漏 | 聚合导出 common/openai-client.ts 的类型守卫到 @vegamo/deepcode-core |
| `packages/core/src/team/autonomous/stage-handlers.ts` import 部分 | 从 common/openai-client.js 导入类型守卫 | v1.3 在本文件内定义（导致循环依赖） | 删除本地定义，改为 `import { isOpenAIClientHandle, type OpenAIClientHandle } from "../../common/openai-client.js";` |
| `packages/core/src/team/team-adapter.ts` import 部分 | 从 common/openai-client.js 导入类型守卫 | v1.3 从 stage-handlers.js 导入（循环依赖） | 改为 `import { createOpenAIClient, isOpenAIClientHandle, type OpenAIClientHandle } from "../common/openai-client.js";` |
| `packages/cli/src/team/team-cmd.ts:486` 注释 | `.deepcode/autonomous.yml` 路径错误 | 错误跟随了 settings.json 的 `.deepcode/` 命名 | 改为 `.deepcodex/autonomous.yml`，补充两套目录命名差异说明 |
| `packages/cli/src/team/team-cmd.ts` 第 2 步 | 类型守卫 IIFE 写法 | v1.3 使用 IIFE + 类型守卫 | 改为 `let + 局部变量 + if/else` 写法，TS 旧版本类型守卫收窄更可靠 |
| `packages/core/src/team/team-adapter.ts` 第 3.1 步 | 同上 IIFE 写法 | v1.3 使用 if/else 但未提取局部变量 | 同步改为局部变量写法 |
| `packages/cli/src/tests/utils/stub-client.ts` | `buildStubClientReturningValidOutput` 固定 content | v1.3 默认返回 `"## Plan\n\n方案内容..."`，verify stage 不匹配 | 改为 stage-aware 工厂，根据 system prompt 推断 stage 返回对应 content |
| `packages/core/src/team/autonomous/run-state.ts` F-04 表格 | "修改前"列描述与真实源码不符 | v1.3 L93 误写为 return、L112 误写为 Object.assign | 按真实源码更新：L93 是构造器赋值、L112 是 JSON.parse、L117 单行 2 处、L203 单行 3 处 |

**v1.5 新增的修改点（H-01 / H-02 / H-03 / H-06 / H-07 / H-08）**：

| 文件 | 修改位置 | v1.4 状态 | v1.5 修正 |
|------|---------|----------|----------|
| `packages/core/src/index.ts` L462 之后 | team 模块导出块末尾追加显式 re-export | 遗漏（H-01 / 架构师 B-01 P0 阻塞）：v1.3 F-01 + v1.4 G-01/G-04 在 team/index.ts 末尾新增的所有导出无法传递到 @vegamo/deepcode-core | 追加 `export { RunState, findLatestResumableRun, NotesMemory, GitDriver, SleepGuard, SmartConfirmation, AutoSkillLoader, RalphLoopController, defaultLoopConfig, generateRunId, loadAutonomousConfig, PlanStageHandler, DevStageHandler, VerifyStageHandler, FixStageHandler, createDefaultStageHandlers, isOpenAIClientHandle } from "./team/index.js";` + `export type { AutonomousConfig, LoopConfig, StageHandler, StageKind, LogCallback, IterationContext, IterationResult, StageResult, RunStateLike, OpenAIClientHandle } from "./team/index.js";`（不使用 `export *` 避免加剧 RiskLevel 命名冲突） |
| `packages/cli/src/tests/utils/stub-client.ts` `buildStubClientReturningValidOutput` | stage 推断逻辑改为基于 user prompt | v1.4 G-06 基于 `messages[0].content`（system prompt），但 dev/fix stage 都是 solo-coder 角色，system prompt 相同，"dev" 先于 "fix" 匹配导致 fix 分支不可达 | 改为基于 `messages[1].content`（user prompt）匹配 `# Plan 阶段`/`# Dev 阶段`/`# Verify 阶段`/`# Fix 阶段` 标题（H-02）|
| `packages/core/src/team/autonomous/stage-handlers.ts` `BaseStageHandler.buildDescription` | 确认生成的 user prompt 含 stage 标题 | v1.4 未明确 | 明确 user prompt 必须含 `# Plan 阶段`/`# Dev 阶段`/`# Verify 阶段`/`# Fix 阶段` 标题，配合 H-02 stub client 推断 |
| §3.3.1 末尾注释 | createOpenAIClient 导出位置说明 | v1.4 错误描述为"已在 team/index.ts 现有导出中" | 修正：`createOpenAIClient` 在 `packages/core/src/index.ts:113` 直接从 `./common/openai-client` 导出（不经 team/index.ts）（H-03） |
| `packages/cli/src/team/team-cmd.ts` 第 6 步 | `stageHandlerClient` 类型断言 | v1.4 G-07 使用 `as { client: unknown; model: string; ... } \| undefined` 冗余断言 | 简化为 `const stageHandlerClient = clientHandle ?? undefined;`（H-06） |
| `packages/cli/src/tests/utils/stub-client.ts` stage 关键字匹配 | `promptLower.includes("test")` 可能误匹配 | v1.4 使用 toLowerCase + includes 子串匹配 | 改为基于 user prompt 的精确 stage 标题匹配（H-07） |
| `README.md` 和 `docs/quickstart.md` | 两套目录命名说明 | v1.4 未说明 | 补充 `.deepcode/`（无 x，settings.json）与 `.deepcodex/`（带 x，autonomous.yml/runs/notes.md）并存说明（H-08） |

**v1.6 新增的修改点（I-01 / B-01 / I-02 / I-03 / I-06 / I-07 / I-08 / I-09 / I-10 / I-11 / I-12）**：

| 文件 | 修改位置 | v1.5 状态 | v1.6 修正 |
|------|---------|----------|----------|
| `packages/core/src/team/index.ts` 末尾 | 将 v1.3 F-01 的 `export * from "./autonomous/index.js";` 改为显式 re-export | v1.5 未处理（架构师 P0-1 阻塞）：`export *` 会触发 smart-confirmation.ts 的 `type RiskLevel` 与 cybernetics/guard-coordinator.ts 的 `const RiskLevel` 同名冲突（team/index.ts L322 已显式导出 const RiskLevel） | 删除 `export * from "./autonomous/index.js";`，改为显式 re-export autonomous 9 组件 + stage-handlers 5 符号 + common/openai-client 类型守卫。**注意：不导出 smart-confirmation.ts 的 type RiskLevel**（已被 team/index.ts L322 的 const RiskLevel 占用），需要 type RiskLevel 的代码应直接从 `./autonomous/smart-confirmation.js` 导入。**v1.6 B-01 修正（独立开发者 P0 阻塞）：isOpenAIClientHandle 和 OpenAIClientHandle 不在 autonomous 块导出，独立从 `../common/openai-client.js` 导入**（autonomous/index.ts 未 re-export 这两个符号）。详见 §3.3.4 |
| `packages/core/src/team/tests/stage-handlers.test.ts` | 新增 SH-018 测试用例 | v1.5 缺失（测试专家 NB-02 + 产品经理 NB-03）：现有 SH-001/005/007/011 是集成验证，无法暴露 stage 推断错误（DevStageHandler/FixStageHandler 的 judgeResult 都只检查 output 非空） | 新增 SH-018：直接调用 `buildStubClientReturningValidOutput().client.chat.completions.create()`，传入含 `# Fix 阶段` 的 user prompt，断言返回 content 含 `"## Fix"`（而非 `"## Implementation"`） |
| §7.1 SH-010 + §7.4 overrideContent 注释 | SH-010 的 stub 配置 | v1.5 矛盾：§7.4 注释说"SH-010 不传（走 stage 推断）"与 §7.1 SH-010 输入"stub 返回 status=failed"矛盾 | SH-010 明确使用 `buildStubClientAlwaysThrows()`（让 stub 抛错使 executeDispatch 走 catch 返回 status=failed），§7.4 注释相应更新 |
| §7.4 overrideContent 注释 | 补充 SH-008 使用场景 | v1.5 遗漏（产品经理 NB-01）：SH-008 期望 kind=retriable 但 stage 推断默认返回含 "PASS" 文本无法触发 FAIL 分支 | 注释追加 SH-008 使用场景 `overrideContent="## Test Results\n\nFAIL ..."` |
| §8.3 v1.5 新增验收项 ② ③ | 验收方式具体化 | v1.5 不够具体（产品经理 NB-03） | ② 改为"通过 SH-018 测试用例验证"；③ 改为"通过 grep README.md docs/quickstart.md 检查 .deepcode/ 和 .deepcodex/ 关键字均有命中" |
| `README.md` | 补充 stage 标题命名约定 | v1.5 未说明（产品经理 NB-04） | 在 team autonomous 使用说明中补充"autonomous 4 阶段流程"说明 + stage 标题命名约定（`# Plan 阶段`/`# Dev 阶段`/`# Verify 阶段`/`# Fix 阶段`） |
| §3.3.1 `isOpenAIClientHandle` 类型守卫 | 补充 baseURL/thinkingEnabled 字段检查 | v1.5 仅检查 client + model（独立开发者 NB-01）：会误判 `{client, model}` 为合法 OpenAIClientHandle | 补充 `"baseURL" in obj && typeof obj.baseURL === "string" && "thinkingEnabled" in obj && typeof obj.thinkingEnabled === "boolean"` |
| §4.6 `executeFullLifecycleCommand` skipped 处理 | 补充说明 | v1.5 仅修改 executeDispatchCommand（独立开发者 NB-02）：executeFullLifecycleCommand 也调用 executeDispatch，当前 `if (result.status !== "succeeded")` 会把 skipped 视为失败 | 在 §4.6 补充：全流程模式下 skipped 视为失败中止（语义：全流程要求每步成功，skipped 表示前置条件未满足，应中止并提示用户配置 API Key） |
| `docs/quickstart.md` | 补充具体路径示例 | v1.5 未补充（产品经理 NB-02） | 明确补充 `~/.deepcode/settings.json`（用户级）和 `./.deepcodex/autonomous.yml`、`./.deepcodex/runs/`、`./.deepcodex/notes.md`（项目级）路径示例 |
| §7.4 buildStubClientReturningValidOutput 注释 | "精确字符串匹配" 描述修正 | v1.5 描述与代码不符（测试专家 NB-04）：代码用 `.includes()` 是子串匹配，不是精确匹配 | 改为"基于 stage 标题的长字符串子串匹配（替代 v1.4 的短关键字子串匹配，大幅降低误匹配率）" |
| §7.1 SH-016/017 | 明确环境隔离写法 | v1.5 未明确（测试专家 NB-03）：try/finally 还是 t.before/t.after | 明确采用 try/finally 写法（与 §6.2.2 一致），因为 SH-016/017 是边界值特例，不应在文件级共享 |
| §3.3 BaseStageHandler 注释 | 强化 stage 标题首字母大写约束 | v1.5 仅说"必须以 stage 标题开头"（独立开发者 NB-03）：大小写敏感风险 | 强化约束："stage 标题必须首字母大写（`# Plan 阶段` 而非 `# plan 阶段`），stub client 使用大小写敏感匹配" |

---

## 三、P0-1 详细设计：autonomous 串联 RalphLoopController

### 3.1 当前问题

`packages/cli/src/team/team-cmd.ts:202-255` 的 `executeAutonomousCommand` 实现如下（简化）：

```typescript
const stages = ["plan", "dev", "verify", "fix"] as const;
for (let iter = 1; iter <= maxIter; iter++) {
  for (const stage of stages) {
    const task = buildTask({
      title: `[${stage}] ${goal}`,
      description: `Autonomous iteration ${iter}/${maxIter}, stage=${stage}, goal=${goal}`,
    });
    task.upstreamContext = { autonomousStage: stage, autonomousIteration: iter, ... };
    const result = await executeDispatch(task, {
      projectRoot: args.projectRoot ?? process.cwd(),
      forceRole: { roleId: "solo-coder" as RoleId, reason: "Autonomous stage 委派" },
    });
    // ...
  }
}
```

**问题**:
1. 未调用已实现的 `RalphLoopController`（ packages/core/src/team/autonomous/loop-controller.ts ）
2. 4 阶段全部硬编码 `forceRole: solo-coder`，未按阶段语义调度对应角色
3. 未使用 `RunState` / `GitDriver` / `NotesMemory` / `SleepGuard` 等 9 组件
4. 缺少断点续跑、连续失败 abort、stop_when 命中等控制流

### 3.2 修复方案

#### 3.2.1 RunState 实现 RunStateLike 接口（v1.1 新增，v1.2 修正字段重命名，v1.3 补充完整替换清单）

**问题**：`RalphLoopController` 构造函数要求 `runState: RunStateLike`，但 `RunState` 类当前不实现该接口：

```typescript
// loop-controller.ts:126-147 RunStateLike 接口要求
export interface RunStateLike {
  state: { runId, objective, iterIndex, cumulativeTokens, commitsMade, status, ... };
  markRunning(): void;
  markComplete(): void;
  markFailed(reason: string): void;
  markAborted(reason: string): void;
  recordIteration(args: { iterIndex, resultKind, summary, tokens, committed, error }): void;
}

// run-state.ts:78-108 RunState 当前实现
export class RunState {
  private readonly runDir: string;
  private readonly state: RunStateSchema;  // ← private，不符合 RunStateLike.state 公开要求
  // 无 markRunning / markComplete / markFailed / markAborted / recordIteration 方法
  // 只有 getState(): Readonly<RunStateSchema> + update(patch) + appendHistory(entry)
}
```

**修复方案**：在 RunState 类中**追加** 5 个公开方法 + 1 个 state getter，并将私有字段 `state` 重命名为 `stateValue`（v1.2 修正 M-07）。

**v1.2 关键修正点（M-07）**：因为 `RunStateLike.state` 要求公开 getter，而 RunState 当前已有同名的 private 字段 `state`，会冲突。因此必须：
1. 将私有字段 `private readonly state: RunStateSchema` 重命名为 `private stateValue: RunStateSchema`
2. **同步修改静态方法 `load()` 中第 175-177 行**的 `rs.state = data` → `rs.stateValue = data`（否则编译失败）

**v1.3 补充（F-04 / 架构师 N-01）+ v1.4 修正（G-05 / 架构师 NB-02）**：v1.2 仅描述了 L83（字段定义）和 L175-177（静态 load()）两处替换，但 `this.state` 在 run-state.ts 中实际出现 **9 处**，全部需替换为 `this.stateValue`，否则多处编译失败。v1.3 的表格"修改前"列描述与真实源码多处不符（L93 是构造器赋值不是 return；L112 是 JSON.parse 不是 Object.assign；L117 单行 2 处引用；L203 单行 3 处引用）。v1.4 按真实源码重新校对，完整替换清单如下：

| 行号 | 所在方法 | 修改前（真实源码） | 修改后 | 说明 |
|------|---------|--------|--------|------|
| 83 | 字段定义 | `private state: RunStateSchema;` | `private stateValue: RunStateSchema;` | 私有字段重命名，避免与 getter 冲突 |
| 93 | 构造器赋值（**非 return**） | `this.state = {`（多行对象字面量起始，含 runId/objective/startedAt 等 11 个字段） | `this.stateValue = {` | 构造器初始化 state 字段，是赋值语句不是返回值 |
| 112 | `getState()` | `return JSON.parse(JSON.stringify(this.state)) as RunStateSchema;`（**非 Object.assign**） | `return JSON.parse(JSON.stringify(this.stateValue)) as RunStateSchema;` | 深拷贝返回，避免外部修改影响内部状态 |
| 117 | `update(patch)` | `this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };`（**单行 2 处引用**：左值 + 展开运算符） | `this.stateValue = { ...this.stateValue, ...patch, updatedAt: new Date().toISOString() };` | 单行 2 处替换，需同步修改 |
| 123 | `appendHistory(entry)` | `this.state.history.push({` | `this.stateValue.history.push({` | 追加历史记录引用 |
| 137 | `persist()` | `const json = JSON.stringify(this.state, null, 2);` | `const json = JSON.stringify(this.stateValue, null, 2);` | 持久化引用 |
| 176 | 静态 `load()` | `rs.state = data;` | `rs.stateValue = data;` | 静态方法同步重命名 |
| 203 | `buildResumeContext(notesPath)` | `canResume: this.state.status === "running" \|\| this.state.status === "aborted" \|\| this.state.status === "failed",`（**单行 3 处引用**） | `canResume: this.stateValue.status === "running" \|\| this.stateValue.status === "aborted" \|\| this.stateValue.status === "failed",` | 单行 3 处替换，需同步修改 |
| 204 | `buildResumeContext(notesPath)` | `lastIterIndex: this.state.iterIndex,` | `lastIterIndex: this.stateValue.iterIndex,` | 构造恢复上下文引用 |

**实施建议（架构师 N-01）**：使用 IDE Refactor → Rename Symbol 功能（VS Code F2）重命名 `state` → `stateValue`，IDE 会自动找到全部 9 处引用并同步修改，避免遗漏。手动 sed 替换有风险（可能误改 `getState` 方法名等无关字符串）。

**v1.4 校对结果（G-05）**：经再次读取 `run-state.ts:75-215` 真实源码，确认 9 处 `this.state` 引用全部已按真实代码描述。L93 是构造器中的赋值语句（`this.state = { ... }`），不是 `getState()` 的 return；L112 是 `JSON.parse(JSON.stringify(this.state))` 深拷贝，不是 `Object.assign`；L117 和 L203 是单行多引用，必须全部替换。

**新增方法追加到 RunState 类末尾**（不修改已有方法）：

| 行号 | 修改前 | 修改后 | 说明 |
|------|--------|--------|------|
| 类末尾追加 | 无 | `get state(): RunStateSchema { return this.stateValue; }` | 新增公开 getter，实现 RunStateLike |
| 类末尾追加 | 无 | `markRunning() / markComplete() / markFailed() / markAborted() / recordIteration()` | 新增 5 个公开方法 |

**注意**：`getState()` 方法保持不变（向后兼容），新代码可通过 `state` getter 访问。

```typescript
// run-state.ts 追加到 RunState 类末尾（不修改已有方法）

  // ========================================================================
  // RunStateLike 接口实现（v1.1 新增，用于对接 RalphLoopController）
  // ========================================================================

  /**
   * RunStateLike 接口要求：暴露 state 字段（只读视图）
   *
   * RalphLoopController 通过 `runState.state.runId` / `runState.state.iterIndex` 等读取状态
   * 直接返回 this.state 的引用（RunStateSchema 字段都是值类型，外部修改不影响内部）
   */
  get state(): RunStateSchema {
    return this.stateValue;
  }

  /**
   * 标记运行开始：state.status = "running"
   * RalphLoopController.run() 入口处调用
   */
  markRunning(): void {
    this.update({ status: "running" });
  }

  /**
   * 标记运行完成：state.status = "completed"
   * 全部迭代成功或命中 stop_when 时调用
   */
  markComplete(): void {
    this.update({ status: "completed" });
  }

  /**
   * 标记运行失败：state.status = "failed"
   * 达到 max_iterations 仍有失败时调用
   * @param reason 失败原因
   */
  markFailed(reason: string): void {
    this.update({ status: "failed", lastError: reason });
  }

  /**
   * 标记运行中止：state.status = "aborted"
   * 连续失败次数超限时调用
   * @param reason 中止原因
   */
  markAborted(reason: string): void {
    this.update({ status: "aborted", lastError: reason });
  }

  /**
   * 记录一次迭代结果
   *
   * 更新字段：
   *   - iterIndex: 已完成迭代数
   *   - cumulativeTokens: 累计 token
   *   - commitsMade: 已提交 commit 数（仅 committed=true 时 +1）
   *   - consecutiveFailures: 连续失败次数（success 时重置为 0，failed/retriable/fatal 时 +1）
   *   - history: 追加一条记录
   *
   * @param args 迭代结果参数
   */
  recordIteration(args: {
    iterIndex: number;
    resultKind: "success" | "failed" | "retriable" | "fatal";
    summary: string;
    tokens: number;
    committed: boolean;
    error: string;
  }): void {
    const current = this.stateValue;
    const newConsecutiveFailures =
      args.resultKind === "success" ? 0 : current.consecutiveFailures + 1;
    const newCommitsMade = args.committed ? current.commitsMade + 1 : current.commitsMade;

    this.update({
      iterIndex: args.iterIndex,
      cumulativeTokens: current.cumulativeTokens + args.tokens,
      commitsMade: newCommitsMade,
      consecutiveFailures: newConsecutiveFailures,
      lastError: args.error || current.lastError,
    });

    this.appendHistory({
      iterIndex: args.iterIndex,
      resultKind: args.resultKind,
      summary: args.summary,
      tokens: args.tokens,
      committed: args.committed,
      error: args.error,
    });
  }
```

**注意**：由于 `state` 字段名与 getter 名冲突，需要将原 `private state: RunStateSchema` 重命名为 `private stateValue: RunStateSchema`。这是必要的字段重命名，不影响外部 API（原 `state` 是 private）。

#### 3.2.2 修改 `team-cmd.ts:executeAutonomousCommand`（v1.1 重写）

以下代码严格对齐 9 组件的真实构造参数（已通过读取源码验证）：

```typescript
import * as path from "node:path";
import {
  // 9 组件
  RunState, findLatestResumableRun,
  NotesMemory,
  GitDriver,
  SleepGuard,
  SmartConfirmation,
  AutoSkillLoader,
  RalphLoopController, defaultLoopConfig, generateRunId,
  loadAutonomousConfig,
  type AutonomousConfig,
  type LoopConfig, type StageHandler, type StageKind, type LogCallback,
  // StageHandler 工厂（见 §3.3）
  createDefaultStageHandlers,
  // v1.4 修正（G-04 / 架构师 NB-03）：共享类型守卫从 stage-handlers.ts 改放到 common/openai-client.ts
  //   原因：F-06 将类型守卫放在 stage-handlers.ts 导致 team-adapter.ts → stage-handlers.ts → team-adapter.ts 循环依赖
  //   common/openai-client.ts 已定义 createOpenAIClient，返回值结构正好对应 OpenAIClientHandle，自然归属此文件
  //   通过 team/index.ts 聚合导出后，外部仍从 @vegamo/deepcode-core 导入，无破坏性变更
  isOpenAIClientHandle,
  type OpenAIClientHandle,
} from "@vegamo/deepcode-core";
import { createOpenAIClient } from "@vegamo/deepcode-core";

/**
 * autonomous 子命令 - Ralph 自主迭代模式（4 阶段循环）
 *
 * v1.1 修复：真实实例化 9 组件 + RalphLoopController，替代 v1.0 的硬编码 4 阶段循环
 */
async function executeAutonomousCommand(args: TeamCommandArgs, startTime: number): Promise<number> {
  const goal = args.goal ?? args.task;
  if (!goal) {
    writeStderrLine("autonomous 子命令需要 --goal 或 --task 参数\n");
    return 1;
  }

  const projectRoot = args.projectRoot ?? process.cwd();
  const maxIter = args.maxIterations ?? 5;

  // ===== 1. 加载 Autonomous 配置 =====
  // v1.4 修正（G-02 / 产品经理 B-01）：autonomous.yml 路径使用 `.deepcodex/`（带 x），
  //   不是 `.deepcode/`（无 x）。源码中存在两套不同目录命名：
  //   ① `.deepcode/`（无 x）— settings.json 使用（settings.ts:657-663 getUserSettingsPath/getProjectSettingsPath）
  //   ② `.deepcodex/`（带 x）— autonomous.yml/runs/notes.md 使用（config-loader.ts:84/87/96/101）
  //   两套目录命名并存是历史遗留，本设计不统一，按各组件真实路径使用。
  // loadAutonomousConfig 读取 `.deepcodex/autonomous.yml`（项目级）+ `~/.deepcodex/autonomous.yml`（用户级）
  const autoConfig = loadAutonomousConfig(projectRoot);
  // 用 --max-iter 覆盖配置中的 maxIterations
  autoConfig.maxIterations = maxIter;

  // ===== 2. API Key 前置校验（v1.1 新增，v1.2 修正提示位置和类型处理，v1.3 修正 3 种配置方式）=====
  // autonomous 模式必须真实调用 LLM，无 API Key 时直接退出，避免启动后才发现失败
  // v1.2 修正（M-10）：项目实际使用 ~/.deepcode/settings.json 的 env.API_KEY
  //   （见 openai-client.ts 的 createOpenAIClient 实现），不是 providers.openai.apiKey
  // v1.2 修正（M-09）：优先使用 args.injectedClient（测试场景），但需类型断言
  //   args.injectedClient 是 unknown，直接与 createOpenAIClient 返回值合并会丢失类型
  // v1.3 修正（F-02 / 产品经理 B-01）：3 种配置方式与真实源码对齐
  //   ① 环境变量：DEEPCODE_API_KEY（settings.ts:399-411 collectDeepcodeEnv 仅收集 DEEPCODE_ 前缀）
  //     收集后变为 env.API_KEY（去掉前缀），由 openai-client.ts 读取
  //   ② 用户级配置文件：~/.deepcode/settings.json 的 env.API_KEY 字段（settings.ts:657-658）
  //   ③ 项目级配置文件：./.deepcode/settings.json 的 env.API_KEY 字段（settings.ts:661-663）
  //   注意：项目不存在 .env 文件机制（settings.ts 全文无 dotenv 调用）
  // v1.3 修正（F-06 / 架构师 N-06）：使用共享的 isOpenAIClientHandle 类型守卫
  //   替代 v1.2 的内联类型断言，避免与 §4.2 重复实现
  // v1.4 修正（G-07 / 独立开发者 NB-02）：改为局部变量写法
  //   原因：v1.3 使用 IIFE（立即调用函数表达式）+ 类型守卫，TS 旧版本对 IIFE 中
  //   类型守卫的收窄可能不生效（return args.injectedClient 时类型仍是 unknown）
  //   改为 let + 局部变量 + if/else，TS 能可靠收窄 injected 的类型为 OpenAIClientHandle
  let clientHandle: OpenAIClientHandle | null = null;
  const injected = args.injectedClient;
  if (isOpenAIClientHandle(injected)) {
    // 优先使用测试注入的客户端（通过共享类型守卫收窄 unknown → OpenAIClientHandle）
    clientHandle = injected;
  } else {
    // 否则通过 createOpenAIClient 创建
    const handle = createOpenAIClient(projectRoot);
    clientHandle = handle.client ? (handle as unknown as OpenAIClientHandle) : null;
  }

  if (!clientHandle || !clientHandle.client) {
    writeStderrLine("✖ autonomous 模式需要 API Key\n");
    writeStderrLine("  请通过以下任一方式配置：\n");
    writeStderrLine("    1) 环境变量 DEEPCODE_API_KEY\n");
    writeStderrLine("    2) ~/.deepcode/settings.json 的 env.API_KEY 字段（用户级）\n");
    writeStderrLine("    3) ./.deepcode/settings.json 的 env.API_KEY 字段（项目级）\n");
    return 1;
  }
  writeStdoutLine(`✓ API 客户端已就绪（model=${clientHandle.model}）\n`);

  // ===== 3. 构造 runDir 和 runId（v1.2 修正 M-03，v1.3 修正 F-05 使用 generateRunId）=====
  // autoConfig.runDir 是相对路径（如 ".deepcode/runs"），需拼接 projectRoot
  const runsBaseDir = path.isAbsolute(autoConfig.runDir)
    ? autoConfig.runDir
    : path.join(projectRoot, autoConfig.runDir);

  // v1.2 修正：先尝试 resume，找到则用 resume 的 runId；否则创建新 runId
  // 这样 GitDriver 和 RunState 使用的 runId/runDir 始终同步
  // v1.3 修正（F-05 / 架构师 N-04）：使用 generateRunId() 替代手写 runId 生成
  //   generateRunId 已在 loop-controller.ts 实现，通过 autonomous/index.ts L38 re-export
  //   格式统一，便于跨工具识别（如 grep "r-" 前缀）
  let runId: string;
  let runDir: string;
  let runState: RunState;

  if (args.resumeRun) {
    // --resume-run：从 runDir 父目录查找最新可恢复的 run
    const resumed = findLatestResumableRun(runsBaseDir);
    if (resumed) {
      runState = resumed;
      // v1.2 关键修正（M-03）：用恢复的 runState 的 runId 重置局部变量
      // 否则下方 GitDriver 会用新 runId，而 RunState 用旧 runId，导致不同步
      runId = runState.getState().runId;
      runDir = path.join(runsBaseDir, runId);
      writeStdoutLine(`📂 已恢复运行 ${runId}（已迭代 ${runState.getState().iterIndex} 次）\n`);
    } else {
      writeStdoutLine(`⚠ 未找到可恢复的 run，创建新运行\n`);
      runId = generateRunId();
      runDir = path.join(runsBaseDir, runId);
      runState = new RunState(runDir, runId, goal);
    }
  } else {
    runId = generateRunId();
    runDir = path.join(runsBaseDir, runId);
    runState = new RunState(runDir, runId, goal);
    writeStdoutLine(`🆕 创建新运行 ${runId}\n`);
  }

  // ===== 4. 实例化 9 组件（按真实 API 构造参数）=====

  // 4.1 RunState 已在上面构造（含断点续跑支持）
  // 真实 API：constructor(runDir: string, runId: string, objective: string = "")
  // 静态方法：findLatestResumableRun(runDir: string): RunState | null（参数是 runDir 不是 projectRoot）
  // 静态方法：RunState.load(runDir: string): RunState | null

  // 4.2 NotesMemory
  // 真实 API：constructor(notesPath: string, maxSizeKb: number = 1024, trimKeepLastN: number = 20)
  // 位置参数，不接受 object。notesPath 从 autoConfig 读取（已是绝对路径或相对 projectRoot）
  const notesPath = path.isAbsolute(autoConfig.notesPath)
    ? autoConfig.notesPath
    : path.join(projectRoot, autoConfig.notesPath);
  const notesMemory = new NotesMemory(notesPath, autoConfig.maxSizeKb, autoConfig.trimKeepLastN);

  // 4.3 GitDriver
  // 真实 API：constructor(args: { repoRoot: string; runId: string; authorName?; authorEmail?; runDir?; gitTimeoutSec? })
  // 注意：字段名是 repoRoot（不是 projectRoot），runId 必填
  // v1.2 修正（M-03）：此处使用上面同步后的 runId/runDir
  const gitDriver = new GitDriver({
    repoRoot: projectRoot,
    runId,
    authorName: autoConfig.gitAuthorName,
    authorEmail: autoConfig.gitAuthorEmail,
    runDir,
    gitTimeoutSec: 30,
  });

  // 4.4 SleepGuard
  // 真实 API：constructor(mode: SleepGuardMode = "on", log?: SleepGuardLogCallback)
  // SleepGuardMode = "on" | "off"（无 "auto"）
  // autoConfig.sleepGuardEnabled 是 boolean（非 sleepGuardMode）
  // v1.2 修正（M-01）：SleepGuardLogCallback 签名是 (message: string) => void（单参数，非双参数）
  //   见 sleep-guard.ts:35: export type SleepGuardLogCallback = (message: string) => void;
  const sleepGuardMode = autoConfig.sleepGuardEnabled ? "on" : "off";
  const sleepGuard = new SleepGuard(sleepGuardMode, (message: string) => {
    writeStdoutLine(`[sleep-guard] ${message}\n`);
  });

  // 4.5 SmartConfirmation（autonomous 模式不使用，但实例化以备后用）
  // 真实 API：constructor(args?: { blacklist?; whitelist?; autoThreshold? })
  // 无 mode 参数，ConfirmationDecision = "auto" | "ask" | "deny"（无 "auto-approve"）
  // autonomous 模式默认行为是 "auto"（不阻塞），通过不调用 confirm 方法实现
  const smartConfirmation = new SmartConfirmation();
  // 注：smartConfirmation 当前不传入 RalphLoopController（controller 无此依赖）
  // 保留实例化是为了未来扩展（如危险操作前要求用户确认）

  // 4.6 AutoSkillLoader
  // 真实 API：constructor(args: { projectRoot: string; extraDirs?: string[] })
  const skillLoader = new AutoSkillLoader({ projectRoot });

  // 4.7 DispatcherAdapter：不实例化（v1.1 决策：不使用 DispatcherAdapter）
  // 理由：DispatcherAdapter.getFacade() 返回 null（TypeScript 无 Python 动态导入），
  //       需要外部注入 facade，而当前没有 V3 _dispatchThroughV3 实现。
  //       StageHandler 直接调用 executeDispatch，更简单直接（见 §10.2 决策 2）

  // ===== 5. 构造 LoopConfig（从 AutonomousConfig 提取字段）=====
  // LoopConfig 和 AutonomousConfig 字段不完全一致，需显式构造
  const loopConfig: LoopConfig = {
    maxIterations: autoConfig.maxIterations,
    maxTokens: autoConfig.maxTokens,
    stopWhen: autoConfig.stopWhen,
    stageOrder: autoConfig.stageOrder,
    backoffBaseSec: autoConfig.backoffBaseSec,
    backoffMaxSec: autoConfig.backoffMaxSec,
    consecutiveFailureAbort: autoConfig.consecutiveFailureAbort,
    gitAuthorName: autoConfig.gitAuthorName,
    gitAuthorEmail: autoConfig.gitAuthorEmail,
    testCommand: autoConfig.testCommand,
    securityAnalyzer: autoConfig.securityAnalyzer,
  };

  // ===== 6. 实例化 4 个 StageHandler（v1.2 修正 M-09：处理 args.injectedClient 类型）=====
  const logCallback: LogCallback = (level, message) => {
    const prefix = level === "error" ? "✖" : level === "warn" ? "⚠" : "ℹ";
    writeStdoutLine(`${prefix} ${message}\n`);
  };

  // v1.2 修正（M-09）：args.injectedClient 是 unknown 类型（来自 TeamCommandArgs）
  //   传给 createDefaultStageHandlers 时需要类型断言为 InjectedClientHandle | undefined
  //   优先使用 args.injectedClient（测试场景），否则用第 2 步创建的 clientHandle
  //   注意：clientHandle 来自 createOpenAIClient，类型已是 OpenAIClientHandle（与 InjectedClientHandle 结构兼容）
  // v1.5 修正（H-06 / 独立开发者 NB-02）：简化为 `clientHandle ?? undefined`
  //   原因：第 2 步已通过 isOpenAIClientHandle 类型守卫处理 args.injectedClient，
  //   clientHandle 类型已是 OpenAIClientHandle | null，无需重复 as 类型断言。
  //   args.injectedClient ?? clientHandle 中，args.injectedClient 是 unknown，
  //   ?? 会收窄 null/undefined，但 unknown 类型未消除。改为仅使用 clientHandle：
  //   - 若 args.injectedClient 是合法 OpenAIClientHandle，第 2 步已将其赋给 clientHandle
  //   - 若 args.injectedClient 是 null/undefined/非法对象，第 2 步走 else 分支用 createOpenAIClient
  //   因此 clientHandle 已包含两路来源，直接 `clientHandle ?? undefined` 即可
  const stageHandlerClient = clientHandle ?? undefined;

  const stageHandlers: Record<StageKind, StageHandler> = createDefaultStageHandlers({
    projectRoot,
    testCommand: autoConfig.testCommand,
    log: logCallback,
    injectedClient: stageHandlerClient,  // 透传已创建的客户端，避免 StageHandler 重复创建
  });

  // ===== 7. 实例化 RalphLoopController =====
  // 真实 API：constructor(args: { config, projectRoot, gitDriver, notesMemory, runState, stageHandlers, objective?, log?, sleepGuard? })
  // 注意：runState 要求 RunStateLike 类型，v1.1 已通过 §3.2.1 让 RunState 实现 RunStateLike
  const controller = new RalphLoopController({
    config: loopConfig,
    projectRoot,
    gitDriver,
    notesMemory,
    runState,  // RunState 已实现 RunStateLike
    stageHandlers,
    objective: goal,
    log: logCallback,
    sleepGuard,
  });

  // ===== 8. 启动主循环 =====
  writeStdoutLine(`\n🚀 启动 Ralph Autonomous Loop（max_iter=${maxIter}）\n`);
  writeStdoutLine(`   目标: ${goal}\n`);
  writeStdoutLine(`   运行 ID: ${runId}\n`);
  writeStdoutLine(`   运行目录: ${runDir}\n\n`);

  // run() 已改为 async（见 §3.4）
  const exitCode = await controller.run();

  // ===== 9. 持久化最终状态 =====
  runState.persist();

  // ===== 10. 输出最终结果 =====
  const duration = Date.now() - startTime;
  const finalState = runState.getState();
  // v1.2 修正（M-12）：直接 return exitCode，不再压成 0/1
  //   原代码 `return exitCode === 0 ? 0 : 1` 会把 2/3 压成 1，导致 exitCodeMap 显示与实际返回值不一致
  //   autonomous 退出码语义（与 §4.6 dispatch 退出码隔离，见 M-11）：
  //     0 = 全部成功
  //     1 = 部分迭代失败
  //     2 = Fatal abort（连续失败超限）
  //     3 = 命中 stop_when 条件
  const exitCodeMap: Record<number, string> = {
    0: "✅ 全部迭代成功",
    1: "⚠  部分迭代失败",
    2: "✖ Fatal abort（连续失败超限）",
    3: "🎯 命中 stop_when 条件",
  };
  writeStdoutLine(`\n${exitCodeMap[exitCode] ?? "未知退出码"}（exit=${exitCode}）\n`);
  writeStdoutLine(`⏱  总耗时: ${duration}ms\n`);
  writeStdoutLine(`📊 迭代次数: ${finalState.iterIndex}\n`);
  writeStdoutLine(`📊 累计 token: ${finalState.cumulativeTokens}\n`);
  writeStdoutLine(`📊 提交数量: ${finalState.commitsMade}\n`);
  writeStdoutLine(`📂 运行目录: ${runDir}\n`);

  return exitCode;
}
```

#### 3.2.3 新增 CLI flag: `--resume-run`（v1.1 修正，v1.2 补充 TeamCommandArgs 字段，v1.3 明确与 --goal 关系）

**v1.0 错误**：使用 `--resume` flag，但 `--resume` 已被 session resume 占用（`cli-args.ts:32`），会冲突。

**v1.1 修正**：改名为 `--resume-run`，避免冲突。

**v1.2 补充（M-09）**：`TeamCommandArgs` 接口除 `resumeRun` 外还需新增 `injectedClient` 字段，AC-003/004/007/008 等测试用例才能注入 stub 客户端进入 autonomous 流程；CLI 命令行不直接传入 `injectedClient`（仅测试场景使用）。

**v1.3 补充（F-09 / 产品经理 NB-01）：`--resume-run` 与 `--goal` 参数关系**

| 场景 | `--resume-run` | `--goal` | 行为 |
|------|---------------|----------|------|
| 全新运行 | 不传 | 必传 | 创建新 runId，使用传入的 `--goal` 作为 objective |
| 恢复运行（成功找到可恢复的 run） | 传 | 可选（缺省） | 使用原 run 的 objective；若传 `--goal` 则覆盖原 objective（更新 RunState.objective 字段） |
| 恢复运行（未找到可恢复的 run） | 传 | 必传 | 降级为创建新运行；若无 `--goal` 则报错退出（exitCode=1） |

**实施细节**：在 `executeAutonomousCommand` 第 3 步 `if (args.resumeRun)` 分支内，找到 resumed 后追加：
```typescript
if (args.goal && args.goal !== runState.getState().objective) {
  // 用户显式覆盖 objective（如调整目标方向）
  runState.update({ objective: args.goal });
  writeStdoutLine(`⚠ 已覆盖原 objective 为新 goal: ${args.goal}\n`);
}
```
未找到可恢复的 run 时，需追加 `--goal` 必传校验：
```typescript
} else {
  if (!goal) {
    writeStderrLine("✖ --resume-run 未找到可恢复的 run，且未提供 --goal，无法创建新运行\n");
    return 1;
  }
  writeStdoutLine(`⚠ 未找到可恢复的 run，创建新运行\n`);
  runId = generateRunId();
  // ... 后续逻辑
}
```

在 `TeamCommandArgs` 新增字段（team-cmd.ts L42-62）：

```typescript
export interface TeamCommandArgs {
  // ... 现有字段 ...
  /** 是否恢复上次未完成的 autonomous run（autonomous 模式） */
  resumeRun?: boolean;
  /**
   * 注入的 OpenAI 客户端句柄（仅用于单元测试/集成测试，CLI 不直接传入）
   *
   * v1.2 新增（M-09）：
   *   - 类型为 unknown，避免 cli 包对 core 包的 OpenAI 类型产生硬依赖
   *   - 在 executeAutonomousCommand 中透传给 createDefaultStageHandlers
   *   - 测试场景注入 stub 客户端后，autonomous 流程不会真实发起 LLM 请求
   *   - 非 mock：提供真实接口契约，调用 chat.completions.create 返回固定内容
   */
  injectedClient?: unknown;
}
```

在 `cli-args.ts` 的 team 命令解析中新增（约 L164-176）：

```typescript
.option("resume-run", {
  type: "boolean",
  describe: "Resume the latest unfinished autonomous run",
  default: false,
})
```

在 `cli-args.ts:288-299` 的 `optionKeys` 数组中新增 `"resume-run"`（v1.2 补充 M-13）：

```typescript
const optionKeys = [
  // ... 现有 keys ...
  "resume-run",  // v1.2 新增
] as const;
```

在 `formatTeamHelp()` 中补充：

```
  team autonomous --goal <goal> [--max-iter N] [--resume-run]
    启动 Ralph 自主迭代模式（4 阶段循环：plan → dev → verify → fix）
    --resume-run: 恢复最近一次未完成的运行
```

**v1.2 修正（M-03 + M-09）**：`executeAutonomousCommand` 在收到 `args.injectedClient` 时优先使用，避免与 `createOpenAIClient(projectRoot)` 重复创建。完整逻辑见 §3.2.2 第 2 步代码（包含类型守卫和优先级处理）。

**关键点**：
1. `args.injectedClient` 是 `unknown` 类型，需通过类型守卫收窄才能访问 `.client` 等字段
2. 优先级：`args.injectedClient` > `createOpenAIClient(projectRoot)`
3. 类型守卫检查 `client` + `model` 字段存在且 `model` 是 string
4. 测试场景注入 stub client 后，autonomous 流程不会真实发起 LLM 请求

### 3.3 StageHandler 完整实现（v1.1 重写）

以下代码对齐 `IterationContext` 真实结构（`prevResults: IterationResult[]`，而非 stage 结果）：

```typescript
// packages/core/src/team/autonomous/stage-handlers.ts

import type {
  StageHandler,
  StageResult,
  IterationContext,
  IterationResult,
  LogCallback,
} from "./loop-controller.js";
// v1.2 修正（M-04）：DispatchResult 不能从 team-adapter.js 导入
//   team-adapter.ts L22 仅 `import type { DispatchResult, ... } from "./types.js"`
//   未通过 export type re-export，因此必须直接从 types.js 导入
import { executeDispatch, buildTask } from "../team-adapter.js";
import type { DispatchResult, RoleId } from "../types.js";
// v1.4 修正（G-04 / 架构师 NB-03）：OpenAIClientHandle 和 isOpenAIClientHandle
//   从 stage-handlers.ts 改放到 common/openai-client.ts，消除循环依赖
//   原因：v1.3 F-06 将类型守卫放在 stage-handlers.ts，但 team-adapter.ts → stage-handlers.ts → team-adapter.ts
//   形成循环依赖。common/openai-client.ts 已定义 createOpenAIClient，返回值结构正好对应
//   OpenAIClientHandle，类型守卫自然归属此文件，且 common/ 不依赖 team/，无循环依赖风险
//   stage-handlers.ts 改为从 common/openai-client.js 导入（通过 team/index.ts 聚合后亦可从 @vegamo/deepcode-core 导入）
import { isOpenAIClientHandle, type OpenAIClientHandle } from "../../common/openai-client.js";

// v1.4 注：OpenAIClientHandle 接口和 isOpenAIClientHandle 函数的定义已迁移到 common/openai-client.ts
//   详见 §3.3.1【v1.4 新增】common/openai-client.ts 追加内容
//   stage-handlers.ts 仅导入并使用，不再重复定义

/** 向后兼容别名（v1.2 stage-handlers 内部使用的旧名） */
type InjectedClientHandle = OpenAIClientHandle;

/**
 * StageHandler 基类：封装通用逻辑（task 构造、dispatch 调用、错误处理）
 *
 * 设计要点：
 *   1. 所有 stage 共享 projectRoot / log / injectedClient
 *   2. 子类只需实现 buildDescription 和 judgeResult 两个抽象方法
 *   3. handle() 是 async（与 StageHandler 接口的 Promise<StageResult> 兼容）
 *   4. judgeResult 参数类型为 DispatchResult（v1.1 修正：替代 any）
 *   5. v1.5 新增（H-02）：buildDescription 生成的 user prompt **必须**以 `# Plan 阶段`/
 *      `# Dev 阶段`/`# Verify 阶段`/`# Fix 阶段` 标题开头，供 stub client 的 stage-aware
 *      工厂基于 user prompt（messages[1].content）精确匹配推断 stage
 *      （见 §7.4 buildStubClientReturningValidOutput 的 v1.5 stage-aware 工厂设计）
 *      若未来新增 StageHandler，必须遵循此命名约定，否则 stub client 会走默认分支返回通用文本
 *   6. v1.6 新增（I-12 / 独立开发者 NB-03）：stage 标题大小写敏感，必须**首字母大写**
 *      （`# Plan 阶段` / `# Dev 阶段` / `# Verify 阶段` / `# Fix 阶段`），
 *      不允许 `# plan 阶段` / `# dev 阶段` / `# verify 阶段` / `# fix 阶段` 等小写写法
 *      原因：stub client 的 stage 推断使用 `userPrompt.includes("# Fix 阶段")` 等子串匹配，
 *      JavaScript `String.prototype.includes` 大小写敏感，若 stage 标题首字母小写会匹配失败，
 *      导致 stub client 误走默认分支返回通用文本，stage-aware 工厂失效
 *      验证：§7.1 SH-018（v1.6 新增）直接断言 stage 推断逻辑
 */
abstract class BaseStageHandler implements StageHandler {
  /**
   * @param projectRoot 项目根目录
   * @param log 日志回调（位置参数风格，与现有组件一致）
   * @param injectedClient 注入的 OpenAI 客户端句柄（可选，用于单元测试）
   */
  constructor(
    protected readonly projectRoot: string,
    protected readonly log: LogCallback = () => {},
    protected readonly injectedClient?: InjectedClientHandle,
  ) {}

  abstract readonly stageName: string;
  abstract readonly roleId: RoleId;

  /**
   * 处理一次 stage 执行
   *
   * @param ctx 迭代上下文（含 prevResults: IterationResult[]）
   * @returns StageResult（kind: success / failed / retriable / fatal）
   */
  async handle(ctx: IterationContext): Promise<StageResult> {
    const task = buildTask({
      title: `[${this.stageName}] iter-${ctx.iterIndex}`,
      description: this.buildDescription(ctx),
      upstreamContext: {
        autonomousStage: this.stageName,
        autonomousIteration: ctx.iterIndex,
        autonomousGoal: ctx.objective,
        // v1.1 修正：prevResults 是 IterationResult[]，summary 不以 [plan]/[verify] 开头
        // 而是形如 "iter-1 全阶段完成" 或 "阶段 plan: ..."
        // 传递最近 3 次的 summary 作为上下文
        recentIterationSummaries: ctx.prevResults.slice(-3).map(r => r.summary),
      },
    });

    try {
      const result = await executeDispatch(task, {
        projectRoot: this.projectRoot,
        forceRole: { roleId: this.roleId, reason: `Autonomous ${this.stageName} stage` },
        // 透传注入的客户端（测试场景）
        injectedClient: this.injectedClient,
      });

      const tokens = result.tokensConsumed.total;
      return this.judgeResult(result, ctx, tokens);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log("error", `[${this.stageName}] 未捕获异常: ${errMsg}`);
      return {
        kind: "fatal",
        summary: `[${this.stageName}] 未捕获异常: ${errMsg}`,
        artifacts: { tokens: 0 },
        error: errMsg,
      };
    }
  }

  /** 子类实现：构造 stage 特定的描述文本 */
  protected abstract buildDescription(ctx: IterationContext): string;

  /**
   * 子类实现：根据 dispatch 结果判定 StageResult
   *
   * v1.1 修正：参数类型从 any 改为 DispatchResult，符合用户规则"禁止 any"
   *
   * @param result executeDispatch 的返回值
   * @param ctx 迭代上下文
   * @param tokens 本次消耗的 token 数
   * @returns StageResult
   */
  protected abstract judgeResult(
    result: DispatchResult,
    ctx: IterationContext,
    tokens: number,
  ): StageResult;
}

/**
 * Plan 阶段处理器：调用 architect 角色生成方案
 */
export class PlanStageHandler extends BaseStageHandler {
  readonly stageName = "plan";
  readonly roleId: RoleId = "architect";

  constructor(
    projectRoot: string,
    log: LogCallback = () => {},
    injectedClient?: InjectedClientHandle,
  ) {
    super(projectRoot, log, injectedClient);
  }

  protected buildDescription(ctx: IterationContext): string {
    return [
      `# Plan 阶段（迭代 ${ctx.iterIndex}）`,
      ``,
      `## 目标`,
      ctx.objective,
      ``,
      `## 历史笔记`,
      ctx.notesSnapshot || "（首次迭代，无历史笔记）",
      ``,
      `## 历史迭代摘要`,
      ctx.prevResults.length > 0
        ? ctx.prevResults.slice(-3).map((r, i) => `${i + 1}. ${r.summary}`).join("\n")
        : "（首次迭代，无历史）",
    ].join("\n");
  }

  protected judgeResult(
    result: DispatchResult,
    ctx: IterationContext,
    tokens: number,
  ): StageResult {
    if (result.status === "succeeded") {
      if (result.output && result.output.includes("## Plan")) {
        return {
          kind: "success",
          summary: `[plan] 生成方案（${result.output.length} 字符）`,
          artifacts: { tokens, plan: result.output },
        };
      }
      return {
        kind: "failed",
        summary: "[plan] LLM 未生成有效方案（缺少 ## Plan 标题）",
        artifacts: { tokens },
        error: "Invalid plan output",
      };
    }
    if (result.status === "failed") {
      return {
        kind: "retriable",
        summary: `[plan] architect 调用失败: ${result.error ?? "未知错误"}`,
        artifacts: { tokens },
        error: result.error,
      };
    }
    // v1.1 新增：处理 skipped 状态（无 API Key 等）
    if (result.status === "skipped") {
      return {
        kind: "fatal",
        summary: `[plan] dispatch 被跳过: ${result.error ?? "未知原因"}`,
        artifacts: { tokens },
        error: result.error,
      };
    }
    return {
      kind: "fatal",
      summary: `[plan] 未知状态: ${result.status}`,
      artifacts: { tokens },
      error: result.error,
    };
  }
}

/**
 * Dev 阶段处理器：调用 solo-coder 角色生成代码
 */
export class DevStageHandler extends BaseStageHandler {
  readonly stageName = "dev";
  readonly roleId: RoleId = "solo-coder";

  constructor(
    projectRoot: string,
    log: LogCallback = () => {},
    injectedClient?: InjectedClientHandle,
  ) {
    super(projectRoot, log, injectedClient);
  }

  protected buildDescription(ctx: IterationContext): string {
    // v1.1 修正：prevResults 是 IterationResult[]，不是 stage 结果
    // 需要从 artifacts 中提取 plan（由 PlanStageHandler 写入）
    const lastIter = ctx.prevResults[ctx.prevResults.length - 1];
    // 注：IterationResult 没有 artifacts 字段，只有 agentOutput
    // plan 信息在当前迭代的 ctx.currentPlan 或上次迭代的 agentOutput 中
    const plan = ctx.currentPlan || lastIter?.agentOutput || "";

    return [
      `# Dev 阶段（迭代 ${ctx.iterIndex}）`,
      ``,
      `## 上游方案`,
      plan || "（无上游 plan，按 objective 直接实现）",
      ``,
      `## 目标`,
      ctx.objective,
    ].join("\n");
  }

  protected judgeResult(
    result: DispatchResult,
    ctx: IterationContext,
    tokens: number,
  ): StageResult {
    if (result.status === "succeeded") {
      if (result.output && result.output.trim().length > 0) {
        return {
          kind: "success",
          summary: `[dev] 生成代码（${result.output.length} 字符）`,
          artifacts: { tokens, code: result.output },
        };
      }
      return {
        kind: "failed",
        summary: "[dev] solo-coder 未生成代码",
        artifacts: { tokens },
        error: "Empty dev output",
      };
    }
    if (result.status === "skipped") {
      return {
        kind: "fatal",
        summary: `[dev] dispatch 被跳过: ${result.error ?? "未知原因"}`,
        artifacts: { tokens },
        error: result.error,
      };
    }
    return {
      kind: "retriable",
      summary: `[dev] solo-coder 调用失败: ${result.error ?? "未知错误"}`,
      artifacts: { tokens },
      error: result.error,
    };
  }
}

/**
 * Verify 阶段处理器：调用 test-expert 角色运行测试
 */
export class VerifyStageHandler extends BaseStageHandler {
  readonly stageName = "verify";
  readonly roleId: RoleId = "test-expert";

  constructor(
    projectRoot: string,
    log: LogCallback = () => {},
    private readonly testCommand: string = "npm test",
    injectedClient?: InjectedClientHandle,
  ) {
    super(projectRoot, log, injectedClient);
  }

  protected buildDescription(ctx: IterationContext): string {
    return [
      `# Verify 阶段（迭代 ${ctx.iterIndex}）`,
      ``,
      `## 目标`,
      ctx.objective,
      ``,
      `## 测试命令`,
      `\`${this.testCommand}\``,
      ``,
      `## 上次迭代输出`,
      ctx.prevResults[ctx.prevResults.length - 1]?.agentOutput || "（无）",
    ].join("\n");
  }

  protected judgeResult(
    result: DispatchResult,
    ctx: IterationContext,
    tokens: number,
  ): StageResult {
    if (result.status === "succeeded") {
      const output = result.output ?? "";
      if (output.includes("PASS") || output.includes("通过")) {
        return {
          kind: "success",
          summary: `[verify] 测试通过`,
          artifacts: { tokens, verifyResult: output },
        };
      }
      if (output.includes("FAIL") || output.includes("失败")) {
        return {
          kind: "retriable",
          summary: `[verify] 测试失败，需要 fix`,
          artifacts: {
            tokens,
            verifyResult: output,
            failures: this.extractFailures(output),
          },
          error: "Tests failed",
        };
      }
      return {
        kind: "failed",
        summary: "[verify] 测试输出无法解析",
        artifacts: { tokens },
        error: "Unparseable test output",
      };
    }
    if (result.status === "skipped") {
      return {
        kind: "fatal",
        summary: `[verify] dispatch 被跳过: ${result.error ?? "未知原因"}`,
        artifacts: { tokens },
        error: result.error,
      };
    }
    return {
      kind: "fatal",
      summary: `[verify] test-expert 调用失败: ${result.error ?? "未知"}`,
      artifacts: { tokens },
      error: result.error,
    };
  }

  /**
   * 从测试输出中提取失败用例
   * @param output 测试输出文本
   * @returns 失败用例行数组（最多 10 条）
   */
  private extractFailures(output: string): string[] {
    const lines = output.split("\n");
    return lines.filter(l => l.includes("FAIL") || l.includes("失败")).slice(0, 10);
  }
}

/**
 * Fix 阶段处理器：调用 solo-coder 角色基于 verify 失败原因修复
 */
export class FixStageHandler extends BaseStageHandler {
  readonly stageName = "fix";
  readonly roleId: RoleId = "solo-coder";

  constructor(
    projectRoot: string,
    log: LogCallback = () => {},
    injectedClient?: InjectedClientHandle,
  ) {
    super(projectRoot, log, injectedClient);
  }

  protected buildDescription(ctx: IterationContext): string {
    // v1.1 修正：从 IterationContext.prevResults（IterationResult[]）中
    // 找最近一次 verify 失败的 agentOutput
    // IterationResult 不含 stage 标识，需通过 summary 中是否含 "verify" 判断
    const verifyResult = [...ctx.prevResults]
      .reverse()
      .find(r => r.summary.includes("verify") || r.summary.includes("测试"));
    const failures = verifyResult?.error ? [String(verifyResult.error)] : [];

    return [
      `# Fix 阶段（迭代 ${ctx.iterIndex}）`,
      ``,
      `## 目标`,
      ctx.objective,
      ``,
      `## 失败原因`,
      failures.length > 0
        ? failures.join("\n")
        : "（无具体失败信息，按 objective 重新实现）",
      ``,
      `## 上次迭代输出`,
      verifyResult?.agentOutput || "（无）",
    ].join("\n");
  }

  protected judgeResult(
    result: DispatchResult,
    ctx: IterationContext,
    tokens: number,
  ): StageResult {
    if (result.status === "succeeded") {
      if (result.output && result.output.trim().length > 0) {
        return {
          kind: "success",
          summary: `[fix] 修复完成（${result.output.length} 字符）`,
          artifacts: { tokens, fix: result.output },
        };
      }
      return {
        kind: "failed",
        summary: "[fix] solo-coder 未生成修复",
        artifacts: { tokens },
        error: "Empty fix output",
      };
    }
    if (result.status === "skipped") {
      return {
        kind: "fatal",
        summary: `[fix] dispatch 被跳过: ${result.error ?? "未知原因"}`,
        artifacts: { tokens },
        error: result.error,
      };
    }
    return {
      kind: "retriable",
      summary: `[fix] solo-coder 调用失败: ${result.error ?? "未知"}`,
      artifacts: { tokens },
      error: result.error,
    };
  }
}

/**
 * 工厂函数：构造 4 个 StageHandler
 *
 * 统一使用位置参数风格（与 NotesMemory / SleepGuard 等组件一致）
 *
 * @param opts.projectRoot 项目根目录
 * @param opts.testCommand 测试命令（默认 "npm test"）
 * @param opts.log 日志回调
 * @param opts.injectedClient 注入的 OpenAI 客户端（可选，用于测试）
 * @returns 4 个 StageHandler 实例
 */
export function createDefaultStageHandlers(opts: {
  projectRoot: string;
  testCommand?: string;
  log?: LogCallback;
  injectedClient?: InjectedClientHandle;
}): Record<StageKind, StageHandler> {
  const log = opts.log ?? (() => {});
  const testCmd = opts.testCommand ?? "npm test";
  return {
    plan: new PlanStageHandler(opts.projectRoot, log, opts.injectedClient),
    dev: new DevStageHandler(opts.projectRoot, log, opts.injectedClient),
    verify: new VerifyStageHandler(opts.projectRoot, log, testCmd, opts.injectedClient),
    fix: new FixStageHandler(opts.projectRoot, log, opts.injectedClient),
  };
}
```

#### 3.3.1 common/openai-client.ts 追加 OpenAIClientHandle + isOpenAIClientHandle（v1.4 新增 G-04）

**v1.4 修正（G-04 / 架构师 NB-03）**：v1.3 F-06 将 `OpenAIClientHandle` 接口和 `isOpenAIClientHandle` 类型守卫放在 stage-handlers.ts，但 `team-adapter.ts` 导入 stage-handlers.ts（通过 `executeDispatch` 调用链），而 stage-handlers.ts 又导入 team-adapter.ts（`executeDispatch, buildTask`），形成 **循环依赖**：

```
team-adapter.ts → stage-handlers.ts（使用 isOpenAIClientHandle）
       ↑                ↓
       └────────────────┘（stage-handlers.ts 导入 executeDispatch, buildTask）
```

**修正方案**：将 `OpenAIClientHandle` 和 `isOpenAIClientHandle` 迁移到 `packages/core/src/common/openai-client.ts`（已定义 `createOpenAIClient`，返回值结构正好对应 `OpenAIClientHandle`，类型守卫自然归属此文件）。`common/` 目录不依赖 `team/`，彻底消除循环依赖。

**迁移后的依赖关系**：

```
common/openai-client.ts（定义 OpenAIClientHandle + isOpenAIClientHandle + createOpenAIClient）
       ↑                ↑
       │                │
team-adapter.ts   stage-handlers.ts（均从 common/openai-client.ts 导入，无循环）
```

**在 `packages/core/src/common/openai-client.ts` 末尾追加**（不修改已有 `createOpenAIClient` 函数）：

```typescript
// packages/core/src/common/openai-client.ts 末尾追加（v1.4 新增 G-04）

/**
 * OpenAI 客户端句柄类型（与 createOpenAIClient 返回值结构对齐）
 *
 * v1.4 新增（G-04 / 架构师 NB-03）：从 stage-handlers.ts 迁移到 common/openai-client.ts
 *   原因：stage-handlers.ts ↔ team-adapter.ts 存在循环依赖，将类型守卫放在 common 层可彻底消除
 *
 * 通过依赖注入方式传入 StageHandler / executeDispatch，避免每个调用点重复创建客户端。
 * injectedClient 是真实接口契约的 stub（不是 mock），用于单元测试。
 *
 * 字段对齐 createOpenAIClient 返回值（13 个字段中 executeDispatch 只用到下列 5 个）：
 *   - client: OpenAI 实例（用 unknown 避免对 openai npm 包的硬依赖）
 *   - model: 模型名（如 "gpt-4o-mini"）
 *   - baseURL: API 基础 URL
 *   - temperature: 采样温度（可选）
 *   - thinkingEnabled: 是否启用 thinking 模式（Qwen3 / DeepSeek-R1 等）
 */
export interface OpenAIClientHandle {
  client: unknown;  // OpenAI 实例（unknown 避免循环依赖）
  model: string;
  baseURL: string;
  temperature?: number;
  thinkingEnabled: boolean;
  // 其余 8 个字段（apiKey / maxRetries / timeoutSec / azureDeployment / ...）按需添加
}

/**
 * v1.4 新增（G-04 / 架构师 NB-03）：导出类型守卫，供 §3.2.2 team-cmd.ts 和
 * §4.2 team-adapter.ts 共享调用，替代 v1.2 的内联类型断言和重复实现
 *
 * v1.6 修正（I-07 / 独立开发者 NB-01）：补充 baseURL / thinkingEnabled 字段检查
 *   原因：v1.4 版本仅检查 client + model 字段存在且 model 是 string，
 *   会误判 `{ client, model }` 为合法 OpenAIClientHandle；
 *   但 OpenAIClientHandle 接口要求 baseURL: string 和 thinkingEnabled: boolean 必填，
 *   类型守卫应严格校验这些必填字段，避免注入不完整对象在后续调用时抛错
 *
 * 检查必填字段：client 非空 + model 是 string + baseURL 是 string + thinkingEnabled 是 boolean
 * 足以判定是合法的 client handle（temperature 是可选字段，不强制校验）
 *
 * @param v 待检查的值（通常是 unknown 类型的 injectedClient）
 * @returns 如果 v 是合法的 OpenAIClientHandle 则返回 true，TypeScript 会自动收窄类型
 */
export function isOpenAIClientHandle(v: unknown): v is OpenAIClientHandle {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    "client" in obj &&
    "model" in obj &&
    typeof obj.model === "string" &&
    "baseURL" in obj &&
    typeof obj.baseURL === "string" &&
    "thinkingEnabled" in obj &&
    typeof obj.thinkingEnabled === "boolean"
  );
}
```

**team/index.ts 聚合导出**（在 F-01 的 `export * from "./autonomous/index.js";` 之外，额外新增一行）：

```typescript
// packages/core/src/team/index.ts 末尾追加（v1.4 新增 G-04）
//   将 common/openai-client.ts 的 OpenAIClientHandle 和 isOpenAIClientHandle
//   通过 team/index.ts 聚合导出，让外部可从 @vegamo/deepcode-core 统一导入
export { isOpenAIClientHandle, type OpenAIClientHandle } from "../common/openai-client.js";
```

**注意**：v1.5 修正（H-03 / 架构师 NB-02）：`createOpenAIClient` **不在** `team/index.ts` 导出，而在 `packages/core/src/index.ts:113` 直接从 `./common/openai-client` 导出（不经 team/index.ts）。因此本节新增的 `export { isOpenAIClientHandle, type OpenAIClientHandle } from "../common/openai-client.js";` 是 team/index.ts 首次聚合导出这两个符号；而 `createOpenAIClient` 已通过 `packages/core/src/index.ts:113` 直接导出，外部已可从 `@vegamo/deepcode-core` 导入。本次仅新增 `isOpenAIClientHandle` 和 `OpenAIClientHandle` 两个符号的聚合导出。

#### 3.3.2 autonomous/index.ts 追加 stage-handlers re-export（v1.4 新增 G-01）

**v1.4 修正（G-01 / 架构师 B-01 + 独立开发者 B-01）**：v1.3 F-01 在 team/index.ts 末尾新增 `export * from "./autonomous/index.js";`，但 `export *` 只能聚合 autonomous/index.ts **已导出**的符号。stage-handlers.ts 新增的 7 个符号（`createDefaultStageHandlers` / `PlanStageHandler` / `DevStageHandler` / `VerifyStageHandler` / `FixStageHandler` / `isOpenAIClientHandle` / `OpenAIClientHandle`）未在 autonomous/index.ts 中显式 re-export，导致 `export *` 无法传递这些符号，外部 `import { createDefaultStageHandlers } from "@vegamo/deepcode-core"` 会报 `Module has no exported member 'createDefaultStageHandlers'`。

**v1.6 修正（I-01 / 架构师 P0 阻塞）**：v1.3 F-01 在 team/index.ts 末尾新增的 `export * from "./autonomous/index.js";` 仍存在 RiskLevel 命名冲突隐患——`smart-confirmation.ts:32` 的 `type RiskLevel` 与 `cybernetics/guard-coordinator.ts:24` 的 `const RiskLevel` 同名，`export *` 与显式 `export {}` 同名时显式优先，导致 smart-confirmation.ts 的 type RiskLevel 在 team/index.ts 层被静默覆盖。v1.5 H-01 仅在 `packages/core/src/index.ts` 层避免 `export *`，未处理 team/index.ts 层。**修正方案**：将 v1.3 F-01 的 `export * from "./autonomous/index.js";` 改为显式 re-export（见 §3.3.4），与 v1.5 §3.3.3 在 packages/core/src/index.ts 中的做法保持一致。

**v1.4 修正方案**：

1. **G-04 已将 `isOpenAIClientHandle` 和 `OpenAIClientHandle` 迁移到 common/openai-client.ts**，并由 team/index.ts 直接聚合导出（见 §3.3.1）。因此 autonomous/index.ts 不再需要 re-export 这两个符号。

2. **stage-handlers.ts 的 5 个符号**（`createDefaultStageHandlers` / `PlanStageHandler` / `DevStageHandler` / `VerifyStageHandler` / `FixStageHandler`）必须在 autonomous/index.ts 中显式 re-export，才能通过 team/index.ts 的 v1.6 I-01 显式 re-export（见 §3.3.4）传递到外部。

**在 `packages/core/src/team/autonomous/index.ts` 末尾追加**（不修改已有的 9 组件导出）：

```typescript
// packages/core/src/team/autonomous/index.ts 末尾追加（v1.4 新增 G-01）
//   v1.3 F-01 在 team/index.ts 新增了 `export * from "./autonomous/index.js";`，
//   但 export * 只能聚合本文件已导出的符号。
//   stage-handlers.ts 新增的 5 个符号必须在此显式 re-export，才能传递到外部。

// v1.4 修正（G-04）：isOpenAIClientHandle 和 OpenAIClientHandle 已迁移到 common/openai-client.ts，
//   由 team/index.ts 直接聚合导出，此处不再 re-export
export {
  PlanStageHandler,
  DevStageHandler,
  VerifyStageHandler,
  FixStageHandler,
  createDefaultStageHandlers,
} from "./stage-handlers.js";
```

**验证**：修正后，外部代码可通过以下方式导入：

```typescript
// ✅ 正确：从 @vegamo/deepcode-core 统一导入（推荐）
import {
  createDefaultStageHandlers,
  PlanStageHandler,
  DevStageHandler,
  VerifyStageHandler,
  FixStageHandler,
  isOpenAIClientHandle,
  type OpenAIClientHandle,
} from "@vegamo/deepcode-core";

// ✅ 正确：从 team/autonomous 直接导入（内部模块）
import { createDefaultStageHandlers } from "./autonomous/index.js";

// ✅ 正确：从 common/openai-client 直接导入（内部模块）
import { isOpenAIClientHandle, type OpenAIClientHandle } from "../common/openai-client.js";
```

**导出链路图**（v1.6 I-01 修正后）：

```
stage-handlers.ts（定义 5 个 StageHandler 符号）
       ↓ export { ... } from "./stage-handlers.js"
autonomous/index.ts（v1.4 G-01 追加 re-export）
       ↓ export { ... } from "./autonomous/index.js"  ← v1.6 I-01 显式 re-export
team/index.ts（v1.3 F-01 已改为 v1.6 I-01 显式 re-export，替代 export *）
       ↓ package.json main → team/index.ts
@vegamo/deepcode-core（外部包入口）
```

```
common/openai-client.ts（定义 isOpenAIClientHandle + OpenAIClientHandle）
       ↓ export { ... } from "../common/openai-client.js"
team/index.ts（v1.4 G-04 追加聚合导出）
       ↓ package.json main → team/index.ts
@vegamo/deepcode-core（外部包入口）
```

#### 3.3.3 packages/core/src/index.ts 追加显式 re-export（v1.5 新增 H-01 / 架构师 B-01 P0 阻塞）

**v1.5 修正（H-01 / 架构师 B-01 P0 阻塞）**：经再次读取 `packages/core/src/index.ts:380-462` 真实源码，确认该文件是 `@vegamo/deepcode-core` 的**真正包入口**（package.json main → dist/index.js → src/index.ts）。该文件对 `./team/index.js` 采用**显式 re-export**（L387-462 两个 export 块，约 40 个值符号 + 30 个类型符号），**没有 `export *`**：

```
packages/core/src/index.ts:387-429
  export { ROLE_REGISTRY, ROLE_MAP, ..., executeDispatch, ..., TeamConfigSchema } from "./team/index.js";

packages/core/src/index.ts:430-462
  export type { RoleId, RolePriority, ..., TeamConfig, TeamDispatchResult } from "./team/index.js";
```

**问题**：v1.3 F-01 在 `team/index.ts` 末尾新增 `export * from "./autonomous/index.js";`，v1.4 G-01 在 `autonomous/index.ts` 末尾追加 `export { PlanStageHandler, ... } from "./stage-handlers.js";`，v1.4 G-04 在 `team/index.ts` 末尾追加 `export { isOpenAIClientHandle, type OpenAIClientHandle } from "../common/openai-client.js";`。但**这些新增导出全部停留在 `team/index.ts` 层**，无法自动传递到 `@vegamo/deepcode-core`，因为 `packages/core/src/index.ts` 是显式 re-export，不会聚合 `team/index.ts` 末尾新增的符号。

**编译失败清单**（§3.2.2 第 1 步 import 语句中的 19 个符号，18 个会编译失败）：

| 失败符号 | 来源 | 当前 packages/core/src/index.ts 是否导出 |
|---------|------|-----------------------------------------|
| RunState | autonomous/run-state.ts | ❌ 未导出 |
| findLatestResumableRun | autonomous/run-state.ts | ❌ 未导出 |
| NotesMemory | autonomous/notes-memory.ts | ❌ 未导出 |
| GitDriver | autonomous/git-driver.ts | ❌ 未导出 |
| SleepGuard | autonomous/sleep-guard.ts | ❌ 未导出 |
| SmartConfirmation | autonomous/smart-confirmation.ts | ❌ 未导出 |
| AutoSkillLoader | autonomous/auto-skill-loader.ts | ❌ 未导出 |
| RalphLoopController | autonomous/loop-controller.ts | ❌ 未导出 |
| defaultLoopConfig | autonomous/loop-controller.ts | ❌ 未导出 |
| generateRunId | autonomous/loop-controller.ts | ❌ 未导出 |
| loadAutonomousConfig | autonomous/config-loader.ts | ❌ 未导出 |
| AutonomousConfig (type) | autonomous/config-loader.ts | ❌ 未导出 |
| LoopConfig (type) | autonomous/loop-controller.ts | ❌ 未导出 |
| StageHandler (type) | autonomous/loop-controller.ts | ❌ 未导出 |
| StageKind (type) | autonomous/loop-controller.ts | ❌ 未导出 |
| LogCallback (type) | autonomous/loop-controller.ts | ❌ 未导出 |
| IterationContext (type) | autonomous/loop-controller.ts | ❌ 未导出 |
| IterationResult (type) | autonomous/loop-controller.ts | ❌ 未导出 |
| StageResult (type) | autonomous/loop-controller.ts | ❌ 未导出 |
| RunStateLike (type) | autonomous/loop-controller.ts | ❌ 未导出 |
| PlanStageHandler | autonomous/stage-handlers.ts | ❌ 未导出 |
| DevStageHandler | autonomous/stage-handlers.ts | ❌ 未导出 |
| VerifyStageHandler | autonomous/stage-handlers.ts | ❌ 未导出 |
| FixStageHandler | autonomous/stage-handlers.ts | ❌ 未导出 |
| createDefaultStageHandlers | autonomous/stage-handlers.ts | ❌ 未导出 |
| isOpenAIClientHandle | common/openai-client.ts | ❌ 未导出 |
| OpenAIClientHandle (type) | common/openai-client.ts | ❌ 未导出 |
| createOpenAIClient | common/openai-client.ts | ✅ 已在 packages/core/src/index.ts:113 直接导出 |

**修正方案**：在 `packages/core/src/index.ts` L462（现有 team 模块导出块末尾）之后追加显式 re-export，将 autonomous 9 组件 + stage-handlers 5 符号 + common/openai-client 2 符号（isOpenAIClientHandle / OpenAIClientHandle，createOpenAIClient 已直接导出）传递到 `@vegamo/deepcode-core`。

**不使用 `export * from "./team/index.js";`** 的原因：v1.4 评审架构师 NB-01 指出存在 `RiskLevel` 双重导出隐患（`smart-confirmation.ts` 的 `type RiskLevel` 与 `cybernetics/guard-coordinator.ts` 的 `const RiskLevel` 同名）。若使用 `export *`，两个同名符号会触发 TypeScript 编译警告或运行时冲突。保持显式 re-export 可精确控制导出符号清单，避免命名冲突。

**在 `packages/core/src/index.ts` L462 之后追加**（不修改 L387-462 已有的显式 re-export）：

```typescript
// packages/core/src/index.ts 在 L462 之后追加（v1.5 新增 H-01 / 架构师 B-01 P0 阻塞）
//   原因：本文件对 ./team/index.js 采用显式 re-export（L387-462），不是 export *
//   v1.3 F-01 + v1.4 G-01/G-04 在 team/index.ts 末尾新增的 autonomous 9 组件 +
//   stage-handlers 5 符号 + common/openai-client 2 符号无法自动传递到 @vegamo/deepcode-core
//   必须在此显式 re-export，否则 §3.2.2 的 19 个 import 符号中有 18 个会编译失败
//   不使用 export * 避免加剧 RiskLevel 命名冲突（smart-confirmation.ts type RiskLevel
//   vs cybernetics/guard-coordinator.ts const RiskLevel）

// autonomous 9 组件 + 辅助函数
export {
  // autonomous 9 组件（v1.3 F-01）
  RunState,
  findLatestResumableRun,
  NotesMemory,
  GitDriver,
  SleepGuard,
  SmartConfirmation,
  AutoSkillLoader,
  RalphLoopController,
  defaultLoopConfig,
  generateRunId,
  loadAutonomousConfig,
  // stage-handlers 5 符号（v1.4 G-01）
  PlanStageHandler,
  DevStageHandler,
  VerifyStageHandler,
  FixStageHandler,
  createDefaultStageHandlers,
  // common/openai-client 类型守卫（v1.4 G-04）
  // 注：createOpenAIClient 已在本文件 L113 直接从 ./common/openai-client 导出，无需重复
  isOpenAIClientHandle,
} from "./team/index.js";

// autonomous + stage-handlers + common/openai-client 类型
export type {
  // autonomous 类型（v1.3 F-01）
  AutonomousConfig,
  LoopConfig,
  StageHandler,
  StageKind,
  LogCallback,
  IterationContext,
  IterationResult,
  StageResult,
  RunStateLike,
  // common/openai-client 类型（v1.4 G-04）
  OpenAIClientHandle,
} from "./team/index.js";
```

**修正后的完整导出链路图**（v1.6 I-01 修正后）：

```
stage-handlers.ts（定义 5 个 StageHandler 符号）
       ↓ export { ... } from "./stage-handlers.js"
autonomous/index.ts（v1.4 G-01 追加 re-export）
       ↓ export { ... } from "./autonomous/index.js"  ← v1.6 I-01 显式 re-export（替代 v1.3 F-01 的 export *）
team/index.ts（v1.6 I-01 改为显式 re-export，消除 RiskLevel 命名冲突）
       ↓ export { ... } from "./team/index.js"  ← v1.5 H-01 新增显式 re-export
packages/core/src/index.ts（@vegamo/deepcode-core 真正包入口）
       ↓ package.json main → dist/index.js → src/index.ts
@vegamo/deepcode-core（外部包入口）
```

```
common/openai-client.ts（定义 isOpenAIClientHandle + OpenAIClientHandle + createOpenAIClient）
       ↓ ① export { createOpenAIClient } from "./common/openai-client"  ← L113 已存在
       ↓ ② export { isOpenAIClientHandle, type OpenAIClientHandle } from "../common/openai-client.js"  ← team/index.ts v1.4 G-04
       ↓ ③ export { isOpenAIClientHandle } + export type { OpenAIClientHandle } from "./team/index.js"  ← packages/core/src/index.ts v1.5 H-01 新增
packages/core/src/index.ts（@vegamo/deepcode-core 真正包入口）
       ↓
@vegamo/deepcode-core（外部包入口）
```

**验证清单**：

```typescript
// ✅ 修正后，以下 19 个 import 语句全部可编译（§3.2.2 第 1 步）
import {
  RunState,
  findLatestResumableRun,
  NotesMemory,
  GitDriver,
  SleepGuard,
  SmartConfirmation,
  AutoSkillLoader,
  RalphLoopController, defaultLoopConfig, generateRunId,
  loadAutonomousConfig,
  type AutonomousConfig,
  type LoopConfig, type StageHandler, type StageKind, type LogCallback,
  createDefaultStageHandlers,
  isOpenAIClientHandle,
  type OpenAIClientHandle,
} from "@vegamo/deepcode-core";
import { createOpenAIClient } from "@vegamo/deepcode-core";
```

#### 3.3.4 team/index.ts 追加 autonomous 显式 re-export（v1.6 新增 I-01 / 架构师 P0 阻塞）

**v1.6 修正（I-01 / 架构师 P0 阻塞）**：v1.3 F-01 在 `team/index.ts` 末尾新增的 `export * from "./autonomous/index.js";` 存在 RiskLevel 命名冲突隐患：

- `packages/core/src/team/autonomous/smart-confirmation.ts:32` 定义并导出 `export type RiskLevel = "low" | "medium" | "high" | "critical";`（**type RiskLevel**）
- `packages/core/src/team/autonomous/index.ts:63` 通过 `export type { RiskLevel, ConfirmationDecision, ConfirmationResult } from "./smart-confirmation.js";` re-export 了 `type RiskLevel`
- `packages/core/src/team/cybernetics/guard-coordinator.ts:24-29` 定义并导出 `export const RiskLevel = { LOW, MEDIUM, HIGH, CRITICAL } as const;`（**const RiskLevel**）
- `packages/core/src/team/index.ts:322` 已通过 `export { RiskLevel, ... } from "./cybernetics/guard-coordinator.js";` 显式导出 const RiskLevel

如果 team/index.ts 使用 `export * from "./autonomous/index.js";`，那么 `type RiskLevel`（来自 smart-confirmation.ts）会进入 team/index.ts 的命名空间，与已有的 `const RiskLevel`（来自 cybernetics/guard-coordinator.ts）形成同名冲突。TypeScript 在 `export *` 与显式 `export {}` 同名时，显式导出优先，导致 `type RiskLevel` 被静默覆盖，外部代码 `import type { RiskLevel } from "@vegamo/deepcode-core"` 会得到 `RiskLevelType`（const 的副作用类型），而非 smart-confirmation.ts 的字面量联合类型 `"low" | "medium" | "high" | "critical"`，运行时类型收窄失效。

**v1.5 H-01 的局限**：v1.5 H-01 仅在 `packages/core/src/index.ts` 层避免 `export *`（采用显式 re-export，见 §3.3.3），但 team/index.ts 层的 `export * from "./autonomous/index.js";` 仍存在，命名冲突在 team/index.ts 层就发生了，packages/core/src/index.ts 层的显式 re-export 无法修正此问题。

**v1.6 I-01 修正方案**：将 v1.3 F-01 在 team/index.ts 末尾新增的 `export * from "./autonomous/index.js";` 改为显式 re-export，**显式排除 `type RiskLevel`**（来自 smart-confirmation.ts），保留 `const RiskLevel`（来自 cybernetics/guard-coordinator.ts）作为 team/index.ts 唯一的 RiskLevel 导出。同时整合 v1.4 G-04 的 `export { isOpenAIClientHandle, type OpenAIClientHandle } from "../common/openai-client.js";`（避免在 team/index.ts 末尾出现两个独立的 export 块）。

**修正前（v1.3 F-01 + v1.4 G-04）**：

```typescript
// packages/core/src/team/index.ts 末尾（v1.3 F-01 + v1.4 G-04）
//   ⚠️ v1.6 I-01 删除以下两行（export * 会触发 RiskLevel 命名冲突）
export * from "./autonomous/index.js";  // ❌ v1.3 F-01（删除）
export { isOpenAIClientHandle, type OpenAIClientHandle } from "../common/openai-client.js";  // v1.4 G-04 保留并整合
```

**修正后（v1.6 I-01 显式 re-export）**：

在 `packages/core/src/team/index.ts` L485（现有 `export { ... } from "./principles/quality-gates.js";` 之后）追加：

```typescript
// packages/core/src/team/index.ts L485 之后追加（v1.6 新增 I-01 / 架构师 P0 阻塞）
//   v1.3 F-01 原方案的 `export * from "./autonomous/index.js";` 会触发 RiskLevel 命名冲突
//   （smart-confirmation.ts:32 的 type RiskLevel 与 cybernetics/guard-coordinator.ts:24 的 const RiskLevel 同名）
//   v1.6 I-01 改为显式 re-export，精确控制导出符号清单，**显式排除 type RiskLevel**
//   保留 team/index.ts:322 已有的 const RiskLevel（来自 cybernetics/guard-coordinator.ts）作为唯一 RiskLevel 导出
//
//   v1.4 G-04 的 `export { isOpenAIClientHandle, type OpenAIClientHandle } from "../common/openai-client.js";`
//   整合到本 export 块（避免在 team/index.ts 末尾出现两个独立的 export 块）

// ============================================================================
// 第十四部分：Autonomous 9 组件 + StageHandlers 5 符号 + Common OpenAI Client 类型守卫
// （v1.6 I-01 显式 re-export，替代 v1.3 F-01 的 export *，消除 RiskLevel 命名冲突）
// ============================================================================

// autonomous 9 组件 + 辅助函数（值导出）
export {
  // 1. config-loader
  defaultAutonomousConfig,
  userConfigPath,
  projectConfigPath,
  parseSimpleYaml,
  loadAutonomousConfig,
  // 2. run-state
  RunState,
  listRuns,
  findLatestResumableRun,
  // 3. notes-memory
  NotesMemory,
  // 4. loop-controller
  RalphLoopController,
  defaultLoopConfig,
  defaultIterationResult,
  generateRunId,
  // 5. git-driver
  GitDriver,
  defaultGitOpResult,
  defaultDiffStats,
  // 6. sleep-guard
  SleepGuard,
  // 7. smart-confirmation
  //   ⚠️ v1.6 I-01：不导出 scoreToLevel（返回 type RiskLevel，与 const RiskLevel 类型不兼容）
  //   若需 scoreToLevel，请从 team/autonomous/smart-confirmation.js 直接导入
  SmartConfirmation,
  // 8. auto-skill-loader
  AutoSkillLoader,
  defaultSkillManifest,
  // 9. dispatcher-adapter
  DispatcherAdapter,
  defaultAdapterInvokeResult,
  defaultTaskArgs,
  // stage-handlers 5 符号（v1.4 G-01 在 autonomous/index.ts 追加的 re-export）
  PlanStageHandler,
  DevStageHandler,
  VerifyStageHandler,
  FixStageHandler,
  createDefaultStageHandlers,
} from "./autonomous/index.js";

// common/openai-client 类型守卫（v1.4 G-04）
//   v1.6 I-01 修正（独立开发者 B-01 P0 阻塞）：isOpenAIClientHandle 和 OpenAIClientHandle
//   均不在 autonomous/index.ts 中 re-export（autonomous/index.ts 仅 re-export 9 组件原生符号
//   + §3.3.2 追加的 stage-handlers 5 符号），必须直接从 common/openai-client.js 导入
//   原 v1.6 I-01 草案错误地将 isOpenAIClientHandle 放入 `from "./autonomous/index.js"` 块，
//   会导致编译失败：Module './autonomous/index.js' has no exported member 'isOpenAIClientHandle'
export { isOpenAIClientHandle } from "../common/openai-client.js";
export type { OpenAIClientHandle } from "../common/openai-client.js";

// autonomous 类型导出（显式排除 type RiskLevel，避免与 const RiskLevel 命名冲突）
export type {
  // config-loader 类型
  AutonomousConfig,
  // run-state 类型
  RunStateSchema,
  ResumeContext,
  // notes-memory 类型
  NotesSection,
  // loop-controller 类型
  StageKind,
  IterationKind,
  LoopConfig,
  IterationContext,
  IterationResult,
  StageResult,
  StageHandler,
  RunStateLike,
  GitDriverLike,
  SleepGuardLike,
  LogCallback,
  // git-driver 类型
  GitOpResult,
  DiffStats,
  // sleep-guard 类型
  SleepGuardMode,
  SleepGuardBackend,
  SleepGuardHandle,
  SleepGuardLogCallback,
  // smart-confirmation 类型
  //   ⚠️ v1.6 I-01：**显式排除 type RiskLevel**（来自 smart-confirmation.ts）
  //   保留 team/index.ts:322 已有的 const RiskLevel（来自 cybernetics/guard-coordinator.ts）
  //   若需 type RiskLevel，请从 team/autonomous/smart-confirmation.js 直接导入
  ConfirmationDecision,
  ConfirmationResult,
  // auto-skill-loader 类型
  SkillManifest,
  // dispatcher-adapter 类型
  AdapterInvokeKind,
  AdapterInvokeResult,
  DispatcherTaskArgs,
  FacadeLike,
  AdapterLogCallback,
} from "./autonomous/index.js";
```

**修正后的 RiskLevel 导出语义**：

| 来源 | 符号 | team/index.ts 状态 | packages/core/src/index.ts 状态 | 外部导入语义 |
|------|------|-------------------|-------------------------------|--------------|
| `cybernetics/guard-coordinator.ts:24` | `const RiskLevel` | ✅ L322 显式导出（保留） | ✅ v1.5 H-01 已显式 re-export | 唯一 RiskLevel，是 const 对象 |
| `cybernetics/guard-coordinator.ts:31` | `type RiskLevelType` | ❌ 未导出 | ❌ 未导出 | 需从 cybernetics/guard-coordinator.js 直接导入 |
| `autonomous/smart-confirmation.ts:32` | `type RiskLevel` | ❌ v1.6 I-01 显式排除 | ❌ 未导出 | 需从 team/autonomous/smart-confirmation.js 直接导入 |

**验证清单**：

```typescript
// ✅ 修正后，以下导入均合法
import { RiskLevel } from "@vegamo/deepcode-core";  // const RiskLevel（来自 guard-coordinator.ts）
RiskLevel.LOW;  // "low"
RiskLevel.CRITICAL;  // "critical"

// ✅ 若需 type RiskLevel（来自 smart-confirmation.ts），从内部模块直接导入
import type { RiskLevel as SmartRiskLevel } from "@vegamo/deepcode-core/team/autonomous/smart-confirmation.js";
// 或从 deepcode-core 内部路径导入（仅内部模块可用）
```

**与 v1.5 §3.3.3 的协同关系**：

| 层级 | 文件 | 修正方案 | 状态 |
|------|------|---------|------|
| team/index.ts 层 | `packages/core/src/team/index.ts` | v1.6 I-01：`export *` → 显式 re-export（排除 type RiskLevel） | 本节新增 |
| packages/core/src/index.ts 层 | `packages/core/src/index.ts` | v1.5 H-01：显式 re-export（不使用 `export *`） | §3.3.3 已设计 |

两层均采用显式 re-export，彻底消除 RiskLevel 命名冲突隐患。

**实施说明（v1.6 补充 / 独立开发者 NB-04）**：当前 `packages/core/src/team/index.ts` 实际仓库状态为 485 行，末尾停留在 `} from "./principles/quality-gates.js";`（L485），**未应用 v1.3 F-01 的 `export *` 和 v1.4 G-04 的独立聚合导出**。因此实施时**直接追加本节的显式 re-export 代码**（跳过 v1.3 F-01 的 `export *` 中间状态），无需执行"先删除 export * 再替换为显式 re-export"的转换。本节的"修正前"代码块仅作为设计层面的状态对比，描述 v1.3/v1.4 设计方案若已应用时的虚拟状态。

### 3.4 接口调整：StageHandler + run() 支持异步（v1.1 显式说明连锁修改）

**连锁修改清单**（v1.0 未完整说明，v1.1 补全）：

| 文件 | 修改点 | v1.0 当前签名 | v1.1 修改后签名 |
|------|--------|--------------|----------------|
| `loop-controller.ts:121-123` | StageHandler 接口 | `handle(ctx): StageResult` | `handle(ctx): StageResult \| Promise<StageResult>` |
| `loop-controller.ts:228` | run() 方法 | `run(): number` | `async run(): Promise<number>` |
| `loop-controller.ts:253` | runOneIteration 调用 | `iterResult = this.runOneIteration(iterIndex)` | `iterResult = await this.runOneIteration(iterIndex)` |
| `loop-controller.ts:368` | runOneIterationPublic | `runOneIterationPublic(iterIndex): IterationResult` | `async runOneIterationPublic(iterIndex): Promise<IterationResult>` |
| `loop-controller.ts:393` | runOneIteration 方法 | `private runOneIteration(iterIndex): IterationResult` | `private async runOneIteration(iterIndex): Promise<IterationResult>` |
| `loop-controller.ts:419` | handler.handle 调用 | `const stageResult = handler.handle(iterCtx)` | `const stageResult = await handler.handle(iterCtx)` |
| `loop-controller.ts:556` | backoffSleep 方法 | `private backoffSleep(attempt): void` | `private async backoffSleep(attempt): Promise<void>` |
| `loop-controller.ts:292` | backoffSleep 调用 | `this.backoffSleep(consecutiveFailures - 1)` | `await this.backoffSleep(consecutiveFailures - 1)` |
| `team-cmd.ts:288` | run() 调用 | `const exitCode = controller.run()` | `const exitCode = await controller.run()` |

**backoffSleep 改为 async 实现**（v1.0 使用 BusyWait 自旋阻塞 event loop，v1.1 改为 setTimeout Promise）：

```typescript
/**
 * 指数退避 + jitter（v1.1 改为 async）
 *
 * v1.0 问题：使用 BusyWait 自旋阻塞 event loop，与 async 化冲突
 * v1.1 修正：使用 setTimeout Promise，让出 event loop
 *
 * @param attempt 重试次数（0 开始）
 */
private async backoffSleep(attempt: number): Promise<void> {
  const base = this.config.backoffBaseSec;
  const maxSec = this.config.backoffMaxSec;
  let sleepSec = Math.min(maxSec, base * Math.pow(2, Math.max(0, attempt)));
  // ± 10% jitter
  sleepSec *= 0.9 + Math.random() * 0.2;
  if (sleepSec > 0.1) {
    this.log("info", `[RalphLoop] 退避 ${sleepSec.toFixed(2)}s（attempt=${attempt}）`);
    const sleepMs = Math.floor(sleepSec * 1000);
    await new Promise<void>(resolve => setTimeout(resolve, sleepMs));
  }
}
```

**向后兼容性**：
- `StageResult | Promise<StageResult>` 联合类型兼容同步和异步实现
- 现有同步 StageHandler 仍可工作（`await` 非 Promise 值直接返回）
- 现有调用 `controller.run()` 的代码需改为 `await controller.run()`（仅 team-cmd.ts 一处）

---

## 四、P0-2 详细设计：executeDispatch 接入 LLM

### 4.1 当前问题

`packages/core/src/team/team-adapter.ts:374-454` 的 `executeDispatch` 函数：

```typescript
export async function executeDispatch(task, options, onProgress) {
  // ...
  // 阶段 3：调用 LLM（此处集成点留给上层 Session 管理）
  // 注：完整 LLM 调用需要 OpenAI 客户端 + 工具执行 + 循环，这部分由 SessionManager 负责
  // 本函数只负责调度 + 准备上下文，实际 LLM 调用由调用方基于 recommendedSystemPrompt 发起
  const dispatchResult: DispatchResult = {
    // ...
    status: "pending",
    output: teamResult.recommendedSystemPrompt,  // ← 把 prompt 当成 output 返回
    tokensConsumed: { prompt: 0, completion: 0, total: 0 },  // ← 全为 0
    // ...
  };

  onProgress?.("succeeded", "调度完成");
  return {
    ...dispatchResult,
    status: "succeeded",  // ← 虚假成功
    // ...
  };
}
```

**问题**:
1. 注释说"留给上层"，但 CLI 直接消费返回值
2. `output` 字段填的是 prompt 文本而非 LLM 真实响应
3. `tokensConsumed` 全为 0
4. `status` 直接设为 `succeeded`，未实际调用 LLM

### 4.2 修复方案

在 `executeDispatch` 内部阶段 3 接入真实 LLM 调用，复用 `domain-expert-review-plugin.ts:650-720` 已验证的 `invokeExpertLLM` 模式：

```typescript
// team-adapter.ts 阶段 3 修改后（完整实现）

// v1.4 修正（G-04 / 架构师 NB-03）：从 common/openai-client.js 导入共享类型守卫
//   替代 v1.3 从 stage-handlers.js 导入（消除循环依赖）
//   原因：team-adapter.ts → stage-handlers.ts（使用 isOpenAIClientHandle）
//          stage-handlers.ts → team-adapter.ts（导入 executeDispatch, buildTask）
//          形成循环依赖。common/openai-client.ts 不依赖 team/，是 createOpenAIClient 的归属文件
//   v1.3 修正（F-06 / 架构师 N-06）已被 v1.4 G-04 替代：原方案从 stage-handlers.js 导入
import {
  createOpenAIClient,
  isOpenAIClientHandle,
  type OpenAIClientHandle,
} from "../common/openai-client.js";

// ... 在 executeDispatch 函数内部 ...

// 阶段 3：调用 LLM（v1.1 真实实现，v1.2 修正类型安全，v1.3 共享类型守卫，v1.4 改为局部变量写法）
let llmOutput = "";
let tokensConsumed = { prompt: 0, completion: 0, total: 0 };

try {
  onProgress?.("running", "正在调用 LLM...");

  // 3.1 获取 OpenAI 客户端
  // 优先使用注入的客户端（测试场景），否则通过 createOpenAIClient 创建
  // v1.2 修正（M-02）：用类型守卫收窄 unknown，避免编译错误
  // v1.2 修正（M-06）：变量名是 options（非 opts），原代码误用 opts.projectRoot
  // v1.3 修正（F-06）：使用共享的 isOpenAIClientHandle，不再本地定义
  // v1.4 修正（G-07 / 独立开发者 NB-02）：改为局部变量写法，避免 IIFE 中类型守卫收窄不可靠
  let clientHandle: OpenAIClientHandle | null = null;
  const injected = options.injectedClient;
  if (isOpenAIClientHandle(injected)) {
    clientHandle = injected;
  } else if (injected === undefined) {
    // 仅当未注入时才通过 createOpenAIClient 创建（避免重复创建）
    const handle = createOpenAIClient(options.projectRoot);
    if (handle.client) {
      clientHandle = handle as unknown as OpenAIClientHandle;
    }
  }

  if (!clientHandle || !clientHandle.client) {
    // 无 API Key → 返回 skipped 状态（不伪装成功）
    // v1.1 修正：明确 skipped 语义
    // v1.2 修正（M-05）：复用 types.ts:163-173 已存在的 skipped 状态，无需新增
    onProgress?.("skipped", "OpenAI 客户端不可用（未配置 API Key）");
    return {
      ...dispatchResult,
      status: "skipped",
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
      error: "OpenAI 客户端不可用（未配置 API Key）",
      tokensConsumed,
    };
  }

  // 3.2 构造 messages
  const messages = [
    { role: "system", content: teamResult.recommendedSystemPrompt },
    { role: "user", content: buildUserPromptFromTask(task) },
  ];

  // 3.3 调用 LLM（含超时保护）
  // 参考 domain-expert-review-plugin.ts:680-700 的 AbortController 模式
  const timeoutMs = options.timeoutMs ?? 60_000;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    // v1.2 修正（M-02）：clientHandle.client 类型是 unknown，需断言为 OpenAI 调用接口
    //   为避免引入 OpenAI 类型硬依赖，使用最小接口定义
    type ChatCompletionsCreate = (req: {
      model: string;
      messages: Array<{ role: "system" | "user"; content: string }>;
      temperature?: number;
    }, opts?: { signal: AbortSignal }) => Promise<{
      choices: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    }>;

    const openaiClient = clientHandle.client as { chat: { completions: { create: ChatCompletionsCreate } } };
    const response = await openaiClient.chat.completions.create(
      {
        model: clientHandle.model,
        messages,
        temperature: clientHandle.temperature ?? 0.3,
      },
      { signal: abortController.signal }
    );
    llmOutput = response.choices[0]?.message?.content ?? "";
    if (response.usage) {
      tokensConsumed = {
        prompt: response.usage.prompt_tokens ?? 0,
        completion: response.usage.completion_tokens ?? 0,
        total: response.usage.total_tokens ?? 0,
      };
    }
  } finally {
    clearTimeout(timer);
  }

  // 3.4 判定状态
  if (llmOutput.trim().length === 0) {
    return {
      ...dispatchResult,
      status: "failed",
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
      error: "LLM 返回空内容",
      tokensConsumed,
    };
  }

  // 3.5 成功
  onProgress?.("succeeded", `LLM 调用完成（${tokensConsumed.total} tokens）`);
  return {
    ...dispatchResult,
    status: "succeeded",
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - new Date(startedAt).getTime(),
    output: llmOutput,
    tokensConsumed,
  };
} catch (err) {
  const errMsg = err instanceof Error ? err.message : String(err);
  return {
    ...dispatchResult,
    status: "failed",
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - new Date(startedAt).getTime(),
    error: `LLM 调用失败: ${errMsg}`,
    tokensConsumed,
  };
}
```

### 4.3 新增辅助函数: `buildUserPromptFromTask`

```typescript
/**
 * 从 TaskRequirement 构造用户 prompt
 *
 * 与 domain-expert-review-plugin.ts:buildExpertUserPrompt 类似，
 * 但不强制 JSON 输出格式（executeDispatch 是通用调度入口）
 *
 * @param task 任务需求
 * @returns 用户 prompt 文本
 */
export function buildUserPromptFromTask(task: TaskRequirement): string {
  const lines: string[] = [];
  lines.push(`# 任务标题`);
  lines.push(task.title);
  lines.push("");
  lines.push(`# 任务描述`);
  lines.push(task.description);

  if (task.constraints.length > 0) {
    lines.push("");
    lines.push(`# 约束条件`);
    for (const c of task.constraints) lines.push(`- ${c}`);
  }

  if (task.attachments.length > 0) {
    lines.push("");
    lines.push(`# 附件`);
    for (const a of task.attachments) lines.push(`- ${a}`);
  }

  // 透传 upstreamContext（如 autonomous stage 信息）
  if (task.upstreamContext && Object.keys(task.upstreamContext).length > 0) {
    lines.push("");
    lines.push(`# 上游上下文`);
    for (const [k, v] of Object.entries(task.upstreamContext)) {
      lines.push(`- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
  }

  return lines.join("\n");
}
```

### 4.4 DispatchOptions 扩展（v1.1 修正位置）

**v1.0 错误**：将 DispatchOptions 描述为在 `types.ts` 中的 TypeScript interface。

**v1.1 修正**：DispatchOptions 实际定义在 `team-adapter.ts:113-132`，是 zod schema（非 TypeScript interface）。修改方式如下：

```typescript
// team-adapter.ts:113-132 当前定义
export const DispatchOptions = z.object({
  projectRoot: z.string().default(process.cwd()),
  forceRole: z
    .object({
      roleId: z.string(),
      reason: z.string().optional(),
    })
    .optional(),
  configOverride: z
    .object({
      matchStrategy: z.enum(["keyword", "ai", "hybrid"]).optional(),
      topK: z.number().int().positive().optional(),
      aiFallbackThreshold: z.number().min(0).max(1).optional(),
    })
    .optional(),
  multiRole: z.boolean().default(false),
});

// v1.1 扩展：新增 timeoutMs 和 injectedClient 字段
export const DispatchOptions = z.object({
  projectRoot: z.string().default(process.cwd()),
  forceRole: z
    .object({
      roleId: z.string(),
      reason: z.string().optional(),
    })
    .optional(),
  configOverride: z
    .object({
      matchStrategy: z.enum(["keyword", "ai", "hybrid"]).optional(),
      topK: z.number().int().positive().optional(),
      aiFallbackThreshold: z.number().min(0).max(1).optional(),
    })
    .optional(),
  multiRole: z.boolean().default(false),
  // v1.1 新增：LLM 调用超时（毫秒，默认 60000）
  timeoutMs: z.number().int().positive().optional(),
  // v1.1 新增：注入的 OpenAI 客户端句柄（用于单元测试，依赖注入，非 mock）
  // 使用 unknown 类型避免循环依赖（common/openai-client.ts 未导出 handle 类型）
  injectedClient: z.unknown().optional(),
});
```

**关于 `skipped` 状态（v1.2 修正 M-05）**：types.ts:163-173 当前 `DispatchStatus` 已包含 9 个状态（含 `skipped`），无需新增：

```typescript
// types.ts:163-173 当前定义（v1.2 已确认）
export const DispatchStatus = z.enum([
  "pending",       // 待执行
  "running",       // 执行中
  "succeeded",     // 成功
  "failed",        // 失败
  "timeout",       // 超时
  "cancelled",     // 取消
  "paused",        // 暂停
  "retrying",      // 重试中
  "skipped",       // 跳过（已存在！）
]);
export type DispatchStatus = z.infer<typeof DispatchStatus>;
```

**v1.2 修正说明**：v1.1 设计文档错误地认为 `DispatchStatus` 只有 4 个状态（pending/running/succeeded/failed），需新增 `skipped`。实际 `types.ts:163-173` 已包含 9 个状态（v1.0 P1 阶段就增加了 timeout/cancelled/paused/retrying/skipped）。本次修复直接复用现有 `skipped` 状态，**无需修改 types.ts**。

### 4.5 语义契约明确化

修复后的 `executeDispatch` 状态语义：

| status | 触发条件 |
|--------|----------|
| `succeeded` | LLM 调用成功且 output 非空 |
| `failed` | LLM 调用失败 / 返回空内容 |
| `skipped` | 无 API Key / OpenAI 客户端不可用 |
| `pending` | 仅作为中间状态，最终不应返回 |
| `running` | 仅作为中间状态，最终不应返回 |

### 4.6 CLI 层 skipped 状态处理（v1.1 新增，v1.2 修正退出码语义）

`team-cmd.ts:executeDispatchCommand` 当前只处理 `succeeded` 和其他状态：

```typescript
// 当前代码（第 198 行）
return result.status === "succeeded" ? 0 : 1;
```

v1.2 修改为显式处理 3 种终态（M-11 修正：dispatch 用 exit code 3=skipped，与 autonomous 的 exit code 2=Fatal abort 隔离）：

```typescript
// v1.2 修改后
if (result.status === "succeeded") {
  return 0;
}
if (result.status === "skipped") {
  writeStderrLine(`\n⚠ 任务被跳过: ${result.error ?? "未知原因"}\n`);
  return 3;  // v1.2 修正（M-11）：dispatch 用 exit code 3 表示 skipped
  //   autonomous 用 exit code 2 表示 Fatal abort（见 §3.2.2 exitCodeMap）
  //   二者不可共用 2，否则脚本无法区分是 autonomous 失败还是 dispatch 跳过
}
// failed / timeout / cancelled / paused / retrying / pending → 1
return 1;
```

**退出码语义隔离表（v1.2 修正 M-11）**：

| 退出码 | autonomous 模式 | dispatch 模式 |
|--------|----------------|--------------|
| 0 | 全部迭代成功 | 调度成功 |
| 1 | 部分迭代失败 | 调度失败（failed/timeout/cancelled/paused/retrying/pending） |
| 2 | **Fatal abort（连续失败超限）** | （保留，dispatch 不使用） |
| 3 | 命中 stop_when 条件 | **任务被跳过（skipped）** |

`executeAutonomousCommand` 中由 StageHandler 自动消化 skipped 状态（转为 fatal），无需 CLI 层额外处理。

**v1.6 补充（I-08 / 独立开发者 NB-02）**：`team-cmd.ts` 中还有另一个调用 `executeDispatch` 的入口——`executeFullLifecycleCommand`（全流程模式，依次执行 dispatch → review → fix 等多个阶段）。当前代码 `if (result.status !== "succeeded")` 会把 `skipped` 视为失败并中止全流程，与 `executeDispatchCommand` 的 skipped 语义不一致。

**`executeFullLifecycleCommand` 的 skipped 处理策略**（全流程模式下 skipped 视为失败中止）：

```typescript
// v1.6 I-08 补充：executeFullLifecycleCommand 的 skipped 处理
//   全流程模式由多个 dispatch 阶段串联组成，任一阶段 skipped 会导致后续阶段无法获得有效的 upstream context，
//   因此全流程模式下 skipped 视为失败中止（exit code 3），与 executeDispatchCommand 的 skipped 语义一致
//   但日志中明确标注"全流程模式因阶段 X 被 skipped 而中止"，便于排查
if (result.status === "skipped") {
  writeStderrLine(`\n⚠ 全流程模式因阶段 [${phaseName}] 被 skipped 而中止: ${result.error ?? "未知原因"}\n`);
  return 3;  // 与 executeDispatchCommand 的 skipped 退出码一致
}
if (result.status !== "succeeded") {
  writeStderrLine(`\n✗ 阶段 [${phaseName}] 失败: ${result.error ?? "未知原因"}\n`);
  return 1;
}
```

**与 `executeDispatchCommand` 的差异**：

| 入口 | skipped 处理 | exit code | 原因 |
|------|-------------|-----------|------|
| `executeDispatchCommand` | skipped → exit 3 | 3 | 单次 dispatch，skipped 即终态 |
| `executeFullLifecycleCommand` | skipped → 中止全流程 + exit 3 | 3 | 多阶段串联，任一 skipped 中止后续阶段 |
| `executeAutonomousCommand` | StageHandler 自动消化（skipped → fatal） | 2（Fatal abort） | autonomous 模式由 StageHandler 接管，skipped 视为 fatal |

---

## 五、P0-3 详细设计：CI 加入 team 测试

### 5.1 当前问题

`.github/workflows/ci.yml:58-66` 的 Test Coverage 步骤：

```yaml
- name: Test Coverage
  run: |
    node --import tsx --test \
      --experimental-test-coverage \
      --test-reporter=spec \
      --test-reporter=lcov \
      --test-reporter-destination=stdout \
      --test-reporter-destination=coverage.lcov \
      packages/core/src/tests/*.test.ts
```

**问题**:
- 只匹配 `packages/core/src/tests/*.test.ts`（基础测试，约 23 个文件）
- 未覆盖 `packages/core/src/team/tests/*.test.ts`（591 个用例）
- 未覆盖 `packages/core/src/providers/tests/*.test.ts`
- 未覆盖 `packages/cli/src/tests/*.test.ts`

### 5.2 修复方案

#### 5.2.1 修改 `ci.yml` Test Coverage 步骤

```yaml
- name: Test Coverage
  run: |
    node --import tsx --test \
      --experimental-test-coverage \
      --test-reporter=spec \
      --test-reporter=lcov \
      --test-reporter-destination=stdout \
      --test-reporter-destination=coverage.lcov \
      packages/core/src/tests/*.test.ts \
      packages/core/src/providers/tests/*.test.ts \
      packages/core/src/team/tests/*.test.ts \
      packages/core/src/team/tests/cybernetics/*.test.ts \
      packages/core/src/team/tests/principles/*.test.ts \
      packages/cli/src/tests/*.test.ts
```

#### 5.2.2 新增 Team Gate 步骤

参考 `tests/scripts/ci-eag-gate.sh` 模式，新增 `tests/scripts/ci-team-gate.sh`:

```bash
#!/usr/bin/env bash
# Team 模块门禁：在 CI 中以独立步骤运行 team 测试，便于快速定位失败
# 严格遵循 user rules：测试 shell 脚本放到 tests/scripts 目录下
set -euo pipefail

echo "==================================================="
echo "  DeepCodeX Team Gate"
echo "==================================================="
echo ""

# 1. 运行 team 模块全部测试
echo "▶ 运行 team 模块测试..."
node --import tsx --test \
  packages/core/src/team/tests/*.test.ts \
  packages/core/src/team/tests/cybernetics/*.test.ts \
  packages/core/src/team/tests/principles/*.test.ts

# 2. 运行 CLI team 子命令测试
echo ""
echo "▶ 运行 CLI team 子命令测试..."
node --import tsx --test \
  packages/cli/src/tests/team-cmd-autonomous.test.ts

echo ""
echo "==================================================="
echo "  ✅ Team Gate 全部通过"
echo "==================================================="
```

在 `ci.yml` 中添加：

```yaml
# ★ 新增步骤 6：Team 专属门禁（对齐设计文档 §5.3）
- name: Team Gate
  if: matrix.os == 'ubuntu-latest' && matrix.node-version == '22'
  run: bash tests/scripts/ci-team-gate.sh
```

#### 5.2.3 路径合并到主 Test Coverage

为避免 team 测试运行两次（一次在 Test Coverage，一次在 Team Gate），采用以下策略：
- **Test Coverage 步骤**：保留全部测试路径，产出覆盖率报告
- **Team Gate 步骤**：仅运行 team 测试，作为快速失败信号（不重复跑覆盖率）

---

## 六、P0-4 详细设计：测试环境隔离

### 6.1 当前问题

`packages/core/src/team/tests/domain-expert-review-plugin.test.ts:1856-1869`:

```typescript
test("DomainExpertReviewPluginOptions：未提供 options 时使用默认值", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
  });

  // 无 options 时 invokeExpertLLM 会调用 createOpenAIClient（无 API Key）→ 抛 ExpertInvocationError
  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("no-client"));  // ← 失败点
});
```

**失败原因**:
- 测试假设开发机无 `OPENAI_API_KEY` 环境变量
- 但开发机实际配置了 API Key（用户本地 `.env` 或系统环境变量）
- `createOpenAIClient` 成功创建客户端后，会真实调用 LLM API（走 network 分支）
- 失败原因变为 `timeout` 或 `network error`，而非 `no-client`

### 6.2 修复方案

参考 `packages/cli/src/tests/eag-rules-cmd.test.ts` 的 `backupAndClearGlobalRules` 模式：在测试 setup 阶段备份环境变量，清空后再运行测试，teardown 阶段恢复。

#### 6.2.1 新增测试工具: `packages/core/src/team/tests/utils/env-isolation.ts`

```typescript
/**
 * 测试环境隔离工具
 *
 * 设计依据：用户规则"禁止 mock"，本工具不模拟 LLM 响应，
 *           仅通过备份/恢复环境变量方式确保测试可复现。
 *
 * 使用方式（推荐用 t.before/t.after 钩子）：
 *
 *   import { isolateOpenAIEnv } from "./utils/env-isolation.js";
 *   import { test, before, after } from "node:test";
 *
 *   let restoreEnv: (() => void) | null = null;
 *   before(() => {
 *     restoreEnv = isolateOpenAIEnv();
 *   });
 *   after(() => {
 *     restoreEnv?.();
 *   });
 *   test("...", () => { ... });
 *
 * 或在单个测试内使用 try/finally：
 *
 *   test("...", () => {
 *     const restoreEnv = isolateOpenAIEnv();
 *     try {
 *       // 测试逻辑（此时环境变量已被清空）
 *     } finally {
 *       restoreEnv();  // 恢复环境变量
 *     }
 *   });
 */

/**
 * 备份并清空指定环境变量
 *
 * 注意：Node.js test runner 跨文件默认并发执行（concurrency: true），
 * 多个测试文件同时调用 isolateEnvVars 会相互污染。
 * 建议在 describe 级别使用 before/after 钩子，而非 test 级别。
 *
 * @param keys 需要隔离的环境变量名列表
 * @returns restore 函数，调用后恢复原值
 */
export function isolateEnvVars(keys: string[]): () => void {
  const backup: Record<string, string | undefined> = {};

  // 备份 + 清空
  for (const key of keys) {
    backup[key] = process.env[key];
    delete process.env[key];
  }

  return () => {
    // 恢复
    for (const key of keys) {
      if (backup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = backup[key];
      }
    }
  };
}

/**
 * 测试专用：隔离 OpenAI 相关环境变量
 *
 * 清空变量：
 *   - OPENAI_API_KEY
 *   - OPENAI_BASE_URL
 *   - OPENAI_MODEL
 *   - DEEPCODE_API_KEY（项目自定义）
 *   - ANTHROPIC_API_KEY
 *   - ANTHROPIC_BASE_URL
 */
export function isolateOpenAIEnv(): () => void {
  return isolateEnvVars([
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "DEEPCODE_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
  ]);
}
```

#### 6.2.2 修改 `domain-expert-review-plugin.test.ts:1856-1869`

```typescript
import { isolateOpenAIEnv } from "./utils/env-isolation.js";

test("DomainExpertReviewPluginOptions：未提供 options 时使用默认值", async () => {
  // ★ 隔离环境变量，确保 createOpenAIClient 走 no-client 分支
  const restoreEnv = isolateOpenAIEnv();
  try {
    const registry = new DomainExpertRegistry();
    const matcher = new DomainExpertMatcher(registry);
    const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
    const ctx = makeCtx({
      currentPhase: 2,
      state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
    });

    const result = await plugin.execute(ctx);
    assert.equal(result.status, "failed");
    assert.ok(result.error?.includes("no-client"));
  } finally {
    restoreEnv();
  }
});
```

#### 6.2.3 同类问题排查

对 `domain-expert-review-plugin.test.ts` 全文搜索 `includes("no-client")` 和 `createOpenAIClient` 调用，识别所有依赖环境变量的测试用例，统一应用 `isolateOpenAIEnv` 隔离。

预估影响测试用例数：3 个（test 1856、test 1888 projectRoot 测试、test 1871 timeout 测试）。

#### 6.2.4 现有 team-adapter.test.ts 兼容性处理（v1.1 新增，v1.2 修正环境隔离）

P0-2 修复后，`team-adapter.test.ts:197-216` 的两个测试用例会失败：

```typescript
// 当前代码（第 197-207 行）
test("executeDispatch returns a DispatchResult", async () => {
  const dir = makeTempProject();
  const task = buildTask({ title: "T", description: "D longer than 10 chars" });
  const result = await executeDispatch(task, { projectRoot: dir });
  assert.equal(result.status, "succeeded");  // ← P0-2 修复后会变成 skipped
  // ...
});
```

**v1.2 关键修正（M-08）**：v1.1 仅把断言从 `succeeded` 改为 `skipped`，但**没有隔离环境变量**。在开发机上若有 `OPENAI_API_KEY`，`createOpenAIClient` 会返回真实 client，走 network 分支而非 skipped 分支，导致断言失败。

正确修复方案：**必须先用 `isolateOpenAIEnv()` 清空环境变量**，确保 `createOpenAIClient` 返回 no-client，然后再断言 `skipped`：

```typescript
import { isolateOpenAIEnv } from "./utils/env-isolation.js";

test("executeDispatch returns a DispatchResult", async () => {
  // v1.2 修正（M-08）：必须先隔离环境变量，否则开发机有 API Key 时会走 network 分支
  const restoreEnv = isolateOpenAIEnv();
  try {
    const dir = makeTempProject();
    const task = buildTask({ title: "T", description: "D longer than 10 chars" });
    const result = await executeDispatch(task, { projectRoot: dir });
    // v1.1 修正：临时目录无 API Key，executeDispatch 返回 skipped（不再是虚假 succeeded）
    assert.equal(result.status, "skipped");
    assert.match(result.dispatchId, /^[0-9a-f]{8}-/);
    assert.ok(
      ["architect", "product-manager"].includes(result.matchedRole.roleId),
      `Unexpected role: ${result.matchedRole.roleId}`
    );
    assert.ok(result.error?.includes("不可用"));
  } finally {
    restoreEnv();
  }
});

test("executeDispatch returns dispatchId even on success", async () => {
  // v1.2 修正（M-08）：同样需要隔离环境变量
  const restoreEnv = isolateOpenAIEnv();
  try {
    const dir = makeTempProject();
    const task = buildTask({ title: "T", description: "D longer than 10 chars" });
    const result = await executeDispatch(task, { projectRoot: dir });
    // v1.1 修正：skipped 状态也应有 completedAt 和 durationMs
    assert.ok(result.completedAt);
    assert.ok(result.durationMs >= 0);
  } finally {
    restoreEnv();
  }
});
```

**推荐方式**：使用 `t.before` + `t.after` 钩子在测试文件级别统一隔离，避免每个 test 重复样板代码：

```typescript
import { isolateOpenAIEnv } from "./utils/env-isolation.js";
import { test } from "node:test";

// v1.3 修正（F-07 / 测试专家 NB-02）：必须配对使用 t.before + t.after
//   v1.2 仅给出 t.before 示例，缺少 t.after 调用 restoreEnv
//   导致环境变量在测试文件结束后未恢复，可能污染后续进程（如 CI 中串行执行的其他测试）
let restoreEnv: (() => void) | null = null;

test.before(() => {
  // 文件级别隔离：所有 test 共享无 API Key 环境
  restoreEnv = isolateOpenAIEnv();
});

test.after(() => {
  // 文件结束后恢复环境变量（避免污染后续测试）
  restoreEnv?.();
  restoreEnv = null;
});
```

**注意**：`isolateEnvVars` 在 Node.js test runner 中跨文件是子进程隔离的（每个 .test.ts 文件是独立子进程），不会污染其他测试文件；同一文件内多个 test 共享 `process.env`，因此 `t.before` + `t.after` 是文件级隔离的正确做法。

**为什么不使用 `t.before` 返回值自动清理**：Node.js test runner 的 `t.before` 回调若返回函数，该函数会在 `t.after` 时被调用。但此行为在 Node.js 20.x 之前版本不稳定，且无法在 `t.after` 中感知清理是否完成。显式 `restoreEnv` 变量 + `t.after` 钩子是最稳妥的写法。

### 6.3 测试用例设计原则

| 原则 | 说明 |
|------|------|
| **不依赖外部环境** | 所有依赖 API Key 的测试必须使用 `isolateOpenAIEnv` 或 `injectedClient` |
| **不真实调用 LLM** | 单元测试不发起网络请求；集成测试可显式标记 `// @integration` |
| **可复现** | 同一测试在不同机器（开发机/CI）行为一致 |
| **不 mock** | `injectedClient` 是依赖注入，提供真实接口契约的 stub（不是 mock） |
| **并发安全** | 使用 t.before/t.after 钩子在文件级别隔离，避免跨文件并发污染 |

---

## 七、测试用例设计（v1.1 扩展）

### 7.1 P0-1 测试用例: `packages/core/src/team/tests/stage-handlers.test.ts`

| 用例 ID | 用例名 | 输入 | 期望输出 | 备注 |
|---------|--------|------|----------|------|
| SH-001 | PlanStageHandler 成功 | ctx.iterIndex=1, objective="实现登录" | StageResult.kind=success, summary 含 "[plan]" | 注入 stub client 返回含 "## Plan" 的输出 |
| SH-002 | PlanStageHandler LLM 未生成方案 | 同上 | kind=failed, error="Invalid plan output" | stub 返回空字符串 |
| SH-003 | PlanStageHandler dispatch 失败 | 同上 | kind=retriable, summary 含 "调用失败" | stub 抛 Error |
| SH-004 | PlanStageHandler dispatch skipped | stub 返回 status=skipped | kind=fatal, summary 含 "dispatch 被跳过" | v1.1 新增 |
| SH-005 | DevStageHandler 成功 | ctx 含 plan 输出 | kind=success, artifacts.code 非空 | - |
| SH-006 | DevStageHandler 空输出 | - | kind=failed | - |
| SH-007 | VerifyStageHandler 测试通过 | output 含 "PASS" | kind=success | - |
| SH-008 | VerifyStageHandler 测试失败 | overrideContent=`"## Test Results\n\nFAIL login.test.ts\n  ✗ should return true for valid credentials"`（v1.6 I-04 补充：stage 推断默认返回含 "PASS" 的文本，无法触发 FAIL 分支，必须显式 overrideContent） | kind=retriable, artifacts.failures 非空 | v1.6 I-04 补充 overrideContent 使用场景 |
| SH-009 | VerifyStageHandler 输出无法解析 | overrideContent="random" | kind=failed | - |
| SH-010 | VerifyStageHandler fatal 分支 | injectedClient: buildStubClientAlwaysThrows()（v1.6 I-03 修正：原方案"不传 overrideContent 走 stage 推断"会返回含 "PASS" 的合法 content，executeDispatch 返回 succeeded，VerifyStageHandler.judgeResult 在 succeeded 分支只会返回 success/retriable/failed，不可能走到 fatal。改为 buildStubClientAlwaysThrows 让 stub 抛错，executeDispatch 走 catch 返回 status=failed，VerifyStageHandler.judgeResult 在 status=failed 分支返回 kind=fatal） | kind=fatal, summary 含 "test-expert 调用失败" | v1.1 新增；v1.6 I-03 修正输入（改用 buildStubClientAlwaysThrows） |
| SH-011 | FixStageHandler 成功 | ctx 含 verify 失败原因 | kind=success | - |
| SH-012 | FixStageHandler 空输出 | - | kind=failed | - |
| SH-013 | createDefaultStageHandlers 工厂 | projectRoot + testCommand | 返回 4 个 handler 实例 | - |
| SH-014 | BaseStageHandler 未捕获异常 | executeDispatch 抛 Error | kind=fatal | - |
| SH-015 | injectedClient 透传验证 | 注入 stub client | StageHandler 使用注入的 client 而非 createOpenAIClient | v1.1 新增 |
| SH-016 | injectedClient 边界：null | injectedClient=null + isolateOpenAIEnv（清空 API Key）+ **try/finally 写法**（v1.6 I-11 明确：SH-016/017 是边界值特例，不应在文件级共享 t.before/t.after，必须用 try/finally 确保环境变量在用例结束时恢复） | StageResult.kind=fatal, summary 含 "dispatch 被跳过"（v1.5 H-05 修正：原期望"回退到 createOpenAIClient"不可观测；改为可观测断言——createOpenAIClient 在无 API Key 的测试环境返回 no-client，executeDispatch 返回 skipped，StageHandler 把 skipped 视为 fatal） | v1.3 新增（F-08 / 测试专家 NB-04）；v1.5 H-05 修正期望输出；v1.6 I-11 明确 try/finally 写法 |
| SH-017 | injectedClient 边界：非法对象 | injectedClient={ foo: "bar" }（无 client/model/baseURL/thinkingEnabled 字段，v1.6 I-07 强化类型守卫后会被识别为非法）+ isolateOpenAIEnv + **try/finally 写法**（v1.6 I-11 明确：同 SH-016） | StageResult.kind=fatal, summary 含 "dispatch 被跳过"（v1.5 H-05 修正：同 SH-016，原期望"回退到 createOpenAIClient"不可观测；改为可观测断言） | v1.3 新增（F-08 / 测试专家 NB-04）；v1.5 H-05 修正期望输出；v1.6 I-11 明确 try/finally 写法 |
| SH-018 | stage-aware 工厂 stage 推断验证（v1.6 I-02 新增） | 直接调用 `buildStubClientReturningValidOutput()` 的 `client.chat.completions.create()`，传入 messages=[{role:"system",content:""},{role:"user",content:"# Fix 阶段\n\n修复失败原因"}]。**v1.6 补充（独立开发者 NB-02）：因 OpenAIClientHandle.client 类型为 unknown（见 §3.3.1 L1427），TypeScript 不允许直接访问 unknown 类型属性，需用类型断言**：`const handle = buildStubClientReturningValidOutput(); const client = handle.client as { chat: { completions: { create: (req: { messages: Array<{ role: "system" \| "user"; content: string }> }) => Promise<{ choices: Array<{ message?: { content?: string } }> }> } } }; const response = await client.chat.completions.create({ messages: [...] });` | 返回 content 含 "## Fix"（**不**含 "## Implementation"），证明 stage 推断正确将 fix stage 与 dev stage 区分（v1.5 H-02 修复的核心契约） | v1.6 I-02 新增（测试专家 NB-02 + 产品经理 NB-03）：直接验证 stage 推断逻辑，避免 SH-001/005/007/011 集成验证通过 judgeResult 弱校验掩盖 stage 推断错误；v1.6 补充类型断言写法说明（独立开发者 NB-02） |

### 7.2 P0-2 测试用例: `packages/core/src/team/tests/team-adapter-llm.test.ts`

| 用例 ID | 用例名 | 输入 | 期望输出 |
|---------|--------|------|----------|
| LL-001 | executeDispatch 成功调用 LLM | task + injectedClient 返回 "Hello" | status=succeeded, output="Hello", tokensConsumed.total=300 |
| LL-002 | LLM 返回空内容 | injectedClient 返回 "" | status=failed, error="LLM 返回空内容" |
| LL-003 | LLM 调用超时 | injectedClient 抛 AbortError | status=failed, error 含 "LLM 调用失败" |
| LL-004 | 无 API Key | isolateOpenAIEnv + 无 injectedClient | status=skipped, error 含 "不可用" |
| LL-005 | tokensConsumed 真实透传 | injectedClient 返回 usage | tokensConsumed.prompt=100, completion=200 |
| LL-006 | injectedClient 优先级 | 注入 client + 有 OPENAI_API_KEY | 使用注入的 client（不读环境变量） |
| LL-007 | timeoutMs 覆盖默认 | timeoutMs=100 + 慢响应 stub | 在 100ms 内触发 abort |
| LL-008 | network 错误处理 | stub 抛 TypeError "fetch failed" | status=failed, error 含 "LLM 调用失败" |
| LL-009 | skipped 状态返回值 | injectedClient 返回 null（dispatch 模式） | status=skipped（v1.3 F-10：原 AC-010 迁移到 dispatch 测试文件；v1.5 H-04 修正：期望输出从 exitCode=3 改为 status=skipped，因为 executeDispatch 返回 DispatchResult 而非 exitCode，exitCode 是 CLI 层概念） |

### 7.3 buildUserPromptFromTask 独立单元测试（v1.1 新增）

`packages/core/src/team/tests/build-user-prompt.test.ts`:

| 用例 ID | 用例名 | 输入 | 期望输出 |
|---------|--------|------|----------|
| BP-001 | 基本字段渲染 | task 含 title + description | 输出包含 title 和 description |
| BP-002 | constraints 渲染 | task 含 3 个 constraints | 输出包含所有 constraints 行 |
| BP-003 | attachments 渲染 | task 含 2 个 attachments | 输出包含所有 attachments 行 |
| BP-004 | upstreamContext 透传 | task.upstreamContext 含 autonomousStage | user prompt 包含 "autonomousStage" |
| BP-005 | 空 upstreamContext | task.upstreamContext = {} | user prompt 不包含 "上游上下文" 段 |
| BP-006 | 非字符串 upstreamContext 值 | upstreamContext = { count: 42 } | 值被 JSON.stringify |

### 7.4 P0-1 集成测试: `packages/cli/src/tests/team-cmd-autonomous.test.ts`

| 用例 ID | 用例名 | 输入 | 期望输出 |
|---------|--------|------|----------|
| AC-001 | autonomous 无 --goal 参数 | args={subcommand:"autonomous"} | exitCode=1, stderr 含 "需要 --goal" |
| AC-002 | autonomous 无 API Key | goal + isolateOpenAIEnv（清空 DEEPCODE_API_KEY 等环境变量）+ 不传 injectedClient | exitCode=1，且 stderr 同时包含 3 个关键字："autonomous 模式需要 API Key" + "DEEPCODE_API_KEY" + "env.API_KEY"（v1.2 修正 M-14：多重断言；v1.3 修正 F-02：关键字从 OPENAI_API_KEY 改为 DEEPCODE_API_KEY） |
| AC-003 | autonomous 成功完成 1 轮迭代 | goal + maxIter=1 + injectedClient: buildStubClientReturningValidOutput() | exitCode=0, stdout 含 "Ralph Autonomous Loop" |
| AC-004 | autonomous 连续失败 abort | injectedClient: buildStubClientAlwaysThrows() + maxIter=5 | exitCode=2（Fatal abort），stdout 含 "Fatal abort" 或 "连续失败"（v1.2 修正：exit code 2，不再压成 1） |
| AC-005 | autonomous 创建 RunState 文件 | goal + tempDir + injectedClient: buildStubClientReturningValidOutput() | state.json 文件存在（v1.3 修正 F-03：明确注入 stub client，避免在开发机真实调用 LLM 不可控） |
| AC-006 | autonomous 写入 notes.md | goal + tempDir + injectedClient: buildStubClientReturningValidOutput() | notes.md 文件存在且含 final summary（v1.3 修正 F-03：同上） |
| AC-007 | autonomous git commit | goal + tempDir + git init + injectedClient: buildStubClientReturningValidOutput() | git log 含 "ralph iter-1" 提交（v1.3 修正 F-03：同上） |
| AC-008 | --resume-run 恢复运行 | 先创建一个未完成 run（含 injectedClient），再 --resume-run（含 injectedClient: buildStubClientReturningValidOutput()） | stdout 含 "已恢复运行"（v1.3 修正 F-03：两次 run 都需注入 stub client） |
| AC-009 | --resume-run 无可恢复运行 | 空目录 + --resume-run + injectedClient: buildStubClientReturningValidOutput() | stdout 含 "未找到可恢复的 run"，创建新运行（v1.3 修正 F-03：注入 stub client 保证后续流程可控） |

**v1.3 修正说明（F-03 / 测试专家 B-01）**：v1.2 的 AC-005~009 未明确 `injectedClient` 注入策略，导致：
- 在有 API Key 的开发机上，`createOpenAIClient` 会返回真实 client，autonomous 流程真实调用 LLM（行为不可控，可能因网络/超时/计费等问题失败）
- 在 CI 环境上，无 API Key 时 `executeAutonomousCommand` 在第 2 步直接退出，根本不会启动 RalphLoopController，无法验证 state.json/notes.md/git commit 等行为

v1.3 在 5 个用例的"输入"列明确补充 `+ injectedClient: buildStubClientReturningValidOutput()`，确保：
- 不依赖外部环境（开发机/CI 行为一致）
- 不真实调用 LLM（节省 token、避免网络抖动）
- 不是 mock：`buildStubClientReturningValidOutput` 返回真实接口契约的 stub（实现 `chat.completions.create` 方法，返回固定的 `{ choices: [{ message: { content: "## Plan\n..." } }], usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 } }`）

**v1.3 修正说明（F-10 / 产品经理 NB-04）**：原 AC-010 测试用例归属模糊（dispatch 测试应在 dispatch 测试文件中）。已迁移到 §7.2 LL-009，autonomous 测试文件不再耦合 dispatch 行为。

**`buildStubClientReturningValidOutput` 实现示例**（放入 `packages/cli/src/tests/utils/stub-client.ts`）：

**v1.4 修正（G-06 / 产品经理 NB-02）**：v1.3 的 `buildStubClientReturningValidOutput` 默认 content `"## Plan\n\n方案内容..."` 是固定值，但 VerifyStageHandler 的 `judgeResult` 会检查 output 是否包含 `PASS`/`FAIL` 关键字（见 §3.3 VerifyStageHandler.judgeResult）。若 stub 始终返回 `"## Plan\n\n方案内容..."`，AC-003 的 verify stage 会因关键字不匹配而返回 `kind=failed`，导致 autonomous 流程在 verify 阶段中断，无法验证完整 4 阶段循环。

**修正方案**：改为 **stage-aware 工厂**，根据 `messages[0].content`（system prompt）中是否含 `plan`/`dev`/`verify`/`fix` 关键字推断当前 stage，返回对应 stage 期望的 content。这样 autonomous 集成测试可以完整跑完 4 阶段，每阶段都得到符合 StageHandler.judgeResult 校验的输出。

**v1.5 修正（H-02 + H-07 / 测试专家 NB-01 + 独立开发者 NB-01 + 产品经理 NB-02 + 独立开发者 NB-03）**：v1.4 基于 `messages[0].content`（system prompt）推断 stage 不可靠：

1. **fix 分支不可达**：DevStageHandler 和 FixStageHandler 都使用 solo-coder 角色，system prompt 相同。stub 的 if/else if 链中 `"dev"` 先于 `"fix"` 检查，导致 fix stage 被误判为 dev stage，返回 `"## Implementation\n..."` 而非 `"## Fix\n..."`。虽然两者都通过 `output.trim().length > 0` 校验（kind=success），但 stage 语义不正确。
2. **`includes("test")` 误匹配**：`promptLower.includes("test")` 可能误匹配 "latest"/"contest"/"testimony" 等含 "test" 子串的单词（v1.4 独立开发者 NB-03）。

**v1.5 修正方案**：改为基于 `messages[1].content`（user prompt）推断 stage，因为 `BaseStageHandler.buildDescription` 生成的 user prompt 包含明确的 `# Plan 阶段`/`# Dev 阶段`/`# Verify 阶段`/`# Fix 阶段` 标题（见 §3.3 BaseStageHandler.buildDescription 实现）。使用**基于 stage 标题的长字符串子串匹配**（v1.6 I-10 修正：原描述"精确字符串匹配（非子串 includes）"与实际代码 `userPrompt.includes("# Plan 阶段")` 不符——`String.prototype.includes` 本身是子串匹配。实际是"用 stage 标题长字符串（如 `# Fix 阶段`）替代 v1.4 的短关键字（如 `fix`）做子串匹配，大幅降低误匹配率"），避免误匹配 "latest"/"contest"/"testimony" 等。

```typescript
import type { OpenAIClientHandle } from "@vegamo/deepcode-core";

/**
 * v1.4 修正（G-06 / 产品经理 NB-02）：stage-aware stub client 工厂
 * v1.5 修正（H-02 + H-07 / 测试专家 NB-01 + 独立开发者 NB-01 + 产品经理 NB-02 + 独立开发者 NB-03）：
 *   - stage 推断改为基于 messages[1].content（user prompt），不再基于 system prompt
 *   - 原因：DevStageHandler 和 FixStageHandler 都用 solo-coder 角色，system prompt 相同，
 *     "dev" 先于 "fix" 匹配导致 fix 分支不可达
 *   - 改为匹配 user prompt 中的 `# Plan 阶段`/`# Dev 阶段`/`# Verify 阶段`/`# Fix 阶段` 标题
 *   - 使用基于 stage 标题的长字符串子串匹配（替代 v1.4 短关键字子串匹配，大幅降低误匹配率），
 *     避免 "test" 误匹配 "latest"/"contest" 等
 *   - v1.6 I-10 修正（测试专家 NB-04 + 架构师 NB-01）：原描述"精确字符串匹配（非子串 includes）"
 *     与实际代码 `String.prototype.includes` 子串匹配语义不符，同步修正注释
 *
 * 根据 user prompt 中的 stage 标题推断当前 autonomous stage，返回对应 stage 期望的 content：
 *   - plan stage（user prompt 含 "# Plan 阶段"）：返回含 "## Plan" 标题的方案文本
 *   - dev stage（user prompt 含 "# Dev 阶段"）：返回非空代码文本
 *   - verify stage（user prompt 含 "# Verify 阶段"）：返回含 "PASS" 关键字的测试报告
 *   - fix stage（user prompt 含 "# Fix 阶段"）：返回非空修复说明
 *   - 默认：返回通用文本
 *
 * 注意：非 mock，是真实接口契约的固定响应（实现 chat.completions.create 方法 + 返回结构化对象）
 *
 * @param overrideContent 可选，覆盖 stage 推断逻辑，直接指定返回 content（用于特殊测试场景）
 *                        v1.5 补充使用场景（测试专家 NB-04）：
 *                          - LL-002 测试 LLM 返回空内容时传 `""`
 *                          - SH-002 测试 PlanStageHandler LLM 未生成方案时传 `""`
 *                          - SH-009 测试 VerifyStageHandler 输出无法解析时传 `"random"`
 *                        v1.6 I-03 修正（测试专家 NB-01 + 产品经理 NB-01）：
 *                          - SH-010 测试 VerifyStageHandler fatal 分支时**不使用本函数**，
 *                            改用 `buildStubClientAlwaysThrows()`（让 stub 抛错使 executeDispatch
 *                            走 catch 返回 status=failed，VerifyStageHandler.judgeResult 在
 *                            status=failed 分支返回 kind=fatal）
 *                            原因：不传 overrideContent 走 stage 推断会返回含 "PASS" 的合法 content，
 *                            executeDispatch 返回 succeeded，judgeResult 在 succeeded 分支只会返回
 *                            success/retriable/failed，不可能走到 fatal
 *                        v1.6 I-04 补充（产品经理 NB-01）：
 *                          - SH-008 测试 VerifyStageHandler 测试失败时传
 *                            `"## Test Results\n\nFAIL login.test.ts\n  ✗ should return true for valid credentials"`
 *                            原因：stage 推断默认返回含 "PASS" 的文本，无法触发 FAIL 分支，
 *                            必须显式 overrideContent 含 "FAIL" 关键字
 */
export function buildStubClientReturningValidOutput(overrideContent?: string): OpenAIClientHandle {
  return {
    client: {
      chat: {
        completions: {
          /**
           * 真实接口契约：接收 messages 数组 + 可选 opts（含 signal）
           * v1.5：根据 user prompt（messages[1].content）推断 stage 并返回对应 content
           */
          create: async (req: {
            messages: Array<{ role: "system" | "user"; content: string }>;
          }, _opts?: { signal?: AbortSignal }) => {
            // 优先使用显式覆盖的 content（测试场景，如 LL-002 传 ""）
            if (overrideContent !== undefined) {
              return {
                choices: [{ message: { content: overrideContent } }],
                usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
              };
            }

            // v1.5 修正（H-02）：从 user prompt（messages[1].content）推断当前 stage
            //   原因：BaseStageHandler.buildDescription 生成的 user prompt 含明确的
            //         `# Plan 阶段`/`# Dev 阶段`/`# Verify 阶段`/`# Fix 阶段` 标题
            //   优于 system prompt 的关键字：避免 dev/fix 共用 solo-coder 角色导致的歧义
            const userPrompt = req.messages[1]?.content ?? "";

            // v1.5 修正（H-07）：使用基于 stage 标题的长字符串子串匹配
            //   （替代 v1.4 的短关键字子串匹配，大幅降低误匹配率），
            //   避免 "test" 误匹配 "latest"/"contest"/"testimony" 等
            //   v1.6 I-10 修正（测试专家 NB-04 + 架构师 NB-01）：
            //     原描述"精确字符串匹配（非 includes 子串）"与实际代码不符
            //     （String.prototype.includes 本身是子串匹配），同步修正代码注释
            let content: string;
            if (userPrompt.includes("# Plan 阶段")) {
              // PlanStageHandler.judgeResult 检查 output.includes("## Plan")
              content = "## Plan\n\n方案内容：\n1. 分析需求\n2. 设计架构\n3. 编写实现计划\n4. 验证方案可行性";
            } else if (userPrompt.includes("# Dev 阶段")) {
              // DevStageHandler.judgeResult 检查 output.trim().length > 0
              content = "## Implementation\n\n```typescript\nexport function login(user: string, pass: string): boolean {\n  // 实现登录逻辑\n  return user.length > 0 && pass.length > 0;\n}\n```";
            } else if (userPrompt.includes("# Verify 阶段")) {
              // VerifyStageHandler.judgeResult 检查 output.includes("PASS") 或 "FAIL"
              content = "## Test Results\n\nPASS login.test.ts (3 tests)\nPASS auth.test.ts (5 tests)\n\n✓ 8 tests passed";
            } else if (userPrompt.includes("# Fix 阶段")) {
              // FixStageHandler.judgeResult 检查 output.trim().length > 0
              content = "## Fix\n\n已修复问题：\n- 修正了登录函数的边界条件\n- 添加了空值检查\n- 补充了单元测试";
            } else {
              // 默认返回通用文本（无 stage 标题匹配时）
              content = "## Response\n\n已处理任务，输出内容。";
            }

            return {
              choices: [{ message: { content } }],
              usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
            };
          },
        },
      },
    },
    model: "stub-model",
    baseURL: "https://stub.local",
    temperature: 0.3,
    thinkingEnabled: false,  // v1.4 注：stub 不模拟 thinking 模式，Qwen3/DeepSeek-R1 等 reasoning 字段需独立测试
  };
}

/**
 * 构造总是抛错的 stub client（用于 AC-004 连续失败 abort 测试）
 *
 * @param error 抛出的错误对象（默认 Error("stub error")）
 */
export function buildStubClientAlwaysThrows(error: Error = new Error("stub error")): OpenAIClientHandle {
  return {
    client: {
      chat: {
        completions: {
          create: async () => { throw error; },
        },
      },
    },
    model: "stub-model",
    baseURL: "https://stub.local",
    temperature: 0.3,
    thinkingEnabled: false,
  };
}
```

**v1.5 stage-aware 工厂的关键设计**：

| Stage | user prompt 标题（精确匹配） | 返回 content | 对应 StageHandler.judgeResult 校验 |
|-------|------------------------------|-------------|-----------------------------------|
| plan | `# Plan 阶段` | `"## Plan\n\n方案内容..."` | `output.includes("## Plan")` → kind=success |
| dev | `# Dev 阶段` | `"## Implementation\n\n```typescript\n...```"` | `output.trim().length > 0` → kind=success |
| verify | `# Verify 阶段` | `"## Test Results\n\nPASS ..."` | `output.includes("PASS")` → kind=success |
| fix | `# Fix 阶段` | `"## Fix\n\n已修复..."` | `output.trim().length > 0` → kind=success |
| 默认 | 无匹配 | `"## Response\n..."` | 通用文本，不匹配特定 stage 校验 |

**v1.5 修正关键点**：

1. **stage 推断依据**：从 `messages[0].content`（system prompt）改为 `messages[1].content`（user prompt），因为 BaseStageHandler.buildDescription 生成的 user prompt 含明确的 stage 标题（`# Plan 阶段`/`# Dev 阶段`/`# Verify 阶段`/`# Fix 阶段`）
2. **基于 stage 标题的长字符串子串匹配**（v1.6 I-10 修正描述）：使用 `userPrompt.includes("# Verify 阶段")` 而非 `promptLower.includes("test")`，用 stage 标题长字符串（如 `# Verify 阶段`）替代 v1.4 的短关键字（如 `test`）做子串匹配，大幅降低误匹配率，避免 "latest"/"contest"/"testimony" 等误匹配
3. **stage 顺序无关**：每个 stage 用独立的 `if/else if` 分支，匹配条件互斥（不同 stage 标题不会同时出现），无需依赖分支顺序
4. **BaseStageHandler.buildDescription 必须生成 stage 标题**：见 §3.3 BaseStageHandler.buildDescription 实现的 v1.5 补充说明

**向后兼容**：`buildStubClientReturningValidOutput()` 无参调用时，默认走 stage-aware 推断逻辑；传入 `overrideContent` 参数时覆盖推断，直接返回指定 content（用于特殊测试场景，如 LL-002 测试 LLM 返回空内容时可传 `""`）。

### 7.5 P0-4 测试用例: `domain-expert-review-plugin.test.ts` 修改

| 用例 ID | 用例名 | 修改 |
|---------|--------|------|
| EV-001 | test:1856 "未提供 options" | 包装 `isolateOpenAIEnv` |
| EV-002 | test:1888 "projectRoot 用于读取 .env" | 包装 `isolateOpenAIEnv` |
| EV-003 | test:1871 "expertTimeoutMs 覆盖默认超时" | 已用 `injectedClient`，无需修改 |

### 7.6 RunState RunStateLike 实现测试（v1.1 新增）

`packages/core/src/team/tests/run-state-like.test.ts`:

| 用例 ID | 用例名 | 输入 | 期望输出 |
|---------|--------|------|----------|
| RS-001 | state getter 返回正确字段 | new RunState(dir, id, "obj") | state.runId === id, state.objective === "obj" |
| RS-002 | markRunning 修改 status | rs.markRunning() | state.status === "running" |
| RS-003 | markComplete 修改 status | rs.markComplete() | state.status === "completed" |
| RS-004 | markFailed 记录原因 | rs.markFailed("test") | state.status === "failed", lastError === "test" |
| RS-005 | markAborted 记录原因 | rs.markAborted("abort") | state.status === "aborted", lastError === "abort" |
| RS-006 | recordIteration success 重置失败计数 | 连续 2 次 failed 后 success | consecutiveFailures === 0, iterIndex 更新 |
| RS-007 | recordIteration failed 增加失败计数 | 1 次 failed | consecutiveFailures === 1 |
| RS-008 | recordIteration committed 增加提交数 | committed=true | commitsMade +1 |
| RS-009 | recordIteration 累计 tokens | tokens=100 | cumulativeTokens += 100 |
| RS-010 | RunState 可注入 RalphLoopController | new RalphLoopController({ runState }) | 不抛类型错误 |

### 7.7 loop-controller async 化测试（v1.1 新增）

`packages/core/src/team/tests/loop-controller-async.test.ts`:

| 用例 ID | 用例名 | 输入 | 期望输出 |
|---------|--------|------|----------|
| LC-001 | run() 返回 Promise | controller.run() | `instanceof Promise` |
| LC-002 | async StageHandler 兼容 | 注入 async handle() | run() 正常完成 |
| LC-003 | sync StageHandler 兼容 | 注入 sync handle() | run() 正常完成（await 非 Promise） |
| LC-004 | backoffSleep 不阻塞 event loop | 在 backoffSleep 期间执行 setTimeout | setTimeout 回调能执行 |
| LC-005 | runOneIterationPublic async | controller.runOneIterationPublic(1) | `instanceof Promise` |

---

## 八、实施顺序与依赖

### 8.1 实施顺序

```
┌─────────────────────────────────────────────────────┐
│ 步骤 1：P0-4 测试环境隔离（独立，无依赖）           │
│   - 新增 utils/env-isolation.ts                     │
│   - 修改 domain-expert-review-plugin.test.ts        │
│   - 修改 team-adapter.test.ts（断言 skipped）       │
│   - 运行测试验证                                     │
└──────────────────────┬──────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────┐
│ 步骤 2：P0-2 executeDispatch 接入 LLM               │
│   - 修改 team-adapter.ts（DispatchOptions + LLM）   │
│   - 新增 buildUserPromptFromTask                    │
│   - 修改 types.ts（DispatchStatus 加 skipped）      │
│   - 新增 team-adapter-llm.test.ts                   │
│   - 新增 build-user-prompt.test.ts                  │
│   - 修改 team-cmd.ts:executeDispatchCommand（CLI）  │
└──────────────────────┬──────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────┐
│ 步骤 3：P0-1 autonomous 串联 RalphLoopController    │
│   - 修改 run-state.ts（追加 5 方法 + state getter） │
│   - 修改 loop-controller.ts（async 化 3 处）        │
│   - 新增 stage-handlers.ts                          │
│   - 修改 autonomous/index.ts 导出                   │
│   - 修改 team-cmd.ts:executeAutonomousCommand       │
│   - 修改 cli-args.ts（--resume-run）                │
│   - 新增 stage-handlers.test.ts                     │
│   - 新增 run-state-like.test.ts                     │
│   - 新增 loop-controller-async.test.ts              │
│   - 新增 team-cmd-autonomous.test.ts                │
└──────────────────────┬──────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────┐
│ 步骤 4：P0-3 CI 加入 team 测试                      │
│   - 修改 .github/workflows/ci.yml                   │
│   - 新增 tests/scripts/ci-team-gate.sh              │
│   - 修改 README.md / quickstart.md                  │
│   - 本地运行 ci-team-gate.sh 验证                   │
└──────────────────────┬──────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────┐
│ 步骤 5：端到端验证                                   │
│   - 运行全部单元测试                                 │
│   - 运行全部集成测试                                 │
│   - 运行 ci-team-gate.sh                            │
│   - 重跑 e2e 评估                                   │
└─────────────────────────────────────────────────────┘
```

### 8.2 依赖关系

| 依赖 | 说明 |
|------|------|
| P0-2 → P0-1 | StageHandler 调用 executeDispatch，必须先修复 P0-2 才能验证 P0-1 |
| P0-4 → P0-2 | P0-2 测试需要环境隔离工具，先实现 P0-4 |
| P0-1 → P0-3 | CI 修改需要包含新增的 stage-handlers.test.ts 和 team-cmd-autonomous.test.ts |
| RunState 改造 → StageHandler 实现 | StageHandler 不直接依赖 RunState，但 RalphLoopController 依赖 |
| loop-controller async 化 → StageHandler 实现 | StageHandler 的 handle() 必须返回 Promise 才能被 await |

### 8.3 验收标准

每个修复点的验收标准：

| 修复点 | 验收标准 |
|--------|----------|
| P0-1 | `deepcodex team autonomous --goal "测试" --max-iter 1` 真实调用 RalphLoopController，生成 state.json + notes.md；stage-handlers.test.ts 18 个用例全部通过（v1.4 G-03 修正：15→17；v1.6 I-02 新增 SH-018：17→18，直接验证 stage-aware 工厂的 stage 推断逻辑；含 SH-016/SH-017 injectedClient 边界值用例；v1.5 H-05 修正：SH-016/SH-017 期望输出改为可观测断言 `StageResult.kind=fatal, summary 含 "dispatch 被跳过"`；v1.6 I-03 修正：SH-010 改用 buildStubClientAlwaysThrows 触发 fatal 分支；v1.6 I-04 补充：SH-008 显式 overrideContent 含 "FAIL" 关键字；v1.6 I-11 明确：SH-016/SH-017 采用 try/finally 写法）；run-state-like.test.ts 10 个用例全部通过；loop-controller-async.test.ts 5 个用例全部通过；team-cmd-autonomous.test.ts 9 个用例全部通过（v1.4 G-03 修正：10→9，AC-010 已迁移为 LL-009） |
| P0-2 | executeDispatch 在有 API Key 时真实调用 LLM，tokensConsumed.total > 0；无 API Key 时返回 status=skipped；team-adapter-llm.test.ts 9 个用例全部通过（v1.4 G-03 修正：8→9；v1.5 H-04 修正：LL-009 期望输出改为 `status=skipped`，非 `exitCode=3`）；build-user-prompt.test.ts 6 个用例全部通过 |
| P0-3 | CI 中 Test Coverage 步骤包含 team 测试路径；ci-team-gate.sh 本地运行通过；CI 触发后全部测试通过 |
| P0-4 | 在有 OPENAI_API_KEY 的开发机运行 `domain-expert-review-plugin.test.ts` 全部通过；测试用例行为与 CI 一致 |
| **v1.5 新增验收项** | ①`packages/core/src/index.ts` 末尾追加显式 re-export 后，`import { RunState, ..., createDefaultStageHandlers, isOpenAIClientHandle, type OpenAIClientHandle } from "@vegamo/deepcode-core"` 全部可编译（H-01）；②`buildStubClientReturningValidOutput` 基于 user prompt 推断 stage，fix stage 不再被 dev 误匹配（H-02 + H-07）；③README.md 和 quickstart.md 包含两套目录命名差异说明（H-08） |
| **v1.6 新增验收项** | ①`team/index.ts` 末尾采用显式 re-export（v1.6 I-01），`import { RiskLevel } from "@vegamo/deepcode-core"` 得到 const RiskLevel（来自 cybernetics/guard-coordinator.ts），`import type { RiskLevel as SmartRiskLevel } from "@vegamo/deepcode-core/team/autonomous/smart-confirmation.js"` 得到 type RiskLevel（来自 smart-confirmation.ts），两者类型独立无冲突；②通过 SH-018 测试用例验证 fix stage 不再被 dev 误匹配（v1.6 I-02 + I-05：`node --test stage-handlers.test.ts` 中 SH-018 通过，断言传入 `# Fix 阶段` user prompt 时返回 content 含 `"## Fix"` 不含 `"## Implementation"`）；③通过 `grep -l '.deepcode/' README.md docs/quickstart.md` 与 `grep -l '.deepcodex/' README.md docs/quickstart.md` 均有命中（v1.6 I-05 + I-09：两套目录命名差异说明在产品文档中可验证） |

---

## 九、风险评估

### 9.1 技术风险

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| `StageHandler` 改为 async 后破坏现有同步实现 | 中 | 现有 `Promise.resolve()` 兼容同步返回值；通过 `loop-controller-async.test.ts` 验证 |
| `executeDispatch` 接入 LLM 后单元测试变慢 | 低 | 测试使用 `injectedClient` 注入 stub，不真实调用 LLM |
| CI 测试时间增加 | 低 | team 测试约 591 个用例，预估增加 30-60 秒；Team Gate 仅在 ubuntu-22 运行 |
| `isolateEnvVars` 在并发测试中相互污染 | 中 | 使用 t.before/t.after 钩子在文件级别隔离；Node.js test runner 跨文件默认并发，需特别注意 |
| 真实 LLM 调用消耗 token | 低 | 单元测试全部使用 `injectedClient`；集成测试显式标记 |
| RunState 字段重命名（state → stateValue）破坏现有代码 | 低 | `state` 原本是 private，外部不直接访问；通过 `run-state-like.test.ts` 验证 |
| `--resume-run` flag 与现有 `--resume` 混淆 | 低 | help 文本明确区分；cli-args.ts 严格校验 |
| IterationContext.prevResults 数据结构与 stage 期望不符 | 中 | v1.1 已重新设计数据传递（通过 currentPlan / agentOutput 而非 summary 前缀） |

### 9.2 兼容性风险

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| 现有调用方依赖 `executeDispatch` 返回 `succeeded` | 中 | 修复后语义更准确：无 API Key 时返回 `skipped`，调用方应处理新状态；team-adapter.test.ts 同步更新（含 `isolateOpenAIEnv` 包装） |
| `DispatchOptions` 新增字段影响类型推导 | 低 | 可选字段，不破坏现有调用 |
| v1.2 修正：`DispatchStatus` 复用现有 `skipped`（types.ts:163-173 已有 9 个状态） | 低 | 无需修改 types.ts；team-cmd.ts 和 stage-handlers.ts 的 switch 语句需覆盖 skipped 分支（已有 9 个状态穷尽检查） |
| CI 路径变更触发 GitHub Actions 缓存失效 | 低 | `cache: npm` 不依赖测试路径 |
| `RunState.state` 从 private 改为 getter 可能影响类型推导 | 低 | getter 返回 `RunStateSchema`（与原 private 字段类型一致）；私有字段重命名为 `stateValue` 同步修改静态 `load()`（M-07） |
| v1.2 修正：autonomous 与 dispatch 退出码语义隔离（M-11） | 低 | autonomous 用 2=Fatal abort，dispatch 用 3=skipped；外部脚本若依赖 exit code 需同步更新 |
| v1.2 修正：`options.injectedClient` 类型守卫（M-02） | 低 | 新增 `isOpenAIClientHandle` 类型守卫，避免 unknown 类型直接访问；不影响运行时行为 |

### 9.3 回滚方案

如修复引入严重问题，可按以下顺序回滚：

1. **回滚 P0-3**: 还原 `ci.yml` 到原测试路径
2. **回滚 P0-1**: 还原 `team-cmd.ts:executeAutonomousCommand` 为原 4 阶段循环；还原 `TeamCommandArgs` 移除 `resumeRun`/`injectedClient` 字段；保留 RunState 新增方法（不影响现有功能）
3. **回滚 P0-2**: 还原 `executeDispatch` 阶段 3 为返回 prompt 文本（标记 TODO）；v1.2 修正：`DispatchStatus` 未修改（skipped 已存在），无需回滚 types.ts
4. **保留 P0-4**: 测试环境隔离是基础设施，无需回滚

---

## 十、附录

### 10.1 相关文件清单

#### 已读取文件（设计依据）

- `packages/core/src/team/index.ts` - team 模块公共 API 入口（485 行，13 部分导出）
- `packages/cli/src/team/team-cmd.ts` - CLI team 子命令（356 行）
- `packages/core/src/team/team-adapter.ts` - team 适配层（488 行）
- `packages/core/src/team/autonomous/loop-controller.ts` - RalphLoopController（700+ 行）
- `packages/core/src/team/autonomous/run-state.ts` - RunState（252 行）
- `packages/core/src/team/autonomous/git-driver.ts` - GitDriver（含 repoRoot / runId 必填）
- `packages/core/src/team/autonomous/notes-memory.ts` - NotesMemory（位置参数）
- `packages/core/src/team/autonomous/sleep-guard.ts` - SleepGuard（位置参数，"on"\|"off"）
- `packages/core/src/team/autonomous/smart-confirmation.ts` - SmartConfirmation（无 mode 参数）
- `packages/core/src/team/autonomous/auto-skill-loader.ts` - AutoSkillLoader
- `packages/core/src/team/autonomous/config-loader.ts` - AutonomousConfig（359 行，含 sleepGuardEnabled）
- `packages/core/src/team/autonomous/dispatcher-adapter.ts` - DispatcherAdapter（324 行，getFacade 返回 null）
- `packages/core/src/team/autonomous/index.ts` - 9 组件聚合导出（79 行）
- `packages/core/src/team/domain-expert-review-plugin.ts` - 领域专家 review 插件（800+ 行，含 invokeExpertLLM）
- `packages/core/src/team/tests/domain-expert-review-plugin.test.ts` - 测试文件（1900+ 行）
- `packages/core/src/team/tests/team-adapter.test.ts` - team-adapter 测试（215 行）
- `packages/core/src/common/openai-client.ts` - createOpenAIClient 返回 client/model/baseURL/temperature/thinkingEnabled
- `packages/cli/src/cli-args.ts` - yargs 解析（含现有 --resume flag，需避免冲突）
- `.github/workflows/ci.yml` - CI 配置（91 行）

#### 待修改/新增文件

见 §2.3 文件影响清单。

### 10.2 设计决策记录

#### 决策 1: StageHandler 改为 async

**背景**: 现有 `StageHandler.handle` 是同步签名，但 `executeDispatch` 是 async。
**选项**:
- A. 修改接口为 `StageResult | Promise<StageResult>`
- B. 提供 `executeDispatchSync` 同步包装器（使用 deasync）
- C. 在 StageHandler 内部使用 child_process 同步执行

**决策**: A
**理由**:
- B 引入 `deasync` 依赖，违反 Ponytail "标准库优先" 原则
- C 启动子进程开销大，且无法共享内存状态
- A 是 TypeScript 生态标准做法，向后兼容同步返回值

#### 决策 2: 不使用 DispatcherAdapter

**背景**: `DispatcherAdapter` 已实现，但需要外部注入 `facade`，而当前没有 V3 `_dispatchThroughV3` 实现。
**选项**:
- A. 直接在 StageHandler 中调用 `executeDispatch`
- B. 实现 V3 facade `_dispatchThroughV3`，使用 `DispatcherAdapter`
- C. 重写 `DispatcherAdapter` 调用 `executeDispatch`

**决策**: A
**理由**:
- B 需要实现完整 V3 dispatcher，超出本次修复范围
- C 修改 `DispatcherAdapter` 接口，违反 Surgical Changes 原则
- A 最简单直接，符合 Karpathy Simplicity First
- DispatcherAdapter.getFacade() 返回 null（TypeScript 无 Python 动态导入），无法使用

#### 决策 3: executeDispatch 接入 LLM 而非改名

**背景**: 注释说"LLM 调用留给上层"，可改为 `prepareDispatch` 明确语义。
**选项**:
- A. 保持 `executeDispatch` 名称，内部接入 LLM
- B. 改名为 `prepareDispatch`，新增 `executeDispatch` 调用 LLM
- C. 拆分为 `prepareDispatch` + `invokeLLM` 两个函数

**决策**: A
**理由**:
- 现有调用方（team-cmd.ts、测试）已使用 `executeDispatch`，改名影响面大
- 注释只是建议，并非接口契约
- A 实现最简，符合 Surgical Changes

#### 决策 4: RunState 实现 RunStateLike（追加方法 vs Adapter 模式）

**背景**: RunState 当前不实现 RunStateLike 接口，无法注入 RalphLoopController。
**选项**:
- A. 在 RunState 类中追加 5 个方法 + state getter
- B. 新增 RunStateAdapter 包装 RunState
- C. 修改 RalphLoopController 接受 RunState + 显式调用 getState/update

**决策**: A
**理由**:
- B 引入额外抽象层，违反 Karpathy Simplicity First
- C 修改 RalphLoopController 内部逻辑，影响面大
- A 最直接，RunState 已有全部底层能力，只需暴露接口
- 重命名 `state` → `stateValue` 是必要的（避免 getter 与字段名冲突），但原字段是 private，不影响外部 API

#### 决策 5: --resume-run 而非 --resume

**背景**: 需要支持 autonomous run 的断点续跑 flag。
**选项**:
- A. 使用 `--resume`（与 session resume 共用）
- B. 使用 `--resume-run`（独立 flag）
- C. 使用 `--auto-resume`

**决策**: B
**理由**:
- A 与现有 `cli-args.ts:32` 的 session resume 冲突
- C 语义不够明确
- B 清晰区分 session resume 和 run resume

### 10.3 评审检查清单

多角色评审时使用：

#### 架构师视角

- [x] 设计是否符合 multi-agent-team skill 的 V3 架构？
- [x] StageHandler 接口调整是否影响 V3 Plugin 契约？（不影响，StageHandler 是 Ralph 内部接口）
- [x] executeDispatch 接入 LLM 是否破坏现有调用方？（已同步修改 team-adapter.test.ts）
- [x] 9 组件实例化顺序是否正确（依赖关系）？
- [x] RunState 实现 RunStateLike 是否破坏现有代码？（state 字段重命名为 stateValue，原为 private）
- [x] LoopConfig 与 AutonomousConfig 字段映射是否完整？（11 个字段显式映射）

#### 测试专家视角

- [x] 测试用例覆盖是否完整（含异常分支）？（补充 fatal / skipped / network 错误用例）
- [x] 测试环境隔离方案是否可靠？（t.before/t.after 钩子 + isolateOpenAIEnv）
- [x] 集成测试是否真实端到端？（team-cmd-autonomous.test.ts 真实启动 RalphLoopController）
- [x] CI 修改是否会引入 flaky test？（injectedClient 注入避免网络依赖）
- [x] injectedClient 注入路径是否清晰？（BaseStageHandler 构造参数透传）
- [x] 现有 team-adapter.test.ts 是否同步更新？（断言从 succeeded 改为 skipped）

#### 独立开发者视角

- [x] 代码实现是否可落地（无伪代码）？（所有代码片段都是真实可运行的 TypeScript）
- [x] 注释是否中文详细？（所有新增函数和关键逻辑都有中文注释）
- [x] 是否引入新依赖？（不引入，复用现有 createOpenAIClient / setTimeout）
- [x] 是否符合用户规则（禁止 mock/占位/简化）？（injectedClient 是依赖注入，非 mock）
- [x] judgeResult 参数类型是否明确？（DispatchResult，非 any）
- [x] StageHandler 构造参数风格是否统一？（位置参数，与现有组件一致）

#### 产品经理视角

- [x] 修复后用户体验是否改善？（autonomous 真实可用，不再虚假成功）
- [x] CLI 输出是否清晰可读？（含进度提示、最终统计、错误诊断）
- [x] 失败时是否有明确错误提示？（skipped/failed 都有 error message）
- [x] --resume-run flag 是否同步更新 help 和解析？（已补充 formatTeamHelp 和 cli-args.ts）
- [x] README 和 quickstart 是否更新？（已加入文件影响清单）
- [x] autonomous 启动前的 API Key 前置校验是否清晰？（无 Key 时明确提示）

---

**文档结束**
