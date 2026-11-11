/**
 * python3 能力探测（测试辅助）
 *
 * 背景：部分 CI / 容器环境中的 python3 解释器本身可运行（`python3 --version`
 * 正常），但缺少标准库的可选原生依赖（典型如 libexpat 缺失导致 `xml.parsers`
 * / pyexpat 无法加载）。此时 Python 脚本在运行期才会崩溃，仅靠 --version
 * 判断「python3 可用」的测试会在真实执行阶段误报失败。
 *
 * 本辅助提供 hasWorkingPython3(extraImports)：除 --version 外，还真实执行
 * 常用标准库导入（可选追加脚本自身依赖的模块），只有全部成功才判定可用。
 * 这样在功能缺失的环境中相关测试会被标记 skip，而不是以失败终止整个测试
 * 套件；功能可用的环境中判定结果与原先一致，不会掩盖真实缺陷。
 */

import { execFileSync } from "node:child_process";

/** 判定结果按进程缓存，避免重复探测带来的开销 */
let cachedResult;

/**
 * @param {string[]} extraImports 追加校验的 import 语句（例如脚本用到的标准库模块）
 * @returns {boolean} 当前环境的 python3 是否可真实执行常规脚本
 */
export function hasWorkingPython3(extraImports = []) {
  if (cachedResult !== undefined) return cachedResult;

  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
  } catch {
    cachedResult = false;
    return cachedResult;
  }

  const probe = [
    "import sys, os, json, uuid, pathlib",
    "import urllib.request, urllib.error, urllib.parse",
    "import xml.etree.ElementTree",
    ...extraImports,
    "print('PY_OK')",
  ].join("\n");

  try {
    const out = execFileSync("python3", ["-c", probe], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    cachedResult = out.includes("PY_OK");
  } catch {
    cachedResult = false;
  }
  return cachedResult;
}
