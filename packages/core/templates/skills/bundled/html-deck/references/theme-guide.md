# 主题选择指南

本目录下的主题均为 CSS 变量覆盖文件，通过覆盖 `base.css` 中 `:root` 定义的 token 实现视觉风格切换。每个主题文件短小精悍，仅修改变量值，不涉及选择器与布局逻辑。

## 可用主题

| 主题名 | 文件 | 风格 | 适用场景 |
|---|---|---|---|
| `light` | `light.css` | 极简白，克制高级 | 内部汇报、技术评审、严肃话题、不抢内容的设计 |
| `dark` | `dark.css` | 深色夜空，技术氛围 | 技术分享、长时间观看、基础设施、开发者受众 |

## 主题选择决策表

按受众与场景选择：

| 受众 / 场景 | 推荐主题 | 理由 |
|---|---|---|
| 内部汇报、一对一技术评审 | `light` | 白底低干扰，突出内容 |
| 对外技术分享、开发者大会 | `dark` | 深色护眼，代码可读性高 |
| 长时间工作坊、教学 | `light` | 低眩光，长时间观看不疲劳 |
| 严肃商务、金融数据 | `light` | 正式、克制 |
| 品牌发布、产品揭幕 | `dark` | 氛围感强，适合大屏投影 |
| 含大量代码的分享 | `dark` | 深色背景代码高亮更清晰 |
| 含大量图表/数据的分享 | `light` | 白底图表色彩还原准确 |

**通用原则**：不确定时选 `light`。深色主题需配合投影环境判断（暗场用 dark，亮场用 light）。

## 主题切换机制

### 静态指定（默认主题）

在 `<head>` 中通过 `<link id="theme-link">` 指定：

```html
<link id="theme-link" rel="stylesheet" href="./_shared/themes/light.css">
```

### 动态切换（T 键循环）

在 `<body>` 或 `<html>` 上声明 `data-themes` 属性（逗号分隔的主题名），运行时按 `T` 键循环：

```html
<body data-themes="light,dark" data-theme-base="./_shared/themes/">
```

- `data-themes` — 可切换的主题列表
- `data-theme-base` — 主题文件所在目录（用于动态拼接 href）

runtime.js 会循环切换 `<link id="theme-link">` 的 `href` 为 `{data-theme-base}{name}.css`，同时更新 `<html>` 的 `data-theme` 属性。

### 深链接指定主题

在 `<html>` 上设置 `data-theme` 属性可标记当前主题（仅展示用，实际加载由 `<link>` 决定）：

```html
<html lang="zh-CN" data-theme="dark">
```

## 主题文件结构

每个主题文件仅包含一个 `:root { ... }` 块，覆盖以下变量：

### 必须定义的变量

| 变量类别 | 变量名 | 说明 |
|---|---|---|
| 背景 | `--bg`, `--bg-soft`, `--surface`, `--surface-2` | 页面与卡片背景 |
| 边框 | `--border`, `--border-strong` | 分隔线与强调边框 |
| 文字 | `--text-1`, `--text-2`, `--text-3` | 三级文字层级 |
| 主题色 | `--accent`, `--accent-2`, `--accent-3` | 主色与辅助色 |
| 语义色 | `--good`, `--warn`, `--bad` | 成功/警告/错误 |
| 渐变 | `--grad`, `--grad-soft` | 标题渐变与柔和渐变 |
| 圆角 | `--radius`, `--radius-sm`, `--radius-lg` | 组件圆角 |
| 阴影 | `--shadow`, `--shadow-lg` | 卡片阴影 |
| 字体 | `--font-sans`, `--font-display` | 正文字体与标题字体 |

### 可选变量

| 变量名 | 说明 |
|---|---|
| `--font-serif` | 衬线字体（杂志风主题用） |
| `--font-mono` | 等宽字体（代码块用） |
| `--letter-tight` | 标题字距收紧 |
| `--letter-normal` | 正文字距 |
| `--ease` | 缓动函数 |
| `--bg-texture` | 背景纹理（径向渐变等，叠加于 `--bg` 之上） |

## 定制新主题

1. 复制 `light.css` 或 `dark.css` 为 `<name>.css`
2. 修改变量值，保持变量名不变
3. 在 `data-themes` 中加入新主题名
4. 测试：按 `T` 键循环切换，确认所有页面元素配色正确

### 定制示例

创建一个暖色调主题 `warm.css`：

```css
:root {
  --bg: #fdf8f3;
  --bg-soft: #f5ebe0;
  --surface: #fffaf5;
  --surface-2: #f0e0d0;
  --border: rgba(120, 80, 40, .1);
  --border-strong: rgba(120, 80, 40, .2);
  --text-1: #3d2817;
  --text-2: #7a5c3e;
  --text-3: #b09a82;
  --accent: #c8581c;
  --accent-2: #e89048;
  --accent-3: #f5b870;
  --good: #4a8c2a;
  --warn: #d4881c;
  --bad: #b8302a;
  --grad: linear-gradient(135deg, #c8581c, #e89048 55%, #f5b870);
  --grad-soft: linear-gradient(135deg, #f5ebe0, #fffaf5);
  --radius: 16px;
  --radius-sm: 10px;
  --radius-lg: 24px;
  --shadow: 0 8px 24px rgba(120, 80, 40, .08);
  --shadow-lg: 0 20px 50px rgba(120, 80, 40, .12);
  --font-sans: 'Inter', 'Noto Sans SC', sans-serif;
  --font-display: 'Inter', 'Noto Sans SC', sans-serif;
  --letter-tight: -.035em;
  --bg-texture:
    radial-gradient(ellipse at 50% 0%, rgba(200, 88, 28, .05), transparent 60%);
}
```

## 背景纹理（--bg-texture）

`--bg-texture` 变量允许在纯色 `--bg` 之上叠加纹理（径向渐变、SVG 噪点等），增加视觉深度。

### 单页覆盖

在单个 `.slide` 上通过 inline style 覆盖：

```html
<!-- 禁用该页纹理 -->
<section class="slide" style="--bg-texture: none;">

<!-- 自定义该页渐变 -->
<section class="slide" style="--bg-texture: radial-gradient(circle at 50% 50%, rgba(255,100,50,.1), transparent 60%);">
```

### 配合图片背景

对于全屏图片背景页，使用 inline style 直接设置 `background`：

```html
<section class="slide" style="background: linear-gradient(rgba(0,0,0,.55), rgba(0,0,0,.55)), url('assets/hero_1024x576.png') center/cover;">
```

## 设计原则

1. **token 驱动**：所有颜色通过变量引用，禁止字面色（`color: #111` ✗，`color: var(--text-1)` ✓）
2. **三级文字层级**：`--text-1`（主文字）、`--text-2`（次文字）、`--text-3`（弱化文字），保持对比度
3. **语义色一致性**：`--good/--warn/--bad` 在所有主题中语义不变
4. **背景纹理克制**：纹理应增强氛围而非抢夺注意力，透明度建议 ≤ 10%
5. **字体可读性**：深色主题文字对比度需 ≥ 4.5:1（WCAG AA），浅色主题 ≥ 7:1 更佳
