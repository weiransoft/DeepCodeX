#!/usr/bin/env bash
# ============================================================================
# install.sh —— DeepCodeX 全自动安装脚本（macOS / Linux 兼容，国内镜像源）
# ============================================================================
#
# 用途：
#   一键完成开发/部署环境的全自动安装：
#   1. 环境预检（Node.js >= 18、npm、git；Linux 附带编译工具链提示）
#   2. 配置国内镜像源（npm registry / node-gyp 头文件 / prebuild 二进制 /
#      sharp 与 better-sqlite3 的 GitHub Release 代理），全部可用环境变量覆盖
#   3. npm install（工作区安装，含原生模块）
#   4. better-sqlite3 原生模块保障（复用 install-better-sqlite3.sh 的
#      安装 + 三级回退编译 + FTS5 验证逻辑）
#   5. 项目构建（npm run build：core/cli 产物 + Web 前端 bundle）
#   6. 安装后冒烟验证（deepcode CLI 版本号输出）
#
# 退出码语义（与 install-better-sqlite3.sh 对齐）：
#   0 = 安装与验证全部通过
#   1 = 环境预检失败（Node.js/npm/git 缺失或版本不符）
#   2 = 安装/构建/验证失败（npm 安装失败、编译失败、构建或冒烟失败）
#
# 使用方式：
#   bash scripts/install.sh                      # 全自动安装（国内源）
#   NPM_REGISTRY=https://registry.npmjs.org \
#     bash scripts/install.sh                    # 覆盖为官方源
#   SKIP_BUILD=1 bash scripts/install.sh         # 跳过构建阶段
#   SKIP_SMOKE=1 bash scripts/install.sh         # 跳过冒烟验证阶段
#
# 国内镜像源说明（默认值，环境变量可覆盖）：
#   - NPM_REGISTRY        npmmirror（阿里）npm 包源
#   - NODE_MIRROR         npmmirror Node.js 发行版镜像（node-gyp 头文件用）
#   - PREBUILD_MIRROR     npmmirror prebuild-install 二进制镜像
#   - BINARY_HOST_PREFIX  npmmirror GitHub Release 代理前缀（sharp/better-sqlite3
#                         等直接打 GitHub 域名的下载会被拦截到镜像站）
#   - GIT_REPO            代码仓库地址（缺省：README 仓库；本地克隆模式跳过 clone）
# ============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# 全局变量与常量
# ----------------------------------------------------------------------------

# 脚本所在目录的绝对路径（用于定位项目根）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 项目根目录（脚本的上一级）
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 退出码常量
EXIT_SUCCESS=0
EXIT_PREFLIGHT_FAILED=1
EXIT_INSTALL_FAILED=2

# 可选开关（默认全自动：安装 + 构建 + 冒烟）
SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_SMOKE="${SKIP_SMOKE:-0}"

# 国内镜像源默认值（npmmirror = 阿里云；全部可被同名环境变量覆盖）
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
NODE_MIRROR="${NODE_MIRROR:-https://cdn.npmmirror.com/binaries/node}"
PREBUILD_MIRROR="${PREBUILD_MIRROR:-https://npmmirror.com/mirrors}"
BINARY_HOST_PREFIX="${BINARY_HOST_PREFIX:-https://cdn.npmmirror.com/binaries}"
# Node.js 最低版本要求（与 packages/cli、core engines 语义一致）
NODE_MIN_MAJOR=18

# 颜色输出（仅当 stdout 是 TTY 时启用）
if [ -t 1 ]; then
  COLOR_RED='\033[0;31m'
  COLOR_GREEN='\033[0;32m'
  COLOR_YELLOW='\033[0;33m'
  COLOR_BLUE='\033[0;34m'
  COLOR_RESET='\033[0m'
else
  COLOR_RED=''
  COLOR_GREEN=''
  COLOR_YELLOW=''
  COLOR_BLUE=''
  COLOR_RESET=''
fi

# ----------------------------------------------------------------------------
# 日志辅助函数
# ----------------------------------------------------------------------------

# 输出 INFO 级别日志（蓝色）
log_info() {
  echo -e "${COLOR_BLUE}[INFO]${COLOR_RESET} $*"
}

# 输出 WARN 级别日志（黄色）到 stderr
log_warn() {
  echo -e "${COLOR_YELLOW}[WARN]${COLOR_RESET} $*" >&2
}

# 输出 ERROR 级别日志（红色）到 stderr
log_error() {
  echo -e "${COLOR_RED}[ERROR]${COLOR_RESET} $*" >&2
}

# 输出 SUCCESS 级别日志（绿色）
log_success() {
  echo -e "${COLOR_GREEN}[SUCCESS]${COLOR_RESET} $*"
}

# ----------------------------------------------------------------------------
# 阶段 0：环境预检（Preflight）
# ----------------------------------------------------------------------------

# 检查操作系统支持范围（本脚本面向 macOS / Linux；Windows 请走 WSL 或 npm 直装）
preflight_os() {
  local os_type
  os_type="$(uname -s 2>/dev/null || echo "Unknown")"
  case "${os_type}" in
    Darwin | Linux)
      log_info "操作系统检查通过：${os_type}"
      ;;
    MINGW* | MSYS* | CYGWIN*)
      log_error "检测到 Windows 类 Unix 环境；请使用 WSL，或在 Windows 上直接执行 npm install + npm run build"
      return "${EXIT_PREFLIGHT_FAILED}"
      ;;
    *)
      log_error "不支持的操作系统：${os_type}"
      return "${EXIT_PREFLIGHT_FAILED}"
      ;;
  esac
  return 0
}

# 检查 Node.js 可用且主版本 >= 18
preflight_node() {
  if ! command -v node >/dev/null 2>&1; then
    log_error "未找到 Node.js 可执行文件，请先安装 Node.js >= ${NODE_MIN_MAJOR}"
    log_error "  Linux 推荐（npmmirror 镜像一键安装）："
    log_error "    curl -fsSL https://cdn.npmmirror.com/binaries/node/latest-v22.x/node-v22.x-linux-x64.tar.xz -o node.tar.xz"
    return "${EXIT_PREFLIGHT_FAILED}"
  fi

  local node_version
  node_version="$(node --version 2>/dev/null | sed 's/^v//')"
  if [ -z "${node_version}" ]; then
    log_error "无法获取 Node.js 版本"
    return "${EXIT_PREFLIGHT_FAILED}"
  fi

  local node_major
  node_major="$(echo "${node_version}" | cut -d. -f1)"
  if [ "${node_major}" -lt "${NODE_MIN_MAJOR}" ]; then
    log_error "Node.js 版本 ${node_version} 不满足要求（>= ${NODE_MIN_MAJOR}）"
    return "${EXIT_PREFLIGHT_FAILED}"
  fi

  log_info "Node.js 版本检查通过：v${node_version}"
  return 0
}

# 检查 npm 可用
preflight_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    log_error "未找到 npm 可执行文件，请确保 npm 随 Node.js 一起安装"
    return "${EXIT_PREFLIGHT_FAILED}"
  fi
  log_info "npm 可用性检查通过：$(npm --version 2>/dev/null)"
  return 0
}

# 检查 git 可用（仓库模式需要）
preflight_git() {
  if ! command -v git >/dev/null 2>&1; then
    log_warn "未找到 git；若仓库已克隆到本地仍可继续安装"
  fi
  return 0
}

# 检查编译工具链（原生模块 better-sqlite3/sharp 源码回退编译需要）
# Linux：缺 make/g++ 时给出包管理器安装提示；macOS：CLT 检查由 sqlite 脚本负责
preflight_build_tools() {
  local os_type
  os_type="$(uname -s 2>/dev/null || echo "Unknown")"

  if [ "${os_type}" = "Linux" ]; then
    local missing=()
    command -v make >/dev/null 2>&1 || missing+=("make")
    (command -v g++ >/dev/null 2>&1 || command -v c++ >/dev/null 2>&1) || missing+=("g++")
    command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1 || missing+=("python3")

    if [ "${#missing[@]}" -gt 0 ]; then
      log_warn "缺少编译工具链：${missing[*]}（原生模块源码编译回退会失败，优先走预编译二进制）"
      log_warn "  Debian/Ubuntu: sudo apt-get install -y build-essential python3"
      log_warn "  CentOS/RHEL:   sudo yum groupinstall -y 'Development Tools' && sudo yum install -y python3"
    else
      log_info "Linux 编译工具链检查通过（make/g++/python3）"
    fi
  fi

  if [ "${os_type}" = "Darwin" ]; then
    if ! command -v make >/dev/null 2>&1; then
      log_warn "未找到 make；若需源码编译原生模块，请先执行：xcode-select --install"
    fi
  fi
  return 0
}

# ----------------------------------------------------------------------------
# 阶段 1：国内镜像源配置
# ----------------------------------------------------------------------------

# 导出镜像相关环境变量并写入项目级 .npmrc（安装期生效，不污染全局配置）
#
# 设计取舍：
#   - 不修改用户全局 ~/.npmrc——避免影响机器上其他项目
#   - 项目级 .npmrc 被 git 忽略（安装产物目录），每次安装重写
#   - GitHub Release 直连下载（sharp/better-sqlite3 的 prebuild）用
#     BINARY_HOST_PREFIX 代理前缀拦截；npmmirror 的 binaries 路径镜像了
#     GitHub Release 资产
configure_mirrors() {
  log_info "==== 阶段 1：配置国内镜像源 ===="
  log_info "  npm registry : ${NPM_REGISTRY}"
  log_info "  node mirror  : ${NODE_MIRROR}"
  log_info "  prebuild     : ${PREBUILD_MIRROR}"
  log_info "  binary proxy : ${BINARY_HOST_PREFIX}"

  # npm registry：写入项目级 .npmrc（仅本项目安装生效）
  cat > "${PROJECT_ROOT}/.npmrc" <<EOF
registry=${NPM_REGISTRY}
# node-gyp 头文件走 npmmirror（国内直连 nodejs.org 慢/不可达）
disturl=${NODE_MIRROR}
# prebuild-install 系列（better-sqlite3 等）二进制镜像
better_sqlite3_binary_host_mirror=${PREBUILD_MIRROR}/better-sqlite3
EOF

  # 原生模块的 GitHub Release 直连下载统一走镜像代理：
  # sharp 与 better-sqlite3 的 prebuild-install 钩子读取以下环境变量
  # 把 github.com 前缀替换为代理站。
  export npm_config_registry="${NPM_REGISTRY}"
  export npm_config_disturl="${NODE_MIRROR}"
  export NPM_CONFIG_REGISTRY="${NPM_REGISTRY}"
  # sharp 的可选依赖由 npm 按平台自动解析（npmmirror 已同步 @img/* 包），
  # 无需额外钩子；better-sqlite3 prebuild 走 binary_host_mirror（见 .npmrc）
  export PREBUILD_INSTALL_GITHUB_HOST="${BINARY_HOST_PREFIX}"
  # node-gyp 头文件镜像（源码编译回退路径）
  export npm_config_better_sqlite3_binary_host="${BINARY_HOST_PREFIX}/goodbetter/better-sqlite3"

  log_success "镜像源配置完成"
  return 0
}

# ----------------------------------------------------------------------------
# 阶段 2：依赖安装
# ----------------------------------------------------------------------------

# 执行工作区依赖安装（npm workspaces：root + packages/*）
install_dependencies() {
  log_info "==== 阶段 2：安装依赖（npm install，registry=${NPM_REGISTRY}） ===="
  cd "${PROJECT_ROOT}"
  if ! npm install --no-audit --no-fund 2>&1; then
    log_error "npm install 失败；可尝试：1) 检查网络/镜像可达性 2) 删除 node_modules 后重试"
    return "${EXIT_INSTALL_FAILED}"
  fi
  log_success "依赖安装完成"
  return 0
}

# 保障 better-sqlite3 原生模块可用（安装/编译/FTS5 验证）
# 复用仓库既有脚本（含三级回退：自带 install → node-gyp → 手动编译）
ensure_sqlite3() {
  log_info "==== 阶段 2.5：better-sqlite3 原生模块保障 ===="
  if ! bash "${SCRIPT_DIR}/install-better-sqlite3.sh"; then
    log_error "better-sqlite3 安装/验证失败（详见上方脚本输出）"
    return "${EXIT_INSTALL_FAILED}"
  fi
  return 0
}

# 验证 sharp 原生模块可加载（图像能力依赖；不可加载仅警告不阻断）
# 背景：跨平台拷贝 node_modules 或镜像解析缺陷会导致 @img/<platform> 缺失
verify_sharp() {
  log_info "验证 sharp 原生模块可加载性 ..."
  if node --input-type=module -e '
    // 动态导入 sharp：加载失败（缺少平台二进制）时退出码非 0
    try {
      const sharp = (await import("sharp")).default;
      const meta = sharp.versions ? sharp.versions.vips : "unknown";
      console.log("[INFO] sharp 加载通过（libvips " + meta + "）");
    } catch (err) {
      console.error("[WARN] sharp 加载失败：" + err.message.split("\n")[0]);
      process.exit(1);
    }
  ' 2>&1; then
    log_success "sharp 原生模块验证通过"
  else
    log_warn "sharp 不可用：图片多模态/预览图像能力将降级；修复方式："
    log_warn "  npm install @img/sharp-\$(node -p \"process.platform+'-'+process.arch\") --no-save"
  fi
  return 0
}

# ----------------------------------------------------------------------------
# 阶段 3：构建
# ----------------------------------------------------------------------------

# 项目构建（scripts/build.js：core → cli 产物 + packages/web/web/build.mjs 前端 bundle）
build_project() {
  log_info "==== 阶段 3：项目构建（npm run build） ===="
  cd "${PROJECT_ROOT}"
  if ! npm run build 2>&1; then
    log_error "构建失败（npm run build），请检查上方编译日志"
    return "${EXIT_INSTALL_FAILED}"
  fi
  log_success "项目构建完成"
  return 0
}

# ----------------------------------------------------------------------------
# 阶段 4：安装后冒烟验证
# ----------------------------------------------------------------------------

# 验证 CLI 产物可运行（dist/cli.js 输出版本号即视为冒烟通过）
smoke_test() {
  log_info "==== 阶段 4：冒烟验证 ===="
  local cli_entry="${PROJECT_ROOT}/packages/cli/dist/cli.js"
  if [ ! -f "${cli_entry}" ]; then
    log_warn "未找到 CLI 产物 ${cli_entry}（跳过冒烟，构建阶段可能已报警）"
    return 0
  fi
  local cli_version
  if ! cli_version="$(node "${cli_entry}" --version 2>&1 | head -1)"; then
    log_error "CLI 冒烟失败：node packages/cli/dist/cli.js --version 执行出错"
    log_error "  ${cli_version}"
    return "${EXIT_INSTALL_FAILED}"
  fi
  log_success "CLI 冒烟通过：${cli_version}"

  # Web 服务产物存在性抽查（前端 bundle 完整性）
  local web_dist="${PROJECT_ROOT}/packages/web/web/dist"
  if [ -f "${web_dist}/bundle.js" ] && [ -f "${web_dist}/index.html" ]; then
    log_success "Web 前端产物齐备：${web_dist}"
  else
    log_warn "Web 前端产物缺失（${web_dist}）；可手动重建：node packages/web/web/build.mjs"
  fi
  return 0
}

# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------

main() {
  log_info "==== DeepCodeX 全自动安装脚本启动 ===="
  log_info "项目根目录：${PROJECT_ROOT}"

  # === 阶段 0：环境预检 ===
  log_info "==== 阶段 0：环境预检 ===="
  preflight_os || return $?
  preflight_node || return $?
  preflight_npm || return $?
  preflight_git || true
  preflight_build_tools || true

  # === 阶段 1：国内镜像源配置 ===
  configure_mirrors || return $?

  # === 阶段 2：依赖安装 ===
  install_dependencies || return $?
  ensure_sqlite3 || return $?
  verify_sharp || true

  # === 阶段 3：构建 ===
  if [ "${SKIP_BUILD}" = "1" ]; then
    log_info "SKIP_BUILD=1，跳过构建阶段"
  else
    build_project || return $?
  fi

  # === 阶段 4：冒烟验证 ===
  if [ "${SKIP_SMOKE}" = "1" ]; then
    log_info "SKIP_SMOKE=1，跳过冒烟验证阶段"
  else
    smoke_test || return $?
  fi

  log_success "==== DeepCodeX 全自动安装完成 ===="
  log_info "启动方式：node scripts/start.js（或按 README：npm run build-and-start）"
  return "${EXIT_SUCCESS}"
}

# ----------------------------------------------------------------------------
# 脚本入口
# ----------------------------------------------------------------------------

main
exit_code=$?

if [ "${exit_code}" -ne "${EXIT_SUCCESS}" ]; then
  log_error "安装脚本执行失败，退出码：${exit_code}"
fi

exit "${exit_code}"
