# 架构元素原语（architecture-elements）

## 场景与意图
- 场景：architecture-and-flow
- 意图：architecture_element_palette
- 触发：用户意图涉及组件/模块架构图，需要复用一组标准块样式（neutral/brand/boundary/external）与连接线样式（实线/brand 虚线/弱依赖虚线/带注解边）来组合表达模块组织、逻辑边界与外部系统调用关系。

## 数据形状
- 数据结构：块集合 + 连接线集合；块分四种类型，连接线分四种类型，可附带图例。
- 必需字段：
  - `blocks[]`：块数组，每块含 `type`（`neutral`/`brand`/`boundary`/`external`）、`title`、`x`/`y`/`width`/`height`
  - `edges[]`：连接线数组，每条含 `from`、`to`、`type`（`neutral-solid`/`brand-dashed`/`neutral-dashed`/`labeled`）
- 可选字段：
  - `blocks[].subtitle`：块副标题/角色
  - `blocks[].id`：稳定标识（供 edges 引用）
  - `edges[].label`：连接线注解（仅 `labeled` 类型）
  - `boundary`：逻辑边界容器的块引用与标签
  - `title` / `description`：顶部紧凑标题与一句话定位

## 适配要点
- 块用圆角矩形（rx=8 或 `--radius`）；boundary 用虚线边框（`stroke-dasharray: 6 4`）区别于节点实线，无填充。
- 四类块样式：
  - `neutral`（普通模块）：`fill: var(--surface); stroke: var(--border)`，c-neutral 类
  - `brand`（核心模块，唯一焦点）：`fill: var(--brand-soft); stroke: var(--brand)`，c-brand 类
  - `boundary`（逻辑边界容器）：`fill: none; stroke: var(--text-muted); stroke-dasharray: 6 4`，用现有 token 表达结构角色
  - `external`（外部系统）：`fill: var(--surface-muted); stroke: var(--text-muted)`，用现有 token 表达外部角色
- 四类连接线样式：
  - `neutral solid`（标准调用）：`stroke: var(--text-muted); stroke-width: 1.5`，实线
  - `brand dashed`（高亮数据流，主路径）：`stroke: var(--brand); stroke-width: 2; stroke-dasharray: 6 4`
  - `neutral dashed`（弱依赖）：`stroke: var(--text-muted); stroke-width: 1.5; stroke-dasharray: 4 4`
  - `labeled edge`（带注解连接）：neutral solid + 居中注解标签（1-3 词，置于连接线上方，不压描带）
- 所有连接线 `fill="none"`，`stroke-linejoin="round"` / `stroke-linecap="round"`，标准 `marker-end` 箭头（`orient="auto"` / `markerUnits="userSpaceOnUse"` / 约 8×8）。
- 主路径用 `--brand`；普通连接线用 `--text-muted`；不做彩虹层级着色，不按类别赋色。
- 块标签 2-5 词；超 2 种块样式或 2 种连接线样式时在预留角落或图下方加简洁图例，图例不浮于模块或连接线走廊上。
- 外部块与边界用现有 token（`--surface-muted`/`--text-muted`）表达结构角色，不发明新色板别名或额外含义色。

## 降级策略
- 节点 ≤2 且单一关系：改用 Markdown 文本回答。
- 模块 >6 且未分组：先归入 boundary 边界或拆分多图；超出硬可读性门槛（≤6 未分组模块、≤8 连接线）改用紧凑关系列表/表格。
- 关系为稠密多对多：先摘要或用表/列表。
- 模板边界不匹配时用降级原语 `node-flow` 或 `explanation-panel`，保持中性结构 + 单一 brand 焦点 + token 化字体/间距/圆角。

## 适配示例
见 `widget-code.html` 与 `fixture.json`
