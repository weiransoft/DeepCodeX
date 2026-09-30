#!/usr/bin/env bash
# ============================================================================
# setup.sh -- DeepCodeX 一键安装入口（GitHub Raw URL 直接可拉）
# ============================================================================
#
# 用途：
#   一行命令从 GitHub 拉取本脚本并完成安装：
#     curl -fsSL https://raw.githubusercontent.com/weiransoft/DeepCodeX/main/setup.sh | bash
#
#   内部自动：
#     1. 环境预检（Node.js >= 18、npm、git；缺失时自动装 Node LTS）
#     2. Git clone 仓库（浅克隆 --depth=1 默认开启）
#     3. 调 scripts/install.sh 完成依赖 + 构建 + 冒烟
#
#   两个安装模式（--mode 参数）：
#     source  （默认）完整源码克隆 + npm install + build
#     npm     GitHub Release tarball → npm install -g（最快，CLI only）
#             默认拉 latest；可用 --tag v0.4.2 指定版本
#
#   生产发布流程（开发者执行一次）：
#     npm run build && cd packages/cli && npm pack
#     gh release create v0.4.2 --title "v0.4.2" --notes "..." \
#       ./vegamo-deepcode-cli-0.4.2.tgz#deepcode-cli.tgz
#
#   Node.js 自动安装策略：
#     当 preflight 发现 Node.js 缺失或版本过低时，setup.sh 会尝试自动安装：
#       1) 优先 nvm（Node Version Manager），用国内镜像加速
#       2) 回退：直接从 npmmirror CDN 下载预编译二进制
#     无 TTY（curl pipe bash）时自动安装；有 TTY 时交互式确认；
#     也可通过 --install-node / --no-install-node 显式指定
#
# 典型用法：
#   curl -fsSL https://raw.githubusercontent.com/weiransoft/DeepCodeX/main/setup.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/weiransoft/DeepCodeX/main/setup.sh | \
#     bash -s -- --mode npm --dir ~/code/dcx
#
# 环境变量覆盖：
#   GIT_REPO, DEFAULT_BRANCH, INSTALL_DIR, NPM_REGISTRY, SKIP_BUILD, SKIP_SMOKE
# ============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# 常量与默认值（全部可通过同名环境变量覆盖）
# ----------------------------------------------------------------------------
GIT_REPO="${GIT_REPO:-https://github.com/weiransoft/DeepCodeX.git}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/DeepCodeX}"
INSTALL_MODE="${INSTALL_MODE:-source}"
SHALLOW_CLONE="${SHALLOW_CLONE:-1}"
UPDATE_EXISTING="${UPDATE_EXISTING:-1}"
# --force 覆盖重装（npm 模式先卸载再装；source 模式删目录重 clone）
FORCE_REINSTALL="${FORCE_REINSTALL:-0}"
NODE_MIN_MAJOR=18
# Node LTS 版本号（npmmirror 上已验证 v22.14.0 存在）
NODE_LTS_VERSION="${NODE_LTS_VERSION:-v22.14.0}"
# nvm 国内镜像（gitee）——比 GitHub 快很多
NVM_INSTALL_URL="${NVM_INSTALL_URL:-https://gitee.com/mirrors/nvm/raw/v0.39.7/install.sh}"
# npmmirror CDN 前缀（直接下载预编译二进制）
NODE_BINARY_MIRROR="${NODE_BINARY_MIRROR:-https://cdn.npmmirror.com/binaries/node}"
# 是否自动安装 Node（空 = 自动判断：无 TTY 时开，有 TTY 时交互）
INSTALL_NODE_FLAG="${INSTALL_NODE_FLAG:-}"

# Colors (TTY only)
if [ -t 1 ]; then
  C_RED='\033[0;31m'; C_GREEN='\033[0;32m'; C_YELLOW='\033[0;33m'; C_BLUE='\033[0;34m'; C_RESET='\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_RESET=''
fi

log_info()  { printf '%b[INFO]%b %s\n'   "${C_BLUE}" "${C_RESET}" "$*"; }
log_warn()  { printf '%b[WARN]%b %s\n'   "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
log_error() { printf '%b[ERROR]%b %s\n'  "${C_RED}"   "${C_RESET}" "$*" >&2; }
log_ok()    { printf '%b[OK]%b %s\n'     "${C_GREEN}" "${C_RESET}" "$*"; }

# ----------------------------------------------------------------------------
# Help text（单引号 heredoc，禁止 bash 变量展开）
# ----------------------------------------------------------------------------
usage() {
  cat <<'EOF'
setup.sh -- DeepCodeX 一键安装入口

用法: setup.sh [选项]

选项:
  --mode <source|npm>   安装模式（默认 source）
                         source = git clone + npm install + build
                         npm    = GitHub Release tarball → npm install -g
  --tag <vX.Y.Z>        npm 模式指定 Release tag（默认 latest）
                         例: --tag v0.4.2
  --dir <path>          安装目录（默认 ~/DeepCodeX）
  --branch <name>       git 检出分支/tag（默认 main）
  --deep                完整克隆（默认浅克隆 --depth=1）
  --force               覆盖重装：npm 模式先卸载再装；source 模式删目录重 clone
  --no-update           目录已存在时不 git pull
  --skip-build          跳过构建阶段（透传给 scripts/install.sh）
  --skip-smoke          跳过冒烟验证（透传给 scripts/install.sh）
  --install-node         Node.js 缺失时自动安装（默认：无 TTY 自动，有 TTY 交互）
  --no-install-node      Node.js 缺失时退出并提示手动安装
  --node-version <ver>  指定安装的 Node LTS 版本（默认 v22.14.0）
  -h, --help            显示本帮助

一行命令：
  curl -fsSL https://raw.githubusercontent.com/weiransoft/DeepCodeX/main/setup.sh | bash
EOF
}

# ----------------------------------------------------------------------------
# 参数解析
# ----------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --mode)             INSTALL_MODE="$2"; shift 2 ;;
    --tag)              RELEASE_TAG="$2"; shift 2 ;;
    --dir)              INSTALL_DIR="$2";  shift 2 ;;
    --branch)           DEFAULT_BRANCH="$2"; shift 2 ;;
    --deep)             SHALLOW_CLONE=0; shift ;;
    --force)            FORCE_REINSTALL=1; shift ;;
    --no-update)        UPDATE_EXISTING=0; shift ;;
    --skip-build)       SKIP_BUILD=1; shift ;;
    --skip-smoke)       SKIP_SMOKE=1; shift ;;
    --install-node)     INSTALL_NODE_FLAG=1; shift ;;
    --no-install-node)  INSTALL_NODE_FLAG=0; shift ;;
    --node-version)     NODE_LTS_VERSION="$2"; shift 2 ;;
    -h|--help)          usage; exit 0 ;;
    *)                  log_error "未知参数：$1（--help 查看用法）"; exit 1 ;;
  esac
done

# ----------------------------------------------------------------------------
# 判断是否应该自动安装 Node.js（参考 INSTALL_NODE_FLAG + TTY 状态）
#   返回值：0 = 应该装，1 = 不该装（让 preflight 走手动提示退出）
# ----------------------------------------------------------------------------
_should_install_node() {
  # 用户显式 --no-install-node → 不装
  if [ "${INSTALL_NODE_FLAG}" = "0" ]; then
    return 1
  fi
  # 用户显式 --install-node → 装
  if [ "${INSTALL_NODE_FLAG}" = "1" ]; then
    return 0
  fi
  # 自动判断：有 TTY 时交互确认，无 TTY（curl pipe bash）时自动装
  if [ -t 0 ] && [ -t 1 ]; then
    # 交互式终端：问一下
    local answer
    printf '\033[0;33m[WARN]\033[0m 是否现在自动安装 Node.js LTS %s？[Y/n] ' "${NODE_LTS_VERSION}"
    read -r answer || answer="y"
    case "${answer}" in
      [Nn]*) return 1 ;;
      *)     return 0 ;;
    esac
  else
    # 无 TTY（curl pipe bash）：自动装
    log_info "无 TTY 模式，自动安装 Node.js LTS ${NODE_LTS_VERSION} ..."
    return 0
  fi
}

# ----------------------------------------------------------------------------
# 自动安装 Node.js LTS
#   策略：
#     1) 优先 nvm（Node Version Manager）—— 国内镜像 gitee，统一 PATH
#     2) 回退：从 npmmirror CDN 下载预编译二进制 tar.xz 到 ~/.local/node
#   安装后自动 export PATH，并尝试持久化到 ~/.bashrc 或 ~/.profile
# ----------------------------------------------------------------------------
install_node_lts() {
  log_info "==== 自动安装 Node.js LTS ${NODE_LTS_VERSION} ===="
  local os_type arch
  os_type="$(uname -s 2>/dev/null)"
  arch="$(uname -m 2>/dev/null)"

  # ---- GLIBC 版本检测（旧系统如 CentOS 7 只有 glibc-2.17，Node 官方二进制跑不了）----
  # 官方 Node v18/v22 预编译二进制需要 glibc >= 2.28
  # 低于此值时，nvm 会自动走源码编译（--build-from-source），只需要 gcc/make
  local glibc_version="" glibc_major=0 glibc_minor=0
  if [ -f /lib64/libc.so.6 ]; then
    glibc_version="$(/lib64/libc.so.6 2>&1 | grep -oE 'version [0-9]+\.[0-9]+' | head -1 | awk '{print $2}')"
  elif command -v ldd >/dev/null 2>&1; then
    glibc_version="$(ldd --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1)"
  fi
  if [ -n "${glibc_version}" ]; then
    glibc_major="$(echo "${glibc_version}" | cut -d. -f1)"
    glibc_minor="$(echo "${glibc_version}" | cut -d. -f2)"
    log_info "系统 GLIBC: ${glibc_version}"
  else
    log_info "系统 GLIBC: 无法检测"
  fi
  # glibc >= 2.28 → 用预编译二进制；否则 → 强制源码编译
  local force_build_from_source=0
  if [ "${glibc_major}" -lt 2 ] || { [ "${glibc_major}" -eq 2 ] && [ "${glibc_minor}" -lt 28 ]; }; then
    log_warn "系统 GLIBC ${glibc_version:-未知} < 2.28，官方 Node 二进制跑不了"
    log_warn "自动切换为源码编译（需要 gcc/make，首次安装较慢）"
    force_build_from_source=1
  fi

  # 架构映射（npmmirror 上 x86_64 → x64，aarch64 → arm64）
  local arch_tag
  case "${arch}" in
    x86_64|amd64) arch_tag="x64" ;;
    aarch64|arm64) arch_tag="arm64" ;;
    *) log_error "不支持的架构：${arch}"; return 1 ;;
  esac

  # ---- 路径 1：尝试 nvm ----
  _try_install_via_nvm() {
    log_info "尝试 nvm（Node Version Manager）..."
    # nvm 安装脚本会自己 clone nvm 仓库到 $HOME/.nvm
    # 设置 NVM_SOURCE 让 nvm install 走 npmmirror 的二进制下载
    export NVM_NODEJS_ORG_MIRROR="${NODE_BINARY_MIRROR}"

    # 优先用 gitee 镜像（国内网络快得多），失败回退 GitHub
    if curl -fsSL "${NVM_INSTALL_URL}" 2>/dev/null | bash 2>&1; then
      log_ok "nvm 安装完成"
    else
      log_warn "gitee nvm 镜像失败，尝试 GitHub 官方源..."
      if curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh 2>/dev/null | bash 2>&1; then
        log_ok "nvm 从 GitHub 安装完成"
      else
        log_warn "nvm 安装失败，回退到预编译二进制方式"
        return 1
      fi
    fi

    # source nvm 到当前 shell
    export NVM_DIR="${HOME}/.nvm"
    # shellcheck disable=SC1090
    [ -s "${NVM_DIR}/nvm.sh" ] && . "${NVM_DIR}/nvm.sh"

    # 安装指定 LTS 版本
    local nvm_install_args=("${NODE_LTS_VERSION}")
    if [ "${force_build_from_source}" = "1" ]; then
      nvm_install_args+=("--build-from-source")
    fi
    log_info "nvm install ${nvm_install_args[*]} ..."
    if nvm install "${nvm_install_args[@]}" 2>&1 && nvm alias default "${NODE_LTS_VERSION}" 2>&1; then
      nvm use "${NODE_LTS_VERSION}" >/dev/null 2>&1
      log_ok "Node.js $(node --version 2>/dev/null) 已通过 nvm 就绪"
      return 0
    fi
    log_warn "nvm install 失败，回退预编译二进制"
    return 1
  }

  # ---- 路径 2：直接下载预编译二进制 ----
  _try_install_via_binary() {
    log_info "从 npmmirror CDN 下载预编译二进制..."
    local os_tag
    case "${os_type}" in
      Linux) os_tag="linux" ;;
      Darwin) os_tag="darwin" ;;
      *) return 1 ;;
    esac

    # 检查 xz 解压工具（部分精简 Linux 没装 xz-utils）
    if ! command -v xz >/dev/null 2>&1 && ! command -v unxz >/dev/null 2>&1; then
      log_warn "未找到 xz 解压工具，尝试安装 xz-utils..."
      if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq && apt-get install -y -qq xz-utils 2>&1 || true
      elif command -v yum >/dev/null 2>&1; then
        yum install -y -q xz 2>&1 || true
      fi
      command -v xz >/dev/null 2>&1 || command -v unxz >/dev/null 2>&1 || {
        log_error "无法安装 xz-utils，请手动：apt-get install -y xz-utils 或 yum install -y xz"
        return 1
      }
    fi

    local tmp_dir pkg_name pkg_url target_dir
    tmp_dir="$(mktemp -d)"
    pkg_name="node-${NODE_LTS_VERSION}-${os_tag}-${arch_tag}.tar.xz"
    pkg_url="${NODE_BINARY_MIRROR}/${NODE_LTS_VERSION}/${pkg_name}"
    target_dir="${HOME}/.local/node-${NODE_LTS_VERSION}"

    log_info "下载：${pkg_url}"
    if ! curl -fsSL -o "${tmp_dir}/${pkg_name}" "${pkg_url}" 2>&1; then
      log_error "下载失败：${pkg_url}"
      log_error "  检查网络/代理，或手动下载后解压到 ${target_dir}"
      rm -rf "${tmp_dir}"; return 1
    fi

    log_info "解压到 ${target_dir} ..."
    mkdir -p "${HOME}/.local"
    # tar.xz 解压（GNU tar 自带 xz 支持；macOS 需要先装，但 macOS 不会走这个分支因为有 brew）
    if ! tar -xJf "${tmp_dir}/${pkg_name}" -C "${HOME}/.local" 2>&1; then
      # 回退：手动 xz 解压
      log_info "tar -xJ 不可用，手动 xz 解压..."
      xz -dc "${tmp_dir}/${pkg_name}" | tar -xf - -C "${HOME}/.local" 2>&1 || {
        log_error "解压失败"; rm -rf "${tmp_dir}"; return 1
      }
    fi
    rm -rf "${tmp_dir}"

    # 软链到固定路径方便 PATH 指向
    rm -rf "${HOME}/.local/node-current"
    ln -s "${target_dir%-*}" "${HOME}/.local/node-current" 2>/dev/null || true
    # 上面软链可能不对——直接用完整路径
    export PATH="${HOME}/.local/${pkg_name%.tar.xz}/bin:${PATH}"

    # 验证
    if command -v node >/dev/null 2>&1; then
      log_ok "Node.js $(node --version 2>/dev/null) 已就绪（${HOME}/.local/）"
      log_info "node 路径：$(command -v node)"
    else
      log_error "安装后仍找不到 node，PATH=${PATH}"
      return 1
    fi
    return 0
  }

  # ---- 尝试顺序：nvm → 预编译（仅 glibc >= 2.28 才走 binary）----
  if _try_install_via_nvm; then
    : # nvm 成功（glibc 旧时已自动 --build-from-source）
  elif [ "${force_build_from_source}" = "1" ]; then
    log_error "GLIBC ${glibc_version} < 2.28 且 nvm 源码编译也失败"
    log_error "请手动升级系统 glibc，或手动安装 Node.js 后重试"
    log_error "  CentOS 7 临时方案: yum install centos-release-scl && yum install rh-nodejs18-nodejs"
    log_error "  或：curl -fsSL https://rpm.nodesource.com/setup_18.x | bash - && yum install nodejs"
  elif _try_install_via_binary; then
    : # binary 成功
  else
    log_error "Node.js 自动安装失败"
    log_error "请手动安装后重跑 setup.sh："
    log_error "  macOS:   brew install node"
    log_error "  Linux:   curl -fsSL ${NODE_BINARY_MIRROR}/${NODE_LTS_VERSION}/node-${NODE_LTS_VERSION}-linux-${arch_tag}.tar.xz | tar -xJ -C /usr/local --strip-components=1"
    return 1
  fi

  # ---- 持久化 PATH（nvm 已成功的话会追加 NVM_DIR init；二进制成功的话追加 node-current/bin）----
  # install_via_npm 会在此基础上再追加 npm_prefix/bin
  _persist_path || true

  # 验证 node/npm 可用
  log_ok "Node.js: $(node --version 2>/dev/null)"
  log_ok "npm:     $(npm --version 2>/dev/null)"
  return 0
}

# ----------------------------------------------------------------------------
# 持久化 PATH 条目到 shell rc 文件（可多次调用，自动去重）
#   用法：_persist_path [extra_path1] [extra_path2] ...
#     内置追加：NVM_DIR init（若 ~/.nvm/nvm.sh 存在）、~/.local/node-current/bin
#     额外追加：从参数传入的路径（例如 npm_prefix/bin）
# ----------------------------------------------------------------------------
_persist_path() {
  local rc_file="" rc_alt="${HOME}/.bashrc"
  case "${SHELL:-}" in
    */zsh)  rc_file="${HOME}/.zshrc" ;;
    */bash) rc_file="${HOME}/.bashrc" ;;
    *)      rc_file="${HOME}/.profile" ;;
  esac

  local need_nvm_init=0
  local need_node_bin=0
  [ -s "${HOME}/.nvm/nvm.sh" ] && need_nvm_init=1
  [ -d "${HOME}/.local/node-current/bin" ] && need_node_bin=1

  local nvm_init='export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"'
  local node_bin_path='export PATH="$HOME/.local/node-current/bin:$PATH"'

  local -a paths_to_add
  paths_to_add=()
  [ ${need_nvm_init} = 1 ] && paths_to_add+=("__NVM_INIT__")
  [ ${need_node_bin} = 1 ] && paths_to_add+=("${node_bin_path}")
  # 追加调用方传入的额外路径
  for extra in "$@"; do
    [ -n "${extra}" ] && paths_to_add+=("export PATH=\"${extra}:\$PATH\"")
  done

  if [ ${#paths_to_add[@]} -eq 0 ]; then
    return 0  # 没有需要持久化的条目
  fi

  local f p
  for f in "${rc_file}" "${rc_alt}"; do
    [ -z "${f}" ] && continue
    touch "${f}" 2>/dev/null || continue
    local section_added=0
    for p in "${paths_to_add[@]}"; do
      if [ "${p}" = "__NVM_INIT__" ]; then
        # nvm init 检查的是 NVM_DIR 关键字
        if ! grep -q "NVM_DIR.*\\.nvm" "${f}" 2>/dev/null; then
          if [ ${section_added} -eq 0 ]; then
            echo "" >> "${f}"
            echo "# >>> setup.sh: PATH init >>>" >> "${f}"
            section_added=1
          fi
          echo "${nvm_init}" >> "${f}"
        fi
      else
        # 普通 PATH 条目：用 grep -q 检查关键部分
        local keyword="${p#export PATH=\"}"
        keyword="${keyword%%:\$PATH\"}"
        if ! grep -Fq "${keyword}" "${f}" 2>/dev/null; then
          if [ ${section_added} -eq 0 ]; then
            echo "" >> "${f}"
            echo "# >>> setup.sh: PATH init >>>" >> "${f}"
            section_added=1
          fi
          echo "${p}" >> "${f}"
        fi
      fi
    done
    if [ ${section_added} -eq 1 ]; then
      echo "# <<< setup.sh <<<" >> "${f}"
    fi
  done
  log_info "PATH 已持久化（新开终端自动生效；或执行 source ~/.bashrc）"
}

# ----------------------------------------------------------------------------
# Preflight —— 环境预检
#   Node.js 缺失/版本低时自动安装（可通过 --install-node / --no-install-node 控制）
# ----------------------------------------------------------------------------
preflight() {
  local os_type node_major
  os_type="$(uname -s 2>/dev/null || echo Unknown)"
  case "${os_type}" in
    Darwin|Linux) log_info "系统：${os_type}" ;;
    *) log_error "不支持的系统：${os_type}（需要 macOS 或 Linux）"; return 1 ;;
  esac

  # ---- Node.js 检查 ----
  local need_install_node=0
  if ! command -v node >/dev/null 2>&1; then
    log_warn "未检测到 Node.js（需要 >= ${NODE_MIN_MAJOR}）"
    need_install_node=1
  else
    node_major="$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
    if [ "${node_major}" -lt "${NODE_MIN_MAJOR}" ]; then
      log_warn "Node.js 版本过低：$(node --version 2>/dev/null)（需要 >= ${NODE_MIN_MAJOR}）"
      need_install_node=1
    else
      log_ok "Node.js: $(node --version 2>/dev/null)"
    fi
  fi

  if [ "${need_install_node}" = "1" ]; then
    if _should_install_node; then
      install_node_lts || return 1
      # 装完再验一遍
      if ! command -v node >/dev/null 2>&1; then
        log_error "Node.js 安装后仍找不到 node 命令（PATH=${PATH}）"; return 1
      fi
      node_major="$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
      [ "${node_major}" -lt "${NODE_MIN_MAJOR}" ] && {
        log_error "Node.js 安装版本仍不满足 >= ${NODE_MIN_MAJOR}"; return 1
      }
    else
      log_error "请先手动安装 Node.js >= ${NODE_MIN_MAJOR} 后重跑 setup.sh"
      log_error "  或加 --install-node 让 setup.sh 自动安装："
      log_error "    curl -fsSL https://raw.githubusercontent.com/weiransoft/DeepCodeX/main/setup.sh | bash -s -- --install-node"
      return 1
    fi
  fi

  # ---- npm 检查 ----
  if ! command -v npm >/dev/null 2>&1; then
    log_error "未找到 npm（通常随 Node.js 一起安装）"; return 1
  fi
  log_ok "npm: $(npm --version 2>/dev/null)"

  # ---- git 检查（仅 source 模式）----
  if [ "${INSTALL_MODE}" = "source" ]; then
    if ! command -v git >/dev/null 2>&1; then
      log_error "源码模式需要 git：apt-get install -y git 或 brew install git"; return 1
    fi
    command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || \
      log_warn "未找到 curl/wget；部分镜像拉取会不可用（git clone 仍可走 HTTPS）"
  fi
  return 0
}

# ----------------------------------------------------------------------------
# Mode 1: npm global install (fastest, CLI only)
#   --force: 先 npm uninstall -g 清干净，再重新 install
# ----------------------------------------------------------------------------
install_via_npm() {
  log_info "==== mode: release tarball（GitHub Release → 本地 npm install -g）===="

  # Release 下载 URL：
  #   默认 latest  → https://github.com/weiransoft/DeepCodeX/releases/latest/download/deepcode-cli.tgz
  #   指定 tag     → https://github.com/weiransoft/DeepCodeX/releases/download/v0.4.2/deepcode-cli.tgz
  # asset 名固定为 deepcode-cli.tgz（每次 release 覆盖上传），避免 setup.sh 解析版本号
  local release_url release_tgz tgz_path
  if [ -n "${RELEASE_TAG:-}" ]; then
    release_url="https://github.com/weiransoft/DeepCodeX/releases/download/${RELEASE_TAG}/deepcode-cli.tgz"
    log_info "指定版本: ${RELEASE_TAG}"
  else
    release_url="https://github.com/weiransoft/DeepCodeX/releases/latest/download/deepcode-cli.tgz"
    log_info "拉取最新 Release（或用 --tag 指定版本）"
  fi
  tgz_path="$(mktemp -t deepcode-cli-XXXXXX.tgz)"

  # ---- 下载 tarball（带超时 + 重试）----
  log_info "下载: ${release_url}"
  local max_attempts=3 attempt=1
  while [ "${attempt}" -le "${max_attempts}" ]; do
    if curl -fsSL --connect-timeout 15 --max-time 180 \
        -o "${tgz_path}" "${release_url}" 2>&1; then
      break
    fi
    if [ "${attempt}" = "${max_attempts}" ]; then
      log_error "下载失败（${max_attempts} 次尝试）: ${release_url}"
      log_error "检查: GitHub Release 是否已上传 deepcode-cli.tgz"
      rm -f "${tgz_path}"
      return 1
    fi
    log_warn "下载失败，${attempt}/${max_attempts}，2s 后重试..."
    sleep 2
    attempt=$((attempt + 1))
  done

  # 校验下载文件（必须是有效的 tarball）
  if ! tar tzf "${tgz_path}" >/dev/null 2>&1; then
    log_error "下载的文件不是有效的 tarball（可能 Release 不存在或 404）"
    log_error "URL: ${release_url}"
    rm -f "${tgz_path}"
    return 1
  fi
  log_ok "下载完成（$(du -h "${tgz_path}" | cut -f1)）"

  # ---- --force: 先卸载旧版本 ----
  if [ "${FORCE_REINSTALL}" = "1" ]; then
    log_info "--force: 先卸载旧版本..."
    npm uninstall -g @vegamo/deepcode-cli 2>&1 || log_warn "卸载跳过（可能未安装）"
  fi

  # ---- 从本地 tarball 安装 ----
  if ! npm install -g "${tgz_path}" 2>&1; then
    log_error "npm install -g ${tgz_path} failed"
    rm -f "${tgz_path}"
    return 1
  fi
  log_ok "npm install 完成"
  rm -f "${tgz_path}"

  # ---- 关键：取 npm 全局 prefix，确保 bin 目录进 PATH ----
  local npm_prefix npm_bin_dir
  npm_prefix="$(npm config get prefix 2>/dev/null || echo "")"
  npm_bin_dir="${npm_prefix}/bin"
  if [ -n "${npm_bin_dir}" ] && [ -d "${npm_bin_dir}" ]; then
    case ":${PATH}:" in
      *":${npm_bin_dir}:"*) : ;;
      *) export PATH="${npm_bin_dir}:${PATH}" ;;
    esac
    _persist_path "${npm_bin_dir}" || true
  fi

  # ---- 诊断 deepcode 可执行性 ----
  local cli_path="" cli_ver=""
  cli_path="$(command -v deepcode 2>/dev/null || echo "")"
  if [ -z "${cli_path}" ]; then
    if [ -x "${npm_bin_dir}/deepcode" ]; then
      cli_path="${npm_bin_dir}/deepcode"
      log_warn "deepcode 已安装但当前 shell PATH 未包含 ${npm_bin_dir}"
      log_warn "  修复: source ~/.bashrc  或  export PATH=\"${npm_bin_dir}:\$PATH\""
    else
      log_error "deepcode 未找到（npm install 可能没把它链接到 bin 目录）"
      log_error "  npm_prefix=${npm_prefix}"
      return 1
    fi
  fi
  cli_ver="$("${cli_path}" --version 2>&1 | head -1 || echo "")"
  log_ok "deepcode: ${cli_path}"
  [ -n "${cli_ver}" ] && log_ok "  version: ${cli_ver}"

  # 多版本告警
  local all_deepcode deepcode_count
  all_deepcode="$(command -a deepcode 2>/dev/null | sort -u || echo "")"
  deepcode_count="$(echo "${all_deepcode}" | grep -c . || true)"
  if [ "${deepcode_count}" -gt 1 ]; then
    log_warn "PATH 上有 ${deepcode_count} 个 deepcode（可能是多次安装残留）："
    echo "${all_deepcode}" | while IFS= read -r p; do log_warn "  ${p}"; done
    log_warn "清理: npm uninstall -g @vegamo/deepcode-cli（多 prefix 重复执行）"
  fi
  return 0
}

# ----------------------------------------------------------------------------
# Mode 2: git clone + scripts/install.sh
# ----------------------------------------------------------------------------
clone_and_install() {
  log_info "==== mode: source ===="
  log_info "  repo     : ${GIT_REPO}"
  log_info "  branch   : ${DEFAULT_BRANCH}"
  log_info "  dir      : ${INSTALL_DIR}"

  if [ -d "${INSTALL_DIR}/.git" ]; then
    log_info "dir exists, updating..."
    if [ "${UPDATE_EXISTING}" = "1" ]; then
      if (cd "${INSTALL_DIR}" && git fetch --depth=1 origin "${DEFAULT_BRANCH}" && \
          git checkout -q "${DEFAULT_BRANCH}" && \
          git pull --ff-only origin "${DEFAULT_BRANCH}") 2>&1; then
        log_ok "repo updated"
      else
        log_warn "git pull failed; keeping working tree as-is"
        (cd "${INSTALL_DIR}" && git checkout -q "${DEFAULT_BRANCH}" 2>/dev/null) || \
          log_error "update failed; delete ${INSTALL_DIR} and retry"
      fi
    else
      log_warn "UPDATE_EXISTING=0, skipping git pull"
    fi
  else
    log_info "cloning to ${INSTALL_DIR} ..."
    local clone_flags=()
    if [ "${SHALLOW_CLONE}" = "1" ]; then
      clone_flags+=(--depth 1)
    fi
    clone_flags+=(--branch "${DEFAULT_BRANCH}" --single-branch)

    if ! git clone "${clone_flags[@]}" "${GIT_REPO}" "${INSTALL_DIR}" 2>&1; then
      log_error "git clone failed"
      log_error "  repo : ${GIT_REPO}"
      log_error "  hint : check network/proxy, or set GIT_REPO to your mirror"
      return 1
    fi
    log_ok "repo cloned"
  fi

  # delegate to scripts/install.sh (npm_install + sqlite3 + build + smoke)
  local -a env_passthrough
  env_passthrough=()
  [ "${SKIP_BUILD:-0}" = "1" ] && env_passthrough+=(SKIP_BUILD=1)
  [ "${SKIP_SMOKE:-0}" = "1" ] && env_passthrough+=(SKIP_SMOKE=1)
  [ -n "${NPM_REGISTRY:-}" ] && env_passthrough+=(NPM_REGISTRY="${NPM_REGISTRY}")

  log_info "running scripts/install.sh ..."
  # env_passthrough 可能为空数组，用 ${arr[@]+"${arr[@]}"} 绕过 set -u
  if ! (cd "${INSTALL_DIR}" && env "${env_passthrough[@]+"${env_passthrough[@]}"}" bash scripts/install.sh); then
    log_error "scripts/install.sh failed (see above)"; return 2
  fi

  log_ok "DeepCodeX source install complete!"
  log_info "next:"
  log_info "  cd ${INSTALL_DIR}"
  log_info "  node scripts/start.js    # CLI"
  log_info "  # Web service: see README for LLM env setup"
  return 0
}

# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
main() {
  log_info "==== DeepCodeX setup.sh ===="
  preflight || exit $?

  case "${INSTALL_MODE}" in
    npm)    install_via_npm   || exit $? ;;
    source) clone_and_install || exit $? ;;
    *)      log_error "unknown --mode: ${INSTALL_MODE} (choose source or npm)"; exit 1 ;;
  esac

  log_ok "all done"
}

main "$@"
exit $?