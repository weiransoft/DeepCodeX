# 独立开发者视角评审 — 智能体群组能力增强方案 v1

- 评审人：独立开发者（Solo Coder）
- 评审对象：`proposal-v1.md`
- 评审依据：可实现性、代码复杂度、改动路径、工作量、Ponytail 合规

---

## 总体评分：**6 / 10**

## 评审结论：**有条件通过**（3 项阻断性问题，改完可执行）

方案能落地，接口方向也对。但有 **3 处实现细节会给后续挖坑**，另外工作量估算偏乐观约 40%。

---

## 各维度评分

| 维度 | 分 | 说明 |
| --- | --- | --- |
| 可实现性 | 7/10 | 目标清晰，接口签名基本可直接写 |
| 代码复杂度 | 6/10 | L0-1 会引入类型搬迁的连锁改动 |
| 实现路径 | 6/10 | 缺「第一步先做什么」的落地顺序 |
| 工作量准确性 | 4/10 | 8 人日 → 实际约 11-12 人日 |
| Ponytail 合规 | 7/10 | 大部分合规，但 L0-2 的 keywords 生成违反「标准库优先」 |

---

## 🔴 阻断性问题

### B-01：`TeamCommandArgs` 从 CLI 搬到 core，会引发连锁改动的连锁反应，方案低估了

`TeamCommandArgs` 现在定义在 `packages/cli/src/team/team-cmd.ts:72`，被两处依赖：

- `packages/cli/src/ui/core/parse-team-args.ts:19`（`import type { TeamCommandArgs, TeamSubcommand } from "../../team/team-cmd"`）
- `packages/cli/src/ui/views/App.tsx:126`（`import type { TeamCommandArgs } from "../../team/team-cmd"`）

方案要求 `runTeamCommand(args: TeamCommandArgs)` 进 core，意味着 `TeamCommandArgs` 也要搬到 core。**迁移路径必须写清楚**，否则会出现「core 定义一份、CLI 又定义一份」的双定义。

**修法**：明确顺序与兼容层：

```ts
// core/commands/team-command.ts
export interface TeamCommandArgs { ... }        // 唯一权威定义

// cli/team/team-cmd.ts
export type { TeamCommandArgs, TeamSubcommand } from "@vegamo/deepcode-core";  // 纯 re-export
```

先搬类型、再搬实现、最后删 CLI 侧定义。三步各自可编译、可测试。

### B-02：「删除 App.tsx 的 write 拦截」风险被严重低估

方案 4.2 表格里写「删除 App.tsx 的 write 拦截」，像是顺手清理。但那 30 行不是普通代码：

```ts
// App.tsx:2242-2270
process.stdout.write = interceptedStdoutWrite as typeof process.stdout.write;
process.stderr.write = interceptedStderrWrite as typeof process.stderr.write;
```

它处理了 Node.js `write` 的**三种重载**（`(chunk, cb)` / `(chunk, encoding, cb)` / `(chunk, encoding, fd, cb)`），并在 `finally` 里恢复。这段代码的存在说明**团队曾经被「team 输出破坏 Ink 渲染」坑过**。

如果 `runTeamCommand` 真的完全不写 stdout，删除是安全的。但**第三方依赖可能在内部写 stdout**（比如某些日志库），删掉拦截后 Ink 仍会被破坏。

**修法**：分两步、可回退。

1. 保留拦截代码，但改为**默认关闭**（用一个常量 `INTERCEPT_TEAM_STDOUT = false` 控制）。
2. 跑一轮真实 TUI 手工验证（`/team list`、`/team dispatch`、`/team autonomous` 各一次），确认渲染无破损后再删代码。

不要在同一次提交里既改执行体又删拦截。

### B-03：L0-2 的 `keywords` 从 description 分词不可行（违反 Ponytail 决策梯第 2 级）

方案写 `keywords`：「从 `description` 分词 + `group` 标签推导」。

中文分词需要词典/分词器。项目现有依赖里没有（`package.json` 未见 jieba / nodejieba / segmentit 之类）。自己写一个「按标点切」的伪分词，产出质量极差——会把「负责增长方案设计与投放优化」切成无意义片段，反而拉低匹配质量。

**Ponytail 决策梯第 2 级「标准库优先」+ 第 1 级「YAGNI」** 的正确答案是：

```ts
// 只做确定性、可解释的映射，不假装做 NLP
keywords: [group, ...groupToKeywords(group)]   // group 是 8 个固定类别，枚举映射
```

即：**只用 `group`（8 个固定值）映射到固定关键词集**，不碰 description。这样：

- 零新依赖
- 行为完全可预测、可测试
- 匹配质量靠 `group` 的语义密度保证，而不是靠脆弱的伪分词

若将来确实需要 description 语义，走 L1-2 已经引入的 `DomainExpertMatcher`（它有 embedder 路径），不在这里造轮子。

---

## 🟡 建议性改进

### S-01：L1-2 的「score ≥ 阈值」缺具体数值，不可实现

方案 7.2 反复出现「阈值」但从未给出数字。实现者会随便填一个。

建议：直接引用既有权重常量 `DOMAIN_MATCH_WEIGHTS`（已在 `domain-expert-matcher.ts` 导出），阈值取「高于随机基线的 1.5 倍」，并给出初值 0.6 + 可配置项 `team.expertInjection.minScore`。

### S-02：L1-1 路径 B 的窄接口命名太宽，容易变成后门

`runWithSystemPromptOverride(prompt, task)` 这种签名会被滥用于「绕过正常 system prompt 组装」。

建议改为更窄、更难误用的形态：

```ts
/** 仅用于 team dispatch：一次性、临时会话、不可嵌套 */
export interface EphemeralRunOptions {
  roleSystemPrompt: string
  task: string
  maxToolRounds: number
  /** 强制走审批链，不可关闭 */
  readonly requireApproval: true
}
runEphemeral(opts: EphemeralRunOptions): Promise<EphemeralRunResult>
```

`requireApproval` 设为字面量 `true` 类型，让「关掉审批」在编译期就不可能。

### S-03：L1-3 的事件日志建议直接复用 `RunState` 的落盘机制

`team/autonomous/` 已有 `RunState` + SHA256 校验 + resume（`core/index.ts:783` 导出）。再写一套 `events.jsonl` 等于维护两套运行记录。

建议：先花半天读 `RunState` 实现，若它可以追加事件（而不只是快照），就在其上扩展；若不行，在方案里**写明为什么不能用**，再新建。

### S-04：工作量估算偏乐观

| 阶段 | 方案估算 | 我的估算 | 差异原因 |
| --- | --- | --- | --- |
| L0-1 | 1.5 天 | 2.5 天 | 类型搬迁 + 3 处调用点改 + Ink 渲染回归验证 |
| L0-2 | 1.5 天 | 1.5 天 | 一致 |
| L1-1 | 2 天 | 3.5 天 | 触碰 `session.ts`（8000+ 行），窄接口 + 临时会话 + 审批强制，回归面大 |
| L1-2 | 1 天 | 1 天 | 一致 |
| L1-3 | 2 天 | 2.5 天 | 崩溃修复 + 并发隔离 |
| **合计** | **8 天** | **11 天** | +37% |

另外**没算**：Tauri 桌面壳重新打包验证（约 0.5 天）、四平台 `cargo check`（0.5 天）、评审往返（1 天）。

### S-05：缺「第一步先做什么」的落地顺序

方案是分层而不是分步。实际动手时应该按「先补测试 → 再改实现」的 TDD 顺序拆任务（测试专家 S-04 也提了这点）。建议给出 8 个可独立提交的 commit 序列。

### S-06：轻量建议 —— `switchModel` 的确认框文案可以借这次机会统一

本次 Composer 的模型切换用 `window.confirm`。如果 L0 阶段要动 Composer（加 team 入口），建议顺手换成项目内的 toast/确认组件，避免原生弹窗在 Tauri 里的观感割裂。**但这属于顺手改，按 Surgical Changes 原则应单独提交**。

---

## 🟢 亮点

1. **4.4 节「为什么不复用 EAG 的自动注入通道」解释得非常好**——把「用户主动输入」vs「模型主动建议」区分开，避免了最容易被误用的那条路。这种「说明为什么不走另一条路」的段落，比只讲「我要怎么做」有用得多。
2. **B4 负向用例（删除 SKILL.md 后角色消失）** 说明作者想到了生命周期，不只是 happy path。
3. **L1-1 只增窄接口不改既有分支**，这是触碰巨型文件时的正确姿势。
4. **每个 L 层都配了验收标准**，可直接转成任务清单。
5. **N5「不引入新运行时依赖」** —— 这条约束让整个方案的可落地性提高了一个档次。

---

## 与项目最新代码结合的证据

| 结论 | 证据 |
| --- | --- |
| `TeamCommandArgs` 定义位置与两处依赖 | `packages/cli/src/team/team-cmd.ts:72`、`ui/core/parse-team-args.ts:19`、`ui/views/App.tsx:126` |
| write 拦截处理三种重载 | `packages/cli/src/ui/views/App.tsx:2242-2270` |
| 无中文分词依赖 | `packages/core/package.json` 依赖清单 |
| 领域匹配权重常量已导出 | `packages/core/src/team/index.ts:256-262`（`DOMAIN_MATCH_WEIGHTS` / `DOMAIN_AI_MATCH_WEIGHTS`） |
| `RunState` 已导出 | `packages/core/src/index.ts:783`（`RunState, listRuns, findLatestResumableRun`） |
| session.ts 规模 | 8000+ 行（`wc -l`） |
| Composer 用原生 confirm | `packages/web/web/src/components/Composer.tsx`（`switchModel` 内 `window.confirm`） |
