---
name: pptx
description: "PowerPoint presentation creation, editing, and analysis. Use when working with .pptx files for: (1) creating new presentations via PptxGenJS, (2) editing existing slides via python-pptx, (3) adding new slides via scripts/add_slide.py, (4) generating slide thumbnails via scripts/thumbnail.py, (5) extracting text via markitdown. Trigger when user mentions .pptx, PowerPoint, slides, or presentation tasks."
---

# PPTX 创建、编辑与分析

## 概述

本 Skill 提供两条工作路径：

| 任务 | 路径 | 工具 |
|------|------|------|
| 读取/分析内容 | markitdown 文本提取 | `python3 -m markitdown presentation.pptx` |
| 编辑现有演示文稿 | python-pptx | `scripts/add_slide.py` 添加新幻灯片 |
| 生成幻灯片缩略图 | LibreOffice + 本 Skill 脚本 | `scripts/thumbnail.py` |
| 创建新演示文稿 | PptxGenJS（npm 包） | 详见 [references/pptxgenjs-guide.md](references/pptxgenjs-guide.md) |

## 前置依赖

- **Python 3.10+**（脚本运行环境）
- **python-pptx**：`pip install python-pptx`（编辑现有 .pptx）
- **markitdown**：`pip install markitdown`（文本提取，可选）
- **LibreOffice**（生成缩略图，可选）
- **PptxGenJS**：`npm install -g pptxgenjs`（创建新演示文稿，可选）

## 工作流

### 1. 编辑现有演示文稿

```bash
# 提取文本概览
python3 -m markitdown presentation.pptx

# 添加新幻灯片（标题 + 内容）
python3 scripts/add_slide.py presentation.pptx \
  --title "新章节标题" \
  --content "要点 1\n要点 2\n要点 3"

# 添加空白幻灯片（之后手动在 PowerPoint 中编辑）
python3 scripts/add_slide.py presentation.pptx --layout blank

# 生成全部幻灯片缩略图
python3 scripts/thumbnail.py presentation.pptx -o thumbnails/
```

### 2. 创建新演示文稿

详见 [references/pptxgenjs-guide.md](references/pptxgenjs-guide.md)。关键要点：

- **使用 PptxGenJS（npm 包）从零创建**，避免空白模板的样式干扰
- **每张幻灯片必须有视觉元素**（图片/图表/图标/形状），纯文字幻灯片难以打动人
- **颜色采用 60-30-10 法则**：主色 60% + 辅助色 30% + 强调色 10%
- **深色背景用于标题与结论页，浅色背景用于内容页**（"三明治"结构）
- **选择一个视觉母题并贯穿始终**（如圆形图片框、彩色圆圈中的图标）

### 3. 设计系统生成（基于 CSV 数据）

本 Skill 的 `data/` 目录包含设计系统训练数据：

| 文件 | 内容 |
|------|------|
| `data/colors.csv` | 配色方案库（按行业/情绪分类） |
| `data/typography.csv` | 字体配对方案 |
| `data/layouts.csv` | 幻灯片布局模式 |
| `data/charts.csv` | 图表类型选择指南 |
| `data/icons.csv` | 图标库与使用场景 |

LLM 可基于这些 CSV 数据为特定主题生成定制化设计系统。

## 安全规则

- **python-pptx 编辑前备份原文件**，避免格式丢失（python-pptx 对部分高级样式支持有限）
- **LibreOffice 缩略图生成使用沙箱环境变量**（`-env:UserInstallation=file:///tmp/lo-...`），避免污染用户配置
- **PptxGenJS 生成的文件路径必须为绝对路径**，禁止相对路径（避免目录遍历）
- **字体引用前校验目标平台可用性**，缺失时降级为系统默认字体

## 设计原则（PPTX 专用）

### 颜色法则

- **主色占据 60-70% 视觉权重**，1-2 个辅助色 + 1 个强调色
- **禁止所有颜色等权重分布**（视觉混乱）
- **颜色应针对主题定制**：若将你的配色替换到完全不相关的演示中仍能"工作"，说明选择不够具体
- **深浅对比**：标题与结论页深色背景，内容页浅色背景

### 布局法则

- **每张幻灯片至少一个视觉元素**：图片、图表、图标或形状
- **禁止纯文字幻灯片**：观众会立即忘记
- **视觉母题贯穿始终**：选一个独特元素（圆形图片框 / 彩色圆圈中的图标 / 厚边框）并重复使用

### 数据展示

- **大数字 + 小标签**（60-72pt 数字 + 12-14pt 标签）
- **对比列**（前后对比 / 优劣势对比）
- **时间线或流程图**（编号步骤 + 箭头）

## 验证清单

- [ ] `.pptx` 文件可在 PowerPoint/Keynote/LibreOffice Impress 正常打开
- [ ] 每张幻灯片含至少一个视觉元素
- [ ] 颜色对比度满足 WCAG AA（正常文本 4.5:1，大文本 3:1）
- [ ] 中文字体在 macOS/Windows/Linux 均可正常显示
- [ ] 添加的新幻灯片样式与现有幻灯片一致（字体/配色/边距）

## 详细参考

- 创建新演示文稿完整指南：[references/pptxgenjs-guide.md](references/pptxgenjs-guide.md)
- 设计系统 CSV 数据：`data/*.csv`
