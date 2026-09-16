/**
 * getMachineId 隐私加固单元测试
 *
 * 背景（2026-09-17 审计）：
 * - 旧实现 `${os.hostname()}-${random}-${timestamp}` 会把主机名（潜在 PII）
 *   持久化到 ~/.deepcode/machine-id 并随遥测/插件请求头发送给远端服务器；
 * - 加固后标识改为纯随机 UUID，并对包含当前主机名的旧版标识自动迁移重生成。
 *
 * 测试策略：通过 HOME 环境变量隔离到临时目录（os.homedir() 在 POSIX 下读取 HOME），
 * 全部断言基于真实文件系统行为，不使用 mock 框架。
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getMachineId } from "../common/openai-client";

/** UUID v4 标准格式（8-4-4-4-12 位十六进制） */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 保存原始 HOME，测试后恢复 */
const originalHome = process.env.HOME;
/** 本测试文件使用的临时 HOME 目录 */
let tempHome = "";

/** 计算隔离 HOME 下 machine-id 文件的绝对路径 */
function machineIdPath(): string {
  return path.join(tempHome, ".deepcode", "machine-id");
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-machine-id-test-"));
  process.env.HOME = tempHome;
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

test("getMachineId 首次调用生成标准 UUID v4 并持久化到 ~/.deepcode/machine-id", () => {
  const machineId = getMachineId();

  assert.ok(machineId, "machineId 不应为 undefined");
  assert.match(machineId, UUID_REGEX, "生成的标识应为 UUID v4 格式（不含主机名等 PII）");
  assert.ok(fs.existsSync(machineIdPath()), "标识应持久化到 .deepcode/machine-id 文件");
  assert.equal(fs.readFileSync(machineIdPath(), "utf8").trim(), machineId, "文件内容应与返回值一致");
});

test("getMachineId 不包含主机名（防止主机名 PII 外泄）", () => {
  const machineId = getMachineId();

  assert.ok(machineId);
  assert.equal(machineId.includes(os.hostname()), false, "标识中不得出现主机名");
});

test("getMachineId 同一 HOME 下多次调用返回稳定标识（幂等）", () => {
  const first = getMachineId();
  const second = getMachineId();

  assert.ok(first);
  assert.equal(first, second, "已存在的有效标识应被复用，不应重复生成");
});

test("getMachineId 对包含主机名的旧版标识自动迁移重生成（消除历史 PII）", () => {
  // 模拟旧版生成的标识：hostname-random-timestamp
  const legacyId = `${os.hostname()}-abc123-${Date.now()}`;
  fs.mkdirSync(path.dirname(machineIdPath()), { recursive: true });
  fs.writeFileSync(machineIdPath(), legacyId, "utf8");

  const machineId = getMachineId();

  assert.ok(machineId);
  assert.notEqual(machineId, legacyId, "旧版含主机名的标识应被替换");
  assert.match(machineId, UUID_REGEX, "迁移后的标识应为纯随机 UUID");
  assert.equal(fs.readFileSync(machineIdPath(), "utf8").trim(), machineId, "迁移结果应覆盖写回 machine-id 文件");
});

test("getMachineId 对不含主机名的有效标识保持兼容（不误迁移第三方写入的值）", () => {
  const customId = "0f1e2d3c-4b5a-4678-9abc-def012345678";
  fs.mkdirSync(path.dirname(machineIdPath()), { recursive: true });
  fs.writeFileSync(machineIdPath(), customId, "utf8");

  const machineId = getMachineId();

  assert.equal(machineId, customId, "有效标识应原样复用");
});

test("getMachineId 对空文件内容重新生成（不返回空标识）", () => {
  fs.mkdirSync(path.dirname(machineIdPath()), { recursive: true });
  fs.writeFileSync(machineIdPath(), "   \n", "utf8");

  const machineId = getMachineId();

  assert.ok(machineId);
  assert.match(machineId, UUID_REGEX, "空内容时应重新生成有效 UUID");
});
