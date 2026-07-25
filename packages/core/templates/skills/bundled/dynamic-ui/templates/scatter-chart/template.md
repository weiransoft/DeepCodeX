# scatter-chart（散点图）

## 场景与意图
- 场景：data-visualization
- 意图：correlation_scatterplot
- 触发：用户意图涉及两数值维度的相关性、聚类、离群点识别，或可选气泡大小作为第三维度对比（如活跃时长与留存率的相关性、代码行数与缺陷密度的散点）。当时序趋势、精确类别排名、日期/字符串轴或数千点稠密分布为主时应改用其他模板。

## 数据形状
- 数据结构：1~2 个聚类系列的散点集合，每个点含 X 与 Y 两个数值维度，可选 R（气泡半径）作为第三维度。
- 必需字段：
  - `series`：`Array<{ name: string; points: Array<{ x: number; y: number; r?: number }> }>`，1~2 个同辈系列
  - `xLabel`：`string`，X 轴含义
  - `yLabel`：`string`，Y 轴含义
- 可选字段：
  - `xUnit`：`string`，X 轴单位
  - `yUnit`：`string`，Y 轴单位
  - `focusPoint`：`{ seriesIndex: number; pointIndex: number }`，唯一可见焦点（离群点），用 brand 描边强调
  - `bubbleSize`：`'r'`，标识是否启用气泡大小维度（启用时 `points[].r` 必填）

## 适配要点
- 系列数严格控制在 1~2 个：单系列用 `--chart-series-1`；双系列用 `--chart-series-1` 与 `--chart-series-2`，确保两色视觉充分分离。
- 点半径基于 `r` 字段，未提供时使用默认半径 5；半径范围限制在 4~18，避免过大点重叠或过小点不可见。
- 仅一个可见焦点：`focusPoint` 标记的离群点用 `--brand` 描边 + 更大半径，其他点保持等大。
- 图表本体不含洞察/结论/分析文案，仅保留坐标轴、图例、提示与必要的焦点标记。
- 提示框使用 `external` 处理器渲染 HTML（Shadcn 风格），禁用 Chart.js 内建 canvas 提示。
- 容器使用 `clamp(220px, 32vw, 360px)` 高度 + `position: relative`，配置 `responsive: true` + `maintainAspectRatio: false`。
- 不使用对数轴（避免视觉误导），稠密点应聚合/分箱为热力图（改用 `heatmap-chart`）。

## 降级策略
- 降级原语：`chart-card`（单图表卡片）+ 可见 HTML 数据列表
- 降级触发条件：
  - Chart.js CDN 加载失败（`window.Chart` 未定义）
  - canvas 上下文不可用
  - 数据为空或所有点均缺失
- 降级行为：保留可见 HTML 列表（按系列分组列出点坐标），仅 Chart.js 实例创建成功后才设 `display: none` 隐藏列表；列表沿用 token 化字体与边框。

## 适配示例
见 `widget-code.html` 与 `fixture.json`
