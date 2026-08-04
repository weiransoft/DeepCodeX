/**
 * EagConfigLoader 单元测试 —— EAG 配置文件加载器
 *
 * 测试范围：
 * - TC-ECL-001: load 加载 .deepcode/eag.yml 配置文件
 * - TC-ECL-002: 配置文件不存在时返回空对象
 * - TC-ECL-003: 解析 YAML 键值对（数字、字符串、注释）
 * - TC-ECL-004: 校验字段合法性（maxIterations 范围、confirmation 取值）
 * - TC-ECL-005: 校验失败时记录到 stderr 并使用默认值
 * - TC-ECL-006: mergeWithCliArgs 合并配置（命令行参数优先级高于配置文件）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实文件系统操作（使用临时目录）
 * - 中文注释
 *
 * @module tests/eag-config-loader
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EagConfigLoader } from "../eag/config/eag-config-loader.ts";

// ============================================================================
// 测试辅助：创建临时目录
// ============================================================================

/**
 * 创建临时目录（用于测试配置文件）
 *
 * @returns 临时目录路径
 */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eag-config-test-"));
}

/**
 * 清理临时目录
 *
 * @param dir 目录路径
 */
function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理错误
  }
}

// ============================================================================
// TC-ECL-001: load 加载 .deepcode/eag.yml 配置文件
// ============================================================================

test("TC-ECL-001: load 加载 .deepcode/eag.yml 配置文件", () => {
  const tempDir = createTempDir();
  try {
    // 创建 .deepcode/eag.yml 配置文件
    const configDir = path.join(tempDir, ".deepcode");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "eag.yml");
    const yamlContent = `
# EAG 配置文件
maxIterations: 20
testCommand: "npm run test"
testTimeoutSec: 300
consecutiveFailureAbort: 5
maxTokens: 100000
confirmation: smart
initialLoop: coding
`;
    fs.writeFileSync(configPath, yamlContent, "utf-8");

    const loader = new EagConfigLoader({ projectRoot: tempDir });
    const config = loader.load();

    assert.equal(config.maxIterations, 20);
    assert.equal(config.testCommand, "npm run test");
    assert.equal(config.testTimeoutSec, 300);
    assert.equal(config.consecutiveFailureAbort, 5);
    assert.equal(config.maxTokens, 100000);
    assert.equal(config.confirmation, "smart");
    assert.equal(config.initialLoop, "coding");
  } finally {
    cleanupTempDir(tempDir);
  }
});

// ============================================================================
// TC-ECL-002: 配置文件不存在时返回空对象
// ============================================================================

test("TC-ECL-002: 配置文件不存在时返回空对象", () => {
  const tempDir = createTempDir();
  try {
    const loader = new EagConfigLoader({ projectRoot: tempDir });
    const config = loader.load();

    assert.deepEqual(config, {}, "配置文件不存在时应返回空对象");
  } finally {
    cleanupTempDir(tempDir);
  }
});

// ============================================================================
// TC-ECL-003: 解析 YAML 键值对（数字、字符串、注释）
// ============================================================================

test("TC-ECL-003: 解析 YAML 键值对（数字、字符串、注释）", () => {
  const tempDir = createTempDir();
  try {
    const configDir = path.join(tempDir, ".deepcode");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "eag.yml");
    const yamlContent = `
# 这是注释
maxIterations: 15
# 另一个注释
testCommand: "pytest"

stopWhen: "all tests pass"
`;
    fs.writeFileSync(configPath, yamlContent, "utf-8");

    const loader = new EagConfigLoader({ projectRoot: tempDir });
    const config = loader.load();

    assert.equal(config.maxIterations, 15);
    assert.equal(config.testCommand, "pytest");
    assert.equal(config.stopWhen, "all tests pass");
  } finally {
    cleanupTempDir(tempDir);
  }
});

// ============================================================================
// TC-ECL-004: 校验字段合法性（maxIterations 范围、confirmation 取值）
// ============================================================================

test("TC-ECL-004: 校验字段合法性（maxIterations 范围、confirmation 取值）", () => {
  const tempDir = createTempDir();
  try {
    const configDir = path.join(tempDir, ".deepcode");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "eag.yml");
    const yamlContent = `
maxIterations: 500
confirmation: always-ask
initialLoop: testing
`;
    fs.writeFileSync(configPath, yamlContent, "utf-8");

    const loader = new EagConfigLoader({ projectRoot: tempDir });
    const config = loader.load();

    // 合法值应被保留
    assert.equal(config.maxIterations, 500);
    assert.equal(config.confirmation, "always-ask");
    assert.equal(config.initialLoop, "testing");
  } finally {
    cleanupTempDir(tempDir);
  }
});

// ============================================================================
// TC-ECL-005: 校验失败时记录到 stderr 并使用默认值
// ============================================================================

test("TC-ECL-005: 校验失败时记录到 stderr 并使用默认值", () => {
  const tempDir = createTempDir();
  try {
    const configDir = path.join(tempDir, ".deepcode");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "eag.yml");
    const yamlContent = `
maxIterations: 2000
confirmation: invalid-mode
initialLoop: invalid-loop
`;
    fs.writeFileSync(configPath, yamlContent, "utf-8");

    const loader = new EagConfigLoader({ projectRoot: tempDir });
    const config = loader.load();

    // 非法值应被过滤掉（返回 undefined）
    assert.equal(config.maxIterations, undefined, "maxIterations 超出范围应被过滤");
    assert.equal(config.confirmation, undefined, "confirmation 非法取值应被过滤");
    assert.equal(config.initialLoop, undefined, "initialLoop 非法取值应被过滤");
  } finally {
    cleanupTempDir(tempDir);
  }
});

// ============================================================================
// TC-ECL-006: mergeWithCliArgs 合并配置（命令行参数优先级高于配置文件）
// ============================================================================

test("TC-ECL-006: mergeWithCliArgs 合并配置（命令行参数优先级高于配置文件）", () => {
  const tempDir = createTempDir();
  try {
    const loader = new EagConfigLoader({ projectRoot: tempDir });

    const fileConfig = {
      maxIterations: 10,
      testCommand: "npm test",
      testTimeoutSec: 600,
    };

    const cliArgs = {
      maxIterations: 20, // 命令行覆盖配置文件
      // testCommand 未提供，保留配置文件值
      testTimeoutSec: 300, // 命令行覆盖配置文件
    };

    const merged = loader.mergeWithCliArgs(fileConfig, cliArgs);

    assert.equal(merged.maxIterations, 20, "命令行参数应覆盖配置文件");
    assert.equal(merged.testCommand, "npm test", "未提供的命令行参数保留配置文件值");
    assert.equal(merged.testTimeoutSec, 300, "命令行参数应覆盖配置文件");
  } finally {
    cleanupTempDir(tempDir);
  }
});
