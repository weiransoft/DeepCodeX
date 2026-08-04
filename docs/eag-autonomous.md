# EAG 无人值守引擎（/eag-autonomous）

## 概述

EAG 无人值守引擎（EAG-P5）是 Deep Code 的自主编程循环系统。它在无人干预的情况下，自动执行 **plan → dev → verify → fix** 四阶段循环，直到任务完成或触发终止条件。

核心能力：

- **4 阶段循环**：规划任务 → 编写代码 → 运行测试 → 修复失败
- **6 层 15 条 BLOCKER 安全护栏**：路径牢笼、命令黑名单、范围锁、证据强制、凭据白名单、运行时约束
- **三命令完整链路**：启动、查询状态、熔断回滚
- **跨会话续跑**：RunState JSONL 持久化 + NotesMemory 跨轮记忆
- **eag/loop/ 调度层复用**：P5 循环复用通用 LoopScheduler 决策器，统一终止条件语义

---

## 命令一览

| 命令 | 用途 |
|------|------|
| [`/eag-autonomous`](#1-启动循环-eag-autonomous) | 启动无人值守循环 |
| [`/eag-autonomous-status`](#2-查询状态-eag-autonomous-status) | 查询运行状态 |
| [`/eag-autonomous-stop`](#3-熔断回滚-eag-autonomous-stop) | 熔断并回滚到最后一个全绿快照 |

---

## 1. 启动循环 `/eag-autonomous`

### 命令格式

```
/eag-autonomous --goal "<目标>" [--max-iterations N] [--confirmation smart] [--test-command "命令"] [--stop-when "条件"] [--max-tokens N] [--test-timeout-sec N] [--consecutive-failure-abort N]
```

### 参数说明

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `--goal` | 是 | — | 用户目标文本，如 `"为订单服务加退款功能"`，支持单/双引号包裹 |
| `--max-iterations` | 否 | `10` | 最大迭代次数，正整数 1-1000 |
| `--confirmation` | 否 | `smart` | 确认模式：`smart`（智能三态）/ `always-ask`（始终询问）/ `fail-closed`（失败即关闭） |
| `--test-command` | 否 | `npm test` | 测试命令字符串 |
| `--stop-when` | 否 | 空 | 确定性停止条件，如 `"all tests passed"` |
| `--max-tokens` | 否 | `200000` | 最大 Token 预算，正整数 |
| `--test-timeout-sec` | 否 | `600` | 测试超时秒数，正整数 |
| `--consecutive-failure-abort` | 否 | `3` | 连续失败 abort 阈值，正整数 |

### 使用示例

基本用法（使用全部默认参数）：

```
/eag-autonomous --goal "为订单服务加退款功能"
```

自定义迭代次数和测试命令：

```
/eag-autonomous --goal "重构用户认证模块" --max-iterations 20 --test-command "npm run test:unit"
```

设置确定性停止条件和保守确认模式：

```
/eag-autonomous --goal "修复所有 TypeScript 编译错误" --stop-when "all tests passed" --confirmation always-ask
```

### 执行流程

1. **参数解析**：从命令字符串提取 goal 和可选参数
2. **准入检查**（AU-1~6）：方案已批准、工作区隔离、确认守门在线、环境凭据扫描、硬上限已配置、熔断通道可用
3. **禁止场景判定**（AU-N1~N5）：命中任一即拒绝启动
4. **展示确认卡**：用户确认后启动循环
5. **4 阶段循环**：plan → dev → verify → fix，每轮迭代执行这 4 个阶段
6. **终止条件判断**：由 LoopScheduler 决策（复用 eag/loop/ 调度层）
7. **输出 run-id**：供后续 status/stop 查询

---

## 2. 查询状态 `/eag-autonomous-status`

### 命令格式

```
/eag-autonomous-status <run-id>
```

### 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `<run-id>` | 是 | 由 `/eag-autonomous` 返回的运行 ID |

### 使用示例

```
/eag-autonomous-status abc123-def456
```

### 输出内容

- **七段式状态栏**：当前迭代 / 阶段 / 状态 / Token 消耗 / LLM 调用次数 / 连续失败数 / 预计剩余
- **里程碑列表**：每轮 4 阶段全绿的记录
- **阻塞分析报告**（若有）：阻塞 Loop / 迭代 / 阶段 / 原因 / 根因假设 / 建议方案
- **Token 消耗统计**：已用 / 预算 / 剩余

---

## 3. 熔断回滚 `/eag-autonomous-stop`

### 命令格式

```
/eag-autonomous-stop <run-id>
```

### 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `<run-id>` | 是 | 由 `/eag-autonomous` 返回的运行 ID |

### 使用示例

```
/eag-autonomous-stop abc123-def456
```

### 执行行为

1. 调用 `LoopGuard.abort()` + `AutonomousOrchestrator.stop()`
2. 当前轮次完成后退出（最长等待 5 秒）
3. GitDriver 滚动回滚至最后一个全绿快照点
4. 输出回滚目标 tag + 清理的未提交改动清单

> 熔断通过 abort flag 文件实现跨进程 stop：`<projectRoot>/.eag/p5/abort-flags/<runId>.abort`

---

## 4 阶段循环

每轮迭代依次执行以下 4 个阶段：

| 阶段 | StageHandler | 职责 |
|------|-------------|------|
| **plan** | PlanStageHandler | 从 tasks.md 取下一任务卡 + 范围锁预检 + 领域专家匹配 + GuardCoordinator 验证 |
| **dev** | DevStageHandler | 路径牢笼 + 凭据白名单 + 文件状态盘点 + ChangeDiff 制品生成 |
| **verify** | VerifyStageHandler | 真实测试命令执行 + 测试输出解析（Jest/Mocha/node:test/generic）+ 证据强制 |
| **fix** | FixStageHandler | 失败模式分析（6 类分类）+ 修复建议生成 + 清理意图永禁 |

阶段制品链流转：plan 产出 taskCard → dev 产出 changeDiff → verify 产出 testResult → fix 产出 fixSuggestion → 下一轮 plan。

---

## 终止条件

EAG-P5 复用 eag/loop/ 的 LoopScheduler 决策器统一管理终止条件：

| 终止条件 | 触发方式 | 最终状态 |
|----------|---------|---------|
| **stop-when 命中** | verify 通过 + stop-when 条件满足 | `succeeded` |
| **迭代上限到达** | iterIndex + 1 >= maxIterations | `failed`（由步骤 6 统一设置） |
| **连续失败 abort** | consecutiveFailures >= consecutiveFailureAbort | `aborted`（human_checkpoint 优先） |
| **用户熔断** | `/eag-autonomous-stop` | `aborted` |
| **Token 预算耗尽** | totalTokensUsed >= maxTokens | `failed` |
| **超时熔断** | 单轮超时 | `failed` |

> LoopScheduler 通过 `SchedulingDecision.action` 映射到 P5 status：`human_checkpoint` → `aborted`；`stop_failure`（非 max-iter）→ `aborted`；`stop_success`/`continue`/`fix` → 不改变 status（由循环条件处理）。

---

## 安全护栏

EAG-P5 内置 6 层 15 条 BLOCKER 安全护栏，全部 fail-closed（默认拒绝）：

| 层级 | Guard | 规则 | 说明 |
|------|-------|------|------|
| G-A1 | EnvBoundaryGuard | 路径牢笼 | 禁止访问项目根目录之外的文件 |
| G-A1 | EnvBoundaryGuard | 环境变量写保护 | 禁止修改生产环境变量 |
| G-A1 | EnvBoundaryGuard | 生产凭据不可达 | 禁止读取生产凭据文件 |
| G-A2 | DangerousCommandGuard | 黑名单命令 | 禁止 `rm -rf /`、`chmod 777` 等危险命令 |
| G-A2 | DangerousCommandGuard | 递归删除 | 禁止无范围限制的递归删除 |
| G-A3 | ScopeLockGuard | 范围锁 | 禁止修改 tasks.md 未声明的文件（越界返回 ASK 转人工） |
| G-A3 | ScopeLockGuard | 清理意图永禁 | 禁止以"清理"为意图的删除操作 |
| G-A4 | FakeCompletionGuard | 证据强制 | 必须提供测试通过证据才能标记完成 |
| G-A4 | FakeCompletionGuard | 伪完成检测 | 禁止伪造测试结果 |
| G-A5 | CredentialMisuseGuard | 凭据白名单 | 只允许使用白名单内的凭据 |
| G-A5 | CredentialMisuseGuard | commit 前密钥扫描 | commit 前扫描密钥泄漏 |
| G-A6 | RuntimeConstraintGuard | 迭代上限 | 强制执行 maxIterations |
| G-A6 | RuntimeConstraintGuard | 超时熔断 | 单轮超时自动熔断 |
| G-A6 | RuntimeConstraintGuard | 心跳 MAJOR | 心跳丢失触发 MAJOR 告警 |
| G-A6 | RuntimeConstraintGuard | 上限冻结 | 达到上限后冻结配置不可修改 |

---

## 持久化与跨会话续跑

### RunState JSONL 持久化

- **文件位置**：`<projectRoot>/.eag/p5/run-state/<runId>.jsonl`
- **格式**：每行一个 JSON 对象，含 `localChecksum` / `cumulativeChecksum` SHA256 校验
- **API**：`P5RunStateStore.initialize` / `save` / `load` / `verify` / `resume`

### NotesMemory 跨轮记忆

- **文件位置**：`<projectRoot>/.eag/p5/notes-memory/<runId>.md`
- **格式**：每轮迭代追加 `## Iter <iterIndex> / 多阶段` 段落
- **作用**：跨轮迭代传递上下文，避免重复犯错

### better-sqlite3 符号图谱

- **文件位置**：`<projectRoot>/.eag/p5/symbol-graph.db`
- **功能**：符号级 CALLS / INHERITS / IMPLEMENTS / TESTED_BY 图谱
- **SQLite 为唯一事实源**，codemap.json 降级为派生视图

---

## 配置

EAG-P5 的运行时参数通过命令行参数配置（见 [参数说明](#参数说明)），无需额外配置文件。

前置条件：

1. **API Key 已配置**：`~/.deepcode/settings.json` 的 `env.API_KEY` 字段已设置（详见 [configuration.md](configuration.md)）
2. **tasks.md 已准备**：`<projectRoot>/.eag/p5/tasks.md` 含至少一张 `status: pending` 的任务卡
3. **Git 工作区干净**：启动前 `git status` 无未提交改动（或使用 worktree 隔离）

---

## 相关文档

- [configuration.md](configuration.md) — Deep Code 配置说明（含 LLM provider 配置）
- [new-features.md](new-features.md) — DeepCodeX 新特性总览（含 EAG-P5 能力矩阵）
- EAG-P5 需求/架构/Loop 集成/端到端验证等设计文档未入库，实现细节见代码 `packages/core/src/eag/p5/`（含 52 个 E2E 测试用例）
