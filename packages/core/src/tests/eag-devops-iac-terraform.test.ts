/**
 * EAG-P4 批次 13 Phase 3 单元测试：TerraformGenerator
 *
 * 测试范围（对齐设计文档 §6.2.1 D1-2 IaC 生成器覆盖率 ≥ 85%）：
 * - T1. 实例化与接口契约
 *   - T1a. 实例化成功
 *   - T1b. iacType 为 "terraform"
 *   - T1c. 实现 IaCGenerator 接口
 * - T2. generate() 返回 3 个 IaCTemplate
 *   - T2a. 返回数组长度为 3
 *   - T2b. 返回的文件路径为 main.tf / variables.tf / outputs.tf
 *   - T2c. 返回的 type 全部为 "terraform"
 *   - T2d. 返回的 generatedAt 是有效 ISO 8601 时间戳
 *   - T2e. 返回的 hash 是 64 位十六进制 SHA256
 * - T3. main.tf 资源覆盖（≥ 5 种资源类型，满足 D1-2 验收标准）
 *   - T3a. 含 kubernetes_namespace 资源
 *   - T3b. 含 kubernetes_deployment 资源
 *   - T3c. 含 kubernetes_service 资源
 *   - T3d. 含 kubernetes_ingress 资源（context.ingress 存在时）
 *   - T3e. 含 kubernetes provider 配置（B-6 修复：通过 kubeconfig 接入既有集群）
 *   - T3f. required_providers 含 kubernetes = hashicorp/kubernetes
 * - T4. main.tf 内容正确性
 *   - T4a. replicas 正确插值
 *   - T4b. image 正确插值
 *   - T4c. port 正确插值
 *   - T4d. resources.requests.cpu / memory 正确插值
 *   - T4e. resources.limits.cpu / memory 正确插值
 *   - T4f. envVars 含 fromSecret=true 时生成 value_from.secret_key_ref（T13 合并）
 *   - T4g. envVars 含 fromSecret=false 时生成明文 env 块（T14 合并）
 *   - T4h. envVars 为空时不生成 env 块（B-7 修复）
 * - T5. Ingress 配置
 *   - T5a. ingress.tlsSecret 存在时生成 tls 块
 *   - T5b. ingress.tlsSecret 不存在时不生成 tls 块
 *   - T5c. context.ingress 为空时 main.tf 不含 kubernetes_ingress
 * - T6. variables.tf 内容正确性
 *   - T6a. 含 project_name 变量（默认值为 context.projectName）
 *   - T6b. 含 environment 变量（含 validation 校验 dev / staging / prod）
 *   - T6c. 含 aws_region 变量（默认 ap-northeast-1）
 * - T7. outputs.tf 内容正确性（N-B-1 修复）
 *   - T7a. 含 namespace / service_name / deployment_name 输出
 *   - T7b. 不含 cluster_endpoint / cluster_name（N-B-1 修复验证）
 *   - T7c. 输出引用 kubernetes_namespace / kubernetes_service / kubernetes_deployment
 * - T8. validate() 真实 CLI 调用
 *   - T8a. terraform 命令不存在时返回 valid=false + 错误信息（含"请确认已预装"）
 *   - T8b. validate 返回的 validatedBy 为 "terraform-validate"
 * - T9. 不可变优先
 *   - T9a. generate() 返回的 IaCTemplate 对象已冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 * - validate() 测试不依赖真实 terraform CLI（测试命令不存在的降级路径）
 *
 * @module core/tests/eag-devops-iac-terraform
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TerraformGenerator } from "../eag/devops/iac-generator/terraform-generator";
import type { IaCGenerator, IaCGenerationContext, IaCTemplate } from "../eag/devops/types";

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

test("T1a. TerraformGenerator 实例化成功", () => {
  const generator = new TerraformGenerator();
  assert.ok(generator instanceof TerraformGenerator);
});

test("T1b. iacType 为 terraform", () => {
  const generator = new TerraformGenerator();
  assert.equal(generator.iacType, "terraform");
});

test("T1c. 实现 IaCGenerator 接口", () => {
  const generator: IaCGenerator = new TerraformGenerator();
  assert.equal(generator.iacType, "terraform");
  assert.equal(typeof generator.generate, "function");
  assert.equal(typeof generator.validate, "function");
});

// ============================================================================
// T2. generate() 返回 3 个 IaCTemplate
// ============================================================================

test("T2a. 返回数组长度为 3", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  assert.equal(templates.length, 3);
});

test("T2b. 返回的文件路径为 main.tf / variables.tf / outputs.tf", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  const filePaths = templates.map((t) => t.filePath).sort();
  assert.deepEqual(filePaths, ["main.tf", "outputs.tf", "variables.tf"]);
});

test("T2c. 返回的 type 全部为 terraform", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  for (const tpl of templates) {
    assert.equal(tpl.type, "terraform");
  }
});

test("T2d. 返回的 generatedAt 是有效 ISO 8601 时间戳", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  for (const tpl of templates) {
    const parsed = new Date(tpl.generatedAt);
    assert.ok(!isNaN(parsed.getTime()), `generatedAt 不是有效时间戳：${tpl.generatedAt}`);
  }
});

test("T2e. 返回的 hash 是 64 位十六进制 SHA256", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  const sha256Pattern = /^[0-9a-f]{64}$/;
  for (const tpl of templates) {
    assert.match(tpl.hash, sha256Pattern, `hash 不是 64 位十六进制 SHA256：${tpl.hash}`);
  }
});

// ============================================================================
// T3. main.tf 资源覆盖（≥ 5 种资源类型，满足 D1-2 验收标准）
// ============================================================================

test("T3a. main.tf 含 kubernetes_namespace 资源", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  assert.ok(mainTf.content.includes('resource "kubernetes_namespace"'));
});

test("T3b. main.tf 含 kubernetes_deployment 资源", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  assert.ok(mainTf.content.includes('resource "kubernetes_deployment"'));
});

test("T3c. main.tf 含 kubernetes_service 资源", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  assert.ok(mainTf.content.includes('resource "kubernetes_service"'));
});

test("T3d. main.tf 含 kubernetes_ingress 资源（context.ingress 存在时）", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  assert.ok(mainTf.content.includes('resource "kubernetes_ingress"'));
});

test("T3e. main.tf 含 kubernetes provider 配置（B-6 修复：通过 kubeconfig 接入既有集群）", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  assert.ok(mainTf.content.includes('provider "kubernetes"'));
  assert.ok(mainTf.content.includes('config_path = "~/.kube/config"'));
  // B-6 修复验证：不含 aws_eks_cluster 资源声明
  assert.ok(!mainTf.content.includes('resource "aws_eks_cluster"'));
});

test("T3f. required_providers 含 kubernetes = hashicorp/kubernetes", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  assert.ok(mainTf.content.includes("hashicorp/kubernetes"));
  assert.ok(mainTf.content.includes('required_version = ">= 1.0"'));
});

// ============================================================================
// T4. main.tf 内容正确性
// ============================================================================

test("T4a. replicas 正确插值", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext({ replicas: 5 }));
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  assert.ok(mainTf.content.includes("replicas = 5"));
});

test("T4b. image 正确插值", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext({ image: "my-registry/app:v2.0" }));
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  assert.ok(mainTf.content.includes('image = "my-registry/app:v2.0"'));
});

test("T4c. port 正确插值", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext({ port: 9090 }));
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  assert.ok(mainTf.content.includes("container_port = 9090"));
  assert.ok(mainTf.content.includes("port        = 9090"));
});

test("T4d. resources.requests.cpu / memory 正确插值", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(
    createContext({
      resources: {
        requests: { cpu: "200m", memory: "256Mi" },
        limits: { cpu: "1000m", memory: "1Gi" },
      },
    })
  );
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  assert.ok(mainTf.content.includes('cpu    = "200m"'));
  assert.ok(mainTf.content.includes('memory = "256Mi"'));
});

test("T4e. resources.limits.cpu / memory 正确插值", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(
    createContext({
      resources: {
        requests: { cpu: "200m", memory: "256Mi" },
        limits: { cpu: "1000m", memory: "1Gi" },
      },
    })
  );
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  assert.ok(mainTf.content.includes('cpu    = "1000m"'));
  assert.ok(mainTf.content.includes('memory = "1Gi"'));
});

test("T4f. envVars 含 fromSecret=true 时生成 value_from.secret_key_ref", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [{ name: "DB_PASSWORD", value: "app-secret", fromSecret: true }],
    })
  );
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  assert.ok(mainTf.content.includes("value_from"));
  assert.ok(mainTf.content.includes("secret_key_ref"));
  assert.ok(mainTf.content.includes('name = "app-secret"'));
  assert.ok(mainTf.content.includes('key  = "DB_PASSWORD"'));
});

test("T4g. envVars 含 fromSecret=false 时生成明文 env 块", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [{ name: "LOG_LEVEL", value: "debug" }],
    })
  );
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  assert.ok(mainTf.content.includes('name  = "LOG_LEVEL"'));
  assert.ok(mainTf.content.includes('value = "debug"'));
  // 不含 secret_key_ref
  assert.ok(!mainTf.content.includes("secret_key_ref"));
});

test("T4h. envVars 为空时不生成 env 块（B-7 修复）", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext({ envVars: [] }));
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  // 不含 env { 块
  assert.ok(!mainTf.content.includes("env {"));
});

// ============================================================================
// T5. Ingress 配置
// ============================================================================

test("T5a. ingress.tlsSecret 存在时生成 tls 块", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(
    createContext({
      ingress: { host: "app.example.com", path: "/", port: 80, tlsSecret: "app-tls" },
    })
  );
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  assert.ok(mainTf.content.includes("tls {"));
  assert.ok(mainTf.content.includes('secret_name = "app-tls"'));
  assert.ok(mainTf.content.includes('hosts       = ["app.example.com"]'));
});

test("T5b. ingress.tlsSecret 不存在时不生成 tls 块", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(
    createContext({
      ingress: { host: "app.example.com", path: "/", port: 80 },
    })
  );
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  assert.ok(!mainTf.content.includes("tls {"));
  assert.ok(!mainTf.content.includes("secret_name"));
});

test("T5c. context.ingress 为空时 main.tf 不含 kubernetes_ingress", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext({ ingress: undefined }));
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;
  assert.ok(!mainTf.content.includes('resource "kubernetes_ingress"'));
});

// ============================================================================
// T6. variables.tf 内容正确性
// ============================================================================

test("T6a. 含 project_name 变量（默认值为 context.projectName）", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext({ projectName: "my-app" }));
  const variablesTf = templates.find((t) => t.filePath === "variables.tf")!;
  assert.ok(variablesTf.content.includes('variable "project_name"'));
  assert.ok(variablesTf.content.includes('default     = "my-app"'));
});

test("T6b. 含 environment 变量（含 validation 校验 dev / staging / prod）", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext({ environment: "prod" }));
  const variablesTf = templates.find((t) => t.filePath === "variables.tf")!;
  assert.ok(variablesTf.content.includes('variable "environment"'));
  assert.ok(variablesTf.content.includes('default     = "prod"'));
  assert.ok(variablesTf.content.includes('contains(["dev", "staging", "prod"], var.environment)'));
});

test("T6c. 含 aws_region 变量（默认 ap-northeast-1）", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  const variablesTf = templates.find((t) => t.filePath === "variables.tf")!;
  assert.ok(variablesTf.content.includes('variable "aws_region"'));
  assert.ok(variablesTf.content.includes('default     = "ap-northeast-1"'));
});

// ============================================================================
// T7. outputs.tf 内容正确性（N-B-1 修复）
// ============================================================================

test("T7a. 含 namespace / service_name / deployment_name 输出", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  const outputsTf = templates.find((t) => t.filePath === "outputs.tf")!;
  assert.ok(outputsTf.content.includes('output "namespace"'));
  assert.ok(outputsTf.content.includes('output "service_name"'));
  assert.ok(outputsTf.content.includes('output "deployment_name"'));
});

test("T7b. 不含 cluster_endpoint / cluster_name output 声明（N-B-1 修复验证）", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  const outputsTf = templates.find((t) => t.filePath === "outputs.tf")!;
  // N-B-1 修复：删除了 cluster_endpoint / cluster_name output 声明
  // 注意：注释中仍含 "aws_eks_cluster" 字样（说明修复原因），但不应有 output 声明
  assert.ok(!outputsTf.content.includes('output "cluster_endpoint"'));
  assert.ok(!outputsTf.content.includes('output "cluster_name"'));
  // 不应引用 aws_eks_cluster.main 资源（已删除）
  assert.ok(!outputsTf.content.includes("aws_eks_cluster.main"));
});

test("T7c. 输出引用 kubernetes_namespace / kubernetes_service / kubernetes_deployment", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  const outputsTf = templates.find((t) => t.filePath === "outputs.tf")!;
  assert.ok(outputsTf.content.includes("kubernetes_namespace.main.metadata[0].name"));
  assert.ok(outputsTf.content.includes("kubernetes_service.main.metadata[0].name"));
  assert.ok(outputsTf.content.includes("kubernetes_deployment.main.metadata[0].name"));
});

// ============================================================================
// T8. validate() 真实 CLI 调用
// ============================================================================

test('T8a. terraform 命令不存在时返回 valid=false + 错误信息（含"请确认已预装"）', async () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;

  // 临时修改 PATH 使 terraform 命令不可用（非 mock，真实模拟命令缺失场景）
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await generator.validate(mainTf);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    // 错误信息含"terraform"或"请确认已预装"
    const errorMessage = result.errors.join(" ");
    assert.ok(
      errorMessage.includes("terraform") || errorMessage.includes("请确认已预装"),
      `错误信息应含 terraform 或"请确认已预装"，实际：${errorMessage}`
    );
  } finally {
    // 恢复 PATH
    process.env.PATH = originalPath;
  }
});

test("T8b. validate 返回的 validatedBy 为 terraform-validate", async () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  const mainTf = templates.find((t) => t.filePath === "main.tf")!;

  // 临时修改 PATH 使 terraform 命令不可用
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await generator.validate(mainTf);
    assert.equal(result.validatedBy, "terraform-validate");
  } finally {
    process.env.PATH = originalPath;
  }
});

// ============================================================================
// T9. 不可变优先
// ============================================================================

test("T9a. generate() 返回的 IaCTemplate 对象已冻结", () => {
  const generator = new TerraformGenerator();
  const templates = generator.generate(createContext());
  for (const tpl of templates) {
    const frozen: IaCTemplate = tpl;
    assert.equal(Object.isFrozen(frozen), true, `IaCTemplate 未冻结：${tpl.filePath}`);
  }
});
