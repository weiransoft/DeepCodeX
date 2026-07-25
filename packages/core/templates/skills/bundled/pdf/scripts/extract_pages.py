#!/usr/bin/env python3
"""
PDF 页面文本提取脚本

从 PDF 文件提取指定页面的文本内容，输出为文本文件或 stdout。

工作流程：
  1. 校验输入文件存在且为 .pdf
  2. 解析 --pages 参数（支持 "1-5"、"1,3,5"、"all" 三种格式）
  3. 使用 pypdf 读取指定页面，提取文本
  4. 输出到指定文件或 stdout

使用方式：
  # 提取第 1-5 页
  python3 extract_pages.py input.pdf --pages 1-5 -o output.txt

  # 提取第 1, 3, 5 页
  python3 extract_pages.py input.pdf --pages 1,3,5 -o output.txt

  # 提取全部页面
  python3 extract_pages.py input.pdf -o output.txt

  # 输出到 stdout
  python3 extract_pages.py input.pdf --pages 1-3

设计原则：
  - 仅依赖 pypdf（轻量，纯 Python）
  - 不依赖 pdfplumber（保留布局信息更丰富，但依赖较重；本脚本聚焦"快速文本提取"）
  - 真实可工作，非简化实现
  - 失败时返回非零退出码并打印错误信息
"""

import argparse
import sys
from pathlib import Path


def parse_page_ranges(pages_arg: str, total_pages: int) -> list[int]:
    """
    解析 --pages 参数为页码列表（0-based 索引）

    支持三种格式：
      - "all"：全部页面
      - "1-5"：1 到 5 页（含端点，1-based）
      - "1,3,5"：第 1、3、5 页（1-based，逗号分隔）

    参数：
        pages_arg: --pages 参数值
        total_pages: PDF 总页数

    返回：
        0-based 页码列表

    异常：
        ValueError: 参数格式不合法或页码超出范围
    """
    pages_arg = pages_arg.strip().lower()

    # 全部页面
    if pages_arg in ("all", "*", ""):
        return list(range(total_pages))

    # 逗号分隔的列表
    if "," in pages_arg:
        result = []
        for part in pages_arg.split(","):
            part = part.strip()
            if "-" in part:
                # 支持 "1-3,5-7" 这种混合格式
                start, end = part.split("-", 1)
                start_idx = int(start) - 1
                end_idx = int(end) - 1
                if start_idx < 0 or end_idx >= total_pages or start_idx > end_idx:
                    raise ValueError(f"页码范围不合法：{part}（总页数 {total_pages}）")
                result.extend(range(start_idx, end_idx + 1))
            else:
                idx = int(part) - 1
                if idx < 0 or idx >= total_pages:
                    raise ValueError(f"页码超出范围：{part}（总页数 {total_pages}）")
                result.append(idx)
        return result

    # 单个范围 "1-5"
    if "-" in pages_arg:
        start, end = pages_arg.split("-", 1)
        start_idx = int(start) - 1
        end_idx = int(end) - 1
        if start_idx < 0 or end_idx >= total_pages or start_idx > end_idx:
            raise ValueError(f"页码范围不合法：{pages_arg}（总页数 {total_pages}）")
        return list(range(start_idx, end_idx + 1))

    # 单页 "3"
    idx = int(pages_arg) - 1
    if idx < 0 or idx >= total_pages:
        raise ValueError(f"页码超出范围：{pages_arg}（总页数 {total_pages}）")
    return [idx]


def extract_pages(input_file: str, pages_arg: str) -> tuple[bool, str, str]:
    """
    从 PDF 提取指定页面的文本

    参数：
        input_file: PDF 文件路径
        pages_arg: --pages 参数值

    返回：
        (success, message, text) - success 为 True 表示成功；
        message 为状态描述；text 为提取的文本内容
    """
    input_path = Path(input_file)

    # 校验输入文件存在
    if not input_path.exists():
        return False, f"错误：{input_file} 不存在", ""

    # 校验文件后缀
    if input_path.suffix.lower() != ".pdf":
        return False, f"错误：{input_file} 必须以 .pdf 结尾", ""

    # 导入 pypdf（在函数内导入，避免脚本启动时失败）
    try:
        from pypdf import PdfReader
    except ImportError:
        return False, "错误：pypdf 未安装，请运行 `pip install pypdf`", ""

    # 读取 PDF
    try:
        reader = PdfReader(str(input_path))
    except Exception as e:
        return False, f"错误：PDF 读取失败 - {e}", ""

    total_pages = len(reader.pages)
    if total_pages == 0:
        return False, f"错误：{input_file} 不含任何页面", ""

    # 解析页码
    try:
        page_indices = parse_page_ranges(pages_arg, total_pages)
    except ValueError as e:
        return False, str(e), ""

    # 提取文本
    text_parts = []
    for idx in page_indices:
        try:
            page_text = reader.pages[idx].extract_text() or ""
            text_parts.append(f"=== Page {idx + 1} ===\n{page_text}")
        except Exception as e:
            text_parts.append(f"=== Page {idx + 1} (提取失败: {e}) ===")

    full_text = "\n\n".join(text_parts)
    return True, f"成功提取 {len(page_indices)}/{total_pages} 页", full_text


def main() -> int:
    """
    命令行入口

    返回值：
        0 - 成功
        1 - 参数错误或提取失败
    """
    parser = argparse.ArgumentParser(
        description="从 PDF 文件提取指定页面的文本内容"
    )
    parser.add_argument("input_file", help="PDF 文件路径")
    parser.add_argument(
        "-o", "--output",
        help="输出文件路径（不指定时输出到 stdout）",
        default=None,
    )
    parser.add_argument(
        "--pages",
        help='页面范围，支持 "1-5"、"1,3,5"、"all" 三种格式（默认 all）',
        default="all",
    )

    args = parser.parse_args()

    success, message, text = extract_pages(args.input_file, args.pages)
    if not success:
        print(message, file=sys.stderr)
        return 1

    # 输出文本
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"{message}，已写入 {args.output}")
    else:
        print(text)

    return 0


if __name__ == "__main__":
    sys.exit(main())
