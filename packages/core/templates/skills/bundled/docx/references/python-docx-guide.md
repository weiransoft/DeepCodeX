# python-docx 创建新文档指南

本指南介绍使用 `python-docx` 库（`pip install python-docx`）从零创建 .docx 文件的关键规则与最佳实践。

## 安装

```bash
pip install python-docx
```

## 关键规则（CRITICAL Rules）

### 1. 页面尺寸必须显式设置

python-docx 默认 A4，US Letter 文档必须显式设置：

```python
from docx import Document
from docx.shared import Inches

doc = Document()

# 设置 US Letter 页面尺寸（8.5 × 11 英寸）
section = doc.sections[0]
section.page_width = Inches(8.5)
section.page_height = Inches(11)
section.top_margin = Inches(1)
section.bottom_margin = Inches(1)
section.left_margin = Inches(1)
section.right_margin = Inches(1)
```

| 纸张 | 宽度 | 高度 | 内容宽度（1 英寸边距） |
|------|------|------|----------------------|
| US Letter | 8.5 英寸 | 11 英寸 | 6.5 英寸 |
| A4（默认） | 21 厘米 | 29.7 厘米 | 19.1 厘米 |

### 2. CJK 字体必须配置三槽（ascii + hAnsi + eastAsia）

含中文/日文/韩文的文档必须同时配置 `ascii` + `hAnsi` + `eastAsia`，否则中文显示为方框：

```python
from docx import Document
from docx.shared import Pt
from docx.oxml.ns import qn

doc = Document()

# 设置 Normal 样式的默认字体
style = doc.styles['Normal']
style.font.name = 'Arial'  # ASCII / Latin 字体
style.font.size = Pt(12)
# CRITICAL: 必须显式设置 eastAsia 槽，否则 CJK 字符显示为方框
style.element.rPr.rFonts.set(qn('w:eastAsia'), 'Microsoft YaHei')

# 为标题样式配置 CJK 字体
heading_style = doc.styles['Heading 1']
heading_style.font.name = 'Arial'
heading_style.font.size = Pt(16)
heading_style.font.bold = True
heading_style.element.rPr.rFonts.set(qn('w:eastAsia'), 'Microsoft YaHei')
```

跨平台字体推荐：

| 平台 | ASCII/Latin | East Asian (CJK) |
|------|-------------|------------------|
| 跨平台 | Arial | Microsoft YaHei |
| macOS | Arial | PingFang SC |
| Windows | Arial | SimSun / SimHei |
| Linux | DejaVu Sans | Noto Sans CJK SC |

### 3. 字符转义使用 Python 原生字符串

⚠️ python-docx 中使用 Python 原生字符串，**禁止**手动插入 XML 实体（如 `&#x201C;`），库会自动处理 XML 转义。

| 需要写入 | ✅ 正确（Python） | ❌ 错误（XML 实体） |
|---------|---------------------|---------------------|
| 双引号 `"` | `"'"` 或 `'\"'` | `&#x201C;` `&#x201D;` `&#34;` |
| 单引号 `'` | `"'"` | `&#x2018;` `&#x2019;` `&#39;` |
| `&` | `"&"` | `&amp;` |
| `<` | `"<"` | `&lt;` |

### 4. 列表使用内置样式（禁止手动 Unicode 项目符号）

```python
# ❌ 错误：手动插入 Unicode 项目符号
doc.add_paragraph("• Item")

# ✅ 正确：使用 'List Bullet' 样式
doc.add_paragraph("Bullet item", style='List Bullet')

# ✅ 正确：使用 'List Number' 样式
doc.add_paragraph("Numbered item", style='List Number')
```

### 5. 表格使用 add_table + style

```python
from docx.shared import Inches

# 创建 2×2 表格，使用 'Table Grid' 样式（含边框）
table = doc.add_table(rows=2, cols=2, style='Table Grid')

# 设置列宽（必须为每个单元格设置宽度）
for row in table.rows:
    for idx, cell in enumerate(row.cells):
        cell.width = Inches(3.25)  # 每列 3.25 英寸

# 设置表头
header_cells = table.rows[0].cells
header_cells[0].text = '列 1'
header_cells[1].text = '列 2'

# 设置内容
content_cells = table.rows[1].cells
content_cells[0].text = '单元格 1'
content_cells[1].text = '单元格 2'
```

**宽度规则**：
- 单元格 `width` 必须显式设置（不设置则 Word 自动分配）
- 列宽之和应等于页面内容宽度（US Letter 1 英寸边距下 = 6.5 英寸）
- 防止行跨页：`table.rows[0].cells[0].paragraphs[0].paragraph_format.keep_together = True`

### 6. PageBreak 使用 add_page_break

```python
# ✅ 正确：使用 add_page_break 方法
doc.add_page_break()

# ✅ 正确：在段落后添加分页符
from docx.enum.text import WD_BREAK
paragraph = doc.add_paragraph()
run = paragraph.add_run()
run.add_break(WD_BREAK.PAGE)
```

### 7. 图片使用 add_picture

```python
# CRITICAL: 必须指定 width 或 height，否则使用图片原始尺寸（可能过大）
doc.add_picture('image.png', width=Inches(4))

# 添加图片到段落（更精细控制）
paragraph = doc.add_paragraph()
run = paragraph.add_run()
run.add_picture('image.png', width=Inches(4))
```

### 8. 目录（TOC）使用 Heading 样式

```python
# CRITICAL: TOC 要求标题使用内置 'Heading 1' / 'Heading 2' 样式
doc.add_heading('一级标题', level=1)  # 自动使用 Heading 1 样式
doc.add_heading('二级标题', level=2)  # 自动使用 Heading 2 样式

# 插入 TOC 字段（Word 打开后右键更新）
paragraph = doc.add_paragraph()
run = paragraph.add_run()
# 插入 TOC 域代码
fldChar_begin = run._element.makeelement(qn('w:fldChar'), {qn('w:fldCharType'): 'begin'})
run._element.append(fldChar_begin)
instrText = run._element.makeelement(qn('w:instrText'), {})
instrText.text = 'TOC \\o "1-3" \\h \\z \\u'
run._element.append(instrText)
fldChar_separate = run._element.makeelement(qn('w:fldChar'), {qn('w:fldCharType'): 'separate'})
run._element.append(fldChar_separate)
fldChar_end = run._element.makeelement(qn('w:fldChar'), {qn('w:fldCharType'): 'end'})
run._element.append(fldChar_end)
```

### 9. 页眉页脚

```python
section = doc.sections[0]

# 页眉
header = section.header
header_para = header.paragraphs[0]
header_para.text = "页眉文本"

# 页脚（含页码）
footer = section.footer
footer_para = footer.paragraphs[0]
footer_para.text = "第 "
# 插入页码字段
run = footer_para.add_run()
fldChar_begin = run._element.makeelement(qn('w:fldChar'), {qn('w:fldCharType'): 'begin'})
run._element.append(fldChar_begin)
instrText = run._element.makeelement(qn('w:instrText'), {})
instrText.text = 'PAGE'
run._element.append(instrText)
fldChar_end = run._element.makeelement(qn('w:fldChar'), {qn('w:fldCharType'): 'end'})
run._element.append(fldChar_end)
```

## 完整示例

```python
#!/usr/bin/env python3
"""使用 python-docx 创建完整 .docx 文档示例"""

from docx import Document
from docx.shared import Inches, Pt
from docx.oxml.ns import qn


def create_sample_doc(output_path: str) -> None:
    """
    创建示例文档

    参数：
        output_path: 输出 .docx 文件路径
    """
    doc = Document()

    # 设置页面尺寸（US Letter）
    section = doc.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = Inches(1)
    section.bottom_margin = Inches(1)
    section.left_margin = Inches(1)
    section.right_margin = Inches(1)

    # 设置默认字体（含 CJK 字体三槽配置）
    style = doc.styles['Normal']
    style.font.name = 'Arial'
    style.font.size = Pt(12)
    style.element.rPr.rFonts.set(qn('w:eastAsia'), 'Microsoft YaHei')

    # 添加标题
    doc.add_heading('文档标题 Title', level=1)

    # 添加正文
    doc.add_paragraph('正文内容 Body text')

    # 添加列表
    doc.add_paragraph('列表项 1', style='List Bullet')
    doc.add_paragraph('列表项 2', style='List Bullet')

    # 添加表格
    table = doc.add_table(rows=2, cols=2, style='Table Grid')
    table.rows[0].cells[0].text = '列 1'
    table.rows[0].cells[1].text = '列 2'
    table.rows[1].cells[0].text = '内容 1'
    table.rows[1].cells[1].text = '内容 2'
    for row in table.rows:
        for cell in row.cells:
            cell.width = Inches(3.25)

    # 保存
    doc.save(output_path)


if __name__ == '__main__':
    create_sample_doc('output.docx')
```

## 速查表

| 规则 | 关键值 |
|------|-------|
| US Letter | 8.5 × 11 英寸 |
| 1 英寸边距 | `Inches(1)` |
| 12pt 字号 | `Pt(12)` |
| 16pt 标题 | `Pt(16)` |
| CJK 字体 | Microsoft YaHei（必须显式设置 eastAsia 槽） |
| 表格样式 | `'Table Grid'`（含边框） |
| 项目符号 | `'List Bullet'` / `'List Number'` 样式 |
| PageBreak | `doc.add_page_break()` |
| 图片 | `doc.add_picture(path, width=Inches(4))` |
| 标题 | `doc.add_heading(text, level=1)` |
