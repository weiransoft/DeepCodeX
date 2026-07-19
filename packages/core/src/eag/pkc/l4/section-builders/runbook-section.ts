/**
 * 运维手册章节构建器（EAG-P3 批次 11 Part B2 §7.4 第 7 章）
 *
 * 本模块实现 RunbookSectionBuilder，构建交接文档第 7 章"运维手册"。
 *
 * 数据源（对齐 §7.4 七章结构表）：
 * - 部署配置（docker-compose.yml / Dockerfile / Makefile）
 * - 日志格式（logger 配置文件）
 *
 * 置信度：inferred（基于部署配置与日志格式静态分析推断，需人工审核后提升置信度）
 *
 * **inferred 章节必须在 content 头部包含 INFERRED_SECTION_NOTICE 提示**
 *
 * 章节内容包含：
 * 1. 部署流程（基于 docker-compose / Dockerfile / Makefile 推导）
 * 2. 环境变量（从 .env.example / docker-compose 提取）
 * 3. 监控指标（从代码中的 metrics 定义提取）
 * 4. 故障排查（基于日志格式与常见错误模式）
 *
 * @module eag/pkc/l4/section-builders/runbook-section
 */

import type { HandoverSection, SectionBuilder, SectionBuildContext } from "../types";
import { INFERRED_SECTION_NOTICE } from "../types";

// ============================================================================
// 常量定义
// ============================================================================

const SECTION_ID = "runbook" as const;
const SECTION_TITLE = "运维手册" as const;
const SECTION_ORDER = 7 as const;
const SECTION_CONFIDENCE = "inferred" as const;

/**
 * 部署配置文件候选路径
 */
const DEPLOYMENT_FILE_PATHS: ReadonlyArray<string> = Object.freeze([
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "Dockerfile",
  "Makefile",
  "docker/Dockerfile",
  "deploy/docker-compose.yml",
]);

/**
 * 环境变量示例文件候选路径
 */
const ENV_FILE_PATHS: ReadonlyArray<string> = Object.freeze([
  ".env.example",
  ".env.template",
  ".env.sample",
  "docs/.env.example",
  "config/.env.example",
]);

/**
 * 可能的日志配置文件路径
 */
const LOG_CONFIG_PATHS: ReadonlyArray<string> = Object.freeze([
  "logger.config.ts",
  "logger.config.js",
  "src/logger.ts",
  "src/logger.js",
  "src/config/logger.ts",
  "src/config/logger.js",
  "src/infra/logger.ts",
  "src/infrastructure/logger.ts",
]);

// ============================================================================
// 类型定义（内部使用）
// ============================================================================

/**
 * 环境变量条目
 */
interface EnvVarEntry {
  /** 变量名 */
  readonly name: string;
  /** 默认值（可选） */
  readonly defaultValue?: string;
  /** 描述（可选，从注释或同名键提取） */
  readonly description?: string;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从 fileMap 中按候选路径顺序查找首个存在的文件
 *
 * @param fileMap 项目文件清单
 * @param candidates 候选路径列表
 * @returns 命中文件路径与内容，未命中返回 null
 */
function findFile(
  fileMap: Readonly<Record<string, string>>,
  candidates: ReadonlyArray<string>
): { path: string; content: string } | null {
  for (const candidate of candidates) {
    const content = fileMap[candidate];
    if (typeof content === "string" && content.trim().length > 0) {
      return { path: candidate, content };
    }
  }
  return null;
}

/**
 * 从 .env.example 内容中提取环境变量列表
 *
 * 解析规则：
 * - 跳过注释行（#）
 * - 解析 KEY=VALUE 格式
 * - 注释行紧邻变量行时，作为变量描述
 *
 * @param content .env.example 内容
 * @returns 环境变量列表
 */
function parseEnvFile(content: string): EnvVarEntry[] {
  const entries: EnvVarEntry[] = [];
  const lines = content.split("\n");
  let pendingDescription: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    // 注释行：积累为待用描述
    if (trimmed.startsWith("#")) {
      const commentText = trimmed.replace(/^#+\s*/, "").trim();
      if (commentText) {
        pendingDescription = commentText;
      }
      continue;
    }
    // 空行：清空待用描述
    if (trimmed === "") {
      pendingDescription = undefined;
      continue;
    }
    // KEY=VALUE 行
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      const name = match[1];
      let value = match[2];
      // 去除引号
      value = value.replace(/^['"]|['"]$/g, "");
      entries.push({
        name,
        defaultValue: value || undefined,
        description: pendingDescription,
      });
      // 用完描述后清空
      pendingDescription = undefined;
    }
  }
  return entries;
}

/**
 * 从 docker-compose 内容中提取环境变量（environment 段）
 *
 * 简易解析：识别 `environment:` 段下的 `KEY: VALUE` 或 `KEY=VALUE` 行。
 *
 * @param content docker-compose 内容
 * @returns 环境变量列表
 */
function parseComposeEnv(content: string): EnvVarEntry[] {
  const entries: EnvVarEntry[] = [];
  const lines = content.split("\n");
  let inEnv = false;
  let envIndent = -1;

  for (const line of lines) {
    const indentMatch = line.match(/^( *)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    const trimmed = line.trim();

    // 检测进入 environment 段
    if (/^environment\s*:/.test(trimmed)) {
      inEnv = true;
      envIndent = indent;
      continue;
    }

    if (!inEnv) {
      continue;
    }

    // 退出 environment 段（缩进回到 envIndent 或更小，且非空行）
    if (indent <= envIndent && trimmed !== "" && !trimmed.startsWith("-") && !trimmed.startsWith("#")) {
      inEnv = false;
      continue;
    }

    // 解析条目
    // 形如：- KEY=VALUE 或 - KEY: VALUE 或 KEY: VALUE
    const itemMatch = trimmed.match(/^-\s+([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/);
    if (itemMatch) {
      const name = itemMatch[1];
      const value = itemMatch[2].replace(/^['"]|['"]$/g, "").trim();
      entries.push({
        name,
        defaultValue: value || undefined,
      });
      continue;
    }
    const directMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (directMatch) {
      const name = directMatch[1];
      const value = directMatch[2].replace(/^['"]|['"]$/g, "").trim();
      entries.push({
        name,
        defaultValue: value || undefined,
      });
    }
  }
  return entries;
}

/**
 * 从 Makefile 内容中提取常用目标（target）
 *
 * 解析规则：识别 `target: dependencies` 行，跳过 .PHONY 与变量定义。
 *
 * @param content Makefile 内容
 * @returns target 列表（名称 + 描述，描述从前一行注释提取）
 */
function parseMakefileTargets(content: string): { name: string; description?: string }[] {
  const targets: { name: string; description?: string }[] = [];
  const lines = content.split("\n");
  let pendingComment: string | undefined;

  for (const line of lines) {
    // 注释行
    if (/^\s*#/.test(line)) {
      const commentText = line.replace(/^\s*#+\s*/, "").trim();
      if (commentText) {
        pendingComment = commentText;
      }
      continue;
    }
    // target 定义：name: dependencies
    const match = line.match(/^([A-Za-z_][\w-]*)\s*:/);
    if (match) {
      const name = match[1];
      // 跳过 .PHONY / .DEFAULT 等内置目标
      if (name.startsWith(".")) {
        continue;
      }
      targets.push({ name, description: pendingComment });
      pendingComment = undefined;
    } else if (line.trim() === "") {
      pendingComment = undefined;
    }
  }
  return targets;
}

/**
 * 从 Dockerfile 内容中提取关键信息（基础镜像 / 暴露端口 / 启动命令）
 *
 * @param content Dockerfile 内容
 * @returns 解析结果
 */
function parseDockerfile(content: string): {
  baseImage?: string;
  exposedPorts: number[];
  startCommand?: string;
  workdir?: string;
} {
  let baseImage: string | undefined;
  const exposedPorts: number[] = [];
  let startCommand: string | undefined;
  let workdir: string | undefined;
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("FROM ")) {
      // FROM image:tag AS stage
      const match = trimmed.match(/^FROM\s+(\S+)/);
      if (match) {
        baseImage = match[1];
      }
    } else if (trimmed.startsWith("EXPOSE ")) {
      const match = trimmed.match(/^EXPOSE\s+(\d+)/);
      if (match) {
        exposedPorts.push(Number(match[1]));
      }
    } else if (trimmed.startsWith("CMD ")) {
      startCommand = trimmed.slice(4).trim();
    } else if (trimmed.startsWith("ENTRYPOINT ")) {
      startCommand = trimmed.slice(11).trim();
    } else if (trimmed.startsWith("WORKDIR ")) {
      workdir = trimmed.slice(8).trim();
    }
  }
  return { baseImage, exposedPorts, startCommand, workdir };
}

/**
 * 从 logger 配置文件中提取日志格式信息
 *
 * 简易解析：识别 console.log / winston.format / pino 等常见模式。
 *
 * @param content logger 配置文件内容
 * @returns 日志格式描述
 */
function parseLoggerConfig(content: string): string | null {
  // 识别 winston format
  if (/winston/i.test(content)) {
    if (/format\.combine/i.test(content)) {
      return "Winston（组合格式，含 timestamp / printf / colorize）";
    }
    if (/format\.json/i.test(content)) {
      return "Winston（JSON 格式）";
    }
    if (/format\.simple/i.test(content)) {
      return "Winston（简单文本格式）";
    }
    return "Winston（默认格式）";
  }
  // 识别 pino
  if (/pino/i.test(content)) {
    return "Pino（JSON 格式，高性能日志库）";
  }
  // 识别 log4js
  if (/log4js/i.test(content)) {
    return "Log4js（可配置 pattern 格式）";
  }
  // 识别 console.log
  if (/console\.log/i.test(content)) {
    return "console.log（开发环境简易日志，生产环境建议替换为结构化日志）";
  }
  return null;
}

/**
 * 从代码文件中扫描监控指标定义（简易识别）
 *
 * 识别模式：
 * - Prometheus：counter / gauge / histogram / summary
 * - metrics.define / metrics.increment
 *
 * @param fileMap 项目文件清单
 * @returns 监控指标描述列表
 */
function scanMetrics(fileMap: Readonly<Record<string, string>>): { name: string; filePath: string }[] {
  const metrics: { name: string; filePath: string }[] = [];
  // 匹配 Prometheus client 风格：new Counter({ name: "..." }) / new Gauge({ name: "..." }) 等
  const prometheusRegex = /new\s+(Counter|Gauge|Histogram|Summary)\s*\(\s*\{[^}]*name\s*:\s*['"]([^'"]+)['"]/g;
  // 匹配 metrics.increment('name') / metrics.define('name', ...)
  const metricsDefineRegex = /metrics\.(?:define|increment|gauge|timer)\s*\(\s*['"]([^'"]+)['"]/g;

  for (const [filePath, content] of Object.entries(fileMap)) {
    if (typeof content !== "string") {
      continue;
    }
    if (!filePath.endsWith(".ts") && !filePath.endsWith(".js")) {
      continue;
    }
    if (/\.test\.[a-z]+$/.test(filePath) || /\.spec\.[a-z]+$/.test(filePath)) {
      continue;
    }
    // Prometheus 模式
    let match: RegExpExecArray | null;
    prometheusRegex.lastIndex = 0;
    while ((match = prometheusRegex.exec(content)) !== null) {
      metrics.push({ name: `${match[1].toLowerCase()}:${match[2]}`, filePath });
    }
    // metrics.define 模式
    metricsDefineRegex.lastIndex = 0;
    while ((match = metricsDefineRegex.exec(content)) !== null) {
      metrics.push({ name: `metric:${match[1]}`, filePath });
    }
  }
  return metrics;
}

// ============================================================================
// RunbookSectionBuilder 类
// ============================================================================

/**
 * 运维手册章节构建器
 *
 * 实现章节顺序 7（对齐 §7.4 七章结构表）。
 *
 * 置信度：inferred（基于部署配置与日志格式静态分析推断，需人工审核）
 *
 * **inferred 章节头部必须包含 INFERRED_SECTION_NOTICE 提示**
 *
 * 构建流程：
 * 1. 从 fileMap 读取部署配置（docker-compose.yml / Dockerfile / Makefile）
 * 2. 从 .env.example 或 docker-compose 提取环境变量
 * 3. 从 logger 配置文件提取日志格式
 * 4. 扫描代码中的监控指标定义
 * 5. 组装 Markdown 内容（部署流程 + 环境变量 + 监控指标 + 故障排查）
 * 6. 返回冻结的 HandoverSection（confidence=inferred）
 */
export class RunbookSectionBuilder implements SectionBuilder {
  readonly sectionId = SECTION_ID;
  readonly title = SECTION_TITLE;
  readonly order = SECTION_ORDER;

  /**
   * 构建运维手册章节
   *
   * @param context 章节构建上下文
   * @returns 冻结的 HandoverSection（confidence=inferred）
   */
  async build(context: SectionBuildContext): Promise<HandoverSection> {
    const sources: string[] = [];

    // 1. 查找部署配置文件
    const deploymentFile = findFile(context.fileMap, DEPLOYMENT_FILE_PATHS);
    if (deploymentFile) {
      sources.push(deploymentFile.path);
    }

    // 2. 查找环境变量文件
    const envFile = findFile(context.fileMap, ENV_FILE_PATHS);
    if (envFile) {
      sources.push(envFile.path);
    }

    // 3. 提取环境变量（.env.example 与 docker-compose 合并，.env.example 优先保留描述）
    // 修复原因：原逻辑为 .env.example 优先降级到 docker-compose，导致仅在 docker-compose 中
    // 定义的环境变量（如 NODE_ENV）被遗漏。改为合并两个来源，按变量名去重
    const envVars: EnvVarEntry[] = [];
    const envVarNames = new Set<string>();
    if (envFile) {
      for (const entry of parseEnvFile(envFile.content)) {
        if (!envVarNames.has(entry.name)) {
          envVars.push(entry);
          envVarNames.add(entry.name);
        }
      }
    }
    if (deploymentFile && /\.(yml|yaml)$/.test(deploymentFile.path)) {
      for (const entry of parseComposeEnv(deploymentFile.content)) {
        if (!envVarNames.has(entry.name)) {
          envVars.push(entry);
          envVarNames.add(entry.name);
        }
      }
    }

    // 4. 提取 Makefile targets
    let makefileTargets: { name: string; description?: string }[] = [];
    if (deploymentFile && deploymentFile.path.endsWith("Makefile")) {
      makefileTargets = parseMakefileTargets(deploymentFile.content);
    } else {
      // 单独查找 Makefile
      const makefile = findFile(context.fileMap, ["Makefile"]);
      if (makefile) {
        sources.push(makefile.path);
        makefileTargets = parseMakefileTargets(makefile.content);
      }
    }

    // 5. 提取 Dockerfile 信息
    let dockerfileInfo: ReturnType<typeof parseDockerfile> | null = null;
    const dockerfile = findFile(context.fileMap, ["Dockerfile", "docker/Dockerfile"]);
    if (dockerfile) {
      sources.push(dockerfile.path);
      dockerfileInfo = parseDockerfile(dockerfile.content);
    } else if (deploymentFile && deploymentFile.path.endsWith("Dockerfile")) {
      dockerfileInfo = parseDockerfile(deploymentFile.content);
    }

    // 6. 提取日志配置
    const logConfigFile = findFile(context.fileMap, LOG_CONFIG_PATHS);
    let logFormat: string | null = null;
    if (logConfigFile) {
      sources.push(logConfigFile.path);
      logFormat = parseLoggerConfig(logConfigFile.content);
    }

    // 7. 扫描监控指标
    const metrics = scanMetrics(context.fileMap);
    for (const m of metrics) {
      if (!sources.includes(m.filePath)) {
        sources.push(m.filePath);
      }
    }

    // 8. 组装 Markdown 内容（头部必须包含 INFERRED_SECTION_NOTICE）
    const content = this.assembleContent({
      deploymentFile: deploymentFile?.path ?? null,
      envVars,
      makefileTargets,
      dockerfileInfo,
      logFormat,
      metrics,
      projectRoot: context.projectRoot,
    });

    return Object.freeze({
      sectionId: SECTION_ID,
      title: SECTION_TITLE,
      order: SECTION_ORDER,
      confidence: SECTION_CONFIDENCE,
      content,
      sources: Object.freeze(sources),
    });
  }

  /**
   * 组装章节 Markdown 内容
   *
   * **inferred 章节头部必须包含 INFERRED_SECTION_NOTICE 提示**
   *
   * @param parts 章节组成部分
   * @returns 完整 Markdown 内容（头部含 INFERRED_SECTION_NOTICE）
   */
  private assembleContent(parts: {
    deploymentFile: string | null;
    envVars: EnvVarEntry[];
    makefileTargets: { name: string; description?: string }[];
    dockerfileInfo: ReturnType<typeof parseDockerfile> | null;
    logFormat: string | null;
    metrics: { name: string; filePath: string }[];
    projectRoot: string;
  }): string {
    const lines: string[] = [];
    // inferred 章节头部提示（对齐 §7.4 注释）
    lines.push(INFERRED_SECTION_NOTICE);
    lines.push(`## ${SECTION_TITLE}`);
    lines.push("");
    lines.push(`> **置信度**：inferred（基于部署配置与日志格式静态分析推断，需人工审核）`);
    lines.push(`> **项目根目录**：${parts.projectRoot}`);
    if (parts.deploymentFile) {
      lines.push(`> **部署配置文件**：\`${parts.deploymentFile}\``);
    }
    lines.push("");

    // 部署流程
    lines.push("### 部署流程");
    lines.push("");
    if (parts.deploymentFile) {
      lines.push(`项目通过 \`${parts.deploymentFile}\` 定义部署流程。`);
      lines.push("");
      // 只要解析到 Makefile targets 就输出（无论 deploymentFile 是否为 Makefile 本身）
      // 修复原因：build 方法在 deploymentFile 为 docker-compose.yml 时也会单独查找 Makefile
      // 并解析 targets，此处条件不应依赖 deploymentFile 后缀
      if (parts.makefileTargets.length > 0) {
        lines.push("**Makefile 目标**：");
        lines.push("");
        lines.push("| 目标 | 描述 |");
        lines.push("|------|------|");
        for (const target of parts.makefileTargets) {
          lines.push(`| \`${target.name}\` | ${target.description ?? "—"} |`);
        }
        lines.push("");
      }
      if (parts.dockerfileInfo) {
        lines.push("**Docker 配置**：");
        lines.push("");
        if (parts.dockerfileInfo.baseImage) {
          lines.push(`- **基础镜像**：\`${parts.dockerfileInfo.baseImage}\``);
        }
        if (parts.dockerfileInfo.workdir) {
          lines.push(`- **工作目录**：\`${parts.dockerfileInfo.workdir}\``);
        }
        if (parts.dockerfileInfo.exposedPorts.length > 0) {
          lines.push(`- **暴露端口**：${parts.dockerfileInfo.exposedPorts.join(", ")}`);
        }
        if (parts.dockerfileInfo.startCommand) {
          lines.push(`- **启动命令**：\`${parts.dockerfileInfo.startCommand}\``);
        }
        lines.push("");
      }
      lines.push("**典型部署步骤**：");
      lines.push("");
      lines.push("1. 构建镜像：`docker build -t app:latest .`");
      lines.push("2. 启动容器：`docker-compose up -d`");
      lines.push("3. 健康检查：`curl http://localhost:8080/health`");
      lines.push("4. 查看日志：`docker-compose logs -f app`");
      lines.push("");
    } else {
      lines.push("> 未在 fileMap 中找到部署配置文件（docker-compose.yml / Dockerfile / Makefile）。");
      lines.push("");
    }

    // 环境变量
    lines.push("### 环境变量");
    lines.push("");
    if (parts.envVars.length === 0) {
      lines.push("> 未在 .env.example 或 docker-compose.yml 中提取到环境变量。");
      lines.push("");
    } else {
      lines.push("| 变量名 | 默认值 | 描述 |");
      lines.push("|--------|--------|------|");
      for (const env of parts.envVars) {
        lines.push(`| \`${env.name}\` | ${env.defaultValue ?? "—"} | ${env.description ?? "—"} |`);
      }
      lines.push("");
      lines.push("> **注**：敏感变量（密码 / 密钥）请通过 secrets manager 或加密环境变量注入，不要写入 .env.example。");
      lines.push("");
    }

    // 监控指标
    lines.push("### 监控指标");
    lines.push("");
    if (parts.metrics.length === 0) {
      lines.push("> 未在代码中扫描到监控指标定义（Prometheus counter/gauge/histogram/summary 或 metrics.define）。");
      lines.push("");
      lines.push("**建议补充以下监控指标**：");
      lines.push("");
      lines.push("- HTTP 请求 QPS / 延迟 / 错误率（RED 三件套）");
      lines.push("- 数据库连接池使用率");
      lines.push("- 缓存命中率");
      lines.push("- MQ 队列长度 / 消费延迟");
      lines.push("- JVM/Node.js 进程内存与 GC");
      lines.push("");
    } else {
      lines.push("| 指标名 | 所在文件 |");
      lines.push("|--------|----------|");
      for (const m of parts.metrics) {
        lines.push(`| \`${m.name}\` | \`${m.filePath}\` |`);
      }
      lines.push("");
    }

    // 日志格式
    lines.push("### 日志格式");
    lines.push("");
    if (parts.logFormat) {
      lines.push(`**日志库与格式**：${parts.logFormat}`);
      lines.push("");
    } else {
      lines.push("> 未在 fileMap 中找到 logger 配置文件（候选路径：logger.config.ts / src/logger.ts）。");
      lines.push("");
    }
    lines.push("**日志分级约定**：");
    lines.push("");
    lines.push("| 级别 | 用途 |");
    lines.push("|------|------|");
    lines.push("| ERROR | 错误日志（影响业务功能，需立即处理） |");
    lines.push("| WARN | 警告日志（潜在风险，需关注） |");
    lines.push("| INFO | 关键业务事件日志（订单创建 / 支付成功等） |");
    lines.push("| DEBUG | 调试日志（开发环境使用，生产环境关闭） |");
    lines.push("");
    lines.push("**结构化日志字段建议**：");
    lines.push("");
    lines.push("- `timestamp`：ISO 8601 时间戳");
    lines.push("- `level`：日志级别");
    lines.push("- `requestId` / `traceId`：请求追踪 ID");
    lines.push("- `userId`：用户 ID（若有）");
    lines.push("- `message`：日志消息");
    lines.push("- `error`：错误对象（含 stack / code / name）");
    lines.push("");

    // 故障排查
    lines.push("### 故障排查");
    lines.push("");
    lines.push("**常见问题与排查步骤**：");
    lines.push("");
    lines.push("| 问题 | 可能原因 | 排查步骤 |");
    lines.push("|------|----------|----------|");
    lines.push("| 服务启动失败 | 端口被占用 / 环境变量缺失 | 检查端口占用 `lsof -i :8080`；检查 .env 配置 |");
    lines.push("| 数据库连接超时 | 数据库不可达 / 凭证错误 | 检查网络 `telnet db-host 5432`；检查 DATABASE_URL |");
    lines.push("| 内存泄漏 | 长时间运行内存增长 | 监控 RSS / Heap；用 `--inspect` 启动后做 heap snapshot |");
    lines.push("| 503 服务不可用 | 健康检查失败 / 限流触发 | 检查 `/health` 端点；查看限流配置 |");
    lines.push("| 502 网关错误 | 上游服务崩溃 / 响应超时 | 检查容器状态 `docker ps`；查看应用日志 |");
    lines.push("");

    // 人工审核提示
    lines.push("### 人工审核提示");
    lines.push("");
    lines.push("> 本章节为 inferred 置信度，建议接手者审核以下内容后提升置信度至 documented：");
    lines.push("");
    lines.push("1. **部署流程**：核实部署步骤是否与实际 CI/CD 流水线一致。");
    lines.push("2. **环境变量**：补充每个环境变量的取值范围与默认行为。");
    lines.push("3. **监控指标**：补充告警阈值与响应 Runbook。");
    lines.push("4. **日志格式**：核实日志字段是否完整、是否便于 ELK / Loki 检索。");
    lines.push("5. **故障排查**：补充历史故障案例与解决方案。");
    lines.push("");

    return lines.join("\n");
  }
}
