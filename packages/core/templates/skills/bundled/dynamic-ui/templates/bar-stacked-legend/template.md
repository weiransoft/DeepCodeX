# bar-stacked-legend（堆叠柱状图带图例）

## 场景与意图
- 场景：data-visualization
- 意图：stacked_part_to_whole
- 触发：用户意图涉及各部分贡献于类别总量，且总量与构成均重要（如季度营收按业务线堆叠、月度成本按类目堆叠、各区域人口按年龄段堆叠）。当直接并排对比比总量更重要时应改用 `bar-chart-multiple`；当仅需占比不含总量时改用 `pie-chart-label-list` 或 `pie-donut-text`。

## 数据形状
- 数据结构：一组同类目标签 + 2~5 个堆叠部分系列。每个系列在每个类目上有一个非负数值，各系列在同一类目上的和构成该类目总量。
- 必需字段：
  - `categories`：`string[]`，类目标签数组（如季度、月份、区域）
  - `parts`：`Array<{ name: string; values: number[] }>`，2~5 个堆叠部分，每个 `values` 长度与 `categories` 一致，非负
- 可选字段：
  - `unit`：`string`，数值后缀单位（如 "万"、"%"、"人"）
  - `yLabel`：`string`，Y 轴说明
  - `focusCategory`：`string`，需要强调的类目（仅一个可见焦点，用 brand 描边表达，其他类目保持中性）
  - `estimated`：`Array<{ partIndex: number; categoryIndex: number }>`，标记估计值位置（影响降级表格的标注）

## 适配要点
- 堆叠部分严格控制在 2~5 个：按序使用 `--chart-series-1` 至 `--chart-series-4`；第 5 个或余项归并为 `--chart-other` 桶。6+ 部分须归并 Top N + Other、拆分小多图或改用表/列表，本模板不扩展。
- 所有数值非负；不将负值导入堆叠占总比图（负值场景改用分组柱状图）。
- Y 轴从 0 起，避免视觉误导；堆叠顺序自下而上按 `parts` 数组顺序，最底层为 `--chart-series-1`。
- 仅一个可见焦点：通过 `focusCategory` 标记的类目柱组用 `--brand` 边框强调（描边整组而非单段），其他类目保持中性。
- 图例置于图表顶部内联嵌入（`position: 'top'`，`align: 'end'`），与切片色一一对应；图例使用 `usePointStyle: true` 的圆形色块。
- 图表本体不含洞察/结论/分析文案，仅保留坐标轴、图例、提示与必要的焦点标记；解读放周边回答。
- 提示框使用 `external` 处理器渲染 HTML（Shadcn 风格），禁用 Chart.js 内建 canvas 提示；提示框内列出该类目下各部分数值与总量。
- 容器使用 `clamp(220px, 32vw, 360px)` 高度 + `position: relative`，配置 `responsive: true` + `maintainAspectRatio: false`。

## 降级策略
- 降级原语：`chart-card`（单图表卡片）+ 可见 HTML 数据表
- 降级触发条件：
  - Chart.js CDN 加载失败（`window.Chart` 未定义）
  - canvas 上下文不可用
  - 数据为空或所有值均为 0
- 降级行为：保留可见 HTML 表格（首列 `categories` + 每部分一列数值 + 末列总量），仅 Chart.js 实例创建成功后才设 `display: none` 隐藏表格；表格沿用 token 化字体与边框，不发明本地样式。

## 适配示例
见 `widget-code.html` 与 `fixture.json`
