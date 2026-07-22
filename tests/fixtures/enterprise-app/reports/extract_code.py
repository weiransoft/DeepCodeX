#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 LLM 输出中提取代码块并写入文件（v2.1.2 增强：支持多种路径标识格式）。

职责：
1. 解析 markdown 代码块（```language ... ``` 格式）
2. 支持的路径标识格式（v2.1.2 四种格式全支持）：
   a. 语言标识符后：```typescript path://src/auth/jwt.ts
   b. 代码块内首行 // 注释（path:// 格式）：```typescript\n// path://src/auth/jwt.ts
   c. 代码块内首行 # 注释（path:// 格式）：```python\n# path://scripts/foo.py
   d. 代码块内首行 // 注释（path: 格式，v2.1.2 新增）：```typescript\n// path: src/utils/errors.ts
3. 将代码块写入对应文件路径
4. 输出提取报告（提取了哪些文件、行数）
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import List, Tuple

# 通用代码块正则：匹配 ```lang ...\n...```（lang 可选，代码内容非贪婪匹配）
# 用于第一轮切分所有代码块，再在代码块内查找路径标识
GENERIC_CODE_BLOCK_PATTERN = re.compile(
    r"```([a-zA-Z0-9_+-]+)?[ \t]*\n(.*?)```",
    re.DOTALL,
)

# 格式 a 正则：path:// 在语言标识符后（```typescript path://src/auth/jwt.ts）
PATH_AFTER_LANG_PATTERN = re.compile(
    r"```(?:typescript|ts|javascript|js|python|py|bash|sh|json|yaml|md|markdown)[ \t]+path://([^\s\n]+)",
)

# 格式 b/c/d 正则：path 标识在代码块内首行注释中
# v2.1.2 增强：同时支持 path:// 和 path: 两种格式
#   // path://src/auth/jwt.ts   → 捕获 src/auth/jwt.ts
#   # path://scripts/foo.py     → 捕获 scripts/foo.py
#   // path: src/utils/errors.ts → 捕获 src/utils/errors.ts（v2.1.2 新增）
PATH_IN_COMMENT_PATTERN = re.compile(
    r"^(?://|#)[ \t]*path:(?://)?[ \t]*([^\s\n]+)",
    re.MULTILINE,
)

# 备用正则：匹配文件路径注释（// File: src/auth/jwt.ts 或 # File: scripts/foo.py）
# v2.1.2 增强：支持小写 path:
FILE_COMMENT_PATTERN = re.compile(
    r"^(?://|#|<!--)[ \t]*(?:File|文件|路径|Path|path):[ \t]*([^\s]+)[ \t]*$",
    re.MULTILINE,
)


def extract_code_blocks(content: str) -> List[Tuple[str, str]]:
    """从 markdown 内容中提取代码块。

    v2.1.2 增强：支持四种路径标识位置
      a. 语言标识符后：```typescript path://...
      b. 代码块内首行 // 注释（path:// 格式）：```typescript\n// path://...
      c. 代码块内首行 # 注释（path:// 格式）：```python\n# path://...
      d. 代码块内首行 // 注释（path: 格式，v2.1.2 新增）：```typescript\n// path: src/utils/errors.ts

    Args:
        content: markdown 文本

    Returns:
        List[Tuple[str, str]]: (文件路径, 代码内容) 列表
    """
    blocks: List[Tuple[str, str]] = []

    # 第一轮：切分所有代码块，逐个提取路径标识
    for match in GENERIC_CODE_BLOCK_PATTERN.finditer(content):
        # 代码块完整内容（含可能的路径注释首行）
        code_with_path = match.group(2)
        path = None

        # 尝试格式 a：path:// 在语言标识符后
        # 需要检查代码块开头的 ```lang 部分
        block_start = content[match.start():match.start() + 200]
        lang_path_match = PATH_AFTER_LANG_PATTERN.search(block_start)
        if lang_path_match:
            path = lang_path_match.group(1).strip()

        # 尝试格式 b/c/d：路径标识在代码块内首行注释中（支持 path:// 和 path: 两种格式）
        if not path:
            # 只在代码块内容的前 500 字符中查找（路径标识通常在首行）
            head = code_with_path[:500]
            comment_match = PATH_IN_COMMENT_PATTERN.search(head)
            if comment_match:
                path = comment_match.group(1).strip()
                # 从代码内容中移除路径注释行（避免写入文件时包含元信息）
                code_with_path = PATH_IN_COMMENT_PATTERN.sub("", code_with_path, count=1)

        # 尝试备用格式：// File: ... 或 # File: ...
        if not path:
            head = code_with_path[:500]
            file_match = FILE_COMMENT_PATTERN.search(head)
            if file_match:
                path = file_match.group(1).strip()
                code_with_path = FILE_COMMENT_PATTERN.sub("", code_with_path, count=1)

        if path and code_with_path.strip():
            blocks.append((path, code_with_path.rstrip() + "\n"))

    return blocks


def write_files(base_dir: Path, blocks: List[Tuple[str, str]]) -> List[Tuple[str, int]]:
    """将代码块写入文件。

    Args:
        base_dir: 基础目录
        blocks: (文件路径, 代码内容) 列表

    Returns:
        List[Tuple[str, int]]: (文件路径, 行数) 列表
    """
    written: List[Tuple[str, int]] = []
    for rel_path, code in blocks:
        # 安全检查：禁止绝对路径和 .. 路径
        if rel_path.startswith("/") or ".." in rel_path:
            print(f"跳过不安全路径: {rel_path}", file=sys.stderr)
            continue

        file_path = base_dir / rel_path
        # 创建父目录
        file_path.parent.mkdir(parents=True, exist_ok=True)
        # 写入文件
        file_path.write_text(code, encoding="utf-8")
        line_count = code.count("\n") + (0 if code.endswith("\n") else 1)
        written.append((rel_path, line_count))
        print(f"写入: {rel_path} ({line_count} 行)")

    return written


def main() -> int:
    """CLI 主入口。

    Usage:
        python3 extract_code.py <input.md> <base_dir>

    Args:
        input.md: LLM 输出文件
        base_dir: 代码写入基础目录

    Returns:
        int: 退出码（0=成功；1=未提取到代码）
    """
    if len(sys.argv) != 3:
        print("Usage: extract_code.py <input.md> <base_dir>", file=sys.stderr)
        return 1

    input_file = Path(sys.argv[1])
    base_dir = Path(sys.argv[2])

    if not input_file.exists():
        print(f"输入文件不存在: {input_file}", file=sys.stderr)
        return 1

    content = input_file.read_text(encoding="utf-8")
    blocks = extract_code_blocks(content)

    if not blocks:
        print(f"未在 {input_file} 中提取到代码块", file=sys.stderr)
        return 1

    print(f"提取到 {len(blocks)} 个代码块：")
    written = write_files(base_dir, blocks)
    print(f"\n成功写入 {len(written)} 个文件")
    return 0 if written else 1


if __name__ == "__main__":
    sys.exit(main())
