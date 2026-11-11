/**
 * 构建脚本安全检查
 *
 * 验证以下构建/发布脚本未使用 shell:true，避免 shell 注入攻击面：
 * - scripts/build.js
 * - scripts/prepare-vscode.js
 * - scripts/build-vscode-companion.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, "../scripts");
const root = path.resolve(__dirname, "..");
const readFileSync = fs.readFileSync;

/**
 * 读取脚本源码
 */
function readScript(name: string): string {
  return fs.readFileSync(path.join(SCRIPTS_DIR, name), "utf-8");
}

/**
 * 断言指定脚本中所有 spawnSync(...) 调用内部均不含 shell:true
 */
function assertNoShellTrue(scriptName: string): void {
  const source = readScript(scriptName);
  const spawnCalls = [...source.matchAll(/spawnSync\s*\(([^)]+)\)/g)];
  assert.ok(spawnCalls.length > 0, `${scriptName} 中应存在 spawnSync 调用`);
  for (const call of spawnCalls) {
    const args = call[1] ?? "";
    assert.doesNotMatch(args, /shell\s*:\s*true/, `${scriptName} 的 spawnSync 调用内部不应使用 shell:true`);
  }
}

test("scripts/build.js 实际 spawnSync 调用中不包含 shell:true", () => {
  assertNoShellTrue("build.js");
});

test("scripts/prepare-vscode.js 实际 spawnSync 调用中不包含 shell:true", () => {
  assertNoShellTrue("prepare-vscode.js");
});

test("scripts/build-vscode-companion.js 实际 spawnSync 调用中不包含 shell:true", () => {
  assertNoShellTrue("build-vscode-companion.js");
});

test("scripts/build.js 的 run 调用点使用字符串命令与数组参数", () => {
  const source = readScript("build.js");
  // 仅匹配 run("...", [...]) 形式的实际调用，排除函数定义 run(command, args, label)
  const runCalls = [...source.matchAll(/run\s*\(\s*"[^"]+"\s*,\s*\[/g)];
  assert.ok(runCalls.length > 0, "build.js 中应存在 run(...) 调用");
});

test("提交物安全扫描：镜像清单引用的 Dockerfile 与生产 compose 禁用 root / latest / 明文密钥", () => {
  const compose = readFileSync(path.join(root, "docker-compose.prod.yml"), "utf8");
  const celery = readFileSync(path.join(root, "apps/worker/celery_app.py"), "utf8");

  // 生产 compose 引用的 Dockerfile 必须显式声明非 root 用户
  for (const df of ["apps/api/Dockerfile", "apps/worker/Dockerfile"]) {
    const content = readFileSync(path.join(root, df), "utf8");
    assert.match(content, /^[ \t]*USER[ \t]+(?!root)\S+/m, `${df} 必须以非 root 用户运行`);
    assert.doesNotMatch(content, /(^|[ \t])USER[ \t]+root[ \t]*$/m, `${df} 运行阶段不得切回 root`);
  }

  // 生产 compose 不得绑定 :latest 镜像
  assert.doesNotMatch(compose, /image:[ \t]*\S+:latest\b/, "生产 compose 不得引用 :latest 镜像");

  // compose 不得内联明文密钥（密钥必须来自 env_file / environment 注入）
  for (const key of ["POSTGRES_PASSWORD", "REDIS_PASSWORD", "SECRET_KEY"]) {
    assert.doesNotMatch(compose, new RegExp(`^[ \\t]*${key}:\\s*\\S`, "m"), `${key} 不得在 compose 中硬编码`);
  }

  // 泛化分发端点必须使用服务令牌鉴权，不得匿名放行
  assert.match(celery, /X-Submit-Token/, "submit/poll 端点必须校验 X-Submit-Token");
  assert.match(celery, /hmac\.compare_digest/, "令牌比较必须使用常量时间比较");
});
