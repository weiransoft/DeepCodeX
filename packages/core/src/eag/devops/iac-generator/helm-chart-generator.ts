/**
 * HelmChartGenerator —— Helm Chart 模板生成器（EAG-P4 批次 13 Phase 3 D1-2）
 *
 * 本模块实现 `HelmChartGenerator` 类，对应 EAG-P4 批次 13 设计文档 §3.5.4 D1-2 Helm Chart 生成器：
 * "HelmChartGenerator —— Helm Chart 模板生成器，产出 Chart.yaml / values.yaml / templates/_helpers.tpl /
 *  templates/deployment.yaml / templates/service.yaml / templates/ingress.yaml / templates/secret.yaml"。
 *
 * 产出文件（共 6~7 个文件，符合 Helm 3 规范，满足 D1-2 验收标准"每个生成器支持 ≥ 5 种资源类型"）：
 * - Chart.yaml: Helm Chart 元数据（apiVersion: v2）
 * - values.yaml: 默认配置值
 * - templates/_helpers.tpl: 模板辅助函数
 * - templates/deployment.yaml: Deployment 模板
 * - templates/service.yaml: Service 模板
 * - templates/ingress.yaml: Ingress 模板（可选，context.ingress 存在时生成）
 * - templates/secret.yaml: Secret 模板（可选，存在 fromSecret=true 的 envVars 时生成，N-M-3-fix-1）
 *
 * 真实 CLI 校验：
 * - validate() 调用 `helm lint <chart-dir>` 校验 Chart 结构与模板语法
 * - 要求用户环境预装 helm CLI（版本 >= 3.0）
 * - 实现步骤：创建临时 Chart 目录结构 → 写入模板文件 → 写入最小 Chart.yaml 骨架 → helm lint → 清理临时目录
 *
 * N-M-3 修复说明（设计文档 §3.5.4 L2193）：
 * - 原 templates/deployment.yaml 未引用 .Values.envVars，用户配置的环境变量不会注入容器
 * - 修复方案：在 container 块中新增 env 段，遍历 .Values.envVars
 * - 支持 value 字段（明文环境变量）和 fromSecret=true 时的 secretKeyRef 引用
 *
 * N-M-3-fix-1 修复说明（设计文档 §3.5.4 L2308）：
 * - N-M-3 修复中 deployment.yaml 新增了 env 段，引用 secretKeyRef 指向 `${fullname}-secret`
 * - 若不生成对应的 Secret 模板，Pod 会进入 CreateContainerConfigError 状态
 * - 与 K8sManifestGenerator 的 generateSecret() 存在不对称缺口
 * - 修复方案：当存在 fromSecret=true 的环境变量时，生成 templates/secret.yaml 模板
 *
 * 设计依据：
 * - EAG-P4 批次 13 设计文档 §3.5.4 D1-2 Helm Chart 生成器
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先，返回值 Object.freeze）
 * - B-5 修复：完整实现，不再省略
 * - N-M-3 修复：deployment.yaml 引用 .Values.envVars
 * - N-M-3-fix-1 修复：补全 Secret 模板生成
 *
 * @module eag/devops/iac-generator/helm-chart-generator
 */

import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { IaCTemplate, IaCGenerationContext, IaCValidationResult } from "../types";
import type { IaCGenerator } from "../types";

/**
 * Helm Chart 模板生成器
 *
 * 实现 §3.5.4 D1-2 Helm Chart 生成器：产出符合 Helm 3 规范的 Chart 目录结构，
 * 通过 helm lint 校验 Chart 结构与模板语法。
 *
 * 使用方式：
 *   const generator = new HelmChartGenerator();
 *   const templates = generator.generate(context);
 *   for (const tpl of templates) {
 *     const result = await generator.validate(tpl);
 *     if (!result.valid) { console.error(result.errors); }
 *   }
 */
export class HelmChartGenerator implements IaCGenerator {
  /** IaC 类型标识（固定为 "helm-chart"） */
  public readonly iacType = "helm-chart" as const;

  /**
   * 生成 Helm Chart 模板
   *
   * 产出 IaCTemplate 数组（6~7 个文件，ingress / secret 可选）：
   * 1. Chart.yaml —— Helm Chart 元数据（始终生成）
   * 2. values.yaml —— 默认配置值（始终生成）
   * 3. templates/_helpers.tpl —— 模板辅助函数（始终生成）
   * 4. templates/deployment.yaml —— Deployment 模板（始终生成）
   * 5. templates/service.yaml —— Service 模板（始终生成）
   * 6. templates/ingress.yaml —— Ingress 模板（context.ingress 存在时生成）
   * 7. templates/secret.yaml —— Secret 模板（存在 fromSecret=true 的 envVars 时生成，N-M-3-fix-1）
   *
   * 不可变优先（§5.12.4 G-A6d）：
   * - 返回的 IaCTemplate 对象通过 Object.freeze 冻结
   * - 返回的数组本身通过 Object.freeze 冻结
   * - 防止调用方意外修改生成产物，保证审计可追溯性
   *
   * @param context IaC 生成上下文
   * @returns IaC 模板数组（6~7 个文件，ingress / secret 可选），全部冻结
   */
  public generate(context: IaCGenerationContext): IaCTemplate[] {
    // 生成时间戳（同批次文件共用，便于追溯）
    const generatedAt = new Date().toISOString();
    const templates: IaCTemplate[] = [];

    // 1. Chart.yaml（始终生成）
    const chartContent = this.generateChartYaml(context);
    templates.push(
      Object.freeze({
        type: "helm-chart",
        content: chartContent,
        filePath: "Chart.yaml",
        hash: this.computeHash(chartContent),
        generatedAt,
      }) as IaCTemplate
    );

    // 2. values.yaml（始终生成）
    const valuesContent = this.generateValuesYaml(context);
    templates.push(
      Object.freeze({
        type: "helm-chart",
        content: valuesContent,
        filePath: "values.yaml",
        hash: this.computeHash(valuesContent),
        generatedAt,
      }) as IaCTemplate
    );

    // 3. templates/_helpers.tpl（始终生成）
    const helpersContent = this.generateHelpersTpl(context);
    templates.push(
      Object.freeze({
        type: "helm-chart",
        content: helpersContent,
        filePath: "templates/_helpers.tpl",
        hash: this.computeHash(helpersContent),
        generatedAt,
      }) as IaCTemplate
    );

    // 4. templates/deployment.yaml（始终生成）
    const deploymentContent = this.generateDeploymentTemplate(context);
    templates.push(
      Object.freeze({
        type: "helm-chart",
        content: deploymentContent,
        filePath: "templates/deployment.yaml",
        hash: this.computeHash(deploymentContent),
        generatedAt,
      }) as IaCTemplate
    );

    // 5. templates/service.yaml（始终生成）
    const serviceContent = this.generateServiceTemplate(context);
    templates.push(
      Object.freeze({
        type: "helm-chart",
        content: serviceContent,
        filePath: "templates/service.yaml",
        hash: this.computeHash(serviceContent),
        generatedAt,
      }) as IaCTemplate
    );

    // 6. templates/ingress.yaml（可选，context.ingress 存在时生成）
    if (context.ingress) {
      const ingressContent = this.generateIngressTemplate(context);
      templates.push(
        Object.freeze({
          type: "helm-chart",
          content: ingressContent,
          filePath: "templates/ingress.yaml",
          hash: this.computeHash(ingressContent),
          generatedAt,
        }) as IaCTemplate
      );
    }

    // 7. templates/secret.yaml（N-M-3-fix-1 修复：当存在 fromSecret=true 的环境变量时生成）
    // 修复原因：deployment.yaml 的 secretKeyRef 引用 ${fullname}-secret，若不生成对应的 Secret 模板，
    // Pod 会进入 CreateContainerConfigError 状态，与 K8sManifestGenerator 存在不对称缺口
    const hasSecretEnv = context.envVars.some((env) => env.fromSecret);
    if (hasSecretEnv) {
      const secretContent = this.generateSecretTemplate(context);
      templates.push(
        Object.freeze({
          type: "helm-chart",
          content: secretContent,
          filePath: "templates/secret.yaml",
          hash: this.computeHash(secretContent),
          generatedAt,
        }) as IaCTemplate
      );
    }

    // 冻结数组本身（防止调用方 push/splice 修改数组结构）
    return Object.freeze(templates) as ReadonlyArray<IaCTemplate> as IaCTemplate[];
  }

  /**
   * 校验 Helm Chart 模板（B-5 修复：完整实现）
   *
   * 调用 `helm lint <chart-dir>` 校验 Chart 结构与模板语法
   * 要求用户环境预装 helm CLI（版本 >= 3.0）
   *
   * 实现步骤：
   * 1. 创建临时目录（fs.mkdtempSync，前缀 eag-helm-validate-）
   * 2. 构造最小 Chart 目录结构（eag-chart/templates/）
   * 3. 写入当前模板文件到对应位置
   * 4. 若当前模板不是 Chart.yaml，写入最小 Chart.yaml 骨架（helm lint 要求）
   * 5. 调用 helm lint <chart-dir>
   * 6. 解析输出（成功则 valid=true，失败则提取 [ERROR] / error 行）
   * 7. 清理临时目录
   *
   * @param template IaC 模板（单个 Helm Chart 文件）
   * @returns 校验结果（含 valid / errors / validatedBy）
   */
  public async validate(template: IaCTemplate): Promise<IaCValidationResult> {
    // helm lint 需要完整的 Chart 目录结构，单个文件校验不适用
    // 这里实现：构造最小 Chart 目录结构后调用 helm lint
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-helm-validate-"));

    try {
      // Step 2: 构造最小 Chart 目录结构
      const chartDir = path.join(tmpDir, "eag-chart");
      const templatesDir = path.join(chartDir, "templates");
      fs.mkdirSync(templatesDir, { recursive: true });

      // Step 3: 写入当前模板文件到对应位置
      const targetFile = path.join(chartDir, template.filePath);
      const targetDir = path.dirname(targetFile);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      // P1-1 修复（架构师审查）：临时文件权限 0o600，避免其他用户读取含敏感值的 Helm 模板
      fs.writeFileSync(targetFile, template.content, { encoding: "utf8", mode: 0o600 });

      // Step 4: 写入最小 Chart.yaml 骨架（如果当前模板不是 Chart.yaml）
      // helm lint 要求 Chart 目录必须含 Chart.yaml
      if (template.filePath !== "Chart.yaml") {
        const chartYamlPath = path.join(chartDir, "Chart.yaml");
        if (!fs.existsSync(chartYamlPath)) {
          // P1-1 修复（架构师审查）：骨架文件同样使用 0o600 权限
          fs.writeFileSync(chartYamlPath, 'apiVersion: v2\nname: eag-chart\nversion: 0.1.0\nappVersion: "1.0"\n', {
            encoding: "utf8",
            mode: 0o600,
          });
        }
      }

      // Step 5: 调用 helm lint <chart-dir>
      const result = await this.spawnHelmCommand(["lint", chartDir]);

      // Step 6: 解析输出
      if (!result.success) {
        // helm lint 失败：从 stderr + stdout 中提取错误行
        const errors: string[] = [];
        const lines = (result.stderr + result.stdout).split("\n");
        for (const line of lines) {
          // 匹配 [ERROR] 或 error 行
          if (line.includes("[ERROR]") || line.includes("error")) {
            errors.push(line.trim());
          }
        }
        // 如果未提取到错误行，使用原始 stderr
        if (errors.length === 0) {
          errors.push(result.stderr || "helm lint 失败");
        }
        return {
          valid: false,
          errors: Object.freeze(errors) as ReadonlyArray<string>,
          validatedBy: "helm-lint",
        };
      }

      // helm lint 成功：valid=true
      return {
        valid: true,
        errors: [],
        validatedBy: "helm-lint",
      };
    } finally {
      // Step 7: 清理临时目录
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响校验结果
      }
    }
  }

  /**
   * 调用 helm CLI 命令的辅助方法
   *
   * 使用 child_process.spawn 启动子进程执行 helm 命令，捕获 stdout / stderr。
   *
   * @param args 命令参数（如 ["lint", chartDir]）
   * @returns 包含 success / stdout / stderr 的结果对象
   */
  private spawnHelmCommand(args: ReadonlyArray<string>): Promise<{ success: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      // 启动 helm 子进程（继承 process.env）
      const child = spawn("helm", [...args], {
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
      // 子进程启动失败（如 helm 命令不存在）
      child.on("error", (err: Error) => {
        resolve({
          success: false,
          stdout: "",
          stderr: `helm 命令执行失败：${err.message}（请确认已预装 helm CLI >= 3.0）`,
        });
      });
    });
  }

  /**
   * 生成 Chart.yaml
   *
   * Helm Chart 元数据文件，符合 Helm 3 规范（apiVersion: v2）。
   *
   * @param context IaC 生成上下文
   * @returns Chart.yaml 内容
   */
  private generateChartYaml(context: IaCGenerationContext): string {
    return `# 由 EAG DevOpsOrchestrator 自动生成
apiVersion: v2
name: ${context.projectName}
description: A Helm chart for ${context.projectName}
type: application
version: 0.1.0
appVersion: "1.0.0"
maintainers:
- name: EAG DevOpsOrchestrator
`;
  }

  /**
   * 生成 values.yaml
   *
   * 默认配置值文件，含 replicas / image / port / resources / envVars / ingress。
   *
   * @param context IaC 生成上下文
   * @returns values.yaml 内容
   */
  private generateValuesYaml(context: IaCGenerationContext): string {
    const { projectName, environment, replicas, image, port, resources, envVars, ingress } = context;

    // 环境变量段（envVars 为空时不生成）
    // P1-3 修复（架构师审查）：env.name 用双引号包裹，避免含特殊字符（如 "." / "-" / 数字开头）时 YAML 解析失败
    const envVarsYaml =
      envVars.length > 0
        ? "\nenvVars:\n" +
          envVars
            .map((env) => `  "${env.name}":\n    value: "${env.value}"\n    fromSecret: ${env.fromSecret ?? false}`)
            .join("\n")
        : "";

    // Ingress 段（context.ingress 存在时启用，否则禁用）
    // P2-4 修复（架构师审查）：host / path / tlsSecret 用双引号包裹，避免含特殊字符（如 IPv6 冒号）时 YAML 解析失败
    const ingressYaml = ingress
      ? `
ingress:
  enabled: true
  host: "${ingress.host}"
  path: "${ingress.path}"
  port: ${ingress.port}
  tlsSecret: "${ingress.tlsSecret ?? ""}"
`
      : "\ningress:\n  enabled: false\n";

    return `# 由 EAG DevOpsOrchestrator 自动生成
# 默认配置值
projectName: ${projectName}
environment: ${environment}
replicas: ${replicas}
image: ${image}
port: ${port}

resources:
  requests:
    cpu: "${resources.requests.cpu}"
    memory: "${resources.requests.memory}"
  limits:
    cpu: "${resources.limits.cpu}"
    memory: "${resources.limits.memory}"
${envVarsYaml}${ingressYaml}
`;
  }

  /**
   * 生成 templates/_helpers.tpl
   *
   * Helm 模板辅助函数，定义：
   * - ${projectName}.name：Chart 名称
   * - ${projectName}.fullname：完全限定名称
   * - ${projectName}.labels：Chart 标签
   * - ${projectName}.selectorLabels：选择器标签
   *
   * @param context IaC 生成上下文
   * @returns templates/_helpers.tpl 内容
   */
  private generateHelpersTpl(context: IaCGenerationContext): string {
    return `{{/* 由 EAG DevOpsOrchestrator 自动生成 */}}
{{/* Chart 名称 */}}
{{- define "${context.projectName}.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* 完全限定名称 */}}
{{- define "${context.projectName}.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Chart 标签 */}}
{{- define "${context.projectName}.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "${context.projectName}.selectorLabels" . }}
{{- if .Chart.AppVersion -}}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* 选择器标签 */}}
{{- define "${context.projectName}.selectorLabels" -}}
app.kubernetes.io/name: {{ include "${context.projectName}.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
`;
  }

  /**
   * 生成 templates/deployment.yaml（N-M-3 修复：新增 env 段引用 .Values.envVars）
   *
   * 修复原因：
   * - 原模板未引用 .Values.envVars，用户配置的环境变量不会注入容器，功能不完整
   *
   * 修复方案：
   * - 在 container 块中新增 env 段，遍历 .Values.envVars
   * - 支持 value 字段（明文环境变量）和 fromSecret=true 时的 secretKeyRef 引用
   * - envVars 为空时通过 {{- if .Values.envVars }} 跳过 env 段生成，避免空行
   *
   * @param context IaC 生成上下文
   * @returns templates/deployment.yaml 内容
   */
  private generateDeploymentTemplate(context: IaCGenerationContext): string {
    return `{{/* 由 EAG DevOpsOrchestrator 自动生成 */}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "${context.projectName}.fullname" . }}
  labels:
    {{- include "${context.projectName}.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicas }}
  selector:
    matchLabels:
      {{- include "${context.projectName}.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "${context.projectName}.selectorLabels" . | nindent 8 }}
    spec:
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image }}"
          ports:
            - name: http
              containerPort: {{ .Values.port }}
              protocol: TCP
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          {{- /* N-M-3 修复：引用 .Values.envVars 注入环境变量 */ -}}
          {{- if .Values.envVars }}
          env:
            {{- range $name, $env := .Values.envVars }}
            {{- if $env.fromSecret }}
            - name: {{ $name }}
              valueFrom:
                secretKeyRef:
                  name: {{ include "${context.projectName}.fullname" $ }}-secret
                  key: {{ $name }}
            {{- else }}
            - name: {{ $name }}
              value: "{{ $env.value }}"
            {{- end }}
            {{- end }}
          {{- end }}
`;
  }

  /**
   * 生成 templates/service.yaml
   *
   * ClusterIP 类型 Service，端口映射 .Values.port → http（deployment 中的端口名）。
   *
   * @param context IaC 生成上下文
   * @returns templates/service.yaml 内容
   */
  private generateServiceTemplate(context: IaCGenerationContext): string {
    return `{{/* 由 EAG DevOpsOrchestrator 自动生成 */}}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "${context.projectName}.fullname" . }}
  labels:
    {{- include "${context.projectName}.labels" . | nindent 4 }}
spec:
  type: ClusterIP
  ports:
    - port: {{ .Values.port }}
      targetPort: http
      protocol: TCP
      name: http
  selector:
    {{- include "${context.projectName}.selectorLabels" . | nindent 4 }}
`;
  }

  /**
   * 生成 templates/ingress.yaml
   *
   * 仅当 .Values.ingress.enabled=true 时生成。
   * 支持 TLS（.Values.ingress.tlsSecret 存在时启用 HTTPS）。
   *
   * @param context IaC 生成上下文
   * @returns templates/ingress.yaml 内容
   */
  private generateIngressTemplate(context: IaCGenerationContext): string {
    return `{{/* 由 EAG DevOpsOrchestrator 自动生成 */}}
{{- if .Values.ingress.enabled -}}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "${context.projectName}.fullname" . }}
  labels:
    {{- include "${context.projectName}.labels" . | nindent 4 }}
spec:
  {{- if .Values.ingress.tlsSecret }}
  tls:
    - hosts:
        - {{ .Values.ingress.host | quote }}
      secretName: {{ .Values.ingress.tlsSecret }}
  {{- end }}
  rules:
    - host: {{ .Values.ingress.host | quote }}
      http:
        paths:
          - path: {{ .Values.ingress.path }}
            pathType: Prefix
            backend:
              service:
                name: {{ include "${context.projectName}.fullname" . }}
                port:
                  number: {{ .Values.ingress.port }}
{{- end }}
`;
  }

  /**
   * 生成 templates/secret.yaml（N-M-3-fix-1 修复：补全 Secret 模板生成）
   *
   * 修复原因：
   * - N-M-3 修复中 deployment.yaml 新增了 env 段，引用 secretKeyRef 指向 `${fullname}-secret`
   * - 若不生成对应的 Secret 模板，Pod 会进入 CreateContainerConfigError 状态
   * - 与 K8sManifestGenerator 的 generateSecret() 存在不对称缺口
   *
   * 实现说明：
   * - 遍历 .Values.envVars，筛选 fromSecret=true 的条目
   * - Secret 名称与 deployment.yaml 中的 `${fullname}-secret` 引用一致
   * - data 字段使用 base64 编码的 value（Helm 模板中使用 `b64enc` 函数编码）
   * - 类型为 Opaque（K8s 通用 Secret 类型）
   *
   * @param context IaC 生成上下文
   * @returns templates/secret.yaml 模板内容
   */
  private generateSecretTemplate(context: IaCGenerationContext): string {
    return `{{/* 由 EAG DevOpsOrchestrator 自动生成（N-M-3-fix-1） */}}
{{- $secretEnvs := dict -}}
{{- range $name, $env := .Values.envVars -}}
{{- if $env.fromSecret -}}
{{- $_ := set $secretEnvs $name $env.value -}}
{{- end -}}
{{- end -}}
{{- if $secretEnvs -}}
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "${context.projectName}.fullname" $ }}-secret
  labels:
    {{- include "${context.projectName}.labels" $ | nindent 4 }}
type: Opaque
data:
  {{- range $name, $value := $secretEnvs }}
  {{ $name }}: {{ $value | b64enc | quote }}
  {{- end }}
{{- end }}
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
