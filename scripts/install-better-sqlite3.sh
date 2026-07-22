#!/usr/bin/env bash
# ============================================================================
# install-better-sqlite3.sh —— better-sqlite3 原生模块安装与重编译脚本
# ============================================================================
#
# 用途：
#   1. 验证 better-sqlite3 已通过 npm optionalDependencies 安装
#   2. 在 prebuilt 二进制缺失或损坏时，基于 node-gyp 重新编译
#   3. 验证 better-sqlite3 可被 Node.js 正常加载（含 FTS5 可用性检查）
#
# 退出码语义（与 ADR-P4-001 §6.1 一致）：
#   0 = 成功（better-sqlite3 已安装并可加载，FTS5 可用）
#   1 = 环境预检失败（Node.js 版本不符 / 必要工具链缺失）
#   2 = 重建失败（node-gyp 编译失败 / 安装失败 / 加载验证失败）
#
# 关联文档：
#   - ADR：docs/dev/ADR-P4-001-better-sqlite3.md
#   - 架构师审查：docs/enterprise/EAG-P5-ARCHITECTURE.md §2.4 / §7
#   - 任务分解：docs/enterprise/EAG-P5-TASKS.md TASK-P5-1.1-002
#
# 使用方式：
#   bash scripts/install-better-sqlite3.sh           # 安装并验证
#   npm run rebuild:sqlite                            # 通过 npm script 调用
# ============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# 全局变量与常量
# ----------------------------------------------------------------------------

# 脚本所在目录的绝对路径（用于定位项目根）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 项目根目录（脚本的上一级）
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# better-sqlite3 包路径
SQLITE3_PACKAGE_DIR="${PROJECT_ROOT}/node_modules/better-sqlite3"
# 退出码常量（与文档一致）
EXIT_SUCCESS=0
EXIT_PREFLIGHT_FAILED=1
EXIT_REBUILD_FAILED=2

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

# 输出 WARN 级别日志（黄色）
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
# 环境预检（Preflight）
# ----------------------------------------------------------------------------

# 检查 Node.js 是否可用且版本满足 >= 18
# 退出码：1 表示预检失败
preflight_node() {
  if ! command -v node >/dev/null 2>&1; then
    log_error "未找到 Node.js 可执行文件，请先安装 Node.js >= 18"
    return "${EXIT_PREFLIGHT_FAILED}"
  fi

  local node_version
  node_version="$(node --version 2>/dev/null | sed 's/^v//')"
  if [ -z "${node_version}" ]; then
    log_error "无法获取 Node.js 版本"
    return "${EXIT_PREFLIGHT_FAILED}"
  fi

  # 提取主版本号（例如 18.19.0 → 18）
  local node_major
  node_major="$(echo "${node_version}" | cut -d. -f1)"

  if [ "${node_major}" -lt 18 ]; then
    log_error "Node.js 版本 ${node_version} 不满足要求（>= 18）"
    return "${EXIT_PREFLIGHT_FAILED}"
  fi

  log_info "Node.js 版本检查通过：v${node_version}"
  return 0
}

# 检查 npm 是否可用
preflight_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    log_error "未找到 npm 可执行文件，请确保 npm 随 Node.js 一起安装"
    return "${EXIT_PREFLIGHT_FAILED}"
  fi
  log_info "npm 可用性检查通过"
  return 0
}

# 检查 Python 3 是否可用（node-gyp 编译需要）
# 仅在需要重建时才检查，预检阶段先记录状态
preflight_python() {
  if command -v python3 >/dev/null 2>&1; then
    log_info "Python 3 可用性检查通过：$(python3 --version 2>&1)"
    return 0
  elif command -v python >/dev/null 2>&1; then
    log_info "Python 可用性检查通过：$(python --version 2>&1)"
    return 0
  else
    log_warn "未找到 Python，若需要重新编译 better-sqlite3 将失败"
    return 0
  fi
}

# 检查 make / g++ 是否可用（类 Unix 系统编译工具链）
preflight_build_tools() {
  local os_type
  os_type="$(uname -s 2>/dev/null || echo "Unknown")"

  if [ "${os_type}" = "Darwin" ] || [ "${os_type}" = "Linux" ]; then
    if ! command -v make >/dev/null 2>&1; then
      log_warn "未找到 make，若需要重新编译 better-sqlite3 将失败"
    fi
    if ! command -v g++ >/dev/null 2>&1 && ! command -v c++ >/dev/null 2>&1; then
      log_warn "未找到 g++/c++，若需要重新编译 better-sqlite3 将失败"
    fi
  fi

  # Windows 平台通过 windows-build-tools 或 Visual Studio Build Tools 提供
  if [ "${os_type}" = "MINGW"* ] || [ "${os_type}" = "MSYS"* ] || [ "${os_type}" = "CYGWIN"* ]; then
    log_info "Windows 平台检测到，编译工具链预检跳过（依赖 Visual Studio Build Tools）"
  fi

  return 0
}

# ----------------------------------------------------------------------------
# macOS CLT（Command Line Tools）Receipt 修复
# ----------------------------------------------------------------------------

# 检查 macOS CLT Receipt 是否完整（node-gyp 通过 pkgutil 检查 CLT 版本）
# 返回值：0 = Receipt 完整，非 0 = Receipt 丢失
check_clt_receipt() {
  local os_type
  os_type="$(uname -s 2>/dev/null || echo "Unknown")"

  # 非 macOS 平台直接返回成功
  if [ "${os_type}" != "Darwin" ]; then
    return 0
  fi

  # 检查三个可能的 CLT pkg-id 是否都有 Receipt
  # gyp 的 xcode_emulation.py 依次检查：
  #   1. com.apple.pkg.CLTools_Executables（macOS Mavericks+）
  #   2. com.apple.pkg.DeveloperToolsCLILeo（独立安装包）
  #   3. com.apple.pkg.DeveloperToolsCLI（从 Xcode 安装）
  local pkg_id
  for pkg_id in "com.apple.pkg.CLTools_Executables" "com.apple.pkg.DeveloperToolsCLILeo" "com.apple.pkg.DeveloperToolsCLI"; do
    if /usr/sbin/pkgutil --pkg-info "${pkg_id}" >/dev/null 2>&1; then
      return 0
    fi
  done

  # 三个 pkg-id 都没有 Receipt，检查 softwareupdate --history 是否有 CLT 记录
  # gyp 的 CLTVersion() 会回退到 softwareupdate --history 检查
  if /usr/sbin/softwareupdate --history 2>/dev/null | grep -q "Command Line Tools"; then
    return 0
  fi

  # Receipt 完全丢失
  return 1
}

# 尝试修复 macOS CLT Receipt
# 退出码：1 表示修复失败（需要用户手动处理）
repair_clt_receipt() {
  local os_type
  os_type="$(uname -s 2>/dev/null || echo "Unknown")"

  if [ "${os_type}" != "Darwin" ]; then
    return 0
  fi

  log_warn "检测到 macOS CLT Receipt 丢失，尝试修复 ..."

  # 方法 1：检查 CLT 实际安装路径是否存在
  # 如果 /Library/Developer/CommandLineTools 存在但 Receipt 丢失，
  # 可以通过重新安装 CLT 来修复 Receipt
  if [ -d "/Library/Developer/CommandLineTools" ]; then
    log_info "CLT 安装目录存在：/Library/Developer/CommandLineTools"
    log_info "Receipt 丢失，尝试通过 softwareupdate 修复 ..."

    # 方法 1a：通过 softwareupdate 查找并安装 CLT 更新
    local clt_update
    clt_update="$(/usr/sbin/softwareupdate --list 2>/dev/null | grep -i "Command Line Tools" | head -1 | sed 's/.*\*\s*//' | sed 's/.*-\s*//' || true)"

    if [ -n "${clt_update}" ]; then
      log_info "发现 CLT 更新：${clt_update}，尝试安装（可能需要 sudo）..."
      if sudo /usr/sbin/softwareupdate --install "${clt_update}" 2>&1; then
        log_success "CLT 更新安装完成"
        return 0
      else
        log_warn "CLT 更新安装失败（可能需要用户交互）"
      fi
    else
      log_warn "softwareupdate 未找到 CLT 更新"
    fi

    # 方法 1b：提示用户手动修复
    log_warn "========================================"
    log_warn " CLT Receipt 修复需要用户手动操作"
    log_warn "========================================"
    log_warn "请在终端执行以下命令之一："
    log_warn ""
    log_warn "  方案 A（推荐）：重新安装 CLT"
    log_warn "    sudo rm -rf /Library/Developer/CommandLineTools"
    log_warn "    xcode-select --install"
    log_warn ""
    log_warn "  方案 B：重置 Xcode 路径"
    log_warn "    sudo xcode-select --reset"
    log_warn ""
    log_warn "执行完成后，重新运行：bash scripts/install-better-sqlite3.sh"
    return 1
  fi

  # CLT 完全未安装
  log_error "CLT 未安装，请执行：xcode-select --install"
  return 1
}

# ----------------------------------------------------------------------------
# better-sqlite3 安装与重建
# ----------------------------------------------------------------------------

# 检查 better-sqlite3 是否已安装到 node_modules
# 返回值：0 = 已安装，非 0 = 未安装
check_sqlite3_installed() {
  if [ -d "${SQLITE3_PACKAGE_DIR}" ] && [ -f "${SQLITE3_PACKAGE_DIR}/package.json" ]; then
    return 0
  fi
  return 1
}

# 通过 npm optionalDependencies 重新安装 better-sqlite3
# 退出码：2 表示安装失败
#
# 实现说明：
#   项目根 package.json 中部分子包使用了 pnpm 风格的 "workspace:*" 协议，
#   npm 在解析时可能抛出 EUNSUPPORTEDPROTOCOL 错误。为绕过此既有兼容性问题，
#   采用"临时目录安装 + 复制到 node_modules"的策略：
#   1. 在 mktemp 临时目录中初始化独立的 package.json（不依赖项目根 package.json）
#   2. 在临时目录中执行 npm install better-sqlite3
#   3. 将安装好的 better-sqlite3 包目录复制到项目根 node_modules
#   4. 清理临时目录
install_sqlite3() {
  log_info "通过 npm 重新安装 better-sqlite3 ..."

  # 创建临时安装目录（mktemp -d 保证唯一性，避免并发冲突）
  local temp_dir
  temp_dir="$(mktemp -d 2>/dev/null || mktemp -d -t 'better-sqlite3-install')"
  log_info "临时安装目录：${temp_dir}"

  # 在临时目录中初始化最小化的 package.json（避免触发 workspace 协议解析）
  cat > "${temp_dir}/package.json" <<'PKGJSON'
{
  "name": "better-sqlite3-installer",
  "version": "1.0.0",
  "private": true,
  "description": "临时安装目录，用于隔离 better-sqlite3 的 npm install"
}
PKGJSON

  # 在临时目录中执行 npm install better-sqlite3
  # 使用 --no-save 避免修改临时 package.json
  # 使用 --no-package-lock 避免生成 lock 文件
  # 使用 --omit=optional 避免安装 better-sqlite3 的可选依赖（减少安装体积）
  # 使用 --ignore-scripts 跳过 native 模块编译（由 rebuild_sqlite3 的三级回退策略处理）
  log_info "在临时目录中执行 npm install better-sqlite3（--ignore-scripts 跳过编译）..."
  if ! (cd "${temp_dir}" && npm install better-sqlite3@^11.0.0 --no-save --no-package-lock --omit=optional --ignore-scripts 2>&1); then
    log_error "npm install better-sqlite3 失败（临时目录策略）"
    rm -rf "${temp_dir}"
    return "${EXIT_REBUILD_FAILED}"
  fi

  # 验证临时目录中 better-sqlite3 已安装
  local temp_sqlite3_dir="${temp_dir}/node_modules/better-sqlite3"
  if [ ! -d "${temp_sqlite3_dir}" ] || [ ! -f "${temp_sqlite3_dir}/package.json" ]; then
    log_error "临时目录中未找到 better-sqlite3 包：${temp_sqlite3_dir}"
    rm -rf "${temp_dir}"
    return "${EXIT_REBUILD_FAILED}"
  fi

  # 确保项目根 node_modules 目录存在
  mkdir -p "${PROJECT_ROOT}/node_modules"

  # 复制 better-sqlite3 到项目根 node_modules
  # 使用 cp -R 保留文件权限与符号链接
  log_info "复制 better-sqlite3 到项目 node_modules ..."
  rm -rf "${SQLITE3_PACKAGE_DIR}"
  if ! cp -R "${temp_sqlite3_dir}" "${SQLITE3_PACKAGE_DIR}"; then
    log_error "复制 better-sqlite3 到 node_modules 失败"
    rm -rf "${temp_dir}"
    return "${EXIT_REBUILD_FAILED}"
  fi

  # 复制 better-sqlite3 的依赖（如 bindings）到项目 node_modules
  # 避免运行时 require 失败
  if [ -d "${temp_dir}/node_modules/bindings" ]; then
    rm -rf "${PROJECT_ROOT}/node_modules/bindings"
    cp -R "${temp_dir}/node_modules/bindings" "${PROJECT_ROOT}/node_modules/bindings" || true
  fi
  if [ -d "${temp_dir}/node_modules/file-uri-to-path" ]; then
    rm -rf "${PROJECT_ROOT}/node_modules/file-uri-to-path"
    cp -R "${temp_dir}/node_modules/file-uri-to-path" "${PROJECT_ROOT}/node_modules/file-uri-to-path" || true
  fi

  # 清理临时目录
  rm -rf "${temp_dir}"

  # 验证最终安装结果
  if ! check_sqlite3_installed; then
    log_error "复制后仍未在 node_modules 中找到 better-sqlite3"
    return "${EXIT_REBUILD_FAILED}"
  fi

  log_success "better-sqlite3 npm 安装完成（临时目录策略）"
  return 0
}

# 基于 node-gyp 重新编译 better-sqlite3 native 模块
# 用于 prebuilt 二进制不可用或损坏的场景
# 退出码：2 表示重建失败
#
# 实现说明：
#   采用三级回退策略：
#   1. 优先使用 better-sqlite3 自带的 install 脚本（prebuild-install || node-gyp rebuild）
#   2. 若失败，尝试直接调用 node-gyp rebuild
#   3. 若仍失败（如 macOS CLT Receipt 丢失），回退到直接 clang++ 手动编译
rebuild_sqlite3() {
  log_info "基于 node-gyp 重新编译 better-sqlite3 ..."

  if [ ! -d "${SQLITE3_PACKAGE_DIR}" ]; then
    log_error "better-sqlite3 包目录不存在：${SQLITE3_PACKAGE_DIR}"
    return "${EXIT_REBUILD_FAILED}"
  fi

  cd "${SQLITE3_PACKAGE_DIR}"

  # === 策略 1：优先使用 better-sqlite3 自带的 install 脚本 ===
  # 已封装 prebuild-install（下载预编译二进制）|| node-gyp rebuild（源码编译）
  if [ -f "install.js" ] || grep -q '"install"' package.json 2>/dev/null; then
    log_info "执行 better-sqlite3 自带 install 脚本 ..."
    if npm run install 2>&1; then
      log_success "better-sqlite3 native 模块重编译完成（install 脚本）"
      return 0
    fi
    log_warn "better-sqlite3 install 脚本执行失败，尝试策略 2 ..."
  fi

  # === 策略 2：直接调用 node-gyp rebuild ===
  log_info "调用 node-gyp rebuild ..."
  if npx --no-install node-gyp rebuild 2>&1 || npx node-gyp rebuild 2>&1; then
    log_success "better-sqlite3 native 模块重编译完成（node-gyp）"
    return 0
  fi
  log_warn "node-gyp rebuild 失败，尝试策略 3（手动 clang++ 编译）..."

  # === 策略 3：手动 clang++ 编译（绕过 node-gyp 的 CLT Receipt 检查）===
  # 适用场景：macOS CLT Receipt 丢失导致 gyp 报错 "No Xcode or CLT version detected!"
  # 此策略直接调用 clang/clang++ 编译 sqlite3.c 和 better_sqlite3.cpp，
  # 完全绕过 node-gyp 的 gyp 配置阶段
  log_info "执行手动 clang++ 编译（绕过 node-gyp）..."
  if ! rebuild_sqlite3_manual; then
    log_error "手动 clang++ 编译失败，请检查 clang/clang++ 工具链是否完整"
    return "${EXIT_REBUILD_FAILED}"
  fi

  log_success "better-sqlite3 native 模块重编译完成（手动 clang++）"
  return 0
}

# 手动 clang++ 编译 better-sqlite3（绕过 node-gyp）
# 当 node-gyp 的 CLT Receipt 检查失败时使用此回退方案
# 退出码：2 表示编译失败
rebuild_sqlite3_manual() {
  log_info "手动编译 better-sqlite3（clang++ 直接编译，绕过 node-gyp）..."

  # 检测 macOS SDK 路径
  local sdk_root=""
  if [ "$(uname -s)" = "Darwin" ]; then
    sdk_root="$(xcrun --show-sdk-path 2>/dev/null || echo "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk")"
    if [ ! -d "${sdk_root}" ]; then
      log_error "macOS SDK 路径不存在：${sdk_root}"
      return "${EXIT_REBUILD_FAILED}"
    fi
    log_info "macOS SDK 路径：${sdk_root}"
  fi

  # 获取 Node.js 头文件路径（node-gyp 缓存目录）
  local node_version
  node_version="$(node --version | sed 's/^v//')"
  local node_include="${HOME}/Library/Caches/node-gyp/${node_version}/include/node"
  if [ ! -d "${node_include}" ]; then
    log_error "Node.js 头文件目录不存在：${node_include}"
    log_error "请先运行 'npx node-gyp install' 下载 Node.js 头文件"
    return "${EXIT_REBUILD_FAILED}"
  fi
  log_info "Node.js 头文件路径：${node_include}"

  # SQLite 源码目录
  local sqlite_dir="${SQLITE3_PACKAGE_DIR}/deps/sqlite3"
  if [ ! -f "${sqlite_dir}/sqlite3.c" ]; then
    log_error "SQLite 源码不存在：${sqlite_dir}/sqlite3.c"
    return "${EXIT_REBUILD_FAILED}"
  fi

  # 构建输出目录
  local build_dir="${SQLITE3_PACKAGE_DIR}/build/Release"
  mkdir -p "${build_dir}"

  # SQLite 编译定义（从 deps/defines.gypi 提取）
  # 这些定义启用了 FTS5、JSON1、RTREE 等关键特性
  local sqlite_defs=(
    -DHAVE_INT16_T=1 -DHAVE_INT32_T=1 -DHAVE_INT8_T=1 -DHAVE_STDINT_H=1
    -DHAVE_UINT16_T=1 -DHAVE_UINT32_T=1 -DHAVE_UINT8_T=1 -DHAVE_USLEEP=1
    -DSQLITE_DEFAULT_CACHE_SIZE=-16000
    -DSQLITE_DEFAULT_FOREIGN_KEYS=1
    -DSQLITE_DEFAULT_MEMSTATUS=0
    -DSQLITE_DEFAULT_WAL_SYNCHRONOUS=1
    -DSQLITE_DQS=0
    -DSQLITE_ENABLE_COLUMN_METADATA
    -DSQLITE_ENABLE_DBSTAT_VTAB
    -DSQLITE_ENABLE_DESERIALIZE
    -DSQLITE_ENABLE_FTS3
    -DSQLITE_ENABLE_FTS3_PARENTHESIS
    -DSQLITE_ENABLE_FTS4
    -DSQLITE_ENABLE_FTS5
    -DSQLITE_ENABLE_GEOPOLY
    -DSQLITE_ENABLE_JSON1
    -DSQLITE_ENABLE_MATH_FUNCTIONS
    -DSQLITE_ENABLE_RTREE
    -DSQLITE_ENABLE_STAT4
    -DSQLITE_ENABLE_UPDATE_DELETE_LIMIT
    -DSQLITE_LIKE_DOESNT_MATCH_BLOBS
    -DSQLITE_OMIT_DEPRECATED
    -DSQLITE_OMIT_PROGRESS_CALLBACK
    -DSQLITE_OMIT_SHARED_CACHE
    -DSQLITE_OMIT_TCL_VARIABLE
    -DSQLITE_SOUNDEX
    -DSQLITE_THREADSAFE=2
    -DSQLITE_TRACE_SIZE_LIMIT=32
    -DSQLITE_USE_URI=0
    -DNDEBUG
  )

  # 编译器选择（macOS 使用 clang/clang++）
  local cc="/usr/bin/clang"
  local cxx="/usr/bin/clang++"
  if [ "$(uname -s)" != "Darwin" ]; then
    cc="gcc"
    cxx="g++"
  fi

  # 编译 sqlite3.c（C99 标准）
  log_info "[1/3] 编译 sqlite3.c ..."
  local cflags="-std=c99 -O3 -w"
  if [ -n "${sdk_root}" ]; then
    cflags="${cflags} -isysroot ${sdk_root}"
  fi
  if ! ${cc} ${cflags} -I"${sqlite_dir}" "${sqlite_defs[@]}" \
    -c "${sqlite_dir}/sqlite3.c" -o "${build_dir}/sqlite3.o"; then
    log_error "编译 sqlite3.c 失败"
    return "${EXIT_REBUILD_FAILED}"
  fi

  # 编译 better_sqlite3.cpp（C++20 标准）
  # 注意：macOS CLT 的 C++ 标准库头文件可能在 SDK 的 usr/include/c++/v1 中，
  # 需要通过 -isystem 显式指定，否则会找不到 <climits> 等头文件
  log_info "[2/3] 编译 better_sqlite3.cpp ..."
  local cxxflags="-std=c++20 -stdlib=libc++ -O3"
  if [ -n "${sdk_root}" ]; then
    cxxflags="${cxxflags} -isysroot ${sdk_root} -isystem ${sdk_root}/usr/include/c++/v1"
  fi
  if ! ${cxx} ${cxxflags} \
    -I"${node_include}" \
    -I"${sqlite_dir}" \
    -I"${SQLITE3_PACKAGE_DIR}/src" \
    "${sqlite_defs[@]}" \
    -c "${SQLITE3_PACKAGE_DIR}/src/better_sqlite3.cpp" \
    -o "${build_dir}/better_sqlite3.o"; then
    log_error "编译 better_sqlite3.cpp 失败"
    return "${EXIT_REBUILD_FAILED}"
  fi

  # 链接 better_sqlite3.node（动态库）
  # -undefined dynamic_lookup 允许运行时解析 Node.js API 符号
  log_info "[3/3] 链接 better_sqlite3.node ..."
  local ldflags="-std=c++20 -stdlib=libc++ -dynamiclib"
  if [ -n "${sdk_root}" ]; then
    ldflags="${ldflags} -isysroot ${sdk_root} -undefined dynamic_lookup"
  fi
  if ! ${cxx} ${ldflags} \
    "${build_dir}/sqlite3.o" \
    "${build_dir}/better_sqlite3.o" \
    -o "${build_dir}/better_sqlite3.node"; then
    log_error "链接 better_sqlite3.node 失败"
    return "${EXIT_REBUILD_FAILED}"
  fi

  log_info "手动编译产物：${build_dir}/better_sqlite3.node"
  return 0
}

# ----------------------------------------------------------------------------
# 加载与 FTS5 可用性验证
# ----------------------------------------------------------------------------

# 通过 Node.js 验证 better-sqlite3 可加载且 FTS5 可用
# 退出码：2 表示加载或 FTS5 验证失败
verify_sqlite3_loadable() {
  log_info "验证 better-sqlite3 可加载性与 FTS5 可用性 ..."

  # 使用 heredoc 传递验证脚本给 node，避免创建临时文件
  if ! node --input-type=module -e '
    // 验证脚本：动态 require better-sqlite3，创建内存数据库，测试 FTS5 可用性
    let Database;
    try {
      // 使用 createRequire 加载 CommonJS 模块（better-sqlite3 是 CJS）
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      Database = require("better-sqlite3");
    } catch (err) {
      console.error("[ERROR] 加载 better-sqlite3 失败：" + err.message);
      process.exit(2);
    }

    let db;
    try {
      // 创建内存数据库（":memory:"）用于验证，不产生文件
      db = new Database(":memory:");
      // 验证 FTS5 可用性：尝试创建 FTS5 虚拟表
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS fts5_verify USING fts5(
          content,
          tokenize="porter unicode61"
        );
      `);
      // 插入测试数据并查询
      db.prepare("INSERT INTO fts5_verify(content) VALUES (?)").run("hello world");
      const row = db.prepare("SELECT content FROM fts5_verify WHERE fts5_verify MATCH ?").get("hello");
      if (!row || row.content !== "hello world") {
        console.error("[ERROR] FTS5 查询结果不符合预期");
        process.exit(2);
      }
      console.log("[INFO] FTS5 可用性验证通过");
    } catch (err) {
      console.error("[ERROR] better-sqlite3 加载或 FTS5 验证失败：" + err.message);
      process.exit(2);
    } finally {
      if (db) db.close();
    }
    console.log("[SUCCESS] better-sqlite3 加载验证通过");
  '; then
    log_error "better-sqlite3 加载或 FTS5 可用性验证失败"
    return "${EXIT_REBUILD_FAILED}"
  fi

  log_success "better-sqlite3 加载与 FTS5 验证通过"
  return 0
}

# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------

main() {
  log_info "==== better-sqlite3 安装与重编译脚本启动 ===="
  log_info "项目根目录：${PROJECT_ROOT}"

  # === 阶段 1：环境预检 ===
  log_info "==== 阶段 1：环境预检 ===="
  preflight_node || return $?
  preflight_npm || return $?
  preflight_python || true
  preflight_build_tools || true

  # === 阶段 1.5：macOS CLT Receipt 检查与修复 ===
  # node-gyp 通过 pkgutil 检查 CLT 版本，Receipt 丢失会导致编译失败
  # 此检查仅在 macOS 平台生效，且仅在需要从源码编译时才检查
  log_info "==== 阶段 1.5：macOS CLT Receipt 检查 ===="
  if ! check_clt_receipt; then
    log_warn "macOS CLT Receipt 丢失，可能导致 node-gyp 编译失败"
    # 尝试自动修复（可能需要 sudo，失败则提示用户）
    if ! repair_clt_receipt; then
      log_warn "CLT Receipt 自动修复失败，将继续尝试安装"
      log_warn "若安装失败，请按上述提示手动修复 CLT Receipt 后重试"
    fi
  else
    log_info "macOS CLT Receipt 检查通过"
  fi

  # === 阶段 2：检查 better-sqlite3 安装状态 ===
  log_info "==== 阶段 2：检查 better-sqlite3 安装状态 ===="
  if check_sqlite3_installed; then
    log_info "better-sqlite3 已安装于 ${SQLITE3_PACKAGE_DIR}"
  else
    log_warn "better-sqlite3 未安装，尝试通过 npm 安装 ..."
    install_sqlite3 || return $?
  fi

  # === 阶段 2.5：检查 native 模块是否已编译 ===
  # install_sqlite3 使用 --ignore-scripts 跳过编译，需要主动调用 rebuild_sqlite3
  local native_module="${SQLITE3_PACKAGE_DIR}/build/Release/better_sqlite3.node"
  if [ ! -f "${native_module}" ]; then
    log_info "==== 阶段 2.5：编译 better-sqlite3 native 模块 ===="
    log_warn "native 模块未编译：${native_module}"
    rebuild_sqlite3 || return $?
  else
    log_info "native 模块已存在：${native_module}"
  fi

  # === 阶段 3：验证 better-sqlite3 加载与 FTS5 可用性 ===
  log_info "==== 阶段 3：验证 better-sqlite3 加载与 FTS5 可用性 ===="
  if ! verify_sqlite3_loadable; then
    # 加载失败 → 尝试重建 native 模块
    log_warn "better-sqlite3 加载失败，尝试重新编译 native 模块 ..."
    rebuild_sqlite3 || return $?
    # 重建后再次验证
    verify_sqlite3_loadable || return $?
  fi

  # === 阶段 4：输出最终状态 ===
  log_info "==== 阶段 4：输出最终状态 ===="
  log_success "better-sqlite3 安装与验证全部通过"
  log_info "  - 包路径：${SQLITE3_PACKAGE_DIR}"
  log_info "  - 加载状态：可加载"
  log_info "  - FTS5 状态：可用"
  log_info "  - 退出码：${EXIT_SUCCESS}"
  return "${EXIT_SUCCESS}"
}

# ----------------------------------------------------------------------------
# 脚本入口
# ----------------------------------------------------------------------------

# 调用主流程并捕获退出码
main
exit_code=$?

if [ "${exit_code}" -ne "${EXIT_SUCCESS}" ]; then
  log_error "脚本执行失败，退出码：${exit_code}"
fi

exit "${exit_code}"
