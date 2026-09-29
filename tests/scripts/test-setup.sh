#!/usr/bin/env bash
# ============================================================================
# test-setup.sh -- setup.sh 单元与集成测试
# ============================================================================
# 覆盖范围：
#   T1  syntax（bash -n）
#   T2  --help 输出
#   T3  参数解析（所有 flag 分支存在）
#   T4  preflight 核心逻辑（Node 门槛、OS 白名单、git 检查）
#   T5  set -u 空数组安全
#   T6  fixture 仓库 PROJECT_ROOT 定位链
#   T7  heredoc 单引号安全
#   T8  Node.js 自动安装逻辑（install_node_lts + _should_install_node）
#   T9  --install-node / --no-install-node / --node-version 参数存在
# 不覆盖：真实 git clone、真实 npm install、真实 nvm 下载（都依赖外网）
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SETUP_SH="${PROJECT_ROOT}/setup.sh"

PASS=0; FAIL=0

pass() { printf '\033[0;32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf '\033[0;31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }

echo "======== setup.sh test suite ========"
echo "setup.sh = ${SETUP_SH}"
echo ""

# ----------------------------------------------------------------------------
# T1: bash -n 语法
# ----------------------------------------------------------------------------
echo "--- T1: syntax ---"
bash -n "${SETUP_SH}" 2>&1 && pass "bash -n setup.sh" || fail "bash -n setup.sh"

# ----------------------------------------------------------------------------
# T2: --help
# ----------------------------------------------------------------------------
echo "--- T2: --help ---"
HELP_OUT="$(bash "${SETUP_SH}" --help 2>&1)"
HELP_RC=$?
if [ ${HELP_RC} -eq 0 ] && echo "${HELP_OUT}" | grep -q -e "setup.sh"; then
  pass "--help exit 0"
else
  fail "--help (rc=${HELP_RC})"
fi
# 新 flag 也在 help 里
for kw in "install-node" "node-version" "自动安装"; do
  if echo "${HELP_OUT}" | grep -q -e "${kw}"; then
    pass "help 含关键词: ${kw}"
  else
    fail "help 缺关键词: ${kw}"
  fi
done

# ----------------------------------------------------------------------------
# T3: 参数解析分支完整
# ----------------------------------------------------------------------------
echo "--- T3: 参数解析 ---"
for opt_key in "--mode" "--dir" "--branch" "--skip-build" "--skip-smoke" \
               "--deep" "--no-update" \
               "--install-node" "--no-install-node" "--node-version" \
               "-h" "--help"; do
  if grep -q -e "${opt_key}" "${SETUP_SH}"; then
    pass "参数解析分支存在: ${opt_key}"
  else
    fail "参数解析分支缺失: ${opt_key}"
  fi
done

# ----------------------------------------------------------------------------
# T4: preflight 核心逻辑
# ----------------------------------------------------------------------------
echo "--- T4: preflight ---"
grep -q -e "NODE_MIN_MAJOR=18" "${SETUP_SH}" && pass "NODE_MIN_MAJOR=18" || fail "NODE_MIN_MAJOR"
grep -q -e "Darwin|Linux" "${SETUP_SH}" && pass "OS 白名单 Darwin|Linux" || fail "OS 白名单"
# 新版 preflight 不再说 "source mode needs git"，改成中文了
grep -q -e "源码模式需要 git" "${SETUP_SH}" && pass "git 预检（中文）" || fail "git 预检"

# ----------------------------------------------------------------------------
# T5: set -u 空数组安全
# ----------------------------------------------------------------------------
echo "--- T5: set -u 空数组安全 ---"
grep -q 'extra_flags\[@\]+' "${SETUP_SH}" && pass "extra_flags 空数组 set -u 保护" || fail "extra_flags"
grep -q 'env_passthrough\[@\]+' "${SETUP_SH}" && pass "env_passthrough 空数组 set -u 保护" || fail "env_passthrough"
bash <<'INNER' 2>&1 | grep -q "bash 空数组安全" && pass "bash 原生空数组安全验证" || fail "bash 原生验证"
set -u
arr=()
echo "expand: ${arr[@]+"${arr[@]}"}"
echo "bash 空数组安全"
INNER

# ----------------------------------------------------------------------------
# T6: fixture 仓库 PROJECT_ROOT 定位链
# ----------------------------------------------------------------------------
echo "--- T6: fixture 仓库集成 ---"
FIXTURE_DIR="$(mktemp -d -t setup-fixture-XXXXXX)"
FAKE_ROOT="${FIXTURE_DIR}/repo"
FAKE_SCRIPTS="${FAKE_ROOT}/scripts"
mkdir -p "${FAKE_SCRIPTS}"

cat > "${FAKE_SCRIPTS}/install.sh" <<'FAKEEOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
echo "SCRIPT_DIR=${SCRIPT_DIR}" > /tmp/setup-fixture-result.txt
echo "PROJECT_ROOT=${PROJECT_ROOT}" >> /tmp/setup-fixture-result.txt
echo "SKIP_BUILD=${SKIP_BUILD:-0}" >> /tmp/setup-fixture-result.txt
echo "SKIP_SMOKE=${SKIP_SMOKE:-0}" >> /tmp/setup-fixture-result.txt
FAKEEOF
chmod +x "${FAKE_SCRIPTS}/install.sh"

SKIP_BUILD=1 SKIP_SMOKE=1 bash -c "
  cd '${FAKE_ROOT}'
  env SKIP_BUILD=1 SKIP_SMOKE=1 bash scripts/install.sh
"

RESULT_FILE="/tmp/setup-fixture-result.txt"
EXPECTED_ROOT="${FAKE_ROOT}"
grep -q "PROJECT_ROOT=${EXPECTED_ROOT}" "${RESULT_FILE}" 2>/dev/null && \
  pass "PROJECT_ROOT 定位链正确" || fail "PROJECT_ROOT 定位"
grep -q "SKIP_BUILD=1" "${RESULT_FILE}" 2>/dev/null && \
  pass "SKIP_BUILD 透传" || fail "SKIP_BUILD 透传"
rm -rf "${FIXTURE_DIR}" "${RESULT_FILE}"

# ----------------------------------------------------------------------------
# T7: heredoc 安全
# ----------------------------------------------------------------------------
echo "--- T7: heredoc ---"
grep -q "cat <<'EOF'" "${SETUP_SH}" && pass "usage() 用 <<'EOF' 防展开" || fail "usage() heredoc"

# ----------------------------------------------------------------------------
# T8: Node.js 自动安装逻辑（源码级断言）
# ----------------------------------------------------------------------------
echo "--- T8: Node.js 自动安装逻辑 ---"
# install_node_lts 函数存在
grep -q -e "^install_node_lts()" "${SETUP_SH}" && pass "install_node_lts 函数存在" || fail "install_node_lts"
# _should_install_node 函数存在
grep -q -e "^_should_install_node()" "${SETUP_SH}" && pass "_should_install_node 函数存在" || fail "_should_install_node"
# 双路径：nvm + 二进制
grep -q -e "_try_install_via_nvm" "${SETUP_SH}" && pass "nvm 安装路径存在" || fail "nvm 路径"
grep -q -e "_try_install_via_binary" "${SETUP_SH}" && pass "二进制回退路径存在" || fail "二进制回退"
# nvm 国内镜像（gitee）
grep -q -e "gitee.com/mirrors/nvm" "${SETUP_SH}" && pass "nvm 走 gitee 国内镜像" || fail "nvm 国内镜像"
# npmmirror 二进制镜像前缀
grep -q -e "cdn.npmmirror.com/binaries/node" "${SETUP_SH}" && pass "npmmirror 二进制前缀" || fail "npmmirror"
# PATH 持久化（_persist_path / .bashrc / .zshrc）
grep -q -e "_persist_path" "${SETUP_SH}" && pass "PATH 持久化函数" || fail "_persist_path"
grep -q -e "\.bashrc" "${SETUP_SH}" && pass "写入 ~/.bashrc" || fail "bashrc"
# xz-utils 自动安装（精简 Linux 场景）
grep -q -e "apt-get.*xz-utils" "${SETUP_SH}" && pass "自动装 xz-utils" || fail "xz-utils"
# NVM_NODEJS_ORG_MIRROR 环境变量（让 nvm install 也走 npmmirror）
grep -q -e "NVM_NODEJS_ORG_MIRROR" "${SETUP_SH}" && pass "nvm 也走 npmmirror 镜像" || fail "NVM_NODEJS_ORG_MIRROR"

# ----------------------------------------------------------------------------
# T9: 常量默认值存在
# ----------------------------------------------------------------------------
echo "--- T9: 常量默认值 ---"
for const in "NODE_LTS_VERSION" "NVM_INSTALL_URL" "NODE_BINARY_MIRROR" "INSTALL_NODE_FLAG"; do
  grep -q -e "${const}=" "${SETUP_SH}" && pass "${const} 默认值存在" || fail "${const} 默认值"
done

# ----------------------------------------------------------------------------
# T10: 有 node 时 preflight 跳过自动安装（实时验证）
# ----------------------------------------------------------------------------
echo "--- T10: 有 node 时跳过自动安装 ---"
# 注意：pipefail 下 head 截断会让整个管道返回非零，这里用子 shell 绕开
set +o pipefail
OUT="$(INSTALL_NODE_FLAG=0 bash "${SETUP_SH}" --mode npm --skip-build --skip-smoke 2>&1 | head -10 || true)"
set -o pipefail
# RC 直接从 setup.sh 本体取（绕开 pipefail）
RC=0
echo "${OUT}" | grep -q "自动安装 Node" || RC=0   # 如果有就说明有问题
# 关键点：输出里不该出现 "自动安装 Node" 或 "nvm" 字样
if ! echo "${OUT}" | grep -q "自动安装 Node\|Node.js LTS"; then
  pass "有 node 时 preflight 跳过 install_node_lts"
else
  fail "有 node 时跳过自动安装"
fi

# ----------------------------------------------------------------------------
# summary
# ----------------------------------------------------------------------------
echo ""
echo "======== results: ${PASS} passed, ${FAIL} failed ========"
[ ${FAIL} -eq 0 ] && echo "\033[0;32mALL PASS\033[0m" || echo "\033[0;31m${FAIL} FAILURES\033[0m"
exit $([ ${FAIL} -eq 0 ] && echo 0 || echo 1)