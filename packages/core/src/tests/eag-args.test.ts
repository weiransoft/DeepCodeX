/**
 * EAG CLI 共享参数解析工具（eag-args）单元测试
 *
 * 背景（2026-10-14 事故追溯）：
 * - /eag-autonomous、/eag-design、/eag-graph、/eag-deploy 四条命令曾各自内联同一份
 *   `--key value` 解析正则，且双引号分支 `"[^"]*"` 不支持值内转义引号 \"。
 * - 当 --goal 值内部含双引号（如 hc_config.get(\"url\")）时，值分支匹配失败退化为
 *   flag（value=true），误报「缺少必填参数 --goal 或值为空」——命令看似正确却被拒绝。
 *
 * 本测试锁定共享实现 parseEagArgs 的行为契约（含事故回归用例）：
 * - 双引号值内 \" 转义（事故原样复现）
 * - 单引号字面语义 / 裸值 / flag 形式
 * - 未知转义序列原样保留（避免破坏正则/路径文本）
 * - 重复参数首次匹配生效
 * - 与 extractEagAutonomousRequestFromPrompt / extractDeployRequestFromPrompt 的端到端集成
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：直接调用 parseEagArgs 与各 extractXxxFromPrompt，不通过 SessionManager 注入
 * - 中文注释
 *
 * @module tests/eag-args
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEagArgs } from "../eag/cli/eag-args";
import { extractEagAutonomousRequestFromPrompt } from "../eag/cli/eag-autonomous-command";
import { extractDeployRequestFromPrompt } from "../eag/cli/eag-command-parser";

// ============================================================================
// N. parseEagArgs 行为契约
// ============================================================================

test('N1 parseEagArgs: 双引号值含 \\" 转义（2026-10-14 事故原样复现）', () => {
  const argsPart =
    '--goal "修复 §7.2 resident stop 探测键名错位（hc_config.get(\\"url\\") 改为兼容 endpoint）以及 §7.3 声明重建等效性问题" --max-iterations 10 --confirmation smart';
  const args = parseEagArgs(argsPart);
  assert.equal(typeof args["goal"], "string", "goal 必须解析为字符串而非 flag(true)");
  const goal = args["goal"] as string;
  // 反转义后内层引号还原为字面 "，转义序列本身不残留多余反斜杠
  assert.ok(goal.includes('hc_config.get("url")'), `goal 应含还原后的内嵌双引号，实际: ${goal}`);
  assert.equal(args["max-iterations"], "10");
  assert.equal(args["confirmation"], "smart");
});

test("N2 parseEagArgs: 双引号值无内嵌引号（回归对照）", () => {
  const args = parseEagArgs('--goal "修复 resident stop 探测键名错位" --max-iterations 10 --confirmation smart');
  assert.equal(args["goal"], "修复 resident stop 探测键名错位");
  assert.equal(args["max-iterations"], "10");
  assert.equal(args["confirmation"], "smart");
});

test("N3 parseEagArgs: 单引号值保持字面语义（不做反转义）", () => {
  const args = parseEagArgs("--goal '修复 hc_config.get(\"url\") 兼容' --x 1");
  // 单引号内双引号原样保留
  assert.equal(args["goal"], '修复 hc_config.get("url") 兼容');
});

test("N4 parseEagArgs: flag 无值 + 裸值混合", () => {
  const args = parseEagArgs("--dry-run --env prod");
  assert.equal(args["dry-run"], true);
  assert.equal(args["env"], "prod");
});

test("N5 parseEagArgs: 未知转义序列原样保留（如 \\d、\\n 字面文本）", () => {
  // 保守反转义策略：仅 \" \' \\ 三种序列还原，其余保留
  const args = parseEagArgs('--goal "正则 \\d+ 与 C:\\\\tmp 路径" --x 1');
  const goal = args["goal"] as string;
  assert.ok(goal.includes("\\d+"), `未知转义 \\d 应原样保留，实际: ${goal}`);
});

test("N6 parseEagArgs: 重复参数首次匹配生效", () => {
  const args = parseEagArgs('--goal "第一值" --goal "第二值"');
  assert.equal(args["goal"], "第一值");
});

test("N7 parseEagArgs: --key=value 形式（等号分隔符）", () => {
  const args = parseEagArgs('--env=prod --image "registry/repo:tag"');
  assert.equal(args["env"], "prod");
  assert.equal(args["image"], "registry/repo:tag");
});

test("N8 parseEagArgs: 空参数字符串返回空对象", () => {
  assert.deepEqual(parseEagArgs(""), {});
});

// ============================================================================
// O. 端到端集成（事故命令通过完整 extract 链路）
// ============================================================================

test("O1 extractEagAutonomousRequestFromPrompt: 事故命令端到端解析成功", () => {
  const cmd =
    '/eag-autonomous --goal "修复 §7.2 resident stop 探测键名错位（hc_config.get(\\"url\\") 改为兼容 endpoint）以及 §7.3 声明重建等效性问题（container_run 支持 entrypoint 覆盖、修正 proteinmpnn 挂载与环境变量），并追溯 is_resident 设入主体" --max-iterations 10 --confirmation smart';
  const request = extractEagAutonomousRequestFromPrompt(cmd);
  assert.ok(typeof request.goal === "string" && request.goal.trim().length > 0, "goal 必须非空");
  assert.ok(request.goal.includes('hc_config.get("url")'), "goal 应还原内嵌双引号");
  assert.equal(request.maxIterations, 10);
  assert.equal(request.confirmation, "smart");
});

test("O2 extractDeployRequestFromPrompt: 引号值参数端到端解析成功", () => {
  const cmd =
    '/eag-deploy --project "order-service" --env prod --image "registry.example.com/order:1.2.3" --port 8080 --replicas 3 --iac helm-chart --strategy canary';
  const request = extractDeployRequestFromPrompt(cmd);
  assert.equal(request.projectName, "order-service");
  assert.equal(request.image, "registry.example.com/order:1.2.3");
  assert.equal(request.port, 8080);
});
