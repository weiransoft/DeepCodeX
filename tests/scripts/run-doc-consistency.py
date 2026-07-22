#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文档对照代码一致性检查 Python wrapper。

职责：
1. 接收命令行参数（项目根目录、文档路径、测试命令）
2. 调用 multi-agent-team 的 DocCodeConsistencyChecker 执行 D1~D6 六大维度检查
3. 输出 JSON 格式的一致性报告
4. 输出人类可读的 Markdown 摘要

使用方式：
    python3 run-doc-consistency.py \\
        --project-root /path/to/project \\
        --prd-path PRD.md \\
        --architecture-path ARCHITECTURE.md \\
        --test-plan-path TEST_PLAN.md \\
        --test-command "npm test" \\
        --output report.json

六大维度：
- D1 功能完成度：文档中每个功能点是否有对应代码实现
- D2 集成完整性：文档定义的模块间集成关系是否在代码中体现
- D3 测试正确性：全部测试通过且覆盖文档功能
- D4 验收标准满足：文档中每条验收标准是否被代码满足
- D5 TODO/FIXME 清零：代码中无残留的未实现 TODO/FIXME
- D6 文档意图遵从：代码实现未偏离文档设计意图

退出码：
- 0 = 检查完成（不表示通过，需要看报告）
- 1 = 检查失败（参数错误、文件不存在等）
- 2 = 检查通过（overall_passed=True）
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional

# multi-agent-team skill 的 scripts 目录路径
# 优先级：环境变量 MULTI_AGENT_TEAM_DIR > 默认路径 ~/.trae-cn/skills/multi-agent-team
DEFAULT_MULTI_AGENT_TEAM_DIR = Path.home() / ".trae-cn" / "skills" / "multi-agent-team"


def find_multi_agent_team_dir() -> Optional[Path]:
    """查找 multi-agent-team skill 目录。

    Returns:
        Optional[Path]: skill 目录路径，未找到返回 None
    """
    # 1. 环境变量优先
    env_dir = os.environ.get("MULTI_AGENT_TEAM_DIR")
    if env_dir:
        path = Path(env_dir)
        if path.exists() and (path / "scripts" / "doc_code_consistency_checker.py").exists():
            return path

    # 2. 默认路径
    if DEFAULT_MULTI_AGENT_TEAM_DIR.exists():
        checker = DEFAULT_MULTI_AGENT_TEAM_DIR / "scripts" / "doc_code_consistency_checker.py"
        if checker.exists():
            return DEFAULT_MULTI_AGENT_TEAM_DIR

    return None


def parse_args() -> argparse.Namespace:
    """解析命令行参数。

    Returns:
        argparse.Namespace: 解析后的参数
    """
    parser = argparse.ArgumentParser(
        description="文档对照代码一致性检查 Python wrapper",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 基本用法
  python3 run-doc-consistency.py \\
    --project-root /path/to/project \\
    --prd-path PRD.md \\
    --architecture-path ARCHITECTURE.md \\
    --test-command "npm test"

  # 输出 JSON 报告
  python3 run-doc-consistency.py \\
    --project-root /path/to/project \\
    --output report.json
        """,
    )
    parser.add_argument(
        "--project-root",
        required=True,
        help="项目根目录路径",
    )
    parser.add_argument(
        "--prd-path",
        default="",
        help="PRD 文档路径（相对 project-root 或绝对路径）",
    )
    parser.add_argument(
        "--architecture-path",
        default="",
        help="架构设计文档路径（相对 project-root 或绝对路径）",
    )
    parser.add_argument(
        "--spec-path",
        default="",
        help="SPEC 规格文档路径（相对 project-root 或绝对路径）",
    )
    parser.add_argument(
        "--test-plan-path",
        default="",
        help="测试计划文档路径（相对 project-root 或绝对路径）",
    )
    parser.add_argument(
        "--test-command",
        default="",
        help="测试执行命令（空字符串则跳过测试检查）",
    )
    parser.add_argument(
        "--test-timeout-sec",
        type=float,
        default=600.0,
        help="测试执行超时时间（秒，默认 600）",
    )
    parser.add_argument(
        "--output",
        default="",
        help="JSON 报告输出路径（不指定则输出到 stdout）",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="输出详细日志",
    )
    return parser.parse_args()


def resolve_doc_path(project_root: Path, doc_path: str) -> Path:
    """解析文档路径（支持相对路径和绝对路径）。

    Args:
        project_root: 项目根目录
        doc_path: 文档路径（相对或绝对）

    Returns:
        Path: 解析后的绝对路径
    """
    path = Path(doc_path)
    if path.is_absolute():
        return path
    return project_root / path


def report_to_dict(report: Any) -> Dict[str, Any]:
    """将 ConsistencyReport 对象转换为字典。

    Args:
        report: ConsistencyReport 对象（dataclass 实例）

    Returns:
        Dict[str, Any]: 字典形式的报告
    """
    # dataclass 转 dict
    import dataclasses

    def _serialize(obj: Any) -> Any:
        """递归序列化对象为 JSON 可序列化形式。"""
        if dataclasses.is_dataclass(obj):
            return {k: _serialize(v) for k, v in dataclasses.asdict(obj).items()}
        if isinstance(obj, list):
            return [_serialize(v) for v in obj]
        if isinstance(obj, dict):
            return {k: _serialize(v) for k, v in obj.items()}
        return obj

    return _serialize(report)


def generate_markdown_summary(report_dict: Dict[str, Any]) -> str:
    """生成人类可读的 Markdown 摘要。

    Args:
        report_dict: 字典形式的报告

    Returns:
        str: Markdown 格式的摘要
    """
    lines = []
    lines.append("# 文档对照代码一致性检查报告")
    lines.append("")
    lines.append(f"> **检查时间**: {report_dict.get('check_time', 'N/A')}")
    lines.append(f"> **项目名称**: {report_dict.get('project_name', 'N/A')}")
    lines.append("")

    # 最终判定
    overall_passed = report_dict.get("overall_passed", False)
    lines.append("## 最终判定")
    lines.append("")
    if overall_passed:
        lines.append("✅ **通过**：所有维度检查均通过，可发布。")
    else:
        lines.append("❌ **不通过**：存在未通过的维度，需要修复后重新检查。")
    lines.append("")

    # D1 功能完成度
    feature_checks = report_dict.get("feature_checks", [])
    implemented = sum(1 for f in feature_checks if f.get("status") == "implemented")
    missing = sum(1 for f in feature_checks if f.get("status") == "missing")
    lines.append("## D1 功能完成度")
    lines.append("")
    lines.append(f"- 已实现: {implemented}")
    lines.append(f"- 未实现: {missing}")
    if feature_checks:
        implementation_rate = implemented * 100 // len(feature_checks)
        lines.append(f"- 实现率: {implementation_rate}%")
    lines.append("")

    # D2 集成完整性
    integration_checks = report_dict.get("integration_checks", [])
    connected = sum(1 for i in integration_checks if i.get("status") == "connected")
    missing_int = sum(1 for i in integration_checks if i.get("status") == "missing")
    lines.append("## D2 集成完整性")
    lines.append("")
    lines.append(f"- 已连接: {connected}")
    lines.append(f"- 未连接: {missing_int}")
    if integration_checks:
        integration_rate = connected * 100 // len(integration_checks)
        lines.append(f"- 集成率: {integration_rate}%")
    lines.append("")

    # D3 测试正确性
    test_result = report_dict.get("test_result")
    lines.append("## D3 测试正确性")
    lines.append("")
    if test_result:
        lines.append(f"- 通过: {test_result.get('passed', 0)}")
        lines.append(f"- 失败: {test_result.get('failed', 0)}")
        lines.append(f"- 跳过: {test_result.get('skipped', 0)}")
        lines.append(f"- 覆盖功能: {len(test_result.get('covered_features', []))}")
        lines.append(f"- 未覆盖功能: {len(test_result.get('uncovered_features', []))}")
        lines.append(f"- 执行耗时: {test_result.get('duration_sec', 0):.2f}s")
    else:
        lines.append("- 未执行测试（无测试命令或测试未运行）")
    lines.append("")

    # D4 验收标准满足
    acceptance_checks = report_dict.get("acceptance_checks", [])
    satisfied = sum(1 for a in acceptance_checks if a.get("status") == "satisfied")
    unsatisfied = sum(1 for a in acceptance_checks if a.get("status") == "unsatisfied")
    lines.append("## D4 验收标准满足")
    lines.append("")
    lines.append(f"- 已满足: {satisfied}")
    lines.append(f"- 未满足: {unsatisfied}")
    if acceptance_checks:
        satisfaction_rate = satisfied * 100 // len(acceptance_checks)
        lines.append(f"- 满足率: {satisfaction_rate}%")
    lines.append("")

    # D5 TODO/FIXME
    todo_items = report_dict.get("todo_items", [])
    lines.append("## D5 TODO/FIXME 清零")
    lines.append("")
    lines.append(f"- TODO/FIXME 总数: {len(todo_items)}")
    unimplemented_todos = [t for t in todo_items if not t.get("has_implementation", False)]
    lines.append(f"- 未实现: {len(unimplemented_todos)}")
    lines.append("")

    # D6 文档意图遵从
    deviation_items = report_dict.get("deviation_items", [])
    lines.append("## D6 文档意图遵从")
    lines.append("")
    lines.append(f"- 偏离项数: {len(deviation_items)}")
    high_severity = [d for d in deviation_items if d.get("severity") == "high"]
    medium_severity = [d for d in deviation_items if d.get("severity") == "medium"]
    low_severity = [d for d in deviation_items if d.get("severity") == "low"]
    lines.append(f"- 高严重度: {len(high_severity)}")
    lines.append(f"- 中严重度: {len(medium_severity)}")
    lines.append(f"- 低严重度: {len(low_severity)}")
    lines.append("")

    # 缺口清单
    gap_list = report_dict.get("gap_list", [])
    if gap_list:
        lines.append("## 缺口清单")
        lines.append("")
        lines.append("| 维度 | 优先级 | 描述 | 建议 |")
        lines.append("|------|--------|------|------|")
        for gap in gap_list:
            lines.append(
                f"| {gap.get('dimension', '')} | {gap.get('priority', '')} | "
                f"{gap.get('description', '')} | {gap.get('suggestion', '')} |"
            )
        lines.append("")

    return "\n".join(lines)


def main() -> int:
    """CLI 主入口。

    Returns:
        int: 退出码（0=完成；1=失败；2=通过）
    """
    args = parse_args()

    # 解析项目根目录
    project_root = Path(args.project_root).resolve()
    if not project_root.exists():
        print(f"错误：项目根目录不存在: {project_root}", file=sys.stderr)
        return 1

    # 查找 multi-agent-team skill 目录
    multi_agent_team_dir = find_multi_agent_team_dir()
    if multi_agent_team_dir is None:
        print(
            "错误：未找到 multi-agent-team skill 目录。\n"
            "请设置环境变量 MULTI_AGENT_TEAM_DIR 或确保默认路径存在：\n"
            f"  {DEFAULT_MULTI_AGENT_TEAM_DIR}",
            file=sys.stderr,
        )
        return 1

    # 将 scripts 目录添加到 sys.path
    scripts_dir = multi_agent_team_dir / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))

    # 导入 DocCodeConsistencyChecker
    try:
        from doc_code_consistency_checker import DocCodeConsistencyChecker  # type: ignore
    except ImportError as e:
        print(
            f"错误：无法导入 DocCodeConsistencyChecker: {e}\n"
            f"请检查 {scripts_dir / 'doc_code_consistency_checker.py'} 是否存在",
            file=sys.stderr,
        )
        return 1

    # 构造文档路径字典
    doc_paths: Dict[str, Path] = {}
    if args.prd_path:
        doc_paths["prd"] = resolve_doc_path(project_root, args.prd_path)
    if args.architecture_path:
        doc_paths["architecture"] = resolve_doc_path(project_root, args.architecture_path)
    if args.spec_path:
        doc_paths["spec"] = resolve_doc_path(project_root, args.spec_path)
    if args.test_plan_path:
        doc_paths["test_plan"] = resolve_doc_path(project_root, args.test_plan_path)

    # 验证文档路径存在
    for doc_type, doc_path in doc_paths.items():
        if not doc_path.exists():
            print(f"警告：{doc_type} 文档不存在: {doc_path}", file=sys.stderr)

    if args.verbose:
        print(f"项目根目录: {project_root}", file=sys.stderr)
        print(f"文档路径: {doc_paths}", file=sys.stderr)
        print(f"测试命令: {args.test_command or '(无)'}", file=sys.stderr)
        print(f"测试超时: {args.test_timeout_sec}s", file=sys.stderr)

    # 创建检查器实例
    checker = DocCodeConsistencyChecker(
        project_root=project_root,
        doc_paths=doc_paths,
        test_command=args.test_command,
        test_timeout_sec=args.test_timeout_sec,
    )

    # 执行检查
    try:
        report = checker.check_all()
    except Exception as e:
        print(f"错误：检查过程中发生异常: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return 1

    # 转换为字典
    report_dict = report_to_dict(report)

    # 输出 JSON 报告
    report_json = json.dumps(report_dict, ensure_ascii=False, indent=2, default=str)
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(report_json, encoding="utf-8")
        if args.verbose:
            print(f"JSON 报告已写入: {output_path}", file=sys.stderr)
    else:
        print(report_json)

    # 输出 Markdown 摘要到 stderr（不干扰 JSON 输出）
    if args.verbose or not args.output:
        markdown = generate_markdown_summary(report_dict)
        if args.output:
            # 同时输出 Markdown 文件
            md_path = Path(args.output).with_suffix(".md")
            md_path.write_text(markdown, encoding="utf-8")
            if args.verbose:
                print(f"Markdown 报告已写入: {md_path}", file=sys.stderr)
        else:
            print("\n" + markdown, file=sys.stderr)

    # 返回退出码
    if report_dict.get("overall_passed", False):
        return 2  # 通过
    return 0  # 完成（但未通过）


if __name__ == "__main__":
    sys.exit(main())
