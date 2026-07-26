/**
 * 日志轮转工具单元测试（D-2 修复）
 *
 * 测试目标：packages/core/src/common/log-rotation.ts
 * 测试范围：
 *   - rotateLogIfNeeded 核心轮转逻辑
 *   - getBackupFilePaths 辅助函数
 *   - DEFAULT_MAX_LOG_SIZE_BYTES / DEFAULT_MAX_BACKUP_COUNT 常量
 *
 * 测试约束（严禁 mock）：
 *   - 所有 fs 操作使用真实文件系统
 *   - 每个用例使用独立的临时目录（os.tmpdir 下 mkdtempSync）
 *   - 用例结束时通过 fs.rmSync(recursive: true, force: true) 清理
 *
 * 运行方式：
 *   cd /Users/wangwei/Documents/VG/DeepCodeX-cli
 *   npx tsx --test packages/core/src/tests/log-rotation.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  rotateLogIfNeeded,
  getBackupFilePaths,
  DEFAULT_MAX_LOG_SIZE_BYTES,
  DEFAULT_MAX_BACKUP_COUNT,
} from "../common/log-rotation";

/**
 * 创建独立临时目录用于测试隔离。
 * 返回临时目录路径，调用方负责在 finally 中通过 fs.rmSync 清理。
 */
function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `deepcode-log-rotation-${prefix}-`));
}

/**
 * 判断当前进程是否以 root 身份运行（root 下 chmod 限制无效，需跳过权限相关用例）。
 */
function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

// TC-LR-001：文件不存在时调用 rotateLogIfNeeded 不应抛错（静默返回）
test("TC-LR-001: 文件不存在时不抛错", () => {
  const tmpDir = makeTempDir("non-existent");
  try {
    const logPath = path.join(tmpDir, "not-exists.log");
    // 不创建文件，直接调用，应静默返回
    assert.doesNotThrow(() => rotateLogIfNeeded(logPath));
    // 文件仍然不存在，无副作用
    assert.equal(fs.existsSync(logPath), false);
    assert.equal(fs.existsSync(`${logPath}.1`), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC-LR-002：文件大小未超过阈值（默认 10MB）时不触发轮转
test("TC-LR-002: 文件大小未超过阈值时不轮转", () => {
  const tmpDir = makeTempDir("under-threshold");
  try {
    const logPath = path.join(tmpDir, "debug.log");
    // 写入 1MB 内容（远小于 10MB 阈值）
    const content = Buffer.alloc(1024 * 1024, 0x61);
    fs.writeFileSync(logPath, content);

    rotateLogIfNeeded(logPath);

    // 原文件保留，无备份生成
    assert.equal(fs.existsSync(logPath), true);
    assert.equal(fs.existsSync(`${logPath}.1`), false);
    // 内容未变
    const after = fs.readFileSync(logPath);
    assert.equal(after.length, content.length);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC-LR-003：文件大小超过阈值时轮转到 .1（核心轮转）
test("TC-LR-003: 文件大小超过阈值时轮转到 .1", () => {
  const tmpDir = makeTempDir("basic-rotate");
  try {
    const logPath = path.join(tmpDir, "debug.log");
    // 写入 10MB + 1KB 内容（超过默认阈值 10MB）
    const original = Buffer.alloc(DEFAULT_MAX_LOG_SIZE_BYTES + 1024, 0x62);
    fs.writeFileSync(logPath, original);

    rotateLogIfNeeded(logPath);

    // 原文件被重命名为 .1，原路径不再存在
    assert.equal(fs.existsSync(logPath), false);
    assert.equal(fs.existsSync(`${logPath}.1`), true);
    // .1 内容与原文件一致
    const backup = fs.readFileSync(`${logPath}.1`);
    assert.equal(backup.length, original.length);
    assert.equal(backup[0], 0x62);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC-LR-004：已有 .1 时轮转触发 .1→.2 的级联
test("TC-LR-004: 已有 .1 时轮转触发 .1→.2", () => {
  const tmpDir = makeTempDir("cascade-1-to-2");
  try {
    const logPath = path.join(tmpDir, "debug.log");
    const dot1 = `${logPath}.1`;
    const dot2 = `${logPath}.2`;

    // 预先创建 .1 备份
    const backup1Content = Buffer.alloc(1024, 0x63);
    fs.writeFileSync(dot1, backup1Content);
    // 当前日志文件超过阈值
    const current = Buffer.alloc(DEFAULT_MAX_LOG_SIZE_BYTES + 1024, 0x64);
    fs.writeFileSync(logPath, current);

    rotateLogIfNeeded(logPath);

    // 当前文件 → .1
    assert.equal(fs.existsSync(logPath), false);
    // 旧 .1 → .2
    assert.equal(fs.existsSync(dot1), true);
    assert.equal(fs.existsSync(dot2), true);
    // .2 内容应等于旧 .1 内容
    const newDot2 = fs.readFileSync(dot2);
    assert.equal(newDot2.length, backup1Content.length);
    assert.equal(newDot2[0], 0x63);
    // .1 内容应等于原当前日志
    const newDot1 = fs.readFileSync(dot1);
    assert.equal(newDot1.length, current.length);
    assert.equal(newDot1[0], 0x64);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC-LR-005：已有 .1/.2/.3 时轮转触发完整级联（满备份轮转，最旧 .3 被删除）
test("TC-LR-005: 已有 .1/.2/.3 时轮转触发完整级联", () => {
  const tmpDir = makeTempDir("full-cascade");
  try {
    const logPath = path.join(tmpDir, "debug.log");
    const dot1 = `${logPath}.1`;
    const dot2 = `${logPath}.2`;
    const dot3 = `${logPath}.3`;

    // 预先创建 .1/.2/.3 备份，使用不同字节便于识别
    const c1 = Buffer.alloc(1024, 0x71);
    const c2 = Buffer.alloc(1024, 0x72);
    const c3 = Buffer.alloc(1024, 0x73);
    fs.writeFileSync(dot1, c1);
    fs.writeFileSync(dot2, c2);
    fs.writeFileSync(dot3, c3);

    // 当前日志文件超过阈值
    const current = Buffer.alloc(DEFAULT_MAX_LOG_SIZE_BYTES + 1024, 0x74);
    fs.writeFileSync(logPath, current);

    rotateLogIfNeeded(logPath); // 默认 maxBackupCount=3

    // 原当前文件 → .1
    assert.equal(fs.existsSync(logPath), false);
    // .1 内容 = 原当前日志
    const newDot1 = fs.readFileSync(dot1);
    assert.equal(newDot1[0], 0x74);
    // .2 内容 = 旧 .1
    const newDot2 = fs.readFileSync(dot2);
    assert.equal(newDot2[0], 0x71);
    // .3 内容 = 旧 .2
    const newDot3 = fs.readFileSync(dot3);
    assert.equal(newDot3[0], 0x72);
    // 旧 .3 被删除（不再存在 .4）
    assert.equal(fs.existsSync(`${logPath}.4`), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC-LR-006：maxBackupCount=1 时只保留 1 个备份（旧 .1 被删除）
test("TC-LR-006: maxBackupCount=1 时只保留 1 个备份", () => {
  const tmpDir = makeTempDir("single-backup");
  try {
    const logPath = path.join(tmpDir, "debug.log");
    const dot1 = `${logPath}.1`;
    const dot2 = `${logPath}.2`;

    // 预先创建 .1 备份（旧内容）
    const oldBackup = Buffer.alloc(1024, 0x81);
    fs.writeFileSync(dot1, oldBackup);
    // 当前日志文件超过阈值
    const current = Buffer.alloc(DEFAULT_MAX_LOG_SIZE_BYTES + 1024, 0x82);
    fs.writeFileSync(logPath, current);

    rotateLogIfNeeded(logPath, { maxBackupCount: 1 });

    // 原当前文件 → .1
    assert.equal(fs.existsSync(logPath), false);
    // 旧 .1 被删除（因为 maxBackupCount=1，i=1 时走 unlink 分支）
    // 新 .1 内容 = 原当前日志
    const newDot1 = fs.readFileSync(dot1);
    assert.equal(newDot1[0], 0x82);
    // 不存在 .2
    assert.equal(fs.existsSync(dot2), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC-LR-007：自定义 maxSizeBytes 触发轮转
test("TC-LR-007: 自定义 maxSizeBytes 轮转", () => {
  const tmpDir = makeTempDir("custom-size");
  try {
    const logPath = path.join(tmpDir, "debug.log");
    // 写入 2KB 内容
    const content = Buffer.alloc(2 * 1024, 0x91);
    fs.writeFileSync(logPath, content);

    // 自定义阈值 1KB，2KB 超过阈值应触发轮转
    rotateLogIfNeeded(logPath, { maxSizeBytes: 1024 });

    assert.equal(fs.existsSync(logPath), false);
    assert.equal(fs.existsSync(`${logPath}.1`), true);
    const backup = fs.readFileSync(`${logPath}.1`);
    assert.equal(backup.length, 2 * 1024);
    assert.equal(backup[0], 0x91);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC-LR-008：maxSizeBytes=0 时任何非空文件都触发轮转（边界参数）
test("TC-LR-008: maxSizeBytes=0 时总是轮转", () => {
  const tmpDir = makeTempDir("zero-threshold");
  try {
    const logPath = path.join(tmpDir, "debug.log");
    // 写入 1 字节内容
    fs.writeFileSync(logPath, Buffer.from("a"));

    // maxSizeBytes=0，stats.size(1) < 0 为 false，触发轮转
    rotateLogIfNeeded(logPath, { maxSizeBytes: 0 });

    assert.equal(fs.existsSync(logPath), false);
    assert.equal(fs.existsSync(`${logPath}.1`), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC-LR-009：rename 失败时抛错（容错-错误传播）
// 通过将日志文件所在目录设为 r-x（chmod 0555，无 w 权限）：
//   - stat 仍可成功（r+x 权限足够访问目录条目）
//   - rename 失败（无 w 权限无法修改目录条目）
// 注意：root 用户下 chmod 限制无效，需跳过；Windows 下 chmod 行为不同，也跳过
test("TC-LR-009: rename 失败时抛错", { skip: isRoot() || process.platform === "win32" }, () => {
  const tmpDir = makeTempDir("readonly-rename");
  const readOnlyDir = path.join(tmpDir, "readonly");
  try {
    fs.mkdirSync(readOnlyDir);
    const logPath = path.join(readOnlyDir, "debug.log");
    // 创建大文件（超过默认阈值）
    fs.writeFileSync(logPath, Buffer.alloc(DEFAULT_MAX_LOG_SIZE_BYTES + 1024, 0xa1));

    // 将目录设为 r-x（0555），无 w 权限：
    //   - stat 可成功（x 权限允许访问目录条目）
    //   - rename 失败（w 权限缺失，无法修改目录条目）
    fs.chmodSync(readOnlyDir, 0o555);

    // 调用应抛错，错误消息包含 "rotateLogIfNeeded 失败"
    assert.throws(
      () => rotateLogIfNeeded(logPath),
      (err: unknown) => {
        assert.ok(err instanceof Error, "应抛出 Error 实例");
        assert.ok(
          err.message.includes("rotateLogIfNeeded 失败"),
          `错误消息应包含 "rotateLogIfNeeded 失败"，实际为：${err.message}`
        );
        return true;
      }
    );
  } finally {
    // 恢复权限以便清理（rmSync 需要目录可写）
    try {
      fs.chmodSync(readOnlyDir, 0o755);
    } catch {
      // 忽略恢复失败
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC-LR-010：stat 失败（文件不存在）时不抛错（容错-静默返回）
// 与 TC-LR-001 互补：这里显式验证 stat 抛错路径不会向上传播
test("TC-LR-010: stat 失败时不抛错（文件不存在）", () => {
  const tmpDir = makeTempDir("stat-fail");
  try {
    const logPath = path.join(tmpDir, "missing.log");
    // 文件不存在，stat 会抛 ENOENT，被 catch 静默返回
    assert.doesNotThrow(() => rotateLogIfNeeded(logPath));
    // 同样测试路径父目录不存在的情况
    const nestedPath = path.join(tmpDir, "nested", "deep", "missing.log");
    assert.doesNotThrow(() => rotateLogIfNeeded(nestedPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC-LR-011：unlink 备份失败时不影响轮转（容错-忽略）
// 通过将 .3 创建为目录，使 unlinkSync 失败（EISDIR），但被 catch 忽略
// 验证最终 logPath 仍被重命名为 .1
test("TC-LR-011: unlink 备份失败时不影响轮转", () => {
  const tmpDir = makeTempDir("unlink-fail");
  try {
    const logPath = path.join(tmpDir, "debug.log");
    const dot1 = `${logPath}.1`;
    const dot3 = `${logPath}.3`;

    // 将 .3 创建为目录，unlinkSync 会失败（EISDIR）
    fs.mkdirSync(dot3);
    // .2 / .1 不存在
    // 当前日志文件超过阈值
    const current = Buffer.alloc(DEFAULT_MAX_LOG_SIZE_BYTES + 1024, 0xb1);
    fs.writeFileSync(logPath, current);

    // 调用不应抛错（unlink 失败被 catch）
    assert.doesNotThrow(() => rotateLogIfNeeded(logPath));

    // 尽管中间 unlink/rename 失败，最终 logPath → .1 应成功
    assert.equal(fs.existsSync(logPath), false);
    assert.equal(fs.existsSync(dot1), true);
    const newDot1 = fs.readFileSync(dot1);
    assert.equal(newDot1[0], 0xb1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC-LR-012：getBackupFilePaths 返回正确路径列表（辅助函数）
test("TC-LR-012: getBackupFilePaths 返回正确路径列表", () => {
  const logPath = "/tmp/test/debug.log";

  // 默认 maxBackupCount=3
  const defaultPaths = getBackupFilePaths(logPath);
  assert.deepEqual(defaultPaths, ["/tmp/test/debug.log.1", "/tmp/test/debug.log.2", "/tmp/test/debug.log.3"]);

  // 自定义 maxBackupCount=5
  const customPaths = getBackupFilePaths(logPath, 5);
  assert.deepEqual(customPaths, [
    "/tmp/test/debug.log.1",
    "/tmp/test/debug.log.2",
    "/tmp/test/debug.log.3",
    "/tmp/test/debug.log.4",
    "/tmp/test/debug.log.5",
  ]);

  // maxBackupCount=1
  const singlePath = getBackupFilePaths(logPath, 1);
  assert.deepEqual(singlePath, ["/tmp/test/debug.log.1"]);

  // maxBackupCount=0 应返回空数组
  const emptyPaths = getBackupFilePaths(logPath, 0);
  assert.deepEqual(emptyPaths, []);
});

// TC-LR-013：默认常量值正确
test("TC-LR-013: 默认常量值正确", () => {
  // 默认日志大小上限为 10MB
  assert.equal(DEFAULT_MAX_LOG_SIZE_BYTES, 10 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_LOG_SIZE_BYTES, 10485760);

  // 默认保留 3 个备份
  assert.equal(DEFAULT_MAX_BACKUP_COUNT, 3);

  // 常量类型应为 number
  assert.equal(typeof DEFAULT_MAX_LOG_SIZE_BYTES, "number");
  assert.equal(typeof DEFAULT_MAX_BACKUP_COUNT, "number");
});
