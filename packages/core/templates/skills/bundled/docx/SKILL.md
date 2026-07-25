---
name: docx
description: "Comprehensive .docx document creation, editing, and analysis. Use when working with Word documents for: (1) creating new documents via python-docx, (2) editing existing documents via unpack/pack XML workflow, (3) adding comments or tracked changes, (4) extracting text via pandoc. Trigger when user mentions .docx, Word files, or document tasks."
---

# DOCX 创建、编辑与分析

## 概述

`.docx` 文件本质是 ZIP 压缩包，内含 OOXML 格式的 XML 文件。本 Skill 提供两条工作路径：

| 任务 | 路径 | 工具 |
|------|------|------|
| 读取/分析内容 | pandoc 提取文本 | `pandoc --track-changes=all doc.docx -o out.md` |
| 创建新文档 | python-docx（Python 库） | 详见 [references/python-docx-guide.md](references/python-docx-guide.md) |
| 编辑现有文档 | unpack → 编辑 XML → pack | 本 Skill 的 `scripts/unpack.py` + `scripts/pack.py` |
| 添加评论 | unpack → comment.py → 编辑 XML → pack | `scripts/comment.py` |

## 前置依赖

- **Python 3.10+**（脚本运行环境）
- **python-docx**：`pip install python-docx`（创建新文档，必需）
- **pandoc**（文本提取，可选）
- **LibreOffice**（`.doc` → `.docx` 转换，可选）

## 工作流

### 1. 编辑现有文档（unpack/pack 工作流）

```bash
# Step 1: 解压 .docx 为可编辑目录
python3 scripts/unpack.py input.docx unpacked/

# Step 2: 直接编辑 unpacked/word/document.xml（使用 Edit 工具替换字符串）
# 注意：tracked changes 使用 <w:ins>/<w:del> 标签包裹

# Step 3: 添加评论（可选）
python3 scripts/comment.py unpacked/ 0 "评论内容"
python3 scripts/comment.py unpacked/ 1 "回复内容" --parent 0

# Step 4: 重新打包为 .docx
python3 scripts/pack.py unpacked/ output.docx --original input.docx
```

### 2. 创建新文档

详见 [references/python-docx-guide.md](references/python-docx-guide.md)。关键要点：

- **必须显式设置页面尺寸**（python-docx 默认 A4，US Letter 为 8.5×11 英寸）
- **CJK 字体必须配置 ascii + hAnsi + eastAsia 三槽**（通过 `qn('w:eastAsia')` 显式设置），否则中文显示为方框
- **使用 Python 原生字符串**，禁止手动插入 XML 实体（`&#x201C;` 等，库会自动转义）
- **表格使用 `add_table(style='Table Grid')`**，并为每个单元格显式设置 `cell.width`
- **PageBreak 使用 `doc.add_page_break()`**，禁止手动插入 `<w:br>` XML

### 3. 读取内容

```bash
# 含 tracked changes 的文本提取
pandoc --track-changes=all document.docx -o output.md

# 原始 XML 访问
python3 scripts/unpack.py document.docx unpacked/
```

## 安全规则

- **Author 字段使用 "AI Assistant"** 作为 tracked changes 与 comments 的作者名，除非用户明确指定其他名称
- **使用 Edit 工具直接替换字符串**，禁止编写 Python 脚本做字符串替换（脚本引入不必要复杂度）
- **`<w:commentRangeStart>`/`<w:commentRangeEnd>` 是 `<w:p>` 的直接子节点**，禁止嵌套在 `<w:r>` 内
- **`<w:ins>`/`<w:del>` 必须是 `<w:r>` 的兄弟节点**，禁止注入到 run 内部
- **保留 `<w:rPr>` 格式块**：替换 run 时必须复制原 run 的 `<w:rPr>` 到新 run，避免丢失加粗/字号等格式

## 关键 OOXML 模式

### Tracked Changes

```xml
<!-- 插入 -->
<w:ins w:id="1" w:author="AI Assistant" w:date="2026-01-01T00:00:00Z">
  <w:r><w:t>inserted text</w:t></w:r>
</w:ins>

<!-- 删除（注意使用 <w:delText> 而非 <w:t>） -->
<w:del w:id="2" w:author="AI Assistant" w:date="2026-01-01T00:00:00Z">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
```

### Comments（运行 comment.py 后）

```xml
<!-- commentRangeStart/End 是 w:p 的直接子节点 -->
<w:commentRangeStart w:id="0"/>
<w:r><w:t>评论覆盖的文本</w:t></w:r>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
```

## 验证清单

- [ ] `.docx` 文件可在 Word/LibreOffice 正常打开
- [ ] tracked changes 显示正确的 author 与 date
- [ ] CJK 字符无方框乱码
- [ ] 表格列宽与列数对齐
- [ ] 评论的 `<w:commentRangeStart>`/`<w:commentRangeEnd>` ID 与 `comments.xml` 中的 `<w:comment w:id>` 一致

## 详细参考

- 创建新文档完整指南：[references/python-docx-guide.md](references/python-docx-guide.md)
