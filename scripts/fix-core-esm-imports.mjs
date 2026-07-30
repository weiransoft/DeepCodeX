// ============================================================================
// 修复 packages/core/src 下相对目录导入，补全 /index 以解决 dist 运行时解析问题。
//
// 背景：core 包使用 "module": "ESNext" + "moduleResolution": "bundler"，tsc 编译后
// 保留源码中的无扩展名相对路径。对于目录导入（如 ./eag/long-horizon），源码可被
// bundler/tsx 正确解析到目录下的 index.ts；但当 tsx 从 packages/core/dist 解析时，
// 会自动追加 .js，导致 ./eag/long-horizon 被解析为 ./eag/long-horizon.js（一个目录
// 而非文件），从而抛出 ERR_MODULE_NOT_FOUND。
//
// 修复策略（最小化）：
// - 仅处理相对路径且指向目录的导入/导出说明符。
// - 目录中存在 index.ts/index.tsx 时，将说明符由 ./foo 改为 ./foo/index。
// - 文件导入、已带扩展名的路径、非相对路径均保持不变。
//
// 使用 TypeScript Compiler API 精确解析导入节点，避免误改注释/字符串。
// ============================================================================
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { globSync } from "glob";

const __filename = fileURLToPath(import.meta.url);
const root = resolve(__filename, "../..");
const srcDir = join(root, "packages", "core", "src");

/**
 * 判断相对导入说明符是否已显式包含文件扩展名。
 *
 * @param specifier 模块说明符
 * @returns true 表示已有 .js/.ts/.mjs 等扩展名
 */
function hasExplicitExtension(specifier) {
  const clean = specifier.split("?")[0].split("#")[0];
  return /\.(js|mjs|cjs|ts|tsx|mts|cts)$/i.test(clean);
}

/**
 * 判断说明符是否指向一个包含 index.ts/index.tsx 的目录。
 *
 * @param sourceFile 当前源文件绝对路径
 * @param specifier  相对模块说明符
 * @returns true 表示为目录导入
 */
function isDirectoryImport(sourceFile, specifier) {
  const baseDir = dirname(sourceFile);
  const target = resolve(baseDir, specifier);

  try {
    const s = statSync(target);
    if (!s.isDirectory()) return false;
  } catch {
    return false;
  }

  for (const ext of [".ts", ".tsx"]) {
    try {
      const s = statSync(join(target, "index" + ext));
      if (s.isFile()) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * 处理单个 TypeScript 源文件，重写其中的目录导入/导出说明符。
 *
 * @param filePath 源文件绝对路径
 * @returns 是否发生了修改
 */
function processFile(filePath) {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

  const replacements = [];

  function visit(node) {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportAssignment(node)
    ) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        const original = moduleSpecifier.text;
        if (original.startsWith(".") && !hasExplicitExtension(original) && isDirectoryImport(filePath, original)) {
          const rewritten = original.replace(/\/$/, "") + "/index";
          replacements.push({
            start: moduleSpecifier.getStart(sourceFile) + 1, // 跳过前引号
            end: moduleSpecifier.getEnd() - 1, // 跳过后引号
            text: rewritten,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (replacements.length === 0) return false;

  // 从后往前替换，避免位置偏移
  replacements.sort((a, b) => b.start - a.start);
  let result = sourceText;
  for (const r of replacements) {
    result = result.slice(0, r.start) + r.text + result.slice(r.end);
  }

  writeFileSync(filePath, result, "utf8");
  console.log(`✅ ${relative(root, filePath)}: ${replacements.length} 处`);
  return true;
}

// ============================================================================
// 主流程
// ============================================================================
const files = globSync("**/*.ts", { cwd: srcDir, absolute: true });
let modifiedCount = 0;

for (const file of files) {
  try {
    const modified = processFile(file);
    if (modified) modifiedCount++;
  } catch (err) {
    console.error(`❌ 处理失败：${relative(root, file)}`, err.message);
    process.exitCode = 1;
  }
}

console.log(`\n完成：修改 ${modifiedCount} 个文件`);
