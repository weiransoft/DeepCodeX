/**
 * 三态权限模式（manual / auto / bypass）—— settings 归一层单元测试
 *
 * 对应设计文档 docs/dev/permission-modes.md §7.1 用例 PM-U01 ~ PM-U06：
 * - PM-U01：无 mode 字段 → 归一为 "auto"（存量配置零回归）
 * - PM-U02：mode="bypass"/"manual" 合法值 → 原样保留
 * - PM-U03：mode="evil"/123/null 非法值 → 降级 "auto"（fail-safe）
 * - PM-U04：merge：项目 mode=bypass 覆盖用户 mode=manual → bypass（项目优先）
 * - PM-U05：merge：仅用户设置 mode → 取用户值
 * - PM-U06：merge：均未设置 mode → "auto"
 *
 * 说明：normalizePermissions / mergePermissions 为 settings.ts 私有函数，
 * 按项目既有测试惯例（settings-and-notify.test.ts）通过公开 API
 * resolveSettingsSources / resolveSettings 观察归一与合并行为。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSettings, resolveSettingsSources } from "../settings";

// 与既有测试保持一致：隔离 process.env，避免宿主机环境变量干扰解析结果
const TEST_PROCESS_ENV = {};

// settings 解析所需的模型默认值（resolveSettings* 的必填 defaults 参数）
const DEFAULTS = { model: "default-model", baseURL: "https://default.example.com" } as const;

/** PM-U01：存量配置无 mode 字段时归一为 "auto"，保证零回归 */
test("resolveSettings normalizes missing permissions mode to auto (PM-U01)", () => {
  const resolved = resolveSettings(
    {
      // 存量用户配置：只有 allow 白名单，没有 mode 字段
      permissions: { allow: ["read-in-cwd"] },
    },
    DEFAULTS,
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.permissions.mode, "auto");
  // 白名单等其他字段不受 mode 归一影响
  assert.deepEqual(resolved.permissions.allow, ["read-in-cwd"]);
});

/** PM-U02：合法三态值 manual / bypass 原样保留，不被归一层改写 */
test("resolveSettings preserves valid permission modes manual and bypass (PM-U02)", () => {
  const manual = resolveSettings({ permissions: { mode: "manual" } }, DEFAULTS, TEST_PROCESS_ENV);
  const bypass = resolveSettings({ permissions: { mode: "bypass" } }, DEFAULTS, TEST_PROCESS_ENV);
  const auto = resolveSettings({ permissions: { mode: "auto" } }, DEFAULTS, TEST_PROCESS_ENV);
  assert.equal(manual.permissions.mode, "manual");
  assert.equal(bypass.permissions.mode, "bypass");
  assert.equal(auto.permissions.mode, "auto");
});

/** PM-U03：非法 mode 值（未知字符串 / 数字 / null）一律降级为 "auto"（fail-safe） */
test("resolveSettings downgrades invalid permission modes to auto (PM-U03)", () => {
  const evil = resolveSettings(
    // 未知字符串：攻击者篡改 settings.json 时不得被当作合法模式
    { permissions: { mode: "evil" as never } },
    DEFAULTS,
    TEST_PROCESS_ENV
  );
  const numeric = resolveSettings({ permissions: { mode: 123 as never } }, DEFAULTS, TEST_PROCESS_ENV);
  const nullish = resolveSettings({ permissions: { mode: null as never } }, DEFAULTS, TEST_PROCESS_ENV);
  assert.equal(evil.permissions.mode, "auto");
  assert.equal(numeric.permissions.mode, "auto");
  assert.equal(nullish.permissions.mode, "auto");
});

/** PM-U04：merge 优先级——项目 settings 的 mode 覆盖用户 settings 的 mode（与 defaultMode 一致） */
test("resolveSettingsSources gives project mode precedence over user mode (PM-U04)", () => {
  const resolved = resolveSettingsSources(
    // 用户级：手动审批
    { permissions: { mode: "manual" } },
    // 项目级：完全访问（项目目录级覆盖生效）
    { permissions: { mode: "bypass" } },
    DEFAULTS,
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.permissions.mode, "bypass");
});

/** PM-U05：merge——仅用户 settings 配置 mode 时取用户值 */
test("resolveSettingsSources falls back to user mode when project omits it (PM-U05)", () => {
  const resolved = resolveSettingsSources(
    { permissions: { mode: "manual" } },
    // 项目级未配置 permissions.mode
    { permissions: { allow: ["network"] } },
    DEFAULTS,
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.permissions.mode, "manual");
  // 项目级其他权限字段仍正常合并
  assert.deepEqual(resolved.permissions.allow, ["network"]);
});

/** PM-U06：merge——两级均未设置 mode 时兜底 "auto" */
test("resolveSettingsSources defaults mode to auto when neither source sets it (PM-U06)", () => {
  const resolved = resolveSettingsSources({}, {}, DEFAULTS, TEST_PROCESS_ENV);
  assert.equal(resolved.permissions.mode, "auto");
});
