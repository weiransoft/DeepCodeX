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
import { copyFile, cp, mkdir, readdir, rm, stat, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 当前脚本所在目录（packages/web/web） */
const webRoot = path.dirname(fileURLToPath(import.meta.url));
/** 固定产物目录名 dist（后端将服务该目录） */
const distDir = path.join(webRoot, "dist");
/** monorepo 根（packages/web/web → 上两级），用于定位 cli dist 装配目录 */
const repoRoot = path.join(webRoot, "..", "..", "..");

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

// 拷贝静态资产（头像等）：public/ 下每个条目原样进 dist 根，
// 与 index.html 同级——`/manul-avatar.png` 因此可直接访问。
// public 不存在时跳过（CI 首次构建 / 老分支没有该目录都不该让构建失败）。
// 逐条目拷贝而不是整目录 cp：dest 已存在时整目录语义会把 dest 当成父目录
// 生成 dist/public/*，与静态托管期望的路径不一致。
const publicDir = path.join(webRoot, "public");
if (existsSync(publicDir)) {
  const entries = await readdir(publicDir, { withFileTypes: true });
  for (const entry of entries) {
    await cp(path.join(publicDir, entry.name), path.join(distDir, entry.name), { recursive: true });
  }
}

// 校验关键产物存在，缺失则让构建失败（不允许静默产出残缺 dist）
for (const name of ["bundle.js", "bundle.css", "index.html"]) {
  const s = await stat(path.join(distDir, name));
  if (!s.isFile() || s.size === 0) {
    throw new Error(`构建产物缺失或为空: dist/${name}`);
  }
}

// 装配到 CLI dist 布局：packages/cli/dist/cli.js 内的 defaultStaticDir 解析为
// <cli dist>/../web/dist（即 packages/cli/dist/web/dist）；该目录不存在时
// Web 服务会回退"UI 尚未构建"提示页。用软链把真实产物目录挂到该布局位置，
// 源码构建与 CLI bundle 共用同一份 dist，避免二次拷贝漂移。
const cliWebDir = path.join(repoRoot, "packages", "cli", "dist", "web");
await mkdir(cliWebDir, { recursive: true });
const cliDistLink = path.join(cliWebDir, "dist");
// 先删旧链接/目录（rm force 幂等），再建 dir 型软链指向真实 dist
await rm(cliDistLink, { recursive: true, force: true });
try {
  await symlink(distDir, cliDistLink, "dir");
  console.log(`✅ 已链接 CLI dist 布局: ${cliDistLink} -> ${distDir}`);
} catch (err) {
  // Windows 普通权限（未开启开发者模式）下创建目录软链会报 EPERM/EACCES，
  // 此时回退为目录复制，保证构建链路可用（产物内容一致）。
  if (err?.code !== "EPERM" && err?.code !== "EACCES") throw err;
  await cp(distDir, cliDistLink, { recursive: true });
  console.log(`✅ 已复制 CLI dist 布局（symlink 不可用）: ${cliDistLink} <- ${distDir}`);
}

console.log(`\n✅ 前端构建完成: ${distDir}\n`);
