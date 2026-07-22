#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""命令超时包装器（macOS 没有 timeout 命令，用 Python 实现等价功能）。

用法：
    python3 timeout.py <seconds> <command> [args...]

行为：
    - 在 <seconds> 秒后终止命令（SIGTERM）
    - 5 秒后若命令仍未退出，强制 SIGKILL
    - 退出码与命令一致；超时则退出码 124（与 GNU timeout 一致）
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from typing import List


def main() -> int:
    """CLI 主入口。

    Returns:
        int: 退出码（0=成功；124=超时；其他=命令自身退出码）
    """
    if len(sys.argv) < 3:
        print("Usage: timeout.py <seconds> <command> [args...]", file=sys.stderr)
        return 2

    # 解析超时秒数
    try:
        timeout_sec = float(sys.argv[1])
    except ValueError:
        print(f"无效的超时秒数: {sys.argv[1]}", file=sys.stderr)
        return 2

    # 待执行的命令
    cmd: List[str] = sys.argv[2:]

    # 启动子进程（继承 stdin/stdout/stderr）
    try:
        proc = subprocess.Popen(cmd)
    except FileNotFoundError:
        print(f"命令不存在: {cmd[0]}", file=sys.stderr)
        return 127

    # 等待命令完成或超时
    start_time = time.time()
    while True:
        ret = proc.poll()
        if ret is not None:
            # 命令已退出
            return ret

        elapsed = time.time() - start_time
        if elapsed >= timeout_sec:
            # 超时：先 SIGTERM
            print(
                f"\n[timeout.py] 命令超时（{timeout_sec}s），发送 SIGTERM...",
                file=sys.stderr,
            )
            proc.terminate()
            # 等待 5 秒，若仍未退出则 SIGKILL
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                print("[timeout.py] 5 秒后仍未退出，发送 SIGKILL...", file=sys.stderr)
                proc.kill()
                proc.wait(timeout=3)
            return 124

        # 短暂 sleep，避免 busy loop
        time.sleep(0.2)


if __name__ == "__main__":
    sys.exit(main())
