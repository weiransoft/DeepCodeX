# Web Artisan 开发手册（详细参考）

本文件为 `web-artisan` Skill 的详细开发手册，覆盖 React/Vue/Express/Supabase/Vercel/Stripe
等全栈技术栈的集成指南，以及路由、状态管理、代码质量、测试等工程实践。

## 1. React 开发指南

### 1.1 文件与组件约定
- 含 JSX 语法的文件必须使用 `.tsx` 扩展名
- 每个组件保持在 300 行以下，超出则拆分为更小的单一职责组件
- 复杂组件或页面拆分为逻辑子组件，或将可复用逻辑提取为独立模块
- 优先组合而非继承，尽可能保持组件纯度

### 1.2 Hooks 使用
- 可复用逻辑提取为自定义 hooks（以 `use*` 开头的函数）
- `import` 声明只能在模块顶层，不可在条件块或函数内部
- **不要**对组件或库使用动态 import 或 lazy loading
- 遵循 Hooks 规则：不在循环、条件或嵌套函数中调用 Hooks

### 1.3 状态管理
- 使用 `zustand` 作为状态管理方案
- 示例：
```typescript
import { create } from 'zustand'

// 创建全局 store，保持单一职责
const useStore = create((set) => ({
  count: 0,
  // 通过 set 更新状态，返回新的状态片段
  increment: () => set((state) => ({ count: state.count + 1 })),
}))
```

### 1.4 路由约定
- 使用 `react-router-dom`，路由组件直接 import，**禁止** lazy loading 路由组件
```tsx
{/* 错误：对顶层路由使用 lazy */}
<Route path="/cart" element={lazy(() => import('@/pages/Cart'))} />
{/* 正确：直接 import */}
<Route path="/login" element={<Login />} />
```

## 2. Vue 开发指南

### 2.1 文件与组件约定
- Vue 组件必须使用 `.vue` 扩展名
- 必须使用 `<script setup lang="ts">`（Composition API + TypeScript）
- 每个组件保持在 300 行以下，超出则拆分
- 组件文件名使用 PascalCase（如 `UserCard.vue`）
- 每个 `.vue` 文件定义一个顶层组件

### 2.2 Composition API
- 可复用逻辑提取为 composables（以 `use*` 开头的函数）
- 优先组合而非 mixins 或继承
- `import` 声明必须放在 `<script>` 块顶部
- **不要**对核心或常用组件使用动态 import

### 2.3 状态管理（Pinia）
- 使用 Pinia 作为状态管理方案
```typescript
import { defineStore } from 'pinia'

// 定义 store，使用 setup 风格
export const useCounterStore = defineStore('counter', () => {
  const count = ref(0)
  // 通过函数暴露修改逻辑，保持状态可追踪
  const increment = () => count.value++
  return { count, increment }
})
```

### 2.4 组件示例
```vue
<!-- 正确：直接 import 顶层路由组件 -->
<script setup lang="ts">
import Login from '@/views/Login.vue'
</script>

<template>
  <Login />
</template>
```

## 3. Express 后端指南

### 3.1 项目约定
- 后端为 Node.js 项目时，使用 ESM 格式与 TypeScript
- `package.json` 中 `"type": "module"` 启用 ESM
- 语法限制在 ES2020 或更早

### 3.2 路由组织
- 按资源/领域拆分路由模块，保持单一职责
```typescript
import { Router } from 'express'
import type { Request, Response } from 'express'

// 创建路由实例，按资源维度组织
const userRouter = Router()

// 定义 RESTful 端点，保持 HTTP 语义清晰
userRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params
  // 真实查询逻辑，严禁 mock
  const user = await findUserById(id)
  res.json(user)
})

export default userRouter
```

### 3.3 中间件
- 通用中间件（日志、CORS、JSON 解析）在应用入口注册
- 特定路由中间件按需挂载，保持职责单一
- 异步中间件必须捕获异常并传递给错误处理中间件

### 3.4 错误处理
- 统一错误处理中间件，签名必须是 4 参数（err, req, res, next）
- 区分客户端错误（4xx）与服务端错误（5xx）
- 生产环境不泄露堆栈信息
```typescript
// 统一错误处理中间件，必须注册在所有路由之后
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error(err.message)
  res.status(500).json({ error: 'Internal Server Error' })
})
```

## 4. Supabase 集成指南

### 4.1 配置约定
- 使用 `supabase` 目录存储 Supabase 配置文件
- 前端使用 ANON_KEY；SERVICE_ROLE 密钥仅在安全的服务端环境使用，**严禁**暴露到前端
- 通过环境变量注入密钥，不可硬编码

### 4.2 Auth 集成
- 直接使用 Supabase Auth 处理用户账户，**不**单独创建 users 表（除非用户明确要求）
- 前端通过 `supabase.auth` 进行登录、注册、会话管理
- 服务端通过 SERVICE_ROLE 验证 JWT 并获取用户身份

### 4.3 Database 与 RLS
- 以技术文档为基准生成表结构、访问控制规则、初始数据
- 除非用户明确要求，**避免**使用物理外键约束，改用逻辑（应用层）外键
- RLS 策略：insert/update 用 `with check` 表达式，delete 用 `using` 表达式
- **重要**：仅启用 RLS 不足够，还须显式为 `anon` 与 `authenticated` 角色授予对应权限
- 生成代码中确保 user ID、文件路径等字段与 RLS 规则对齐，防止权限绕过或数据泄露

### 4.4 权限排错
遇到 `permission denied for table [your_table]` 错误时：
- 未登录用户：为 anon 角色授予基础读权限 `GRANT SELECT ON [your_table] TO anon;`
- 已登录用户：为 authenticated 角色授予完整权限 `GRANT ALL PRIVILEGES ON [your_table] TO authenticated;`
- 检查现有权限：
```sql
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
ORDER BY table_name, grantee;
```

### 4.5 Storage
- 使用 Supabase Storage 管理文件上传，bucket 权限与 RLS 策略对齐
- 上传文件路径包含用户 ID，确保与 RLS 规则一致

## 5. Vercel 部署指南

### 5.1 配置文件
- 使用 `vercel.json` 配置 Vercel 部署
- 使用 `rewrites` 段处理 API 路由，将前端路由代理到后端
- **禁止**使用已废弃的 `functions` 段

```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" }
  ]
}
```

### 5.2 环境变量
- 所有密钥（Supabase keys、Stripe keys 等）通过 Vercel 项目环境变量注入
- 区分 Development / Preview / Production 环境
- **严禁**将密钥提交到代码仓库

### 5.3 构建配置
- `tsconfig.json` 在部署时不支持 references 或 path aliases，需提前调整或提示用户
- 确保构建脚本（`npm run build`）在本地可成功运行
- 部署前验证环境变量已正确注入

## 6. Stripe 集成指南

### 6.1 架构原则
- **重要**：Stripe 仅提供后端服务，所有 Stripe 与支付相关逻辑必须在后端实现，**严禁**在前端实现
- 前端仅负责调用后端 API 触发支付流程，不直接调用 Stripe Secret Key

### 6.2 支付流程
1. 前端调用后端 API 创建 PaymentIntent / Checkout Session
2. 后端使用 Stripe Secret Key 创建支付意图
3. 前端使用 Stripe.js / Elements 收集支付信息并确认支付
4. Stripe 通过 Webhook 通知后端支付结果

### 6.3 Webhook 处理
- 后端注册 Stripe Webhook 端点，验证签名防止伪造
- 处理 `payment_intent.succeeded`、`payment_intent.payment_failed` 等事件
- Webhook 必须幂等，重复事件不产生副作用
```typescript
import Stripe from 'stripe'

// 使用 Stripe Secret Key 初始化客户端（仅后端）
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

// Webhook 签名验证，确保请求来自 Stripe
export function verifyStripeWebhook(rawBody: Buffer, signature: string): Stripe.Event {
  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET!
  )
}
```

## 7. 路由指南

### 7.1 React Router
- 使用 `react-router-dom`，路由组件直接 import
- 嵌套路由使用 `<Outlet />` 渲染子路由
- 路由守卫通过包装组件实现鉴权
- **禁止**对顶层路由使用 `React.lazy` 或动态 import

### 7.2 Vue Router
- 使用 `vue-router`，路由配置使用 Composition API 风格
- 命名路由便于维护与反向解析
- 路由懒加载仅用于真正需要的场景（如大型 Markdown 渲染器），核心路由直接 import
```typescript
import { createRouter } from 'vue-router'

// 创建路由实例，核心路由直接 import
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('@/views/Login.vue') },
  ],
})
```

## 8. 状态管理指南

### 8.1 选型建议
- **React**：默认使用 Zustand（轻量、无样板代码）；大型项目可选 Redux Toolkit
- **Vue**：默认使用 Pinia（官方推荐、TypeScript 友好）

### 8.2 Redux Toolkit（大型项目）
- 使用 `createSlice` 定义状态与 reducer
- 异步逻辑使用 `createAsyncThunk`
- 配置 store 时启用中间件（如 redux-thunk）

### 8.3 Zustand（轻量项目）
- 单一 store 保持聚焦，跨领域状态拆分多 store
- 通过 selector 订阅最小状态片段，避免不必要重渲染

### 8.4 Pinia（Vue）
- 使用 setup 风格定义 store，与 Composition API 一致
- 状态修改通过 action 函数，保持可追踪性

## 9. 代码质量指南

### 9.1 TypeScript 类型安全
- 全项目使用 TypeScript，限制语法在 ES2020 或更早
- 严禁 `any` 类型，必要时使用 `unknown` 并做类型收窄
- 公共类型定义放在 `shared` 目录，前后端共享
- 接口与类型优先使用 `interface`（可扩展），联合类型使用 `type`

### 9.2 组件质量
- 创建小型、聚焦的组件（< 200 行，含 .tsx/.vue 等）
- 复杂组件拆分为单一职责子组件或模块
- 默认实现响应式设计
- 确保 import 正确，页面链接与按钮可点击且功能完整

### 9.3 ESLint
- 配置 ESLint 规则集，启用 TypeScript 与 React/Vue 插件
- 提交前运行 `eslint --fix` 自动修复
- 禁止 `no-explicit-any`、`no-unused-vars` 等规则告警进入仓库

### 9.4 Prettier
- 统一格式化规则（缩进、引号、分号等）
- 配合 `lint-staged` 在提交时自动格式化
- 与 ESLint 规则不冲突（使用 `eslint-config-prettier`）

### 9.5 变量文本转义
- 存储含引号的文本变量时，正确转义
- 反斜杠（\）转义引号，或单双引号交替使用
```typescript
// 示例 1：反斜杠转义双引号
const message1 = "Welcome to the \"Amazing\" App"
// 示例 2：双引号内使用单引号
const message2 = "Welcome to the 'Amazing' App"
```

## 10. 测试指南

### 10.1 测试原则
- 始终为编写的代码编写测试，覆盖所有可能场景
- 测试应独立且隔离，可按任意顺序运行
- 测试应易读、易理解
- 根据技术栈选择合适的测试工具与框架

### 10.2 Jest（React 单元测试）
- 使用 Jest + React Testing Library 渲染组件并断言
- 聚焦用户行为而非实现细节
```typescript
import { render, screen } from '@testing-library/react'
import UserCard from './UserCard'

// 渲染组件并验证关键内容
test('显示用户名', () => {
  render(<UserCard name="Alice" />)
  expect(screen.getByText('Alice')).toBeInTheDocument()
})
```

### 10.3 Vitest（Vite 项目）
- Vite 项目优先使用 Vitest（与 Vite 配置共享，启动快）
- API 与 Jest 兼容，迁移成本低

### 10.4 Playwright（E2E 测试）
- 使用 Playwright 进行端到端测试，覆盖关键用户流程
- 跨浏览器测试（Chromium、Firefox、WebKit）
```typescript
import { test, expect } from '@playwright/test'

// 端到端测试：验证登录流程
test('用户登录流程', async ({ page }) => {
  await page.goto('/login')
  await page.fill('[name=email]', 'user@example.com')
  await page.click('button[type=submit]')
  await expect(page).toHaveURL('/dashboard')
})
```

### 10.5 后端 API 测试
- 使用 curl 发送请求并检查响应
- 验证状态码、响应体、错误处理
```bash
# 测试 GET 端点
curl -s http://localhost:3000/api/users/1 | jq '.name'
```

### 10.6 数据库与浏览器验证
- 数据库操作：使用 SQL 查询验证数据完整性与正确性
- 浏览器页面：编写 `console.debug` 并在浏览器控制台检查输出，验证后清理
- TypeScript 更新后：执行 `npm run check` 确保代码功能正确且符合质量标准
