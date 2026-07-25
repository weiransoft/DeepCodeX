#!/usr/bin/env python3
"""
PPTX 幻灯片添加脚本

向现有 PowerPoint 演示文稿添加新幻灯片。

工作流程：
  1. 校验输入文件存在且为 .pptx
  2. 使用 python-pptx 加载演示文稿
  3. 根据 --layout 选择幻灯片布局（title / title_content / blank / section_header）
  4. 填充标题与内容文本
  5. 保存到原文件或 --output 指定的新文件

使用方式：
  # 添加标题 + 内容幻灯片
  python3 add_slide.py presentation.pptx \
      --title "新章节" --content "要点 1\n要点 2"

  # 添加空白幻灯片
  python3 add_slide.py presentation.pptx --layout blank

  # 添加章节标题页
  python3 add_slide.py presentation.pptx --layout section_header --title "第二部分"

  # 输出到新文件（保留原文件）
  python3 add_slide.py input.pptx --title "标题" -o output.pptx

设计原则：
  - 仅依赖 python-pptx（pip install python-pptx）
  - 支持 4 种布局：title / title_content / blank / section_header
  - 内容文本支持 \n 换行（自动拆分为多个段落）
  - 真实可工作，非简化实现
"""

import argparse
import sys
from pathlib import Path


def _get_layout(prs, layout_name: str):
    """
    根据名称获取幻灯片布局

    python-pptx 内置 11 种布局（索引 0-10），名称因模板而异。
    本函数尝试按名称匹配，失败时回退到索引。

    参数：
        prs: Presentation 对象
        layout_name: 布局名称（title / title_content / blank / section_header）

    返回：
        SlideLayout 对象

    异常：
        ValueError: 布局名称不支持
    """
    # 布局名称到 python-pptx 常见模板名称的映射
    layout_aliases = {
        "title": ["Title Slide", "标题幻灯片", "Title"],
        "title_content": ["Title and Content", "标题和内容", "Title and Text"],
        "blank": ["Blank", "空白"],
        "section_header": ["Section Header", "章节标题", "Section Header Two Content"],
    }

    if layout_name not in layout_aliases:
        raise ValueError(f"不支持的布局：{layout_name}（支持：{list(layout_aliases.keys())}）")

    # 尝试按名称匹配
    for alias in layout_aliases[layout_name]:
        for layout in prs.slide_layouts:
            if alias.lower() in layout.name.lower():
                return layout

    # 回退：按索引匹配
    index_map = {"title": 0, "title_content": 1, "blank": 6, "section_header": 2}
    idx = index_map[layout_name]
    if idx < len(prs.slide_layouts):
        return prs.slide_layouts[idx]

    # 最终回退：第一个布局
    return prs.slide_layouts[0]


def add_slide(
    input_file: str,
    layout: str = "title_content",
    title: str | None = None,
    content: str | None = None,
    output_file: str | None = None,
) -> tuple[bool, str]:
    """
    向现有 PPTX 添加新幻灯片

    参数：
        input_file: 输入 .pptx 文件路径
        layout: 布局类型（title / title_content / blank / section_header）
        title: 标题文本（可选）
        content: 内容文本（可选，支持 \n 换行）
        output_file: 输出文件路径（不指定时覆盖原文件）

    返回：
        (success, message) - success 为 True 表示成功
    """
    input_path = Path(input_file)

    # 校验输入文件存在
    if not input_path.exists():
        return False, f"错误：{input_file} 不存在"

    # 校验文件后缀
    if input_path.suffix.lower() != ".pptx":
        return False, f"错误：{input_file} 必须以 .pptx 结尾"

    # 导入 python-pptx（函数内导入，避免脚本启动失败）
    try:
        from pptx import Presentation
        from pptx.util import Inches, Pt
    except ImportError:
        return False, "错误：python-pptx 未安装，请运行 `pip install python-pptx`"

    # 加载演示文稿
    try:
        prs = Presentation(str(input_path))
    except Exception as e:
        return False, f"错误：PPTX 加载失败 - {e}"

    # 获取布局
    try:
        slide_layout = _get_layout(prs, layout)
    except ValueError as e:
        return False, str(e)

    # 添加幻灯片
    slide = prs.slides.add_slide(slide_layout)

    # 填充标题
    if title and slide.shapes.title:
        slide.shapes.title.text = title

    # 建立内容占位符的索引映射（用于多段落文本）
    # 标题占位符通常是 idx=0，内容占位符是 idx=1
    title_ph_idx = 0
    body_ph_idx = 1

    # 填充内容（支持 \n 换行，每行作为独立段落）
    if content:
        # 查找 body placeholder
        body_placeholder = None
        for shape in slide.placeholders:
            if shape.placeholder_format.idx == body_ph_idx:
                body_placeholder = shape
                break

        if body_placeholder:
            # 拆分内容为多段落
            lines = content.split("\n")
            text_frame = body_placeholder.text_frame
            text_frame.clear()
            for i, line in enumerate(lines):
                if i == 0:
                    p = text_frame.paragraphs[0]
                else:
                    p = text_frame.add_paragraph()
                p.text = line
                # 设置字号（默认 18pt，避免过小）
                for run in p.runs:
                    run.font.size = Pt(18)

    # 保存到输出文件
    save_path = Path(output_file) if output_file else input_path
    save_path.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(save_path))

    return True, (
        f"成功添加幻灯片（布局：{layout}）"
        f"{'，标题：' + title if title else ''}"
        f"{'，内容：' + str(len(content.split(chr(10)))) + ' 段落' if content else ''}"
        f"，已保存到 {save_path}"
    )


def main() -> int:
    """
    命令行入口

    返回值：
        0 - 成功
        1 - 参数错误或添加失败
    """
    parser = argparse.ArgumentParser(
        description="向现有 PowerPoint 演示文稿添加新幻灯片"
    )
    parser.add_argument("input_file", help="输入 .pptx 文件路径")
    parser.add_argument(
        "--layout",
        choices=["title", "title_content", "blank", "section_header"],
        default="title_content",
        help="幻灯片布局（默认 title_content）",
    )
    parser.add_argument("--title", help="幻灯片标题文本", default=None)
    parser.add_argument(
        "--content",
        help="幻灯片内容文本（支持 \\n 换行，每行作为独立段落）",
        default=None,
    )
    parser.add_argument(
        "-o", "--output",
        help="输出文件路径（不指定时覆盖原文件）",
        default=None,
    )

    args = parser.parse_args()

    success, message = add_slide(
        args.input_file,
        args.layout,
        args.title,
        args.content,
        args.output,
    )
    print(message)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
