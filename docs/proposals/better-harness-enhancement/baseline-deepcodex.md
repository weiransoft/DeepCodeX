# DeepCodeX 现状基线报告

> 扫描对象：/Users/wangwei/Documents/VG/DeepCodeX-cli（packages/core + packages/web + desktop，Node/TS monorepo）

## A. 项目定位与架构

CLI 优先的 AI 编码助手 monorepo，最近完成 Web 化与桌面化：**packages/core**（引擎：agent 循环、工具系统、会话、EAG 门禁/评估器、规则、技能、记忆、沉淀引擎）→ **packages/web**（Express HTTP 服务 + React 前端）→ **desktop**（Tauri/Rust 桌面壳）。核心抽象是 SessionRuntime（packages/core/src/session-runtime.ts，1400+ 行）：创建会话 → 系统提示组装 → 消息循环 → 工具执行 → 响应流式返回。

## B. Agent 执行循环现状

- **消息循环与工具执行**：SessionRuntime.run（packages/core/src/session-runtime.ts:300-560）维护 messages 数组，通过 while 循环调用 LLM 直到无 tool_use；工具执行器 packages/core/src/tools/executor.ts 分发到各工具。
- **重试与退避**：packages/core/src/utils/retry.ts 指数退避；**circuit-breaker.ts** 在连续失败时熔断。
- **事件系统**：packages/core/src/events/（emitter.ts、types.ts）定义 40+ 事件类型（message、tool_call、session_lifecycle），事件总线供 UI 订阅。
- **执行历史**：SessionRuntime 在会话目录持久化 **execution-history.jsonl**（packages/core/src/session/execution-history.ts），记录每轮 turn 的消息与工具调用——这是最接近 Session Evidence 的资产。
- **上下文压缩**：自动压缩机制在会话超过阈值时触发，摘要历史并保留系统提示。

## C. 五大资产现状

| 资产 | 现状 | 关键路径 |
|---|---|---|
| Rules（RLIS 规则体系） | 三层规则库（core `eag/rlis`：RuleStore/RuleInjector/SEED_RULES），最近新增 global-rules.ts（~/.deepcodeX/rules/global-rules.json，Web UI CRUD，会话创建时注入系统提示） | packages/core/src/global-rules.ts、eag/rlis/*；规则触发时 violationCount 自动统计，**但统计结果无消费闭环** |
| Skills | 技能系统：SKILL.md 解析、渐进加载（加载时去重）；最近新增 loadSkillPromptAsMessages（提示词级注入，不写磁盘） | packages/core/src/skills/ |
| Memory | 三层记忆：cloud（服务端生成，只读注入）/ user（~/.workbuddy/.../MEMORY.md，显式编辑）/ workspace（.workbuddy/memory/，自动追加）；跨设备同步已实现；全局记忆含内置 redaction.ts 脱敏 | packages/core/src/memory/ |
| Tools | 内置工具 30+（bash、文件、搜索、进程、联网等），统一 schema 校验 + 权限墙（allowlist/denylist + 危险命令拦截） | packages/core/src/tools/ |
| Hooks | **无 pre/post 钩子系统**（与 Claude Code hooks 对齐的能力空白） | — |

## D. 可观测性/证据留存现状

- 会话历史：完整 JSONL 持久化（~/.deepcodeX/projects/...，含 sessionId、时间戳、消息、工具调用、token 用量）。
- execution-history.jsonl：每轮 turn 记录。
- packages/core/src/v2/：v2 架构迁移中，含 observability/ 与 events/（结构化日志 + 事件溯源）。
- **空白**：无聚合视图；无「资产使用证据」——规则触发有计数但无链路回溯，skill 加载无使用统计，记忆读取无命中统计。

## E. EAG 质量闭环现状（对照 Harness 概念）

- packages/core/src/eag/：gate.ts（G 系列门禁，规则评估）、**independent-evaluator.ts**（已定义 IndependentEvaluatorProtocol 接口）、verdict.ts（判定）、runner.ts（执行器）、sedimentation-engine.ts（**经验沉淀引擎，v0**）、sedimentation-writer.ts（v0.1，待完成 finding-bound 结构）。
- CHANGELOG 与 git log 显示最近 20 次提交集中在：T01（custom agents 子代理）、T02（sedimentation-writer）、T05（自主循环稳健化：退避策略、错误分类、边界 case 处理）、全局规则系统（本次会话新增）。
- **空白**：①无资产使用证据链；②无统一证据聚合命令（evidence bundle）；③无跨会话审计/趋势视图；④沉淀建议无 Finding-bound 结构；⑤无重复工作发现机制。

## F. 与「工作流审计/持续改进」的能力对照小结

已有：会话持久化、执行历史、EAG 门禁/评估器协议、规则触发计数、v2 事件溯源、记忆脱敏。
缺失：证据状态语义（Present/Wired/Exercised...）、证据包聚合、Finding-bound 建议结构、重复工作→资产升级的 loop discovery、纵向干预台账、审计报告渲染。
