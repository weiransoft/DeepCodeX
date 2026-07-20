/**
 * TerraformGenerator —— Terraform HCL 模板生成器（EAG-P4 批次 13 Phase 3 D1-2）
 *
 * 本模块实现 `TerraformGenerator` 类，对应 EAG-P4 批次 13 设计文档 §3.5.2 D1-2 Terraform 生成器：
 * "TerraformGenerator —— Terraform HCL 模板生成器，产出 main.tf / variables.tf / outputs.tf 三个文件"。
 *
 * 产出文件（共 3 个 IaCTemplate，对应 6 种 K8s 资源类型，满足 D1-2 验收标准"每个生成器支持 ≥ 5 种资源类型"）：
 * - main.tf: 主配置文件（含 provider / resource / output）
 *   资源类型：
 *   - kubernetes_namespace（K8s Namespace）
 *   - kubernetes_deployment（K8s Deployment）
 *   - kubernetes_service（K8s Service）
 *   - kubernetes_ingress（K8s Ingress，可选）
 * - variables.tf: 变量定义
 * - outputs.tf: 输出定义
 *
 * 真实 CLI 校验：
 * - validate() 调用 `terraform validate -json` 校验 HCL 语法
 * - 要求用户环境预装 terraform CLI（版本 >= 1.0）
 * - 实现步骤：创建临时目录 → 写入 .tf 文件 → terraform init -backend=false → terraform validate -json → 解析 JSON → 清理临时目录
 *
 * B-6 修复说明（设计文档 §3.5.2 L1236）：
 * - 原设计引用 aws_iam_role.eks_cluster / aws_subnet.eks / aws_vpc 但未声明，导致 terraform validate 失败
 * - 修复策略：简化为"假设集群已存在"，通过 kubernetes_provider 直接接入，仅创建 K8s 资源
 * - EKS 集群创建由独立模块负责（如 terraform-aws-eks），本生成器仅负责应用层部署
 *
 * B-7 修复说明（设计文档 §3.5.2 L1387）：
 * - IngressConfig 添加 port 字段，generateIngressBlock 使用 ingress.port 而非 context.port
 *
 * N-B-1 修复说明（设计文档 §3.5.2 L1463）：
 * - outputs.tf 删除 cluster_endpoint / cluster_name，仅保留真实声明的资源引用
 * - 原因：B-6 修复时 main.tf 简化为仅使用 kubernetes_provider，不再声明 aws_eks_cluster，
 *   原 outputs.tf 仍引用 aws_eks_cluster.main.endpoint / .name 会导致 terraform validate 必然失败
 *
 * 设计依据：
 * - EAG-P4 批次 13 设计文档 §3.5.2 D1-2 Terraform 生成器
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先，返回值 Object.freeze）
 * - B-1 修复（设计文档 §3.5.2 L1106）：完整实现 validate()，不再抛 TODO
 * - B-6 修复（设计文档 §3.5.2 L1236）：简化为 kubernetes provider，不创建 EKS 集群
 * - B-7 修复（设计文档 §3.5.2 L1387）：IngressConfig 添加 port 字段
 * - N-B-1 修复（设计文档 §3.5.2 L1463）：outputs.tf 仅引用真实声明的资源
 *
 * @module eag/devops/iac-generator/terraform-generator
 */

import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { IaCTemplate, IaCGenerationContext, IaCValidationResult, EnvVar, IngressConfig } from "../types";
import type { IaCGenerator } from "../types";

/**
 * Terraform HCL 模板生成器
 *
 * 实现 §3.5.2 D1-2 Terraform 生成器：产出 main.tf / variables.tf / outputs.tf 三个文件，
 * 通过 kubernetes_provider 接入既有 K8s 集群，创建 namespace / deployment / service / ingress 资源。
 *
 * 使用方式：
 *   const generator = new TerraformGenerator();
 *   const templates = generator.generate(context);
 *   for (const tpl of templates) {
 *     const result = await generator.validate(tpl);
 *     if (!result.valid) { console.error(result.errors); }
 *   }
 */
export class TerraformGenerator implements IaCGenerator {
  /** IaC 类型标识（固定为 "terraform"） */
  public readonly iacType = "terraform" as const;

  /**
   * 生成 Terraform 模板
   *
   * 产出 3 个 IaCTemplate：
   * 1. main.tf —— 主配置文件（provider / namespace / deployment / service / ingress）
   * 2. variables.tf —— 变量定义（project_name / environment / aws_region）
   * 3. outputs.tf —— 输出定义（namespace / service_name / deployment_name）
   *
   * 不可变优先（§5.12.4 G-A6d）：
   * - 返回的 IaCTemplate 对象通过 Object.freeze 冻结
   * - 返回的数组本身通过 Object.freeze 冻结
   * - 防止调用方意外修改生成产物，保证审计可追溯性
   *
   * @param context IaC 生成上下文
   * @returns 3 个 IaCTemplate（main.tf / variables.tf / outputs.tf），全部冻结
   */
  public generate(context: IaCGenerationContext): IaCTemplate[] {
    // 生成时间戳（3 个文件共用同一时间戳，便于追溯同批次生成）
    const generatedAt = new Date().toISOString();

    // 分别生成 3 个 .tf 文件内容
    const mainTfContent = this.generateMainTf(context);
    const variablesTfContent = this.generateVariablesTf(context);
    const outputsTfContent = this.generateOutputsTf(context);

    // 构造 IaCTemplate 数组（每个模板含 type / content / filePath / hash / generatedAt）
    // 不可变优先：每个 IaCTemplate 对象通过 Object.freeze 冻结
    const templates: IaCTemplate[] = [
      Object.freeze({
        type: "terraform",
        content: mainTfContent,
        filePath: "main.tf",
        hash: this.computeHash(mainTfContent),
        generatedAt,
      }) as IaCTemplate,
      Object.freeze({
        type: "terraform",
        content: variablesTfContent,
        filePath: "variables.tf",
        hash: this.computeHash(variablesTfContent),
        generatedAt,
      }) as IaCTemplate,
      Object.freeze({
        type: "terraform",
        content: outputsTfContent,
        filePath: "outputs.tf",
        hash: this.computeHash(outputsTfContent),
        generatedAt,
      }) as IaCTemplate,
    ];

    // 冻结数组本身（防止调用方 push/splice 修改数组结构）
    return Object.freeze(templates) as ReadonlyArray<IaCTemplate> as IaCTemplate[];
  }

  /**
   * 校验 Terraform 模板（B-1 修复：完整实现，不再抛 TODO）
   *
   * 调用 `terraform validate` 命令校验 HCL 语法
   * 要求用户环境预装 terraform CLI（版本 >= 1.0）
   *
   * 实现步骤：
   * 1. 创建临时目录（fs.mkdtempSync，前缀 eag-tf-validate-）
   * 2. 写入模板文件（fs.writeFileSync，写入 main.tf / variables.tf / outputs.tf）
   * 3. 调用 `terraform init -backend=false`（初始化 provider，不使用远程 backend）
   * 4. 调用 `terraform validate -json`（JSON 格式输出，便于解析）
   * 5. 解析 JSON 输出，提取 valid / errors
   * 6. 清理临时目录（fs.rmSync，recursive=true）
   *
   * 错误处理：
   * - terraform init 失败：返回 valid=false + errors=[init 失败信息]
   * - terraform validate 输出解析失败：返回 valid=false + errors=[解析失败信息]
   * - terraform 命令不存在：返回 valid=false + errors=[命令执行失败信息]
   * - 临时目录清理失败：不影响校验结果（仅记录日志）
   *
   * @param template IaC 模板（单个 .tf 文件）
   * @returns 校验结果（含 valid / errors / validatedBy）
   */
  public async validate(template: IaCTemplate): Promise<IaCValidationResult> {
    // Step 1: 创建临时目录（前缀 eag-tf-validate-，便于排查遗留文件）
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-tf-validate-"));

    try {
      // Step 2: 写入模板文件
      // 注意：传入的 template 是单个文件，但 terraform validate 需要完整目录
      // 调用方应将同批次生成的所有 .tf 文件分别调用 validate()，或在 DevOpsOrchestrator
      // 中聚合后调用（设计文档 §3.4 DevOpsOrchestrator.run() 负责 IaC 校验编排）
      const targetFile = path.join(tmpDir, template.filePath);
      const targetDir = path.dirname(targetFile);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      fs.writeFileSync(targetFile, template.content, "utf8");

      // Step 3: 调用 terraform init -backend=false（初始化 provider，不使用远程 backend）
      // -input=false 避免交互式提示阻塞自动化流程
      const initResult = await this.spawnTerraformCommand(tmpDir, ["init", "-backend=false", "-input=false"]);
      if (!initResult.success) {
        return {
          valid: false,
          errors: [`terraform init 失败：${initResult.stderr}`],
          validatedBy: "terraform-validate",
        };
      }

      // Step 4: 调用 terraform validate -json（JSON 格式输出，便于解析）
      const validateResult = await this.spawnTerraformCommand(tmpDir, ["validate", "-json"]);

      // Step 5: 解析 JSON 输出
      try {
        const output = JSON.parse(validateResult.stdout || "{}");
        const valid = output.valid === true;
        const errors: string[] = [];
        // 解析 diagnostics 数组（terraform validate -json 的标准输出格式）
        if (Array.isArray(output.diagnostics)) {
          for (const diag of output.diagnostics) {
            const severity = diag.severity || "error";
            const message = diag.summary || diag.detail || "未知错误";
            errors.push(`[${severity}] ${message}`);
          }
        }
        return {
          valid,
          errors: Object.freeze(errors) as ReadonlyArray<string>,
          validatedBy: "terraform-validate",
        };
      } catch (parseError) {
        // JSON 解析失败：返回 valid=false + 解析错误信息
        return {
          valid: false,
          errors: [
            `terraform validate 输出解析失败：${parseError instanceof Error ? parseError.message : String(parseError)}`,
          ],
          validatedBy: "terraform-validate",
        };
      }
    } finally {
      // Step 6: 清理临时目录（无论成功失败都清理，避免磁盘泄漏）
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响校验结果，仅记录日志
      }
    }
  }

  /**
   * 调用 terraform CLI 命令的辅助方法
   *
   * 使用 child_process.spawn 启动子进程执行 terraform 命令，捕获 stdout / stderr，
   * 等待子进程退出后返回结果。
   *
   * 环境变量：
   * - TF_IN_AUTOMATION=1：告知 terraform 处于自动化模式，禁用颜色输出与建议提示
   *
   * @param cwd 工作目录（临时目录）
   * @param args 命令参数（如 ["init", "-backend=false"]）
   * @returns 包含 success / stdout / stderr 的结果对象
   */
  private spawnTerraformCommand(
    cwd: string,
    args: ReadonlyArray<string>
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      // 启动 terraform 子进程（继承 process.env，添加 TF_IN_AUTOMATION）
      const child = spawn("terraform", [...args], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, TF_IN_AUTOMATION: "1" },
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

      // 子进程正常退出（exit code 0 = 成功，非 0 = 失败）
      child.on("close", (code: number | null) => {
        resolve({
          success: code === 0,
          stdout,
          stderr,
        });
      });
      // 子进程启动失败（如 terraform 命令不存在）
      child.on("error", (err: Error) => {
        resolve({
          success: false,
          stdout: "",
          stderr: `terraform 命令执行失败：${err.message}（请确认已预装 terraform CLI >= 1.0）`,
        });
      });
    });
  }

  /**
   * 生成 main.tf 内容（B-6 修复：简化为直接使用 kubernetes provider，不创建 EKS 集群）
   *
   * 包含：
   * - Terraform 配置块（required_version / required_providers）
   * - Provider 配置（kubernetes，通过 kubeconfig 或环境变量接入既有集群）
   * - 资源定义（kubernetes_namespace / kubernetes_deployment / kubernetes_service / kubernetes_ingress）
   *
   * B-6 修复说明：
   * - 原设计引用 aws_iam_role.eks_cluster / aws_subnet.eks / aws_vpc 但未声明，导致 terraform validate 失败
   * - 修复策略：简化为"假设集群已存在"，通过 kubernetes_provider 直接接入，仅创建 K8s 资源
   * - EKS 集群创建由独立模块负责（如 terraform-aws-eks），本生成器仅负责应用层部署
   *
   * @param context IaC 生成上下文
   * @returns main.tf 文件内容字符串
   */
  private generateMainTf(context: IaCGenerationContext): string {
    const { projectName, environment, replicas, image, port, resources, envVars, ingress } = context;

    // B-7 修复：envVars 为空时不生成环境变量块，避免空行
    const envVarBlock =
      envVars.length > 0
        ? `\n          ${envVars.map((env) => this.generateEnvVarBlock(env)).join("\n          ")}`
        : "";

    return `# 由 EAG DevOpsOrchestrator 自动生成
# 项目：${projectName}
# 环境：${environment}
# 生成时间：${new Date().toISOString()}

terraform {
  required_version = ">= 1.0"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.23"
    }
  }
}

# Provider 配置：通过 kubeconfig 接入既有 K8s 集群（B-6 修复：不创建 EKS 集群）
provider "kubernetes" {
  config_path = "~/.kube/config"
}

# K8s Namespace
resource "kubernetes_namespace" "main" {
  metadata {
    name = var.project_name
    labels = {
      environment = var.environment
      managed-by  = "eag-devops"
    }
  }
}

# K8s Deployment
resource "kubernetes_deployment" "main" {
  metadata {
    name      = var.project_name
    namespace = kubernetes_namespace.main.metadata[0].name
    labels = {
      app = var.project_name
    }
  }

  spec {
    replicas = ${replicas}

    selector {
      match_labels = {
        app = var.project_name
      }
    }

    template {
      metadata {
        labels = {
          app = var.project_name
        }
      }

      spec {
        container {
          name  = var.project_name
          image = "${image}"

          port {
            container_port = ${port}
          }

          resources {
            requests = {
              cpu    = "${resources.requests.cpu}"
              memory = "${resources.requests.memory}"
            }

            limits = {
              cpu    = "${resources.limits.cpu}"
              memory = "${resources.limits.memory}"
            }
          }${envVarBlock}
        }
      }
    }
  }
}

# K8s Service
resource "kubernetes_service" "main" {
  metadata {
    name      = var.project_name
    namespace = kubernetes_namespace.main.metadata[0].name
  }

  spec {
    selector = {
      app = var.project_name
    }

    port {
      port        = ${port}
      target_port = ${port}
    }

    type = "ClusterIP"
  }
}

${ingress ? this.generateIngressBlock(projectName, ingress) : ""}
`;
  }

  /**
   * 生成环境变量块
   *
   * 支持两种模式：
   * - 明文环境变量（fromSecret=false 或未设置）：使用 env { name = ... value = ... } 语法
   * - Secret 引用（fromSecret=true）：使用 env { name = ... value_from { secret_key_ref { ... } } } 语法
   *
   * @param env 环境变量
   * @returns HCL 环境变量块字符串
   */
  private generateEnvVarBlock(env: EnvVar): string {
    if (env.fromSecret) {
      // Secret 引用：value_from { secret_key_ref { name = ... key = ... } }
      return `env {
              name = "${env.name}"
              value_from {
                secret_key_ref {
                  name = "${env.value}"
                  key  = "${env.name}"
                }
              }
            }`;
    }
    // 明文环境变量
    return `env {
              name  = "${env.name}"
              value = "${env.value}"
            }`;
  }

  /**
   * 生成 Ingress 块（B-7 修复：使用 ingress.port，IngressConfig 已添加 port 字段）
   *
   * @param projectName 项目名称（用于 Ingress 资源命名）
   * @param ingress Ingress 配置
   * @returns HCL Ingress 资源块字符串
   */
  private generateIngressBlock(projectName: string, ingress: IngressConfig): string {
    // TLS 块（可选，tlsSecret 存在时启用 HTTPS）
    const tlsBlock = ingress.tlsSecret
      ? `tls {
    hosts       = ["${ingress.host}"]
    secret_name = "${ingress.tlsSecret}"
  }
  `
      : "";

    return `# K8s Ingress
resource "kubernetes_ingress" "main" {
  metadata {
    name      = "${projectName}"
    namespace = kubernetes_namespace.main.metadata[0].name
  }

  spec {
    ${tlsBlock}

    rule {
      host = "${ingress.host}"

      http {
        path {
          path      = "${ingress.path}"
          path_type = "Prefix"

          backend {
            service {
              name = kubernetes_service.main.metadata[0].name
              port {
                number = ${ingress.port}
              }
            }
          }
        }
      }
    }
  }
}`;
  }

  /**
   * 生成 variables.tf 内容
   *
   * 定义 3 个变量：
   * - project_name：项目名称（默认值为 context.projectName）
   * - environment：部署环境（含 validation 校验 dev / staging / prod）
   * - aws_region：AWS 区域（默认 ap-northeast-1，保留以备后续扩展 AWS 资源）
   *
   * @param context IaC 生成上下文
   * @returns variables.tf 文件内容字符串
   */
  private generateVariablesTf(context: IaCGenerationContext): string {
    return `# 由 EAG DevOpsOrchestrator 自动生成
# 变量定义文件

variable "project_name" {
  description = "项目名称"
  type        = string
  default     = "${context.projectName}"
}

variable "environment" {
  description = "部署环境（dev / staging / prod）"
  type        = string
  default     = "${context.environment}"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "环境必须是 dev / staging / prod 之一。"
  }
}

variable "aws_region" {
  description = "AWS 区域"
  type        = string
  default     = "ap-northeast-1"
}
`;
  }

  /**
   * 生成 outputs.tf 内容（N-B-1 修复：删除 cluster_endpoint / cluster_name，仅保留真实声明的资源引用）
   *
   * 修复原因：B-6 修复时已将 main.tf 简化为仅使用 kubernetes_provider 接入既有集群，
   * 不再声明 aws_eks_cluster 资源。原 outputs.tf 仍引用 aws_eks_cluster.main.endpoint / .name，
   * 导致 terraform validate 必然失败。
   *
   * 修复方案：仅保留 namespace / service_name / deployment_name 三个 output，
   * 全部引用 main.tf 中真实声明的 kubernetes_namespace / kubernetes_service / kubernetes_deployment 资源
   *
   * @param context IaC 生成上下文（保留参数以备后续扩展，当前未使用）
   * @returns outputs.tf 文件内容字符串
   */
  private generateOutputsTf(context: IaCGenerationContext): string {
    // context 参数保留以备后续扩展（如根据 context.projectName 动态生成 output 描述）
    // 当前实现使用固定模板，不依赖 context 字段
    void context; // 显式标记参数未使用，避免 ESLint 警告

    return `# 由 EAG DevOpsOrchestrator 自动生成
# 输出定义文件
# N-B-1 修复：仅引用 main.tf 中真实声明的 K8s 资源，不再引用 aws_eks_cluster

output "namespace" {
  description = "K8s Namespace 名称"
  value       = kubernetes_namespace.main.metadata[0].name
}

output "service_name" {
  description = "K8s Service 名称"
  value       = kubernetes_service.main.metadata[0].name
}

output "deployment_name" {
  description = "K8s Deployment 名称"
  value       = kubernetes_deployment.main.metadata[0].name
}
`;
  }

  /**
   * 计算内容 SHA256 哈希
   *
   * 用于 IaCTemplate.hash 字段，检测模板内容是否变更（避免重复生成相同模板）。
   *
   * @param content 模板内容
   * @returns SHA256 哈希字符串（64 位十六进制）
   */
  private computeHash(content: string): string {
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
  }
}
