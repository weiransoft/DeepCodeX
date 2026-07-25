# Visual Tokens（视觉 Token 定义）

本文件定义内联 widget 的紧凑颜色契约。保持默认生成表面小而精：中性 token、一个当前 brand/主题、固定语义 token、少量图表/图示类。

## 生成模式

助手在 `widget_code` 中输出 token CSS。

默认行为：
- 除非用户明确要求其他颜色主题，否则用紫色 brand 主题
- 用户要求蓝/青/绿/琥珀/珊瑚/粉视觉主题时，仅重映射 brand/主题变量
- 正常生成时不暴露完整参考色板
- 不创建 `--w-*` 等额外本地别名层
- 不按序列选色；颜色必须编码焦点、类别、状态、强度或层级
- 颜色契约优先于语义色臆测；先用中性、brand、chart-series token；仅当用户明确要求状态/风险/健康编码或数据字段本身是状态/风险变量时才用语义色，而非因标签恰好含成功/失败/警告/阻塞/接受/拒绝等词
- 字体、间距、圆角契约优先于视觉即兴；即便自定义输出无就绪模板也用本文件的角色 token
- 图表数据标记可用彩色 brand 系列；卡片、指标块、安静面板在任何状态下保持中性
- 默认紫色主题下，复杂图表仅可通过相邻 brand 色相（如蓝/粉）扩展；这是 chart-series 扩展，非整体主题切换；不因类别增多就切换为随机彩虹、高饱和或无关预设色
- 宿主主题通过 `:root[data-widget-theme="light"]` 或 `:root[data-widget-theme="dark"]` 暴露；`:root` 放亮色默认，`:root[data-widget-theme="dark"]` 放暗色覆盖
- 每个主题敏感视觉属性须用 token；SVG `fill`/`stroke`、坐标轴标签、图表条/线、图例文字、卡片表面、边框、连接线须引用 `var(...)`
- 组件选择器或 SVG 属性中禁用 `#fff`/`#000`/`#333`/`rgba(0,0,0,...)` 等硬编码亮色值（定义 token 除外）
- 自定义/降级 widget 沿用就绪模板的紧凑运行时契约；不得引入本地色板别名、额外类别色、着色卡背景或第二视觉主题

## 降级 token 门槛

无就绪模板匹配时，写组件 CSS 前应用：
- 从本文件的中性表面、文字、边框、间距、圆角、字体起
- 先用 `--font-*`、`--text-*`、`--spacer-*`、`--radius*` token 做 UI 样式，再加组件特定 CSS
- 不发明本地字号阶、间距别名、圆角别名或一次性字面视觉值
- `--brand` 仅用于单一焦点：选中路径、推荐、最高值或主图表标记
- 自定义/降级图表普通同辈类别按序赋 `--chart-series-1` 至 `--chart-series-4`，再考虑任何语义 token
- `--accent` 仅当次级类别有异于同辈对比的真实含义时用
- 语义色仅当用户明确要求状态/风险/健康编码或数据字段本身是状态/风险变量时用
- 图表色放数据标记与图例点；周围卡片、指标格、面板保持中性
- 普通同辈类别止于 `--chart-series-1` 至 `--chart-series-4` + 可选 `--chart-other`
- 视觉需更多色才能工作时改结构：归并 Top N + Other、拆小多图或用紧凑表/列表
- 若自定义输出需渐变、彩虹类别、着色卡填充、微小文字、非 token 字号、非 token 间距、自定义圆角或硬编码亮色组件色才可接受，则拒绝

## 必需的 CSS 放置

token 定义置于首个 `<style>` 块顶部，组件样式之前：

```html
<style>
:root {
  color-scheme: light;
  --surface: #F7F7F8;
  --surface-muted: #EFEFF2;
  --text: #171717;
  --text-muted: #52525B;
  --border: rgba(23, 23, 23, 0.12);

  --brand: #4B3FE3;
  --brand-soft: #F2F7FF;
  --brand-soft-strong: #E5EAFF;
  --brand-text: #1A1759;
  --brand-on: #FFFFFF;
  --chart-series-1: #3C2ECA;
  --chart-series-2: #A9AEFF;
  --chart-series-3: #6F6FFF;
  --chart-series-4: #22A5F7;
  --chart-other: #D3D4DA;

  --accent: #27D2BF;
  --accent-2: #F87454;
  --accent-soft: #EAFBF8;
  --accent-text: #0F766E;
  --success: #1DC981;
  --warning: #EFAA17;
  --danger: #E8463A;

  --radius: 8px;
  --radius-card: 12px;
  --radius-full: 999px;
  --spacer-4: 4px;
  --spacer-8: 8px;
  --spacer-12: 12px;
  --spacer-16: 16px;
  --spacer-20: 20px;
  --spacer-24: 24px;
  --font-sans: "SF Pro Text", "PingFang SC", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-metric: "Inter", "SF Pro Text", "PingFang SC", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --weight-regular: 400;
  --weight-medium: 500;
  --weight-strong: 600;
  --text-caption: 12px/18px;
  --text-body: 14px/20px;
  --text-title: 16px/24px;
  --text-code: 13px/20px;
}

:root[data-widget-theme="dark"] {
  color-scheme: dark;
  --surface: #171717;
  --surface-muted: #262626;
  --text: #E5E5E5;
  --text-muted: #A1A1AA;
  --border: rgba(229, 229, 229, 0.12);

  --brand: #6054F1;
  --brand-soft: #1A1759;
  --brand-soft-strong: #3C2ECA;
  --brand-text: #CFD8FF;
  --chart-series-1: #4B3FE3;
  --accent-2: #F87454;
  --accent-soft: #123F3C;
  --accent-text: #CCFBF1;
}

.widget {
  color: var(--text);
  background: transparent;
  font: var(--weight-regular) var(--text-body) var(--font-sans);
  letter-spacing: 0;
}
</style>
```

可选独立降级：widget 可能被下载并在 Trae 外打开时，在 `data-widget-theme` 块后于 `@media (prefers-color-scheme: dark)` 下复制相同暗色覆盖。

## 运行时颜色契约

正常生成 widget 仅用以下颜色 token。

**中性**：

| Token | 亮色 | 暗色 | 用途 |
|---|---|---|---|
| `--surface` | `#F7F7F8` | `#171717` | 卡片、表格、芯片、安静面板表面 |
| `--surface-muted` | `#EFEFF2` | `#262626` | 嵌套或次级表面 |
| `--text` | `#171717` | `#E5E5E5` | 主文本与主图标色（通过 `currentColor`） |
| `--text-muted` | `#52525B` | `#A1A1AA` | 次级文本、坐标轴标签、说明、安静图标、引导线 |
| `--border` | `rgba(23,23,23,.12)` | `rgba(229,229,229,.12)` | 普通分隔线与卡片边框 |

**Brand/主题**：

| Token | 亮色默认 | 暗色默认 | 用途 |
|---|---|---|---|
| `--brand` | `#4B3FE3` | `#6054F1` | 主焦点、选中态、主图表系列、推荐路径 |
| `--brand-soft` | `#F2F7FF` | `#1A1759` | 非卡节点/徽章/图表填充的浅 brand 背景；永不作卡片表面 |
| `--brand-soft-strong` | `#E5EAFF` | `#3C2ECA` | 仅非卡强调的更强 brand 背景 |
| `--brand-text` | `#1A1759` | `#CFD8FF` | brand soft 表面上的文字 |
| `--brand-on` | `#FFFFFF` | `#FFFFFF` | 实心 brand 填充上的文字/图标 |
| `--chart-series-1` | `#3C2ECA` | `#4B3FE3` | 第一图表来源；每模式最强可读 brand 阶 |
| `--chart-series-2` | `#A9AEFF` | `#A9AEFF` | 第二图表来源；高对比浅 brand 阶 |
| `--chart-series-3` | `#6F6FFF` | `#6F6FFF` | 第三图表来源；分离的中间 brand 阶 |
| `--chart-series-4` | `#22A5F7` | `#22A5F7` | 第四图表来源；活动 brand 附近的相邻色相 |
| `--chart-other` | `#D3D4DA` | `#D3D4DA` | 去强调的分组余项（Other/长尾/残余/低优先溢出） |

**次级 accent**：

| Token | 亮色 | 暗色 | 用途 |
|---|---|---|---|
| `--accent` | `#27D2BF` | `#27D2BF` | 一个真正不同的次级类别；非普通 A/B/C/D 图表来源 |
| `--accent-2` | `#F87454` | `#F87454` | 需有界额外类别色的模板的次级 accent |
| `--accent-soft` | `#EAFBF8` | `#123F3C` | 次级类别表面 |
| `--accent-text` | `#0F766E` | `#CCFBF1` | 次级类别表面上的文字 |

**语义**：

| Token | 亮色 | 暗色 | 用途 |
|---|---|---|---|
| `--success` | `#1DC981` | `#1DC981` | 正面结果、健康状态、完成、接受路径 |
| `--warning` | `#EFAA17` | `#EFAA17` | 注意、权衡、成本、风险、待定状态 |
| `--danger` | `#E8463A` | `#E8463A` | 失败、阻塞、拒绝选项、高风险 |

## 主题预设

主题预设是重映射四个运行时 brand token 的参考表。语义色不随主题变。

默认用 `purple`。仅当用户明确要求该视觉主题或提供 brand 色时用其他预设；不单凭领域措辞推断非紫色主题。

| 主题 | 50 | 100 | 200 | 500 | 600 | 700 | 900 | 适用 |
|---|---|---|---|---|---|---|---|---|
| `purple`（默认） | `#F2F7FF` | `#E5EAFF` | `#A9AEFF` | `#6F6FFF` | `#4B3FE3` | `#3C2ECA` | `#1A1759` | 默认 brand |
| `blue` | `#EFF6FF` | `#DBEAFE` | `#BFDBFE` | `#3B82F6` | `#2563EB` | `#1D4ED8` | `#1E3A8A` | |
| `teal` | `#ECFDF9` | `#CCFBF1` | `#99F6E4` | `#14B8A6` | `#0D9488` | `#0F766E` | `#134E4A` | |
| `green` | `#F0FDF4` | `#DCFCE7` | `#BBF7D0` | `#22C55E` | `#16A34A` | `#15803D` | `#14532D` | |
| `amber` | `#FFFBEB` | `#FEF3C7` | `#FDE68A` | `#F59E0B` | `#D97706` | `#B45309` | `#78350F` | |
| `coral` | `#FFF1ED` | `#FFDAD1` | `#FFB8A8` | `#FF6B4A` | `#E0523F` | `#B73B2F` | `#6F211B` | |
| `pink` | `#FDF2F8` | `#FCE7F3` | `#FBCFE8` | `#EC4899` | `#DB2777` | `#BE185D` | `#831843` | |

主题映射：

| 主题列 | 运行时 token |
|---|---|
| `50` | `--brand-soft` |
| `100` | `--brand-soft-strong` |
| `600` | 亮色 `--brand` |
| `900` | `--brand-text` |

默认紫色用模式特定暗色 brand 覆盖：`--brand: #6054F1`。

chart-series 映射（同类来源对比）：

| 运行时 token | 默认来源 |
|---|---|
| `--chart-series-1` | 亮色活动主题 700；暗色模式特定主 brand 阶 |
| `--chart-series-2` | 活动主题 200/500 混或明显更浅可读 brand 阶 |
| `--chart-series-3` | 活动主题 500 或另一分离中间 brand 阶 |
| `--chart-series-4` | 活动品牌附近的相邻色相中阶 |
| `--chart-other` | 中性低强调余项色，非另一主类别 |

暗色模式下反转 soft 表面映射并应用模式特定主色覆盖：

| 来源 | 运行时 token |
|---|---|
| 暗色 brand 覆盖 | `--brand` |
| 暗色主 chart 阶 | `--chart-series-1` |
| `900` | `--brand-soft` |
| `700` | `--brand-soft-strong` |
| `100` | `--brand-text` |

重映射模板：

```css
:root {
  --brand: <theme-600>;
  --brand-soft: <theme-50>;
  --brand-soft-strong: <theme-100>;
  --brand-text: <theme-900>;
}
:root[data-widget-theme="dark"] {
  --brand: <dark-brand-or-theme-600>;
  --chart-series-1: <dark-primary-series-or-theme-600>;
  --brand-soft: <theme-900>;
  --brand-soft-strong: <theme-700>;
  --brand-text: <theme-100>;
}
```

## 图标颜色用法

通过 `currentColor` 用图标；在按钮、芯片、行或包裹器上设 `color`。
- 默认图标：`color: var(--text-muted)`
- 安静或禁用图标：`color: var(--text-muted); opacity: .64`
- 主操作、选中或焦点图标：`color: var(--brand)`
- 实心 brand 填充内图标：`color: var(--brand-on)`
- 成功/警告/危险图标：用匹配的语义 token
- 图示图标或形状指示器遵循图示类或显式语义描边；不在图内加独立图标专用色

## 图表颜色用法

用最小有用系列集：
- 主单系列或推荐选项：`--chart-series-1` 或 `--brand`
- 同类来源对比（A/B/C/D、渠道、模型、版本、浏览器、地区、团队、部门）用 chart-series 阶
- 2 同辈来源用 `--chart-series-1` 与 `--chart-series-2`；须可见分离，非相邻中间调
- 3 同辈来源用 `--chart-series-1` 至 `--chart-series-3`，使活动 brand 族占多数
- 4 同辈来源用 `--chart-series-4` 作唯一相邻色相扩展，而非强加第四个难辨 brand 色
- 复杂图需更多对比时优先分组、小多图或表/列表，再扩色；不加超四个 chart-series token 的同辈色
- 活动 brand 非紫色时，从用户 brand 色相邻域派生相邻色阶，不硬编码紫/蓝
- 分组余项、长尾项、残余桶、低优先溢出用 `--chart-other`
- 不用 `--accent`/`--success`/`--warning`/`--danger` 区分普通图表来源
- `--accent` 仅当第二系列是真正不同的语义类别时用，非另一同辈来源
- 语义 token 仅当状态/风险/健康是主编码变量或用户明确要求时用
- 显式正面状态：`--success`；显式注意或中等风险：`--warning`；显式失败/阻塞/高风险：`--danger`
- 图表网格与坐标轴：`--border`；图表标签与图例：`--text-muted`，关键值用 `--text`

单个内联 widget 不超 4 个 brand 图表来源色 + 一个可选 `--chart-other` 桶。数据需更多同辈类别时归并 Top N + Other、小多图或表/列表。不加深灰降级类别；灰表示低重要性。保持可见图例或直接标签，切片/条/色块/提示点用同一 token。

`sankey-chart` 的 628 样本是文档化的模板本地例外（展示有界来源/结果流色板）。该例外不得视为通用图表色板。`templates/sankey-chart` 之外，普通同辈图表来源不得用 `--accent`/`--accent-2`/`--success`/`--warning`/`--danger`。

## 表面颜色用法

默认卡片、图表面板、指标块、表格、安静面板背景用 `--surface`；嵌套或次级卡区域用 `--surface-muted`。普通卡用 `--border`；聚焦卡可用 `--brand` 仅作边框。

规则：
- 颜色放图表本体，不放卡本体。条、线、点、切片、热格、图例色块、提示点可用 `--chart-series-*`、`--brand` 或文档化的语义 token
- 允许卡样式：中性边框 + 中性/浅灰填充，或 brand 边框 + 中性/浅灰填充；不配 brand 边框 + 着色卡填充
- 不用 `--brand-soft`、`--brand-soft-strong`、`--accent-soft`、语义 soft 填充、chart-series 色、渐变或着色 color-mix 作卡背景
- 卡需显示选中/推荐/类别/状态时先用边框处理与文本层级；卡填充保持中性
- 成功/警告/危险卡仅用语义色作描边、图标、标签文字或次级标签强调；卡填充仍中性
- 暗色模式同角色：卡表面中性，图表标记带色

## 图示色板

普通图示仅用以下类：
- `c-neutral`：结构、容器、非活动节点、非焦点步骤
- `c-brand`：主路径、选中节点、推荐、焦点或模型/AI 概念
- `c-accent`：一个次级类别或对比路径
- `c-success`：状态/风险图中显式接受、健康、完成、正面状态
- `c-warning`：状态/风险图中显式待定、注意、成本、中等风险状态
- `c-danger`：状态/风险图中显式失败、阻塞、拒绝选项、热态

规则：
- 紧凑图示用 `c-neutral` + 至多 1-2 含义色
- 主线默认用 `c-brand`，非随机类别或语义色
- 流程图与架构图默认姿态：中性表面 + 中性连接线 + 一个可见 brand 焦点；同辈类别需色时先用 chart-series 阶再语义类
- `c-success`/`c-warning`/`c-danger` 仅当图示显式关于状态/健康/风险/审批/失败时用；含成功/失败/阻塞等词的普通流程标签保持中性、brand 或 chart-series，除非用户要状态视图
- 颜色数即含义数；三节点三无关色则图示声称三种不同含义，需标签或图例，否则保持中性
- 不按彩虹着色步骤
- 不对连接线路径应用图示类；普通连接线用 `arr` 或 `leader`；`--brand` 或 `--chart-series-*` 仅用于带标签的焦点/类别路径，语义描边仅用于显式状态/风险路径
- 默认流程图连接线色为 token 化浅灰（`--text-muted` 或 `--border`）；避免任意饱和连接线色
- brand 或 accent soft 表面上的文字用匹配文字 token；语义 soft 表面上的文字用 `--text`；语义色本身保留作描边、图标或次级标签强调
- 状态机、风险图或机制图当颜色直接编码状态/温度/压力/活跃度等已解释变量时允许例外；此时保持色板 token 化并加直接标签或简洁图例

类 CSS 模板：

```css
.t { fill: var(--text); font: var(--weight-regular) var(--text-body) var(--font-sans); }
.th { fill: var(--text); font: var(--weight-medium) var(--text-body) var(--font-sans); }
.ts { fill: var(--text-muted); font: var(--weight-regular) var(--text-caption) var(--font-sans); }
.arr { stroke: var(--text-muted); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; fill: none; }
.leader { stroke: var(--text-muted); stroke-width: .5; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 4 4; fill: none; }

g.c-neutral > rect, g.c-neutral > ellipse, g.c-neutral > circle, g.c-neutral > polygon,
rect.c-neutral, ellipse.c-neutral, circle.c-neutral, polygon.c-neutral {
  fill: var(--surface); stroke: var(--border);
}
g.c-brand > rect, g.c-brand > ellipse, g.c-brand > circle, g.c-brand > polygon,
rect.c-brand, ellipse.c-brand, circle.c-brand, polygon.c-brand {
  fill: var(--brand-soft); stroke: var(--brand);
}
.c-brand > .th, .c-brand > .t { fill: var(--brand-text); }
.c-brand > .ts { fill: var(--brand); }
g.c-accent > rect, g.c-accent > ellipse, g.c-accent > circle, g.c-accent > polygon,
rect.c-accent, ellipse.c-accent, circle.c-accent, polygon.c-accent {
  fill: var(--accent-soft); stroke: var(--accent);
}
.c-accent > .th, .c-accent > .t { fill: var(--accent-text); }
.c-accent > .ts { fill: var(--accent); }
g.c-success > rect, g.c-success > ellipse, g.c-success > circle, g.c-success > polygon,
rect.c-success, ellipse.c-success, circle.c-success, polygon.c-success {
  fill: color-mix(in srgb, var(--success) 14%, transparent); stroke: var(--success);
}
.c-success > .th, .c-success > .t { fill: var(--text); }
.c-success > .ts { fill: var(--success); }
g.c-warning > rect, g.c-warning > ellipse, g.c-warning > circle, g.c-warning > polygon,
rect.c-warning, ellipse.c-warning, circle.c-warning, polygon.c-warning {
  fill: color-mix(in srgb, var(--warning) 14%, transparent); stroke: var(--warning);
}
.c-warning > .th, .c-warning > .t { fill: var(--text); }
.c-warning > .ts { fill: var(--warning); }
g.c-danger > rect, g.c-danger > ellipse, g.c-danger > circle, g.c-danger > polygon,
rect.c-danger, ellipse.c-danger, circle.c-danger, polygon.c-danger {
  fill: color-mix(in srgb, var(--danger) 14%, transparent); stroke: var(--danger);
}
.c-danger > .th, .c-danger > .t { fill: var(--text); }
.c-danger > .ts { fill: var(--danger); }
```

## 物理色场景

物理色场景是罕见例外。若场景描绘不应跨主题语义反转的材质（天空、水、草、皮肤、金属、火、热），仅在该说明性 SVG 内用一小组显式色。保持文字、边框、控件与 UI 外壳在 token 契约上。不混硬编码材质填充与主题响应前景文字，除非对比度被显式控制。

## 非颜色 token

按需直接用这些紧凑角色 token。

**间距**：

| Token | 值 | 用途 |
|---|---|---|
| `--spacer-4` | `4px` | 紧凑内部间隙 |
| `--spacer-8` | `8px` | 密集控件间隙 |
| `--spacer-12` | `12px` | 输入/弹层内边距 |
| `--spacer-16` | `16px` | 紧凑卡内边距/网格间距 |
| `--spacer-20` | `20px` | 默认卡内边距 |
| `--spacer-24` | `24px` | 分组间隙 |

间距用法：
- `--spacer-4` 用于紧凑标记/文字间隙与紧凑内联组
- `--spacer-8` 用于密集控件间隙、图例行间隙、提示内部间隙
- `--spacer-12` 用于输入、弹层、徽章行、紧凑面板内边距
- `--spacer-16` 用于紧凑卡内边距、图表内间距、网格间隙
- `--spacer-20` 用于默认卡与图表面板内边距
- `--spacer-24` 用于分离视觉组或区段间隙
- 不发明 `6px`/`10px`/`14px`/`18px`/`22px`/`28px` 等中间间距值；布局拥挤或松散时选最近 spacer token 或改结构
- SVG 坐标、viewBox 维度、图表 canvas 高度、弧半径、条位置、数据驱动几何可用字面数值；周围 UI 内边距、间隙、文字偏移、图例间距、提示间距、卡布局须用 spacer token

**圆角**：

| Token | 值 | 用途 |
|---|---|---|
| `--radius` | `8px` | 默认控件、标签、图表标签、紧凑容器、普通 SVG 节点 |
| `--radius-card` | `12px` | 卡片、分组指标块、图表面板、弹层、大 SVG 容器 |
| `--radius-full` | `999px` | 仅圆与胶囊 |

圆角用法：
- 多数生成 UI 与 SVG 节点用 `--radius`
- 仅元素是卡、图表面板、分组指标块或大容器时用 `--radius-card`
- 仅圆与胶囊用 `--radius-full`
- 不发明中间圆角值；过尖或过软时选 `--radius` 或 `--radius-card`，不加 `4px`/`6px`/`10px`/`16px` 或自定义值

**字体**：

| Token | 值 | 用途 |
|---|---|---|
| `--font-sans` | `"SF Pro Text", "PingFang SC", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` | 默认文字与标题 |
| `--font-metric` | `"Inter", "SF Pro Text", "PingFang SC", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` | token 化字号下的数值强调 |
| `--font-mono` | `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace` | 代码、ID、紧凑数值 |
| `--weight-regular` | `400` | 默认文字 |
| `--weight-medium` | `500` | 强调文字与小标题 |
| `--weight-strong` | `600` | 强指标或主数据标签 |
| `--text-caption` | `12px/18px` | 说明、图例、坐标轴标签、辅助文字 |
| `--text-body` | `14px/20px` | 基础字号；默认正文、控件、普通图表标签 |
| `--text-title` | `16px/24px` | 卡标题、紧凑区段标题、允许的最大字号 |
| `--text-code` | `13px/20px` | 代码片段、ID、紧凑数值 |

字体用法（按角色集）：
- 视 `14px` 为基线字号，由 `--text-body` 表达
- 默认文字用 `font: var(--weight-regular) var(--text-body) var(--font-sans)`
- 仅说明、图例、坐标轴标签、辅助文字、次级表文字用更小 `--text-caption`
- 仅卡标题、紧凑区段标题与一个主指标显示用大于正文的文字；`--text-title` 为最大字号
- 卡标题与紧凑区段标题用 `font: var(--weight-medium) var(--text-title) var(--font-sans)`
- 主 KPI、记分卡、分析、营收、用量、转化数值用 `font: var(--weight-strong) var(--text-title) var(--font-metric)` + tabular figures
- 代码片段、ID、紧凑数值、表数字、技术计数器用 `font: var(--weight-medium) var(--text-code) var(--font-mono)` + tabular figures
- 组件 CSS 中不用 `11px`/`13px`/`15px`/`18px`/`22px`、`font-family: Inter`、`line-height: 1.2` 等 ad hoc 值；用匹配文字用途的角色 token
- 内容在 token 化字号下放不下时缩减内容、换行标签、移入提示/表文本、拆分视觉或改 Markdown；不缩到 `--text-caption` 以下强塞密集 widget

不重新引入旧 `body-*`/`heading-*`/`code-editor-*`/`font-family-*` token 族，除非 skill 有意扩展超出内联 widget。

## 卡片信息层级

对每个卡、指标块、对比选项、安静面板、表单元格面板、多图表 widget 中的辅助卡应用此层级。

| 角色 | 必需 token 集 | 颜色角色 |
|---|---|---|
| 卡标题/选项名 | `font: var(--weight-medium) var(--text-title) var(--font-sans)` | `--text` |
| 副标题/元数据 | `font: var(--weight-regular) var(--text-caption) var(--font-sans)` | `--text-muted` |
| 正文事实/行值 | `font: var(--weight-regular) var(--text-body) var(--font-sans)` | `--text` |
| 行标签/辅助文字 | `font: var(--weight-regular) var(--text-caption) var(--font-sans)` | `--text-muted` |
| 紧凑数字/ID/计数器 | `font: var(--weight-medium) var(--text-code) var(--font-mono)` | `--text` |
| 仅主 KPI | `font: var(--weight-strong) var(--text-title) var(--font-metric)` | `--text` 或仅焦点值时 `--brand` |
| 徽章/标签/图例标签 | `font: var(--weight-medium) var(--text-caption) var(--font-sans)` | `--text-muted`、`--brand-text` 或显式语义 token |

规则：
- 每卡或每辅助指标组至多一个 `--text-title` 真头条数值；不把每个数值渲染为头条
- 无文字超 `--text-title`；标签需更多强调时用位置、字重或徽章，而非更大字号
- 组合图表 widget 中的辅助指标卡须从属主图表；用紧凑行/条/列表先于加大数字
- 卡、指标块、安静面板保持中性 `--surface` 或 `--surface-muted` 填充；颜色仅用于图表标记、边框、徽章、图标或焦点文字
- 空值可显示 `Unknown`/`N/A` 或省略；不把未知转零或使其视觉主导
- 长标签应缩短、换行或移入提示/表文本；不缩到 `--text-caption` 以下或用溢出裁切掩盖问题
- 不同单位混合指标应用行或紧凑表；除非比较这些 KPI 是目的，否则不把无关 KPI 数值并排作等大视觉头条

## 用法规则

- 从默认紫色主题起
- 仅当用户明确要求其他视觉主题或提供 brand 色时切换主题；不单凭领域措辞推断非紫主题
- 语义色跨主题固定
- 卡、指标块、图表面板、表格、安静结构用中性表面；brand 色仅用于图表标记、主焦点与聚焦卡边框
- 同类图表来源用 `--chart-series-*`
- `--chart-other` 仅用于一个去强调的分组余项或溢出桶
- `--accent` 仅当 chart-series 非正确编码后用于一个真正不同的次级类别
- 语义色仅当显式编码状态/风险/健康时用；不从普通标签推断，不为卡背景派生语义 soft 填充
- 不把模板本地色板例外复制到其他模板或生成自定义图表
- 不为单个 widget 发明额外色板变量
- 不把整个主题预设表复制进 `widget_code`；仅输出 widget 使用的活动运行时 token 值与类
- 降级原语把每个额外色视为额外含义声明；若该含义无法在图例、标签或焦点中命名，则移除该色
