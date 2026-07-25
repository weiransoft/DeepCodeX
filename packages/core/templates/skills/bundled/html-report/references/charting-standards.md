# 图表标准

本文件定义 ECharts 数据图表的配置标准与配色规则。所有量化数据图表必须使用 ECharts，禁止使用 matplotlib、seaborn、plotly 等其他库生成图片。

## 1. CDN 引用

ECharts 通过 CDN 引用，不本地包含大型 JS 库。在 `</body>` 前引入：

```html
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<script src="./assets/charts.js"></script>
```

**顺序要求**：ECharts CDN 必须在 `charts.js` 之前，确保后者可访问 `echarts` 全局对象。

## 2. charts.js 文件结构

所有图表初始化逻辑写入 `assets/charts.js` 外部文件，禁止在 HTML 内写内联 `<script>` 代码块（CSP 兼容）。文件结构：

```javascript
// assets/charts.js
(function() {
  // --- 读取主题 CSS 变量（仅读取一次，全文件复用） ---
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();

  // --- 图表 1：[名称] ---
  var chart1 = echarts.init(
    document.getElementById('chart-[name]'),
    null,
    { renderer: 'svg' }
  );
  chart1.setOption({
    // 配置项
  });
  window.addEventListener('resize', function() { chart1.resize(); });

  // --- 图表 2：[名称] ---
  // ...
})();
```

**关键规则**：
- 用 IIFE 包裹，避免污染全局作用域
- CSS 变量在文件顶部读取一次，所有图表复用
- 每个图表实例独立绑定 `resize` 监听器
- 使用 `renderer: 'svg'` 而非默认 canvas，便于打印与缩放

## 3. 通用配置

所有 ECharts 图表必须包含以下配置：

```javascript
{
  animation: false,           // 报告为静态文档，禁用动画
  tooltip: {
    trigger: 'item',          // 或 'axis'（折线/柱状）
    appendToBody: true        // 防止被容器 overflow 裁切
  },
  // 其他配置
}
```

## 4. 配色规则

**核心原则**：所有图表颜色从 CSS 变量派生，禁止硬编码 hex，禁止使用 ECharts 默认调色板。

### 单系列图表（折线、柱状、面积）

用 `--accent` 作为主色：

```javascript
{
  color: [accent],
  series: [{
    type: 'line',  // 或 'bar'
    itemStyle: { color: accent },
    lineStyle: { color: accent, width: 2 },
    areaStyle: { color: accent + '33' }  // 透明度叠加
  }]
}
```

### 多系列图表

用 `--accent` 与 `--accent2` 及其透明度变体构建调色板：

```javascript
{
  color: [accent, accent2, muted, accent + '99', accent2 + '99']
}
```

### 热力图（连续色映射）

```javascript
{
  visualMap: {
    inRange: { color: [bg2, accent2, accent] }  // 从浅到深
  }
}
```

### 发散图表（正负值对比）

```javascript
{
  itemStyle: {
    color: function(params) {
      return params.value >= 0 ? accent : accent2;
    }
  }
}
```

### 文字与轴线

- 轴标签、图例文字：主文字用 `ink`，次文字用 `muted`
- 网格线、轴线：用 `rule`

```javascript
{
  xAxis: {
    axisLine: { lineStyle: { color: rule } },
    axisLabel: { color: muted },
    splitLine: { lineStyle: { color: rule } }
  },
  yAxis: {
    axisLine: { lineStyle: { color: rule } },
    axisLabel: { color: muted },
    splitLine: { lineStyle: { color: rule } }
  }
}
```

## 5. 热力图专项规则

### 容器高度

当 y 轴类目 ≥ 6 时，使用 `.chart-container.tall`（`min-height: 560px`），或按公式计算：
`高度 = 类目数 × 50px + 120px`（120px 为坐标轴与 visualMap 预留）。

```html
<div id="chart-heatmap" class="chart-container tall"></div>
```

```javascript
{
  grid: { top: 30 }  // 防止顶部行被裁切
}
```

### 数据完整性

- x/y 轴类目仅声明存在数据点的项，禁止声明无数据的空类目
- 始终设置 `splitArea: { show: false }`

### 缺失数据回退

合法无数据的网格单元，显式填充 `'-'`，渲染为透明背景 + `N/A` 标签：

```javascript
// 补全缺失单元
var fullData = data.slice();
yData.forEach(function(_, yi) {
  xData.forEach(function(_, xi) {
    if (!data.some(function(d) { return d[0] === xi && d[1] === yi; })) {
      fullData.push([xi, yi, '-']);
    }
  });
});

// 系列配置
series: [{
  type: 'heatmap',
  data: fullData,
  label: {
    show: true,
    formatter: function(p) {
      return p.value[2] === '-' ? 'N/A' : Number(p.value[2]).toFixed(2);
    },
    color: ink
  }
}],
visualMap: {
  // ... 其他配置
  outOfRange: { color: 'transparent' }  // 缺失单元透明
}
```

## 6. HTML 结构

每个图表必须包含 `<figure>` + `<figcaption>` + 容器 `<div>`：

```html
<figure class="chart-figure">
  <figcaption>图 1：月度增长趋势</figcaption>
  <div id="chart-growth" class="chart-container"></div>
</figure>
```

- 容器 `id` 唯一，格式 `chart-[name]`，与 `charts.js` 中 `getElementById` 对应
- 容器必须有 `class="chart-container"`（提供 `width: 100%; min-height: 400px`）
- `<figcaption>` 必填，描述图表展示的内容

## 7. 禁止事项

- ❌ 使用 matplotlib、seaborn、plotly 等其他库生成图表图片
- ❌ 在 HTML 内写内联 `<script>...</script>` 图表逻辑
- ❌ 硬编码 hex 颜色（如 `#2563eb`），必须用 CSS 变量
- ❌ 使用 ECharts 默认调色板（自动分配的蓝绿橙）
- ❌ 使用 viridis、plasma 等 matplotlib 风格色图
- ❌ 省略 `animation: false`（报告为静态文档）
- ❌ 省略 `resize` 监听器（窗口缩放会破坏图表）
- ❌ 省略 `<figcaption>` 标题
- ❌ 使用 `renderer: 'canvas'`（不利于打印，改用 `'svg'`）

## 8. 图表类型选择

| 数据场景 | 推荐图表 | ECharts type |
|---|---|---|
| 时间序列趋势 | 折线图 | `line` |
| 类目对比 | 柱状图 | `bar` |
| 占比构成 | 饼图/环图 | `pie` |
| 多维对比 | 雷达图 | `radar` |
| 二维密度 | 热力图 | `heatmap` |
| 相关性 | 散点图 | `scatter` |
| 流向关系 | 桑基图 | `sankey` |
| 累计构成 | 堆叠柱状 | `bar` + `stack` |
