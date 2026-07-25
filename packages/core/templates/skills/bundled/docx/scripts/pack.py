#!/usr/bin/env python3
"""
DOCX 打包脚本

将解压后的 OOXML 目录重新打包为 .docx 文件。

工作流程：
  1. 校验输入目录与输出文件路径
  2. 压缩目录内全部文件为 ZIP（保持相对路径结构）
  3. 使用 ZIP_DEFLATED 压缩级别，生成 .docx 文件

使用方式：
  python3 pack.py <input_dir> <output.docx> [--original <original.docx>]

设计原则：
  - 仅依赖 Python 标准库（zipfile / pathlib / argparse）
  - 不引入 OOXML schema 校验（保持轻量，校验由 Word/LibreOffice 在打开时执行）
  - 真实可工作，非简化实现

依赖关系：
  - 被 SKILL.md 中的 unpack → edit → pack 工作流调用
  - 与 unpack.py 配对使用
"""

import argparse
import sys
import zipfile
from pathlib import Path


def pack(input_directory: str, output_file: str) -> tuple[bool, str]:
    """
    将目录打包为 .docx 文件

    参数：
        input_directory: 解压后的 OOXML 目录路径
        output_file: 输出 .docx 文件路径

    返回：
        (success, message) - success 为 True 表示成功，message 为状态描述
    """
    input_dir = Path(input_directory)
    output_path = Path(output_file)

    # 校验输入目录存在
    if not input_dir.is_dir():
        return False, f"错误：{input_dir} 不是有效目录"

    # 校验输出文件后缀
    if output_path.suffix.lower() != ".docx":
        return False, f"错误：输出文件 {output_file} 必须以 .docx 结尾"

    # 确保输出目录存在
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # 收集目录内全部文件（保持相对路径）
    files_to_pack = [f for f in input_dir.rglob("*") if f.is_file()]
    if not files_to_pack:
        return False, f"错误：目录 {input_dir} 为空"

    # 创建 ZIP 压缩包（即 .docx 文件）
    try:
        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for file_path in files_to_pack:
                # 使用相对路径作为 ZIP 内文件名
                arcname = file_path.relative_to(input_dir).as_posix()
                zf.write(file_path, arcname)
    except zipfile.BadZipFile as e:
        return False, f"错误：ZIP 创建失败 - {e}"
    except OSError as e:
        return False, f"错误：文件写入失败 - {e}"

    return True, f"成功打包 {len(files_to_pack)} 个文件到 {output_file}"


def main() -> int:
    """
    命令行入口

    返回值：
        0 - 成功
        1 - 参数错误或打包失败
    """
    parser = argparse.ArgumentParser(
        description="将解压后的 OOXML 目录打包为 .docx 文件"
    )
    parser.add_argument(
        "input_dir",
        help="解压后的 OOXML 目录路径",
    )
    parser.add_argument(
        "output_file",
        help="输出 .docx 文件路径",
    )
    parser.add_argument(
        "--original",
        help="原始 .docx 文件路径（保留参数，当前实现未使用）",
        default=None,
    )

    args = parser.parse_args()

    success, message = pack(args.input_dir, args.output_file)
    print(message)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
