# radar-chart-lines-only（极简雷达轮廓）

## 场景与意图
- 场景：data-visualization
- 意图：radar_profile_lines_only
- 触发：用户意图涉及两个同辈来源跨同维度集的极简轮廓对比，需无填充仅描边呈现两条分离的折线（如两版本性能基线对比、两候选方案能力轮廓、两次评估差异）。当需填充雷达、精确排名或趋势为主时应改用 `radar-chart-legend` 或其他模板。

## 数据形状
- 数据结构：3~8 个同维度标签 + 恰好两个同辈数值系列。两个系列在每个维度上有一个数值，以无填充仅描边的折线表达轮廓对比。
- 必需字段：
  - `dimensions`：`string[]`，维度标签数组（3~8 项）
  - `series`：`Array<{ name: string; values: number[] }>`，长度严格为 2，每个 `values` 长度与 `dimensions` 一致
- 可选字段：
  - `maxValue`：`number`，雷达轴最大值；不提供时由数据推导
  - `unit`：`string`，数值后缀单位（如 "ms"、"分"）
  - `focusDimension`：`string`，需要强调的维度（仅一个可见焦点，用 brand 描边轴或加粗标签强调）
  - `estimated`：`Array<{ seriesIndex: number; dimensionIndex: number }>`，标记估计值位置

## 适配要点
- 系列数严格为 2：使用 `--chart-series-1` 与 `--chart-series-2`，确保两色视觉充分分离；不扩展至 3 系列。
- 无填充仅描边：两个系列均使用 `fill: false`，仅以描边折线表达轮廓；不使用半透明填充叠加。
- 维度数 3~8 为宜；超 8 维度时归并、拆分或改用表/列表，避免标签拥挤。
- 仅一个可见焦点：通过 `focusDimension` 标记的维度用 `--brand` 描边轴或加粗标签表达，其他维度保持中性。
- 图例置于图表顶部内联嵌入（`position: 'top'`，`align: 'end'`）；与 `radar-chart-legend` 区别在于：图例不用填充色块，改用线段示意（`boxWidth: 16`，`boxHeight: 0`，`usePointStyle: false`，通过自定义 legend label renderer 渲染线段）。
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
