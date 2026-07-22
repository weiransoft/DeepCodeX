#!/usr/bin/env bash
# ==============================================================================
# 企业应用 E2E 测试脚本：通过 DeepCodeX CLI 调用多角色团队产出代码
#
# 测试目标：
#   1. 验证 DeepCodeX CLI team 子命令调用链路正常（list/match/dispatch）
#   2. 通过 CLI 真实调用 LLM 让多角色团队产出企业应用代码
#   3. 调用 Python DocCodeConsistencyChecker 检测产出与文档一致性（D1~D6）
#   4. 运行企业应用单元测试，验证代码质量
#
# 设计依据：
#   - tests/fixtures/enterprise-app/PRD.md（产品需求文档）
#   - tests/fixtures/enterprise-app/ARCHITECTURE.md（架构设计文档）
#   - tests/fixtures/enterprise-app/TEST_PLAN.md（测试计划）
#   - packages/cli/src/team/team-cmd.ts（team 子命令实现）
#   - multi-agent-team/scripts/doc_code_consistency_checker.py（一致性检查器）
#
# 测试流程：
#   Stage A: CLI 调用链路验证（list/match，无 LLM）
#   Stage B: 多角色团队真实调用 LLM 产出代码（dispatch 5 个角色）
#   Stage C: 文档对照一致性检测（Python DocCodeConsistencyChecker）
#   Stage D: 企业应用单元测试执行（npm test）
#   Stage E: 产出一致性报告生成
#
# 退出码语义：
#   0 = 全部通过
#   1 = 部分失败（详见报告）
#   2 = 环境错误（CLI 缺失、API Key 缺失等）
# ==============================================================================

set -uo pipefail

# ---------- 全局变量 ----------
TOTAL_CASES=0
PASSED_CASES=0
FAILED_CASES=0
FAILED_CASES_LIST=()
STAGE_RESULTS=()

# ---------- 日志工具 ----------
log() {
  echo "[e2e-enterprise-app] $*"
}

fail_log() {
  echo "[e2e-enterprise-app] ❌ $*" >&2
}

stage_log() {
  echo ""
  echo "[e2e-enterprise-app] ========== $* =========="
}

# ---------- 环境预检 ----------
stage_log "环境预检"

command -v node >/dev/null 2>&1 || { fail_log "未找到 node"; exit 2; }
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "${NODE_MAJOR}" -ge 20 ] || { fail_log "node 版本过低（需要 >= 20）"; exit 2; }

command -v python3 >/dev/null 2>&1 || { fail_log "未找到 python3"; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CLI_DIR="${PROJECT_ROOT}/packages/cli"
CLI_ENTRY="${CLI_DIR}/src/cli.tsx"
FIXTURE_DIR="${PROJECT_ROOT}/tests/fixtures/enterprise-app"
MULTI_AGENT_TEAM_DIR="${HOME}/.trae-cn/skills/multi-agent-team"
DOC_CHECKER="${MULTI_AGENT_TEAM_DIR}/scripts/doc_code_consistency_checker.py"
RUN_WORKFLOW_LOOP="${MULTI_AGENT_TEAM_DIR}/scripts/run_workflow_loop.py"

[ -f "${CLI_ENTRY}" ] || { fail_log "未找到 CLI 入口: ${CLI_ENTRY}"; exit 2; }
[ -d "${PROJECT_ROOT}/packages/core/src/team" ] || { fail_log "未找到 team 模块"; exit 2; }
[ -f "${FIXTURE_DIR}/PRD.md" ] || { fail_log "未找到 fixture PRD.md"; exit 2; }
[ -f "${FIXTURE_DIR}/ARCHITECTURE.md" ] || { fail_log "未找到 fixture ARCHITECTURE.md"; exit 2; }
[ -f "${FIXTURE_DIR}/TEST_PLAN.md" ] || { fail_log "未找到 fixture TEST_PLAN.md"; exit 2; }
[ -f "${DOC_CHECKER}" ] || { fail_log "未找到 DocCodeConsistencyChecker: ${DOC_CHECKER}"; exit 2; }

log "✅ 环境预检通过"

# ---------- 创建产物目录 ----------
REPORTS_DIR="${FIXTURE_DIR}/reports"
LLM_OUTPUTS_DIR="${REPORTS_DIR}/llm-outputs"
mkdir -p "${REPORTS_DIR}" "${LLM_OUTPUTS_DIR}"

# ---------- 构造 CLI 命令 ----------
CLI_CMD="node --import tsx ${CLI_ENTRY}"

# ---------- 超时命令（macOS 没有 timeout，用 Python 包装器） ----------
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
else
  TIMEOUT_CMD="python3 ${SCRIPT_DIR}/timeout.py"
fi

# ---------- 测试用例执行函数 ----------
run_case() {
  local case_id="$1"
  local case_desc="$2"
  local expected_exit="$3"
  local expected_output="$4"
  local cmd="$5"
  local output_file="$6"

  TOTAL_CASES=$((TOTAL_CASES + 1))
  log ""
  log "--- [${case_id}] ${case_desc} ---"
  log "命令: ${cmd}"

  local output
  set +e
  # 添加 < /dev/null 防止 TUI 在非交互环境下挂起等待输入
  output=$(eval "${cmd}" 2>&1 < /dev/null)
  local actual_exit=$?
  set -e

  # 保存输出到文件（如果有指定）
  if [ -n "${output_file}" ]; then
    echo "${output}" > "${output_file}"
    log "输出已保存到: ${output_file}"
  fi

  local exit_ok=1
  if [ "${expected_exit}" != "-1" ]; then
    if [ "${actual_exit}" != "${expected_exit}" ]; then
      exit_ok=0
      fail_log "${case_id} 退出码不匹配: expected=${expected_exit}, actual=${actual_exit}"
    fi
  fi

  local output_ok=1
  if [ -n "${expected_output}" ]; then
    if ! echo "${output}" | grep -qiE "${expected_output}"; then
      output_ok=0
      fail_log "${output_ok} ${case_id} 输出不包含期望字符串: '${expected_output}'"
      fail_log "实际输出（前 300 字符）: $(echo "${output}" | head -c 300)"
    fi
  fi

  if [ "${exit_ok}" -eq 1 ] && [ "${output_ok}" -eq 1 ]; then
    PASSED_CASES=$((PASSED_CASES + 1))
    log "✅ ${case_id} 通过"
    STAGE_RESULTS+=("${case_id}: PASS")
  else
    FAILED_CASES=$((FAILED_CASES + 1))
    FAILED_CASES_LIST+=("${case_id}")
    STAGE_RESULTS+=("${case_id}: FAIL")
  fi
}

# ==============================================================================
# Stage A: CLI 调用链路验证（无 LLM）
# ==============================================================================
stage_log "Stage A: CLI 调用链路验证"

# TC-E2E-A01: team list 列出 5 个核心角色
run_case "TC-E2E-A01" \
  "team list 列出 5 个核心角色" \
  0 \
  "architect|product-manager|test-expert|solo-coder|ui-designer" \
  "${CLI_CMD} team list" \
  "${LLM_OUTPUTS_DIR}/team-list.txt"

# TC-E2E-A02: team match 关键词匹配（架构师）
run_case "TC-E2E-A02" \
  "team match 关键词匹配（架构师）" \
  0 \
  "architect|confidence|roleId" \
  "${CLI_CMD} team match --keywords 架构,设计,模块" \
  "${LLM_OUTPUTS_DIR}/team-match-architect.txt"

# TC-E2E-A03: team match 关键词匹配（测试专家）
run_case "TC-E2E-A03" \
  "team match 关键词匹配（测试专家）" \
  0 \
  "test-expert|confidence|roleId" \
  "${CLI_CMD} team match --keywords 测试,质量,自动化" \
  "${LLM_OUTPUTS_DIR}/team-match-test.txt"

# TC-E2E-A04: team match 关键词匹配（独立开发者）
run_case "TC-E2E-A04" \
  "team match 关键词匹配（独立开发者）" \
  0 \
  "solo-coder|confidence|roleId" \
  "${CLI_CMD} team match --keywords 实现,开发,代码" \
  "${LLM_OUTPUTS_DIR}/team-match-coder.txt"

# ==============================================================================
# Stage B: 多角色团队真实调用 LLM 产出代码
# ==============================================================================
stage_log "Stage B: 多角色团队真实调用 LLM 产出代码"

# 设置 API Key 超时
# v2.1.3 调整：从 300 秒（5 分钟）调整为 1200 秒（20 分钟）
# 原因：续写机制启用后，单次 dispatch 可能触发最多 3 次续写（首次 + 3 次 = 4 次 LLM 调用）
# 每次调用最长 5 分钟，总时长可达 20 分钟。LLM_TIMEOUT 需容纳续写场景。
LLM_TIMEOUT=1200

# 将 task 描述保存到文件，避免 shell 转义问题
TASK_DIR="${REPORTS_DIR}/tasks"
mkdir -p "${TASK_DIR}"

# TC-E2E-B01: 架构师审查 PRD 和 ARCHITECTURE
# v2.1.1 E2E 修正：使用 --task-file 替代 --task，避免 shell 转义问题
# 原因：task 描述嵌入完整 PRD/ARCHITECTURE 文档，含 <token> ?name=xxx 等特殊字符
#       使用 --task "..." 会被 eval 展开为 shell 命令，导致 LLM 输出全是 shell 错误信息
cat > "${TASK_DIR}/architect-task.txt" << 'EOF'
请审查下方提供的企业应用 PRD 和 ARCHITECTURE 设计文档，重点检查：
1. 12 个功能点（F-001 ~ F-012）是否覆盖订单管理 REST API 的核心需求
2. 17 个验收标准（AC-001 ~ AC-017）是否可验证
3. 6 个集成关系（INT-001 ~ INT-006）是否合理
4. 模块划分（auth/products/orders/inventory）是否清晰
5. 错误处理层级（NotFoundError/ValidationError/InsufficientStockError/AuthenticationError）是否完整

请输出审查报告，包含：通过项、问题项、改进建议。

=== PRD.md 内容开始 ===
EOF
cat "${FIXTURE_DIR}/PRD.md" >> "${TASK_DIR}/architect-task.txt"
echo "" >> "${TASK_DIR}/architect-task.txt"
echo "=== PRD.md 内容结束 ===" >> "${TASK_DIR}/architect-task.txt"
echo "" >> "${TASK_DIR}/architect-task.txt"
echo "=== ARCHITECTURE.md 内容开始 ===" >> "${TASK_DIR}/architect-task.txt"
cat "${FIXTURE_DIR}/ARCHITECTURE.md" >> "${TASK_DIR}/architect-task.txt"
echo "" >> "${TASK_DIR}/architect-task.txt"
echo "=== ARCHITECTURE.md 内容结束 ===" >> "${TASK_DIR}/architect-task.txt"
echo "" >> "${TASK_DIR}/architect-task.txt"
echo "请根据上述文档内容，输出审查报告。" >> "${TASK_DIR}/architect-task.txt"

# v2.1.1 E2E：使用 --task-file 直接传递文件路径，shell 不需要展开 task 内容
run_case "TC-E2E-B01" \
  "架构师审查 PRD 和 ARCHITECTURE" \
  -1 \
  "DispatchResult|status" \
  "${TIMEOUT_CMD} ${LLM_TIMEOUT} ${CLI_CMD} team dispatch --role architect --task-file ${TASK_DIR}/architect-task.txt --project-root ${FIXTURE_DIR}" \
  "${LLM_OUTPUTS_DIR}/architect-review.txt"

# TC-E2E-B02: 独立开发者根据 PRD 和 ARCHITECTURE 实现代码
# v2.1.1 E2E 修正：使用 --task-file 替代 --task，避免 shell 转义问题
cat > "${TASK_DIR}/coder-task.txt" << 'EOF'
请根据下方提供的 PRD 和 ARCHITECTURE 文档内容，实现企业应用代码。

要求：
1. 严格按照 ARCHITECTURE 文档的模块结构实现：src/auth/jwt.ts, src/products/product-service.ts, src/orders/order-service.ts, src/inventory/inventory-service.ts, src/utils/{errors,logger,repository}.ts, src/index.ts
2. 实现 PRD 文档中的 12 个功能点（F-001 ~ F-012）
3. 满足 17 个验收标准（AC-001 ~ AC-017）
4. 体现 6 个集成关系（INT-001 ~ INT-006）
5. 代码中函数和关键逻辑需要中文注释
6. 禁止使用 mock/占位/简化实现
7. 输出完整代码内容（每个文件用 markdown 代码块包裹，代码块开头用 path://文件路径 标注路径）

=== PRD.md 内容开始 ===
EOF
cat "${FIXTURE_DIR}/PRD.md" >> "${TASK_DIR}/coder-task.txt"
echo "" >> "${TASK_DIR}/coder-task.txt"
echo "=== PRD.md 内容结束 ===" >> "${TASK_DIR}/coder-task.txt"
echo "" >> "${TASK_DIR}/coder-task.txt"
echo "=== ARCHITECTURE.md 内容开始 ===" >> "${TASK_DIR}/coder-task.txt"
cat "${FIXTURE_DIR}/ARCHITECTURE.md" >> "${TASK_DIR}/coder-task.txt"
echo "" >> "${TASK_DIR}/coder-task.txt"
echo "=== ARCHITECTURE.md 内容结束 ===" >> "${TASK_DIR}/coder-task.txt"
echo "" >> "${TASK_DIR}/coder-task.txt"
echo "请根据上述文档内容，实现完整的企业应用代码。每个文件用 markdown 代码块包裹，代码块开头用 path://文件路径 标注路径。" >> "${TASK_DIR}/coder-task.txt"

run_case "TC-E2E-B02" \
  "独立开发者根据 PRD 实现代码" \
  -1 \
  "DispatchResult|status" \
  "${TIMEOUT_CMD} ${LLM_TIMEOUT} ${CLI_CMD} team dispatch --role solo-coder --task-file ${TASK_DIR}/coder-task.txt --project-root ${FIXTURE_DIR}" \
  "${LLM_OUTPUTS_DIR}/coder-implementation.txt"

# TC-E2E-B03: 测试专家根据 TEST_PLAN 实现测试代码
# v2.1.1 E2E 修正：使用 --task-file 替代 --task，避免 shell 转义问题
cat > "${TASK_DIR}/test-task.txt" << 'EOF'
请根据下方提供的 TEST_PLAN 和 ARCHITECTURE 文档内容，实现企业应用的单元测试代码。

要求：
1. 实现 TEST_PLAN 文档中的所有测试用例（TC-AUTH-01~08, TC-PROD-01~15, TC-ORDER-01~12, TC-INV-01~11）
2. 使用 node:test + node:assert/strict 测试框架
3. 测试文件放到 tests/ 目录下：tests/auth.test.ts, tests/products.test.ts, tests/orders.test.ts, tests/inventory.test.ts
4. 禁止使用 mock，通过真实 HTTP 请求或直接实例化 Service 测试
5. 输出完整测试代码内容（每个文件用 markdown 代码块包裹，代码块开头用 path://文件路径 标注路径）

=== TEST_PLAN.md 内容开始 ===
EOF
cat "${FIXTURE_DIR}/TEST_PLAN.md" >> "${TASK_DIR}/test-task.txt"
echo "" >> "${TASK_DIR}/test-task.txt"
echo "=== TEST_PLAN.md 内容结束 ===" >> "${TASK_DIR}/test-task.txt"
echo "" >> "${TASK_DIR}/test-task.txt"
echo "=== ARCHITECTURE.md 内容开始 ===" >> "${TASK_DIR}/test-task.txt"
cat "${FIXTURE_DIR}/ARCHITECTURE.md" >> "${TASK_DIR}/test-task.txt"
echo "" >> "${TASK_DIR}/test-task.txt"
echo "=== ARCHITECTURE.md 内容结束 ===" >> "${TASK_DIR}/test-task.txt"
echo "" >> "${TASK_DIR}/test-task.txt"
echo "请根据上述文档内容，实现完整的单元测试代码。每个文件用 markdown 代码块包裹，代码块开头用 path://文件路径 标注路径。" >> "${TASK_DIR}/test-task.txt"

run_case "TC-E2E-B03" \
  "测试专家根据 TEST_PLAN 实现测试代码" \
  -1 \
  "DispatchResult|status" \
  "${TIMEOUT_CMD} ${LLM_TIMEOUT} ${CLI_CMD} team dispatch --role test-expert --task-file ${TASK_DIR}/test-task.txt --project-root ${FIXTURE_DIR}" \
  "${LLM_OUTPUTS_DIR}/test-implementation.txt"

# TC-E2E-B04: 产品经理审查 PRD 完整性
# v2.1.1 E2E 修正：使用 --task-file 替代 --task，避免 shell 转义问题
cat > "${TASK_DIR}/pm-task.txt" << 'EOF'
请审查下方提供的企业应用 PRD 产品需求文档，重点检查：
1. 12 个功能点是否定义清晰、可落地
2. 17 个验收标准是否可验证
3. 4 组 API 契约（auth/products/orders/inventory）是否完整
4. 集成关系图是否清晰
5. 技术栈选型是否合理

请输出审查报告。

=== PRD.md 内容开始 ===
EOF
cat "${FIXTURE_DIR}/PRD.md" >> "${TASK_DIR}/pm-task.txt"
echo "" >> "${TASK_DIR}/pm-task.txt"
echo "=== PRD.md 内容结束 ===" >> "${TASK_DIR}/pm-task.txt"
echo "" >> "${TASK_DIR}/pm-task.txt"
echo "请根据上述文档内容，输出审查报告。" >> "${TASK_DIR}/pm-task.txt"

run_case "TC-E2E-B04" \
  "产品经理审查 PRD 完整性" \
  -1 \
  "DispatchResult|status" \
  "${TIMEOUT_CMD} ${LLM_TIMEOUT} ${CLI_CMD} team dispatch --role product-manager --task-file ${TASK_DIR}/pm-task.txt --project-root ${FIXTURE_DIR}" \
  "${LLM_OUTPUTS_DIR}/pm-review.txt"

# ==============================================================================
# Stage B+: 从 LLM 输出中提取代码并写入文件
# ==============================================================================
stage_log "Stage B+: 从 LLM 输出中提取代码并写入文件"

# 创建 Python 提取脚本
EXTRACT_SCRIPT="${REPORTS_DIR}/extract_code.py"
cat > "${EXTRACT_SCRIPT}" << 'PYEOF'
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
PYEOF

log "提取脚本已创建: ${EXTRACT_SCRIPT}"

# 从 coder-implementation.txt 提取源代码
TC_E2E_BP1_PASSED=0
if [ -f "${LLM_OUTPUTS_DIR}/coder-implementation.txt" ]; then
  log "从 coder-implementation.txt 提取源代码..."
  if python3 "${EXTRACT_SCRIPT}" "${LLM_OUTPUTS_DIR}/coder-implementation.txt" "${FIXTURE_DIR}" > "${REPORTS_DIR}/extract-src.log" 2>&1; then
    TC_E2E_BP1_PASSED=1
    log "✅ TC-E2E-BP1 通过：源代码提取成功"
  else
    fail_log "TC-E2E-BP1 失败：源代码提取失败（详见 ${REPORTS_DIR}/extract-src.log）"
  fi
fi
TOTAL_CASES=$((TOTAL_CASES + 1))
if [ "${TC_E2E_BP1_PASSED}" -eq 1 ]; then
  PASSED_CASES=$((PASSED_CASES + 1))
  STAGE_RESULTS+=("TC-E2E-BP1: PASS")
else
  FAILED_CASES=$((FAILED_CASES + 1))
  FAILED_CASES_LIST+=("TC-E2E-BP1")
  STAGE_RESULTS+=("TC-E2E-BP1: FAIL")
fi

# 从 test-implementation.txt 提取测试代码
TC_E2E_BP2_PASSED=0
if [ -f "${LLM_OUTPUTS_DIR}/test-implementation.txt" ]; then
  log "从 test-implementation.txt 提取测试代码..."
  if python3 "${EXTRACT_SCRIPT}" "${LLM_OUTPUTS_DIR}/test-implementation.txt" "${FIXTURE_DIR}" > "${REPORTS_DIR}/extract-tests.log" 2>&1; then
    TC_E2E_BP2_PASSED=1
    log "✅ TC-E2E-BP2 通过：测试代码提取成功"
  else
    fail_log "TC-E2E-BP2 失败：测试代码提取失败（详见 ${REPORTS_DIR}/extract-tests.log）"
  fi
fi
TOTAL_CASES=$((TOTAL_CASES + 1))
if [ "${TC_E2E_BP2_PASSED}" -eq 1 ]; then
  PASSED_CASES=$((PASSED_CASES + 1))
  STAGE_RESULTS+=("TC-E2E-BP2: PASS")
else
  FAILED_CASES=$((FAILED_CASES + 1))
  FAILED_CASES_LIST+=("TC-E2E-BP2")
  STAGE_RESULTS+=("TC-E2E-BP2: FAIL")
fi

# 列出提取的文件（v2.1.2 修复：排除 node_modules，避免 SIGPIPE 截断管道导致脚本异常退出）
log ""
log "提取后的 fixture 目录结构："
find "${FIXTURE_DIR}" -type f \( -name "*.ts" -o -name "*.md" -o -name "*.json" \) -not -path "${FIXTURE_DIR}/node_modules/*" | sort | sed "s|${FIXTURE_DIR}/||" | head -30 || true

# ==============================================================================
# Stage C: 文档对照一致性检测（Python DocCodeConsistencyChecker）
# ==============================================================================
stage_log "Stage C: 文档对照一致性检测"

# 调用 Python wrapper 执行 D1~D6 六大维度检查
CONSISTENCY_REPORT="${REPORTS_DIR}/consistency-report.json"
CONSISTENCY_WRAPPER="${SCRIPT_DIR}/run-doc-consistency.py"

TC_E2E_C01_PASSED=0
if [ -f "${CONSISTENCY_WRAPPER}" ]; then
  log "调用 DocCodeConsistencyChecker 执行六大维度检查..."
  # 测试命令：如果 package.json 和 src/ 都存在，运行 npm test
  TEST_CMD=""
  if [ -d "${FIXTURE_DIR}/src" ] && [ -f "${FIXTURE_DIR}/package.json" ]; then
    # 安装依赖（如果 node_modules 不存在）
    if [ ! -d "${FIXTURE_DIR}/node_modules" ]; then
      log "安装 fixture 依赖..."
      (cd "${FIXTURE_DIR}" && npm install > "${REPORTS_DIR}/npm-install.log" 2>&1) || true
    fi
    TEST_CMD="cd ${FIXTURE_DIR} && npm test 2>&1"
  fi

  if python3 "${CONSISTENCY_WRAPPER}" \
    --project-root "${FIXTURE_DIR}" \
    --prd-path "PRD.md" \
    --architecture-path "ARCHITECTURE.md" \
    --test-plan-path "TEST_PLAN.md" \
    --test-command "${TEST_CMD}" \
    --output "${CONSISTENCY_REPORT}" > "${REPORTS_DIR}/consistency-check.log" 2>&1; then
    TC_E2E_C01_PASSED=1
    log "✅ TC-E2E-C01 通过：一致性检查完成"
  else
    fail_log "TC-E2E-C01 失败：一致性检查失败（详见 ${REPORTS_DIR}/consistency-check.log）"
  fi
else
  fail_log "TC-E2E-C01 失败：未找到 Python wrapper ${CONSISTENCY_WRAPPER}"
fi
TOTAL_CASES=$((TOTAL_CASES + 1))
if [ "${TC_E2E_C01_PASSED}" -eq 1 ]; then
  PASSED_CASES=$((PASSED_CASES + 1))
  STAGE_RESULTS+=("TC-E2E-C01: PASS")
else
  FAILED_CASES=$((FAILED_CASES + 1))
  FAILED_CASES_LIST+=("TC-E2E-C01")
  STAGE_RESULTS+=("TC-E2E-C01: FAIL")
fi

# 输出一致性检查结果摘要
if [ -f "${CONSISTENCY_REPORT}" ]; then
  log ""
  log "一致性检查结果摘要："
  python3 -c "
import json
with open('${CONSISTENCY_REPORT}') as f:
    report = json.load(f)
print(f\"  overall_passed: {report.get('overall_passed', 'N/A')}\")
print(f\"  feature_checks: {len(report.get('feature_checks', []))} 项\")
print(f\"  integration_checks: {len(report.get('integration_checks', []))} 项\")
print(f\"  acceptance_checks: {len(report.get('acceptance_checks', []))} 项\")
print(f\"  todo_items: {len(report.get('todo_items', []))} 项\")
print(f\"  deviation_items: {len(report.get('deviation_items', []))} 项\")
print(f\"  gap_list: {len(report.get('gap_list', []))} 项\")
test_result = report.get('test_result') or {}
if test_result:
    print(f\"  test_result: passed={test_result.get('passed', 0)}, failed={test_result.get('failed', 0)}\")
" 2>&1 || true
fi

# ==============================================================================
# Stage D: 企业应用单元测试执行
# ==============================================================================
stage_log "Stage D: 企业应用单元测试执行"

TC_E2E_D01_PASSED=0
if [ -d "${FIXTURE_DIR}/src" ] && [ -d "${FIXTURE_DIR}/tests" ] && [ -f "${FIXTURE_DIR}/package.json" ]; then
  log "运行企业应用单元测试..."
  if (cd "${FIXTURE_DIR}" && npm test) > "${REPORTS_DIR}/npm-test.log" 2>&1; then
    TC_E2E_D01_PASSED=1
    log "✅ TC-E2E-D01 通过：单元测试全部通过"
  else
    fail_log "TC-E2E-D01 失败：单元测试存在失败（详见 ${REPORTS_DIR}/npm-test.log）"
    # 输出测试日志末尾
    tail -20 "${REPORTS_DIR}/npm-test.log" 2>&1 || true
  fi
else
  fail_log "TC-E2E-D01 跳过：src/ 或 tests/ 目录不存在（LLM 未产出完整代码）"
fi
TOTAL_CASES=$((TOTAL_CASES + 1))
if [ "${TC_E2E_D01_PASSED}" -eq 1 ]; then
  PASSED_CASES=$((PASSED_CASES + 1))
  STAGE_RESULTS+=("TC-E2E-D01: PASS")
else
  FAILED_CASES=$((FAILED_CASES + 1))
  FAILED_CASES_LIST+=("TC-E2E-D01")
  STAGE_RESULTS+=("TC-E2E-D01: FAIL/SKIP")
fi

# ==============================================================================
# Stage E: 生成最终报告
# ==============================================================================
stage_log "Stage E: 生成最终报告"

FINAL_REPORT="${REPORTS_DIR}/e2e-final-report.md"
{
  echo "# 企业应用 E2E 测试报告"
  echo ""
  echo "> **生成时间**: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "> **测试脚本**: tests/scripts/e2e-enterprise-app.sh"
  echo "> **Fixture 目录**: tests/fixtures/enterprise-app/"
  echo ""
  echo "## 1. 测试概览"
  echo ""
  echo "| 指标 | 值 |"
  echo "|------|------|"
  echo "| 总用例数 | ${TOTAL_CASES} |"
  echo "| 通过数 | ${PASSED_CASES} |"
  echo "| 失败数 | ${FAILED_CASES} |"
  if [ "${TOTAL_CASES}" -gt 0 ]; then
    echo "| 通过率 | $(( PASSED_CASES * 100 / TOTAL_CASES ))% |"
  fi
  echo ""
  echo "## 2. 阶段结果详情"
  echo ""
  echo "| 用例 ID | 结果 |"
  echo "|---------|------|"
  for result in "${STAGE_RESULTS[@]}"; do
    echo "| ${result} |"
  done
  echo ""
  echo "## 3. Stage A: CLI 调用链路验证"
  echo ""
  echo "验证 DeepCodeX CLI team 子命令的 list/match 功能，确认多角色团队核心模块正常工作。"
  echo ""
  echo "输出文件："
  echo "- ${LLM_OUTPUTS_DIR}/team-list.txt"
  echo "- ${LLM_OUTPUTS_DIR}/team-match-architect.txt"
  echo "- ${LLM_OUTPUTS_DIR}/team-match-test.txt"
  echo "- ${LLM_OUTPUTS_DIR}/team-match-coder.txt"
  echo ""
  echo "## 4. Stage B: 多角色团队 LLM 真实调用"
  echo ""
  echo "通过 CLI team dispatch 调用 4 个角色（架构师/独立开发者/测试专家/产品经理），让 LLM 真实产出代码和审查报告。"
  echo ""
  echo "输出文件："
  echo "- ${LLM_OUTPUTS_DIR}/architect-review.txt（架构师审查报告）"
  echo "- ${LLM_OUTPUTS_DIR}/coder-implementation.txt（独立开发者代码产出）"
  echo "- ${LLM_OUTPUTS_DIR}/test-implementation.txt（测试专家测试代码产出）"
  echo "- ${LLM_OUTPUTS_DIR}/pm-review.txt（产品经理审查报告）"
  echo ""
  echo "## 5. Stage B+: 代码提取"
  echo ""
  echo "从 LLM 输出中提取 markdown 代码块，写入 fixture 目录。"
  echo ""
  echo "提取日志："
  echo "- ${REPORTS_DIR}/extract-src.log"
  echo "- ${REPORTS_DIR}/extract-tests.log"
  echo ""
  echo "## 6. Stage C: 文档对照一致性检测"
  echo ""
  echo "调用 multi-agent-team 的 DocCodeConsistencyChecker 执行 D1~D6 六大维度检查。"
  echo ""
  echo "报告文件: ${CONSISTENCY_REPORT}"
  echo "检查日志: ${REPORTS_DIR}/consistency-check.log"
  echo ""
  echo "## 7. Stage D: 单元测试执行"
  echo ""
  echo "运行企业应用 fixture 的单元测试，验证 LLM 产出的代码质量。"
  echo ""
  echo "测试日志: ${REPORTS_DIR}/npm-test.log"
  echo ""
  echo "## 8. 失败用例清单"
  echo ""
  if [ "${FAILED_CASES}" -gt 0 ]; then
    for case_id in "${FAILED_CASES_LIST[@]}"; do
      echo "- ${case_id}"
    done
  else
    echo "（无）"
  fi
  echo ""
  echo "## 9. 结论"
  echo ""
  if [ "${FAILED_CASES}" -eq 0 ]; then
    echo "✅ **全部用例通过**：DeepCodeX CLI 多角色团队能力正常，LLM 产出的代码与设计文档一致，单元测试全部通过。"
  else
    echo "⚠️ **部分用例失败**：详见上方失败用例清单和对应日志文件。"
    echo ""
    echo "可能原因："
    echo "1. LLM 产出的代码不完整或存在 bug"
    echo "2. LLM 产出的代码与 PRD/ARCHITECTURE 设计文档不一致"
    echo "3. 代码提取脚本未能正确解析 LLM 输出格式"
    echo "4. 单元测试依赖的模块未产出"
  fi
} > "${FINAL_REPORT}"

log "最终报告已生成: ${FINAL_REPORT}"

# ---------- 汇总 ----------
stage_log "汇总"
log "  总用例: ${TOTAL_CASES}"
log "  通过:   ${PASSED_CASES}"
log "  失败:   ${FAILED_CASES}"
if [ "${TOTAL_CASES}" -gt 0 ]; then
  log "  通过率: $(( PASSED_CASES * 100 / TOTAL_CASES ))%"
fi
log ""
log "  最终报告: ${FINAL_REPORT}"
log "  LLM 输出目录: ${LLM_OUTPUTS_DIR}"
log "  检查报告目录: ${REPORTS_DIR}"

if [ "${FAILED_CASES}" -gt 0 ]; then
  log ""
  log "  失败用例:"
  for case_id in "${FAILED_CASES_LIST[@]}"; do
    log "    - ${case_id}"
  done
  exit 1
fi

exit 0
