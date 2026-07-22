/**
 * EAG-P4 批次 14 Phase 3 单元测试：K8sRollbackManager + HelmRollbackManager + RollbackPlanWriter + RollbackExecutionError（TASK-14-3-5）
 *
 * 测试范围（对齐任务清单 TASK-14-3-5 验收标准）：
 * - TC-RBM-3-1. K8sRollbackManager.createSnapshot 成功路径
 *   - TC-RBM-3-1a. 调用 fake kubectl 返回真实 YAML + history，snapshot.version 为真实 revision
 *   - TC-RBM-3-1b. snapshot.resources 含 deployment/<name>
 *   - TC-RBM-3-1c. snapshot.rollbackPlanFilePath 非空（回滚预案文件已生成）
 *   - TC-RBM-3-1d. snapshot.snapshotDataPath 非空（快照数据文件已保存）
 *   - TC-RBM-3-1e. snapshot 被 Object.freeze 冻结
 * - TC-RBM-3-2. K8sRollbackManager.rollback 三种策略
 *   - TC-RBM-3-2a. rolling 策略调用 kubectl rollout undo，返回 success=true
 *   - TC-RBM-3-2b. blue-green 策略调用 kubectl patch service，返回 success=true
 *   - TC-RBM-3-2c. canary 策略调用 kubectl scale deployment，返回 success=true
 * - TC-RBM-3-3. K8sRollbackManager.verifyRollback 轮询验证
 *   - TC-RBM-3-3a. availableReplicas >= expectedReplicas 时返回 success=true
 *   - TC-RBM-3-3b. availableReplicas < expectedReplicas 时轮询直到超时返回 success=false
 * - TC-RBM-3-4. K8sRollbackManager.createSnapshot 失败抛 RollbackExecutionError
 *   - TC-RBM-3-4a. fake kubectl 返回非零退出码时抛 RollbackExecutionError
 *   - TC-RBM-3-4b. RollbackExecutionError 含 command / stderr / exitCode 字段
 *   - TC-RBM-3-4c. RollbackExecutionError 被 Object.freeze 冻结
 * - TC-RBM-3-5. HelmRollbackManager.createSnapshot 成功路径
 *   - TC-RBM-3-5a. 调用 fake helm history 返回真实 YAML，snapshot.version 为最新 revision
 *   - TC-RBM-3-5b. snapshot.resources 含 release/<name>
 * - TC-RBM-3-6. HelmRollbackManager.rollback 成功路径
 *   - TC-RBM-3-6a. 调用 fake helm rollback，返回 success=true
 * - TC-RBM-3-7. HelmRollbackManager.verifyRollback 验证
 *   - TC-RBM-3-7a. 当前 revision 匹配目标 revision 时返回 success=true
 *   - TC-RBM-3-7b. 当前 revision 不匹配时返回 success=false
 * - TC-RBM-3-8. RollbackPlanWriter 完整流程
 *   - TC-RBM-3-8a. writePlan 序列化 YAML 文件成功
 *   - TC-RBM-3-8b. readPlan 反序列化 RollbackPlan 对象成功（字段值一致）
 *   - TC-RBM-3-8c. validatePlanFile 校验通过（exists=true, valid=true, failures=[]）
 *   - TC-RBM-3-8d. readPlan 返回的对象被 Object.freeze 冻结
 *   - TC-RBM-3-8e. validatePlanFile 文件不存在时返回 exists=false
 *   - TC-RBM-3-8f. writePlan steps 为空时抛 Error
 *   - TC-RBM-3-8g. writePlan 必填字段为空时抛 Error
 * - TC-RBM-3-9. RollbackExecutionError 错误传递
 *   - TC-RBM-3-9a. RollbackExecutionError 是 Error 的子类
 *   - TC-RBM-3-9b. RollbackExecutionError.name === "RollbackExecutionError"
 *   - TC-RBM-3-9c. RollbackExecutionError.message 含命令名称、退出码与 stderr
 *   - TC-RBM-3-9d. RollbackExecutionError 实例被 Object.freeze 冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用 fake-binary 技巧（临时目录创建可执行 shell 脚本作为 fake kubectl/helm）
 * - 真实读写文件系统（fs.mkdtempSync + fs.writeFileSync + fs.rmSync）
 * - 中文详细注释
 * - Object.isFrozen 断言不可变优先
 *
 * fake-binary 技巧说明（对齐 NFR-3 测试不使用 mock）：
 * - 在临时目录创建可执行 shell 脚本作为 fake kubectl/helm
 * - 临时修改 process.env.PATH 让 execFile 找到 fake binary（真实调用 execFile，非 mock）
 * - fake binary 是真实的可执行文件，根据参数输出预先定义好的内容
 * - 测试完成后恢复 PATH 并清理临时目录
 *
 * 设计依据：
 * - EAG-P4 批次 14 任务清单 TASK-14-3-5 验收标准
 * - types.ts 中 RollbackExecutionError / RollbackPlan / RollbackPlanStep 类型定义
 * - rollback-manager.ts 中 K8sRollbackManager / HelmRollbackManager 类实现
 * - rollback-plan-writer.ts 中 RollbackPlanWriter 类实现
 *
 * @module core/tests/eag-devops-rollback-managers
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { K8sRollbackManager, HelmRollbackManager } from "../eag/devops/rollback-manager";
import { RollbackPlanWriter } from "../eag/devops/rollback-plan-writer";
import { RollbackExecutionError } from "../eag/devops/types";
import type {
  RollbackSnapshot,
  RollbackSnapshotContext,
  RollbackPlan,
  RollbackPlanStep,
  RollbackStrategyType,
  RollbackVerificationResult,
} from "../eag/devops/types";

// ============================================================================
// fake-binary 工具函数：创建临时目录与 fake CLI 脚本
// ============================================================================

/**
 * 创建 fake binary 临时目录环境
 *
 * 执行流程：
 * 1. 在 os.tmpdir() 下创建临时目录（fs.mkdtempSync，前缀 "eag-rbm-fake-"）
 * 2. 在临时目录下创建 fake kubectl / helm 可执行脚本
 * 3. 返回 { tmpDir, originalPath }，调用方需在测试完成后调用 restoreFakeBinEnv 恢复
 *
 * @param options 选项（含 kubectlScript / helmScript 内容）
 * @returns 含临时目录路径与原始 PATH 的对象
 */
function setupFakeBinEnv(options: { kubectlScript?: string; helmScript?: string }): {
  tmpDir: string;
  originalPath: string;
} {
  // 创建临时目录
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-fake-"));

  // 创建 fake kubectl 脚本（如果指定）
  if (options.kubectlScript) {
    const kubectlPath = path.join(tmpDir, "kubectl");
    fs.writeFileSync(kubectlPath, options.kubectlScript, {
      encoding: "utf8",
      mode: 0o755, // 可执行权限
    });
  }

  // 创建 fake helm 脚本（如果指定）
  if (options.helmScript) {
    const helmPath = path.join(tmpDir, "helm");
    fs.writeFileSync(helmPath, options.helmScript, {
      encoding: "utf8",
      mode: 0o755,
    });
  }

  // 临时修改 PATH 让 execFile 找到 fake binary（fake binary 目录优先）
  const originalPath = process.env.PATH ?? "";
  // 将临时目录放在 PATH 最前面，确保优先于系统 kubectl/helm
  process.env.PATH = `${tmpDir}:${originalPath}`;

  return { tmpDir, originalPath };
}

/**
 * 恢复 fake-binary 环境
 *
 * 执行流程：
 * 1. 恢复 process.env.PATH 为原始值
 * 2. 递归删除临时目录（fs.rmSync recursive: true）
 *
 * @param tmpDir 临时目录路径
 * @param originalPath 原始 PATH 值
 */
function restoreFakeBinEnv(tmpDir: string, originalPath: string): void {
  // 恢复 PATH
  process.env.PATH = originalPath;
  // 清理临时目录
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 清理失败不抛异常（避免测试失败时掩盖原始错误）
  }
}

// ============================================================================
// fake kubectl 脚本生成器
// ============================================================================

/**
 * 生成 fake kubectl 脚本（成功路径，根据子命令返回不同输出）
 *
 * 支持的子命令：
 * - get deployment <name> -n <ns> -o yaml：返回 Deployment YAML
 * - get deployment <name> -n <ns> -o json：返回 Deployment JSON（含 status.availableReplicas）
 * - rollout history deployment/<name> -n <ns>：返回 revision 历史
 * - rollout undo deployment/<name> -n <ns> --to-revision=N：返回成功
 * - patch service <name> -n <ns> --type=json -p=...：返回成功
 * - scale deployment <name>-canary -n <ns> --replicas=0：返回成功
 *
 * @param options 选项（含 availableReplicas 等可配置参数）
 * @returns fake kubectl shell 脚本内容
 */
function createFakeKubectlScript(options?: {
  availableReplicas?: number;
  expectedReplicas?: number;
  exitCode?: number; // 非 0 时模拟失败
  stderr?: string; // 失败时的错误输出
}): string {
  const availableReplicas = options?.availableReplicas ?? 3;
  const expectedReplicas = options?.expectedReplicas ?? 3;
  const exitCode = options?.exitCode ?? 0;
  const stderr = options?.stderr ?? "";

  // 如果指定 exitCode 非 0，所有命令都失败
  if (exitCode !== 0) {
    return `#!/bin/bash
# fake kubectl 失败模式
echo "${stderr}" >&2
exit ${exitCode}
`;
  }

  // 成功模式：根据子命令返回不同输出
  return `#!/bin/bash
# fake kubectl 成功模式
# 根据 $1 $2 ... 判断子命令并返回相应输出

# 解析参数
subcmd="$1"
shift

case "$subcmd" in
  get)
    # kubectl get deployment <name> -n <ns> -o <format>
    resource="$1"
    name="$2"
    shift 2
    # 解析剩余参数（-n <ns> -o <format>）
    ns="default"
    format=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -n) ns="$2"; shift 2 ;;
        -o) format="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [[ "$resource" == "deployment" ]]; then
      if [[ "$format" == "yaml" ]]; then
        # 返回 Deployment YAML（含 metadata.labels）
        cat <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: \${name}
  namespace: \${ns}
  labels:
    app: \${name}
    version: v1.0.0
spec:
  replicas: ${expectedReplicas}
  selector:
    matchLabels:
      app: \${name}
  template:
    metadata:
      labels:
        app: \${name}
status:
  availableReplicas: ${availableReplicas}
  readyReplicas: ${availableReplicas}
EOF
        exit 0
      elif [[ "$format" == "json" ]]; then
        # 返回 Deployment JSON
        cat <<EOF
{
  "apiVersion": "apps/v1",
  "kind": "Deployment",
  "metadata": {
    "name": "\${name}",
    "namespace": "\${ns}",
    "labels": {
      "app": "\${name}",
      "version": "v1.0.0"
    }
  },
  "spec": {
    "replicas": ${expectedReplicas}
  },
  "status": {
    "availableReplicas": ${availableReplicas},
    "readyReplicas": ${availableReplicas}
  }
}
EOF
        exit 0
      fi
    fi
    exit 1
    ;;
  rollout)
    # kubectl rollout <history|undo> deployment/<name> -n <ns> [--to-revision=N]
    action="$1"
    shift
    target="$1"  # deployment/<name>
    shift
    # 解析剩余参数
    ns="default"
    to_revision=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -n) ns="$2"; shift 2 ;;
        --to-revision=*) to_revision="\${1#--to-revision=}"; shift ;;
        *) shift ;;
      esac
    done
    if [[ "$action" == "history" ]]; then
      # 返回 revision 历史（最新 revision 为 5）
      echo "deployment.apps/\${target#deployment/}"
      echo "REVISION  CHANGE-CAUSE"
      echo "1         <none>"
      echo "2         <none>"
      echo "3         <none>"
      echo "4         <none>"
      echo "5         kubectl apply --filename=..."
      exit 0
    elif [[ "$action" == "undo" ]]; then
      # rollout undo 成功
      echo "deployment.apps/\${target#deployment/} rolled back"
      exit 0
    fi
    exit 1
    ;;
  patch)
    # kubectl patch service <name> -n <ns> --type=json -p=...
    resource="$1"
    name="$2"
    shift 2
    # 跳过剩余参数
    echo "service/\${name} patched"
    exit 0
    ;;
  scale)
    # kubectl scale deployment <name> -n <ns> --replicas=N
    resource="$1"
    name="$2"
    shift 2
    echo "deployment/\${name} scaled"
    exit 0
    ;;
  *)
    echo "Unknown subcommand: $subcmd" >&2
    exit 1
    ;;
esac
`;
}

// ============================================================================
// fake helm 脚本生成器
// ============================================================================

/**
 * 生成 fake helm 脚本（成功路径，根据子命令返回不同输出）
 *
 * 支持的子命令：
 * - history <release> -n <ns> --output yaml：返回 revision 历史（YAML 格式）
 * - rollback <release> <revision> -n <ns>：返回成功
 *
 * @param options 选项（含 latestRevision 等可配置参数）
 * @returns fake helm shell 脚本内容
 */
function createFakeHelmScript(options?: { latestRevision?: number; exitCode?: number; stderr?: string }): string {
  const latestRevision = options?.latestRevision ?? 5;
  const exitCode = options?.exitCode ?? 0;
  const stderr = options?.stderr ?? "";

  if (exitCode !== 0) {
    return `#!/bin/bash
# fake helm 失败模式
echo "${stderr}" >&2
exit ${exitCode}
`;
  }

  return `#!/bin/bash
# fake helm 成功模式
subcmd="$1"
shift

case "$subcmd" in
  history)
    # helm history <release> -n <ns> --output yaml
    release="$1"
    shift
    # 解析剩余参数
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -n) shift 2 ;;
        --output) shift 2 ;;
        *) shift ;;
      esac
    done
    # 返回 helm history YAML 输出（含多个 revision 记录）
    cat <<EOF
- app_version: "1.0.0"
  chart: \${release}-0.1.0
  description: Install complete
  revision: 1
  status: superseded
  updated: 2026-07-21T10:00:00.000Z
- app_version: "1.1.0"
  chart: \${release}-0.2.0
  description: Upgrade complete
  revision: 2
  status: superseded
  updated: 2026-07-21T11:00:00.000Z
- app_version: "2.0.0"
  chart: \${release}-0.3.0
  description: Upgrade complete
  revision: ${latestRevision}
  status: deployed
  updated: 2026-07-21T12:00:00.000Z
EOF
    exit 0
    ;;
  rollback)
    # helm rollback <release> <revision> -n <ns>
    release="$1"
    revision="$2"
    shift 2
    echo "Rollback was a success! Hooray!"
    exit 0
    ;;
  *)
    echo "Unknown subcommand: $subcmd" >&2
    exit 1
    ;;
esac
`;
}

// ============================================================================
// 测试辅助函数：构造 RollbackSnapshotContext
// ============================================================================

/**
 * 构造测试用 RollbackSnapshotContext
 *
 * @param overrides 覆盖字段
 * @returns 完整的 RollbackSnapshotContext
 */
function createSnapshotContext(overrides?: Partial<RollbackSnapshotContext>): RollbackSnapshotContext {
  return {
    projectName: "test-app",
    namespace: "default",
    runId: "test-run-001",
    rollbackStrategy: overrides?.rollbackStrategy ?? "rolling",
    ...overrides,
  };
}

// ============================================================================
// TC-RBM-3-1. K8sRollbackManager.createSnapshot 成功路径
// ============================================================================

test("TC-RBM-3-1a. K8sRollbackManager.createSnapshot 调用 fake kubectl 返回真实 revision", async () => {
  // 创建独立的临时项目目录（用于快照数据文件与回滚预案文件）
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-project-"));
  const env = setupFakeBinEnv({ kubectlScript: createFakeKubectlScript() });
  try {
    const manager = new K8sRollbackManager({
      rollbackTimeoutMs: 5000,
      projectRoot: projectTmpDir,
    });
    const snapshot = await manager.createSnapshot(createSnapshotContext());

    // 验证 version 是最新 revision 号（fake kubectl 返回 revision 5）
    assert.equal(snapshot.version, "5", `version 应为 "5"，实际：${snapshot.version}`);
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-1b. K8sRollbackManager.createSnapshot 返回 snapshot.resources 含 deployment/<name>", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-project-"));
  const env = setupFakeBinEnv({ kubectlScript: createFakeKubectlScript() });
  try {
    const manager = new K8sRollbackManager({ projectRoot: projectTmpDir });
    const snapshot = await manager.createSnapshot(createSnapshotContext());

    // 验证 resources 包 deployment/test-app
    assert.ok(
      snapshot.resources.includes("deployment/test-app"),
      `resources 应含 "deployment/test-app"，实际：${JSON.stringify(snapshot.resources)}`
    );
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-1c. K8sRollbackManager.createSnapshot 生成回滚预案文件（rollbackPlanFilePath 非空）", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-project-"));
  const env = setupFakeBinEnv({ kubectlScript: createFakeKubectlScript() });
  try {
    const manager = new K8sRollbackManager({ projectRoot: projectTmpDir });
    const snapshot = await manager.createSnapshot(createSnapshotContext());

    // 验证 rollbackPlanFilePath 非空
    assert.ok(snapshot.rollbackPlanFilePath, "rollbackPlanFilePath 应非空（回滚预案文件已生成）");
    // 验证文件实际存在
    assert.ok(fs.existsSync(snapshot.rollbackPlanFilePath!), `回滚预案文件应存在：${snapshot.rollbackPlanFilePath}`);
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-1d. K8sRollbackManager.createSnapshot 保存快照数据文件（snapshotDataPath 非空）", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-project-"));
  const env = setupFakeBinEnv({ kubectlScript: createFakeKubectlScript() });
  try {
    const manager = new K8sRollbackManager({ projectRoot: projectTmpDir });
    const snapshot = await manager.createSnapshot(createSnapshotContext());

    // 验证 snapshotDataPath 非空
    assert.ok(snapshot.snapshotDataPath, "snapshotDataPath 应非空");
    // 验证文件实际存在
    assert.ok(fs.existsSync(snapshot.snapshotDataPath!), `快照数据文件应存在：${snapshot.snapshotDataPath}`);
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-1e. K8sRollbackManager.createSnapshot 返回的 snapshot 被 Object.freeze 冻结", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-project-"));
  const env = setupFakeBinEnv({ kubectlScript: createFakeKubectlScript() });
  try {
    const manager = new K8sRollbackManager({ projectRoot: projectTmpDir });
    const snapshot = await manager.createSnapshot(createSnapshotContext());

    assert.equal(Object.isFrozen(snapshot), true, "snapshot 应被 Object.freeze 冻结");
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-RBM-3-2. K8sRollbackManager.rollback 三种策略
// ============================================================================

test("TC-RBM-3-2a. K8sRollbackManager.rollback rolling 策略调用 kubectl rollout undo", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-project-"));
  const env = setupFakeBinEnv({
    kubectlScript: createFakeKubectlScript({ availableReplicas: 3, expectedReplicas: 3 }),
  });
  try {
    const manager = new K8sRollbackManager({ projectRoot: projectTmpDir });
    // 先创建快照（rolling 策略）
    const snapshot = await manager.createSnapshot(
      createSnapshotContext({
        rollbackStrategy: "rolling",
      })
    );

    // 执行回滚
    const result = await manager.rollback(snapshot);

    // 验证回滚成功
    assert.equal(result.success, true, `rolling 回滚应成功，实际：${result.success}`);
    // 验证 rolledBackTo 为快照版本号
    assert.equal(result.rolledBackTo, snapshot.version);
    // 验证 errors 为空数组
    assert.equal(result.errors.length, 0, "errors 应为空数组");
    // 验证结果被冻结
    assert.equal(Object.isFrozen(result), true, "result 应被 Object.freeze 冻结");
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-2b. K8sRollbackManager.rollback blue-green 策略调用 kubectl patch service", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-project-"));
  const env = setupFakeBinEnv({
    kubectlScript: createFakeKubectlScript({ availableReplicas: 3, expectedReplicas: 3 }),
  });
  try {
    const manager = new K8sRollbackManager({ projectRoot: projectTmpDir });
    // 先创建快照（blue-green 策略）
    const snapshot = await manager.createSnapshot(
      createSnapshotContext({
        rollbackStrategy: "blue-green",
      })
    );

    // 执行回滚
    const result = await manager.rollback(snapshot);

    // 验证回滚成功
    assert.equal(result.success, true, `blue-green 回滚应成功，实际：${result.success}`);
    assert.equal(result.rolledBackTo, snapshot.version);
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-2c. K8sRollbackManager.rollback canary 策略调用 kubectl scale deployment", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-project-"));
  const env = setupFakeBinEnv({
    kubectlScript: createFakeKubectlScript({ availableReplicas: 3, expectedReplicas: 3 }),
  });
  try {
    const manager = new K8sRollbackManager({ projectRoot: projectTmpDir });
    // 先创建快照（canary 策略）
    const snapshot = await manager.createSnapshot(
      createSnapshotContext({
        rollbackStrategy: "canary",
      })
    );

    // 执行回滚
    const result = await manager.rollback(snapshot);

    // 验证回滚成功
    assert.equal(result.success, true, `canary 回滚应成功，实际：${result.success}`);
    assert.equal(result.rolledBackTo, snapshot.version);
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-RBM-3-3. K8sRollbackManager.verifyRollback 轮询验证
// ============================================================================

test("TC-RBM-3-3a. K8sRollbackManager.verifyRollback 副本数达标时返回 success=true", async () => {
  const env = setupFakeBinEnv({
    kubectlScript: createFakeKubectlScript({ availableReplicas: 3, expectedReplicas: 3 }),
  });
  try {
    const manager = new K8sRollbackManager({ rollbackTimeoutMs: 5000 });
    const result = await manager.verifyRollback("test-app", "default");

    // 验证成功
    assert.equal(result.success, true, "availableReplicas=3 >= expectedReplicas=3 应返回 success=true");
    assert.equal(result.currentReplicas, 3);
    assert.equal(result.expectedReplicas, 3);
    // 验证结果被冻结
    assert.equal(Object.isFrozen(result), true, "verifyRollback 结果应被 Object.freeze 冻结");
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
  }
});

test("TC-RBM-3-3b. K8sRollbackManager.verifyRollback 副本数不达标时轮询超时返回 success=false", async () => {
  // 使用 availableReplicas < expectedReplicas 模拟回滚未完成
  const env = setupFakeBinEnv({
    kubectlScript: createFakeKubectlScript({ availableReplicas: 1, expectedReplicas: 3 }),
  });
  try {
    // 设置较短的超时（1000ms）避免测试运行过久
    const manager = new K8sRollbackManager({ rollbackTimeoutMs: 1500 });
    const result = await manager.verifyRollback("test-app", "default");

    // 验证失败（轮询超时）
    assert.equal(result.success, false, "availableReplicas=1 < expectedReplicas=3 应返回 success=false");
    assert.equal(result.currentReplicas, 1);
    assert.equal(result.expectedReplicas, 3);
    // 验证消息含超时信息
    assert.ok(
      result.message.includes("超时") || result.message.includes("未达到"),
      `message 应含超时信息，实际：${result.message}`
    );
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
  }
});

// ============================================================================
// TC-RBM-3-4. K8sRollbackManager.createSnapshot 失败抛 RollbackExecutionError
// ============================================================================

test("TC-RBM-3-4a. K8sRollbackManager.createSnapshot kubectl 失败时抛 RollbackExecutionError", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-project-"));
  const env = setupFakeBinEnv({
    kubectlScript: createFakeKubectlScript({
      exitCode: 1,
      stderr: 'Error from server (NotFound): deployments.apps "test-app" not found',
    }),
  });
  try {
    const manager = new K8sRollbackManager({ projectRoot: projectTmpDir });

    // 验证抛出 RollbackExecutionError
    await assert.rejects(manager.createSnapshot(createSnapshotContext()), (err: unknown) => {
      assert.ok(
        err instanceof RollbackExecutionError,
        `应抛出 RollbackExecutionError，实际：${(err as Error).constructor.name}`
      );
      return true;
    });
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-4b. RollbackExecutionError 含 command / stderr / exitCode 字段", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-project-"));
  const env = setupFakeBinEnv({
    kubectlScript: createFakeKubectlScript({
      exitCode: 1,
      stderr: "deployment not found",
    }),
  });
  try {
    const manager = new K8sRollbackManager({ projectRoot: projectTmpDir });

    try {
      await manager.createSnapshot(createSnapshotContext());
      assert.fail("应抛出 RollbackExecutionError");
    } catch (err) {
      assert.ok(err instanceof RollbackExecutionError);
      const rollbackErr = err as RollbackExecutionError;
      // 验证 command 字段（含 kubectl get deployment 命令）
      assert.ok(
        rollbackErr.command.includes("kubectl get deployment"),
        `command 应含 "kubectl get deployment"，实际：${rollbackErr.command}`
      );
      // 验证 stderr 字段
      assert.ok(
        rollbackErr.stderr.includes("deployment not found") || rollbackErr.stderr.includes("命令"),
        `stderr 应含错误信息，实际：${rollbackErr.stderr}`
      );
      // 验证 exitCode 字段
      assert.equal(rollbackErr.exitCode, 1, `exitCode 应为 1，实际：${rollbackErr.exitCode}`);
    }
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-4c. RollbackExecutionError 实例被 Object.freeze 冻结", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-project-"));
  const env = setupFakeBinEnv({
    kubectlScript: createFakeKubectlScript({
      exitCode: 2,
      stderr: "fake error for freeze test",
    }),
  });
  try {
    const manager = new K8sRollbackManager({ projectRoot: projectTmpDir });

    try {
      await manager.createSnapshot(createSnapshotContext());
      assert.fail("应抛出 RollbackExecutionError");
    } catch (err) {
      assert.ok(err instanceof RollbackExecutionError);
      // 验证错误实例被 Object.freeze 冻结
      assert.equal(Object.isFrozen(err), true, "RollbackExecutionError 实例应被 Object.freeze 冻结");
    }
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-RBM-3-5. HelmRollbackManager.createSnapshot 成功路径
// ============================================================================

test("TC-RBM-3-5a. HelmRollbackManager.createSnapshot 调用 fake helm history 返回真实 revision", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-project-"));
  const env = setupFakeBinEnv({ helmScript: createFakeHelmScript({ latestRevision: 5 }) });
  try {
    const manager = new HelmRollbackManager({ projectRoot: projectTmpDir });
    const snapshot = await manager.createSnapshot(createSnapshotContext());

    // 验证 version 是最新 revision 号（fake helm 返回 revision 5）
    assert.equal(snapshot.version, "5", `version 应为 "5"，实际：${snapshot.version}`);
    // 验证 snapshotDataPath 非空
    assert.ok(snapshot.snapshotDataPath, "snapshotDataPath 应非空");
    // 验证 rollbackPlanFilePath 非空
    assert.ok(snapshot.rollbackPlanFilePath, "rollbackPlanFilePath 应非空");
    // 验证 snapshot 被冻结
    assert.equal(Object.isFrozen(snapshot), true, "snapshot 应被 Object.freeze 冻结");
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-5b. HelmRollbackManager.createSnapshot 返回 snapshot.resources 含 release/<name>", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-project-"));
  const env = setupFakeBinEnv({ helmScript: createFakeHelmScript() });
  try {
    const manager = new HelmRollbackManager({ projectRoot: projectTmpDir });
    const snapshot = await manager.createSnapshot(createSnapshotContext());

    // 验证 resources 包 release/test-app
    assert.ok(
      snapshot.resources.includes("release/test-app"),
      `resources 应含 "release/test-app"，实际：${JSON.stringify(snapshot.resources)}`
    );
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-RBM-3-6. HelmRollbackManager.rollback 成功路径
// ============================================================================

test("TC-RBM-3-6a. HelmRollbackManager.rollback 调用 fake helm rollback 返回 success=true", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-project-"));
  // rollback 后 verifyRollback 会调用 helm history，需返回匹配的 revision
  // 此处 latestRevision=5 与 snapshot.version="5" 一致，verifyRollback 成功
  const env = setupFakeBinEnv({ helmScript: createFakeHelmScript({ latestRevision: 5 }) });
  try {
    const manager = new HelmRollbackManager({ projectRoot: projectTmpDir });
    // 先创建快照
    const snapshot = await manager.createSnapshot(createSnapshotContext());

    // 执行回滚
    const result = await manager.rollback(snapshot);

    // 验证回滚成功
    assert.equal(result.success, true, `helm 回滚应成功，实际：${result.success}`);
    assert.equal(result.rolledBackTo, snapshot.version);
    assert.equal(result.errors.length, 0, "errors 应为空数组");
    // 验证结果被冻结
    assert.equal(Object.isFrozen(result), true, "result 应被 Object.freeze 冻结");
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-RBM-3-7. HelmRollbackManager.verifyRollback 验证
// ============================================================================

test("TC-RBM-3-7a. HelmRollbackManager.verifyRollback revision 匹配时返回 success=true", async () => {
  const env = setupFakeBinEnv({ helmScript: createFakeHelmScript({ latestRevision: 5 }) });
  try {
    const manager = new HelmRollbackManager({ rollbackTimeoutMs: 5000 });
    const result = await manager.verifyRollback("test-app", "default", 5);

    // 验证成功
    assert.equal(result.success, true, "当前 revision=5 匹配目标 revision=5 应返回 success=true");
    assert.equal(result.currentReplicas, 5);
    assert.equal(result.expectedReplicas, 5);
    assert.equal(Object.isFrozen(result), true, "verifyRollback 结果应被 Object.freeze 冻结");
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
  }
});

test("TC-RBM-3-7b. HelmRollbackManager.verifyRollback revision 不匹配时返回 success=false", async () => {
  // 目标 revision=4，但 fake helm 返回当前 revision=5，不匹配
  const env = setupFakeBinEnv({ helmScript: createFakeHelmScript({ latestRevision: 5 }) });
  try {
    const manager = new HelmRollbackManager({ rollbackTimeoutMs: 5000 });
    const result = await manager.verifyRollback("test-app", "default", 4);

    // 验证失败
    assert.equal(result.success, false, "当前 revision=5 ≠ 目标 revision=4 应返回 success=false");
    assert.equal(result.currentReplicas, 5);
    assert.equal(result.expectedReplicas, 4);
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
  }
});

// ============================================================================
// TC-RBM-3-8. RollbackPlanWriter 完整流程
// ============================================================================

/**
 * 构造测试用 RollbackPlan 对象
 *
 * @param overrides 覆盖字段
 * @returns 完整的 RollbackPlan
 */
function createTestRollbackPlan(overrides?: Partial<RollbackPlan>): RollbackPlan {
  const steps: ReadonlyArray<RollbackPlanStep> = Object.freeze([
    Object.freeze({
      step: 1,
      action: "执行 kubectl rollout undo",
      command: "kubectl rollout undo deployment/test-app -n default --to-revision=5",
    }) as RollbackPlanStep,
    Object.freeze({
      step: 2,
      action: "等待 rollout 完成",
      command: "kubectl rollout status deployment/test-app -n default",
    }) as RollbackPlanStep,
  ]);

  return {
    targetVersion: "revision-5",
    rollbackCommand: "kubectl rollout undo deployment/test-app -n default --to-revision=5",
    resources: Object.freeze(["deployment/test-app", "service/test-app"]) as ReadonlyArray<string>,
    createdAt: "2026-07-21T10:00:00.000Z",
    runId: "test-run-001",
    steps,
    ...overrides,
  };
}

test("TC-RBM-3-8a. RollbackPlanWriter.writePlan 序列化 YAML 文件成功", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-writer-"));
  try {
    const writer = new RollbackPlanWriter({ projectRoot: tmpDir });
    const plan = createTestRollbackPlan();
    const filePath = await writer.writePlan(plan, "rollback-plan.yaml");

    // 验证返回的文件路径是绝对路径
    assert.ok(path.isAbsolute(filePath), "返回的文件路径应为绝对路径");
    // 验证文件存在
    assert.ok(fs.existsSync(filePath), `文件应存在：${filePath}`);
    // 验证文件内容非空
    const content = fs.readFileSync(filePath, { encoding: "utf8" });
    assert.ok(content.length > 0, "文件内容应非空");
    // 验证文件内容含 targetVersion 字段
    assert.ok(content.includes("targetVersion:"), `文件内容应含 "targetVersion:" 字段，实际：${content}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-8b. RollbackPlanWriter.readPlan 反序列化 RollbackPlan 对象成功（字段值一致）", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-writer-"));
  try {
    const writer = new RollbackPlanWriter({ projectRoot: tmpDir });
    const originalPlan = createTestRollbackPlan();
    const filePath = await writer.writePlan(originalPlan, "rollback-plan.yaml");

    // 读取并反序列化
    const readPlan = await writer.readPlan(filePath);

    // 验证字段值一致
    assert.equal(readPlan.targetVersion, originalPlan.targetVersion);
    assert.equal(readPlan.rollbackCommand, originalPlan.rollbackCommand);
    assert.equal(readPlan.createdAt, originalPlan.createdAt);
    assert.equal(readPlan.runId, originalPlan.runId);
    // 验证 resources 数组
    assert.deepEqual([...readPlan.resources], [...originalPlan.resources], "resources 数组应一致");
    // 验证 steps 数组
    assert.equal(readPlan.steps.length, originalPlan.steps.length, "steps 长度应一致");
    assert.equal(readPlan.steps[0].step, originalPlan.steps[0].step);
    assert.equal(readPlan.steps[0].action, originalPlan.steps[0].action);
    assert.equal(readPlan.steps[0].command, originalPlan.steps[0].command);
    assert.equal(readPlan.steps[1].step, originalPlan.steps[1].step);
    assert.equal(readPlan.steps[1].action, originalPlan.steps[1].action);
    assert.equal(readPlan.steps[1].command, originalPlan.steps[1].command);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-8c. RollbackPlanWriter.validatePlanFile 校验通过（exists=true, valid=true, failures=[]）", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-writer-"));
  try {
    const writer = new RollbackPlanWriter({ projectRoot: tmpDir });
    const plan = createTestRollbackPlan();
    const filePath = await writer.writePlan(plan, "rollback-plan.yaml");

    // 校验文件
    const validation = await writer.validatePlanFile(filePath);

    // 验证校验结果
    assert.equal(validation.exists, true, "文件应存在");
    assert.equal(validation.valid, true, "文件应通过校验");
    assert.equal(validation.failures.length, 0, "failures 应为空数组");
    assert.equal(Object.isFrozen(validation), true, "校验结果应被 Object.freeze 冻结");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-8d. RollbackPlanWriter.readPlan 返回的对象被 Object.freeze 冻结", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-writer-"));
  try {
    const writer = new RollbackPlanWriter({ projectRoot: tmpDir });
    const plan = createTestRollbackPlan();
    const filePath = await writer.writePlan(plan, "rollback-plan.yaml");

    const readPlan = await writer.readPlan(filePath);

    // 验证 readPlan 对象被冻结
    assert.equal(Object.isFrozen(readPlan), true, "readPlan 应被 Object.freeze 冻结");
    // 验证 resources 数组被冻结
    assert.equal(Object.isFrozen(readPlan.resources), true, "resources 数组应被冻结");
    // 验证 steps 数组被冻结
    assert.equal(Object.isFrozen(readPlan.steps), true, "steps 数组应被冻结");
    // 验证 steps[0] 对象被冻结
    assert.equal(Object.isFrozen(readPlan.steps[0]), true, "steps[0] 应被冻结");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-8e. RollbackPlanWriter.validatePlanFile 文件不存在时返回 exists=false", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-writer-"));
  try {
    const writer = new RollbackPlanWriter({ projectRoot: tmpDir });
    const validation = await writer.validatePlanFile("nonexistent.yaml");

    // 验证文件不存在
    assert.equal(validation.exists, false, "文件应不存在");
    assert.equal(validation.valid, false, "校验应失败");
    assert.ok(validation.failures.length > 0, "failures 应含错误信息");
    assert.ok(
      validation.failures.some((f) => f.includes("不存在")),
      `failures 应含 "不存在"，实际：${JSON.stringify(validation.failures)}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-8f. RollbackPlanWriter.writePlan steps 为空时抛 Error", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-writer-"));
  try {
    const writer = new RollbackPlanWriter({ projectRoot: tmpDir });
    // 构造 steps 为空的 RollbackPlan
    const planWithEmptySteps = createTestRollbackPlan({
      steps: Object.freeze([]) as ReadonlyArray<RollbackPlanStep>,
    });

    // 验证抛出 Error
    await assert.rejects(writer.writePlan(planWithEmptySteps, "rollback-plan.yaml"), (err: unknown) => {
      const msg = (err as Error).message;
      assert.ok(msg.includes("steps") && msg.includes("不能为空"), `错误消息应含 "steps 不能为空"，实际：${msg}`);
      return true;
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-8g. RollbackPlanWriter.writePlan 必填字段为空时抛 Error", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-writer-"));
  try {
    const writer = new RollbackPlanWriter({ projectRoot: tmpDir });
    // 构造 targetVersion 为空的 RollbackPlan
    const planWithEmptyField = createTestRollbackPlan({
      targetVersion: "",
    });

    // 验证抛出 Error
    await assert.rejects(writer.writePlan(planWithEmptyField, "rollback-plan.yaml"), (err: unknown) => {
      const msg = (err as Error).message;
      assert.ok(
        msg.includes("targetVersion") && msg.includes("不能为空"),
        `错误消息应含 "targetVersion 不能为空"，实际：${msg}`
      );
      return true;
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-8h. RollbackPlanWriter.readPlan 文件不存在时抛 Error", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-writer-"));
  try {
    const writer = new RollbackPlanWriter({ projectRoot: tmpDir });

    // 验证抛出 Error
    await assert.rejects(writer.readPlan("nonexistent.yaml"), (err: unknown) => {
      const msg = (err as Error).message;
      assert.ok(msg.includes("不存在"), `错误消息应含 "不存在"，实际：${msg}`);
      return true;
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-8i. RollbackPlanWriter 实例被 Object.freeze 冻结", () => {
  const writer = new RollbackPlanWriter();
  assert.equal(Object.isFrozen(writer), true, "RollbackPlanWriter 实例应被 Object.freeze 冻结");
});

// ============================================================================
// TC-RBM-3-9. RollbackExecutionError 错误传递
// ============================================================================

test("TC-RBM-3-9a. RollbackExecutionError 是 Error 的子类", () => {
  const err = new RollbackExecutionError("kubectl rollout undo", "fake error", 1);
  assert.ok(err instanceof Error, "RollbackExecutionError 应是 Error 的子类");
  assert.ok(err instanceof RollbackExecutionError, "应是 RollbackExecutionError 实例");
});

test("TC-RBM-3-9b. RollbackExecutionError.name === 'RollbackExecutionError'", () => {
  const err = new RollbackExecutionError("helm rollback", "fake error", 2);
  assert.equal(err.name, "RollbackExecutionError", `name 应为 "RollbackExecutionError"，实际：${err.name}`);
});

test("TC-RBM-3-9c. RollbackExecutionError.message 含命令名称、退出码与 stderr", () => {
  const command = "kubectl rollout undo deployment/test-app -n default --to-revision=5";
  const stderr = "Error from server: deployment not found";
  const exitCode = 1;
  const err = new RollbackExecutionError(command, stderr, exitCode);

  // 验证 message 含命令名称
  assert.ok(err.message.includes(command), `message 应含命令名称 "${command}"，实际：${err.message}`);
  // 验证 message 含退出码
  assert.ok(err.message.includes(String(exitCode)), `message 应含退出码 "${exitCode}"，实际：${err.message}`);
  // 验证 message 含 stderr
  assert.ok(err.message.includes(stderr), `message 应含 stderr "${stderr}"，实际：${err.message}`);
});

test("TC-RBM-3-9d. RollbackExecutionError 实例被 Object.freeze 冻结", () => {
  const err = new RollbackExecutionError("kubectl", "fake error", 1);
  assert.equal(Object.isFrozen(err), true, "RollbackExecutionError 实例应被 Object.freeze 冻结");
});

test("TC-RBM-3-9e. RollbackExecutionError 支持 null exitCode（进程被信号终止）", () => {
  const err = new RollbackExecutionError("kubectl", "signal terminated", null);
  assert.equal(err.exitCode, null, "exitCode 应为 null");
  assert.ok(err.message.includes("null"), `message 应含 "null"，实际：${err.message}`);
});

// ============================================================================
// TC-RBM-3-10. 端到端集成：createSnapshot + rollback + verifyRollback 完整流程
// ============================================================================

test("TC-RBM-3-10a. K8sRollbackManager 端到端集成（createSnapshot → rollback → verifyRollback）", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-e2e-"));
  const env = setupFakeBinEnv({
    kubectlScript: createFakeKubectlScript({ availableReplicas: 3, expectedReplicas: 3 }),
  });
  try {
    const manager = new K8sRollbackManager({
      rollbackTimeoutMs: 5000,
      projectRoot: projectTmpDir,
    });

    // 步骤 1: 创建快照
    const snapshot = await manager.createSnapshot(
      createSnapshotContext({
        rollbackStrategy: "rolling",
      })
    );
    assert.equal(snapshot.version, "5", "createSnapshot 应返回 revision 5");

    // 步骤 2: 执行回滚
    const rollbackResult = await manager.rollback(snapshot);
    assert.equal(rollbackResult.success, true, "rollback 应成功");
    assert.equal(rollbackResult.rolledBackTo, "5", "rolledBackTo 应为 5");

    // 步骤 3: 验证回滚结果（独立调用 verifyRollback）
    const verifyResult = await manager.verifyRollback("test-app", "default");
    assert.equal(verifyResult.success, true, "verifyRollback 应成功");
    assert.equal(verifyResult.currentReplicas, 3);
    assert.equal(verifyResult.expectedReplicas, 3);
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-10b. HelmRollbackManager 端到端集成（createSnapshot → rollback → verifyRollback）", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-e2e-"));
  const env = setupFakeBinEnv({
    helmScript: createFakeHelmScript({ latestRevision: 5 }),
  });
  try {
    const manager = new HelmRollbackManager({
      rollbackTimeoutMs: 5000,
      projectRoot: projectTmpDir,
    });

    // 步骤 1: 创建快照
    const snapshot = await manager.createSnapshot(createSnapshotContext());
    assert.equal(snapshot.version, "5", "createSnapshot 应返回 revision 5");

    // 步骤 2: 执行回滚
    const rollbackResult = await manager.rollback(snapshot);
    assert.equal(rollbackResult.success, true, "rollback 应成功");
    assert.equal(rollbackResult.rolledBackTo, "5", "rolledBackTo 应为 5");

    // 步骤 3: 验证回滚结果
    const verifyResult = await manager.verifyRollback("test-app", "default", 5);
    assert.equal(verifyResult.success, true, "verifyRollback 应成功");
    assert.equal(verifyResult.currentReplicas, 5);
    assert.equal(verifyResult.expectedReplicas, 5);
  } finally {
    restoreFakeBinEnv(env.tmpDir, env.originalPath);
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RBM-3-10c. RollbackPlanWriter 端到端集成（writePlan → readPlan → validatePlanFile）", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rbm-e2e-"));
  try {
    const writer = new RollbackPlanWriter({ projectRoot: tmpDir });
    const originalPlan = createTestRollbackPlan();

    // 步骤 1: 写入文件
    const filePath = await writer.writePlan(originalPlan, "rollback-plan.yaml");
    assert.ok(fs.existsSync(filePath), "文件应已创建");

    // 步骤 2: 读取文件
    const readPlan = await writer.readPlan(filePath);
    assert.equal(readPlan.targetVersion, originalPlan.targetVersion);
    assert.equal(readPlan.runId, originalPlan.runId);

    // 步骤 3: 校验文件
    const validation = await writer.validatePlanFile(filePath);
    assert.equal(validation.exists, true);
    assert.equal(validation.valid, true);
    assert.equal(validation.failures.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
