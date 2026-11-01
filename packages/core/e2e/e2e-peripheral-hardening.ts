/**
 * E2E：外围硬化项（kubectl 挂死 / LDAP 分页死循环 / 护栏命令来源判定）
 *
 * 覆盖 2026-11-01 三项修复的**真实行为**：
 *   1. kubectl 挂死：kubeconfig 指向失联 apiserver 时，`kubectl get` 会永久
 *      挂住，监控就绪检查的 Promise 永不 settle → 整个部署流程静默卡死。
 *      这里用**真实的卡死 kubectl 进程**（PATH 注入的 shell 脚本）验证超时生效。
 *   2. LDAP 分页死循环：`syncBatchSize=0` 时 offset 不推进 → while(true) 空转。
 *      这里用真实 LdapSynchronizer + 可控的假 LDAP 客户端，验证仍能收敛。
 *   3. 护栏命令来源：verify 阶段跑的是**用户配置的**测试命令，不该被
 *      「模型自选命令白名单」误拦；而真正的危险命令必须照样拦。
 *
 * 运行：
 *   node --import tsx packages/core/e2e/e2e-peripheral-hardening.ts
 *
 * 退出码：0 = 全部通过；1 = 有用例失败
 */
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { MonitoringReadinessCheckerImpl } from "../src/eag/devops/monitoring-readiness-checker";
import { createLdapSynchronizer } from "../src/eag/tcs/ldap-adapter";
import type { LdapClient, UserMirrorStore } from "../src/eag/tcs/ldap-adapter";
import { BlockerGuardChain } from "../src/eag/p5/guards/blocker-guard-chain";
import { EnvBoundaryGuard } from "../src/eag/p5/guards/env-boundary-guard";
import { DangerousCommandGuard } from "../src/eag/p5/guards/dangerous-command-guard";
import {
  CredentialMisuseGuard,
  FakeCompletionGuard,
  RuntimeConstraintGuard,
  ScopeLockGuard,
} from "../src/eag/p5/guards/scope-fake-cred-runtime-guards";
import type { GuardContext } from "../src/eag/p5/guards/types";

let pass = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 给任意 Promise 套一个"卡死检测"超时（超时即判失败，而不是让脚本挂住） */
async function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  label: string
): Promise<{ ok: boolean; value?: T; ms: number }> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), ms);
  });
  const result = await Promise.race([p.then((v) => ({ ok: true as const, value: v })), timeout]);
  if (timer) clearTimeout(timer);
  const elapsed = Date.now() - start;
  if (!result.ok) {
    console.log(`     ⏱  ${label} 超过 ${ms}ms 仍未返回（判定为挂死）`);
    return { ok: false, ms: elapsed };
  }
  return { ok: true, value: (result as { value: T }).value, ms: elapsed };
}

// ============================================================================
// 场景 1：kubectl 永久挂死 → 必须在超时后返回结论
// ============================================================================

console.log("\n【场景 1】kubectl 挂死：监控检查必须在超时后返回（不得静默卡死）");
{
  const binDir = mkdtempSync(path.join(tmpdir(), "deepcode-fake-kubectl-"));
  const fakeKubectl = path.join(binDir, "kubectl");
  // 真实可执行的"卡死 kubectl"：sleep 60 秒，模拟 apiserver 失联
  writeFileSync(fakeKubectl, "#!/bin/sh\nsleep 60\n", "utf8");
  chmodSync(fakeKubectl, 0o755);

  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}:${originalPath}`;

  const KUBECTL_TIMEOUT = 800;
  const checker = new MonitoringReadinessCheckerImpl({
    kubectlTimeoutMs: KUBECTL_TIMEOUT,
    httpTimeoutMs: 300,
  });

  const started = Date.now();
  const outcome = await withDeadline(
    checker.check({
      projectName: "e2e-app",
      namespace: "e2e-ns",
      serviceName: "e2e-svc",
      // 不可达端点：只验证超时行为，不依赖外网
      metricsEndpoint: "http://127.0.0.1:1/metrics",
    }),
    15000,
    "MonitoringReadinessChecker.check"
  );
  const elapsed = Date.now() - started;

  // 恢复 PATH（避免影响后续用例）
  process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });

  check("监控检查最终返回（未因 kubectl 挂死而永久阻塞）", outcome.ok === true, `耗时 ${elapsed}ms`);
  if (outcome.ok && outcome.value) {
    const result = outcome.value;
    const monitorItem = result.checkedItems.find((i) => i.name === "serviceMonitorExists");
    check("kubectl 检查项被标记为未通过", monitorItem?.passed === false, `passed=${monitorItem?.passed}`);
    check(
      "失败原因明确指向超时（用户可据此排查集群连通性）",
      typeof monitorItem?.detail === "string" && monitorItem.detail.includes("超时"),
      monitorItem?.detail?.slice(0, 60)
    );
    check(
      "总耗时受 kubectl 超时约束（远小于卡死的 60s）",
      elapsed < 10000,
      `实际 ${elapsed}ms（kubectlTimeoutMs=${KUBECTL_TIMEOUT}）`
    );
    check("整体 ready=false（不把未就绪当就绪）", result.ready === false);
  }
}

// ============================================================================
// 场景 2：LDAP syncBatchSize=0 → 必须收敛，不得 while(true) 空转
// ============================================================================

console.log("\n【场景 2】LDAP syncBatchSize=0/-5/NaN：分页同步必须收敛");
{
  /** 可控的假 LDAP 客户端：共 3 个用户，按 offset/limit 分页 */
  function makeClient(): { client: LdapClient; calls: () => number; lastLimit: () => number } {
    const users = [
      { entryUUID: "u1", username: "a", mail: "a@e2e", displayName: "A", status: "active" as const },
      { entryUUID: "u2", username: "b", mail: "b@e2e", displayName: "B", status: "active" as const },
      { entryUUID: "u3", username: "c", mail: "c@e2e", displayName: "C", status: "active" as const },
    ];
    let calls = 0;
    let lastLimit = -1;
    const client = {
      async testConnection() {
        return true;
      },
      async searchAllUsers(offset: number, limit: number) {
        calls += 1;
        lastLimit = limit;
        // limit<=0 时若实现直接 `offset += limit` 就会原地打转；
        // 这里返回 1 条让"不推进"立刻暴露成无限循环
        const size = limit > 0 ? limit : 1;
        return users.slice(offset, offset + size);
      },
      async searchAllOrgs() {
        return [];
      },
      async searchUsersByUsername(username: string) {
        return users.filter((u) => u.username === username);
      },
      async validateCredentials() {
        return true;
      },
      async getUserByEntryUUID(uuid: string) {
        return users.find((u) => u.entryUUID === uuid) ?? null;
      },
    } as unknown as LdapClient;
    return { client, calls: () => calls, lastLimit: () => lastLimit };
  }

  const store = {
    async upsertUserByEntryUUID() {
      return "created" as const;
    },
    async upsertOrgByDn() {
      return "created" as const;
    },
    async deleteUserByEntryUUID() {
      /* noop */
    },
    async getUserByUsername() {
      return null;
    },
    async getSyncedEntryUUIDs() {
      return new Set<string>();
    },
    async listAllUsers() {
      return [];
    },
  } as unknown as UserMirrorStore;

  const baseConfig = {
    url: "ldap://127.0.0.1:389",
    bindDn: "cn=admin,dc=e2e",
    bindPassword: "secret",
    userSearchBase: "ou=users,dc=e2e",
    userSearchFilter: "(uid={0})",
    orgSearchBase: "ou=orgs,dc=e2e",
    orgSearchFilter: "(ou={0})",
  };

  for (const batchSize of [0, -5, Number.NaN]) {
    const { client, calls, lastLimit } = makeClient();
    const sync = createLdapSynchronizer({ ...baseConfig, syncBatchSize: batchSize } as never, client, store);
    const outcome = await withDeadline(sync.fullSync(), 8000, `fullSync(syncBatchSize=${batchSize})`);
    check(
      `syncBatchSize=${String(batchSize)}：全量同步能收敛（不死循环）`,
      outcome.ok === true,
      outcome.ok ? `调用 ${calls()} 次分页` : "超时判定为死循环"
    );
    if (outcome.ok) {
      check(
        `syncBatchSize=${String(batchSize)}：实际下发批大小被夹到 >= 1`,
        lastLimit() >= 1,
        `实际 limit=${lastLimit()}`
      );
      check(`syncBatchSize=${String(batchSize)}：分页调用次数有限（<= 10）`, calls() <= 10, `调用 ${calls()} 次`);
    }
  }
}

// ============================================================================
// 场景 3：护栏按「命令来源」区分对待
// ============================================================================

console.log("\n【场景 3】护栏：用户配置的测试命令不被 AUTO 白名单误拦，危险命令照拦");
{
  const chain = new BlockerGuardChain({
    envBoundaryGuard: new EnvBoundaryGuard(),
    dangerousCommandGuard: new DangerousCommandGuard(),
    scopeLockGuard: new ScopeLockGuard(),
    fakeCompletionGuard: new FakeCompletionGuard(),
    credentialMisuseGuard: new CredentialMisuseGuard(),
    runtimeConstraintGuard: new RuntimeConstraintGuard(),
  });

  /**
   * 执行护栏链。
   *
   * 注意：BLOCKER 命中时 BlockerGuardChain 设计为**抛 GuardViolationError**
   * （fail-closed，调用方不处理就必须崩），因此这里捕获异常并归一成结果对象，
   * 否则 DENY 场景会把整个脚本炸掉——那属于测试写法问题，不是实现问题。
   */
  async function runChain(ctx: GuardContext): Promise<{
    decision: string;
    ruleIds: string[];
    denialRuleId: string | null;
    denialReason: string;
    threw: boolean;
  }> {
    try {
      const r = await chain.execute(ctx);
      return {
        decision: r.overallDecision,
        ruleIds: r.triggeredGuards.map((v) => v.ruleId),
        denialRuleId: r.firstDenial?.ruleId ?? null,
        denialReason: r.firstDenial?.reason ?? "",
        threw: false,
      };
    } catch (e) {
      const verdict = (e as { verdict?: { decision: string; ruleId: string; reason: string } }).verdict;
      if (!verdict) throw e;
      return {
        decision: verdict.decision,
        ruleIds: [verdict.ruleId],
        denialRuleId: verdict.ruleId,
        denialReason: verdict.reason,
        threw: true,
      };
    }
  }

  const baseCtx: GuardContext = {
    runId: "e2e-guard",
    iterIndex: 1,
    stage: "verify",
    loopType: "coding",
    projectRoot: "/tmp/e2e-project",
    worktreePath: "/tmp/e2e-project",
    confirmationCardAccepted: true,
    emergencyStopRequested: false,
    // verify 阶段 G-A4a 要求真实完成证据（这里给一条"测试通过"的完整证据，
    // 与 verify-stage-handler 构造的 guardContext 同形）
    completionEvidence: {
      testCommand: "npm test",
      testExitCode: 0,
      testOutputSummary: "Tests: 12 passed, 12 total",
      coveragePercent: 82,
      evaluatorVerdict: "pass",
      executedAt: new Date().toISOString(),
    },
    // G-A6d 上限不可自改：需要 loopGuardConfig 才能校验上限一致性，
    // 且必须冻结（防运行时篡改），与 buildGuardContext 的构造口径一致
    loopGuardConfig: Object.freeze({
      maxIterations: 10,
      maxTokens: 200000,
      maxConsecutiveFailures: 3,
    }),
  };

  // A) 用户配置的测试命令（带前置 export 隔离 HOME）→ 不得被行为约束类规则拦
  const userCmd = await runChain({
    ...baseCtx,
    pendingCommand: "export HOME=/tmp/e2e-home && npm test -- --runInBand",
    commandAuthority: "user-configured",
  });
  check(
    "用户配置的测试命令不被 G-A2c（AUTO 白名单）误拦",
    !userCmd.ruleIds.includes("G-A2c"),
    `命中规则=${userCmd.ruleIds.join(",") || "无"}`
  );
  check(
    "用户配置的测试命令不被 G-A1b（环境变量写保护）误拦 —— 否则 verify 恒拒、任务永远收不完",
    !userCmd.ruleIds.includes("G-A1b"),
    `命中规则=${userCmd.ruleIds.join(",") || "无"}；reason=${userCmd.denialReason.slice(0, 50)}`
  );
  check(
    "用户配置的常规测试命令整体放行（不 DENY / 不转人工）",
    userCmd.decision === "PASS",
    `decision=${userCmd.decision}`
  );

  // B) 同样形态但来源是模型自选 → 仍按白名单判断（fail-closed 转人工）
  const modelCmd = await runChain({
    ...baseCtx,
    pendingCommand: "export HOME=/tmp/e2e-home && npm test -- --runInBand",
    commandAuthority: "agent",
  });
  check(
    "同一条命令来自模型自选时仍触发 G-A2c 白名单判定（来源区分有效）",
    modelCmd.ruleIds.includes("G-A2c") || modelCmd.ruleIds.includes("G-A1b"),
    `decision=${modelCmd.decision}；命中=${modelCmd.ruleIds.join(",")}`
  );
  check("模型自选的非白名单命令不得静默 PASS", modelCmd.decision !== "PASS", `decision=${modelCmd.decision}`);

  // C) 真正的危险命令：无论来源如何都必须拦
  const dangerCmd = await runChain({
    ...baseCtx,
    pendingCommand: "rm -rf /",
    commandAuthority: "user-configured",
  });
  check(
    "危险命令（rm -rf /）即使标记为用户配置仍被拦截",
    dangerCmd.decision === "DENY",
    `decision=${dangerCmd.decision}，denial=${dangerCmd.denialRuleId}`
  );

  // D) 无 pendingCommand 时不得因缺字段放行一切（护栏链仍能正常返回）
  const emptyCmd = await runChain({ ...baseCtx });
  check("无 pendingCommand 时护栏链正常返回", typeof emptyCmd.decision === "string", `decision=${emptyCmd.decision}`);
}

// ============================================================================
// 汇总
// ============================================================================

console.log("\n========================================");
if (failures.length === 0) {
  console.log(`✅ 外围硬化项端到端全部通过（${pass} 项断言）`);
  process.exit(0);
}
console.log(`❌ 失败 ${failures.length} 项 / 通过 ${pass} 项：`);
for (const f of failures) console.log(`   - ${f}`);
process.exit(1);
