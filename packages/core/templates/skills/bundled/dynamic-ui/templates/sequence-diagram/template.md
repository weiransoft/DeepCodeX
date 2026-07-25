# 时序图（sequence-diagram）

## 场景与意图
- 场景：architecture-and-flow
- 意图：sequence_diagram_call_chain
- 触发：用户意图涉及调用链、协议时序、跨服务请求传播、双向请求/响应握手等 3-5 参与者、4-8 有序消息的时序关系，需要 ZenUML 风格的参与者/生命线/消息布局。

## 数据形状
- 数据结构：参与者数组 + 有序消息数组；参与者固定列，消息按时间顺序自上而下排列。
- 必需字段：
  - `participants[]`：参与者数组（3-5 个），每项含 `name`、`x`（列坐标）
  - `messages[]`：消息数组（4-8 条），每项含 `from`、`to`、`label`、`kind`（`sync`/`async`/`return`/`self`）
- 可选字段：
  - `participants[].subtitle`：参与者角色副标题
  - `messages[].focus`：布尔，标记焦点路径消息（渲染为 `--brand`）
  - `messages[].order`：消息序号（默认按数组顺序）
  - `title` / `description`：顶部紧凑标题与一句话定位

## 适配要点
- SVG 实现：`viewBox="0 0 720 H"`（H 依消息数计算），`width="100%"` + `height="auto"` 响应式缩放；安全区 ≥40 单位。
- 参与者固定列：顶部参与者标签 + 头像框（`c-brand` 类，`brand-soft` 填充 + `brand` 描边）；参与者下方画生命线（垂直虚线，`--text-muted` 或 `--border`，`stroke-dasharray="4 4"`）。
- 消息箭头从一条生命线指向另一条；同步消息用实心箭头（`marker-end`，`orient="auto"` / `markerUnits="userSpaceOnUse"` / 约 8×8），异步/返回消息用开放 V 形箭头 + 虚线（`stroke-dasharray: 6 4`）。
- 自调用消息用半圆回环：从生命线出发，向右延伸后弧形返回生命线，箭头指向自身。
- 消息标签居中于参与者间，偏移箭头上/下 14-20 单位；同步调用标签居上，返回标签居下（交替偏移避免双向请求/响应标签碰撞）。
- 行距：带标签消息行 72 单位；紧凑仅状态行 56 单位；同一 y 坐标不重复用于状态标记、消息线与消息标签。
- 焦点路径消息用 `--brand`（`msg-sync-brand`，2px 描边）；普通消息用 `--text-muted`（`msg-sync`，1.5px 描边）；返回用 `--text-muted` 虚线。参与者统一 `c-brand` 表达结构性角色，焦点由消息路径的 brand 色显式表达。
- 参与者 3-5 个、消息 4-8 条；超出则分相为多个紧凑图或垂直堆叠面板，不缩小文字或压缩行距。

## 降级策略
- 参与者 <3 或消息 <4：关系过简单，改用 Markdown 文本回答。
- 参与者 >5 或消息 >8：分相为多个紧凑图或垂直堆叠面板；稠密协议拆分。
- 关系为纯线性列表无分支：改用 Markdown 有序列表。
- 模板边界不匹配时用降级原语 `node-flow` 或 `explanation-panel`，保持中性结构 + 单一 brand 焦点路径 + token 化字体/间距/圆角。

## 适配示例
见 `widget-code.html` 与 `fixture.json`
