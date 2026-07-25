# bar-chart-multiple（分组柱状图）

## 场景与意图
- 场景：data-visualization
- 意图：grouped_bar_comparison
- 触发：用户意图涉及恰好两个同辈系列跨同类目并排对比量级（如两个产品在多个季度的销量对比、两个团队在多个迭代的速度对比）。当涉及趋势形状、堆叠贡献、精确分布或 3+ 同辈系列为主时应改用其他模板。

## 数据形状
- 数据结构：一组同类目标签 + 恰好两个同辈数值系列。两个系列在每个类目上各有一个数值，并排对比。
- 必需字段：
  - `categories`：`string[]`，类目标签数组（如季度、地区、团队）
  - `series`：`Array<{ name: string; values: number[] }>`，长度严格为 2，每个系列的 `values` 长度须与 `categories` 一致
- 可选字段：
  - `yLabel`：`string`，Y 轴单位说明
  - `yUnit`：`string`，数值后缀单位（如 "万"、"%"）
  - `focusCategory`：`string`，需要强调的类目（仅一个可见焦点，用 brand 描边表达）
  - `estimated`：`Array<{ seriesIndex: number; categoryIndex: number }>`，标记估计值位置

## 适配要点
- 系列数严格为 2：使用 `--chart-series-1` 与 `--chart-series-2`，确保两色视觉充分分离；不扩展至 3 系列。
- 同类目两柱并排，柱宽一致，组间留出清晰间隔（`categoryPercentage: 0.7` + `barPercentage: 0.85`）。
- 仅一个可见焦点：通过 `focusCategory` 标记的类目组用 `--brand` 边框强调，其他柱组保持中性。
- 图表本体不含洞察/结论/分析文案，仅保留坐标轴、图例、提示与必要的焦点标记。
- 提示框使用 `external` 处理器渲染 HTML（Shadcn 风格），禁用 Chart.js 内建 canvas 提示。
- 容器使用 `clamp(220px, 32vw, 360px)` 高度 + `position: relative`，配置 `responsive: true` + `maintainAspectRatio: false`。
- Y 轴从 0 起，避免视觉误导；不裁切负值（本模板不处理负值，负值场景改用其他模板）。

## 降级策略
- 降级原语：`chart-card`（单图表卡片）+ 可见 HTML 数据表
- 降级触发条件：
  - Chart.js CDN 加载失败（`window.Chart` 未定义）
  - canvas 上下文不可用
  - 数据为空或所有值均为 0
- 降级行为：保留可见 HTML 表格（含 `categories` 行 + 每系列一行数值），仅 Chart.js 实例创建成功后才设 `display: none` 隐藏表格；表格沿用 token 化字体与边框。

## 适配示例
见 `widget-code.html` 与 `fixture.json`
