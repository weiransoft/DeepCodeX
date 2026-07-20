/**
 * EAG-P4 批次 13 Phase 3 单元测试：K8sManifestGenerator
 *
 * 测试范围（对齐设计文档 §6.2.1 D1-2 IaC 生成器覆盖率 ≥ 85%）：
 * - T1. 实例化与接口契约
 *   - T1a. 实例化成功
 *   - T1b. iacType 为 "k8s-manifest"
 *   - T1c. 实现 IaCGenerator 接口
 * - T2. generate() 返回 5~6 个 IaCTemplate（6 种资源类型，满足 D1-2 验收标准）
 *   - T2a. 含 ingress 时返回 6 个文件
 *   - T2b. 不含 ingress 时返回 5 个文件
 *   - T2c. 返回的 type 全部为 "k8s-manifest"
 *   - T2d. 返回的 hash 是 64 位十六进制 SHA256
 *   - T2e. 返回的 generatedAt 是有效 ISO 8601 时间戳
 * - T3. namespace.yaml 资源（v1 / Namespace）
 *   - T3a. 含 apiVersion: v1
 *   - T3b. 含 kind: Namespace
 *   - T3c. metadata.name 为 context.projectName
 *   - T3d. labels 含 environment / managed-by
 * - T4. configmap.yaml 资源（v1 / ConfigMap）
 *   - T4a. envVars 含非 Secret 时生成 configmap.yaml
 *   - T4b. 含 apiVersion: v1 + kind: ConfigMap
 *   - T4c. metadata.name 为 ${projectName}-config
 *   - T4d. data 含非 Secret 环境变量的 key=value
 * - T5. secret.yaml 资源（v1 / Secret，base64 编码）
 *   - T5a. envVars 含 fromSecret=true 时生成 secret.yaml
 *   - T5b. 含 apiVersion: v1 + kind: Secret + type: Opaque
 *   - T5c. data 值是 base64 编码
 * - T6. deployment.yaml 资源（apps/v1 / Deployment）
 *   - T6a. 含 apiVersion: apps/v1 + kind: Deployment
 *   - T6b. spec.replicas 正确插值
 *   - T6c. spec.template.spec.containers[0].image 正确插值
 *   - T6d. spec.template.spec.containers[0].ports.containerPort 正确插值
 *   - T6e. resources.requests / limits 正确插值
 *   - T6f. envVars 含 fromSecret=true 时生成 secretKeyRef 引用
 *   - T6g. envVars 含 fromSecret=false 时生成 configMapKeyRef 引用
 * - T7. service.yaml 资源（v1 / Service / ClusterIP）
 *   - T7a. 含 apiVersion: v1 + kind: Service
 *   - T7b. spec.type 为 ClusterIP
 *   - T7c. spec.ports.port / targetPort 正确插值
 * - T8. ingress.yaml 资源（networking.k8s.io/v1 / Ingress，可选）
 *   - T8a. context.ingress 存在时生成 ingress.yaml
 *   - T8b. 含 apiVersion: networking.k8s.io/v1 + kind: Ingress
 *   - T8c. spec.rules[0].host 正确插值
 *   - T8d. tlsSecret 存在时生成 tls 块
 *   - T8e. tlsSecret 不存在时不生成 tls 块
 * - T9. 边界场景
 *   - T9a. envVars 全为 fromSecret=true 时不生成 configmap.yaml
 *   - T9b. envVars 全为 fromSecret=false 时不生成 secret.yaml
 *   - T9c. envVars 为空时只生成 namespace/deployment/service 3 个文件
 *   - T9d. context.ingress 为空时不生成 ingress.yaml
 * - T10. validate() 真实 CLI 调用
 *   - T10a. kubectl 命令不存在时返回 valid=false + 错误信息
 *   - T10b. validate 返回的 validatedBy 为 "kubectl-dry-run"
 *   - T10c. kubectl CLI 存在时 validate 返回结构正确（P1-4 修复，CLI 不存在时跳过）
 * - T11. 不可变优先
 *   - T11a. generate() 返回的 IaCTemplate 对象已冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 * - validate() 测试覆盖两条路径：命令不存在的降级路径 + CLI 存在时的真实路径（P1-4 修复）
 *
 * @module core/tests/eag-devops-iac-k8s
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { K8sManifestGenerator } from "../eag/devops/iac-generator/k8s-manifest-generator";
import type { IaCGenerator, IaCGenerationContext, IaCTemplate } from "../eag/devops/types";

// ============================================================================
// 辅助函数：检测 CLI 工具是否可用（P1-4 修复：补充 validate 成功路径测试）
// ============================================================================

/**
 * 检测 CLI 工具是否可用
 *
 * 通过 spawnSync 调用 `<cli> --version` 检测 CLI 是否存在，非 mock。
 * 用于有条件地运行 validate() 成功路径测试，CLI 不存在时跳过。
 *
 * @param cliName CLI 工具名称（如 "terraform" / "kubectl" / "helm"）
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
// 辅助函数：构造 IaCGenerationContext
// ============================================================================

/**
 * 构造测试用 IaCGenerationContext（默认含 ingress + 混合 envVars）
 *
 * @param overrides 覆盖字段
 * @returns 完整的 IaCGenerationContext
 */
function createContext(overrides: Partial<IaCGenerationContext> = {}): IaCGenerationContext {
  return {
    projectName: "test-app",
    environment: "dev",
    replicas: 3,
    image: "registry.example.com/test-app:v1.0.0",
    port: 8080,
    resources: {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "500m", memory: "512Mi" },
    },
    envVars: [
      { name: "LOG_LEVEL", value: "info" },
      { name: "DATABASE_PASSWORD", value: "test-app-secret", fromSecret: true },
    ],
    ingress: {
      host: "test-app.example.com",
      path: "/",
      port: 8080,
      tlsSecret: "test-app-tls",
    },
    ...overrides,
  };
}

// ============================================================================
// T1. 实例化与接口契约
// ============================================================================

test("T1a. K8sManifestGenerator 实例化成功", () => {
  const generator = new K8sManifestGenerator();
  assert.ok(generator instanceof K8sManifestGenerator);
});

test("T1b. iacType 为 k8s-manifest", () => {
  const generator = new K8sManifestGenerator();
  assert.equal(generator.iacType, "k8s-manifest");
});

test("T1c. 实现 IaCGenerator 接口", () => {
  const generator: IaCGenerator = new K8sManifestGenerator();
  assert.equal(generator.iacType, "k8s-manifest");
  assert.equal(typeof generator.generate, "function");
  assert.equal(typeof generator.validate, "function");
});

// ============================================================================
// T2. generate() 返回 5~6 个 IaCTemplate（6 种资源类型，满足 D1-2 验收标准）
// ============================================================================

test("T2a. 含 ingress 时返回 6 个文件", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext());
  // namespace + configmap + secret + deployment + service + ingress = 6
  assert.equal(templates.length, 6);
});

test("T2b. 不含 ingress 时返回 5 个文件", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext({ ingress: undefined }));
  // namespace + configmap + secret + deployment + service = 5
  assert.equal(templates.length, 5);
});

test("T2c. 返回的 type 全部为 k8s-manifest", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext());
  for (const tpl of templates) {
    assert.equal(tpl.type, "k8s-manifest");
  }
});

test("T2d. 返回的 hash 是 64 位十六进制 SHA256", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext());
  const sha256Pattern = /^[0-9a-f]{64}$/;
  for (const tpl of templates) {
    assert.match(tpl.hash, sha256Pattern, `hash 不是 64 位十六进制 SHA256：${tpl.hash}`);
  }
});

test("T2e. 返回的 generatedAt 是有效 ISO 8601 时间戳", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext());
  for (const tpl of templates) {
    const parsed = new Date(tpl.generatedAt);
    assert.ok(!isNaN(parsed.getTime()), `generatedAt 不是有效时间戳：${tpl.generatedAt}`);
  }
});

// ============================================================================
// T3. namespace.yaml 资源（v1 / Namespace）
// ============================================================================

test("T3a. namespace.yaml 含 apiVersion: v1", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext());
  const ns = templates.find((t) => t.filePath === "namespace.yaml")!;
  assert.ok(ns.content.includes("apiVersion: v1"));
});

test("T3b. namespace.yaml 含 kind: Namespace", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext());
  const ns = templates.find((t) => t.filePath === "namespace.yaml")!;
  assert.ok(ns.content.includes("kind: Namespace"));
});

test("T3c. namespace.yaml metadata.name 为 context.projectName", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext({ projectName: "my-app" }));
  const ns = templates.find((t) => t.filePath === "namespace.yaml")!;
  assert.ok(ns.content.includes("name: my-app"));
});

test("T3d. namespace.yaml labels 含 environment / managed-by", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext({ environment: "prod" }));
  const ns = templates.find((t) => t.filePath === "namespace.yaml")!;
  assert.ok(ns.content.includes("environment: prod"));
  assert.ok(ns.content.includes("managed-by: eag-devops"));
});

// ============================================================================
// T4. configmap.yaml 资源（v1 / ConfigMap）
// ============================================================================

test("T4a. envVars 含非 Secret 时生成 configmap.yaml", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [{ name: "LOG_LEVEL", value: "info" }],
    })
  );
  assert.ok(templates.some((t) => t.filePath === "configmap.yaml"));
});

test("T4b. configmap.yaml 含 apiVersion: v1 + kind: ConfigMap", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext());
  const cm = templates.find((t) => t.filePath === "configmap.yaml")!;
  assert.ok(cm.content.includes("apiVersion: v1"));
  assert.ok(cm.content.includes("kind: ConfigMap"));
});

test("T4c. configmap.yaml metadata.name 为 ${projectName}-config", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext({ projectName: "my-app" }));
  const cm = templates.find((t) => t.filePath === "configmap.yaml")!;
  assert.ok(cm.content.includes("name: my-app-config"));
});

test("T4d. configmap.yaml data 含非 Secret 环境变量的 key=value", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [{ name: "LOG_LEVEL", value: "debug" }],
    })
  );
  const cm = templates.find((t) => t.filePath === "configmap.yaml")!;
  assert.ok(cm.content.includes("LOG_LEVEL:"));
  assert.ok(cm.content.includes('"debug"'));
});

// ============================================================================
// T5. secret.yaml 资源（v1 / Secret，base64 编码）
// ============================================================================

test("T5a. envVars 含 fromSecret=true 时生成 secret.yaml", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [{ name: "DB_PASSWORD", value: "secret-value", fromSecret: true }],
    })
  );
  assert.ok(templates.some((t) => t.filePath === "secret.yaml"));
});

test("T5b. secret.yaml 含 apiVersion: v1 + kind: Secret + type: Opaque", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext());
  const secret = templates.find((t) => t.filePath === "secret.yaml")!;
  assert.ok(secret.content.includes("apiVersion: v1"));
  assert.ok(secret.content.includes("kind: Secret"));
  assert.ok(secret.content.includes("type: Opaque"));
});

test("T5c. secret.yaml data 值是 base64 编码", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [{ name: "DB_PASSWORD", value: "mypassword", fromSecret: true }],
    })
  );
  const secret = templates.find((t) => t.filePath === "secret.yaml")!;
  // base64("mypassword") = "bXlwYXNzd29yZA=="
  const expectedBase64 = Buffer.from("mypassword", "utf8").toString("base64");
  assert.ok(secret.content.includes(`DB_PASSWORD: "${expectedBase64}"`));
  // 不应含明文密码
  assert.ok(!secret.content.includes("mypassword"));
});

// ============================================================================
// T6. deployment.yaml 资源（apps/v1 / Deployment）
// ============================================================================

test("T6a. deployment.yaml 含 apiVersion: apps/v1 + kind: Deployment", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext());
  const dep = templates.find((t) => t.filePath === "deployment.yaml")!;
  assert.ok(dep.content.includes("apiVersion: apps/v1"));
  assert.ok(dep.content.includes("kind: Deployment"));
});

test("T6b. deployment.yaml spec.replicas 正确插值", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext({ replicas: 7 }));
  const dep = templates.find((t) => t.filePath === "deployment.yaml")!;
  assert.ok(dep.content.includes("replicas: 7"));
});

test("T6c. deployment.yaml image 正确插值", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext({ image: "my-registry/app:v2.0" }));
  const dep = templates.find((t) => t.filePath === "deployment.yaml")!;
  assert.ok(dep.content.includes("image: my-registry/app:v2.0"));
});

test("T6d. deployment.yaml containerPort 正确插值", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext({ port: 9090 }));
  const dep = templates.find((t) => t.filePath === "deployment.yaml")!;
  assert.ok(dep.content.includes("containerPort: 9090"));
});

test("T6e. deployment.yaml resources.requests / limits 正确插值", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(
    createContext({
      resources: {
        requests: { cpu: "200m", memory: "256Mi" },
        limits: { cpu: "1000m", memory: "1Gi" },
      },
    })
  );
  const dep = templates.find((t) => t.filePath === "deployment.yaml")!;
  assert.ok(dep.content.includes('cpu: "200m"'));
  assert.ok(dep.content.includes('memory: "256Mi"'));
  assert.ok(dep.content.includes('cpu: "1000m"'));
  assert.ok(dep.content.includes('memory: "1Gi"'));
});

test("T6f. deployment.yaml envVars 含 fromSecret=true 时生成 secretKeyRef 引用", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(
    createContext({
      projectName: "my-app",
      envVars: [{ name: "DB_PASSWORD", value: "app-secret", fromSecret: true }],
    })
  );
  const dep = templates.find((t) => t.filePath === "deployment.yaml")!;
  assert.ok(dep.content.includes("secretKeyRef"));
  assert.ok(dep.content.includes("name: my-app-secret"));
  assert.ok(dep.content.includes("key: DB_PASSWORD"));
});

test("T6g. deployment.yaml envVars 含 fromSecret=false 时生成 configMapKeyRef 引用", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(
    createContext({
      projectName: "my-app",
      envVars: [{ name: "LOG_LEVEL", value: "debug" }],
    })
  );
  const dep = templates.find((t) => t.filePath === "deployment.yaml")!;
  assert.ok(dep.content.includes("configMapKeyRef"));
  assert.ok(dep.content.includes("name: my-app-config"));
  assert.ok(dep.content.includes("key: LOG_LEVEL"));
  // 不含 secretKeyRef
  assert.ok(!dep.content.includes("secretKeyRef"));
});

// ============================================================================
// T7. service.yaml 资源（v1 / Service / ClusterIP）
// ============================================================================

test("T7a. service.yaml 含 apiVersion: v1 + kind: Service", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext());
  const svc = templates.find((t) => t.filePath === "service.yaml")!;
  assert.ok(svc.content.includes("apiVersion: v1"));
  assert.ok(svc.content.includes("kind: Service"));
});

test("T7b. service.yaml spec.type 为 ClusterIP", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext());
  const svc = templates.find((t) => t.filePath === "service.yaml")!;
  assert.ok(svc.content.includes("type: ClusterIP"));
});

test("T7c. service.yaml spec.ports.port / targetPort 正确插值", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext({ port: 9090 }));
  const svc = templates.find((t) => t.filePath === "service.yaml")!;
  assert.ok(svc.content.includes("port: 9090"));
  assert.ok(svc.content.includes("targetPort: 9090"));
});

// ============================================================================
// T8. ingress.yaml 资源（networking.k8s.io/v1 / Ingress，可选）
// ============================================================================

test("T8a. context.ingress 存在时生成 ingress.yaml", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(
    createContext({
      ingress: { host: "app.example.com", path: "/", port: 80 },
    })
  );
  assert.ok(templates.some((t) => t.filePath === "ingress.yaml"));
});

test("T8b. ingress.yaml 含 apiVersion: networking.k8s.io/v1 + kind: Ingress", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext());
  const ing = templates.find((t) => t.filePath === "ingress.yaml")!;
  assert.ok(ing.content.includes("apiVersion: networking.k8s.io/v1"));
  assert.ok(ing.content.includes("kind: Ingress"));
});

test("T8c. ingress.yaml spec.rules[0].host 正确插值", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(
    createContext({
      ingress: { host: "my-app.example.com", path: "/api", port: 80 },
    })
  );
  const ing = templates.find((t) => t.filePath === "ingress.yaml")!;
  assert.ok(ing.content.includes("host: my-app.example.com"));
  assert.ok(ing.content.includes("path: /api"));
});

test("T8d. ingress.yaml tlsSecret 存在时生成 tls 块", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(
    createContext({
      ingress: { host: "app.example.com", path: "/", port: 80, tlsSecret: "app-tls" },
    })
  );
  const ing = templates.find((t) => t.filePath === "ingress.yaml")!;
  assert.ok(ing.content.includes("tls:"));
  assert.ok(ing.content.includes("secretName: app-tls"));
});

test("T8e. ingress.yaml tlsSecret 不存在时不生成 tls 块", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(
    createContext({
      ingress: { host: "app.example.com", path: "/", port: 80 },
    })
  );
  const ing = templates.find((t) => t.filePath === "ingress.yaml")!;
  assert.ok(!ing.content.includes("tls:"));
  assert.ok(!ing.content.includes("secretName"));
});

// ============================================================================
// T9. 边界场景
// ============================================================================

test("T9a. envVars 全为 fromSecret=true 时不生成 configmap.yaml", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [{ name: "DB_PASSWORD", value: "secret", fromSecret: true }],
    })
  );
  assert.ok(!templates.some((t) => t.filePath === "configmap.yaml"));
  // 但应生成 secret.yaml
  assert.ok(templates.some((t) => t.filePath === "secret.yaml"));
});

test("T9b. envVars 全为 fromSecret=false 时不生成 secret.yaml", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [{ name: "LOG_LEVEL", value: "info" }],
    })
  );
  assert.ok(!templates.some((t) => t.filePath === "secret.yaml"));
  // 但应生成 configmap.yaml
  assert.ok(templates.some((t) => t.filePath === "configmap.yaml"));
});

test("T9c. envVars 为空时只生成 namespace/deployment/service 3 个文件", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [],
      ingress: undefined,
    })
  );
  assert.equal(templates.length, 3);
  const filePaths = templates.map((t) => t.filePath).sort();
  assert.deepEqual(filePaths, ["deployment.yaml", "namespace.yaml", "service.yaml"]);
});

test("T9d. context.ingress 为空时不生成 ingress.yaml", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext({ ingress: undefined }));
  assert.ok(!templates.some((t) => t.filePath === "ingress.yaml"));
});

// ============================================================================
// T10. validate() 真实 CLI 调用
// ============================================================================

test("T10a. kubectl 命令不存在时返回 valid=false + 错误信息", async () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext());
  const ns = templates.find((t) => t.filePath === "namespace.yaml")!;

  // 临时修改 PATH 使 kubectl 命令不可用
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await generator.validate(ns);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    // 错误信息含 "kubectl" 或 "请确认已预装"
    const errorMessage = result.errors.join(" ");
    assert.ok(
      errorMessage.includes("kubectl") || errorMessage.includes("请确认已预装"),
      `错误信息应含 kubectl 或"请确认已预装"，实际：${errorMessage}`
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("T10b. validate 返回的 validatedBy 为 kubectl-dry-run", async () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext());
  const ns = templates.find((t) => t.filePath === "namespace.yaml")!;

  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await generator.validate(ns);
    assert.equal(result.validatedBy, "kubectl-dry-run");
  } finally {
    process.env.PATH = originalPath;
  }
});

// T10c. kubectl CLI 存在时 validate 返回结构正确（P1-4 修复）
// 检测真实 kubectl CLI 是否存在，存在时测试真实路径（非 mock），不存在时跳过
const hasKubectlCli = checkCliAvailable("kubectl");

test("T10c. kubectl CLI 存在时 validate 返回结构正确", { skip: !hasKubectlCli }, async () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext());
  const ns = templates.find((t) => t.filePath === "namespace.yaml")!;

  // 调用真实 kubectl apply --dry-run=client
  const result = await generator.validate(ns);

  // 验证返回结构正确性（不强制 valid=true，因为 dry-run 可能因集群配置失败）
  assert.equal(typeof result.valid, "boolean");
  assert.ok(Array.isArray(result.errors));
  assert.equal(result.validatedBy, "kubectl-dry-run");

  // 如果 valid=true，errors 应为空数组
  if (result.valid) {
    assert.equal(result.errors.length, 0);
  } else {
    // 如果 valid=false，errors 应含错误信息
    assert.ok(result.errors.length > 0);
  }
});

// ============================================================================
// T11. 不可变优先
// ============================================================================

test("T11a. generate() 返回的 IaCTemplate 对象已冻结", () => {
  const generator = new K8sManifestGenerator();
  const templates = generator.generate(createContext());
  for (const tpl of templates) {
    const frozen: IaCTemplate = tpl;
    assert.equal(Object.isFrozen(frozen), true, `IaCTemplate 未冻结：${tpl.filePath}`);
  }
});
