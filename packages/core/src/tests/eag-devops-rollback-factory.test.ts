/**
 * EAG-P4 批次 14 Phase 1 单元测试：createRollbackManager 工厂函数（TASK-14-1-3）
 *
 * 测试范围（对齐 EAG-P4-BATCH14-TEST-CASES.md TC-RBM-009/010/011）：
 * - TC-RBM-009: k8s-manifest / helm-chart / terraform 三种 iacType 正确路由
 *   - TC-RBM-009a: k8s-manifest → K8sRollbackManager 实例
 *   - TC-RBM-009b: helm-chart → HelmRollbackManager 实例
 *   - TC-RBM-009c: terraform → K8sRollbackManager 兜底实例
 * - TC-RBM-010: 未识别 iacType 抛 UnsupportedRollbackManagerTypeError
 * - TC-RBM-011: terraform 兜底 + WARNING 日志断言
 *   - TC-RBM-011a: terraform 兜底时打印 WARNING 日志（含"Terraform IaC 使用 K8sRollbackManager 兜底"）
 *   - TC-RBM-011b: 工厂返回的实例不可变（Object.isFrozen）
 *   - TC-RBM-011c: RollbackManagerFactoryOptions 含必填 projectRoot + 可选 rollbackTimeoutMs（默认 30000）
 *   - TC-RBM-011d: Phase 3 真实实现验证（kubectl/helm 不可用时抛 RollbackExecutionError，非 Phase 1 占位错误）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接调用真实 createRollbackManager 工厂函数
 * - 使用真实 console.warn 捕获 WARNING 日志（覆盖临时拦截 stdout/stderr，非 mock）
 * - 中文详细注释
 *
 * @module core/tests/eag-devops-rollback-factory
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRollbackManager,
  HelmRollbackManager,
  K8sRollbackManager,
  UnsupportedRollbackManagerTypeError,
} from "../eag/devops/rollback-manager";
import { RollbackExecutionError } from "../eag/devops/types";
import type { RollbackManager, RollbackSnapshot } from "../eag/devops/types";
import type { IaCType } from "../eag/devops/types";

// ============================================================================
// 测试辅助：构造真实 RollbackManagerFactoryOptions 对象（避免重复，所有测试复用）
// ============================================================================

/**
 * 构造测试用 RollbackManagerFactoryOptions（真实对象，非 mock）
 *
 * @param overrides 覆盖字段（可选）
 * @returns RollbackManagerFactoryOptions 含 projectRoot + 可选 rollbackTimeoutMs
 */
function createFactoryOptions(overrides?: { projectRoot?: string; rollbackTimeoutMs?: number }): {
  projectRoot: string;
  rollbackTimeoutMs?: number;
} {
  return {
    projectRoot: overrides?.projectRoot ?? "/path/to/project",
    rollbackTimeoutMs: overrides?.rollbackTimeoutMs,
  };
}

// ============================================================================
// TC-RBM-009: k8s-manifest / helm-chart / terraform 三种 iacType 正确路由
// ============================================================================

test("TC-RBM-009a. k8s-manifest 类型路由到 K8sRollbackManager 实例", () => {
  // 调用工厂函数（K-3 决策：k8s-manifest → K8sRollbackManager）
  const manager = createRollbackManager("k8s-manifest", createFactoryOptions());

  // 验证返回的是 K8sRollbackManager 实例
  assert.ok(manager instanceof K8sRollbackManager, `应为 K8sRollbackManager 实例，实际：${manager.constructor.name}`);
  // 验证实现了 RollbackManager 接口（createSnapshot / rollback 方法存在）
  assert.equal(typeof manager.createSnapshot, "function");
  assert.equal(typeof manager.rollback, "function");
  // 验证 projectRoot 配置正确传入
  assert.equal((manager as K8sRollbackManager).projectRoot, "/path/to/project");
  // 验证 rollbackTimeoutMs 默认值 30000ms
  assert.equal((manager as K8sRollbackManager).rollbackTimeoutMs, 30000);
});

test("TC-RBM-009b. helm-chart 类型路由到 HelmRollbackManager 实例", () => {
  // 调用工厂函数（K-3 决策：helm-chart → HelmRollbackManager）
  const manager = createRollbackManager("helm-chart", createFactoryOptions());

  // 验证返回的是 HelmRollbackManager 实例
  assert.ok(manager instanceof HelmRollbackManager, `应为 HelmRollbackManager 实例，实际：${manager.constructor.name}`);
  // 验证实现了 RollbackManager 接口（createSnapshot / rollback 方法存在）
  assert.equal(typeof manager.createSnapshot, "function");
  assert.equal(typeof manager.rollback, "function");
  // 验证 projectRoot 配置正确传入
  assert.equal((manager as HelmRollbackManager).projectRoot, "/path/to/project");
  // 验证 rollbackTimeoutMs 默认值 30000ms
  assert.equal((manager as HelmRollbackManager).rollbackTimeoutMs, 30000);
});

test("TC-RBM-009c. terraform 类型路由到 K8sRollbackManager 兜底实例", () => {
  // 调用工厂函数（K-3 决策：terraform → K8sRollbackManager 兜底 + WARNING 日志）
  // 注意：terraform 路径会调用 console.warn，此处先临时拦截 console.warn 避免污染测试输出
  const originalWarn = console.warn;
  const warnCalls: string[] = [];
  console.warn = (msg: string) => {
    warnCalls.push(msg);
  };
  try {
    const manager = createRollbackManager("terraform", createFactoryOptions());

    // 验证返回的是 K8sRollbackManager 实例（兜底）
    assert.ok(
      manager instanceof K8sRollbackManager,
      `terraform 应兜底为 K8sRollbackManager 实例，实际：${manager.constructor.name}`
    );
    // 验证实现了 RollbackManager 接口
    assert.equal(typeof manager.createSnapshot, "function");
    assert.equal(typeof manager.rollback, "function");
    // 验证 WARNING 日志被调用（TC-RBM-011 会更详细断言日志内容）
    assert.ok(warnCalls.length >= 1, `应打印至少 1 条 WARNING 日志，实际：${warnCalls.length} 条`);
  } finally {
    // 恢复 console.warn
    console.warn = originalWarn;
  }
});

test("TC-RBM-009d. 三种 iacType 路由结果类型正确（K8s / Helm / K8s 兜底）", () => {
  // 验证 K-3 决策装配规则的完整性
  const cases: ReadonlyArray<{
    iacType: IaCType;
    expectedClass: typeof K8sRollbackManager | typeof HelmRollbackManager;
  }> = [
    { iacType: "k8s-manifest", expectedClass: K8sRollbackManager },
    { iacType: "helm-chart", expectedClass: HelmRollbackManager },
    { iacType: "terraform", expectedClass: K8sRollbackManager }, // 兜底
  ];

  // 临时拦截 console.warn 避免 terraform 路径的日志污染
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    for (const { iacType, expectedClass } of cases) {
      const manager = createRollbackManager(iacType, createFactoryOptions());
      assert.ok(
        manager instanceof expectedClass,
        `iacType="${iacType}" 应路由到 ${expectedClass.name}，实际：${manager.constructor.name}`
      );
    }
  } finally {
    console.warn = originalWarn;
  }
});

// ============================================================================
// TC-RBM-010: 未识别 iacType 抛 UnsupportedRollbackManagerTypeError
// ============================================================================

test("TC-RBM-010a. 未识别 iacType 抛 UnsupportedRollbackManagerTypeError（防御性检查）", () => {
  // 通过类型断言绕过编译期检查，模拟运行时传入未识别的 iacType
  const invalidIacType = "docker-compose" as unknown as IaCType;

  // 验证抛出 UnsupportedRollbackManagerTypeError
  assert.throws(
    () => {
      createRollbackManager(invalidIacType, createFactoryOptions());
    },
    (err: unknown) => {
      // 验证错误类型
      assert.ok(
        err instanceof UnsupportedRollbackManagerTypeError,
        `应抛出 UnsupportedRollbackManagerTypeError，实际：${(err as Error).constructor.name}`
      );
      // 验证错误消息包含未识别的 iacType 值
      const errorMsg = (err as Error).message;
      assert.ok(
        errorMsg.includes("docker-compose"),
        `错误消息应包含未识别的 iacType 值 "docker-compose"，实际：${errorMsg}`
      );
      // 验证错误消息列出支持的类型
      assert.ok(errorMsg.includes("terraform"), `错误消息应列出支持的类型 "terraform"，实际：${errorMsg}`);
      assert.ok(errorMsg.includes("k8s-manifest"), `错误消息应列出支持的类型 "k8s-manifest"，实际：${errorMsg}`);
      assert.ok(errorMsg.includes("helm-chart"), `错误消息应列出支持的类型 "helm-chart"，实际：${errorMsg}`);
      // 验证 iacType 属性可访问
      assert.equal(
        (err as UnsupportedRollbackManagerTypeError).iacType,
        "docker-compose",
        `错误对象的 iacType 属性应为 "docker-compose"`
      );
      return true;
    }
  );
});

test("TC-RBM-010b. UnsupportedRollbackManagerTypeError 实例不可变（Object.freeze）", () => {
  // 验证错误实例被 Object.freeze 冻结
  const invalidIacType = "invalid-type" as unknown as IaCType;
  try {
    createRollbackManager(invalidIacType, createFactoryOptions());
    assert.fail("应抛出 UnsupportedRollbackManagerTypeError");
  } catch (err) {
    assert.ok(err instanceof UnsupportedRollbackManagerTypeError);
    assert.equal(Object.isFrozen(err), true, "错误实例应被 Object.freeze 冻结");
    // 验证 name 属性正确
    assert.equal((err as Error).name, "UnsupportedRollbackManagerTypeError");
  }
});

// ============================================================================
// TC-RBM-011: terraform 兜底 + WARNING 日志断言
// ============================================================================

test("TC-RBM-011a. terraform 兜底时打印 WARNING 日志（含 'Terraform IaC 使用 K8sRollbackManager 兜底'）", () => {
  // 临时拦截 console.warn 捕获 WARNING 日志（真实拦截，非 mock）
  const originalWarn = console.warn;
  const warnCalls: string[] = [];
  console.warn = (msg: string) => {
    warnCalls.push(msg);
  };
  try {
    const manager = createRollbackManager("terraform", createFactoryOptions({ projectRoot: "/test/project" }));

    // 验证返回的是 K8sRollbackManager 兜底实例
    assert.ok(manager instanceof K8sRollbackManager);

    // 验证 WARNING 日志被调用 1 次
    assert.equal(warnCalls.length, 1, `应打印 1 条 WARNING 日志，实际：${warnCalls.length} 条`);

    // 验证日志内容包含 "Terraform IaC 使用 K8sRollbackManager 兜底"
    const warnMsg = warnCalls[0];
    assert.ok(typeof warnMsg === "string", `WARNING 日志应为字符串，实际类型：${typeof warnMsg}`);
    assert.ok(
      warnMsg.includes("Terraform IaC 使用 K8sRollbackManager 兜底"),
      `WARNING 日志应包含 "Terraform IaC 使用 K8sRollbackManager 兜底"，实际：${warnMsg}`
    );
    // 验证日志包含 projectRoot（便于诊断）
    assert.ok(warnMsg.includes("/test/project"), `WARNING 日志应包含 projectRoot "/test/project"，实际：${warnMsg}`);
    // 验证日志提及"仅支持 K8s 资源回滚"（语义完整性）
    assert.ok(warnMsg.includes("仅支持 K8s 资源回滚"), `WARNING 日志应提及 "仅支持 K8s 资源回滚"，实际：${warnMsg}`);
  } finally {
    // 恢复 console.warn
    console.warn = originalWarn;
  }
});

test("TC-RBM-011b. 工厂返回的 RollbackManager 实例不可变（Object.isFrozen）", () => {
  // 临时拦截 console.warn 避免 terraform 路径的日志污染
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    // 验证 k8s-manifest 实例不可变
    const k8sManager = createRollbackManager("k8s-manifest", createFactoryOptions());
    assert.equal(Object.isFrozen(k8sManager), true, "K8sRollbackManager 实例应被 Object.freeze 冻结");

    // 验证 helm-chart 实例不可变
    const helmManager = createRollbackManager("helm-chart", createFactoryOptions());
    assert.equal(Object.isFrozen(helmManager), true, "HelmRollbackManager 实例应被 Object.freeze 冻结");

    // 验证 terraform 兜底实例不可变
    const terraformManager = createRollbackManager("terraform", createFactoryOptions());
    assert.equal(
      Object.isFrozen(terraformManager),
      true,
      "terraform 兜底 K8sRollbackManager 实例应被 Object.freeze 冻结"
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("TC-RBM-011c. RollbackManagerFactoryOptions 含必填 projectRoot + 可选 rollbackTimeoutMs（默认 30000）", () => {
  // 临时拦截 console.warn 避免 terraform 路径的日志污染
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    // 验证 1：默认 rollbackTimeoutMs = 30000（不提供该字段）
    const managerDefault = createRollbackManager(
      "k8s-manifest",
      createFactoryOptions({ projectRoot: "/project/default" })
    ) as K8sRollbackManager;
    assert.equal(managerDefault.rollbackTimeoutMs, 30000, "默认 rollbackTimeoutMs 应为 30000");
    assert.equal(managerDefault.projectRoot, "/project/default");

    // 验证 2：自定义 rollbackTimeoutMs = 60000
    const managerCustom = createRollbackManager(
      "k8s-manifest",
      createFactoryOptions({ projectRoot: "/project/custom", rollbackTimeoutMs: 60000 })
    ) as K8sRollbackManager;
    assert.equal(managerCustom.rollbackTimeoutMs, 60000, "自定义 rollbackTimeoutMs 应为 60000");
    assert.equal(managerCustom.projectRoot, "/project/custom");

    // 验证 3：helm-chart 类型同样支持默认/自定义 rollbackTimeoutMs
    const helmManagerDefault = createRollbackManager(
      "helm-chart",
      createFactoryOptions({ projectRoot: "/project/helm" })
    ) as HelmRollbackManager;
    assert.equal(helmManagerDefault.rollbackTimeoutMs, 30000, "HelmRollbackManager 默认 rollbackTimeoutMs 应为 30000");

    const helmManagerCustom = createRollbackManager(
      "helm-chart",
      createFactoryOptions({ projectRoot: "/project/helm", rollbackTimeoutMs: 45000 })
    ) as HelmRollbackManager;
    assert.equal(helmManagerCustom.rollbackTimeoutMs, 45000, "HelmRollbackManager 自定义 rollbackTimeoutMs 应为 45000");

    // 验证 4：terraform 兜底类型同样支持默认/自定义 rollbackTimeoutMs
    const terraformManager = createRollbackManager(
      "terraform",
      createFactoryOptions({ projectRoot: "/project/tf", rollbackTimeoutMs: 90000 })
    ) as K8sRollbackManager;
    assert.equal(terraformManager.rollbackTimeoutMs, 90000, "terraform 兜底 rollbackTimeoutMs 应为 90000");
    assert.equal(terraformManager.projectRoot, "/project/tf");
  } finally {
    console.warn = originalWarn;
  }
});

test("TC-RBM-011d. Phase 3 真实实现验证（kubectl/helm 不可用时抛 RollbackExecutionError，非 Phase 1 占位错误）", async () => {
  // 临时拦截 console.warn 避免 terraform 路径的日志污染
  const originalWarn = console.warn;
  console.warn = () => {};
  // 临时修改 PATH 让 kubectl/helm 不可用（真实模拟 CLI 不存在场景，非 mock）
  // 对齐 eag-deploy-strategy-rolling.test.ts TC-RL-004 的 PATH 修改方式
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    // 验证工厂返回的实例可赋值给 RollbackManager 接口（接口约束校验）
    const k8sManager: RollbackManager = createRollbackManager("k8s-manifest", createFactoryOptions());
    const helmManager: RollbackManager = createRollbackManager("helm-chart", createFactoryOptions());
    const terraformManager: RollbackManager = createRollbackManager("terraform", createFactoryOptions());

    // 验证 createSnapshot / rollback 方法存在（接口协议校验）
    for (const manager of [k8sManager, helmManager, terraformManager]) {
      assert.equal(typeof manager.createSnapshot, "function", "createSnapshot 应为函数");
      assert.equal(typeof manager.rollback, "function", "rollback 应为函数");
    }

    // 验证 Phase 3 真实实现：kubectl/helm 不可用时抛 RollbackExecutionError（错误外抛模式）
    // 区别于 Phase 1 占位实现抛 "not implemented in Phase 1"，Phase 3 真实调用 CLI
    // 失败时通过 RollbackExecutionError 暴露 stderr / command / exitCode
    const snapshotContext = {
      projectName: "test-app",
      namespace: "default",
    };

    // 构造有效的 RollbackSnapshot 用于 rollback 测试（含 projectName / namespace / version）
    const testSnapshot: RollbackSnapshot = {
      snapshotId: "test-snap",
      createdAt: "2026-07-21T10:00:00.000Z",
      version: "1",
      resources: Object.freeze(["deployment/test-app"]) as ReadonlyArray<string>,
      projectName: "test-app",
      namespace: "default",
      rollbackStrategy: "rolling",
    };

    // 验证 K8sRollbackManager.createSnapshot 抛 RollbackExecutionError（kubectl 不可用 → ENOENT）
    await assert.rejects(k8sManager.createSnapshot(snapshotContext), (err: unknown) => {
      assert.ok(
        err instanceof RollbackExecutionError,
        `K8sRollbackManager.createSnapshot 应抛 RollbackExecutionError，实际：${(err as Error).constructor.name}`
      );
      // 验证错误消息不含 "not implemented in Phase 1"（Phase 3 已替换为真实实现）
      const msg = (err as Error).message;
      assert.ok(
        !msg.includes("not implemented in Phase 1"),
        `K8sRollbackManager.createSnapshot 不应抛 Phase 1 占位错误，实际：${msg}`
      );
      // 验证 RollbackExecutionError 字段（command / stderr / exitCode）
      assert.ok(
        (err as RollbackExecutionError).command.includes("kubectl"),
        `command 应包含 "kubectl"，实际：${(err as RollbackExecutionError).command}`
      );
      return true;
    });

    // 验证 K8sRollbackManager.rollback 抛 RollbackExecutionError（kubectl 不可用 → ENOENT）
    await assert.rejects(k8sManager.rollback(testSnapshot), (err: unknown) => {
      assert.ok(
        err instanceof RollbackExecutionError,
        `K8sRollbackManager.rollback 应抛 RollbackExecutionError，实际：${(err as Error).constructor.name}`
      );
      const msg = (err as Error).message;
      assert.ok(
        !msg.includes("not implemented in Phase 1"),
        `K8sRollbackManager.rollback 不应抛 Phase 1 占位错误，实际：${msg}`
      );
      return true;
    });

    // 验证 HelmRollbackManager.createSnapshot 抛 RollbackExecutionError（helm 不可用 → ENOENT）
    await assert.rejects(helmManager.createSnapshot(snapshotContext), (err: unknown) => {
      assert.ok(
        err instanceof RollbackExecutionError,
        `HelmRollbackManager.createSnapshot 应抛 RollbackExecutionError，实际：${(err as Error).constructor.name}`
      );
      const msg = (err as Error).message;
      assert.ok(
        !msg.includes("not implemented in Phase 1"),
        `HelmRollbackManager.createSnapshot 不应抛 Phase 1 占位错误，实际：${msg}`
      );
      assert.ok(
        (err as RollbackExecutionError).command.includes("helm"),
        `command 应包含 "helm"，实际：${(err as RollbackExecutionError).command}`
      );
      return true;
    });

    // 验证 HelmRollbackManager.rollback 抛 RollbackExecutionError（helm 不可用 → ENOENT）
    await assert.rejects(helmManager.rollback(testSnapshot), (err: unknown) => {
      assert.ok(
        err instanceof RollbackExecutionError,
        `HelmRollbackManager.rollback 应抛 RollbackExecutionError，实际：${(err as Error).constructor.name}`
      );
      const msg = (err as Error).message;
      assert.ok(
        !msg.includes("not implemented in Phase 1"),
        `HelmRollbackManager.rollback 不应抛 Phase 1 占位错误，实际：${msg}`
      );
      return true;
    });

    // 验证 terraform 兜底 K8sRollbackManager.createSnapshot 抛 RollbackExecutionError（kubectl 不可用）
    await assert.rejects(terraformManager.createSnapshot(snapshotContext), (err: unknown) => {
      assert.ok(
        err instanceof RollbackExecutionError,
        `terraform 兜底 K8sRollbackManager.createSnapshot 应抛 RollbackExecutionError，实际：${(err as Error).constructor.name}`
      );
      return true;
    });

    // 验证 terraform 兜底 K8sRollbackManager.rollback 抛 RollbackExecutionError（kubectl 不可用）
    await assert.rejects(terraformManager.rollback(testSnapshot), (err: unknown) => {
      assert.ok(
        err instanceof RollbackExecutionError,
        `terraform 兜底 K8sRollbackManager.rollback 应抛 RollbackExecutionError，实际：${(err as Error).constructor.name}`
      );
      return true;
    });
  } finally {
    // 恢复 PATH 和 console.warn
    process.env.PATH = originalPath;
    console.warn = originalWarn;
  }
});
