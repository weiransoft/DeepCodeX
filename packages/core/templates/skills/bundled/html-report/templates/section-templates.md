# 章节模板说明

本文件提供 HTML 报告中各类章节的 HTML 片段模板。从 `report-template.html` 起步后，按需复制对应片段替换示例数据。所有片段已包含在 `report-template.html` 的样式定义中，无需额外 CSS。

## 1. 页眉（报告标题）

```html
<header class="page-header">
  <h1>报告标题</h1>
  <p class="subtitle">副标题或一句话简介</p>
  <p class="meta">作者 · 日期 · 版本</p>
</header>
```

- `<h1>`：报告主标题，全页唯一
- `.subtitle`：副标题，`--muted` 色
- `.meta`：作者、日期、版本等元信息，`--muted` 色

## 2. 正文章节

```html
<section>
  <h2>章节标题</h2>
  <p>正文段落。重点内容用 <strong>加粗</strong> 标记。</p>

  <h3>子节标题</h3>
  <p>子节内容。</p>

  <h4>子小节标题</h4>
  <p>更细的内容。</p>
</section>
```

- `h2`：章节标题，自带底部分隔线
- `h3`：小节标题
- `h4`：子小节标题
- 重点强调统一用 `<strong>`（方式 A）或 `<mark class="key">`（方式 B），整份报告二选一

## 3. 引用块

```html
<blockquote>
  这是一段引用文字，用于强调重要观点或摘录原文。
</blockquote>
```

- 左侧 4px `--accent2` 边框
- `--bg2` 背景，`--muted` 文字，斜体

## 4. 数据卡片

```html
<section>
  <h2>关键指标</h2>
  <div class="stat-grid">
    <div class="stat-card">
      <div class="stat-value">1,234</div>
      <div class="stat-label">总用户数</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">98%</div>
      <div class="stat-label">满意度</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">3.2x</div>
      <div class="stat-label">增长率</div>
    </div>
  </div>
</section>
```

- `.stat-grid`：自适应网格，`minmax(180px, 1fr)`
- `.stat-value`：大号 `--accent` 色数字
- `.stat-label`：小号 `--muted` 色标签

## 5. 表格

```html
<section>
  <h2>对比表格</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>项目</th>
          <th>方案 A</th>
          <th>方案 B</th>
          <th>方案 C</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>成本</td>
          <td>低</td>
          <td>中</td>
          <td>高</td>
        </tr>
        <tr>
          <td>性能</td>
          <td>高</td>
          <td>高</td>
          <td>中</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>
```

- 必须包裹在 `.table-wrap` 中
- 4 列以上表格用单列全宽布局，禁止放入多栏网格
- `thead` 粘性定位，`tbody` 斑马纹

## 6. ECharts 数据图表

### HTML 部分

```html
<section>
  <h2>数据可视化</h2>
  <figure class="chart-figure">
    <figcaption>图 1：月度增长趋势</figcaption>
    <div id="chart-growth" class="chart-container"></div>
  </figure>
</section>
```

### charts.js 部分

```javascript
// assets/charts.js
(function() {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();

  var chart = echarts.init(
    document.getElementById('chart-growth'),
    null,
    { renderer: 'svg' }
  );
  chart.setOption({
    animation: false,
    tooltip: { trigger: 'axis', appendToBody: true },
    xAxis: {
      type: 'category',
      data: ['1月', '2月', '3月', '4月', '5月', '6月'],
      axisLine: { lineStyle: { color: rule } },
      axisLabel: { color: muted }
    },
    yAxis: {
      type: 'value',
      axisLine: { lineStyle: { color: rule } },
      axisLabel: { color: muted },
      splitLine: { lineStyle: { color: rule } }
    },
    series: [{
      type: 'line',
      data: [120, 200, 150, 80, 70, 110],
      itemStyle: { color: accent },
      lineStyle: { color: accent, width: 2 }
    }]
  });
  window.addEventListener('resize', function() { chart.resize(); });
})();
```

## 7. Mermaid 结构图表

```html
<section>
  <h2>系统架构</h2>
  <figure class="diagram">
    <pre class="mermaid">
      flowchart LR
        A[客户端] --> B[网关]
        B --> C[服务 A]
        B --> D[服务 B]
        C --> E[(数据库)]
        D --> E
    </pre>
    <figcaption>图 2：系统架构图</figcaption>
  </figure>
</section>
```

- `<pre class="mermaid">` 内为 Mermaid 语法
- 必须有 `<figcaption>` 标题
- 需引入 Mermaid CDN 并在 `charts.js` 中初始化

## 8. 图片

### 单张图片

```html
<section>
  <h2>界面展示</h2>
  <figure class="diagram">
    <img src="assets/dashboard_1024x576.png" alt="仪表盘界面">
    <figcaption>图 3：仪表盘界面</figcaption>
  </figure>
</section>
```

### 图片网格

```html
<div class="figure-grid">
  <figure class="diagram">
    <img src="assets/scenario_a_1024x768.png" alt="场景 A">
    <figcaption>场景 A</figcaption>
  </figure>
  <figure class="diagram">
    <img src="assets/scenario_b_1024x768.png" alt="场景 B">
    <figcaption>场景 B</figcaption>
  </figure>
</div>
```

- 图片放入 `assets/`，命名 `assets/{name}_{w}x{h}.png`
- 移动端自动折叠为单列

## 9. 引用与来源

### 正文内引用

```html
<p>该结论基于多项研究<sup><a href="#cite-1">[1]</a></sup>，并与行业趋势一致<sup><a href="#cite-2">[2]</a></sup>。</p>
```

### 文末来源列表

```html
<footer>
  <div class="sources">
    <h2>来源</h2>
    <ol>
      <li id="cite-1">
        <span class="src-title">作者/机构, 文档标题. 简要说明.</span>
        <a class="src-url" href="https://example.com/source" target="_blank" rel="noopener">https://example.com/source</a>
      </li>
      <li id="cite-2">
        <span class="src-title">作者/机构, 另一份文档标题. 简要说明.</span>
        <a class="src-url" href="https://example.com/other" target="_blank" rel="noopener">https://example.com/other</a>
      </li>
    </ol>
  </div>
</footer>
```

- 引用编号从 1 开始顺序递增
- 每个 `<li>` 的 `id="cite-N"` 与正文 `<a href="#cite-N">` 一一对应
- 来源 URL 必须是可点击的 `<a href>`，加 `target="_blank" rel="noopener"`
- 用户上传文档无 URL 时用 `<span class="src-url">用户上传文档</span>`

## 10. 完整页面骨架

```html
<!-- Generated by DeepCodeX -->
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>报告标题</title>
<style>
  /* 主题 CSS 变量（见 references/styling-rules.md） */
  :root { /* ... */ }
  /* 基础样式（见 report-template.html） */
</style>
</head>
<body>
  <article class="page">
    <!-- 1. 页眉 -->
    <header class="page-header">...</header>

    <main>
      <!-- 2. 正文章节 -->
      <section>...</section>
      <!-- 3. 数据卡片 -->
      <section>...</section>
      <!-- 4. ECharts 图表 -->
      <section>...</section>
      <!-- 5. Mermaid 图表 -->
      <section>...</section>
      <!-- 6. 表格 -->
      <section>...</section>
    </main>

    <!-- 7. 来源列表 -->
    <footer>...</footer>
  </article>

  <!-- CDN 引用（按需） -->
  <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <!-- 图表逻辑（外部文件） -->
  <script src="./assets/charts.js"></script>
</body>
</html>
```
