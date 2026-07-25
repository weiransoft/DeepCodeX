# 对比卡片（comparison-cards）

## 场景与意图
- 场景：comparison-and-decision
- 意图：multi_option_comparison_cards
- 触发：用户意图涉及 2-4 个产品/来源/供应商/方案/框架/解决方案的并排对比，且每个选项需在 3-5 个共享维度上呈现差异，并存在一个明确推荐或差异化焦点。

## 数据形状
- 数据结构：选项数组，每项含标题、副标题/元数据、可选头条数值（KPI）、可选评分条、分隔行（维度+值）、至多 2 个标签、可选推荐标记。
- 必需字段：
  - `options[]`：选项数组（长度 2-4）
  - `options[].name`：选项标题（6-10 词以内）
  - `options[].rows[]`：分隔行，每行含 `label` 与 `value`
- 可选字段：
  - `options[].subtitle`：副标题/元数据（如作者、许可、来源）
  - `options[].recommended`：布尔，标记推荐选项（至多一个为 true）
  - `options[].metric`：头条数值对象 `{ label, value, max }`，每卡至多一个
  - `options[].tags[]`：标签数组（至多 2 个）
  - `title` / `description`：顶部紧凑标题与一句话定位

## 适配要点
- 卡片背景统一用 `--surface`；嵌套或次级区域用 `--surface-muted`。推荐卡仅用 `--brand` 边框强调，不填充 brand 背景或 brand-soft 表面。
- 每张选项卡至多一个 `--text-title` 真头条数值（KPI）；行值用 `--text-body` 或 `--text-code`，行标签/标签用 `--text-caption` + `--text-muted`，严格遵循卡片信息层级。
- 推荐徽章用 `--brand-soft-strong` 背景 + `--brand-text` 文字；非推荐选项保持中性表面与中性边框。推荐焦点还可用 `--brand` 文字强调该卡的头条数值。
- 评分条用 `--chart-series-1` 至 `--chart-series-4` 表达分数（同类来源对比），推荐卡用 `--chart-series-1`；非推荐卡按序取后续序列色，禁止用语义色或 accent 区分普通同辈来源。
- 分隔行用 `--border` 分隔线，扁平结构（标签 + 右对齐值或紧凑条），不嵌套行卡；行内文本 ≤15 词。
- 响应式：宽屏并排（`grid-template-columns: repeat(auto-fit, minmax(0, 1fr))`），窄视口自动换行或垂直堆叠；推荐焦点不依赖默认选中态，悬停/聚焦提供检视强调（≤120ms）。
- 不在卡片下方加推荐理由或结论文案；理由放回答文本中。

## 降级策略
- 选项 > 4 或维度 > 7：先筛至最具代表性的 2-4 选项与 3-5 核心维度，超出部分移入回答文本；仍超则改用 Markdown 表格。
- 无明确推荐或所有选项在所有维度上基本相同：不渲染 widget，改用 Markdown 文字回答。
- 单一维度差异（一句话即可说明）：拒绝进入本场景。
- 模板边界不匹配时用降级原语 `decision-cards`，保持中性表面、token 字体/间距/圆角与单一 brand 焦点规则。

## 适配示例
见 `widget-code.html` 与 `fixture.json`
