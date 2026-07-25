---
name: xlsx
description: "Comprehensive Excel/spreadsheet processing: open, read, edit, create, validate, and recalculate .xlsx/.xlsm/.csv/.tsv files. Use when working with spreadsheets for: (1) data analysis via pandas, (2) formulas and formatting via openpyxl, (3) formula recalculation via scripts/recalc.py (LibreOffice), (4) financial modeling with industry-standard color coding, (5) cleaning messy tabular data. Trigger when user mentions .xlsx, .csv, spreadsheets, or tabular data tasks."
---

# XLSX 创建、编辑与分析

## 概述

本 Skill 提供基于 Python 库的 Excel 文件处理能力，覆盖数据读取、公式编辑、重算验证、财务建模四大场景。

| 任务 | 推荐工具 | 关键 API |
|------|---------|---------|
| 数据读取与分析 | pandas | `pd.read_excel()` / `df.describe()` |
| 公式与格式化 | openpyxl | `load_workbook()` / `Workbook()` |
| 公式重算 | 本 Skill 脚本 | `python3 scripts/recalc.py output.xlsx` |
| 财务建模 | openpyxl + recalc.py | 详见 [references/financial-modeling.md](references/financial-modeling.md) |

## 前置依赖

```bash
pip install openpyxl pandas
# 公式重算还需 LibreOffice
brew install --cask libreoffice  # macOS
soffice --version  # 验证
```

## 工作流

### 1. 数据分析（pandas）

```python
import pandas as pd
df = pd.read_excel('file.xlsx')  # 或 sheet_name=None 读取全部
df.describe()  # 统计摘要
```

### 2. 创建新 Excel（openpyxl，含公式）

⚠️ **CRITICAL：使用 Excel 公式，禁止 Python 计算后硬编码值**

```python
from openpyxl import Workbook
wb = Workbook()
sheet = wb.active
sheet.append(['收入', 1000])
sheet.append(['成本', 600])
sheet['B3'] = '=B1-B2'           # ✅ Excel 公式
wb.save('output.xlsx')
```

```bash
python3 scripts/recalc.py output.xlsx  # 重算公式（MANDATORY）
```

### 3. 编辑现有 Excel（openpyxl）

```python
from openpyxl import load_workbook
wb = load_workbook('existing.xlsx')
sheet['A1'] = '新值'
wb.save('modified.xlsx')
```

## 关键规则

### 1. 公式优先（CRITICAL）

**所有计算必须使用 Excel 公式，禁止 Python 计算后硬编码值**。表格保持动态可更新。

```python
# ✅ 正确
sheet['B10'] = '=SUM(B2:B9)'
# ❌ 错误
sheet['B10'] = sum(df['Sales'])  # 硬编码
```

### 2. 颜色编码（财务模型）

| 颜色 | 含义 |
|------|------|
| 蓝色文本 | 硬编码输入值 |
| 黑色文本 | 公式与计算 |
| 绿色文本 | 同工作簿跨表引用 |
| 红色文本 | 外部文件引用 |
| 黄色背景 | 关键假设 |

详细 RGB 值与 openpyxl 实现见 [references/financial-modeling.md](references/financial-modeling.md)。

### 3. 数字格式标准

| 数据类型 | 格式 |
|---------|------|
| 年份 | 文本 `"2024"`（非 `2,024`） |
| 货币 | `$#,##0;($#,##0);-`（含零占位） |
| 百分比 | `0.0%` |
| 倍数 | `0.0x` |
| 负数 | 括号 `($123)` 非 `-123` |

### 4. 公式重算

Excel 文件由 openpyxl 保存后，**公式为字符串，不含计算结果**。必须运行：

```bash
python3 scripts/recalc.py output.xlsx [timeout_seconds]
```

脚本通过 LibreOffice headless 重算全部公式，并扫描 Excel 错误（#REF!, #DIV/0!, #VALUE!, #N/A, #NAME?）。返回 JSON：

```json
{
  "status": "success",           // 或 "errors_found"
  "total_errors": 0,
  "total_formulas": 42,
  "error_summary": { "#REF!": { "count": 2, "locations": ["Sheet1!B5"] } }
}
```

### 5. 假设分离

**所有假设放在独立单元格**，公式通过引用使用：

```python
# ✅ 正确：假设独立 + 引用
sheet['B6'] = 0.05  # 增长率假设
sheet['B10'] = '=B9*(1+$B$6)'  # 公式引用假设单元格

# ❌ 错误：硬编码在公式中
sheet['B10'] = '=B9*1.05'
```

## 安全规则

- **`load_workbook(data_only=True)` 读取计算值时禁止保存**，否则公式将永久丢失
- **公式重算前备份原文件**，避免 LibreOffice 异常导致文件损坏
- **CSV 导入时显式指定 dtype**，避免数据类型推断错误（如手机号被转为数字）
- **大文件使用 `read_only=True` 或 `write_only=True`**，避免内存溢出

## 验证清单

- [ ] 文件可在 Excel/LibreOffice/Numbers 正常打开
- [ ] 所有公式重算后无错误（`status: success`）
- [ ] 颜色编码符合财务模型标准
- [ ] 假设独立在专用单元格，公式通过引用使用
- [ ] 负数使用括号格式
- [ ] 年份格式为文本

## 详细参考

- 财务建模完整规范（颜色编码 RGB + 数字格式 + 完整示例）：[references/financial-modeling.md](references/financial-modeling.md)
