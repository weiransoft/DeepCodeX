# pie-chart-label-list（饼图带标签列表）

## 场景与意图
- 场景：data-visualization
- 意图：part_to_whole_label_list
- 触发：用户意图涉及小类别集（2~5 类）的份额对比，需要切片标签 + 紧凑侧标签列表（图例）同步呈现（如设备类型占比、渠道来源构成、产品类别份额、回答类型分布）。当需精确排名、长标签、中心总量或超 5 类时应改用其他模板。

## 数据形状
- 数据结构：2~5 个类别及其非负数值；类别顺序即切片顺序，按序赋色。
- 必需字段：
  - `slices`：`Array<{ name: string; value: number }>`，2~5 个切片，`value` 非负
- 可选字段：
  - `unit`：`string`，数值后缀单位（如 "万"、"人"、"次"）
  - `totalLabel`：`string`，总量说明（如 "总用户数"、"总回答数"）
  - `focusSlice`：`string`，需要强调的切片名（仅一个可见焦点，用 brand 描边表达，其他切片保持中性）
  - `estimated`：`boolean[]`，与 `slices` 等长，标记哪些切片为估计值

## 适配要点
- 切片数严格控制在 2~5 个：按序使用 `--chart-series-1` 至 `--chart-series-4`；第 5 个或余项归并为 `--chart-other` 桶。6+ 类别须归并 Top N + Other、拆分小多图或改用表/列表，本模板不扩展。
- 所有数值非负；不将负值导入饼图。
- 侧标签列表用 HTML/CSS 实现（不用 Chart.js legend）：每个标签含色块 + 名称 + 百分比/数值；色块色与对应切片色一一对应。
- 布局：左侧饼图 + 右侧紧凑标签列表，窄屏堆叠（饼图在前，标签列表在后）。
- 仅一个可见焦点：通过 `focusSlice` 标记的切片用 `--brand` 描边 + 略微外凸表达，其他切片保持中性。
- 图表本体不含洞察/结论/分析文案，仅保留切片、侧标签列表与必要的焦点标记；解读放周边回答。
- 提示框使用 `external` 处理器渲染 HTML（Shadcn 风格），禁用 Chart.js 内建 canvas 提示；提示框内列出切片名、数值与占比。
- 容器使用 `clamp(220px, 32vw, 360px)` 高度 + `position: relative`，配置 `responsive: true` + `maintainAspectRatio: false`。
- 禁用 Chart.js 内建 legend（`plugins.legend.display = false`），图例由侧标签列表承担。

## 降级策略
- 降级原语：`chart-card`（单图表卡片）+ 可见 HTML 数据表
- 降级触发条件：
  - Chart.js CDN 加载失败（`window.Chart` 未定义）
  - canvas 上下文不可用
  - 数据为空或所有值均为 0
- 降级行为：保留可见 HTML 表格（含切片名、数值、百分比三列），仅 Chart.js 实例创建成功后才设 `display: none` 隐藏表格；表格沿用 token 化字体与边框。侧标签列表在降级时仍可见，作为图例补充。

## 适配示例
见 `widget-code.html` 与 `fixture.json`
