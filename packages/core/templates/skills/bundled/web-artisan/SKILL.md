---
name: web-artisan
description: 全栈 web 应用开发 skill——含 React/Vue/Express/Supabase/Vercel/Stripe 全套开发指南。Use when 用户请求全栈开发、构建 web 应用、实现前后端、集成第三方服务、部署到 Vercel/Netlify 等场景，或需要完整的全栈技术栈指南时。
triggers:
  - 全栈开发
  - 构建 web 应用
  - 实现前后端
  - React 开发
  - Vue 开发
  - Express 开发
  - Supabase 集成
  - Vercel 部署
  - Stripe 集成
  - 全栈技术栈
---

# Web Artisan Skill

本 Skill 为 DeepCodeX-cli 设计，聚焦全栈 web 应用开发，提供
React/Vue/Express/Supabase/Vercel/Stripe 全套技术栈集成指南。

## 1. 概述

本 Skill 引导独立开发者完成全栈 web 应用构建，强调：
- **技术栈完整**：覆盖前端框架、后端服务、第三方集成、部署平台
- **文档先行**：开发前必须完成 PRD 与技术文档
- **真实实现**：严禁 mock/占位/简化，严格按需求实现完整逻辑
- **语言一致**：输出语言严格跟随用户输入语言

## 2. 适用场景

**适用**：
- 用户请求全栈开发、构建 web 应用、实现前后端
- 集成 Supabase/Vercel/Stripe 等第三方服务
- 需要完整的全栈技术栈指南（React/Vue/Express 等）
- 已有项目需接入新框架或服务

**不适用**：
- 0-to-1 greenfield 全流程（应使用 `web-dev` Skill）
- 纯单文件 HTML/JSX 工件（应使用 web 工件类 Skill）

## 3. 执行流程图

```
START
  ↓
PHASE 1: 文档评估（始终首先执行）
  检查 .deepcodex/docs/ 是否已有 PRD + 技术架构文档
  ├── 两份文档均存在且有效 → 进入 PHASE 3
  └── 任一缺失或无效 → 进入 PHASE 2
  ↓
PHASE 2: 文档创建与审批
  生成 PRD 与技术架构文档，存入 .deepcodex/docs/
  通过 AskUserQuestion 工具提交用户审批
  停止并等待用户显式确认
  ├── 用户批准 → 进入 PHASE 3
  └── 用户拒绝 → 修订后重新提交
  ↓
PHASE 3: 全栈开发
  按审批通过的技术栈选型，依 development_handbooks 实现前后端
```

## 4. 指导原则（guiding_principles）

- **清晰与复用（Clarity and Reuse）**：组件与页面模块化、可复用，重复 UI 模式提取为组件
- **一致性（Consistency）**：UI 遵循统一设计系统——颜色 token、字体、间距、组件统一
- **简洁性（Simplicity）**：优先小型、聚焦组件，避免样式或逻辑过度复杂
- **演示导向（Demo-Oriented）**：结构支持快速原型，展示流式、多轮对话、工具集成等特性
- **视觉质量（Visual Quality）**：遵循高视觉质量标准（间距、padding、hover 状态等）

## 5. UI/UX 最佳实践（ui_ux_best_practices）

- **视觉层级（Visual Hierarchy）**：4-5 种字号 + 字重；标注用 `text-xs`；非 hero 标题避免 `text-xl`
- **颜色使用（Color Usage）**：1 个中性基础色（如 `zinc`）+ 最多 2 个强调色；用 CSS 变量保持一致
- **间距与布局（Spacing and Layout）**：padding/margin 使用 4 的倍数；长内容用固定高度容器 + 内部滚动
- **状态处理（State Handling）**：数据获取用骨架占位符或 `animate-pulse`；可点击元素用 hover 过渡
- **可访问性（Accessibility）**：语义化 HTML + ARIA roles；优先 Radix/shadcn 组件（内置可访问性）

## 6. 开发手册概要（development_handbooks）

详细指南见 [references/handbooks.md](references/handbooks.md)，包含：
- **React 指南**：组件拆分、Hooks、状态管理
- **Vue 指南**：Composition API、Pinia
- **Express 后端指南**：路由、中间件、错误处理
- **Supabase 集成指南**：Auth、Database、Storage、RLS
- **Vercel 部署指南**：环境变量、构建配置、rewrites
- **Stripe 集成指南**：支付流程、Webhook（仅后端）
- **路由指南**：React Router / Vue Router
- **状态管理指南**：Redux / Zustand / Pinia
- **代码质量指南**：TypeScript 类型安全、ESLint、Prettier
- **测试指南**：Jest / Vitest / Playwright

## 7. 项目结构指南

推荐的前端项目结构：
- `src/components`：组件目录
- `src/hooks`：React 可复用 hooks
- `src/composables`：Vue 可复用 composables
- `src/pages`：页面目录
- `src/utils`：工具函数目录
- `shared`：前后端公共类型定义
- `api`：后端代码（除非用户另行要求）
- `supabase`：Supabase 配置文件
- `migrations`：数据库迁移 SQL（按时间戳命名）
- **不可新建**：`package.json`/`tsconfig.json`/`vite.config.ts`/`tailwind.config.js`/`postcss.config.js` 仅允许修改

## 8. 合规检查清单（COMPLIANCE CHECKLIST）

开发前必须逐项确认：
- [ ] `.deepcodex/docs/` 已有审批通过的 PRD + 技术文档
- [ ] 语言一致性：所有输出匹配 `<user_input>` 语言
- [ ] 设计美学：拒绝 AI slop，遵循统一设计系统
- [ ] 可访问性：语义化 HTML + ARIA + 键盘可达
- [ ] 测试覆盖：单元测试 + API 测试 + 浏览器验证

**禁止**：
- 跳过文档工作流直接编码
- 未经用户审批擅自开发
- 手动创建文档（须用文档生成流程）

## 9. 与 web-dev 的区别

- **web-dev**：0-to-1 greenfield，PRD → 技术文档 → 开发全流程，聚焦"从零开始构建"
- **web-artisan**：全栈技术栈指南，含具体框架/服务（React/Vue/Express/Supabase/Vercel/Stripe）的集成指南，聚焦"技术栈选型与集成"

两者可协同：greenfield 项目先用 `web-dev` 完成脚手架，再用本 Skill 指导具体框架与服务集成。

## 验证清单

- [ ] Skill 通过 `session.listSkills()` 可被扫描注册
- [ ] 用户输入"全栈开发"/"Supabase 集成"/"Vercel 部署"时自动匹配本 Skill
- [ ] 触发后首先检查 `.deepcodex/docs/` 是否已有文档
- [ ] 文档生成后通过 `AskUserQuestion` 请求用户审批
- [ ] `enabledSkills: {"web-artisan": false}` 可禁用本 Skill
- [ ] 详细开发手册已拆分到 [references/handbooks.md](references/handbooks.md)
