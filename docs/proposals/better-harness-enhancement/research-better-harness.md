# Better Harness 开源实现调研报告

> 来源：github.com/QoderAI/better-harness（main 快照，2026-10-20）。本地副本：/tmp/better-harness-main
> 定位：阿里云 Qoder 开源的 Coding Agent 工作流审计与持续改进工具，连接 Harness Engineering 与 Loop Engineering。

## A. 核心理念

- **「配置存在 ≠ 被观测使用」**：不把 AGENTS.md / Rules / Skills / MCP / Hooks / Memory / 测试 / CI 的存在当作其生效的证据（models/agent-work-loop.md: "A configured capability is not observed use"）。
- 审计对象不是代码 diff，而是**整个工作闭环**：上下文 → 受控执行 → 变更验证 → 可靠交付 → 经验沉淀。
- 每条改进建议（Finding）必须附：可追溯证据、用户影响、最小修复范围、验证方式。

## B. 三层开源架构

| 层 | 内容 | 关键文件 |
|---|---|---|
| 实践层 | 五大领域参考文档（检查什么、不能下什么结论） | references/{session-evidence, project-harness, agent-customize, loop-engineering, bootstrap, tool-runtimes} |
| 评估模型层 | Agent Work Loop（五维度×3 检查项）、Harness Engineering（F0-F4 流畅度）、Finding 质量门 | models/agent-work-loop.md, models/harness-engineering.md, models/routing.md |
| 工程实现层 | 确定性 CLI（证据采集/校验/渲染）+ 宿主 LLM 提示词（判断） | scripts/better-harness-cli, scripts/session-analysis, skills/better-harness/SKILL.md |

## C. 证据采集模型

- 三类证据：**Session Evidence**（会话如何完成任务的：task episode、工具调用、失败重试、用量、结果证据）/ **Project Harness**（项目是否提供可靠执行-验证-交付路径：CLI、可观测性、设计契约、测试、Git Hooks）/ **Agent Customize**（资产可发现、可适用、实际有效：Rules/Skills/MCP/Memory/Hooks）。
- 单命令冻结证据边界：`<cli> harness evidence-bundle --platform <provider> --workspace <target> --depth quick|normal --since --until --format json`（SKILL.md Step 1）——一次性冻结 topology/provider/窗口/深度/权限，返回 sessionEvidence + projectHarness + agentCustomize + lead 信封。
- 证据缺失**显式保留**（Unobserved / partial），绝不拿配置计数或其他平台数据顶替；normal 模式下任何专家 lane 不可用则阻塞报告。
- 会话数据默认脱敏：语义 facet 化，禁止把原始 prompt/命令/密钥带进读者产物（agent-work-loop.md §3）。

## D. 评估模型（五维度 × 15 检查项）

| 维度 | 检查项 |
|---|---|
| Task Understanding 任务理解 | Intent and Acceptance / Relevant Context / Scope Boundary |
| Controlled Execution 受控执行 | Reproducible Startup / Supported Operation / Permission Boundary |
| Change Validation 变更验证 | Relevant Verification / Failure Diagnosis & Repair / Post-repair Revalidation |
| Reliable Delivery 可靠交付 | Delivery Acceptance / High-risk Approval / Rollback or Recovery |
| Learning Capture 学习沉淀 | Lifecycle Opportunity Detection / Loop Engineering / Longitudinal Validation |

- **七级证据状态**：Present → Wired → Exercised → Outcome-supported；Missing / Unobserved / Not applicable。
- **分数天花板**：证据等级封顶分数——Missing/Unobserved/NA ≤59、Present ≤74、Wired ≤84、Exercised ≤94、Outcome-supported =100。分数只用于定位问题，Findings 由独立证据判断产生，分数永不制造/压制 Finding。
- **Harness Engineering F0-F4**：Missing / Present / Usable / Repeatable / **Enforced（机械验证）**；五条内部透镜（Context/Workbench/Feedback/Constraint/Operating Fluency）。

## E. 确定性脚本层 × 宿主 LLM 层分工

- 脚本层零 LLM：evidence-bundle 采集与冻结、findings JSON schema 校验（`harness render --validate`）、HTML/MD/Canvas 渲染、lint/inventory/integrity 信封。**宿主 LLM 禁止手写 HTML/MD/Canvas**（SKILL.md Step 4）。
- LLM 层：三个并行只读证据代理（session / project / agent-customize，互相隔离不通气），lead 汇聚做一次 reconciliation（合并同因果候选、保留分歧、定 severity 与维度分）→ 质量门（findings-review.md 的 eligibility/consistency/privacy/asset/candidate-promotion gates）→ 按支持轨道（Bootstrap 0→1 / Operationalize 1→60 / Optimize 60→100）定至多 3 条 priority moves。
- 硬上限：证据代理至多 3 个；修复必须 Finding-bound（不越界顺手改）。

## F. 多宿主适配

- 每宿主一个插件目录（.claude-plugin/.codex-plugin/.qoder-plugin/.cursor-plugin/.kimi-plugin/.dsh-plugin），共享同一评估模型；能力差异显式声明（如无 REPORT_RENDERING 能力的宿主只允许 inline 输出）；evidence gap（如 Copilot CLI 无 per-response token）显式保留而非补造。

## G. Loop Engineering 与学习沉淀

- references/loop-engineering：已证实复现的工作应交给哪个机制承载（Skill/Hook/Script/Automation/Rule/Custom Agent），含 loop-discovery（重复工作发现）。
- scripts/memory、scripts/ai-contribution-census：学习沉淀与干预台账（intervention ledger，纵向验证「改进是否真的有效」需后续可比 Task Episode 佐证）。

## H. 报告产物

findings.json（机器可校验）→ `harness render` 产出 HTML / Markdown / Canvas（Qoder/Cursor 持久化）+ .better-harness 报告根目录；render 返回 status: pass 才算成功。

## I. 值得借鉴的实现要点（附证据）

1. 证据包单命令冻结边界（skills/better-harness/SKILL.md Step 1）。
2. 七级证据状态 + 分数天花板（models/agent-work-loop.md）。
3. 「配置存在≠被观测使用」贯穿全部判断（同上 §Review unit）。
4. 三 lane 并行只读证据代理 + lead 单次 reconciliation（SKILL.md Step 2-3）。
5. Finding 四要素（证据/影响/最小修复/验证）+ 质量门（references/findings-review.md）。
6. 渲染必须走确定性 renderer，LLM 禁止手写报告（SKILL.md Step 4）。
7. Finding-bound 修复 + 独立 post-fix 代理更新修复进度（SKILL.md Step 5）。
8. F0-F4 流畅度分级，F4 只给机械验证（models/harness-engineering.md）。
9. 干预台账做纵向验证（models/agent-work-loop.md §intervention ledger）。
10. 会话数据默认脱敏、语义 facet 化（agent-work-loop.md §3）。
11. 计数只用于路由检查，绝不直接产生 Finding 或分数（SKILL.md Step 1）。
12. 证据缺失显式保留 Unobserved，normal 模式下 lane 缺失阻塞报告（SKILL.md Step 2）。

## J. 局限

- 各宿主证据覆盖不齐（无统一入口）；Cursor 插件未上架；历史报告只能记录趋势、不能独立证明某次干预因果；源码开发运行窗口窄（Node 22.20–24.x）。
