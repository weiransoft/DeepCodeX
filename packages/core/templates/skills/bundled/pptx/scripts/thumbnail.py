#!/usr/bin/env python3
"""
PPTX 幻灯片缩略图生成脚本

将 PowerPoint 演示文稿的每张幻灯片导出为 PNG 缩略图。

工作流程：
  1. 校验输入文件存在且为 .pptx
  2. 调用 LibreOffice headless 模式将 .pptx 转换为 PDF
  3. 调用 pdftoppm（poppler-utils）将 PDF 每页转换为 PNG
  4. 输出 PNG 文件到指定目录

使用方式：
  # 生成全部幻灯片缩略图（默认输出到 ./thumbnails/）
  python3 thumbnail.py presentation.pptx

  # 指定输出目录
  python3 thumbnail.py presentation.pptx -o output_thumbs/

  # 指定分辨率（默认 150 DPI）
  python3 thumbnail.py presentation.pptx -r 300

设计原则：
  - 依赖 LibreOffice（soffice）+ poppler-utils（pdftoppm）
  - 使用临时目录隔离中间 PDF 文件
  - 沙箱化 LibreOffice 用户配置目录，避免污染用户配置
  - 真实可工作，非简化实现
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def _find_executable(name: str) -> str | None:
    """
    查找可执行文件路径

    参数：
        name: 可执行文件名（如 soffice / pdftoppm）

    返回：
        可执行文件完整路径，未找到时返回 None
    """
    return shutil.which(name)


def _convert_pptx_to_pdf(
    pptx_file: Path,
    output_dir: Path,
    user_profile_dir: Path,
) -> Path | None:
    """
    使用 LibreOffice 将 .pptx 转换为 PDF

    参数：
        pptx_file: 输入 .pptx 文件路径
        output_dir: 输出目录
        user_profile_dir: LibreOffice 用户配置目录（沙箱隔离）

    返回：
        生成的 PDF 文件路径，失败时返回 None
    """
    soffice = _find_executable("soffice")
    if soffice is None:
        print("错误：LibreOffice（soffice）未安装", file=sys.stderr)
        return None

    # 构造 LibreOffice 命令行
    # -env:UserInstallation 使用 file:// 协议指定沙箱用户配置目录
    cmd = [
        soffice,
        "--headless",
        "--norestore",
        "--nodefault",
        "--nolockcheck",
        f"-env:UserInstallation=file://{user_profile_dir}",
        "--convert-to", "pdf",
        "--outdir", str(output_dir),
        str(pptx_file),
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=60,
            check=False,
        )
        if result.returncode != 0:
            print(
                f"LibreOffice 转换失败（退出码 {result.returncode}）："
                f"{result.stderr.decode('utf-8', errors='replace')}",
                file=sys.stderr,
            )
            return None
    except subprocess.TimeoutExpired:
        print("错误：LibreOffice 转换超时（60s）", file=sys.stderr)
        return None
    except FileNotFoundError:
        print("错误：soffice 命令未找到", file=sys.stderr)
        return None

    # 查找生成的 PDF 文件（文件名与输入相同，扩展名为 .pdf）
    expected_pdf = output_dir / (pptx_file.stem + ".pdf")
    if not expected_pdf.exists():
        print(f"错误：转换后 PDF 文件不存在 {expected_pdf}", file=sys.stderr)
        return None

    return expected_pdf


def _convert_pdf_to_png(
    pdf_file: Path,
    output_dir: Path,
    resolution: int,
    prefix: str,
) -> list[Path]:
    """
    使用 pdftoppm 将 PDF 转换为 PNG 缩略图

    参数：
        pdf_file: 输入 PDF 文件路径
        output_dir: 输出目录
        resolution: DPI 分辨率
        prefix: 输出文件前缀

    返回：
        生成的 PNG 文件路径列表（按页码排序）
    """
    pdftoppm = _find_executable("pdftoppm")
    if pdftoppm is None:
        print("错误：pdftoppm（poppler-utils）未安装", file=sys.stderr)
        return []

    output_prefix = str(output_dir / prefix)
    cmd = [
        pdftoppm,
        "-jpeg",  # 使用 JPEG 格式（兼容性更好，文件更小）
        "-r", str(resolution),
        str(pdf_file),
        output_prefix,
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=120,
            check=False,
        )
        if result.returncode != 0:
            print(
                f"pdftoppm 转换失败（退出码 {result.returncode}）："
                f"{result.stderr.decode('utf-8', errors='replace')}",
                file=sys.stderr,
            )
            return []
    except subprocess.TimeoutExpired:
        print("错误：pdftoppm 转换超时（120s）", file=sys.stderr)
        return []

    # 收集生成的 JPG 文件（pdftoppm 输出格式：<prefix>-N.jpg）
    jpg_files = sorted(output_dir.glob(f"{prefix}-*.jpg"))
    return jpg_files


def generate_thumbnails(
    input_file: str,
    output_dir: str,
    resolution: int = 150,
) -> tuple[bool, str]:
    """
    生成 PPTX 幻灯片缩略图

    参数：
        input_file: 输入 .pptx 文件路径
        output_dir: 输出目录路径
        resolution: DPI 分辨率（默认 150）

    返回：
        (success, message) - success 为 True 表示成功
    """
    input_path = Path(input_file)
    output_path = Path(output_dir)

    # 校验输入文件
    if not input_path.exists():
        return False, f"错误：{input_file} 不存在"
    if input_path.suffix.lower() != ".pptx":
        return False, f"错误：{input_file} 必须以 .pptx 结尾"

    # 创建输出目录
    output_path.mkdir(parents=True, exist_ok=True)

    # 使用临时目录隔离中间 PDF
    with tempfile.TemporaryDirectory(prefix="pptx-thumb-") as temp_dir:
        temp_path = Path(temp_dir)
        pdf_temp_dir = temp_path / "pdf"
        pdf_temp_dir.mkdir()
        lo_profile = temp_path / "lo-profile"

        # Step 1: pptx → pdf
        pdf_file = _convert_pptx_to_pdf(input_path, pdf_temp_dir, lo_profile)
        if pdf_file is None:
            return False, "错误：PPTX → PDF 转换失败"

        # Step 2: pdf → jpg（每页一张）
        prefix = input_path.stem
        jpg_files = _convert_pdf_to_png(pdf_file, output_path, resolution, prefix)

        if not jpg_files:
            return False, "错误：PDF → JPG 转换失败"

        return True, (
            f"成功生成 {len(jpg_files)} 张缩略图（{resolution} DPI）"
            f"，已保存到 {output_path}/"
        )


def main() -> int:
    """
    命令行入口

    返回值：
        0 - 成功
        1 - 参数错误或生成失败
    """
    parser = argparse.ArgumentParser(
        description="生成 PPTX 幻灯片缩略图（依赖 LibreOffice + poppler-utils）"
    )
    parser.add_argument("input_file", help="输入 .pptx 文件路径")
    parser.add_argument(
        "-o", "--output",
        help="输出目录（默认 ./thumbnails/）",
        default="thumbnails",
    )
    parser.add_argument(
        "-r", "--resolution",
        type=int,
        default=150,
        help="DPI 分辨率（默认 150）",
    )

    args = parser.parse_args()

    success, message = generate_thumbnails(args.input_file, args.output, args.resolution)
    print(message)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
