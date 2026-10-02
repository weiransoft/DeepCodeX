#!/usr/bin/env bash
# ============================================================================
# scripts/release.sh -- 一键构建 + 打包 + 创建 GitHub Release + 上传 tarball
# ============================================================================
#
# 流程：
#   1. npm run build（core + cli + web）
#   2. cd packages/cli && npm pack → vegamo-deepcode-cli-<version>.tgz
#   3. 复制为 deploy/deepcode-cli.tgz（asset 名固定，每次覆盖）
#   4. 创建 git tag v<version>（已存在则跳过）
#   5. 推送 tag → GitHub
#   6. 用 GitHub API 创建 Release + 上传 tarball
#
# 用法：
#   # 发布当前 package.json 里的版本号
#   bash scripts/release.sh
#
#   # 覆盖版本号（不改 package.json，只影响 tag + release）
#   bash scripts/release.sh v0.4.3
#
#   # 只 build + pack（不推 tag / 不创建 Release）
#   bash scripts/release.sh --dry-run
#
# 环境变量：
#   GITHUB_TOKEN  GitHub PAT（需要 repo 写权限）
#   REPO          GitHub 仓库（默认 weiransoft/DeepCodeX）
#
# ============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# 常量
# ----------------------------------------------------------------------------
REPO="${REPO:-weiransoft/DeepCodeX}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="${ROOT_DIR}/packages/cli"
DEPLOY_DIR="${ROOT_DIR}/deploy"

# ----------------------------------------------------------------------------
# 网络自适应：GitHub API 直连失败时走国内 ghproxy 镜像
# ----------------------------------------------------------------------------
# api.github.com 在国内（尤其 VPN 阻断环境）经常不可达；gh-proxy 系镜像对 API
# 做透明转发（用法：https://<proxy>/https://api.github.com/...），token 鉴权头
# 原样透传。按顺序探活，全失败则回退直连（探测本身超时 5s，不拖慢正常流程）。
# export GITHUB_API_BASE 可手动覆盖（如自建内网镜像）。
GITHUB_API_BASE="${GITHUB_API_BASE:-}"
probe_api() {
  local base="$1"
  # 轻量探活：/meta 返回 200 即视为可用；--max-time 5 快速失败
  local code
  code="$(curl -sL -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 \
    "${base}/meta" -H "Accept: application/vnd.github+json" 2>/dev/null || echo 000)"
  [ "${code}" = "200" ]
}
if [ -z "${GITHUB_API_BASE}" ]; then
  for cand in "https://api.github.com" \
              "https://gh-proxy.com/https://api.github.com" \
              "https://ghproxy.net/https://api.github.com"; do
    if probe_api "${cand}"; then
      GITHUB_API_BASE="${cand}"
      break
    fi
  done
  # 全部探活失败：默认仍用直连（让后续 curl 的报错信息更真实）
  GITHUB_API_BASE="${GITHUB_API_BASE:-https://api.github.com}"
fi
echo "GitHub API 通道：${GITHUB_API_BASE}"

# ----------------------------------------------------------------------------
# 参数解析
# ----------------------------------------------------------------------------
DRY_RUN=0
VERSION_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    v*)        VERSION_OVERRIDE="$1"; shift ;;
    *)         echo "未知参数: $1"; exit 1 ;;
  esac
done

# ----------------------------------------------------------------------------
# 取版本号（优先 CLI package.json，其次根 package.json）
# ----------------------------------------------------------------------------
get_version() {
  if [ -n "${VERSION_OVERRIDE}" ]; then
    # 去掉前缀 v
    echo "${VERSION_OVERRIDE#v}"
    return
  fi
  node -e "console.log(require('${CLI_DIR}/package.json').version)"
}

VERSION="$(get_version)"
TAG="v${VERSION}"
echo "================================================"
echo " DeepCodeX Release: ${TAG}"
echo "================================================"

# ----------------------------------------------------------------------------
# Step 1: build
# ----------------------------------------------------------------------------
echo ""
echo "[1/5] npm run build ..."
cd "${ROOT_DIR}"
npm run build 2>&1 | tail -5

# ----------------------------------------------------------------------------
# Step 2: npm pack cli
# ----------------------------------------------------------------------------
echo ""
echo "[2/5] npm pack packages/cli ..."
cd "${CLI_DIR}"
npm pack 2>&1 | tail -3
LOCAL_TGZ="vegamo-deepcode-cli-${VERSION}.tgz"
if [ ! -f "${LOCAL_TGZ}" ]; then
  echo "❌ 找不到 ${LOCAL_TGZ}"
  exit 1
fi

# ----------------------------------------------------------------------------
# Step 3: 复制到 deploy/deepcode-cli.tgz（asset 名固定）
# ----------------------------------------------------------------------------
echo ""
echo "[3/5] → deploy/deepcode-cli.tgz ..."
mkdir -p "${DEPLOY_DIR}"
cp -f "${LOCAL_TGZ}" "${DEPLOY_DIR}/deepcode-cli.tgz"
cd "${ROOT_DIR}"
ls -lh "${DEPLOY_DIR}/deepcode-cli.tgz"
tar tzf "${DEPLOY_DIR}/deepcode-cli.tgz" >/dev/null 2>&1 || { echo "❌ tarball 无效"; exit 1; }
echo "✅ tarball 有效（$(tar tzf "${DEPLOY_DIR}/deepcode-cli.tgz" | wc -l | tr -d ' ') 文件）"

# dry-run 到这里停
if [ "${DRY_RUN}" = "1" ]; then
  echo ""
  echo "✅ --dry-run 完成，未推 tag / 未创建 Release"
  exit 0
fi

# ----------------------------------------------------------------------------
# Step 4: git tag + push
# ----------------------------------------------------------------------------
echo ""
echo "[4/5] git tag + push ${TAG} ..."
cd "${ROOT_DIR}"

# 确保所有改动已 commit
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  有未提交的改动，自动 commit ..."
  git add -A
  git commit -m "chore: release ${TAG}" || true
fi

# tag（已存在则跳过）
if git rev-parse "${TAG}" >/dev/null 2>&1; then
  echo "  tag ${TAG} 已存在，跳过"
else
  git tag -a "${TAG}" -m "release: ${TAG}"
fi

# push tag
git push origin "${TAG}" 2>&1 || echo "⚠️  git push 失败（可能 GitHub 连不上），跳过 Release API"

# ----------------------------------------------------------------------------
# Step 5: GitHub API 创建 Release + 上传 asset
# ----------------------------------------------------------------------------
if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo ""
  echo "⚠️  未设置 GITHUB_TOKEN，跳过 GitHub Release 创建"
  echo "    手动创建：https://github.com/${REPO}/releases/new"
  echo "    上传文件：${DEPLOY_DIR}/deepcode-cli.tgz"
  exit 0
fi

echo ""
echo "[5/5] GitHub API 创建 Release + 上传 asset ..."

# 5a. 创建 Release
echo "  POST /releases (tag=${TAG}) ..."
RELEASE_RESP="$(curl -fsSL -X POST "${GITHUB_API_BASE}/repos/${REPO}/releases" \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"tag_name\": \"${TAG}\",
    \"name\": \"${TAG}\",
    \"body\": \"## DeepCodeX ${TAG}\n\n自动发布于 $(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"draft\": false,
    \"prerelease\": false
  }" 2>&1)" || {
  echo "❌ Release 创建失败:"
  echo "   ${RELEASE_RESP}" | head -5
  echo "   检查 token 权限: repo Contents=Write, Releases=Write"
  exit 1
}

UPLOAD_URL="$(echo "${RELEASE_RESP}" | grep -o '"upload_url":"[^"]*"' | head -1 | sed 's/"upload_url":"//;s/"$//;s/{?name,label}//')"
RELEASE_ID="$(echo "${RELEASE_RESP}" | grep -oE '"id": [0-9]+' | head -1 | grep -oE '[0-9]+')"

echo "  ✅ Release ID=${RELEASE_ID}"

# 5b. 上传 tarball
echo "  POST upload asset deepcode-cli.tgz ..."
curl -fsSL -X POST "${UPLOAD_URL}?name=deepcode-cli.tgz" \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"${DEPLOY_DIR}/deepcode-cli.tgz" >/dev/null 2>&1 || {
  echo "❌ asset 上传失败"
  exit 1
}
echo "  ✅ asset 上传完成"

# ----------------------------------------------------------------------------
# 完成
# ----------------------------------------------------------------------------
echo ""
echo "================================================"
echo " ✅ Release ${TAG} 完成！"
echo "================================================"
echo ""
echo " Release URL: https://github.com/${REPO}/releases/tag/${TAG}"
echo " Asset URL : https://github.com/${REPO}/releases/download/${TAG}/deepcode-cli.tgz"
echo ""
echo " 安装验证："
echo "   curl -fsSL https://raw.githubusercontent.com/${REPO}/main/setup.sh | bash -s -- --mode npm --force --tag ${TAG}"
