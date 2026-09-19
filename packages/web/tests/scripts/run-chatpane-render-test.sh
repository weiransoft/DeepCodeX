#!/usr/bin/env bash
# ChatPane 页面渲染回归测试（真实 SSR）驱动脚本。
#
# 为什么需要独立脚本：run-tests.mjs 经 tsx loader 转译，而 tsx 对 JSX 仅
# classic（React.createElement）转译且不生效 tsconfig 的 jsx 配置；
# 此处用 esbuild --jsx=automatic 打包为 CJS 产物后由 node 执行，
# node:test 的退出码随用例失败置非零（CI 可直接门禁）。
#
# 用法：tests/scripts/run-chatpane-render-test.sh
set -euo pipefail
cd "$(dirname "$0")/../.."   # 进入 packages/web

OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT
OUT="$OUT_DIR/chatpane-render.test.cjs"

# esbuild 打包（jsx automatic 与 web/build.mjs 前端构建同一转换语义）
npx esbuild tests/scripts/chatpane-render.tsx \
  --bundle \
  --platform=node \
  --format=cjs \
  --jsx=automatic \
  --outfile="$OUT" \
  --log-level=warning

node "$OUT"
