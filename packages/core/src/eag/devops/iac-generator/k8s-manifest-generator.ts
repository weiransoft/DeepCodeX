/**
 * K8sManifestGenerator —— Kubernetes Manifest YAML 生成器（EAG-P4 批次 13 Phase 3 D1-2）
 *
 * 本模块实现 `K8sManifestGenerator` 类，对应 EAG-P4 批次 13 设计文档 §3.5.3 D1-2 K8s Manifest 生成器：
 * "K8sManifestGenerator —— Kubernetes Manifest YAML 生成器，产出 namespace/configmap/secret/deployment/service/ingress 6 种资源"。
 *
 * 产出文件（共 6 种资源类型，满足 D1-2 验收标准"每个生成器支持 ≥ 5 种资源类型"）：
 * - namespace.yaml: Namespace 资源（v1）
 * - configmap.yaml: ConfigMap 资源（v1，含非敏感环境变量）
 * - secret.yaml: Secret 资源（v1，含敏感环境变量，fromSecret=true 的）
 * - deployment.yaml: Deployment 资源（apps/v1，含 replicas / container / resources / envVars）
 * - service.yaml: Service 资源（v1，ClusterIP 类型）
 * - ingress.yaml: Ingress 资源（networking.k8s.io/v1，可选，context.ingress 非空时生成）
 *
 * 真实 CLI 校验：
 * - validate() 调用 `kubectl apply --dry-run=client -f <file> -o json` 校验 YAML 语法与 API 对象合法性
 * - 要求用户环境预装 kubectl CLI
 * - 实现步骤：创建临时目录 → 写入 .yaml 文件 → kubectl apply --dry-run=client → 解析输出 → 清理临时目录
 *
 * B-5 修复说明（设计文档 §3.5.3 L1503）：
 * - 完整实现 K8sManifestGenerator，不再省略
 * - 6 种资源类型完整覆盖：Namespace / ConfigMap / Secret / Deployment / Service / Ingress
 *
 * B-7 修复说明（设计文档 §3.5.3 L1828）：
 * - IngressConfig 添加 port 字段，generateIngress 使用 ingress.port
 *
 * 设计依据：
 * - EAG-P4 批次 13 设计文档 §3.5.3 D1-2 K8s Manifest 生成器
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先，返回值 Object.freeze）
 * - B-5 修复：完整实现，不再省略
 * - B-7 修复：IngressConfig 添加 port 字段
 *
 * @module eag/devops/iac-generator/k8s-manifest-generator
 */

import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { IaCTemplate, IaCGenerationContext, IaCValidationResult, EnvVar, IngressConfig } from "../types";
import type { IaCGenerator } from "../types";

/**
 * Kubernetes Manifest YAML 生成器
 *
 * 实现 §3.5.3 D1-2 K8s Manifest 生成器：产出 6 种 K8s 资源 YAML 文件，
 * 通过 kubectl apply --dry-run=client 校验 YAML 语法与 API 对象合法性。
 *
 * 使用方式：
 *   const generator = new K8sManifestGenerator();
 *   const templates = generator.generate(context);
 *   for (const tpl of templates) {
 *     const result = await generator.validate(tpl);
 *     if (!result.valid) { console.error(result.errors); }
 *   }
 */
export class K8sManifestGenerator implements IaCGenerator {
  /** IaC 类型标识（固定为 "k8s-manifest"） */
  public readonly iacType = "k8s-manifest" as const;

  /**
   * 生成 K8s Manifest 模板
   *
   * 产出 IaCTemplate 数组（5~6 个文件，ingress 可选）：
   * 1. namespace.yaml —— Namespace 资源（始终生成）
   * 2. configmap.yaml —— ConfigMap 资源（存在非 Secret 环境变量时生成）
   * 3. secret.yaml —— Secret 资源（存在 fromSecret=true 环境变量时生成）
   * 4. deployment.yaml —— Deployment 资源（始终生成）
   * 5. service.yaml —— Service 资源（始终生成）
   * 6. ingress.yaml —— Ingress 资源（context.ingress 非空时生成）
   *
   * 不可变优先（§5.12.4 G-A6d）：
   * - 返回的 IaCTemplate 对象通过 Object.freeze 冻结
   * - 返回的数组本身通过 Object.freeze 冻结
   * - 防止调用方意外修改生成产物，保证审计可追溯性
   *
   * @param context IaC 生成上下文
   * @returns IaC 模板数组（5~6 个文件，ingress 可选），全部冻结
   */
  public generate(context: IaCGenerationContext): IaCTemplate[] {
    // 生成时间戳（同批次文件共用，便于追溯）
    const generatedAt = new Date().toISOString();
    const templates: IaCTemplate[] = [];

    // 1. namespace.yaml（始终生成）
    const namespaceContent = this.generateNamespace(context);
    templates.push(
      Object.freeze({
        type: "k8s-manifest",
        content: namespaceContent,
        filePath: "namespace.yaml",
        hash: this.computeHash(namespaceContent),
        generatedAt,
      }) as IaCTemplate
    );

    // 2. configmap.yaml（非敏感环境变量，fromSecret != true 的）
    const nonSecretEnvs = context.envVars.filter((env) => !env.fromSecret);
    if (nonSecretEnvs.length > 0) {
      const configMapContent = this.generateConfigMap(context, nonSecretEnvs);
      templates.push(
        Object.freeze({
          type: "k8s-manifest",
          content: configMapContent,
          filePath: "configmap.yaml",
          hash: this.computeHash(configMapContent),
          generatedAt,
        }) as IaCTemplate
      );
    }

    // 3. secret.yaml（敏感环境变量，fromSecret=true 的）
    const secretEnvs = context.envVars.filter((env) => env.fromSecret);
    if (secretEnvs.length > 0) {
      const secretContent = this.generateSecret(context, secretEnvs);
      templates.push(
        Object.freeze({
          type: "k8s-manifest",
          content: secretContent,
          filePath: "secret.yaml",
          hash: this.computeHash(secretContent),
          generatedAt,
        }) as IaCTemplate
      );
    }

    // 4. deployment.yaml（始终生成）
    const deploymentContent = this.generateDeployment(context);
    templates.push(
      Object.freeze({
        type: "k8s-manifest",
        content: deploymentContent,
        filePath: "deployment.yaml",
        hash: this.computeHash(deploymentContent),
        generatedAt,
      }) as IaCTemplate
    );

    // 5. service.yaml（始终生成）
    const serviceContent = this.generateService(context);
    templates.push(
      Object.freeze({
        type: "k8s-manifest",
        content: serviceContent,
        filePath: "service.yaml",
        hash: this.computeHash(serviceContent),
        generatedAt,
      }) as IaCTemplate
    );

    // 6. ingress.yaml（可选，context.ingress 非空时生成）
    if (context.ingress) {
      const ingressContent = this.generateIngress(context, context.ingress);
      templates.push(
        Object.freeze({
          type: "k8s-manifest",
          content: ingressContent,
          filePath: "ingress.yaml",
          hash: this.computeHash(ingressContent),
          generatedAt,
        }) as IaCTemplate
      );
    }

    // 冻结数组本身（防止调用方 push/splice 修改数组结构）
    return Object.freeze(templates) as ReadonlyArray<IaCTemplate> as IaCTemplate[];
  }

  /**
   * 校验 K8s Manifest 模板（B-5 修复：完整实现）
   *
   * 调用 `kubectl apply --dry-run=client -f <file> -o json` 校验 YAML 语法与 API 对象合法性
   * 要求用户环境预装 kubectl CLI
   *
   * 实现步骤：
   * 1. 创建临时目录（fs.mkdtempSync，前缀 eag-k8s-validate-）
   * 2. 写入 .yaml 文件
   * 3. 调用 kubectl apply --dry-run=client -f <file> -o json
   * 4. 解析输出（成功则 valid=true，失败则解析 stderr 中的错误信息）
   * 5. 清理临时目录
   *
   * @param template IaC 模板（单个 .yaml 文件）
   * @returns 校验结果（含 valid / errors / validatedBy）
   */
  public async validate(template: IaCTemplate): Promise<IaCValidationResult> {
    // Step 1: 创建临时目录
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-k8s-validate-"));

    try {
      // Step 2: 写入 .yaml 文件
      const targetFile = path.join(tmpDir, template.filePath);
      fs.writeFileSync(targetFile, template.content, "utf8");

      // Step 3: 调用 kubectl apply --dry-run=client -f <file> -o json
      // --dry-run=client：仅在客户端校验，不发送到 API server
      // -o json：JSON 格式输出，便于解析
      const result = await this.spawnKubectlCommand(["apply", "--dry-run=client", "-f", targetFile, "-o", "json"]);

      // Step 4: 解析输出
      if (!result.success) {
        // kubectl 失败：尝试解析 stderr 中的 JSON 错误信息
        const errors: string[] = [];
        try {
          const output = JSON.parse(result.stderr || "{}");
          if (output.message) {
            errors.push(output.message);
          } else if (output.details) {
            errors.push(JSON.stringify(output.details));
          } else {
            errors.push(result.stderr || "未知错误");
          }
        } catch {
          // stderr 不是 JSON：直接使用原始输出
          errors.push(result.stderr || "kubectl dry-run 失败，且输出无法解析");
        }
        return {
          valid: false,
          errors: Object.freeze(errors) as ReadonlyArray<string>,
          validatedBy: "kubectl-dry-run",
        };
      }

      // kubectl 成功：valid=true
      return {
        valid: true,
        errors: [],
        validatedBy: "kubectl-dry-run",
      };
    } finally {
      // Step 5: 清理临时目录
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响校验结果
      }
    }
  }

  /**
   * 调用 kubectl CLI 命令的辅助方法
   *
   * 使用 child_process.spawn 启动子进程执行 kubectl 命令，捕获 stdout / stderr。
   *
   * @param args 命令参数（如 ["apply", "--dry-run=client", "-f", file]）
   * @returns 包含 success / stdout / stderr 的结果对象
   */
  private spawnKubectlCommand(
    args: ReadonlyArray<string>
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      // 启动 kubectl 子进程（继承 process.env）
      const child = spawn("kubectl", [...args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      let stdout = "";
      let stderr = "";

      // 捕获 stdout 输出
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      // 捕获 stderr 输出
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      // 子进程正常退出
      child.on("close", (code: number | null) => {
        resolve({ success: code === 0, stdout, stderr });
      });
      // 子进程启动失败（如 kubectl 命令不存在）
      child.on("error", (err: Error) => {
        resolve({
          success: false,
          stdout: "",
          stderr: `kubectl 命令执行失败：${err.message}（请确认已预装 kubectl CLI）`,
        });
      });
    });
  }

  /**
   * 生成 Namespace 资源 YAML
   *
   * @param context IaC 生成上下文
   * @returns namespace.yaml 内容
   */
  private generateNamespace(context: IaCGenerationContext): string {
    return `# 由 EAG DevOpsOrchestrator 自动生成
apiVersion: v1
kind: Namespace
metadata:
  name: ${context.projectName}
  labels:
    environment: ${context.environment}
    managed-by: eag-devops
`;
  }

  /**
   * 生成 ConfigMap 资源 YAML（非敏感环境变量）
   *
   * 仅包含 fromSecret != true 的环境变量（明文环境变量）。
   * 敏感环境变量（fromSecret=true）通过 Secret 资源单独管理。
   *
   * @param context IaC 生成上下文
   * @param envs 非敏感环境变量列表
   * @returns configmap.yaml 内容
   */
  private generateConfigMap(context: IaCGenerationContext, envs: ReadonlyArray<EnvVar>): string {
    // 构造 data 段（每个环境变量一行）
    const dataEntries = envs.map((env) => `  ${env.name}: "${env.value}"`).join("\n");
    return `# 由 EAG DevOpsOrchestrator 自动生成
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${context.projectName}-config
  namespace: ${context.projectName}
data:
${dataEntries}
`;
  }

  /**
   * 生成 Secret 资源 YAML（敏感环境变量，base64 编码）
   *
   * 仅包含 fromSecret=true 的环境变量。
   * K8s Secret 的 data 字段要求 base64 编码，使用 Buffer.toString("base64") 编码。
   *
   * @param context IaC 生成上下文
   * @param envs 敏感环境变量列表（fromSecret=true）
   * @returns secret.yaml 内容
   */
  private generateSecret(context: IaCGenerationContext, envs: ReadonlyArray<EnvVar>): string {
    // 构造 data 段（每个环境变量 base64 编码后一行）
    const dataEntries = envs
      .map((env) => {
        // Secret 的 value 需要 base64 编码（K8s Secret 规范）
        const encoded = Buffer.from(env.value, "utf8").toString("base64");
        return `  ${env.name}: "${encoded}"`;
      })
      .join("\n");
    return `# 由 EAG DevOpsOrchestrator 自动生成
apiVersion: v1
kind: Secret
metadata:
  name: ${context.projectName}-secret
  namespace: ${context.projectName}
type: Opaque
data:
${dataEntries}
`;
  }

  /**
   * 生成 Deployment 资源 YAML
   *
   * 包含：
   * - metadata（name / namespace / labels）
   * - spec.replicas
   * - spec.selector.matchLabels
   * - spec.template.metadata.labels
   * - spec.template.spec.containers（name / image / ports / resources / env）
   *
   * 环境变量引用块：
   * - fromSecret=true：使用 secretKeyRef 引用 ${projectName}-secret
   * - fromSecret=false：使用 configMapKeyRef 引用 ${projectName}-config
   *
   * @param context IaC 生成上下文
   * @returns deployment.yaml 内容
   */
  private generateDeployment(context: IaCGenerationContext): string {
    const { projectName, environment, replicas, image, port, resources, envVars } = context;

    // 环境变量引用块（ConfigMap / Secret 引用）
    // envVars 为空时不生成 env 段，避免空行
    const envBlock =
      envVars.length > 0
        ? "\n        env:" +
          envVars
            .map((env) => {
              if (env.fromSecret) {
                // Secret 引用：secretKeyRef
                return `\n        - name: ${env.name}\n          valueFrom:\n            secretKeyRef:\n              name: ${projectName}-secret\n              key: ${env.name}`;
              } else {
                // ConfigMap 引用：configMapKeyRef
                return `\n        - name: ${env.name}\n          valueFrom:\n            configMapKeyRef:\n              name: ${projectName}-config\n              key: ${env.name}`;
              }
            })
            .join("")
        : "";

    return `# 由 EAG DevOpsOrchestrator 自动生成
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${projectName}
  namespace: ${projectName}
  labels:
    app: ${projectName}
    environment: ${environment}
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: ${projectName}
  template:
    metadata:
      labels:
        app: ${projectName}
        environment: ${environment}
    spec:
      containers:
      - name: ${projectName}
        image: ${image}
        ports:
        - containerPort: ${port}
        resources:
          requests:
            cpu: "${resources.requests.cpu}"
            memory: "${resources.requests.memory}"
          limits:
            cpu: "${resources.limits.cpu}"
            memory: "${resources.limits.memory}"${envBlock}
`;
  }

  /**
   * 生成 Service 资源 YAML
   *
   * 默认类型 ClusterIP（集群内部访问），端口映射 port → targetPort。
   *
   * @param context IaC 生成上下文
   * @returns service.yaml 内容
   */
  private generateService(context: IaCGenerationContext): string {
    const { projectName, port } = context;
    return `# 由 EAG DevOpsOrchestrator 自动生成
apiVersion: v1
kind: Service
metadata:
  name: ${projectName}
  namespace: ${projectName}
spec:
  selector:
    app: ${projectName}
  ports:
  - port: ${port}
    targetPort: ${port}
    protocol: TCP
  type: ClusterIP
`;
  }

  /**
   * 生成 Ingress 资源 YAML（B-7 修复：使用 ingress.port）
   *
   * @param context IaC 生成上下文
   * @param ingress Ingress 配置
   * @returns ingress.yaml 内容
   */
  private generateIngress(context: IaCGenerationContext, ingress: IngressConfig): string {
    const { projectName } = context;
    // TLS 块（可选，tlsSecret 存在时启用 HTTPS）
    const tlsBlock = ingress.tlsSecret
      ? `
  tls:
  - hosts:
    - ${ingress.host}
    secretName: ${ingress.tlsSecret}
`
      : "";

    return `# 由 EAG DevOpsOrchestrator 自动生成
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${projectName}
  namespace: ${projectName}
spec:${tlsBlock}
  rules:
  - host: ${ingress.host}
    http:
      paths:
      - path: ${ingress.path}
        pathType: Prefix
        backend:
          service:
            name: ${projectName}
            port:
              number: ${ingress.port}
`;
  }

  /**
   * 计算内容 SHA256 哈希
   *
   * @param content 模板内容
   * @returns SHA256 哈希字符串（64 位十六进制）
   */
  private computeHash(content: string): string {
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
  }
}
