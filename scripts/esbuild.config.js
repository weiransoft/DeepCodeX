import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const cliRoot = join(root, "packages", "cli");
const entry = join(cliRoot, "src", "cli.tsx");

await build({
  entryPoints: [entry],
  bundle: true,
  outdir: join(cliRoot, "dist"),
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  // splitting 关闭（2026-09-19）：开启 code splitting 时，yargs platform-shims esm.mjs
  // 顶层的 `var __dirname = fileURLToPath(import.meta.url)` 可能与 esbuild-shims.js 注入的
  // `__dirname` 导入落在同一入口 chunk 作用域，产生 ESM 重复声明 SyntaxError
  // （新增 @vegamo/deepcode-web 依赖后模块图变化触发）。关闭后 esbuild 在单文件内
  // 自动重命名冲突符号，bundle 语义不变。
  splitting: false,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  jsx: "automatic",
  jsxImportSource: "react",
  packages: "bundle",
  // sharp 为原生模块，保持 external：由 npm 按宿主平台安装对应二进制
  external: ["sharp"],
  inject: [join(__dirname, "esbuild-shims.js")],
  alias: {
    // react-devtools-core is a browser-only package pulled in by ink's
    // devtools support.  It cannot run in a Node.js CLI, so we replace it
    // with an empty shim so esbuild doesn't bundle the real (broken) code.
    "react-devtools-core": join(__dirname, "empty-shim.js"),
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  logOverride: {
    "empty-import-meta": "silent",
  },
  metafile: true,
  write: true,
  keepNames: true,
});

console.log(`\n✅  ${join(cliRoot, "dist", "cli.js")}  built successfully\n\n`);
