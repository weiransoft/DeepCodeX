#!/usr/bin/env bash
# ============================================================================
# setup.sh -- DeepCodeX one-click install entry (directly runnable from GitHub Raw)
# ============================================================================
#
# Purpose:
#   One-liner to pull this script from GitHub and install:
#     curl -fsSL https://raw.githubusercontent.com/weiransoft/DeepCodeX/main/setup.sh | bash
#
#   Internally:
#     1. Preflight (Node.js >= 18, git, curl)
#     2. Git clone the repo (shallow by default)
#     3. Delegate to scripts/install.sh (mirrors + npm install + build + smoke)
#
#   Two install modes (--mode flag):
#     source  (default) full source clone + npm install + build -- for dev/hacking
#     npm     npm global install of published CLI only -- fastest, just the 'deepcode' command
#
# Examples:
#   # One-liner: default source install to ~/DeepCodeX
#   curl -fsSL https://raw.githubusercontent.com/weiransoft/DeepCodeX/main/setup.sh | bash
#
#   # Install to custom dir + specific branch
#   curl -fsSL https://raw.githubusercontent.com/weiransoft/DeepCodeX/main/setup.sh | \
#     bash -s -- --dir ~/code/dcx --branch main
#
#   # CLI only (npm global, skip clone/build)
#   curl -fsSL https://raw.githubusercontent.com/weiransoft/DeepCodeX/main/setup.sh | \
#     bash -s -- --mode npm
#
#   # China mirror (npmmirror)
#   curl -fsSL https://raw.githubusercontent.com/weiransoft/DeepCodeX/main/setup.sh | \
#     NPM_REGISTRY=https://registry.npmmirror.com bash
#
# Env overrides (each can be overwritten by same-name env var):
#   GIT_REPO         git repo URL (default https://github.com/weiransoft/DeepCodeX.git)
#   DEFAULT_BRANCH   branch/tag to checkout (default main)
#   INSTALL_DIR      install directory (default ~/DeepCodeX)
#   NPM_REGISTRY     npm registry (default: scripts/install.sh built-in npmmirror)
#   SKIP_BUILD       1 = skip build phase (default 0)
#   SKIP_SMOKE       1 = skip smoke test (default 0)
# ============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# Constants and defaults (all overridable via env)
# ----------------------------------------------------------------------------
GIT_REPO="${GIT_REPO:-https://github.com/weiransoft/DeepCodeX.git}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/DeepCodeX}"
INSTALL_MODE="${INSTALL_MODE:-source}"
SHALLOW_CLONE="${SHALLOW_CLONE:-1}"
UPDATE_EXISTING="${UPDATE_EXISTING:-1}"
NODE_MIN_MAJOR=18

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
# Help text (single-quoted heredoc -- NO variable expansion)
# ----------------------------------------------------------------------------
usage() {
  cat <<'EOF'
setup.sh -- DeepCodeX one-click install entry

Usage: setup.sh [options]

Options:
  --mode <source|npm>  install mode (default: source)
                       source = git clone + npm install + build
                       npm    = npm install -g @vegamo/deepcode-cli
  --dir <path>         install directory (default: INSTALL_DIR env or ~/DeepCodeX)
  --branch <name>      git branch/tag to checkout (default: main)
  --deep               full clone (default: shallow --depth=1)
  --no-update          skip git pull when dir already exists
  --skip-build         skip build phase (pass-through to scripts/install.sh)
  --skip-smoke         skip smoke test (pass-through to scripts/install.sh)
  -h, --help           show this help

One-liner:
  curl -fsSL https://raw.githubusercontent.com/weiransoft/DeepCodeX/main/setup.sh | bash
EOF
}

# ----------------------------------------------------------------------------
# Argument parsing
# ----------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --mode)        INSTALL_MODE="$2"; shift 2 ;;
    --dir)         INSTALL_DIR="$2";  shift 2 ;;
    --branch)      DEFAULT_BRANCH="$2"; shift 2 ;;
    --deep)        SHALLOW_CLONE=0; shift ;;
    --no-update)   UPDATE_EXISTING=0; shift ;;
    --skip-build)  SKIP_BUILD=1; shift ;;
    --skip-smoke)  SKIP_SMOKE=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             log_error "unknown option: $1 (see --help)"; exit 1 ;;
  esac
done

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------
preflight() {
  local os_type
  os_type="$(uname -s 2>/dev/null || echo Unknown)"
  case "${os_type}" in
    Darwin|Linux) log_info "OS: ${os_type}" ;;
    *) log_error "unsupported OS: ${os_type} (macOS or Linux required)"; return 1 ;;
  esac

  if ! command -v node >/dev/null 2>&1; then
    log_error "Node.js not found (need >= ${NODE_MIN_MAJOR})"
    log_error "  macOS:   brew install node"
    log_error "  Linux:   curl -fsSL https://cdn.npmmirror.com/binaries/node/v22.14.0/node-v22.14.0-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1"
    return 1
  fi
  local node_major
  node_major="$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
  if [ "${node_major}" -lt "${NODE_MIN_MAJOR}" ]; then
    log_error "Node.js too old: $(node --version 2>/dev/null) (need >= ${NODE_MIN_MAJOR})"; return 1
  fi
  log_info "Node.js: $(node --version 2>/dev/null)"

  if ! command -v npm >/dev/null 2>&1; then
    log_error "npm not found (comes with Node.js)"; return 1
  fi
  log_info "npm: $(npm --version 2>/dev/null)"

  if [ "${INSTALL_MODE}" = "source" ]; then
    if ! command -v git >/dev/null 2>&1; then
      log_error "source mode needs git: brew install git or apt-get install -y git"; return 1
    fi
    command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || \
      log_warn "curl/wget missing; some mirror fetches may fail (git clone still works over HTTPS)"
  fi
  return 0
}

# ----------------------------------------------------------------------------
# Mode 1: npm global install (fastest, CLI only)
# ----------------------------------------------------------------------------
install_via_npm() {
  log_info "==== mode: npm global ===="
  local -a extra_flags
  extra_flags=()
  if [ -n "${NPM_REGISTRY:-}" ]; then
    extra_flags+=(--registry "${NPM_REGISTRY}")
  fi

  # "${arr[@]+"${arr[@]}"}" 是 bash set -u 下安全的空数组展开写法
  if ! npm install -g @vegamo/deepcode-cli "${extra_flags[@]+"${extra_flags[@]}"}" 2>&1; then
    log_error "npm install -g @vegamo/deepcode-cli failed"; return 1
  fi

  log_ok "installed"
  local cli_path
  cli_path="$(command -v deepcode 2>/dev/null || echo "")"
  if [ -n "${cli_path}" ]; then
    log_ok "deepcode binary: ${cli_path}"
    local cli_ver
    cli_ver="$(deepcode --version 2>&1 | head -1 || echo "")"
    [ -n "${cli_ver}" ] && log_ok "version: ${cli_ver}"
  fi
  log_info "note: npm mode installs CLI only. For Web UI use source mode:"
  log_info "  curl -fsSL https://raw.githubusercontent.com/weiransoft/DeepCodeX/main/setup.sh | bash"
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