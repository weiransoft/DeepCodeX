# PptxGenJS 创建新演示文稿指南

本指南介绍使用 `pptxgenjs` npm 包（`npm install -g pptxgenjs`）从零创建 .pptx 文件的关键规则与完整示例。

## 安装

```bash
npm install -g pptxgenjs
```

## 关键规则

### 1. 视觉优先

**每张幻灯片必须有视觉元素**（图片/图表/图标/形状）。纯文字幻灯片难以打动观众。

### 2. 颜色 60-30-10 法则

- **主色 60-70% 视觉权重**（背景或主色块）
- **辅助色 30%**（次要元素）
- **强调色 10%**（关键数据或 CTA）

颜色应针对主题定制，禁止使用通用配色（如默认蓝色）。

### 3. 深浅"三明治"结构

- **标题页 + 结论页**：深色背景（营造高级感）
- **内容页**：浅色背景（提升可读性）
- **或全程深色**：营造高端品牌感

### 4. 视觉母题贯穿始终

选择一个独特元素并重复使用：
- 圆形图片框
- 彩色圆圈中的图标
- 单侧厚边框
- 几何形状装饰

## 基础示例

```javascript
const pptxgen = require("pptxgenjs");
const pptx = new pptxgen();

// 设置演示文稿属性
pptx.title = "演示文稿标题";
pptx.author = "AI Assistant";

// 定义颜色（基于主题定制）
const COLORS = {
  primary: "1A365D",     // 深蓝（主色 60%）
  secondary: "2B6CB0",   // 中蓝（辅助色 30%）
  accent: "F6AD55",      // 橙色（强调色 10%）
  light: "F7FAFC",      // 浅灰（内容页背景）
  dark: "1A202C",        // 深色（标题页背景）
  text: "2D3748",        // 正文文本色
  white: "FFFFFF",
};

// ============ Slide 1: 标题页（深色背景） ============
const slide1 = pptx.addSlide();
slide1.background = { color: COLORS.dark };
slide1.addText("演示文稿标题", {
  x: 0.5, y: 2.0, w: 9.0, h: 1.5,
  fontSize: 44, color: COLORS.white, bold: true,
  fontFace: "Microsoft YaHei",
  align: "center",
});
slide1.addText("副标题 Subtitle", {
  x: 0.5, y: 3.5, w: 9.0, h: 0.8,
  fontSize: 18, color: COLORS.accent,
  fontFace: "Microsoft YaHei",
  align: "center",
});

// ============ Slide 2: 内容页（浅色背景） ============
const slide2 = pptx.addSlide();
slide2.background = { color: COLORS.light };
slide2.addText("第一章 Introduction", {
  x: 0.5, y: 0.3, w: 9.0, h: 0.8,
  fontSize: 28, color: COLORS.primary, bold: true,
  fontFace: "Microsoft YaHei",
});

// 左侧文字 + 右侧图标的两列布局
slide2.addText(
  [
    { text: "要点 1: ", options: { bold: true, color: COLORS.secondary } },
    { text: "说明内容...\n", options: { color: COLORS.text } },
    { text: "要点 2: ", options: { bold: true, color: COLORS.secondary } },
    { text: "说明内容...\n", options: { color: COLORS.text } },
    { text: "要点 3: ", options: { bold: true, color: COLORS.secondary } },
    { text: "说明内容...", options: { color: COLORS.text } },
  ],
  {
    x: 0.5, y: 1.5, w: 5.0, h: 3.5,
    fontSize: 18, fontFace: "Microsoft YaHei",
    valign: "top",
  }
);

// 右侧添加彩色圆圈作为视觉元素
slide2.addShape(pptx.ShapeType.ellipse, {
  x: 6.5, y: 1.5, w: 3.0, h: 3.0,
  fill: { color: COLORS.accent },
  line: { color: COLORS.secondary, width: 2 },
});

// ============ Slide 3: 数据展示页 ============
const slide3 = pptx.addSlide();
slide3.background = { color: COLORS.white };

// 大数字 + 小标签
slide3.addText("158", {
  x: 0.5, y: 1.5, w: 4.0, h: 2.0,
  fontSize: 72, color: COLORS.secondary, bold: true,
  align: "center",
});
slide3.addText("季度销售额（百万）", {
  x: 0.5, y: 3.5, w: 4.0, h: 0.5,
  fontSize: 14, color: COLORS.text,
  align: "center",
});

// 图表（柱状图）
const chartData = [
  {
    name: "销售额",
    labels: ["Q1", "Q2", "Q3", "Q4"],
    values: [120, 135, 142, 158],
  },
];
slide3.addChart(pptx.ChartType.bar, chartData, {
  x: 5.0, y: 1.5, w: 5.0, h: 3.5,
  chartColors: [COLORS.secondary],
  showValue: true,
  valueFontSize: 12,
  catAxisLabelColor: COLORS.text,
  valAxisLabelColor: COLORS.text,
});

// ============ Slide 4: 结论页（深色背景） ============
const slide4 = pptx.addSlide();
slide4.background = { color: COLORS.dark };
slide4.addText("谢谢", {
  x: 0.5, y: 2.5, w: 9.0, h: 1.5,
  fontSize: 60, color: COLORS.white, bold: true,
  align: "center",
  fontFace: "Microsoft YaHei",
});

// 保存
pptx.writeFile({ fileName: "output.pptx" });
```

## 字体策略

| 平台 | ASCII 字体 | CJK 字体 |
|------|-----------|---------|
| 跨平台 | Arial | Microsoft YaHei |
| macOS | Helvetica Neue | PingFang SC |
| Windows | Segoe UI | Microsoft YaHei |
| Linux | DejaVu Sans | Noto Sans CJK SC |

```javascript
// 跨平台字体配置（推荐）
const FONT = {
  ascii: "Arial",
  cjk: "Microsoft YaHei",
};

slide.addText("中文标题 Title", {
  fontFace: FONT.cjk,  // 中文字体
  fontSize: 28,
});
```

## 图表类型选择

| 数据类型 | 推荐图表 | PptxGenJS 类型 |
|---------|---------|----------------|
| 时间趋势 | 折线图 | `pptx.ChartType.line` |
| 类别对比 | 柱状图 | `pptx.ChartType.bar` |
| 占比分布 | 饼图 | `pptx.ChartType.pie` |
| 多维对比 | 雷达图 | `pptx.ChartType.radar` |
| 散点关系 | 散点图 | `pptx.ChartType.scatter` |

## 布局速查

```javascript
// 全屏图片 + 文字覆盖
slide.addImage({ path: "background.jpg", x: 0, y: 0, w: 10, h: 5.63 });
slide.addText("标题", { x: 0.5, y: 4.5, w: 9, h: 0.8, color: "FFFFFF" });

// 两列布局（左文右图）
slide.addText("左侧文字", { x: 0.3, y: 0.5, w: 4.5, h: 4.5 });
slide.addImage({ path: "right.jpg", x: 5.2, y: 0.5, w: 4.5, h: 4.5 });

// 网格布局（2x3 图标 + 文字）
const items = [
  { icon: "🚀", title: "速度", desc: "快速交付" },
  { icon: "🎯", title: "精准", desc: "目标明确" },
  { icon: "🔒", title: "安全", desc: "数据加密" },
];
items.forEach((item, i) => {
  const col = i % 3;
  const x = 0.5 + col * 3.2;
  slide.addText(item.icon, { x: x, y: 1.5, w: 1, h: 1, fontSize: 40, align: "center" });
  slide.addText(item.title, { x: x, y: 2.5, w: 3, h: 0.5, bold: true, align: "center" });
  slide.addText(item.desc, { x: x, y: 3, w: 3, h: 0.5, align: "center" });
});
```

## 验证清单

- [ ] 每张幻灯片含至少一个视觉元素
- [ ] 颜色对比度满足 WCAG AA（正常文本 4.5:1，大文本 3:1）
- [ ] 主色占据 60-70% 视觉权重
- [ ] CJK 字体在 macOS/Windows/Linux 均可正常显示
- [ ] 图表数据标签清晰可读
- [ ] 幻灯片切换动画不依赖外部插件
