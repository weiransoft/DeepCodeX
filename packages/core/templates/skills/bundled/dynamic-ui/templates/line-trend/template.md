# line-trend（折线趋势图）

## 场景与意图
- 场景：data-visualization
- 意图：trend_over_time
- 触发：用户意图涉及有序时间点上的连续变化，需要识别斜率、拐点或多系列对比（如月度增长、周环比、年度走势）。当类别无序或仅单一当前值重要时不应使用。

## 数据形状
- 数据结构：一组有序时间点标签 + 1~2 个同辈数值系列。每个系列在相同时间点上有一个数值（允许缺失以表达可见缺口）。
- 必需字段：
  - `labels`：`string[]`，时间点标签数组（如月份、周次、日期）
  - `series`：`Array<{ name: string; values: Array<number | null> }>`，1~2 个同辈系列，每个系列的 `values` 长度须与 `labels` 一致
- 可选字段：
  - `yLabel`：`string`，Y 轴单位说明（如 "活跃用户 / 万人"）
  - `yUnit`：`string`，数值后缀单位（如 "万"、"%"）
  - `xLabel`：`string`，X 轴说明
  - `focusIndex`：`number`，需要强调的拐点或峰值在 `labels` 中的下标（仅一个可见焦点）
  - `estimated`：`boolean[]`，与 `labels` 等长，标记哪些点为估计值（影响降级表格的标注）

## 适配要点
- 系列数严格控制在 1~2 个：单系列用 `--chart-series-1`；双系列用 `--chart-series-1` 与 `--chart-series-2`，确保两色视觉充分分离。3+ 同辈系列须归并、小多图或改用表/列表，本模板不扩展。
- 缺失值（`null`）保留为可见缺口，使用 Chart.js 的 `spanGaps: false`；不静默转零。
- 估计值在降级表格中以 `≈` 标记，并在 Chart.js 点上保持相同视觉精度（不放大、不变色），由周边回答承担解释。
- 仅一个可见焦点：通过 `focusIndex` 标记的拐点用更大半径 + `--brand` 描边表达，其他点保持等大。
- 图表本体不含洞察/结论/分析文案，仅保留坐标轴、图例、提示与必要的焦点标记；解读放周边回答。
- 提示框使用 `external` 处理器渲染 HTML（Shadcn 风格），禁用 Chart.js 内建 canvas 提示。
- 容器使用 `clamp(220px, 32vw, 360px)` 高度 + `position: relative`，配置 `responsive: true` + `maintainAspectRatio: false`。

## 降级策略
- 降级原语：`chart-card`（单图表卡片）+ 可见 HTML 数据表
- 降级触发条件：
  - Chart.js CDN 加载失败（`window.Chart` 未定义）
  - canvas 上下文不可用
  - 数据为空或所有值均为 `null`
- 降级行为：保留可见 HTML 表格（含 `labels` 行 + 每系列一行数值），仅 Chart.js 实例创建成功后才设 `display: none` 隐藏表格；表格沿用 token 化字体与边框，不发明本地样式。

## 适配示例
见 `widget-code.html` 与 `fixture.json`
