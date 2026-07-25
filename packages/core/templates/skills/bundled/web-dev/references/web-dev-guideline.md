# Web Dev 前端美学指南（详细参考）

本文件为 `web-dev` Skill 的详细美学指南，覆盖字体、颜色、动效、空间、背景五大维度，
以及项目初始化、代码质量、UI/UX 最佳实践等开发指引。

## 1. 项目初始化工作流

1. **环境检测**：若 `node` 未安装，必须先安装；已安装则跳过
2. **包管理器优先级**：用户未指定时，若 `pnpm` 存在则优先使用，否则使用 `npm`
3. **脚手架模板**：使用 vite 脚手架创建项目，可用模板：
   - `react-ts`：React + TypeScript + react-router-dom + tailwind + zustand（纯前端）
   - `vue-ts`：Vue + TypeScript + vue-router + tailwind（纯前端）
   - `react-express-ts`：React + TypeScript + Express.js 后端（默认，全栈）
   - `vue-express-ts`：Vue + TypeScript + Express.js 后端（全栈）
4. **依赖版本**：用户有特定版本需求时，直接修改 `package.json` 后执行 `pnpm install` / `npm install`
5. **开发服务器**：后台启动 `npm run dev` / `pnpm dev`，使用 `OpenPreview` 展示预览 URL

## 2. 指导原则（Guiding Principles）

- **语言一致性**：所有响应、解释、人类可读内容必须与 `<user_input>` 同语言；仅代码语法（变量名、函数名）保持英文
- **清晰与复用**：每个组件与页面应模块化、可复用，避免重复 UI 模式
- **一致性**：UI 必须遵循统一设计系统——颜色 token、字体、间距、组件统一
- **简洁性**：优先小型、聚焦的组件，避免样式或逻辑的过度复杂
- **Demo 导向**：结构应支持快速原型，展示流式、多轮对话、工具集成等特性
- **视觉质量**：遵循高视觉质量标准（间距、padding、hover 状态等）
- **测试**：始终用测试验证代码正确性

## 3. UI/UX 最佳实践

### 3.1 视觉层级（Visual Hierarchy）
- 字号限制在 4-5 种字号 + 字重，保持层级一致
- 标注与注释使用 `text-xs`
- 避免 `text-xl` 除非用于 hero 或主标题

### 3.2 颜色使用（Color Usage）
- 使用 1 个中性基础色（如 `zinc`）
- 最多 2 个强调色
- 用 CSS 变量保持一致性
- 主导色 + 锐利强调优于均分布局

### 3.3 间距与布局（Spacing and Layout）
- padding 与 margin 始终使用 4 的倍数，保持视觉节奏
- 长内容流使用固定高度容器 + 内部滚动
- 不对称、重叠、对角流、网格突破元素
- 大量留白或受控密度

### 3.4 状态处理（State Handling）
- 数据获取时使用骨架占位符或 `animate-pulse`
- 可点击元素用 hover 过渡（`hover:bg-*`、`hover:shadow-md`）表示

### 3.5 可访问性（Accessibility）
- 使用语义化 HTML 与 ARIA roles
- 优先使用预构建的 Radix / shadcn 组件（已内置可访问性）

## 4. 字体指南（Typography）

- 选择美观、独特、有趣的字体；**避免** Arial、Inter、Roboto、系统字体等通用字体
- 选择能提升前端美学的有特色字体对
- 配对：一个有特色的展示字体 + 一个精致的正文字体
- 多次生成时**不要**趋同于同一选择（如反复使用 Space Grotesk）
- 在不同生成之间变化字体选择

## 5. 动效指南（Motion）

- 动画用于效果与微交互
- HTML 优先 CSS-only 方案
- React 可用时使用 Motion 库
- 聚焦高影响时刻：一次精心编排的页面加载 + 交错揭示（animation-delay）
  优于分散的微交互
- 使用滚动触发与令人惊喜的 hover 状态
- **克制**：动效必须有目的，不为动而动

## 6. 背景与视觉细节（Backgrounds & Visual Details）

- 营造氛围与深度，而非默认纯色
- 添加与整体美学匹配的上下文效果与纹理
- 创意形式：渐变网格、噪点纹理、几何图案、分层透明、戏剧性阴影、装饰边框、自定义光标、颗粒叠加
- **避免**通用的白底紫色渐变等老套效果

## 7. 反 AI slop 规则（详细）

**NEVER** 使用以下通用 AI 生成美学：
- 过度使用的字体族（Inter / Roboto / Arial / 系统字体）
- 老套配色（尤其白底紫色渐变）
- 可预测的布局与组件模式
- 缺乏上下文特色的千篇一律设计
- 多次生成趋同的选择（如反复使用 Space Grotesk）

**要求**：
- 创造性解读，做出符合上下文的意外选择
- 每个设计都应独特，在明暗主题、不同字体、不同美学之间变化
- 实现复杂度匹配美学愿景：最大化设计需要精心代码 + 丰富动效；
  极简设计需要克制、精准、对间距/字体/细节的极致关注

## 8. 项目结构指南

- `src/components`：组件目录
- `src/hooks`：React 可复用 hooks
- `src/composables`：Vue 可复用 composables
- `src/pages`：页面目录
- `src/utils`：工具函数目录
- `shared`：前后端公共类型定义（如适用）
- `api`：后端代码（除非用户另行要求）
- `migrations`：数据库迁移 SQL 文件（按时间戳命名）
- **不可新建**：`package.json` / `tsconfig.json` / `vite.config.ts` / `tailwind.config.js` / `postcss.config.js` 仅允许修改

## 9. 代码质量指南

- 创建小型、聚焦的组件（< 200 行，含 .tsx / .vue 等）
- 复杂组件或页面拆分为更小的单一职责组件或模块
- 使用 TypeScript 保证类型安全，语法限制在 ES2020 或更早
- 遵循既定项目结构
- 默认实现响应式设计
- 确保 import 正确
- 确保页面上的链接与按钮可点击且功能完整

## 10. React 指南

- 含 JSX 语法的文件必须使用 `.tsx` 扩展名
- 每个组件保持在 300 行以下，超出则拆分
- 每个组件聚焦单一职责
- 可复用逻辑提取为自定义 hooks
- 优先组合而非继承
- 尽可能保持组件纯度
- `import` 声明只能在模块顶层
- **不要**对组件或库使用动态 import 或 lazy loading
- 使用 `zustand` 作为状态管理

## 11. Vue 指南

- Vue 组件必须使用 `.vue` 扩展名
- 必须使用 `<script setup lang="ts">`（Composition API + TypeScript）
- 每个组件保持在 300 行以下，超出则拆分
- 每个组件聚焦单一职责或 UI 单元
- 可复用逻辑提取为 composables（以 `use*` 开头的函数）
- 优先组合而非 mixins 或继承
- 尽可能保持组件纯度与无状态
- `import` 声明必须放在 `<script>` 块顶部
- **不要**对核心或常用组件使用动态 import
- 组件文件名使用 PascalCase（如 `UserCard.vue`）
- 每个 `.vue` 文件定义一个顶层组件

## 12. 图标指南

- **始终**使用 `lucide-react` 中的图标
- 默认**不要**输出 `<svg>` 标签
- **不要**尝试用 Base64 编码生成 PNG 图片或图标

## 13. 后端指南

- 后端为 Node.js 项目时，使用 ESM 格式与 TypeScript

## 14. 测试指南

- 始终为编写的代码编写测试，覆盖所有可能场景
- 根据技术栈选择合适的测试工具与框架
- 测试应易读、易理解
- 测试应独立且隔离，可按任意顺序运行

### 测试示例
1. **前端页面**（React / Vue）：使用 Jest 或 Vitest 编写单元测试并渲染组件
2. **后端 API**：使用 curl 发送请求并检查响应
3. **代码逻辑**：使用 Node.js 模块编写测试文件验证结果
4. **数据库操作**：使用 SQL 查询验证数据完整性与正确性
5. **浏览器页面**：编写 `console.debug` 并在浏览器控制台检查输出，完成后清理
6. **TypeScript 更新后**：执行 `npm run check` 确保代码功能正确且符合质量标准

## 15. 开发服务器指南

- 启动开发服务器（如 `npm run dev` 或 `pnpm dev`）时，后台运行以便继续后续任务
- 开发服务器启动后，使用 `OpenPreview` 工具向用户展示预览 URL

## 16. 文档指南

- 文档必须存放在 `.deepcodex/docs` 目录下
- 开始前始终阅读已有文档
- 产品文档必须存放在 `.deepcodex/docs` 目录，不将其他文件视为产品文档
- 若无法确定哪个文件是产品文档，始终先读取再开始（历史内容可能已过时）

## 17. 待办规则（Todo Rule）

- 不要忘记同时包含前端与后端任务，包括数据库创建、初始数据设置、API 集成
- **空项目优先**：若项目为空，第一个 todo 必须是"创建需求、技术文档与页面设计文档，然后等待用户确认"
- **需求变更优先**：若需求变更，始终添加 todo"更新需求与技术文档，然后等待用户确认"
- **后端集成优先**：生成涉及后端功能或从前端-only 迁移到全栈的 todo 时，若用户未指定后端技术栈，第一个 todo 必须是"按 backend_framework_init_guidelines 初始化后端框架"

## 18. 变量文本转义指南

- 存储含引号的文本变量时，需正确转义
- 可用反斜杠（\）转义引号，或在单引号与双引号之间交替

### 示例
```typescript
// 示例 1：使用反斜杠转义双引号
const message1 = "Welcome to the \"Amazing\" App";

// 示例 2：双引号内使用单引号
const message2 = "Welcome to the 'Amazing' App";

// 示例 3：单引号内使用双引号
const message3 = 'Welcome to the "Amazing" App';
```

### 最佳实践
- 选择最易读的方式
- 在整个项目中保持一致的引号转义风格
