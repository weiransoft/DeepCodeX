---
name: web-dev
description: 0-to-1 greenfield web 开发全流程 skill——从 PRD 到技术文档到代码实现。Use when 用户请求创建网站、开发前端、构建 web 应用、设计页面、实现 UI 等场景，或需要从零开始构建 web 项目时。
triggers:
  - 创建网站
  - 开发前端
  - 构建 web 应用
  - 设计页面
  - 实现 UI
  - greenfield 开发
  - 从零开始
  - web 项目
---

# Web Dev Skill

本 Skill 专为 DeepCodeX-cli 设计，覆盖 0-to-1 greenfield web 开发全流程：
从需求确认 → PRD/技术文档生成 → 用户审批 → 项目初始化 → 代码实现 → 测试验证。

## 1. 概述

本 Skill 引导独立开发者完成从零开始的 web 项目构建，强调：
- **文档先行**：先 PRD 与技术文档，后代码实现
- **美学优先**：拒绝通用 AI slop 美学，追求有品牌感的设计
- **真实实现**：严禁 mock/占位/简化，严格按需求实现完整逻辑
- **语言一致**：输出语言严格跟随用户输入语言

## 2. 适用场景

**适用**：
- 用户明确要求从零创建新的 web 项目、网站、页面、应用或 web 游戏
- 工作区为空或不含前端代码（无 package.json / index.html / .tsx / .vue 等）
- 需要完整 PRD + 开发流程

**不适用**：
- 已有前端项目的增量修改、bug 修复、功能追加
- 已建立代码库的渐进式开发（应走常规开发流程）

## 3. 文档工作流

**CRITICAL**：开发前必须完成文档工作流。

### Step 3.1 检查已有文档
检查 `.deepcodex/docs/` 目录是否已有 PRD 与技术架构文档：
- 两份文档均存在 → 跳到 Step 3.3 直接进入开发
- 文档缺失或不完整 → 进入 Step 3.2 创建

### Step 3.2 创建文档（如不存在）
1. 生成 PRD（产品需求文档）：含目标、用户、功能列表、非功能需求
2. 生成技术架构文档：含技术栈、目录结构、数据流、API 设计、Mermaid 图
3. 所有文档存入 `.deepcodex/docs/` 目录
4. Mermaid 图节点 label 必须用引号包裹
5. 除非用户指定，默认 desktop-first 设计

### Step 3.3 用户审批
- 文档生成后必须使用 `AskUserQuestion` 工具通知用户审批
- 用户审批后不再重复确认开始开发
- 仅当缺失关键信息或安全/不可逆操作时才再次询问

## 4. 语言一致性规则（最高优先级）

**CRITICAL**：所有生成的文档、代码注释、响应必须匹配 `<user_input>` 使用的语言：
- `<user_input>` 为中文 → 生成中文文档与中文章节标题
- `<user_input>` 为英文 → 生成英文文档
- 模板仅为结构参考，必须翻译所有占位文本为用户输入语言
- 代码语法（变量名、函数名）保持英文

## 5. 设计思维

编码前必须明确以下四个维度，并承诺一个鲜明的美学方向：

- **Purpose（目的）**：界面解决什么问题？谁是用户？
- **Tone（调性）**：选择一种鲜明的风格——极简、最大化混乱、复古未来、有机自然、奢华精致、俏皮玩具、编辑杂志、野兽派、艺术装饰、柔和粉彩、工业实用等
- **Constraints（约束）**：框架、性能、可访问性等技术约束
- **Differentiation（差异化）**：什么让这个作品令人难忘？记忆点是什么？

**关键**：选择一个清晰的概念方向并精准执行。极致的最大化和精炼的极简都可行——核心是有意图性。

## 6. 前端美学指南（概要）

详细指南见 [references/web-dev-guideline.md](references/web-dev-guideline.md)，核心要点：

- **Typography（字体）**：4-5 种字号 + 字重；避免 Arial/Inter 等通用字体，选择有特色的字体对
- **Color（颜色）**：1 个中性基础色 + 最多 2 个强调色；用 CSS 变量保持一致
- **Motion（动效）**：克制、有目的；优先 CSS-only，React 可用 Motion 库；聚焦高影响时刻
- **Spatial（空间）**：4 的倍数间距；不对称、重叠、对角流、网格突破
- **Backgrounds（背景）**：避免渐变/噪点等通用效果；用创意形式营造氛围与深度

## 7. 反 AI slop 规则

**NEVER** 使用以下通用 AI 生成美学：
- 过度使用的字体族（Inter / Roboto / Arial / 系统字体）
- 老套配色（尤其白底紫色渐变）
- 可预测的布局与组件模式
- 缺乏上下文特色的千篇一律设计
- 多次生成趋同的选择（如反复使用 Space Grotesk）

**要求**：每个设计都应独特、有品牌感、为上下文量身定制。在明暗主题、不同字体、不同美学之间变化。

## 8. 开发流程

- **Step 1 需求确认**：如有疑问用 `AskUserQuestion` 工具询问（仅限阻塞性问题）
- **Step 2 文档创建**：按 §3 生成 PRD + 技术文档
- **Step 3 用户审批**：等待用户审批文档
- **Step 4 项目初始化**：使用 vite / react-ts / vue-ts 等模板脚手架；优先 pnpm
- **Step 5 代码实现**：严格按 PRD 与技术文档实现，遵循美学指南
- **Step 6 测试验证**：单元测试（Jest/Vitest）+ API 测试（curl）+ 浏览器验证（console.debug）

## 9. 与 EAG 协同

本 Skill 可与 EAG（企业应用生成）的 `coding/` 模块协同：
- EAG 的 `skeleton-generator` + `llm-filler` 可参考本 Skill 的美学指南生成前端代码
- EAG 的 `strict-evaluator` 可校验生成代码是否符合美学规则
- 本 Skill 不修改 EAG 既有代码，仅作为提示词指引

## 验证清单

- [ ] Skill 通过 `session.listSkills()` 可被扫描注册
- [ ] 用户输入"创建网站"/"开发前端"时自动匹配本 Skill
- [ ] 触发后首先检查 `.deepcodex/docs/` 是否已有文档
- [ ] 文档生成后通过 `AskUserQuestion` 请求用户审批
- [ ] `enabledSkills: {"web-dev": false}` 可禁用本 Skill
- [ ] 详细美学指南已拆分到 [references/web-dev-guideline.md](references/web-dev-guideline.md)
