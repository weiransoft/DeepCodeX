# Deep Code 架构：围绕DeepSeek模型构建的harness

Coding Agent的质量不是由模型单独决定的，而是模型(LLM)与其执行框架(harness)共同构成的系统决定的。

Deep Code的终极目标：在智能编码任务上，Deep Code 应当以比“Claude Code + DeepSeek”这套组合更低的成本，取得更好的效果。实现路径不是幻想用一个通用框架让所有模型都表现最佳，而是不断将框架适配最新的 DeepSeek 模型，让模型看到的工具形态、上下文布局、安全规则和恢复路径，都契合它实际的行为方式。

## 这个目标为什么可行

Armin Ronacher 的文章[《Better Models: Worse Tools》](https://lucumr.pocoo.org/2026/7/4/better-models-worse-tools/)指出了一个值得重视的事实：工具 schema 并非「中立」。模型不会把工具模式当作纯粹的抽象约定来遵守，而是带着训练和强化学习过程中形成的使用习惯去接触它。如果某个厂商主要针对一种主流框架训练模型，那么模型可能会非常擅长那个框架的工具生态，却在面对形态不同的工具时意外地不可靠。能力更强的模型可能形成更强的习惯，而更强的习惯会让它更排斥陌生的工具。

这一观察正是 Deep Code 设计的核心依据。Claude Code 是一个为 Anthropic 模型优化的闭源框架，没有理由把 DeepSeek 当作头等对象来对待。而 Deep Code 的选择则是成为 DeepSeek 生态的一部分，它应该为 DeepSeek 量身调优，而不仅仅是“兼容”。

## 核心设计一：通过 snippet 修复工具调用

传统编辑工具往往要求模型提供文件路径以及大段的 `old_string` 和 `new_string`。这看起来直接，但在真实应用场景中，会有多种典型失败：模型可能编辑过时了的文件视图，匹配到错误的重复块，错误地带上行号，丢失缩进，过度替换，或者生成转义错误的 JSON。结果要么是工具调用失败，要么更糟，甚至产生一个看上去合理、实际错误的文件改动。

Deep Code 给出的方案是片段(snippet)系统。`read` 工具除了返回文件内容，还会在文本文件上维护一个会话本地的文件状态，并在元数据中返回 `snippet_id`。`edit` 工具随后将这个 `snippet_id` 作为必填参数。片段携带了文件路径、行范围、预览、版本和范围类型信息。

这重塑了编辑的约定：文件必须先被读过才能编辑，片段必须在当前会话中，文件自读取后未被改动，替换只在片段范围内搜索，非唯一匹配会返回候选片段而不是直接猜测，批量替换可以要求声明预期出现次数。

这是一种理解模型行为、而非放任模型的修复策略。它不强求模型在压力下保持完美，而是让正确操作更容易表达，同时让框架掌握足以发现歧义的局部信息。在接口校验上它保持严格，但在编码智能体常见的、可恢复的文本错误上又给予宽容，使智能体在意图清晰时可以继续向前推进。

内置工具有意保持少而精：`bash`、`read`、`write`、`edit`、`AskUserQuestion`、`UpdatePlan` 和 `WebSearch`，外部 MCP 工具则动态挂载。这是一个刻意的设计决定，它降低了模式的不确定性，让权限分析变得可行，也给了模型一套可预期、可重复的操作语言。

## 核心设计二：缓存感知的上下文管理

第二个核心设计是用上下文缓存控制成本。DeepSeek 的上下文缓存默认启用，当后续请求完全复用了已缓存的前缀单元，就能命中缓存，并在返回值中给出缓存命中与未命中的token数。这是一套尽力而为的系统，但它确实奖励那些稳定的重复前缀。

Deep Code 的会话架构正是围绕这一特性设计的，而且不需要用户刻意配合。系统提示、工具文档、默认技能、运行时上下文和项目说明，这些稳定内容都被放在易变的用户内容之前。会话消息以 JSONL 持久化，并能被一致地重放。工具调用与工具结果的配对在转换时会被修复，包括中断的工具调用，以保证发回给模型的对话始终保持结构有效。

## 核心设计三：以Agent Skills为核心的上下文工程

一个编码智能体不该把所有的知识都塞进上下文里，那样会污染上下文、推高成本，还会削弱指令的优先级。与此同时，很多任务又确实需要可复用的知识：代码审查流程、领域约定、框架特定模式等等。Agent Skills就是在这些知识真正需要时，按需加载的机制。

自动匹配同样借助了模型本身：系统将候选技能的名称和描述发给模型，由模型返回应匹配的技能。已加载的技能不会重复加载，技能也可以声明不参与隐式调用。这一设计让基础框架保持精干，同时又允许丰富的任务特定行为，也使得技能得以跨工具移植。

更深层的架构含义是，技能并非传统意义上的插件，而是被结构化的上下文。它让框架来决定何时把指令、示例、模板、脚本和参考文件引入对话。对于泛化能力强但并非完美的模型来说，这恰恰是最合适的抽象：让默认环境保持干净，在真正能产生帮助的时刻，再注入精准的先验知识。

## 核心设计四：基于副作用分类的权限系统

智能编码必然伴随真实的副作用：读写文件、运行 Shell 命令、访问网络、调用外部工具。一个只提供“全自动模式”的框架不安全，事事弹窗询问又太慢。Deep Code 的创新是引入基于副作用分类的作用域策略。

权限系统定义了具体的作用域，例如目录内外的读、写、删除，Git 日志的查询与修改，网络，MCP 等。`bash` 工具要求模型声明本次操作的副作用，文件工具则根据路径直接分类。

这不仅仅是安全功能，它本身就是智能体质量的一部分。权限给模型提供了一个可预测的操作边界，低风险工作可以快速推进，高风险动作则会停下来。它也让命令行为变得可审查：一条命令不只是待执行的文本，而是文本、所声明的副作用以及策略决策的组合。

## 基准测试

Deep Code 的优势并非来自某个单点妙招，而是源自一系列决策的叠加效应。[deepcode-qrcode-benchmark](https://github.com/qorzj/deepcode-qrcode-benchmark)项目展示了在一个真实且有难度的Python需求上，Deep Code+DeepSeek+`/plan`模式的组合总是能够胜过Claude Code+DeepSeek的组合。

## V2 模块群：上下文记忆与可控执行扩展

V2 模块群是 Deep Code 在四项核心设计（snippet 编辑、缓存感知上下文、Agent Skills、副作用权限）之上构建的扩展层，位于 `packages/core/src/v2/` 目录下，由 `v2/index.ts` 作为公共 API 聚合层统一对外导出。它的设计目标不是替代 V1，而是补充 V1 在长任务记忆、复杂项目理解、高风险操作审批、上下文动态供给等方面的能力。V2 全部模块通过 `integration` 子模块与 V1 集成，遵循"V2 模块引用 V1 依赖的唯一入口是 `v1-adapters.ts`"的边界约束（由 eslint `no-restricted-imports` 强制），不修改 V1 核心逻辑。V2 路线分 P0a/P0b/P1/P2/P3 五个阶段落地，全部完成且测试全绿；其上又叠加了 EAG-P6 的四个 Phase（SymbolGraphAdapter 降级层、DynamicWindowManager、五段式 Prompt 组装、codemap 工具集）。

### 子模块职责

**context（上下文记忆核心）**：提供全局上下文（GlobalContext）、双层上下文管理器（DualLayerContextManager）、滑动窗口（SlidingWindowManager）、渐进式加载（ProgressiveContextLoader）、相关性评分（RelevanceScorer）、上下文同步器（ContextSynchronizer）和任务上下文管理器（TaskContextManager）。任务上下文（TaskContext）封装任务定义、任务状态、工作记忆和技能上下文，是单任务生命周期的完整状态单元；滑动窗口与渐进式加载负责在有限 Token 预算内动态取舍上下文；相关性评分器以关注点（focusPoints）为距离源点集计算文件相关性。该模块还包含 EAG-P6 Phase 1 的 SymbolGraphAdapter 适配层及其降级实现（DefaultSymbolGraphAdapter / StaticSymbolGraph），在图谱模块未实施时静默降级返回空结果。

**memory（记忆持久化与隐私管理）**：提供记忆存储（MemoryStore）、项目记忆（ProjectMemoryManager）、用户全局记忆（UserGlobalMemoryManager）、隐私管理（MemoryPrivacyManager）、内容摘要器（DeepSeek / RuleBased 双实现 + Factory）、经验推荐器（ExperienceRecommender）、.gitignore 过滤器、敏感信息脱敏（SensitiveInfoRedactor）和 `/memory` 命令处理器。摘要器支持 DeepSeek 模型与规则兜底两套实现，脱敏模块作为隐私红线贯穿所有落盘路径。

**codemap（代码地图生成与监视）**：通过正则 AST 分析器（RegexASTAnalyzer）扫描项目，由 CodeMapGenerator 构建包含文件列表、同文件调用关系、跨文件依赖关系、循环依赖检测、项目技术栈与架构信息的代码地图；CodeMapFileWatcher 提供增量更新能力；Markdown 渲染器将 CodeMap 转为可读文档。支持 TypeScript/JavaScript/Python/Java/Rust/Go 多语言。

**understanding（项目理解与业务领域建模）**：ProjectUnderstandingService 在 CodeMap 基线之上识别项目结构、技术栈、架构类型并生成 AGENTS.md 文档；DomainModeler 负责业务领域建模，产出领域概念、关系与规则。项目理解服务复用 CodeMap 检测能力避免双源真相，CodeMap 失败时降级为仅做清单文件识别，不向上抛错。

**diff（Myers diff 与补丁应用）**：实现 Myers diff 算法、模糊匹配补丁应用器（ApplyPatch，参考 DeepSeek-TUI）、补丁摘要生成器（PatchSummaryGenerator）和 Diff 预览增强（enhanceDiffPreview）。ApplyPatch 支持精确匹配、空白容错、滑动搜索与 bigram 相似度评分，覆盖 7 种失败原因映射与 Top-5 候选位置返回，是 V2 对 V1 snippet 编辑的补充编辑路径。

**approval（审批门 / 命令安全 / Side Git / 工具路由）**：ApprovalGate 基于副作用分类做出"自动批准 / 询问用户 / 拒绝"三态决策；CommandSafety 与 ArityClassifier 提供命令安全评分与黑白名单检查；SideGitManager 提供 turn 级快照与回滚能力；ToolRouter 统一路由工具执行并串联审批与快照。审批模式（suggest/auto/never）与应用模式（plan/agent/yolo）正交组合，黑名单检查始终先于模式判断（安全关键）。

**integration（V1/V2 集成 Hook）**：是 V2 与 V1 集成的唯一边界。SessionContextHook 实现"两阶段缓存模式"（异步预计算 + 同步供给），在 buildMessages 热路径上以同步快照注入上下文；approval-hook 与 edit-handler-hook 将 V2 审批与编辑增强挂接到 V1 工具执行生命周期；settings-bridge 实现四层配置合并（内置默认 → 用户设置 → 环境变量 → CLI 参数）；v1-adapters 作为 V2 引用 V1 依赖的唯一入口，全量 re-export V2 需要消费的 V1 公开 API。

**observability（V2 事件日志）**：V2EventLogger 统一记录 4 类日志事件（approval/compression/retrieval/snapshot），所有事件落盘前经 SensitiveInfoRedactor 脱敏，以 JSON Lines 格式追加到 `~/.deepcode/logs/v2-<YYYY-MM-DD>.log`。

**prompt（五段式 prompt 组装与角色定制）**：FiveStagePromptAssembler 按 SystemConstraint(10%) / TaskContext(15%) / CodeMapSnippet(50%) / HistoricalExperience(15%) / OutputRequirement(10%) 五段式组装 prompt（默认 4000 Token 预算，对齐 multi-agent-team skill Token 经济学）；RoleSignalDetector 通过关键词 + 语义匹配（embedder/TFIDF/Hashing 三级降级链）+ 任务类型推断检测角色信号；RolePromptCustomizer 注入角色身份与阶段知识切片（5 角色 × 4 阶段 = 20 个切片）。

**tools（codemap 工具集）**：提供 4 个 codemap 工具（codemap_query / impact_analysis / flow_trace / risk_scan）注册到 V1 ToolExecutor，对应动态窗口的 DW-2/DW-3/DW-4 供给策略。impact_analysis 使用方向感知 BFS（深度 ≤3）+ 独立 DFS 循环检测（深度 ≤10）；flow_trace 使用方向感知 DFS 路径枚举（路径数 ≤20）；risk_scan 扫描高风险符号 Top-N。全部工具在图谱不可用时静默降级返回空结果（NFR-4 零回归）。

### 模块间依赖关系

V2 模块群内部依赖呈分层结构：

- **基础层**：`memory`（记忆存储/脱敏/gitignore）与 `codemap`（代码地图）为底层基础模块，被上层模块消费
- **上下文层**：`context` 依赖 `memory`（经验归档）与 `codemap`（CodeMap 提供文件视图），`understanding` 依赖 `codemap`（复用检测能力）
- **执行层**：`approval` 与 `diff` 相对独立，`approval` 的 SideGit 依赖 V1 git 驱动（经 v1-adapters）
- **工具层**：`tools` 的 4 个 codemap 工具依赖 `context` 的 SymbolGraphAdapter 与 CodeMapSnippetProvider
- **prompt 层**：`prompt` 依赖 `context`（DynamicWindowResult）与 `memory`（历史经验）
- **集成层**：`integration` 依赖上述所有模块，是 V1 调用 V2 的统一入口
- **横切层**：`observability` 被 approval/context/memory 等模块调用记录事件

### 与 V1 模块的集成点

V2 通过 `integration` 子模块与 V1 集成，关键集成点如下：

- **v1-adapters.ts**：V2 模块引用 V1 依赖（语义嵌入、文件工具、智能确认、git 驱动、模式执行器、反馈控制环、Karpathy 原则、Ponytail 决策梯）的唯一入口，由 eslint `no-restricted-imports` 强制约束
- **settings-bridge.ts**：V2 配置经四层合并后注入 V1 配置体系，V2Config 作为 V1 settings 的 `v2` 子树存在
- **session-hook.ts**：SessionContextHook 挂接到 V1 OpenAIMessageConverter 的 buildMessages 热路径，以同步快照方式注入 V2 上下文片段
- **approval-hook.ts / edit-handler-hook.ts**：将 V2 审批门与编辑增强挂接到 V1 ToolExecutor 的 before/after execution 生命周期
- **tool-executor-registry.ts**：将 4 个 codemap 工具注册到 V1 ToolExecutor，与 bash/read/write/edit 等内置工具并列调度

所有集成点遵循"不修改 V1 核心逻辑"原则，V2 能力可通过配置（V2Config.*.enabled）逐项启停，关闭时行为与 V1 完全一致（零回归）。
