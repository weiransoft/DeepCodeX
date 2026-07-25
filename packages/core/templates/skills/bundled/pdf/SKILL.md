---
name: pdf
description: "Comprehensive PDF manipulation: extract text/tables, merge/split documents, fill forms, create new PDFs. Use when working with PDF files for: (1) extracting text or tables via pdfplumber, (2) merging/splitting/rotating via pypdf, (3) creating styled PDFs via reportlab, (4) OCR scanned PDFs via pytesseract. Trigger when user mentions .pdf, PDF files, or document extraction/merging/creation tasks."
---

# PDF 处理指南

## 概述

本 Skill 提供基于 Python 库的 PDF 处理能力，覆盖提取、合并、拆分、创建、OCR 五大场景。

| 任务 | 推荐工具 | 命令/库 |
|------|---------|---------|
| 提取文本（保留布局） | pdfplumber | `page.extract_text()` |
| 提取表格 | pdfplumber | `page.extract_tables()` |
| 合并/拆分/旋转 | pypdf | `PdfWriter` / `PdfReader` |
| 提取指定页面 | 本 Skill 脚本 | `python3 scripts/extract_pages.py` |
| 创建新 PDF | reportlab | `SimpleDocTemplate` |
| 扫描件 OCR | pytesseract + pdf2image | `image_to_string()` |
| 命令行合并/拆分 | qpdf | `qpdf --empty --pages ...` |
| 命令行提取文本 | pdftotext | `pdftotext -layout input.pdf output.txt` |

## 前置依赖

```bash
# Python 库（必需）
pip install pypdf pdfplumber reportlab

# 可选（OCR / 命令行）
pip install pytesseract pdf2image
brew install qpdf poppler tesseract  # macOS
```

## 工作流

### 1. 提取指定页面（本 Skill 脚本）

```bash
# 提取第 1-5 页为文本
python3 scripts/extract_pages.py input.pdf --pages 1-5 -o output.txt

# 提取全部页面
python3 scripts/extract_pages.py input.pdf -o output.txt
```

### 2. 提取文本与表格（pdfplumber）

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        tables = page.extract_tables()
        for table in tables:
            for row in table:
                print(row)
```

### 3. 合并/拆分（pypdf）

```python
from pypdf import PdfReader, PdfWriter

# 合并
writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf"]:
    for page in PdfReader(pdf_file).pages:
        writer.add_page(page)
with open("merged.pdf", "wb") as f:
    writer.write(f)

# 拆分
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as f:
        writer.write(f)
```

### 4. 创建新 PDF（reportlab，含 CJK 支持）

⚠️ **CJK 字体必须显式注册**，否则中文/日文/韩文显示为方框。

```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor

# 注册 CJK 字体（macOS PingFang）
pdfmetrics.registerFont(TTFont("CJKFont", "/System/Library/Fonts/PingFang.ttc", subfontIndex=0))

style = ParagraphStyle(
    "Body", fontName="CJKFont", fontSize=11, leading=18,
    textColor=HexColor("#2d3748"), wordWrap="CJK"
)

doc = SimpleDocTemplate("report.pdf", pagesize=letter)
doc.build([Paragraph("标题 Title", style)])
```

详细样式、表格、分页规则见 [references/pdf-libraries.md](references/pdf-libraries.md)。

### 5. 扫描件 OCR

```python
import pytesseract
from pdf2image import convert_from_path

images = convert_from_path('scanned.pdf')
for i, image in enumerate(images):
    text = pytesseract.image_to_string(image)
    print(f"Page {i+1}:\n{text}")
```

## 安全规则

- **PDF 文件来源不可信时使用 `pypdf` 而非 `pdfplumber`**（pypdf 解析更严格，不易受恶意 PDF 攻击）
- **LibreOffice 转换前校验文件路径**，禁止相对路径（避免目录遍历）
- **生成 PDF 时显式声明编码**（UTF-8），避免 CJK 字符乱码
- **OCR 结果未经校验不直接入库**（pytesseract 准确率受图像质量影响）

## CJK 字体跨平台策略

| 平台 | 字体路径 |
|------|---------|
| macOS | `/System/Library/Fonts/PingFang.ttc` |
| Windows | `C:/Windows/Fonts/msyh.ttc`（微软雅黑） |
| Linux | `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc` |

字体注册失败时降级为 `Helvetica`，并打印警告日志。

## 验证清单

- [ ] 提取的文本保留原文档段落结构
- [ ] 表格的列对齐正确（无错列）
- [ ] 创建的 PDF 中 CJK 字符无方框乱码
- [ ] 合并后的 PDF 页数 = 各源 PDF 页数之和
- [ ] 拆分后的单页 PDF 文件可独立打开

## 详细参考

- 三大库速查与完整示例：[references/pdf-libraries.md](references/pdf-libraries.md)
