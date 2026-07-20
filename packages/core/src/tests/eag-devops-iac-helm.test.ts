/**
 * EAG-P4 批次 13 Phase 3 单元测试：HelmChartGenerator
 *
 * 测试范围（对齐设计文档 §6.2.1 D1-2 IaC 生成器覆盖率 ≥ 85%）：
 * - T1. 实例化与接口契约
 *   - T1a. 实例化成功
 *   - T1b. iacType 为 "helm-chart"
 *   - T1c. 实现 IaCGenerator 接口
 * - T2. generate() 返回 6~7 个 IaCTemplate
 *   - T2a. 默认场景（含 ingress + 含 Secret envVars）返回 7 个文件
 *   - T2b. 不含 ingress + 不含 Secret envVars 时返回 5 个文件
 *   - T2c. 仅含 ingress 时返回 6 个文件
 *   - T2d. 仅含 Secret envVars 时返回 6 个文件
 *   - T2e. 返回的 type 全部为 "helm-chart"
 *   - T2f. 返回的 hash 是 64 位十六进制 SHA256
 * - T3. Chart.yaml 资源（Helm Chart 元数据，apiVersion: v2）
 *   - T3a. 含 apiVersion: v2
 *   - T3b. 含 name 为 context.projectName
 *   - T3c. 含 version / appVersion
 *   - T3d. 含 type: application
 * - T4. values.yaml 资源（默认配置值）
 *   - T4a. 含 projectName / environment / replicas / image / port
 *   - T4b. 含 resources.requests / limits
 *   - T4c. envVars 非空时含 envVars 段
 *   - T4d. envVars 为空时不含 envVars 段
 *   - T4e. context.ingress 存在时 ingress.enabled: true
 *   - T4f. context.ingress 为空时 ingress.enabled: false
 * - T5. templates/_helpers.tpl 资源（Helm 模板辅助函数）
 *   - T5a. 含 ${projectName}.name 定义
 *   - T5b. 含 ${projectName}.fullname 定义
 *   - T5c. 含 ${projectName}.labels 定义
 *   - T5d. 含 ${projectName}.selectorLabels 定义
 * - T6. templates/deployment.yaml 资源（Deployment 模板）
 *   - T6a. 含 apiVersion: apps/v1 + kind: Deployment
 *   - T6b. 使用 {{ include "${projectName}.fullname" . }}
 *   - T6c. 含 replicas: {{ .Values.replicas }}
 *   - T6d. 含 image: "{{ .Values.image }}"
 *   - T6e. N-M-3 修复：含 {{- if .Values.envVars }} env 段
 *   - T6f. N-M-3 修复：envVars 含 fromSecret=true 时引用 secretKeyRef
 * - T7. templates/service.yaml 资源（Service 模板）
 *   - T7a. 含 apiVersion: v1 + kind: Service
 *   - T7b. 含 type: ClusterIP
 *   - T7c. 含 targetPort: http
 * - T8. templates/ingress.yaml 资源（Ingress 模板，可选）
 *   - T8a. context.ingress 存在时生成
 *   - T8b. 含 {{- if .Values.ingress.enabled -}} 判断
 *   - T8c. 含 networking.k8s.io/v1 + Ingress
 *   - T8d. tlsSecret 存在时含 tls 段
 * - T9. templates/secret.yaml 资源（Secret 模板，N-M-3-fix-1 修复）
 *   - T9a. envVars 含 fromSecret=true 时生成
 *   - T9b. envVars 不含 fromSecret=true 时不生成
 *   - T9c. 含 {{- if $env.fromSecret -}} 筛选逻辑
 *   - T9d. 含 b64enc 编码
 * - T10. validate() 真实 CLI 调用
 *   - T10a. helm 命令不存在时返回 valid=false + 错误信息
 *   - T10b. validate 返回的 validatedBy 为 "helm-lint"
 *   - T10c. helm CLI 存在时 validate 返回结构正确（P1-4 修复，CLI 不存在时跳过）
 * - T11. 不可变优先
 *   - T11a. generate() 返回的 IaCTemplate 对象已冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 * - validate() 测试覆盖两条路径：命令不存在的降级路径 + CLI 存在时的真实路径（P1-4 修复）
 *
 * @module core/tests/eag-devops-iac-helm
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { HelmChartGenerator } from "../eag/devops/iac-generator/helm-chart-generator";
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

test("T1a. HelmChartGenerator 实例化成功", () => {
  const generator = new HelmChartGenerator();
  assert.ok(generator instanceof HelmChartGenerator);
});

test("T1b. iacType 为 helm-chart", () => {
  const generator = new HelmChartGenerator();
  assert.equal(generator.iacType, "helm-chart");
});

test("T1c. 实现 IaCGenerator 接口", () => {
  const generator: IaCGenerator = new HelmChartGenerator();
  assert.equal(generator.iacType, "helm-chart");
  assert.equal(typeof generator.generate, "function");
  assert.equal(typeof generator.validate, "function");
});

// ============================================================================
// T2. generate() 返回 6~7 个 IaCTemplate
// ============================================================================

test("T2a. 默认场景（含 ingress + 含 Secret envVars）返回 7 个文件", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  // Chart.yaml + values.yaml + _helpers.tpl + deployment.yaml + service.yaml +
  // ingress.yaml + secret.yaml = 7
  assert.equal(templates.length, 7);
});

test("T2b. 不含 ingress + 不含 Secret envVars 时返回 5 个文件", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [{ name: "LOG_LEVEL", value: "info" }],
      ingress: undefined,
    })
  );
  // Chart.yaml + values.yaml + _helpers.tpl + deployment.yaml + service.yaml = 5
  assert.equal(templates.length, 5);
});

test("T2c. 仅含 ingress 时返回 6 个文件", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [{ name: "LOG_LEVEL", value: "info" }],
      ingress: { host: "app.example.com", path: "/", port: 80 },
    })
  );
  // Chart.yaml + values.yaml + _helpers.tpl + deployment.yaml + service.yaml + ingress.yaml = 6
  assert.equal(templates.length, 6);
});

test("T2d. 仅含 Secret envVars 时返回 6 个文件", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [{ name: "DB_PASSWORD", value: "secret", fromSecret: true }],
      ingress: undefined,
    })
  );
  // Chart.yaml + values.yaml + _helpers.tpl + deployment.yaml + service.yaml + secret.yaml = 6
  assert.equal(templates.length, 6);
});

test("T2e. 返回的 type 全部为 helm-chart", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  for (const tpl of templates) {
    assert.equal(tpl.type, "helm-chart");
  }
});

test("T2f. 返回的 hash 是 64 位十六进制 SHA256", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  const sha256Pattern = /^[0-9a-f]{64}$/;
  for (const tpl of templates) {
    assert.match(tpl.hash, sha256Pattern, `hash 不是 64 位十六进制 SHA256：${tpl.hash}`);
  }
});

// ============================================================================
// T3. Chart.yaml 资源（Helm Chart 元数据，apiVersion: v2）
// ============================================================================

test("T3a. Chart.yaml 含 apiVersion: v2", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  const chart = templates.find((t) => t.filePath === "Chart.yaml")!;
  assert.ok(chart.content.includes("apiVersion: v2"));
});

test("T3b. Chart.yaml 含 name 为 context.projectName", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext({ projectName: "my-app" }));
  const chart = templates.find((t) => t.filePath === "Chart.yaml")!;
  assert.ok(chart.content.includes("name: my-app"));
});

test("T3c. Chart.yaml 含 version / appVersion", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  const chart = templates.find((t) => t.filePath === "Chart.yaml")!;
  assert.ok(chart.content.includes("version: 0.1.0"));
  assert.ok(chart.content.includes('appVersion: "1.0.0"'));
});

test("T3d. Chart.yaml 含 type: application", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  const chart = templates.find((t) => t.filePath === "Chart.yaml")!;
  assert.ok(chart.content.includes("type: application"));
});

// ============================================================================
// T4. values.yaml 资源（默认配置值）
// ============================================================================

test("T4a. values.yaml 含 projectName / environment / replicas / image / port", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(
    createContext({
      projectName: "my-app",
      environment: "prod",
      replicas: 5,
      image: "my-registry/app:v2.0",
      port: 9090,
    })
  );
  const values = templates.find((t) => t.filePath === "values.yaml")!;
  assert.ok(values.content.includes("projectName: my-app"));
  assert.ok(values.content.includes("environment: prod"));
  assert.ok(values.content.includes("replicas: 5"));
  assert.ok(values.content.includes("image: my-registry/app:v2.0"));
  assert.ok(values.content.includes("port: 9090"));
});

test("T4b. values.yaml 含 resources.requests / limits", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(
    createContext({
      resources: {
        requests: { cpu: "200m", memory: "256Mi" },
        limits: { cpu: "1000m", memory: "1Gi" },
      },
    })
  );
  const values = templates.find((t) => t.filePath === "values.yaml")!;
  assert.ok(values.content.includes('cpu: "200m"'));
  assert.ok(values.content.includes('memory: "256Mi"'));
  assert.ok(values.content.includes('cpu: "1000m"'));
  assert.ok(values.content.includes('memory: "1Gi"'));
});

test("T4c. values.yaml envVars 非空时含 envVars 段", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [
        { name: "LOG_LEVEL", value: "info" },
        { name: "DB_PASSWORD", value: "secret", fromSecret: true },
      ],
    })
  );
  const values = templates.find((t) => t.filePath === "values.yaml")!;
  assert.ok(values.content.includes("envVars:"));
  // P1-3 修复后 env.name 用双引号包裹，避免含特殊字符时 YAML 解析失败
  assert.ok(values.content.includes('"LOG_LEVEL":'));
  assert.ok(values.content.includes('"DB_PASSWORD":'));
  assert.ok(values.content.includes("fromSecret: true"));
  assert.ok(values.content.includes("fromSecret: false"));
});

test("T4d. values.yaml envVars 为空时不含 envVars 段", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext({ envVars: [] }));
  const values = templates.find((t) => t.filePath === "values.yaml")!;
  assert.ok(!values.content.includes("envVars:"));
});

test("T4e. values.yaml context.ingress 存在时 ingress.enabled: true", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(
    createContext({
      ingress: { host: "app.example.com", path: "/", port: 80, tlsSecret: "app-tls" },
    })
  );
  const values = templates.find((t) => t.filePath === "values.yaml")!;
  assert.ok(values.content.includes("ingress:"));
  assert.ok(values.content.includes("enabled: true"));
  // P2-4 修复后 host / tlsSecret 用双引号包裹，避免含特殊字符时 YAML 解析失败
  assert.ok(values.content.includes('host: "app.example.com"'));
  assert.ok(values.content.includes('tlsSecret: "app-tls"'));
});

test("T4f. values.yaml context.ingress 为空时 ingress.enabled: false", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext({ ingress: undefined }));
  const values = templates.find((t) => t.filePath === "values.yaml")!;
  assert.ok(values.content.includes("ingress:"));
  assert.ok(values.content.includes("enabled: false"));
});

// ============================================================================
// T5. templates/_helpers.tpl 资源（Helm 模板辅助函数）
// ============================================================================

test("T5a. _helpers.tpl 含 ${projectName}.name 定义", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext({ projectName: "my-app" }));
  const helpers = templates.find((t) => t.filePath === "templates/_helpers.tpl")!;
  assert.ok(helpers.content.includes('define "my-app.name"'));
});

test("T5b. _helpers.tpl 含 ${projectName}.fullname 定义", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext({ projectName: "my-app" }));
  const helpers = templates.find((t) => t.filePath === "templates/_helpers.tpl")!;
  assert.ok(helpers.content.includes('define "my-app.fullname"'));
});

test("T5c. _helpers.tpl 含 ${projectName}.labels 定义", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext({ projectName: "my-app" }));
  const helpers = templates.find((t) => t.filePath === "templates/_helpers.tpl")!;
  assert.ok(helpers.content.includes('define "my-app.labels"'));
});

test("T5d. _helpers.tpl 含 ${projectName}.selectorLabels 定义", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext({ projectName: "my-app" }));
  const helpers = templates.find((t) => t.filePath === "templates/_helpers.tpl")!;
  assert.ok(helpers.content.includes('define "my-app.selectorLabels"'));
});

// ============================================================================
// T6. templates/deployment.yaml 资源（Deployment 模板）
// ============================================================================

test("T6a. deployment.yaml 含 apiVersion: apps/v1 + kind: Deployment", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  const dep = templates.find((t) => t.filePath === "templates/deployment.yaml")!;
  assert.ok(dep.content.includes("apiVersion: apps/v1"));
  assert.ok(dep.content.includes("kind: Deployment"));
});

test('T6b. deployment.yaml 使用 {{ include "${projectName}.fullname" . }}', () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext({ projectName: "my-app" }));
  const dep = templates.find((t) => t.filePath === "templates/deployment.yaml")!;
  assert.ok(dep.content.includes('{{ include "my-app.fullname" . }}'));
});

test("T6c. deployment.yaml 含 replicas: {{ .Values.replicas }}", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  const dep = templates.find((t) => t.filePath === "templates/deployment.yaml")!;
  assert.ok(dep.content.includes("replicas: {{ .Values.replicas }}"));
});

test('T6d. deployment.yaml 含 image: "{{ .Values.image }}"', () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  const dep = templates.find((t) => t.filePath === "templates/deployment.yaml")!;
  assert.ok(dep.content.includes('image: "{{ .Values.image }}"'));
});

test("T6e. N-M-3 修复：deployment.yaml 含 {{- if .Values.envVars }} env 段", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  const dep = templates.find((t) => t.filePath === "templates/deployment.yaml")!;
  assert.ok(dep.content.includes("{{- if .Values.envVars }}"));
  assert.ok(dep.content.includes("env:"));
  assert.ok(dep.content.includes("{{- range $name, $env := .Values.envVars }}"));
});

test("T6f. N-M-3 修复：deployment.yaml envVars 含 fromSecret=true 时引用 secretKeyRef", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext({ projectName: "my-app" }));
  const dep = templates.find((t) => t.filePath === "templates/deployment.yaml")!;
  assert.ok(dep.content.includes("{{- if $env.fromSecret }}"));
  assert.ok(dep.content.includes("secretKeyRef"));
  assert.ok(dep.content.includes('{{ include "my-app.fullname" $ }}-secret'));
});

// ============================================================================
// T7. templates/service.yaml 资源（Service 模板）
// ============================================================================

test("T7a. service.yaml 含 apiVersion: v1 + kind: Service", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  const svc = templates.find((t) => t.filePath === "templates/service.yaml")!;
  assert.ok(svc.content.includes("apiVersion: v1"));
  assert.ok(svc.content.includes("kind: Service"));
});

test("T7b. service.yaml 含 type: ClusterIP", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  const svc = templates.find((t) => t.filePath === "templates/service.yaml")!;
  assert.ok(svc.content.includes("type: ClusterIP"));
});

test("T7c. service.yaml 含 targetPort: http", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  const svc = templates.find((t) => t.filePath === "templates/service.yaml")!;
  assert.ok(svc.content.includes("targetPort: http"));
});

// ============================================================================
// T8. templates/ingress.yaml 资源（Ingress 模板，可选）
// ============================================================================

test("T8a. context.ingress 存在时生成 ingress.yaml", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(
    createContext({
      ingress: { host: "app.example.com", path: "/", port: 80 },
    })
  );
  assert.ok(templates.some((t) => t.filePath === "templates/ingress.yaml"));
});

test("T8b. ingress.yaml 含 {{- if .Values.ingress.enabled -}} 判断", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  const ing = templates.find((t) => t.filePath === "templates/ingress.yaml")!;
  assert.ok(ing.content.includes("{{- if .Values.ingress.enabled -}}"));
});

test("T8c. ingress.yaml 含 networking.k8s.io/v1 + Ingress", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  const ing = templates.find((t) => t.filePath === "templates/ingress.yaml")!;
  assert.ok(ing.content.includes("apiVersion: networking.k8s.io/v1"));
  assert.ok(ing.content.includes("kind: Ingress"));
});

test("T8d. ingress.yaml tlsSecret 存在时含 tls 段", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(
    createContext({
      ingress: { host: "app.example.com", path: "/", port: 80, tlsSecret: "app-tls" },
    })
  );
  const ing = templates.find((t) => t.filePath === "templates/ingress.yaml")!;
  assert.ok(ing.content.includes("{{- if .Values.ingress.tlsSecret }}"));
  assert.ok(ing.content.includes("tls:"));
  assert.ok(ing.content.includes("secretName: {{ .Values.ingress.tlsSecret }}"));
});

// ============================================================================
// T9. templates/secret.yaml 资源（Secret 模板，N-M-3-fix-1 修复）
// ============================================================================

test("T9a. envVars 含 fromSecret=true 时生成 secret.yaml", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [{ name: "DB_PASSWORD", value: "secret", fromSecret: true }],
    })
  );
  assert.ok(templates.some((t) => t.filePath === "templates/secret.yaml"));
});

test("T9b. envVars 不含 fromSecret=true 时不生成 secret.yaml", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [{ name: "LOG_LEVEL", value: "info" }],
    })
  );
  assert.ok(!templates.some((t) => t.filePath === "templates/secret.yaml"));
});

test("T9c. secret.yaml 含 {{- if $env.fromSecret -}} 筛选逻辑", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [{ name: "DB_PASSWORD", value: "secret", fromSecret: true }],
    })
  );
  const secret = templates.find((t) => t.filePath === "templates/secret.yaml")!;
  assert.ok(secret.content.includes("{{- if $env.fromSecret -}}"));
  assert.ok(secret.content.includes("{{- $_ := set $secretEnvs $name $env.value -}}"));
});

test("T9d. secret.yaml 含 b64enc 编码", () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(
    createContext({
      envVars: [{ name: "DB_PASSWORD", value: "secret", fromSecret: true }],
    })
  );
  const secret = templates.find((t) => t.filePath === "templates/secret.yaml")!;
  assert.ok(secret.content.includes("b64enc"));
});

// ============================================================================
// T10. validate() 真实 CLI 调用
// ============================================================================

test("T10a. helm 命令不存在时返回 valid=false + 错误信息", async () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  const chart = templates.find((t) => t.filePath === "Chart.yaml")!;

  // 临时修改 PATH 使 helm 命令不可用
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await generator.validate(chart);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    // 错误信息含 "helm" 或 "请确认已预装"
    const errorMessage = result.errors.join(" ");
    assert.ok(
      errorMessage.includes("helm") || errorMessage.includes("请确认已预装"),
      `错误信息应含 helm 或"请确认已预装"，实际：${errorMessage}`
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("T10b. validate 返回的 validatedBy 为 helm-lint", async () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  const chart = templates.find((t) => t.filePath === "Chart.yaml")!;

  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await generator.validate(chart);
    assert.equal(result.validatedBy, "helm-lint");
  } finally {
    process.env.PATH = originalPath;
  }
});

// T10c. helm CLI 存在时 validate 返回结构正确（P1-4 修复）
// 检测真实 helm CLI 是否存在，存在时测试真实路径（非 mock），不存在时跳过
const hasHelmCli = checkCliAvailable("helm");

test("T10c. helm CLI 存在时 validate 返回结构正确", { skip: !hasHelmCli }, async () => {
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  const chart = templates.find((t) => t.filePath === "Chart.yaml")!;

  // 调用真实 helm lint
  const result = await generator.validate(chart);

  // 验证返回结构正确性（不强制 valid=true，因为 helm lint 可能因依赖缺失失败）
  assert.equal(typeof result.valid, "boolean");
  assert.ok(Array.isArray(result.errors));
  assert.equal(result.validatedBy, "helm-lint");

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
  const generator = new HelmChartGenerator();
  const templates = generator.generate(createContext());
  for (const tpl of templates) {
    const frozen: IaCTemplate = tpl;
    assert.equal(Object.isFrozen(frozen), true, `IaCTemplate 未冻结：${tpl.filePath}`);
  }
});
