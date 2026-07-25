# radar-chart-legend（雷达图带图例）

## 场景与意图
- 场景：data-visualization
- 意图：radar_profile_comparison
- 触发：用户意图涉及两个同辈来源跨同维度集的画像对比，需以填充形状呈现重叠区域与分离区域（如两个产品在多个能力维度评分、两个候选人画像对比、两个城市生活成本分布、前后对比）。当需精确值排名、长标签或趋势为主时应改用其他模板。

## 数据形状
- 数据结构：3~8 个同维度标签 + 恰好两个同辈数值系列。两个系列在每个维度上有一个数值（典型 0~100 评分或同量纲数值），以填充形状叠加对比。
- 必需字段：
  - `dimensions`：`string[]`，维度标签数组（3~8 项，如能力维度、评分维度）
  - `series`：`Array<{ name: string; values: number[] }>`，长度严格为 2，每个 `values` 长度与 `dimensions` 一致
- 可选字段：
  - `maxValue`：`number`，雷达轴最大值（如 100）；不提供时由数据推导
  - `unit`：`string`，数值后缀单位（如 "分"、"%"）
  - `focusDimension`：`string`，需要强调的维度（仅一个可见焦点，用 brand 描边轴或标签强调）
  - `estimated`：`Array<{ seriesIndex: number; dimensionIndex: number }>`，标记估计值位置

## 适配要点
- 系列数严格为 2：使用 `--chart-series-1` 与 `--chart-series-2`，确保两色视觉充分分离；不扩展至 3 系列。
- 填充形状：两个系列均使用半透明填充（`fill: true`，`backgroundColor` 带 alpha），描边为对应 chart-series 实色；填充叠加区域呈现交集与差集。
- 维度数 3~8 为宜；超 8 维度时归并、拆分或改用表/列表，避免标签拥挤。
- 仅一个可见焦点：通过 `focusDimension` 标记的维度用 `--brand` 描边轴或加粗标签表达，其他维度保持中性。
- 图例置于图表顶部内联嵌入（`position: 'top'`，`align: 'end'`），与系列色一一对应；图例使用 `usePointStyle: true` 的圆形色块。
- 图表本体不含洞察/结论/分析文案，仅保留雷达轴、维度标签、图例、提示与必要的焦点标记；解读放周边回答。
- 提示框使用 `external` 处理器渲染 HTML（Shadcn 风格），禁用 Chart.js 内建 canvas 提示；提示框内列出该维度下两系列的数值。
- 容器使用 `clamp(240px, 32vw, 380px)` 高度 + `position: relative`，配置 `responsive: true` + `maintainAspectRatio: false`。
- 雷达轴刻度与维度标签使用 `--text-muted`；网格线使用 `--border`，不发明本地色。

## 降级策略
- 降级原语：`chart-card`（单图表卡片）+ 可见 HTML 数据表
- 降级触发条件：
  - Chart.js CDN 加载失败（`window.Chart` 未定义）
  - canvas 上下文不可用
  - 数据为空或维度数 < 3
- 降级行为：保留可见 HTML 表格（首列 `dimensions` + 每系列一列数值），仅 Chart.js 实例创建成功后才设 `display: none` 隐藏表格；表格沿用 token 化字体与边框，不发明本地样式。

## 适配示例
见 `widget-code.html` 与 `fixture.json`
