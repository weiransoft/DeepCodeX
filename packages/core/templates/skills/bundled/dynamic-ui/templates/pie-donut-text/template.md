# pie-donut-text — 环形图带中心指标

## 场景与意图
- 场景：data-visualization
- 意图：composition_with_center_metric
- 触发：用户意图涉及类别份额围绕一个有意义的总量或头条百分比（如"收入构成""流量占比""各渠道份额""成本结构"）

## 数据形状
- 数据结构：类别份额数组 + 中心头条指标
- 必需字段：
  - `slices`：数组，每项含 `name`（类别名，2-5 词）、`value`（非负数值）
  - `total`：数值，所有 slices 之和（或独立给定的总量）
  - `centerLabel`：字符串，中心头条标签（如"总收入"）
  - `centerValue`：字符串，中心头条数值（格式化后的总量或头条百分比）
- 可选字段：
  - `unit`：数值单位（如"万元""%"）
  - `headlineSlice`：字符串，头条类别名（占比最大或最值得强调的类别），用于中心副行
  - `headlinePct`：数值，头条类别百分比，用于中心副行

## 适配要点
- 类别数 2-5 为宜；超 5 类时归并 Top N + Other（用 `--chart-other`），或改用 `pie-chart-label-list` / 紧凑表
- 同类来源按序用 `--chart-series-1` 至 `--chart-series-4`；去强调余项/Other 桶用 `--chart-other`
- 环形空洞（cutout 65%-70%）承载中心头条指标：`--text-title` + `--weight-strong` 的总量或头条百分比
- 中心头条至多一个：总量数值或头条百分比，不同时显示；副行用 `--text-caption` + `--text-muted`
- 单一焦点：占比最大类别用 `--chart-series-1`（最强调阶），并通过位置或中心副行标识
- 不用 `--accent`/`--success`/`--warning`/`--danger` 区分普通同辈份额；仅当类别本身是状态/风险变量时引入语义色
- 禁用于需精确排名、负值、长标签或超 5 类的场景；改用柱状图或紧凑表

## 降级策略
- 降级原语：`chart-card`（Chart.js 不可用时显示可见 HTML 表格：类别 / 数值 / 占比）
- 降级触发条件：
  - Chart.js CDN 加载失败（`typeof Chart === 'undefined'`）
  - slices 为空或总数 ≤ 0
  - canvas 2d 上下文获取失败
- 降级内容在 `<script>` 执行前可见，仅 Chart.js 实例化成功后隐藏；中心指标在降级表格中以头条行展示

## 适配示例
见 `widget-code.html` 与 `fixture.json`
