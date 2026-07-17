/**
 * DropInLoader 测试
 *
 * 验证 sanitize、loadFromFile 错误路径、目录加载
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DropInLoader, sanitizeStem } from "../drop-in-loader.js";
import { DropInFileNotFoundError, DropInExecFailedError, DropInNoPluginError, DropInPathError } from "../errors.js";

test("sanitizeStem keeps ASCII alphanumeric and underscore", () => {
  assert.equal(sanitizeStem("hello"), "hello");
  assert.equal(sanitizeStem("hello_world"), "hello_world");
  assert.equal(sanitizeStem("abc123"), "abc123");
});

test("sanitizeStem replaces special chars with underscore", () => {
  assert.equal(sanitizeStem("hello-world"), "hello_world");
  assert.equal(sanitizeStem("hello@x"), "hello_x");
  assert.equal(sanitizeStem("hello.x"), "hello_x");
  assert.equal(sanitizeStem("a$b"), "a_b");
});

test("sanitizeStem prefixes underscore when starts with digit", () => {
  assert.equal(sanitizeStem("123abc"), "_123abc");
  assert.equal(sanitizeStem("9"), "_9");
});

test("sanitizeStem returns underscore for empty/all-special", () => {
  assert.equal(sanitizeStem(""), "_");
  assert.equal(sanitizeStem("插件"), "__");
  assert.equal(sanitizeStem("$$$"), "___");
});

test("loadFromFile throws on non-existent file", async () => {
  await assert.rejects(() => DropInLoader.loadFromFile("/nonexistent/file.js"), DropInFileNotFoundError);
});

test("loadFromFile throws on directory", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dropin-test-"));
  try {
    await assert.rejects(() => DropInLoader.loadFromFile(tmpDir), DropInFileNotFoundError);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadFromFile throws DropInExecFailedError on syntax error", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dropin-test-"));
  const brokenFile = path.join(tmpDir, "broken.js");
  fs.writeFileSync(brokenFile, "this is not valid javascript syntax !!!");
  try {
    await assert.rejects(() => DropInLoader.loadFromFile(brokenFile), DropInExecFailedError);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadFromFile throws DropInNoPluginError when no plugin", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dropin-test-"));
  const emptyFile = path.join(tmpDir, "empty.js");
  fs.writeFileSync(emptyFile, "const x = 1;");
  try {
    await assert.rejects(() => DropInLoader.loadFromFile(emptyFile), DropInNoPluginError);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadFromDirectory returns empty map for empty dir", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dropin-test-"));
  try {
    const result = await DropInLoader.loadFromDirectory(tmpDir);
    assert.equal(result.size, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadFromDirectory throws on missing dir", async () => {
  await assert.rejects(() => DropInLoader.loadFromDirectory("/nonexistent/dir"), DropInPathError);
});

test("loadFromDirectory ignores _prefix files", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dropin-test-"));
  fs.writeFileSync(path.join(tmpDir, "_private.js"), "const x = 1;");
  fs.writeFileSync(path.join(tmpDir, ".hidden.js"), "const y = 2;");
  try {
    const result = await DropInLoader.loadFromDirectory(tmpDir);
    assert.equal(result.size, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadFromDirectory ignores non-js files", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dropin-test-"));
  fs.writeFileSync(path.join(tmpDir, "readme.md"), "# readme");
  fs.writeFileSync(path.join(tmpDir, "config.json"), "{}");
  try {
    const result = await DropInLoader.loadFromDirectory(tmpDir);
    assert.equal(result.size, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("purgeModule does not throw on non-existent file", () => {
  // Just verify no crash
  DropInLoader.purgeModule("/nonexistent.js");
});
