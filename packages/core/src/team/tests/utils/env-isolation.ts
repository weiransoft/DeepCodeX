/**
 * 测试环境隔离工具
 *
 * 设计依据：用户规则"禁止 mock"，本工具不模拟 LLM 响应，
 *           仅通过备份/恢复环境变量 + 重定向 HOME 目录方式确保测试可复现。
 *
 * 使用方式（推荐用 test.before/test.after 钩子，文件级别统一隔离）：
 *
 *   import { isolateOpenAIEnv } from "./utils/env-isolation.js";
 *   import { test } from "node:test";
 *
 *   // v1.3 F-07：必须配对使用 test.before + test.after
 *   //   缺少 test.after 调用 restoreEnv 会导致环境变量在测试文件结束后未恢复，
 *   //   可能污染后续进程（如 CI 中串行执行的其他测试）
 *   let restoreEnv: (() => void) | null = null;
 *
 *   test.before(() => {
 *     // 文件级别隔离：所有 test 共享无 API Key 环境
 *     restoreEnv = isolateOpenAIEnv();
 *   });
 *
 *   test.after(() => {
 *     // 文件结束后恢复环境变量（避免污染后续测试）
 *     restoreEnv?.();
 *     restoreEnv = null;
 *   });
 *
 * 或在单个测试内使用 try/finally：
 *
 *   test("...", () => {
 *     const restoreEnv = isolateOpenAIEnv();
 *     try {
 *       // 测试逻辑（此时环境变量已被清空）
 *     } finally {
 *       restoreEnv();  // 恢复环境变量
 *     }
 *   });
 *
 * 注意：Node.js test runner 跨文件是子进程隔离的（每个 .test.ts 文件是独立子进程），
 *      不会污染其他测试文件；同一文件内多个 test 共享 process.env，
 *      因此 test.before + test.after 是文件级隔离的正确做法。
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * 备份并清空指定环境变量
 *
 * Node.js test runner 跨文件默认并发执行（concurrency: true），
 * 多个测试文件同时调用 isolateEnvVars 会相互污染。
 * 建议在 describe/test.before 级别使用 before/after 钩子，而非 test 级别。
 *
 * @param keys 需要隔离的环境变量名列表
 * @returns restore 函数，调用后恢复原值
 */
export function isolateEnvVars(keys: string[]): () => void {
  // 备份字典：记录每个 key 在调用前的原始值（可能为 undefined，表示原本未设置）
  const backup: Record<string, string | undefined> = {};

  // 备份 + 清空：遍历所有 key，先记录原值再删除环境变量
  for (const key of keys) {
    backup[key] = process.env[key];
    delete process.env[key];
  }

  // 返回 restore 函数：根据 backup 字典恢复环境变量
  return () => {
    for (const key of keys) {
      if (backup[key] === undefined) {
        // 原本未设置 → 删除（避免残留空字符串）
        delete process.env[key];
      } else {
        // 原本有值 → 恢复
        process.env[key] = backup[key];
      }
    }
  };
}

/**
 * 重定向 HOME / USERPROFILE 环境变量到临时目录
 *
 * 用途：让 `os.homedir()` 返回临时目录，从而使 `~/.deepcode/settings.json`
 *      找不到（getProjectSettingsPath/getUserSettingsPath 都基于 os.homedir()），
 *      阻断 settings.json 中的 env.API_KEY 被读取。
 *
 * 同时清理 createOpenAIClient 模块级缓存（cachedOpenAI / cachedOpenAIKey），
 * 防止上一个测试缓存的 client 实例被复用。
 *
 * @returns restore 函数，调用后恢复原值并删除临时目录
 */
export function isolateHomeDir(): () => void {
  // 创建临时 HOME 目录（用 mkdtempSync 保证唯一性，避免并发冲突）
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-test-home-"));

  // 备份原值（macOS/Linux 用 HOME，Windows 用 USERPROFILE）
  const backupHome = process.env.HOME;
  const backupUserProfile = process.env.USERPROFILE;

  // 重定向到临时目录
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  // 返回 restore 函数：恢复原值 + 删除临时目录
  return () => {
    if (backupHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = backupHome;
    }
    if (backupUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = backupUserProfile;
    }
    // 清理临时目录（recursive + force 避免报错）
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      // 忽略清理失败（不影响测试结果）
    }
  };
}

/**
 * 测试专用：隔离 OpenAI / Anthropic / DeepCode 相关环境变量 + 用户级 settings.json
 *
 * 清空以下环境变量，确保 createOpenAIClient 走 no-client 分支：
 *   - OPENAI_API_KEY          OpenAI 官方 API Key
 *   - OPENAI_BASE_URL         OpenAI 自定义 base URL（如代理）
 *   - OPENAI_MODEL            OpenAI 默认模型名
 *   - DEEPCODE_API_KEY        DeepCode 项目自定义 API Key（settings.json env.API_KEY 的环境变量形式）
 *   - ANTHROPIC_API_KEY       Anthropic Claude API Key
 *   - ANTHROPIC_BASE_URL      Anthropic 自定义 base URL
 *
 * 同时重定向 HOME / USERPROFILE 到临时目录，阻断 `~/.deepcode/settings.json`
 * 中的 env.API_KEY 被 resolveCurrentSettings 读取。
 *
 * 必要性：仅清空环境变量不足以让 createOpenAIClient 走 no-client 分支，
 *        因为开发机上 `~/.deepcode/settings.json` 可能配置了 env.API_KEY，
 *        resolveCurrentSettings 会从该文件读取 apiKey，导致 createOpenAIClient
 *        返回真实 client 走 network 分支，最终 result.error 是 timeout/network 而非 no-client。
 *
 * @returns restore 函数，调用后恢复原值
 */
export function isolateOpenAIEnv(): () => void {
  // 1. 隔离环境变量
  const restoreVars = isolateEnvVars([
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "DEEPCODE_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
  ]);
  // 2. 重定向 HOME 到临时目录（阻断 settings.json 读取）
  const restoreHome = isolateHomeDir();

  // 返回聚合 restore 函数：先恢复 HOME，再恢复环境变量
  return () => {
    restoreHome();
    restoreVars();
  };
}
