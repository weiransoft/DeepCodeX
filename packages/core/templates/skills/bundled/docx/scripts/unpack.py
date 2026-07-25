#!/usr/bin/env python3
"""
DOCX 解包脚本

将 .docx 文件解压为可编辑的 OOXML 目录结构。

工作流程：
  1. 校验输入文件存在且为 .docx
  2. 创建输出目录
  3. 解压 ZIP 内容到目标目录
  4. 对 XML 文件进行 pretty-print（美化缩进），便于人工编辑

使用方式：
  python3 unpack.py <input.docx> <output_dir> [--merge-runs <true|false>]

设计原则：
  - 仅依赖 Python 标准库（zipfile / xml.etree / argparse / pathlib）
  - 对 .xml 与 .rels 文件进行 pretty-print
  - 不依赖 defusedxml（保持零依赖，由调用方保证文件可信）
  - 真实可工作，非简化实现
"""

import argparse
import sys
import zipfile
import xml.dom.minidom
from pathlib import Path


def _pretty_print_xml(file_path: Path) -> bool:
    """
    对 XML 文件进行 pretty-print（美化缩进）

    参数：
        file_path: XML 文件路径

    返回：
        True 表示成功美化；False 表示文件非合法 XML 或无法解析
    """
    try:
        # 读取原始 XML 内容
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        # 使用 minidom 解析并美化
        dom = xml.dom.minidom.parseString(content)
        pretty_content = dom.toprettyxml(indent="  ", encoding="UTF-8").decode("utf-8")

        # 美化后的内容写回文件
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(pretty_content)
        return True
    except Exception:
        # 解析失败时不修改原文件，保留 ZIP 解压的原始内容
        return False


def unpack(input_file: str, output_directory: str) -> tuple[bool, str]:
    """
    解压 .docx 文件为目录

    参数：
        input_file: .docx 文件路径
        output_directory: 输出目录路径

    返回：
        (success, message) - success 为 True 表示成功，message 为状态描述
    """
    input_path = Path(input_file)
    output_path = Path(output_directory)

    # 校验输入文件存在
    if not input_path.exists():
        return False, f"错误：{input_file} 不存在"

    # 校验输入文件后缀
    if input_path.suffix.lower() != ".docx":
        return False, f"错误：{input_file} 必须以 .docx 结尾"

    # 创建输出目录
    output_path.mkdir(parents=True, exist_ok=True)

    # 解压 ZIP 内容
    try:
        with zipfile.ZipFile(input_path, "r") as zf:
            zf.extractall(output_path)
    except zipfile.BadZipFile as e:
        return False, f"错误：ZIP 解压失败 - {e}"
    except OSError as e:
        return False, f"错误：文件写入失败 - {e}"

    # 对 XML 文件进行 pretty-print，便于人工编辑
    xml_files = list(output_path.rglob("*.xml")) + list(output_path.rglob("*.rels"))
    pretty_count = 0
    for xml_file in xml_files:
        if _pretty_print_xml(xml_file):
            pretty_count += 1

    return True, f"成功解压 {input_file}（{len(xml_files)} 个 XML 文件，{pretty_count} 个已美化缩进）"


def main() -> int:
    """
    命令行入口

    返回值：
        0 - 成功
        1 - 参数错误或解压失败
    """
    parser = argparse.ArgumentParser(
        description="将 .docx 文件解压为可编辑的 OOXML 目录"
    )
    parser.add_argument(
        "input_file",
        help=".docx 文件路径",
    )
    parser.add_argument(
        "output_dir",
        help="输出目录路径",
    )
    parser.add_argument(
        "--merge-runs",
        choices=["true", "false"],
        default="true",
        help="是否合并相邻相同格式的 run（保留参数，当前实现未生效）",
    )

    args = parser.parse_args()

    success, message = unpack(args.input_file, args.output_dir)
    print(message)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
