# PDF Python 库速查

本指南汇总 pypdf / pdfplumber / reportlab 三大库的常用 API 与完整示例。

## 1. pypdf - 基础操作

### 1.1 读取 PDF

```python
from pypdf import PdfReader

reader = PdfReader("document.pdf")
print(f"页数: {len(reader.pages)}")

# 提取单页文本
text = reader.pages[0].extract_text()

# 提取全部文本
full_text = "\n".join(page.extract_text() for page in reader.pages)

# 提取元数据
meta = reader.metadata
print(f"标题: {meta.title}")
print(f"作者: {meta.author}")
```

### 1.2 合并 PDF

```python
from pypdf import PdfWriter, PdfReader

writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf", "doc3.pdf"]:
    for page in PdfReader(pdf_file).pages:
        writer.add_page(page)

with open("merged.pdf", "wb") as output:
    writer.write(output)
```

### 1.3 拆分 PDF

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as output:
        writer.write(output)
```

### 1.4 旋转页面

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()

page = reader.pages[0]
page.rotate(90)  # 顺时针旋转 90 度
writer.add_page(page)

with open("rotated.pdf", "wb") as output:
    writer.write(output)
```

### 1.5 密码保护

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()

for page in reader.pages:
    writer.add_page(page)

writer.encrypt("userpassword", "ownerpassword")

with open("encrypted.pdf", "wb") as output:
    writer.write(output)
```

### 1.6 添加水印

```python
from pypdf import PdfReader, PdfWriter

watermark = PdfReader("watermark.pdf").pages[0]
reader = PdfReader("document.pdf")
writer = PdfWriter()

for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)

with open("watermarked.pdf", "wb") as output:
    writer.write(output)
```

## 2. pdfplumber - 文本与表格提取

### 2.1 提取文本（保留布局）

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        print(text)
```

### 2.2 提取表格

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for i, page in enumerate(pdf.pages):
        tables = page.extract_tables()
        for j, table in enumerate(tables):
            print(f"Page {i+1} Table {j+1}:")
            for row in table:
                print(row)
```

### 2.3 表格转 DataFrame

```python
import pandas as pd
import pdfplumber

all_tables = []
with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            if table:
                df = pd.DataFrame(table[1:], columns=table[0])
                all_tables.append(df)

combined = pd.concat(all_tables, ignore_index=True)
combined.to_excel("extracted.xlsx", index=False)
```

## 3. reportlab - 创建 PDF

### 3.1 CJK 字体注册

⚠️ **必须先注册 CJK 字体，否则中文显示为方框**

```python
import os
import platform
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

def register_cjk_font():
    """根据操作系统注册 CJK 字体"""
    system = platform.system()

    if system == "Darwin":  # macOS
        font_paths = [
            "/System/Library/Fonts/PingFang.ttc",
            "/Library/Fonts/Arial Unicode.ttf",
            "/System/Library/Fonts/STHeiti Medium.ttc",
        ]
    elif system == "Windows":
        font_paths = [
            "C:/Windows/Fonts/msyh.ttc",
            "C:/Windows/Fonts/simsun.ttc",
        ]
    else:  # Linux
        font_paths = [
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        ]

    for font_path in font_paths:
        if os.path.exists(font_path):
            pdfmetrics.registerFont(TTFont("CJKFont", font_path, subfontIndex=0))
            return "CJKFont"
    return None  # 字体注册失败时降级为 Helvetica

cjk_font = register_cjk_font()
```

### 3.2 专业样式集

```python
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor

PRIMARY_COLOR = HexColor('#1a365d')
ACCENT_COLOR = HexColor('#2b6cb0')

def get_professional_styles(cjk_font='CJKFont'):
    """返回专业 PDF 样式集"""
    return {
        'title': ParagraphStyle(
            'Title', fontName=cjk_font, fontSize=28, leading=34,
            textColor=PRIMARY_COLOR, spaceAfter=20, alignment=1, wordWrap='CJK'
        ),
        'h1': ParagraphStyle(
            'H1', fontName=cjk_font, fontSize=20, leading=26,
            textColor=PRIMARY_COLOR, spaceBefore=24, spaceAfter=12, wordWrap='CJK'
        ),
        'h2': ParagraphStyle(
            'H2', fontName=cjk_font, fontSize=16, leading=22,
            textColor=ACCENT_COLOR, spaceBefore=18, spaceAfter=8, wordWrap='CJK'
        ),
        'body': ParagraphStyle(
            'Body', fontName=cjk_font, fontSize=11, leading=18,
            textColor=HexColor('#2d3748'), spaceAfter=10, wordWrap='CJK'
        ),
    }

styles = get_professional_styles('CJKFont')
```

### 3.3 表格样式

```python
from reportlab.platypus import Table, LongTable
from reportlab.lib.colors import HexColor
from reportlab.lib import colors

def create_styled_table(data, col_widths=None, is_large=False):
    """创建专业样式表格"""
    TableClass = LongTable if is_large else Table
    table = TableClass(data, colWidths=col_widths, repeatRows=1 if is_large else 0)

    table.setStyle([
        ('BACKGROUND', (0, 0), (-1, 0), HexColor('#2b6cb0')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, -1), 'CJKFont'),
        ('FONTSIZE', (0, 0), (-1, 0), 11),
        ('FONTSIZE', (0, 1), (-1, -1), 10),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, 0), 10),
        ('BOTTOMPADDING', (0, 1), (-1, -1), 8),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [HexColor('#f7fafc'), colors.white]),
        ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#e2e8f0')),
    ])
    return table
```

### 3.4 分页最佳实践

⚠️ **核心原则**：让内容自然流动，最小化使用 `PageBreak` 和 `KeepTogether`

| 内容类型 | 添加方式 | KeepTogether? | PageBreak? |
|---------|---------|---------------|------------|
| 封面 | `story.append()` + `PageBreak()` 后 | 否 | **仅封面后** |
| 标题 | `story.append()` 直接 | **否** | **否** |
| 段落 | `story.append()` 直接 | **否** | **否** |
| 图片+说明 | `KeepTogether([Image, Paragraph])` | 是 | 否 |
| 小表格 | `KeepTogether([Table])` | 是 | 否 |
| 大表格 | `LongTable(..., repeatRows=1)` | 否 | 否 |

```python
# ❌ 错误：在章节前加 PageBreak（造成大量留白）
story.append(PageBreak())
story.append(Paragraph("第二章", h1_style))

# ✅ 正确：直接添加标题，内容自然流动
story.append(Paragraph("第二章", h1_style))
```

### 3.5 完整示例

```python
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, PageBreak

# 1. 注册 CJK 字体
cjk_font = register_cjk_font()

# 2. 文档设置
doc = SimpleDocTemplate(
    "report.pdf", pagesize=letter,
    leftMargin=0.75*inch, rightMargin=0.75*inch,
    topMargin=0.75*inch, bottomMargin=0.75*inch
)

# 3. 加载样式
styles = get_professional_styles(cjk_font)

story = []

# 封面（仅此处使用 PageBreak）
story.append(Spacer(1, 2*inch))
story.append(Paragraph("报告标题 Report Title", styles['title']))
story.append(Paragraph("副标题 Subtitle", styles['subtitle']))
story.append(PageBreak())

# 章节内容（直接添加，无 KeepTogether / PageBreak）
story.append(Paragraph("第一章 Introduction", styles['h1']))
story.append(Paragraph("正文内容自然流动，可跨页分割...", styles['body']))

doc.build(story)
```

## 4. matplotlib 图表（含 CJK 支持）

```python
import matplotlib
import matplotlib.pyplot as plt
import platform

def setup_matplotlib_cjk():
    """配置 matplotlib 支持 CJK 字符"""
    system = platform.system()
    if system == "Darwin":
        font_names = ['Arial Unicode MS', 'PingFang SC', 'Heiti SC', 'STHeiti']
    elif system == "Windows":
        font_names = ['Microsoft YaHei', 'SimHei', 'SimSun']
    else:
        font_names = ['Noto Sans CJK SC', 'WenQuanYi Zen Hei']

    available = [f.name for f in matplotlib.font_manager.fontManager.ttflist]
    for name in font_names:
        if name in available:
            plt.rcParams['font.sans-serif'] = [name] + plt.rcParams['font.sans-serif']
            plt.rcParams['axes.unicode_minus'] = False
            return name
    return None

setup_matplotlib_cjk()

categories = ['第一季度', '第二季度', '第三季度', '第四季度']
values = [120, 135, 142, 158]

plt.figure(figsize=(10, 6))
plt.bar(categories, values, color='steelblue')
plt.title('季度销售数据 Quarterly Sales', fontsize=16)
plt.tight_layout()
plt.savefig('chart.png', dpi=150)
```

## 5. 命令行工具

### pdftotext（poppler-utils）

```bash
# 提取文本
pdftotext input.pdf output.txt

# 保留布局
pdftotext -layout input.pdf output.txt

# 提取指定页
pdftotext -f 1 -l 5 input.pdf output.txt
```

### qpdf

```bash
# 合并
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf

# 拆分
qpdf input.pdf --pages . 1-5 -- pages1-5.pdf

# 旋转
qpdf input.pdf output.pdf --rotate=+90:1

# 解密
qpdf --password=mypassword --decrypt encrypted.pdf decrypted.pdf
```

## 速查表

| 任务 | 库/工具 | 关键 API |
|------|---------|---------|
| 读取 PDF | pypdf | `PdfReader(path).pages[i].extract_text()` |
| 合并 PDF | pypdf | `PdfWriter().add_page(page)` |
| 拆分 PDF | pypdf | 单页 `PdfWriter` 写文件 |
| 旋转 | pypdf | `page.rotate(90)` |
| 提取表格 | pdfplumber | `page.extract_tables()` |
| 创建 PDF | reportlab | `SimpleDocTemplate + Paragraph` |
| CJK 字体 | reportlab | `pdfmetrics.registerFont(TTFont(...))` |
| 命令行合并 | qpdf | `qpdf --empty --pages ...` |
| 命令行提取 | pdftotext | `pdftotext -layout input.pdf output.txt` |
| 扫描件 OCR | pytesseract | `image_to_string(image)` |
