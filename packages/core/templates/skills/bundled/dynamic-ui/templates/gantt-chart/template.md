# gantt-chart（甘特图）

## 场景与意图
- 场景：architecture-and-flow
- 意图：project_schedule_gantt
- 触发：用户意图涉及任务/里程碑排期与关键路径可视化（如产品上线排期、迭代计划、关键路径分析）。当任务数 >10 或需精确到日级资源分配时应改用专业项目管理工具或 Markdown 列表。

## 数据形状
- 数据结构：一组任务（含起止时间）+ 可选里程碑 + 可选关键路径标记。
- 必需字段：
  - `tasks`：`Array<{ name: string; start: number; end: number; critical?: boolean }>`，1~6 个任务，`start`/`end` 为时间单位索引（如周次），`critical` 标记是否在关键路径上
  - `timeStart`：`number`，时间轴起点索引
  - `timeEnd`：`number`，时间轴终点索引
  - `timeUnit`：`string`，时间单位标签（如 "周"、"天"）
- 可选字段：
  - `milestones`：`Array<{ name: string; at: number }>`，里程碑（用菱形标记），1~3 个
  - `timeLabels`：`string[]`，时间轴标签数组，长度须等于 `timeEnd - timeStart + 1`
  - `progress`：`Array<number>`，与 `tasks` 等长，0~1 表示完成度（用于在任务条上叠加进度填充）

## 适配要点
- 任务数严格控制在 1~6 个：超过 6 个须分组、拆分或改用 Markdown 列表，本模板不扩展。
- 关键路径任务用 `--brand` 填充 + `--brand-soft` 描边，作为唯一可见焦点；普通任务用 `--chart-series-1` 至 `--chart-series-4` 按序着色，里程碑用 `--brand` 菱形。
- 时间轴使用 SVG viewBox 布局，宽度 `720`，高度按任务数计算（每任务 56 单位 + 顶部时间轴 60 单位 + 底部内边距 24 单位）；安全区 ≥40 单位。
- 任务标签 2~5 词；时间标签用 `--text-caption`；任务名用 `--text-body`；标题用 `--text-title`。
- 图表本体不含洞察/结论/分析文案，仅保留时间轴、任务条、里程碑与必要的焦点标记。
- 不使用 Chart.js（甘特图非 Chart.js 原生类型），用 SVG 直接绘制；不依赖外部库。
- 提示框用 SVG `<title>` 元素提供原生可达性提示（架构场景允许，无 canvas 提示约束）。
- 严格遵循 SVG 画布规范：`viewBox="0 0 720 H"`，`width="100%"` + `height="auto"`。

## 降级策略
- 降级原语：`node-flow`（节点流式布局）+ 可见 HTML 表格
- 降级触发条件：
  - SVG 不可用（极罕见，浏览器均支持）
  - 数据为空或所有任务起止相同
  - 任务数 >6（模板边界外，应改用其他形式）
- 降级行为：保留可见 HTML 表格（含任务名、起止时间、是否关键路径），SVG 仅作为视觉增强；表格沿用 token 化字体与边框。本模板不依赖外部 CDN，故无 CDN 失败降级路径。

## 适配示例
见 `widget-code.html` 与 `fixture.json`
