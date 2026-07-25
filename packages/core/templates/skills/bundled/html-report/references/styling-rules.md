# 样式规则

本文件定义 HTML 报告的详细样式规则。所有样式通过 CSS 变量驱动，禁止字面色，确保主题一致性与可维护性。

## 1. CSS 变量系统

所有颜色、字体、布局参数在 `:root` 中定义为 CSS 变量，样式规则仅引用 `var(--*)`。

### 必须定义的变量

| 类别 | 变量名 | 用途 | 默认值（浅色） |
|---|---|---|---|
| 背景 | `--bg` | 页面主背景 | `#ffffff` |
| 背景 | `--bg2` | 次级背景（卡片、表头、斑马纹） | `#f7f7f8` |
| 文字 | `--ink` | 主文字 | `#1a1a1a` |
| 文字 | `--muted` | 次要文字（图注、元信息） | `#6b7280` |
| 边框 | `--rule` | 分隔线、表格边框 | `#e5e7eb` |
| 主题色 | `--accent` | 主强调色（链接、主图表色） | `#2563eb` |
| 主题色 | `--accent2` | 辅助强调色（引用边框、第二系列） | `#7c3aed` |
| 字体 | `--font` | 正文字体栈 | 系统无衬线栈 |
| 字体 | `--font-mono` | 等宽字体（代码） | 系统等宽栈 |
| 布局 | `--max` | 内容最大宽度 | `860px` |
| 布局 | `--radius` | 圆角 | `6px` |

### 调色板选择建议

按报告类型选择调色板：

| 报告类型 | `--accent` | `--accent2` | 风格 |
|---|---|---|---|
| 技术研究 | `#2563eb`（蓝） | `#7c3aed`（紫） | 冷静、专业 |
| 商业分析 | `#0ea5e9`（青） | `#f59e0b`（橙） | 现代、活力 |
| 学术论文 | `#1f2937`（深灰） | `#6b7280`（灰） | 克制、严肃 |
| 数据看板 | `#10b981`（绿） | `#3b82f6`（蓝） | 清新、数据导向 |
| 金融报告 | `#b91c1c`（红） | `#0f766e`（青绿） | 正式、对比强 |

### 对比度要求

- 正文 `--ink` on `--bg`：≥ 7:1（WCAG AAA）
- 次要文字 `--muted` on `--bg`：≥ 4.5:1（WCAG AA）
- 主题色文字 `--accent` on `--bg`：≥ 4.5:1
- 大标题（≥ 18px 加粗）：≥ 3:1

## 2. 字体系统

### 字体栈

使用系统字体栈，零网络依赖，渲染速度最快：

```css
--font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', sans-serif;
--font-mono: 'SF Mono', Menlo, Consolas, monospace;
```

如需特定字体氛围，可通过 `@font-face` 引入本地字体或 Web 字体，但需权衡加载性能。

### 字号层级

| 元素 | 字号 | 行高 | 字重 |
|---|---|---|---|
| `h1`（报告标题） | 2.25rem (36px) | 1.2 | 700 |
| `h2`（章节） | 1.6rem (26px) | 1.3 | 600 |
| `h3`（小节） | 1.25rem (20px) | 1.4 | 600 |
| `h4`（子节） | 1.05rem (17px) | 1.5 | 600 |
| 正文 `p` | 1rem (16px) | 1.7 | 400 |
| 图注 `figcaption` | 0.85rem (14px) | 1.5 | 400 |
| 来源 `footer .sources` | 0.85rem (14px) | 1.6 | 400 |

**最低字号**：正文不得低于 14px，图注与来源不得低于 12px。

## 3. 间距系统

采用 `rem` 单位，基于 16px 根字号：

| 场景 | 间距 |
|---|---|
| 页面内边距（桌面） | `2rem 1rem` |
| 页面内边距（移动） | `1rem 0.75rem` |
| 页眉下边距 | `3rem` |
| 章节间距（`section` 之间） | `2.5rem` |
| 段落间距 | `1rem` |
| `h2` 与下方内容 | `1rem` |
| `h3` 与上方内容 | `1.5rem` |
| 图表上下边距 | `2rem` |
| 来源区上边距 | `3rem` |

## 4. 组件样式

### 标题

- `h2`（章节）：底部 1px `--rule` 分隔线，`padding-bottom: 0.3rem`
- `h3`（小节）：无装饰，纯文字
- `h4`（子节）：无装饰，纯文字

### 引用块

```css
blockquote {
  margin: 1.5rem 0; padding: 0.75rem 1.25rem;
  border-left: 4px solid var(--accent2);
  background: var(--bg2); color: var(--muted);
  font-style: italic;
}
```

### 数据卡片

用于突出展示关键指标：

```css
.stat-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem; margin: 1.5rem 0;
}
.stat-card { padding: 1.25rem; background: var(--bg2); border-radius: var(--radius); }
.stat-card .stat-value { font-size: 1.8rem; font-weight: 700; color: var(--accent); }
.stat-card .stat-label { font-size: 0.85rem; color: var(--muted); margin-top: 0.25rem; }
```

### 表格

表格必须包裹在 `.table-wrap` 中，实现横向与纵向滚动：

```css
.table-wrap {
  overflow-x: auto; overflow-y: auto; max-height: 600px;
  margin: 1.5rem 0; border: 1px solid var(--rule);
  border-radius: var(--radius);
}
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
thead { position: sticky; top: 0; background: var(--bg2); }
th, td { padding: 0.6rem 0.9rem; text-align: left; border-bottom: 1px solid var(--rule); }
tbody tr:nth-child(even) { background: var(--bg2); }
```

**表格布局规则**：
- 4 列以上的表格必须使用单列全宽布局，禁止放入多栏网格
- 表格永远包裹在 `.table-wrap` 中，禁止裸 `<table>`
- `max-height: 600px` 防止超长表格撑开页面

### 图表容器

```css
.chart-figure { margin: 2rem 0; text-align: center; }
.chart-figure figcaption {
  font-size: 0.9rem; font-weight: 600; color: var(--ink); margin-bottom: 0.75rem;
}
.chart-container { width: 100%; min-height: 400px; }
.chart-container.tall { min-height: 560px; }  /* heatmap ≥ 6 类目时使用 */
```

### 图片网格

```css
.figure-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1.5rem; margin: 2rem 0; }
.figure-grid .diagram { margin: 0; }
```

## 5. 重点强调

整份报告统一选择**一种**重点强调方式，禁止混用：

- **方式 A — 加粗**（适合正式/学术报告）：用 `<strong>` 标签
- **方式 B — 主题色高亮**（适合现代/视觉报告）：
  ```css
  mark.key { background: none; color: var(--accent); font-weight: 600; }
  ```
  用 `<mark class="key">` 标签

## 6. 引用与来源

```css
sup a { color: var(--accent); text-decoration: none; font-size: 0.75em; font-weight: 600; }
footer .sources { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); }
footer .sources ol { padding-left: 1.2rem; font-size: 0.85rem; color: var(--muted); }
footer .sources li { margin-bottom: 0.5rem; overflow-wrap: break-word; word-break: break-all; }
footer .sources .src-title { color: var(--ink); word-break: normal; }
footer .sources .src-url { display: block; margin-top: 0.15rem; font-size: 0.82rem; color: var(--accent); }
```

## 7. 响应式

```css
@media (max-width: 600px) {
  .figure-grid { grid-template-columns: 1fr; }  /* 网格折叠为单列 */
  body { padding: 1rem 0.75rem; }                /* 减小内边距 */
}
```

- 所有多栏网格在 ≤ 600px 时折叠为单列
- 表格通过 `.table-wrap` 横向滚动，不折叠
- 来源链接 `word-break: break-all` 防止长 URL 溢出

## 8. 打印样式

```css
@media print {
  body { padding: 0; }
  section { page-break-inside: avoid; }          /* 章节不被分页截断 */
  h2 { page-break-after: avoid; }                 /* 标题不与内容分离 */
  .chart-figure, .diagram { page-break-inside: avoid; }
}
```

## 9. 设计原则

1. **token 驱动**：所有颜色通过 `var(--*)` 引用，禁止字面色（`color: #111` ✗，`color: var(--ink)` ✓）
2. **三级文字层级**：`--ink`（主文字）、`--muted`（次文字）、`--accent`（强调），保持对比度
3. **层级靠字号与字重**：不靠不同字体家族建立层级，用 `font-size` + `font-weight` + `whitespace`
4. **留白优于装饰**：用间距分隔内容，少用边框与背景色
5. **可读性优先**：正文 ≥ 14px、行高 1.7、对比度 ≥ 4.5:1
