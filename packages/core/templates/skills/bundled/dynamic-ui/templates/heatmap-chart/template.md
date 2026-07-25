# heatmap-chart — 热力图

## 场景与意图
- 场景：data-visualization
- 意图：contribution_heatmap
- 触发：用户意图按行/列密度、日历格或贡献强度扫描数值（如"提交热力图""活跃度分布""贡献矩阵""密度扫描"）

## 数据形状
- 数据结构：二维矩阵，行×列；每单元格为非负数值
- 必需字段：
  - `rows`：数组，行标签（如项目名/团队名），2-8 项
  - `cols`：数组，列标签（如月份/日期/类别），3-12 项
  - `values`：二维数组，`values[i][j]` 对应 `rows[i]` × `cols[j]` 的数值
  - `unit`：数值单位（如"提交数""次"）
- 可选字段：
  - `focusCell`：`{row, col}` 标记单一焦点格（如最大值），用 brand 边框强调
  - `intensityLabel`：强度图例说明（如"提交密度"）

## 适配要点
- 行数 2-8、列数 3-12 为宜；超量时归并、采样或改用紧凑表
- 纯 SVG 实现（每格 `<rect>`），便于精确控制颜色映射与提示框
- 颜色强度用 `color-mix(in srgb, var(--brand) X%, var(--surface))`，X 范围 12%-88%
- 强度映射：X = 12 + (v - min) / (max - min) * 76；max==min 时统一 50%
- 单一焦点：最大值格用 `--brand` 描边强调，不靠多色
- 单元格数值文本对比度：X > 45 用 `--brand-on`（浅色文本），否则用 `--text`（深色文本）
- 行/列标签用 `--text-muted`；坐标轴与图例用 `--border` 分隔
- 不用于精确排名、连续趋势或多个同辈来源；改用对应专用模板

## 降级策略
- 降级原语：`compact-table-visual`（JS 不可用时显示可见 HTML 表格，行/列/数值完整）
- 降级触发条件：
  - 数据为空或矩阵维度不匹配
  - SVG 命名空间创建失败
- 降级内容在 `<script>` 执行前可见，仅 SVG 单元格渲染成功后隐藏

## 适配示例
见 `widget-code.html` 与 `fixture.json`
