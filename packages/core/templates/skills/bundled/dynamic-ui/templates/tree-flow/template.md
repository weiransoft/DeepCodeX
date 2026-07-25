# 水平节点树流（tree-flow）

## 场景与意图
- 场景：architecture-and-flow
- 意图：horizontal_node_tree_flow
- 触发：用户意图涉及模块/依赖层级、组件调用树、组织层级等 ≤4 层的树形依赖关系，需要从左到右展示父—子层级与主路径焦点。

## 数据形状
- 数据结构：嵌套节点树，每节点含标题、副标题、子节点数组；可标记焦点节点与主路径边集。
- 必需字段：
  - `root`：根节点对象
  - `root.title`：节点标题（2-5 词）
  - `root.children[]`：子节点数组（可嵌套至 ≤4 层）
- 可选字段：
  - `root.subtitle`：节点副标题/角色说明（caption）
  - `root.id`：节点稳定标识
  - `root.focus`：布尔，标记唯一焦点节点（渲染为 c-brand）
  - `edges[].mainPath`：主路径边标识集合（用于 --brand 高亮关键调用链）
  - `title` / `description`：顶部紧凑标题与一句话定位

## 适配要点
- 布局方向：水平从左到右；`viewBox="0 0 720 H"`（H 依内容计算），`width="100%"` + `height="auto"` 响应式缩放；安全区 ≥40 单位。
- 节点用圆角矩形（rx=8），双行节点（标题 + 副标题）≥56px 高；节点宽度 = `max(标题字符数 × 8, 副标题字符数 × 7) + 24`；中文/长标识符可上浮 30-50%。
- 节点间距 ≥60px；同层节点垂直分布，父节点居中于其子节点群的垂直中点。
- 焦点节点用 `c-brand` 类（`fill: var(--brand-soft); stroke: var(--brand)`），普通节点用 `c-neutral` 类（`fill: var(--surface); stroke: var(--border)`）；单一 brand 焦点。
- 主路径连接线用 `--brand`（`.arr-brand`，2px 描边）；普通连接线用 `--text-muted`（`.arr`，1.5px 描边）；连接线 `fill="none"`，`stroke-linejoin="round"` / `stroke-linecap="round"`，标准 `marker-end` 箭头（`orient="auto"` / `markerUnits="userSpaceOnUse"` / 约 8×8）。
- 标题用 `.th` 类（medium 字重 + body 字号），副标题用 `.ts` 类（caption + muted）；标签 2-5 词，超长先缩短或移入回答文本，不缩小字号。
- 嵌套 ≤4 层；超 5 项分组/换行/拆分，不用微小文字或裁切溢出掩盖布局失败。

## 降级策略
- 节点 ≤2 且单一关系：改用 Markdown 文本回答。
- 层级 >4 或节点 >20：建议分层多图或改用紧凑关系列表/表格。
- 关系为稠密多对多且精确拓扑比解释更重要：先摘要或用表/列表。
- 模板边界不匹配时用降级原语 `node-flow`，保持中性结构 + 单一 brand 焦点 + token 化字体/间距/圆角。

## 适配示例
见 `widget-code.html` 与 `fixture.json`
