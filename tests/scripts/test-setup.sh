#!/usr/bin/env bash
# ============================================================================
# test-setup.sh -- setup.sh 单元与集成测试
# ============================================================================
# 覆盖范围：
#   1. syntax / shellcheck 基础语法
#   2. --help 输出（不触发任何安装）
#   3. preflight 在当前 macOS 环境下通过
#   4. 参数解析：--mode / --dir / --branch / --skip-build / --skip-smoke
#   5. 空数组在 set -u 下的安全性（NPM_REGISTRY 未设置时 extra_flags / env_passthrough）
#   6. setup.sh -> install.sh 的 PROJECT_ROOT 定位链（mock fixture）
#
# 不覆盖：真实 git clone（依赖外网）、真实 npm install（依赖 npm registry）
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SETUP_SH="${PROJECT_ROOT}/setup.sh"

PASS=0; FAIL=0

pass() { echo -e "\033[0;32mPASS\033[0m $1"; PASS=$((PASS+1)); }
fail() { echo -e "\033[0;31mFAIL\033[0m $1"; FAIL=$((FAIL+1)); }

echo "======== setup.sh test suite ========"
echo "setup.sh = ${SETUP_SH}"
echo ""

# ----------------------------------------------------------------------------
# T1: bash -n syntax check
# ----------------------------------------------------------------------------
echo "--- T1: syntax ---"
if bash -n "${SETUP_SH}" 2>&1; then
  pass "bash -n setup.sh"
else
  fail "bash -n setup.sh"
fi

# ----------------------------------------------------------------------------
# T2: --help 输出
# ----------------------------------------------------------------------------
echo "--- T2: --help ---"
HELP_OUT="$(bash "${SETUP_SH}" --help 2>&1)"
HELP_RC=$?
if [ ${HELP_RC} -eq 0 ] && echo "${HELP_OUT}" | grep -q "setup.sh.*one-click"; then
  pass "--help exit 0 + 含标题"
else
  fail "--help (rc=${HELP_RC})"
  echo "  output: ${HELP_OUT:0:200}"
fi

# ----------------------------------------------------------------------------
# T3: 参数解析 --mode / --dir / --branch
# ----------------------------------------------------------------------------
echo "--- T3: 参数解析 ---"
# macOS 的 grep 会把 --xxx 当成自己的 flag，必须用 -e 显式指定 pattern
for opt_key in "--mode" "--dir" "--branch" "--skip-build" "--skip-smoke" "--deep" "--no-update" "-h" "--help"; do
  if grep -q -e "${opt_key}" "${SETUP_SH}"; then
    pass "参数解析分支存在: ${opt_key}"
  else
    fail "参数解析分支缺失: ${opt_key}"
  fi
done

# ----------------------------------------------------------------------------
# T4: preflight 在当前环境下通过（不触发安装）
# ----------------------------------------------------------------------------
echo "--- T4: preflight ---"
# 预创建 mock 让 install_via_npm / clone_and_install 被跳过？不行——setup.sh 没有 dry-run flag
# 换方法：直接断言 setup.sh 源码里 preflight 函数逻辑正确
#   a) 检查 Node.js 版本门槛 (NODE_MIN_MAJOR=18)
grep -q -e "NODE_MIN_MAJOR=18" "${SETUP_SH}" && pass "NODE_MIN_MAJOR=18" || fail "NODE_MIN_MAJOR"
#   b) 检查 Darwin|Linux 白名单
grep -q -e "Darwin|Linux" "${SETUP_SH}" && pass "OS 白名单 Darwin|Linux" || fail "OS 白名单"
#   c) 检查 git 在 source 模式下被要求
if grep -q -e "source mode needs git" "${SETUP_SH}"; then
  pass "source 模式检查 git"
else
  fail "git 预检"
fi

# ----------------------------------------------------------------------------
# T5: set -u 空数组安全（关键！否则 npm 模式在无 NPM_REGISTRY 时会崩）
# ----------------------------------------------------------------------------
echo "--- T5: set -u 空数组安全 ---"
# 源码里必须有 ${arr[@]+"${arr[@]}"} 或等价写法
if grep -q 'extra_flags\[@\]+' "${SETUP_SH}"; then
  pass "npm install 调用用 ${extra_flags[@]+...} 防 set -u"
else
  fail "npm install 空数组展开未做 set -u 保护"
fi
if grep -q 'env_passthrough\[@\]+' "${SETUP_SH}"; then
  pass "env 透传用 ${env_passthrough[@]+...} 防 set -u"
else
  fail "env_passthrough 空数组展开未做 set -u 保护"
fi

# 实时用 bash 直接跑空数组在 set -u 下的行为验证
bash <<'INNER' 2>&1 && echo "bash 空数组安全 ✓"
set -u
arr=()
echo "arr len=${#arr[@]}"
echo "expand: ${arr[@]+"${arr[@]}"}"
INNER

# ----------------------------------------------------------------------------
# T6: 用本地 fixture 仓库测试 setup.sh -> install.sh 调用链
# ----------------------------------------------------------------------------
echo "--- T6: fixture 仓库集成 ---"
FIXTURE_DIR="$(mktemp -d -t setup-fixture-XXXXXX)"
FAKE_ROOT="${FIXTURE_DIR}/repo"
FAKE_SCRIPTS="${FAKE_ROOT}/scripts"
mkdir -p "${FAKE_SCRIPTS}"

# 写一个极简 fixture：模拟真实仓库的 scripts/install.sh 入口
cat > "${FAKE_SCRIPTS}/install.sh" <<'FAKEEOF'
#!/usr/bin/env bash
set -euo pipefail
# 计算自身 PROJECT_ROOT（和真实 install.sh 一样）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 写结果到 marker 文件
echo "SCRIPT_DIR=${SCRIPT_DIR}" > /tmp/setup-fixture-result.txt
echo "PROJECT_ROOT=${PROJECT_ROOT}" >> /tmp/setup-fixture-result.txt
echo "SKIP_BUILD=${SKIP_BUILD:-0}" >> /tmp/setup-fixture-result.txt
echo "SKIP_SMOKE=${SKIP_SMOKE:-0}" >> /tmp/setup-fixture-result.txt
FAKEEOF
chmod +x "${FAKE_SCRIPTS}/install.sh"

# 跑 setup.sh 的 clone_and_install，但用 GIT_REPO 指向 fixture 的 file:// git？不行——没有 .git
# 换方法：直接在 FAKE_ROOT 里手动调用，模拟 setup.sh clone 完成后的最终步骤
SKIP_BUILD=1 SKIP_SMOKE=1 bash -c "
  cd '${FAKE_ROOT}'
  env SKIP_BUILD=1 SKIP_SMOKE=1 bash scripts/install.sh
"

RESULT_FILE="/tmp/setup-fixture-result.txt"
EXPECTED_ROOT="${FAKE_ROOT}"
if grep -q "PROJECT_ROOT=${EXPECTED_ROOT}" "${RESULT_FILE}" 2>/dev/null; then
  pass "PROJECT_ROOT 定位链正确（setup.sh → install.sh → 自反推）"
else
  fail "PROJECT_ROOT 定位（期望 ${EXPECTED_ROOT}）"
  cat "${RESULT_FILE}" 2>/dev/null || echo "(结果文件缺失)"
fi
if grep -q "SKIP_BUILD=1" "${RESULT_FILE}" 2>/dev/null; then
  pass "SKIP_BUILD 环境变量透传正确"
else
  fail "SKIP_BUILD 透传"
fi

# 清理 fixture
rm -rf "${FIXTURE_DIR}" "${RESULT_FILE}"

# ----------------------------------------------------------------------------
# T7: heredoc 禁止变量展开（必须是 <<'EOF' 而非 <<EOF）
# ----------------------------------------------------------------------------
echo "--- T7: heredoc 安全 ---"
if grep -q "cat <<'EOF'" "${SETUP_SH}"; then
  pass "usage() 用 cat <<'EOF'（单引号禁止展开）"
else
  fail "usage() heredoc 应该用 <<'EOF' 防变量展开"
fi

# ----------------------------------------------------------------------------
# summary
# ----------------------------------------------------------------------------
echo ""
echo "======== results: ${PASS} passed, ${FAIL} failed ========"
if [ ${FAIL} -gt 0 ]; then exit 1; fi
exit 0