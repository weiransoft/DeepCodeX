/**
 * image_generator.py get_machine_id 隐私加固单元测试
 *
 * 背景（2026-09-17 审计复查）：
 * 图片生成技能脚本独立维护 machine-id 兜底生成逻辑，旧实现
 * `${hostname}-${random}-${timestamp}` 会把主机名（潜在 PII）写入
 * ~/.deepcode/machine-id 并随 image-gen 请求头发送。加固后与 CLI 侧
 * getMachineId 对齐：纯随机 UUID + 旧标识迁移。
 *
 * 测试策略：HOME 隔离到临时目录（Path.home() 在 POSIX 下读取 HOME），
 * 通过 importlib 真实加载脚本模块执行；python3 缺失时跳过。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

// ESM 模块兼容：__dirname 在 ESM 中不可用，通过 import.meta.url 构造等价路径
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCRIPT_PATH = path.resolve(
  __dirname,
  "../../templates/skills/bundled/image-generator/scripts/image_generator.py"
);

/** UUID v4 标准格式（8-4-4-4-12 位十六进制） */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 判断当前环境是否有可用的 python3 */
function hasPython3(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 HOME 隔离的临时目录中执行 Python 片段。
 * @param statements Python 语句列表（在模块加载后逐条执行，最后 print PYTHON_OK）
 */
function runPythonWithIsolatedHome(statements: string[]): string {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-image-gen-mid-"));
  try {
    const python = [
      "import importlib.util",
      `spec = importlib.util.spec_from_file_location('ig', r'''${SCRIPT_PATH}''')`,
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      ...statements,
      "print('PYTHON_OK')",
    ].join("\n");
    return execFileSync("python3", ["-c", python], {
      encoding: "utf8",
      env: { ...process.env, HOME: tempHome },
    });
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

test("image_generator get_machine_id 生成纯随机 UUID 且不含主机名", { skip: !hasPython3() }, () => {
  const stdout = runPythonWithIsolatedHome([
    "machine_id = module.get_machine_id()",
    "import re",
    "assert machine_id, 'machine_id should not be None'",
    `assert re.match(r'${UUID_REGEX.source}', machine_id), f'not a UUID: {machine_id}'`,
    "import socket",
    "assert socket.gethostname() not in machine_id, 'hostname PII leaked'",
    "id_file = module.MACHINE_ID_PATH",
    "assert id_file.exists() and id_file.read_text().strip() == machine_id",
  ]);
  assert.match(stdout, /PYTHON_OK/);
});

test("image_generator get_machine_id 复用已有有效标识（幂等）", { skip: !hasPython3() }, () => {
  const stdout = runPythonWithIsolatedHome([
    "first = module.get_machine_id()",
    "second = module.get_machine_id()",
    "assert first == second, 'existing valid id should be reused'",
  ]);
  assert.match(stdout, /PYTHON_OK/);
});

test("image_generator get_machine_id 对含主机名的旧标识自动迁移", { skip: !hasPython3() }, () => {
  const stdout = runPythonWithIsolatedHome([
    "import socket",
    "legacy = f'{socket.gethostname()}-abc123-1737000000000'",
    "module.MACHINE_ID_PATH.parent.mkdir(parents=True, exist_ok=True)",
    "module.MACHINE_ID_PATH.write_text(legacy, encoding='utf-8')",
    "machine_id = module.get_machine_id()",
    "import re",
    "assert machine_id != legacy, 'legacy hostname id should be regenerated'",
    `assert re.match(r'${UUID_REGEX.source}', machine_id), f'not a UUID: {machine_id}'`,
    "assert module.MACHINE_ID_PATH.read_text().strip() == machine_id",
  ]);
  assert.match(stdout, /PYTHON_OK/);
});
