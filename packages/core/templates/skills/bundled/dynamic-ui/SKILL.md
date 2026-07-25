---
name: dynamic-ui
description: 在文字回答旁生成紧凑内联可视化 — 数据图表、架构流程图、对比决策、机制图解、微交互 demo。仅当紧凑可视化能让回答更清晰时使用，不用于网站/应用/报告/看板。Use when 用户需要画图、数据可视化、图表、架构图、流程图、时序图、对比矩阵、决策树、机制图解、交互演示等内联可视化时。
triggers:
  - 画图
  - 可视化
  - 数据可视化
  - 图表
  - 柱状图
  - 折线图
  - 饼图
  - 散点图
  - 架构图
  - 流程图
  - 时序图
  - 对比矩阵
  - 决策树
  - 机制图解
  - 交互演示
---

# dynamic-ui — 内联可视化

## 1. 适用场景

**适用**：当紧凑的内联可视化能让关系、量级、选择或局部交互更清晰时 — 图表、架构图、交互 demo、对比分析。
**不适用**：独立网站、应用、长报告、看板、幻灯片；单值查询、一步命令；Markdown 更易扫描的内容；无可见焦点的装饰性视觉。

## 2. 文件结构

`{{SKILL_DIR}}` 为本 `SKILL.md` 所在目录：

```
{{SKILL_DIR}}/
├── SKILL.md                ← 入口（本文件）
├── scenes/                 ← 场景指引（一场景一文件）
│   ├── data-visualization.md
│   ├── architecture-and-flow.md
│   ├── comparison-and-decision.md
│   ├── mechanism-explanation.md
│   └── micro-interaction.md
├── tokens/
│   └── visual-tokens.md    ← 完整 CSS token 定义（按需读取）
└── templates/
    └── manifest.json       ← 模板清单（按需读取）
```

## 3. 场景路由

读取用户意图后，路由到**唯一**场景文件：

| 用户意图 | 场景文件 |
|---|---|
| 数值趋势、量级对比、构成/占比、分布、流量、热力密度 | `scenes/data-visualization.md` |
| 模块关系、依赖图、流程图、状态迁移、调用链、排期 | `scenes/architecture-and-flow.md` |
| 选项对比、技术选型、风险摘要、决策矩阵、优劣分析 | `scenes/comparison-and-decision.md` |
| 解释原理、物理/抽象机制、因果链、概念模型 | `scenes/mechanism-explanation.md` |
| 局部交互 demo、参数切换、状态变化、筛选/排序 | `scenes/micro-interaction.md` |

路由后必须遵循所选场景的强制工作流，再生成 widget 代码。这些工作流步骤为内部步骤，不向用户叙述。

## 4. 工具契约

调用 `pure_show_widget(widget_code, widget_type)` 渲染可视化：
- `widget_code`：完整的自包含 HTML/CSS/SVG/JS 片段（无 `<!DOCTYPE>`/`<html>`/`<head>`/`<body>`）
- `widget_type`：可视化类型标识（如 `chart`、`diagram`、`comparison`、`mechanism`、`interaction`）

决定渲染后，**静默**完成布局/代码推理，直接以最终 `widget_code` 调用工具。不要在工具调用前后流式输出计划、草稿代码、片段或"正在组装"等过渡语。widget 代码只出现在工具调用内。

## 5. 渲染契约（CLI 降级）

DeepCodeX 为 CLI 环境，无内联 widget 宿主，按以下规则降级：

- 调用 `pure_show_widget` 后，运行时将 `widget_code` 包裹为自包含 HTML 文件，写入 `.deepcodex/widgets/<name>.html`，并返回文件路径
- 助手在响应中提示用户用浏览器打开该路径
- HTML 文件需自带 token CSS（见 `tokens/visual-tokens.md`），不依赖外部宿主样式
- 若 `pure_show_widget` 工具不可用，直接将 `widget_code` 写入 `.deepcodex/widgets/<name>.html` 并告知路径
- 输出顺序：`<style>` → 内容 HTML/SVG → `<script>`（仅交互需要时）
- 禁止 `<!DOCTYPE>`、`<html>`、`<head>`、`<body>`、meta 标签、路由、导出流、页面外壳
- token 定义置于 `<style>` 顶部，组件选择器之前
- 根元素：`data-dynamic-ui-widget` + `data-template="<id>"`；通过稳定选择器初始化，绑定前设 `data-mounted="true"`；所有 DOM 查询限定在根元素内
- 外部库仅可从允许的 CDN 加载：`cdnjs.cloudflare.com`、`esm.sh`、`cdn.jsdelivr.net`、`unpkg.com`；widget 须在外部库加载失败时仍保持可用

## 6. 视觉设计原则

核心原则（详细定义见 `tokens/visual-tokens.md`）：
- **无缝**：用户不应察觉 widget 与回答的边界
- **扁平**：无渐变、mesh 背景、噪点纹理；干净的扁平表面
- **紧凑**：内联展示要点，其余用文字解释
- **分离**：解释文字放回答中，视觉证据放 widget 内
- **仅图表**：图表 widget 只含图表本体、可选短标题与必要读数辅助（坐标轴/图例/标签/提示），不含洞察、结论、分析、建议或页脚文案

**token 优先**：颜色/字体/间距/圆角一律使用 `tokens/visual-tokens.md` 的角色 token，不发明局部色板、字号、间距或圆角值。SVG 几何坐标、viewBox、canvas 尺寸可用字面数值。

**颜色优先级**：先中性表面 + 连接线 + `--brand` 焦点 + `--chart-series-*`；仅当用户明确要求状态/风险/健康编码或数据字段本身是状态/风险变量时才用语义色（`--success`/`--warning`/`--danger`）。"成功/失败/警告"等词不自动触发语义色。

**主题**：默认紫色主题。仅在用户明确要求其他视觉主题时重映射 brand token。每个 widget 须在亮/暗主题下均可读：`:root` 放亮色默认，`:root[data-widget-theme="dark"]` 放暗色覆盖；独立导出无 `data-widget-theme` 时仍可从亮色默认读出。

## 7. 安全规则

- `widget_code` 在沙箱内执行，**禁止访问文件系统、网络请求（除允许的 CDN）、`eval`、`Function` 构造器、`document.cookie`、`localStorage`、`sessionStorage`**
- 禁止内联事件处理器（`onclick`/`onchange` 等），事件绑定用 `addEventListener` 或事件委托
- 禁止 `document.currentScript`、`previousElementSibling`、兄弟遍历、全局选择器、`position: fixed`
- `window.sendPrompt('...')` 仅用于需要模型推理的后续问题，不用于本地 UI 行为
- 正文文字 ≥14px，不低于 11px；无嵌套滚动；无嵌套滚动卡片

## 8. 降级原语

无匹配模板时，选择**一个**降级原语并遵循同一套 token/颜色/字体/间距/圆角契约：

| 原语 | 用途 |
|---|---|
| `chart-card` | 单图表卡片 |
| `metric-strip-chart` | 指标条 + 迷你图 |
| `node-flow` | 节点流程图 |
| `decision-cards` | 选项卡片对比 |
| `compact-table-visual` | 紧凑表格可视化 |
| `explanation-panel` | 机制/原理解释面板 |

自定义输出不得发明色板、字号、间距或圆角值弥补模板缺失。若内容无法在 token 字号/间距下容纳，简化、分组、拆分或改用 Markdown 回答，而非缩小字号、压缩间距、裁切溢出或用背景遮盖碰撞。

## 9. 内容规则

- 每个 widget 须有**一个**可见焦点（推荐项/关键路径/瓶颈/最高值/相位边界/风险标记），用位置、标签或一个强调色显式表达，不单靠颜色
- 文案密度：节点标签 2-5 词；卡片标题 6-10 词；连接线标签 1-3 词（明显关系可省略）；用句首大写，仅标识符/命令/路径用代码体
- 复杂度预算：1 焦点、2-5 主节点、2-4 选项/KPI/系列、1 交互概念；水平层最多 4 框，超 5 项则分组/换行/拆分；无图例时最多 2 种非中性含义色
- 数据诚实：估计值标注为估计；显示值舍入一致；数字旁标单位；近似来源不用精确外观；禁止渲染地图，改用按区域的柱/表/矩阵

## 10. 验证清单

交付前确认：
- [ ] 路由到唯一场景文件并遵循其强制工作流
- [ ] `widget_code` 自包含，自带 token CSS，无页面外壳
- [ ] 调用 `pure_show_widget`，或写入 `.deepcodex/widgets/<name>.html` 并提示打开
- [ ] 颜色/字体/间距/圆角均使用 token，无字面色值
- [ ] 仅一个可见焦点；正文 ≥14px
- [ ] 亮/暗主题均可读
- [ ] 无文件系统/网络/Cookie 访问；外部库仅来自允许的 CDN
- [ ] 图表 widget 不含洞察/结论/分析文案（放回答中）
