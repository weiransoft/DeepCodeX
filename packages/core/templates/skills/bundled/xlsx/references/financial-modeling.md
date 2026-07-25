# 财务建模规范指南

本指南详细说明 Excel 财务模型的颜色编码、数字格式、公式构建与验证规范。

## 1. 颜色编码标准

### 1.1 行业通用颜色规则

除非用户或现有模板另有说明，财务模型必须遵循以下颜色编码：

| 颜色 | RGB | 用途 |
|------|-----|------|
| **蓝色文本** | (0, 0, 255) | 硬编码输入值、用户会调整的情景数值 |
| **黑色文本** | (0, 0, 0) | 所有公式与计算 |
| **绿色文本** | (0, 128, 0) | 引用同一工作簿内其他工作表的链接 |
| **红色文本** | (255, 0, 0) | 引用其他外部文件的链接 |
| **黄色背景** | (255, 255, 0) | 需要关注的关键假设或待更新单元格 |

### 1.2 openpyxl 实现

```python
from openpyxl.styles import Font, PatternFill

# 蓝色文本（硬编码输入）
blue_font = Font(color="0000FF")
sheet['B5'] = 1000
sheet['B5'].font = blue_font

# 黑色文本（公式，默认）
black_font = Font(color="000000")
sheet['B6'] = '=B5*1.05'
sheet['B6'].font = black_font

# 绿色文本（跨工作表引用）
green_font = Font(color="008000")
sheet['B7'] = "=Assumptions!B5"
sheet['B7'].font = green_font

# 黄色背景（关键假设）
yellow_fill = PatternFill("solid", start_color="FFFF00")
sheet['B5'].fill = yellow_fill
```

## 2. 数字格式标准

### 2.1 必需格式规则

| 数据类型 | 格式字符串 | 示例 |
|---------|-----------|------|
| **年份** | 文本字符串（不数字格式化） | `"2024"` 非 `2,024` |
| **货币** | `$#,##0` | `$1,234` |
| **货币（含零）** | `$#,##0;($#,##0);-` | `$1,234` / `($500)` / `-` |
| **百分比** | `0.0%` | `15.5%` |
| **倍数** | `0.0x` | `3.2x` |
| **负数** | 括号（非减号） | `(123)` 非 `-123` |

### 2.2 openpyxl 实现

```python
# 年份格式为文本
sheet['A1'] = '2024'  # 字符串，非整数
sheet['A1'].number_format = '@'  # 文本格式

# 货币（含零占位）
sheet['B5'].number_format = '$#,##0;($#,##0);-'

# 百分比
sheet['C5'].number_format = '0.0%'

# 估值倍数
sheet['D5'].number_format = '0.0x'
```

## 3. 公式构建规则

### 3.1 假设分离

**所有假设（增长率、利润率、倍数等）必须放在独立的假设单元格**，公式通过单元格引用使用：

```python
# ✅ 正确：假设独立 + 引用
sheet['B6'] = 0.05  # 增长率假设（蓝色 + 黄色背景标记关键）
sheet['B6'].font = Font(color="0000FF")
sheet['B6'].fill = PatternFill("solid", start_color="FFFF00")

sheet['B10'] = '=B9*(1+$B$6)'  # 公式引用假设单元格（绝对引用）
sheet['B10'].font = Font(color="000000")

# ❌ 错误：硬编码在公式中
sheet['B10'] = '=B9*1.05'  # 假设无法统一调整
```

### 3.2 公式错误预防

```python
# 检查单元格引用是否正确（避免 #REF!）
# 检查范围是否正确（避免 off-by-one）
# 确保跨表引用格式正确：SheetName!Cell

# 跨工作表引用
sheet['B7'] = "=Assumptions!B5"  # 注意 SheetName!Cell 格式
sheet['B7'].font = Font(color="008000")  # 绿色

# SUM 公式
sheet['B10'] = '=SUM(B2:B9)'

# AVERAGE 公式
sheet['C10'] = '=AVERAGE(C2:C9)'

# 增长率公式
sheet['D5'] = '=(C5-C4)/C4'  # 同比增长
```

### 3.3 硬编码值的文档要求

对硬编码值（如 10-K 财报数据），必须在单元格旁添加注释说明数据来源：

```python
from openpyxl.comments import Comment

# 添加数据来源注释
sheet['B5'] = 1250000000  # 营收（来自 10-K）
sheet['B5'].comment = Comment(
    "来源：公司 10-K, FY2024, Page 45, Revenue Note\n"
    "URL: https://www.sec.gov/...",
    "AI Assistant"
)
```

格式：`"来源：[系统/文档], [日期], [具体参考], [URL]"`

示例：
- `"来源：公司 10-K, FY2024, Page 45, Revenue Note, [SEC EDGAR URL]"`
- `"来源：公司 10-Q, Q2 2025, Exhibit 99.1, [SEC EDGAR URL]"`
- `"来源：Bloomberg Terminal, 8/15/2025, AAPL US Equity"`
- `"来源：FactSet, 8/20/2025, Consensus Estimates Screen"`

## 4. 完整示例：简单财务模型

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

wb = Workbook()

# ============ Sheet 1: 假设 ============
assumptions = wb.active
assumptions.title = "Assumptions"

# 标题
assumptions['A1'] = '假设'
assumptions['A1'].font = Font(bold=True)

# 关键假设（蓝色 + 黄色背景）
yellow_fill = PatternFill("solid", start_color="FFFF00")
blue_font = Font(color="0000FF")

assumptions['A3'] = '初始营收（$mm）'
assumptions['B3'] = 1000
assumptions['B3'].font = blue_font
assumptions['B3'].fill = yellow_fill
assumptions['B3'].number_format = '$#,##0'

assumptions['A4'] = '增长率'
assumptions['B4'] = 0.05
assumptions['B4'].font = blue_font
assumptions['B4'].fill = yellow_fill
assumptions['B4'].number_format = '0.0%'

assumptions['A5'] = '毛利率'
assumptions['B5'] = 0.40
assumptions['B5'].font = blue_font
assumptions['B5'].fill = yellow_fill
assumptions['B5'].number_format = '0.0%'

# ============ Sheet 2: 预测 ============
forecast = wb.create_sheet("Forecast")

# 表头
forecast['A1'] = '年份'
forecast['B1'] = '营收（$mm）'
forecast['C1'] = '毛利（$mm）'
forecast['D1'] = '增长率'

# 跨表引用假设（绿色）
green_font = Font(color="008000")
forecast['A2'] = '2024'
forecast['B2'] = "=Assumptions!B3"  # 初始营收
forecast['B2'].font = green_font
forecast['B2'].number_format = '$#,##0;($#,##0);-'

# 公式（黑色）
black_font = Font(color="000000")
forecast['A3'] = '2025'
forecast['B3'] = '=B2*(1+Assumptions!$B$4)'  # 营收 = 上年 × (1 + 增长率)
forecast['B3'].font = black_font
forecast['B3'].number_format = '$#,##0;($#,##0);-'

forecast['C3'] = '=B3*Assumptions!$B$5'  # 毛利 = 营收 × 毛利率
forecast['C3'].font = black_font
forecast['C3'].number_format = '$#,##0;($#,##0);-'

forecast['D3'] = '=(B3-B2)/B2'  # 增长率
forecast['D3'].font = black_font
forecast['D3'].number_format = '0.0%'

# 扩展到 2026-2028
for year_offset, row in enumerate(range(4, 8), start=2):
    year = 2024 + year_offset
    forecast.cell(row=row, column=1, value=str(year)).number_format = '@'
    forecast.cell(row=row, column=2, value=f'=B{row-1}*(1+Assumptions!$B$4)').font = black_font
    forecast.cell(row=row, column=2).number_format = '$#,##0;($#,##0);-'
    forecast.cell(row=row, column=3, value=f'=B{row}*Assumptions!$B$5').font = black_font
    forecast.cell(row=row, column=3).number_format = '$#,##0;($#,##0);-'
    forecast.cell(row=row, column=4, value=f'=(B{row}-B{row-1})/B{row-1}').font = black_font
    forecast.cell(row=row, column=4).number_format = '0.0%'

# 保存
wb.save('financial_model.xlsx')

# 重算公式
# bash: python3 scripts/recalc.py financial_model.xlsx
```

## 5. 验证检查清单

### 5.1 必需验证

- [ ] **测试 2-3 个样本引用**：在广泛应用前验证公式正确性
- [ ] **列映射**：确认 Excel 列与数据源匹配（如列 64 = BL，不是 BK）
- [ ] **行偏移**：Excel 行从 1 开始（DataFrame 第 5 行 = Excel 第 6 行）

### 5.2 常见陷阱

- [ ] **NaN 处理**：用 `pd.notna()` 检查空值
- [ ] **远右列**：财年数据常在列 50+
- [ ] **多重匹配**：搜索所有出现位置，不只第一个
- [ ] **除以零**：使用 `/` 前检查分母（#DIV/0!）
- [ ] **错误引用**：验证所有单元格引用指向正确单元格（#REF!）
- [ ] **跨表引用**：使用正确格式 `Sheet1!A1`

### 5.3 公式测试策略

- [ ] **小步开始**：2-3 个单元格测试公式后再广泛应用
- [ ] **验证依赖**：检查公式引用的所有单元格是否存在
- [ ] **测试边界**：包括零、负数、超大值

## 6. 速查表

| 任务 | openpyxl API |
|------|-------------|
| 创建工作簿 | `Workbook()` |
| 加载工作簿 | `load_workbook('file.xlsx')` |
| 选择工作表 | `wb.active` 或 `wb['SheetName']` |
| 写入单元格 | `sheet['A1'] = 'value'` |
| 添加公式 | `sheet['B1'] = '=SUM(A1:A10)'` |
| 设置字体 | `sheet['A1'].font = Font(color="0000FF")` |
| 设置填充 | `sheet['A1'].fill = PatternFill("solid", start_color="FFFF00")` |
| 数字格式 | `sheet['A1'].number_format = '$#,##0'` |
| 单元格注释 | `sheet['A1'].comment = Comment("text", "author")` |
| 插入行 | `sheet.insert_rows(2)` |
| 删除列 | `sheet.delete_cols(3)` |
| 保存 | `wb.save('output.xlsx')` |
| 重算公式 | `python3 scripts/recalc.py output.xlsx` |
