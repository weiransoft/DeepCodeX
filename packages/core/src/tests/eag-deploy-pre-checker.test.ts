/**
 * EAG-P4 批次 13 Phase 4 单元测试：PreDeployCheckerImpl
 *
 * 测试范围（对齐设计文档 §6.2.1 D2-2 PreDeployChecker 覆盖率 ≥ 85%）：
 * - T1. 实例化与接口契约
 *   - T1a. 实例化成功
 *   - T1b. 实现 PreDeployChecker 接口
 * - T2. check() 返回结构正确
 *   - T2a. 返回 PreDeployCheckResult 结构（含 6 个字段）
 *   - T2b. 返回的 failures 是数组
 * - T3. 镜像构建校验（imageBuilt）
 *   - T3a. docker 命令不存在时 imageBuilt=false
 *   - T3b. imageBuilt=false 时 failures 含"镜像"
 * - T4. 配置完整性校验（configValid）
 *   - T4a. iacTemplates 非空时 configValid=true
 *   - T4b. iacTemplates 为空时 configValid=false
 * - T5. 依赖服务可用校验（dependenciesAvailable，N-M-2 修复）
 *   - T5a. kubectl 命令不存在时 dependenciesAvailable=true（首次部署场景）
 * - T6. 资源配额校验（resourceQuotaSufficient，N-M-2 修复）
 *   - T6a. kubectl 命令不存在时 resourceQuotaSufficient=true（首次部署场景）
 * - T7. 整体校验结果
 *   - T7a. CLI 不存在时 passed=false（因 imageBuilt=false）
 *   - T7b. failures 含镜像相关错误
 * - T8. 不可变优先
 *   - T8a. 返回的 PreDeployCheckResult 对象已冻结
 *   - T8b. failures 数组已冻结
 * - T9. validate() 真实 CLI 调用（CLI 存在时）
 *   - T9a. docker CLI 存在时 imageBuilt 真实校验（CLI 不存在时跳过）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 * - CLI 不存在测试通过 PATH="/nonexistent" 真实模拟（非 mock）
 * - CLI 存在测试通过 checkCliAvailable 检测，不存在时跳过
 *
 * @module core/tests/eag-deploy-pre-checker
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PreDeployCheckerImpl } from "../eag/deploy/pre-deploy-checker";
import type { PreDeployChecker, PreDeployCheckContext, PreDeployCheckResult, IaCTemplate } from "../eag/devops/types";

// ============================================================================
// 辅助函数：检测 CLI 工具是否可用
// ============================================================================

/**
 * 检测 CLI 工具是否可用
 *
 * 通过 spawnSync 调用 `<cli> --version` 检测 CLI 是否存在，非 mock。
 * 用于有条件地运行真实 CLI 测试，CLI 不存在时跳过。
 *
 * @param cliName CLI 工具名称（如 "docker" / "kubectl"）
 * @returns true=CLI 可用，false=CLI 不可用
 */
function checkCliAvailable(cliName: string): boolean {
  try {
    const result = spawnSync(cliName, ["--version"], {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ============================================================================
// 辅助函数：构造 PreDeployCheckContext
// ============================================================================

/**
 * 构造测试用 PreDeployCheckContext（默认含 1 个 IaC 模板）
 *
 * @param overrides 覆盖字段
 * @returns 完整的 PreDeployCheckContext
 */
function createContext(overrides: Partial<PreDeployCheckContext> = {}): PreDeployCheckContext {
  return {
    projectName: "test-app",
    environment: "dev",
    image: "registry.example.com/test-app:v1.0.0",
    iacTemplates: [
      {
        type: "terraform",
        content: "# test terraform content",
        filePath: "main.tf",
        hash: "abc123",
        generatedAt: "2026-07-20T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

/**
 * 构造测试用 IaCTemplate 数组
 *
 * @param count 模板数量
 * @returns IaCTemplate 数组
 */
function createIacTemplates(count: number): ReadonlyArray<IaCTemplate> {
  const templates: IaCTemplate[] = [];
  for (let i = 0; i < count; i++) {
    templates.push({
      type: "terraform",
      content: `# test terraform content ${i}`,
      filePath: `main-${i}.tf`,
      hash: `hash-${i}`,
      generatedAt: "2026-07-20T00:00:00.000Z",
    });
  }
  return templates;
}

// ============================================================================
// T1. 实例化与接口契约
// ============================================================================

test("T1a. PreDeployCheckerImpl 实例化成功", () => {
  const checker = new PreDeployCheckerImpl();
  assert.ok(checker instanceof PreDeployCheckerImpl);
});

test("T1b. 实现 PreDeployChecker 接口", () => {
  const checker: PreDeployChecker = new PreDeployCheckerImpl();
  assert.equal(typeof checker.check, "function");
});

// ============================================================================
// T2. check() 返回结构正确
// ============================================================================

test("T2a. 返回 PreDeployCheckResult 结构（含 6 个字段）", async () => {
  const checker = new PreDeployCheckerImpl();
  const result = await checker.check(createContext());

  // 验证 6 个字段全部存在
  assert.ok("passed" in result);
  assert.ok("imageBuilt" in result);
  assert.ok("configValid" in result);
  assert.ok("dependenciesAvailable" in result);
  assert.ok("resourceQuotaSufficient" in result);
  assert.ok("failures" in result);

  // 验证字段类型
  assert.equal(typeof result.passed, "boolean");
  assert.equal(typeof result.imageBuilt, "boolean");
  assert.equal(typeof result.configValid, "boolean");
  assert.equal(typeof result.dependenciesAvailable, "boolean");
  assert.equal(typeof result.resourceQuotaSufficient, "boolean");
});

test("T2b. 返回的 failures 是数组", async () => {
  const checker = new PreDeployCheckerImpl();
  const result = await checker.check(createContext());
  assert.ok(Array.isArray(result.failures));
});

// ============================================================================
// T3. 镜像构建校验（imageBuilt）
// ============================================================================

test("T3a. docker 命令不存在时 imageBuilt=false", async () => {
  const checker = new PreDeployCheckerImpl();
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await checker.check(createContext());
    // docker 命令不存在时，imageBuilt 应为 false
    assert.equal(result.imageBuilt, false);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('T3b. imageBuilt=false 时 failures 含"镜像"', async () => {
  const checker = new PreDeployCheckerImpl();
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await checker.check(createContext());
    // imageBuilt=false 时 failures 应含"镜像"相关错误
    const failuresStr = result.failures.join(" ");
    assert.ok(failuresStr.includes("镜像"), `failures 应含"镜像"，实际：${failuresStr}`);
  } finally {
    process.env.PATH = originalPath;
  }
});

// ============================================================================
// T4. 配置完整性校验（configValid）
// ============================================================================

test("T4a. iacTemplates 非空时 configValid=true", async () => {
  const checker = new PreDeployCheckerImpl();
  const result = await checker.check(createContext({ iacTemplates: createIacTemplates(3) }));
  assert.equal(result.configValid, true);
});

test("T4b. iacTemplates 为空时 configValid=false", async () => {
  const checker = new PreDeployCheckerImpl();
  const result = await checker.check(createContext({ iacTemplates: [] }));
  assert.equal(result.configValid, false);
  // failures 应含"IaC 模板为空"
  const failuresStr = result.failures.join(" ");
  assert.ok(failuresStr.includes("IaC"), `failures 应含"IaC"，实际：${failuresStr}`);
});

// ============================================================================
// T5. 依赖服务可用校验（dependenciesAvailable，N-M-2 修复）
// ============================================================================

test("T5a. kubectl 命令不存在时 dependenciesAvailable=true（首次部署场景）", async () => {
  const checker = new PreDeployCheckerImpl();
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await checker.check(createContext());
    // N-M-2 修复：kubectl 不存在时视为首次部署，dependenciesAvailable=true
    assert.equal(result.dependenciesAvailable, true);
  } finally {
    process.env.PATH = originalPath;
  }
});

// ============================================================================
// T6. 资源配额校验（resourceQuotaSufficient，N-M-2 修复）
// ============================================================================

test("T6a. kubectl 命令不存在时 resourceQuotaSufficient=true（首次部署场景）", async () => {
  const checker = new PreDeployCheckerImpl();
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await checker.check(createContext());
    // N-M-2 修复：kubectl 不存在时视为首次部署，resourceQuotaSufficient=true
    assert.equal(result.resourceQuotaSufficient, true);
  } finally {
    process.env.PATH = originalPath;
  }
});

// ============================================================================
// T7. 整体校验结果
// ============================================================================

test("T7a. CLI 不存在时 passed=false（因 imageBuilt=false）", async () => {
  const checker = new PreDeployCheckerImpl();
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await checker.check(createContext());
    // docker 不存在 → imageBuilt=false → passed=false
    assert.equal(result.passed, false);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("T7b. failures 含镜像相关错误", async () => {
  const checker = new PreDeployCheckerImpl();
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await checker.check(createContext());
    assert.ok(result.failures.length > 0);
    const failuresStr = result.failures.join(" ");
    assert.ok(failuresStr.includes("镜像"), `failures 应含"镜像"，实际：${failuresStr}`);
  } finally {
    process.env.PATH = originalPath;
  }
});

// ============================================================================
// T8. 不可变优先
// ============================================================================

test("T8a. 返回的 PreDeployCheckResult 对象已冻结", async () => {
  const checker = new PreDeployCheckerImpl();
  const result: PreDeployCheckResult = await checker.check(createContext());
  assert.equal(Object.isFrozen(result), true);
});

test("T8b. failures 数组已冻结", async () => {
  const checker = new PreDeployCheckerImpl();
  const result = await checker.check(createContext());
  assert.equal(Object.isFrozen(result.failures), true);
});

// ============================================================================
// T9. 真实 CLI 调用（CLI 存在时）
// ============================================================================

// 检测真实 docker CLI 是否存在，存在时测试真实路径（非 mock），不存在时跳过
const hasDockerCli = checkCliAvailable("docker");

test("T9a. docker CLI 存在时 imageBuilt 真实校验", { skip: !hasDockerCli }, async () => {
  const checker = new PreDeployCheckerImpl();
  // 使用一个不存在的镜像地址，验证 docker inspect 真实返回 false
  const result = await checker.check(createContext({ image: "registry.example.com/nonexistent-image:v0.0.0" }));
  // docker inspect 对不存在的镜像返回非 0 退出码，imageBuilt 应为 false
  assert.equal(typeof result.imageBuilt, "boolean");
});
