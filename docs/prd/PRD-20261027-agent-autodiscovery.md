# PRD：自定义 Agent + Skill/Agent 自动发现沉淀 + Web 同步与多工作空间

- **PRD 编号**：PRD-20261027-agent-autodiscovery
- **日期**：2026-10-27
- **作者**：产品经理 许清楚（Xu）
- **状态**：Draft（待架构师评审）
- **适用包**：core / web / cli（同步变更）

---

## 1. 项目信息

- **Language**：简体中文
- **Programming Language**：TypeScript（monorepo：npm workspaces，packages：cli / core / web / vscode-ide-companion / quality）；Web 前端为 React 19（无路由库、无状态库，构建脚本 `packages/web/web/build.mjs`）
- **Project Name**：`agent-autodiscovery`
- **原始需求复述**（4 条，全部中文用户）：
  1. 用户可根据自己的需求定义**自定义 Agent**（类似已有 skill 的定义方式）；
  2. 系统**自动发现并总结**可沉淀的 skill / Agent，形成沉淀物，之后按需调用（对话 → 挖掘 → 沉淀 → 复用闭环）；
  3. 以上能力在 **Web 端同步可用**；
  4. Web UI 支持**多工作空间切换**。

---

## 2. 现状调研结论（2026-10-27 实际读码确认）

### 2.1 Skill 机制（可复用基座）

- 加载器：`packages/core/src/skill-manager.ts`（SkillManager），扫描 6 个根目录，优先级从高到低：
  1. `<projectRoot>/.deepcode/skills`（项目级）
  2. `<projectRoot>/.agents/skills`（项目级兼容）
  3. `~/.deepcode/skills`（用户级）
  4. `~/.agents/skills`（用户级兼容）
  5. `~/.trae-cn/builtin_skills`（平台复用）
  6. `bundled:`（内置，`packages/core/templates/skills/bundled/`，最低优先级）
- 定义格式：`<skill-name>/SKILL.md`，gray-matter frontmatter（`name` / `description` / 可选 `metadata.allow-implicit-invocation`，bundled 内已有 `triggers` 用法）；同名技能高优先级根覆盖低优先级。
- 调用机制：LLM 经 `skill` 工具（`packages/core/src/tools/skill-handler.ts`）调 `onLoadSkill(name)` 注入 prompt；已加载技能记录在消息 `meta.skill`；隐式匹配（identifyMatchingSkillNames）在 SessionManager。启用开关：settings `enabledSkills`。

### 2.2 Agent 现状（无用户自定义入口）

- **不存在**通用用户自定义 subagent 机制。现有「agent」均为内置硬编码：
  - `packages/core/src/team/role-registry.ts`：5 个固定角色（architect 等，systemPromptPrefix 完整硬编码）；
  - `packages/core/src/team/workflows/pattern-executor.ts`：fanout 动态生成 subagent，但 role 只能取内置 registry 的值；
  - team/autonomous 编排、EAG 动态建议器（`createEagDynamicSuggester`）均为内置。
- 结论：自定义 Agent **应复用 skill 体系的扫描/去重/启用机制**，扩展定义格式表达「角色 + 行为约束」，避免发明第二套文件体系。

### 2.3 沉淀现状

- 已有「沉淀」= MemoryStore 经验沉淀（`experience.json` / `execution-history.jsonl`，含增量沉淀、`flushSedimentation` 兜底、结构化日志，见 `docs/dev/eag-web-sedimentation-fixes.md`）——但沉淀对象是**经验记忆**，不是 skill/Agent。
- 已有「对话 → LLM 建议」通道：EagDynamicSuggester（建议 EAG 命令 + 白名单自动执行，CLI/Web 均已接通）。
- 结论：skill/Agent 沉淀可复用上述两条既有链路（建议通道 + 沉淀兜底），新增「沉淀物落盘为 SKILL.md 草稿」环节。

### 2.4 Web 与工作空间现状

- `packages/web`：REST + SSE 后端（`session-pool.ts` 每 chat 一个进程内 SessionManager；`chat-registry.ts` 聊天注册表）。
- 工作空间现状（`docs/dev/web-workspace.md`，已实施）：
  - **personalOnly（默认 true）**：服务端强制 `projectRoot = <uploadDir>/<userId>`（单根，用户不可选）；引擎数据落 `<homeRoot>/.deepcodex/projects/<projectCode>/`，`projectCode = getProjectCode(projectRoot)`；
  - **shared 模式**：`allowRoots` 白名单牢笼，chat 创建时信任 body.projectRoot 但仅限白名单内；
  - 会话存储：`sessions-index.json` + `<sessionId>.jsonl`，按 projectCode 隔离。
- 前端（`packages/web/web/src`）：React 19 + SSE，组件含 SessionSidebar / ChatPane / Composer 等；**当前无任何工作空间切换 UI**。
- 结论：多工作空间的存储基座（projectCode 隔离、sessions-index 按项目分目录）已天然支持，缺的是「per-user 多个可用 projectRoot 的配置 + 校验 + chat 绑定 + 前端切换器」。

---

## 3. 产品定义

### 3.1 Product Goals

1. **可定义**：中文用户零文档门槛地用 Markdown 文件定义自己的 Agent，与 skill 同一套心智和存放习惯；
2. **可沉淀**：对话中反复出现的方法论能被系统自动识别、总结为 skill/Agent 草稿，经用户确认后沉淀复用，形成「对话 → 挖掘 → 沉淀 → 复用」闭环；
3. **两端一致**：CLI 与 Web 行为对齐；Web 端补齐多工作空间切换，一个界面管理多个项目。

### 3.2 User Stories

1. 作为中文用户，我想在 `~/.deepcode/` 下写一个 Markdown 文件定义「代码评审 Agent」，以便每次 `/agent` 或对话触发时它以固定角色和约束帮我评审；
2. 作为中文用户，当我连续几次对话都在教系统同一套排查步骤时，我希望系统主动提示「这段流程可以沉淀为 skill」，我确认后就自动生成 SKILL.md，之后新会话能自动复用；
3. 作为 Web 用户，我希望在 Web 端也能看到沉淀建议、确认或忽略，并且沉淀的 skill 在 CLI 与 Web 中均可加载；
4. 作为 Web 用户，我希望在侧边栏切换我的多个项目工作空间，切到哪个空间就看到哪个空间的会话与文件；
5. 作为管理员，我希望用户可选的工作空间严格限定在服务端配置的白名单内，任何越权 projectRoot 都被拒绝。

---

## 4. 需求池

> P0 = Must have；P1 = Should have；P2 = Nice to have。每条附验收标准。

### P0（必须有）

| # | 需求 | 说明 | 验收标准 |
|---|------|------|----------|
| P0-1 | **自定义 Agent 定义与加载** | 复用 SkillManager 扫描/去重/优先级/`enabledSkills` 机制，新增 Agent 定义格式（复用 SKILL.md，frontmatter 增加角色语义字段，如 `type: agent` + `role`/`tools` 等，具体以架构师方案为准），扫描根与 skill 一致（新增 `agents/` 目录或同目录标识，二选一，见待确认 Q1）。CLI 可列出、可调用 | ① 用户在扫描根内放置合法 Agent 定义文件后，CLI 重启可发现并列出（含名称/描述/来源根）；② 调用后其角色约束注入会话并生效（产出行为与定义一致）；③ frontmatter 非法（缺 name/description）时有明确中文报错且不中断其余技能扫描；④ 同名覆盖优先级与 skill 一致并有单元测试 |
| P0-2 | **Skill/Agent 自动发现与沉淀** | 会话收尾（轮次结束或 `flushSedimentation` 时机）由 LLM 分析对话，识别可沉淀的模式，生成 SKILL.md/Agent 定义**草稿**；经**用户确认**后写入 `.deepcode/skills`（项目级或用户级，用户选择）；复用 EagDynamicSuggester 建议通道与沉淀兜底（增量/flush/崩溃兜底）语义 | ① 复现型对话触发沉淀建议（含草稿预览）；② 用户确认后草稿落盘为合法 SKILL.md（可被 P0-1/SkillManager 扫描到）；③ 用户拒绝则不写盘且本会话不重复建议同一条目；④ 全程 try/catch 隔离，沉淀失败不影响会话（沉淀结构化日志有记录）；⑤ 新会话中沉淀物可被识别/加载（闭环验证） |
| P0-3 | **Web 端能力同步** | Web 会话注入与 CLI 同源的 Agent 定义加载与沉淀触发（装配沿用 core 单一装配源模式，参考 eag-assembly 下沉先例）；Web 端提供沉淀建议卡片（预览/确认/忽略） | ① 同一 Agent 定义在 CLI 与 Web 均可发现并调用，行为一致；② Web 端收到沉淀建议并可确认/忽略，确认后落盘路径与 CLI 语义一致；③ CLI 既有行为零回归（既有测试全绿） |
| P0-4 | **Web 多工作空间** | 服务端新增 per-user 可用工作空间列表（严格限定在 allowRoots 白名单内 / personalOnly 场景见 Q4）；chat 创建时绑定 workspace（projectRoot）；`listChats` 按 workspace 过滤；前端侧边栏新增工作空间切换器 | ① 新建 chat 时可选择工作空间；② 切换工作空间后会话列表仅显示该空间的会话；③ 越权 projectRoot（不在白名单/他人空间）创建 chat 返回 403（回归 web-workspace.md R5 防线测试）；④ 会话与文件读写牢笼不因多空间放宽（jail 测试全绿） |

### P1（应该有）

| # | 需求 | 说明 | 验收标准 |
|---|------|------|----------|
| P1-1 | Agent 参与 team/workflows 编排 | 自定义 Agent 可被 role-matcher / pattern-executor 的 `subagent_role` 等内置编排点引用（优先级低于内置 5 角色或可覆盖，方案待定） | workflows 指定自定义 role 名时成功实例化；未定义时回退内置角色并告警 |
| P1-2 | Web 端 Skill/Agent 管理视图 | 列出当前工作空间与用户级可用的 skill/Agent（来源、启用态），支持启用/禁用（写 `enabledSkills`） | 列表与 CLI `listSkills` 一致；禁用后该空间新会话不再加载 |
| P1-3 | 沉淀物版本与迭代 | 同名沉淀物二次建议时生成修订草稿（diff 预览），确认后覆盖并保留历史 | 覆盖前有历史备份；diff 在 Web/CLI 均可查看 |
| P1-4 | 沉淀建议节流与去噪 | 按 sessionId/内容指纹去重；建议频率可配置（settings） | 同一模式不重复弹建议；配置项有默认值与文档 |

### P2（可以有）

| # | 需求 | 说明 | 验收标准 |
|---|------|------|----------|
| P2-1 | 自定义 Agent 带工具白名单 | frontmatter 声明该 Agent 可用工具集，调用时收窄权限 | 越权工具调用被拒并有提示 |
| P2-2 | 沉淀物跨设备同步/导出 | 导出沉淀为 zip / 从导入恢复 | 导入后可被扫描加载 |
| P2-3 | Web 工作空间管理 UI | 用户在 Web 端查看可用工作空间列表与只读元信息（增删仍走服务端配置） | 列表与配置一致 |

---

## 5. UI Design Draft（Web）

1. **会话侧边栏顶部**新增「工作空间切换器」：下拉展示当前用户可用工作空间（名称 + projectRoot 缩略路径），选中后下方的会话列表按该空间过滤；当前空间高亮。
2. **新建会话**入口：默认使用当前选中的工作空间；创建请求携带 workspace 标识（服务端仍做白名单强校验）。
3. **沉淀建议卡片**（ChatPane 消息流内）：LLM 建议出现时插入卡片，含标题（建议沉淀为 skill / agent）、生成草稿预览（Markdown 折叠）、操作按钮【确认沉淀】【忽略】；确认后卡片态变为「已沉淀 → <落盘路径>」。
4. **Agent 管理入口（P1）**：侧边栏底部「技能/Agent」页签，列表含名称、描述、来源根（`./.deepcode/skills` / `~/.deepcode/skills` / `bundled:`）、启用开关。
5. CLI 侧：`/skills`、`/agents`（或既有 slash 体系扩展）列出与调用；沉淀建议复用既有建议注入回路（CLI 有客户端注入通道，Web 走卡片）。

---

## 6. 待确认问题（Open Questions）

> 按约束，以下重大歧义不在 PRD 内自行拍板，需架构师/主理人确认。

1. **Q1 自定义 Agent 的定义载体**：独立 `AGENT.md` + 独立 `agents/` 扫描根，还是复用 SKILL.md 增加 frontmatter 字段（`type: agent`）？倾向后者（Simplicity First：完全复用 SkillManager 扫描/去重/启用链），**且需等 DeepSeek Harness（dsh）的自定义 Agent 与 skill 发现机制结论**由主理人转交后对齐，避免实施后返工。
2. **Q2 Agent 的执行模型**：角色约束注入当前会话（prompt 注入，轻量），还是独立子会话/子上下文执行（隔离性强，涉及 interrupts、审批、牢笼传递等大量改造）？此决策影响工作量数量级，需架构师评估。
3. **Q3 沉淀写入位置与审核策略**：默认人工确认（PRD 现方案）还是可配置自动沉淀？写入项目级（`.deepcode/skills`，影响协作者）还是默认用户级？涉及时序：轮次结束实时分析（成本高）还是会话结束/每 N 轮批量分析？
4. **Q4 personalOnly 与多工作空间的冲突**：现网默认 personalOnly 强制单根个人区（web-workspace.md R1/R5 已实施）。多工作空间是否仅对 shared 模式开放？personalOnly 用户的多空间诉求（如多个子目录）如何在不破坏凭据防线（R5：个人区不得成为凭据来源）的前提下实现？需架构师给出方案后再定 P0-4 的适用范围。
5. **Q5 沉淀物质量兜底**：LLM 生成的 SKILL.md 草稿是否需要质量门槛（如最小长度、描述必填、触发词抽取）与安全审查（防止沉淀物注入恶意指令，沉淀物会进入后续会话 prompt）？
6. **Q6 与 dsh 对齐范围**：团队同步分析中的 dsh「一切皆插件」内核与本仓 EAG/team 体系的对应关系，是否影响 P1-1（Agent 参与编排）的设计方向？

---

## 7. 里程碑建议（供排期参考，非承诺）

1. **M1**：P0-1 自定义 Agent（core 扫描/调用 + CLI）→ 2. **M2**：P0-4 Web 多工作空间（后端白名单 + 前端切换器）→ 3. **M3**：P0-2/P0-3 沉淀闭环（core 触发 + 双端 UI）→ 4. **M4**：P1 打磨（管理视图、编排接入、节流）。
