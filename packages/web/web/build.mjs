/**
 * DeepCodeX Web 前端构建脚本（自包含，不依赖 package.json scripts）。
 *
 * 产物（固定目录 packages/web/web/dist，由 packages/web/src 后端静态托管）：
 *   - dist/bundle.js   ：src/main.tsx 打包产物（IIFE，已压缩）
 *   - dist/bundle.css  ：styles.css + a2ui.css 经 esbuild css loader 合并产物
 *   - dist/index.html  ：由本目录 index.html 拷贝
 *
 * 运行方式：node packages/web/web/build.mjs
 */
import { build } from "esbuild";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 当前脚本所在目录（packages/web/web） */
const webRoot = path.dirname(fileURLToPath(import.meta.url));
/** 固定产物目录名 dist（后端将服务该目录） */
const distDir = path.join(webRoot, "dist");

// 清空旧产物，保证 dist 内容与源码严格同步
await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

// esbuild 打包：jsx automatic 由 React 19 运行时（react/jsx-runtime）提供，无需手动 import React
await build({
  entryPoints: [path.join(webRoot, "src", "main.tsx")],
  outfile: path.join(distDir, "bundle.js"),
  bundle: true,
  // 单文件 IIFE：SPA 无需代码分割，直接 <script src> 引入即可
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  jsxImportSource: "react",
  minify: true,
  sourcemap: false,
  // 前端使用 React 生产构建，去除开发警告分支
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  legalComments: "none",
  logLevel: "info",
});

// 拷贝入口 HTML 到产物目录
const indexPath = path.join(webRoot, "index.html");
await copyFile(indexPath, path.join(distDir, "index.html"));

// 校验关键产物存在，缺失则让构建失败（不允许静默产出残缺 dist）
for (const name of ["bundle.js", "bundle.css", "index.html"]) {
  const s = await stat(path.join(distDir, name));
  if (!s.isFile() || s.size === 0) {
    throw new Error(`构建产物缺失或为空: dist/${name}`);
  }
}

console.log(`\n✅ 前端构建完成: ${distDir}\n`);
