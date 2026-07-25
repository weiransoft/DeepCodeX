---
name: browser-automation
description: 浏览器自动化 skill——通过 Chrome DevTools MCP 实现 Web 测试/E2E/截图/性能分析。Use when 用户请求打开网页、测试前端、截图、性能分析、表单填写、E2E 测试、浏览器自动化等场景，或需要在真实浏览器环境中验证 web 应用行为时。
triggers:
  - 打开网页
  - 测试前端
  - 截图
  - 性能分析
  - 表单填写
  - E2E 测试
  - 浏览器自动化
  - 网页测试
  - 控制台错误
  - 网络请求
  - Lighthouse 审计
---

# Browser Automation Skill

本 Skill 通过 Chrome DevTools MCP 提供 29 个浏览器自动化工具，
覆盖 Web 测试/E2E/截图/性能分析/控制台监控/网络请求分析等场景。

## 前置条件（MCP 配置）

本 Skill 依赖 Chrome DevTools MCP，用户需在 `settings.json` 的 `mcpServers` 中配置：

```json
{
  "mcpServers": {
    "mcp_Chrome_DevTools_MCP": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp"]
    }
  }
}
```

**降级处理**：若 MCP 未配置或不可用，本 Skill 应：
1. 明确告知用户前置条件未满足
2. 提供配置示例
3. 不抛错，保持流程继续（用户可后续配置）

## 29 个 MCP 工具映射表（按功能分组）

### 页面导航与管理（6 个）

| 工具 | 能力 | 典型场景 |
|------|------|---------|
| `navigate_page` | 导航到指定 URL | 打开待测试页面 |
| `new_page` | 新建浏览器页面/标签 | 多页面测试 |
| `close_page` | 关闭页面 | 测试结束清理 |
| `list_pages` | 列出所有打开的页面 | 多标签管理 |
| `select_page` | 选择/切换页面 | 多页面交替操作 |
| `resize_page` | 调整页面尺寸 | 响应式测试（移动端/桌面端） |

### 元素交互（8 个）

| 工具 | 能力 | 典型场景 |
|------|------|---------|
| `click` | 点击元素 | 按钮点击、链接导航 |
| `hover` | 悬停元素 | 触发 tooltip、下拉菜单 |
| `fill` | 填充单个输入框 | 表单字段填写 |
| `fill_form` | 批量填充表单 | 完整表单提交 |
| `type_text` | 键盘输入文本 | 模拟真实输入 |
| `press_key` | 按键操作 | Enter/Escape/Tab 等 |
| `drag` | 拖拽元素 | 拖拽排序、画布交互 |
| `upload_file` | 上传文件 | 文件上传测试 |

### 对话框与等待（2 个）

| 工具 | 能力 | 典型场景 |
|------|------|---------|
| `handle_dialog` | 处理浏览器对话框 | alert/confirm/prompt |
| `wait_for` | 等待条件满足 | 等待元素出现/网络空闲 |

### 截图与快照（3 个）

| 工具 | 能力 | 典型场景 |
|------|------|---------|
| `take_screenshot` | 页面截图 | 视觉回归基线、Bug 报告 |
| `take_snapshot` | DOM 快照 | 元素结构分析、可访问性检查 |
| `take_heapsnapshot` | 堆内存快照 | 内存泄漏检测 |

### 控制台与网络（4 个）

| 工具 | 能力 | 典型场景 |
|------|------|---------|
| `list_console_messages` | 列出控制台消息 | JS 错误检测、警告分析 |
| `get_console_message` | 获取特定控制台消息 | 按索引精确定位 |
| `list_network_requests` | 列出网络请求 | API 调用监控、性能分析 |
| `get_network_request` | 获取特定网络请求 | 按索引精确分析请求/响应 |

### 性能与审计（4 个）

| 工具 | 能力 | 典型场景 |
|------|------|---------|
| `performance_start_trace` | 开始性能追踪 | 性能基准测试 |
| `performance_stop_trace` | 停止性能追踪 | 获取性能数据 |
| `performance_analyze_insight` | 分析性能洞察 | 瓶颈识别 |
| `lighthouse_audit` | Lighthouse 审计 | SEO/性能/可访问性评分 |

### 高级（2 个）

| 工具 | 能力 | 典型场景 |
|------|------|---------|
| `evaluate_script` | 执行 JavaScript | 自定义断言、DOM 操作 |
| `emulate` | 设备模拟 | 移动端模拟、网络限速 |

## 安全规则（强制执行）

本 Skill 涉及浏览器操作，存在安全风险。以下规则**必须**执行：

### 红线规则（违反必须 AskUserQuestion 确认）

| 场景 | 规则 | 实现方式 |
|------|------|---------|
| **凭据输入** | 禁止自动填写密码/支付信息 | 检测到 password 类型输入框或支付页面时，调用 `AskUserQuestion` 请求用户确认 |
| **CAPTCHA** | 禁止自动绕过验证码 | 检测到 CAPTCHA 时，停止自动化，提示用户手动处理 |
| **删除类操作** | 禁止自动点击"删除"/"清空"/"重置"按钮 | 检测到危险操作关键词（delete/clear/reset/remove）时，调用 `AskUserQuestion` 请求确认 |
| **表单提交** | 禁止自动提交真实表单（非测试环境） | 检测到非 localhost/非测试环境的表单提交时，调用 `AskUserQuestion` 请求确认 |
| **文件下载** | 禁止自动下载文件 | 检测到下载触发时，调用 `AskUserQuestion` 请求确认 |
| **支付操作** | 禁止自动完成支付流程 | 检测到支付关键词（pay/checkout/purchase）时，立即停止 |

### 检测实现

危险操作检测在 `fill` / `fill_form` / `click` 等工具调用前执行：

- **关键词检测**：`delete/remove/clear/reset/destroy/drop/pay/checkout/purchase/transfer`
- **敏感输入类型检测**：`password/credit-card/cvv`
- **处置方式**：命中危险关键词或敏感输入时调用 `AskUserQuestion` 请求确认；命中 CAPTCHA 或支付关键词时立即停止

完整的 TS 检测实现与规则映射见 [references/safety-detection.md](references/safety-detection.md)。

## 典型工作流

### 工作流 1：Web 应用 E2E 测试

```
1. navigate_page(url) ──> 打开待测试页面
2. wait_for("networkidle") ──> 等待页面加载完成
3. take_snapshot() ──> 获取 DOM 快照
4. fill_form(formData) ──> 填写测试表单（⚠️ 检查安全规则）
5. click("#submit") ──> 提交表单
6. wait_for(".success-message") ──> 等待结果
7. take_screenshot() ──> 截图作为测试证据
8. list_console_messages() ──> 检查控制台错误
9. list_network_requests() ──> 检查 API 调用
```

### 工作流 2：视觉回归测试

```
1. navigate_page(url)
2. resize_page({ width: 1920, height: 1080 }) ──> 桌面端基线
3. take_screenshot() ──> 桌面端基线截图
4. resize_page({ width: 375, height: 669 }) ──> 移动端
5. take_screenshot() ──> 移动端截图
6. resize_page({ width: 768, height: 1024 }) ──> 平板端
7. take_screenshot() ──> 平板端截图
```

### 工作流 3：性能分析

```
1. performance_start_trace({ name: "page-load" })
2. navigate_page(url)
3. wait_for("load")
4. performance_stop_trace()
5. performance_analyze_insight({ traceName: "page-load" })
6. lighthouse_audit({ categories: ["performance", "accessibility", "seo"] })
```

### 工作流 4：控制台与网络错误检测

```
1. navigate_page(url)
2. wait_for("networkidle")
3. list_console_messages() ──> 检查 JS 错误
   ├── 有 error 级别消息 → 报告错误详情
   └── 无错误 → 继续
4. list_network_requests() ──> 检查失败的 API 调用
   ├── 有 4xx/5xx 响应 → 报告失败请求
   └── 全部成功 → 通过
```

## 与 code-mode-orchestrator 协同

当需要对多个页面/多个测试用例批量执行时，可与 Code Mode 编排协同：

```
用户请求："对 10 个页面批量截图"
   │
   ├─> code-mode-orchestrator skill 识别为 fan-out-aggregate 模式
   │     （subtask_count=10, subtask_homogeneous=true, subtask_independent=true）
   │
   ├─> FanOutAggregateExecutor 并行调度
   │     ├── 子任务 1: navigate_page(url1) + take_screenshot()
   │     ├── 子任务 2: navigate_page(url2) + take_screenshot()
   │     └── ... 子任务 10: navigate_page(url10) + take_screenshot()
   │
   └─> 聚合结果（concat 策略）──> 输出 10 张截图路径列表
```

## 降级处理

### MCP 未配置时

```
用户请求："打开网页测试"
   │
   ├─> 检测 mcp_Chrome_DevTools_MCP 是否可用
   │
   ├─> 不可用 → 降级处理：
   │     1. 告知用户："浏览器自动化需要 Chrome DevTools MCP，当前未配置"
   │     2. 提供配置示例（见"前置条件"）
   │     3. 不抛错，保持流程继续
   │     4. 建议用户配置后重新执行
   │
   └─> 可用 → 正常执行工作流
```

### 工具调用失败时

| 失败场景 | 降级策略 |
|---------|---------|
| `navigate_page` 超时 | 重试 1 次，仍失败则报告错误 |
| `take_screenshot` 失败 | 降级为 `take_snapshot`（DOM 快照） |
| `evaluate_script` 异常 | 捕获异常，报告脚本错误 |
| `wait_for` 超时 | 报告超时，继续执行后续步骤 |

Chrome DevTools MCP 为 Trae 内置 MCP，位于 `~/.trae-cn/mcps/m__trae-cn_multi-agen-24840664/solo_agent/mcp_Chrome_DevTools_MCP/`。

## 验证清单

- [ ] Skill 通过 `session.listSkills()` 可被扫描注册
- [ ] 用户输入"打开网页测试"/"截图"/"E2E 测试"时自动匹配本 Skill
- [ ] Skill 内容引用的 29 个 MCP 工具名与 `mcp_Chrome_DevTools_MCP/tools/` 目录一致
- [ ] 安全规则完整（凭据/CAPTCHA/删除/支付/表单提交/文件下载 6 类红线）
- [ ] MCP 未配置时给出明确前置条件提示，不抛错
- [ ] `enabledSkills: {"browser-automation": false}` 可禁用本 Skill
- [ ] 与 code-mode-orchestrator 协同的 fan-out-aggregate 示例准确
