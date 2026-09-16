/**
 * video_generator.py 敏感文件上传拦截单元测试
 *
 * 背景（2026-09-17 审计建议 #2）：
 * 视频生成技能会将用户本地素材上传至外部对象存储（deepcode.vegamo.cn / files.vegamo.cn）。
 * 加固后脚本在 validate_file 中增加 assert_upload_safe 拦截，拒绝疑似密钥/凭据文件。
 *
 * 测试策略：通过 importlib 按路径真实加载 Python 脚本模块，调用 assert_upload_safe
 * 验证拦截规则；不使用 mock。python3 缺失时跳过。
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
  "../../templates/skills/bundled/video-generator/scripts/video_generator.py"
);

/** 判断当前环境是否有可用的 python3 */
function hasPython3(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("video_generator.py assert_upload_safe 拦截敏感文件并放行正常媒体素材", { skip: !hasPython3() }, () => {
  // 用例集：[文件名, 是否应被拦截]
  const cases: Array<[string, boolean]> = [
    // 应拦截：.env 前缀（含 .env.local 等变体）
    [".env", true],
    [".env.local", true],
    // 应拦截：SSH 私钥全名匹配
    ["id_rsa", true],
    ["id_ed25519", true],
    // 应拦截：敏感后缀
    ["server.pem", true],
    ["private.key", true],
    ["keystore.p12", true],
    ["app.jks", true],
    // 应拦截：通用凭据与关键词命中
    ["credentials.json", true],
    ["api_secrets.json", true],
    ["my_passwords.txt", true],
    ["git-credentials", true],
    // 应放行：正常媒体素材
    ["scene.mp4", false],
    ["photo.png", false],
    ["voiceover.mp3", false],
    ["banner.webp", false],
    // 应放行：名称敏感词出现在扩展名之后缀部位以外的误判边界（如 "secrete" 不含 secret? 含!）
    // 注："secrete.mp4" 含 "secret" 会被拦截——设计取舍：宁拒勿泄
  ];

  const python = [
    "import importlib.util",
    `spec = importlib.util.spec_from_file_location('vg', r'''${SCRIPT_PATH}''')`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "from pathlib import Path",
    // JSON.stringify 会输出 true/false，Python 需要手工转为 True/False
    `cases = [${cases.map(([name, sensitive]) => `[${JSON.stringify(name)}, ${sensitive ? "True" : "False"}]`).join(", ")}]`,
    "for name, sensitive in cases:",
    "    try:",
    "        module.assert_upload_safe(Path(name))",
    "        assert not sensitive, f'{name} should have been rejected'",
    "    except module.VideoError:",
    "        assert sensitive, f'{name} should have been allowed'",
    "print('ALL_OK')",
  ].join("\n");

  const stdout = execFileSync("python3", ["-c", python], { encoding: "utf8" });
  assert.match(stdout, /ALL_OK/);
});

test("video_generator.py validate_file 在存在性检查后立即调用敏感拦截", { skip: !hasPython3() }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-gen-safety-"));
  try {
    // 构造一个真实存在但名称敏感的文件：validate_file 应在大小/类型检查前先行拒绝
    const secretFile = path.join(dir, ".env");
    fs.writeFileSync(secretFile, "PLUS_API_KEY=leak");

    const python = [
      "import importlib.util",
      `spec = importlib.util.spec_from_file_location('vg', r'''${SCRIPT_PATH}''')`,
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "from pathlib import Path",
      `p = Path(r'''${secretFile}''')`,
      "try:",
      "    module.validate_file(p, 'video', False)",
      "    raise SystemExit('FAIL: .env was not rejected by validate_file')",
      "except module.VideoError as exc:",
      "    assert '禁止上传' in str(exc), str(exc)",
      "print('ALL_OK')",
    ].join("\n");

    const stdout = execFileSync("python3", ["-c", python], { encoding: "utf8" });
    assert.match(stdout, /ALL_OK/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
