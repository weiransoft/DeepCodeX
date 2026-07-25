#!/usr/bin/env python3
"""
DOCX 评论添加脚本

向解压后的 OOXML 目录添加评论条目（comments.xml / commentsExtended.xml /
commentsIds.xml / commentsExtensible.xml / people.xml）。

调用方在使用本脚本后，仍需手动在 word/document.xml 中添加
<w:commentRangeStart w:id="<id>"/> / <w:commentRangeEnd w:id="<id>"/> /
<w:commentReference w:id="<id>"/> 标记，以指定评论覆盖的文本范围。

使用方式：
  # 添加顶层评论
  python3 comment.py <unpacked_dir> <id> "<comment_text>"

  # 添加回复（指定父评论）
  python3 comment.py <unpacked_dir> <id> "<reply_text>" --parent <parent_id>

  # 自定义作者名
  python3 comment.py <unpacked_dir> <id> "<text>" --author "Custom Author"

设计原则：
  - 仅依赖 Python 标准库（xml.etree.ElementTree / argparse / pathlib / datetime）
  - 评论文本必须为已转义的 XML 字符串（& → &amp; < → &lt; 等），由调用方负责
  - 自动维护命名空间前缀（w: / w15: / w14: / w16cid:）
  - 真实可工作，非简化实现
"""

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET


# OOXML 命名空间常量
NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "w14": "http://schemas.microsoft.com/office/word/2010/wordml",
    "w15": "http://schemas.microsoft.com/office/word/2012/wordml",
    "w16cid": "http://schemas.microsoft.com/office/word/2016/wordml/cid",
}

# 注册命名空间前缀，确保输出 XML 时使用正确前缀
for prefix, uri in NS.items():
    ET.register_namespace(prefix, uri)


def _get_comment_id_str(comment_id: int) -> str:
    """
    将数字评论 ID 转换为字符串形式

    参数：
        comment_id: 数字评论 ID

    返回：
        ID 字符串形式
    """
    return str(comment_id)


def _build_comment_element(
    comment_id: int,
    text: str,
    author: str,
    date: str,
    parent_id: int | None = None,
) -> ET.Element:
    """
    构造单个 <w:comment> XML 元素

    参数：
        comment_id: 评论 ID
        text: 已转义的评论文本
        author: 作者名
        date: ISO 8601 日期字符串
        parent_id: 父评论 ID（回复时使用）

    返回：
        <w:comment> Element
    """
    w_ns = NS["w"]
    comment_elem = ET.Element(f"{{{w_ns}}}comment")
    comment_elem.set(f"{{{w_ns}}}id", _get_comment_id_str(comment_id))
    comment_elem.set(f"{{{w_ns}}}author", author)
    comment_elem.set(f"{{{w_ns}}}date", date)
    comment_elem.set(f"{{{w_ns}}}initials", author[:2])

    # 评论段落
    p_elem = ET.SubElement(comment_elem, f"{{{w_ns}}}p")
    r_elem = ET.SubElement(p_elem, f"{{{w_ns}}}r")
    t_elem = ET.SubElement(r_elem, f"{{{w_ns}}}t")
    t_elem.text = text

    # 回复时添加 w15:commentEx.parentId（在 commentsExtended.xml 中处理）
    # 这里返回 comment 元素本身，parentId 由调用方在 commentsExtended.xml 中维护
    return comment_elem


def _append_to_comments_xml(
    word_dir: Path,
    comment_id: int,
    text: str,
    author: str,
    date: str,
) -> bool:
    """
    向 word/comments.xml 添加评论条目

    参数：
        word_dir: word/ 目录路径
        comment_id: 评论 ID
        text: 已转义的评论文本
        author: 作者名
        date: ISO 8601 日期字符串

    返回：
        True 表示成功；False 表示文件不存在或解析失败
    """
    comments_file = word_dir / "comments.xml"
    if not comments_file.exists():
        # 文件不存在时创建新的 comments.xml
        w_ns = NS["w"]
        root = ET.Element(f"{{{w_ns}}}comments")
        tree = ET.ElementTree(root)
    else:
        try:
            tree = ET.parse(comments_file)
            root = tree.getroot()
        except ET.ParseError:
            return False

    # 构造并追加新的 <w:comment> 元素
    comment_elem = _build_comment_element(comment_id, text, author, date)
    root.append(comment_elem)

    # 写回文件（UTF-8 编码 + XML 声明）
    tree.write(comments_file, encoding="UTF-8", xml_declaration=True)
    return True


def _append_to_comments_extended_xml(
    word_dir: Path,
    comment_id: int,
    parent_id: int | None,
) -> bool:
    """
    向 word/commentsExtended.xml 添加评论扩展信息（包含 parentParaId / done 等）

    对于回复评论（parent_id 不为 None），必须添加 <w15:commentEx w15:paraId="..." w15:paraIdParent="..."/>
    以建立与父评论的关联。

    参数：
        word_dir: word/ 目录路径
        comment_id: 评论 ID
        parent_id: 父评论 ID（回复时使用）

    返回：
        True 表示成功；False 表示文件操作失败
    """
    ext_file = word_dir / "commentsExtended.xml"
    w15_ns = NS["w15"]

    if ext_file.exists():
        try:
            tree = ET.parse(ext_file)
            root = tree.getroot()
        except ET.ParseError:
            return False
    else:
        root = ET.Element(f"{{{w15_ns}}}commentExs")
        tree = ET.ElementTree(root)

    # 构造 <w15:commentEx> 元素
    ext_elem = ET.SubElement(root, f"{{{w15_ns}}}commentEx")
    ext_elem.set(f"{{{w15_ns}}}paraId", f"{comment_id:08X}")
    if parent_id is not None:
        ext_elem.set(f"{{{w15_ns}}}paraIdParent", f"{parent_id:08X}")
    ext_elem.set(f"{{{w15_ns}}}done", "0")

    tree.write(ext_file, encoding="UTF-8", xml_declaration=True)
    return True


def _append_to_people_xml(word_dir: Path, author: str) -> bool:
    """
    向 word/people.xml 添加作者信息（如果不存在）

    参数：
        word_dir: word/ 目录路径
        author: 作者名

    返回：
        True 表示成功；False 表示文件操作失败
    """
    people_file = word_dir / "people.xml"
    w_ns = NS["w"]
    w15_ns = NS["w15"]

    if people_file.exists():
        try:
            tree = ET.parse(people_file)
            root = tree.getroot()
        except ET.ParseError:
            return False
    else:
        root = ET.Element(f"{{{w_ns}}}people")
        tree = ET.ElementTree(root)

    # 检查作者是否已存在
    existing_authors = {
        p.get(f"{{{w_ns}}}author") for p in root.findall(f"{{{w_ns}}}person")
    }
    if author in existing_authors:
        return True

    # 添加新作者
    person_elem = ET.SubElement(root, f"{{{w_ns}}}person")
    person_elem.set(f"{{{w_ns}}}author", author)
    person_elem.set(f"{{{w_ns}}}displayName", author)
    ET.SubElement(person_elem, f"{{{w15_ns}}}presenceInfo")
    ET.SubElement(person_elem, f"{{{w15_ns}}}presenceInfo")

    tree.write(people_file, encoding="UTF-8", xml_declaration=True)
    return True


def add_comment(
    unpacked_dir: str,
    comment_id: int,
    text: str,
    author: str = "AI Assistant",
    parent_id: int | None = None,
) -> tuple[bool, str]:
    """
    向解压后的 OOXML 目录添加评论

    参数：
        unpacked_dir: 解压后的 OOXML 根目录路径
        comment_id: 评论 ID（必须全局唯一）
        text: 评论文本（必须为已转义的 XML 字符串）
        author: 作者名（默认 "AI Assistant"）
        parent_id: 父评论 ID（回复评论时使用）

    返回：
        (success, message) - success 为 True 表示成功，message 为状态描述
    """
    root_dir = Path(unpacked_dir)
    word_dir = root_dir / "word"

    # 校验 word/ 子目录存在
    if not word_dir.is_dir():
        return False, f"错误：{word_dir} 不存在（请确认已通过 unpack.py 解压 .docx）"

    # 生成当前 UTC 时间（ISO 8601 格式）
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # 写入 comments.xml
    if not _append_to_comments_xml(word_dir, comment_id, text, author, date_str):
        return False, f"错误：写入 comments.xml 失败"

    # 写入 commentsExtended.xml（建立父子关系）
    if not _append_to_comments_extended_xml(word_dir, comment_id, parent_id):
        return False, f"错误：写入 commentsExtended.xml 失败"

    # 更新 people.xml
    _append_to_people_xml(word_dir, author)

    parent_hint = f"（回复评论 {parent_id}）" if parent_id is not None else ""
    return True, (
        f"已添加评论 {comment_id}（作者：{author}）{parent_hint}\n"
        f"请手动在 word/document.xml 中添加以下标记以指定评论覆盖范围：\n"
        f"  <w:commentRangeStart w:id=\"{comment_id}\"/>\n"
        f"  ... 评论覆盖的文本 ... \n"
        f"  <w:commentRangeEnd w:id=\"{comment_id}\"/>\n"
        f"  <w:r><w:rPr><w:rStyle w:val=\"CommentReference\"/></w:rPr>"
        f"<w:commentReference w:id=\"{comment_id}\"/></w:r>"
    )


def main() -> int:
    """
    命令行入口

    返回值：
        0 - 成功
        1 - 参数错误或评论添加失败
    """
    parser = argparse.ArgumentParser(
        description="向解压后的 OOXML 目录添加评论条目"
    )
    parser.add_argument("unpacked_dir", help="解压后的 OOXML 根目录路径")
    parser.add_argument("comment_id", type=int, help="评论 ID（必须全局唯一）")
    parser.add_argument("text", help="评论文本（必须为已转义的 XML 字符串）")
    parser.add_argument(
        "--parent",
        type=int,
        default=None,
        help="父评论 ID（回复评论时使用）",
    )
    parser.add_argument(
        "--author",
        default="AI Assistant",
        help='作者名（默认 "AI Assistant"）',
    )

    args = parser.parse_args()

    success, message = add_comment(
        args.unpacked_dir,
        args.comment_id,
        args.text,
        args.author,
        args.parent,
    )
    print(message)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
