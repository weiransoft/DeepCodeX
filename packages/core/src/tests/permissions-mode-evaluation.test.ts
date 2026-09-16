/**
 * 三态权限模式（manual / auto / bypass）—— 权限评估引擎单元测试
 *
 * 对应设计文档 docs/dev/permission-modes.md §7.1 用例 PM-U07 ~ PM-U17：
 * - PM-U07~U11：manual 模式评估语义（unknown→ask、allow→allow、deny 保留、其余→ask）
 * - PM-U12：bypass 模式全部放行（deny/unknown/ask 一律 allow）
 * - PM-U13：auto 模式回归基线（与三态机制引入前行为一致）
 * - PM-U14~U15：getPermissionScopesRequiringAsk 在 manual / bypass 下的入列语义
 * - PM-U16~U17：computeToolCallPermissions 在 bypass / manual 下的审批计划生成
 *
 * 说明：直接从源路径 ../common/permissions 导入（core 测试既有惯例，见 permissions.test.ts）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import {
  computeToolCallPermissions,
  evaluatePermissionScopes,
  getPermissionScopesRequiringAsk,
} from "../common/permissions";
import type { PermissionScope, PermissionSettings } from "../settings";

const tempDirs: string[] = [];

/** 创建隔离临时目录并登记清理（测试结束后递归删除，避免污染宿主机） */
function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

process.on("exit", () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** 构造带 mode 字段的完整权限策略（Required<PermissionSettings>） */
function policy(
  mode: "manual" | "auto" | "bypass",
  overrides: Partial<Pick<PermissionSettings, "allow" | "deny" | "ask" | "defaultMode" | "addWorkingDirs">> = {}
): Required<PermissionSettings> {
  return {
    mode,
    allow: (overrides.allow ?? []) as PermissionScope[],
    deny: (overrides.deny ?? []) as PermissionScope[],
    ask: (overrides.ask ?? []) as PermissionScope[],
    defaultMode: overrides.defaultMode ?? "allowAll",
    addWorkingDirs: overrides.addWorkingDirs ?? [],
  };
}

// ---------------------------------------------------------------------------
// PM-U07 ~ PM-U11：manual（手动审批）评估语义
// ---------------------------------------------------------------------------

/** PM-U07：manual 模式下 unknown scope 仍须 ask（非法 sideEffects 不可借 manual 绕过） */
test("evaluatePermissionScopes(manual) asks for unknown scopes (PM-U07)", () => {
  assert.equal(evaluatePermissionScopes(["unknown"], policy("manual")), "ask");
  // unknown 与合法 allow scope 混合：unknown 检查在前，整体仍 ask
  assert.equal(
    evaluatePermissionScopes(["unknown", "read-in-cwd"], policy("manual", { allow: ["read-in-cwd"] })),
    "ask"
  );
});

/** PM-U08：manual 模式下 scope 命中 allow 白名单 → allow（白名单语义保留） */
test("evaluatePermissionScopes(manual) allows allowlisted scopes (PM-U08)", () => {
  const settings = policy("manual", { allow: ["read-in-cwd", "query-git-log"] });
  assert.equal(evaluatePermissionScopes(["read-in-cwd"], settings), "allow");
  // 多 scope 全部命中白名单时整体 allow
  assert.equal(evaluatePermissionScopes(["read-in-cwd", "query-git-log"], settings), "allow");
});

/** PM-U09：manual 模式下 deny 黑名单仍然生效（优先级最高） */
test("evaluatePermissionScopes(manual) keeps deny blacklist effective (PM-U09)", () => {
  const settings = policy("manual", { deny: ["write-out-cwd"] });
  assert.equal(evaluatePermissionScopes(["write-out-cwd"], settings), "deny");
  // deny scope 混入其他合法 scope：deny 优先于 manual 的 ask
  assert.equal(evaluatePermissionScopes(["write-out-cwd", "read-in-cwd"], settings), "deny");
});

/** PM-U10：manual 模式下 scope 命中 ask 列表（未进 allow）→ ask */
test("evaluatePermissionScopes(manual) asks for scopes in the ask list (PM-U10)", () => {
  const settings = policy("manual", { ask: ["network"] });
  assert.equal(evaluatePermissionScopes(["network"], settings), "ask");
});

/** PM-U11：manual 模式核心语义——未显式 allow 的合法 scope 一律 ask（对齐 Trae「始终手动运行」） */
test("evaluatePermissionScopes(manual) asks for any scope not in the allowlist (PM-U11)", () => {
  const settings = policy("manual");
  // 空白名单：任意合法 scope 都要询问（即便 defaultMode=allowAll 也不放行）
  assert.equal(evaluatePermissionScopes(["write-in-cwd"], settings), "ask");
  assert.equal(evaluatePermissionScopes(["network"], settings), "ask");
  assert.equal(evaluatePermissionScopes(["mcp"], settings), "ask");
  assert.equal(evaluatePermissionScopes(["delete-out-cwd"], settings), "ask");
});

// ---------------------------------------------------------------------------
// PM-U12：bypass（完全访问）评估语义
// ---------------------------------------------------------------------------

/** PM-U12：bypass 模式下 deny / unknown / ask / 普通合法 scope 全部放行 */
test("evaluatePermissionScopes(bypass) allows every scope including deny and unknown (PM-U12)", () => {
  // 即使配置了 deny 黑名单与 ask 列表，bypass 也全部放行（安全底线由 executor 硬拦截独立保障）
  const settings = policy("bypass", { deny: ["write-out-cwd"], ask: ["network"] });
  assert.equal(evaluatePermissionScopes(["write-out-cwd"], settings), "allow");
  assert.equal(evaluatePermissionScopes(["unknown"], settings), "allow");
  assert.equal(evaluatePermissionScopes(["network"], settings), "allow");
  assert.equal(evaluatePermissionScopes(["read-in-cwd"], settings), "allow");
  assert.equal(evaluatePermissionScopes([], settings), "allow");
});

// ---------------------------------------------------------------------------
// PM-U13：auto（自动审批 + 白名单，默认）回归基线
// ---------------------------------------------------------------------------

/** PM-U13：auto 模式行为与三态机制引入前完全一致（回归基线） */
test("evaluatePermissionScopes(auto) keeps legacy evaluation semantics (PM-U13)", () => {
  const settings = policy("auto", {
    allow: ["read-in-cwd"],
    deny: ["write-out-cwd"],
    ask: ["network"],
    defaultMode: "askAll",
  });
  assert.equal(evaluatePermissionScopes(["write-out-cwd"], settings), "deny");
  assert.equal(evaluatePermissionScopes(["network"], settings), "ask");
  assert.equal(evaluatePermissionScopes(["read-in-cwd"], settings), "allow");
  // 未命中任何列表且 defaultMode=askAll → ask
  assert.equal(evaluatePermissionScopes(["write-in-cwd"], settings), "ask");
  // 空 scope 列表 → allow（无副作用）
  assert.equal(evaluatePermissionScopes([], settings), "allow");
  // unknown 在 auto 下仍强制 ask（P0 安全修复回归）
  assert.equal(evaluatePermissionScopes(["unknown"], settings), "ask");
});

// ---------------------------------------------------------------------------
// PM-U14 ~ PM-U15：getPermissionScopesRequiringAsk 三态语义
// ---------------------------------------------------------------------------

/** PM-U14：manual 模式下非 allow 的 scope 全量入列（deny 仍被排除），供审批面板展示 */
test("getPermissionScopesRequiringAsk(manual) lists every non-allowlisted scope (PM-U14)", () => {
  const settings = policy("manual", {
    allow: ["read-in-cwd"],
    deny: ["delete-in-cwd"],
  });
  const result = getPermissionScopesRequiringAsk(["read-in-cwd", "write-in-cwd", "network", "delete-in-cwd"], settings);
  // read-in-cwd 已在白名单不入列；delete-in-cwd 被 deny 排除；其余全量入列
  assert.deepEqual(result, ["write-in-cwd", "network"]);
});

/** PM-U15：bypass 模式下无任何 scope 需要询问（审批面板不触发） */
test("getPermissionScopesRequiringAsk(bypass) returns an empty list (PM-U15)", () => {
  const settings = policy("bypass", { deny: ["write-out-cwd"], ask: ["network"] });
  assert.deepEqual(getPermissionScopesRequiringAsk(["unknown", "network", "write-out-cwd"], settings), []);
});

// ---------------------------------------------------------------------------
// PM-U16 ~ PM-U17：computeToolCallPermissions 三态审批计划
// ---------------------------------------------------------------------------

/** PM-U16：bypass 模式快速通道——所有工具调用 allow、不产生 askPermissions，planMode forceAskScopes 亦放行 */
test("computeToolCallPermissions(bypass) allows everything and skips ask panel even in plan mode (PM-U16)", () => {
  const projectRoot = createTempDir("deepcode-perm-bypass-plan-workspace-");
  const plan = computeToolCallPermissions({
    sessionId: "session-bypass",
    projectRoot,
    // planMode 强制询问列表（写/删/git 变更）：bypass 语义下用户已明确放弃审批，同样放行
    forceAskScopes: ["write-in-cwd", "delete-in-cwd", "mutate-git-log"],
    settings: policy("bypass", { deny: ["write-in-cwd"] }),
    toolCalls: [
      {
        id: "call-write",
        type: "function",
        function: {
          name: "write",
          arguments: JSON.stringify({ file_path: path.join(projectRoot, "a.txt"), content: "x" }),
        },
      },
      {
        id: "call-bash",
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: "curl https://example.com", sideEffects: ["network"] }),
        },
      },
      {
        id: "call-mcp",
        type: "function",
        function: { name: "mcp__weather__lookup", arguments: JSON.stringify({ city: "sf" }) },
      },
    ],
  });
  assert.deepEqual(plan.permissions, [
    { toolCallId: "call-write", permission: "allow" },
    { toolCallId: "call-bash", permission: "allow" },
    { toolCallId: "call-mcp", permission: "allow" },
  ]);
  assert.deepEqual(plan.askPermissions, []);
});

/** PM-U17：manual 模式审批计划——写/删/network/mcp 全部 ask，且 askPermissions 携带齐全 scope */
test("computeToolCallPermissions(manual) asks for write/delete/network/mcp calls (PM-U17)", () => {
  const projectRoot = createTempDir("deepcode-perm-manual-plan-workspace-");
  const plan = computeToolCallPermissions({
    sessionId: "session-manual",
    projectRoot,
    settings: policy("manual"),
    toolCalls: [
      {
        id: "call-write",
        type: "function",
        function: {
          name: "write",
          arguments: JSON.stringify({ file_path: path.join(projectRoot, "a.txt"), content: "x" }),
        },
      },
      {
        id: "call-bash-net",
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: "curl https://example.com", sideEffects: ["network"] }),
        },
      },
      {
        id: "call-bash-del",
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: "rm ./build.log", sideEffects: ["delete-in-cwd"] }),
        },
      },
      {
        id: "call-mcp",
        type: "function",
        function: { name: "mcp__weather__lookup", arguments: JSON.stringify({ city: "sf" }) },
      },
    ],
  });
  // 手动审批：所有非常规只读调用一律 ask
  assert.deepEqual(plan.permissions, [
    { toolCallId: "call-write", permission: "ask" },
    { toolCallId: "call-bash-net", permission: "ask" },
    { toolCallId: "call-bash-del", permission: "ask" },
    { toolCallId: "call-mcp", permission: "ask" },
  ]);
  // askPermissions 与 ask 项一一对应，scope 与工具调用匹配
  assert.deepEqual(
    plan.askPermissions.map((item) => ({ id: item.toolCallId, scopes: item.scopes })),
    [
      { id: "call-write", scopes: ["write-in-cwd"] },
      { id: "call-bash-net", scopes: ["network"] },
      { id: "call-bash-del", scopes: ["delete-in-cwd"] },
      { id: "call-mcp", scopes: ["mcp"] },
    ]
  );
});
